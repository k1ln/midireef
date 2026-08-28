//! Wiedergabe-Engine: kompiliert Lanes/Bausteine des Projekts in schnelle
//! Strukturen und spielt sie im Clock-Loop ab (Melodie + Beat für v1).
//!
//! Timing: 24 PPQN. Ein Step-Boundary löst Note-Ons aus; Note-Offs werden
//! global (nach absolutem Puls) verwaltet.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::midi::{MidiOutManager, MIDI_CLOCK, MIDI_START, MIDI_STOP};
use crate::model::{Device, Project};

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
            Self::Lfo { waveform, rate_mode, rate_bars, rate_hz, phase, .. } => {
                let raw_phase = if rate_mode == "hz" {
                    ctx.elapsed_secs * rate_hz + phase
                } else {
                    let bars = ctx.global_pulse as f64 / ctx.ppb.max(1) as f64;
                    bars / rate_bars.max(0.0001) + phase
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
    layers: Vec<CcLayerCompiled>,
}

enum CKind {
    Melody(Vec<CNote>),
    /// pro Step eine Liste aus (Note, Velocity)
    Beat(Vec<Vec<(u8, u8)>>),
    Cc(CcAutomation),
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

struct CLane {
    id: String,
    port: String,
    enabled: bool,
    /// "sequential" (Default) rückt beim Blockende zum nächsten Slot vor,
    /// "random" springt zu einem zufälligen, "manual" bleibt stehen (repeat)
    /// bis der Slot per `trigger_slot` (Touch) gewechselt wird.
    play_mode: String,
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
}

struct PendingOff {
    port: String,
    ch: u8,
    note: u8,
    at: u64, // absoluter Puls
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
        }
    }

    pub fn clock_pulse(&mut self) {
        for port in &self.clock_ports {
            self.midi.send(port, &[MIDI_CLOCK]);
        }
    }

    pub fn transport_start(&mut self) {
        self.reset();
        for port in &self.clock_ports {
            self.midi.send(port, &[MIDI_START]);
        }
    }

    pub fn transport_stop(&mut self) {
        for port in &self.clock_ports {
            self.midi.send(port, &[MIDI_STOP]);
        }
        self.midi.all_notes_off();
        self.pending.clear();
    }

    pub fn panic(&mut self) {
        self.midi.all_notes_off();
        self.pending.clear();
    }

    /// Springt sofort zum Baustein hinter `slot_id` in der Lane `lane_id`
    /// ("sofort" gemäß Architektur — Quantisierung zum Taktanfang folgt später).
    pub fn trigger_slot(&mut self, lane_id: &str, slot_id: &str) {
        let Some(idx) = self.lanes.iter().position(|l| l.id == lane_id) else {
            return;
        };
        let Some(block_idx) = self.lanes[idx].blocks.iter().position(|b| b.slot_id == slot_id) else {
            return;
        };
        self.playback[idx].slot = block_idx;
        self.playback[idx].pos = 0;
        self.playback[idx].loops_done = 0;
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
        }
        self.pending.clear();
        self.elapsed_secs = 0.0;
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
        for dev in &project.devices {
            let blocks_json = &dev.blocks;
            for lane in &dev.lanes {
                let port = if dev.midi_out_port.is_empty() {
                    String::new()
                } else {
                    dev.midi_out_port.clone()
                };
                let lane_channel = lane.channel.unwrap_or(dev.channel).clamp(1, 16);
                // CC-Ziel hängt an der Lane, nicht am Baustein — einmal pro
                // Lane auflösen und an alle ihre CC-Bausteine durchreichen.
                let cc_target =
                    resolve_cc_target(&lane.cc_control_id, dev, lane_channel, &project.controls);
                let blocks = compile_slots(
                    &lane.slots,
                    blocks_json,
                    lane_channel,
                    dev.transpose,
                    cc_target,
                );
                lanes.push(CLane {
                    id: lane.id.clone(),
                    port,
                    enabled: lane.enabled && !lane.muted,
                    play_mode: lane.play_mode.clone(),
                    blocks,
                });
            }
        }

        self.playback = lanes
            .iter()
            .map(|l| {
                let mut pb = prev
                    .get(&l.id)
                    .copied()
                    .unwrap_or(Playback { slot: 0, pos: 0, hits: 0, loops_done: 0 });
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

        for idx in 0..self.lanes.len() {
            if !self.lanes[idx].enabled || self.lanes[idx].blocks.is_empty() {
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
                // Block ist einmal durch. Ob die Lane weiterrückt, entscheiden
                // Play-Mode UND die Loop-Anzahl des Slots:
                //   manual        → bleibt immer stehen (wiederholt current).
                //   max_loops == 0 → ∞, dieser Block loopt endlos, kein Wechsel.
                //   sonst          → nach max_loops Durchläufen weiterrücken;
                //                    "sequential" zum nächsten, "random" zufällig.
                let n_blocks = self.lanes[idx].blocks.len();
                let max_loops = self.lanes[idx].blocks[slot].max_loops;
                if self.lanes[idx].play_mode != "manual" && max_loops != 0 {
                    self.playback[idx].loops_done += 1;
                    if self.playback[idx].loops_done >= max_loops {
                        self.playback[idx].loops_done = 0;
                        next_slot = if self.lanes[idx].play_mode == "random" && n_blocks > 1 {
                            let h = global_pulse.wrapping_mul(2654435761).wrapping_add(idx as u64);
                            let pick = (h % (n_blocks - 1) as u64) as usize;
                            if pick >= slot { pick + 1 } else { pick }
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
    }

    fn fire_step(&mut self, lane_idx: usize, slot: usize, step: u32, global_pulse: u64) {
        let lane = &self.lanes[lane_idx];
        let port = lane.port.clone();
        let block = &lane.blocks[slot];
        let ch = block.channel;
        let pps = block.pulses_per_step.max(1);

        // (note, vel, off_at) einsammeln, dann senden (Borrow-Konflikt vermeiden).
        let mut hits: Vec<(u8, u8, u64)> = Vec::new();
        match &block.kind {
            CKind::Melody(notes) => {
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
            let pb = self.playback[idx];
            let slot = pb.slot % lane.blocks.len();
            let block = &lane.blocks[slot];
            let pps = block.pulses_per_step.max(1);
            let len = block.len_pulses.max(1);
            let (kind, cc_number, cc_value) = match &block.kind {
                CKind::Melody(_) => ("melody", None, None),
                CKind::Beat(_) => ("beat", None, None),
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
        let (slot_id, out_min, out_max, target, value01) = {
            let block = &self.lanes[lane_idx].blocks[slot];
            let CKind::Cc(ref auto) = block.kind else { return };
            let Some(target) = auto.target.clone() else { return };
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
            };
            let value01 = eval_cc_layers(&auto.layers, &ctx);
            (block.slot_id.clone(), auto.out_min, auto.out_max, target, value01)
        };

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
    #[serde(default)]
    layers: Vec<serde_json::Value>,
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
    dev_transpose: i32,
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
        if let Some(cb) = compile_block(&block, &slot, lane_channel, dev_transpose, &cc_target) {
            out.push(cb);
        }
    }
    out
}

fn compile_block(
    b: &BlockJson,
    slot: &SlotJson,
    lane_channel: u8,
    dev_transpose: i32,
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
    let transpose = slot.transpose + dev_transpose;

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
            layers: compile_cc_layers(&b.layers),
        }),
        _ => return None, // andere Typen (arp/…) folgen später
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
    Some(CcTarget {
        port: dev.midi_out_port.clone(),
        channel: lane_channel.clamp(1, 16),
        cc_number,
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
