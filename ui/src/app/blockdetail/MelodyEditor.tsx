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

import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { Block, MelodyNote } from "../../state";
import { useSend } from "../store";
import { useNotePicker, noteName } from "../NotePicker";
import { Button } from "../widgets/Button";
import { Popup } from "../widgets/Popup";
import { StepBars, StepCell, RollKey, ROLL_LOW_NOTE, ROLL_HIGH_NOTE, ROLL_KEY_W, isBlackKey, type StepFlow } from "./StepGrid";
import { useLongPress } from "../useLongPress";
import { useLocalPref } from "../useLocalPref";
import { NoteEditorPopup, type NoteRef } from "./NoteEditor";
import { usePlayIn, PlayInBar, type PlayIn } from "./PlayIn";

export type MelodyLayout = "stack" | "grid";

/** Default pitch used where the editor needs a starting point but there's no
 *  note to derive one from yet (first note in an empty column, initial
 *  piano-roll scroll position, play-in keyboard octave) — middle C. */
const DEFAULT_BASE_NOTE = 60;

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
  const [confirmClear, setConfirmClear] = useState(false);
  const noteCount = block.notes?.length ?? 0;

  return (
    <>
      <Button
        variant="alt"
        style={{ width: 84, height: 40, fontSize: 14 }}
        onClick={() => setLayout(layout === "stack" ? "grid" : "stack")}
      >
        {layout === "stack" ? "▤ Cols" : "▦ Roll"}
      </Button>
      {/* Nur in der Piano-Rolle: dort gibt es die Tonhöhen-Zeilen, an denen
          man den Cursor und das Eingespielte SIEHT. In der Spalten-Ansicht
          bliebe vom Einspielen nur eine wachsende Zahlenkolonne. Play-Zeichen
          + "IN" statt "Play in" ausgeschrieben — an/aus zeigt schon die Farbe. */}
      {layout === "grid" && (
        <Button
          variant={playIn ? "active" : "alt"}
          style={{ width: 56, height: 40, fontSize: 14 }}
          title="Play the melody in from a connected keyboard or the on-screen keys"
          onClick={() => setPlayIn(!playIn)}
        >
          ▶ IN
        </Button>
      )}
      {/* "∅" statt des Papierkorb-Emojis: das blieb auf dem Pi-Kiosk ohne
          Color-Emoji-Font leer (s. Nutzer-Feedback beim Delete-Knopf) — ∅ ist
          ein normales Textzeichen und meint dasselbe ("leer machen"). */}
      <Button
        variant="danger"
        style={{ width: 44, height: 40, fontSize: 18 }}
        title="Remove every note in this melody"
        disabled={noteCount === 0}
        onClick={() => setConfirmClear(true)}
      >
        ∅
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
  paint,
}: {
  block: Block;
  flow: StepFlow;
  layout: MelodyLayout;
  playIn: boolean;
  /** Paint-Werkzeug lebt in BlockDetail (s. dort) und rendert die Farb-Leiste
   *  selbst, in derselben Kopfzeile wie Play/Clear/Delete — die Rolle hier
   *  braucht das armierte Werkzeug nur lesend, für Tipper auf die Zellen. */
  paint: PaintTool;
}) {
  return layout === "stack" ? (
    <MelodyStack block={block} flow={flow} />
  ) : (
    <MelodyGrid block={block} flow={flow} playIn={playIn} paint={paint} />
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

/** Höhe der Velocity-Bar-Zeile unter den Notenspalten — s. `VelocityBars`. */
const VEL_BAR_H = 90;

/** 1..127, von der senkrechten Zeigerposition in der Bar gelesen (oben = 127,
 *  unten = 1) — 0 fehlt hier aus demselben Grund wie in NoteEditor: das wäre
 *  auf dem Draht ein Note-Off. */
function velocityFromPointer(e: React.PointerEvent<HTMLDivElement>): number {
  const rect = e.currentTarget.getBoundingClientRect();
  const frac = 1 - (e.clientY - rect.top) / rect.height;
  return Math.min(127, Math.max(1, Math.round(frac * 127)));
}

/** Eine Velocity-Bar pro Step, direkt unter den Notenspalten — dieselbe
 *  Ziehen-oder-Wischen-Weiche wie CcEditor's "stepped"-Layer-Kästen (senkrecht
 *  ziehen setzt den Wert, waagerecht wischen scrollt das Raster weiter), damit
 *  sich Velocity so schnell setzen lässt wie ein CC-Wert — kein Umweg über den
 *  Noten-Editor für jede einzelne Note. Ein Step mit mehreren gestapelten Noten
 *  (Akkord) bekommt EINE Bar, die alle davon zusammen setzt: eine eigene Bar je
 *  Note wäre auf dem Touchdisplay zu schmal, um noch treffsicher zu sein. */
function VelocityBars({ block, steps, notes }: { block: Block; steps: number[]; notes: NonNullable<Block["notes"]> }) {
  const send = useSend();
  const gesture = useRef<{ x: number; y: number; mode: "idle" | "draw" | "pan" }>({ x: 0, y: 0, mode: "idle" });
  const DIR_SLOP = 6;

  const dragMode = (e: React.PointerEvent<HTMLDivElement>): boolean => {
    const g = gesture.current;
    if (g.mode !== "idle") return g.mode === "draw";
    const dx = Math.abs(e.clientX - g.x);
    const dy = Math.abs(e.clientY - g.y);
    if (Math.max(dx, dy) < DIR_SLOP) return false;
    g.mode = dy >= dx ? "draw" : "pan";
    return g.mode === "draw";
  };

  const stepNotesOf = (step: number) => notes.filter((n) => n.step === step).sort((a, b) => b.note - a.note);

  const setVelocity = (step: number, e: React.PointerEvent<HTMLDivElement>) => {
    const stepNotes = stepNotesOf(step);
    if (stepNotes.length === 0) return;
    const velocity = velocityFromPointer(e);
    for (const n of stepNotes) {
      send({ t: "melody.setNoteVelocity", blockId: block.id, step, note: n.note, velocity });
    }
  };

  return (
    <>
      <div style={{ display: "flex", marginTop: 6 }}>
        {steps.map((step) => {
          const stepNotes = stepNotesOf(step);
          const has = stepNotes.length > 0;
          const vel = has ? (stepNotes[0].velocity ?? 100) : 0;
          const barH = has ? Math.max(3, (vel / 127) * (VEL_BAR_H - 4)) : 0;
          return (
            <div
              key={step}
              style={{
                width: STACK_CELL,
                flexShrink: 0,
                height: VEL_BAR_H,
                margin: 1,
                border: "1px solid var(--pal-step-border)",
                background: "var(--pal-step-off)",
                display: "flex",
                alignItems: "flex-end",
                opacity: has ? 1 : 0.35,
                cursor: has ? "pointer" : "default",
                touchAction: "pan-x",
              }}
              onPointerDown={(e) => {
                if (!has) return;
                e.currentTarget.setPointerCapture(e.pointerId);
                gesture.current = { x: e.clientX, y: e.clientY, mode: "idle" };
              }}
              onPointerMove={(e) => {
                if (has && e.buttons === 1 && dragMode(e)) setVelocity(step, e);
              }}
              onPointerUp={(e) => {
                if (has && gesture.current.mode === "idle") setVelocity(step, e);
                gesture.current.mode = "pan";
              }}
              onPointerCancel={() => {
                gesture.current.mode = "pan";
              }}
            >
              {has && <div style={{ width: "100%", height: barH, background: "var(--pal-btn-active)" }} />}
            </div>
          );
        })}
      </div>
      <div style={{ display: "flex" }}>
        {steps.map((step) => {
          const stepNotes = stepNotesOf(step);
          return (
            <div
              key={step}
              style={{ width: STACK_CELL, margin: 1, textAlign: "center", fontSize: 9, color: "var(--pal-text-dim)" }}
            >
              {stepNotes.length > 0 ? (stepNotes[0].velocity ?? 100) : "–"}
            </div>
          );
        })}
      </div>
    </>
  );
}

function MelodyStack({ block, flow }: { block: Block; flow: StepFlow }) {
  const send = useSend();
  const openNotePicker = useNotePicker();
  const [editing, setEditing] = useState<NoteRef | null>(null);
  const stepsPerBar = block.stepsPerBar ?? 16;
  const totalSteps = stepsPerBar * (block.lengthBars ?? 1);
  const notes = block.notes ?? [];

  return (
    <div>
      <StepBars totalSteps={totalSteps} stepsPerBar={stepsPerBar} cellW={STACK_COL} flow={flow}>
        {(steps) => (
          <>
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
                      openNotePicker(stepNotes[stepNotes.length - 1]?.note ?? DEFAULT_BASE_NOTE, (n) =>
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
          <VelocityBars block={block} steps={steps} notes={notes} />
          </>
        )}
      </StepBars>

      <div style={{ marginTop: 10, fontSize: 12, color: "var(--pal-text-dim)" }}>
        Tap a note to remove it, long-press it for pitch, length and velocity. Tap "+" at the foot of a column to add a note
        (again for a chord on the same step). Drag the bars below a step to set velocity for every note there at once.
      </div>

      {editing && (
        <NoteEditorPopup block={block} target={editing} onRetarget={setEditing} onClose={() => setEditing(null)} />
      )}
    </div>
  );
}

// ── Paint-Werkzeuge ─────────────────────────────────────────────────────────
// Statt für jede Längen-/Velocity-Änderung den Noten-Editor aufzumachen: eine
// Farbe wählen, dann direkt im Raster tippen. Grau ist an dieselbe Bedeutung
// gebunden, die die Halte-Spur ohnehin schon zeigt (`--pal-step-held`) — mit
// Grau angewählt verlängert ein Tipper auf JEDE Zelle rechts einer Note diese
// bis dorthin, nicht nur innerhalb ihrer schon gezeichneten Spur. Rot/Grün/Blau
// sind frei belegbare Velocity-Akzente (lang drücken auf die Farbe ändert
// ihren Wert) — ein Tipper auf eine Note akzentuiert sie, ein Tipper auf eine
// leere Zelle setzt gleich eine neue Note mit diesem Anschlag.

export type PaintTool = "grey" | "red" | "green" | "blue" | null;
type PaintColor = "red" | "green" | "blue";

const PAINT_VELOCITY_DEFAULT: Record<PaintColor, number> = { red: 127, green: 90, blue: 50 };
const PAINT_SWATCH_HEX: Record<Exclude<PaintTool, null>, string> = {
  grey: "#8a8a8a",
  red: "#e74c3c",
  green: "#2ecc71",
  blue: "#4aa3ff",
};
const PAINT_VELOCITY_PRESETS = [20, 40, 60, 80, 100, 110, 127];

/** Velocity-Wert einer Farbe — client-seitige Werkzeug-Einstellung, nicht Teil
 *  des Projekts (s. `useLocalPref`s Kopfkommentar), daher pro Browser/Gerät
 *  eigen einstellbar. Mehrere Aufrufer (Toolbar-Anzeige UND `applyPaint`)
 *  bleiben über den Storage-Listener automatisch synchron. */
function usePaintVelocity(color: PaintColor): [number, (v: number) => void] {
  const [raw, setRaw] = useLocalPref(`melody.paint.${color}.vel`, String(PAINT_VELOCITY_DEFAULT[color]));
  const value = Math.min(127, Math.max(1, parseInt(raw, 10) || PAINT_VELOCITY_DEFAULT[color]));
  return [value, (v) => setRaw(String(Math.min(127, Math.max(1, Math.round(v)))))];
}

function PaintSwatch({
  active,
  color,
  title,
  onTap,
  onHold,
}: {
  active: boolean;
  color: string;
  title: string;
  onTap: () => void;
  onHold?: () => void;
}) {
  const press = useLongPress(onHold ?? (() => {}), onTap);
  const handlers = onHold ? { ...press, onPointerCancel: press.onPointerLeave } : { onClick: onTap };
  return (
    <div
      title={title}
      {...handlers}
      style={{
        width: 48,
        height: 48,
        borderRadius: "50%",
        background: color,
        border: active ? "4px solid var(--pal-text)" : "4px solid transparent",
        cursor: "pointer",
        flexShrink: 0,
      }}
    />
  );
}

function PaintVelocityPopup({
  color,
  value,
  onChange,
  onClose,
}: {
  color: PaintColor;
  value: number;
  onChange: (v: number) => void;
  onClose: () => void;
}) {
  return (
    <Popup onClose={onClose}>
      <div className="popup-title" style={{ textTransform: "capitalize" }}>
        {color} paint — velocity
      </div>
      <div style={{ fontSize: 13, color: "var(--pal-text-dim)", marginBottom: 10 }}>
        Tapping a note with {color} selected sets it to this velocity — tapping an empty cell places a new note with it.
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 10 }}>
        {PAINT_VELOCITY_PRESETS.map((n) => (
          <Button
            key={n}
            variant={n === value ? "active" : "alt"}
            style={{ width: 58, height: 46, fontSize: 16 }}
            onClick={() => onChange(n)}
          >
            {n}
          </Button>
        ))}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 16 }}>
        <Button variant="alt" style={{ width: 62, height: 50, fontSize: 16 }} disabled={value <= 1} onClick={() => onChange(value - 5)}>
          −
        </Button>
        <Button variant="alt" style={{ width: 62, height: 50, fontSize: 16 }} disabled={value >= 127} onClick={() => onChange(value + 5)}>
          +
        </Button>
        <div style={{ flex: 1, alignSelf: "center", fontSize: 15, textAlign: "center" }}>{value}</div>
      </div>
      <Button variant="active" style={{ width: "100%", height: 46, fontSize: 15 }} onClick={onClose}>
        Done
      </Button>
    </Popup>
  );
}

export function PaintToolbar({ paint, setPaint }: { paint: PaintTool; setPaint: (v: PaintTool) => void }) {
  const [redVel, setRedVel] = usePaintVelocity("red");
  const [greenVel, setGreenVel] = usePaintVelocity("green");
  const [blueVel, setBlueVel] = usePaintVelocity("blue");
  const [editing, setEditing] = useState<PaintColor | null>(null);
  const vel: Record<PaintColor, number> = { red: redVel, green: greenVel, blue: blueVel };
  const setVel: Record<PaintColor, (v: number) => void> = { red: setRedVel, green: setGreenVel, blue: setBlueVel };

  const swatches: { key: Exclude<PaintTool, null>; title: string }[] = [
    { key: "grey", title: "Tap a note (or the empty cells after it) to lengthen it up to there" },
    { key: "red", title: `Accent — sets velocity ${redVel} (long-press to change)` },
    { key: "green", title: `Velocity ${greenVel} (long-press to change)` },
    { key: "blue", title: `Velocity ${blueVel} (long-press to change)` },
  ];

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
      {swatches.map((s) => (
        <PaintSwatch
          key={s.key}
          active={paint === s.key}
          color={PAINT_SWATCH_HEX[s.key]}
          title={s.title}
          onTap={() => setPaint(paint === s.key ? null : s.key)}
          onHold={s.key === "grey" ? undefined : () => setEditing(s.key as PaintColor)}
        />
      ))}
      {/* Kein Hinweistext mehr, sobald eine Farbe armiert ist — der drängte die
          Zeile über die Bildschirmbreite und sprengte sie in eine zweite (s.
          Nutzer-Feedback). Die Anleitung darunter im Editor deckt dasselbe ab. */}
      {editing && (
        <PaintVelocityPopup color={editing} value={vel[editing]} onChange={setVel[editing]} onClose={() => setEditing(null)} />
      )}
    </div>
  );
}

// ── Piano-Roll-Ansicht ──────────────────────────────────────────────────────

// Quadratische Zellen: eine 34×20-Zelle ist mit dem Finger senkrecht kaum zu
// treffen — daneben liegt sofort die nächste Tonhöhe. Gleich hoch wie breit
// kostet Sichtfeld (der Ausschnitt scrollt ohnehin), trifft dafür. 64 statt 50:
// selbst 50 war für einen Finger noch knapp (s. Nutzer-Feedback) — das
// Sichtfeld verkleinert sich dadurch, aber die Rolle ist ja ohnehin auf
// Scrollen ausgelegt (und seit der Zeilen-Virtualisierung kostet das nichts).
const ROW_H = 64;
const CELL_W = 64;

/** Akkord-Typen für den Lang-Druck auf eine leere Zelle (s. `ChordPickerPopup`)
 *  — Intervalle in Halbtönen ÜBER der angetippten Tonhöhe, die selbst immer
 *  mitkommt (0 steht deshalb nicht extra in jeder Liste, sondern wird beim
 *  Senden vorangestellt). Bewusst nur Grundstellungen: eine Umkehrung wäre ein
 *  zweiter Auswahlschritt, den man auf dem Touchdisplay danach ohnehin per
 *  Lang-Druck + Tonhöhe-Editor auf die einzelne Note anwenden kann.  */
const CHORD_KINDS: { label: string; intervals: number[] }[] = [
  { label: "Major", intervals: [4, 7] },
  { label: "Minor", intervals: [3, 7] },
  { label: "Dim", intervals: [3, 6] },
  { label: "Aug", intervals: [4, 8] },
  { label: "Sus2", intervals: [2, 7] },
  { label: "Sus4", intervals: [5, 7] },
  { label: "Maj7", intervals: [4, 7, 11] },
  { label: "Min7", intervals: [3, 7, 10] },
  { label: "Dom7", intervals: [4, 7, 10] },
  { label: "Maj6", intervals: [4, 7, 9] },
];

function ChordPickerPopup({
  block,
  step,
  root,
  onClose,
}: {
  block: Block;
  step: number;
  root: number;
  onClose: () => void;
}) {
  const send = useSend();
  const addChord = (intervals: number[]) => {
    for (const semi of [0, ...intervals]) {
      const note = root + semi;
      if (note < 0 || note > 127) continue;
      send({ t: "melody.addNote", blockId: block.id, step, note });
    }
    onClose();
  };
  return (
    <Popup onClose={onClose}>
      <div className="popup-title">
        Chord · step {step + 1} · {noteName(root)}
      </div>
      <div style={{ fontSize: 13, color: "var(--pal-text-dim)", marginBottom: 10 }}>
        Stacks every chord tone on this step, rooted at {noteName(root)}.
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {CHORD_KINDS.map((k) => (
          <Button key={k.label} variant="alt" style={{ width: 84, height: 46, fontSize: 14 }} onClick={() => addChord(k.intervals)}>
            {k.label}
          </Button>
        ))}
      </div>
    </Popup>
  );
}

function MelodyGrid({
  block,
  flow,
  playIn,
  paint,
}: {
  block: Block;
  flow: StepFlow;
  playIn: boolean;
  paint: PaintTool;
}) {
  const send = useSend();
  const [editing, setEditing] = useState<NoteRef | null>(null);
  const [chordPick, setChordPick] = useState<NoteRef | null>(null);
  const [redVel] = usePaintVelocity("red");
  const [greenVel] = usePaintVelocity("green");
  const [blueVel] = usePaintVelocity("blue");
  const stepsPerBar = block.stepsPerBar ?? 16;
  const totalSteps = stepsPerBar * (block.lengthBars ?? 1);
  const notes = block.notes ?? [];
  // Umfasst alle `.step-scroller` dieser Rolle — bei Layout "wrap" ist das
  // einer pro Takt-Zeile, nicht nur einer. Ein Klick auf +8ve/-8ve/Grundnote
  // bewegt sie alle gleich weit, sonst zeigten Takt-Zeilen nach dem Springen
  // unterschiedliche Tonhöhen-Ausschnitte.
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const forEachScroller = (fn: (el: HTMLElement) => void) => {
    wrapperRef.current?.querySelectorAll<HTMLElement>(".step-scroller").forEach(fn);
  };
  const jumpOctave = (semitones: number) => {
    forEachScroller((el) => el.scrollBy({ top: -semitones * ROW_H, behavior: "smooth" }));
  };
  const jumpToBaseNote = () => {
    forEachScroller((el) => {
      // Rechnet die Ziel-Zeile aus `data-rows-top` aus, statt sie per
      // `[data-roll-center]` im DOM zu suchen: die Zeile selbst ist
      // virtualisiert und steht nur im DOM, solange sie im sichtbaren
      // Fenster (± Überstand) liegt — weit weggescrollt fände `querySelector`
      // sie also gar nicht mehr (s. `RollRows`).
      const anchor = el.querySelector<HTMLElement>("[data-rows-top]");
      if (!anchor) return;
      const index = ROLL_HIGH_NOTE - DEFAULT_BASE_NOTE;
      const wanted = anchor.offsetTop + index * ROW_H + ROW_H / 2 - el.clientHeight / 2;
      el.scrollTo({ top: Math.max(0, Math.min(wanted, el.scrollHeight - el.clientHeight)), behavior: "smooth" });
    });
  };
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

  /** Wendet das armierte Paint-Werkzeug auf eine getippte Zelle an — s. den
   *  Kopfkommentar über `PaintToolbar`. Grau: trifft der Tipper die Note
   *  selbst, wächst sie um einen Step; trifft er ihre (ggf. noch gar nicht
   *  gezeichnete) Fortsetzung, wird ihre Länge auf genau diesen Step gesetzt —
   *  das kürzt (Tipper innerhalb der Spur) oder verlängert (Tipper danach) je
   *  nachdem, wo er landet. Farben: auf einer Note ändern sie nur die
   *  Velocity, auf einer leeren Zelle setzen sie gleich eine neue Note damit.
   */
  const applyPaint = (tool: Exclude<PaintTool, null>, step: number, pitch: number) => {
    const rowNotes = byPitch.get(pitch) ?? [];
    const own = rowNotes.find((n) => n.step === step);
    const covering = own ?? rowNotes.find((n) => n.step < step && n.step + Math.max(1, n.lengthSteps ?? 1) > step);

    if (tool === "grey") {
      if (covering) {
        const newLen = own ? Math.max(1, covering.lengthSteps ?? 1) + 1 : step - covering.step + 1;
        send({ t: "melody.setNoteLength", blockId: block.id, step: covering.step, note: pitch, lengthSteps: newLen });
        return;
      }
      let preceding: (typeof rowNotes)[number] | undefined;
      for (const n of rowNotes) if (n.step < step && (!preceding || n.step > preceding.step)) preceding = n;
      if (preceding) {
        send({ t: "melody.setNoteLength", blockId: block.id, step: preceding.step, note: pitch, lengthSteps: step - preceding.step + 1 });
      }
      return;
    }

    const vel = tool === "red" ? redVel : tool === "green" ? greenVel : blueVel;
    if (covering) send({ t: "melody.setNoteVelocity", blockId: block.id, step: covering.step, note: pitch, velocity: vel });
    else send({ t: "melody.addNote", blockId: block.id, step, note: pitch, velocity: vel });
  };

  return (
    <div ref={wrapperRef} style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      {/* Springt über die volle Tonhöhen-Skala, statt sie leerzuscrollen —
          116 Zeilen bei ~15 sichtbaren sind sonst viel Wischen für eine weit
          entfernte Tonhöhe (s. Nutzer-Feedback zur Rolle). */}
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 6, marginBottom: 6, flexShrink: 0 }}>
        <Button variant="alt" style={{ width: 56, height: 34, fontSize: 13 }} title="Scroll one octave up" onClick={() => jumpOctave(12)}>
          +8ve
        </Button>
        <Button
          variant="alt"
          style={{ width: 64, height: 34, fontSize: 13 }}
          title="Scroll to the block's base note"
          onClick={jumpToBaseNote}
        >
          {noteName(DEFAULT_BASE_NOTE)}
        </Button>
        <Button variant="alt" style={{ width: 56, height: 34, fontSize: 13 }} title="Scroll one octave down" onClick={() => jumpOctave(-12)}>
          −8ve
        </Button>
      </div>
      <StepBars
        totalSteps={totalSteps}
        stepsPerBar={stepsPerBar}
        cellW={CELL_W}
        flow={flow}
        fillHeight
        cursorStep={playIn ? play.cursor : undefined}
        onPickStep={playIn ? play.setCursor : undefined}
        leftGutter={ROLL_KEY_W}
      >
        {(steps) => (
          <RollRows
            rows={rows}
            steps={steps}
            stepsPerBar={stepsPerBar}
            block={block}
            playIn={playIn}
            play={play}
            paint={paint}
            applyPaint={applyPaint}
            noteAt={noteAt}
            heldAt={heldAt}
            send={send}
            setEditing={setEditing}
            setChordPick={setChordPick}
          />
        )}
      </StepBars>

      <div style={{ marginTop: 6, fontSize: 12, color: "var(--pal-text-dim)", flexShrink: 0 }}>
        {playIn ? (
          <>
            Play a connected MIDI keyboard or the keys below — notes land on the marked step, held keys become one chord, and the
            cursor moves on when you let go. Tap the ruler to jump the cursor, "▶" leaves a rest. Editing by tap still works.
          </>
        ) : paint === "grey" ? (
          <>Grey armed — tap a note to grow it by one step, or any cell after it to lengthen (or shorten) it up to there.</>
        ) : paint ? (
          <>{paint[0].toUpperCase() + paint.slice(1)} armed — tap a note to accent it, an empty cell to place a new one with it.</>
        ) : (
          <>
            Tap an empty cell to place a note, tap the note again to remove it, tap its trail to end it there. Long-press a note
            for pitch, length and velocity, or an empty cell to stack a chord there. Hold a key at either end of a row to hear
            that pitch. Pick a paint color above to skip the editor for length/velocity — tap the color again to let go of it.
          </>
        )}
      </div>

      {playIn && <PlayInBar playIn={play} totalSteps={totalSteps} stepsPerBar={stepsPerBar} baseNote={DEFAULT_BASE_NOTE} />}

      {editing && (
        <NoteEditorPopup block={block} target={editing} onRetarget={setEditing} onClose={() => setEditing(null)} />
      )}
      {chordPick && (
        <ChordPickerPopup block={block} step={chordPick.step} root={chordPick.note} onClose={() => setChordPick(null)} />
      )}
    </div>
  );
}

/** Zusätzliche Tonhöhen-Zeilen, die über das gemessene Sichtfenster hinaus
 *  gemountet bleiben — billig dank `.roll-row`s `content-visibility:auto`
 *  (theme.css), nur genug Puffer, dass ein schneller Wisch keine leeren
 *  Zeilen für einen Frame aufblitzen lässt. */
const ROLL_OVERSCAN = 6;

/** Großzügiges Fenster für den allerersten Render, bevor der Scroller
 *  vermessen ist — breit genug für jeden realen Bildschirm, damit die
 *  Grundnoten-Zeile (`data-roll-center`, von StepScrollers Start-Scroll
 *  gelesen) beim Mount garantiert schon steht. */
const ROLL_INITIAL_HALF = 24;

/** Liest die sichtbare Zeilen-Spanne aus dem `.step-scroller`, der `anchorRef`
 *  umschließt — einem pro Takt-Zeile bei Layout "wrap", einem einzigen bei
 *  "scroll" (s. StepGrid.tsx). Der Scroller wird per `closest()` erst im
 *  Effekt gesucht (Refs sind beim Commit schon gesetzt, bevor Effekte
 *  laufen), darum startet der Hook mit einem großzügig geschätzten Fenster
 *  statt mit leerem Zustand. */
function useVisibleRollRows(
  anchorRef: { current: HTMLElement | null },
  rowCount: number,
  rowH: number,
  initialCenter: number,
): [number, number] {
  const [range, setRange] = useState<[number, number]>(() => [
    Math.max(0, initialCenter - ROLL_INITIAL_HALF),
    Math.min(rowCount, initialCenter + ROLL_INITIAL_HALF),
  ]);

  useEffect(() => {
    const container = anchorRef.current?.closest<HTMLElement>(".step-scroller");
    if (!container) return;
    let raf = 0;
    const measure = () => {
      raf = 0;
      const start = Math.max(0, Math.floor(container.scrollTop / rowH) - ROLL_OVERSCAN);
      const end = Math.min(
        rowCount,
        Math.ceil((container.scrollTop + container.clientHeight) / rowH) + ROLL_OVERSCAN,
      );
      setRange((prev) => (prev[0] === start && prev[1] === end ? prev : [start, end]));
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(measure);
    };
    measure();
    container.addEventListener("scroll", onScroll, { passive: true });
    const ro = new ResizeObserver(onScroll);
    ro.observe(container);
    return () => {
      container.removeEventListener("scroll", onScroll);
      ro.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [anchorRef, rowCount, rowH]);

  return range;
}

/** Tonhöhen-Zeilen EINER Takt-Zeile der Piano-Rolle, virtualisiert: die volle
 *  MIDI-Skala sind 116 Zeilen, sichtbar sind auf dem Display vielleicht 15 —
 *  ungefiltert gemountet bedeutete, dass jede Notenänderung (und jede fremde
 *  Projektänderung, solange dieser Editor offen ist, s. MelodyGrid-Kopf) alle
 *  116 neu anlegte und abglich. `.roll-row`s `content-visibility` erspart dem
 *  Browser nur das MALEN der ausgeblendeten Zeilen — das hier erspart React
 *  das Anlegen als Elemente überhaupt, und DAS kostete auf dem Pi die Zeit. */
function RollRows({
  rows,
  steps,
  stepsPerBar,
  block,
  playIn,
  play,
  paint,
  applyPaint,
  noteAt,
  heldAt,
  send,
  setEditing,
  setChordPick,
}: {
  rows: number[];
  steps: number[];
  /** Für die Takt-Trennlinien — s. `RollCell`s `barStart`. */
  stepsPerBar: number;
  block: Block;
  playIn: boolean;
  play: PlayIn;
  paint: PaintTool;
  applyPaint: (tool: Exclude<PaintTool, null>, step: number, pitch: number) => void;
  noteAt: (step: number, pitch: number) => MelodyNote | undefined;
  heldAt: (step: number, pitch: number) => MelodyNote | undefined;
  send: ReturnType<typeof useSend>;
  setEditing: (ref: NoteRef) => void;
  setChordPick: (ref: NoteRef) => void;
}) {
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const initialCenter = Math.max(0, rows.indexOf(DEFAULT_BASE_NOTE));
  const [start, end] = useVisibleRollRows(anchorRef, rows.length, ROW_H, initialCenter);

  return (
    // Anker mit fester Position relativ zum Scroller, unabhängig vom
    // Scroll-Stand — anders als die Zeilen selbst, die außerhalb von
    // [start,end) gar nicht im DOM stehen (s. MelodyGrids `jumpToBaseNote`,
    // die genau deshalb NICHT über `[data-roll-center]` sucht, wenn das
    // Ziel gerade nicht sichtbar ist).
    <div ref={anchorRef} data-rows-top="">
      {start > 0 && <div style={{ height: start * ROW_H }} />}
      {rows.slice(start, end).map((note) => {
        const isC = ((note % 12) + 12) % 12 === 0;
        return (
          <div
            key={note}
            className="step-row roll-row"
            // Anker für den Start-Scroll des Ausschnitts (s. StepScroller).
            data-roll-center={note === DEFAULT_BASE_NOTE ? "" : undefined}
            style={
              {
                // C bleibt die kräftigste Markierung (Oktavgrenze). Alle
                // anderen Zeilen bekommen nur einen HAUCH Unterschied je
                // Taste (weiß heller, schwarz dunkler) — genug, um beim
                // Blick über die Rolle die Tastatur wiederzuerkennen, ohne
                // mit der viel helleren gehaltenen Note zu konkurrieren.
                background: isC
                  ? "var(--pal-panel-deep)"
                  : isBlackKey(note)
                    ? "var(--pal-roll-black)"
                    : "var(--pal-roll-white)",
                // Platzhalterhöhe der ausgeblendeten Zeilen (s. .roll-row).
                "--roll-row-h": `${ROW_H}px`,
              } as CSSProperties
            }
          >
            {/* Klaviatur auch links: hält man das Display mit der rechten
                Hand, verdeckt genau die die Tasten am rechten Rand — die
                Zeile bleibt so in jeder Griffhaltung lesbar. Klebt (sticky)
                am linken Rand des Scrollers, verdrängt also die Zellen statt
                sie zu überdecken (s. `leftGutter` an StepBars für das
                passende Lineal-Gegenstück). */}
            <RollKey
              note={note}
              label={noteName(note)}
              height={ROW_H}
              side="left"
              onPress={() => send({ t: "block.previewNote", blockId: block.id, note, on: true })}
              onRelease={() => send({ t: "block.previewNote", blockId: block.id, note, on: false })}
            />
            {steps.map((step) => {
              const noteStart = noteAt(step, note);
              const held = !noteStart ? heldAt(step, note) : undefined;
              return (
                <RollCell
                  key={step}
                  // Anfang eines neuen Takts (außer dem allerersten Step) —
                  // eine kräftigere Linie, damit man beim Scrollen durch
                  // mehrtaktige Melodien sieht, wo ein Takt endet und der
                  // nächste beginnt (s. Nutzer-Feedback).
                  barStart={step > 0 && step % stepsPerBar === 0}
                  // Die Spalte, auf die das nächste Gespielte geht.
                  cursor={playIn && step === play.cursor}
                  // Gehaltene Note als eigener, DECKENDER Grauton statt als
                  // halbtransparentes Weiß — vorher schimmerte die Zeile
                  // darunter durch und die Note sah "leer" aus.
                  background={
                    noteStart ? "var(--pal-btn-active)" : held ? "var(--pal-step-held)" : "var(--pal-step-off)"
                  }
                  onTap={() => {
                    // Werkzeug armiert: es entscheidet allein, s.
                    // `applyPaint` — kein Setzen/Entfernen daneben.
                    if (paint) {
                      applyPaint(paint, step, note);
                      return;
                    }
                    // Auf dem Anfang: Note wieder weg — derselbe Tipper,
                    // der sie gesetzt hat, nimmt sie zurück. Auf dem
                    // Halte-Schweif: Note bis GENAU hierher kürzen — das
                    // ist die schnelle Länge direkt im Raster, ohne Umweg.
                    // Leere Zelle: neue Note.
                    if (noteStart)
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
                  // Halte-Schweif aus, der gehört ja zur selben Note. Auf
                  // einer leeren Zelle stapelt es stattdessen einen Akkord
                  // ab genau dieser Tonhöhe (s. `ChordPickerPopup`) — der
                  // kurze Tipper bleibt dort weiterhin die einzelne Note.
                  onLongPress={
                    noteStart || held
                      ? () => setEditing({ step: (noteStart ?? held)!.step, note })
                      : () => setChordPick({ step, note })
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
              side="right"
              onPress={() => send({ t: "block.previewNote", blockId: block.id, note, on: true })}
              onRelease={() => send({ t: "block.previewNote", blockId: block.id, note, on: false })}
            />
          </div>
        );
      })}
      {end < rows.length && <div style={{ height: (rows.length - end) * ROW_H }} />}
    </div>
  );
}

/** Eine Piano-Roll-Zelle. Eigene Komponente nur, weil `useLongPress` ein Hook
 *  ist und deshalb nicht in der Zellen-Schleife stehen darf. */
function RollCell({
  background,
  cursor,
  barStart,
  onTap,
  onLongPress,
}: {
  background: string;
  /** Liegt die Zelle auf dem Schreib-Cursor des Einspielens? */
  cursor?: boolean;
  /** Erster Step eines neuen Takts (außer dem allerersten) — kräftigere
   *  linke Kante statt des normalen Zellrahmens, s. `RollRows`. */
  barStart?: boolean;
  onTap: () => void;
  /** RollRows liefert das immer — Note oder leere Zelle öffnen beide etwas
   *  (Editor bzw. Akkord-Auswahl), nur WAS unterscheidet sich. Bleibt
   *  trotzdem optional: ohne Halte-Ziel soll auch kein Halte-Timer laufen,
   *  der sonst einen langsamen Tipper verschluckt (s. `useLongPress`). */
  onLongPress?: () => void;
}) {
  const press = useLongPress(onLongPress ?? (() => {}), onTap);
  const handlers = onLongPress
    ? // Quer-Wischen zum Scrollen darf weder als Tipper noch als langes
      // Drücken enden (s. dieselbe Stelle in StepGrid's StepCell).
      { ...press, onPointerCancel: press.onPointerLeave }
    : { onClick: onTap };
  return (
    <div
      className={`step-cell${cursor ? " step-cursor" : ""}`}
      style={{
        width: CELL_W - 2,
        height: ROW_H,
        background,
        ...(barStart ? { borderLeft: "3px solid var(--pal-text-dim)" } : undefined),
      }}
      {...handlers}
    />
  );
}
