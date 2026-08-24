//! Gemeinsamer App-Zustand: Projekt, Transport, Clock-Handle, Event-Broadcast.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use tokio::sync::broadcast;

use crate::clock::ClockHandle;
use crate::model::{Project, TransportState};

#[derive(Clone)]
pub struct AppState {
    pub project: Arc<Mutex<Project>>,
    pub transport: Arc<Mutex<TransportState>>,
    pub clock: ClockHandle,
    pub events: broadcast::Sender<serde_json::Value>,
    pub data_dir: PathBuf,
    /// Wenn true, wird die nächste eingehende MIDI-Nachricht als Control gelernt.
    pub learn_armed: Arc<AtomicBool>,
    /// Wird bei jeder Projekt-Änderung erhöht → die Engine kompiliert neu.
    pub generation: Arc<AtomicU64>,
    /// Drosselt die "Kein Gerät zugewiesen"-Warnung (sonst Flut bei CC-Ziehen).
    pub last_device_warning: Arc<Mutex<Option<Instant>>>,
}

impl AppState {
    /// Signalisiert der Wiedergabe-Engine, dass sich das Projekt geändert hat.
    pub fn bump_generation(&self) {
        self.generation.fetch_add(1, Ordering::Relaxed);
    }

    pub fn data_dir() -> PathBuf {
        let base = std::env::var("MIDIDRIFT_DATA")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("./data"));
        let _ = std::fs::create_dir_all(base.join("projects"));
        base
    }

    pub fn project_path(&self, id: &str) -> PathBuf {
        self.data_dir.join("projects").join(format!("{id}.json"))
    }

    pub fn save_project(&self) -> std::io::Result<()> {
        let proj = self.project.lock().unwrap().clone();
        let path = self.project_path(&proj.id);
        let json = serde_json::to_string_pretty(&proj)?;
        std::fs::write(path, json)
    }

    pub fn load_project(&self, id: &str) -> std::io::Result<Project> {
        let path = self.project_path(id);
        let data = std::fs::read_to_string(path)?;
        let proj: Project = serde_json::from_str(&data)?;
        Ok(proj)
    }

    pub fn snapshot_event(&self) -> serde_json::Value {
        let project = self.project.lock().unwrap().clone();
        let transport = self.transport.lock().unwrap().clone();
        serde_json::json!({
            "t": "state.snapshot",
            "project": project,
            "transport": transport,
        })
    }

    /// Fügt ein gelerntes Live-Control mit der gegebenen MIDI-Zuordnung hinzu.
    /// `device_id`, falls vorhanden, wird sofort als Ziel-Device gesetzt.
    /// Gibt die neue Control-ID zurück.
    pub fn add_learned_control(&self, mapping: &serde_json::Value, device_id: Option<&str>) -> String {
        const SIZE: f64 = 78.0; // 60% der früheren Standardgröße (130)

        let id = uuid::Uuid::new_v4().to_string();
        // Note/Program → Taster (Button); CC/PitchBend → Drehpoti (Knob).
        let map_kind = mapping.get("kind").and_then(|v| v.as_str()).unwrap_or("cc");
        let kind = match map_kind {
            "note" | "programChange" => "button",
            _ => "knob",
        };

        let mut proj = self.project.lock().unwrap();
        let (x, y) = next_free_position(&proj, SIZE);
        let ctrl = serde_json::json!({
            "id": id,
            "name": "",
            "kind": kind,
            "mapping": mapping,
            "deviceId": device_id,
            "min": 0,
            "max": 127,
            "value": 0,
            "screenId": "main",
            "x": x,
            "y": y,
            "w": SIZE,
            "h": SIZE,
        });
        if !proj.controls.is_array() {
            proj.controls = serde_json::json!([]);
        }
        if let Some(arr) = proj.controls.as_array_mut() {
            arr.push(ctrl);
        }
        id
    }

    /// Ermittelt (oder legt bei Bedarf an) das Device, das zum MIDI-Eingang
    /// `source_port` gehört — damit ein gelerntes Control automatisch dem
    /// Gerät zugeordnet wird, von dem die Lern-Nachricht kam.
    ///
    /// 1. Ein bereits bekanntes Device mit passendem `midiInPort`/`midiOutPort`
    ///    wird wiederverwendet.
    /// 2. Sonst: existiert ein gleichnamiger MIDI-*Ausgang* (viele Controller/
    ///    Synths melden sich mit demselben Namen als In- und Out-Port), wird
    ///    automatisch ein neues Device dafür angelegt (taucht dann auch in der
    ///    Sequencer-Übersicht auf).
    /// 3. Sonst `None` — der Eingang hat keinen erreichbaren Ausgang (z.B. ein
    ///    reiner Controller ohne MIDI-Out); das Control bleibt ohne Device.
    ///
    /// `learned_channel` (aus der Lern-Nachricht) wird als Start-Kanal für ein
    /// neu angelegtes Device übernommen — bessere Annahme als der Default 1,
    /// gerade weil er oft vom selben physischen Gerät stammt. Über den
    /// „Ch“-Button in der Sequencer-Übersicht bleibt er jederzeit korrigierbar.
    pub fn device_id_for_input_port(&self, source_port: &str, learned_channel: u8) -> Option<String> {
        {
            let proj = self.project.lock().unwrap();
            if let Some(d) = proj
                .devices
                .iter()
                .find(|d| names_match(d.midi_in_port.as_deref(), source_port)
                    || names_match(Some(d.midi_out_port.as_str()), source_port))
            {
                return Some(d.id.clone());
            }
        }

        let (outputs, _) = crate::midi::list_ports();
        let matching_output = outputs
            .into_iter()
            .find(|o| names_match(Some(o.as_str()), source_port))?;

        let mut proj = self.project.lock().unwrap();
        let mut device = crate::model::Device::new(matching_output.clone(), matching_output.clone());
        device.midi_in_port = Some(source_port.to_string());
        device.channel = learned_channel.clamp(1, 16);
        let id = device.id.clone();
        proj.devices.push(device);
        tracing::info!("Gerät „{matching_output}“ automatisch angelegt (aus MIDI-Learn)");
        Some(id)
    }

    /// Benennt ein Live-Control anhand seiner ID um.
    pub fn rename_control(&self, control_id: &str, name: &str) {
        let mut proj = self.project.lock().unwrap();
        if let Some(arr) = proj.controls.as_array_mut() {
            for c in arr.iter_mut() {
                if c.get("id").and_then(|v| v.as_str()) == Some(control_id) {
                    c["name"] = serde_json::Value::String(name.to_string());
                }
            }
        }
    }
}

/// Findet eine freie Position für ein neu gelerntes Control: rastert von
/// oben links, überspringt Zellen, die ein bestehendes Control überlappen
/// würden (auch manuell verschobene), damit neue Knöpfe nicht auf alten liegen.
/// Die Zeilenhöhe berücksichtigt zusätzlich den Beschriftungs-Block unter
/// jedem Control (Gerät/Name/Mapping/Frequenz), sonst würde Text der oberen
/// Reihe optisch mit dem Icon der nächsten Reihe kollidieren.
pub fn next_free_position(proj: &Project, size: f64) -> (f64, f64) {
    const MARGIN: f64 = 16.0;
    const LABEL_STACK_H: f64 = 96.0;
    const COLS: i32 = 8;
    const ROWS: i32 = 60;
    let col_step = size + MARGIN;
    let row_step = size + LABEL_STACK_H + MARGIN;

    let existing: Vec<(f64, f64, f64, f64)> = proj
        .controls
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|c| {
                    let x = c.get("x")?.as_f64()?;
                    let y = c.get("y")?.as_f64()?;
                    let w = c.get("w").and_then(|v| v.as_f64()).unwrap_or(size);
                    Some((x, y, w, w + LABEL_STACK_H))
                })
                .collect()
        })
        .unwrap_or_default();

    for row in 0..ROWS {
        for col in 0..COLS {
            let x = 24.0 + col as f64 * col_step;
            let y = 24.0 + row as f64 * row_step;
            let h = size + LABEL_STACK_H;
            let overlaps = existing.iter().any(|&(ex, ey, ew, eh)| {
                x < ex + ew && x + size > ex && y < ey + eh && y + h > ey
            });
            if !overlaps {
                return (x, y);
            }
        }
    }
    (24.0, 24.0)
}

/// Vergleicht zwei MIDI-Portnamen tolerant (case-insensitive, Substring in
/// beide Richtungen) — macOS/ALSA benennen den In- und Out-Port desselben
/// Geräts oft leicht unterschiedlich (z.B. mit/ohne Kanal-Suffix).
fn names_match(a: Option<&str>, b: &str) -> bool {
    let Some(a) = a else { return false };
    let (a, b) = (a.to_lowercase(), b.to_lowercase());
    if a == b || a.contains(b.as_str()) || b.contains(a.as_str()) {
        return true;
    }
    // Hardware meldet IN/OUT oft mit gegensätzlichem Richtungs-Suffix
    // ("P-6 MIDI OUT" als Eingang am Rechner, "P-6 MIDI IN" als Ausgang) —
    // nach Abschneiden des Suffix vergleichen, um trotzdem dasselbe
    // physische Gerät zu erkennen.
    let (base_a, base_b) = (strip_io_suffix(&a), strip_io_suffix(&b));
    base_a.len() >= 3 && base_a == base_b
}

/// Entfernt ein abschließendes "in"/"out"/"midi in"/"midi out" (samt Trenner)
/// von einem MIDI-Portnamen, um die Geräte-Basis zu vergleichen.
fn strip_io_suffix(name: &str) -> String {
    let trimmed = name.trim();
    for suffix in ["midi out", "midi in", "out", "in"] {
        if let Some(base) = trimmed.strip_suffix(suffix) {
            let base = base.trim_end_matches(['-', '_', ' ']).trim();
            if base.len() != trimmed.len() {
                return base.to_string();
            }
        }
    }
    trimmed.to_string()
}

/// Lädt beim Serverstart das zuletzt gespeicherte Projekt (nach Änderungsdatum
/// der `projects/*.json`-Datei), falls eines existiert. Verhindert Datenverlust
/// (gelernte Controls, Devices) bei einem Server-Neustart.
pub fn load_most_recent_project_from(data_dir: &std::path::Path) -> Option<Project> {
    let dir = data_dir.join("projects");
    let entries = std::fs::read_dir(&dir).ok()?;
    let newest = entries
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().and_then(|x| x.to_str()) == Some("json"))
        .max_by_key(|e| e.metadata().and_then(|m| m.modified()).ok())?;
    let data = std::fs::read_to_string(newest.path()).ok()?;
    serde_json::from_str(&data).ok()
}
