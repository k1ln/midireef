//! Block Detail editors — React port of the per-type editor methods in
//! ui/blockdetail.ts (melodyEditor, beatEditor, chordEditor, arpEditor,
//! programChangeEditor, patternShiftEditor). CC has its own file (CcEditor)
//! since it's the largest by far (5 layer kinds).

import { useState } from "react";
import type { Block } from "../../state";
import { useSend } from "../store";
import { useNotePicker, noteName } from "../NotePicker";
import { Button } from "../widgets/Button";
import { Popup } from "../widgets/Popup";
import { StepScroller, StepRuler, StepCell } from "./StepGrid";
import { useNumberEditor, useSetField } from "../useNumberEditor";

const DIRECTIONS = ["up", "down", "upDown", "random", "asPlayed"];
const MSG_KINDS = ["programChange", "cc", "note"];

// ── Melody: Step-Reihe + Noten-Listenauswahl (kein Piano-Roll-Grid) ─────────
// Ein Step trägt genau eine Note. Leerer Step antippen → Noten-Liste öffnet
// sich zum Auswählen; belegter Step antippen → Liste öffnet sich zum Ändern
// (aktuelle Note vorausgewählt); lang drücken → Note löschen.

export function MelodyEditor({ block }: { block: Block }) {
  const send = useSend();
  const openNotePicker = useNotePicker();
  const setField = useSetField();
  const stepsPerBar = block.stepsPerBar ?? 16;
  const totalSteps = stepsPerBar * (block.lengthBars ?? 1);
  const base = block.baseNote ?? 60;
  const notes = block.notes ?? [];

  return (
    <div>
      <Button
        style={{ width: 150, height: 30, fontSize: 13, marginBottom: 16 }}
        onClick={() => openNotePicker(base, (n) => setField(block.id, "baseNote", n))}
      >
        Base {noteName(base)}
      </Button>

      <StepScroller>
        <StepRuler totalSteps={totalSteps} stepsPerBar={stepsPerBar} cellW={46} />
        <div className="step-row">
          {Array.from({ length: totalSteps }, (_, step) => {
            const note = notes.find((n) => n.step === step);
            return (
              <StepCell
                key={step}
                width={46}
                height={46}
                active={!!note}
                onClick={() =>
                  openNotePicker(note?.note ?? base, (n) =>
                    send({ t: "melody.setStepNote", blockId: block.id, step, note: n }),
                  )
                }
                onHoldClear={
                  note ? () => send({ t: "melody.setStepNote", blockId: block.id, step, note: null }) : undefined
                }
              >
                {note ? noteName(note.note) : ""}
              </StepCell>
            );
          })}
        </div>
      </StepScroller>

      <div style={{ marginTop: 10, fontSize: 12, color: "var(--pal-text-dim)" }}>
        Tap a step to pick its note, long-press to clear it.
      </div>
    </div>
  );
}

// ── Beat: Step-Grid pro Line ────────────────────────────────────────────────

export function BeatEditor({ block }: { block: Block }) {
  const send = useSend();
  const stepsPerBar = block.stepsPerBar ?? 16;
  const totalSteps = stepsPerBar * (block.lengthBars ?? 1);
  const lines = block.lines ?? [];

  return (
    <StepScroller>
      <div style={{ display: "flex" }}>
        <div style={{ width: 130 }}>
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
        </div>
        <div>
          <StepRuler totalSteps={totalSteps} stepsPerBar={stepsPerBar} cellW={34} />
          {lines.map((line) => (
            <div key={line.id} className="step-row">
              {Array.from({ length: totalSteps }, (_, step) => {
                const on = (line.steps[step]?.velocity ?? 0) > 0;
                const beatMarker = step % (stepsPerBar / 4) === 0;
                return (
                  <div
                    key={step}
                    className="step-cell"
                    style={{
                      width: 32,
                      height: 38,
                      background: on ? "var(--pal-btn-active)" : beatMarker ? "var(--pal-panel-deep)" : "var(--pal-btn)",
                      opacity: on ? 1 : line.muted ? 0.3 : 0.55,
                    }}
                    onClick={() => send({ t: "beat.toggleStep", blockId: block.id, lineId: line.id, step })}
                  />
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </StepScroller>
  );
}

// ── Chord: Piano-Roll wie Melodie, aber mehrere Noten pro Step ─────────────

export function ChordEditor({ block }: { block: Block }) {
  const send = useSend();
  const numberEdit = useNumberEditor();
  const setField = useSetField();
  const stepsPerBar = block.stepsPerBar ?? 16;
  const totalSteps = stepsPerBar * (block.lengthBars ?? 1);
  const base = block.baseNote ?? 60;
  const low = base - 6;
  const high = base + 18;
  const chords = block.chords ?? [];
  const hasNote = (step: number, note: number) => chords.some((c) => c.step === step && c.notes.includes(note));

  const rows: number[] = [];
  for (let note = high; note >= low; note--) rows.push(note);

  return (
    <div>
      <Button
        style={{ width: 150, height: 30, fontSize: 13, marginBottom: 16 }}
        onClick={() => numberEdit(base, 0, 127, (n) => setField(block.id, "baseNote", n))}
      >
        Base {noteName(base)}
      </Button>

      <StepScroller>
        <StepRuler totalSteps={totalSteps} stepsPerBar={stepsPerBar} cellW={34} />
        {rows.map((note) => {
          const isC = ((note % 12) + 12) % 12 === 0;
          return (
            <div key={note} className="step-row" style={{ background: isC ? "var(--pal-panel-deep)" : "var(--pal-panel)", opacity: 0.4 }}>
              {Array.from({ length: totalSteps }, (_, step) => {
                const on = hasNote(step, note);
                return (
                  <div
                    key={step}
                    className="step-cell"
                    style={{
                      width: 32,
                      height: 20,
                      background: on ? "var(--pal-btn-active)" : "var(--pal-btn)",
                      opacity: on ? 1 : 0.5,
                    }}
                    onClick={() => send({ t: "chord.toggleNote", blockId: block.id, step, note })}
                  />
                );
              })}
            </div>
          );
        })}
      </StepScroller>
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
            <div key={note} style={{ width: 34, fontSize: 9, color: note === base ? "var(--pal-white)" : "var(--pal-text-dim)", fontWeight: note === base ? 700 : 400 }}>
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

export function ProgramChangeEditor({ block }: { block: Block }) {
  const send = useSend();
  const numberEdit = useNumberEditor();
  const stepsPerBar = block.stepsPerBar ?? 16;
  const totalSteps = stepsPerBar * (block.lengthBars ?? 1);
  const events = block.events ?? [];

  return (
    <StepScroller>
      <StepRuler totalSteps={totalSteps} stepsPerBar={stepsPerBar} cellW={46} />
      <div className="step-row">
        {Array.from({ length: totalSteps }, (_, step) => {
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
              onHoldClear={evt ? () => send({ t: "programChange.setEvent", blockId: block.id, step, program: null }) : undefined}
            >
              {evt ? `PC${evt.program}` : ""}
            </StepCell>
          );
        })}
      </div>
    </StepScroller>
  );
}

// ── Pattern-Shift: Step-Reihe mit MIDI-Nachricht je Event ───────────────────

export function PatternShiftEditor({ block }: { block: Block }) {
  const send = useSend();
  const stepsPerBar = block.stepsPerBar ?? 16;
  const totalSteps = stepsPerBar * (block.lengthBars ?? 1);
  const messages = block.messages ?? [];
  const [pickerStep, setPickerStep] = useState<number | null>(null);

  const existing = pickerStep !== null ? messages.find((m) => m.atStep === pickerStep) : undefined;

  return (
    <StepScroller>
      <StepRuler totalSteps={totalSteps} stepsPerBar={stepsPerBar} cellW={46} />
      <div className="step-row">
        {Array.from({ length: totalSteps }, (_, step) => {
          const msg = messages.find((m) => m.atStep === step);
          const short = msg ? (msg.kind === "programChange" ? `PC${msg.data1}` : msg.kind === "cc" ? `CC${msg.data1}` : `N${msg.data1}`) : "";
          return (
            <StepCell
              key={step}
              width={46}
              height={40}
              active={!!msg}
              onClick={() => setPickerStep(step)}
              onHoldClear={msg ? () => send({ t: "patternShift.setEvent", blockId: block.id, step, kind: null }) : undefined}
            >
              {short}
            </StepCell>
          );
        })}
      </div>

      {pickerStep !== null && (
        <PatternMessagePickerPopup
          blockId={block.id}
          step={pickerStep}
          existing={existing}
          onClose={() => setPickerStep(null)}
        />
      )}
    </StepScroller>
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
