//! MIDI-I/O über midir: Port-Enumeration und ein Output-Manager, der einen
//! virtuellen Port ("MidiDrift Out") sowie Ports pro Device verwaltet.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};

use midir::{MidiInput, MidiInputConnection, MidiOutput, MidiOutputConnection};

/// Ob jede einzelne IN/OUT-MIDI-Nachricht geloggt wird — standardmäßig aus,
/// da das bei aktiver Clock/Performance sehr viel Log-Rauschen erzeugt.
/// Aktiviert über `--debug` oder `MIDIDRIFT_DEBUG=1` (siehe main.rs).
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
    let outputs = MidiOutput::new("mididrift-scan")
        .map(|o| {
            o.ports()
                .iter()
                .filter_map(|p| o.port_name(p).ok())
                .collect()
        })
        .unwrap_or_default();

    let inputs = MidiInput::new("mididrift-scan")
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
    named: HashMap<String, MidiOutputConnection>,
}

impl MidiOutManager {
    pub fn new() -> Self {
        // Virtueller Ausgang, an den sich Synths/DAWs hängen können (CoreMIDI/ALSA).
        let virt = MidiOutput::new("MidiDrift")
            .ok()
            .and_then(|o| create_virtual(o, "MidiDrift Out"));
        if virt.is_some() {
            tracing::info!("Virtueller MIDI-Ausgang „MidiDrift Out“ erstellt");
        }
        Self {
            virt,
            named: HashMap::new(),
        }
    }

    /// Liefert die Verbindung für einen Portnamen (öffnet reale Ports bei Bedarf).
    fn conn_for(&mut self, port: &str) -> Option<&mut MidiOutputConnection> {
        if port.is_empty() {
            return self.virt.as_mut();
        }
        if !self.named.contains_key(port) {
            if let Some(conn) = open_matching(port) {
                self.named.insert(port.to_string(), conn);
            }
        }
        self.named.get_mut(port)
    }

    /// Sendet MIDI-Bytes; liefert `false`, wenn kein Ausgang (virtuell oder
    /// namentlich passend) erreichbar war — der Aufrufer kann das der UI melden.
    pub fn send(&mut self, port: &str, bytes: &[u8]) -> bool {
        let target = if port.is_empty() { "MidiDrift Out (virtuell)" } else { port };
        if let Some(c) = self.conn_for(port) {
            let ok = c.send(bytes).is_ok();
            if ok {
                if midi_log_enabled() {
                    tracing::info!("{}", tag_out(&format!(" {ANSI_DIM}→{ANSI_RESET} {target:<28} {}", describe(bytes))));
                }
            } else {
                // Fehlschläge immer loggen, unabhängig vom Debug-Flag.
                tracing::warn!(
                    "{}",
                    tag_out(&format!(" {ANSI_DIM}→{ANSI_RESET} {target}: Senden fehlgeschlagen ({})", describe(bytes)))
                );
            }
            ok
        } else {
            tracing::warn!(
                "{}",
                tag_out(&format!(
                    " {ANSI_DIM}→{ANSI_RESET} „{port}“ nicht gefunden — verworfen: {}",
                    describe(bytes)
                ))
            );
            false
        }
    }

    /// Clock/Transport-Bytes an alle offenen Ausgänge (virtuell + real).
    pub fn broadcast(&mut self, bytes: &[u8]) {
        if let Some(v) = self.virt.as_mut() {
            let _ = v.send(bytes);
        }
        for c in self.named.values_mut() {
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

fn open_matching(needle: &str) -> Option<MidiOutputConnection> {
    let out = MidiOutput::new("mididrift-out").ok()?;
    let ports = out.ports();
    let p = ports
        .iter()
        .find(|p| out.port_name(p).map(|n| n.contains(needle)).unwrap_or(false))?;
    out.connect(p, "mididrift-out").ok()
}

/// Öffnet alle MIDI-Eingänge und leitet eingehende Nachrichten (mit Portnamen der
/// Quelle, damit ein gelerntes Control automatisch dem passenden Gerät zugeordnet
/// werden kann) über `tx` weiter.
pub fn open_all_inputs(
    tx: std::sync::mpsc::Sender<(String, Vec<u8>)>,
) -> Vec<MidiInputConnection<()>> {
    let mut conns = Vec::new();
    let Ok(scan) = MidiInput::new("mididrift-in-scan") else {
        return conns;
    };
    for p in scan.ports() {
        let Ok(input) = MidiInput::new("mididrift-in") else {
            continue;
        };
        let Ok(port_name) = input.port_name(&p) else {
            continue;
        };
        let txc = tx.clone();
        let log_name = port_name.clone();
        if let Ok(conn) = input.connect(
            &p,
            "mididrift-in",
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
            conns.push(conn);
        }
    }
    conns
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
/// (z.B. „Note-On ch11 note51 vel100" oder „CC ch11 cc121=127").
fn describe(bytes: &[u8]) -> String {
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
