//! MidiReef MIDI-Server — Einstiegspunkt.
//!
//! Startet Clock-Engine, WebSocket-Server und lädt/erzeugt ein Default-Projekt.

mod clock;
#[cfg(target_os = "macos")]
mod coremidi_hotplug;
mod engine;
mod logbuf;
mod midi;
mod model;
mod net_ap;
mod state;
mod ws;

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use axum::routing::get;
use axum::Router;
use tokio::sync::broadcast;
use tower_http::services::{ServeDir, ServeFile};

use crate::model::{Project, TransportState};
use crate::state::AppState;

/// Muss als allererster CoreMIDI-Kontakt im Prozess laufen — vor jedem
/// `midi::`-Aufruf. Siehe `coremidi_hotplug`-Moduldoku für das Warum.
#[cfg(target_os = "macos")]
fn init_coremidi_hotplug() {
    if let Err(e) = coremidi_hotplug::init() {
        tracing::warn!(
            "CoreMIDI-Hotplug-Notification konnte nicht initialisiert werden ({e}) — \
             nach Prozessstart angeschlossene MIDI-Geräte werden dann nicht erkannt"
        );
    } else {
        tracing::info!("CoreMIDI-Hotplug-Notification aktiv");
    }
}

#[cfg(not(target_os = "macos"))]
fn init_coremidi_hotplug() {}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "midireef_server=info".into()),
        )
        // Jede Zeile zusätzlich in den 1000-Zeilen-Ringpuffer (Einstellungen →
        // Server-Log). `with_ansi(false)`, damit dort keine Farbcodes stehen.
        .with_writer(logbuf::TeeMakeWriter)
        .with_ansi(false)
        .init();

    // Panics landen sonst nur auf stderr (→ journald) und tauchen in der
    // Log-Ansicht der Einstellungen nie auf. Hook: Grund + Ort + ein Stück
    // Backtrace zusätzlich in den Ringpuffer schreiben, dann den Standard-Hook
    // laufen lassen. Nützt vor allem, wenn ein Hintergrund-Thread (Clock)
    // stirbt und der Server „hängt", ohne dass man ohne SSH sieht, warum.
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let loc = info
            .location()
            .map(|l| format!("{}:{}", l.file(), l.line()))
            .unwrap_or_else(|| "?".into());
        let msg = info
            .payload()
            .downcast_ref::<&str>()
            .map(|s| s.to_string())
            .or_else(|| info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "<non-string panic payload>".into());
        let thread = std::thread::current().name().unwrap_or("<unnamed>").to_string();
        logbuf::record(&format!("PANIC [{thread}] at {loc}: {msg}"));
        let bt = std::backtrace::Backtrace::force_capture().to_string();
        for line in bt.lines().take(24) {
            logbuf::record(&format!("  {line}"));
        }
        default_hook(info);
    }));

    // Debug-Modus: loggt jede einzelne IN/OUT-MIDI-Nachricht (sonst nur
    // Fehler/Warnungen) — via `--debug`-Flag oder MIDIREEF_DEBUG=1.
    let debug = std::env::args().any(|a| a == "--debug")
        || std::env::var("MIDIREEF_DEBUG").map(|v| v == "1").unwrap_or(false);
    if debug {
        midi::MIDI_LOG.store(true, Ordering::Relaxed);
        tracing::info!("Debug-Modus aktiv: jede MIDI IN/OUT-Nachricht wird geloggt");
    }

    init_coremidi_hotplug();

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
        None => Project::new("MidiReef"),
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
        data_dir.clone(),
    );

    // WLAN-Access-Point-Konfiguration (siehe net_ap): der Pi „behält" den AP
    // über Reboots, indem der Soll-Zustand hier aus network.json kommt.
    let network = Arc::new(Mutex::new(net_ap::load(&data_dir)));

    let state = AppState {
        project,
        transport,
        clock,
        events: events_tx,
        data_dir,
        learn_armed: Arc::new(AtomicBool::new(false)),
        generation,
        last_device_warning: Arc::new(Mutex::new(None)),
        held_notes: Arc::new(Mutex::new(std::collections::HashMap::new())),
        record_armed: Arc::new(Mutex::new(None)),
        note_input: Arc::new(Mutex::new(None)),
        network: network.clone(),
    };

    // MIDI-Input öffnen + Learn-Handler-Thread starten.
    spawn_midi_learn(&state);

    // WLAN-AP beim Start in den gespeicherten Zustand bringen. Nie den
    // Serverstart blockieren — `nmcli` setzt die Schnittstelle neu auf und
    // braucht Sekunden — daher in einem Blocking-Task nebenher.
    {
        let cfg = network.lock().unwrap().clone();
        if cfg.ap_enabled && net_ap::supported() {
            tokio::task::spawn_blocking(move || match net_ap::apply(&cfg) {
                Ok(()) => tracing::info!("WLAN-Access-Point „{}“ aktiviert", cfg.ssid),
                Err(e) => tracing::warn!("WLAN-Access-Point-Start fehlgeschlagen: {e}"),
            });
        }
    }

    let app = Router::new()
        .route("/ws", get(ws::ws_handler))
        .with_state(state)
        .fallback_service(ui_service());

    let port: u16 = std::env::var("MIDIREEF_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(8787);
    let addr = format!("0.0.0.0:{port}");

    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .expect("bind TCP");
    tracing::info!("MidiReef-Server läuft auf http://{addr} (WebSocket: ws://{addr}/ws)");

    axum::serve(listener, app).await.expect("serve");
}

/// Statisches Ausliefern des gebauten UI (`ui/dist`) durch denselben Server,
/// der auch `/ws` bedient — auf dem Pi läuft so ein einziger Dienst auf einem
/// einzigen Port, den der Kiosk-Browser anspringt. Pfad via `MIDIREEF_UI_DIR`
/// (Default `./ui`, relativ zum Arbeitsverzeichnis des Dienstes).
///
/// Unbekannte Pfade fallen auf `index.html` zurück: die UI ist eine SPA, und
/// ohne Fallback würde ein Reload auf einer Unterroute 404 liefern.
fn ui_service() -> ServeDir<ServeFile> {
    let dir = std::env::var("MIDIREEF_UI_DIR").unwrap_or_else(|_| "./ui".into());
    let index = std::path::Path::new(&dir).join("index.html");
    if index.exists() {
        tracing::info!("UI wird ausgeliefert aus „{dir}“");
    } else {
        tracing::warn!(
            "Kein UI unter „{dir}“ gefunden (kein index.html) — der Server \
             bedient nur /ws. Für den Kiosk-Betrieb `ui/dist` dorthin deployen."
        );
    }
    ServeDir::new(&dir).fallback(ServeFile::new(index))
}

/// Interval für den Hotplug-Rescan der MIDI-Eingänge — `midir` bietet keine
/// Verbinden/Trennen-Benachrichtigung, daher wird periodisch neu gescannt.
const MIDI_RESCAN_INTERVAL: std::time::Duration = std::time::Duration::from_secs(2);

/// Öffnet alle MIDI-Eingänge und startet einen Thread, der eingehende
/// Nachrichten verarbeitet: im Learn-Modus wird die erste passende Nachricht
/// als Live-Control gelernt. Derselbe Thread rescannt periodisch die
/// Eingänge, damit nachträglich angeschlossene Geräte (Hotplug) ohne
/// Server-Neustart erkannt werden.
fn spawn_midi_learn(state: &AppState) {
    let (tx, rx) = std::sync::mpsc::channel::<(String, Vec<u8>)>();
    let mut in_mgr = midi::MidiInManager::new(tx);
    tracing::info!("MIDI-Eingänge geöffnet: {}", in_mgr.len());

    let state = state.clone();
    std::thread::Builder::new()
        .name("midireef-learn".into())
        .spawn(move || {
            let mut last_scan = std::time::Instant::now();
            loop {
                match rx.recv_timeout(MIDI_RESCAN_INTERVAL) {
                    Ok((source_port, msg)) => {
                        // Live-Aufnahme (record.arm) läuft unabhängig vom
                        // Lern-Modus — beides sind unabhängige Vorgänge.
                        state.forward_to_recorder(&msg);
                        // Einspielen in die offene Piano-Rolle — ebenfalls
                        // unabhängig vom Lern-Modus (s. `forward_note_input`).
                        state.forward_note_input(&msg);
                        if !state.learn_armed.load(Ordering::Relaxed) {
                            // Nicht im Lern-Modus: trotzdem prüfen, ob die Nachricht zu
                            // einem bereits gelernten Control passt (physisch bedienter
                            // Regler/Taster → Dashboard live nachführen). Bewusst KEIN
                            // `continue` hier: ein bereits verbundenes Gerät, das laufend
                            // sendet (MIDI-Clock, Active-Sensing 0xFE) würde sonst den
                            // Hotplug-Rescan unten dauerhaft überspringen, sodass ein
                            // nach Serverstart angeschlossenes Gerät nie geöffnet wird.
                            state.handle_midi_feedback(&source_port, &msg);
                        } else if let Some(mapping) = midi::parse_mapping(&msg) {
                            state.learn_armed.store(false, Ordering::Relaxed);
                            // Gerät automatisch aus der Quelle ableiten: passendes Device
                            // wiederverwenden oder — falls ein gleichnamiger MIDI-Ausgang
                            // existiert — neu in der Sequencer-Übersicht anlegen.
                            let device_id = state.device_id_for_input_port(&source_port);
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
                    Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
                    Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                }

                if last_scan.elapsed() >= MIDI_RESCAN_INTERVAL {
                    last_scan = std::time::Instant::now();
                    let delta = in_mgr.rescan();
                    if !delta.is_empty() {
                        for name in &delta.connected {
                            tracing::info!("MIDI-Eingang verbunden: „{name}“");
                        }
                        for name in &delta.disconnected {
                            tracing::info!("MIDI-Eingang getrennt: „{name}“");
                        }
                        let (outputs, inputs) = midi::list_ports();
                        let _ = state.events.send(serde_json::json!({
                            "t": "midi.ports",
                            "outputs": outputs,
                            "inputs": inputs,
                        }));
                    }
                }
            }
        })
        .expect("learn thread");
}
