//! Audio-Aufnahme über ein ausgewähltes Eingangs-Interface (cpal). Ein
//! Vorgang läuft komplett auf einem eigenen OS-Thread (derselbe Grund wie bei
//! `midi::MidiInManager`/`spawn_midi_learn`: der `cpal::Stream` ist auf
//! manchen Plattformen nicht `Send`, muss also dort bleiben, wo er erzeugt
//! wurde). Aufnahmen landen als WAV unter `<data_dir>/recordings/` und werden
//! über die normale HTTP-Route ausgeliefert (s. `main.rs`), sodass sie sich
//! direkt übers WLAN herunterladen lassen — kein eigener Datei-Server nötig.

use std::fs::File;
use std::io::BufWriter;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::Sample as _;
use serde::{Deserialize, Serialize};

/// Ausgewählter Audio-Eingang, persistiert wie `display.json`/`network.json`.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AudioConfig {
    pub input_device: Option<String>,
}

fn config_path(data_dir: &Path) -> PathBuf {
    data_dir.join("audio.json")
}

pub fn load(data_dir: &Path) -> AudioConfig {
    match std::fs::read_to_string(config_path(data_dir)) {
        Ok(s) => serde_json::from_str(&s).unwrap_or_else(|e| {
            tracing::warn!("audio.json unlesbar ({e}) — nehme Default (kein Eingang gewählt)");
            AudioConfig::default()
        }),
        Err(_) => AudioConfig::default(),
    }
}

pub fn save(data_dir: &Path, cfg: &AudioConfig) -> std::io::Result<()> {
    std::fs::write(config_path(data_dir), serde_json::to_string_pretty(cfg)?)
}

pub fn recordings_dir(data_dir: &Path) -> PathBuf {
    let dir = data_dir.join("recordings");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

/// Anzeigename eines Geräts — `description().name` (strukturiert, wenn der
/// Host sie liefert), sonst der `Display`-Fallback (`device.to_string()`).
fn device_label(d: &cpal::Device) -> String {
    d.description()
        .ok()
        .map(|desc| desc.name().to_string())
        .unwrap_or_else(|| d.to_string())
}

/// Verfügbare Audio-Eingänge (Anzeigenamen) — Grundlage der Interface-Auswahl
/// in der UI, analog zu `midi::list_ports`.
pub fn list_input_devices() -> Vec<String> {
    let host = cpal::default_host();
    let Ok(devices) = host.input_devices() else {
        return Vec::new();
    };
    devices.map(|d| device_label(&d)).collect()
}

/// Sucht ein Eingangsgerät per Namens-Substring — tolerant wie
/// `midi::find_port`, weil derselbe Name nach einem Replug/Neustart des
/// Audio-Servers leicht anders lauten kann. Leerer/fehlender Name → `None`
/// (der Aufrufer fällt dann auf den Standard-Eingang zurück).
fn find_input_device(host: &cpal::platform::Host, needle: &str) -> Option<cpal::Device> {
    host.input_devices()
        .ok()?
        .find(|d| device_label(d).contains(needle))
}

/// Metadaten aller gespeicherten Aufnahmen, neueste zuerst — Grundlage des
/// `audio.recordings`-Events.
pub fn list_recordings(data_dir: &Path) -> Vec<serde_json::Value> {
    let dir = recordings_dir(data_dir);
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut found: Vec<(u64, serde_json::Value)> = entries
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().and_then(|x| x.to_str()) == Some("wav"))
        .filter_map(|e| {
            let meta = e.metadata().ok()?;
            let modified = meta
                .modified()
                .ok()?
                .duration_since(std::time::UNIX_EPOCH)
                .ok()?
                .as_secs();
            let name = e.file_name().to_string_lossy().to_string();
            Some((
                modified,
                serde_json::json!({
                    "file": name,
                    "size": meta.len(),
                    "createdAt": modified,
                }),
            ))
        })
        .collect();
    found.sort_by(|a, b| b.0.cmp(&a.0));
    found.into_iter().map(|(_, v)| v).collect()
}

/// Löscht eine gespeicherte Aufnahme. Nimmt nur einfache Dateinamen (kein
/// `/`, kein `..`) an — Eingabe kommt über den WS-Command direkt aus der UI.
pub fn delete_recording(data_dir: &Path, file: &str) -> std::io::Result<()> {
    if file.contains('/') || file.contains("..") {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, "ungültiger Dateiname"));
    }
    std::fs::remove_file(recordings_dir(data_dir).join(file))
}

/// Ein laufender Aufnahme-Vorgang. Der `cpal::Stream` selbst lebt auf seinem
/// eigenen Thread (s. Moduldoku); hier steht nur, was der Rest des Servers
/// braucht: der Dateiname fürs `audio.recordingState`-Event und ein Kanal,
/// über den sich der Thread stoppen lässt.
pub struct ActiveRecording {
    pub file: String,
    pub device: String,
    pub started_at: Instant,
    stop_tx: std::sync::mpsc::Sender<()>,
}

impl ActiveRecording {
    pub fn stop(&self) {
        let _ = self.stop_tx.send(());
    }
}

/// Startet eine neue Aufnahme. Blockiert kurz (Timeout 3s), bis der Stream
/// wirklich läuft, damit Start-Fehler (Gerät verschwunden, kein Eingangs-
/// Format) sofort als `Err` an den Aufrufer zurückkommen statt stillzuliegen.
pub fn start_recording(
    device_name: Option<String>,
    data_dir: PathBuf,
    events: tokio::sync::broadcast::Sender<serde_json::Value>,
) -> Result<ActiveRecording, String> {
    // Unix-Sekunden statt `model::now_iso()` — dessen Format ("unix:<secs>")
    // ist fürs Projekt-JSON gedacht, nicht für einen Dateinamen.
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let file_name = format!("rec-{secs}.wav");
    let path = recordings_dir(&data_dir).join(&file_name);

    let (ready_tx, ready_rx) = std::sync::mpsc::channel::<Result<String, String>>();
    let (stop_tx, stop_rx) = std::sync::mpsc::channel::<()>();

    std::thread::Builder::new()
        .name("midireef-audio-rec".into())
        .spawn(move || {
            run_recording(device_name, path, ready_tx, stop_rx);
            let recordings = list_recordings(&data_dir);
            let _ = events.send(serde_json::json!({ "t": "audio.recordings", "recordings": recordings }));
        })
        .map_err(|e| e.to_string())?;

    match ready_rx.recv_timeout(std::time::Duration::from_secs(3)) {
        Ok(Ok(device)) => Ok(ActiveRecording {
            file: file_name,
            device,
            started_at: Instant::now(),
            stop_tx,
        }),
        Ok(Err(e)) => Err(e),
        Err(_) => Err("Audio-Eingang antwortet nicht".into()),
    }
}

/// Läuft komplett auf dem Aufnahme-Thread: Gerät auflösen, WAV-Datei anlegen,
/// Stream bauen + starten, auf `stop_rx` warten, dann abschließen.
fn run_recording(
    device_name: Option<String>,
    path: PathBuf,
    ready_tx: std::sync::mpsc::Sender<Result<String, String>>,
    stop_rx: std::sync::mpsc::Receiver<()>,
) {
    let host = cpal::default_host();
    let device = match device_name.as_deref().filter(|n| !n.is_empty()) {
        Some(name) => find_input_device(&host, name),
        None => host.default_input_device(),
    };
    let Some(device) = device else {
        let _ = ready_tx.send(Err("Audio-Eingang nicht gefunden".into()));
        return;
    };
    let label = device_label(&device);

    let supported = match device.default_input_config() {
        Ok(c) => c,
        Err(e) => {
            let _ = ready_tx.send(Err(format!("Kein Eingangs-Format verfügbar: {e}")));
            return;
        }
    };
    let sample_format = supported.sample_format();
    let stream_config = supported.config();

    // Immer als 32-bit-Float-WAV geschrieben, unabhängig vom nativen Format
    // des Geräts — vermeidet eine eigene hound-Sample-Format-Verzweigung pro
    // Quantisierung (I8/I16/I32/U8/U16/U32/F32/F64), s. `build_stream`.
    let spec = hound::WavSpec {
        channels: stream_config.channels,
        sample_rate: stream_config.sample_rate,
        bits_per_sample: 32,
        sample_format: hound::SampleFormat::Float,
    };
    let writer = match hound::WavWriter::create(&path, spec) {
        Ok(w) => w,
        Err(e) => {
            let _ = ready_tx.send(Err(format!("WAV-Datei ließ sich nicht anlegen: {e}")));
            return;
        }
    };
    let writer: Arc<Mutex<Option<hound::WavWriter<BufWriter<File>>>>> = Arc::new(Mutex::new(Some(writer)));

    let stream = match build_stream(&device, &stream_config, sample_format, writer.clone()) {
        Ok(s) => s,
        Err(e) => {
            let _ = ready_tx.send(Err(e));
            return;
        }
    };
    if let Err(e) = stream.play() {
        let _ = ready_tx.send(Err(format!("Aufnahme ließ sich nicht starten: {e}")));
        return;
    }
    let _ = ready_tx.send(Ok(label));

    // Blockiert, bis `ActiveRecording::stop()` feuert — der Stream muss so
    // lange am Leben bleiben (sein Callback schreibt in `writer`).
    let _ = stop_rx.recv();
    drop(stream);

    let taken = writer.lock().unwrap().take();
    if let Some(w) = taken {
        if let Err(e) = w.finalize() {
            tracing::warn!("WAV-Datei „{}“ ließ sich nicht abschließen: {e}", path.display());
        }
    }
}

/// Baut den Input-Stream fürs tatsächliche Format des Geräts — cpal verlangt
/// den Sample-Typ zur Compile-Zeit, das Format steht aber erst zur Laufzeit
/// fest, daher die Verzweigung. Jeder Zweig konvertiert über `dasp_sample`
/// (von `cpal` reexportiert) nach `f32`, damit `writer` nur einen einzigen
/// Sample-Typ kennen muss.
fn build_stream(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    format: cpal::SampleFormat,
    writer: Arc<Mutex<Option<hound::WavWriter<BufWriter<File>>>>>,
) -> Result<cpal::platform::Stream, String> {
    let err_fn = |err: cpal::Error| tracing::warn!("Audio-Aufnahme-Fehler: {err}");

    macro_rules! build {
        ($t:ty) => {
            device
                .build_input_stream(
                    config.clone(),
                    move |data: &[$t], _: &cpal::InputCallbackInfo| {
                        if let Ok(mut guard) = writer.lock() {
                            if let Some(w) = guard.as_mut() {
                                for &s in data {
                                    let _ = w.write_sample(s.to_sample::<f32>());
                                }
                            }
                        }
                    },
                    err_fn,
                    None,
                )
                .map_err(|e| e.to_string())
        };
    }

    match format {
        cpal::SampleFormat::F32 => build!(f32),
        cpal::SampleFormat::F64 => build!(f64),
        cpal::SampleFormat::I8 => build!(i8),
        cpal::SampleFormat::I16 => build!(i16),
        cpal::SampleFormat::I32 => build!(i32),
        cpal::SampleFormat::U8 => build!(u8),
        cpal::SampleFormat::U16 => build!(u16),
        cpal::SampleFormat::U32 => build!(u32),
        other => Err(format!("nicht unterstütztes Sample-Format: {other:?}")),
    }
}

/// Baut das `audio.state`-Event: Eingangsliste, gewählter Eingang, laufende
/// Aufnahme (falls eine), gespeicherte Aufnahmen.
pub fn state_event(cfg: &AudioConfig, active: Option<&ActiveRecording>, data_dir: &Path) -> serde_json::Value {
    serde_json::json!({
        "t": "audio.state",
        "inputs": list_input_devices(),
        "inputDevice": cfg.input_device,
        "recording": active.map(|a| serde_json::json!({
            "file": a.file,
            "device": a.device,
            "elapsedMs": a.started_at.elapsed().as_millis() as u64,
        })),
        "recordings": list_recordings(data_dir),
    })
}
