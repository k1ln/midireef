//! Wiedergabe-Engine: kompiliert Lanes/Bausteine des Projekts in schnelle
//! Strukturen und spielt sie im Clock-Loop ab (Melodie + Beat für v1).
//!
//! Timing: 24 PPQN. Ein Step-Boundary löst Note-Ons aus; Note-Offs werden
//! global (nach absolutem Puls) verwaltet.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::midi::{MidiOutManager, MIDI_CLOCK, MIDI_START, MIDI_STOP};
use crate::model::{Device, Lane, Project};

const PPQN: u32 = 24;
const PULSES_PER_WHOLE: u32 = PPQN * 4; // 96 Pulse pro ganze Note

/// Mindestabstand zwischen zwei gesendeten CC-Werten EINES CC-Bausteins — hart
/// gedeckelt (~50/s), unabhängig von BPM/PPQN/LFO-Rate. Das ist der eigentliche
/// Schutz gegen einen überlasteten MIDI-Kanal bei schnellen (Hz-)LFOs: die
/// Engine wertet zwar jeden Puls aus, sendet aber nur, wenn sich der 7-Bit-Wert
/// geändert hat UND dieses Intervall seit dem letzten Send verstrichen ist.
const MIN_CC_SEND_INTERVAL: Duration = Duration::from_millis(20);

// ── Kompilierte Strukturen ──────────────────────────────────────────────────

struct CNote {
    step: u32,
    len_steps: u32,
    note: u8,
    vel: u8,
}

/// Ziel einer CC-*Lane*: (Port, Kanal, CC-Nummer), aufgelöst aus dem
/// verknüpften Dashboard-Knob (`Lane.ccControlId` → `LiveControl.mapping`).
#[derive(Clone)]
struct CcTarget {
    port: String,
    channel: u8,
    cc_number: u8,
    /// Id des Dashboard-Knobs — für das `control.valueChanged`-Echo an die UI,
    /// wenn ein nicht-destruktiver Baustein das Ziel auf die Ruhelage zurücksetzt.
    control_id: String,
    /// Ruhewert des Knobs (dessen `value` beim letzten Rebuild). Dahin kehrt ein
    /// nicht-destruktiver CC-Baustein zurück, sobald er nicht mehr spielt.
    rest_value: u8,
}

/// Ein CC-Ziel, das GERADE von einem CC-Baustein bespielt wird. Pro Puls neu
/// markiert (`seen`); wer nach einem Puls nicht markiert ist, hat aufgehört —
/// und wird, falls nicht destruktiv, auf `rest_value` zurückgestellt.
struct CcDrive {
    control_id: String,
    rest_value: u8,
    destructive: bool,
    /// Slot des zuletzt treibenden Bausteins — beim Zurückstellen wird dessen
    /// `cc_send_state` verworfen, damit ein Neustart wieder frisch gegen den
    /// echten Gerätewert (= Ruhelage) vergleicht statt gegen den alten last_val.
    slot_id: String,
    seen: bool,
}

/// Ein kompilierter CC-Layer (LFO/Envelope/Ramp/Random/Stepped) — einmal beim
/// Rebuild aus dem rohen JSON geparst, damit pro Puls keine JSON-Lookups nötig
/// sind. Werte sind immer 0..1 normiert (wie im Modell), Skalierung auf
/// outMin..outMax passiert erst nach dem Kombinieren aller Layer.
enum CcLayerCompiled {
    Lfo {
        enabled: bool,
        combine: String,
        depth: f64,
        offset: f64,
        waveform: String,
        rate_mode: String,
        rate_bars: f64,
        rate_hz: f64,
        phase: f64,
        /// Key-Tracking der Rate: 0 = aus. 1 = die Rate verdoppelt sich pro
        /// Oktave über Note 60 (halbiert pro Oktave darunter). Negativ = kehrt
        /// die Richtung um. Braucht eine auslösende Note (`Playback::trigger_note`).
        rate_key_track: f64,
    },
    Envelope {
        enabled: bool,
        combine: String,
        depth: f64,
        offset: f64,
        points: Vec<(u32, f64)>, // nach step sortiert
    },
    Ramp {
        enabled: bool,
        combine: String,
        depth: f64,
        offset: f64,
        from: f64,
        to: f64,
    },
    Random {
        enabled: bool,
        combine: String,
        depth: f64,
        offset: f64,
        every_steps: u32,
        smooth: bool,
    },
    Stepped {
        enabled: bool,
        combine: String,
        depth: f64,
        offset: f64,
        values: Vec<f64>,
    },
}

impl CcLayerCompiled {
    fn enabled(&self) -> bool {
        match self {
            Self::Lfo { enabled, .. }
            | Self::Envelope { enabled, .. }
            | Self::Ramp { enabled, .. }
            | Self::Random { enabled, .. }
            | Self::Stepped { enabled, .. } => *enabled,
        }
    }
    fn combine(&self) -> &str {
        match self {
            Self::Lfo { combine, .. }
            | Self::Envelope { combine, .. }
            | Self::Ramp { combine, .. }
            | Self::Random { combine, .. }
            | Self::Stepped { combine, .. } => combine,
        }
    }
    fn depth(&self) -> f64 {
        match self {
            Self::Lfo { depth, .. }
            | Self::Envelope { depth, .. }
            | Self::Ramp { depth, .. }
            | Self::Random { depth, .. }
            | Self::Stepped { depth, .. } => *depth,
        }
    }
    fn offset(&self) -> f64 {
        match self {
            Self::Lfo { offset, .. }
            | Self::Envelope { offset, .. }
            | Self::Ramp { offset, .. }
            | Self::Random { offset, .. }
            | Self::Stepped { offset, .. } => *offset,
        }
    }

    /// Roh-Wert 0..1 an der aktuellen Position, VOR depth/offset/combine.
    fn eval(&self, ctx: &CcEvalCtx) -> f64 {
        match self {
            Self::Lfo { waveform, rate_mode, rate_bars, rate_hz, phase, rate_key_track, .. } => {
                // Key-Tracking: eine höhere auslösende Note macht den LFO
                // schneller (eine Oktave = ×2 bei rate_key_track = 1).
                let kt = match (*rate_key_track != 0.0).then_some(()).and(ctx.trigger_note) {
                    Some(n) => 2f64.powf((n as f64 - 60.0) / 12.0 * *rate_key_track),
                    None => 1.0,
                };
                let raw_phase = if rate_mode == "hz" {
                    ctx.elapsed_secs * (rate_hz * kt) + phase
                } else {
                    let bars = ctx.global_pulse as f64 / ctx.ppb.max(1) as f64;
                    // Schnellere Rate = kürzere Periode (in Takten).
                    bars / (rate_bars / kt).max(0.0001) + phase
                };
                eval_waveform(waveform, raw_phase)
            }
            Self::Envelope { points, .. } => eval_envelope(points, ctx.step_pos),
            Self::Ramp { from, to, .. } => {
                let t = ctx.pos as f64 / ctx.len_pulses.max(1) as f64;
                from + (to - from) * t
            }
            // Bewusst die GLOBALE Step-Position: mit der baustein-lokalen käme
            // bei jedem Loop-Durchlauf exakt dieselbe „Zufalls"-Folge heraus
            // (`hash01` ist zustandslos) — ein Random-Layer, der sich jeden
            // Takt wiederholt, ist kein Random.
            Self::Random { every_steps, smooth, .. } => {
                eval_random(*every_steps, *smooth, ctx.global_step_pos)
            }
            Self::Stepped { values, .. } => values.get(ctx.step_index).copied().unwrap_or(0.0),
        }
    }
}

/// Positions-/Zeitkontext für die Layer-Auswertung an einem Puls.
struct CcEvalCtx {
    step_pos: f64,   // fraktionale Step-Position im Baustein — für Envelope
    step_index: usize, // floor(step_pos), für Stepped
    global_step_pos: f64, // Step-Position seit Transport-Start — für Random
    pos: u32,        // Puls-Position im Baustein
    len_pulses: u32,
    global_pulse: u64,
    ppb: u32, // Pulse pro Takt (für taktsynchronen LFO)
    elapsed_secs: f64, // seit Transport-Start (für Hz-LFO)
    trigger_note: Option<u8>, // auslösende Note — für LFO-Key-Tracking (rateKeyTrack)
}

/// Kombiniert alle enabled Layer von unten nach oben (siehe `CcCombineMode` im
/// Modell) zu einem finalen 0..1-Wert.
///
/// Der UNTERSTE aktive Layer ist immer die Basis, sein `combine` wird ignoriert:
/// mit einem Start-Akku von 0 hätten „multiply"/„min" dort sonst zwangsläufig 0
/// ergeben — ein stummer Baustein, dessen Ursache in der UI nirgends sichtbar
/// ist. Die UI zeigt für diesen Layer deshalb „base" statt eines Modus-Buttons.
fn eval_cc_layers(layers: &[CcLayerCompiled], ctx: &CcEvalCtx) -> f64 {
    let mut acc = 0.0f64;
    let mut is_base = true;
    for layer in layers {
        if !layer.enabled() {
            continue;
        }
        // depth skaliert die Bewegung, offset verschiebt sie danach — in dieser
        // Reihenfolge, damit „halbe Tiefe, um 50% angehoben" auch genau das
        // heißt und offset nicht selbst mitskaliert wird.
        let contrib = (layer.eval(ctx) * layer.depth() + layer.offset()).clamp(0.0, 1.0);
        acc = if is_base {
            contrib
        } else {
            match layer.combine() {
                "multiply" => acc * contrib,
                "max" => acc.max(contrib),
                "min" => acc.min(contrib),
                "replace" => contrib,
                _ => acc + contrib, // "add"
            }
        };
        is_base = false;
    }
    acc.clamp(0.0, 1.0)
}

fn eval_waveform(waveform: &str, raw_phase: f64) -> f64 {
    match waveform {
        "sine" => {
            let p = raw_phase.rem_euclid(1.0);
            0.5 + 0.5 * (p * std::f64::consts::TAU).sin()
        }
        "triangle" => {
            let p = raw_phase.rem_euclid(1.0);
            if p < 0.5 {
                2.0 * p
            } else {
                2.0 * (1.0 - p)
            }
        }
        "sawUp" => raw_phase.rem_euclid(1.0),
        "sawDown" => 1.0 - raw_phase.rem_euclid(1.0),
        "square" => {
            if raw_phase.rem_euclid(1.0) < 0.5 {
                1.0
            } else {
                0.0
            }
        }
        "randomSmooth" => {
            let n = raw_phase.floor();
            let frac = raw_phase - n;
            let a = hash01(n as i64);
            let b = hash01(n as i64 + 1);
            a + (b - a) * frac
        }
        _ => 0.5,
    }
}

fn eval_envelope(points: &[(u32, f64)], step_pos: f64) -> f64 {
    let Some(&(first_step, first_val)) = points.first() else {
        return 0.0;
    };
    if step_pos <= first_step as f64 {
        return first_val;
    }
    let &(last_step, last_val) = points.last().unwrap();
    if step_pos >= last_step as f64 {
        return last_val;
    }
    for w in points.windows(2) {
        let (s0, v0) = w[0];
        let (s1, v1) = w[1];
        if step_pos >= s0 as f64 && step_pos <= s1 as f64 {
            let span = (s1 as f64 - s0 as f64).max(0.0001);
            let t = (step_pos - s0 as f64) / span;
            return v0 + (v1 - v0) * t;
        }
    }
    last_val
}

fn eval_random(every_steps: u32, smooth: bool, step_pos: f64) -> f64 {
    let span = every_steps.max(1) as f64;
    let bucket = (step_pos / span).floor();
    if !smooth {
        hash01(bucket as i64)
    } else {
        let frac = step_pos / span - bucket;
        let a = hash01(bucket as i64);
        let b = hash01(bucket as i64 + 1);
        a + (b - a) * frac
    }
}

/// Deterministischer Pseudo-Zufallswert 0..1 aus einem Integer-Seed
/// (splitmix64-artige Mischung) — bewusst zustandslos: derselbe Bucket-Index
/// liefert immer denselben Wert, kein mutable RNG-State pro Baustein nötig.
fn hash01(n: i64) -> f64 {
    let mut x = (n as u64) ^ 0x9E37_79B9_7F4A_7C15;
    x = x.wrapping_mul(0xBF58_476D_1CE4_E5B9);
    x ^= x >> 33;
    x = x.wrapping_mul(0x94D0_49BB_1331_11EB);
    x ^= x >> 33;
    (x >> 11) as f64 / (1u64 << 53) as f64
}

struct CcAutomation {
    out_min: u8,
    out_max: u8,
    /// Ziel der LANE (nicht des Bausteins). `None`, solange die Lane keinen
    /// Knob verknüpft hat — der Baustein spielt dann stumm (wie ein Control
    /// ohne Mapping).
    target: Option<CcTarget>,
    /// `true` = der zuletzt gesendete Wert bleibt stehen. `false` (Standard) =
    /// das Ziel kehrt am Baustein-Ende zur Ruhelage (`CcTarget::rest_value`)
    /// zurück — die Automation ist damit nicht-destruktiv.
    destructive: bool,
    layers: Vec<CcLayerCompiled>,
}

enum CKind {
    Melody(Vec<CNote>),
    /// pro Step eine Liste aus (Note, Velocity)
    Beat(Vec<Vec<(u8, u8)>>),
    Cc(CcAutomation),
    /// Akkord: mehrere Noten pro Step. Spielt exakt wie `Melody` — der eigene
    /// Zweig existiert nur, damit der Runtime-Snapshot den Typ korrekt meldet.
    Chord(Vec<CNote>),
    /// Arpeggio: aus dem Notenvorrat vorab erzeugte Einzelnoten. Spielt wie
    /// `Melody` (s. `Chord`).
    Arp(Vec<CNote>),
}

struct CBlock {
    slot_id: String,
    /// Id des BAUSTEINS (nicht des Slots) — der Baustein-Detail-Editor kennt
    /// nur diese Id und braucht sie im Runtime-Snapshot, um seinen Playhead
    /// zuzuordnen (derselbe Baustein kann in mehreren Lanes laufen).
    block_id: String,
    pulses_per_step: u32,
    len_pulses: u32,
    /// Pulse pro Takt — nur für CC/LFO-Taktsync relevant (0 bei anderen Kinds egal).
    ppb: u32,
    /// Wie oft dieser Block spielt, bevor die Lane laut `play_mode` weiterrückt:
    /// 1 = einmal (1×), N = N-mal (×N), 0 = endlos (∞, rückt nie weiter).
    max_loops: u32,
    channel: u8,
    kind: CKind,
}

/// Letzter gesendeter Wert + Zeitpunkt eines CC-Bausteins, pro Slot — Grundlage
/// des Sende-Rate-Limits (`MIN_CC_SEND_INTERVAL`).
struct CcSendState {
    last_val: Option<u8>,
    last_sent: Instant,
}

/// Eigenständige „▶ Play" im Baustein-Detail: spielt GENAU einen Baustein
/// einmal oder in Schleife ab — unabhängig vom Transport (läuft auch bei
/// Stillstand) und ohne dass er in einer Lane stecken muss. Bewusst NICHT
/// Teil von `Engine::lanes`/`playback`: es gibt immer höchstens eine aktive
/// Vorschau (das aktuell offene Baustein-Detail), ein neuer Start (oder das
/// Schließen des Editors) löst die alte einfach ab.
struct PreviewPlayback {
    port: String,
    cb: CBlock,
    /// Position im Baustein — läuft bei `looping` am Ende auf 0 zurück.
    pos: u32,
    /// Freilaufender Puls-Zähler, NIE zurückgesetzt — Grundlage der
    /// Note-Off-Fälligkeiten, damit eine über eine Schleifengrenze klingende
    /// Note nicht mit der neuen Runde verwechselt wird.
    global_pulse: u64,
    /// Sekunden seit Start — Zeitbasis für Hz-LFOs eines CC-Bausteins.
    elapsed_secs: f64,
    looping: bool,
    /// Fällige Note-Offs dieser Vorschau: (Kanal, Note, fällig bei `global_pulse`).
    /// Eigener, kleiner Puffer statt `Engine::pending` — der ist über
    /// `PendingOff::lane_idx` an echte Lanes gebunden.
    pending: Vec<(u8, u8, u64)>,
    /// Rate-Limit-Zustand für CC-Bausteine, analog `CcSendState`.
    cc_last_val: Option<u8>,
    cc_last_sent: Instant,
}

struct CLane {
    id: String,
    port: String,
    enabled: bool,
    /// "sequential" (Default) rückt beim Blockende zum nächsten Slot vor,
    /// "random" springt zu einem zufälligen, "manual" bleibt stehen (repeat)
    /// bis der Slot per `trigger_slot` (Touch) gewechselt wird.
    play_mode: String,
    /// Wann ein per Touch ausgelöster Slot tatsächlich startet:
    /// "immediate" | "nextBeat" | "nextBar" | "nextBlock" (s. `trigger_slot`).
    trigger_quantize: String,
    /// Trigger-Kette: wird ein Slot DIESER Lane ausgelöst, wird zusätzlich
    /// `(laneId, slotId)` mit ausgelöst (auf dessen eigener Quantisierung) —
    /// z.B. Melodie-Lane zündet einen CC-Effekt mit. `None` = keine Kette.
    chain: Option<(String, String)>,
    /// Index (in `Engine::lanes`) einer Melodie-Lane, deren gespielte Noten
    /// das LFO-Key-Tracking dieser (CC-)Lane treiben (`Lane::keytrack_source_lane_id`,
    /// aufgelöst beim Rebuild). `None` = kein internes Keytrack.
    keytrack_source: Option<usize>,
    blocks: Vec<CBlock>,
}

#[derive(Clone, Copy)]
struct Playback {
    slot: usize,
    pos: u32, // Pulse-Position im aktuellen Block
    /// Wie oft der aktuelle Block seit dem letzten Slot-Wechsel durchgelaufen
    /// ist — mit `CBlock::max_loops` verglichen, um zu entscheiden, wann die
    /// Lane weiterrückt (sequential/random).
    loops_done: u32,
    /// Monoton steigender Zähler gefeuerter Note-Steps dieser Lane. Die UI
    /// vergleicht ihn zwischen zwei Snapshots und blitzt bei jedem Zuwachs —
    /// so hängt das Aufleuchten an echten Noten und nicht an Step-Grenzen,
    /// die auch leer sein können.
    hits: u32,
    /// Nur für `play_mode` "hold"/"oneShot": ob die Lane gerade läuft. Solche
    /// Lanes sind stumm (`on_pulse` überspringt sie), bis `press_slot` sie
    /// startet; `release_slot` bzw. das Baustein-Ende (oneShot) stoppt sie.
    /// Bei allen anderen Play-Modes immer `true`.
    running: bool,
    /// Nur "hold": die Kachel wird gerade gehalten — am Baustein-Ende von vorn
    /// loopen statt stoppen. `release_slot` setzt es zurück.
    held: bool,
    /// Per Touch ausgelöst, wartet auf die Quantisierungsgrenze. `None` = nichts
    /// vorgemerkt. Ein erneuter Touch überschreibt (letzter Wunsch gewinnt), ein
    /// Touch auf den bereits wartenden Slot nimmt die Vormerkung zurück.
    queued: Option<usize>,
    /// Note, die diese Lane zuletzt ausgelöst hat (MIDI-Trigger). Treibt das
    /// LFO-Key-Tracking von CC-Bausteinen (`rateKeyTrack`). `None` bei Touch-
    /// oder Sequencer-Auslösung ohne Note.
    trigger_note: Option<u8>,
}

struct PendingOff {
    port: String,
    ch: u8,
    note: u8,
    at: u64, // absoluter Puls
    /// Index der Lane, die dieses Note-Off erzeugt hat — `release_slot` kann so
    /// gezielt die noch offenen Noten genau dieser Lane sofort abschalten.
    lane_idx: usize,
}

/// Momentaufnahme der Wiedergabe EINER Lane — die Grundlage des UI-Feedbacks
/// ("welcher Baustein läuft gerade, wie weit ist er durch"). Bewusst schlank
/// und ohne Interpolation: gesendet wird nur im UI-Broadcast-Raster (16tel),
/// die Position zwischen zwei Snapshots rechnet die UI selbst weiter
/// (s. ui/src/app/runtime.ts).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LaneRuntime {
    pub lane_id: String,
    /// `LaneSlot.id` des laufenden Bausteins (nicht die Block-Id — dieselbe
    /// Kachel-Identität, die die UI in `lane.slots` kennt).
    pub slot_id: String,
    /// Id des laufenden Bausteins — Adresse des Baustein-Detail-Feedbacks.
    pub block_id: String,
    /// Art des laufenden Bausteins ("melody" | "beat" | "cc"), damit das UI
    /// das Feedback beschriften kann, ohne das Projekt nachzuschlagen.
    pub kind: &'static str,
    pub pos: u32,
    pub len_pulses: u32,
    pub step: u32,
    pub steps: u32,
    pub hits: u32,
    /// Nur CC-Bausteine: die CC-Nummer, auf die die Lane sendet. `None` heißt
    /// „kein Ziel-Knob verknüpft" — der Baustein läuft, sendet aber nichts.
    /// Genau das soll der offene CC-Editor zeigen können, statt stumm zu wirken.
    pub cc_number: Option<u8>,
    /// Zuletzt tatsächlich GESENDETER 7-Bit-Wert dieses Slots (nicht der eben
    /// berechnete): was hier steht, ging auch über den Port raus.
    pub cc_value: Option<u8>,
    /// Per Touch vorgemerkter Slot, der noch auf seine Quantisierungsgrenze
    /// wartet (s. `trigger_slot`). Die UI markiert diese Kachel als „scharf",
    /// damit sichtbar ist, dass der Griff angekommen ist — sonst wirkt ein
    /// Touch bis zum nächsten Takt wie verschluckt.
    pub queued_slot_id: Option<String>,
    /// Klingt diese Lane gerade wirklich? Für "hold"/"oneShot" ist sie zwischen
    /// den Auslösungen stumm. Der Eintrag wird trotzdem gesendet, sobald etwas
    /// vorgemerkt ist (`queued_slot_id`) — nur so kann die UI die wartende
    /// Kachel markieren. `false` heißt: nur Vormerkung, noch kein Ton.
    pub running: bool,
}

pub struct Engine {
    midi: MidiOutManager,
    lanes: Vec<CLane>,
    playback: Vec<Playback>,
    pending: Vec<PendingOff>,
    gen_seen: u64,
    /// Ports der Devices mit aktiviertem `sendClock` — Clock/Start/Stop gehen
    /// NUR dorthin, nicht an jeden offenen Ausgang (s. `Device::send_clock`).
    clock_ports: Vec<String>,
    /// Sekunden seit Transport-Start — Basis für frei laufende (Hz-)LFOs,
    /// unabhängig vom BPM-synchronen Puls-Zähler.
    elapsed_secs: f64,
    /// Letzter gesendeter CC-Wert je Slot (Rate-Limit, s. `MIN_CC_SEND_INTERVAL`).
    cc_send_state: HashMap<String, CcSendState>,
    /// Aktuell von CC-Bausteinen bespielte Ziele, Key = (Port, Kanal, CC-Nr).
    /// Grundlage der nicht-destruktiven Rückstellung: fällt ein Ziel aus der
    /// Menge (Baustein zu Ende / Lane gestoppt), geht es zurück auf `rest_value`.
    cc_driven: HashMap<(String, u8, u8), CcDrive>,
    /// Vom Clock-Thread nach dem Puls abzuholen: (controlId, value) — als
    /// `control.valueChanged` an die UI und zurück in `project.controls`,
    /// damit der Dashboard-Knob sichtbar auf die Ruhelage zurückspringt.
    cc_restores: Vec<(String, u8)>,
    /// Läuft der Transport? Bei Stillstand kommen keine Puls-Grenzen mehr, also
    /// startet ein getriggerter Slot dann sofort — sonst würde ein Touch bei
    /// gestopptem Transport scheinbar ins Leere gehen.
    playing: bool,
    /// Pulse pro Takt aus der Projekt-Taktart — Grenze für "nextBar".
    bar_pulses: u32,
    /// Eigenständige Baustein-Vorschau des Baustein-Details (s. `PreviewPlayback`).
    /// `None` = kein Editor mit aktiver „▶ Play" gerade offen.
    preview: Option<PreviewPlayback>,
}

impl Engine {
    pub fn new() -> Self {
        Self {
            midi: MidiOutManager::new(),
            lanes: Vec::new(),
            playback: Vec::new(),
            pending: Vec::new(),
            gen_seen: u64::MAX,
            clock_ports: Vec::new(),
            elapsed_secs: 0.0,
            cc_send_state: HashMap::new(),
            cc_driven: HashMap::new(),
            cc_restores: Vec::new(),
            playing: false,
            bar_pulses: pulses_per_bar("4/4"),
            preview: None,
        }
    }

    pub fn clock_pulse(&mut self) {
        for port in &self.clock_ports {
            self.midi.send(port, &[MIDI_CLOCK]);
        }
    }

    pub fn transport_start(&mut self) {
        self.reset();
        self.playing = true;
        for port in &self.clock_ports {
            self.midi.send(port, &[MIDI_START]);
        }
    }

    pub fn transport_stop(&mut self) {
        self.playing = false;
        for port in &self.clock_ports {
            self.midi.send(port, &[MIDI_STOP]);
        }
        self.midi.all_notes_off();
        self.pending.clear();
        // Nicht-destruktive CC-Ziele auf ihre Ruhelage zurückstellen — sonst
        // bliebe das Gerät nach dem Stop dort stehen, wo die Automation zuletzt war.
        self.restore_cc_targets(false);
        // Vormerkungen verwerfen: sie beziehen sich auf eine Zeitachse, die es
        // nach dem Stop nicht mehr gibt.
        for pb in &mut self.playback {
            pb.queued = None;
        }
    }

    /// Stellt CC-Ziele auf ihre Ruhelage zurück. `only_idle == true`: nur Ziele,
    /// die im letzten Puls NICHT mehr bespielt wurden (laufende bleiben).
    /// `false`: alle (Transport-Stop). Destruktive Ziele bleiben stehen.
    fn restore_cc_targets(&mut self, only_idle: bool) {
        let keys: Vec<(String, u8, u8)> = self
            .cc_driven
            .iter_mut()
            .filter_map(|(k, d)| {
                if only_idle {
                    if d.seen {
                        d.seen = false;
                        return None;
                    }
                } else {
                    d.seen = false;
                }
                Some(k.clone())
            })
            .collect();
        for key in keys {
            let Some(drive) = self.cc_driven.remove(&key) else { continue };
            if drive.destructive {
                continue;
            }
            // Neustart soll wieder gegen den echten Gerätewert vergleichen.
            self.cc_send_state.remove(&drive.slot_id);
            let (port, ch, cc) = key;
            self.midi
                .send(&port, &[0xB0 | (ch - 1), cc, drive.rest_value]);
            self.cc_restores.push((drive.control_id, drive.rest_value));
        }
    }

    /// Vom Clock-Thread nach jedem Puls / Stop abgeholt: Knopf-Rückstellungen,
    /// die als `control.valueChanged` an die UI und ins Projekt gespiegelt werden.
    pub fn take_cc_restores(&mut self) -> Vec<(String, u8)> {
        std::mem::take(&mut self.cc_restores)
    }

    pub fn panic(&mut self) {
        self.midi.all_notes_off();
        self.pending.clear();
    }

    /// Löst den Baustein hinter `slot_id` in der Lane `lane_id` aus — je nach
    /// `Lane.trigger_quantize` sofort oder erst zur nächsten Grenze.
    ///
    /// Sofort passiert es nur bei "immediate" oder wenn der Transport steht
    /// (dann käme nie eine Grenze). Sonst wird der Slot vorgemerkt und
    /// `apply_queued` schaltet ihn auf dem passenden Puls scharf. Ein zweiter
    /// Touch auf dieselbe wartende Kachel nimmt die Vormerkung zurück — sonst
    /// ließe sich ein Fehlgriff bis zum nächsten Takt nicht mehr korrigieren.
    pub fn trigger_slot(&mut self, lane_id: &str, slot_id: &str, note: Option<u8>) {
        self.trigger_slot_depth(lane_id, slot_id, note, 0);
    }

    /// Wie `trigger_slot`, plus Trigger-Kette (`CLane::chain`). `depth` bricht
    /// eine versehentliche Rückkopplung (A→B→A) nach ein paar Sprüngen ab.
    fn trigger_slot_depth(&mut self, lane_id: &str, slot_id: &str, note: Option<u8>, depth: u8) {
        let Some(idx) = self.lanes.iter().position(|l| l.id == lane_id) else {
            return;
        };
        let Some(block_idx) = self.lanes[idx].blocks.iter().position(|b| b.slot_id == slot_id) else {
            return;
        };
        self.playback[idx].trigger_note = note;
        if self.triggers_now(idx) {
            self.playback[idx].queued = None;
            self.start_slot(idx, block_idx);
        } else if self.playback[idx].queued == Some(block_idx) {
            self.playback[idx].queued = None;
        } else {
            self.playback[idx].queued = Some(block_idx);
        }
        self.fire_chain(idx, note, depth);
    }

    /// Zündet die Trigger-Kette der Lane `idx` (falls gesetzt) mit —
    /// als regulärer `trigger_slot` auf der Ziel-Lane (deren eigene
    /// Quantisierung / Play-Mode gelten).
    fn fire_chain(&mut self, idx: usize, note: Option<u8>, depth: u8) {
        if depth >= 8 {
            return;
        }
        if let Some((cl, cs)) = self.lanes[idx].chain.clone() {
            self.trigger_slot_depth(&cl, &cs, note, depth + 1);
        }
    }

    /// Klingt diese Lane gerade? "hold"/"oneShot" sind zwischen den
    /// Auslösungen stumm; alle anderen Play-Modes laufen immer durch.
    fn is_sounding(&self, idx: usize) -> bool {
        !matches!(self.lanes[idx].play_mode.as_str(), "hold" | "oneShot")
            || self.playback[idx].running
    }

    /// Soll dieser Trigger sofort greifen, statt vorgemerkt zu werden?
    ///
    /// Neben "immediate" und stehendem Transport ist der dritte Fall der
    /// wichtige: "nextBlock" wartet auf das ENDE des laufenden Bausteins — läuft
    /// gerade keiner (stumme hold/oneShot-Lane), kommt dieses Ende nie, und die
    /// Vormerkung bliebe für immer hängen. Ohne Baustein gibt es nichts
    /// abzuwarten, also los.
    fn triggers_now(&self, idx: usize) -> bool {
        match self.lanes[idx].trigger_quantize.as_str() {
            _ if !self.playing => true,
            "immediate" => true,
            "nextBlock" => !self.is_sounding(idx),
            _ => false,
        }
    }

    /// Setzt eine Lane auf einen Slot und startet ihn von vorn.
    fn start_slot(&mut self, idx: usize, block_idx: usize) {
        self.playback[idx].slot = block_idx;
        self.playback[idx].pos = 0;
        self.playback[idx].loops_done = 0;
    }

    /// Schaltet vorgemerkte Slots scharf, deren Grenze auf `global_pulse` fällt.
    /// Läuft VOR dem Abspielen des Pulses, damit der neue Baustein denselben
    /// Puls noch als seinen Step 0 spielt — sonst käme er einen Puls zu spät.
    ///
    /// "nextBlock" wird hier NICHT behandelt: dessen Grenze ist das Ende des
    /// laufenden Bausteins, und das kennt nur die Fortschaltung in `on_pulse`.
    fn apply_queued(&mut self, global_pulse: u64) {
        for idx in 0..self.lanes.len() {
            let Some(block_idx) = self.playback[idx].queued else {
                continue;
            };
            let hit = match self.lanes[idx].trigger_quantize.as_str() {
                "nextBeat" => global_pulse % PPQN as u64 == 0,
                "nextBar" => global_pulse % self.bar_pulses.max(1) as u64 == 0,
                _ => false,
            };
            if hit {
                self.playback[idx].queued = None;
                self.start_slot(idx, block_idx);
                // "oneShot" ist bis zum Auslösen stumm (`running == false`) —
                // beim Scharfschalten muss die Lane also mitlaufen, sonst
                // überspringt `on_pulse` sie weiterhin und man hört nichts.
                if matches!(self.lanes[idx].play_mode.as_str(), "hold" | "oneShot") {
                    self.playback[idx].running = true;
                    self.playback[idx].held = self.lanes[idx].play_mode == "hold";
                }
            }
        }
    }

    /// Touch-Down auf eine Kachel einer "hold"/"oneShot"-Lane: den Baustein von
    /// vorn starten und die (sonst stumme) Lane laufen lassen. Bei "hold" bleibt
    /// sie laufen, solange `held` gesetzt ist; bei "oneShot" stoppt sie am
    /// Baustein-Ende von selbst (siehe `on_pulse`).
    pub fn press_slot(&mut self, lane_id: &str, slot_id: &str, note: Option<u8>) {
        let Some(idx) = self.lanes.iter().position(|l| l.id == lane_id) else {
            return;
        };
        let Some(block_idx) = self.lanes[idx].blocks.iter().position(|b| b.slot_id == slot_id) else {
            return;
        };
        self.playback[idx].trigger_note = note;
        // "hold" wird SOFORT scharf: die Lane soll klingen, solange der Finger
        // liegt — würde der Start auf den nächsten Takt warten, wäre die Geste
        // bei einem kurzen Antippen schon vorbei, bevor überhaupt etwas kommt.
        // "oneShot" dagegen ist ein normaler Auslöser und folgt der
        // Quantisierung wie `trigger_slot`.
        let hold = self.lanes[idx].play_mode == "hold";
        if hold || self.triggers_now(idx) {
            self.playback[idx].queued = None;
            self.start_slot(idx, block_idx);
            self.playback[idx].running = true;
            self.playback[idx].held = hold;
        } else if self.playback[idx].queued == Some(block_idx) {
            self.playback[idx].queued = None; // zweiter Tipp = Vormerkung zurück
        } else {
            self.playback[idx].queued = Some(block_idx);
        }
        // Auch ein Press (MIDI-Note-On auf eine getaktete Lane) zündet die Kette.
        self.fire_chain(idx, note, 1);
    }

    /// Touch-Up auf eine "hold"-Lane: Baustein stoppen, Lane wieder stumm
    /// schalten und alle noch offenen Noten dieser Lane sofort abschalten
    /// (nicht erst zur regulären Off-Fälligkeit). No-op für andere Lanes.
    pub fn release_slot(&mut self, lane_id: &str) {
        let Some(idx) = self.lanes.iter().position(|l| l.id == lane_id) else {
            return;
        };
        // Loslassen (Touch-Up / Note-Off) wirkt NUR im "hold"-Modus als Gate.
        // In allen Auto-Run-Modi (sequential/oneShot/random/manual) läuft ein
        // ausgelöster Baustein durch — ein Note-Off darf ihn nicht abwürgen.
        // Der MIDI-Trigger-Pfad schickt `ReleaseSlot` unabhängig vom Modus
        // (s. `handle_midi_feedback`), also hier aussieben.
        if self.lanes[idx].play_mode != "hold" {
            return;
        }
        // Finger weg, bevor eine Vormerkung scharf wurde: verwerfen, sonst
        // startete die Lane nach dem Loslassen von allein.
        self.playback[idx].queued = None;
        self.playback[idx].running = false;
        self.playback[idx].held = false;
        self.playback[idx].pos = 0;
        self.playback[idx].loops_done = 0;

        // Offene Note-Offs dieser Lane herauslösen und pro Port in EINEM Packet
        // rausschicken — wie die Batch-Logik in `on_pulse`.
        let mut off_batches: std::collections::HashMap<String, Vec<u8>> = std::collections::HashMap::new();
        let mut i = 0;
        while i < self.pending.len() {
            if self.pending[i].lane_idx == idx {
                let off = self.pending.swap_remove(i);
                off_batches
                    .entry(off.port)
                    .or_default()
                    .extend_from_slice(&[0x80 | (off.ch - 1), off.note, 0]);
            } else {
                i += 1;
            }
        }
        for (port, bytes) in off_batches {
            self.midi.send(&port, &bytes);
        }
    }

    /// Sendet rohe MIDI-Bytes an einen Port (für Live-Controls vom Dashboard).
    /// Liefert `false`, wenn der Ausgang nicht erreichbar war.
    pub fn send_raw(&mut self, port: &str, bytes: &[u8]) -> bool {
        self.midi.send(port, bytes)
    }

    fn reset(&mut self) {
        for p in self.playback.iter_mut() {
            p.slot = 0;
            p.pos = 0;
            p.loops_done = 0;
            // "hold"/"oneShot"-Lanes nach einem Transport-Neustart wieder
            // scharf (stumm bis zum nächsten Touch); für alle anderen egal.
            p.running = false;
            p.held = false;
        }
        self.pending.clear();
        self.elapsed_secs = 0.0;
        // Frischer Transport-Start: laufende Rückstell-Buchführung verwerfen
        // (nichts zu senden — die Bausteine fangen ohnehin von vorn an).
        self.cc_driven.clear();
        self.cc_restores.clear();
    }

    /// Rekompiliert bei geänderter Projekt-Generation.
    pub fn rebuild_if_needed(&mut self, project: &Project, generation: u64) {
        if generation == self.gen_seen {
            return;
        }
        self.gen_seen = generation;
        self.rebuild(project);
    }

    fn rebuild(&mut self, project: &Project) {
        // Taktlänge fürs "nextBar"-Raster — die Taktart kann sich im Projekt
        // ändern, also bei jedem Rebuild mitziehen.
        self.bar_pulses = pulses_per_bar(&project.time_signature);
        // Bisherige Playback-Positionen je Lane-ID merken.
        let prev: std::collections::HashMap<String, Playback> = self
            .lanes
            .iter()
            .zip(self.playback.iter())
            .map(|(l, p)| (l.id.clone(), *p))
            .collect();

        let mut clock_ports = Vec::new();
        for dev in &project.devices {
            if dev.send_clock && !clock_ports.contains(&dev.midi_out_port) {
                clock_ports.push(dev.midi_out_port.clone());
            }
        }
        self.clock_ports = clock_ports;

        let mut lanes = Vec::new();
        // Roh-Ids parallel zu `lanes` gesammelt — die Ziel-Lane eines
        // Keytrack-Bezugs kann im flachen Index vor ODER nach der Quelle
        // liegen, also erst nach dem Aufbau aller Lanes zu Indizes auflösen.
        let mut keytrack_source_ids: Vec<Option<String>> = Vec::new();
        // Bausteine liegen projektweit (nicht mehr je Device) — einmal referenzieren.
        let blocks_json = &project.blocks;
        for dev in &project.devices {
            let dev_muted = dev.muted;
            for lane in &dev.lanes {
                let port = if dev.midi_out_port.is_empty() {
                    String::new()
                } else {
                    dev.midi_out_port.clone()
                };
                let lane_channel = lane.channel.clamp(1, 16);
                // CC-Ziel hängt an der Lane, nicht am Baustein — einmal pro
                // Lane auflösen und an alle ihre CC-Bausteine durchreichen.
                let cc_target =
                    resolve_cc_target(&lane.cc_control_id, dev, lane_channel, &project.controls);
                let blocks = compile_slots(&lane.slots, blocks_json, lane_channel, cc_target);
                let chain = lane
                    .chain_slot
                    .as_ref()
                    .map(|c| (c.lane_id.clone(), c.slot_id.clone()));
                keytrack_source_ids.push(lane.keytrack_source_lane_id.clone());
                lanes.push(CLane {
                    id: lane.id.clone(),
                    port,
                    enabled: lane.enabled && !lane.muted && !dev_muted,
                    play_mode: lane.play_mode.clone(),
                    trigger_quantize: lane.trigger_quantize.clone(),
                    chain,
                    keytrack_source: None, // unten aufgelöst
                    blocks,
                });
            }
        }
        // Ids → Indizes auflösen. Eine gelöschte/unbekannte Quelle verwirft
        // sich selbst (bleibt `None`) statt auf die falsche Lane zu zeigen.
        let resolved: Vec<Option<usize>> = {
            let idx_by_id: HashMap<&str, usize> =
                lanes.iter().enumerate().map(|(i, l)| (l.id.as_str(), i)).collect();
            keytrack_source_ids
                .iter()
                .map(|source_id| source_id.as_deref().and_then(|id| idx_by_id.get(id).copied()))
                .collect()
        };
        for (i, source_idx) in resolved.into_iter().enumerate() {
            lanes[i].keytrack_source = source_idx;
        }

        self.playback = lanes
            .iter()
            .map(|l| {
                let mut pb = prev
                    .get(&l.id)
                    .copied()
                    .unwrap_or(Playback {
                        slot: 0,
                        pos: 0,
                        hits: 0,
                        loops_done: 0,
                        running: false,
                        held: false,
                        queued: None,
                        trigger_note: None,
                    });
                if l.blocks.is_empty() {
                    pb.slot = 0;
                    pb.pos = 0;
                } else {
                    pb.slot %= l.blocks.len();
                    if pb.pos >= l.blocks[pb.slot].len_pulses {
                        pb.pos = 0;
                    }
                }
                pb
            })
            .collect();

        // Stale CC-Sende-State (gelöschte/verschobene Slots) verwerfen, damit
        // die Map nicht unbegrenzt wächst.
        let active_slot_ids: std::collections::HashSet<&str> = lanes
            .iter()
            .flat_map(|l| l.blocks.iter().map(|b| b.slot_id.as_str()))
            .collect();
        self.cc_send_state.retain(|k, _| active_slot_ids.contains(k.as_str()));

        self.lanes = lanes;
    }

    /// Ein Puls Vorlauf: fällige Note-Offs senden, dann pro Lane Steps auslösen.
    /// `dt_secs` = Dauer dieses Pulses in Sekunden (aus dem aktuellen BPM) —
    /// treibt `elapsed_secs`, die Zeitbasis frei laufender (Hz-)LFOs.
    pub fn on_pulse(&mut self, global_pulse: u64, dt_secs: f64) {
        self.elapsed_secs += dt_secs;

        // Fällige Note-Offs: pro Ziel-Port zu EINEM Puffer zusammenfassen und in
        // einem einzigen `send()` (= ein CoreMIDI-Packet) rausschicken, statt pro
        // Note einen eigenen IPC-Call — sonst driften gleichzeitige Note-Offs
        // durch OS-Scheduling-Jitter zwischen den einzelnen Calls auseinander.
        let mut off_batches: std::collections::HashMap<String, Vec<u8>> = std::collections::HashMap::new();
        let mut i = 0;
        while i < self.pending.len() {
            if self.pending[i].at <= global_pulse {
                let off = self.pending.swap_remove(i);
                off_batches
                    .entry(off.port)
                    .or_default()
                    .extend_from_slice(&[0x80 | (off.ch - 1), off.note, 0]);
            } else {
                i += 1;
            }
        }
        for (port, bytes) in off_batches {
            self.midi.send(&port, &bytes);
        }

        // Vorgemerkte Trigger, deren Grenze genau jetzt liegt, scharfschalten.
        self.apply_queued(global_pulse);

        for idx in 0..self.lanes.len() {
            if !self.lanes[idx].enabled || self.lanes[idx].blocks.is_empty() {
                continue;
            }
            // "hold"/"oneShot"-Lanes sind stumm, bis `press_slot` sie startet.
            let gated = matches!(self.lanes[idx].play_mode.as_str(), "hold" | "oneShot");
            if gated && !self.playback[idx].running {
                continue;
            }
            let (slot, pos) = {
                let pb = self.playback[idx];
                (pb.slot % self.lanes[idx].blocks.len(), pb.pos)
            };

            // Step-Boundary?
            let pps = self.lanes[idx].blocks[slot].pulses_per_step.max(1);
            if pos % pps == 0 {
                let step = pos / pps;
                self.fire_step(idx, slot, step, global_pulse);
            }

            // CC/LFO: anders als Note-Steps kontinuierlich JEDEN Puls auswerten
            // (nicht nur an Step-Grenzen) — Rate-Limit passiert innerhalb.
            self.eval_cc_pulse(idx, slot, pos, global_pulse);

            // Position fortschreiben, ggf. Block/Slot wechseln.
            let len = self.lanes[idx].blocks[slot].len_pulses.max(1);
            let mut next = pos + 1;
            let mut next_slot = slot;
            if next >= len {
                next = 0;
                // Getakte Lanes: nicht weiterrücken, sondern
                //   oneShot → nach EINEM Durchlauf stoppen (Lane wieder stumm).
                //   hold    → von vorn loopen, solange die Kachel gehalten wird;
                //             das `release_slot` beendet es.
                if gated {
                    // Eine "nextBlock"-Vormerkung wartet genau auf DIESEN
                    // Moment. Sie muss vor dem Stummschalten greifen, sonst
                    // bliebe sie liegen: die Lane wäre danach still, und der
                    // stumme Zweig oben überspringt sie fortan — die
                    // Vormerkung käme nie mehr zum Zug.
                    if let Some(queued) = self.playback[idx].queued {
                        if self.lanes[idx].trigger_quantize.as_str() == "nextBlock" {
                            self.playback[idx].queued = None;
                            self.playback[idx].slot = queued;
                            self.playback[idx].pos = 0;
                            self.playback[idx].loops_done = 0;
                            self.playback[idx].running = true;
                            continue;
                        }
                    }
                    if self.lanes[idx].play_mode == "oneShot" {
                        self.playback[idx].running = false;
                    }
                    self.playback[idx].slot = slot;
                    self.playback[idx].pos = 0;
                    continue;
                }
                // Block ist einmal durch. Ob die Lane weiterrückt, entscheiden
                // Play-Mode UND die Loop-Anzahl des Slots:
                //   manual        → bleibt immer stehen (wiederholt current).
                //   max_loops == 0 → ∞, dieser Block loopt endlos, kein Wechsel.
                //   sonst          → nach max_loops Durchläufen weiterrücken;
                //                    "sequential" zum nächsten, "random" zufällig.
                // "nextBlock": der laufende Baustein ist hier zu Ende — das ist
                // genau die Grenze, auf die die Vormerkung gewartet hat. Sie
                // gewinnt gegen die reguläre Fortschaltung.
                if let Some(queued) = self.playback[idx].queued {
                    if self.lanes[idx].trigger_quantize.as_str() == "nextBlock" {
                        self.playback[idx].queued = None;
                        self.playback[idx].slot = queued;
                        self.playback[idx].pos = 0;
                        self.playback[idx].loops_done = 0;
                        if matches!(self.lanes[idx].play_mode.as_str(), "hold" | "oneShot") {
                            self.playback[idx].running = true;
                        }
                        continue;
                    }
                }
                let n_blocks = self.lanes[idx].blocks.len();
                let max_loops = self.lanes[idx].blocks[slot].max_loops;
                if self.lanes[idx].play_mode != "manual" && max_loops != 0 {
                    self.playback[idx].loops_done += 1;
                    if self.playback[idx].loops_done >= max_loops {
                        self.playback[idx].loops_done = 0;
                        next_slot = if self.lanes[idx].play_mode == "random" && n_blocks > 1 {
                            // Echt zufällig — darf auch wieder denselben Slot treffen,
                            // statt ihn zwanghaft auszuschließen.
                            let h = global_pulse.wrapping_mul(2654435761).wrapping_add(idx as u64);
                            (h % n_blocks as u64) as usize
                        } else {
                            (slot + 1) % n_blocks
                        };
                    }
                }
            }
            if next_slot != slot {
                self.playback[idx].loops_done = 0;
            }
            self.playback[idx].slot = next_slot;
            self.playback[idx].pos = next;
        }

        // Ziele, die diesen Puls NICHT mehr bespielt wurden (Baustein zu Ende,
        // Lane gestoppt/gewechselt), auf ihre Ruhelage zurückstellen — sofern
        // nicht destruktiv.
        self.restore_cc_targets(true);
    }

    fn fire_step(&mut self, lane_idx: usize, slot: usize, step: u32, global_pulse: u64) {
        let lane = &self.lanes[lane_idx];
        let port = lane.port.clone();
        let block = &lane.blocks[slot];
        let ch = block.channel;
        let pps = block.pulses_per_step.max(1);

        // (note, vel, off_at) einsammeln, dann senden (Borrow-Konflikt vermeiden).
        let mut hits: Vec<(u8, u8, u64)> = Vec::new();
        let is_notey = matches!(block.kind, CKind::Melody(_) | CKind::Chord(_) | CKind::Arp(_));
        match &block.kind {
            CKind::Melody(notes) | CKind::Chord(notes) | CKind::Arp(notes) => {
                for n in notes {
                    if n.step == step {
                        let off = global_pulse + (n.len_steps.max(1) * pps) as u64;
                        hits.push((n.note, n.vel, off));
                    }
                }
            }
            CKind::Beat(steps) => {
                if let Some(row) = steps.get(step as usize) {
                    for (note, vel) in row {
                        hits.push((*note, *vel, global_pulse + pps as u64));
                    }
                }
            }
            // CC-Bausteine haben keine Step-"Hits" — ihr Ausgang wird
            // kontinuierlich in `eval_cc_pulse` erzeugt, nicht hier.
            CKind::Cc(_) => {}
        }

        // Keytrack-Weitergabe: eine Melodie/Chord/Arp-Lane treibt live das
        // LFO-Key-Tracking jeder CC-Lane, die sie als Quelle gewählt hat
        // (`Lane::keytrack_source_lane_id`) — dieselbe `trigger_note`, die
        // sonst nur ein externer MIDI-Trigger setzt (s. `press_slot`). Bei
        // einem Akkord zählt die höchste Note; ohne neue Noten in diesem
        // Step bleibt die zuletzt gehaltene Note stehen (Sample & Hold).
        if is_notey {
            if let Some(top_note) = hits.iter().map(|h| h.0).max() {
                for i in 0..self.lanes.len() {
                    if self.lanes[i].keytrack_source == Some(lane_idx) {
                        self.playback[i].trigger_note = Some(top_note);
                    }
                }
            }
        }

        // Alle Note-Ons dieses Steps in EINEM Puffer sammeln und mit einem
        // einzigen `send()` (= ein CoreMIDI-Packet, ein Timestamp) rausschicken —
        // sonst bekommt jede Note im Akkord ihren eigenen IPC-Call und die Noten
        // driften durch OS-Scheduling-Jitter hörbar auseinander statt scharf
        // gleichzeitig anzukommen.
        let mut on_bytes = Vec::with_capacity(hits.len() * 3);
        for (note, vel, off) in &hits {
            on_bytes.extend_from_slice(&[0x90 | (ch - 1), *note, *vel]);
            // Retrigger derselben Tonhöhe, solange eine längere Note noch
            // klingt: MIDI kennt kein „Note-Off für GENAU diese Note" — das
            // Off der Vorgängerin würde mitten in die neue fallen und sie
            // abwürgen (bei `lengthSteps` 1 kann das nie passieren, ab 2
            // schon). Also die alte Fälligkeit verwerfen; die neue, spätere
            // beendet beide.
            self.pending
                .retain(|p| !(p.note == *note && p.ch == ch && p.port == port));
            self.pending.push(PendingOff {
                port: port.clone(),
                ch,
                note: *note,
                at: *off,
                lane_idx,
            });
        }
        if !on_bytes.is_empty() {
            self.midi.send(&port, &on_bytes);
            // Sichtbares Lebenszeichen für die UI (s. `LaneRuntime::hits`).
            self.playback[lane_idx].hits = self.playback[lane_idx].hits.wrapping_add(1);
        }
    }

    /// Wiedergabe-Zustand aller Lanes für die UI. Lanes ohne Bausteine (oder
    /// deaktiviert/gemutet, also von `on_pulse` übersprungen) fallen raus —
    /// dann leuchtet in der Übersicht auch nichts.
    pub fn runtime_snapshot(&self) -> Vec<LaneRuntime> {
        let mut out = Vec::with_capacity(self.lanes.len());
        for (idx, lane) in self.lanes.iter().enumerate() {
            if !lane.enabled || lane.blocks.is_empty() {
                continue;
            }
            // Getakte Lanes ("hold"/"oneShot") tauchen nur auf, solange sie
            // wirklich laufen — sonst zeigte die Übersicht einen Dauer-Glow auf
            // einer stummen Lane.
            let gated = matches!(lane.play_mode.as_str(), "hold" | "oneShot");
            let running = !gated || self.playback[idx].running;
            // Stumme getaktete Lane nur dann melden, wenn ein Trigger wartet —
            // sonst zeigte die Übersicht Dauer-Glow auf einer stillen Lane.
            if !running && self.playback[idx].queued.is_none() {
                continue;
            }
            let pb = self.playback[idx];
            let slot = pb.slot % lane.blocks.len();
            let block = &lane.blocks[slot];
            let pps = block.pulses_per_step.max(1);
            let len = block.len_pulses.max(1);
            let (kind, cc_number, cc_value) = match &block.kind {
                CKind::Melody(_) => ("melody", None, None),
                CKind::Beat(_) => ("beat", None, None),
                CKind::Chord(_) => ("chord", None, None),
                CKind::Arp(_) => ("arp", None, None),
                CKind::Cc(auto) => (
                    "cc",
                    auto.target.as_ref().map(|t| t.cc_number),
                    self.cc_send_state.get(&block.slot_id).and_then(|s| s.last_val),
                ),
            };
            out.push(LaneRuntime {
                lane_id: lane.id.clone(),
                slot_id: block.slot_id.clone(),
                block_id: block.block_id.clone(),
                kind,
                pos: pb.pos.min(len),
                len_pulses: len,
                step: pb.pos / pps,
                steps: (len + pps - 1) / pps,
                hits: pb.hits,
                cc_number,
                cc_value,
                running,
                queued_slot_id: pb
                    .queued
                    .and_then(|q| lane.blocks.get(q))
                    .map(|b| b.slot_id.clone()),
            });
        }
        out
    }

    /// Wertet einen CC-Baustein an der aktuellen Puls-Position aus und sendet
    /// den 7-Bit-Wert, wenn er sich geändert hat UND `MIN_CC_SEND_INTERVAL`
    /// seit dem letzten Send verstrichen ist (Schutz gegen einen überlasteten
    /// MIDI-Kanal bei schnellen Hz-LFOs — s. Konstante oben). No-op für
    /// andere Block-Kinds oder wenn kein Knob verknüpft ist.
    fn eval_cc_pulse(&mut self, lane_idx: usize, slot: usize, pos: u32, global_pulse: u64) {
        let (slot_id, out_min, out_max, target, destructive, value01) = {
            let block = &self.lanes[lane_idx].blocks[slot];
            let CKind::Cc(ref auto) = block.kind else { return };
            let Some(target) = auto.target.clone() else { return };
            let destructive = auto.destructive;
            let pulses_per_step = block.pulses_per_step.max(1) as f64;
            let step_pos = pos as f64 / pulses_per_step;
            let ctx = CcEvalCtx {
                step_pos,
                step_index: step_pos.floor().max(0.0) as usize,
                global_step_pos: global_pulse as f64 / pulses_per_step,
                pos,
                len_pulses: block.len_pulses,
                global_pulse,
                ppb: block.ppb,
                elapsed_secs: self.elapsed_secs,
                trigger_note: self.playback[lane_idx].trigger_note,
            };
            let value01 = eval_cc_layers(&auto.layers, &ctx);
            (block.slot_id.clone(), auto.out_min, auto.out_max, target, destructive, value01)
        };

        // NaN/Inf (etwa aus einer extremen Key-Track-Rate) würde sonst als
        // CC 0 rausgehen — diesen Puls lieber auslassen.
        if !value01.is_finite() {
            return;
        }

        // Dieses Ziel wird JETZT bespielt — für die nicht-destruktive
        // Rückstellung merken (unabhängig davon, ob der Wert gleich rausgeht;
        // das Rate-Limit unten ändert daran nichts). Der Ruhewert wird beim
        // ERSTEN Antreffen festgehalten — spätere Bausteine überschreiben ihn
        // nicht, damit gestapelte Effekte alle zur selben Ausgangslage zurück.
        let key = (target.port.clone(), target.channel, target.cc_number);
        self.cc_driven
            .entry(key)
            .and_modify(|d| {
                d.seen = true;
                d.destructive = destructive;
                d.slot_id = slot_id.clone();
            })
            .or_insert(CcDrive {
                control_id: target.control_id.clone(),
                rest_value: target.rest_value,
                destructive,
                slot_id: slot_id.clone(),
                seen: true,
            });

        let span = out_max as i32 - out_min as i32;
        let val = (out_min as f64 + value01.clamp(0.0, 1.0) * span as f64)
            .round()
            .clamp(0.0, 127.0) as u8;

        let now = Instant::now();
        let state = self.cc_send_state.entry(slot_id).or_insert_with(|| CcSendState {
            last_val: None,
            last_sent: now.checked_sub(MIN_CC_SEND_INTERVAL).unwrap_or(now),
        });
        let changed = state.last_val != Some(val);
        let ready = now.duration_since(state.last_sent) >= MIN_CC_SEND_INTERVAL;
        if changed && ready {
            state.last_val = Some(val);
            state.last_sent = now;
            self.midi.send(&target.port, &[0xB0 | (target.channel - 1), target.cc_number, val]);
        }
    }

    // ── Baustein-Detail „▶ Play" (Vorschau eines einzelnen Bausteins) ──────

    /// Kompiliert `block_id` aus der projektweiten Bibliothek und startet eine
    /// eigenständige Vorschau — läuft unabhängig vom Transport (auch bei
    /// Stillstand) und ohne dass der Baustein in einer Lane stecken muss.
    /// Port/Kanal (und bei CC das Ziel) kommen von einer PASSENDEN Lane, nach
    /// derselben Regel wie `block.previewNote` (`block_preview_target` in
    /// ws.rs): bevorzugt eine Lane, die den Baustein wirklich enthält, sonst
    /// die erste Lane derselben Rolle, sonst irgendeine. Ein `Err` trägt einen
    /// UI-tauglichen Grund, warum es nicht ging.
    pub fn start_block_preview(&mut self, project: &Project, block_id: &str, looping: bool) -> Result<(), String> {
        let blocks = project.blocks.as_array().map(|a| a.as_slice()).unwrap_or(&[]);
        let block_json = blocks
            .iter()
            .find(|b| b.get("id").and_then(|v| v.as_str()) == Some(block_id))
            .ok_or_else(|| "This block no longer exists.".to_string())?;
        let block_type = block_json.get("type").and_then(|v| v.as_str()).unwrap_or("");
        if !matches!(block_type, "melody" | "beat" | "cc" | "chord" | "arp") {
            return Err(format!("Preview isn't supported for {block_type} blocks yet."));
        }

        let mut found: Option<(&Device, &Lane)> = None;
        let mut same_role: Option<(&Device, &Lane)> = None;
        let mut any: Option<(&Device, &Lane)> = None;
        'outer: for dev in &project.devices {
            for lane in &dev.lanes {
                if any.is_none() {
                    any = Some((dev, lane));
                }
                if same_role.is_none() && lane.role == block_type {
                    same_role = Some((dev, lane));
                }
                if lane
                    .slots
                    .as_array()
                    .is_some_and(|s| s.iter().any(|s| s.get("blockId").and_then(|v| v.as_str()) == Some(block_id)))
                {
                    found = Some((dev, lane));
                    break 'outer;
                }
            }
        }
        let (dev, lane) = found
            .or(same_role)
            .or(any)
            .ok_or_else(|| "No device/lane set up yet to preview through.".to_string())?;
        if dev.midi_out_port.is_empty() {
            return Err(format!("\"{}\" has no MIDI output port set.", dev.name));
        }
        let channel = lane.channel.clamp(1, 16);
        let cc_target = if block_type == "cc" {
            let target = resolve_cc_target(&lane.cc_control_id, dev, channel, &project.controls);
            if target.is_none() {
                return Err(format!("Lane \"{}\" has no CC target knob set yet.", lane.name));
            }
            target
        } else {
            None
        };

        let block: BlockJson = serde_json::from_value(block_json.clone())
            .map_err(|_| "Could not read this block.".to_string())?;
        let slot = SlotJson {
            id: String::new(),
            block_id: block_id.to_string(),
            transpose: 0,
            speed: 1.0,
            loop_mode: if looping { "loop".to_string() } else { String::new() },
            loop_count: 0,
        };
        let cb = compile_block(&block, &slot, channel, &cc_target)
            .ok_or_else(|| "Could not compile this block.".to_string())?;

        self.stop_preview();
        let now = Instant::now();
        self.preview = Some(PreviewPlayback {
            port: dev.midi_out_port.clone(),
            cb,
            pos: 0,
            global_pulse: 0,
            elapsed_secs: 0.0,
            looping,
            pending: Vec::new(),
            cc_last_val: None,
            cc_last_sent: now.checked_sub(MIN_CC_SEND_INTERVAL).unwrap_or(now),
        });
        Ok(())
    }

    /// Beendet eine laufende Baustein-Vorschau sofort — noch fällige
    /// Note-Offs gehen sofort raus statt erst am regulären Fälligkeitspuls
    /// (der käme ja nie mehr, sobald `on_preview_pulse` nicht mehr tickt).
    pub fn stop_preview(&mut self) {
        if let Some(p) = self.preview.take() {
            if !p.pending.is_empty() {
                let ch = p.cb.channel;
                let mut bytes = Vec::with_capacity(p.pending.len() * 3);
                for (_, note, _) in &p.pending {
                    bytes.extend_from_slice(&[0x80 | (ch - 1), *note, 0]);
                }
                self.midi.send(&p.port, &bytes);
            }
        }
    }

    /// Ein freilaufender Puls der Baustein-Vorschau — unabhängig vom
    /// Transport, im selben BPM-Intervall wie `on_pulse` getickt (s.
    /// `clock.rs`). No-op ohne aktive Vorschau.
    pub fn on_preview_pulse(&mut self, dt_secs: f64) {
        let Some(p) = &mut self.preview else { return };
        p.elapsed_secs += dt_secs;
        let global_pulse = p.global_pulse;
        let ch = p.cb.channel;

        // Fällige Note-Offs.
        let mut off_bytes = Vec::new();
        p.pending.retain(|(c, note, at)| {
            if *at <= global_pulse {
                off_bytes.extend_from_slice(&[0x80 | (c - 1), *note, 0]);
                false
            } else {
                true
            }
        });
        if !off_bytes.is_empty() {
            self.midi.send(&p.port, &off_bytes);
        }

        let pps = p.cb.pulses_per_step.max(1);
        let mut finished = false;
        if p.pos % pps == 0 {
            let step = p.pos / pps;
            match &p.cb.kind {
                CKind::Melody(notes) | CKind::Chord(notes) | CKind::Arp(notes) => {
                    let mut on_bytes = Vec::new();
                    for n in notes {
                        if n.step == step {
                            on_bytes.extend_from_slice(&[0x90 | (ch - 1), n.note, n.vel]);
                            p.pending.push((ch, n.note, global_pulse + (n.len_steps.max(1) * pps) as u64));
                        }
                    }
                    if !on_bytes.is_empty() {
                        self.midi.send(&p.port, &on_bytes);
                    }
                }
                CKind::Beat(steps) => {
                    if let Some(row) = steps.get(step as usize) {
                        let mut on_bytes = Vec::new();
                        for (note, vel) in row {
                            on_bytes.extend_from_slice(&[0x90 | (ch - 1), *note, *vel]);
                            p.pending.push((ch, *note, global_pulse + pps as u64));
                        }
                        if !on_bytes.is_empty() {
                            self.midi.send(&p.port, &on_bytes);
                        }
                    }
                }
                CKind::Cc(_) => {} // unten, kontinuierlich statt an Step-Grenzen
            }
        }
        if let CKind::Cc(auto) = &p.cb.kind {
            if let Some(target) = auto.target.clone() {
                let pulses_per_step = pps as f64;
                let step_pos = p.pos as f64 / pulses_per_step;
                let ctx = CcEvalCtx {
                    step_pos,
                    step_index: step_pos.floor().max(0.0) as usize,
                    global_step_pos: global_pulse as f64 / pulses_per_step,
                    pos: p.pos,
                    len_pulses: p.cb.len_pulses,
                    global_pulse,
                    ppb: p.cb.ppb,
                    elapsed_secs: p.elapsed_secs,
                    // Eigenständige Vorschau, keine Lane, die sie ausgelöst
                    // haben könnte — kein Key-Tracking.
                    trigger_note: None,
                };
                let value01 = eval_cc_layers(&auto.layers, &ctx);
                if value01.is_finite() {
                    let span = auto.out_max as i32 - auto.out_min as i32;
                    let val = (auto.out_min as f64 + value01.clamp(0.0, 1.0) * span as f64)
                        .round()
                        .clamp(0.0, 127.0) as u8;
                    let now = Instant::now();
                    let changed = p.cc_last_val != Some(val);
                    let ready = now.duration_since(p.cc_last_sent) >= MIN_CC_SEND_INTERVAL;
                    if changed && ready {
                        p.cc_last_val = Some(val);
                        p.cc_last_sent = now;
                        self.midi.send(&p.port, &[0xB0 | (ch - 1), target.cc_number, val]);
                    }
                }
            }
        }

        p.global_pulse += 1;
        p.pos += 1;
        if p.pos >= p.cb.len_pulses.max(1) {
            if p.looping {
                p.pos = 0;
            } else {
                finished = true;
            }
        }
        // Einmal durch und nichts mehr fällig: Vorschau von selbst beenden,
        // statt endlos leer weiterzuticken.
        if finished && p.pending.is_empty() {
            self.preview = None;
        }
    }
}

// ── JSON-Parsing der Bausteine/Slots (aus den freien Value-Feldern) ─────────

#[derive(Deserialize)]
struct SlotJson {
    #[serde(default)]
    id: String,
    #[serde(rename = "blockId")]
    block_id: String,
    #[serde(default)]
    transpose: i32,
    #[serde(default = "one")]
    speed: f64,
    #[serde(rename = "loopMode", default)]
    loop_mode: String,
    #[serde(rename = "loopCount", default)]
    loop_count: u32,
}

fn one() -> f64 {
    1.0
}

#[derive(Deserialize)]
struct MelodyNoteJson {
    step: u32,
    #[serde(rename = "lengthSteps")]
    len_steps: u32,
    note: i32,
    velocity: u8,
}

#[derive(Deserialize)]
struct BeatStepJson {
    #[serde(default)]
    velocity: u8,
}

#[derive(Deserialize)]
struct ChordEventJson {
    step: u32,
    #[serde(rename = "lengthSteps", default = "one_u32")]
    len_steps: u32,
    #[serde(default)]
    notes: Vec<i32>,
    #[serde(default = "vel_100")]
    velocity: u8,
}

fn vel_100() -> u8 {
    100
}
fn arp_up() -> String {
    "up".to_string()
}

#[derive(Deserialize)]
struct BeatLineJson {
    note: u8,
    #[serde(default)]
    muted: bool,
    steps: Vec<BeatStepJson>,
}

/// Ein Baustein ist reiner INHALT — Noten, Steps, Bewegungs-Layer. Kein Kanal,
/// keine CC-Nummer, kein Ziel: das kommt alles von der Lane bzw. deren Device,
/// damit derselbe Baustein in mehreren Lanes auf unterschiedlichen Kanälen/CCs
/// laufen kann. Altprojekte können solche Felder noch enthalten; serde ignoriert
/// sie hier, `migrate_project` (state.rs) räumt sie beim Laden weg.
#[derive(Deserialize)]
struct BlockJson {
    #[serde(rename = "type")]
    kind: String,
    #[serde(rename = "lengthBars", default = "one_u32")]
    length_bars: u32,
    #[serde(rename = "stepsPerBar", default = "sixteen")]
    steps_per_bar: u32,
    #[serde(rename = "timeSignature", default = "four_four")]
    time_signature: String,
    #[serde(default)]
    notes: Vec<MelodyNoteJson>,
    #[serde(default)]
    lines: Vec<BeatLineJson>,
    #[serde(rename = "outMin", default)]
    out_min: Option<u8>,
    #[serde(rename = "outMax", default)]
    out_max: Option<u8>,
    /// CC: `true` = letzter Wert bleibt stehen; `false`/fehlt (Standard) =
    /// Ziel kehrt am Baustein-Ende zur Ruhelage zurück.
    #[serde(default)]
    destructive: bool,
    #[serde(default)]
    layers: Vec<serde_json::Value>,
    // ── Akkord ──
    #[serde(default)]
    chords: Vec<ChordEventJson>,
    // ── Arp ──
    #[serde(rename = "chordNotes", default)]
    chord_notes: Vec<i32>,
    #[serde(default = "arp_up")]
    direction: String,
    #[serde(rename = "gateSteps", default = "one_u32")]
    gate_steps: u32,
    #[serde(rename = "rateSteps", default = "one_u32")]
    rate_steps: u32,
    #[serde(default = "vel_100")]
    velocity: u8,
}

fn one_u32() -> u32 {
    1
}
fn sixteen() -> u32 {
    16
}
fn four_four() -> String {
    "4/4".to_string()
}

pub(crate) fn pulses_per_bar(ts: &str) -> u32 {
    let mut it = ts.split('/');
    let num: u32 = it.next().and_then(|s| s.parse().ok()).unwrap_or(4);
    let den: u32 = it.next().and_then(|s| s.parse().ok()).unwrap_or(4);
    (num * PULSES_PER_WHOLE / den.max(1)).max(1)
}

fn compile_slots(
    slots_json: &serde_json::Value,
    blocks_json: &serde_json::Value,
    lane_channel: u8,
    cc_target: Option<CcTarget>,
) -> Vec<CBlock> {
    let slots: Vec<SlotJson> = serde_json::from_value(slots_json.clone()).unwrap_or_default();
    let blocks: Vec<serde_json::Value> =
        serde_json::from_value(blocks_json.clone()).unwrap_or_default();

    let mut out = Vec::new();
    for slot in slots {
        let Some(bv) = blocks.iter().find(|b| {
            b.get("id").and_then(|v| v.as_str()) == Some(slot.block_id.as_str())
        }) else {
            continue;
        };
        let Ok(block) = serde_json::from_value::<BlockJson>(bv.clone()) else {
            continue;
        };
        if let Some(cb) = compile_block(&block, &slot, lane_channel, &cc_target) {
            out.push(cb);
        }
    }
    out
}

fn compile_block(
    b: &BlockJson,
    slot: &SlotJson,
    lane_channel: u8,
    cc_target: &Option<CcTarget>,
) -> Option<CBlock> {
    let ppb = pulses_per_bar(&b.time_signature);
    let steps_per_bar = b.steps_per_bar.max(1);
    let total_steps = steps_per_bar * b.length_bars.max(1);
    let speed = if slot.speed > 0.0 { slot.speed } else { 1.0 };
    let base_pps = ppb as f64 / steps_per_bar as f64 / speed;
    let pulses_per_step = base_pps.round().max(1.0) as u32;
    let len_pulses = pulses_per_step * total_steps;
    // Loop-Anzahl: off = einmal (1), count = loopCount-mal, loop = endlos (0).
    let max_loops = match slot.loop_mode.as_str() {
        "loop" => 0,
        "count" => slot.loop_count.max(1),
        _ => 1,
    };
    let channel = lane_channel.clamp(1, 16);
    let transpose = slot.transpose;

    let kind = match b.kind.as_str() {
        "melody" => {
            let notes = b
                .notes
                .iter()
                .map(|n| CNote {
                    step: n.step,
                    len_steps: n.len_steps.max(1),
                    note: (n.note + transpose).clamp(0, 127) as u8,
                    vel: n.velocity.clamp(1, 127),
                })
                .collect();
            CKind::Melody(notes)
        }
        "beat" => {
            let mut steps: Vec<Vec<(u8, u8)>> = vec![Vec::new(); total_steps as usize];
            for line in &b.lines {
                if line.muted {
                    continue;
                }
                let note = (line.note as i32 + transpose).clamp(0, 127) as u8;
                for (i, s) in line.steps.iter().enumerate() {
                    if i < steps.len() && s.velocity > 0 {
                        steps[i].push((note, s.velocity.clamp(1, 127)));
                    }
                }
            }
            CKind::Beat(steps)
        }
        "cc" => CKind::Cc(CcAutomation {
            out_min: b.out_min.unwrap_or(0),
            out_max: b.out_max.unwrap_or(127),
            target: cc_target.clone(),
            destructive: b.destructive,
            layers: compile_cc_layers(&b.layers),
        }),
        // Akkord: jeder ChordEvent wird zu mehreren gleichzeitigen Noten am
        // selben Step — von da an identisch zu Melody.
        "chord" => {
            let notes = b
                .chords
                .iter()
                .flat_map(|c| {
                    let step = c.step;
                    let len = c.len_steps.max(1);
                    let vel = c.velocity.clamp(1, 127);
                    c.notes.iter().map(move |n| CNote {
                        step,
                        len_steps: len,
                        note: (n + transpose).clamp(0, 127) as u8,
                        vel,
                    })
                })
                .collect();
            CKind::Chord(notes)
        }
        // Arp: den Notenvorrat vorab in eine Einzelnoten-Folge ausrollen.
        "arp" => {
            let pool: Vec<u8> = b
                .chord_notes
                .iter()
                .map(|n| (n + transpose).clamp(0, 127) as u8)
                .collect();
            CKind::Arp(build_arp(
                &pool,
                &b.direction,
                b.rate_steps.max(1),
                b.gate_steps.max(1),
                b.velocity.clamp(1, 127),
                total_steps,
            ))
        }
        _ => return None,
    };

    Some(CBlock {
        slot_id: slot.id.clone(),
        block_id: slot.block_id.clone(),
        pulses_per_step,
        len_pulses,
        ppb,
        max_loops,
        channel,
        kind,
    })
}

/// Rollt den Notenvorrat eines Arp-Bausteins in eine feste Einzelnoten-Folge
/// aus: alle `rate_steps` Steps die nächste Note laut `direction`, je
/// `gate_steps` lang, bis `total_steps` voll ist. Vorab statt zur Laufzeit,
/// damit der Rest der Engine ihn wie eine gewöhnliche Melodie behandelt.
fn build_arp(
    pool: &[u8],
    direction: &str,
    rate_steps: u32,
    gate_steps: u32,
    vel: u8,
    total_steps: u32,
) -> Vec<CNote> {
    if pool.is_empty() {
        return Vec::new();
    }
    // Index-Reihenfolge EINES Durchlaufs durch den Vorrat.
    let order: Vec<usize> = match direction {
        "down" => (0..pool.len()).rev().collect(),
        "upDown" if pool.len() > 2 => (0..pool.len())
            .chain((1..pool.len() - 1).rev())
            .collect(),
        // "up" | "asPlayed" | "upDown" (≤2 Noten) | Unbekanntes: Vorrat wie
        // gespeichert. „asPlayed" ist die Speicherreihenfolge, weil es beim
        // Sequencer-Baustein kein Live-Anschlagen gibt.
        _ => (0..pool.len()).collect(),
    };
    let random = direction == "random";
    let mut out = Vec::new();
    let mut i = 0usize;
    let mut step = 0u32;
    while step < total_steps {
        let idx = if random {
            // Aus dem Step abgeleitet, nicht aus einem Thread-RNG: derselbe
            // Baustein klingt bei jedem Loop gleich und der Audiopfad bleibt
            // deterministisch.
            let h = (step as u64)
                .wrapping_mul(2654435761)
                .wrapping_add(0x9E3779B9);
            (h % pool.len() as u64) as usize
        } else {
            order[i % order.len()]
        };
        out.push(CNote {
            step,
            len_steps: gate_steps,
            note: pool[idx],
            vel,
        });
        i += 1;
        step += rate_steps;
    }
    out
}

/// Löst `Lane.ccControlId` → `LiveControl` (aus `Project.controls`) → Ziel auf.
/// `None`, wenn kein Knob gewählt ist, das Control kein `kind:"knob"` ist, sein
/// Mapping kein CC ist oder es zu einem ANDEREN Device gehört als die Lane —
/// die Lane spielt dann stumm (wie ein Control ohne Zuordnung, s.
/// `warn_no_mapping`/`warn_no_device` in ws.rs für das Live-Control-Pendant).
///
/// Die Device-Prüfung ist die „nur verbundene CCs"-Regel im Playback: die UI
/// bietet ohnehin nur Knobs dieses Devices an, aber ein Umziehen/Löschen des
/// Knobs darf nicht dazu führen, dass eine Lane still auf ein fremdes Gerät
/// sendet.
///
/// Vom Knob kommt NUR die CC-Nummer („welcher Parameter"). Port und Kanal
/// kommen wie bei jeder anderen Lane von Lane/Device („welches Instrument") —
/// nicht aus dem Mapping des Knobs. Dessen Kanal ist der, auf dem das Gerät beim
/// MIDI-Learn gesendet hat; weicht der vom Empfangskanal ab, ging die Automation
/// unsichtbar ins Leere, weil in der Lane-Zeile nirgends ein Kanal stand.
fn resolve_cc_target(
    cc_control_id: &Option<String>,
    dev: &Device,
    lane_channel: u8,
    controls: &serde_json::Value,
) -> Option<CcTarget> {
    let id = cc_control_id.as_ref()?;
    let ctrl = controls
        .as_array()?
        .iter()
        .find(|c| c.get("id").and_then(|v| v.as_str()) == Some(id.as_str()))?;
    if ctrl.get("kind").and_then(|v| v.as_str()) != Some("knob") {
        return None;
    }
    if ctrl.get("deviceId").and_then(|v| v.as_str()) != Some(dev.id.as_str()) {
        return None;
    }
    let map = ctrl.get("mapping")?;
    if map.get("kind").and_then(|v| v.as_str())? != "cc" {
        return None;
    }
    let cc_number = (map.get("number").and_then(|v| v.as_u64()).unwrap_or(0) as u8).min(127);
    let rest_value = (ctrl.get("value").and_then(|v| v.as_u64()).unwrap_or(0) as u8).min(127);
    Some(CcTarget {
        port: dev.midi_out_port.clone(),
        channel: lane_channel.clamp(1, 16),
        cc_number,
        control_id: id.clone(),
        rest_value,
    })
}

/// Parst die rohen `layers` (aus dem CC-Baustein-JSON) einmal beim Rebuild in
/// die kompilierte Repräsentation (siehe `CcLayerCompiled`).
fn compile_cc_layers(raw: &[serde_json::Value]) -> Vec<CcLayerCompiled> {
    raw.iter().filter_map(compile_cc_layer).collect()
}

fn compile_cc_layer(v: &serde_json::Value) -> Option<CcLayerCompiled> {
    let kind = v.get("kind").and_then(|x| x.as_str())?;
    let enabled = v.get("enabled").and_then(|x| x.as_bool()).unwrap_or(true);
    let combine = v.get("combine").and_then(|x| x.as_str()).unwrap_or("add").to_string();
    let depth = v.get("depth").and_then(|x| x.as_f64()).unwrap_or(1.0);
    let offset = v.get("offset").and_then(|x| x.as_f64()).unwrap_or(0.0);
    match kind {
        "lfo" => Some(CcLayerCompiled::Lfo {
            enabled,
            combine,
            depth,
            offset,
            waveform: v.get("waveform").and_then(|x| x.as_str()).unwrap_or("sine").to_string(),
            rate_mode: v.get("rateMode").and_then(|x| x.as_str()).unwrap_or("bars").to_string(),
            rate_bars: v.get("rateBars").and_then(|x| x.as_f64()).unwrap_or(1.0).max(0.0001),
            rate_hz: v.get("rateHz").and_then(|x| x.as_f64()).unwrap_or(1.0).max(0.0001),
            phase: v.get("phase").and_then(|x| x.as_f64()).unwrap_or(0.0),
            rate_key_track: v.get("rateKeyTrack").and_then(|x| x.as_f64()).unwrap_or(0.0),
        }),
        "envelope" => {
            let mut points: Vec<(u32, f64)> = v
                .get("points")
                .and_then(|x| x.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|p| {
                            let step = p.get("step")?.as_u64()? as u32;
                            let val = p.get("value")?.as_f64()?;
                            Some((step, val))
                        })
                        .collect()
                })
                .unwrap_or_default();
            points.sort_by_key(|(s, _)| *s);
            Some(CcLayerCompiled::Envelope { enabled, combine, depth, offset, points })
        }
        "ramp" => Some(CcLayerCompiled::Ramp {
            enabled,
            combine,
            depth,
            offset,
            from: v.get("from").and_then(|x| x.as_f64()).unwrap_or(0.0),
            to: v.get("to").and_then(|x| x.as_f64()).unwrap_or(1.0),
        }),
        "random" => Some(CcLayerCompiled::Random {
            enabled,
            combine,
            depth,
            offset,
            every_steps: (v.get("everySteps").and_then(|x| x.as_u64()).unwrap_or(1) as u32).max(1),
            smooth: v.get("smooth").and_then(|x| x.as_bool()).unwrap_or(false),
        }),
        "stepped" => {
            let values = v
                .get("values")
                .and_then(|x| x.as_array())
                .map(|arr| arr.iter().map(|n| n.as_f64().unwrap_or(0.0)).collect())
                .unwrap_or_default();
            Some(CcLayerCompiled::Stepped { enabled, combine, depth, offset, values })
        }
        _ => None,
    }
}
