//! Melodie-Editor mit zwei Ansichten auf dieselben Noten — umschaltbar, weil
//! beide etwas können, was der anderen fehlt:
//!
//!   "stack" (Spalten) — je Step eine Spalte, die nach unten wächst. Zeigt
//!     Tonhöhe UND Notenlänge als Text, erlaubt Akkord-Stapel und ist auf dem
//!     Touchdisplay treffsicher. Der Verlauf einer Melodie ist aber nicht zu
//!     sehen: alle Noten stehen auf gleicher Höhe.
//!   "grid" (Piano-Roll) — Zeile = Tonhöhe, Spalte = Step. Man SIEHT die
//!     Melodie und setzt Noten mit einem Tipper, dafür ist die Notenlänge nur
//!     als Balken sichtbar (Feineinstellung bleibt der Spalten-Ansicht).
//!
//! Beide Ansichten sprechen dieselben Kommandos (melody.addNote/removeNote/
//! setNotePitch/setNoteLength) — es ist wirklich nur die Darstellung.
//!
//! In BEIDEN öffnet ein Tipper auf eine gesetzte Note denselben `NoteEditor`
//! (Tonhöhe + Länge in einem Popup, s. dort) — Länge einstellen ist damit
//! überall gleich weit weg, nicht nur in der Spalten-Ansicht.

import { useState } from "react";
import type { Block } from "../../state";
import { useSend } from "../store";
import { useNotePicker, noteName } from "../NotePicker";
import { Button } from "../widgets/Button";
import { StepBars, StepCell, type StepFlow } from "./StepGrid";
import { useSetField } from "../useNumberEditor";
import { useLocalPref } from "../useLocalPref";
import { useLongPress } from "../useLongPress";
import { NoteEditorPopup, type NoteRef } from "./NoteEditor";

export type MelodyLayout = "stack" | "grid";

export function MelodyEditor({ block, flow }: { block: Block; flow: StepFlow }) {
  const openNotePicker = useNotePicker();
  const setField = useSetField();
  const [layout, setLayout] = useLocalPref<MelodyLayout>("blockdetail.melodyLayout", "stack");
  const base = block.baseNote ?? 60;

  return (
    <div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginBottom: 16 }}>
        <Button
          style={{ width: 150, height: 34, fontSize: 13 }}
          onClick={() => openNotePicker(base, (n) => setField(block.id, "baseNote", n))}
        >
          Base {noteName(base)} ({base})
        </Button>
        <Button
          variant="alt"
          style={{ width: 130, height: 34, fontSize: 13 }}
          onClick={() => setLayout(layout === "stack" ? "grid" : "stack")}
        >
          {layout === "stack" ? "▤ Columns" : "▦ Piano roll"}
        </Button>
      </div>

      {layout === "stack" ? <MelodyStack block={block} flow={flow} /> : <MelodyGrid block={block} flow={flow} />}
    </div>
  );
}

// ── Spalten-Ansicht ─────────────────────────────────────────────────────────
// Jeder Step ist eine eigene Spalte, die nach unten wächst: eine Note antippen
// öffnet Tonhöhe UND Länge, lang drücken entfernt sie; "+" am Fuß der Spalte
// fügt eine weitere Note am selben Step hinzu (gleichzeitiger Akkord-Stack).

function MelodyStack({ block, flow }: { block: Block; flow: StepFlow }) {
  const send = useSend();
  const openNotePicker = useNotePicker();
  const [editing, setEditing] = useState<NoteRef | null>(null);
  const stepsPerBar = block.stepsPerBar ?? 16;
  const totalSteps = stepsPerBar * (block.lengthBars ?? 1);
  const base = block.baseNote ?? 60;
  const notes = block.notes ?? [];

  return (
    <div>
      <StepBars totalSteps={totalSteps} stepsPerBar={stepsPerBar} cellW={46} flow={flow}>
        {(steps) => (
          <div style={{ display: "flex" }}>
            {steps.map((step) => {
              // Höchste Note oben, "+" wächst die Spalte nach unten weiter.
              const stepNotes = notes.filter((n) => n.step === step).sort((a, b) => b.note - a.note);
              return (
                <div key={step} style={{ width: 44, flexShrink: 0, margin: 1, display: "flex", flexDirection: "column", gap: 2 }}>
                  {stepNotes.map((n) => (
                    <div key={n.note}>
                      <StepCell
                        width={44}
                        height={28}
                        active
                        onClick={() => setEditing({ step, note: n.note })}
                        onHoldClear={() => send({ t: "melody.removeNote", blockId: block.id, step, note: n.note })}
                      >
                        {noteName(n.note)}
                        <span style={{ fontSize: 9, color: "var(--pal-step-label)", marginLeft: 3 }}>{n.note}</span>
                      </StepCell>
                      <div
                        onClick={() => setEditing({ step, note: n.note })}
                        style={{
                          height: 14,
                          marginTop: 1,
                          borderRadius: 2,
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          fontSize: 9,
                          fontWeight: 700,
                          cursor: "pointer",
                          color: "var(--pal-text-dim)",
                          background: "var(--pal-panel-deep)",
                        }}
                      >
                        len {n.lengthSteps ?? 1}
                      </div>
                    </div>
                  ))}
                  <div
                    onClick={() =>
                      openNotePicker(stepNotes[stepNotes.length - 1]?.note ?? base, (n) =>
                        send({ t: "melody.addNote", blockId: block.id, step, note: n }),
                      )
                    }
                    style={{
                      height: 22,
                      borderRadius: 2,
                      border: "1px dashed var(--pal-text-dim)",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontSize: 14,
                      fontWeight: 700,
                      cursor: "pointer",
                      color: "var(--pal-text-dim)",
                    }}
                  >
                    +
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </StepBars>

      <div style={{ marginTop: 10, fontSize: 12, color: "var(--pal-text-dim)" }}>
        Tap "+" to stack another note on a step (chord). Tap a note (or its "len" strip) to set pitch and length, long-press to remove it.
      </div>

      {editing && (
        <NoteEditorPopup block={block} target={editing} onRetarget={setEditing} onClose={() => setEditing(null)} />
      )}
    </div>
  );
}

// ── Piano-Roll-Ansicht ──────────────────────────────────────────────────────

const ROW_H = 20;
const CELL_W = 34;
/** Höhe eines Piano-Roll-Ausschnitts: gut zwei Handbreit, damit auf dem
 *  Pi-Display auch bei taktweisem Layout mehr als ein Takt aufs Bild passt.
 *  Der Rest ist im Raster selbst scrollbar (senkrecht). */
const ROLL_MAX_H = 300;

function MelodyGrid({ block, flow }: { block: Block; flow: StepFlow }) {
  const send = useSend();
  const [editing, setEditing] = useState<NoteRef | null>(null);
  const stepsPerBar = block.stepsPerBar ?? 16;
  const totalSteps = stepsPerBar * (block.lengthBars ?? 1);
  const base = block.baseNote ?? 60;
  const notes = block.notes ?? [];

  // Tonumfang: eine Oktave um die Basis, aber immer weit genug, dass KEINE
  // vorhandene Note aus dem Bild fällt — sonst wäre sie im Grid unsichtbar
  // und (anders als in der Spalten-Ansicht) auch nicht mehr löschbar.
  const pitches = notes.map((n) => n.note);
  const low = Math.min(base - 6, ...pitches);
  const high = Math.max(base + 18, ...pitches);
  const rows: number[] = [];
  for (let note = high; note >= low; note--) rows.push(note);

  /** Note, die an diesem Step ANFÄNGT. */
  const noteAt = (step: number, pitch: number) => notes.find((n) => n.step === step && n.note === pitch);
  /** Note, die über diesen Step hinweg KLINGT (Halten sichtbar machen). */
  const heldAt = (step: number, pitch: number) =>
    notes.find((n) => n.note === pitch && n.step < step && n.step + Math.max(1, n.lengthSteps ?? 1) > step);

  return (
    <div>
      <StepBars totalSteps={totalSteps} stepsPerBar={stepsPerBar} cellW={CELL_W} flow={flow} maxHeight={ROLL_MAX_H}>
        {(steps) =>
          rows.map((note) => {
            const isC = ((note % 12) + 12) % 12 === 0;
            return (
              <div key={note} className="step-row" style={{ background: isC ? "var(--pal-panel-deep)" : "var(--pal-panel)" }}>
                {steps.map((step) => {
                  const start = noteAt(step, note);
                  const held = !start ? heldAt(step, note) : undefined;
                  return (
                    <RollCell
                      key={step}
                      // Gehaltene Note als eigener, DECKENDER Grauton statt
                      // als halbtransparentes Weiß — vorher schimmerte die
                      // Zeile darunter durch und die Note sah "leer" aus.
                      background={
                        start ? "var(--pal-btn-active)" : held ? "var(--pal-step-held)" : "var(--pal-step-off)"
                      }
                      onTap={() => {
                        // Auf dem Anfang: Tonhöhe/Länge im Popup. Auf dem
                        // Halte-Schweif: Note bis GENAU hierher kürzen — das
                        // ist die schnelle Länge direkt im Raster, ohne Umweg.
                        // Leere Zelle: neue Note (bleibt ein Tipper).
                        if (start) setEditing({ step, note });
                        else if (held)
                          send({
                            t: "melody.setNoteLength",
                            blockId: block.id,
                            step: held.step,
                            note,
                            lengthSteps: step - held.step + 1,
                          });
                        else send({ t: "melody.addNote", blockId: block.id, step, note });
                      }}
                      onLongPress={
                        start || held
                          ? () =>
                              send({
                                t: "melody.removeNote",
                                blockId: block.id,
                                step: (start ?? held)!.step,
                                note,
                              })
                          : undefined
                      }
                    />
                  );
                })}
                {/* Notennamen am Zeilenende — im Grid gibt es sonst keinen
                    Anhaltspunkt, auf welcher Tonhöhe man tippt. */}
                <div style={{ paddingLeft: 6, fontSize: 9, lineHeight: `${ROW_H}px`, color: isC ? "var(--pal-text)" : "var(--pal-text-dim)" }}>
                  {noteName(note)}
                </div>
              </div>
            );
          })
        }
      </StepBars>

      <div style={{ marginTop: 10, fontSize: 12, color: "var(--pal-text-dim)" }}>
        Tap an empty cell to place a note, tap the note itself for pitch and length, tap its trail to end it there. Long-press
        removes.
      </div>

      {editing && (
        <NoteEditorPopup block={block} target={editing} onRetarget={setEditing} onClose={() => setEditing(null)} />
      )}
    </div>
  );
}

/** Eine Piano-Roll-Zelle. Eigene Komponente nur, weil `useLongPress` ein Hook
 *  ist und deshalb nicht in der Zellen-Schleife stehen darf. */
function RollCell({
  background,
  onTap,
  onLongPress,
}: {
  background: string;
  onTap: () => void;
  /** Fehlt bei leeren Zellen — dort gibt es nichts zu entfernen. */
  onLongPress?: () => void;
}) {
  const press = useLongPress(onLongPress ?? (() => {}), onTap);
  // Ohne etwas zu Löschen KEIN Halte-Timer: der würde bei einem langsamen
  // Tipper auf eine leere Zelle zuschlagen und den Tipper verschlucken.
  const handlers = onLongPress
    ? // Quer-Wischen zum Scrollen darf weder als Tipper noch als langes
      // Drücken enden (s. dieselbe Stelle in StepGrid's StepCell).
      { ...press, onPointerCancel: press.onPointerLeave }
    : { onClick: onTap };
  return <div className="step-cell" style={{ width: CELL_W - 2, height: ROW_H, background }} {...handlers} />;
}
