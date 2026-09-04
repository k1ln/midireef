//! Clock-/Transport-Engine.
//!
//! Läuft auf einem dedizierten OS-Thread (kein async, kein GC-Jitter) und erzeugt
//! MIDI-Clock (24 PPQN) sowie Start/Stop. Treibt die Wiedergabe-Engine (Noten/CC)
//! und pusht den Transportzustand als JSON-Event an die UI.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tokio::sync::broadcast;

use crate::engine::{pulses_per_bar, Engine};
use crate::model::{ClockSource, Project, TransportState};
use crate::state::save_project_to;

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
    /// Baustein auslösen: (laneId, slotId, ggf. auslösende Note). Die Note
    /// treibt u.a. das LFO-Key-Tracking von CC-Bausteinen (rateKeyTrack).
    TriggerSlot(String, String, Option<u8>),
    /// Touch-Down / Note-On auf eine "hold"/"oneShot"-Lane: (laneId, slotId,
    /// ggf. auslösende Note).
    PressSlot(String, String, Option<u8>),
    /// Touch-Up auf eine "hold"-Lane: (laneId).
    ReleaseSlot(String),
    /// Setzt NUR die auslösende Note fürs LFO-Key-Tracking einer Lane, ohne
    /// sie zu starten/stoppen — Gegenstück zu `PressSlot`/`ReleaseSlot`, wenn
    /// eine externe MIDI-Note nur die Rate treiben soll (`setsKeytrack` bei
    /// `control.setTrigger`, unabhängig von dessen `starts`).
    SetTriggerNote(String, Option<u8>),
    /// Live vom Keyboard kommende Note für eine per `record.arm` gelinkte
    /// Melodie-Lane — siehe `record_note_in` unten. Nur der Clock-Thread kennt
    /// den laufenden Puls-Zähler, daher landet das hier statt in ws.rs.
    RecordNoteIn {
        lane_id: String,
        note: u8,
        velocity: u8,
        on: bool,
    },
    /// Baustein-Detail „▶ Play": den offenen Baustein einmal oder in Schleife
    /// abspielen — unabhängig vom Transport. Löst eine ggf. schon laufende
    /// Vorschau ab (s. `Engine::start_block_preview`).
    PlayBlockPreview(String, bool),
    /// „■ Stop" / Editor geschlossen: eine laufende Baustein-Vorschau sofort
    /// beenden (fällige Note-Offs gehen sofort raus).
    StopBlockPreview,
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
    data_dir: PathBuf,
) -> ClockHandle {
    let (tx, rx) = std::sync::mpsc::channel::<ClockCommand>();

    std::thread::Builder::new()
        .name("midireef-clock".into())
        .spawn(move || clock_loop(rx, transport, project, generation, events, data_dir))
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
    data_dir: PathBuf,
) {
    let mut engine = Engine::new();
    let mut cur_gen = u64::MAX;

    let mut bpm = { transport.lock().unwrap().bpm };
    let mut playing = false;
    let mut interval = pulse_interval(bpm);
    let mut next_pulse = Instant::now();
    // Baustein-Vorschau (BlockDetail „▶ Play") tickt im selben BPM-Intervall
    // wie der Haupt-Puls, aber UNABHÄNGIG von `playing` — sonst ließe sich ein
    // Baustein bei gestopptem Transport gar nicht anspielen.
    let mut preview_next_pulse = Instant::now();
    let mut pulses: u64 = 0;
    let mut taps: Vec<Instant> = Vec::new();
    // Live-Aufnahme (record.arm): pro (laneId, Note) der Step, an dem die
    // Note per Note-On begonnen hat — Note-Off berechnet daraus `lengthSteps`.
    let mut recording_holds: HashMap<(String, u8), u32> = HashMap::new();

    loop {
        // Bei Projekt-Änderung neu kompilieren.
        let g = generation.load(Ordering::Relaxed);
        if g != cur_gen {
            cur_gen = g;
            // Projekt KOPIEREN, statt den Lock über den Rebuild zu halten: ein
            // Panic beim Kompilieren darf nicht den `project`-Mutex vergiften
            // und damit jeden weiteren `lock().unwrap()` im Server (die
            // WS-Handler!) mitreißen. `catch_unwind` hält zusätzlich den
            // Clock-Thread am Leben — sonst stünde die Wiedergabe bis zum
            // Server-Neustart still.
            let proj = { project.lock().unwrap_or_else(|e| e.into_inner()).clone() };
            let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                engine.rebuild_if_needed(&proj, g);
                // Eine laufende Baustein-Vorschau (BlockDetail „▶ Play") hängt
                // NICHT an `self.lanes`, also fasst `rebuild_if_needed` sie
                // nicht an — ohne das hier bliebe eine Schleife auf dem Stand
                // von ihrem Start, während man am offenen Baustein weiter
                // editiert.
                engine.refresh_preview(&proj);
            }));
            if res.is_err() {
                tracing::error!(
                    "Engine-Rebuild für Generation {g} ist gepanickt — letzter guter Stand bleibt aktiv (Grund siehe PANIC-Zeile oben)"
                );
            }
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
                    drop(t);
                    broadcast_runtime(&events, engine.runtime_snapshot(), bpm, true);
                }
                ClockCommand::Stop => {
                    playing = false;
                    engine.transport_stop();
                    let mut t = transport.lock().unwrap();
                    t.playing = false;
                    broadcast_tick(&events, &t);
                    drop(t);
                    broadcast_runtime(&events, Vec::new(), bpm, false);
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
                ClockCommand::TriggerSlot(lane_id, slot_id, note) => {
                    engine.trigger_slot(&lane_id, &slot_id, note);
                }
                ClockCommand::PressSlot(lane_id, slot_id, note) => {
                    engine.press_slot(&lane_id, &slot_id, note);
                }
                ClockCommand::ReleaseSlot(lane_id) => {
                    engine.release_slot(&lane_id);
                }
                ClockCommand::SetTriggerNote(lane_id, note) => {
                    engine.set_trigger_note(&lane_id, note);
                }
                ClockCommand::SetClockSource(src) => {
                    let mut t = transport.lock().unwrap();
                    t.clock_source = src;
                    broadcast_tick(&events, &t);
                }
                ClockCommand::RecordNoteIn { lane_id, note, velocity, on } => {
                    // Nur während der Wiedergabe hat `pulses` eine sinnvolle
                    // Step-Position — sonst gäbe es nichts, wonach man sich
                    // beim Aufnehmen richten könnte.
                    if !playing {
                        continue;
                    }
                    let result = {
                        let mut proj = project.lock().unwrap();
                        record_note_in(&mut proj, &lane_id, note, velocity, on, pulses, &mut recording_holds)
                    };
                    if let Some((block_id, changed)) = result {
                        if changed {
                            generation.fetch_add(1, Ordering::Relaxed);
                            let proj_snapshot = project.lock().unwrap().clone();
                            if let Err(e) = save_project_to(&data_dir, &proj_snapshot) {
                                tracing::warn!("Auto-Save nach Live-Aufnahme fehlgeschlagen: {e}");
                            }
                            let t = transport.lock().unwrap().clone();
                            let _ = events.send(serde_json::json!({
                                "t": "state.snapshot",
                                "project": proj_snapshot,
                                "transport": t,
                            }));
                            let _ = events.send(serde_json::json!({
                                "t": "record.captured",
                                "laneId": lane_id,
                                "blockId": block_id,
                            }));
                        }
                    }
                }
                ClockCommand::PlayBlockPreview(block_id, looping) => {
                    let proj = project.lock().unwrap_or_else(|e| e.into_inner()).clone();
                    if let Err(reason) = engine.start_block_preview(&proj, &block_id, looping) {
                        let _ = events.send(serde_json::json!({ "t": "control.sendError", "message": reason }));
                    }
                }
                ClockCommand::StopBlockPreview => engine.stop_preview(),
            }
        }

        // Nach Stop/Release stellt die Engine ggf. nicht-destruktive CC-Ziele
        // zurück — an UI + Projekt spiegeln.
        flush_cc_restores(&mut engine, &project, &events);

        // s. `preview_next_pulse` oben — läuft immer, ob der Transport spielt
        // oder nicht.
        let preview_now = Instant::now();
        while preview_now >= preview_next_pulse {
            engine.on_preview_pulse(interval.as_secs_f64());
            preview_next_pulse += interval;
        }

        if playing {
            let now = Instant::now();
            while now >= next_pulse {
                let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    engine.clock_pulse();
                    engine.on_pulse(pulses, interval.as_secs_f64());
                }));
                if res.is_err() {
                    tracing::error!("Engine-Puls {pulses} ist gepanickt — Puls übersprungen (Grund siehe PANIC-Zeile oben)");
                }
                flush_cc_restores(&mut engine, &project, &events);
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
                    drop(t);
                    broadcast_runtime(&events, engine.runtime_snapshot(), bpm, true);
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

/// Knopf-Rückstellungen der Engine (nicht-destruktive CC-Bausteine am Ende)
/// an die UI melden UND in `project.controls` spiegeln, damit der Dashboard-Knob
/// sichtbar zur Ruhelage zurückspringt und der nächste Snapshot den Wert hält.
fn flush_cc_restores(
    engine: &mut Engine,
    project: &Arc<Mutex<Project>>,
    events: &broadcast::Sender<serde_json::Value>,
) {
    let restores = engine.take_cc_restores();
    if restores.is_empty() {
        return;
    }
    {
        let mut proj = project.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(arr) = proj.controls.as_array_mut() {
            for (cid, val) in &restores {
                if let Some(c) = arr
                    .iter_mut()
                    .find(|c| c.get("id").and_then(|v| v.as_str()) == Some(cid.as_str()))
                {
                    c["value"] = serde_json::json!(val);
                }
            }
        }
    }
    for (cid, val) in restores {
        let _ = events.send(serde_json::json!({
            "t": "control.valueChanged",
            "controlId": cid,
            "value": val,
        }));
    }
}

/// Wiedergabe-Zustand aller Lanes an die UI (welcher Baustein läuft, wie weit).
/// Bewusst ein EIGENES Event neben `transport.tick`: die Transportleiste hängt
/// an ihrem schlanken Tick und soll nicht bei jedem Lane-Snapshot mit-rendern
/// (s. Transport.tsx). `pulsesPerSec` reicht die aktuelle Puls-Rate mit, damit
/// die UI die Position zwischen zwei Snapshots flüssig weiterrechnen kann statt
/// im 16tel-Raster zu ruckeln.
fn broadcast_runtime(
    events: &broadcast::Sender<serde_json::Value>,
    lanes: Vec<crate::engine::LaneRuntime>,
    bpm: f64,
    playing: bool,
) {
    let _ = events.send(serde_json::json!({
        "t": "lane.runtime",
        "playing": playing,
        "pulsesPerSec": bpm * PPQN as f64 / 60.0,
        "lanes": lanes,
    }));
}

/// Trägt eine live vom Keyboard kommende Note in den ERSTEN Slot-Baustein der
/// Ziel-Lane ein. Die Step-Position kommt aus dem laufenden Puls-Zähler
/// (derselbe Takt, den die Engine fürs Abspielen nutzt — `pulses_per_bar`),
/// modulo der Baustein-Länge, damit man einfach über den Baustein "drüber"
/// spielt, egal ob er gerade selbst aktiv abgespielt wird. `on=false`
/// schließt die zuvor bei `on=true` begonnene Note ab (echte gehaltene Länge
/// statt einer geratenen festen Länge).
///
/// Rückgabe: `Some((blockId, changed))` — `changed=false` heißt "nichts zu
/// broadcasten/speichern" (z.B. Note lag schon exakt an Step+Tonhöhe vor).
fn record_note_in(
    proj: &mut Project,
    lane_id: &str,
    note: u8,
    velocity: u8,
    on: bool,
    pulses: u64,
    holds: &mut HashMap<(String, u8), u32>,
) -> Option<(String, bool)> {
    let block_id = proj
        .devices
        .iter()
        .flat_map(|d| d.lanes.iter())
        .find(|l| l.id == lane_id)?
        .slots
        .as_array()?
        .first()?
        .get("blockId")?
        .as_str()?
        .to_string();
    // Bausteine liegen projektweit (`project.blocks`).
    let block = proj
        .blocks
        .as_array_mut()?
        .iter_mut()
        .find(|b| b.get("id").and_then(|v| v.as_str()) == Some(block_id.as_str()))?;
    if block.get("type").and_then(|v| v.as_str()) != Some("melody") {
        return None;
    }

    let steps_per_bar = (block.get("stepsPerBar").and_then(|v| v.as_u64()).unwrap_or(16) as u32).max(1);
    let length_bars = (block.get("lengthBars").and_then(|v| v.as_u64()).unwrap_or(1) as u32).max(1);
    let time_sig = block.get("timeSignature").and_then(|v| v.as_str()).unwrap_or("4/4");
    let total_steps = steps_per_bar * length_bars;
    let pulses_per_step = (pulses_per_bar(time_sig) / steps_per_bar).max(1) as u64;
    let step = ((pulses / pulses_per_step) % total_steps as u64) as u32;

    let key = (lane_id.to_string(), note);
    if !block["notes"].is_array() {
        block["notes"] = serde_json::json!([]);
    }

    if on {
        holds.insert(key, step);
        let arr = block["notes"].as_array_mut()?;
        let dup = arr.iter().any(|n| {
            n.get("step").and_then(|v| v.as_u64()) == Some(step as u64)
                && n.get("note").and_then(|v| v.as_u64()) == Some(note as u64)
        });
        if !dup {
            arr.push(serde_json::json!({
                "step": step,
                "lengthSteps": 1,
                "note": note,
                "velocity": velocity,
            }));
        }
        Some((block_id, !dup))
    } else {
        let start_step = holds.remove(&key)?;
        let len = (step as i64 - start_step as i64).rem_euclid(total_steps as i64).max(1) as u32;
        let arr = block["notes"].as_array_mut()?;
        let n = arr.iter_mut().find(|n| {
            n.get("step").and_then(|v| v.as_u64()) == Some(start_step as u64)
                && n.get("note").and_then(|v| v.as_u64()) == Some(note as u64)
        })?;
        n["lengthSteps"] = serde_json::json!(len);
        Some((block_id, true))
    }
}
