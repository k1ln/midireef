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

/// Verfügbare Audio-Eingänge (Anzeigenamen), auf eine Zeile pro physischer
/// Karte entdoppelt — Grundlage der Interface-Auswahl in der UI, analog zu
/// `midi::list_ports`. S. `dedupe_alsa_aliases` fürs Warum der Entdopplung.
pub fn list_input_devices() -> Vec<String> {
    let host = cpal::default_host();
    let Ok(devices) = host.input_devices() else {
        return Vec::new();
    };
    let entries: Vec<(String, String)> = devices
        .filter_map(|d| Some((d.id().ok()?.id().to_string(), device_label(&d))))
        .collect();
    dedupe_alsa_aliases(entries).into_iter().map(|(_, label)| label).collect()
}

/// Sucht ein Eingangsgerät per Namens-Substring — tolerant wie
/// `midi::find_port`, weil derselbe Name nach einem Replug/Neustart des
/// Audio-Servers leicht anders lauten kann. Leerer/fehlender Name → `None`
/// (der Aufrufer fällt dann auf den Standard-Eingang zurück).
///
/// Matcht ein Name mehrere ALSA-Aliasse derselben Karte (identische
/// Beschreibung, s. `dedupe_alsa_aliases`), wird der am direktesten nutzbare
/// genommen (`alsa_priority`) — nicht irgendeiner, den `Iterator::find` zuerst
/// sieht, sonst öffnet ein Klick auf den EINEN Listeneintrag mal `front:…`,
/// mal `dmix:…`, je nachdem, in welcher Reihenfolge `cpal` sie aufzählt.
fn find_input_device(host: &cpal::platform::Host, needle: &str) -> Option<cpal::Device> {
    let mut candidates: Vec<cpal::Device> = host
        .input_devices()
        .ok()?
        .filter(|d| device_label(d).contains(needle))
        .collect();
    candidates.sort_by_key(|d| d.id().ok().map(|id| alsa_priority(id.id())).unwrap_or(u8::MAX));
    candidates.into_iter().next()
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
