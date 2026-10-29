//! MIDI-Dateien als Notenquelle: Bibliothek durchsuchen, Datei parsen, einen
//! Ausschnitt (Beats + Spuren) in einen Melodie-Baustein übersetzen.
//!
//! Die UI bleibt dumm: sie bekommt die Noten einer Datei als einfache
//! Beat-Zahlen zum Zeichnen und schickt nur "dieser Ausschnitt" zurück — die
//! Umrechnung in Steps passiert hier (`select_notes`).
//!
//! Gesucht wird in zwei Wurzeln: der mitgelieferten `midi-library/` (neben dem
//! Datenverzeichnis, per `MIDIREEF_MIDI_LIBRARY` überschreibbar) und
//! `<data_dir>/midi/` für selbst abgelegte Dateien.

use std::collections::{HashMap, HashSet};
use std::path::{Component, Path, PathBuf};

use midly::{MetaMessage, MidiMessage, Smf, Timing, TrackEventKind};
use serde_json::{json, Value};

/// Obergrenze Noten je Baustein — ein ganzes Klavierstück als Baustein wäre
/// für Engine und Snapshot-Broadcasts unnötig schwer.
const MAX_NOTES: usize = 4096;
/// Steps pro Viertelnote im erzeugten Baustein (16 Steps pro 4/4-Takt).
const STEPS_PER_BEAT: f64 = 4.0;
const MAX_LENGTH_BARS: u32 = 16;

pub fn library_roots(data_dir: &Path) -> Vec<PathBuf> {
    let lib = std::env::var("MIDIREEF_MIDI_LIBRARY")
        .map(PathBuf::from)
        .unwrap_or_else(|_| data_dir.join("..").join("midi-library"));
    vec![lib, data_dir.join("midi")]
}

/// Metadaten aus `manifest.json` der Bibliothek, je relativem Dateipfad
/// (Titel, Komponist, Stil, Lizenz — Futter für die Suche in der UI).
fn load_manifest(root: &Path) -> HashMap<String, Value> {
    let Ok(text) = std::fs::read_to_string(root.join("manifest.json")) else { return HashMap::new() };
    let Ok(Value::Array(entries)) = serde_json::from_str::<Value>(&text) else { return HashMap::new() };
    entries
        .into_iter()
        .filter_map(|e| Some((e.get("file")?.as_str()?.to_string(), e)))
        .collect()
}

/// Alle `.mid`-Dateien beider Wurzeln, als relative Pfade ("drums/x.mid").
/// `folder` ist der oberste Ordner; `composer`/`style`/`license` stammen aus
/// dem Manifest und fehlen bei selbst abgelegten Dateien.
pub fn list(data_dir: &Path) -> Vec<Value> {
    let mut found: Vec<(String, u64)> = Vec::new();
    let mut meta: HashMap<String, Value> = HashMap::new();
    for root in library_roots(data_dir) {
        scan(&root, &root, &mut found);
        meta.extend(load_manifest(&root));
    }
    found.sort_by(|a, b| a.0.to_lowercase().cmp(&b.0.to_lowercase()));
    found.dedup_by(|a, b| a.0 == b.0);
    found
        .into_iter()
        .map(|(rel, bytes)| {
            let folder = rel.split('/').next().filter(|_| rel.contains('/')).unwrap_or("");
            let file = rel.rsplit('/').next().unwrap_or(&rel);
            let fallback = file.rsplit_once('.').map_or(file, |(n, _)| n).replace('-', " ");
            let m = meta.get(&rel);
            let text = |k: &str| m.and_then(|m| m.get(k)).and_then(|v| v.as_str()).unwrap_or("");
            let name = if text("title").is_empty() { fallback.as_str() } else { text("title") };
            json!({
                "id": rel,
                "name": name,
                "folder": folder,
                "composer": text("composer"),
                "style": text("style"),
                "license": text("license"),
                "bytes": bytes,
            })
        })
        .collect()
}

fn scan(root: &Path, dir: &Path, out: &mut Vec<(String, u64)>) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let p = e.path();
        let Ok(meta) = e.metadata() else { continue };
        if meta.is_dir() {
            scan(root, &p, out);
            continue;
        }
        let is_midi = p
            .extension()
            .and_then(|x| x.to_str())
            .is_some_and(|x| matches!(x.to_ascii_lowercase().as_str(), "mid" | "midi" | "kar"));
        if let (true, Ok(rel)) = (is_midi, p.strip_prefix(root)) {
            out.push((rel.to_string_lossy().replace('\\', "/"), meta.len()));
        }
    }
}

/// Löst eine Datei-ID auf einen Pfad auf — nur relative Pfade ohne `..`, damit
/// über das WebSocket keine beliebigen Dateien lesbar werden.
fn resolve(data_dir: &Path, id: &str) -> Result<PathBuf, String> {
    let rel = Path::new(id);
    if rel.components().any(|c| !matches!(c, Component::Normal(_))) {
        return Err("Invalid file name.".into());
    }
    library_roots(data_dir)
        .into_iter()
        .map(|r| r.join(rel))
        .find(|p| p.is_file())
        .ok_or_else(|| "MIDI file not found.".to_string())
}

pub struct MidiNote {
    /// Beginn und Dauer in Viertelnoten ab Dateianfang.
    pub start: f64,
    pub len: f64,
    pub note: u8,
    pub vel: u8,
}

pub struct MidiTrack {
    pub index: usize,
    pub name: String,
    pub channel: Option<u8>,
    pub notes: Vec<MidiNote>,
}

pub struct ParsedMidi {
    pub bpm: f64,
    /// Taktart der Datei (Zähler, Nenner) und daraus die Länge eines Takts in Viertelnoten.
    pub time_sig: (u32, u32),
    pub beats_per_bar: f64,
    pub total_beats: f64,
    pub tracks: Vec<MidiTrack>,
}

pub fn parse_bytes(bytes: &[u8]) -> Result<ParsedMidi, String> {
    let smf = Smf::parse(bytes).map_err(|e| format!("Not a readable MIDI file: {e}"))?;
    let ppq = match smf.header.timing {
        Timing::Metrical(t) => f64::from(t.as_int()).max(1.0),
        Timing::Timecode(..) => return Err("SMPTE-timed MIDI files aren't supported.".into()),
    };
    let mut bpm: Option<f64> = None;
    let mut time_sig: Option<(u32, u32)> = None;
    let mut tracks = Vec::new();
    let mut total_beats = 0.0f64;

    for (index, track) in smf.tracks.iter().enumerate() {
        let mut t: u64 = 0;
        let mut name = String::new();
        let mut channel = None;
        // (Kanal, Note) → (Startticks, Anschlag) der gerade klingenden Noten.
        let mut open: HashMap<(u8, u8), (u64, u8)> = HashMap::new();
        let mut notes = Vec::new();
        let close = |notes: &mut Vec<MidiNote>, key: (u8, u8), start: u64, vel: u8, end: u64| {
            let len = (end.saturating_sub(start) as f64 / ppq).max(0.02);
            notes.push(MidiNote { start: start as f64 / ppq, len, note: key.1, vel });
        };
        for ev in track {
            t += u64::from(ev.delta.as_int());
            match ev.kind {
                TrackEventKind::Meta(MetaMessage::Tempo(us)) if bpm.is_none() => {
                    let us = f64::from(us.as_int());
                    if us > 0.0 {
                        bpm = Some(60_000_000.0 / us);
                    }
                }
                TrackEventKind::Meta(MetaMessage::TimeSignature(n, d, _, _)) if time_sig.is_none() => {
                    time_sig = Some((u32::from(n).max(1), 1u32 << d.min(6)));
                }
                TrackEventKind::Meta(MetaMessage::TrackName(n)) if name.is_empty() => {
                    name = String::from_utf8_lossy(n).trim().to_string();
                }
                TrackEventKind::Midi { channel: ch, message } => {
                    let ch = ch.as_int();
                    match message {
                        MidiMessage::NoteOn { key, vel } if vel.as_int() > 0 => {
                            let k = (ch, key.as_int());
                            // Doppeltes Note-On ohne Off: die alte Note endet jetzt.
                            if let Some((s, v)) = open.insert(k, (t, vel.as_int())) {
                                close(&mut notes, k, s, v, t);
                            }
                            channel.get_or_insert(ch);
                        }
                        MidiMessage::NoteOn { key, .. } | MidiMessage::NoteOff { key, .. } => {
                            let k = (ch, key.as_int());
                            if let Some((s, v)) = open.remove(&k) {
                                close(&mut notes, k, s, v, t);
                            }
                        }
                        _ => {}
                    }
                }
                _ => {}
            }
        }
        // Noten ohne Note-Off enden am Spurende.
        for (k, (s, v)) in open.drain() {
            close(&mut notes, k, s, v, t);
        }
        notes.sort_by(|a, b| a.start.total_cmp(&b.start).then(a.note.cmp(&b.note)));
        for n in &notes {
            total_beats = total_beats.max(n.start + n.len);
        }
        if !notes.is_empty() {
            tracks.push(MidiTrack { index, name, channel, notes });
        }
    }
    if tracks.is_empty() {
        return Err("This MIDI file contains no notes.".into());
    }
    let time_sig = time_sig.unwrap_or((4, 4));
    Ok(ParsedMidi {
        bpm: bpm.unwrap_or(120.0),
        time_sig,
        beats_per_bar: f64::from(time_sig.0) * 4.0 / f64::from(time_sig.1),
        total_beats,
        tracks,
    })
}

pub fn open(data_dir: &Path, id: &str) -> Result<ParsedMidi, String> {
    let path = resolve(data_dir, id)?;
    let bytes = std::fs::read(&path).map_err(|e| format!("Couldn't read file: {e}"))?;
    parse_bytes(&bytes)
}

fn r3(x: f64) -> f64 {
    (x * 1000.0).round() / 1000.0
}

/// Wire-Format fürs UI: Noten als `[start, len, note, vel]` in Viertelnoten.
pub fn to_event(id: &str, p: &ParsedMidi) -> Value {
    let tracks: Vec<Value> = p
        .tracks
        .iter()
        .map(|t| {
            let notes: Vec<Value> = t.notes.iter().map(|n| json!([r3(n.start), r3(n.len), n.note, n.vel])).collect();
            json!({
                "index": t.index,
                "name": t.name,
                "channel": t.channel,
                "drums": t.channel == Some(9),
                "notes": notes,
            })
        })
        .collect();
    json!({
        "t": "midi.file",
        "file": id,
        "bpm": r3(p.bpm),
        "beatsPerBar": p.beats_per_bar,
        "timeSignature": format!("{}/{}", p.time_sig.0, p.time_sig.1),
        "totalBeats": r3(p.total_beats),
        "tracks": tracks,
    })
}

/// Baustein-Felder für einen Ausschnitt.
pub struct Selection {
    pub notes: Vec<Value>,
    pub length_bars: u32,
    pub steps_per_bar: u32,
    pub time_signature: &'static str,
}

/// Baut aus `[start_beat, end_beat)` der gewählten Spuren die Baustein-Noten.
/// Zeitpunkte bleiben frei: ganzer Step + `microTiming` (0..1), Längen bleiben
/// Bruchteile — nichts wird auf ein Raster gerundet.
pub fn select_notes(p: &ParsedMidi, track_indices: &[usize], start_beat: f64, end_beat: f64) -> Result<Selection, String> {
    if end_beat <= start_beat {
        return Err("Empty selection.".into());
    }
    // Die Taktart der Datei, soweit der Baustein sie kennt — alles andere läuft als 4/4.
    let (time_signature, bar_beats) = match p.time_sig {
        (2, 4) => ("2/4", 2.0),
        (3, 4) => ("3/4", 3.0),
        (5, 4) => ("5/4", 5.0),
        (6, 8) => ("6/8", 3.0),
        (7, 8) => ("7/8", 3.5),
        (9, 8) => ("9/8", 4.5),
        (12, 8) => ("12/8", 6.0),
        _ => ("4/4", 4.0),
    };
    let steps_per_bar = (bar_beats * STEPS_PER_BEAT) as u32;
    let length_bars = (((end_beat - start_beat) / bar_beats).ceil() as u32).clamp(1, MAX_LENGTH_BARS);
    let total_steps = f64::from(length_bars * steps_per_bar);

    let mut notes: Vec<Value> = Vec::new();
    let mut seen = HashSet::new();
    'tracks: for tr in p.tracks.iter().filter(|t| track_indices.contains(&t.index)) {
        for n in &tr.notes {
            if n.start < start_beat - 1e-6 || n.start >= end_beat {
                continue;
            }
            let s = (n.start - start_beat).max(0.0) * STEPS_PER_BEAT;
            if s >= total_steps {
                continue;
            }
            let step = s.floor();
            // Wie bei `melody.addNote`: Versatz nur nach hinten, 0..1 im Step.
            let micro = (s - step).clamp(0.0, 0.999);
            if !seen.insert((step as u64, n.note)) {
                continue;
            }
            let len = (n.len * STEPS_PER_BEAT).min(total_steps - s).max(0.05);
            let mut v = json!({
                "step": step as u64,
                "lengthSteps": crate::ws::length_json(len),
                "note": n.note,
                "velocity": n.vel.clamp(1, 127),
            });
            crate::ws::set_micro_timing(&mut v, micro);
            notes.push(v);
            if notes.len() >= MAX_NOTES {
                break 'tracks;
            }
        }
    }
    if notes.is_empty() {
        return Err("No notes in this selection.".into());
    }
    Ok(Selection { notes, length_bars, steps_per_bar, time_signature })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// ppq 96, eine Spur: C4 auf Beat 0 (1 Beat lang), E4 auf Beat 1.5 (halber Beat).
    fn tiny_smf() -> Vec<u8> {
        let trk: Vec<u8> = vec![
            0x00, 0x90, 60, 100, 0x60, 0x80, 60, 0, // Beat 0 → 1
            0x30, 0x90, 64, 80, 0x30, 0x80, 64, 0, // Beat 1.5 → 2
            0x00, 0xFF, 0x2F, 0x00,
        ];
        let mut f = b"MThd".to_vec();
        f.extend([0, 0, 0, 6, 0, 0, 0, 1, 0, 96]);
        f.extend(b"MTrk");
        f.extend((trk.len() as u32).to_be_bytes());
        f.extend(trk);
        f
    }

    #[test]
    fn parses_and_selects_with_free_timing() {
        let p = parse_bytes(&tiny_smf()).unwrap();
        assert_eq!(p.tracks[0].notes.len(), 2);
        assert!((p.tracks[0].notes[1].start - 1.5).abs() < 1e-9);
        let sel = select_notes(&p, &[0], 0.0, 4.0).unwrap();
        assert_eq!((sel.length_bars, sel.steps_per_bar, sel.time_signature), (1, 16, "4/4"));
        // Beat 1.5 = Step 6.0; Beat 0 = Step 0.
        assert_eq!(sel.notes[1]["step"], 6);
        // Auswahl ab Beat 1: die erste Note fällt raus, E4 liegt auf Step 2.
        let sel = select_notes(&p, &[0], 1.0, 5.0).unwrap();
        assert_eq!(sel.notes.len(), 1);
        assert_eq!(sel.notes[0]["step"], 2);
        // Auswahl ab Beat 1.3: E4 liegt 0.2 Beat = 0.8 Step später → Step 0 + Versatz 0.8.
        let sel = select_notes(&p, &[0], 1.3, 5.3).unwrap();
        assert_eq!(sel.notes[0]["step"], 0);
        assert!((sel.notes[0]["microTiming"].as_f64().unwrap() - 0.8).abs() < 1e-6);
    }
}
