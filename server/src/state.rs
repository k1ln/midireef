//! Gemeinsamer App-Zustand: Projekt, Transport, Clock-Handle, Event-Broadcast.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use tokio::sync::broadcast;

use crate::clock::{ClockCommand, ClockHandle};
use crate::model::{Project, TransportState};

/// Ein per `record.arm` live an eine Melodie-Lane gelinktes Keyboard-Control
/// (siehe `AppState::forward_to_recorder`). `channel` kommt aus dessen
/// gelerntem Mapping — nur Noten auf genau diesem Kanal werden aufgenommen.
#[derive(Debug, Clone)]
pub struct RecordArm {
    pub control_id: String,
    pub lane_id: String,
    pub channel: u8,
}

/// Ein Melodie-Baustein, der gerade im Piano-Roll-Editor auf Eingabe wartet
/// (`noteInput.listen`). Solange einer armiert ist, werden Noten JEDES
/// MIDI-Eingangs als `noteInput.note` an die UI gemeldet — dort trägt der
/// Editor sie an seinem Schreib-Cursor ein (siehe `PlayIn.tsx`).
#[derive(Debug, Clone)]
pub struct NoteInputArm {
    pub block_id: String,
    /// Ziel zum Mithören (Port, Kanal), beim Armieren aus den Lanes des
    /// Bausteins aufgelöst. Der Server spielt eingehende Noten selbst dorthin
    /// aus, statt die UI ein `block.previewNote` zurückschicken zu lassen —
    /// über den Umweg käme der Ton eine WS-Runde später, und genau daran
    /// merkt man beim Spielen jede Millisekunde.
    pub echo: Option<(String, u8)>,
    /// Tonhöhen, die dieses Mithören gerade hält — beim Entwaffnen bekommt
    /// jede davon ihr Note-Off, sonst bliebe ein Ton hängen.
    pub held: HashSet<u8>,
}

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
    /// Aktuell gehaltene Noten je Control-ID (nur Note-Mappings betroffen).
    /// Nötig für "keyboard"-Controls (matchen JEDE Note ihres Kanals): beim
    /// Loslassen EINER Taste darf das Licht nicht erlöschen, während andere
    /// Tasten noch gehalten werden (polyphones Spiel). Für normale
    /// Einzel-Tasten-Controls bleibt die Menge einfach bei Größe 0/1.
    pub held_notes: Arc<Mutex<HashMap<String, HashSet<u8>>>>,
    /// Aktuell an eine Melodie-Lane gelinktes Keyboard-Control (`record.arm`),
    /// falls eines armiert ist. Nur EINES gleichzeitig (v1).
    pub record_armed: Arc<Mutex<Option<RecordArm>>>,
    /// Baustein, dessen Piano-Roll gerade eingespielt wird (`noteInput.listen`).
    /// Auch hier nur EINER gleichzeitig — es ist immer genau ein Editor offen.
    pub note_input: Arc<Mutex<Option<NoteInputArm>>>,
    /// Soll-Zustand des Pi-WLAN-Access-Points (Einstellungen → „Wi-Fi access
    /// point"). Persistiert als `<data_dir>/network.json`, siehe `net_ap`.
    pub network: Arc<Mutex<crate::net_ap::NetworkConfig>>,
    /// Zeitpunkt des letzten gedrosselten Snapshots (s. `broadcast_snapshot_throttled`
    /// in ws.rs) — CC-Step-/Envelope-Balken und Velocity-Balken ziehen sonst bei
    /// jedem Zwischenwert einen vollen Engine-Rebuild + JSON-Snapshot + Autosave
    /// nach sich, was den Clock-Thread bei laufendem Transport ausbremst.
    pub last_streamed_snapshot: Arc<Mutex<Option<Instant>>>,
    /// Ob für die aktuelle Drossel-Periode schon ein Nachzügler-Snapshot
    /// eingeplant ist — verhindert, dass jeder gedrosselte Aufruf einen
    /// eigenen `tokio::spawn` anhäuft.
    pub snapshot_pending: Arc<AtomicBool>,
}

impl AppState {
    /// Signalisiert der Wiedergabe-Engine, dass sich das Projekt geändert hat.
    pub fn bump_generation(&self) {
        self.generation.fetch_add(1, Ordering::Relaxed);
    }

    pub fn data_dir() -> PathBuf {
        let base = std::env::var("MIDIREEF_DATA")
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
        save_project_to(&self.data_dir, &proj)
    }

    pub fn load_project(&self, id: &str) -> std::io::Result<Project> {
        let path = self.project_path(id);
        let data = std::fs::read_to_string(path)?;
        let mut proj: Project = serde_json::from_str(&data)?;
        migrate_project(&mut proj);
        Ok(proj)
    }

    /// Alle auf Platte liegenden Projekte fürs Einstellungs-Menü.
    pub fn list_projects(&self) -> Vec<serde_json::Value> {
        list_projects_in(&self.data_dir)
    }

    /// Löscht die Projektdatei. Ob dabei gerade dieses Projekt geöffnet ist,
    /// entscheidet der Aufrufer (siehe `project.delete` in ws.rs).
    pub fn delete_project_file(&self, id: &str) -> std::io::Result<()> {
        std::fs::remove_file(self.project_path(id))
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
    pub fn device_id_for_input_port(&self, source_port: &str) -> Option<String> {
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

    /// Spiegelt eine physisch am Gerät ausgelöste MIDI-Nachricht auf ein
    /// bereits gelerntes Live-Control zurück, damit der Dashboard-Knopf sich
    /// mitdreht bzw. der Taster aufleuchtet — Gegenstück zu MIDI-Learn (das
    /// nur EINMAL im Lern-Modus zuhört, hier läuft es dauerhaft mit) — und
    /// leitet sie zugleich an das Ziel-Device dieses Controls weiter
    /// (MIDI-Thru, s. [`thru_port`]).
    ///
    /// Erst das Weiterleiten macht ein angeschlossenes Keyboard spielbar:
    /// bis dahin liess ein eingehender Ton den Dashboard-Knopf zwar
    /// aufleuchten, es ging aber kein einziges Byte an einen Synth — während
    /// derselbe Knopf per Touch sehr wohl sendete. Welches Gerät gespielt
    /// wird, entscheidet „Device …" im Kontextmenü des Controls; ohne
    /// zugewiesenes Device leitet nichts weiter.
    ///
    /// Bewusst OHNE `broadcast_snapshot`: Regler können sehr schnell
    /// aufeinanderfolgende CCs schicken, ein voller Snapshot pro Nachricht
    /// (inkl. Autosave) wäre unnötige Last — siehe gleiche Überlegung beim
    /// `control.setValue`-Handler in ws.rs.
    pub fn handle_midi_feedback(&self, source_port: &str, msg: &[u8]) {
        // Nicht `< 3`: Channel-Aftertouch (0xD0) ist zwei Bytes lang und soll
        // beim Spielen mit durchgereicht werden.
        if msg.len() < 2 {
            return;
        }
        // Kommt die Nachricht von unserem EIGENEN virtuellen Ausgang zurück
        // (ALSA listet ihn auch als Eingang), niemals weiterverarbeiten — sonst
        // schleift die CC-Automation über Thru endlos zurück und legt den
        // Server lahm. `MidiInManager` öffnet ihn eigentlich gar nicht mehr;
        // dies ist die zweite Sicherung.
        if crate::midi::is_own_port(source_port) {
            return;
        }
        let status = msg[0] & 0xF0;
        let channel = (msg[0] & 0x0F) + 1;

        // Welches Control ist für diese Nachricht zuständig? Für Note und CC
        // das gelernte Mapping; für alles Übrige (Pitch-Bend, Aftertouch) und
        // für nicht gelernte CCs (Mod-Wheel, Sustain-Pedal) das
        // „keyboard"-Control des Kanals als Auffang-Eintrag — sonst käme beim
        // Spielen nur die nackte Tonhöhe am Synth an.
        let thru = {
            let proj = self.project.lock().unwrap();
            let ctrl = match status {
                0x90 | 0x80 if msg.len() >= 3 => find_control_by_mapping(&proj, channel, "note", msg[1]),
                0xB0 if msg.len() >= 3 => find_control_by_mapping(&proj, channel, "cc", msg[1])
                    .or_else(|| find_keyboard_control(&proj, channel)),
                0xE0 | 0xD0 | 0xA0 => find_keyboard_control(&proj, channel),
                _ => None,
            };
            let Some(ctrl) = ctrl else { return };
            thru_port(&proj, ctrl, source_port)
        };

        // Unverändert weiterreichen — insbesondere auf dem EINGEHENDEN Kanal,
        // nicht auf dem des Devices: dieselbe Überlegung wie bei
        // `control_trigger` in ws.rs (ein Keyboard sendet seine Zonen/Parts
        // auf genau den Kanälen, die das Zielgerät erwartet).
        if let Some(port) = thru {
            self.clock.send(ClockCommand::Midi(port, msg.to_vec()));
        }

        // ── Rückmeldung an die UI ───────────────────────────────────────────
        match status {
            0x90 | 0x80 if msg.len() >= 3 => {
                let (note, velocity) = (msg[1], msg[2]);
                let note_on = status == 0x90 && velocity > 0;
                let (id, trigger) = {
                    let proj = self.project.lock().unwrap();
                    match find_control_by_mapping(&proj, channel, "note", note) {
                        Some(c) => (
                            c.get("id").and_then(|v| v.as_str()).map(str::to_string),
                            c.get("trigger").and_then(|t| {
                                // `enabled === false` → Bindung ist pausiert.
                                if t.get("enabled").and_then(|v| v.as_bool()) == Some(false) {
                                    return None;
                                }
                                // Zwei unabhängig schaltbare Wirkungen derselben
                                // Note — s. Kommentar bei `control.setTrigger`
                                // in ws.rs. Fehlen die Felder (älteres Projekt),
                                // bleiben beide an: das alte, feste Verhalten.
                                let sets_keytrack =
                                    t.get("setsKeytrack").and_then(|v| v.as_bool()).unwrap_or(true);
                                let starts = t.get("starts").and_then(|v| v.as_bool()).unwrap_or(true);
                                Some((
                                    t.get("laneId")?.as_str()?.to_string(),
                                    t.get("slotId")?.as_str()?.to_string(),
                                    sets_keytrack,
                                    starts,
                                ))
                            }),
                        ),
                        None => (None, None),
                    }
                };
                // An einen Lane-Slot gebunden (control.setTrigger): Note-On löst
                // ihn aus — je nachdem, welche der beiden Wirkungen gewünscht
                // sind, presst es den Slot (`starts`), setzt nur die
                // Key-Track-Note (`setsKeytrack`), oder beides. Note-Off gibt
                // eine per `starts` gehaltene „hold"-Lane wieder frei.
                if let Some((lane_id, slot_id, sets_keytrack, starts)) = trigger {
                    if note_on {
                        if starts {
                            self.clock
                                .send(ClockCommand::PressSlot(lane_id.clone(), slot_id, Some(note)));
                        }
                        if sets_keytrack {
                            self.clock
                                .send(ClockCommand::SetTriggerNote(lane_id, Some(note)));
                        }
                    } else if starts {
                        self.clock.send(ClockCommand::ReleaseSlot(lane_id));
                    }
                }
                if let Some(id) = id {
                    let active = {
                        let mut held = self.held_notes.lock().unwrap();
                        let set = held.entry(id.clone()).or_default();
                        if note_on {
                            set.insert(note);
                        } else {
                            set.remove(&note);
                        }
                        !set.is_empty()
                    };
                    let _ = self.events.send(serde_json::json!({
                        "t": "control.activity",
                        "controlId": id,
                        "active": active,
                    }));
                }
            }
            0xB0 if msg.len() >= 3 => {
                // Einen Wert führt nur ein Control mit eigenem CC-Mapping —
                // das Keyboard-Control von oben ist für CCs reiner
                // Durchleiter und hat keinen Regler auf dem Dashboard.
                let (cc, value) = (msg[1], msg[2]);
                let id = {
                    let mut proj = self.project.lock().unwrap();
                    set_control_value_by_mapping(&mut proj, channel, "cc", cc, value)
                };
                if let Some(id) = id {
                    let _ = self.events.send(serde_json::json!({
                        "t": "control.valueChanged",
                        "controlId": id,
                        "value": value,
                    }));
                }
            }
            _ => {}
        }
    }

    /// Leitet eine eingehende Note-On/Off-Nachricht an den Clock-Thread weiter,
    /// FALLS gerade eine Lane über `record.arm` an ein Keyboard-Control auf
    /// genau diesem Kanal gelinkt ist — unabhängig vom MIDI-Learn-Status, das
    /// ist ein komplett separater Vorgang. Der Clock-Thread trägt die Note
    /// dort taktgenau ein (siehe `ClockCommand::RecordNoteIn` in clock.rs),
    /// weil nur er den laufenden Puls-Zähler kennt.
    pub fn forward_to_recorder(&self, msg: &[u8]) {
        if msg.len() < 3 {
            return;
        }
        let status = msg[0] & 0xF0;
        if status != 0x90 && status != 0x80 {
            return;
        }
        let channel = (msg[0] & 0x0F) + 1;
        let armed = self.record_armed.lock().unwrap().clone();
        let Some(arm) = armed else { return };
        if arm.channel != channel {
            return;
        }
        let (note, velocity) = (msg[1], msg[2]);
        let on = status == 0x90 && velocity > 0;
        self.clock.send(ClockCommand::RecordNoteIn {
            lane_id: arm.lane_id,
            note,
            velocity,
            on,
        });
    }

    /// Meldet eine eingehende Note an den offenen Piano-Roll-Editor, FALLS
    /// dort gerade `noteInput.listen` armiert ist — und spielt sie zugleich
    /// auf dem Ziel des Bausteins mit, damit man hört, was man spielt.
    ///
    /// Bewusst OHNE Kanalfilter: das angeschlossene Keyboard ist hier keine
    /// gelernte Zuordnung, sondern schlicht „das Ding, auf dem gespielt wird".
    /// Wer beim Einspielen den Kanal seines Keyboards suchen muss, hat schon
    /// verloren.
    ///
    /// Eingetragen wird die Note NICHT hier: an welchem Step sie landet, weiß
    /// nur der Editor (sein Schreib-Cursor), und die Bildschirm-Klaviatur
    /// nimmt denselben Weg — so gibt es für beide Quellen genau einen Pfad.
    pub fn forward_note_input(&self, msg: &[u8]) {
        if msg.len() < 3 {
            return;
        }
        let status = msg[0] & 0xF0;
        if status != 0x90 && status != 0x80 {
            return;
        }
        let (note, velocity) = (msg[1], msg[2]);
        // Note-On mit Velocity 0 ist die verbreitete Schreibweise fürs Note-Off.
        let on = status == 0x90 && velocity > 0;

        let mut guard = self.note_input.lock().unwrap();
        let Some(arm) = guard.as_mut() else { return };
        let block_id = arm.block_id.clone();
        if let Some((port, ch)) = arm.echo.clone() {
            // Nur wirklich neue bzw. wirklich gehaltene Töne durchlassen: ein
            // Keyboard mit Aftertouch/Retrigger schickt sonst Note-Ons auf
            // einen schon klingenden Ton, und beim Entwaffnen fehlte für den
            // zweiten das Off.
            let changed = if on { arm.held.insert(note) } else { arm.held.remove(&note) };
            if changed {
                let bytes = if on {
                    vec![0x90 | (ch - 1), note, velocity.max(1)]
                } else {
                    vec![0x80 | (ch - 1), note, 0]
                };
                self.clock.send(ClockCommand::Midi(port, bytes));
            }
        }
        drop(guard);

        let _ = self.events.send(serde_json::json!({
            "t": "noteInput.note",
            "blockId": block_id,
            "note": note,
            "velocity": velocity,
            "on": on,
        }));
    }
}

/// Ob das Mapping eines Live-Controls zu Kanal/Art/Nummer einer eingehenden
/// MIDI-Nachricht passt. Fehlt `number` im Mapping (nur bei "keyboard"-
/// Controls, siehe `control.setKind`), matcht JEDE Nummer auf dem Kanal —
/// so muss man nicht jede einzelne Taste eines Keyboards einzeln lernen.
fn mapping_matches(control: &serde_json::Value, channel: u8, kind: &str, number: u8) -> bool {
    let Some(m) = control.get("mapping") else {
        return false;
    };
    if m.get("channel").and_then(|v| v.as_u64()) != Some(channel as u64) {
        return false;
    }
    if m.get("kind").and_then(|v| v.as_str()) != Some(kind) {
        return false;
    }
    match m.get("number").and_then(|v| v.as_u64()) {
        Some(n) => n == number as u64,
        None => true,
    }
}

fn find_control_by_mapping(proj: &Project, channel: u8, kind: &str, number: u8) -> Option<serde_json::Value> {
    proj.controls
        .as_array()?
        .iter()
        .find(|c| mapping_matches(c, channel, kind, number))
        .cloned()
}

/// Findet das "keyboard"-Control (falls eines gelernt wurde) für den ganzen
/// physischen Eingang auf `channel` — Auffang-Ziel fürs MIDI-Thru bei
/// Nachrichten, die kein eigenes Control-Mapping haben (Pitch-Bend,
/// Aftertouch, nicht gelernte CCs wie Mod-Wheel/Sustain-Pedal).
fn find_keyboard_control(proj: &Project, channel: u8) -> Option<serde_json::Value> {
    proj.controls.as_array()?.iter().find(|c| {
        c.get("kind").and_then(|v| v.as_str()) == Some("keyboard")
            && c.get("mapping")
                .and_then(|m| m.get("channel"))
                .and_then(|v| v.as_u64())
                == Some(channel as u64)
    }).cloned()
}

/// Ziel-Port fürs MIDI-Thru eines Controls: dessen zugewiesenes Device, sonst
/// der virtuelle Ausgang (leerer Portname) — dieselbe Default-Regel wie beim
/// Touch-Auslösen eines Controls (`control_port` in ws.rs).
fn thru_port(proj: &Project, ctrl: serde_json::Value, source_port: &str) -> Option<String> {
    let target = match ctrl.get("deviceId").and_then(|v| v.as_str()) {
        Some(did) => proj.devices.iter().find(|d| d.id == did).map(|d| d.midi_out_port.clone())?,
        None => String::new(),
    };
    // Nie auf den Port zurücksenden, von dem die Nachricht kam: ein Gerät an
    // einem bidirektionalen Port (oder mit eigenem Soft-Thru) bekäme seine
    // eigene CC-Automation zurückgespielt → Endlosschleife.
    if !target.is_empty() && crate::midi::same_port(&target, source_port) {
        return None;
    }
    Some(target)
}

/// Setzt `value` auf dem passenden Control und liefert dessen ID zurück.
fn set_control_value_by_mapping(
    proj: &mut Project,
    channel: u8,
    kind: &str,
    number: u8,
    value: u8,
) -> Option<String> {
    let c = proj
        .controls
        .as_array_mut()?
        .iter_mut()
        .find(|c| mapping_matches(c, channel, kind, number))?;
    c["value"] = serde_json::json!(value);
    c.get("id")?.as_str().map(str::to_string)
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

/// Schreibt ein Projekt nach `<data_dir>/projects/<id>.json`. Freie Funktion
/// (statt nur `AppState::save_project`), weil der Clock-Thread (Live-Aufnahme
/// vom Keyboard, siehe `clock.rs`) nur einzelne `Arc`-Felder hält, kein
/// komplettes `AppState`.
pub fn save_project_to(data_dir: &std::path::Path, proj: &Project) -> std::io::Result<()> {
    let path = data_dir.join("projects").join(format!("{}.json", proj.id));
    let json = serde_json::to_string_pretty(proj)?;
    std::fs::write(path, json)
}

/// Kurzinfos zu allen gespeicherten Projekten, neuestes zuerst — Grundlage
/// der Projektliste im Einstellungs-Dialog. Als Zeitstempel dient die
/// Änderungszeit der DATEI (Unix-Sekunden), nicht `updatedAt` im Projekt:
/// die Datei-Zeit ist auch bei Altprojekten verlässlich und ist derselbe
/// Schlüssel, nach dem `load_most_recent_project_from` beim Start wählt.
/// Unlesbare/fremde JSON-Dateien werden still übersprungen statt die ganze
/// Liste scheitern zu lassen.
pub fn list_projects_in(data_dir: &std::path::Path) -> Vec<serde_json::Value> {
    let Ok(entries) = std::fs::read_dir(data_dir.join("projects")) else {
        return Vec::new();
    };
    let mut found: Vec<(u64, serde_json::Value)> = entries
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().and_then(|x| x.to_str()) == Some("json"))
        .filter_map(|e| {
            let raw = std::fs::read_to_string(e.path()).ok()?;
            let proj: serde_json::Value = serde_json::from_str(&raw).ok()?;
            let id = proj.get("id")?.as_str()?.to_string();
            let name = proj.get("name").and_then(|v| v.as_str()).unwrap_or("Unbenannt");
            let devices = proj
                .get("devices")
                .and_then(|v| v.as_array())
                .map_or(0, |a| a.len());
            let updated = e
                .metadata()
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map_or(0, |d| d.as_secs());
            Some((
                updated,
                serde_json::json!({
                    "id": id,
                    "name": name,
                    "updatedAt": updated,
                    "deviceCount": devices,
                }),
            ))
        })
        .collect();
    found.sort_by(|a, b| b.0.cmp(&a.0));
    found.into_iter().map(|(_, v)| v).collect()
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
    let mut proj: Project = serde_json::from_str(&data).ok()?;
    migrate_project(&mut proj);
    Some(proj)
}

/// Zieht Altprojekte auf das aktuelle Modell nach: Bausteine sind reiner Inhalt,
/// das MIDI-Ziel (Kanal bzw. Ziel-Knob) hängt an der Lane.
///
/// Früher trug jeder CC-Baustein sein eigenes `sourceControlId` (und Reste einer
/// noch älteren manuellen `ccNumber`/`channel`-Eingabe). Dadurch war ein
/// Baustein an genau ein Ziel gefesselt und konnte nicht auf einem zweiten CC
/// wiederverwendet werden. Hier wandert das Ziel einmalig auf die Lane; die
/// toten Felder werden aus den Bausteinen entfernt.
///
/// `resolutionPerBar`/`slewMs`/`curve` fallen ersatzlos weg — sie waren nie
/// implementiert (die Senderate deckelt `MIN_CC_SEND_INTERVAL` in engine.rs).
pub fn migrate_project(proj: &mut Project) {
    let controls = proj.controls.clone();

    // ── Pass 1: Baustein-Bibliothek von Device- auf Projektebene heben ──
    // Altprojekte tragen `device.blocks`; heute lebt die Bibliothek in
    // `project.blocks`. Lane-Slots referenzieren Bausteine per uuid, nicht per
    // Rasterzelle — bei Zell-Kollision (zwei Geräte hatten je „1-1") wird die
    // Zelle (type,row,col) neu gepackt, die ID bleibt, alle Referenzen halten.
    let already_hoisted = proj
        .blocks
        .as_array()
        .map(|a| !a.is_empty())
        .unwrap_or(false);
    if !already_hoisted {
        let mut lib: Vec<serde_json::Value> = Vec::new();
        let mut taken: std::collections::HashSet<(String, i64, i64)> =
            std::collections::HashSet::new();
        for dev in proj.devices.iter_mut() {
            let Some(arr) = dev.legacy_blocks.as_array() else {
                continue;
            };
            for b in arr {
                let mut b = b.clone();
                let ty = b
                    .get("type")
                    .and_then(|v| v.as_str())
                    .unwrap_or("melody")
                    .to_string();
                let (mut row, mut col) = b
                    .get("slot")
                    .map(|s| {
                        (
                            s.get("row").and_then(|v| v.as_i64()).unwrap_or(1),
                            s.get("col").and_then(|v| v.as_i64()).unwrap_or(1),
                        )
                    })
                    .unwrap_or((1, 1));
                if taken.contains(&(ty.clone(), row, col)) {
                    'find: for r in 1..=9 {
                        for c in 1..=9 {
                            if !taken.contains(&(ty.clone(), r, c)) {
                                row = r;
                                col = c;
                                break 'find;
                            }
                        }
                    }
                }
                taken.insert((ty.clone(), row, col));
                b["slot"] = serde_json::json!({ "type": ty, "row": row, "col": col });
                lib.push(b);
            }
        }
        if !lib.is_empty() {
            proj.blocks = serde_json::Value::Array(lib);
        }
    }
    if !proj.blocks.is_array() {
        proj.blocks = serde_json::json!([]);
    }

    for dev in proj.devices.iter_mut() {
        let dev_id = dev.id.clone();
        // Früher lag der Default-Kanal am Device; heute trägt ihn jede Lane.
        let legacy_dev_channel = dev.legacy_channel;
        let blocks = dev.legacy_blocks.clone();
        let block_field = |block_id: &str, field: &str| -> Option<serde_json::Value> {
            blocks
                .as_array()?
                .iter()
                .find(|b| b.get("id").and_then(|v| v.as_str()) == Some(block_id))?
                .get(field)
                .cloned()
                .filter(|v| !v.is_null())
        };

        for lane in dev.lanes.iter_mut() {
            let slot_block_ids: Vec<String> = lane
                .slots
                .as_array()
                .map(|arr| {
                    arr.iter()
                        .filter_map(|s| s.get("blockId")?.as_str().map(str::to_string))
                        .collect()
                })
                .unwrap_or_default();

            if lane.cc_control_id.is_none() {
                lane.cc_control_id = slot_block_ids
                    .iter()
                    .find_map(|bid| block_field(bid, "sourceControlId"))
                    .and_then(|v| v.as_str().map(str::to_string))
                    // Nur übernehmen, wenn der Knob wirklich an DIESEM Gerät
                    // hängt — sonst war das Ziel ohnehin nie „verbunden".
                    .filter(|cid| knob_belongs_to(&controls, cid, &dev_id));
            }

            // Sentinel `0` = Altprojekt-Lane ohne eigenen Kanal: einmalig aus
            // dem alten Baustein-Feld bzw. dem alten Device-Kanal füllen (sonst 1).
            if lane.channel == 0 {
                let from_block = slot_block_ids
                    .iter()
                    .find_map(|bid| block_field(bid, "channel"))
                    .and_then(|v| v.as_u64())
                    .map(|c| c as u8);
                lane.channel = from_block.or(legacy_dev_channel).unwrap_or(1).clamp(1, 16);
            }

            // Macro-Knobs zeigten früher auf eine freie CC-Nummer; jetzt auf
            // einen gelernten Knob. Ohne passenden Knob gibt es kein Ziel mehr —
            // das Control fliegt raus statt stumm liegen zu bleiben.
            if let Some(arr) = lane.controls.as_array_mut() {
                arr.retain_mut(|c| {
                    if c.get("kind").and_then(|v| v.as_str()) != Some("macroKnob") {
                        return true;
                    }
                    if c.get("controlId").and_then(|v| v.as_str()).is_some() {
                        return true;
                    }
                    let Some(cc) = c.get("ccNumber").and_then(|v| v.as_u64()) else {
                        return false;
                    };
                    let Some(id) = knob_with_cc(&controls, &dev_id, cc as u8) else {
                        return false;
                    };
                    if let Some(obj) = c.as_object_mut() {
                        obj.insert("controlId".into(), serde_json::json!(id));
                        obj.remove("ccNumber");
                        obj.remove("min");
                        obj.remove("max");
                        obj.remove("value");
                    }
                    true
                });
            }
        }

    }

    // Tote Baustein-Felder aus der (jetzt projektweiten) Bibliothek entfernen.
    if let Some(arr) = proj.blocks.as_array_mut() {
        for b in arr.iter_mut() {
            let Some(obj) = b.as_object_mut() else { continue };
            for dead in [
                "sourceControlId",
                "channel",
                "ccNumber",
                "resolutionPerBar",
                "slewMs",
                "curve",
            ] {
                obj.remove(dead);
            }
        }
    }
}

/// Ob `control_id` ein gelernter Knob des Geräts `device_id` ist.
fn knob_belongs_to(controls: &serde_json::Value, control_id: &str, device_id: &str) -> bool {
    controls
        .as_array()
        .and_then(|arr| {
            arr.iter()
                .find(|c| c.get("id").and_then(|v| v.as_str()) == Some(control_id))
        })
        .is_some_and(|c| {
            c.get("kind").and_then(|v| v.as_str()) == Some("knob")
                && c.get("deviceId").and_then(|v| v.as_str()) == Some(device_id)
        })
}

/// Erster gelernter Knob dieses Geräts, dessen CC-Mapping auf `cc` zeigt.
fn knob_with_cc(controls: &serde_json::Value, device_id: &str, cc: u8) -> Option<String> {
    controls
        .as_array()?
        .iter()
        .find(|c| {
            c.get("deviceId").and_then(|v| v.as_str()) == Some(device_id)
                && c.get("mapping").and_then(|m| m.get("kind")).and_then(|v| v.as_str()) == Some("cc")
                && c.get("mapping").and_then(|m| m.get("number")).and_then(|v| v.as_u64())
                    == Some(cc as u64)
        })?
        .get("id")?
        .as_str()
        .map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Device, Lane};

    fn project_with_legacy_cc_block() -> Project {
        let mut proj = Project::new("t");
        let mut dev = Device::new("D MINI".into(), "D MINI".into());
        dev.id = "dev-1".into();
        dev.legacy_channel = Some(9);
        dev.legacy_blocks = serde_json::json!([{
            "id": "blk-1",
            "type": "cc",
            "name": "CC",
            // Altlasten: Ziel + Kanal am Baustein, dazu nie implementierte Felder.
            "sourceControlId": "knob-1",
            "channel": 2,
            "ccNumber": 74,
            "resolutionPerBar": 16,
            "slewMs": 0,
            "curve": "linear",
            "layers": [],
        }]);
        let mut lane = Lane::new("cc", "Lane 1".into());
        lane.id = "lane-1".into();
        lane.channel = 0; // Altprojekt-Lane ohne eigenen Kanal
        lane.slots = serde_json::json!([{ "id": "s1", "blockId": "blk-1" }]);
        lane.controls = serde_json::json!([
            { "id": "lc-1", "kind": "macroKnob", "label": "CC44", "order": 0, "ccNumber": 44, "min": 0, "max": 127, "value": 3 },
            { "id": "lc-2", "kind": "macroKnob", "label": "CC99", "order": 1, "ccNumber": 99, "min": 0, "max": 127, "value": 0 },
        ]);
        dev.lanes.push(lane);
        proj.devices.push(dev);
        proj.controls = serde_json::json!([
            { "id": "knob-1", "kind": "knob", "deviceId": "dev-1", "name": "f",
              "mapping": { "kind": "cc", "channel": 1, "number": 44 } },
        ]);
        proj
    }

    #[test]
    fn migration_moves_cc_target_and_channel_from_block_to_lane() {
        let mut proj = project_with_legacy_cc_block();
        migrate_project(&mut proj);

        let lane = &proj.devices[0].lanes[0];
        assert_eq!(lane.cc_control_id.as_deref(), Some("knob-1"));
        assert_eq!(lane.channel, 2);

        let block = &proj.blocks[0];
        for dead in ["sourceControlId", "channel", "ccNumber", "resolutionPerBar", "slewMs", "curve"] {
            assert!(block.get(dead).is_none(), "{dead} should be stripped from the block");
        }
    }

    #[test]
    fn migration_drops_a_cc_target_pointing_at_another_device() {
        let mut proj = project_with_legacy_cc_block();
        // Knob hängt jetzt an einem anderen Gerät — es war nie ein „verbundenes" Ziel.
        proj.controls[0]["deviceId"] = serde_json::json!("dev-other");
        migrate_project(&mut proj);
        assert_eq!(proj.devices[0].lanes[0].cc_control_id, None);
    }

    #[test]
    fn migration_relinks_macro_knobs_and_drops_unmatched_ones() {
        let mut proj = project_with_legacy_cc_block();
        migrate_project(&mut proj);

        let controls = proj.devices[0].lanes[0].controls.as_array().unwrap();
        // CC44 findet den gelernten Knob, CC99 nicht → fliegt raus.
        assert_eq!(controls.len(), 1);
        assert_eq!(controls[0]["controlId"], serde_json::json!("knob-1"));
        assert!(controls[0].get("ccNumber").is_none());
    }

    #[test]
    fn migration_hoists_device_blocks_to_project_and_repacks_grid_collisions() {
        let mut proj = Project::new("t");
        let mut a = Device::new("A".into(), "A".into());
        a.legacy_blocks = serde_json::json!([
            { "id": "b1", "type": "melody", "name": "m1", "slot": { "type": "melody", "row": 1, "col": 1 } },
        ]);
        let mut lane_a = Lane::new("melody", "L".into());
        lane_a.slots = serde_json::json!([{ "id": "s1", "blockId": "b1" }]);
        a.lanes.push(lane_a);

        let mut b = Device::new("B".into(), "B".into());
        b.legacy_blocks = serde_json::json!([
            // Kollidiert mit A's 1-1 → muss auf 1-2 rutschen.
            { "id": "b2", "type": "melody", "name": "m2", "slot": { "type": "melody", "row": 1, "col": 1 } },
        ]);
        let mut lane_b = Lane::new("melody", "L".into());
        lane_b.slots = serde_json::json!([{ "id": "s2", "blockId": "b2" }]);
        b.lanes.push(lane_b);

        proj.devices.push(a);
        proj.devices.push(b);
        migrate_project(&mut proj);

        let lib = proj.blocks.as_array().expect("project.blocks is an array");
        assert_eq!(lib.len(), 2, "both device blocks hoisted");
        let b1 = lib.iter().find(|x| x["id"] == serde_json::json!("b1")).unwrap();
        let b2 = lib.iter().find(|x| x["id"] == serde_json::json!("b2")).unwrap();
        assert_eq!(b1["slot"]["col"], serde_json::json!(1));
        assert_eq!(b2["slot"]["col"], serde_json::json!(2), "collision repacked");
        // Slot-Referenzen halten (per uuid, nicht per Zelle).
        assert_eq!(proj.devices[0].lanes[0].slots[0]["blockId"], serde_json::json!("b1"));
        assert_eq!(proj.devices[1].lanes[0].slots[0]["blockId"], serde_json::json!("b2"));

        // Idempotent: erneutes Migrieren ändert die Bibliothek nicht.
        migrate_project(&mut proj);
        assert_eq!(proj.blocks.as_array().unwrap().len(), 2);
    }
}
