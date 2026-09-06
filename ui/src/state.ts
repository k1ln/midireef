//! Kleiner State-Store: hält das aktuelle Projekt + Transport und benachrichtigt
//! Abonnenten bei Änderungen.

import type { TransportState } from "./net";

export type BlockType = "melody" | "beat" | "cc" | "programChange" | "patternShift" | "chord" | "arp";

export interface Slot {
  id: string;
  blockId: string;
  transpose: number;
  speed: number;
  loopMode: string;
  loopCount?: number; // nur bei loopMode === "count"
}

export interface MelodyNote {
  step: number;
  lengthSteps: number;
  note: number;
  velocity: number;
}

export interface BeatStep {
  velocity: number;
}

export interface BeatLine {
  id: string;
  name: string;
  note: number;
  muted: boolean;
  steps: BeatStep[];
}

export interface ChordEvent {
  step: number;
  lengthSteps: number;
  notes: number[];
  velocity: number;
}

export interface CcEnvelopePoint {
  step: number;
  value: number; // 0..1
}

export type CcLayer = {
  id: string;
  kind: string; // "lfo" | "envelope" | "ramp" | "random" | "stepped"
  enabled: boolean;
  combine: string; // "add" | "multiply" | "max" | "min" | "replace"
  depth: number; // 0..1
  offset: number; // -1..1
  values?: number[]; // stepped: 0..1 per step
  points?: CcEnvelopePoint[]; // envelope
  waveform?: string; // lfo
  rateMode?: string; // lfo: "bars" | "hz"
  rateBars?: number; // lfo
  rateHz?: number; // lfo, rateMode="hz"
  phase?: number; // lfo, 0..1
  rateKeyTrack?: number; // lfo: Rate folgt der auslösenden Note (0 = aus, 1 = ×2/Oktave)
  from?: number; // ramp, 0..1
  to?: number; // ramp, 0..1
  everySteps?: number; // random
  smooth?: boolean; // random
};

export interface ProgramChangeEvent {
  atStep: number;
  program: number;
  bankMsb?: number;
  bankLsb?: number;
}

export interface PatternMessage {
  atStep: number;
  kind: string;
  data1: number;
  data2?: number;
  value14?: number;
}

export interface BlockSlotId {
  type: string;
  row: number; // 1-9
  col: number; // 1-9
}

export interface Block {
  id: string;
  type: string;
  name: string;
  slot?: BlockSlotId;
  lengthBars?: number;
  stepsPerBar?: number;
  timeSignature?: string;
  // Kein channel/CC-Ziel: ein Baustein ist reiner Inhalt und in mehreren Lanes
  // (auf anderen Kanälen/CCs) wiederverwendbar — das Ziel legt die Lane fest.
  baseNote?: number; // chord, arp
  notes?: MelodyNote[]; // melody
  lines?: BeatLine[]; // beat
  chords?: ChordEvent[]; // chord
  chordNotes?: number[]; // arp
  direction?: string; // arp
  gateSteps?: number; // arp
  rateSteps?: number; // arp
  velocity?: number; // arp
  outMin?: number; // cc
  outMax?: number; // cc
  destructive?: boolean; // cc: false/undef = Ziel kehrt am Blockende zur Ruhelage zurück
  layers?: CcLayer[]; // cc
  events?: ProgramChangeEvent[]; // programChange
  messages?: PatternMessage[]; // patternShift
}

export interface NoteControl {
  id: string;
  kind: "note";
  label: string;
  color?: string;
  order: number;
  note: number;
  velocity: number;
  trigger: string;
}

export interface DrumButtonControl {
  id: string;
  kind: "drumButton";
  label: string;
  color?: string;
  order: number;
  action: "trigger" | "muteToggle";
  note: number;
  velocity: number;
  targetBlockId?: string;
  targetLineId?: string;
}

export interface MidiSignalControl {
  id: string;
  kind: "midiSignal";
  label: string;
  color?: string;
  order: number;
  message: PatternMessage;
  trigger: string;
}

/** Fernbedienung für einen gelernten Dashboard-Knob desselben Geräts —
 *  Wert/Kanal/CC-Nummer liegen dort (Project.controls), nicht hier. */
export interface MacroKnobControl {
  id: string;
  kind: "macroKnob";
  label: string;
  color?: string;
  order: number;
  controlId: string;
}

/** Beat-Repeat/Stutter: hold down to freeze the lane on a loop of its last
 *  `steps` steps, release to continue exactly where it was (see
 *  `Engine::press_repeat` / `release_repeat` in server/src/engine.rs). */
export interface BeatRepeatControl {
  id: string;
  kind: "beatRepeat";
  label: string;
  color?: string;
  order: number;
  /** In steps of the block's OWN resolution, not absolute pulses — "1" is
   *  always "the most recent step," whatever grid the running block uses. */
  steps: number;
}

/** Manual roll: hold down to retrigger `note` at a fixed rate (independent
 *  of the pattern's own steps), release to stop — a finger-drumming roll. */
export interface RollControl {
  id: string;
  kind: "roll";
  label: string;
  color?: string;
  order: number;
  note: number;
  velocity: number;
  /** Hits per quarter note — 4 = sixteenths, 8 = thirty-seconds, … */
  rateDiv: number;
}

/** Scatter/Glitch: hold down to make every step-trigger on this lane read a
 *  RANDOM step's content instead of its own — timing stays exactly on the
 *  grid, only the content glitches. Release returns to normal. */
export interface ScatterControl {
  id: string;
  kind: "scatter";
  label: string;
  color?: string;
  order: number;
}

export type LaneControl =
  | NoteControl
  | DrumButtonControl
  | MidiSignalControl
  | MacroKnobControl
  | BeatRepeatControl
  | RollControl
  | ScatterControl;

export interface Lane {
  id: string;
  name: string;
  role: string;
  color?: string;
  enabled: boolean;
  visible: boolean;
  muted: boolean;
  solo: boolean;
  collapsed: boolean;
  height: number;
  playMode: string;
  triggerQuantize: string;
  channel: number; // MIDI-Kanal 1–16 dieser Lane
  ccControlId?: string | null; // cc-Lane: Ziel-Knob (LiveControl-Id desselben Geräts)
  /** Trigger-Kette: wird ein Slot dieser Lane ausgelöst, feuert (laneId, slotId) mit. */
  chainSlot?: { laneId: string; slotId: string } | null;
  /** cc-Lane: eine Melodie-Lane, deren gespielte Noten das LFO-Key-Tracking
   *  (rateKeyTrack) dieser Lane treiben — Alternative zum externen MIDI-
   *  Trigger. Nur Melodie-Lanes sind ein gültiges Ziel. */
  keytrackSourceLaneId?: string | null;
  /** Zusätzlich zum Keytrack: soll die Quell-Lane diese (Hold/OneShot-)Lane
   *  auch starten/halten, statt nur ihre Rate zu treiben — wie ein externer
   *  MIDI-Trigger, nur ohne MIDI-In. Unabhängig von `keytrackSourceLaneId`
   *  schaltbar. */
  keytrackSourceStarts?: boolean;
  /** Swing 0..1 nur für diese Lane — überschreibt den Projekt-Default.
   *  `undefined` = Projekt-Default gilt. */
  swing?: number;
  /** Humanize: leichte Zufallsstreuung von Timing/Velocity (0..1), je
   *  unabhängig schaltbar. `undefined` = aus. */
  humanizeTiming?: number;
  humanizeVelocity?: number;
  /** Note-Echo/Delay: abklingende Wiederholungen jeder gespielten Note.
   *  `undefined` = aus. */
  echo?: { repeats: number; rateDiv: number; decay: number };
  /** Glide/Portamento — sends CC65 (on/off) + CC5 (time) to the synth once
   *  when toggled; the synth glides legato notes itself. `undefined` = never
   *  set (synth default applies). */
  glide?: { enabled: boolean; timeCc: number };
  slots: Slot[];
  controls: LaneControl[];
}

export interface Device {
  id: string;
  name: string;
  midiOutPort: string;
  sendClock: boolean;
  muted?: boolean;
  latencyOffsetMs: number;
  lanes: Lane[];
}

/** Ein Scene-Ziel: auf einer Lane entweder einen Slot triggern (ohne `slotId`
 *  greift der gerade aktive/erste Slot) oder die Lane stoppen. */
export interface SceneTarget {
  laneId: string;
  action: "trigger" | "stop";
  slotId?: string;
}

/** Mehrere Lanes/Devices mit einem Touch starten/stoppen (Screen: Scenes). */
export interface Scene {
  id: string;
  name: string;
  color?: string;
  targets: SceneTarget[];
}

/** Ein Step in einem `Song`: spielt `sceneId` für `bars` Takte, mit optionaler
 *  Tempo-/Taktart-Automation. Fortschaltung passiert serverseitig. */
export interface SongStep {
  id: string;
  sceneId: string;
  bars: number;
  bpmOverride?: number;
  timeSignatureOverride?: string;
}

/** Scenes zu einem Track verketten (Screen: Song, Tab neben Scenes). */
export interface Song {
  id: string;
  name: string;
  steps: SongStep[];
  loop: boolean;
}

/** Ein physischer MIDI-Eingang (externer Controller), benennbar. */
export interface MidiInputSource {
  id: string;
  name: string;
  port: string;
  channelFilter?: number;
}

export interface CcRemapEntry {
  from: number;
  to: number;
}

export interface RouteTransform {
  deviceId: string;
  channel?: number;
  noteTranspose?: number;
  velocityScale?: number;
  ccRemap?: CcRemapEntry[];
}

export type MidiMessageKind = "note" | "cc" | "pitchBend" | "aftertouch" | "programChange";

/** Leitet gefilterte MIDI-Nachrichten einer Quelle live an ein Device — der
 *  Kern des Routing-Hubs (Controller ohne Kabelwechsel umschalten). */
export interface MidiRoute {
  id: string;
  name: string;
  enabled: boolean;
  sourceId: string;
  messageFilter: MidiMessageKind[] | "all";
  ccFilter?: number[];
  noteRange?: { low: number; high: number };
  transform: RouteTransform;
}

/** Aktiviert eine bestimmte Menge Routen auf Knopfdruck (z.B. "alle
 *  Controller → Synth B") ohne Kabel/Re-Learn. */
export interface RoutingScene {
  id: string;
  name: string;
  activeRouteIds: string[];
}

export interface RoutingHub {
  sources: MidiInputSource[];
  routes: MidiRoute[];
  scenes: RoutingScene[];
  activeSceneId?: string;
}

export type LfoWaveform = "sine" | "triangle" | "sawUp" | "sawDown" | "square";

/** Globaler LFO, auf mehrere Ziele routbar — anders als eine CC-Baustein-Layer
 *  läuft er unabhängig von jeder Lane immer mit, taktsynchron. */
export interface GlobalModulator {
  id: string;
  name: string;
  waveform: LfoWaveform;
  rateBars: number;
  phase: number;
  bipolar: boolean;
}

/** Ein Ziel, das ein globaler Modulator ansteuert — mehrere Routes derselben
 *  Modulator-Id sind der "Multi-Parameter-Macro-Knob". */
export interface ModRoute {
  id: string;
  modulatorId: string;
  deviceId: string;
  ccNumber: number;
  channel?: number;
  depth: number; // -1..1
}

export interface Project {
  id: string;
  name: string;
  bpm: number;
  devices: Device[];
  /** Projektweite Baustein-Bibliothek (9×9-Raster pro Typ). Bausteine sind
   *  reiner Inhalt und in jeder Lane jedes Geräts einsetzbar. */
  blocks: Block[];
  [key: string]: unknown;
}

type Listener = () => void;

export interface RecordArm {
  controlId: string;
  laneId: string;
}

/** Zustand des Pi-WLAN-Access-Points (Einstellungen → „Wi-Fi access point").
 *  Spiegelt das ServerEvent `network.state`. `supported` ist false, wo der
 *  privilegierte Helfer fehlt (Mac-Dev) — die Karte ist dann deaktiviert. */
export interface NetworkState {
  supported: boolean;
  apEnabled: boolean;
  ssid: string;
  password: string;
  apAddress: string;
  port: number;
  active: boolean;
}

/** Zustand der Kiosk-Bildschirmdrehung (Einstellungen → „Display"). Spiegelt
 *  das ServerEvent `display.state`. `supported` ist false, wo der Helfer
 *  fehlt (Mac-Dev) — die Karte ist dann deaktiviert. */
export interface DisplayState {
  supported: boolean;
  rotated: boolean;
}

/** Zustand der GitHub-Backup-Verbindung (Einstellungen → „GitHub backup").
 *  Spiegelt das ServerEvent `github.config` — das Token selbst kommt NIE mit,
 *  nur ob eins hinterlegt ist. */
export interface GithubState {
  configured: boolean;
  owner: string;
  repo: string;
  branch: string;
}

export class Store {
  project?: Project;
  transport?: TransportState;
  midiOutputs: string[] = [];
  midiInputs: string[] = [];
  /** Which keyboard control is currently linked to which melody lane for
   *  live recording (`record.arm`) — null when nothing is armed. */
  recordArmed: RecordArm | null = null;
  /** Latest `network.state` from the server — null until it first arrives. */
  network: NetworkState | null = null;
  /** Latest `display.state` from the server — null until it first arrives. */
  display: DisplayState | null = null;
  /** Latest `github.config` from the server — null until it first arrives. */
  github: GithubState | null = null;
  private listeners: Listener[] = [];

  /** Returns an unsubscribe function — React components mount/unmount
   *  (unlike the old long-lived Pixi screens), so callers must clean up. */
  subscribe(fn: Listener): () => void {
    this.listeners.push(fn);
    return () => {
      const i = this.listeners.indexOf(fn);
      if (i !== -1) this.listeners.splice(i, 1);
    };
  }

  private emit() {
    for (const l of this.listeners) l();
  }

  setProject(p: Project) {
    this.project = p;
    this.emit();
  }

  setTransport(t: TransportState) {
    this.transport = t;
  }

  setPorts(outputs: string[], inputs?: string[]) {
    this.midiOutputs = outputs;
    if (inputs) this.midiInputs = inputs;
    this.emit();
  }

  setRecordArmed(arm: RecordArm | null) {
    this.recordArmed = arm;
    this.emit();
  }

  setNetwork(n: NetworkState) {
    this.network = n;
    this.emit();
  }

  setDisplay(d: DisplayState) {
    this.display = d;
    this.emit();
  }

  setGithub(g: GithubState) {
    this.github = g;
    this.emit();
  }

  /** Patches a single field of a Live-Control (dashboard `controls` array)
   *  in place — e.g. `value` when a physically turned knob reports back via
   *  `control.valueChanged`. Rebuilds project/controls/control as new object
   *  references (not just mutating in place) so `useSyncExternalStore`
   *  selectors in Dashboard/ControlWidget actually see a change and re-render. */
  patchControl(controlId: string, patch: Record<string, unknown>) {
    if (!this.project) return;
    const controls = (this.project.controls as Array<Record<string, unknown>> | undefined) ?? [];
    const idx = controls.findIndex((c) => c.id === controlId);
    if (idx === -1) return;
    const newControls = controls.slice();
    newControls[idx] = { ...newControls[idx], ...patch };
    this.project = { ...this.project, controls: newControls };
    this.emit();
  }
}
