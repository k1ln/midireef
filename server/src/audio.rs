//! Audio-Aufnahme + -Wiedergabe über ausgewählte Ein-/Ausgangs-Interfaces
//! (cpal). Ein Vorgang läuft komplett auf einem eigenen OS-Thread (derselbe
//! Grund wie bei `midi::MidiInManager`/`spawn_midi_learn`: der `cpal::Stream`
//! ist auf manchen Plattformen nicht `Send`, muss also dort bleiben, wo er
//! erzeugt wurde). Aufnahmen landen als WAV unter `<data_dir>/recordings/`
//! und werden über die normale HTTP-Route ausgeliefert (s. `main.rs`), sodass
//! sie sich direkt übers WLAN herunterladen bzw. im Browser abspielen lassen
//! — kein eigener Datei-Server nötig. Wiedergabe über die echte Hardware des
//! Servers (statt nur im Browser) läuft über denselben `cpal`-Weg wie die
//! Aufnahme, nur mit einem Ausgangs- statt Eingangs-Stream, s. `start_playback`.

use std::fs::File;
use std::io::BufWriter;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::Sample as _;
use serde::{Deserialize, Serialize};

/// Ausgewählter Audio-Ein-/Ausgang, persistiert wie `display.json`/`network.json`.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AudioConfig {
    pub input_device: Option<String>,
    /// Ausgang für die Wiedergabe gespeicherter Aufnahmen (`audio.play.start`)
    /// — läuft über die echte Hardware des Servers (Interface-Ausgang,
    /// Kopfhörerbuchse, HDMI, …), nicht über den Browser der Kiosk-Anzeige.
    #[serde(default)]
    pub output_device: Option<String>,
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

/// Verfügbare Audio-Eingänge (Anzeigenamen), auf eine Zeile pro physischer
/// Karte entdoppelt — Grundlage der Interface-Auswahl in der UI, analog zu
/// `midi::list_ports`. S. `dedupe_alsa_aliases` fürs Warum der Entdopplung.
pub fn list_input_devices() -> Vec<String> {
    let host = cpal::default_host();
    host.input_devices().map(list_devices).unwrap_or_default()
}

/// Verfügbare Audio-Ausgänge — für die Wiedergabe einer Aufnahme über die
/// echte Hardware des Servers (`audio.play.start`), s. `list_input_devices`.
pub fn list_output_devices() -> Vec<String> {
    let host = cpal::default_host();
    host.output_devices().map(list_devices).unwrap_or_default()
}

fn list_devices(devices: impl Iterator<Item = cpal::Device>) -> Vec<String> {
    let entries: Vec<(String, String)> = devices
        .filter_map(|d| Some((d.id().ok()?.id().to_string(), device_label(&d))))
        .collect();
    dedupe_alsa_aliases(entries).into_iter().map(|(_, label)| label).collect()
}

/// Sucht ein Ein-/Ausgangsgerät per Namens-Substring — tolerant wie
/// `midi::find_port`, weil derselbe Name nach einem Replug/Neustart des
/// Audio-Servers leicht anders lauten kann. Leerer/fehlender Name → `None`
/// (der Aufrufer fällt dann auf Standard-Ein-/Ausgang zurück).
///
/// Matcht ein Name mehrere ALSA-Aliasse derselben Karte (identische
/// Beschreibung, s. `dedupe_alsa_aliases`), wird der am direktesten nutzbare
/// genommen (`alsa_priority`) — nicht irgendeiner, den `Iterator::find` zuerst
/// sieht, sonst öffnet ein Klick auf den EINEN Listeneintrag mal `front:…`,
/// mal `dmix:…`, je nachdem, in welcher Reihenfolge `cpal` sie aufzählt.
fn find_device(devices: impl Iterator<Item = cpal::Device>, needle: &str) -> Option<cpal::Device> {
    let mut candidates: Vec<cpal::Device> = devices.filter(|d| device_label(d).contains(needle)).collect();
    candidates.sort_by_key(|d| d.id().ok().map(|id| alsa_priority(id.id())).unwrap_or(u8::MAX));
    candidates.into_iter().next()
}

fn find_input_device(host: &cpal::platform::Host, needle: &str) -> Option<cpal::Device> {
    find_device(host.input_devices().ok()?, needle)
}

fn find_output_device(host: &cpal::platform::Host, needle: &str) -> Option<cpal::Device> {
    find_device(host.output_devices().ok()?, needle)
}

/// Löst den zu benutzenden Ein-/Ausgang auf: explizit gewählter Name, sonst
/// der beste verfügbare (`find_device` mit leerem Suchstring matcht — und
/// sortiert damit nach `alsa_priority` — JEDES Gerät, liefert also denselben
/// Spitzenreiter wie der erste Eintrag von `list_input_devices()`/
/// `list_output_devices()`).
///
/// Bewusst NICHT `host.default_input_device()`/`default_output_device()`:
/// cpals „Standardgerät" ist auf ALSA meist buchstäblich der Alias `"default"`
/// aus `/etc/asound.conf` — der zeigt nicht zuverlässig auf ein frisch
/// angeschlossenes USB-Interface, sondern oft weiter auf die Onboard-Karte.
/// Ohne diese eigene Auflösung konnte die UI „aktiv" einen Eintrag zeigen
/// (den Spitzenreiter der eigenen Liste), während Aufnahme/Wiedergabe
/// tatsächlich über ein ANDERES, per `cpal` als „Standard" gemeldetes Gerät
/// liefen — z.B. eine stumme Aufnahme, obwohl die Liste das richtige
/// Interface als gewählt anzeigte.
fn resolve_input_device(host: &cpal::platform::Host, selected: Option<&str>) -> Option<cpal::Device> {
    match selected.filter(|n| !n.is_empty()) {
        Some(name) => find_input_device(host, name),
        None => find_device(host.input_devices().ok()?, ""),
    }
}

fn resolve_output_device(host: &cpal::platform::Host, selected: Option<&str>) -> Option<cpal::Device> {
    match selected.filter(|n| !n.is_empty()) {
        Some(name) => find_output_device(host, name),
        None => find_device(host.output_devices().ok()?, ""),
    }
}

/// ALSA meldet eine einzelne physische Karte oft mehrfach unter
/// verschiedenen Alias-Namen — `cpal`s ALSA-Backend listet sowohl alle ALSA-
/// „Hints" (`default`/`sysdefault`/`front`/`surround*`/`dmix`/`dsnoop`/…) ALS
/// AUCH zusätzlich `hw:`/`plughw:` für jede gefundene Hardware. Alle Aliasse
/// derselben Karte tragen dieselbe menschenlesbare Beschreibung (ALSA liefert
/// sie identisch für jeden Alias) — ungefiltert taucht ein einziges
/// angeschlossenes Interface deshalb mehrfach mit demselben Namen in der
/// Liste auf. Hier wird pro Karte (erkannt an `CARD=…` in der rohen
/// Geräte-ID) GENAU EIN Alias behalten, der am direktesten nutzbare
/// (`alsa_priority`). Ids ohne `CARD=` (macOS-CoreAudio-UIDs, `"default"`
/// ohne Kartenbezug, …) bleiben unangetastet: jede ist ihre eigene Gruppe.
fn dedupe_alsa_aliases(entries: Vec<(String, String)>) -> Vec<(String, String)> {
    let mut order: Vec<String> = Vec::new();
    let mut groups: std::collections::HashMap<String, Vec<(String, String)>> = std::collections::HashMap::new();
    for entry in entries {
        let key = alsa_group_key(&entry.0);
        if !groups.contains_key(&key) {
            order.push(key.clone());
        }
        groups.entry(key).or_default().push(entry);
    }
    order
        .into_iter()
        .filter_map(|key| {
            let mut variants = groups.remove(&key)?;
            variants.sort_by_key(|(id, _)| alsa_priority(id));
            variants.into_iter().next()
        })
        .collect()
}

/// Gruppenschlüssel für `dedupe_alsa_aliases`: `CARD=`(+`DEV=`) aus einer
/// rohen ALSA-Geräte-ID, sonst die ID selbst (→ eigene Gruppe, kein Entdoppeln).
fn alsa_group_key(id: &str) -> String {
    let Some(card_pos) = id.find("CARD=") else {
        return id.to_string();
    };
    let rest = &id[card_pos + "CARD=".len()..];
    let card = rest.split(',').next().unwrap_or(rest);
    let dev = id
        .find("DEV=")
        .map(|p| {
            id[p + "DEV=".len()..]
                .split(|c: char| !c.is_ascii_digit())
                .next()
                .unwrap_or("0")
        })
        .unwrap_or("0");
    format!("card:{card}:{dev}")
}

/// Reihenfolge, in der ALSA-Aliasse derselben Karte bevorzugt werden:
/// `plughw` (direkter Zugriff, ALSA übernimmt Format-/Raten-Konvertierung —
/// der robusteste Alias für ein beliebiges Interface) vor `hw` (direkt, aber
/// ohne Konvertierung — scheitert an unpassenden Formaten) vor den Software-
/// Mix-Aliassen (`dmix`/`dsnoop`, teilen sich die Karte mit anderen
/// Prozessen, mehr Latenz) vor den übrigen Hints. Alles ohne bekanntes
/// Präfix (z.B. eine macOS-CoreAudio-UID) landet zuletzt — dort greift die
/// Priorität ohnehin nie, weil solche IDs nie eine `CARD=`-Gruppe teilen.
fn alsa_priority(id: &str) -> u8 {
    match id.split(':').next().unwrap_or(id) {
        "plughw" => 0,
        "hw" => 1,
        "dmix" | "dsnoop" => 2,
        "sysdefault" => 3,
        "front" => 4,
        p if p.starts_with("surround") => 5,
        "iec958" | "spdif" | "modem" => 6,
        "default" => 7,
        _ => 8,
    }
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

/// Liest eine gespeicherte Aufnahme komplett durch und meldet ihren
/// Spitzenpegel (0..1) — Diagnose-Werkzeug: „hört man eine Aufnahme nicht,
/// liegt es an der Aufnahme (falscher/stummer Eingang beim Aufnehmen) oder an
/// der Wiedergabe?" lässt sich damit ohne funktionierende Lautsprecher
/// beantworten, ähnlich `probe_peak` fürs LIVE-Signal eines Eingangs. Bewusst
/// NICHT automatisch bei jedem `list_recordings()` mitberechnet (das läuft in
/// praktisch jedem `audio.state`-Broadcast) — ein voller Datei-Scan pro
/// Aufnahme bei jedem Broadcast würde mit wachsendem Ordner spürbar lahmen;
/// stattdessen ein eigener, auf Anfrage laufender Command.
pub fn peak_of_recording(data_dir: &Path, file: &str) -> Result<f32, String> {
    if file.contains('/') || file.contains("..") {
        return Err("ungültiger Dateiname".into());
    }
    let path = recordings_dir(data_dir).join(file);
    let reader = hound::WavReader::open(&path).map_err(|e| format!("WAV-Datei ließ sich nicht öffnen: {e}"))?;
    let mut peak = 0f32;
    for sample in reader.into_samples::<f32>() {
        let Ok(s) = sample else { break };
        peak = peak.max(s.abs());
    }
    Ok(peak)
}

/// Löscht eine gespeicherte Aufnahme. Nimmt nur einfache Dateinamen (kein
/// `/`, kein `..`) an — Eingabe kommt über den WS-Command direkt aus der UI.
pub fn delete_recording(data_dir: &Path, file: &str) -> std::io::Result<()> {
    if file.contains('/') || file.contains("..") {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, "ungültiger Dateiname"));
    }
    let result = std::fs::remove_file(recordings_dir(data_dir).join(file));
    write_index(data_dir);
    result
}

/// Schreibt `<recordings_dir>/index.html` mit einer simplen Liste aller
/// Aufnahmen neu. `ServeDir` (s. `main.rs`s `/recordings`-Route) liefert eine
/// vorhandene `index.html` automatisch aus, sobald der bloße Ordner-Pfad
/// aufgerufen wird (dasselbe eingebaute Verhalten, das schon `ui_service()`
/// für die SPA nutzt) — ohne diese Datei zeigt `http://<pi>:8787/recordings/`
/// nichts an, obwohl die Dateien da sind (kein Verzeichnis-Listing ohne sie).
/// Ein Handler dafür würde mit `nest_service`s eigener Route auf demselben
/// Präfix kollidieren (Panik beim Router-Aufbau), daher der Umweg über eine
/// echte Datei statt eines eigenen Endpunkts. Aufgerufen bei jeder Änderung
/// der Liste (fertige Aufnahme, Löschen) sowie einmal beim Serverstart.
pub fn write_index(data_dir: &Path) {
    let recordings = list_recordings(data_dir);
    let rows = if recordings.is_empty() {
        "<li>No recordings yet.</li>".to_string()
    } else {
        recordings
            .iter()
            .filter_map(|r| {
                let file = r.get("file")?.as_str()?;
                let size = r.get("size").and_then(|v| v.as_u64()).unwrap_or(0);
                let kb = size / 1024;
                let escaped = file.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;");
                let encoded = urlencode(file);
                Some(format!("<li><a href=\"{encoded}\">{escaped}</a> — {kb} KB</li>"))
            })
            .collect::<Vec<_>>()
            .join("\n")
    };
    let html = format!(
        "<!doctype html><html><head><meta charset=\"utf-8\"><title>MidiReef recordings</title></head>\
         <body style=\"font-family:system-ui,sans-serif;max-width:640px;margin:2rem auto;padding:0 1rem\">\
         <h1>Recordings</h1><ul style=\"list-style:none;padding:0;line-height:2\">{rows}</ul></body></html>"
    );
    if let Err(e) = std::fs::write(recordings_dir(data_dir).join("index.html"), html) {
        tracing::warn!("recordings/index.html ließ sich nicht schreiben: {e}");
    }
}

/// Minimales Percent-Encoding für Dateinamen in `href` — unsere eigenen
/// Dateinamen (`rec-<unix-sekunden>.wav`, s. `start_recording`) sind zwar
/// immer ASCII-sauber, aber ein manuell in den Ordner kopierter Dateiname
/// soll die Liste nicht mit einem kaputten Link zerlegen.
fn urlencode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
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
            write_index(&data_dir);
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
    let device = resolve_input_device(&host, device_name.as_deref());
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

/// Testet nacheinander ALLE sichtbaren Eingänge (je ~300ms) und meldet den
/// Spitzenpegel jedes einzelnen per Event, sobald er feststeht — läuft auf
/// einem eigenen Thread, damit der Command-Loop währenddessen weiterläuft.
/// Nacheinander statt parallel, aus zwei Gründen: erstens ließen sich zwei
/// ALSA-Aliasse DERSELBEN Karte ohnehin nicht gleichzeitig öffnen (an sich
/// kein Problem mehr seit `dedupe_alsa_aliases`, aber verschiedene physische
/// Karten dürfen ruhig nacheinander drankommen statt die CPU mit N parallelen
/// Streams zu belasten); zweitens macht das der UI-Anzeige „testet gerade
/// Gerät X …" möglich, statt N Ergebnisse gleichzeitig hereinplatzen zu
/// lassen. Praktischer Nutzen: mehrdeutig benannte Eingänge lassen sich so
/// auseinanderhalten, indem man während des Tests ins richtige Mikro spricht
/// und beobachtet, bei welchem Listeneintrag der Pegel ausschlägt.
pub fn probe_inputs(events: tokio::sync::broadcast::Sender<serde_json::Value>) {
    std::thread::Builder::new()
        .name("midireef-audio-probe".into())
        .spawn(move || {
            let host = cpal::default_host();
            for name in list_input_devices() {
                let _ = events.send(serde_json::json!({ "t": "audio.probeStart", "device": name }));
                let result = match find_input_device(&host, &name) {
                    Some(device) => probe_peak(&device, 300),
                    None => Err("Gerät verschwunden".to_string()),
                };
                if let Err(e) = &result {
                    tracing::warn!("audio.probeInputs: „{name}“ fehlgeschlagen: {e}");
                }
                let evt = match result {
                    Ok(level) => serde_json::json!({ "t": "audio.probeResult", "device": name, "level": level }),
                    Err(e) => serde_json::json!({ "t": "audio.probeResult", "device": name, "error": e }),
                };
                let _ = events.send(evt);
            }
            let _ = events.send(serde_json::json!({ "t": "audio.probeDone" }));
        })
        .ok();
}

/// Öffnet EINEN Eingang für `probe_ms`, merkt sich den betragsmäßig größten
/// gesehenen Sample-Wert (0..1), schließt wieder.
fn probe_peak(device: &cpal::Device, probe_ms: u64) -> Result<f32, String> {
    let supported = device
        .default_input_config()
        .map_err(|e| format!("Kein Eingangs-Format verfügbar: {e}"))?;
    let format = supported.sample_format();
    let config = supported.config();

    let peak = Arc::new(Mutex::new(0f32));
    let stream = build_probe_stream(device, &config, format, peak.clone())?;
    stream.play().map_err(|e| format!("Test ließ sich nicht starten: {e}"))?;
    std::thread::sleep(std::time::Duration::from_millis(probe_ms));
    drop(stream);

    let level = *peak.lock().unwrap();
    Ok(level)
}

/// Wie `build_stream`, nur dass statt in eine WAV-Datei zu schreiben der
/// betragsmäßig größte Sample-Wert in `peak` festgehalten wird — eigene
/// (kleine) Verzweigung statt eine gemeinsame Abstraktion mit `build_stream`,
/// weil die beiden Callback-Bodies zu wenig teilen, um eine gemeinsame
/// Funktion zu rechtfertigen (s. Datei-Kopf zur Code-Stil-Haltung).
fn build_probe_stream(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    format: cpal::SampleFormat,
    peak: Arc<Mutex<f32>>,
) -> Result<cpal::platform::Stream, String> {
    let err_fn = |err: cpal::Error| tracing::debug!("Audio-Pegeltest-Fehler: {err}");

    macro_rules! build {
        ($t:ty) => {
            device
                .build_input_stream(
                    config.clone(),
                    move |data: &[$t], _: &cpal::InputCallbackInfo| {
                        let local_max = data
                            .iter()
                            .fold(0f32, |m, &s| m.max(s.to_sample::<f32>().abs()));
                        if let Ok(mut p) = peak.lock() {
                            if local_max > *p {
                                *p = local_max;
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

/// Eine laufende Wiedergabe (`audio.play.start`). Wie `ActiveRecording` lebt
/// der `cpal::Stream` auf seinem eigenen Thread; hier nur, was der Rest des
/// Servers braucht.
pub struct ActivePlayback {
    pub file: String,
    pub device: String,
    stop_tx: std::sync::mpsc::Sender<()>,
    /// Von der Stream-Callback selbst gesetzt, sobald die Datei durchgelaufen
    /// ist (s. `build_playback_stream`) — unabhängig davon, ob/wann jemand
    /// `stop()` ruft. `state_event` liest ihn, um eine natürlich zu Ende
    /// gespielte Aufnahme nicht mehr als „läuft" zu melden: der `Option`-Slot
    /// in `AppState.audio_playback` selbst wird erst beim NÄCHSTEN
    /// `audio.play.start`/`.stop` geräumt (s. dortiger Kommentar), ohne diesen
    /// Flag bliebe die UI bis dahin fälschlich bei „spielt gerade".
    finished: Arc<AtomicBool>,
}

impl ActivePlayback {
    pub fn stop(&self) {
        let _ = self.stop_tx.send(());
    }
}

/// Spielt kurz einen 440-Hz-Testton über den gewählten (oder System-Standard-)
/// Ausgang ab — unabhängig von jeder Aufnahme. Zum Durchprobieren, welcher
/// gelistete Ausgang tatsächlich am angeschlossenen Interface hängt bzw. ob
/// der Ausgangs-Pfad überhaupt Ton produziert: hört man den Ton nicht, liegt
/// es nicht an einer leisen/falsch aufgenommenen Datei, sondern am Ausgang
/// selbst (falsches Gerät gewählt, System-Lautstärke, Verkabelung, …).
pub fn play_test_tone(device_name: Option<String>, events: tokio::sync::broadcast::Sender<serde_json::Value>) {
    std::thread::Builder::new()
        .name("midireef-audio-tone".into())
        .spawn(move || {
            if let Err(e) = run_test_tone(device_name) {
                let _ = events.send(serde_json::json!({ "t": "audio.error", "message": e }));
            }
        })
        .ok();
}

fn run_test_tone(device_name: Option<String>) -> Result<(), String> {
    let host = cpal::default_host();
    let device = resolve_output_device(&host, device_name.as_deref());
    let Some(device) = device else {
        return Err("Audio-Ausgang nicht gefunden".into());
    };
    let supported = device
        .default_output_config()
        .map_err(|e| format!("Kein Ausgangs-Format verfügbar: {e}"))?;
    let format = supported.sample_format();
    let config = supported.config();
    let sample_rate = config.sample_rate as f32;

    let stream = build_tone_stream(&device, &config, format, sample_rate)?;
    stream.play().map_err(|e| format!("Testton ließ sich nicht starten: {e}"))?;
    std::thread::sleep(std::time::Duration::from_millis(1200));
    drop(stream);
    Ok(())
}

/// Baut den Output-Stream für den Testton: ein 440-Hz-Sinus (Kammerton A),
/// gedämpft auf 30% Amplitude (Lautsprecher/Ohren schonen), auf allen
/// Kanälen gleich. Kein externer Sample-Quelle nötig wie bei
/// `build_playback_stream` — die Callback rechnet die Welle selbst aus einem
/// laufenden Phasen-Zähler, den sie als `FnMut`-Zustand hält.
fn build_tone_stream(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    format: cpal::SampleFormat,
    sample_rate: f32,
) -> Result<cpal::platform::Stream, String> {
    const FREQ_HZ: f32 = 440.0;
    const AMPLITUDE: f32 = 0.3;
    let channels = config.channels.max(1) as usize;
    let err_fn = |err: cpal::Error| tracing::warn!("Audio-Testton-Fehler: {err}");

    macro_rules! build {
        ($t:ty) => {{
            let mut phase = 0f32;
            device
                .build_output_stream(
                    config.clone(),
                    move |data: &mut [$t], _: &cpal::OutputCallbackInfo| {
                        for out_frame in data.chunks_mut(channels) {
                            let sample = (phase * 2.0 * std::f32::consts::PI).sin() * AMPLITUDE;
                            phase = (phase + FREQ_HZ / sample_rate).fract();
                            let converted = sample.to_sample::<$t>();
                            for slot in out_frame.iter_mut() {
                                *slot = converted;
                            }
                        }
                    },
                    err_fn,
                    None,
                )
                .map_err(|e| e.to_string())
        }};
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
        other => Err(format!("nicht unterstütztes Ausgangs-Format: {other:?}")),
    }
}

/// Spielt eine gespeicherte Aufnahme über die echte Hardware des Servers ab
/// (nicht über den Browser der UI — dafür gibt es den `<audio>`-Player mit
/// dem HTTP-Link, s. `main.rs`s `/recordings`-Route). Blockiert kurz (Timeout
/// 3s), bis der Ausgangs-Stream wirklich läuft.
pub fn start_playback(
    file: String,
    device_name: Option<String>,
    data_dir: PathBuf,
    events: tokio::sync::broadcast::Sender<serde_json::Value>,
) -> Result<ActivePlayback, String> {
    if file.contains('/') || file.contains("..") {
        return Err("ungültiger Dateiname".into());
    }
    let path = recordings_dir(&data_dir).join(&file);
    if !path.is_file() {
        return Err("Aufnahme nicht gefunden".into());
    }

    let (ready_tx, ready_rx) = std::sync::mpsc::channel::<Result<String, String>>();
    let (stop_tx, stop_rx) = std::sync::mpsc::channel::<()>();
    let finished = Arc::new(AtomicBool::new(false));
    let finished_thread = finished.clone();

    let file_for_thread = file.clone();
    std::thread::Builder::new()
        .name("midireef-audio-play".into())
        .spawn(move || {
            run_playback(device_name, path, ready_tx, stop_rx, finished_thread);
            let _ = events.send(serde_json::json!({ "t": "audio.playbackDone", "file": file_for_thread }));
        })
        .map_err(|e| e.to_string())?;

    match ready_rx.recv_timeout(std::time::Duration::from_secs(3)) {
        Ok(Ok(device)) => Ok(ActivePlayback { file, device, stop_tx, finished }),
        Ok(Err(e)) => Err(e),
        Err(_) => Err("Wiedergabe-Ausgang antwortet nicht".into()),
    }
}

/// Läuft komplett auf dem Wiedergabe-Thread: Ausgang auflösen, WAV-Datei
/// öffnen, Stream bauen + starten, warten bis entweder `stop_rx` feuert ODER
/// die Datei zu Ende gespielt ist (`finished`, von der Stream-Callback selbst
/// gesetzt), dann abbauen.
fn run_playback(
    device_name: Option<String>,
    path: PathBuf,
    ready_tx: std::sync::mpsc::Sender<Result<String, String>>,
    stop_rx: std::sync::mpsc::Receiver<()>,
    finished: Arc<AtomicBool>,
) {
    let host = cpal::default_host();
    let device = resolve_output_device(&host, device_name.as_deref());
    let Some(device) = device else {
        let _ = ready_tx.send(Err("Audio-Ausgang nicht gefunden".into()));
        return;
    };
    let label = device_label(&device);

    let reader = match hound::WavReader::open(&path) {
        Ok(r) => r,
        Err(e) => {
            let _ = ready_tx.send(Err(format!("WAV-Datei ließ sich nicht öffnen: {e}")));
            return;
        }
    };
    let src_channels = reader.spec().channels as usize;
    let src_rate = reader.spec().sample_rate;
    // Aufnahmen sind IMMER 32-bit-Float-WAV (s. `run_recording`) — direktes
    // Lesen als f32 ohne Formatverzweigung, unabhängig vom Ausgangsgerät.
    let samples = reader.into_samples::<f32>();

    let supported = match device.default_output_config() {
        Ok(c) => c,
        Err(e) => {
            let _ = ready_tx.send(Err(format!("Kein Ausgangs-Format verfügbar: {e}")));
            return;
        }
    };
    let out_format = supported.sample_format();
    // Rate der Aufnahme erzwingen statt der Geräte-Vorgabe: die meisten Aus-
    // gänge (v.a. `plughw:` unter ALSA, s. `alsa_priority`) rechnen intern um
    // — sonst liefe die Wiedergabe in falscher Geschwindigkeit/Tonhöhe, weil
    // dieselben Samples mit der (typischerweise abweichenden) Geräte-Rate
    // ausgegeben würden.
    let mut out_config = supported.config();
    out_config.sample_rate = src_rate;

    let stream = match build_playback_stream(&device, &out_config, out_format, src_channels, samples, finished.clone()) {
        Ok(s) => s,
        Err(e) => {
            let _ = ready_tx.send(Err(e));
            return;
        }
    };
    if let Err(e) = stream.play() {
        let _ = ready_tx.send(Err(format!("Wiedergabe ließ sich nicht starten: {e}")));
        return;
    }
    let _ = ready_tx.send(Ok(label));

    // Wartet, bis entweder extern gestoppt wird ODER die Datei durchgelaufen
    // ist — kurzes Poll-Intervall statt eines blockierenden `recv()`, weil
    // NUR die Stream-Callback (nicht dieser Thread) weiß, wann die letzte
    // Sample-Probe verbraucht ist.
    loop {
        if finished.load(Ordering::Relaxed) {
            break;
        }
        match stop_rx.recv_timeout(std::time::Duration::from_millis(80)) {
            Ok(()) => break,
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
    drop(stream);
}

/// Baut den Output-Stream für die Wiedergabe: liest `samples` (immer f32,
/// s. `run_playback`) framebasiert aus, mapt Quell- auf Ziel-Kanalzahl per
/// Modulo (deckt die häufigen Fälle sauber ab — Mono-Aufnahme auf Stereo-
/// Ausgang verdoppelt den einen Kanal, Stereo auf Mono-Ausgang nimmt den
/// ersten; ein echter Downmix wäre für eine Performance-Aufnahme kein
/// nennenswerter Zugewinn) und konvertiert jedes Sample über `dasp_sample`
/// (von `cpal` reexportiert) ins Zielformat. Ist die Quelle erschöpft, setzt
/// die Callback `finished` (der Wiedergabe-Thread beendet sich daraufhin von
/// selbst) und füllt den Rest mit Stille.
fn build_playback_stream(
    device: &cpal::Device,
    out_config: &cpal::StreamConfig,
    out_format: cpal::SampleFormat,
    src_channels: usize,
    mut samples: impl Iterator<Item = Result<f32, hound::Error>> + Send + 'static,
    finished: Arc<AtomicBool>,
) -> Result<cpal::platform::Stream, String> {
    let out_channels = out_config.channels.max(1) as usize;
    let src_channels = src_channels.max(1);
    let err_fn = |err: cpal::Error| tracing::warn!("Audio-Wiedergabe-Fehler: {err}");

    macro_rules! build {
        ($t:ty) => {{
            let mut frame = vec![0f32; src_channels];
            device
                .build_output_stream(
                    out_config.clone(),
                    move |data: &mut [$t], _: &cpal::OutputCallbackInfo| {
                        if finished.load(Ordering::Relaxed) {
                            for s in data.iter_mut() {
                                *s = <$t as cpal::Sample>::EQUILIBRIUM;
                            }
                            return;
                        }
                        for out_frame in data.chunks_mut(out_channels) {
                            let mut have_frame = true;
                            for slot in frame.iter_mut() {
                                match samples.next() {
                                    Some(Ok(v)) => *slot = v,
                                    _ => {
                                        have_frame = false;
                                        break;
                                    }
                                }
                            }
                            if !have_frame {
                                finished.store(true, Ordering::Relaxed);
                                for s in out_frame.iter_mut() {
                                    *s = <$t as cpal::Sample>::EQUILIBRIUM;
                                }
                                continue;
                            }
                            for (ch, slot) in out_frame.iter_mut().enumerate() {
                                *slot = frame[ch % src_channels].to_sample::<$t>();
                            }
                        }
                    },
                    err_fn,
                    None,
                )
                .map_err(|e| e.to_string())
        }};
    }

    match out_format {
        cpal::SampleFormat::F32 => build!(f32),
        cpal::SampleFormat::F64 => build!(f64),
        cpal::SampleFormat::I8 => build!(i8),
        cpal::SampleFormat::I16 => build!(i16),
        cpal::SampleFormat::I32 => build!(i32),
        cpal::SampleFormat::U8 => build!(u8),
        cpal::SampleFormat::U16 => build!(u16),
        cpal::SampleFormat::U32 => build!(u32),
        other => Err(format!("nicht unterstütztes Ausgangs-Format: {other:?}")),
    }
}

/// Baut das `audio.state`-Event: Ein-/Ausgangsliste, gewählte Geräte, laufende
/// Aufnahme/Wiedergabe (falls eine), gespeicherte Aufnahmen.
pub fn state_event(
    cfg: &AudioConfig,
    active: Option<&ActiveRecording>,
    playing: Option<&ActivePlayback>,
    data_dir: &Path,
) -> serde_json::Value {
    serde_json::json!({
        "t": "audio.state",
        "inputs": list_input_devices(),
        "inputDevice": cfg.input_device,
        "outputs": list_output_devices(),
        "outputDevice": cfg.output_device,
        "recording": active.map(|a| serde_json::json!({
            "file": a.file,
            "device": a.device,
            "elapsedMs": a.started_at.elapsed().as_millis() as u64,
        })),
        // `filter`: eine natürlich zu Ende gespielte Datei (s. `ActivePlayback::finished`)
        // gilt nicht mehr als „läuft" — der `Option`-Slot in `AppState.audio_playback`
        // wird sonst erst beim nächsten `audio.play.start`/`.stop` geräumt.
        "playing": playing.filter(|p| !p.finished.load(Ordering::Relaxed)).map(|p| serde_json::json!({
            "file": p.file,
            "device": p.device,
        })),
        "recordings": list_recordings(data_dir),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dedupe_collapses_alsa_aliases_of_the_same_card_to_one_entry() {
        // Genau das gemeldete Symptom: eine einzelne Karte, fünf ALSA-Aliasse,
        // alle mit identischer Beschreibung (so liefert `cpal` sie tatsächlich).
        let label = "USB Audio CODEC".to_string();
        let entries = vec![
            ("front:CARD=Generic,DEV=0".to_string(), label.clone()),
            ("surround21:CARD=Generic,DEV=0".to_string(), label.clone()),
            ("dmix:CARD=Generic,DEV=0".to_string(), label.clone()),
            ("hw:CARD=Generic,DEV=0".to_string(), label.clone()),
            ("plughw:CARD=Generic,DEV=0".to_string(), label.clone()),
        ];
        let out = dedupe_alsa_aliases(entries);
        assert_eq!(out.len(), 1);
        // plughw gewinnt — direkter Zugriff, ALSA übernimmt Format-/Raten-
        // Konvertierung, funktioniert also mit dem breitesten Gerätespektrum.
        assert_eq!(out[0].0, "plughw:CARD=Generic,DEV=0");
        assert_eq!(out[0].1, label);
    }

    #[test]
    fn dedupe_keeps_different_cards_and_devices_separate() {
        let entries = vec![
            ("hw:CARD=A,DEV=0".to_string(), "Interface A".to_string()),
            ("plughw:CARD=B,DEV=0".to_string(), "Interface B".to_string()),
            // Zweiter Eingang DERSELBEN Mehrkanal-Karte (anderes DEV=) bleibt
            // ein eigener, echter Eintrag statt mit DEV=0 verschmolzen zu werden.
            ("hw:CARD=A,DEV=1".to_string(), "Interface A (2)".to_string()),
        ];
        let out = dedupe_alsa_aliases(entries);
        assert_eq!(out.len(), 3);
    }

    #[test]
    fn dedupe_leaves_ids_without_card_untouched() {
        // macOS-CoreAudio-UIDs (oder ein kartenloses "default") teilen keine
        // CARD=-Gruppe — jede Id bleibt für sich, auch bei identischem Namen.
        let entries = vec![
            ("AppleUSBAudioEngine:foo".to_string(), "Built-in Microphone".to_string()),
            ("AppleUSBAudioEngine:bar".to_string(), "Built-in Microphone".to_string()),
        ];
        let out = dedupe_alsa_aliases(entries);
        assert_eq!(out.len(), 2);
    }

    #[test]
    fn alsa_priority_orders_plughw_before_hw_before_software_mix_before_hints() {
        assert!(alsa_priority("plughw:CARD=A,DEV=0") < alsa_priority("hw:CARD=A,DEV=0"));
        assert!(alsa_priority("hw:CARD=A,DEV=0") < alsa_priority("dmix:CARD=A,DEV=0"));
        assert!(alsa_priority("dsnoop:CARD=A,DEV=0") < alsa_priority("sysdefault:CARD=A"));
        assert!(alsa_priority("sysdefault:CARD=A") < alsa_priority("front:CARD=A,DEV=0"));
        assert!(alsa_priority("front:CARD=A,DEV=0") < alsa_priority("surround21:CARD=A,DEV=0"));
        assert!(alsa_priority("default") > alsa_priority("plughw:CARD=A,DEV=0"));
    }

    #[test]
    fn alsa_group_key_ignores_the_alias_prefix() {
        assert_eq!(alsa_group_key("front:CARD=Generic,DEV=0"), alsa_group_key("plughw:CARD=Generic,DEV=0"));
        assert_ne!(alsa_group_key("hw:CARD=A,DEV=0"), alsa_group_key("hw:CARD=B,DEV=0"));
        assert_ne!(alsa_group_key("hw:CARD=A,DEV=0"), alsa_group_key("hw:CARD=A,DEV=1"));
    }
}
