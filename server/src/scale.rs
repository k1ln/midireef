//! Skalen-Rechnung für Lane-Keys-Links im „Stay in scale"-Modus: statt die
//! Lane um Halbtöne zu verschieben (was aus C-Dur F-Dur macht), wandern die
//! Noten um Skalenstufen — die Melodie bleibt in der Tonleiter.

/// Intervalle einer Skala (Halbtöne ab Grundton) nach `ScaleName` aus
/// shared/model.ts. `None` für `chromatic` und unbekannte Namen.
pub fn intervals(name: &str) -> Option<&'static [u8]> {
    Some(match name {
        "major" => &[0, 2, 4, 5, 7, 9, 11],
        "minor" => &[0, 2, 3, 5, 7, 8, 10],
        "dorian" => &[0, 2, 3, 5, 7, 9, 10],
        "phrygian" => &[0, 1, 3, 5, 7, 8, 10],
        "lydian" => &[0, 2, 4, 6, 7, 9, 11],
        "mixolydian" => &[0, 2, 4, 5, 7, 9, 10],
        "locrian" => &[0, 1, 3, 5, 6, 8, 10],
        "harmonicMinor" => &[0, 2, 3, 5, 7, 8, 11],
        "melodicMinor" => &[0, 2, 3, 5, 7, 9, 11],
        "pentatonicMajor" => &[0, 2, 4, 7, 9],
        "pentatonicMinor" => &[0, 3, 5, 7, 10],
        "blues" => &[0, 3, 5, 6, 7, 10],
        _ => return None,
    })
}

fn in_scale(note: i32, root_pc: u8, scale: &[u8]) -> bool {
    let rel = (note - root_pc as i32).rem_euclid(12) as u8;
    scale.contains(&rel)
}

/// Index von `note` in der Liste aller Skalentöne 0..=127 — liegt die Note
/// außerhalb der Skala, zählt der nächste Skalenton darunter (bei Gleichstand
/// der untere).
fn degree_index(note: u8, root_pc: u8, scale: &[u8]) -> i32 {
    (0..=note as i32).filter(|&m| in_scale(m, root_pc, scale)).count() as i32 - 1
}

/// Skalenstufen von `root` bis `key` (positiv = höher). Beide werden auf
/// die Skala gerastet (`root` liegt per Konstruktion drin).
pub fn degrees_between(root: i32, key: u8, root_pc: u8, scale: &[u8]) -> i32 {
    let r = root.clamp(0, 127) as u8;
    degree_index(key, root_pc, scale) - degree_index(r, root_pc, scale)
}

/// `note` um `degrees` Skalenstufen verschieben. Eine Note außerhalb der
/// Skala rastet dabei auf den Skalenton darunter ein; das Ergebnis liegt
/// immer in der Skala und im MIDI-Bereich.
pub fn shift_degrees(note: u8, degrees: i32, root_pc: u8, scale: &[u8]) -> u8 {
    let notes: Vec<u8> = (0..=127u8).filter(|&m| in_scale(m as i32, root_pc, scale)).collect();
    if notes.is_empty() {
        return note;
    }
    let idx = (degree_index(note, root_pc, scale).max(0) + degrees).clamp(0, notes.len() as i32 - 1);
    notes[idx as usize]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn c_major() -> &'static [u8] {
        intervals("major").unwrap()
    }

    #[test]
    fn pressing_f_moves_a_c_major_melody_up_three_degrees_staying_in_c_major() {
        let d = degrees_between(60, 65, 0, c_major());
        assert_eq!(d, 3);
        // C D E G A  →  F G A C D (alles weiße Tasten)
        let out: Vec<u8> = [60, 62, 64, 67, 69].iter().map(|&n| shift_degrees(n, d, 0, c_major())).collect();
        assert_eq!(out, vec![65, 67, 69, 72, 74]);
    }

    #[test]
    fn negative_degrees_and_octave_wrap() {
        // Eine Oktave tiefer = −7 Stufen in einer Siebenton-Skala.
        assert_eq!(degrees_between(60, 48, 0, c_major()), -7);
        assert_eq!(shift_degrees(60, -7, 0, c_major()), 48);
    }

    #[test]
    fn key_outside_scale_snaps_down() {
        // F# (66) in C-Dur rastet auf F (65) → +3.
        assert_eq!(degrees_between(60, 66, 0, c_major()), 3);
    }

    #[test]
    fn pentatonic_and_root_offset() {
        let p = intervals("pentatonicMajor").unwrap();
        // Stufe über G in C-Pentatonik: A (+1)… von C aus: G ist Stufe 3.
        assert_eq!(degrees_between(60, 67, 0, p), 3);
        // Grundton D (pc 2): D-Dur-Skala, Taste F# = Stufe 2.
        assert_eq!(degrees_between(62, 66, 2, c_major()), 2);
    }

    #[test]
    fn chromatic_has_no_intervals() {
        assert!(intervals("chromatic").is_none());
    }
}
