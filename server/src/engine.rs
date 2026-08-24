//! Wiedergabe-Engine: kompiliert Lanes/Bausteine des Projekts in schnelle
//! Strukturen und spielt sie im Clock-Loop ab (Melodie + Beat für v1).
//!
//! Timing: 24 PPQN. Ein Step-Boundary löst Note-Ons aus; Note-Offs werden
//! global (nach absolutem Puls) verwaltet.

use serde::Deserialize;

use crate::midi::{MidiOutManager, MIDI_CLOCK, MIDI_START, MIDI_STOP};
use crate::model::Project;

const PPQN: u32 = 24;
const PULSES_PER_WHOLE: u32 = PPQN * 4; // 96 Pulse pro ganze Note

// ── Kompilierte Strukturen ──────────────────────────────────────────────────

struct CNote {
    step: u32,
    len_steps: u32,
    note: u8,
    vel: u8,
}

enum CKind {
    Melody(Vec<CNote>),
    /// pro Step eine Liste aus (Note, Velocity)
    Beat(Vec<Vec<(u8, u8)>>),
}

struct CBlock {
    slot_id: String,
    pulses_per_step: u32,
    len_pulses: u32,
    loop_block: bool,
    channel: u8,
    kind: CKind,
}

struct CLane {
    id: String,
    port: String,
    enabled: bool,
    blocks: Vec<CBlock>,
}

#[derive(Clone, Copy)]
struct Playback {
    slot: usize,
    pos: u32, // Pulse-Position im aktuellen Block
}

struct PendingOff {
    port: String,
    ch: u8,
    note: u8,
    at: u64, // absoluter Puls
}

pub struct Engine {
    midi: MidiOutManager,
    lanes: Vec<CLane>,
    playback: Vec<Playback>,
    pending: Vec<PendingOff>,
    gen_seen: u64,
}

impl Engine {
    pub fn new() -> Self {
        Self {
            midi: MidiOutManager::new(),
            lanes: Vec::new(),
            playback: Vec::new(),
            pending: Vec::new(),
            gen_seen: u64::MAX,
        }
    }

    pub fn clock_pulse(&mut self) {
        self.midi.broadcast(&[MIDI_CLOCK]);
    }

    pub fn transport_start(&mut self) {
        self.reset();
        self.midi.broadcast(&[MIDI_START]);
    }

    pub fn transport_stop(&mut self) {
        self.midi.broadcast(&[MIDI_STOP]);
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
        self.playback[idx] = Playback { slot: block_idx, pos: 0 };
    }

    /// Sendet rohe MIDI-Bytes an einen Port (für Live-Controls vom Dashboard).
    /// Liefert `false`, wenn der Ausgang nicht erreichbar war.
    pub fn send_raw(&mut self, port: &str, bytes: &[u8]) -> bool {
        self.midi.send(port, bytes)
    }

    fn reset(&mut self) {
        for p in self.playback.iter_mut() {
            *p = Playback { slot: 0, pos: 0 };
        }
        self.pending.clear();
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
                let blocks = compile_slots(&lane.slots, blocks_json, lane_channel, dev.transpose);
                lanes.push(CLane {
                    id: lane.id.clone(),
                    port,
                    enabled: lane.enabled && !lane.muted,
                    blocks,
                });
            }
        }

        self.playback = lanes
            .iter()
            .map(|l| {
                let mut pb = prev.get(&l.id).copied().unwrap_or(Playback { slot: 0, pos: 0 });
                if l.blocks.is_empty() {
                    pb = Playback { slot: 0, pos: 0 };
                } else {
                    pb.slot %= l.blocks.len();
                    if pb.pos >= l.blocks[pb.slot].len_pulses {
                        pb.pos = 0;
                    }
                }
                pb
            })
            .collect();
        self.lanes = lanes;
    }

    /// Ein Puls Vorlauf: fällige Note-Offs senden, dann pro Lane Steps auslösen.
    pub fn on_pulse(&mut self, global_pulse: u64) {
        // Fällige Note-Offs.
        let mut i = 0;
        while i < self.pending.len() {
            if self.pending[i].at <= global_pulse {
                let off = self.pending.swap_remove(i);
                self.midi
                    .send(&off.port, &[0x80 | (off.ch - 1), off.note, 0]);
            } else {
                i += 1;
            }
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

            // Position fortschreiben, ggf. Block/Slot wechseln.
            let len = self.lanes[idx].blocks[slot].len_pulses.max(1);
            let mut next = pos + 1;
            let mut next_slot = slot;
            if next >= len {
                next = 0;
                if !self.lanes[idx].blocks[slot].loop_block {
                    next_slot = (slot + 1) % self.lanes[idx].blocks.len();
                }
            }
            self.playback[idx] = Playback {
                slot: next_slot,
                pos: next,
            };
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
        }

        for (note, vel, off) in hits {
            self.midi.send(&port, &[0x90 | (ch - 1), note, vel]);
            self.pending.push(PendingOff {
                port: port.clone(),
                ch,
                note,
                at: off,
            });
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
    channel: Option<u8>,
    #[serde(default)]
    notes: Vec<MelodyNoteJson>,
    #[serde(default)]
    lines: Vec<BeatLineJson>,
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

fn pulses_per_bar(ts: &str) -> u32 {
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
        if let Some(cb) = compile_block(&block, &slot, lane_channel, dev_transpose) {
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
) -> Option<CBlock> {
    let ppb = pulses_per_bar(&b.time_signature);
    let steps_per_bar = b.steps_per_bar.max(1);
    let total_steps = steps_per_bar * b.length_bars.max(1);
    let speed = if slot.speed > 0.0 { slot.speed } else { 1.0 };
    let base_pps = ppb as f64 / steps_per_bar as f64 / speed;
    let pulses_per_step = base_pps.round().max(1.0) as u32;
    let len_pulses = pulses_per_step * total_steps;
    let loop_block = slot.loop_mode != "off"; // v1: alles außer "off" loopt
    let channel = b.channel.unwrap_or(lane_channel).clamp(1, 16);
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
        _ => return None, // andere Typen (cc/arp/…) folgen später
    };

    Some(CBlock {
        slot_id: slot.id.clone(),
        pulses_per_step,
        len_pulses,
        loop_block,
        channel,
        kind,
    })
}
