//! Zufalls-Generator der 1601-Ansicht: würfelt eine monophone Melodie über die
//! ganze Länge des Bausteins — Tonhöhen im Fader-Fenster, optional in einer
//! Skala, mit Wahrscheinlichkeiten für Note/Pause, Accent und gebundene Noten.
//!
//! Die Ausgabe sind normale Melodie-Noten (Step, Länge, Tonhöhe, Anschlag): die
//! Engine und alle anderen Ansichten brauchen dafür nichts Neues. Accent ist
//! wie im TD-3-Generator eine hohe Velocity, TIE eine Länge über einen Step.
//!
//! Gleicher Seed + gleiche Parameter ergeben exakt dieselbe Melodie; „neu
//! würfeln" heißt anderer Seed (den die UI zieht).

use serde_json::{json, Value};

use crate::td3::Rng;

const ACCENT_VELOCITY: u64 = 120;
const NORMAL_VELOCITY: u64 = 80;
/// Längste gebundene Note in Steps (wie der TIE-Schalter der UI).
const MAX_TIE: u32 = 4;

/// Wohin die Zufalls-Melodie zielt. `Random` ist der freie Wurf (Skala und
/// Wahrscheinlichkeiten kommen aus den Reglern); die übrigen Stile bringen
/// Skala, Rhythmus-Gewichte, Bewegungsart und Wiederholung SELBST mit — s. `Spec`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Style {
    Random,
    Acid,
    Blues,
    Techno,
    Funk,
    Jazz,
    Ambient,
    Trance,
}

impl Style {
    pub fn from_name(name: &str) -> Style {
        match name {
            "acid" => Style::Acid,
            "blues" => Style::Blues,
            "techno" => Style::Techno,
            "funk" => Style::Funk,
            "jazz" => Style::Jazz,
            "ambient" => Style::Ambient,
            "trance" => Style::Trance,
            _ => Style::Random,
        }
    }
}

#[derive(Debug, Clone)]
pub struct Params {
    pub style: Style,
    /// Tiefste Note des Fenster (Fader unten) und seine Breite in Halbtönen.
    pub low: i32,
    pub span: i32,
    /// Abstand der Rasterpunkte ab `low`: 1 = Halbton, 2 = Ganzton.
    pub grid: i32,
    /// Grundton der Skala (Tonklasse 0..11); `scale` = `None` heißt chromatisch.
    pub root: u8,
    pub scale: Option<&'static [u8]>,
    /// Wahrscheinlichkeiten 0..1.
    pub density: f64,
    pub accent: f64,
    pub tie: f64,
    pub seed: u64,
    pub total_steps: u32,
}

/// Alle erlaubten Tonhöhen: Rasterpunkte des Fensters, die in der Skala liegen.
/// Bleibt nichts übrig (enge Skala + Ganztonraster), gelten alle Rasterpunkte —
/// lieber eine Note außerhalb der Skala als eine stumme Melodie.
pub fn pitch_pool(p: &Params) -> Vec<i32> {
    let grid = p.grid.max(1);
    let all: Vec<i32> = (0..=p.span.max(0))
        .step_by(grid as usize)
        .map(|o| p.low + o)
        .filter(|n| (0..=127).contains(n))
        .collect();
    let in_scale: Vec<i32> = match p.scale {
        Some(sc) => all
            .iter()
            .copied()
            .filter(|n| sc.contains(&((n - p.root as i32).rem_euclid(12) as u8)))
            .collect(),
        None => all.clone(),
    };
    if in_scale.is_empty() {
        all
    } else {
        in_scale
    }
}

pub fn generate(p: &Params) -> Vec<Value> {
    if p.style != Style::Random {
        return generate_styled(p);
    }
    let pool = pitch_pool(p);
    if pool.is_empty() {
        return Vec::new();
    }
    let mut rng = Rng(p.seed);
    let density = p.density.clamp(0.0, 1.0);
    let mut out = Vec::new();
    for step in 0..p.total_steps {
        // Zählzeiten fallen seltener aus als die ungeraden 16tel: bei Dichte 1
        // spielt jeder Step, bei 0 keiner, dazwischen bekommt der Lauf Drive.
        let exponent = match step % 4 {
            0 => 0.7,
            2 => 1.0,
            _ => 1.3,
        };
        if !rng.chance(density.powf(exponent)) {
            continue;
        }
        let note = pool[rng.below(pool.len())];
        let velocity = if rng.chance(p.accent.clamp(0.0, 1.0)) { ACCENT_VELOCITY } else { NORMAL_VELOCITY };
        let room = p.total_steps - step;
        let len = if room >= 2 && rng.chance(p.tie.clamp(0.0, 1.0)) {
            2 + rng.below((MAX_TIE.min(room) - 1) as usize) as u32
        } else {
            1
        };
        out.push(json!({ "step": step, "lengthSteps": len, "note": note, "velocity": velocity }));
    }
    out
}


// ── Stile ──────────────────────────────────────────────────────────────────
//
// Ein Stil ist KEIN Zufall mit anderer Skala, sondern ein kleines Regelwerk, wie
// diese Musik gebaut ist:
//   • Rhythmus  — wie wahrscheinlich ein Ton auf jedem der 16 Steps eines Takts
//                 liegt (Acid: fast überall; Blues: Achtel mit Lücken; Ambient:
//                 selten und lang).
//   • Bewegung  — die Melodie springt nicht wild, sondern geht von der letzten
//                 Note aus in Skalenstufen weiter (`walk`); auf Zählzeiten
//                 bevorzugt sie die tragenden Töne der Skala (`strong`).
//   • Motiv     — ein Takt wird gewürfelt, die folgenden wiederholen ihn mit
//                 kleinen Abweichungen (`vary`), jeder vierte stärker (Wendung).
//                 Das ist es, was aus Zufallstönen einen Riff macht.
//   • Trance    — Sonderfall: kein Walk, sondern ein Arpeggio über die Akkordtöne.

struct Spec {
    /// Skala in Halbtönen ab dem Grundton.
    scale: &'static [u8],
    /// Wahrscheinlichkeit eines Tons je 16tel im Takt (bei Dichte-Regler 50 %).
    weights: [f64; 16],
    /// Gewichte der Bewegung um -2, -1, 0, +1, +2 Skalenstufen.
    walk: [f64; 5],
    /// Bevorzugte Töne (Halbtöne ab Grundton) auf Zählzeiten, und wie oft.
    strong: &'static [u8],
    strong_p: f64,
    accent: f64,
    tie: f64,
    tie_max: u32,
    /// Chance auf Oktavsprung.
    octave: f64,
    /// Abweichung bei jeder Wiederholung des Motivs.
    vary: f64,
    /// Länge des Motivs in Steps.
    motif: u32,
    arp: bool,
}

fn spec(style: Style) -> Spec {
    match style {
        // 303-Bass: dichte 16tel, Grundton und Quinte, Oktavsprünge, viel Accent
        // und Slide, kleine Phrygisch-Färbung (b2).
        Style::Acid => Spec {
            scale: &[0, 1, 3, 5, 7, 10],
            weights: [1.0, 0.7, 0.85, 0.7, 1.0, 0.7, 0.85, 0.75, 1.0, 0.7, 0.85, 0.7, 1.0, 0.75, 0.85, 0.8],
            walk: [0.1, 0.2, 0.3, 0.25, 0.15],
            strong: &[0, 7],
            strong_p: 0.5,
            accent: 0.35,
            tie: 0.2,
            tie_max: 2,
            octave: 0.22,
            vary: 0.22,
            motif: 16,
            arp: false,
        },
        // Moll-Blues-Skala, Achtel mit Lücken, Grundton/b3/Quinte/b7 auf den
        // Zählzeiten, gehaltene Töne, stufenweise Bewegung.
        Style::Blues => Spec {
            scale: &[0, 3, 5, 6, 7, 10],
            weights: [1.0, 0.15, 0.6, 0.15, 0.8, 0.15, 0.6, 0.2, 1.0, 0.15, 0.6, 0.15, 0.7, 0.2, 0.5, 0.3],
            walk: [0.1, 0.35, 0.1, 0.35, 0.1],
            strong: &[0, 3, 7, 10],
            strong_p: 0.7,
            accent: 0.2,
            tie: 0.35,
            tie_max: 3,
            octave: 0.04,
            vary: 0.35,
            motif: 16,
            arp: false,
        },
        // Minimal-Techno: fast nur der Grundton, Off-Beat-16tel, wenig Bewegung.
        Style::Techno => Spec {
            scale: &[0, 3, 5, 7, 10],
            weights: [0.8, 0.1, 0.5, 0.9, 0.3, 0.1, 0.6, 0.9, 0.8, 0.1, 0.5, 0.9, 0.3, 0.1, 0.6, 0.9],
            walk: [0.05, 0.15, 0.6, 0.15, 0.05],
            strong: &[0],
            strong_p: 0.7,
            accent: 0.3,
            tie: 0.08,
            tie_max: 2,
            octave: 0.15,
            vary: 0.15,
            motif: 16,
            arp: false,
        },
        // Funk-Bass/Gitarre: dorisch, synkopiert, kurz und trocken (kaum Ties).
        Style::Funk => Spec {
            scale: &[0, 2, 3, 5, 7, 9, 10],
            weights: [1.0, 0.35, 0.45, 0.7, 0.2, 0.7, 0.45, 0.35, 0.9, 0.3, 0.5, 0.7, 0.25, 0.65, 0.5, 0.8],
            walk: [0.15, 0.25, 0.15, 0.25, 0.2],
            strong: &[0, 3, 7],
            strong_p: 0.5,
            accent: 0.4,
            tie: 0.03,
            tie_max: 2,
            octave: 0.2,
            vary: 0.3,
            motif: 16,
            arp: false,
        },
        // Jazz-Linie: dorisch, Achtel, stufenweise, Akkordtöne auf den Zählzeiten.
        Style::Jazz => Spec {
            scale: &[0, 2, 3, 5, 7, 9, 10],
            weights: [1.0, 0.1, 0.8, 0.1, 0.9, 0.1, 0.8, 0.2, 1.0, 0.1, 0.8, 0.1, 0.9, 0.1, 0.8, 0.25],
            walk: [0.2, 0.35, 0.05, 0.35, 0.2],
            strong: &[0, 3, 7, 10],
            strong_p: 0.6,
            accent: 0.15,
            tie: 0.25,
            tie_max: 3,
            octave: 0.05,
            vary: 0.45,
            motif: 16,
            arp: false,
        },
        // Ambient: Dur-Pentatonik, wenige lange Töne, weite Sprünge.
        Style::Ambient => Spec {
            scale: &[0, 2, 4, 7, 9],
            weights: [0.7, 0.0, 0.05, 0.0, 0.25, 0.0, 0.05, 0.0, 0.5, 0.0, 0.05, 0.0, 0.25, 0.0, 0.1, 0.0],
            walk: [0.2, 0.25, 0.1, 0.25, 0.2],
            strong: &[0, 7],
            strong_p: 0.4,
            accent: 0.05,
            tie: 0.75,
            tie_max: 4,
            octave: 0.1,
            vary: 0.5,
            motif: 16,
            arp: false,
        },
        // Trance-Arpeggio: Moll-Akkordtöne auf-/absteigend in dichten 16teln.
        Style::Trance => Spec {
            scale: &[0, 3, 7, 10],
            weights: [1.0, 0.95, 0.95, 0.95, 1.0, 0.95, 0.95, 0.95, 1.0, 0.95, 0.95, 0.95, 1.0, 0.95, 0.95, 0.95],
            walk: [0.0, 0.0, 0.0, 1.0, 0.0],
            strong: &[0],
            strong_p: 0.0,
            accent: 0.25,
            tie: 0.05,
            tie_max: 2,
            octave: 0.0,
            vary: 0.12,
            motif: 16,
            arp: true,
        },
        Style::Random => unreachable!("Random hat keine Spec"),
    }
}

#[derive(Clone, Copy)]
struct Hit {
    /// Index im Tonvorrat.
    idx: usize,
    accent: bool,
    len: u32,
}

/// Index im `pool` eines Tons `semis` Halbtöne von `idx` entfernt, falls vorhanden.
fn shifted(pool: &[i32], idx: usize, semis: i32) -> Option<usize> {
    let target = pool[idx] + semis;
    pool.iter().position(|&n| n == target)
}

struct Walker<'a> {
    pool: &'a [i32],
    root: u8,
    spec: &'a Spec,
    prev: Option<usize>,
    /// Arpeggio: laufender Index und Richtung (+1 auf, -1 ab).
    arp_dir: i32,
}

impl Walker<'_> {
    fn strong_indices(&self) -> Vec<usize> {
        self.pool
            .iter()
            .enumerate()
            .filter(|(_, &n)| self.spec.strong.contains(&(((n - self.root as i32).rem_euclid(12)) as u8)))
            .map(|(i, _)| i)
            .collect()
    }

    fn next_idx(&mut self, rng: &mut Rng, step: u32) -> usize {
        let last = self.pool.len() - 1;
        let idx = if self.spec.arp {
            // Ping-pong durch die Akkordtöne des Fensters.
            let cur = self.prev.unwrap_or(0) as i32;
            let mut nxt = cur + self.arp_dir;
            if nxt > last as i32 || nxt < 0 {
                self.arp_dir = -self.arp_dir;
                nxt = (cur + self.arp_dir).clamp(0, last as i32);
            }
            if self.prev.is_none() { 0 } else { nxt as usize }
        } else {
            let strong = self.strong_indices();
            if !strong.is_empty() && (self.prev.is_none() || (step % 4 == 0 && rng.chance(self.spec.strong_p))) {
                strong[rng.below(strong.len())]
            } else {
                let from = self.prev.unwrap_or(last / 2) as i32;
                // Gewichtete Wahl der Bewegung in Skalenstufen.
                let total: f64 = self.spec.walk.iter().sum();
                let mut r = rng.unit() * total.max(1e-9);
                let mut delta = 0;
                for (i, w) in self.spec.walk.iter().enumerate() {
                    if r < *w {
                        delta = i as i32 - 2;
                        break;
                    }
                    r -= w;
                }
                (from + delta).clamp(0, last as i32) as usize
            }
        };
        let idx = if rng.chance(self.spec.octave) {
            let up = rng.chance(0.5);
            shifted(self.pool, idx, if up { 12 } else { -12 })
                .or_else(|| shifted(self.pool, idx, if up { -12 } else { 12 }))
                .unwrap_or(idx)
        } else {
            idx
        };
        self.prev = Some(idx);
        idx
    }
}

fn generate_styled(p: &Params) -> Vec<Value> {
    let sp = spec(p.style);
    // Tonvorrat: Fensterraster ∩ Stil-Skala (Grundton = gewählter Grundton).
    let pool = pitch_pool(&Params { scale: Some(sp.scale), ..p.clone() });
    if pool.is_empty() || p.total_steps == 0 {
        return Vec::new();
    }
    let mut rng = Rng(p.seed);
    // Die Regler sind „mehr/weniger als typisch": 50 % = so, wie der Stil es
    // von sich aus macht.
    let dens = 2.0 * p.density.clamp(0.0, 1.0);
    let acc = (sp.accent * 2.0 * p.accent.clamp(0.0, 1.0)).clamp(0.0, 1.0);
    let tie = (sp.tie * 2.0 * p.tie.clamp(0.0, 1.0)).clamp(0.0, 1.0);

    let motif_len = sp.motif.min(p.total_steps).max(1);
    let mut walker = Walker { pool: &pool, root: p.root, spec: &sp, prev: None, arp_dir: 1 };

    // Das Motiv: Takt 1, frei gewürfelt.
    let mut motif: Vec<Option<Hit>> = Vec::with_capacity(motif_len as usize);
    for pos in 0..motif_len {
        let w = sp.weights[(pos % 16) as usize];
        if !rng.chance((w * dens).clamp(0.0, 1.0)) {
            motif.push(None);
            continue;
        }
        let idx = walker.next_idx(&mut rng, pos);
        let accent = rng.chance(acc);
        let room = motif_len - pos;
        let len = if room >= 2 && rng.chance(tie) { 2 + rng.below((sp.tie_max.min(room).max(2) - 1) as usize) as u32 } else { 1 };
        motif.push(Some(Hit { idx, accent, len }));
    }

    // Wiederholungen: dasselbe Motiv mit Abweichungen, jeder vierte Durchlauf
    // stärker verändert (Wendung/Turnaround).
    let mut out = Vec::new();
    let reps = p.total_steps.div_ceil(motif_len);
    for rep in 0..reps {
        let vary = if rep == 0 { 0.0 } else if rep % 4 == 3 { (sp.vary * 2.2).min(0.9) } else { sp.vary };
        for pos in 0..motif_len {
            let step = rep * motif_len + pos;
            if step >= p.total_steps {
                break;
            }
            let mut hit = motif[pos as usize];
            if rep > 0 && rng.chance(vary) {
                hit = match hit {
                    // Ton: neu würfeln, weglassen oder Accent kippen.
                    Some(h) => match rng.below(3) {
                        0 => Some(Hit { idx: walker.next_idx(&mut rng, pos), ..h }),
                        1 => None,
                        _ => Some(Hit { accent: !h.accent, ..h }),
                    },
                    // Pause: manchmal kommt ein Ton dazu.
                    None if rng.chance((sp.weights[(pos % 16) as usize] * dens).clamp(0.0, 1.0) * 0.6) => {
                        Some(Hit { idx: walker.next_idx(&mut rng, pos), accent: rng.chance(acc), len: 1 })
                    }
                    None => None,
                };
            }
            if let Some(h) = hit {
                let len = h.len.min(p.total_steps - step).max(1);
                out.push(json!({
                    "step": step,
                    "lengthSteps": len,
                    "note": pool[h.idx],
                    "velocity": if h.accent { ACCENT_VELOCITY } else { NORMAL_VELOCITY },
                }));
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn params() -> Params {
        Params {
            style: Style::Random,
            low: 36,
            span: 24,
            grid: 1,
            root: 0,
            scale: None,
            density: 0.7,
            accent: 0.3,
            tie: 0.2,
            seed: 7,
            total_steps: 32,
        }
    }

    fn notes(v: &[Value]) -> Vec<i64> {
        v.iter().map(|n| n["note"].as_i64().unwrap()).collect()
    }

    #[test]
    fn same_seed_same_melody_other_seed_differs() {
        let a = generate(&params());
        assert_eq!(a, generate(&params()));
        assert_ne!(a, generate(&Params { seed: 8, ..params() }));
    }

    #[test]
    fn notes_stay_in_window_and_on_the_grid() {
        for seed in 0..50 {
            for grid in [1, 2] {
                for n in generate(&Params { seed, grid, ..params() }) {
                    let note = n["note"].as_i64().unwrap();
                    assert!((36..=60).contains(&note));
                    assert_eq!((note - 36) % grid as i64, 0);
                }
            }
        }
    }

    #[test]
    fn notes_stay_in_scale() {
        let minor_pent: &'static [u8] = &[0, 3, 5, 7, 10];
        for seed in 0..50 {
            let g = generate(&Params { seed, root: 2, scale: Some(minor_pent), ..params() });
            for note in notes(&g) {
                assert!(minor_pent.contains(&(((note - 2).rem_euclid(12)) as u8)), "{note} off scale");
            }
        }
    }

    #[test]
    fn density_extremes() {
        assert!(generate(&Params { density: 0.0, ..params() }).is_empty());
        assert_eq!(generate(&Params { density: 1.0, tie: 0.0, ..params() }).len(), 32);
    }

    #[test]
    fn ties_never_run_past_the_end_and_accents_are_loud() {
        for seed in 0..50 {
            for n in generate(&Params { seed, density: 1.0, tie: 1.0, accent: 1.0, ..params() }) {
                let (step, len) = (n["step"].as_u64().unwrap(), n["lengthSteps"].as_u64().unwrap());
                assert!(step + len <= 32);
                assert!((1..=MAX_TIE as u64).contains(&len));
                assert_eq!(n["velocity"].as_u64().unwrap(), ACCENT_VELOCITY);
            }
        }
    }

    const STYLES: [Style; 7] = [Style::Acid, Style::Blues, Style::Techno, Style::Funk, Style::Jazz, Style::Ambient, Style::Trance];

    #[test]
    fn every_style_plays_stays_in_window_and_scale_and_is_deterministic() {
        for style in STYLES {
            let sc = spec(style).scale;
            for root in [0u8, 2, 9] {
                for seed in 0..20 {
                    // Fenster ab dem Grundton, damit Raster und Skala zusammenpassen.
                    let p = Params { style, root, low: 36 + root as i32, seed, density: 0.5, total_steps: 64, ..params() };
                    let g = generate(&p);
                    assert!(!g.is_empty(), "{style:?} root {root} seed {seed} is silent");
                    assert_eq!(g, generate(&p));
                    for n in &g {
                        let note = n["note"].as_i64().unwrap() as i32;
                        assert!((p.low..=p.low + 24).contains(&note), "{style:?} {note} outside window");
                        assert!(sc.contains(&((note - root as i32).rem_euclid(12) as u8)), "{style:?} {note} off scale");
                        let (step, len) = (n["step"].as_u64().unwrap(), n["lengthSteps"].as_u64().unwrap());
                        assert!(step + len <= 64);
                    }
                }
            }
        }
    }

    #[test]
    fn styles_sound_different() {
        let sets: Vec<_> = STYLES.iter().map(|&style| generate(&Params { style, density: 0.5, total_steps: 32, ..params() })).collect();
        for i in 0..sets.len() {
            for j in i + 1..sets.len() {
                assert_ne!(sets[i], sets[j], "{:?} and {:?} are identical", STYLES[i], STYLES[j]);
            }
        }
    }

    #[test]
    fn later_bars_repeat_the_motif_with_small_changes() {
        // Blues bei 64 Steps: Takt 2 ähnelt Takt 1 (gleiche Steps zu >50 %).
        let g = generate(&Params { style: Style::Blues, density: 0.5, total_steps: 64, ..params() });
        let steps: Vec<u64> = g.iter().map(|n| n["step"].as_u64().unwrap()).collect();
        let bar1: Vec<u64> = steps.iter().copied().filter(|s| *s < 16).collect();
        let bar2: Vec<u64> = steps.iter().copied().filter(|s| (16..32).contains(s)).map(|s| s - 16).collect();
        let same = bar1.iter().filter(|s| bar2.contains(s)).count();
        assert!(same * 2 > bar1.len(), "bar 2 shares only {same} of {} steps with bar 1", bar1.len());
    }

    #[test]
    fn narrow_scale_with_whole_tone_grid_falls_back_instead_of_going_silent() {
        let p = Params { grid: 2, scale: Some(&[1]), root: 0, ..params() };
        assert!(!pitch_pool(&p).is_empty());
    }
}
