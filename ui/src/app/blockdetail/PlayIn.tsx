//! „Play in" — eine Melodie in die Piano-Rolle SPIELEN statt sie Zelle für
//! Zelle zu tippen.
//!
//! Zwei Quellen, ein Weg: ein angeschlossenes MIDI-Keyboard (der Server meldet
//! dessen Noten als `noteInput.note`, sobald `noteInput.listen` armiert ist)
//! und die Klaviatur, die unter dem Raster erscheint. Beide landen in
//! denselben `press`/`release` — es gibt also keine zweite Eingabe-Logik, die
//! sich anders verhalten könnte, auch wenn beide Seiten unterschiedlich
//! Akkorde bilden (Hardware über gleichzeitiges Halten, Bildschirm-Tasten
//! über mehrere Tipper — s. `notesAtCursor`).
//!
//! Eingespielt wird in SCHRITTEN, nicht in Echtzeit: es gibt einen
//! Schreib-Cursor, gespielte Noten landen auf seinem Step, und er rückt mit
//! `autoAdvance` weiter, sobald eine Hardware-Taste losgelassen (bzw. keine
//! mehr gehalten) wird. Damit ist das Einspielen unabhängig vom Transport
//! (man kann bei stehender Wiedergabe schreiben), Akkorde entstehen von
//! selbst (was gleichzeitig gehalten wird, steht auf einem Step), und nichts
//! landet „daneben", weil man zu früh oder zu spät war — Timing-Korrektur
//! bräuchte auf einem Touchdisplay ohnehin eine Quantisierung, die man erst
//! wieder einstellen müsste. Wer live gegen die laufende Uhr aufnehmen will,
//! hat dafür `record.arm` im Dashboard.
//!
//! Der TON kommt bei Hardware-Noten vom Server (er spielt sie direkt aufs Ziel
//! des Bausteins, s. `AppState::forward_note_input`), bei den Bildschirm-Tasten
//! von `block.previewNote` (nur, solange `sendOnPlay` an ist) — eine
//! Hardware-Note über die UI zurückzuschicken
//! kostete eine WS-Runde, und die hört man beim Spielen.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Block } from "../../state";
import { useNet, useSend } from "../store";
import { noteName } from "../NotePicker";
import { Button } from "../widgets/Button";

/** Notenlängen des Schreib-Cursors, in Steps — zugleich das Maß, um das er
 *  weiterrückt. Punktierte/krumme Werte fehlen bewusst: sie sind über den
 *  Noten-Editor (langes Drücken) genauer einzustellen, als sie hier zu raten. */
const LENGTHS = [1, 2, 3, 4, 6, 8, 16];

/** Anschlagstärken der Bildschirm-Tasten, zum Durchklicken wie `LENGTHS`. */
const VELOCITIES = [20, 40, 60, 80, 100, 110, 127];

/** Anschlag, den ein Gerät ohne eigene Velocity meldet (sollte praktisch nie
 *  vorkommen, ist aber ein sinnvoller Nullwert). */
const DEFAULT_VELOCITY = 100;

export interface PlayIn {
  /** Step, auf den die nächste gespielte Note geschrieben wird. */
  cursor: number;
  setCursor: (step: number) => void;
  /** Länge der geschriebenen Noten UND Schrittweite des Cursors. */
  lengthSteps: number;
  setLengthSteps: (steps: number) => void;
  /** Anschlagstärke, mit der eine Bildschirm-Taste schreibt (Hardware bringt
   *  ihre eigene mit). */
  velocity: number;
  setVelocity: (v: number) => void;
  /** Ob eine gedrückte Bildschirm-Taste hörbar auf dem Ziel-Gerät klingt. Aus
   *  lässt sich eine Zeile stumm eintippen, ohne das Gerät zu triggern. */
  sendOnPlay: boolean;
  setSendOnPlay: (v: boolean) => void;
  /** Ob der Cursor nach einer NEU geschriebenen Note automatisch weiterrückt.
   *  Aus bleibt er stehen — so sammeln mehrere angetippte Tasten (oder ein
   *  Akkord vom Hardware-Keyboard) auf demselben Step, statt dass die erste
   *  Note schon zum nächsten Step weiterschiebt. */
  autoAdvance: boolean;
  setAutoAdvance: (v: boolean) => void;
  /** Was gerade klingt — Hardware und Bildschirm-Tasten zusammen (kurzer
   *  Anspiel-Blitz, keine dauerhafte Auswahl). */
  held: readonly number[];
  /** Noten, die am AKTUELLEN Cursor-Step schon stehen — das ist die grüne
   *  Auswahl der Klaviatur: kehrt man zu einem Step zurück, zeigt sie genau
   *  das, was dort schon liegt, und ein Tipp nimmt es wieder weg. */
  notesAtCursor: readonly number[];
  /** Bildschirm-Taste gedrückt bzw. losgelassen: Anspiel-Ton (falls
   *  `sendOnPlay`) beim Drücken, Setzen/Entfernen der Note beim Loslassen. */
  press: (note: number) => void;
  release: (note: number) => void;
}

/**
 * Hält Cursor und gehaltene Noten und armiert den Server, solange `active`.
 *
 * `totalSteps` ist die Länge des Bausteins: der Cursor läuft am Ende wieder
 * auf 0 — ein Baustein ist eine Schleife, und ein Cursor, der am Ende stehen
 * bleibt, würde alles Weitere auf denselben letzten Step stapeln.
 */
export function usePlayIn(block: Block, totalSteps: number, active: boolean): PlayIn {
  const send = useSend();
  const net = useNet();
  const [cursor, setCursorState] = useState(0);
  const [lengthSteps, setLengthSteps] = useState(1);
  const [velocity, setVelocity] = useState(DEFAULT_VELOCITY);
  const [sendOnPlay, setSendOnPlay] = useState(true);
  const [autoAdvance, setAutoAdvance] = useState(true);
  const [held, setHeld] = useState<number[]>([]);

  // Refs neben dem State, weil der WS-Handler unten NICHT bei jeder
  // Cursor-Bewegung neu aufgehängt werden soll (mitten im Spielen die
  // Subscription tauschen = verpasste Note-Offs = hängender Ton).
  const cursorRef = useRef(0);
  const lengthRef = useRef(1);
  const autoAdvanceRef = useRef(true);
  const heldRef = useRef<Set<number>>(new Set());
  const totalRef = useRef(totalSteps);
  totalRef.current = Math.max(1, totalSteps);
  lengthRef.current = lengthSteps;
  autoAdvanceRef.current = autoAdvance;

  const setCursor = useCallback((step: number) => {
    const total = totalRef.current;
    const wrapped = ((step % total) + total) % total;
    cursorRef.current = wrapped;
    setCursorState(wrapped);
  }, []);

  /** Schreibt die Note an den Cursor. Ohne `send` in den Deps — der Kontext
   *  liefert dieselbe Funktion über die Lebensdauer der App. */
  const noteOn = useCallback(
    (note: number, velocity: number) => {
      if (heldRef.current.has(note)) return;
      heldRef.current.add(note);
      setHeld([...heldRef.current]);
      send({
        t: "melody.addNote",
        blockId: block.id,
        step: cursorRef.current,
        note,
        velocity: Math.max(1, Math.min(127, velocity)),
        lengthSteps: lengthRef.current,
      });
    },
    [send, block.id],
  );

  const noteOff = useCallback(
    (note: number) => {
      if (!heldRef.current.delete(note)) return;
      setHeld([...heldRef.current]);
      // Erst wenn ALLES los ist, rückt der Cursor: bis dahin gehört jede
      // weitere Taste zum selben Akkord auf demselben Step. Mit
      // `autoAdvance` aus bleibt er stehen — für einen Hardware-Akkord, der
      // in mehreren Anschlägen statt einer Hand voll Finger entsteht.
      if (heldRef.current.size === 0 && autoAdvanceRef.current) setCursor(cursorRef.current + lengthRef.current);
    },
    [setCursor],
  );

  // Server armieren/entwaffnen. Das Entwaffnen im Cleanup ist der Teil, der
  // zählt: es schickt Note-Offs für alles, was das Mithören noch hält (s.
  // `set_note_input` in ws.rs) — ein Editor, den man mitten im Akkord
  // schließt, ließe sonst einen Ton stehen.
  useEffect(() => {
    if (!active) return;
    send({ t: "noteInput.listen", blockId: block.id });
    return () => {
      send({ t: "noteInput.listen", blockId: null });
      heldRef.current.clear();
      setHeld([]);
    };
  }, [active, block.id, send]);

  // Noten des angeschlossenen Keyboards. Sie klingen schon (Server), hier
  // werden sie nur geschrieben.
  useEffect(() => {
    if (!active) return;
    return net.onEvent((evt) => {
      if (evt.t !== "noteInput.note" || evt.blockId !== block.id) return;
      if (evt.on) noteOn(evt.note, evt.velocity ?? DEFAULT_VELOCITY);
      else noteOff(evt.note);
    });
  }, [active, net, block.id, noteOn, noteOff]);

  // Baustein gekürzt, während der Cursor hinter dem neuen Ende stand.
  useEffect(() => {
    if (cursorRef.current >= Math.max(1, totalSteps)) setCursor(0);
  }, [totalSteps, setCursor]);

  const notes = block.notes ?? [];
  const notesAtCursor = useMemo(
    () => notes.filter((n) => n.step === cursor).map((n) => n.note),
    [notes, cursor],
  );

  /** Bildschirm-Taste unten: kurzer Anspiel-Ton, solange sie unter dem
   *  Finger liegt — ob die Note dabei am Step steht oder nicht, entscheidet
   *  erst `release` (s. dort). Nutzt `held` NUR für den kurzen Aufblitzer der
   *  Taste, nicht für das Schreiben (das macht die grüne Auswahl, s.
   *  `notesAtCursor`). */
  const press = useCallback(
    (note: number) => {
      heldRef.current.add(note);
      setHeld([...heldRef.current]);
      if (sendOnPlay) send({ t: "block.previewNote", blockId: block.id, note, on: true, velocity });
    },
    [sendOnPlay, send, block.id, velocity],
  );

  /** Loslassen entscheidet: Note noch nicht am Step → setzen (und mit
   *  `autoAdvance` weiterrücken); steht sie schon (grün) → wieder weg. So
   *  baut man einen Akkord durch mehrere Tipper auf denselben Step, statt
   *  dass jeder Tipper allein schon den Cursor verschiebt. */
  const release = useCallback(
    (note: number) => {
      heldRef.current.delete(note);
      setHeld([...heldRef.current]);
      if (sendOnPlay) send({ t: "block.previewNote", blockId: block.id, note, on: false });
      const step = cursorRef.current;
      if (notes.some((n) => n.step === step && n.note === note)) {
        send({ t: "melody.removeNote", blockId: block.id, step, note });
      } else {
        send({ t: "melody.addNote", blockId: block.id, step, note, velocity, lengthSteps: lengthRef.current });
        if (autoAdvanceRef.current) setCursor(step + lengthRef.current);
      }
    },
    [sendOnPlay, send, block.id, notes, velocity, setCursor],
  );

  return {
    cursor,
    setCursor,
    lengthSteps,
    setLengthSteps,
    velocity,
    setVelocity,
    sendOnPlay,
    setSendOnPlay,
    autoAdvance,
    setAutoAdvance,
    held,
    notesAtCursor,
    press,
    release,
  };
}

/**
 * Die Leiste unter dem Raster: Schreib-Cursor-Bedienung und die Klaviatur.
 *
 * Sie klebt am unteren Rand (`position: sticky`) — die Piano-Rolle darüber
 * scrollt senkrecht durch 116 Tonhöhen, und eine Klaviatur, die dabei aus dem
 * Bild wandert, wäre beim Spielen wertlos.
 */
export function PlayInBar({
  playIn,
  totalSteps,
  stepsPerBar,
  baseNote,
}: {
  playIn: PlayIn;
  totalSteps: number;
  stepsPerBar: number;
  /** Grundnote des Bausteins — legt fest, welche Oktave zuerst zu sehen ist. */
  baseNote: number;
}) {
  const {
    cursor,
    setCursor,
    lengthSteps,
    setLengthSteps,
    velocity,
    setVelocity,
    sendOnPlay,
    setSendOnPlay,
    autoAdvance,
    setAutoAdvance,
    held,
    notesAtCursor,
    press,
    release,
  } = playIn;
  // Oktave der Klaviatur, unabhängig vom Cursor verschiebbar. Startwert ist
  // die Oktave der Grundnote, damit man ohne Blättern dort landet, wo der
  // Baustein spielt.
  const [firstC, setFirstC] = useState(() => clampFirstC(Math.floor(baseNote / 12) * 12));
  const bar = Math.floor(cursor / Math.max(1, stepsPerBar)) + 1;
  const beat = (cursor % Math.max(1, stepsPerBar)) + 1;

  return (
    <div className="play-in-bar">
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 8 }}>
        {/* Ganz links: die Klaviatur schiebt sich unter demselben Finger
            hin und her, mit dem man gerade spielt — rechts (hinter dem
            Lineal) läge sie oft außerhalb des bequemen Daumenbereichs. */}
        <div style={{ display: "flex", gap: 6 }}>
          <Button variant="alt" style={{ width: 52, height: 38, fontSize: 14 }} title="Octave down" onClick={() => setFirstC(clampFirstC(firstC - 12))}>
            −8ve
          </Button>
          <Button variant="alt" style={{ width: 52, height: 38, fontSize: 14 }} title="Octave up" onClick={() => setFirstC(clampFirstC(firstC + 12))}>
            +8ve
          </Button>
        </div>
        <div style={{ fontSize: 13, fontWeight: 700, color: "var(--pal-run)" }}>PLAY IN</div>
        <Button variant="alt" style={{ width: 46, height: 38, fontSize: 16 }} title="Step back" onClick={() => setCursor(cursor - lengthSteps)}>
          ◀
        </Button>
        {/* Der Schreib-Cursor als Text, weil Takt/Step im Raster oben zwar zu
            sehen, aber bei 64 Steps nicht abzuzählen sind. */}
        <div className="mono" style={{ minWidth: 132, textAlign: "center", fontSize: 14 }}>
          Step {cursor + 1}/{totalSteps}
          <span style={{ color: "var(--pal-text-dim)" }}>
            {" "}
            (bar {bar}.{beat})
          </span>
        </div>
        {/* Vorrücken OHNE Note = Pause. Genau dasselbe, was das Loslassen
            einer Taste tut — deshalb hier kein eigener „Rest"-Begriff. */}
        <Button variant="alt" style={{ width: 46, height: 38, fontSize: 16 }} title="Step forward (rest)" onClick={() => setCursor(cursor + lengthSteps)}>
          ▶
        </Button>
        <Button
          style={{ width: 92, height: 38, fontSize: 14 }}
          title="Note length and cursor step"
          onClick={() => setLengthSteps(LENGTHS[(LENGTHS.indexOf(lengthSteps) + 1) % LENGTHS.length] ?? 1)}
        >
          Len {lengthSteps}
        </Button>
        <Button
          style={{ width: 92, height: 38, fontSize: 14 }}
          title="Velocity of notes played from the on-screen keys"
          onClick={() => setVelocity(VELOCITIES[(VELOCITIES.indexOf(velocity) + 1) % VELOCITIES.length] ?? DEFAULT_VELOCITY)}
        >
          Vel {velocity}
        </Button>
        <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
          <Button
            variant={sendOnPlay ? "active" : "alt"}
            style={{ width: 84, height: 38, fontSize: 13 }}
            title="Play a preview sound on the connected device while a key is held"
            onClick={() => setSendOnPlay(!sendOnPlay)}
          >
            {sendOnPlay ? "🔊 Sound" : "🔇 Sound"}
          </Button>
          <Button
            variant={autoAdvance ? "active" : "alt"}
            style={{ width: 84, height: 38, fontSize: 13 }}
            title="Advance the cursor automatically after each new note (turn off to stack a chord on one step)"
            onClick={() => setAutoAdvance(!autoAdvance)}
          >
            {autoAdvance ? "→ Auto" : "→ Hold"}
          </Button>
        </div>
      </div>
      <PianoKeys firstC={firstC} held={held} selected={notesAtCursor} onPress={press} onRelease={release} />
    </div>
  );
}

// ── Klaviatur ───────────────────────────────────────────────────────────────

/** Halbtonabstände der weißen Tasten einer Oktave. */
const WHITE_SEMIS = [0, 2, 4, 5, 7, 9, 11];
/** Nach diesen weißen Tasten (Index in WHITE_SEMIS) sitzt eine schwarze —
 *  also nach C, D, F, G, A. */
const BLACK_AFTER = [0, 1, 3, 4, 5];
/** Sichtbare Oktaven. Zwei sind auf dem 800px-Display noch fingerbreite
 *  Tasten (~57px) und decken die Spannweite ab, die man beim Einspielen mit
 *  einer Hand braucht; für alles andere gibt es ±8ve. */
const OCTAVES = 2;

function clampFirstC(c: number): number {
  // Untere Grenze wie die Piano-Rolle (C0); oben so, dass die letzte Taste
  // der rechten Oktave noch existiert.
  return Math.max(12, Math.min(c, 127 - 12 * OCTAVES));
}

function PianoKeys({
  firstC,
  held,
  selected,
  onPress,
  onRelease,
}: {
  firstC: number;
  held: readonly number[];
  /** Noten, die schon am aktuellen Step stehen — grün, s. `notesAtCursor`. */
  selected: readonly number[];
  onPress: (note: number) => void;
  onRelease: (note: number) => void;
}) {
  const whites: number[] = [];
  for (let o = 0; o < OCTAVES; o++) for (const s of WHITE_SEMIS) whites.push(firstC + 12 * o + s);
  const blacks: { note: number; index: number }[] = [];
  for (let o = 0; o < OCTAVES; o++)
    for (const i of BLACK_AFTER) blacks.push({ note: firstC + 12 * o + WHITE_SEMIS[i] + 1, index: o * 7 + i });

  return (
    <div className="piano" style={{ ["--white-count" as string]: whites.length }}>
      <div className="piano-whites">
        {whites.map((note) => (
          <PianoKey
            key={note}
            note={note}
            black={false}
            down={held.includes(note)}
            selected={selected.includes(note)}
            onPress={onPress}
            onRelease={onRelease}
          >
            {/* Beschriftet ist nur das C: jede Taste zu benennen macht die
                Klaviatur zur Tabelle, und die Oktave ist genau das, was man
                beim Blick nach unten sucht. */}
            {note % 12 === 0 ? noteName(note) : ""}
          </PianoKey>
        ))}
      </div>
      <div className="piano-blacks">
        {blacks.map(({ note, index }) => (
          <PianoKey
            key={note}
            note={note}
            black
            down={held.includes(note)}
            selected={selected.includes(note)}
            onPress={onPress}
            onRelease={onRelease}
            style={{ left: `calc(var(--white-w) * ${index + 1} - var(--black-w) / 2)` }}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * Eine Taste. Note-Off-Behandlung wie bei `RollKey` in StepGrid: `pointerup`,
 * `pointerleave` UND `pointercancel`, gedeckelt durch `down`, mit
 * Pointer-Capture — ein verpasstes Note-Off wäre ein hängender Ton, den nur
 * noch Panic beendet. Capture heißt zugleich: über die Tasten zu WISCHEN
 * spielt keine Tonleiter, die gedrückte Taste behält den Finger. Das ist der
 * Preis für „kein hängender Ton", und der ist es wert.
 */
function PianoKey({
  note,
  black,
  down,
  selected,
  onPress,
  onRelease,
  style,
  children,
}: {
  note: number;
  black: boolean;
  down: boolean;
  /** Note steht schon am aktuellen Step — grün, unabhängig vom Finger. */
  selected: boolean;
  onPress: (note: number) => void;
  onRelease: (note: number) => void;
  style?: React.CSSProperties;
  children?: React.ReactNode;
}) {
  const pressed = useRef(false);
  const release = () => {
    if (!pressed.current) return;
    pressed.current = false;
    onRelease(note);
  };
  return (
    <div
      className={`piano-key ${black ? "black" : "white"}${down ? " down" : ""}${selected ? " selected" : ""}`}
      style={style}
      onPointerDown={(e) => {
        if (pressed.current) return;
        e.currentTarget.setPointerCapture?.(e.pointerId);
        pressed.current = true;
        onPress(note);
      }}
      onPointerUp={release}
      onPointerLeave={release}
      onPointerCancel={release}
    >
      {children}
    </div>
  );
}
