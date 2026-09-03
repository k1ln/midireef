/**
 * MidiReef — verbindliches Datenmodell (Single Source of Truth).
 *
 * Diese Typen werden von UI (PixiJS) und MIDI-Server (Rust, gespiegelt via serde)
 * gemeinsam genutzt. Persistenz erfolgt als JSON — jede Struktur ist JSON-serialisierbar.
 */

// ────────────────────────────────────────────────────────────────────────────
// Grundlagen
// ────────────────────────────────────────────────────────────────────────────

/** Eindeutige ID (uuid o.ä.). */
export type Id = string;

/** MIDI-Kanal 1–16. */
export type MidiChannel = number;

/** MIDI-Notennummer 0–127. */
export type MidiNote = number;

/** MIDI-Wert 0–127 (Velocity, CC-Wert …). */
export type Midi7Bit = number;

/** MIDI-14-Bit-Wert 0–16383 (Pitch-Bend, NRPN/RPN). */
export type Midi14Bit = number;

/**
 * Alle unterstützten MIDI-Nachrichtentypen (volle Palette).
 */
export type MidiMessageKind =
  | "note"
  | "cc"
  | "programChange"
  | "pitchBend"
  | "channelAftertouch"
  | "polyAftertouch"
  | "nrpn"
  | "rpn"
  | "sysex";

/** Unterstützte Taktarten. Erweiterbar. */
export type TimeSignature =
  | "4/4"
  | "3/4"
  | "6/8"
  | "5/4"
  | "7/8"
  | "12/8"
  | "2/4";

/**
 * Speed-Multiplikator eines Bausteins.
 * Nur ganzzahlige Vielfache erlaubt (Wunsch: "nur in geraden Noten").
 *  1 = normal, 2 = doppelt so schnell, 3 = dreifach, 0.5 = halb (halbe = gerade Teilung).
 */
export type SpeedMultiplier = 0.25 | 0.5 | 1 | 2 | 3 | 4 | 6 | 8 | 16;

/**
 * Baustein-Typen. Jeder Typ hat ein eigenes 9×9-ID-Raster pro Projekt.
 * "1-1" … "9-9".
 */
export type BlockType =
  | "melody" // Melodie: Noten mit Tonhöhe & Länge
  | "beat" // Beat: nur Note-Ons, mehrere mutebare Lines (Drums)
  | "cc" // CC-Automation: LFO/Envelope/Ramp/Random-Layer
  | "patternShift" // Pattern-Wechsel (z.B. Roland Aira) via PC/CC
  | "chord" // Akkorde
  | "arp" // Arpeggio
  | "programChange"; // Program-Change-Sequenzen

/** Baustein-ID im 9×9-Raster: row 1–9, col 1–9. */
export interface BlockSlotId {
  type: BlockType;
  row: number; // 1–9
  col: number; // 1–9
}

// ────────────────────────────────────────────────────────────────────────────
// Skalen (für Transpose-Quantisierung)
// ────────────────────────────────────────────────────────────────────────────

export type ScaleRoot =
  | "C" | "C#" | "D" | "D#" | "E" | "F"
  | "F#" | "G" | "G#" | "A" | "A#" | "B";

export type ScaleName =
  | "chromatic"
  | "major"
  | "minor"
  | "dorian"
  | "phrygian"
  | "lydian"
  | "mixolydian"
  | "locrian"
  | "harmonicMinor"
  | "melodicMinor"
  | "pentatonicMajor"
  | "pentatonicMinor"
  | "blues";

/**
 * Tonleiter, in die Noten beim Transponieren optional gezwungen werden.
 * `chromatic` = keine Quantisierung (rein chromatisch verschieben).
 */
export interface Scale {
  root: ScaleRoot;
  name: ScaleName;
}

// ────────────────────────────────────────────────────────────────────────────
// Trigger & Wiedergabe
// ────────────────────────────────────────────────────────────────────────────

/** Wann ein per Touch ausgelöster Baustein tatsächlich startet. */
export type TriggerQuantize =
  | "immediate" // sofort bei Touch
  | "nextBeat" // beim nächsten Beat
  | "nextBar" // beim nächsten Taktanfang
  | "nextBlock"; // wenn der laufende Baustein fertig ist

/** Wie eine Lane durch ihre Bausteine läuft. */
export type LanePlayMode =
  | "sequential" // hintereinander
  | "random" // randomisiert
  | "manual" // nur per Touch ausgelöst, wiederholt den aktuellen Baustein
  | "hold" // stumm bis gedrückt; spielt nur solange die Kachel gehalten wird
  | "oneShot"; // stumm; ein Tap spielt den Baustein einmal durch, dann wieder still

/** Verhalten am Baustein-Ende. */
export type LoopMode =
  | "off" // einmal, dann Lane geht weiter ("durch die Klammer")
  | "loop" // endlos wiederholen bis nächster Trigger
  | "count"; // n-mal wiederholen (siehe loopCount)

// ────────────────────────────────────────────────────────────────────────────
// Per-Step-Modulation (Elektron-/Polyend-Klasse)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Trig-Condition: Bedingung, ob ein Step/Note in diesem Durchlauf spielt.
 *  "always"                  – immer
 *  { ratio: [a, b] }         – im a-ten von je b Durchläufen (z.B. [1,4])
 *  "fill" | "notFill"        – nur (nicht) im Fill-Modus
 *  "first" | "notFirst"      – nur (nicht) beim ersten Loop-Durchlauf
 *  { probability: 0..1 }     – Wahrscheinlichkeit
 */
export type TrigCondition =
  | "always"
  | "fill"
  | "notFill"
  | "first"
  | "notFirst"
  | { ratio: [number, number] }
  | { probability: number };

/**
 * Modulation eines einzelnen Steps/Events. Alle Felder optional → Default = neutral.
 */
export interface StepMod {
  probability?: number; // 0..1
  condition?: TrigCondition;
  ratchet?: number; // Anzahl Retrigger innerhalb des Steps (Rolls)
  microTiming?: number; // -1..1 Bruchteil eines Steps früher/später (Nudge)
}

// ────────────────────────────────────────────────────────────────────────────
// Bausteine — gemeinsame Basis
// ────────────────────────────────────────────────────────────────────────────

/** Maximale Länge eines Baustein-Namens (kurz, touch-freundlich). */
export const BLOCK_NAME_MAX_LENGTH = 6;

export interface BlockBase {
  id: Id;
  slot: BlockSlotId; // Position im 9×9-Raster (Anzeige-/Referenz-ID)
  type: BlockType;
  name: string; // max. BLOCK_NAME_MAX_LENGTH (6) Zeichen

  /** Länge in Takten (>= 1). Der Baustein läuft, bis er fertig ist. */
  lengthBars: number;
  timeSignature: TimeSignature;

  /** Anzahl Steps pro Takt (Auflösung im Editor, z.B. 16). */
  stepsPerBar: number;

  // Bewusst KEIN Kanal und kein MIDI-Ziel am Baustein: ein Baustein ist reiner
  // Inhalt (Noten, Steps, Bewegung) und soll in mehreren Lanes — auf anderen
  // Kanälen, anderen CCs, anderen Geräten — wiederverwendbar sein. Das Ziel
  // legt die Lane fest: `Lane.channel` (MIDI-Kanal) bzw. `Lane.ccControlId`
  // (Ziel-Knob einer CC-Lane).
}

// ── Melodie ────────────────────────────────────────────────────────────────

export interface MelodyNote extends StepMod {
  step: number; // Start-Step (0-basiert, über alle Takte)
  lengthSteps: number; // Dauer in Steps
  note: MidiNote; // absolute Tonhöhe VOR Transpose
  velocity: Midi7Bit;
}

export interface MelodyBlock extends BlockBase {
  type: "melody";
  /** Grund-/Basisnote, auf die der Baustein bezogen ist. */
  baseNote: MidiNote;
  notes: MelodyNote[];
  /** Optional: erzwingt Noten beim Transponieren in diese Skala (sonst Projekt-Default). */
  scale?: Scale;
}

// ── Beat ────────────────────────────────────────────────────────────────────

/** Ein Beat-Step mit optionaler Per-Step-Modulation. velocity 0 = aus. */
export interface BeatStep extends StepMod {
  velocity: Midi7Bit; // 0 = aus, sonst 1–127
}

/** Euklidischer Rhythmus-Generator für eine Beat-Line. */
export interface EuclidConfig {
  enabled: boolean;
  pulses: number; // Anzahl aktiver Schläge
  steps: number; // über wie viele Steps verteilt
  rotation: number; // Rotation des Musters
}

export interface BeatLine {
  id: Id;
  name: string; // z.B. "Kick", "Snare"
  note: MidiNote; // welche Note gesendet wird
  muted: boolean; // schnell mutebar (auch aus der Übersicht)
  steps: BeatStep[]; // ein BeatStep pro Step
  /** Optional: Muster euklidisch generieren statt manuell. */
  euclid?: EuclidConfig;
  /** Choke-Gruppe: Lines gleicher Gruppe schneiden sich gegenseitig ab (z.B. HiHats). */
  chokeGroup?: number;
}

export interface BeatBlock extends BlockBase {
  type: "beat";
  lines: BeatLine[];
}

// ── CC-Automation ─────────────────────────────────────────────────────────

export type CcLayerKind = "lfo" | "envelope" | "ramp" | "random" | "stepped";

export type LfoWaveform =
  | "sine"
  | "triangle"
  | "sawUp"
  | "sawDown"
  | "square"
  | "randomSmooth";

/**
 * Wie ein Layer mit dem Ergebnis der darunterliegenden Layer kombiniert wird.
 * Für den UNTERSTEN aktiven Layer ohne Bedeutung — der ist immer die Basis
 * (sonst ergäben "multiply"/"min" dort zwangsläufig 0, also Stille).
 */
export type CcCombineMode = "add" | "multiply" | "max" | "min" | "replace";

export interface CcLayerBase {
  id: Id;
  kind: CcLayerKind;
  enabled: boolean;
  combine: CcCombineMode;
  /** Beitrag = roh * depth + offset, danach auf 0..1 geklemmt. */
  depth: number; // 0..1 Skalierung der Bewegung
  offset: number; // -1..1 Versatz NACH der Skalierung
}

export interface CcLfoLayer extends CcLayerBase {
  kind: "lfo";
  waveform: LfoWaveform;
  /** "bars" = tempo-synchron (rateBars), "hz" = frei laufend (rateHz), unabhängig vom Tempo. */
  rateMode: "bars" | "hz";
  /** Rate synchron zum Takt, in Takten pro Zyklus (z.B. 1 = 1 Zyklus/Takt, 0.25 = 4/Takt). */
  rateBars: number;
  /** Freie Rate in Hz (nur bei rateMode="hz") — für schnelle, nicht taktsynchrone LFOs. */
  rateHz?: number;
  phase: number; // 0..1 Startphase
}

export interface CcEnvelopePoint {
  step: number;
  value: number; // 0..1
}

export interface CcEnvelopeLayer extends CcLayerBase {
  kind: "envelope";
  points: CcEnvelopePoint[];
}

export interface CcRampLayer extends CcLayerBase {
  kind: "ramp";
  from: number; // 0..1
  to: number; // 0..1
}

export interface CcRandomLayer extends CcLayerBase {
  kind: "random";
  /** Neue Zufallswerte je n Steps. */
  everySteps: number;
  smooth: boolean;
}

export interface CcSteppedLayer extends CcLayerBase {
  kind: "stepped";
  values: number[]; // 0..1 je Step
}

export type CcLayer =
  | CcLfoLayer
  | CcEnvelopeLayer
  | CcRampLayer
  | CcRandomLayer
  | CcSteppedLayer;

/**
 * Reine BEWEGUNG — welchen CC sie fährt, entscheidet die Lane über ihren
 * Ziel-Knob (`Lane.ccControlId`). Derselbe Baustein kann so in mehreren Lanes
 * auf unterschiedlichen CCs/Geräten laufen.
 */
export interface CcBlock extends BlockBase {
  type: "cc";
  /** Ausgabewerte in diesem Bereich (Standard 0–127). */
  outMin: Midi7Bit;
  outMax: Midi7Bit;
  layers: CcLayer[]; // von unten nach oben kombiniert; der unterste ist die Basis
}

// ── Pattern-Shift (z.B. Roland Aira) ────────────────────────────────────────

export interface PatternMessage {
  atStep: number; // wann innerhalb des Bausteins
  kind: MidiMessageKind;
  data1: number; // PC-/CC-/NRPN-Nummer, Note, o.ä.
  data2?: number; // CC-Wert / Velocity
  /** 14-Bit-Wert für pitchBend / nrpn / rpn. */
  value14?: Midi14Bit;
  /** Rohe Bytes für SysEx (inkl. F0 … F7). */
  sysex?: number[];
}

export interface PatternShiftBlock extends BlockBase {
  type: "patternShift";
  messages: PatternMessage[];
}

// ── Chord / Arp / Program-Change ────────────────────────────────────────────

export interface ChordEvent extends StepMod {
  step: number;
  lengthSteps: number;
  notes: MidiNote[];
  velocity: Midi7Bit;
}

export interface ChordBlock extends BlockBase {
  type: "chord";
  baseNote: MidiNote;
  chords: ChordEvent[];
  scale?: Scale;
}

export type ArpDirection = "up" | "down" | "upDown" | "random" | "asPlayed";

export interface ArpBlock extends BlockBase {
  type: "arp";
  baseNote: MidiNote;
  chordNotes: MidiNote[]; // Notenvorrat
  direction: ArpDirection;
  gateSteps: number; // Notenlänge in Steps
  rateSteps: number; // Abstand zwischen Noten
  velocity: Midi7Bit;
  scale?: Scale;
}

export interface ProgramChangeEvent {
  atStep: number;
  program: number; // 0–127
  bankMsb?: number;
  bankLsb?: number;
}

export interface ProgramChangeBlock extends BlockBase {
  type: "programChange";
  events: ProgramChangeEvent[];
}

/** Union aller Baustein-Varianten. */
export type Block =
  | MelodyBlock
  | BeatBlock
  | CcBlock
  | PatternShiftBlock
  | ChordBlock
  | ArpBlock
  | ProgramChangeBlock;

// ────────────────────────────────────────────────────────────────────────────
// Lanes & Placement
// ────────────────────────────────────────────────────────────────────────────

/**
 * Rolle einer Lane = ihr Baustein-Typ.
 * Lanes sind REIN pro Typ: eine Lane hostet nur Bausteine EINES Typs.
 * Die Rolle bestimmt zugleich, welche Schnell-Controls (LaneControl) sie erlaubt:
 *   melody | chord | arp   → Noten-/Frequenz-Controls
 *   beat                   → Drum-/Mute-Buttons
 *   cc                     → Macro-Knobs
 *   programChange          → MIDI-Signal-Buttons
 *   patternShift           → MIDI-Signal-Buttons
 */
export type LaneRole = BlockType;

/**
 * Platzierung eines Bausteins in einer Lane.
 * Overrides ändern das Abspielen, ohne den Original-Baustein zu verändern.
 */
export interface LaneSlot {
  id: Id;
  blockId: Id; // Referenz auf Block in der Device-Bibliothek

  /** Transponierung in Halbtönen (z.B. -7, +12). */
  transpose: number;
  /** Nur ganzzahlige/gerade Vielfache erlaubt. */
  speed: SpeedMultiplier;

  loopMode: LoopMode;
  loopCount: number; // nur bei loopMode === "count"
}

// ── Lane-Controls (Schnellbedienung in der Lane-Zeile) ──────────────────────

/**
 * Wie ein Control auslöst:
 *  momentary = Note-On bei Touch-Down, Note-Off bei Touch-Up (gedrückt halten)
 *  toggle    = umschalten (an/aus bleibt)
 *  oneShot   = einmaliger Impuls (z.B. Program-Change senden)
 */
export type ControlTrigger = "momentary" | "toggle" | "oneShot";

export interface LaneControlBase {
  id: Id;
  label: string; // Beschriftung (Touch-Keyboard)
  color?: string; // optionale Farbe fürs UI
  /** Position im Control-Streifen der Lane (Reihenfolge). */
  order: number;
}

/** Melodie-Lane: eine Note/Frequenz, die man live auslöst ("frequencies anlegen"). */
export interface NoteControl extends LaneControlBase {
  kind: "note";
  note: MidiNote; // absolute Note (Frequenz)
  velocity: Midi7Bit;
  trigger: ControlTrigger;
}

/** Drum-Lane: Button, der eine Drum-Note feuert ODER eine Beat-Line mutet. */
export interface DrumButtonControl extends LaneControlBase {
  kind: "drumButton";
  action: "trigger" | "muteToggle";
  note: MidiNote; // bei action="trigger": welche Drum-Note
  velocity: Midi7Bit;
  targetBlockId?: Id; // bei muteToggle: Beat-Baustein
  targetLineId?: Id; // bei muteToggle: welche Line
}

/** Program-Change / Pattern-Shift: sendet ein festes MIDI-Signal per Touch. */
export interface MidiSignalControl extends LaneControlBase {
  kind: "midiSignal";
  message: PatternMessage; // programChange | cc | note wiederverwendet
  trigger: ControlTrigger;
}

/**
 * CC-Lane: Macro-Knob — Fernbedienung für einen gelernten Dashboard-Knob
 * (`Project.controls`, kind="knob") DESSELBEN Geräts. Wert, Kanal und
 * CC-Nummer leben dort, damit Lane und Dashboard denselben Regler zeigen; ein
 * freies CC ohne Gerät dahinter lässt sich hier gar nicht erst wählen.
 */
export interface MacroKnobControl extends LaneControlBase {
  kind: "macroKnob";
  controlId: Id;
}

/** Löst einen Slot/Baustein der Lane per Touch aus. */
export interface SlotTriggerControl extends LaneControlBase {
  kind: "slotTrigger";
  slotId: Id;
}

export type LaneControl =
  | NoteControl
  | DrumButtonControl
  | MidiSignalControl
  | MacroKnobControl
  | SlotTriggerControl;

/**
 * Lane. Mehrere aktive Lanes eines Devices klingen gleichzeitig (parallel/polyphon).
 * Bei playMode=="random" wird der nächste Baustein zufällig aus DIESEN slots gewählt.
 */
export interface Lane {
  id: Id;
  name: string;
  role: LaneRole; // bestimmt erlaubte Bausteine & Controls
  color?: string; // Farb-Codierung im UI

  enabled: boolean; // an/aus (läuft mit)
  visible: boolean; // ein-/ausblenden in der UI
  muted: boolean; // stumm, läuft aber weiter
  solo: boolean; // nur Solo-Lanes klingen (falls irgendeine solo ist)
  collapsed: boolean; // Lane-Zeile eingeklappt (Platz sparen)
  height: number; // Zeilenhöhe im UI (Touch-Größe)

  playMode: LanePlayMode;
  triggerQuantize: TriggerQuantize;

  /** MIDI-Kanal dieser Lane (1–16). Der Kanal sitzt ausschließlich an der Lane. */
  channel: MidiChannel;

  /**
   * Nur für `role === "cc"`: Ziel-Knob dieser Lane — ein gelerntes Live-Control
   * (`Project.controls`, kind="knob") DESSELBEN Geräts. Die CC-Bausteine der
   * Lane liefern die Bewegung, der Knob die CC-NUMMER; Port und Kanal kommen
   * wie bei jeder Lane von Lane/Device (nicht aus dem Mapping des Knobs, dessen
   * Kanal nur den Sendekanal beim MIDI-Learn festhält).
   * `null`/undefined = kein Ziel, die Lane spielt stumm.
   */
  ccControlId?: Id | null;

  /** Swing 0..1 nur für diese Lane (überschreibt Projekt-Swing). */
  swing?: number;
  /** Humanize: leichte Zufallsstreuung von Timing/Velocity (0..1). */
  humanizeTiming?: number;
  humanizeVelocity?: number;

  slots: LaneSlot[]; // Baustein-Kette
  controls: LaneControl[]; // Schnell-Controls (rollenabhängig)

  // ── Laufzeit (vom Server gesetzt, nicht persistiert) ──
  runtime?: LaneRuntime;
}

export interface LaneRuntime {
  activeSlotId?: Id;
  queuedSlotId?: Id; // per Touch getriggert, wartet auf Quantisierung
  positionInBlockSteps: number;
  currentLoopIteration: number;
  /** Ids aktuell "an" geschalteter Toggle/Momentary-Controls (fürs UI-Feedback). */
  activeControlIds: Id[];
}

// ────────────────────────────────────────────────────────────────────────────
// Device
// ────────────────────────────────────────────────────────────────────────────

export interface Device {
  id: Id;
  name: string; // per Touch-Keyboard benennbar
  midiOutPort: string; // Portname
  midiInPort?: string;
  sendClock: boolean; // erhält dieses Device die MIDI-Clock?
  muted: boolean; // Schnell-Mute: alle Lanes des Geräts schweigen (laufen aber weiter)

  /** Verknüpftes Geräte-Profil (benannte CC/PC-Maps). */
  profileId?: Id;
  /** Latenz-Kompensation in ms (Events werden entsprechend früher gesendet). */
  latencyOffsetMs: number;
  /** MPE-Konfiguration (optional). */
  mpe?: MpeConfig;

  /** Baustein-Bibliothek ("schwebende Tabelle"), organisiert im 9×9-Raster pro Typ. */
  blocks: Block[];

  lanes: Lane[];
}

/** MIDI Polyphonic Expression. */
export interface MpeConfig {
  enabled: boolean;
  zone: "lower" | "upper";
  memberChannels: number; // Anzahl Member-Kanäle
  pitchBendRange: number; // in Halbtönen
}

// ────────────────────────────────────────────────────────────────────────────
// Live-Controls (Startbildschirm)
// ────────────────────────────────────────────────────────────────────────────

/**
 * "keyboard" = kein einzelner Taster, sondern eine Live-Aktivitäts-Anzeige
 * für ein GANZES physisches Keyboard (z.B. das eingebaute Keyboard eines
 * Mini-Synths): leuchtet, solange irgendeine Taste auf dem gelernten Kanal
 * gehalten wird — man muss also nicht jede einzelne Taste einzeln lernen.
 */
export type ControlKind = "knob" | "fader" | "button" | "toggle" | "xy" | "keyboard";

/**
 * Ergebnis eines MIDI-Learn: was dieses Control sendet/empfängt.
 * `number` fehlt NUR bei kind="keyboard": das Mapping matcht dann jede Note
 * auf `channel`, statt an der einen beim Lernen zufällig gedrückten Taste
 * hängen zu bleiben (siehe `control.setKind` im Server).
 */
export interface MidiMapping {
  channel: MidiChannel;
  kind: MidiMessageKind;
  number?: number; // CC-/Note-/NRPN-Nr — optional nur für kind="keyboard"-Controls
}

export interface LiveControl {
  id: Id;
  name: string; // per Touch-Keyboard
  kind: ControlKind;
  mapping?: MidiMapping; // via Learn gesetzt
  deviceId?: Id; // Ziel-Device
  min: Midi7Bit;
  max: Midi7Bit;
  value: number; // aktueller Wert

  /** Position auf einem individuellen Control-Screen. */
  screenId: Id;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Ein frei zusammenstellbarer Screen mit Live-Controls. */
export interface ControlScreen {
  id: Id;
  name: string;
  controlIds: Id[];
}

// ────────────────────────────────────────────────────────────────────────────
// Device-Profile (benannte CC/PC-Maps pro Gerätetyp)
// ────────────────────────────────────────────────────────────────────────────

export interface ProfileCc {
  number: number; // CC-Nummer
  name: string; // z.B. "Cutoff"
  min?: Midi7Bit;
  max?: Midi7Bit;
  default?: Midi7Bit;
}

export interface ProfileProgram {
  program: number;
  name: string; // z.B. "Techno Kit"
  bankMsb?: number;
  bankLsb?: number;
}

export interface ProfileNrpn {
  msb: number;
  lsb: number;
  name: string;
}

/** Wiederverwendbares Geräte-Profil (z.B. "Roland TR-8S", "Roland TB-3"). */
export interface DeviceProfile {
  id: Id;
  name: string;
  manufacturer?: string;
  ccs: ProfileCc[];
  programs: ProfileProgram[];
  nrpns: ProfileNrpn[];
}

// ────────────────────────────────────────────────────────────────────────────
// Scenes (mehrere Lanes/Devices mit einem Touch starten)
// ────────────────────────────────────────────────────────────────────────────

export interface SceneTarget {
  laneId: Id;
  action: "trigger" | "stop"; // Slot starten oder Lane stoppen
  slotId?: Id; // welcher Slot bei "trigger" (sonst aktueller/erster)
}

export interface Scene {
  id: Id;
  name: string;
  color?: string;
  targets: SceneTarget[]; // was diese Scene über alle Devices auslöst
}

// ────────────────────────────────────────────────────────────────────────────
// Song / Arrangement (Scenes zu einem Track verketten)
// ────────────────────────────────────────────────────────────────────────────

export interface SongStep {
  id: Id;
  sceneId: Id;
  bars: number; // wie viele Takte diese Scene läuft
  bpmOverride?: number; // optionale Tempo-Automation
  timeSignatureOverride?: TimeSignature; // optionaler Taktartwechsel
}

export interface Song {
  id: Id;
  name: string;
  steps: SongStep[];
  loop: boolean; // am Ende wieder von vorn
}

// ────────────────────────────────────────────────────────────────────────────
// Routing-Hub (externe Controller on-the-fly auf Devices routen)
// ────────────────────────────────────────────────────────────────────────────

/** Ein physischer MIDI-Eingang (externer Controller). */
export interface MidiInputSource {
  id: Id;
  name: string; // benennbar, z.B. "Launchkey"
  port: string; // physischer MIDI-In-Port
  channelFilter?: MidiChannel; // nur dieser Kanal (optional)
}

/** Transformation/Remapping einer Route auf das Ziel. */
export interface RouteTransform {
  deviceId: Id; // Ziel-Device
  channel?: MidiChannel; // Ziel-Kanal (Remap)
  noteTranspose?: number; // Noten verschieben
  velocityScale?: number; // 0..1
  /** CC-Umnummerierung: eingehende CC → andere CC-Nummer. */
  ccRemap?: { from: number; to: number }[];
}

/**
 * Eine Route: leitet gefilterte MIDI-Nachrichten einer Quelle live an ein Device.
 * Kernstück des Routing-Hubs — Controller ohne Kabelwechsel umschalten.
 */
export interface MidiRoute {
  id: Id;
  name: string;
  enabled: boolean;
  sourceId: Id; // MidiInputSource
  messageFilter: MidiMessageKind[] | "all"; // welche Nachrichten
  ccFilter?: number[]; // nur diese CCs (optional)
  noteRange?: { low: MidiNote; high: MidiNote }; // nur dieser Notenbereich
  transform: RouteTransform;
}

/**
 * Routing-Scene: aktiviert eine bestimmte Menge Routen auf Knopfdruck.
 * Ermöglicht "denselben Knob auf Synth A, dann auf Synth B" ohne Kabel/Re-Learn.
 */
export interface RoutingScene {
  id: Id;
  name: string;
  activeRouteIds: Id[];
}

export interface RoutingHub {
  sources: MidiInputSource[];
  routes: MidiRoute[];
  scenes: RoutingScene[];
  activeSceneId?: Id;
}

// ────────────────────────────────────────────────────────────────────────────
// Globale Modulation (Mod-Matrix)
// ────────────────────────────────────────────────────────────────────────────

/** Globaler LFO/Modulator, auf mehrere Ziele routbar. */
export interface GlobalModulator {
  id: Id;
  name: string;
  waveform: LfoWaveform;
  rateBars: number; // synchron zum Takt
  phase: number; // 0..1
  bipolar: boolean;
}

/** Ein Ziel, das ein Modulator ansteuert. */
export interface ModRoute {
  id: Id;
  modulatorId: Id;
  deviceId: Id;
  ccNumber: number;
  channel?: MidiChannel;
  depth: number; // -1..1
}

export interface ControlScreenSnapshot {
  id: Id;
  name: string;
  /** Gespeicherte Control-Werte (controlId → value) zum Wiederherstellen/Morphen. */
  values: Record<Id, number>;
}

// ────────────────────────────────────────────────────────────────────────────
// Projekt & Transport
// ────────────────────────────────────────────────────────────────────────────

/** Woher die Clock kommt. */
export type ClockSource =
  | "internal" // eigene Clock, wird gesendet
  | "externalMidi" // Sync zu eingehender MIDI-Clock
  | "link"; // Ableton Link (Netzwerk-Sync)

export interface MetronomeConfig {
  enabled: boolean;
  deviceId?: Id; // wohin der Click geht
  channel: MidiChannel;
  accentNote: MidiNote; // Note für Taktanfang
  note: MidiNote; // Note für übrige Beats
  countInBars: number; // Einzähler vor Aufnahme
}

export interface Project {
  id: Id;
  name: string;
  bpm: number;
  timeSignature: TimeSignature; // Projekt-Default
  scale: Scale; // Default-Skala für Transpose-Quantisierung
  swing: number; // 0..1

  devices: Device[];
  deviceProfiles: DeviceProfile[]; // Profil-Bibliothek
  controls: LiveControl[];
  controlScreens: ControlScreen[];
  controlSnapshots: ControlScreenSnapshot[];

  scenes: Scene[]; // Live-Scenes
  songs: Song[]; // Arrangements
  routing: RoutingHub; // Routing-Hub
  modulators: GlobalModulator[]; // globale LFOs
  modRoutes: ModRoute[]; // Mod-Matrix

  metronome: MetronomeConfig;

  createdAt: string; // ISO
  updatedAt: string; // ISO
}

/** Laufzeit-Transportzustand (Server-Wahrheit, an UI gepusht). */
export interface TransportState {
  playing: boolean;
  recording: boolean;
  bpm: number;
  clockSource: ClockSource;
  linkPeers?: number; // Anzahl Ableton-Link-Peers (bei clockSource="link")
  /** Position im Song. */
  bar: number;
  beat: number;
  tick: number; // 0–23 (24 PPQN)
  ppqn: 24;
  fillActive: boolean; // Fill-Modus (für Trig-Conditions "fill")
  songMode: boolean; // läuft ein Arrangement?
  activeSongId?: Id;
  activeSceneId?: Id;
}

/** Aufnahme-Einstellungen (MIDI-Input in Bausteine aufzeichnen). */
export interface RecordSettings {
  targetLaneId?: Id; // in welche Lane/Baustein aufgenommen wird
  quantize: TimeSignature | "off" | "1/4" | "1/8" | "1/16" | "1/32";
  overdub: boolean; // zu Bestehendem hinzufügen statt ersetzen
  countIn: boolean;
}

// ────────────────────────────────────────────────────────────────────────────
// WebSocket-Protokoll
// ────────────────────────────────────────────────────────────────────────────

/** UI → Server. */
export type Command =
  | { t: "transport.play" }
  | { t: "transport.stop" }
  | { t: "transport.setBpm"; bpm: number }
  | { t: "transport.tapTempo" }
  | { t: "transport.panic" } // All Notes Off / alle Devices
  | { t: "transport.setClockSource"; source: ClockSource }
  | { t: "transport.setFill"; active: boolean }
  | { t: "transport.setMetronome"; enabled: boolean }
  // ── Aufnahme ──
  // Linkt ein gelerntes Live-Control (i.d.R. kind="keyboard", siehe oben) live
  // an eine Melodie-Lane: solange die Wiedergabe läuft, werden Noten, die auf
  // dem Kanal des Controls ankommen, taktgenau in den ERSTEN Slot-Baustein der
  // Lane eingetragen (Step aus dem laufenden Clock-Puls, Note-Off setzt die
  // tatsächlich gehaltene Länge). Erneuter Aufruf mit selben Werten hebt die
  // Zuordnung wieder auf (Toggle) — Antwort über ServerEvent "record.armState".
  | { t: "record.arm"; controlId: Id; laneId: Id }
  | { t: "record.start" }
  | { t: "record.stop" }
  | { t: "record.setSettings"; settings: RecordSettings }
  // ── Undo/Redo & Zwischenablage ──
  | { t: "edit.undo" }
  | { t: "edit.redo" }
  | { t: "block.copy"; blockId: Id }
  | { t: "block.paste"; deviceId: Id; slot: BlockSlotId }
  | { t: "lane.copy"; laneId: Id }
  | { t: "lane.paste"; deviceId: Id }
  // ── Lane-Management ──
  | { t: "lane.create"; deviceId: Id; role: LaneRole; name?: string }
  | { t: "lane.duplicate"; laneId: Id }
  | { t: "lane.delete"; laneId: Id }
  | { t: "lane.rename"; laneId: Id; name: string }
  | { t: "lane.reorder"; deviceId: Id; orderedLaneIds: Id[] }
  | { t: "lane.setRole"; laneId: Id; role: LaneRole }
  | { t: "lane.setColor"; laneId: Id; color: string }
  | { t: "lane.setChannel"; laneId: Id; channel: MidiChannel } // MIDI-Kanal 1–16 dieser Lane
  | { t: "lane.setCcControl"; laneId: Id; controlId: Id | null } // CC-Lane: Ziel-Knob (nur Knobs desselben Geräts); null löst das Ziel
  | { t: "lane.setEnabled"; laneId: Id; enabled: boolean }
  | { t: "lane.setVisible"; laneId: Id; visible: boolean }
  | { t: "lane.setMuted"; laneId: Id; muted: boolean }
  | { t: "lane.setSolo"; laneId: Id; solo: boolean }
  | { t: "lane.setCollapsed"; laneId: Id; collapsed: boolean }
  | { t: "lane.setHeight"; laneId: Id; height: number }
  | { t: "lane.setPlayMode"; laneId: Id; mode: LanePlayMode }
  | { t: "lane.setTriggerQuantize"; laneId: Id; quantize: TriggerQuantize }
  | { t: "lane.setSwing"; laneId: Id; swing?: number }
  | { t: "lane.setHumanize"; laneId: Id; timing?: number; velocity?: number }
  // ── Lane-Controls (Schnellbedienung) ──
  // `add` schickt ein Control ohne `id`/`order` — der Server vergibt beides
  // (uuid, nächster Index). `update` patcht nur die übergebenen Felder.
  | { t: "laneControl.add"; laneId: Id; control: Omit<LaneControl, "id" | "order"> }
  | { t: "laneControl.update"; laneId: Id; controlId: Id; patch: Partial<LaneControl> }
  | { t: "laneControl.remove"; laneId: Id; controlId: Id }
  | { t: "laneControl.reorder"; laneId: Id; orderedControlIds: Id[] }
  | { t: "laneControl.press"; laneId: Id; controlId: Id } // Touch-Down (momentary/toggle/oneShot)
  | { t: "laneControl.release"; laneId: Id; controlId: Id } // Touch-Up (momentary)
  | { t: "laneControl.setValue"; laneId: Id; controlId: Id; value: number } // Macro-Knob
  // ── Slots in Lanes ──
  | { t: "laneSlot.add"; laneId: Id; blockId: Id }
  | { t: "laneSlot.remove"; laneId: Id; slotId: Id }
  | { t: "laneSlot.setBlock"; laneId: Id; slotId: Id; blockId: Id } // Slot behält transpose/speed/loopMode, nur blockId wechselt (Baustein tauschen)
  | { t: "laneSlot.reorder"; laneId: Id; orderedSlotIds: Id[] }
  // ── Bausteine ──
  | { t: "block.trigger"; laneId: Id; slotId: Id }
  | { t: "block.press"; laneId: Id; slotId: Id } // Touch-Down bei playMode "hold"/"oneShot": Baustein starten
  | { t: "block.release"; laneId: Id; slotId: Id } // Touch-Up bei playMode "hold": Baustein stoppen + Noten aus
  | { t: "block.rename"; blockId: Id; name: string } // max. 6 Zeichen (BLOCK_NAME_MAX_LENGTH)
  | { t: "block.createAt"; deviceId: Id; blockType: BlockType; row: number; col: number } // Baustein-Bibliothek: an gewählter Zelle anlegen (no-op falls belegt)
  | { t: "block.delete"; blockId: Id } // entfernt Baustein + räumt dangling Lane-Slot-Referenzen auf
  | { t: "block.move"; blockId: Id; row: number; col: number } // Baustein-Bibliothek: an andere Zelle verschieben (no-op falls belegt)
  | { t: "block.setTranspose"; laneId: Id; slotId: Id; transpose: number }
  | { t: "block.setSpeed"; laneId: Id; slotId: Id; speed: SpeedMultiplier }
  | { t: "block.setLoop"; laneId: Id; slotId: Id; loop: LoopMode; count?: number }
  | { t: "block.setStepMod"; blockId: Id; stepIndex: number; mod: StepMod }
  // Baustein-Raster ändern: Länge in Takten (`lengthBars`) und/oder Auflösung
  // (`stepsPerBar`, "Substeps pro Takt"). Weggelassene Felder bleiben, wie sie
  // sind. Der Server passt den INHALT mit an:
  //  • Auflösungswechsel skaliert Positionen und Längen mit (16→32 Steps hält
  //    die Musik an derselben Stelle, statt sie in den halben Takt zu quetschen),
  //  • Beat-Step-Arrays und Stepped-CC-Werte werden auf die neue Gesamtlänge
  //    gebracht (kürzen bzw. mit leeren Steps auffüllen),
  //  • Events hinter dem neuen Ende fallen weg.
  | { t: "block.setLength"; blockId: Id; lengthBars?: number; stepsPerBar?: number }
  // Generischer Skalarfeld-Setter für INHALTS-Felder eines Bausteins
  // (baseNote, direction, gateSteps, rateSteps, velocity, outMin/outMax, …) —
  // `value: null` löscht das Feld. Kanal/CC-Ziel gehören NICHT hierher, die
  // sitzen an der Lane (siehe lane.setChannel / lane.setCcControl).
  | { t: "block.setField"; blockId: Id; field: string; value: unknown }
  | { t: "beat.setLineMuted"; blockId: Id; lineId: Id; muted: boolean }
  | { t: "beat.setLineNote"; blockId: Id; lineId: Id; note: MidiNote } // welche MIDI-Note diese Drum-Line auslöst (z.B. 36 = Kick am TR-6S)
  | { t: "beat.setEuclid"; blockId: Id; lineId: Id; euclid: EuclidConfig }
  // Neue Note an Step hinzufügen — Steps können mehrere gleichzeitige Noten
  // tragen (Akkord-Stack). Gibt es die Tonhöhe an diesem Step schon, entsteht
  // KEIN zweiter Eintrag: mitgeschickte velocity/lengthSteps schreiben die
  // vorhandene Note um, ohne beide bleibt sie unverändert. `velocity` und
  // `lengthSteps` schickt vor allem das Einspielen über die Piano-Rolle mit
  // (s. "noteInput.listen"), wo Anschlag und Notenlänge schon feststehen.
  | { t: "melody.addNote"; blockId: Id; step: number; note: MidiNote; velocity?: Midi7Bit; lengthSteps?: number }
  | { t: "melody.removeNote"; blockId: Id; step: number; note: MidiNote } // eine bestimmte Note an einem Step entfernen, identifiziert über (step, Tonhöhe)
  | { t: "melody.setNotePitch"; blockId: Id; step: number; note: MidiNote; newNote: MidiNote } // Tonhöhe einer bestehenden Note ändern (identifiziert über die alte Tonhöhe)
  | { t: "melody.setNoteLength"; blockId: Id; step: number; note: MidiNote; lengthSteps: number } // Dauer einer bestimmten Note am Step (Note-Off entsprechend später)
  | { t: "melody.setNoteVelocity"; blockId: Id; step: number; note: MidiNote; velocity: Midi7Bit } // Anschlagstärke einer bestimmten Note am Step (1–127; 0 wäre ein Note-Off)
  // Melodie-Editor: Piano-Rolle auf Eingabe schalten ("Play in"). Solange ein
  // Baustein armiert ist, meldet der Server JEDE Note JEDES MIDI-Eingangs als
  // "noteInput.note" an die UI — der Editor trägt sie an seinem Schreib-Cursor
  // ein — und spielt sie zugleich auf dem Ziel des Bausteins mit. `blockId:
  // null` entwaffnet (und schickt Note-Offs für noch gehaltene Töne).
  | { t: "noteInput.listen"; blockId: Id | null }
  | { t: "block.previewNote"; blockId: Id; note: MidiNote; on: boolean; velocity?: Midi7Bit } // Baustein-Detail: Tonhöhe live anspielen (Klaviatur der Piano-Rolle). Ändert NICHTS am Projekt; Ziel ist die erste Lane, die den Baustein verwendet. on=false ist das zugehörige Note-Off
  | { t: "beat.toggleStep"; blockId: Id; lineId: Id; step: number } // Baustein-Detail: Step an/aus
  | { t: "chord.toggleNote"; blockId: Id; step: number; note: MidiNote } // Baustein-Detail: Note im Akkord an Step an/aus
  | { t: "arp.toggleNote"; blockId: Id; note: MidiNote } // Baustein-Detail: Note im Notenvorrat an/aus
  // CC-Layer-Verwaltung (mehrere Layer pro Block — LFO/Envelope/Ramp/Random/Stepped).
  | { t: "cc.addLayer"; blockId: Id; kind: CcLayerKind; steps?: number } // steps = Länge einer neuen Stepped-Layer
  | { t: "cc.removeLayer"; blockId: Id; layerId: Id }
  | { t: "cc.moveLayer"; blockId: Id; layerId: Id; dir: "up" | "down" }
  | { t: "cc.updateLayer"; blockId: Id; layerId: Id; patch: Partial<CcLayer> } // enabled/combine/depth/offset/waveform/…
  | { t: "cc.setStepValue"; blockId: Id; layerId: Id; step: number; value: number } // 0..1, Stepped-Layer
  | { t: "cc.setEnvelopePoint"; blockId: Id; layerId: Id; step: number; value: number | null } // 0..1; null löscht den Punkt
  | { t: "programChange.setEvent"; blockId: Id; step: number; program: number | null } // null löscht das Event
  | { t: "patternShift.setEvent"; blockId: Id; step: number; kind: MidiMessageKind | null; data1?: number; data2?: number } // kind=null löscht die Nachricht
  // ── Scenes ──
  | { t: "scene.create"; name: string }
  | { t: "scene.trigger"; sceneId: Id }
  | { t: "scene.update"; scene: Scene }
  | { t: "scene.delete"; sceneId: Id }
  // ── Song / Arrangement ──
  | { t: "song.create"; name: string }
  | { t: "song.update"; song: Song }
  | { t: "song.delete"; songId: Id }
  | { t: "song.play"; songId: Id }
  | { t: "song.stop" }
  // ── Routing-Hub ──
  | { t: "routing.addSource"; source: MidiInputSource }
  | { t: "routing.updateSource"; source: MidiInputSource }
  | { t: "routing.removeSource"; sourceId: Id }
  | { t: "routing.addRoute"; route: MidiRoute }
  | { t: "routing.updateRoute"; route: MidiRoute }
  | { t: "routing.removeRoute"; routeId: Id }
  | { t: "routing.setRouteEnabled"; routeId: Id; enabled: boolean }
  | { t: "routing.activateScene"; sceneId: Id } // Routing-Scene on-the-fly
  | { t: "routing.saveScene"; name: string }
  // ── Modulation ──
  | { t: "mod.addModulator"; modulator: GlobalModulator }
  | { t: "mod.updateModulator"; modulator: GlobalModulator }
  | { t: "mod.removeModulator"; modulatorId: Id }
  | { t: "mod.addRoute"; route: ModRoute }
  | { t: "mod.removeRoute"; routeId: Id }
  // ── Device & Profile ──
  | { t: "device.setSendClock"; deviceId: Id; sendClock: boolean }
  | { t: "device.setMuted"; deviceId: Id; muted: boolean } // Schnell-Mute des ganzen Geräts (alle Lanes schweigen, laufen aber weiter)
  | { t: "device.setProfile"; deviceId: Id; profileId?: Id }
  | { t: "device.setLatency"; deviceId: Id; latencyOffsetMs: number }
  | { t: "profile.create"; profile: DeviceProfile }
  | { t: "profile.update"; profile: DeviceProfile }
  | { t: "profile.delete"; profileId: Id }
  // ── Control-Snapshots ──
  | { t: "snapshot.save"; name: string }
  | { t: "snapshot.recall"; snapshotId: Id }
  | { t: "snapshot.delete"; snapshotId: Id }
  // ── Live-Controls & Projekt ──
  | { t: "control.setValue"; controlId: Id; value: number }
  | { t: "control.startLearn"; controlId: Id }
  | { t: "control.assignName"; controlId: Id; name: string }
  | { t: "control.setDevice"; controlId: Id; deviceId: Id | null } // Ziel-Device (Name erscheint am Button)
  | { t: "control.setKind"; controlId: Id; kind: ControlKind } // z.B. CC als Taster statt Regler reproduzieren
  | { t: "control.move"; controlId: Id; x: number; y: number }
  | { t: "control.delete"; controlId: Id }
  | { t: "control.press"; controlId: Id } // Touch-Down (Note-On/Program-Change)
  | { t: "control.release"; controlId: Id } // Touch-Up (Note-Off)
  | { t: "project.create"; name: string }
  | { t: "project.copy"; name: string } // dupliziert das GEÖFFNETE Projekt und wechselt hinein
  | { t: "project.load"; projectId: Id }
  | { t: "project.rename"; name: string }
  | { t: "project.delete"; projectId: Id }
  | { t: "project.list" } // Antwort: ServerEvent "project.list"
  | { t: "project.save" }
  // ── WLAN-Access-Point (nur auf dem Pi) ──
  // Der Pi kann sein eigenes WLAN aufspannen, damit man ohne vorhandenes Netz
  // per Handy/Laptop an die UI kommt. Antwort ist immer ServerEvent
  // "network.state" (bzw. "network.error" bei ungültiger Eingabe / Fehler).
  | { t: "network.getState" }
  // `ssid`: 1–32 Zeichen. `password`: leer = offenes Netz, sonst WPA2-PSK mit
  // 8–63 Zeichen. Achtung: Der Pi hat EIN WLAN-Radio — den AP einzuschalten
  // trennt jede andere WLAN-Verbindung des Pi (Ethernet-Uplink bleibt und wird
  // an die AP-Clients weitergereicht). Clients erreichen die UI dann unter
  // http://10.42.0.1:<port>.
  | { t: "network.setAp"; enabled: boolean; ssid: string; password: string };

/** Ein gespeichertes Projekt in der Projektliste (Zahnrad-Menü). `updatedAt`
 *  ist die Änderungszeit der Datei in Unix-Sekunden. */
export interface ProjectSummary {
  id: Id;
  name: string;
  updatedAt: number;
  deviceCount: number;
}

/** Server → UI. */
export type ServerEvent =
  | { t: "state.snapshot"; project: Project; transport: TransportState }
  | { t: "state.patch"; path: string; value: unknown }
  | { t: "transport.tick"; transport: TransportState }
  | { t: "learn.captured"; controlId: Id; mapping: MidiMapping }
  | { t: "record.captured"; laneId: Id; blockId: Id } // Aufnahme in Baustein geschrieben
  | { t: "noteInput.note"; blockId: Id; note: MidiNote; velocity: Midi7Bit; on: boolean } // Note eines angeschlossenen Keyboards, während die Piano-Rolle auf Eingabe steht
  | { t: "noteInput.armed"; blockId: Id | null } // aktueller Eingabe-Zustand der Piano-Rolle (null = niemand hört zu)
  | { t: "record.armState"; controlId: Id | null; laneId: Id | null } // aktueller Record-Arm-Zustand (beide null = nichts armiert)
  | { t: "routing.activity"; routeId: Id } // Route hat gerade Daten durchgeleitet (UI-Feedback)
  | { t: "midi.ports"; outputs: string[]; inputs: string[] }
  | { t: "project.list"; projects: ProjectSummary[]; currentId: Id } // beim Verbinden + nach jeder Projekt-Operation
  | { t: "control.sendError"; controlId?: Id; message: string } // MIDI konnte nicht gesendet werden (UI-Feedback)
  // Physisch am Gerät ausgelöste MIDI-Nachricht, die zu einem gelernten
  // Control passt — Dashboard hält Knopf/Regler live synchron (unabhängig
  // vom einmaligen MIDI-Learn-Vorgang, der ein Control erst anlegt).
  | { t: "control.valueChanged"; controlId: Id; value: Midi7Bit } // Regler physisch gedreht
  | { t: "control.activity"; controlId: Id; active: boolean } // Taster physisch gedrückt/losgelassen
  // WLAN-Access-Point: beim Verbinden, nach "network.getState" und nach jedem
  // "network.setAp". `supported` ist false, wo der privilegierte Helfer fehlt
  // (z.B. Mac-Dev) — die UI zeigt die Karte dann deaktiviert. `apEnabled` ist
  // der gespeicherte Soll-Zustand, `active` ob der AP gerade wirklich läuft.
  // `password` kommt bewusst mit zurück, damit der Kiosk ihn (und den
  // Beitritts-QR-Code) anzeigen kann.
  | {
      t: "network.state";
      supported: boolean;
      apEnabled: boolean;
      ssid: string;
      password: string;
      apAddress: string; // i.d.R. "10.42.0.1"
      port: number;
      active: boolean;
    }
  | { t: "network.error"; message: string }; // ungültige Eingabe oder Helfer-Fehler
