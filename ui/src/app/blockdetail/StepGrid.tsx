//! Shared step-grid primitives — every Block Detail editor (Melody, Beat,
//! Chord, Program Change, Pattern Shift, CC stepped/envelope layers) is a
//! row (or several) of step cells.
//!
//! Zwei Layouts, umschaltbar im Kopf des Baustein-Details (`StepFlow`):
//!
//!   "wrap"   — ein Takt pro Zeile, Takte untereinander. Auf dem Touchdisplay
//!              meist die bessere Wahl: ein 4-Takt-Baustein ist ohne Wischen
//!              komplett sichtbar.
//!   "scroll" — alle Steps in EINER langen Reihe, quer scrollbar. Gut zum
//!              Vergleichen über Taktgrenzen hinweg, braucht aber Wischen.
//!
//! In beiden Fällen liegt jede Zeile in einem eigenen `overflow-x`-Scroller —
//! auch ein einzelner Takt kann breiter als der Screen sein (bis 64 Substeps).
//! Der Playhead sitzt geklippt IM Scroller: er wandert mit dem Raster mit und
//! verschwindet von allein, sobald der laufende Step nicht in dieser Zeile
//! liegt (s. `.step-playhead-clip` in theme.css) — dafür braucht es kein
//! JavaScript, runtime.ts setzt weiterhin nur `--play-step`.

import { useRef, useState, type CSSProperties, type ReactNode } from "react";

/** Wie die Steps eines Bausteins ausgelegt werden — s. Kopfkommentar. */
export type StepFlow = "wrap" | "scroll";

/** Tonumfang der Piano-Rollen: C0 bis G9 — die volle MIDI-Skala ohne die
 *  namenlose Oktave -1. Feste Grenzen statt eines Fensters um die Grundnote:
 *  jede Note, die ein Gerät spielen kann, ist damit auch erreichbar. */
export const ROLL_LOW_NOTE = 12;
export const ROLL_HIGH_NOTE = 127;
/** Höhe eines Piano-Roll-Ausschnitts: gut zwei Handbreit, damit auf dem
 *  Pi-Display auch bei taktweisem Layout mehr als ein Takt aufs Bild passt.
 *  Der Rest ist im Raster selbst scrollbar (senkrecht). */
export const ROLL_MAX_H = 300;

/** Breite der Klaviatur am Rand der Piano-Rolle. Ein Notenname allein käme mit
 *  der halben Breite aus — die Taste ist so breit, WEIL man sie mit dem Finger
 *  treffen und gedrückt halten soll (s. `RollKey`). */
export const ROLL_KEY_W = 78;

const BLACK_KEYS = [1, 3, 6, 8, 10];

/** Haltedauer für „lang drücken" — identisch zu `useLongPress`, damit sich die
 *  Geste über alle Raster gleich anfühlt. */
export const HOLD_MS = 500;

/**
 * Anspielbare Taste am Rand einer Piano-Roll-Zeile.
 *
 * Sie ersetzt die frühere reine Beschriftung am Zeilenende: gedrückt halten
 * schickt ein Note-On auf das Ziel des Bausteins, loslassen das Note-Off — so
 * hört man eine Tonhöhe, BEVOR man sie ins Raster setzt.
 *
 * Das Note-Off ist der heikle Teil: es muss auch dann kommen, wenn der Finger
 * die Taste verlässt oder der Browser die Geste als Scrollen übernimmt. Darum
 * hängt es an `pointerup`, `pointerleave` UND `pointercancel`, gedeckelt durch
 * `down` (kein doppeltes Off) und mit Pointer-Capture, damit ein Loslassen
 * außerhalb der Taste noch hier ankommt — ein verpasstes Note-Off wäre ein
 * hängender Ton, den nur noch Panic beendet.
 */
export function RollKey({
  note,
  label,
  height,
  width = ROLL_KEY_W,
  onPress,
  onRelease,
}: {
  note: number;
  label: string;
  height: number;
  width?: number;
  onPress: () => void;
  onRelease: () => void;
}) {
  const [down, setDown] = useState(false);
  const black = BLACK_KEYS.includes(((note % 12) + 12) % 12);
  const release = () => {
    if (!down) return;
    setDown(false);
    onRelease();
  };
  return (
    <div
      className={`roll-key ${black ? "black" : "white"}${down ? " down" : ""}`}
      style={{ width, height, lineHeight: `${height}px` }}
      onPointerDown={(e) => {
        if (down) return;
        e.currentTarget.setPointerCapture?.(e.pointerId);
        setDown(true);
        onPress();
      }}
      onPointerUp={release}
      onPointerLeave={release}
      onPointerCancel={release}
    >
      {label}
      <span style={{ opacity: 0.6, fontWeight: 400 }}>{note}</span>
    </div>
  );
}

export function StepScroller({
  children,
  playhead,
  maxHeight,
}: {
  children: ReactNode;
  /** Geometrie des Spalten-Playheads; fehlt sie, wird keiner gezeichnet. */
  playhead?: { cellW: number; count: number; from: number; offsetX?: number };
  /** Hohe Raster (Piano-Roll) auf diese Höhe deckeln und senkrecht scrollbar
   *  machen, sonst schiebt EIN Takt schon den halben Screen voll. Beim ersten
   *  Anzeigen wird die mit `data-roll-center` markierte Zeile in den Blick
   *  gerückt (die Grundnote); ohne Markierung bleibt es bei der Mitte. */
  maxHeight?: number;
}) {
  const centered = useRef(false);
  const ref = (el: HTMLDivElement | null) => {
    if (!el || !maxHeight || centered.current) return;
    centered.current = true;
    // Über die ganze MIDI-Skala ist die Mitte der Zeilen NICHT die Mitte des
    // Interesses — ohne das hier startete die Rolle irgendwo um F#4 statt bei
    // der Grundnote des Bausteins. `.step-scroller` ist position:relative,
    // also ist offsetTop der Zeile schon die Scroll-Koordinate.
    const target = el.querySelector<HTMLElement>("[data-roll-center]");
    const wanted = target
      ? target.offsetTop + target.offsetHeight / 2 - el.clientHeight / 2
      : (el.scrollHeight - el.clientHeight) / 2;
    el.scrollTop = Math.max(0, Math.min(wanted, el.scrollHeight - el.clientHeight));
  };
  return (
    <div className="step-scroller" ref={ref} style={maxHeight ? { maxHeight, overflowY: "auto" } : undefined}>
      {/* Wandert mit --play-step über das Raster; die Variable und die Klasse
          `playing` setzt runtime.ts auf der Editor-Wurzel, geerbt wird beides.
          Bewusst absolut positioniert INNERHALB des Scrollers: so scrollt der
          Playhead mit dem Raster mit, ohne dass eine Zelle etwas davon merkt
          (kein Re-Render, kein Prop durch jede Zeile). */}
      {playhead && (
        <div
          className="step-playhead-clip"
          style={{ left: playhead.offsetX ?? 0, width: playhead.cellW * playhead.count }}
        >
          <div
            className="step-playhead"
            style={
              {
                "--cell-w": `${playhead.cellW}px`,
                "--bar-start": playhead.from,
              } as CSSProperties
            }
          />
        </div>
      )}
      {children}
    </div>
  );
}

/**
 * Legt die Steps eines Bausteins als eine oder mehrere Zeilen aus und rahmt
 * jede Zeile mit Scroller, Lineal und (bei mehreren Zeilen) Takt-Nummer ein.
 *
 * `children` bekommt die Step-Nummern DIESER Zeile — absolut, nicht bei 0
 * beginnend: Kommandos adressieren Steps immer über den ganzen Baustein.
 */
export function StepBars({
  totalSteps,
  stepsPerBar,
  cellW,
  flow,
  leftColumn,
  leftWidth = 0,
  maxHeight,
  children,
}: {
  totalSteps: number;
  stepsPerBar: number;
  cellW: number;
  flow: StepFlow;
  /** Beat-Editor: Zeilennamen links neben dem Raster (pro Takt wiederholt). */
  leftColumn?: ReactNode;
  leftWidth?: number;
  /** Deckel für hohe Raster — s. StepScroller. */
  maxHeight?: number;
  children: (steps: number[], barStart: number) => ReactNode;
}) {
  const perRow = flow === "wrap" ? Math.max(1, stepsPerBar) : Math.max(1, totalSteps);
  const rows: number[][] = [];
  for (let start = 0; start < Math.max(1, totalSteps); start += perRow) {
    rows.push(Array.from({ length: Math.min(perRow, totalSteps - start) }, (_, i) => start + i));
  }

  return (
    <div>
      {rows.map((steps) => (
        <div key={steps[0]} className="step-bar">
          {rows.length > 1 && <div className="bar-label">Bar {Math.floor(steps[0] / stepsPerBar) + 1}</div>}
          <StepScroller playhead={{ cellW, count: steps.length, from: steps[0], offsetX: leftWidth }} maxHeight={maxHeight}>
            <div style={{ display: "flex" }}>
              {leftColumn !== undefined && <div style={{ width: leftWidth, flexShrink: 0 }}>{leftColumn}</div>}
              <div>
                <StepRuler steps={steps} stepsPerBar={stepsPerBar} cellW={cellW} />
                {children(steps, steps[0])}
              </div>
            </div>
          </StepScroller>
        </div>
      ))}
    </div>
  );
}

export function StepRuler({ steps, stepsPerBar, cellW }: { steps: number[]; stepsPerBar: number; cellW: number }) {
  // Gerundet: stepsPerBar ist frei wählbar (auch 6, 12, 24 …), ein krummer
  // Divisor würde die Beat-Zahlen sonst willkürlich verteilen.
  const marker = Math.max(1, Math.round(stepsPerBar / 4));
  return (
    <div style={{ display: "flex", marginBottom: 4 }}>
      {steps.map((step) => (
        <div
          key={step}
          className="mono"
          style={{ width: cellW, flexShrink: 0, fontSize: 10, color: "var(--pal-text-dim)" }}
        >
          {step % marker === 0 ? step + 1 : ""}
        </div>
      ))}
    </div>
  );
}

export interface StepCellProps {
  width: number;
  height: number;
  active: boolean;
  mutedLook?: boolean;
  onClick: () => void;
  /** Fires after HOLD_MS of holding the cell down; the tap is then swallowed,
   *  so a hold never also triggers `onClick`. Pass undefined when a hold has
   *  no meaning on this cell (the timer is then not even armed, otherwise a
   *  slow tap on an empty cell would be eaten). */
  onHold?: () => void;
  children?: ReactNode;
}

export function StepCell({ width, height, active, mutedLook, onClick, onHold, children }: StepCellProps) {
  const timer = useRef<number | undefined>(undefined);
  /** Hat der Halte-Timer zugeschlagen, darf das Loslassen NICHT mehr als
   *  Tipper zählen — sonst löste erst das Halten aus und gleich danach der
   *  Klick (Detail öffnen auf eine gerade entfernte Note, Picker direkt nach
   *  dem Leeren eines Steps). */
  const fired = useRef(false);
  const cancel = () => {
    window.clearTimeout(timer.current);
    timer.current = undefined;
  };
  return (
    <div
      className="step-cell"
      style={{
        width: width - 2,
        height: height - 2,
        // Deckende Töne statt `opacity` — sonst schien der Hintergrund durch
        // jede leere Zelle und das Raster wirkte durchsichtig (s. --pal-step-*).
        background: active
          ? "var(--pal-btn-active)"
          : mutedLook
            ? "var(--pal-step-off-muted)"
            : "var(--pal-step-off)",
        color: active ? "var(--pal-ink)" : mutedLook ? "var(--pal-text-dim)" : "var(--pal-text)",
      }}
      onPointerDown={() => {
        fired.current = false;
        if (onHold)
          timer.current = window.setTimeout(() => {
            fired.current = true;
            onHold();
          }, HOLD_MS);
      }}
      onPointerUp={cancel}
      onPointerLeave={cancel}
      // Quer-Wischen zum Scrollen darf nicht als langes Drücken enden: sobald
      // der Browser die Geste als Pan übernimmt, kommt `pointercancel` — ohne
      // das hier hätte ein Scrollen über eine Note sie nach 500ms gelöscht.
      onPointerCancel={cancel}
      onClick={() => {
        if (!fired.current) onClick();
      }}
    >
      {children}
    </div>
  );
}
