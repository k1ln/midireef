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
  rateBars?: number; // lfo
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
  channel?: number; // Kanal-Override, sonst Lane/Device-Kanal
  baseNote?: number; // melody, chord, arp
  notes?: MelodyNote[]; // melody
  lines?: BeatLine[]; // beat
  chords?: ChordEvent[]; // chord
  chordNotes?: number[]; // arp
  direction?: string; // arp
  gateSteps?: number; // arp
  rateSteps?: number; // arp
  velocity?: number; // arp
  ccNumber?: number; // cc
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

export interface MacroKnobControl {
  id: string;
  kind: "macroKnob";
  label: string;
  color?: string;
  order: number;
  ccNumber: number;
  min: number;
  max: number;
  value: number;
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

export class Store {
  project?: Project;
  transport?: TransportState;
  midiOutputs: string[] = [];
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
}
