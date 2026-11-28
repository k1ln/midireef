//! Arp-Editor: Quadrate (Tonhöhen) + Melodie (Verweise darauf).
//!
//! Zwei getrennte Dinge: oben die QUADRATE — je eine Tonhöhe, mit ▲/▼ darüber
//! und darunter, die sie um einen Halbton verschieben. Darunter die MELODIE in
//! einer Rollen-Ansicht wie beim Melodie-Baustein: Spalten sind die Stellen der
//! Melodie, Zeilen die Quadrate (nach Tonhöhe sortiert, hoch oben). Ein Feld
//! trifft das Quadrat seiner Zeile — die Melodie speichert nur den Verweis,
//! keine Tonhöhe. Ändert sich ein Quadrat, klingt jede Stelle, die darauf
//! zeigt, sofort anders (auch während des Spielens); Quadrate dürfen
//! aneinander vorbeiziehen, nichts verschmilzt, und zurückschieben gibt
//! exakt den alten Klang.
//!
//! "▶ IN": spielt man mit einem MIDI-Keyboard Noten ein, landet jede an der
//! Cursor-Stelle der Melodie (gleiche Tonhöhe → vorhandenes Quadrat, sonst
//! wird ein neues angelegt) und der Cursor rückt weiter. Verfügbar, sobald an
//! der Lane ein Eingang gewählt ist (derselbe wie "MIDI input" in den
//! Lane-Einstellungen).

import { memo, useCallback, useEffect, useRef, useState } from "react";
import type { Block, Device, Lane } from "../../state";
import { useNet, useRuntime, useSend, useStoreValue } from "../store";
import { noteName } from "../NotePicker";
import { Button } from "../widgets/Button";
import { HSlider } from "../widgets/HSlider";
import { SelectMenu, type SelectOption } from "../widgets/SelectMenu";
import { useWheelPicker } from "../widgets/WheelPicker";
import { useLongPress } from "../useLongPress";
import { useSetField } from "../useNumberEditor";

const SQUARE = 128; // Quadrate oben und gespielte Noten unten gleich groß
const MAX_ARP_STEPS = 64; // wie MAX_ARP_PATTERN im Server
const CELL_W = 80;
const CELL_H = 68;
const LABEL_W = 156;

const NO_DEVICES: Device[] = [];
const NO_INPUTS: string[] = [];

/** A, B, C … — jedes Quadrat behält seinen Buchstaben, solange es nicht
 *  gelöscht wird (die Reihenfolge ist seine Identität, nicht seine Tonhöhe). */
function squareLetter(i: number) {
  return i < 26 ? String.fromCharCode(65 + i) : String(i + 1);
}

// ── Skala ───────────────────────────────────────────────────────────────────

const ROOTS = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
/** Skalen, die der Arp anbietet — Namen und Intervalle wie `scale::intervals`
 *  im Server (dort rechnen die ▲/▼-Pfeile damit). */
const ARP_SCALES: { id: string; label: string; intervals: number[] }[] = [
  { id: "major", label: "Major", intervals: [0, 2, 4, 5, 7, 9, 11] },
  { id: "minor", label: "Minor", intervals: [0, 2, 3, 5, 7, 8, 10] },
  { id: "dorian", label: "Dorian", intervals: [0, 2, 3, 5, 7, 9, 10] },
  { id: "phrygian", label: "Phrygian", intervals: [0, 1, 3, 5, 7, 8, 10] },
  { id: "lydian", label: "Lydian", intervals: [0, 2, 4, 6, 7, 9, 11] },
  { id: "mixolydian", label: "Mixolydian", intervals: [0, 2, 4, 5, 7, 9, 10] },
  { id: "locrian", label: "Locrian", intervals: [0, 1, 3, 5, 6, 8, 10] },
  { id: "harmonicMinor", label: "Harmonic minor", intervals: [0, 2, 3, 5, 7, 8, 11] },
  { id: "melodicMinor", label: "Melodic minor", intervals: [0, 2, 3, 5, 7, 9, 11] },
  { id: "pentatonicMinor", label: "Minor pentatonic", intervals: [0, 3, 5, 7, 10] },
  { id: "pentatonicMajor", label: "Major pentatonic", intervals: [0, 2, 4, 7, 9] },
  { id: "blues", label: "Blues", intervals: [0, 3, 5, 6, 7, 10] },
];

type ArpScaleSel = { root: string; name: string } | undefined;
type ScaleState = "none" | "root" | "in" | "out";

/** Wie passt eine Tonhöhe zur Skala des Bausteins? `none` = keine Skala. */
function scaleState(note: number, scale: ArpScaleSel): ScaleState {
  const def = scale && ARP_SCALES.find((s) => s.id === scale.name);
  const root = scale ? ROOTS.indexOf(scale.root) : -1;
  if (!def || root < 0) return "none";
  const rel = (((note - root) % 12) + 12) % 12;
  return rel === 0 ? "root" : def.intervals.includes(rel) ? "in" : "out";
}

/** Ton einer Skala im Raster: leicht eingefärbt; der Grundton kräftiger. */
const SCALE_TINT = "color-mix(in srgb, var(--pal-btn-alt) 28%, var(--pal-step-off))";
const ROOT_TINT = "color-mix(in srgb, var(--pal-btn-alt) 55%, var(--pal-step-off))";

// ── Tempo ───────────────────────────────────────────────────────────────────

/** Tempo-Leiter in Pulsen pro Melodie-Stelle (24 PPQN), schnell → langsam.
 *  Gerade Werte und Triolen; "×" ist relativ zu 1/16 (= 1×, ein Step im
 *  16er-Raster). */
const SPEEDS: { pulses: number; note: string; mult: string }[] = [
  { pulses: 3, note: "1/32", mult: "2×" },
  { pulses: 4, note: "1/16 triplet", mult: "1.5×" },
  { pulses: 6, note: "1/16", mult: "1×" },
  { pulses: 8, note: "1/8 triplet", mult: "¾×" },
  { pulses: 12, note: "1/8", mult: "½×" },
  { pulses: 16, note: "1/4 triplet", mult: "⅜×" },
  { pulses: 24, note: "1/4", mult: "¼×" },
  { pulses: 48, note: "1/2", mult: "⅛×" },
  { pulses: 96, note: "1/1", mult: "1/16×" },
];

/** Pulse pro Takt aus der Taktart ("4/4" → 96, "3/4" → 72, "6/8" → 72). */
function pulsesPerBar(ts: string | undefined): number {
  const [n, d] = (ts ?? "4/4").split("/").map(Number);
  return n > 0 && d > 0 ? Math.round((n * 96) / d) : 96;
}

/** Die Lane, auf der dieser Baustein klingt — dieselbe Regel wie
 *  `block_target_lane` im Server (Lane mit dem Baustein, sonst erste Arp-Lane,
 *  sonst irgendeine), damit der Eingang, den man hier wählt, genau der ist,
 *  der beim Einspielen filtert. */
function useTargetLane(blockId: string): Lane | null {
  const devices = useStoreValue((s) => (s.project?.devices as Device[] | undefined) ?? NO_DEVICES);
  let byRole: Lane | null = null;
  let any: Lane | null = null;
  for (const dev of devices) {
    for (const lane of dev.lanes) {
      if (lane.slots.some((sl) => sl.blockId === blockId)) return lane;
      if (!byRole && lane.role === "arp") byRole = lane;
      if (!any) any = lane;
    }
  }
  return byRole ?? any;
}

/** Stelle der Melodie, die gerade klingt (Playhead), oder null, wenn der
 *  Baustein in keiner Lane läuft. Aktualisiert sich mit denselben Events wie
 *  der Playhead der Piano-Rolle. */
function usePatternPlayhead(blockId: string, rateSteps: number, len: number): number | null {
  // `rateSteps` darf ein Bruch sein (schneller als ein Step).
  const net = useNet();
  const runtime = useRuntime();
  const [idx, setIdx] = useState<number | null>(null);
  useEffect(() => {
    const sync = () => {
      const step = runtime.currentPosition(blockId);
      setIdx(step === null || len === 0 ? null : Math.floor(step / Math.max(0.01, rateSteps) + 1e-6) % len);
    };
    sync();
    return net.onEvent((evt) => {
      if (evt.t === "lane.runtime") sync();
    });
  }, [net, runtime, blockId, rateSteps, len]);
  return idx;
}

/** Einspielen vom MIDI-Eingang in die Melodie (s. Datei-Kopf). Der Server
 *  klemmt einen Index hinter dem Ende auf "anhängen" — der Cursor darf also
 *  einfach hochzählen, auch wenn die Schnappschüsse hinterherhinken. */
function useArpPlayIn(blockId: string, active: boolean) {
  const send = useSend();
  const net = useNet();
  const [cursor, setCursorState] = useState(0);
  const cursorRef = useRef(0);

  const setCursor = useCallback((i: number) => {
    const c = Math.max(0, Math.min(i, MAX_ARP_STEPS - 1));
    cursorRef.current = c;
    setCursorState(c);
  }, []);

  // Server armieren/entwaffnen (das Entwaffnen schickt Note-Offs für alles, was
  // noch klingt — s. `set_note_input`).
  useEffect(() => {
    if (!active) return;
    send({ t: "noteInput.listen", blockId });
    return () => send({ t: "noteInput.listen", blockId: null });
  }, [active, blockId, send]);

  useEffect(() => {
    if (!active) return;
    return net.onEvent((evt) => {
      if (evt.t !== "noteInput.note" || evt.blockId !== blockId || !evt.on) return;
      const i = cursorRef.current;
      send({ t: "arp.playIn", blockId, index: i, note: evt.note });
      setCursor(i + 1 >= MAX_ARP_STEPS ? 0 : i + 1);
    });
  }, [active, net, blockId, send, setCursor]);

  /** Pause an der Cursor-Stelle. */
  const rest = useCallback(() => {
    const i = cursorRef.current;
    send({ t: "arp.setStep", blockId, index: i, square: -1 });
    setCursor(i + 1 >= MAX_ARP_STEPS ? 0 : i + 1);
  }, [send, blockId, setCursor]);

  return { cursor, setCursor, rest };
}

// ── Quadrate ────────────────────────────────────────────────────────────────

function ArpSquare({
  block,
  index,
  note,
  selected,
  onSelect,
  fit,
  fine,
}: {
  block: Block;
  index: number;
  note: number;
  selected: boolean;
  onSelect: () => void;
  fit: ScaleState;
  fine: boolean;
}) {
  const send = useSend();
  const wheel = useWheelPicker();
  // Tippen = auswählen + kurz anspielen; lang halten = Tonhöhe direkt wählen.
  const press = useLongPress(
    () =>
      wheel({
        title: `Square ${squareLetter(index)}`,
        min: 0,
        max: 127,
        value: note,
        format: (v) => `${noteName(v)} (${v})`,
        onPick: (n) => send({ t: "arp.setSquare", blockId: block.id, index, note: n }),
      }),
    () => {
      onSelect();
      send({ t: "block.previewNote", blockId: block.id, note, on: true });
      window.setTimeout(() => send({ t: "block.previewNote", blockId: block.id, note, on: false }), 220);
    },
  );
  const shift = (delta: number) => send({ t: "arp.shiftSquare", blockId: block.id, index, delta, fine });
  const arrow = { width: SQUARE, height: 72, fontSize: 32, padding: 0 } as const;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, flexShrink: 0 }}>
      <Button style={arrow} onClick={() => shift(1)} aria-label={`Square ${squareLetter(index)} up`}>
        ▲
      </Button>
      <div
        {...press}
        style={{
          width: SQUARE,
          height: SQUARE,
          boxSizing: "border-box",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          borderRadius: 6,
          border: fit === "out" ? "1px dashed var(--pal-text-dim)" : "1px solid var(--pal-step-border)",
          background: selected ? "var(--pal-btn-active)" : fit === "root" ? ROOT_TINT : fit === "in" ? SCALE_TINT : "var(--pal-step-off)",
          color: selected ? "var(--pal-ink)" : "var(--pal-text)",
          opacity: fit === "out" && !selected ? 0.6 : 1,
          touchAction: "none",
          userSelect: "none",
          cursor: "pointer",
        }}
      >
        <div style={{ fontSize: 22, opacity: 0.6 }}>
          {squareLetter(index)}
          {fit === "root" && " ●"}
        </div>
        <div style={{ fontSize: 38, fontWeight: 700 }}>{noteName(note)}</div>
      </div>
      <Button style={arrow} onClick={() => shift(-1)} aria-label={`Square ${squareLetter(index)} down`}>
        ▼
      </Button>
    </div>
  );
}

// ── Melodie als Rolle ───────────────────────────────────────────────────────

/** Kopfzelle einer Spalte: Stellen-Nummer. Tippen = Cursor dorthin (Einspielen),
 *  lang halten = Stelle entfernen. */
function RollHeader({
  block,
  col,
  isCursor,
  isPlayhead,
  setCursor,
}: {
  block: Block;
  col: number;
  isCursor: boolean;
  isPlayhead: boolean;
  setCursor: (i: number) => void;
}) {
  const send = useSend();
  const press = useLongPress(
    () => send({ t: "arp.removeStep", blockId: block.id, index: col }),
    () => setCursor(col),
  );
  return (
    <div
      {...press}
      style={{
        height: 48,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: 22,
        color: isCursor ? "var(--pal-ink)" : isPlayhead ? "var(--pal-white)" : "var(--pal-text-dim)",
        background: isCursor ? "var(--pal-btn-active)" : isPlayhead ? "var(--pal-step-held)" : "transparent",
        borderLeft: col % 4 === 0 ? "1px solid var(--pal-step-border)" : "1px solid transparent",
        touchAction: "none",
        userSelect: "none",
        cursor: "pointer",
      }}
    >
      {col + 1}
    </div>
  );
}

const RollCell = memo(function RollCell({
  on,
  col,
  playhead,
  fit,
  onTap,
}: {
  on: boolean;
  col: number;
  playhead: boolean;
  fit: ScaleState;
  onTap: () => void;
}) {
  return (
    <div
      onClick={onTap}
      style={{
        height: CELL_H,
        boxSizing: "border-box",
        borderLeft: col % 4 === 0 ? "1px solid var(--pal-step-border)" : "1px solid transparent",
        borderBottom: "1px solid var(--pal-panel-deep)",
        background: on
          ? "var(--pal-btn-active)"
          : playhead
            ? "var(--pal-btn-alt)"
            : fit === "root"
              ? ROOT_TINT
              : fit === "in"
                ? SCALE_TINT
                : "var(--pal-step-off)",
        cursor: "pointer",
      }}
    />
  );
});

function ArpRoll({
  block,
  squares,
  pattern,
  selected,
  onSelect,
  playhead,
  cursor,
  setCursor,
  scale,
}: {
  block: Block;
  squares: number[];
  pattern: number[];
  selected: number;
  onSelect: (i: number) => void;
  playhead: number | null;
  /** null = kein Einspielen aktiv (kein Cursor). */
  cursor: number | null;
  setCursor: (i: number) => void;
  scale: ArpScaleSel;
}) {
  const send = useSend();
  const len = pattern.length;
  // Eine Spalte mehr als die Melodie lang ist: ein Tipper dort hängt an.
  const cols = len < MAX_ARP_STEPS ? len + 1 : len;
  // Zeilen nach Tonhöhe, hoch oben — wie in der Piano-Rolle. Ein umgestimmtes
  // Quadrat wandert dadurch sichtbar in seine neue Zeile (samt aller Stellen).
  const rows = squares.map((note, index) => ({ note, index })).sort((a, b) => b.note - a.note || a.index - b.index);

  const tap = (col: number, sq: number) => {
    const placed = col < len && pattern[col] === sq;
    send({ t: "arp.setStep", blockId: block.id, index: col, square: placed ? -1 : sq });
    if (!placed) {
      onSelect(sq);
      const note = squares[sq];
      send({ t: "block.previewNote", blockId: block.id, note, on: true });
      window.setTimeout(() => send({ t: "block.previewNote", blockId: block.id, note, on: false }), 180);
    }
  };

  return (
    <div style={{ overflowX: "auto", paddingBottom: 6 }}>
      <div style={{ display: "grid", gridTemplateColumns: `${LABEL_W}px repeat(${cols}, ${CELL_W}px)`, width: "max-content" }}>
        <div style={{ position: "sticky", left: 0, zIndex: 1, background: "var(--pal-panel)" }} />
        {Array.from({ length: cols }, (_, c) =>
          c < len ? (
            <RollHeader key={c} block={block} col={c} isCursor={cursor === c} isPlayhead={playhead === c} setCursor={setCursor} />
          ) : (
            <div
              key={c}
              onClick={() => setCursor(c)}
              style={{
                height: 48,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 28,
                color: cursor === c ? "var(--pal-ink)" : "var(--pal-text-dim)",
                background: cursor === c ? "var(--pal-btn-active)" : "transparent",
                cursor: "pointer",
              }}
            >
              +
            </div>
          ),
        )}
        {rows.map(({ note, index }) => (
          <RollRow
            key={index}
            squareIndex={index}
            note={note}
            selected={index === selected}
            pattern={pattern}
            cols={cols}
            playhead={playhead}
            fit={scaleState(note, scale)}
            onSelect={() => onSelect(index)}
            tap={tap}
          />
        ))}
      </div>
    </div>
  );
}

function RollRow({
  squareIndex,
  note,
  selected,
  pattern,
  cols,
  playhead,
  fit,
  onSelect,
  tap,
}: {
  squareIndex: number;
  note: number;
  selected: boolean;
  pattern: number[];
  cols: number;
  playhead: number | null;
  fit: ScaleState;
  onSelect: () => void;
  tap: (col: number, sq: number) => void;
}) {
  return (
    <>
      <div
        onClick={onSelect}
        style={{
          position: "sticky",
          left: 0,
          zIndex: 1,
          height: CELL_H,
          boxSizing: "border-box",
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "0 16px",
          fontSize: 24,
          background: selected ? "var(--pal-btn-active)" : fit === "root" ? ROOT_TINT : fit === "in" ? SCALE_TINT : "var(--pal-panel)",
          color: selected ? "var(--pal-ink)" : "var(--pal-text)",
          opacity: fit === "out" && !selected ? 0.55 : 1,
          borderBottom: "1px solid var(--pal-panel-deep)",
          cursor: "pointer",
        }}
      >
        <b>{squareLetter(squareIndex)}</b>
        <span style={{ opacity: 0.8 }}>{noteName(note)}</span>
        {fit === "root" && <span aria-label="root note">●</span>}
      </div>
      {Array.from({ length: cols }, (_, c) => (
        <RollCell
          key={c}
          col={c}
          on={pattern[c] === squareIndex}
          playhead={playhead === c}
          fit={fit}
          onTap={() => tap(c, squareIndex)}
        />
      ))}
    </>
  );
}

// ── Gespielte Noten: die Melodie in Reihenfolge als Quadrate ───────────────

const STEP_SQ_W = SQUARE;
/** Obergrenze der Anschläge je Stelle in der UI (die Engine erlaubt 10). */
const MAX_STEP_REPEATS = 8;

/** Eine Stelle der Melodie als Quadrat mit ▲/▼ — ändert NUR diese Stelle
 *  (die Quadrate oben ändern dagegen jede Stelle auf demselben Quadrat). */
function ArpStepSquare({
  block,
  col,
  square,
  note,
  isCursor,
  isPlayhead,
  setCursor,
  fine,
  reps,
  repsCap,
}: {
  block: Block;
  col: number;
  square: number;
  note: number | undefined;
  isCursor: boolean;
  isPlayhead: boolean;
  setCursor: (i: number) => void;
  fine: boolean;
  /** Anschläge dieser Stelle (1 = normal). */
  reps: number;
  /** Mehr als so viele Anschläge passen bei diesem Tempo nicht in eine Stelle. */
  repsCap: number;
}) {
  const send = useSend();
  const rest = note === undefined;
  // Ein Tipp = eine Wiederholung mehr, nach dem Maximum wieder auf 1.
  const shownReps = Math.min(reps, repsCap);
  const cycleReps = () =>
    send({ t: "arp.setStepRepeats", blockId: block.id, index: col, repeats: shownReps >= repsCap ? 1 : shownReps + 1 });
  const shift = (delta: number) => send({ t: "arp.shiftStep", blockId: block.id, index: col, delta, fine });
  // Tippen: Cursor hierher + anspielen; lang halten: Stelle entfernen.
  const press = useLongPress(
    () => send({ t: "arp.removeStep", blockId: block.id, index: col }),
    () => {
      setCursor(col);
      if (note === undefined) return;
      send({ t: "block.previewNote", blockId: block.id, note, on: true });
      window.setTimeout(() => send({ t: "block.previewNote", blockId: block.id, note, on: false }), 200);
    },
  );
  const arrow = { width: STEP_SQ_W, height: 72, fontSize: 32, padding: 0 } as const;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, flexShrink: 0 }}>
      <Button style={arrow} disabled={rest} onClick={() => shift(1)} aria-label={`Step ${col + 1} up`}>
        ▲
      </Button>
      <div
        {...press}
        style={{
          width: STEP_SQ_W,
          height: STEP_SQ_W,
          boxSizing: "border-box",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          borderRadius: 6,
          border: isPlayhead ? "2px solid var(--pal-white)" : "1px solid var(--pal-step-border)",
          background: isCursor ? "var(--pal-btn-active)" : "var(--pal-step-off)",
          color: isCursor ? "var(--pal-ink)" : "var(--pal-text)",
          touchAction: "none",
          userSelect: "none",
          cursor: "pointer",
        }}
      >
        <div style={{ fontSize: 22, opacity: 0.6 }}>
          {col + 1}
          {!rest && ` · ${squareLetter(square)}`}
        </div>
        <div style={{ fontSize: rest ? 42 : 38, fontWeight: 700, color: rest ? "var(--pal-text-dim)" : undefined }}>
          {rest ? "–" : noteName(note)}
        </div>
      </div>
      <Button style={arrow} disabled={rest} onClick={() => shift(-1)} aria-label={`Step ${col + 1} down`}>
        ▼
      </Button>
      <Button
        variant={shownReps > 1 ? "active" : "alt"}
        style={{ width: STEP_SQ_W, height: 72, fontSize: 30, padding: 0 }}
        disabled={rest || repsCap < 2}
        onClick={cycleReps}
        aria-label={`Step ${col + 1} hits: ${shownReps}`}
        title="Hits per note — tap to add one, wraps back to 1"
      >
        ×{shownReps}
      </Button>
    </div>
  );
}

// ── Editor ──────────────────────────────────────────────────────────────────

export function ArpEditor({ block }: { block: Block }) {
  const send = useSend();
  const setField = useSetField();
  const squares = block.chordNotes ?? [];
  // Altprojekt ohne Melodie: jedes Quadrat einmal aufwärts (wie die Engine).
  const pattern = block.pattern ?? squares.map((_, i) => i);
  const gateSteps = block.gateSteps ?? 1;
  const rateSteps = block.rateSteps ?? 1;
  // Tempo: ratePulses hat Vorrang; sonst aus rateSteps und Raster abgeleitet.
  const ppb = pulsesPerBar(block.timeSignature);
  const stepsPerBar = block.stepsPerBar ?? 16;
  const ratePulses = block.ratePulses ?? Math.max(1, Math.round((rateSteps * ppb) / stepsPerBar));
  const rateInSteps = (ratePulses * stepsPerBar) / ppb;
  const speedNow = SPEEDS.find((sp) => sp.pulses === ratePulses);
  // Gate: Notenlänge in % des Abstands zur nächsten Stelle (folgt dem Tempo).
  // Altprojekte mit nur `gateSteps`: daraus abgeleitet (max. 100 %).
  const gatePct = block.gatePct ?? Math.min(100, Math.max(5, Math.round((gateSteps / Math.max(0.01, rateInSteps)) * 100)));
  const swingPct = Math.round((block.swing ?? 0) * 100);
  // Die Engine rastet auf ganze Pulse: mehr Anschläge als Pulse pro Stelle gibt es nicht.
  const repeatsCap = Math.min(MAX_STEP_REPEATS, Math.max(1, Math.floor(ratePulses)));
  const velocity = block.velocity ?? 100;
  const fitBar = block.fitBar !== false;
  const [semitone, setSemitone] = useState(false);
  const scale: ArpScaleSel = ARP_SCALES.some((sc) => sc.id === block.scale?.name) ? block.scale : undefined;
  const fine = !scale || semitone;

  const [picked, setPicked] = useState(0);
  const selected = Math.min(picked, Math.max(0, squares.length - 1));
  const hasSquares = squares.length > 0;

  // Einspielen: Eingang der Ziel-Lane + "▶ IN".
  const lane = useTargetLane(block.id);
  const midiInputs = useStoreValue((s) => s.midiInputs ?? NO_INPUTS);
  const midiIn = lane?.midiInPort || "";
  const inputOptions: SelectOption<string>[] = [
    { value: "", label: "none selected" },
    ...(midiIn && !midiInputs.includes(midiIn) ? [{ value: midiIn, label: `${midiIn} (offline)` }] : []),
    ...midiInputs.map((p) => ({ value: p, label: p })),
  ];
  const [playInOn, setPlayInOn] = useState(false);
  // Ohne gewählten Eingang gibt es nichts, wovon man einspielen könnte.
  const playInActive = playInOn && !!midiIn;
  const playIn = useArpPlayIn(block.id, playInActive);
  const playhead = usePatternPlayhead(block.id, rateInSteps, pattern.length);

  const setScale = (root: string, name: string) => setField(block.id, "scale", name ? { root, name } : null);
  const scaleOptions: SelectOption<string>[] = [
    { value: "", label: "Off (semitones)" },
    ...ARP_SCALES.map((sc) => ({ value: sc.id, label: sc.label })),
  ];
  const rootOptions: SelectOption<string>[] = ROOTS.map((r) => ({ value: r, label: r }));

  const hint = { fontSize: 15, color: "var(--pal-text-dim)", marginBottom: 8 } as const;
  const small = { height: 46, fontSize: 17, padding: "0 16px" } as const;

  return (
    <div>
      <div style={{ display: "flex", flexWrap: "wrap", columnGap: 28, rowGap: 6, marginBottom: 10 }}>
        <HSlider label="GATE" value={gatePct} min={5} max={100} unit="%" onChange={(n) => setField(block.id, "gatePct", n)} />
        <HSlider label="SWING" value={swingPct} min={0} max={100} unit="%" onChange={(n) => setField(block.id, "swing", n / 100)} />
        <HSlider label="VELOCITY" value={velocity} min={1} max={127} onChange={(n) => setField(block.id, "velocity", n)} />
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 14, marginBottom: 16 }}>
        <Button
          variant={fitBar ? "active" : "alt"}
          style={{ width: 170, height: 46, fontSize: 17 }}
          title="Block length follows the melody so the loop restarts exactly on a bar line"
          onClick={() => setField(block.id, "fitBar", !fitBar)}
        >
          Fit bar {fitBar ? "on" : "off"}
        </Button>
        <div style={{ alignSelf: "center", fontSize: 15, color: "var(--pal-text-dim)" }}>
          Loop: {block.lengthBars ?? 1} {(block.lengthBars ?? 1) === 1 ? "bar" : "bars"} · melody {Math.round((pattern.length * ratePulses) / 24 * 100) / 100} beats
        </div>
      </div>
      <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 8, marginBottom: 16 }}>
        <div style={{ fontSize: 15, color: "var(--pal-text-dim)", marginRight: 4 }}>Speed:</div>
        {SPEEDS.map((sp) => (
          <Button
            key={sp.pulses}
            variant={sp.pulses === ratePulses ? "active" : "alt"}
            style={{ minWidth: 84, height: 46, fontSize: 17, padding: "0 10px" }}
            title={`${sp.note} (${sp.mult} of 1/16)`}
            onClick={() => setField(block.id, "ratePulses", sp.pulses)}
          >
            {sp.note.replace(" triplet", "T")}
          </Button>
        ))}
        {!speedNow && <div style={{ fontSize: 15, color: "var(--pal-text-dim)" }}>custom: {ratePulses}p</div>}
      </div>
      <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 10, marginBottom: 10 }}>
        <div style={{ fontSize: 15, color: "var(--pal-text-dim)", marginRight: 4 }}>Scale:</div>
        <SelectMenu
          variant={scale ? "active" : "alt"}
          title="Scale for ▲▼ and the markings"
          buttonLabel={scale ? ARP_SCALES.find((sc) => sc.id === scale.name)?.label : "Off (semitones)"}
          value={scale?.name ?? ""}
          options={scaleOptions}
          style={{ height: 46, fontSize: 17, padding: "0 14px" }}
          onChange={(name) => {
            // Beim Einschalten: Grundton = Tonklasse des gewählten Quadrats,
            // damit man nicht erst von C aus in die eigene Tonart wandern muss.
            const base = scale?.root ?? ROOTS[(((squares[selected] ?? 60) % 12) + 12) % 12];
            setScale(base, name);
          }}
        />
        <SelectMenu
          variant="alt"
          title="Root note"
          buttonLabel={scale ? `Root ${scale.root}` : "Root"}
          value={scale?.root ?? ""}
          options={rootOptions}
          disabled={!scale}
          style={{ height: 46, fontSize: 17, padding: "0 14px" }}
          onChange={(root) => scale && setScale(root, scale.name)}
        />
        {scale && (
          <Button
            variant={semitone ? "active" : "alt"}
            style={{ height: 46, fontSize: 17, padding: "0 14px" }}
            title="What the ▲▼ arrows do: next scale note, or one half tone (any note)"
            onClick={() => setSemitone(!semitone)}
          >
            Arrows: {semitone ? "½ tone" : "scale"}
          </Button>
        )}
        {scale && (
          <div style={{ fontSize: 14, color: "var(--pal-text-dim)" }}>● = root · tinted = in scale · dashed = out of scale</div>
        )}
      </div>
      <div style={hint}>
        Squares — tap = select &amp; hear, ▲▼ = {fine ? "one semitone" : "next note in the scale"}, hold = pick the note. Changing a square changes every melody
        step that uses it, live:
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
        {squares.map((note, i) => (
          <ArpSquare
            key={i}
            block={block}
            index={i}
            note={note}
            selected={i === selected}
            onSelect={() => setPicked(i)}
            fit={scaleState(note, scale)}
            fine={fine}
          />
        ))}
        <div style={{ display: "flex", flexDirection: "column", justifyContent: "center", paddingTop: 78 }}>
          <Button
            style={{ width: SQUARE, height: SQUARE, fontSize: 52 }}
            onClick={() => {
              send({ t: "arp.addSquare", blockId: block.id });
              setPicked(squares.length);
            }}
            aria-label="Add square"
          >
            +
          </Button>
        </div>
      </div>
      {hasSquares && (
        <div style={{ marginTop: 10 }}>
          <Button style={small} onClick={() => send({ t: "arp.removeSquare", blockId: block.id, index: selected })}>
            Delete square {squareLetter(selected)}
          </Button>
        </div>
      )}

      <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 10, marginTop: 22, marginBottom: 8 }}>
        <div style={{ fontSize: 15, color: "var(--pal-text-dim)", marginRight: 4 }}>Melody — tap a field to place a square, tap again = rest:</div>
        <SelectMenu
          variant="alt"
          title="MIDI input for play-in"
          buttonTitle="MIDI input to play the melody in from (same as the lane's MIDI input)"
          buttonLabel={midiIn || "Play-in input…"}
          value={midiIn}
          options={inputOptions}
          disabled={!lane}
          style={{ height: 46, fontSize: 17, padding: "0 14px", maxWidth: 260 }}
          onChange={(v) => lane && send({ t: "lane.setMidiIn", laneId: lane.id, port: v || null })}
        />
        <Button
          variant={playInActive ? "active" : "alt"}
          style={{ width: 76, height: 46, fontSize: 17 }}
          disabled={!midiIn}
          title={midiIn ? "Play the melody in from the selected MIDI input" : "Select a play-in input first"}
          onClick={() => setPlayInOn(!playInOn)}
        >
          ▶ IN
        </Button>
        {playInActive && (
          <Button variant="alt" style={small} onClick={playIn.rest}>
            Rest
          </Button>
        )}
      </div>
      {playInActive && (
        <div style={hint}>
          Playing in at step {playIn.cursor + 1}: each note you play lands there (a pitch without a square gets a new one). Tap a column number to move the cursor,
          hold it to remove that step.
        </div>
      )}

      {hasSquares ? (
        <ArpRoll
          block={block}
          squares={squares}
          pattern={pattern}
          selected={selected}
          onSelect={setPicked}
          playhead={playhead}
          cursor={playInActive ? playIn.cursor : null}
          setCursor={playIn.setCursor}
          scale={scale}
        />
      ) : (
        <div style={hint}>Add a square first.</div>
      )}
      <div style={{ ...hint, marginTop: 22 }}>
        Played notes — the melody in order. ▲▼ change only that one step{fine ? "" : " (to the next scale note)"} (the squares at the top change every step that uses them). Tap = hear &amp; move the
        cursor, hold = remove the step. ×N under a step = hits per note (tap to cycle):
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
        {pattern.length === 0 && <div style={hint}>No steps yet.</div>}
        {pattern.map((sq, i) => (
          <ArpStepSquare
            key={i}
            block={block}
            col={i}
            square={sq}
            note={squares[sq]}
            isCursor={playInActive && playIn.cursor === i}
            isPlayhead={playhead === i}
            setCursor={playIn.setCursor}
            fine={fine}
            reps={block.stepRepeats?.[i] ?? 1}
            repsCap={repeatsCap}
          />
        ))}
      </div>
      <div style={{ display: "flex", gap: 12, marginTop: 10 }}>
        <Button style={small} onClick={() => send({ t: "arp.removeStep", blockId: block.id })}>
          Remove last
        </Button>
        <Button style={small} onClick={() => send({ t: "arp.clearSteps", blockId: block.id })}>
          Clear melody
        </Button>
        <Button
          variant="alt"
          style={small}
          title="New random melody from the squares (same length, some rests)"
          onClick={() => send({ t: "arp.randomize", blockId: block.id, seed: Math.floor(Math.random() * 2 ** 32) })}
        >
          🎲 Random
        </Button>
      </div>
    </div>
  );
}
