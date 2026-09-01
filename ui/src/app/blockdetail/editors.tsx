//! Block Detail editors — React port of the per-type editor methods in
//! ui/blockdetail.ts (beatEditor, chordEditor, arpEditor, programChangeEditor,
//! patternShiftEditor). Melodie und CC haben eigene Dateien (MelodyEditor mit
//! seinen zwei Ansichten, CcEditor mit fünf Layer-Arten).
//!
//! Alle Raster laufen über `StepBars`: das legt die Steps je nach `flow`
//! entweder in eine lange scrollbare Reihe oder taktweise untereinander.

import { useState } from "react";
import type { Block } from "../../state";
import { useSend } from "../store";
import { noteName } from "../NotePicker";
import { Button } from "../widgets/Button";
import { Popup } from "../widgets/Popup";
import { StepScroller, StepBars, StepCell, ROLL_LOW_NOTE, ROLL_HIGH_NOTE, ROLL_MAX_H, type StepFlow } from "./StepGrid";
import { useNumberEditor, useSetField } from "../useNumberEditor";

const DIRECTIONS = ["up", "down", "upDown", "random", "asPlayed"];
const MSG_KINDS = ["programChange", "cc", "note"];

// ── Beat: Step-Grid pro Line ────────────────────────────────────────────────

export function BeatEditor({ block, flow }: { block: Block; flow: StepFlow }) {
  const send = useSend();
  const stepsPerBar = block.stepsPerBar ?? 16;
  const totalSteps = stepsPerBar * (block.lengthBars ?? 1);
  const lines = block.lines ?? [];

  // Zeilennamen links; bei taktweisem Layout wiederholt StepBars sie je Takt,
  // damit man auch in Takt 3 noch weiß, welche Zeile die Snare ist.
  const names = (
    <>
      <div style={{ height: 20 }} />
      {lines.map((line) => (
        <div
          key={line.id}
          style={{ height: 46, display: "flex", flexDirection: "column", justifyContent: "center", cursor: "pointer" }}
          onClick={() => send({ t: "beat.setLineMuted", blockId: block.id, lineId: line.id, muted: !line.muted })}
        >
          <span style={{ fontSize: 15, fontWeight: 600, color: line.muted ? "var(--pal-text-dim)" : "var(--pal-text)" }}>
            {line.name}
          </span>
          {line.muted && <span style={{ fontSize: 10, fontWeight: 700, color: "var(--pal-danger)" }}>MUTE</span>}
        </div>
      ))}
    </>
  );

  return (
    <StepBars totalSteps={totalSteps} stepsPerBar={stepsPerBar} cellW={34} flow={flow} leftColumn={names} leftWidth={130}>
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
                    width: 32,
                    height: 38,
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

// ── Chord: Piano-Roll wie Melodie, aber mehrere Noten pro Step ─────────────

export function ChordEditor({ block, flow }: { block: Block; flow: StepFlow }) {
  const send = useSend();
  const numberEdit = useNumberEditor();
  const setField = useSetField();
  const stepsPerBar = block.stepsPerBar ?? 16;
  const totalSteps = stepsPerBar * (block.lengthBars ?? 1);
  const base = block.baseNote ?? 60;
  const chords = block.chords ?? [];
  const hasNote = (step: number, note: number) => chords.some((c) => c.step === step && c.notes.includes(note));

  // Volle MIDI-Skala wie in der Melodie-Rolle (s. MelodyGrid), gedeckelt und
  // senkrecht scrollbar — der Ausschnitt startet auf der Grundnote.
  const rows: number[] = [];
  for (let note = ROLL_HIGH_NOTE; note >= ROLL_LOW_NOTE; note--) rows.push(note);

  return (
    <div>
      <Button
        style={{ width: 150, height: 30, fontSize: 13, marginBottom: 16 }}
        onClick={() => numberEdit(base, 0, 127, (n) => setField(block.id, "baseNote", n))}
      >
        Base {noteName(base)}
      </Button>

      <StepBars totalSteps={totalSteps} stepsPerBar={stepsPerBar} cellW={34} flow={flow} maxHeight={ROLL_MAX_H}>
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
  const numberEdit = useNumberEditor();
  const setField = useSetField();
  const base = block.baseNote ?? 60;
  const low = base - 12;
  const high = base + 12;
  const chordNotes = block.chordNotes ?? [];
  const direction = block.direction ?? "up";
  const gateSteps = block.gateSteps ?? 1;
  const rateSteps = block.rateSteps ?? 1;
  const velocity = block.velocity ?? 100;

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
        <Button style={{ width: 150, height: 34, fontSize: 14 }} onClick={() => numberEdit(base, 0, 127, (n) => setField(block.id, "baseNote", n))}>
          Base {noteName(base)}
        </Button>
        <Button
          style={{ width: 170, height: 34, fontSize: 14 }}
          onClick={() => setField(block.id, "direction", DIRECTIONS[(DIRECTIONS.indexOf(direction) + 1) % DIRECTIONS.length])}
        >
          Dir: {direction}
        </Button>
        <Button style={{ width: 120, height: 34, fontSize: 14 }} onClick={() => numberEdit(gateSteps, 1, 64, (n) => setField(block.id, "gateSteps", n))}>
          Gate {gateSteps}
        </Button>
        <Button style={{ width: 120, height: 34, fontSize: 14 }} onClick={() => numberEdit(rateSteps, 1, 64, (n) => setField(block.id, "rateSteps", n))}>
          Rate {rateSteps}
        </Button>
        <Button style={{ width: 120, height: 34, fontSize: 14 }} onClick={() => numberEdit(velocity, 1, 127, (n) => setField(block.id, "velocity", n))}>
          Vel {velocity}
        </Button>
      </div>
    </div>
  );
}

// ── Program-Change: Step-Reihe mit Programm-Nummer je Event ────────────────

export function ProgramChangeEditor({ block, flow }: { block: Block; flow: StepFlow }) {
  const send = useSend();
  const numberEdit = useNumberEditor();
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
                  numberEdit(evt?.program ?? 0, 0, 127, (n) => send({ t: "programChange.setEvent", blockId: block.id, step, program: n }))
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
