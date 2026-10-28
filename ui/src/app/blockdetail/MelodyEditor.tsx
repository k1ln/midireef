//! Melodie-Editor mit zwei Ansichten auf dieselben Noten — umschaltbar, weil
//! beide etwas können, was der anderen fehlt:
//!
//!   "stack" (Spalten) — je Step eine Spalte, die nach unten wächst. Zeigt
//!     Tonhöhe UND Notenlänge als Text, erlaubt Akkord-Stapel und ist auf dem
//!     Touchdisplay treffsicher. Der Verlauf einer Melodie ist aber nicht zu
//!     sehen: alle Noten stehen auf gleicher Höhe.
//!   "grid" (Piano-Roll) — Zeile = Tonhöhe, Zeit nach rechts, OHNE Zellraster
//!     (s. RollCanvas.tsx): Noten sind Balken, die dort beginnen, wo man sie
//!     setzt (Step + `microTiming`) und beliebig lang sind. Man SIEHT die
//!     Melodie, kann hineinzoomen und setzt Noten mit einem Tipper. Das ist die
//!     Standardansicht — nur sie kann Noten abbilden, die nicht auf einem Step
//!     liegen (eingespielte Takes!). Die Spalten-Ansicht zeigt sie auf ihrem Step.
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
//!
//! In der Piano-Rolle kommen dazu, NUR dort: Ziehen am rechten Ende einer Note
//! ändert ihre Länge live unter dem Finger, Ziehen am Rest verschiebt sie
//! (Zeit frei, Tonhöhe zeilenweise), und Zoom hält das Treffen auch bei langen
//! Bausteinen leicht — alles in `RollCanvas`.

import { useRef, useState } from "react";
import type { Block, MelodyNote } from "../../state";
import { useSend, useRuntime } from "../store";
import { useNotePicker, noteName } from "../NotePicker";
import { Button } from "../widgets/Button";
import { Popup } from "../widgets/Popup";
import { StepBars, StepCell, type StepFlow } from "./StepGrid";
import { RollCanvas, ROLL_MIN_LENGTH } from "./RollCanvas";
import { useLongPress } from "../useLongPress";
import { useLocalPref } from "../useLocalPref";
import { NoteEditorPopup, type NoteRef } from "./NoteEditor";
import { usePlayIn, PlayInBar, type PlayInMode } from "./PlayIn";

export type { PlayInMode } from "./PlayIn";

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
  setPlayInMode,
}: {
  block: Block;
  layout: MelodyLayout;
  setLayout: (v: MelodyLayout) => void;
  /** „Play in" — s. PlayIn.tsx. Der Zustand liegt (wie `layout`) im
   *  Baustein-Detail, weil sein Schalter hier oben und die Klaviatur unten
   *  unter dem Raster sitzt. */
  playIn: boolean;
  setPlayIn: (v: boolean) => void;
  /** Nur zum EINSCHALTEN gebraucht — s. `armPlayIn` unten. Der aktuelle Modus
   *  selbst braucht diese Leiste nicht (er steht nirgends in der Kopfzeile). */
  setPlayInMode: (v: PlayInMode) => void;
}) {
  const send = useSend();
  const runtime = useRuntime();
  const [confirmClear, setConfirmClear] = useState(false);
  const [pickMode, setPickMode] = useState(false);
  const noteCount = block.notes?.length ?? 0;

  /** Startet "Live" — und mit ihm den Transport, falls er noch steht: der
   *  Sinn des Modus ist ja gerade, dass der Baustein LÄUFT, während man
   *  hineinspielt (s. PlayIn.tsx-Kopf). Steht er schon, ändert der Aufruf
   *  nichts (`transport.play` ist keine Umschaltung). */
  const armLive = () => {
    setPlayInMode("live");
    setPlayIn(true);
    setPickMode(false);
    if (!runtime.isPlaying()) send({ t: "transport.play" });
  };

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
          + "IN" statt "Play in" ausgeschrieben — an/aus zeigt schon die Farbe.
          Einschalten fragt erst nach dem Modus (s. `pickMode`) — ausschalten
          bleibt ein einzelner Tipper, ganz gleich, in welchem Modus man war. */}
      {layout === "grid" && (
        <Button
          variant={playIn ? "active" : "alt"}
          style={{ width: 56, height: 40, fontSize: 14 }}
          title="Play the melody in from a connected keyboard or the on-screen keys"
          onClick={() => (playIn ? setPlayIn(false) : setPickMode(true))}
        >
          ▶ IN
        </Button>
      )}
      {pickMode && (
        <Popup onClose={() => setPickMode(false)}>
          <div className="popup-title">Play the melody in</div>
          <div style={{ fontSize: 13, color: "var(--pal-text-dim)", marginBottom: 14 }}>
            Step writes one step at a time, at your own pace — the transport doesn't need to run. Live loops this block and
            records what you play right where the playhead is.
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <Button
              variant="alt"
              style={{ flex: 1, height: 56, fontSize: 15 }}
              onClick={() => {
                setPlayInMode("step");
                setPlayIn(true);
                setPickMode(false);
              }}
            >
              ⎘ Step
            </Button>
            <Button variant="alt" style={{ flex: 1, height: 56, fontSize: 15 }} onClick={armLive}>
              ● Live
            </Button>
          </div>
        </Popup>
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
  playInMode,
  paint,
}: {
  block: Block;
  flow: StepFlow;
  layout: MelodyLayout;
  playIn: boolean;
  playInMode: PlayInMode;
  /** Paint-Werkzeug lebt in BlockDetail (s. dort) und rendert die Farb-Leiste
   *  selbst, in derselben Kopfzeile wie Play/Clear/Delete — die Rolle hier
   *  braucht das armierte Werkzeug nur lesend, für Tipper auf die Zellen. */
  paint: PaintTool;
}) {
  return layout === "stack" ? (
    <MelodyStack block={block} flow={flow} />
  ) : (
    <MelodyGrid block={block} flow={flow} playIn={playIn} playInMode={playInMode} paint={paint} />
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
                          <span style={{ fontSize: 10, color: "var(--pal-step-label)" }}>len {Math.round(len * 100) / 100}</span>
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
        // 38 statt 48: die Leiste frisst Höhe, die die Rolle braucht; ein
        // Daumen trifft 38px-Kreise trotzdem sicher.
        width: 38,
        height: 38,
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
// Ohne Zellraster: die Ansicht selbst steckt in `RollCanvas` (Zoom, Balken,
// Gesten). Hier steht, was die Gesten BEDEUTEN — Kommandos an den Server und
// das Paint-Werkzeug.

/** Anschlag einer frisch gesetzten Note, wenn kein Paint-Werkzeug etwas anderes
 *  vorgibt. */
const NEW_NOTE_VELOCITY = 100;

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
  micro,
  root,
  onClose,
}: {
  block: Block;
  step: number;
  /** Versatz im Step (0..1) — der Akkord beginnt dort, wo gedrückt wurde. */
  micro: number;
  root: number;
  onClose: () => void;
}) {
  const send = useSend();
  const addChord = (intervals: number[]) => {
    for (const semi of [0, ...intervals]) {
      const note = root + semi;
      if (note < 0 || note > 127) continue;
      send({ t: "melody.addNote", blockId: block.id, step, note, microTiming: micro });
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

/** Zeit in Steps (Bruchteile erlaubt) → Step + Versatz darin, so wie der Server
 *  eine Note speichert. Immer nach HINTEN versetzt: die Engine kann eine Note
 *  nicht vor ihrem Step spielen, also rundet das ab statt zu runden. */
function splitTime(t: number, totalSteps: number): { step: number; micro: number } {
  const clamped = Math.min(totalSteps - ROLL_MIN_LENGTH, Math.max(0, t));
  const step = Math.floor(clamped);
  return { step, micro: clamped - step };
}

function MelodyGrid({
  block,
  playIn,
  playInMode,
  paint,
}: {
  block: Block;
  /** Wird nicht mehr gebraucht — die Rolle hat kein Takt-Layout. Bleibt in der
   *  Signatur, damit `MelodyEditor` beide Ansichten gleich füttern kann. */
  flow: StepFlow;
  playIn: boolean;
  playInMode: PlayInMode;
  paint: PaintTool;
}) {
  const send = useSend();
  const [editing, setEditing] = useState<NoteRef | null>(null);
  const [chordPick, setChordPick] = useState<{ step: number; micro: number; note: number } | null>(null);
  const [redVel] = usePaintVelocity("red");
  const [greenVel] = usePaintVelocity("green");
  const [blueVel] = usePaintVelocity("blue");
  // Länge neuer Noten: die zuletzt gezogene. Eine Note einmal auf die gewünschte
  // Länge ziehen, und die nächsten Tipper setzen gleich lange — statt jede Note
  // einzeln zu dehnen.
  const [newLenPref, setNewLenPref] = useLocalPref<string>("melody.roll.newLength", "1");
  const newLength = Math.max(ROLL_MIN_LENGTH, parseFloat(newLenPref) || 1);
  const stepsPerBar = block.stepsPerBar ?? 16;
  const totalSteps = stepsPerBar * (block.lengthBars ?? 1);
  const notes = block.notes ?? [];
  // Einspielen: Schreib-Cursor + Tastatur-Eingang. Der Hook läuft immer mit
  // (Hooks dürfen nicht bedingt sein), armiert den Server aber nur, solange
  // `playIn` steht — s. PlayIn.tsx.
  const play = usePlayIn(block, totalSteps, playIn, playInMode);

  const addAt = (t: number, pitch: number, velocity: number) => {
    const { step, micro } = splitTime(t, totalSteps);
    send({
      t: "melody.addNote",
      blockId: block.id,
      step,
      note: pitch,
      velocity,
      lengthSteps: Math.min(newLength, totalSteps - (step + micro)),
      microTiming: micro,
    });
  };

  const setLength = (n: MelodyNote, lengthSteps: number) =>
    send({
      t: "melody.setNoteLength",
      blockId: block.id,
      step: n.step,
      note: n.note,
      lengthSteps: Math.max(ROLL_MIN_LENGTH, lengthSteps),
    });

  /** Tipper auf leere Fläche. Mit Paint-Werkzeug: Grau dehnt die Note davor
   *  (gleiche Tonhöhe) bis hierher, eine Farbe setzt gleich eine Note mit ihrem
   *  Anschlag. Ohne: neue Note genau hier. */
  const tapEmpty = (t: number, pitch: number) => {
    if (paint === "grey") {
      let before: MelodyNote | undefined;
      for (const n of notes) {
        const start = n.step + (n.microTiming ?? 0);
        if (n.note === pitch && start < t && (!before || start > before.step + (before.microTiming ?? 0))) before = n;
      }
      if (before) setLength(before, t - (before.step + (before.microTiming ?? 0)));
      return;
    }
    if (paint) addAt(t, pitch, paint === "red" ? redVel : paint === "green" ? greenVel : blueVel);
    else addAt(t, pitch, NEW_NOTE_VELOCITY);
  };

  /** Tipper auf eine Note. Mit Paint-Werkzeug: Grau dehnt sie um einen Step,
   *  eine Farbe setzt ihren Anschlag. Ohne: Note entfernen. */
  const tapNote = (n: MelodyNote) => {
    if (paint === "grey") {
      setLength(n, Math.min(totalSteps - n.step - (n.microTiming ?? 0), Math.max(ROLL_MIN_LENGTH, n.lengthSteps ?? 1) + 1));
    } else if (paint) {
      const velocity = paint === "red" ? redVel : paint === "green" ? greenVel : blueVel;
      send({ t: "melody.setNoteVelocity", blockId: block.id, step: n.step, note: n.note, velocity });
    } else {
      send({ t: "melody.removeNote", blockId: block.id, step: n.step, note: n.note });
    }
  };

  /** Verschieben = an der alten Stelle weg, an der neuen mit denselben Werten
   *  hin. Eine Note ist über (Step, Tonhöhe) adressiert — es gibt kein
   *  „umsetzen"-Kommando, und zwei Kommandos nacheinander sind in der
   *  Reihenfolge sicher. */
  const moveNote = (n: MelodyNote, t: number, pitch: number) => {
    const { step, micro } = splitTime(t, totalSteps);
    if (step === n.step && pitch === n.note && Math.abs(micro - (n.microTiming ?? 0)) < 0.001) return;
    send({ t: "melody.removeNote", blockId: block.id, step: n.step, note: n.note });
    send({
      t: "melody.addNote",
      blockId: block.id,
      step,
      note: Math.min(127, Math.max(0, pitch)),
      velocity: n.velocity,
      lengthSteps: Math.min(Math.max(ROLL_MIN_LENGTH, n.lengthSteps ?? 1), totalSteps - (step + micro)),
      microTiming: micro,
    });
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <RollCanvas
        blockId={block.id}
        notes={notes}
        totalSteps={totalSteps}
        stepsPerBar={stepsPerBar}
        centerNote={DEFAULT_BASE_NOTE}
        send={send}
        // Im Live-Modus IST der Cursor der Playhead — den zeichnet die Rolle
        // ohnehin; ein Band käme nur doppelt.
        cursorStep={playIn && playInMode === "step" ? play.cursor : undefined}
        onPickStep={playIn && playInMode === "step" ? play.setCursor : undefined}
        onTapEmpty={tapEmpty}
        onLongPressEmpty={(t, pitch) => {
          const { step, micro } = splitTime(t, totalSteps);
          setChordPick({ step, micro, note: pitch });
        }}
        onTapNote={tapNote}
        onLongPressNote={(n) => setEditing({ step: n.step, note: n.note })}
        onMoveNote={moveNote}
        onResizeNote={(n, len) => {
          const clamped = Math.min(len, Math.max(ROLL_MIN_LENGTH, totalSteps - n.step - (n.microTiming ?? 0)));
          setLength(n, clamped);
          setNewLenPref(String(Math.round(clamped * 1000) / 1000));
        }}
      />

      <div style={{ marginTop: 6, fontSize: 12, color: "var(--pal-text-dim)", flexShrink: 0 }}>
        {playIn && playInMode === "live" ? (
          <>
            Play a connected MIDI keyboard or the keys below — the block loops and each note lands exactly where you played
            it, with the length you actually held it. Editing by tap still works.
          </>
        ) : playIn ? (
          <>
            Play a connected MIDI keyboard or the keys below — notes land on the marked step, held keys become one chord, and the
            cursor moves on when you let go. Tap the ruler to jump the cursor, "▶" leaves a rest. Editing by tap still works.
          </>
        ) : paint === "grey" ? (
          <>Grey armed — tap a note to grow it by a step, or empty space to the right of one to stretch it up to there.</>
        ) : paint ? (
          <>{paint[0].toUpperCase() + paint.slice(1)} armed — tap a note to accent it, empty space to place a new one with it.</>
        ) : (
          <>
            Tap empty space to place a note exactly there, tap a note to remove it. Drag a note's right end to resize it (new
            notes then get that length), drag the rest to move it. Long-press a note for pitch, length and velocity, or empty
            space for a chord. Zoom with ↔ ↕ or two fingers; swipe empty space to scroll.
          </>
        )}
      </div>

      {playIn && <PlayInBar playIn={play} totalSteps={totalSteps} stepsPerBar={stepsPerBar} baseNote={DEFAULT_BASE_NOTE} />}

      {editing && (
        <NoteEditorPopup block={block} target={editing} onRetarget={setEditing} onClose={() => setEditing(null)} />
      )}
      {chordPick && (
        <ChordPickerPopup
          block={block}
          step={chordPick.step}
          micro={chordPick.micro}
          root={chordPick.note}
          onClose={() => setChordPick(null)}
        />
      )}
    </div>
  );
}
