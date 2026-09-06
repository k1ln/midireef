//! Datenmodell (Rust-Spiegel von shared/model.ts, via serde JSON-kompatibel).
//! Für das Grundgerüst zunächst die Kern-Strukturen; wird schrittweise erweitert.

use serde::{Deserialize, Serialize};

pub type Id = String;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Scale {
    pub root: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MetronomeConfig {
    pub enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub device_id: Option<Id>,
    pub channel: u8,
    pub accent_note: u8,
    pub note: u8,
    pub count_in_bars: u32,
}

impl Default for MetronomeConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            device_id: None,
            channel: 10,
            accent_note: 76,
            note: 77,
            count_in_bars: 1,
        }
    }
}

/// Ziel einer Trigger-Kette: „wird ein Slot dieser Lane ausgelöst, feuere
/// zusätzlich (laneId, slotId)". Sitzt an der Lane, weil dort auch Kanal und
/// CC-Ziel liegen — Bausteine bleiben reiner, wiederverwendbarer Inhalt.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChainSlot {
    pub lane_id: Id,
    pub slot_id: Id,
}

/// Note-Echo/Delay-Konfiguration einer Lane — s. `engine::EchoConfig`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LaneEcho {
    pub repeats: u32,
    /// Hits pro Viertelnote (wie beim Roll-LaneControl) — 8 = Achtel-Delay.
    pub rate_div: u32,
    /// 0..1 — Velocity-Multiplikator PRO Wiederholung.
    pub decay: f64,
}

/// Glide/Portamento einer Lane. Bewusst KEIN eigenes Pitch-Bend-Timing in der
/// Engine — Midireef spielt externe MIDI-Hardware an, und praktisch jeder
/// Synth hat sein eigenes Portamento-Schaltwerk (CC5 Zeit, CC65 an/aus).
/// `lane.setGlide` sendet diese beiden CCs einmalig auf Kanal/Port der Lane;
/// von da an gleitet JEDE Note, die der Synth selbst legato spielt — echtes
/// Nachbauen der Kurve in der Engine wäre nur eine schlechtere Kopie dessen,
/// was das Zielgerät ohnehin schon kann.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LaneGlide {
    pub enabled: bool,
    /// CC5-Rohwert (0-127) — wie lange der Synth für den Gleitvorgang braucht.
    pub time_cc: u8,
}

// ── Routing-Hub (externe Controller on-the-fly auf Devices routen) ─────────
// S. docs/ARCHITECTURE.md §4b. Anders als blocks/scenes/songs (bewusst rohes
// JSON, weil die Engine sie nur durchreicht) braucht Routing beim Empfang
// JEDER eingehenden MIDI-Nachricht echte Feld-für-Feld-Logik (Filter,
// Transform) — dafür lohnt sich der getippte Rust-Umweg von Anfang an.

/// Ein physischer MIDI-Eingang (externer Controller), benennbar.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MidiInputSource {
    pub id: Id,
    pub name: String,
    pub port: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub channel_filter: Option<u8>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CcRemapEntry {
    pub from: u8,
    pub to: u8,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteTransform {
    pub device_id: Id,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub channel: Option<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note_transpose: Option<i32>,
    /// 0..1
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub velocity_scale: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cc_remap: Option<Vec<CcRemapEntry>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteRange {
    pub low: u8,
    pub high: u8,
}

/// Eine Route: leitet gefilterte MIDI-Nachrichten einer Quelle live an ein
/// Device. `message_filter` bleibt rohes JSON (`"all"` ODER eine Liste von
/// Nachrichtenarten) — dieselbe manuelle Auswertung wie schon bei
/// `TrigCondition` in engine.rs, statt ein fragiles String-oder-Array-Enum.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MidiRoute {
    pub id: Id,
    pub name: String,
    pub enabled: bool,
    pub source_id: Id,
    #[serde(default = "all_messages")]
    pub message_filter: serde_json::Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cc_filter: Option<Vec<u8>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note_range: Option<NoteRange>,
    pub transform: RouteTransform,
}

fn all_messages() -> serde_json::Value {
    serde_json::json!("all")
}

/// Aktiviert eine bestimmte Menge Routen auf Knopfdruck (z.B. "alle
/// Controller → Synth B") — Kern des kabellosen Umschaltens. Aktivieren
/// heißt: GENAU diese Routen an, alle anderen aus (s. `routing.activateScene`
/// in ws.rs) — keine separate "welche Scene ist aktiv"-Logik beim Forwarden
/// nötig, nur `MidiRoute.enabled` zählt zur Laufzeit.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutingScene {
    pub id: Id,
    pub name: String,
    pub active_route_ids: Vec<Id>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RoutingHub {
    #[serde(default)]
    pub sources: Vec<MidiInputSource>,
    #[serde(default)]
    pub routes: Vec<MidiRoute>,
    #[serde(default)]
    pub scenes: Vec<RoutingScene>,
    /// Nur fürs UI-Feedback ("zuletzt aktivierte Scene") — spätere manuelle
    /// Änderungen an einzelnen Routen machen das rückblickend "veraltet",
    /// wie bei `TransportState.activeSceneId` auch schon.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_scene_id: Option<Id>,
}

// ── Globale Modulation (Mod-Matrix) ─────────────────────────────────────────

/// Globaler LFO, auf mehrere Ziele routbar (`ModRoute`) — anders als eine
/// `CcLayer` an einem Baustein läuft er unabhängig von jeder Lane/Slot immer
/// mit, taktsynchron. S. `engine::CModulator`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GlobalModulator {
    pub id: Id,
    pub name: String,
    /// "sine" | "triangle" | "sawUp" | "sawDown" | "square"
    pub waveform: String,
    pub rate_bars: f64,
    pub phase: f64,
    pub bipolar: bool,
}

/// Ein Ziel, das ein globaler Modulator ansteuert.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModRoute {
    pub id: Id,
    pub modulator_id: Id,
    pub device_id: Id,
    pub cc_number: u8,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub channel: Option<u8>,
    /// -1..1
    pub depth: f64,
}

/// Lane innerhalb eines Devices. Slots/Controls bleiben vorerst als freies JSON.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Lane {
    pub id: Id,
    pub name: String,
    pub role: String, // BlockType: melody|beat|cc|programChange|patternShift|chord|arp
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    pub enabled: bool,
    pub visible: bool,
    pub muted: bool,
    pub solo: bool,
    pub collapsed: bool,
    pub height: f64,
    pub play_mode: String,        // sequential|random|manual
    pub trigger_quantize: String, // immediate|nextBeat|nextBar|nextBlock
    /// MIDI-Kanal dieser Lane (1–16). Der Kanal sitzt ausschließlich an der
    /// Lane — Bausteine sind reiner Inhalt, das Device kennt keinen Kanal mehr.
    /// Sentinel `0` = aus einem Altprojekt geladen, ohne eigenen Kanal;
    /// `migrate_project` füllt ihn beim Laden auf (Baustein-Feld → alter
    /// Device-Kanal → 1).
    #[serde(default)]
    pub channel: u8,
    /// Nur für `role == "cc"`: der Ziel-Knob dieser Lane (ein gelerntes
    /// Live-Control aus `Project.controls`, `kind == "knob"`). Die CC-Bausteine
    /// der Lane liefern ausschließlich die BEWEGUNG (0..1) — Port, Kanal und
    /// CC-Nummer kommen aus dem Mapping dieses Knobs. `None` = kein Ziel
    /// gewählt, die Lane spielt stumm. Bewusst hier und nicht am Baustein:
    /// derselbe Baustein soll in mehreren Lanes auf unterschiedliche CCs
    /// laufen können (siehe `resolve_cc_target` in engine.rs).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cc_control_id: Option<Id>,
    /// Trigger-Kette: wird ein Slot dieser Lane ausgelöst, wird zusätzlich das
    /// hier hinterlegte `(laneId, slotId)` mit ausgelöst. `None` = keine Kette.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chain_slot: Option<ChainSlot>,
    /// Nur für `role == "cc"`: Id einer Melodie-Lane, deren gespielte Noten
    /// das LFO-Key-Tracking (`rateKeyTrack`) dieser Lane treiben — die
    /// höchste Note jedes Note-Steps setzt laufend `Playback::trigger_note`
    /// (s. `Engine::fire_step`). Alternative zum externen MIDI-Trigger
    /// (`control.setTrigger`), der denselben Wert nur bei einer physisch
    /// gespielten Note setzt. `None` = kein internes Keytrack.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub keytrack_source_lane_id: Option<Id>,
    /// Zusätzlich zum Keytrack (`keytrack_source_lane_id`): startet/hält die
    /// Quell-Lane diese (Hold/OneShot-)Lane auch aktiv mit, statt nur ihre
    /// Rate zu treiben — wie ein externer MIDI-Trigger, nur ohne MIDI-In.
    /// Unabhängig voneinander schaltbar, weil beides oft getrennt gebraucht
    /// wird (nur Rate folgen vs. auch klingen). `false` = nur Keytrack, wie
    /// bisher.
    #[serde(default)]
    pub keytrack_source_starts: bool,
    /// Swing 0..1 NUR für diese Lane — überschreibt `Project.swing`. `None` =
    /// Projekt-Default gilt (Einstellungen → „lane.setSwing").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub swing: Option<f64>,
    /// Humanize: leichte Zufallsstreuung von Timing/Velocity (0..1),
    /// unabhängig voneinander schaltbar (`lane.setHumanize`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub humanize_timing: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub humanize_velocity: Option<f64>,
    /// Note-Echo/Delay — abklingende Wiederholungen jeder gespielten Note
    /// dieser Lane. `None` = aus (`lane.setEcho`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub echo: Option<LaneEcho>,
    /// Glide/Portamento — `None` = nie gesetzt (Synth-Default gilt). Anders
    /// als swing/humanize/echo wirkt das NICHT in der Engine, sondern nur als
    /// gesendete CC5/CC65 (`lane.setGlide`), s. `LaneGlide`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub glide: Option<LaneGlide>,
    #[serde(default)]
    pub slots: serde_json::Value,
    #[serde(default)]
    pub controls: serde_json::Value,
}

impl Lane {
    pub fn new(role: &str, name: String) -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            name,
            role: role.to_string(),
            color: Some(default_role_color(role).to_string()),
            enabled: true,
            visible: true,
            muted: false,
            solo: false,
            collapsed: false,
            height: 64.0,
            play_mode: "sequential".to_string(),
            trigger_quantize: "nextBar".to_string(),
            channel: 1,
            cc_control_id: None,
            chain_slot: None,
            keytrack_source_lane_id: None,
            keytrack_source_starts: false,
            swing: None,
            humanize_timing: None,
            humanize_velocity: None,
            echo: None,
            glide: None,
            slots: serde_json::json!([]),
            controls: serde_json::json!([]),
        }
    }
}

fn default_role_color(role: &str) -> &'static str {
    match role {
        "melody" => "#4fd1c5",
        "beat" => "#f6ad55",
        "cc" => "#63b3ed",
        "programChange" => "#b794f4",
        "patternShift" => "#f687b3",
        "chord" => "#68d391",
        "arp" => "#76e4f7",
        _ => "#9ff0ff",
    }
}

/// Device (Instrument). Die Baustein-Bibliothek liegt seit der Projekt-Umstellung
/// nicht mehr am Device, sondern an `Project.blocks` — ein Baustein ist reiner
/// Inhalt und in jeder Lane jedes Geräts einsetzbar.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    pub id: Id,
    pub name: String,
    pub midi_out_port: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub midi_in_port: Option<String>,
    /// Nur für die Migration von Altprojekten: früher lag der Default-Kanal am
    /// Device, heute trägt ihn jede Lane selbst. Wird beim Laden aus dem alten
    /// `channel`-Feld gelesen, um Lanes ohne eigenen Kanal einmalig zu füllen
    /// (siehe `migrate_project`), und nie wieder geschrieben.
    #[serde(rename = "channel", default, skip_serializing)]
    pub legacy_channel: Option<u8>,
    pub send_clock: bool,
    /// Schnell-Mute des GANZEN Geräts: alle seine Lanes schweigen (laufen aber
    /// weiter, wie ein einzelnes `Lane.muted`). `#[serde(default)]` → Altprojekte
    /// laden als „nicht gemutet".
    #[serde(default)]
    pub muted: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profile_id: Option<Id>,
    pub latency_offset_ms: f64,
    /// Nur für die Migration von Altprojekten: früher hielt jedes Device seine
    /// eigene Baustein-Bibliothek. `migrate_project` hebt diese einmalig nach
    /// `Project.blocks` und schreibt sie nie wieder.
    #[serde(rename = "blocks", default, skip_serializing)]
    pub legacy_blocks: serde_json::Value,
    pub lanes: Vec<Lane>,
}

impl Device {
    pub fn new(name: String, midi_out_port: String) -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            name,
            midi_out_port,
            midi_in_port: None,
            legacy_channel: None,
            send_clock: true,
            muted: false,
            profile_id: None,
            latency_offset_ms: 0.0,
            legacy_blocks: serde_json::Value::Null,
            lanes: Vec::new(),
        }
    }
}

/// Minimal-Projekt fürs Grundgerüst. Geräte/Lanes/Bausteine folgen inkrementell,
/// bleiben aber als freies JSON erhalten, damit nichts verloren geht.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: Id,
    pub name: String,
    pub bpm: f64,
    pub time_signature: String,
    pub scale: Scale,
    pub swing: f64,

    /// Rohbereiche, die der Server (noch) nicht typisiert verarbeitet, aber persistiert.
    #[serde(default)]
    pub devices: Vec<Device>,
    /// Baustein-Bibliothek des Projekts ("schwebende Tabelle", 9×9-Raster pro Typ).
    /// Ein Baustein ist reiner Inhalt und in jeder Lane jedes Geräts nutzbar; das
    /// Ziel (Kanal/CC) legt die Lane fest. Altprojekte tragen die Bausteine noch
    /// je Device — `migrate_project` hebt sie beim Laden hierher.
    #[serde(default)]
    pub blocks: serde_json::Value,
    #[serde(default)]
    pub device_profiles: serde_json::Value,
    #[serde(default)]
    pub controls: serde_json::Value,
    #[serde(default)]
    pub control_screens: serde_json::Value,
    #[serde(default)]
    pub control_snapshots: serde_json::Value,
    #[serde(default)]
    pub scenes: serde_json::Value,
    #[serde(default)]
    pub songs: serde_json::Value,
    #[serde(default)]
    pub routing: RoutingHub,
    #[serde(default)]
    pub modulators: Vec<GlobalModulator>,
    #[serde(default)]
    pub mod_routes: Vec<ModRoute>,

    #[serde(default)]
    pub metronome: MetronomeConfig,

    pub created_at: String,
    pub updated_at: String,
}

impl Project {
    pub fn new(name: &str) -> Self {
        let now = now_iso();
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            name: name.to_string(),
            bpm: 120.0,
            time_signature: "4/4".to_string(),
            scale: Scale {
                root: "C".to_string(),
                name: "minor".to_string(),
            },
            swing: 0.0,
            devices: Vec::new(),
            blocks: serde_json::json!([]),
            device_profiles: serde_json::json!([]),
            controls: serde_json::json!([]),
            control_screens: serde_json::json!([]),
            control_snapshots: serde_json::json!([]),
            scenes: serde_json::json!([]),
            songs: serde_json::json!([]),
            routing: RoutingHub::default(),
            modulators: Vec::new(),
            mod_routes: Vec::new(),
            metronome: MetronomeConfig::default(),
            created_at: now.clone(),
            updated_at: now,
        }
    }
}

/// Woher die Clock kommt.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ClockSource {
    Internal,
    ExternalMidi,
    Link,
}

/// Laufzeit-Transportzustand (Server-Wahrheit, an UI gepusht).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransportState {
    pub playing: bool,
    pub recording: bool,
    pub bpm: f64,
    pub clock_source: ClockSource,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub link_peers: Option<u32>,
    pub bar: u32,
    pub beat: u32,
    pub tick: u32,
    pub ppqn: u32,
    pub fill_active: bool,
    pub song_mode: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_song_id: Option<Id>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_scene_id: Option<Id>,
    /// Index (in `Song.steps`) des gerade laufenden Steps — nur bei
    /// `song_mode == true`. Treibt die Fortschrittsanzeige im Song-Screen.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_song_step_index: Option<u32>,
    /// Takte bis zum nächsten Step-Wechsel — zählt bei jeder Taktgrenze
    /// runter, s. `clock.rs`s Song-Auto-Advance.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub song_bars_remaining: Option<u32>,
}

impl Default for TransportState {
    fn default() -> Self {
        Self {
            playing: false,
            recording: false,
            bpm: 120.0,
            clock_source: ClockSource::Internal,
            link_peers: None,
            bar: 1,
            beat: 1,
            tick: 0,
            ppqn: 24,
            fill_active: false,
            song_mode: false,
            active_song_id: None,
            active_scene_id: None,
            active_song_step_index: None,
            song_bars_remaining: None,
        }
    }
}

pub fn now_iso() -> String {
    // Einfacher ISO-Zeitstempel ohne zusätzliche Crate.
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("unix:{secs}")
}
