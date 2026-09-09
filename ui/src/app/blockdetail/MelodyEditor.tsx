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
import type { Block } from "../../state";
import { useSend } from "../store";
import { useNotePicker, noteName } from "../NotePicker";
import { Button } from "../widgets/Button";
import { Popup } from "../widgets/Popup";
import { StepBars, StepCell, RollKey, ROLL_LOW_NOTE, ROLL_HIGH_NOTE, type StepFlow } from "./StepGrid";
import { useLongPress } from "../useLongPress";
import { useLocalPref } from "../useLocalPref";
import { NoteEditorPopup, type NoteRef } from "./NoteEditor";
import { usePlayIn, PlayInBar } from "./PlayIn";

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

type PaintTool = "grey" | "red" | "green" | "blue" | null;
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
        width: 32,
        height: 32,
        borderRadius: "50%",
        background: color,
        border: active ? "3px solid var(--pal-text)" : "3px solid transparent",
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

function PaintToolbar({ paint, setPaint }: { paint: PaintTool; setPaint: (v: PaintTool) => void }) {
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
    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
      <span style={{ fontSize: 12, color: "var(--pal-text-dim)" }}>Paint:</span>
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
      {paint && (
        <span style={{ fontSize: 12, color: "var(--pal-text-dim)" }}>
          {paint === "grey"
            ? "tap a note or the cells after it to lengthen it"
            : "tap a note to accent it, an empty cell to add one"}
        </span>
      )}
      {editing && (
        <PaintVelocityPopup color={editing} value={vel[editing]} onChange={setVel[editing]} onClose={() => setEditing(null)} />
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
  const [paint, setPaint] = useState<PaintTool>(null);
  // Ein armiertes Werkzeug gehört zur Sitzung an DIESEM Baustein — beim
  // Wechsel auf einen anderen soll nicht versehentlich eine fremde Note
  // akzentiert werden, nur weil das Werkzeug von vorhin noch stand.
  useEffect(() => setPaint(null), [block.id]);
  const [redVel] = usePaintVelocity("red");
  const [greenVel] = usePaintVelocity("green");
  const [blueVel] = usePaintVelocity("blue");
  const stepsPerBar = block.stepsPerBar ?? 16;
  const totalSteps = stepsPerBar * (block.lengthBars ?? 1);
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
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <PaintToolbar paint={paint} setPaint={setPaint} />
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
                data-roll-center={note === DEFAULT_BASE_NOTE ? "" : undefined}
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
        ) : paint === "grey" ? (
          <>Grey armed — tap a note to grow it by one step, or any cell after it to lengthen (or shorten) it up to there.</>
        ) : paint ? (
          <>{paint[0].toUpperCase() + paint.slice(1)} armed — tap a note to accent it, an empty cell to place a new one with it.</>
        ) : (
          <>
            Tap an empty cell to place a note, tap the note again to remove it, tap its trail to end it there. Long-press a note
            for pitch, length and velocity. Hold a key at the end of a row to hear that pitch. Pick a paint color above to skip the
            editor for length/velocity — tap the color again to let go of it.
          </>
        )}
      </div>

      {playIn && <PlayInBar playIn={play} totalSteps={totalSteps} stepsPerBar={stepsPerBar} baseNote={DEFAULT_BASE_NOTE} />}

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
