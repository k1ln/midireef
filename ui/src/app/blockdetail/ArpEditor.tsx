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
import { SelectMenu, type SelectOption } from "../widgets/SelectMenu";
import { useWheelPicker } from "../widgets/WheelPicker";
import { useLongPress } from "../useLongPress";
import { useSetField } from "../useNumberEditor";

const SQUARE = 76;
const MAX_ARP_STEPS = 64; // wie MAX_ARP_PATTERN im Server
const CELL_W = 40;
const CELL_H = 34;
const LABEL_W = 78;

const NO_DEVICES: Device[] = [];
const NO_INPUTS: string[] = [];

/** A, B, C … — jedes Quadrat behält seinen Buchstaben, solange es nicht
 *  gelöscht wird (die Reihenfolge ist seine Identität, nicht seine Tonhöhe). */
function squareLetter(i: number) {
  return i < 26 ? String.fromCharCode(65 + i) : String(i + 1);
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
  const net = useNet();
  const runtime = useRuntime();
  const [idx, setIdx] = useState<number | null>(null);
  useEffect(() => {
    const sync = () => {
      const step = runtime.currentStep(blockId);
      setIdx(step === null || len === 0 ? null : Math.floor(step / Math.max(1, rateSteps)) % len);
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
}: {
  block: Block;
  index: number;
  note: number;
  selected: boolean;
  onSelect: () => void;
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
  const shift = (delta: number) => send({ t: "arp.shiftSquare", blockId: block.id, index, delta });
  const arrow = { width: SQUARE, height: 40, fontSize: 18 } as const;
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
          border: "1px solid var(--pal-step-border)",
          background: selected ? "var(--pal-btn-active)" : "var(--pal-step-off)",
          color: selected ? "var(--pal-ink)" : "var(--pal-text)",
          touchAction: "none",
          userSelect: "none",
          cursor: "pointer",
        }}
      >
        <div style={{ fontSize: 11, opacity: 0.6 }}>{squareLetter(index)}</div>
        <div style={{ fontSize: 22, fontWeight: 700 }}>{noteName(note)}</div>
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
        height: 24,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: 11,
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
  onTap,
}: {
  on: boolean;
  col: number;
  playhead: boolean;
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
        background: on ? "var(--pal-btn-active)" : playhead ? "var(--pal-btn-alt)" : "var(--pal-step-off)",
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
                height: 24,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 14,
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
  onSelect,
  tap,
}: {
  squareIndex: number;
  note: number;
  selected: boolean;
  pattern: number[];
  cols: number;
  playhead: number | null;
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
          gap: 6,
          padding: "0 8px",
          fontSize: 12,
          background: selected ? "var(--pal-btn-active)" : "var(--pal-panel)",
          color: selected ? "var(--pal-ink)" : "var(--pal-text)",
          borderBottom: "1px solid var(--pal-panel-deep)",
          cursor: "pointer",
        }}
      >
        <b>{squareLetter(squareIndex)}</b>
        <span style={{ opacity: 0.8 }}>{noteName(note)}</span>
      </div>
      {Array.from({ length: cols }, (_, c) => (
        <RollCell
          key={c}
          col={c}
          on={pattern[c] === squareIndex}
          playhead={playhead === c}
          onTap={() => tap(c, squareIndex)}
        />
      ))}
    </>
  );
}

// ── Gespielte Noten: die Melodie in Reihenfolge als Quadrate ───────────────

const STEP_SQ_W = 56;

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
}: {
  block: Block;
  col: number;
  square: number;
  note: number | undefined;
  isCursor: boolean;
  isPlayhead: boolean;
  setCursor: (i: number) => void;
}) {
  const send = useSend();
  const rest = note === undefined;
  const shift = (delta: number) => send({ t: "arp.shiftStep", blockId: block.id, index: col, delta });
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
  const arrow = { width: STEP_SQ_W, height: 34, fontSize: 15, padding: 0 } as const;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, flexShrink: 0 }}>
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
        <div style={{ fontSize: 10, opacity: 0.6 }}>
          {col + 1}
          {!rest && ` · ${squareLetter(square)}`}
        </div>
        <div style={{ fontSize: rest ? 20 : 17, fontWeight: 700, color: rest ? "var(--pal-text-dim)" : undefined }}>
          {rest ? "–" : noteName(note)}
        </div>
      </div>
      <Button style={arrow} disabled={rest} onClick={() => shift(-1)} aria-label={`Step ${col + 1} down`}>
        ▼
      </Button>
    </div>
  );
}

// ── Editor ──────────────────────────────────────────────────────────────────

export function ArpEditor({ block }: { block: Block }) {
  const send = useSend();
  const wheel = useWheelPicker();
  const setField = useSetField();
  const squares = block.chordNotes ?? [];
  // Altprojekt ohne Melodie: jedes Quadrat einmal aufwärts (wie die Engine).
  const pattern = block.pattern ?? squares.map((_, i) => i);
  const gateSteps = block.gateSteps ?? 1;
  const rateSteps = block.rateSteps ?? 1;
  const velocity = block.velocity ?? 100;

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
  const playhead = usePatternPlayhead(block.id, rateSteps, pattern.length);

  const hint = { fontSize: 13, color: "var(--pal-text-dim)", marginBottom: 8 } as const;
  const small = { height: 34, fontSize: 14, padding: "0 14px" } as const;

  return (
    <div>
      <div style={hint}>
        Squares — tap = select &amp; hear, ▲▼ = one semitone, hold = pick the note. Changing a square changes every melody step that uses it, live:
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
        {squares.map((note, i) => (
          <ArpSquare key={i} block={block} index={i} note={note} selected={i === selected} onSelect={() => setPicked(i)} />
        ))}
        <div style={{ display: "flex", flexDirection: "column", justifyContent: "center", paddingTop: 46 }}>
          <Button
            style={{ width: SQUARE, height: SQUARE, fontSize: 28 }}
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
        <div style={{ fontSize: 13, color: "var(--pal-text-dim)", marginRight: 4 }}>Melody — tap a field to place a square, tap again = rest:</div>
        <SelectMenu
          variant="alt"
          title="MIDI input for play-in"
          buttonTitle="MIDI input to play the melody in from (same as the lane's MIDI input)"
          buttonLabel={midiIn || "Play-in input…"}
          value={midiIn}
          options={inputOptions}
          disabled={!lane}
          style={{ height: 34, fontSize: 14, padding: "0 12px", maxWidth: 260 }}
          onChange={(v) => lane && send({ t: "lane.setMidiIn", laneId: lane.id, port: v || null })}
        />
        <Button
          variant={playInActive ? "active" : "alt"}
          style={{ width: 64, height: 34, fontSize: 14 }}
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
        />
      ) : (
        <div style={hint}>Add a square first.</div>
      )}
      <div style={{ ...hint, marginTop: 22 }}>
        Played notes — the melody in order. ▲▼ change only that one step (the squares at the top change every step that uses them). Tap = hear &amp; move the
        cursor, hold = remove the step:
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
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
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginTop: 22 }}>
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
    </div>
  );
}
