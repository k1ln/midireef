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
//! Die Geste ist in BEIDEN Ansichten dieselbe — und bewusst die, die sich auf
//! Step-Sequencern durchgesetzt hat (Elektron, Push, FL Studio Mobile):
//!
//!   kurzer Tipper  = Note setzen bzw. entfernen (ein Klick, kein Umweg)
//!   langes Drücken = `NoteEditor` für DIESE Note (Tonhöhe, Länge, Velocity)
//!
//! Bewusst KEIN Umschalt-Modus („jetzt löschen"): ein Modus ist auf einem
//! Touchdisplay ohne Mauszeiger nicht zu sehen, solange man ihn nicht bemerkt
//! hat — und dann löscht der nächste Tipper etwas, das man setzen wollte. Das
//! lange Drücken hängt dagegen an der Note selbst und kann nicht „anbleiben".

import { useState, type CSSProperties } from "react";
import type { Block } from "../../state";
import { useSend } from "../store";
import { useNotePicker, noteName } from "../NotePicker";
import { Button } from "../widgets/Button";
import { Popup } from "../widgets/Popup";
import { StepBars, StepCell, RollKey, ROLL_LOW_NOTE, ROLL_HIGH_NOTE, type StepFlow } from "./StepGrid";
import { useSetField } from "../useNumberEditor";
import { useLongPress } from "../useLongPress";
import { NoteEditorPopup, type NoteRef } from "./NoteEditor";
import { usePlayIn, PlayInBar } from "./PlayIn";

export type MelodyLayout = "stack" | "grid";

/** Grundnote und Ansichts-Umschalter. Sitzt NICHT über dem Raster, sondern in
 *  der Kopfzeile des Baustein-Details (s. BlockDetail) — zwei Leisten
 *  übereinander kosteten auf dem kleinen Display eine Rasterzeile, und die
 *  Kopfzeile ist ohnehin die Stelle, an der man nach Schaltern sucht. Der
 *  Zustand liegt deshalb dort und kommt als Prop zurück. */
export function MelodyToolbar({
  block,
  layout,
  setLayout,
  playIn,
  setPlayIn,
}: {
  block: Block;
  layout: MelodyLayout;
  setLayout: (v: MelodyLayout) => void;
  /** „Play in" — s. PlayIn.tsx. Der Zustand liegt (wie `layout`) im
   *  Baustein-Detail, weil sein Schalter hier oben und die Klaviatur unten
   *  unter dem Raster sitzt. */
  playIn: boolean;
  setPlayIn: (v: boolean) => void;
}) {
  const send = useSend();
  const openNotePicker = useNotePicker();
  const setField = useSetField();
  const base = block.baseNote ?? 60;
  const [confirmClear, setConfirmClear] = useState(false);
  const noteCount = block.notes?.length ?? 0;

  return (
    <>
      <Button
        style={{ width: 150, height: 40, fontSize: 14 }}
        onClick={() => openNotePicker(base, (n) => setField(block.id, "baseNote", n))}
      >
        Base {noteName(base)} ({base})
      </Button>
      <Button
        variant="alt"
        style={{ width: 130, height: 40, fontSize: 14 }}
        onClick={() => setLayout(layout === "stack" ? "grid" : "stack")}
      >
        {layout === "stack" ? "▤ Columns" : "▦ Piano roll"}
      </Button>
      {/* Nur in der Piano-Rolle: dort gibt es die Tonhöhen-Zeilen, an denen
          man den Cursor und das Eingespielte SIEHT. In der Spalten-Ansicht
          bliebe vom Einspielen nur eine wachsende Zahlenkolonne. */}
      {layout === "grid" && (
        <Button
          variant={playIn ? "active" : "alt"}
          style={{ width: 120, height: 40, fontSize: 14 }}
          title="Play the melody in from a connected keyboard or the on-screen keys"
          onClick={() => setPlayIn(!playIn)}
        >
          {playIn ? "● Play in" : "○ Play in"}
        </Button>
      )}
      <Button
        variant="danger"
        style={{ width: 90, height: 40, fontSize: 14 }}
        title="Remove every note in this melody"
        disabled={noteCount === 0}
        onClick={() => setConfirmClear(true)}
      >
        🗑 Clear
      </Button>

      {confirmClear && (
        <Popup onClose={() => setConfirmClear(false)}>
          <div className="popup-title">Clear this melody?</div>
          <div style={{ fontSize: 13, color: "var(--pal-text-dim)", marginBottom: 16 }}>
            This removes all {noteCount} note{noteCount === 1 ? "" : "s"} right now — there's no undo.
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <Button
              variant="danger"
              style={{ flex: 1, height: 44 }}
              onClick={() => {
                send({ t: "melody.clear", blockId: block.id });
                setConfirmClear(false);
              }}
            >
              Clear everything
            </Button>
            <Button variant="alt" style={{ flex: 1, height: 44 }} onClick={() => setConfirmClear(false)}>
              Cancel
            </Button>
          </div>
        </Popup>
      )}
    </>
  );
}

export function MelodyEditor({
  block,
  flow,
  layout,
  playIn,
}: {
  block: Block;
  flow: StepFlow;
  layout: MelodyLayout;
  playIn: boolean;
}) {
  return layout === "stack" ? (
    <MelodyStack block={block} flow={flow} />
  ) : (
    <MelodyGrid block={block} flow={flow} playIn={playIn} />
  );
}

// ── Spalten-Ansicht ─────────────────────────────────────────────────────────
// Jeder Step ist eine eigene Spalte, die nach unten wächst: eine Note antippen
// entfernt sie, lang drücken öffnet ihren Editor; "+" am Fuß der Spalte fügt
// eine weitere Note am selben Step hinzu (gleichzeitiger Akkord-Stack).

/** Notenfeld der Spalten-Ansicht: QUADRATISCH. Vorher war es 44×28 mit einer
 *  14px-Leiste für die Länge darunter — zwei schmale Streifen übereinander,
 *  die man auf dem Touchdisplay beide verfehlt bzw. verwechselt. Ein Quadrat
 *  von Fingerbreite trifft man, und Tonhöhe und Länge stehen darin. */
const STACK_CELL = 44;
/** Spaltenbreite = Zelle + 1px Rand auf jeder Seite. */
const STACK_COL = STACK_CELL + 2;

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
      <StepBars totalSteps={totalSteps} stepsPerBar={stepsPerBar} cellW={STACK_COL} flow={flow}>
        {(steps) => (
          <div style={{ display: "flex" }}>
            {steps.map((step) => {
              // Höchste Note oben, "+" wächst die Spalte nach unten weiter.
              const stepNotes = notes.filter((n) => n.step === step).sort((a, b) => b.note - a.note);
              return (
                <div
                  key={step}
                  style={{
                    width: STACK_CELL,
                    flexShrink: 0,
                    margin: 1,
                    display: "flex",
                    flexDirection: "column",
                    gap: 2,
                  }}
                >
                  {stepNotes.map((n) => {
                    const len = Math.max(1, n.lengthSteps ?? 1);
                    return (
                      <StepCell
                        key={n.note}
                        width={STACK_CELL}
                        height={STACK_CELL}
                        active
                        onClick={() => send({ t: "melody.removeNote", blockId: block.id, step, note: n.note })}
                        onHold={() => setEditing({ step, note: n.note })}
                      >
                        {/* Tonhöhe groß, Länge klein darunter — beides IM
                            Quadrat, damit es nur ein Ziel für den Finger gibt. */}
                        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", lineHeight: 1.1 }}>
                          <span style={{ fontSize: 14, fontWeight: 700 }}>{noteName(n.note)}</span>
                          <span style={{ fontSize: 10, color: "var(--pal-step-label)" }}>len {len}</span>
                        </div>
                      </StepCell>
                    );
                  })}
                  <div
                    onClick={() =>
                      openNotePicker(stepNotes[stepNotes.length - 1]?.note ?? base, (n) =>
                        send({ t: "melody.addNote", blockId: block.id, step, note: n }),
                      )
                    }
                    style={{
                      height: 34,
                      borderRadius: 2,
                      border: "1px dashed var(--pal-text-dim)",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontSize: 18,
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
        Tap a note to remove it, long-press it for pitch, length and velocity. Tap "+" at the foot of a column to add a note
        (again for a chord on the same step).
      </div>

      {editing && (
        <NoteEditorPopup block={block} target={editing} onRetarget={setEditing} onClose={() => setEditing(null)} />
      )}
    </div>
  );
}

// ── Piano-Roll-Ansicht ──────────────────────────────────────────────────────

// Quadratische Zellen: eine 34×20-Zelle ist mit dem Finger senkrecht kaum zu
// treffen — daneben liegt sofort die nächste Tonhöhe. Gleich hoch wie breit
// kostet Sichtfeld (der Ausschnitt scrollt ohnehin), trifft dafür.
const ROW_H = 50;
const CELL_W = 50;

function MelodyGrid({ block, flow, playIn }: { block: Block; flow: StepFlow; playIn: boolean }) {
  const send = useSend();
  const [editing, setEditing] = useState<NoteRef | null>(null);
  const stepsPerBar = block.stepsPerBar ?? 16;
  const totalSteps = stepsPerBar * (block.lengthBars ?? 1);
  const base = block.baseNote ?? 60;
  const notes = block.notes ?? [];
  // Einspielen: Schreib-Cursor + Tastatur-Eingang. Der Hook läuft immer mit
  // (Hooks dürfen nicht bedingt sein), armiert den Server aber nur, solange
  // `playIn` steht — s. PlayIn.tsx.
  const play = usePlayIn(block, totalSteps, playIn);

  // Tonumfang: die volle MIDI-Skala von C0 bis G9. Kein Fenster um die
  // Grundnote mehr — jede Tonhöhe, die ein Gerät spielen kann, soll auch im
  // Raster setzbar sein; gescrollt wird ohnehin (Start s. data-roll-center).
  const rows: number[] = [];
  for (let note = ROLL_HIGH_NOTE; note >= ROLL_LOW_NOTE; note--) rows.push(note);

  // Noten nach Tonhöhe vorsortiert: über 116 Zeilen × Steps würde ein
  // `notes.find()` über ALLE Noten je Zelle spürbar bremsen, ein Blick in die
  // Noten DIESER Zeile (meist keine oder eine) nicht.
  const byPitch = new Map<number, typeof notes>();
  for (const n of notes) {
    const list = byPitch.get(n.note);
    if (list) list.push(n);
    else byPitch.set(n.note, [n]);
  }

  /** Note, die an diesem Step ANFÄNGT. */
  const noteAt = (step: number, pitch: number) => byPitch.get(pitch)?.find((n) => n.step === step);
  /** Note, die über diesen Step hinweg KLINGT (Halten sichtbar machen). */
  const heldAt = (step: number, pitch: number) =>
    byPitch.get(pitch)?.find((n) => n.step < step && n.step + Math.max(1, n.lengthSteps ?? 1) > step);

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <StepBars
        totalSteps={totalSteps}
        stepsPerBar={stepsPerBar}
        cellW={CELL_W}
        flow={flow}
        fillHeight
        cursorStep={playIn ? play.cursor : undefined}
        onPickStep={playIn ? play.setCursor : undefined}
      >
        {(steps) =>
          rows.map((note) => {
            const isC = ((note % 12) + 12) % 12 === 0;
            return (
              <div
                key={note}
                className="step-row roll-row"
                // Anker für den Start-Scroll des Ausschnitts (s. StepScroller).
                data-roll-center={note === base ? "" : undefined}
                style={
                  {
                    background: isC ? "var(--pal-panel-deep)" : "var(--pal-panel)",
                    // Platzhalterhöhe der ausgeblendeten Zeilen (s. .roll-row).
                    "--roll-row-h": `${ROW_H}px`,
                  } as CSSProperties
                }
              >
                {steps.map((step) => {
                  const start = noteAt(step, note);
                  const held = !start ? heldAt(step, note) : undefined;
                  return (
                    <RollCell
                      key={step}
                      // Die Spalte, auf die das nächste Gespielte geht.
                      cursor={playIn && step === play.cursor}
                      // Gehaltene Note als eigener, DECKENDER Grauton statt
                      // als halbtransparentes Weiß — vorher schimmerte die
                      // Zeile darunter durch und die Note sah "leer" aus.
                      background={
                        start ? "var(--pal-btn-active)" : held ? "var(--pal-step-held)" : "var(--pal-step-off)"
                      }
                      onTap={() => {
                        // Auf dem Anfang: Note wieder weg — derselbe Tipper,
                        // der sie gesetzt hat, nimmt sie zurück. Auf dem
                        // Halte-Schweif: Note bis GENAU hierher kürzen — das
                        // ist die schnelle Länge direkt im Raster, ohne Umweg.
                        // Leere Zelle: neue Note.
                        if (start)
                          send({ t: "melody.removeNote", blockId: block.id, step, note });
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
                      // Lang drücken öffnet den Editor dieser Note — auch vom
                      // Halte-Schweif aus, der gehört ja zur selben Note.
                      onLongPress={
                        start || held
                          ? () => setEditing({ step: (start ?? held)!.step, note })
                          : undefined
                      }
                    />
                  );
                })}
                {/* Klaviatur am Zeilenende: sie sagt (wie die frühere reine
                    Beschriftung), auf welcher Tonhöhe man tippt — und spielt
                    sie beim Drücken an, damit man eine Note hören kann, bevor
                    man sie setzt. Gedrückt halten = Ton hält (s. RollKey). */}
                <RollKey
                  note={note}
                  label={noteName(note)}
                  height={ROW_H}
                  onPress={() => send({ t: "block.previewNote", blockId: block.id, note, on: true })}
                  onRelease={() => send({ t: "block.previewNote", blockId: block.id, note, on: false })}
                />
              </div>
            );
          })
        }
      </StepBars>

      <div style={{ marginTop: 10, fontSize: 12, color: "var(--pal-text-dim)", flexShrink: 0 }}>
        {playIn ? (
          <>
            Play a connected MIDI keyboard or the keys below — notes land on the marked step, held keys become one chord, and the
            cursor moves on when you let go. Tap the ruler to jump the cursor, "▶" leaves a rest. Editing by tap still works.
          </>
        ) : (
          <>
            Tap an empty cell to place a note, tap the note again to remove it, tap its trail to end it there. Long-press a note
            for pitch, length and velocity. Hold a key at the end of a row to hear that pitch.
          </>
        )}
      </div>

      {playIn && <PlayInBar playIn={play} totalSteps={totalSteps} stepsPerBar={stepsPerBar} baseNote={base} />}

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
  cursor,
  onTap,
  onLongPress,
}: {
  background: string;
  /** Liegt die Zelle auf dem Schreib-Cursor des Einspielens? */
  cursor?: boolean;
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
  return (
    <div
      className={`step-cell${cursor ? " step-cursor" : ""}`}
      style={{ width: CELL_W - 2, height: ROW_H, background }}
      {...handlers}
    />
  );
}
