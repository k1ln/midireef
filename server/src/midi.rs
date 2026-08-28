//! MIDI-I/O über midir: Port-Enumeration und ein Output-Manager, der einen
//! virtuellen Port ("MidiReef Out") sowie Ports pro Device verwaltet.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};

use midir::{MidiInput, MidiInputConnection, MidiOutput, MidiOutputConnection};

/// Ob jede einzelne IN/OUT-MIDI-Nachricht geloggt wird — standardmäßig aus,
/// da das bei aktiver Clock/Performance sehr viel Log-Rauschen erzeugt.
/// Aktiviert über `--debug` oder `MIDIREEF_DEBUG=1` (siehe main.rs).
pub static MIDI_LOG: AtomicBool = AtomicBool::new(false);

fn midi_log_enabled() -> bool {
    MIDI_LOG.load(Ordering::Relaxed)
}

pub const MIDI_CLOCK: u8 = 0xF8;
pub const MIDI_START: u8 = 0xFA;
#[allow(dead_code)] // für Continue-Support (Song Position) reserviert
pub const MIDI_CONTINUE: u8 = 0xFB;
pub const MIDI_STOP: u8 = 0xFC;

// ANSI-Farben fürs Terminal-Log — IN (grün) vs. OUT (cyan) auf einen Blick
// unterscheidbar, unabhängig von den level-Farben von tracing_subscriber.
const ANSI_GREEN: &str = "\x1b[1;32m";
const ANSI_CYAN: &str = "\x1b[1;36m";
const ANSI_RESET: &str = "\x1b[0m";
const ANSI_DIM: &str = "\x1b[2m";

fn tag_in(text: &str) -> String {
    format!("{ANSI_GREEN}IN {ANSI_RESET}{text}")
}

fn tag_out(text: &str) -> String {
    format!("{ANSI_CYAN}OUT{ANSI_RESET}{text}")
}

/// Liste der verfügbaren MIDI-Ausgänge/-Eingänge (Portnamen).
pub fn list_ports() -> (Vec<String>, Vec<String>) {
    let outputs = MidiOutput::new("midireef-scan")
        .map(|o| {
            o.ports()
                .iter()
                .filter_map(|p| o.port_name(p).ok())
                .collect()
        })
        .unwrap_or_default();

    let inputs = MidiInput::new("midireef-scan")
        .map(|i| {
            i.ports()
                .iter()
                .filter_map(|p| i.port_name(p).ok())
                .collect()
        })
        .unwrap_or_default();

    (outputs, inputs)
}

/// Verwaltet MIDI-Ausgänge: einen virtuellen Standard-Port plus reale Ports
/// (nach Namens-Substring geöffnet, lazy). Leerer Portname → virtueller Port.
pub struct MidiOutManager {
    virt: Option<MidiOutputConnection>,
    /// Portname (Projekt-Substring) → (System-ID des zuletzt aufgelösten
    /// Ports, Verbindung). Die ID erlaubt, eine nach Systemschlaf verwaiste
    /// Verbindung zu erkennen (s. `revalidate`).
    named: HashMap<String, (String, MidiOutputConnection)>,
    /// Ports, die bereits als unerreichbar gemeldet wurden — verhindert, dass
    /// jeder Clock-Tick/jede Note dieselbe Warnung erneut ausgibt.
    unreachable: HashSet<String>,
    last_revalidate: std::time::Instant,
}

/// Intervall, in dem gecachte Ausgangs-Verbindungen gegen die aktuell vom OS
/// gemeldete Port-ID geprüft werden — s. `MidiOutManager::revalidate`.
const OUT_REVALIDATE_INTERVAL: std::time::Duration = std::time::Duration::from_secs(2);

impl MidiOutManager {
    pub fn new() -> Self {
        // Virtueller Ausgang, an den sich Synths/DAWs hängen können (CoreMIDI/ALSA).
        let virt = MidiOutput::new("MidiReef")
            .ok()
            .and_then(|o| create_virtual(o, "MidiReef Out"));
        if virt.is_some() {
            tracing::info!("Virtueller MIDI-Ausgang „MidiReef Out“ erstellt");
        }
        Self {
            virt,
            named: HashMap::new(),
            unreachable: HashSet::new(),
            last_revalidate: std::time::Instant::now(),
        }
    }

    /// Liefert die Verbindung für einen Portnamen (öffnet reale Ports bei Bedarf).
    fn conn_for(&mut self, port: &str) -> Option<&mut MidiOutputConnection> {
        if port.is_empty() {
            return self.virt.as_mut();
        }
        if !self.named.contains_key(port) {
            if let Some((id, conn)) = open_matching(port) {
                self.named.insert(port.to_string(), (id, conn));
            }
        }
        self.named.get_mut(port).map(|(_, conn)| conn)
    }

    /// Versucht einmal zu senden — über die (ggf. gecachte) Verbindung.
    fn try_send(&mut self, port: &str, bytes: &[u8]) -> bool {
        match self.conn_for(port) {
            Some(c) => c.send(bytes).is_ok(),
            None => false,
        }
    }

    /// Prüft periodisch, ob ein gecachter Port noch dieselbe System-ID hat wie
    /// beim Öffnen. Nach macOS-Systemschlaf (CoreMIDI-Server-Neustart) oder
    /// Unplug/Replug behält ein Gerät oft denselben Namen, bekommt vom OS aber
    /// eine neue interne Referenz — `send()` auf die alte Verbindung schlägt
    /// dabei nicht zuverlässig fehl (CoreMIDI verwirft still), daher reicht der
    /// Fehlschlag-Retry in `send` allein nicht. Weicht die ID ab oder ist der
    /// Port verschwunden, wird die Verbindung verworfen; `conn_for` öffnet sie
    /// beim nächsten Sendeversuch frisch.
    fn revalidate(&mut self) {
        if self.named.is_empty() || self.last_revalidate.elapsed() < OUT_REVALIDATE_INTERVAL {
            return;
        }
        self.last_revalidate = std::time::Instant::now();
        let Ok(out) = MidiOutput::new("midireef-out-check") else { return };
        self.named.retain(|needle, (id, _)| {
            let Some(p) = find_port(&out, needle) else { return false };
            out.port_name(&p).map(|_| p.id() == *id).unwrap_or(false)
        });
    }

    /// Sendet MIDI-Bytes; liefert `false`, wenn kein Ausgang (virtuell oder
    /// namentlich passend) erreichbar war — der Aufrufer kann das der UI melden.
    pub fn send(&mut self, port: &str, bytes: &[u8]) -> bool {
        self.revalidate();
        let target = if port.is_empty() { "MidiReef Out (virtuell)" } else { port };

        let mut ok = self.try_send(port, bytes);

        // Named-Port fehlgeschlagen? Nach Unplug/Replug zeigt eine gecachte
        // Verbindung auf ein totes CoreMIDI-Endpoint (gleicher Name, neue
        // Referenz) — Cache verwerfen und mit frisch aufgelöstem Port genau
        // einmal erneut versuchen, statt der UI „nicht gefunden“ zu melden.
        if !ok && !port.is_empty() {
            self.named.remove(port);
            ok = self.try_send(port, bytes);
        }

        if ok {
            self.unreachable.remove(port);
            if midi_log_enabled() {
                tracing::info!("{}", tag_out(&format!(" {ANSI_DIM}→{ANSI_RESET} {target:<28} {}", describe(bytes))));
            }
        } else if self.unreachable.insert(port.to_string()) {
            // Nur beim ersten Fehlschlag warnen; erneut erst, wenn der Port
            // zwischenzeitlich wieder erreichbar war (s. `unreachable.remove`).
            // Die aktuell sichtbaren Ausgänge mitloggen, da Fehlschläge in der
            // Praxis fast immer ein Namens-Mismatch sind (gespeicherter
            // Projekt-Name vs. tatsächlicher OS-Portname).
            let visible = MidiOutput::new("midireef-out-list")
                .map(|o| o.ports().iter().filter_map(|p| o.port_name(p).ok()).collect::<Vec<_>>())
                .unwrap_or_default();
            tracing::warn!(
                "{}",
                tag_out(&format!(
                    " {ANSI_DIM}→{ANSI_RESET} „{port}“ nicht erreichbar — verworfen (weitere unterdrückt): {}. Sichtbare Ausgänge: {visible:?}",
                    describe(bytes)
                ))
            );
        }
        ok
    }

    /// Clock/Transport-Bytes an alle offenen Ausgänge (virtuell + real).
    pub fn broadcast(&mut self, bytes: &[u8]) {
        self.revalidate();
        if let Some(v) = self.virt.as_mut() {
            let _ = v.send(bytes);
        }
        for (_, c) in self.named.values_mut() {
            let _ = c.send(bytes);
        }
    }

    /// All Notes Off + All Sound Off auf allen Kanälen aller Ausgänge.
    pub fn all_notes_off(&mut self) {
        for ch in 0u8..16 {
            self.broadcast(&[0xB0 | ch, 123, 0]);
            self.broadcast(&[0xB0 | ch, 120, 0]);
        }
    }
}

/// Sucht unter den aktuell sichtbaren Ausgängen von `out` den zu `needle`
/// passenden Port. Zuerst exakter Substring-Match; schlägt der fehl, tolerant
/// vergleichen (Groß/Klein + Leer-/Sonderzeichen ignorieren), da das OS
/// denselben Port oft leicht anders benennt als im Projekt gespeichert
/// ("D mini" vs "Dmini").
fn find_port(out: &MidiOutput, needle: &str) -> Option<midir::MidiOutputPort> {
    let ports = out.ports();
    ports
        .iter()
        .find(|p| out.port_name(p).map(|n| n.contains(needle)).unwrap_or(false))
        .or_else(|| {
            let needle_norm = normalize_port_name(needle);
            ports.iter().find(|p| {
                out.port_name(p)
                    .map(|n| normalize_port_name(&n).contains(&needle_norm))
                    .unwrap_or(false)
            })
        })
        .cloned()
}

fn open_matching(needle: &str) -> Option<(String, MidiOutputConnection)> {
    let out = MidiOutput::new("midireef-out").ok()?;
    let p = find_port(&out, needle)?;
    let id = p.id();
    let conn = out.connect(&p, "midireef-out").ok()?;
    Some((id, conn))
}

/// Normalisiert einen Portnamen für toleranten Vergleich: Kleinbuchstaben,
/// nur alphanumerische Zeichen (Leer-/Sonderzeichen entfernt).
fn normalize_port_name(name: &str) -> String {
    name.chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(|c| c.to_lowercase())
        .collect()
}

/// Verwaltet MIDI-Eingänge: verbindet alle aktuell sichtbaren Ports und erkennt
/// per periodischem [`rescan`](Self::rescan) neu angeschlossene oder getrennte
/// Geräte (Hotplug) — `midir` selbst hat dafür keine Callback-API.
pub struct MidiInManager {
    /// Portname → (System-ID des Ports beim Öffnen, Verbindung). Die ID
    /// erlaubt, eine nach Systemschlaf verwaiste Verbindung zu erkennen —
    /// s. `rescan`.
    conns: HashMap<String, (String, MidiInputConnection<()>)>,
    tx: std::sync::mpsc::Sender<(String, Vec<u8>)>,
}

/// Ergebnis eines [`MidiInManager::rescan`]: neu verbundene bzw. getrennte Ports.
pub struct HotplugDelta {
    pub connected: Vec<String>,
    pub disconnected: Vec<String>,
}

impl HotplugDelta {
    pub fn is_empty(&self) -> bool {
        self.connected.is_empty() && self.disconnected.is_empty()
    }
}

impl MidiInManager {
    /// Öffnet alle aktuell sichtbaren MIDI-Eingänge und leitet eingehende
    /// Nachrichten (mit Portnamen der Quelle, damit ein gelerntes Control
    /// automatisch dem passenden Gerät zugeordnet werden kann) über `tx` weiter.
    pub fn new(tx: std::sync::mpsc::Sender<(String, Vec<u8>)>) -> Self {
        let mut mgr = Self { conns: HashMap::new(), tx };
        mgr.rescan();
        mgr
    }

    pub fn len(&self) -> usize {
        self.conns.len()
    }

    /// Vergleicht die aktuell sichtbaren Ports mit den offenen Verbindungen:
    /// verbindet neu aufgetauchte Ports, trennt verschwundene. Sollte
    /// regelmäßig (z.B. alle paar Sekunden) aufgerufen werden, da `midir`
    /// keine Hotplug-Benachrichtigung bietet.
    ///
    /// Vergleicht dabei auch die System-ID jedes Ports, nicht nur den Namen:
    /// nach macOS-Systemschlaf (CoreMIDI-Server-Neustart) oder Unplug/Replug
    /// behält ein Gerät oft denselben Namen, bekommt vom OS aber eine neue
    /// interne Referenz. Eine gecachte Verbindung auf die alte Referenz
    /// bleibt "offen", liefert aber nie wieder Nachrichten — daher wird eine
    /// solche Verbindung hier als getrennt behandelt und im selben Rescan neu
    /// geöffnet, statt sie anhand des (weiterhin passenden) Namens zu behalten.
    pub fn rescan(&mut self) -> HotplugDelta {
        let Ok(scan) = MidiInput::new("midireef-in-scan") else {
            return HotplugDelta { connected: Vec::new(), disconnected: Vec::new() };
        };
        let ports = scan.ports();
        let current: HashMap<String, String> = ports
            .iter()
            .filter_map(|p| scan.port_name(p).ok().map(|name| (name, p.id())))
            .collect();

        let mut disconnected = Vec::new();
        self.conns.retain(|name, (id, _)| {
            let keep = current.get(name).map(|live_id| live_id == id).unwrap_or(false);
            if !keep {
                disconnected.push(name.clone());
            }
            keep
        });

        let mut connected = Vec::new();
        for p in &ports {
            let Ok(port_name) = scan.port_name(p) else {
                continue;
            };
            if self.conns.contains_key(&port_name) {
                continue;
            }
            let Ok(input) = MidiInput::new("midireef-in") else {
                continue;
            };
            let key_name = port_name.clone();
            let log_name = port_name.clone();
            let port_id = p.id();
            let txc = self.tx.clone();
            if let Ok(conn) = input.connect(
                p,
                "midireef-in",
                move |_ts, msg, _| {
                    // Clock/Active-Sensing sind hochfrequent (bis zu 24×/Beat) und
                    // würden das Log fluten — alles andere wird protokolliert
                    // (nur im Debug-Modus, siehe MIDI_LOG).
                    if midi_log_enabled() && !matches!(msg.first(), Some(0xF8) | Some(0xFE)) {
                        tracing::info!("{}", tag_in(&format!(" {ANSI_DIM}←{ANSI_RESET} {log_name:<28} {}", describe(msg))));
                    }
                    let _ = txc.send((port_name.clone(), msg.to_vec()));
                },
                (),
            ) {
                self.conns.insert(key_name.clone(), (port_id, conn));
                connected.push(key_name);
            }
        }

        HotplugDelta { connected, disconnected }
    }
}

/// Wandelt eine eingehende MIDI-Nachricht in ein Control-Mapping (JSON) um.
pub fn parse_mapping(msg: &[u8]) -> Option<serde_json::Value> {
    if msg.is_empty() {
        return None;
    }
    let channel = (msg[0] & 0x0F) + 1;
    match msg[0] & 0xF0 {
        0x90 if msg.len() >= 3 && msg[2] > 0 => {
            Some(serde_json::json!({ "channel": channel, "kind": "note", "number": msg[1] }))
        }
        0xB0 if msg.len() >= 3 => {
            Some(serde_json::json!({ "channel": channel, "kind": "cc", "number": msg[1] }))
        }
        0xC0 if msg.len() >= 2 => {
            Some(serde_json::json!({ "channel": channel, "kind": "programChange", "number": msg[1] }))
        }
        0xE0 => Some(serde_json::json!({ "channel": channel, "kind": "pitchBend", "number": 0 })),
        _ => None,
    }
}

/// Menschenlesbare Beschreibung roher MIDI-Bytes fürs Server-Log
/// (z.B. „Note-On ch11 note51 vel100" oder „CC ch11 cc121=127"). Ein `send()`
/// kann mehrere zu einem Packet gebündelte Nachrichten enthalten (Akkorde,
/// s. `Engine::fire_step`) — die werden hier einzeln beschrieben und mit
/// „ + “ verbunden, statt nur die erste zu zeigen.
fn describe(bytes: &[u8]) -> String {
    let mut parts = Vec::new();
    let mut rest = bytes;
    while !rest.is_empty() {
        let len = match rest[0] & 0xF0 {
            0xC0 | 0xD0 => 2, // ProgramChange/ChannelAftertouch: Status + 1 Byte
            0xF0 => 1,        // System-Messages (Clock/Start/Stop/...): kein Datenbyte
            _ => 3,
        }
        .min(rest.len());
        parts.push(describe_one(&rest[..len]));
        rest = &rest[len..];
    }
    if parts.is_empty() {
        "(leer)".to_string()
    } else {
        parts.join(" + ")
    }
}

fn describe_one(bytes: &[u8]) -> String {
    let Some(&status) = bytes.first() else {
        return "(leer)".to_string();
    };
    let ch = (status & 0x0F) + 1;
    match (status & 0xF0, bytes.get(1), bytes.get(2)) {
        (0x90, Some(&note), Some(&vel)) if vel > 0 => {
            format!("Note-On  ch{ch} note{note} vel{vel}")
        }
        (0x90, Some(&note), Some(&vel)) => format!("Note-Off ch{ch} note{note} vel{vel} (vel0)"),
        (0x80, Some(&note), Some(&vel)) => format!("Note-Off ch{ch} note{note} vel{vel}"),
        (0xB0, Some(&cc), Some(&val)) => format!("CC       ch{ch} cc{cc}={val}"),
        (0xC0, Some(&prog), _) => format!("ProgramChange ch{ch} prog{prog}"),
        (0xF8, _, _) => "Clock".to_string(),
        (0xFA, _, _) => "Start".to_string(),
        (0xFC, _, _) => "Stop".to_string(),
        _ => format!("{bytes:02X?}"),
    }
}

#[cfg(unix)]
fn create_virtual(out: MidiOutput, name: &str) -> Option<MidiOutputConnection> {
    use midir::os::unix::VirtualOutput;
    out.create_virtual(name).ok()
}

#[cfg(not(unix))]
fn create_virtual(_out: MidiOutput, _name: &str) -> Option<MidiOutputConnection> {
    None
}
