//! Block Detail editors — React port of the per-type editor methods in
//! ui/blockdetail.ts (beatEditor, chordEditor, arpEditor, programChangeEditor,
//! patternShiftEditor). Melodie und CC haben eigene Dateien (MelodyEditor mit
//! seinen zwei Ansichten, CcEditor mit fünf Layer-Arten).
//!
//! Alle Raster laufen über `StepBars`: das legt die Steps je nach `flow`
//! entweder in eine lange scrollbare Reihe oder taktweise untereinander.

import { useState } from "react";
import type { Block, BeatLine } from "../../state";
import { useSend } from "../store";
import { noteName, useNotePicker } from "../NotePicker";
import { Button } from "../widgets/Button";
import { Popup } from "../widgets/Popup";
import { StepScroller, StepBars, StepCell, ROLL_LOW_NOTE, ROLL_HIGH_NOTE, type StepFlow } from "./StepGrid";
import { useNumberEditor, useSetField } from "../useNumberEditor";
import { useWheelPicker } from "../widgets/WheelPicker";
import { useLongPress } from "../useLongPress";
import { useTouchKeyboard } from "../TouchKeyboard";

/** Zellgröße der Beat-Zeilen — dieselbe wie die Piano-Rolle (s. MelodyEditor),
 *  damit ein Finger auf dem Touchdisplay auch hier sicher trifft (s. Nutzer-
 *  Feedback: "same sizes as melody"). */
const BEAT_CELL = 64;

const DIRECTIONS = ["up", "down", "upDown", "random", "asPlayed"];
const MSG_KINDS = ["programChange", "cc", "note"];

// ── Beat: Step-Grid pro Line ────────────────────────────────────────────────

export function BeatEditor({ block, flow }: { block: Block; flow: StepFlow }) {
  const send = useSend();
  const openNotePicker = useNotePicker();
  const stepsPerBar = block.stepsPerBar ?? 16;
  const totalSteps = stepsPerBar * (block.lengthBars ?? 1);
  const lines = block.lines ?? [];

  // Zeilennamen links; bei taktweisem Layout wiederholt StepBars sie je Takt,
  // damit man auch in Takt 3 noch weiß, welche Zeile die Snare ist.
  //   • Name antippen      → umbenennen (Tastatur)
  //   • Name lang drücken  → "lernen", welche MIDI-Note diese Line schickt
  //     (derselbe Note-Picker wie vorher, nur nicht mehr hinter einem Tipper
  //     versteckt, der jetzt fürs Umbenennen gebraucht wird)
  const names = (
    <>
      <div style={{ height: 20 }} />
      {lines.map((line) => (
        <BeatLineLabel key={line.id} block={block} line={line} openNotePicker={openNotePicker} send={send} />
      ))}
    </>
  );

  return (
    <StepBars totalSteps={totalSteps} stepsPerBar={stepsPerBar} cellW={BEAT_CELL} flow={flow} leftColumn={names} leftWidth={150}>
      {(steps) =>
        lines.map((line) => (
          <div key={line.id} className="step-row">
            {steps.map((step) => {
              const on = (line.steps[step]?.velocity ?? 0) > 0;
              // Runden, weil stepsPerBar frei wählbar ist (6, 12, 24 …) und
              // ein krummer Divisor sonst nie oder fast überall trifft.
              const beatMarker = step % Math.max(1, Math.round(stepsPerBar / 4)) === 0;
              return (
                <div
                  key={step}
                  className="step-cell"
                  style={{
                    width: BEAT_CELL,
                    height: BEAT_CELL,
                    // Deckend abgestuft (kein `opacity`): stumme Line dunkler,
                    // Beat-Marker etwas dunkler als die Zwischen-Steps.
                    background: on
                      ? "var(--pal-btn-active)"
                      : line.muted
                        ? "var(--pal-step-off-muted)"
                        : beatMarker
                          ? "var(--pal-step-off-beat)"
                          : "var(--pal-step-off)",
                  }}
                  onClick={() => send({ t: "beat.toggleStep", blockId: block.id, lineId: line.id, step })}
                />
              );
            })}
          </div>
        ))
      }
    </StepBars>
  );
}

/** Eine Zeilenbeschriftung der Beat-Rolle. Eigene Komponente nur, weil
 *  `useLongPress`/`useTouchKeyboard` Hooks sind und deshalb nicht in der
 *  Zeilen-Schleife stehen dürfen. */
function BeatLineLabel({
  block,
  line,
  openNotePicker,
  send,
}: {
  block: Block;
  line: BeatLine;
  openNotePicker: ReturnType<typeof useNotePicker>;
  send: ReturnType<typeof useSend>;
}) {
  const openKeyboard = useTouchKeyboard();
  const press = useLongPress(
    () => openNotePicker(line.note, (n) => send({ t: "beat.setLineNote", blockId: block.id, lineId: line.id, note: n })),
    () =>
      openKeyboard(line.name, 16, (v) => {
        if (v) send({ t: "beat.setLineName", blockId: block.id, lineId: line.id, name: v });
      }),
  );

  return (
    <div style={{ height: BEAT_CELL, display: "flex", flexDirection: "column", justifyContent: "center", gap: 4 }}>
      <span
        {...press}
        title="Tap to rename, long-press to set which MIDI note plays this line"
        style={{
          fontSize: 17,
          fontWeight: 700,
          cursor: "pointer",
          color: line.muted ? "var(--pal-text-dim)" : "var(--pal-text)",
          touchAction: "manipulation",
        }}
      >
        {line.name}
      </span>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: "var(--pal-text-dim)" }}>
          ♪ {noteName(line.note)} ({line.note})
        </span>
        <span
          style={{
            fontSize: 10,
            fontWeight: 700,
            cursor: "pointer",
            color: line.muted ? "var(--pal-danger)" : "var(--pal-text-dim)",
          }}
          onClick={() => send({ t: "beat.setLineMuted", blockId: block.id, lineId: line.id, muted: !line.muted })}
        >
          {line.muted ? "MUTED" : "mute"}
        </span>
      </div>
    </div>
  );
}

// ── Chord: Piano-Roll wie Melodie, aber mehrere Noten pro Step ─────────────

export function ChordEditor({ block, flow }: { block: Block; flow: StepFlow }) {
  const send = useSend();
  const wheel = useWheelPicker();
  const setField = useSetField();
  const stepsPerBar = block.stepsPerBar ?? 16;
  const totalSteps = stepsPerBar * (block.lengthBars ?? 1);
  const base = block.baseNote ?? 60;
  const chords = block.chords ?? [];
  const hasNote = (step: number, note: number) => chords.some((c) => c.step === step && c.notes.includes(note));

  // Volle MIDI-Skala wie in der Melodie-Rolle (s. MelodyGrid), auf den Rest
  // des Screens gestreckt und senkrecht scrollbar — der Ausschnitt startet
  // auf der Grundnote.
  const rows: number[] = [];
  for (let note = ROLL_HIGH_NOTE; note >= ROLL_LOW_NOTE; note--) rows.push(note);

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <Button
        style={{ width: 150, height: 30, fontSize: 13, marginBottom: 16 }}
        onClick={() =>
          wheel({ title: "Base note", min: 0, max: 127, value: base, format: (v) => `${noteName(v)} (${v})`, onPick: (n) => setField(block.id, "baseNote", n) })
        }
      >
        Base {noteName(base)}
      </Button>

      <StepBars totalSteps={totalSteps} stepsPerBar={stepsPerBar} cellW={34} flow={flow} fillHeight>
        {(steps) =>
          rows.map((note) => {
            const isC = ((note % 12) + 12) % 12 === 0;
            return (
              <div
                key={note}
                className="step-row roll-row"
                data-roll-center={note === base ? "" : undefined}
                style={{ background: isC ? "var(--pal-panel-deep)" : "var(--pal-panel)" }}
              >
                {steps.map((step) => {
                  const on = hasNote(step, note);
                  return (
                    <div
                      key={step}
                      className="step-cell"
                      style={{
                        width: 32,
                        height: 20,
                        background: on ? "var(--pal-btn-active)" : "var(--pal-step-off)",
                      }}
                      onClick={() => send({ t: "chord.toggleNote", blockId: block.id, step, note })}
                    />
                  );
                })}
              </div>
            );
          })
        }
      </StepBars>
    </div>
  );
}

// ── Arp: Notenvorrat-Strip + Parameter ──────────────────────────────────────

export function ArpEditor({ block }: { block: Block }) {
  const send = useSend();
  const wheel = useWheelPicker();
  const setField = useSetField();
  const base = block.baseNote ?? 60;
  const low = base - 12;
  const high = base + 12;
  const chordNotes = block.chordNotes ?? [];
  const direction = block.direction ?? "up";
  const gateSteps = block.gateSteps ?? 1;
  const rateSteps = block.rateSteps ?? 1;
  const velocity = block.velocity ?? 100;
  const driftIndex = block.driftIndex ?? 0;
  const driftAmount = block.driftAmount ?? 0;
  const maxDriftIndex = Math.max(0, chordNotes.length - 1);

  const notes: number[] = [];
  for (let n = low; n <= high; n++) notes.push(n);

  return (
    <div>
      <div style={{ fontSize: 13, color: "var(--pal-text-dim)", marginBottom: 8 }}>Note pool (tap = on/off):</div>
      <StepScroller>
        <div className="step-row">
          {notes.map((note) => {
            const on = chordNotes.includes(note);
            return (
              <StepCell key={note} width={34} height={26} active={on} onClick={() => send({ t: "arp.toggleNote", blockId: block.id, note })} />
            );
          })}
        </div>
        <div className="step-row">
          {notes.map((note) => (
            <div key={note} style={{ width: 34, flexShrink: 0, fontSize: 9, color: note === base ? "var(--pal-white)" : "var(--pal-text-dim)", fontWeight: note === base ? 700 : 400 }}>
              {noteName(note)}
            </div>
          ))}
        </div>
      </StepScroller>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginTop: 20 }}>
        <Button
          style={{ width: 150, height: 34, fontSize: 14 }}
          onClick={() =>
            wheel({ title: "Base note", min: 0, max: 127, value: base, format: (v) => `${noteName(v)} (${v})`, onPick: (n) => setField(block.id, "baseNote", n) })
          }
        >
          Base {noteName(base)}
        </Button>
        <Button
          style={{ width: 170, height: 34, fontSize: 14 }}
          onClick={() => setField(block.id, "direction", DIRECTIONS[(DIRECTIONS.indexOf(direction) + 1) % DIRECTIONS.length])}
        >
          Dir: {direction}
        </Button>
        <Button
          style={{ width: 120, height: 34, fontSize: 14 }}
          onClick={() => wheel({ title: "Gate", min: 1, max: 64, unit: " step(s)", value: gateSteps, onPick: (n) => setField(block.id, "gateSteps", n) })}
        >
          Gate {gateSteps}
        </Button>
        <Button
          style={{ width: 120, height: 34, fontSize: 14 }}
          onClick={() => wheel({ title: "Rate", min: 1, max: 64, unit: " step(s)", value: rateSteps, onPick: (n) => setField(block.id, "rateSteps", n) })}
        >
          Rate {rateSteps}
        </Button>
        <Button
          style={{ width: 120, height: 34, fontSize: 14 }}
          onClick={() => wheel({ title: "Velocity", min: 1, max: 127, value: velocity, onPick: (n) => setField(block.id, "velocity", n) })}
        >
          Vel {velocity}
        </Button>
      </div>

      <div style={{ fontSize: 13, color: "var(--pal-text-dim)", marginTop: 20, marginBottom: 8 }}>
        Drift — one note in the cycle slips a few steps further every time the block loops, so the pattern slowly goes crooked before it wraps back:
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
        <Button
          style={{ width: 150, height: 34, fontSize: 14 }}
          onClick={() =>
            wheel({ title: "Drift note", min: 0, max: maxDriftIndex, value: Math.min(driftIndex, maxDriftIndex), format: (v) => `note #${v + 1}`, onPick: (n) => setField(block.id, "driftIndex", n) })
          }
        >
          Drift note #{driftIndex + 1}
        </Button>
        <Button
          style={{ width: 170, height: 34, fontSize: 14 }}
          onClick={() =>
            wheel({ title: "Drift amount", min: -16, max: 16, unit: " step(s)/loop", value: driftAmount, onPick: (n) => setField(block.id, "driftAmount", n) })
          }
        >
          Drift {driftAmount === 0 ? "off" : `${driftAmount > 0 ? "+" : ""}${driftAmount}/loop`}
        </Button>
      </div>
    </div>
  );
}

// ── Program-Change: Step-Reihe mit Programm-Nummer je Event ────────────────

export function ProgramChangeEditor({ block, flow }: { block: Block; flow: StepFlow }) {
  const send = useSend();
  const wheel = useWheelPicker();
  const stepsPerBar = block.stepsPerBar ?? 16;
  const totalSteps = stepsPerBar * (block.lengthBars ?? 1);
  const events = block.events ?? [];

  return (
    <StepBars totalSteps={totalSteps} stepsPerBar={stepsPerBar} cellW={46} flow={flow}>
      {(steps) => (
        <div className="step-row">
          {steps.map((step) => {
            const evt = events.find((e) => e.atStep === step);
            return (
              <StepCell
                key={step}
                width={46}
                height={40}
                active={!!evt}
                onClick={() =>
                  wheel({
                    title: `Program · step ${step + 1}`,
                    min: 0,
                    max: 127,
                    value: evt?.program ?? 0,
                    format: (v) => `PC${v}`,
                    onPick: (n) => send({ t: "programChange.setEvent", blockId: block.id, step, program: n }),
                  })
                }
                onHold={evt ? () => send({ t: "programChange.setEvent", blockId: block.id, step, program: null }) : undefined}
              >
                {evt ? `PC${evt.program}` : ""}
              </StepCell>
            );
          })}
        </div>
      )}
    </StepBars>
  );
}

// ── Pattern-Shift: Step-Reihe mit MIDI-Nachricht je Event ───────────────────

export function PatternShiftEditor({ block, flow }: { block: Block; flow: StepFlow }) {
  const send = useSend();
  const stepsPerBar = block.stepsPerBar ?? 16;
  const totalSteps = stepsPerBar * (block.lengthBars ?? 1);
  const messages = block.messages ?? [];
  const [pickerStep, setPickerStep] = useState<number | null>(null);

  const existing = pickerStep !== null ? messages.find((m) => m.atStep === pickerStep) : undefined;

  return (
    <div>
      <StepBars totalSteps={totalSteps} stepsPerBar={stepsPerBar} cellW={46} flow={flow}>
        {(steps) => (
          <div className="step-row">
            {steps.map((step) => {
              const msg = messages.find((m) => m.atStep === step);
              const short = msg ? (msg.kind === "programChange" ? `PC${msg.data1}` : msg.kind === "cc" ? `CC${msg.data1}` : `N${msg.data1}`) : "";
              return (
                <StepCell
                  key={step}
                  width={46}
                  height={40}
                  active={!!msg}
                  onClick={() => setPickerStep(step)}
                  onHold={msg ? () => send({ t: "patternShift.setEvent", blockId: block.id, step, kind: null }) : undefined}
                >
                  {short}
                </StepCell>
              );
            })}
          </div>
        )}
      </StepBars>

      {pickerStep !== null && (
        <PatternMessagePickerPopup
          blockId={block.id}
          step={pickerStep}
          existing={existing}
          onClose={() => setPickerStep(null)}
        />
      )}
    </div>
  );
}

/** Popup: Nachrichtentyp wählen, dann data1 (+ data2 bei cc/note) per Keyboard. */
function PatternMessagePickerPopup({
  blockId,
  step,
  existing,
  onClose,
}: {
  blockId: string;
  step: number;
  existing: { kind: string; data1: number; data2?: number } | undefined;
  onClose: () => void;
}) {
  const send = useSend();
  const numberEdit = useNumberEditor();

  const pick = (kind: string) => {
    onClose();
    const askData1 = (data1: number) => {
      numberEdit(data1, 0, 127, (d1) => {
        if (kind === "programChange") {
          send({ t: "patternShift.setEvent", blockId, step, kind, data1: d1 });
        } else {
          numberEdit(existing?.data2 ?? 127, 0, 127, (d2) =>
            send({ t: "patternShift.setEvent", blockId, step, kind, data1: d1, data2: d2 }),
          );
        }
      });
    };
    askData1(existing?.kind === kind ? existing.data1 : 0);
  };

  return (
    <Popup onClose={onClose}>
      <div className="popup-title">Choose message type</div>
      {MSG_KINDS.map((kind) => (
        <Button key={kind} className="popup-row" onClick={() => pick(kind)}>
          {kind}
        </Button>
      ))}
    </Popup>
  );
}
