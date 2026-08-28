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
  baseNote?: number; // melody, chord, arp
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

export type LaneControl = NoteControl | DrumButtonControl | MidiSignalControl | MacroKnobControl;

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
  channel?: number; // Kanal-Override, sonst Device-Kanal
  ccControlId?: string | null; // cc-Lane: Ziel-Knob (LiveControl-Id desselben Geräts)
  slots: Slot[];
  controls: LaneControl[];
}

export interface Device {
  id: string;
  name: string;
  midiOutPort: string;
  channel: number;
  transpose: number;
  sendClock: boolean;
  latencyOffsetMs: number;
  lanes: Lane[];
  blocks: Block[];
}

export interface Project {
  id: string;
  name: string;
  bpm: number;
  devices: Device[];
  [key: string]: unknown;
}

type Listener = () => void;

export interface RecordArm {
  controlId: string;
  laneId: string;
}

export class Store {
  project?: Project;
  transport?: TransportState;
  midiOutputs: string[] = [];
  /** Which keyboard control is currently linked to which melody lane for
   *  live recording (`record.arm`) — null when nothing is armed. */
  recordArmed: RecordArm | null = null;
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

  setPorts(outputs: string[]) {
    this.midiOutputs = outputs;
    this.emit();
  }

  setRecordArmed(arm: RecordArm | null) {
    this.recordArmed = arm;
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
