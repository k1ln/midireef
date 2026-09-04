//! Ringpuffer der letzten Log-Zeilen — Grundlage der Log-Ansicht in den
//! Einstellungen (UI kann sie per `server.log` abrufen). Als `MakeWriter` vor
//! `tracing_subscriber::fmt` gehängt: jede Zeile geht weiter nach stdout (→
//! journald auf dem Pi) UND in einen 1000-Zeilen-Puffer im Speicher.

use std::collections::VecDeque;
use std::io::{self, Write};
use std::sync::{Mutex, OnceLock};

const CAP: usize = 1000;

static BUF: OnceLock<Mutex<VecDeque<String>>> = OnceLock::new();

fn buf() -> &'static Mutex<VecDeque<String>> {
    BUF.get_or_init(|| Mutex::new(VecDeque::with_capacity(CAP)))
}

/// Auch nach einem Panic (der den Mutex vergiftet) weiter beschreibbar — der
/// Log-Puffer ist gerade DANN am wichtigsten.
fn lock() -> std::sync::MutexGuard<'static, VecDeque<String>> {
    buf().lock().unwrap_or_else(|e| e.into_inner())
}

/// Die gepufferten Zeilen (älteste zuerst).
pub fn recent() -> Vec<String> {
    lock().iter().cloned().collect()
}

/// Eine Zeile direkt in den Ringpuffer schreiben — nicht über `tracing`. Für
/// den Panic-Hook, dessen Ausgabe sonst nur nach stderr/journald ginge und in
/// der Log-Ansicht der Einstellungen nie auftauchte.
pub fn record(text: &str) {
    push_lines(text);
}

fn push_lines(text: &str) {
    let mut b = lock();
    for line in text.split('\n') {
        if line.is_empty() {
            continue;
        }
        if b.len() >= CAP {
            b.pop_front();
        }
        b.push_back(line.to_string());
    }
}

pub struct TeeMakeWriter;

/// Sammelt die Bytes EINES Log-Events und schiebt sie beim Drop (Event fertig)
/// zeilenweise in den Ringpuffer. `tracing_subscriber::fmt` erzeugt pro Event
/// genau einen Writer und lässt ihn danach fallen.
pub struct TeeWriter(Vec<u8>);

impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for TeeMakeWriter {
    type Writer = TeeWriter;
    fn make_writer(&'a self) -> Self::Writer {
        TeeWriter(Vec::new())
    }
}

impl Write for TeeWriter {
    fn write(&mut self, data: &[u8]) -> io::Result<usize> {
        let _ = io::stdout().write_all(data);
        self.0.extend_from_slice(data);
        Ok(data.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        io::stdout().flush()
    }
}

impl Drop for TeeWriter {
    fn drop(&mut self) {
        if !self.0.is_empty() {
            push_lines(&String::from_utf8_lossy(&self.0));
        }
    }
}
