//! Melodie-Generator für den Behringer TD-3 (MO): erzeugt Acid-Bassläufe, die
//! sich über MIDI so abspielen lassen, wie der TD-3 sie von seinem eigenen
//! Sequencer kennt.
//!
//! Was den TD-3 von „irgendeiner Melodie" unterscheidet — und warum der
//! Generator nicht einfach `melody.addNote` mit Zufallstönen ist:
//!
//!   * ein Pattern hat 16 Steps, jeder Step ist Note ODER Pause (monophon)
//!   * jeder Step trägt zwei Schalter: ACCENT und SLIDE — die machen den Klang
//!   * über MIDI sind das keine eigenen Nachrichten, sondern Konventionen:
//!       - Accent  = hoher Anschlag (Schwelle: `ACCENT_MIN_VELOCITY`)
//!       - Slide   = die Note reicht über den Beginn der nächsten hinaus
//!                   (Legato-Überlappung) — der Filter/Pitch gleitet dann
//!   * Tonumfang: drei Oktaven um die Grundoktave (Down / Normal / Up)
//!
//! Die Ausgabe sind normale Melodie-Noten (Step, Länge, Tonhöhe, Anschlag), die
//! Engine braucht dafür nichts Neues: Accent ist die Velocity, Slide ist eine
//! Notenlänge über 1 Step.
//!
//! Der Zufall ist ein kleiner Seed-Generator, keine Systemquelle: gleiche
//! Parameter + gleicher Seed ergeben exakt dasselbe Pattern. Dadurch behält
//! ein Regler-Dreh den „Charakter" des Patterns, statt alles neu zu würfeln;
//! neu würfeln heißt: anderer Seed.

use serde_json::{json, Value};

/// Steps pro Takt/Pattern — der TD-3 hat fest 16 (kürzere Patterns laufen dort
/// einfach früher von vorn; hier ist ein Takt = ein TD-3-Pattern).
pub const STEPS: u32 = 16;

/// Längster Baustein: 32 Takte = 512 Steps (der Dialog bietet bis 16 = 256 an).
pub const MAX_BARS: u32 = 32;

/// Tiefste/höchste Note des TD-3-Umfangs (MIDI): Grundoktave ab `BASE_NOTE`,
/// je eine Oktave darunter (Down) und darüber (Up).
pub const LOW_NOTE: i32 = 24;
pub const HIGH_NOTE: i32 = 60;
/// Unterste Note der „normalen" Oktave (C), auf die `root` aufgesetzt wird.
const BASE_NOTE: i32 = 36;

/// Ab dieser Velocity löst der TD-3 Accent aus; Normalnoten bleiben klar darunter.
pub const ACCENT_MIN_VELOCITY: u8 = 100;
const ACCENT_VELOCITY: u8 = 120;
const NORMAL_VELOCITY: u8 = 80;
const _: () = assert!(ACCENT_VELOCITY >= ACCENT_MIN_VELOCITY && NORMAL_VELOCITY < ACCENT_MIN_VELOCITY);

/// Gate-Länge einer normalen Note in Steps. Der TD-3 spielt kurze, trockene
/// Noten — ganze Steps klängen wie Legato und würden mit dem Slide verwischen.
const GATE_STEPS: f64 = 0.55;
/// Länge einer Slide-Note: genug über den nächsten Step hinaus, dass die
/// Überlappung nach der Rundung auf Pulse (24 PPQN → 6 je 16tel) sicher
/// mindestens einen Puls beträgt.
const SLIDE_STEPS: f64 = 1.3;

/// Tonleitern als Halbtonabstände zur Grundnote. Reihenfolge = Angebot im Dialog.
pub const SCALES: &[(&str, &[i32])] = &[
    ("minorPent", &[0, 3, 5, 7, 10]),
    ("minor", &[0, 2, 3, 5, 7, 8, 10]),
    ("phrygian", &[0, 1, 3, 5, 7, 8, 10]),
    ("dorian", &[0, 2, 3, 5, 7, 9, 10]),
    ("harmonicMinor", &[0, 2, 3, 5, 7, 8, 11]),
    ("phrygianDominant", &[0, 1, 4, 5, 7, 8, 10]),
    ("blues", &[0, 3, 5, 6, 7, 10]),
];

#[derive(Debug, Clone)]
pub struct Params {
    /// Grundton als Tonklasse 0..11 (C = 0).
    pub root: u8,
    pub scale: String,
    /// 1..=`MAX_BARS` Takte; jeder Takt ist ein TD-3-Pattern. Takt 2+ sind Variationen
    /// des Riffs, in Vier-Takt-Phrasen gegliedert (s. `generate`).
    pub bars: u32,
    /// 0..1 — Anteil belegter Steps (Rest = Pausen).
    pub density: f64,
    /// 0..1 — Wahrscheinlichkeit für Accent je Note.
    pub accent: f64,
    /// 0..1 — Wahrscheinlichkeit für Slide je Note, auf die direkt eine weitere folgt.
    pub slide: f64,
    /// 0..1 — Wahrscheinlichkeit für Oktavsprünge (Down/Up) je Note.
    pub octaves: f64,
    pub seed: u64,
}

impl Params {
    pub fn from_cmd(cmd: &Value) -> Params {
        let f = |k: &str, d: f64| cmd.get(k).and_then(|v| v.as_f64()).unwrap_or(d).clamp(0.0, 1.0);
        let scale = cmd.get("scale").and_then(|v| v.as_str()).unwrap_or("minorPent");
        Params {
            root: cmd.get("root").and_then(|v| v.as_u64()).unwrap_or(0).min(11) as u8,
            scale: if SCALES.iter().any(|(n, _)| *n == scale) { scale } else { "minorPent" }.to_string(),
            bars: cmd.get("bars").and_then(|v| v.as_u64()).unwrap_or(1).clamp(1, MAX_BARS as u64) as u32,
            density: f("density", 0.7),
            accent: f("accent", 0.4),
            slide: f("slide", 0.3),
            octaves: f("octaves", 0.3),
            seed: cmd.get("seed").and_then(|v| v.as_u64()).unwrap_or(1),
        }
    }
}

/// Ein Step des Patterns, wie ihn das TD-3-Display zeigt.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Step {
    pub note: i32,
    pub accent: bool,
    /// Gleitet in den NÄCHSTEN Step (die Note ist über dessen Beginn verlängert).
    pub slide: bool,
    /// Gewünschte Länge in Steps, solange die Note NICHT gleitet (bei Slide
    /// gilt `SLIDE_STEPS`). Lang gewählt, aber der nächste Step ist belegt?
    /// Dann kürzt `to_notes` — sonst würde die Überlappung ungewollt zum Slide.
    pub len: f64,
}

pub struct Generated {
    /// Je Takt 16 Steps, `None` = Pause.
    pub bars: Vec<Vec<Option<Step>>>,
}

/// splitmix64 — klein, schnell, bei Seed 0 und kleinen Seeds trotzdem gut verteilt.
pub(crate) struct Rng(pub u64);
impl Rng {
    pub(crate) fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E3779B97F4A7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58476D1CE4E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D049BB133111EB);
        z ^ (z >> 31)
    }
    pub(crate) fn unit(&mut self) -> f64 {
        (self.next() >> 11) as f64 / (1u64 << 53) as f64
    }
    pub(crate) fn chance(&mut self, p: f64) -> bool {
        self.unit() < p
    }
    pub(crate) fn below(&mut self, n: usize) -> usize {
        (self.next() % n.max(1) as u64) as usize
    }
}

fn scale_intervals(name: &str) -> &'static [i32] {
    SCALES.iter().find(|(n, _)| *n == name).map(|(_, s)| *s).unwrap_or(SCALES[0].1)
}

/// Wie gern ein Step eine Note trägt: Zählzeiten fast immer, Achtel-Offbeats
/// oft, die ungeraden 16tel seltener — das gibt dem Lauf den typischen
/// Acid-Drive, statt Pausen gleichmäßig zu streuen.
fn step_weight(step: u32) -> f64 {
    match step % 4 {
        0 => 1.0,
        2 => 0.85,
        _ => 0.6,
    }
}

/// Erzeugt das Pattern. Takt 1 wird frei gewürfelt, jeder weitere Takt ist
/// eine Variation davon (einzelne Steps neu gewürfelt) — so klingt ein
/// mehrtaktiger Baustein wie EIN Riff mit Abwandlungen, nicht wie vier fremde.
pub fn generate(p: &Params) -> Generated {
    let mut rng = Rng(p.seed);
    let scale = scale_intervals(&p.scale);

    // Alle erlaubten Töne im TD-3-Umfang, aufsteigend. Der Index in dieser
    // Liste ist der „Skalenschritt" — Melodiebewegung rechnet darin, nicht in
    // Halbtönen, damit Läufe in der Tonleiter bleiben.
    let mut pitches: Vec<i32> = Vec::new();
    for oct in -1..=1 {
        for &iv in scale {
            let n = BASE_NOTE + p.root as i32 + iv + oct * 12;
            if (LOW_NOTE..=HIGH_NOTE).contains(&n) {
                pitches.push(n);
            }
        }
    }
    pitches.sort_unstable();
    pitches.dedup();

    // Grundton der mittleren Oktave: Anker des Patterns.
    let root_mid = BASE_NOTE + p.root as i32;
    let root_idx = pitches.iter().position(|&n| n == root_mid).unwrap_or(0);

    // Gliederung in Vier-Takt-Phrasen, wie ein Acid-Track sie spielt: je Phrase
    // ein Thema, das im 2. Takt leicht und im 4. Takt stärker abgewandelt wird
    // (Turnaround). Die nächste Phrase wandelt das vorige Thema ab — so
    // entwickelt sich ein langer Baustein, statt 16 Mal dasselbe zu wiederholen
    // oder in 16 fremde Takte zu zerfallen.
    let mut bars: Vec<Vec<Option<Step>>> = Vec::new();
    let mut theme = gen_bar(&mut rng, p, &pitches, root_idx);
    for b in 0..p.bars {
        if b > 0 && b % 4 == 0 {
            theme = mutate_bar(&mut rng, p, &pitches, root_idx, &theme, 0.3);
        }
        let bar = match b % 4 {
            0 | 2 => theme.clone(),
            1 => mutate_bar(&mut rng, p, &pitches, root_idx, &theme, 0.22),
            _ => mutate_bar(&mut rng, p, &pitches, root_idx, &theme, 0.4),
        };
        bars.push(bar);
    }
    Generated { bars }
}

/// Wandelt einen Takt ab: einzelne Steps werden zur Pause, bekommen eine neue
/// Note oder kippen ihren Accent. Step 0 bleibt belegt (Anker), die Slides
/// werden danach neu ausgewürfelt (Pausen/Töne haben die alten ungültig gemacht).
fn mutate_bar(rng: &mut Rng, p: &Params, pitches: &[i32], root_idx: usize, base: &[Option<Step>], change: f64) -> Vec<Option<Step>> {
    let mut bar = base.to_vec();
    for s in 0..STEPS as usize {
        if !rng.chance(change) {
            continue;
        }
        match rng.below(3) {
            0 => bar[s] = None,
            1 => bar[s] = Some(new_step(rng, p, pitches, root_idx, s as u32, bar[s].map(|x| x.note))),
            _ => {
                if let Some(st) = bar[s].as_mut() {
                    st.accent = !st.accent;
                }
            }
        }
    }
    if bar[0].is_none() {
        bar[0] = base[0];
    }
    resolve_slides(rng, p, &mut bar);
    bar
}

fn gen_bar(rng: &mut Rng, p: &Params, pitches: &[i32], root_idx: usize) -> Vec<Option<Step>> {
    let mut bar: Vec<Option<Step>> = vec![None; STEPS as usize];
    let mut prev: Option<i32> = None;
    for s in 0..STEPS {
        // Step 0 immer belegt (mit dem Grundton) — ohne den fehlt dem Pattern
        // der Halt, und ein Loop beginnt „im Nichts".
        let on = s == 0 || rng.chance((p.density * step_weight(s) * 1.25).min(1.0));
        if !on {
            continue;
        }
        let step = if s == 0 {
            Step { note: pitches[root_idx], accent: rng.chance(p.accent.max(0.5)), slide: false, len: GATE_STEPS }
        } else {
            new_step(rng, p, pitches, root_idx, s, prev)
        };
        prev = Some(step.note);
        bar[s as usize] = Some(step);
    }
    resolve_slides(rng, p, &mut bar);
    bar
}

/// Würfelt Tonhöhe und Accent für einen Step. Tonhöhe: meist Grundton oder
/// Quinte (die Anker jedes Acid-Riffs), sonst ein Nachbarton der vorigen Note
/// (Läufe) oder ein beliebiger Ton der Skala; dazu gelegentlich eine Oktave
/// hoch/runter — der typische „Bounce".
fn new_step(rng: &mut Rng, p: &Params, pitches: &[i32], root_idx: usize, step: u32, prev: Option<i32>) -> Step {
    let r = rng.unit();
    let mut idx = if r < 0.30 {
        root_idx
    } else if r < 0.45 {
        // Quinte der mittleren Oktave, falls vorhanden — sonst Grundton.
        let fifth = pitches[root_idx] + 7;
        pitches.iter().position(|&n| n == fifth).unwrap_or(root_idx)
    } else if r < 0.80 && prev.is_some() {
        // Nachbarton der vorigen Note im Skalenraster.
        let pi = pitches.iter().position(|&n| Some(n) == prev).unwrap_or(root_idx) as i32;
        let d = if rng.chance(0.5) { 1 } else { -1 } * if rng.chance(0.25) { 2 } else { 1 };
        (pi + d).clamp(0, pitches.len() as i32 - 1) as usize
    } else {
        rng.below(pitches.len())
    };

    if rng.chance(p.octaves * 0.5) {
        // Oktavsprung: gleicher Ton eine Oktave höher oder tiefer, falls im Umfang.
        let up = rng.chance(0.6);
        let want = pitches[idx] + if up { 12 } else { -12 };
        if let Some(i) = pitches.iter().position(|&n| n == want) {
            idx = i;
        }
    }

    // Accent liegt gern auf den Offbeats — die 303-Betonung kommt „dazwischen".
    let weight = if step % 4 == 2 { 1.2 } else if step % 2 == 1 { 1.0 } else { 0.7 };
    Step { note: pitches[idx], accent: rng.chance((p.accent * weight).min(1.0)), slide: false, len: GATE_STEPS }
}

/// Setzt die Slides neu: eine Note gleitet nur, wenn direkt der nächste Step
/// belegt ist und eine ANDERE Tonhöhe hat (Gleiten auf denselben Ton ist
/// unhörbar — und würde auf MIDI-Ebene das Note-Off der alten Note mitten in
/// die neue legen und sie abwürgen). Die letzte Note des Takts gleitet nie:
/// über die Schleifengrenze hinweg ist die Überlappung nicht verlässlich.
fn resolve_slides(rng: &mut Rng, p: &Params, bar: &mut [Option<Step>]) {
    for s in 0..bar.len() {
        let next = if s + 1 < bar.len() { bar[s + 1] } else { None };
        if let Some(cur) = bar[s].as_mut() {
            cur.slide = match next {
                Some(n) if n.note != cur.note => rng.chance(p.slide),
                _ => false,
            };
        }
    }
}

/// Je belegtem Step: wie viele Steps bis zur nächsten Note (bzw. zum Ende des
/// Bausteins) Platz sind. Index = globaler Step, `None` = Pause.
fn rooms(g: &Generated) -> Vec<Option<f64>> {
    let flat: Vec<Option<&Step>> = g.bars.iter().flat_map(|b| b.iter().map(|s| s.as_ref())).collect();
    let mut out = vec![None; flat.len()];
    let mut next = flat.len();
    for i in (0..flat.len()).rev() {
        if flat[i].is_some() {
            out[i] = Some((next - i) as f64);
            next = i;
        }
    }
    out
}

/// Tatsächlich gespielte Länge: Slide = `SLIDE_STEPS`, sonst die gewählte
/// Länge, höchstens knapp unter dem Platz bis zur nächsten Note.
fn play_len(st: &Step, room: f64) -> f64 {
    if st.slide {
        SLIDE_STEPS
    } else {
        st.len.min(room * 0.95).max(0.1)
    }
}

/// Als Melodie-Noten (JSON wie im Projekt gespeichert).
pub fn to_notes(g: &Generated) -> Vec<Value> {
    let rooms = rooms(g);
    let mut out = Vec::new();
    for (b, bar) in g.bars.iter().enumerate() {
        for (s, st) in bar.iter().enumerate() {
            let Some(st) = st else { continue };
            let gi = b * STEPS as usize + s;
            out.push(json!({
                "step": gi as u32,
                "lengthSteps": crate::ws::length_json(play_len(st, rooms[gi].unwrap_or(1.0))),
                "note": st.note,
                "velocity": if st.accent { ACCENT_VELOCITY } else { NORMAL_VELOCITY },
            }));
        }
    }
    out
}

/// Das Pattern für die Anzeige im Dialog: je Takt 16 Einträge, `null` = Pause.
/// `room` = Steps Platz bis zur nächsten Note — der Dialog sperrt damit Längen,
/// die nicht passen würden.
pub fn to_pattern_json(g: &Generated) -> Value {
    let rooms = rooms(g);
    Value::Array(
        g.bars
            .iter()
            .enumerate()
            .map(|(b, bar)| {
                Value::Array(
                    bar.iter()
                        .enumerate()
                        .map(|(s, st)| match st {
                            Some(st) => json!({
                                "note": st.note,
                                "accent": st.accent,
                                "slide": st.slide,
                                "len": st.len,
                                "room": rooms[b * STEPS as usize + s],
                            }),
                            None => Value::Null,
                        })
                        .collect(),
                )
            })
            .collect(),
    )
}

/// Liest ein vom Dialog (nach Handbearbeitung) geschicktes Pattern zurück und
/// macht es gültig: Töne in den TD-3-Umfang, Länge begrenzt, Slide nur in einen
/// direkt folgenden Step anderer Tonhöhe. `None`, wenn es kein Pattern ist.
pub fn from_pattern(v: &Value) -> Option<Generated> {
    let bars_in = v.as_array()?;
    if bars_in.is_empty() || bars_in.len() > MAX_BARS as usize {
        return None;
    }
    let mut bars = Vec::new();
    for bar in bars_in {
        let steps = bar.as_array()?;
        let mut out: Vec<Option<Step>> = (0..STEPS as usize)
            .map(|i| {
                let st = steps.get(i)?;
                let note = st.get("note")?.as_i64()? as i32;
                Some(Step {
                    note: note.clamp(LOW_NOTE, HIGH_NOTE),
                    accent: st.get("accent").and_then(|x| x.as_bool()).unwrap_or(false),
                    slide: st.get("slide").and_then(|x| x.as_bool()).unwrap_or(false),
                    len: st.get("len").and_then(|x| x.as_f64()).unwrap_or(GATE_STEPS).clamp(0.1, 16.0),
                })
            })
            .collect();
        for s in 0..out.len() {
            let next = out.get(s + 1).copied().flatten();
            if let Some(cur) = out[s].as_mut() {
                cur.slide = cur.slide && matches!(next, Some(n) if n.note != cur.note);
            }
        }
        bars.push(out);
    }
    Some(Generated { bars })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn params(seed: u64) -> Params {
        Params::from_cmd(&json!({ "seed": seed, "bars": 4, "density": 1.0, "slide": 1.0, "accent": 0.5, "octaves": 1.0 }))
    }

    #[test]
    fn same_seed_same_pattern() {
        let a = to_notes(&generate(&params(7)));
        let b = to_notes(&generate(&params(7)));
        assert_eq!(a, b);
        assert_ne!(a, to_notes(&generate(&params(8))));
    }

    #[test]
    fn stays_in_td3_range_and_scale() {
        for seed in 0..200 {
            for name in SCALES.iter().map(|(n, _)| *n) {
                for root in [0u8, 5, 11] {
                    let p = Params::from_cmd(&json!({ "seed": seed, "scale": name, "root": root, "bars": 2, "octaves": 1.0 }));
                    let scale = scale_intervals(name);
                    for bar in generate(&p).bars {
                        assert_eq!(bar.len(), STEPS as usize);
                        for st in bar.into_iter().flatten() {
                            assert!((LOW_NOTE..=HIGH_NOTE).contains(&st.note), "note {} out of range", st.note);
                            let pc = (st.note - root as i32).rem_euclid(12);
                            assert!(scale.contains(&pc), "pc {pc} not in {name}");
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn first_step_is_always_set() {
        for seed in 0..100 {
            let p = Params::from_cmd(&json!({ "seed": seed, "density": 0.0, "bars": 3 }));
            for bar in generate(&p).bars {
                assert!(bar[0].is_some());
            }
        }
    }

    #[test]
    fn slides_only_into_a_different_following_note() {
        for seed in 0..200 {
            for bar in generate(&params(seed)).bars {
                for s in 0..bar.len() {
                    if let Some(st) = bar[s] {
                        if st.slide {
                            let next = bar.get(s + 1).copied().flatten().expect("slide needs a next step");
                            assert_ne!(next.note, st.note);
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn accent_and_slide_map_to_velocity_and_length() {
        let g = generate(&params(3));
        let notes = to_notes(&g);
        let flat: Vec<Step> = g.bars.iter().flatten().flatten().copied().collect();
        assert_eq!(notes.len(), flat.len());
        for (n, st) in notes.iter().zip(flat) {
            let vel = n["velocity"].as_u64().unwrap() as u8;
            assert_eq!(vel >= ACCENT_MIN_VELOCITY, st.accent);
            assert_eq!(n["lengthSteps"].as_f64().unwrap() > 1.0, st.slide);
        }
    }

    #[test]
    fn long_pattern_256_steps() {
        let p = Params::from_cmd(&json!({ "seed": 9, "bars": 16 }));
        let g = generate(&p);
        assert_eq!(g.bars.len(), 16);
        let notes = to_notes(&g);
        assert!(notes.iter().all(|n| n["step"].as_u64().unwrap() < 256));
        assert!(notes.len() > 60);
    }

    #[test]
    fn hand_edited_pattern_is_sanitised() {
        let mut bar = vec![Value::Null; 16];
        bar[0] = json!({ "note": 200, "accent": true, "slide": true, "len": 4.0 });
        bar[1] = json!({ "note": 200, "slide": true });
        bar[4] = json!({ "note": 40, "len": 8.0 });
        let g = from_pattern(&json!([bar])).unwrap();
        let a = g.bars[0][0].unwrap();
        assert_eq!(a.note, HIGH_NOTE);
        assert!(!a.slide, "slide into the same pitch is dropped");
        let notes = to_notes(&g);
        // 4-Step-Länge auf Step 0 wird auf den Platz bis Step 1 gekürzt, nicht überlappend.
        assert!(notes[0]["lengthSteps"].as_f64().unwrap() < 1.0);
        // letzte Note darf bis zum Ende des Bausteins (12 Steps) reichen.
        assert!(notes[2]["lengthSteps"].as_f64().unwrap() >= 8.0);
        assert!(from_pattern(&json!([])).is_none());
        assert!(from_pattern(&json!("x")).is_none());
    }

    #[test]
    fn zero_density_leaves_only_the_anchor() {
        let p = Params::from_cmd(&json!({ "seed": 5, "density": 0.0 }));
        let g = generate(&p);
        assert_eq!(g.bars[0].iter().flatten().count(), 1);
    }
}
