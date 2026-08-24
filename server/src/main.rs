//! MidiDrift MIDI-Server — Einstiegspunkt.
//!
//! Startet Clock-Engine, WebSocket-Server und lädt/erzeugt ein Default-Projekt.

mod clock;
mod engine;
mod midi;
mod model;
mod state;
mod ws;

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use axum::routing::get;
use axum::Router;
use tokio::sync::broadcast;

use crate::model::{Project, TransportState};
use crate::state::AppState;

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "mididrift_server=info".into()),
        )
        .init();

    // Debug-Modus: loggt jede einzelne IN/OUT-MIDI-Nachricht (sonst nur
    // Fehler/Warnungen) — via `--debug`-Flag oder MIDIDRIFT_DEBUG=1.
    let debug = std::env::args().any(|a| a == "--debug")
        || std::env::var("MIDIDRIFT_DEBUG").map(|v| v == "1").unwrap_or(false);
    if debug {
        midi::MIDI_LOG.store(true, Ordering::Relaxed);
        tracing::info!("Debug-Modus aktiv: jede MIDI IN/OUT-Nachricht wird geloggt");
    }

    let data_dir = AppState::data_dir();

    let project = match state::load_most_recent_project_from(&data_dir) {
        Some(p) => {
            tracing::info!(
                "Zuletzt gespeichertes Projekt geladen: „{}“ ({} Device(s))",
                p.name,
                p.devices.len()
            );
            p
        }
        None => Project::new("MidiDrift"),
    };
    let transport = Arc::new(Mutex::new(TransportState {
        bpm: project.bpm,
        ..Default::default()
    }));
    let project = Arc::new(Mutex::new(project));
    let generation = Arc::new(AtomicU64::new(0));

    let (events_tx, _rx) = broadcast::channel::<serde_json::Value>(256);
    let clock = clock::spawn(
        transport.clone(),
        project.clone(),
        generation.clone(),
        events_tx.clone(),
    );

    let state = AppState {
        project,
        transport,
        clock,
        events: events_tx,
        data_dir,
        learn_armed: Arc::new(AtomicBool::new(false)),
        generation,
        last_device_warning: Arc::new(Mutex::new(None)),
    };

    // MIDI-Input öffnen + Learn-Handler-Thread starten.
    spawn_midi_learn(&state);

    let app = Router::new()
        .route("/ws", get(ws::ws_handler))
        .with_state(state);

    let port: u16 = std::env::var("MIDIDRIFT_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(8787);
    let addr = format!("0.0.0.0:{port}");

    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .expect("bind TCP");
    tracing::info!("MidiDrift-Server läuft auf ws://{addr}/ws");

    axum::serve(listener, app).await.expect("serve");
}

/// Öffnet alle MIDI-Eingänge und startet einen Thread, der eingehende
/// Nachrichten verarbeitet: im Learn-Modus wird die erste passende Nachricht
/// als Live-Control gelernt.
fn spawn_midi_learn(state: &AppState) {
    let (tx, rx) = std::sync::mpsc::channel::<(String, Vec<u8>)>();
    let conns = midi::open_all_inputs(tx);
    tracing::info!("MIDI-Eingänge geöffnet: {}", conns.len());

    let state = state.clone();
    std::thread::Builder::new()
        .name("mididrift-learn".into())
        .spawn(move || {
            // Verbindungen am Leben halten, solange der Thread läuft.
            let _conns = conns;
            while let Ok((source_port, msg)) = rx.recv() {
                if !state.learn_armed.load(Ordering::Relaxed) {
                    continue;
                }
                if let Some(mapping) = midi::parse_mapping(&msg) {
                    state.learn_armed.store(false, Ordering::Relaxed);
                    // Gerät automatisch aus der Quelle ableiten: passendes Device
                    // wiederverwenden oder — falls ein gleichnamiger MIDI-Ausgang
                    // existiert — neu in der Sequencer-Übersicht anlegen.
                    let learned_channel = mapping
                        .get("channel")
                        .and_then(|v| v.as_u64())
                        .unwrap_or(1) as u8;
                    let device_id = state.device_id_for_input_port(&source_port, learned_channel);
                    let control_id = state.add_learned_control(&mapping, device_id.as_deref());
                    let _ = state.events.send(serde_json::json!({
                        "t": "learn.captured",
                        "controlId": control_id,
                        "mapping": mapping,
                    }));
                    let _ = state.events.send(state.snapshot_event());
                    if let Err(e) = state.save_project() {
                        tracing::warn!("Auto-Save nach MIDI-Learn fehlgeschlagen: {e}");
                    }
                }
            }
        })
        .expect("learn thread");
}
