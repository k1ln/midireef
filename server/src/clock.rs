//! Clock-/Transport-Engine.
//!
//! Läuft auf einem dedizierten OS-Thread (kein async, kein GC-Jitter) und erzeugt
//! MIDI-Clock (24 PPQN) sowie Start/Stop. Treibt die Wiedergabe-Engine (Noten/CC)
//! und pusht den Transportzustand als JSON-Event an die UI.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tokio::sync::broadcast;

use crate::engine::Engine;
use crate::model::{ClockSource, Project, TransportState};

#[derive(Debug, Clone)]
pub enum ClockCommand {
    Play,
    Stop,
    SetBpm(f64),
    TapTempo,
    Panic,
    SetClockSource(ClockSource),
    /// Rohe MIDI-Bytes an einen Port senden (Live-Controls).
    Midi(String, Vec<u8>),
    /// Baustein per Touch auslösen: (laneId, slotId).
    TriggerSlot(String, String),
}

#[derive(Clone)]
pub struct ClockHandle {
    tx: Sender<ClockCommand>,
}

impl ClockHandle {
    pub fn send(&self, cmd: ClockCommand) {
        let _ = self.tx.send(cmd);
    }
}

const PPQN: u32 = 24;
const BEATS_PER_BAR: u32 = 4; // Grundgerüst: 4/4; folgt später der Taktart
const UI_BROADCAST_EVERY: u32 = 6; // UI-Tick alle 6 Pulse (16tel)

pub fn spawn(
    transport: Arc<Mutex<TransportState>>,
    project: Arc<Mutex<Project>>,
    generation: Arc<AtomicU64>,
    events: broadcast::Sender<serde_json::Value>,
) -> ClockHandle {
    let (tx, rx) = std::sync::mpsc::channel::<ClockCommand>();

    std::thread::Builder::new()
        .name("mididrift-clock".into())
        .spawn(move || clock_loop(rx, transport, project, generation, events))
        .expect("clock thread");

    ClockHandle { tx }
}

fn pulse_interval(bpm: f64) -> Duration {
    let secs = 60.0 / (bpm * PPQN as f64);
    Duration::from_secs_f64(secs.max(0.0001))
}

fn clock_loop(
    rx: Receiver<ClockCommand>,
    transport: Arc<Mutex<TransportState>>,
    project: Arc<Mutex<Project>>,
    generation: Arc<AtomicU64>,
    events: broadcast::Sender<serde_json::Value>,
) {
    let mut engine = Engine::new();
    let mut cur_gen = u64::MAX;

    let mut bpm = { transport.lock().unwrap().bpm };
    let mut playing = false;
    let mut interval = pulse_interval(bpm);
    let mut next_pulse = Instant::now();
    let mut pulses: u64 = 0;
    let mut taps: Vec<Instant> = Vec::new();

    loop {
        // Bei Projekt-Änderung neu kompilieren.
        let g = generation.load(Ordering::Relaxed);
        if g != cur_gen {
            cur_gen = g;
            let proj = project.lock().unwrap();
            engine.rebuild_if_needed(&proj, g);
        }

        while let Ok(cmd) = rx.try_recv() {
            match cmd {
                ClockCommand::Play => {
                    playing = true;
                    pulses = 0;
                    next_pulse = Instant::now();
                    engine.transport_start();
                    let mut t = transport.lock().unwrap();
                    t.playing = true;
                    t.bar = 1;
                    t.beat = 1;
                    t.tick = 0;
                    broadcast_tick(&events, &t);
                }
                ClockCommand::Stop => {
                    playing = false;
                    engine.transport_stop();
                    let mut t = transport.lock().unwrap();
                    t.playing = false;
                    broadcast_tick(&events, &t);
                }
                ClockCommand::SetBpm(v) => {
                    bpm = v.clamp(20.0, 300.0);
                    interval = pulse_interval(bpm);
                    let mut t = transport.lock().unwrap();
                    t.bpm = bpm;
                    broadcast_tick(&events, &t);
                }
                ClockCommand::TapTempo => {
                    let now = Instant::now();
                    taps.retain(|t| now.duration_since(*t) < Duration::from_secs(2));
                    taps.push(now);
                    if taps.len() >= 2 {
                        let mut sum = 0.0;
                        for w in taps.windows(2) {
                            sum += w[1].duration_since(w[0]).as_secs_f64();
                        }
                        let avg = sum / (taps.len() - 1) as f64;
                        if avg > 0.0 {
                            bpm = (60.0 / avg).clamp(20.0, 300.0);
                            interval = pulse_interval(bpm);
                            let mut t = transport.lock().unwrap();
                            t.bpm = bpm;
                            broadcast_tick(&events, &t);
                        }
                    }
                }
                ClockCommand::Panic => engine.panic(),
                ClockCommand::Midi(port, bytes) => {
                    if !engine.send_raw(&port, &bytes) {
                        let reason = if port.is_empty() {
                            "No virtual MIDI output available.".to_string()
                        } else {
                            format!("MIDI output \"{port}\" not found — is the device connected?")
                        };
                        let _ = events.send(
                            serde_json::json!({ "t": "control.sendError", "message": reason }),
                        );
                    }
                }
                ClockCommand::TriggerSlot(lane_id, slot_id) => {
                    engine.trigger_slot(&lane_id, &slot_id);
                }
                ClockCommand::SetClockSource(src) => {
                    let mut t = transport.lock().unwrap();
                    t.clock_source = src;
                    broadcast_tick(&events, &t);
                }
            }
        }

        if playing {
            let now = Instant::now();
            while now >= next_pulse {
                engine.clock_pulse();
                engine.on_pulse(pulses);
                pulses += 1;
                next_pulse += interval;

                let tick = (pulses % PPQN as u64) as u32;
                let total_beats = pulses / PPQN as u64;
                let beat = (total_beats % BEATS_PER_BAR as u64) as u32 + 1;
                let bar = (total_beats / BEATS_PER_BAR as u64) as u32 + 1;

                if tick % UI_BROADCAST_EVERY == 0 {
                    let mut t = transport.lock().unwrap();
                    t.tick = tick;
                    t.beat = beat;
                    t.bar = bar;
                    broadcast_tick(&events, &t);
                }
            }
            std::thread::sleep(Duration::from_millis(1));
        } else {
            std::thread::sleep(Duration::from_millis(5));
        }
    }
}

fn broadcast_tick(events: &broadcast::Sender<serde_json::Value>, t: &TransportState) {
    let _ = events.send(serde_json::json!({ "t": "transport.tick", "transport": t }));
}
