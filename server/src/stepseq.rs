//! Step-Sequencer ("ST"-Ansicht) — ein Korg-SQ-1-artiger Pattern-Spieler mit
//! langen Linien (bis 64 Steps), dessen Knobs pro Step Tonhöhe/Wert, Anschlag,
//! Gate-Länge und einen Mod-Wert tragen. Mehrere Sequencer laufen gleichzeitig,
//! jeder mit eigener Zielliste:
//!  - **Dashboard-Control** (Taster/Regler): der Step "drückt" das Control —
//!    Note-Taster spielen die Step-Tonhöhe auf Kanal/Port des Controls (mit
//!    Anschlag + Gate), CC-Controls bekommen den Step-Wert als CC-Wert (inkl.
//!    Fan-out/Wertebereich des Controls), Program-Change-Controls wählen das
//!    Programm.
//!  - **Device direkt**: Noten (`mode = "note"`) oder ein CV-artiger
//!    CC-Strom (`mode = "cc"`, Tonhöhe → CC-Wert 0–127).
//!
//! Zeit: der Sequencer hat KEINEN eigenen Taktgeber. Er rastet auf 24 PPQN ein
//! wie die Lanes der [`Engine`](crate::engine::Engine):
//!  - Standard (`free = false`): folgt dem Transport — startet/stoppt mit
//!    Play/Stop und liegt auf dem globalen Pulsraster (Beat/Takt-synchron zu
//!    den Lanes). Ist er scharf (`running`), während der Transport steht,
//!    wartet er auf Play.
//!  - `free = true`: läuft unabhängig vom Transport auf einem eigenen
//!    Pulszähler (im selben BPM-Intervall, s. `clock.rs`).

use serde::{Deserialize, Serialize};

use crate::midi::MidiOutManager;
use crate::model::Project;

pub const MAX_STEPS: usize = 64;
pub const DEFAULT_STEPS: usize = 16;

fn d_true() -> bool {
    true
}
fn d_pitch() -> u8 {
    60
}
fn d_vel() -> u8 {
    100
}
fn d_gate() -> f64 {
    0.5
}
fn d_len() -> u32 {
    DEFAULT_STEPS as u32
}
fn d_rate() -> String {
    "1/16".to_string()
}
fn d_dir() -> String {
    "forward".to_string()
}
fn d_one() -> u8 {
    1
}
fn d_note_mode() -> String {
    "note".to_string()
}
fn d_cc() -> u8 {
    74
}

/// Ein Step: die vier Knobs des SQ-1 plus An/Aus.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SeqStep {
    #[serde(default = "d_true")]
    pub on: bool,
    /// Tonhöhe 0–127 (Notenziel) bzw. Wert 0–127 (CC-/Program-Ziel).
    #[serde(default = "d_pitch")]
    pub pitch: u8,
    #[serde(default = "d_vel")]
    pub velocity: u8,
    /// Gate-Länge als Anteil des Step-Abstands (0.05–1.0; 1.0 = legato).
    #[serde(default = "d_gate")]
    pub gate: f64,
    /// Mod-Wert 0–127 — geht an `modCc` eines Device-Ziels (falls gesetzt).
    #[serde(default, rename = "mod")]
    pub modulation: u8,
}

impl Default for SeqStep {
    fn default() -> Self {
        Self { on: true, pitch: 60, velocity: 100, gate: 0.5, modulation: 0 }
    }
}

/// Wohin ein Sequencer seine Steps schickt.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SeqTarget {
    /// Ein Dashboard-Control (Taster/Regler) — s. Modul-Doku.
    #[serde(rename_all = "camelCase")]
    Control { control_id: String },
    /// Ein Device direkt: `mode` = "note" | "cc".
    #[serde(rename_all = "camelCase")]
    Device {
        device_id: String,
        #[serde(default = "d_one")]
        channel: u8,
        #[serde(default = "d_note_mode")]
        mode: String,
        /// CC-Nummer im CC-Modus (der CV-artige Strom).
        #[serde(default = "d_cc")]
        cc: u8,
        /// Optional: der Mod-Knob eines Steps geht zusätzlich auf diese CC.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        mod_cc: Option<u8>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StepSeq {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    /// Scharf geschaltet. Wird beim Laden eines Projekts zurückgesetzt
    /// (`migrate_project`) — ein Kiosk soll nach dem Booten nicht von selbst
    /// losspielen.
    #[serde(default)]
    pub running: bool,
    /// `true` = unabhängig vom Transport; `false` = folgt Play/Stop.
    #[serde(default)]
    pub free: bool,
    /// Länge der Linie in Steps, 1..=64.
    #[serde(default = "d_len")]
    pub length: u32,
    /// Step-Raster: "1/2", "1/4", "1/8", "1/16", "1/32" (+ "T"-Triolen).
    #[serde(default = "d_rate")]
    pub rate: String,
    /// "forward" | "reverse" | "pingPong" | "random".
    #[serde(default = "d_dir")]
    pub direction: String,
    /// 0..1 — verzögert jeden zweiten Step (max. ein Drittel Step).
    #[serde(default)]
    pub swing: f64,
    /// Halbtöne, nur auf Notenziele.
    #[serde(default)]
    pub transpose: i32,
    #[serde(default)]
    pub steps: Vec<SeqStep>,
    #[serde(default)]
    pub targets: Vec<SeqTarget>,
}

impl StepSeq {
    pub fn new(name: &str) -> Self {
        let mut s = Self {
            id: uuid::Uuid::new_v4().to_string(),
            name: name.to_string(),
            color: None,
            running: false,
            free: false,
            length: DEFAULT_STEPS as u32,
            rate: d_rate(),
            direction: d_dir(),
            swing: 0.0,
            transpose: 0,
            steps: Vec::new(),
            targets: Vec::new(),
        };
        s.normalize();
        s
    }

    /// Bringt Länge/Steps/Wertebereiche in einen gültigen Zustand. Wächst die
    /// Linie, wird das vorhandene Muster wiederholt (SQ-1-Stil: aus 16 wird
    /// "16 + dieselben 16" zum Weiterbauen), statt leere Steps anzuhängen.
    pub fn normalize(&mut self) {
        self.length = self.length.clamp(1, MAX_STEPS as u32);
        let want = self.length as usize;
        if self.steps.is_empty() {
            self.steps = vec![SeqStep::default(); want];
        } else if self.steps.len() < want {
            let base = self.steps.len();
            for i in base..want {
                let copy = self.steps[i % base].clone();
                self.steps.push(copy);
            }
        } else if self.steps.len() > want {
            // Bewusst NICHT abschneiden: wer kürzt und wieder verlängert, soll
            // sein Muster zurückbekommen. Gespielt wird nur `length`.
            self.steps.truncate(MAX_STEPS);
        }
        for st in self.steps.iter_mut() {
            st.pitch = st.pitch.min(127);
            st.velocity = st.velocity.clamp(1, 127);
            st.gate = if st.gate.is_finite() { st.gate.clamp(0.05, 1.0) } else { 0.5 };
            st.modulation = st.modulation.min(127);
        }
        if !self.swing.is_finite() {
            self.swing = 0.0;
        }
        self.swing = self.swing.clamp(0.0, 1.0);
        self.transpose = self.transpose.clamp(-48, 48);
        if rate_pulses(&self.rate).is_none() {
            self.rate = d_rate();
        }
        if !matches!(self.direction.as_str(), "forward" | "reverse" | "pingPong" | "random") {
            self.direction = d_dir();
        }
        for t in self.targets.iter_mut() {
            if let SeqTarget::Device { channel, cc, mod_cc, mode, .. } = t {
                *channel = (*channel).clamp(1, 16);
                *cc = (*cc).min(127);
                if let Some(m) = mod_cc {
                    *m = (*m).min(127);
                }
                if mode != "cc" {
                    *mode = d_note_mode();
                }
            }
        }
    }
}

/// Pulse (24 PPQN) je Step für ein Raster, `None` bei unbekanntem Namen.
pub fn rate_pulses(rate: &str) -> Option<u32> {
    Some(match rate {
        "1/2" => 48,
        "1/4" => 24,
        "1/4T" => 16,
        "1/8" => 12,
        "1/8T" => 8,
        "1/16" => 6,
        "1/16T" => 4,
        "1/32" => 3,
        "1/32T" => 2,
        _ => return None,
    })
}

// ── Laufzeit ────────────────────────────────────────────────────────────────

/// Was ein Ziel beim Auslösen eines Steps tatsächlich sendet.
#[derive(Debug, Clone, PartialEq)]
enum Out {
    Note { port: String, ch: u8 },
    /// `lo`/`hi`: Wertebereich des Ziels (Fan-out eines Controls, `lo > hi` =
    /// invertiert). `release`: Taster-artiges Control → nach dem Gate 0 senden.
    Cc { port: String, ch: u8, cc: u8, lo: i64, hi: i64, release: bool },
    Pc { port: String, ch: u8 },
}

#[derive(Debug, Clone, PartialEq)]
struct Resolved {
    out: Out,
    mod_cc: Option<u8>,
    control_id: Option<String>,
}

/// Fällige Nachricht (Note-Off / CC-Release) bzw. nur UI-Feedback (`bytes` leer).
#[derive(Debug, Clone)]
struct Off {
    at: u64,
    port: String,
    bytes: Vec<u8>,
    control_id: Option<String>,
}

/// Rückmeldungen für den Clock-Thread (→ UI).
#[derive(Debug, Clone, PartialEq)]
pub enum SeqEvent {
    /// Aktueller Step eines Sequencers (`None` = steht).
    Step { seq_id: String, step: Option<u32> },
    /// Dashboard-Control hat gerade "gedrückt"/"losgelassen" (Aufblitzen).
    Activity { control_id: String, active: bool },
}

struct Runner {
    cfg: StepSeq,
    resolved: Vec<Resolved>,
    /// Nächster Rasterpunkt in der Pulszeit der Domäne (global bzw. frei).
    /// `None` = nicht scharf bzw. wartet (Transport steht).
    next_grid: Option<u64>,
    trig_count: u64,
    pos: usize,
    started: bool,
    up: bool,
    /// Swing: Step, der erst `fire_at` (Pulse) feuert.
    delayed: Option<(u64, usize)>,
    offs: Vec<Off>,
    reported: Option<u32>,
}

impl Runner {
    fn new(cfg: StepSeq, resolved: Vec<Resolved>) -> Self {
        Self {
            cfg,
            resolved,
            next_grid: None,
            trig_count: 0,
            pos: 0,
            started: false,
            up: true,
            delayed: None,
            offs: Vec::new(),
            reported: None,
        }
    }

    fn rate(&self) -> u64 {
        rate_pulses(&self.cfg.rate).unwrap_or(6) as u64
    }

    /// Alles Klingende sofort beenden (Note-Offs/CC-Release raus).
    fn silence(&mut self, midi: &mut MidiOutManager, events: &mut Vec<SeqEvent>) {
        for off in self.offs.drain(..) {
            if !off.bytes.is_empty() {
                midi.send(&off.port, &off.bytes);
            }
            if let Some(c) = off.control_id {
                events.push(SeqEvent::Activity { control_id: c, active: false });
            }
        }
        self.delayed = None;
    }

    /// Zurück an den Anfang (Position/Swing-Zähler), ohne scharf-Zustand.
    fn reset(&mut self, events: &mut Vec<SeqEvent>) {
        self.next_grid = None;
        self.trig_count = 0;
        self.pos = 0;
        self.started = false;
        self.up = true;
        self.delayed = None;
        self.report(None, events);
    }

    fn report(&mut self, step: Option<u32>, events: &mut Vec<SeqEvent>) {
        if self.reported != step {
            self.reported = step;
            events.push(SeqEvent::Step { seq_id: self.cfg.id.clone(), step });
        }
    }

    /// Welcher Step kommt als nächstes (Richtung + Ping-Pong-Zustand).
    fn advance(&mut self, rng: &mut u64) -> usize {
        let len = (self.cfg.length as usize).clamp(1, self.cfg.steps.len().max(1));
        if !self.started {
            self.started = true;
            self.up = true;
            self.pos = if self.cfg.direction == "reverse" { len - 1 } else { 0 };
            if self.cfg.direction == "random" {
                self.pos = next_rand(rng) as usize % len;
            }
            return self.pos;
        }
        self.pos = match self.cfg.direction.as_str() {
            "reverse" => (self.pos + len - 1) % len,
            "random" => next_rand(rng) as usize % len,
            "pingPong" => {
                if len == 1 {
                    0
                } else if self.up {
                    if self.pos + 1 >= len {
                        self.up = false;
                        self.pos.saturating_sub(1)
                    } else {
                        self.pos + 1
                    }
                } else if self.pos == 0 {
                    self.up = true;
                    1
                } else {
                    self.pos - 1
                }
            }
            _ => (self.pos + 1) % len,
        };
        self.pos
    }

    /// Ein Puls dieser Zeitdomäne.
    fn tick(&mut self, midi: &mut MidiOutManager, p: u64, events: &mut Vec<SeqEvent>, rng: &mut u64) {
        // 1. Fällige Offs (zuerst, damit ein Legato-Step sauber "aus, dann an" liefert).
        if !self.offs.is_empty() {
            let mut i = 0;
            while i < self.offs.len() {
                if self.offs[i].at <= p {
                    let off = self.offs.remove(i);
                    if !off.bytes.is_empty() {
                        midi.send(&off.port, &off.bytes);
                    }
                    if let Some(c) = off.control_id {
                        events.push(SeqEvent::Activity { control_id: c, active: false });
                    }
                } else {
                    i += 1;
                }
            }
        }
        // 2. Per Swing verzögerter Step.
        if let Some((at, step)) = self.delayed {
            if at <= p {
                self.delayed = None;
                self.fire(midi, p, step, events);
            }
        }
        // 3. Rasterpunkt.
        if let Some(g) = self.next_grid {
            if g <= p {
                let step = self.advance(rng);
                let n = self.trig_count;
                self.trig_count += 1;
                let rate = self.rate();
                self.next_grid = Some(g.max(p.saturating_sub(rate)) + rate);
                self.report(Some(step as u32), events);
                let delay = if n % 2 == 1 {
                    ((self.cfg.swing * rate as f64) / 3.0).round() as u64
                } else {
                    0
                };
                if delay == 0 {
                    self.fire(midi, p, step, events);
                } else {
                    // Ein vorher noch ausstehender Swing-Step wäre jetzt schon
                    // fällig gewesen (delay < rate) — nie zwei gleichzeitig.
                    self.delayed = Some((p + delay, step));
                }
            }
        }
    }

    fn fire(&mut self, midi: &mut MidiOutManager, p: u64, step: usize, events: &mut Vec<SeqEvent>) {
        let Some(st) = self.cfg.steps.get(step).cloned() else { return };
        if !st.on {
            return;
        }
        let gate_pulses = ((st.gate * self.rate() as f64).round() as u64).max(1);
        let off_at = p + gate_pulses;
        let transpose = self.cfg.transpose;
        let resolved = self.resolved.clone();
        for r in &resolved {
            match &r.out {
                Out::Note { port, ch } => {
                    if let Some(mc) = r.mod_cc {
                        midi.send(port, &[0xB0 | (ch - 1), mc, st.modulation]);
                    }
                    let note = (st.pitch as i32 + transpose).clamp(0, 127) as u8;
                    let off_bytes = vec![0x80 | (ch - 1), note, 0];
                    // Dieselbe Note noch offen (Legato/Wiederholung)? Erst aus.
                    self.offs.retain(|o| {
                        if o.port == *port && o.bytes.first() == off_bytes.first() && o.bytes.get(1) == off_bytes.get(1) {
                            midi.send(&o.port, &o.bytes);
                            false
                        } else {
                            true
                        }
                    });
                    midi.send(port, &[0x90 | (ch - 1), note, st.velocity.max(1)]);
                    self.push_off(off_at, port, off_bytes, &r.control_id, events);
                }
                Out::Cc { port, ch, cc, lo, hi, release } => {
                    if let Some(mc) = r.mod_cc {
                        midi.send(port, &[0xB0 | (ch - 1), mc, st.modulation]);
                    }
                    let v = scale_7bit(st.pitch, *lo, *hi);
                    midi.send(port, &[0xB0 | (ch - 1), *cc, v]);
                    if *release {
                        self.push_off(off_at, port, vec![0xB0 | (ch - 1), *cc, 0], &r.control_id, events);
                    } else if let Some(c) = &r.control_id {
                        // Regler ohne Release: nur ein kurzes Aufblitzen.
                        self.push_off(off_at, port, Vec::new(), &Some(c.clone()), events);
                    }
                }
                Out::Pc { port, ch } => {
                    midi.send(port, &[0xC0 | (ch - 1), st.pitch.min(127)]);
                    if let Some(c) = &r.control_id {
                        self.push_off(off_at, port, Vec::new(), &Some(c.clone()), events);
                    }
                }
            }
        }
    }

    fn push_off(
        &mut self,
        at: u64,
        port: &str,
        bytes: Vec<u8>,
        control_id: &Option<String>,
        events: &mut Vec<SeqEvent>,
    ) {
        if let Some(c) = control_id {
            events.push(SeqEvent::Activity { control_id: c.clone(), active: true });
        }
        self.offs.push(Off { at, port: port.to_string(), bytes, control_id: control_id.clone() });
    }
}

fn scale_7bit(value: u8, lo: i64, hi: i64) -> u8 {
    (lo + (value as i64 * (hi - lo)) / 127).clamp(0, 127) as u8
}

/// Splitmix64 — Pseudozufall für die Random-Richtung, ohne Zusatz-Crate.
fn next_rand(state: &mut u64) -> u64 {
    *state = state.wrapping_add(0x9E3779B97F4A7C15);
    let mut z = *state;
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58476D1CE4E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D049BB133111EB);
    z ^ (z >> 31)
}

/// Löst die Ziele eines Sequencers gegen das aktuelle Projekt auf (Port,
/// Kanal, Control-Mapping). Unauflösbare Ziele (Device/Control gelöscht)
/// werden übersprungen.
fn resolve(cfg: &StepSeq, proj: &Project) -> Vec<Resolved> {
    let mut out = Vec::new();
    for t in &cfg.targets {
        match t {
            SeqTarget::Device { device_id, channel, mode, cc, mod_cc } => {
                let Some(dev) = proj.devices.iter().find(|d| &d.id == device_id) else { continue };
                let port = dev.midi_out_port.clone();
                let ch = (*channel).clamp(1, 16);
                let o = if mode == "cc" {
                    Out::Cc { port, ch, cc: *cc & 0x7F, lo: 0, hi: 127, release: false }
                } else {
                    Out::Note { port, ch }
                };
                out.push(Resolved { out: o, mod_cc: *mod_cc, control_id: None });
            }
            SeqTarget::Control { control_id } => {
                let Some(ctrl) = proj
                    .controls
                    .as_array()
                    .and_then(|a| a.iter().find(|c| c.get("id").and_then(|v| v.as_str()) == Some(control_id.as_str())))
                else {
                    continue;
                };
                let ckind = ctrl.get("kind").and_then(|v| v.as_str()).unwrap_or("");
                if ckind == "keyboard" {
                    continue;
                }
                let Some(map) = ctrl.get("mapping") else { continue };
                let mkind = map.get("kind").and_then(|v| v.as_str()).unwrap_or("");
                let ch = (map.get("channel").and_then(|v| v.as_u64()).unwrap_or(1) as u8).clamp(1, 16);
                let num = (map.get("number").and_then(|v| v.as_u64()).unwrap_or(0) as u8) & 0x7F;
                let port = ctrl
                    .get("deviceId")
                    .and_then(|v| v.as_str())
                    .and_then(|did| proj.devices.iter().find(|d| d.id == did))
                    .map(|d| d.midi_out_port.clone())
                    .unwrap_or_default();
                let cid = Some(control_id.clone());
                match mkind {
                    "note" => out.push(Resolved { out: Out::Note { port, ch }, mod_cc: None, control_id: cid }),
                    "programChange" => out.push(Resolved { out: Out::Pc { port, ch }, mod_cc: None, control_id: cid }),
                    "cc" => {
                        let release = ckind == "button";
                        // Fan-out-Regler: jedes Ziel mit eigener CC/Kanal/Range.
                        let fan: Vec<Resolved> = ctrl
                            .get("targets")
                            .and_then(|t| t.as_array())
                            .map(|ts| {
                                ts.iter()
                                    .filter_map(|t| {
                                        let did = t.get("deviceId").and_then(|v| v.as_str())?;
                                        let dev = proj.devices.iter().find(|d| d.id == did)?;
                                        let tcc = (t.get("cc").and_then(|v| v.as_u64())? as u8) & 0x7F;
                                        let tch = t
                                            .get("channel")
                                            .and_then(|v| v.as_u64())
                                            .map(|c| c as u8)
                                            .unwrap_or(ch)
                                            .clamp(1, 16);
                                        let lo = t.get("min").and_then(|v| v.as_i64()).unwrap_or(0).clamp(0, 127);
                                        let hi = t.get("max").and_then(|v| v.as_i64()).unwrap_or(127).clamp(0, 127);
                                        Some(Resolved {
                                            out: Out::Cc { port: dev.midi_out_port.clone(), ch: tch, cc: tcc, lo, hi, release },
                                            mod_cc: None,
                                            control_id: cid.clone(),
                                        })
                                    })
                                    .collect()
                            })
                            .unwrap_or_default();
                        if fan.is_empty() {
                            out.push(Resolved {
                                out: Out::Cc { port, ch, cc: num, lo: 0, hi: 127, release },
                                mod_cc: None,
                                control_id: cid,
                            });
                        } else {
                            out.extend(fan);
                        }
                    }
                    _ => {}
                }
            }
        }
    }
    out
}

/// Alle Sequencer-Läufer. Gehört der `Engine` (teilt sich deren MIDI-Ausgang).
pub struct StepSeqs {
    runners: Vec<Runner>,
    /// Pulszähler der freien Domäne (`free = true`).
    free_pulse: u64,
    events: Vec<SeqEvent>,
    rng: u64,
}

impl StepSeqs {
    pub fn new() -> Self {
        Self { runners: Vec::new(), free_pulse: 0, events: Vec::new(), rng: 0x5EED_5EED_1234_5678 }
    }

    /// Gleicht die Läufer mit der Projekt-Konfiguration ab, ohne Laufzeit-
    /// Zustand (Position, klingende Noten) zu verlieren. `playing`/`next_global`
    /// = Transportzustand bzw. der nächste globale Puls, den `on_global_pulse`
    /// sehen wird.
    pub fn sync(&mut self, midi: &mut MidiOutManager, proj: &Project, playing: bool, next_global: u64) {
        let mut events = std::mem::take(&mut self.events);
        // Verschwundene Sequencer: ausklingen lassen, nicht stehen lassen.
        let mut i = 0;
        while i < self.runners.len() {
            if proj.step_seqs.iter().any(|c| c.id == self.runners[i].cfg.id) {
                i += 1;
            } else {
                let mut r = self.runners.remove(i);
                r.silence(midi, &mut events);
                r.report(None, &mut events);
            }
        }
        for cfg in &proj.step_seqs {
            let mut cfg = cfg.clone();
            cfg.normalize();
            let resolved = resolve(&cfg, proj);
            let idx = match self.runners.iter().position(|r| r.cfg.id == cfg.id) {
                Some(i) => {
                    let r = &mut self.runners[i];
                    let stop = (r.cfg.running && !cfg.running) || r.cfg.free != cfg.free;
                    if stop {
                        r.silence(midi, &mut events);
                        r.reset(&mut events);
                    } else if r.resolved != resolved {
                        // Ziel geändert: Klingendes auf dem ALTEN Ziel beenden,
                        // sonst hängt dort die Note für immer.
                        r.silence(midi, &mut events);
                    }
                    if r.cfg.rate != cfg.rate {
                        r.next_grid = None; // aufs neue Raster neu einrasten
                    }
                    r.cfg = cfg;
                    r.resolved = resolved;
                    i
                }
                None => {
                    self.runners.push(Runner::new(cfg, resolved));
                    self.runners.len() - 1
                }
            };
            let free_pulse = self.free_pulse;
            let r = &mut self.runners[idx];
            let len = (r.cfg.length as usize).max(1);
            if r.pos >= len {
                r.pos %= len;
            }
            if r.cfg.running && r.next_grid.is_none() {
                let rate = r.rate();
                if r.cfg.free {
                    r.next_grid = Some(free_pulse);
                } else if playing {
                    // Mitten im Lauf scharf geschaltet: auf den nächsten
                    // Rasterpunkt des GLOBALEN Pulsraster warten (Beat-genau).
                    r.next_grid = Some(next_global.div_ceil(rate) * rate);
                }
            }
        }
        self.events = events;
    }

    /// Ein globaler Puls (nur bei laufendem Transport) — treibt die folgenden Läufer.
    pub fn on_global_pulse(&mut self, midi: &mut MidiOutManager, pulse: u64) {
        let (mut events, mut rng) = (std::mem::take(&mut self.events), self.rng);
        for r in self.runners.iter_mut().filter(|r| !r.cfg.free) {
            r.tick(midi, pulse, &mut events, &mut rng);
        }
        self.events = events;
        self.rng = rng;
    }

    /// Ein Puls der freien Domäne — läuft immer, ob der Transport spielt oder nicht.
    pub fn on_free_pulse(&mut self, midi: &mut MidiOutManager) {
        let p = self.free_pulse;
        let (mut events, mut rng) = (std::mem::take(&mut self.events), self.rng);
        for r in self.runners.iter_mut().filter(|r| r.cfg.free) {
            r.tick(midi, p, &mut events, &mut rng);
        }
        self.events = events;
        self.rng = rng;
        self.free_pulse += 1;
    }

    /// Transport startet: folgende Läufer beginnen bei Puls 0 von vorn.
    pub fn transport_start(&mut self, midi: &mut MidiOutManager) {
        let mut events = std::mem::take(&mut self.events);
        for r in self.runners.iter_mut().filter(|r| !r.cfg.free) {
            r.silence(midi, &mut events);
            r.reset(&mut events);
            if r.cfg.running {
                r.next_grid = Some(0);
            }
        }
        self.events = events;
    }

    /// Transport stoppt: folgende Läufer verstummen und warten auf das nächste Play.
    pub fn transport_stop(&mut self, midi: &mut MidiOutManager) {
        let mut events = std::mem::take(&mut self.events);
        for r in self.runners.iter_mut().filter(|r| !r.cfg.free) {
            r.silence(midi, &mut events);
            r.reset(&mut events);
        }
        self.events = events;
    }

    /// Panic: alles Klingende beenden, Läufer bleiben scharf.
    pub fn silence(&mut self, midi: &mut MidiOutManager) {
        let mut events = std::mem::take(&mut self.events);
        for r in self.runners.iter_mut() {
            r.silence(midi, &mut events);
        }
        self.events = events;
    }

    /// UI-Rückmeldungen seit dem letzten Abholen.
    pub fn take_events(&mut self) -> Vec<SeqEvent> {
        std::mem::take(&mut self.events)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn growing_repeats_the_pattern_and_clamps_values() {
        let mut s = StepSeq::new("t");
        s.steps[0].pitch = 48;
        s.steps[1].pitch = 55;
        s.length = 40;
        s.steps[3].velocity = 0;
        s.steps[4].gate = 9.0;
        s.normalize();
        assert_eq!(s.steps.len(), 40);
        assert_eq!(s.steps[16].pitch, 48);
        assert_eq!(s.steps[17].pitch, 55);
        assert_eq!(s.steps[3].velocity, 1);
        assert_eq!(s.steps[4].gate, 1.0);
        s.length = 999;
        s.normalize();
        assert_eq!(s.length, 64);
        assert_eq!(s.steps.len(), 64);
    }

    #[test]
    fn rates_map_to_whole_pulses() {
        assert_eq!(rate_pulses("1/16"), Some(6));
        assert_eq!(rate_pulses("1/8T"), Some(8));
        assert_eq!(rate_pulses("1/32"), Some(3));
        assert_eq!(rate_pulses("bogus"), None);
    }

    fn runner(dir: &str, len: u32) -> Runner {
        let mut cfg = StepSeq::new("t");
        cfg.length = len;
        cfg.direction = dir.to_string();
        cfg.normalize();
        Runner::new(cfg, Vec::new())
    }

    fn order(dir: &str, len: u32, n: usize) -> Vec<usize> {
        let mut r = runner(dir, len);
        let mut rng = 1;
        (0..n).map(|_| r.advance(&mut rng)).collect()
    }

    #[test]
    fn directions_walk_the_line() {
        assert_eq!(order("forward", 4, 6), vec![0, 1, 2, 3, 0, 1]);
        assert_eq!(order("reverse", 4, 6), vec![3, 2, 1, 0, 3, 2]);
        assert_eq!(order("pingPong", 4, 8), vec![0, 1, 2, 3, 2, 1, 0, 1]);
        assert_eq!(order("pingPong", 1, 3), vec![0, 0, 0]);
        assert!(order("random", 5, 50).iter().all(|&s| s < 5));
    }

    #[test]
    fn scaling_matches_the_dashboard_fan_out() {
        assert_eq!(scale_7bit(0, 0, 127), 0);
        assert_eq!(scale_7bit(127, 20, 110), 110);
        assert_eq!(scale_7bit(127, 127, 0), 0);
    }
}
