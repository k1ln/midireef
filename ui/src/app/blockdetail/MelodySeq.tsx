//! „1601"-Ansicht der Melodie — dieselben Noten wie Piano-Rolle und Spalten,
//! bedient wie der Behringer 1601 (Eurorack-Nachbau des ARP 1601): ein Feld aus
//! 16 senkrechten Pitch-FADERN, darunter je Step drei Gate-Bus-Schalter.
//!
//!   Fader   — Tonhöhe des Steps, auf Halbtöne quantisiert, 2 Oktaven breit
//!             (wie der Quantizer des Originals). Die Oktavlage des Fenster
//!             schiebt man mit ▲/▼ Oct. Antippen springt, Ziehen folgt dem Finger.
//!   Bus 1   — GATE: der Step spielt eine Note (aus = Pause). Beim Original
//!             steht an Bus 1 der Clocked-Gate-Ausgang.
//!   Bus 2   — ACC: Accent — hoher Anschlag (≥ `ACCENT_AT`).
//!   Bus 3   — TIE: gehaltene/gebundene Note. Tippen schaltet die Länge durch
//!             (1 → 2 → 3 → 4 Steps → wieder 1). Die überdeckten Steps stehen
//!             als „gehalten"; reicht die Note über den nächsten Ton hinaus,
//!             gleitet der Synth (Slide).
//!   Snap    — Halbton (jede Note), Ganzton (nur jeder zweite Halbton ab dem
//!             Fensterboden, also eine Ganztonleiter) oder Free: der Griff
//!             folgt dem Finger ohne Raster. MIDI-Noten sind ganzzahlig, daher
//!             wird beim Free-Ziehen die nächste Note gespielt und der Griff
//!             rastet nach dem Loslassen auf sie ein.
//!   Steps   — Länge FREI von 8 bis 128 Steps (−/+ oder Zahl antippen). Der
//!             Baustein wird ein einzelner Takt aus N Sechzehnteln, die Taktart
//!             folgt (12 Steps = 12/16); Inhalt wird nicht verschoben (s.
//!             `block.setStepCount`).
//!   Random  — Zufalls-Melodie, frei oder auf einen Stil gezielt (Acid, Blues,
//!             Techno, Funk, Jazz, Ambient, Trance): s. `randseq.rs`.
//!   1×16 / 2×8 — wie am Gerät: eine Reihe aus 16 Steps oder zwei Reihen à 8.
//!             Nur die Darstellung — die Noten bleiben ein durchlaufender Baustein.
//!
//! Es gibt keine eigenen Kommandos und kein eigenes Datenformat: alles läuft
//! über melody.addNote/removeNote/setNotePitch/setNoteLength/setNoteVelocity,
//! die Ansicht wechselt also verlustfrei mit Roll und Cols.
//!
//! Anders als am Gerät hat ein Step OHNE Note keine Tonhöhe im Baustein: der
//! Fader einer Pause merkt sich seinen Wert nur in dieser Ansicht und gibt ihn
//! beim Einschalten des Gates an die Note weiter (nach einem Neuladen steht er
//! wieder auf dem Vorschlag). Außerdem ist die Ansicht monophon: liegen an
//! einem Step mehrere Noten (Akkord aus der Roll), bearbeitet sie die HÖCHSTE
//! und zeigt „+n" für die übrigen, die sie unberührt lässt. Frei gesetztes
//! Timing (`microTiming`) bleibt ebenfalls unangetastet.
//!
//! Nicht nachgebaut: Skip/Reset-Schalter, Zufalls-Modus, Clock-FM — Takt und
//! Wiedergabe gehören hier dem Transport und der Lane.

import { useEffect, useMemo, useRef, useState } from "react";
import type { Block, MelodyNote } from "../../state";
import { useNet, useRuntime, useSend } from "../store";
import { noteName } from "../NotePicker";
import { Button } from "../widgets/Button";
import { useLocalPref } from "../useLocalPref";
import { Popup } from "../widgets/Popup";
import { useNumberEditor } from "../useNumberEditor";
import { useBlockPreview } from "./useBlockPreview";

/** Ab hier gilt eine Note als Accent (die Roll setzt neue Noten mit 100, die
 *  Schwelle liegt darüber, damit nicht jede Standardnote als Accent erscheint). */
const ACCENT_AT = 110;
/** Anschlag, den der ACC-Schalter setzt bzw. beim Abschalten zurückgibt
 *  (gleiche Werte wie der TD-3-Generator). */
const ACCENT_VELOCITY = 120;
const NORMAL_VELOCITY = 80;
/** Reihenfolge des TIE-Schalters (Steps). */
const TIE_LENGTHS = [1, 2, 3, 4];
/** Fader-Bereich in Halbtönen (2 Oktaven, wie der Quantizer). */
const SPAN = 24;
const LOWEST = 0;
const HIGHEST_LOW = 127 - SPAN;
const KNOB_H = 26;

type RowMode = "16" | "8";
type Snap = "semi" | "whole" | "free";

const MIN_STEPS = 8;
const MAX_STEPS = 128;

const STYLES: [id: string, label: string, hint: string][] = [
  ["random", "Random", "Free dice roll in the chosen scale"],
  ["acid", "Acid", "303 bass: dense 16ths, root + fifth, octave jumps, accents and slides"],
  ["blues", "Blues", "Blues scale, spaced eighths, held notes, chord tones on the beat"],
  ["techno", "Techno", "Minimal: mostly the root, off-beat 16ths"],
  ["funk", "Funk", "Dorian, syncopated and short"],
  ["jazz", "Jazz", "Dorian line, stepwise eighths, lots of variation"],
  ["ambient", "Ambient", "Few long notes in a major pentatonic"],
  ["trance", "Trance", "Minor arpeggio up and down in 16ths"],
];
const SCALES: [id: string, label: string][] = [
  ["", "Chromatic"],
  ["major", "Major"],
  ["minor", "Minor"],
  ["dorian", "Dorian"],
  ["phrygian", "Phrygian"],
  ["lydian", "Lydian"],
  ["mixolydian", "Mixolydian"],
  ["harmonicMinor", "Harm. minor"],
  ["pentatonicMinor", "Minor pent."],
  ["pentatonicMajor", "Major pent."],
  ["blues", "Blues"],
];
const KEYS = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

interface Memo {
  note: number;
  velocity: number;
  len: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function MelodySeq({ block }: { block: Block }) {
  const send = useSend();
  const net = useNet();
  const runtime = useRuntime();
  const stepsPerBar = block.stepsPerBar ?? 16;
  const total = stepsPerBar * (block.lengthBars ?? 1);
  const notes = block.notes ?? [];
  const [rowMode, setRowMode] = useLocalPref<RowMode>("melody.1601.rows", "16");
  const [snap, setSnap] = useLocalPref<Snap>("melody.1601.snap", "semi");
  const [randomOpen, setRandomOpen] = useState(false);
  const numberEdit = useNumberEditor();
  const setSteps = (n: number) => send({ t: "block.setStepCount", blockId: block.id, steps: Math.min(MAX_STEPS, Math.max(MIN_STEPS, n)) });

  // Playhead: dieselben `lane.runtime`-Events wie in der Roll (alle 16tel) —
  // und, solange der Test-Loop läuft, dessen eigene Position (die Vorschau ist
  // keine Lane und kommt in `lane.runtime` nicht vor).
  const [laneHead, setLaneHead] = useState<number | null>(null);
  useEffect(() => {
    const sync = () => setLaneHead(runtime.currentStep(block.id));
    sync();
    return net.onEvent((evt) => {
      if (evt.t === "lane.runtime") sync();
    });
  }, [net, runtime, block.id]);
  const preview = useBlockPreview(block.id);
  const head = preview.playing ? preview.step : laneHead;

  // Test-Loop: nur DIESEN Baustein in Schleife auf dem Zielgerät abspielen,
  // ohne Transport und ohne die übrigen Lanes. Änderungen an den Fadern sind
  // sofort hörbar (der Server baut die Vorschau bei jeder Änderung neu auf).
  // Beim Verlassen der Ansicht wird die Schleife beendet.
  const previewing = useRef(false);
  previewing.current = preview.playing;
  useEffect(
    () => () => {
      if (previewing.current) send({ t: "block.stopPreview" });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [block.id],
  );
  const toggleTest = () => (preview.playing ? send({ t: "block.stopPreview" }) : send({ t: "block.play", blockId: block.id, loop: true }));

  // Je Step die bearbeitete Note (die höchste) und wie viele weitere dort liegen.
  const byStep = useMemo(() => {
    const map = new Map<number, { main: MelodyNote; extra: number }>();
    for (const n of notes) {
      const s = Math.floor(n.step);
      const cur = map.get(s);
      if (!cur) map.set(s, { main: n, extra: 0 });
      else if (n.note > cur.main.note) map.set(s, { main: n, extra: cur.extra + 1 });
      else map.set(s, { main: cur.main, extra: cur.extra + 1 });
    }
    return map;
  }, [notes]);

  // Welcher Step wird von der Länge einer früheren Note überdeckt?
  const held = useMemo(() => {
    const set = new Set<number>();
    for (const { main } of byStep.values()) {
      const end = Math.min(total, Math.ceil(main.step + (main.lengthSteps ?? 1) - 1e-6));
      for (let s = Math.floor(main.step) + 1; s < end; s++) set.add(s);
    }
    return set;
  }, [byStep, total]);

  // Fenster der Fader: Tiefste Note des Bausteins auf eine Oktave abgerundet,
  // solange der Nutzer es nicht selbst verschoben hat ("" = automatisch).
  const [lowPref, setLowPref] = useLocalPref<string>(`melody.1601.low.${block.id}`, "");
  const autoLow = useMemo(() => {
    const ref = notes.length > 0 ? Math.min(...notes.map((n) => n.note)) : (block.baseNote ?? 60);
    return clamp(Math.floor(ref / 12) * 12, LOWEST, HIGHEST_LOW);
  }, [notes, block.baseNote]);
  const low = lowPref === "" ? autoLow : clamp(parseInt(lowPref, 10) || autoLow, LOWEST, HIGHEST_LOW);
  const shiftOctave = (d: number) => setLowPref(String(clamp(low + d, LOWEST, HIGHEST_LOW)));

  // Zuletzt bekannte Werte je Step: Pause → wieder an bringt sie zurück, und
  // der Fader eines Pausen-Steps hat so etwas, das er anzeigen kann.
  const memo = useRef<Map<number, Memo>>(new Map());
  const [, bump] = useState(0);
  for (const [s, { main }] of byStep) {
    memo.current.set(s, { note: main.note, velocity: main.velocity ?? NORMAL_VELOCITY, len: main.lengthSteps ?? 1 });
  }

  /** Tonhöhe, die ein Step ohne Note anzeigt bzw. beim Einschalten bekommt:
   *  seine Erinnerung, sonst die der nächsten Note davor (Läufe bleiben in der
   *  Lage), sonst die Mitte des Fensters. */
  const pitchOf = (step: number): number => {
    const own = memo.current.get(step);
    if (own) return own.note;
    for (let s = step - 1; s >= 0; s--) {
      const m = byStep.get(s)?.main;
      if (m) return m.note;
    }
    return low + 12;
  };

  const toggleGate = (step: number) => {
    const cur = byStep.get(step)?.main;
    if (cur) {
      send({ t: "melody.removeNote", blockId: block.id, step, note: cur.note });
      return;
    }
    const m = memo.current.get(step);
    send({
      t: "melody.addNote",
      blockId: block.id,
      step,
      note: pitchOf(step),
      velocity: m?.velocity ?? NORMAL_VELOCITY,
      lengthSteps: Math.min(m?.len ?? 1, total - step),
    });
  };

  const toggleAccent = (n: MelodyNote) =>
    send({
      t: "melody.setNoteVelocity",
      blockId: block.id,
      step: n.step,
      note: n.note,
      velocity: (n.velocity ?? NORMAL_VELOCITY) >= ACCENT_AT ? NORMAL_VELOCITY : ACCENT_VELOCITY,
    });

  const cycleTie = (n: MelodyNote) => {
    const cur = n.lengthSteps ?? 1;
    const room = Math.max(1, total - Math.floor(n.step));
    const options = TIE_LENGTHS.filter((l) => l <= room);
    const next = options.find((l) => l > cur + 1e-6) ?? options[0];
    send({ t: "melody.setNoteLength", blockId: block.id, step: n.step, note: n.note, lengthSteps: next });
  };

  /** Fader bewegt: mit Note → Tonhöhe ändern; bei Pause nur merken. */
  const setPitch = (step: number, from: number | null, next: number) => {
    if (from === null) {
      const m = memo.current.get(step);
      memo.current.set(step, { note: next, velocity: m?.velocity ?? NORMAL_VELOCITY, len: m?.len ?? 1 });
      bump((v) => v + 1);
    } else if (from !== next) {
      send({ t: "melody.setNotePitch", blockId: block.id, step, note: from, newNote: next });
    }
    // Beim Ziehen hört man, was man einstellt.
    send({ t: "block.previewNote", blockId: block.id, note: next, on: true });
    window.setTimeout(() => send({ t: "block.previewNote", blockId: block.id, note: next, on: false }), 140);
  };

  const per = Math.min(rowMode === "8" ? 8 : 16, Math.max(1, stepsPerBar));
  const rows: number[][] = [];
  for (let s = 0; s < total; s += per) {
    const row: number[] = [];
    for (let k = s; k < Math.min(total, s + per); k++) row.push(k);
    rows.push(row);
  }
  // Mit zwei Reihen auf dem Schirm sind die Fader kürzer, damit beide ohne
  // Scrollen passen.
  const faderH = rows.length > 1 ? 118 : 190;

  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: "auto", overflowX: "hidden", display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", flexShrink: 0 }}>
        <Button
          variant={preview.playing ? "active" : "default"}
          style={{ width: 132, height: 34, fontSize: 14 }}
          title="Loop just this sequence on the device — the transport and other lanes stay silent"
          onClick={toggleTest}
        >
          {preview.playing ? "■ Stop test" : "▶ Test loop"}
        </Button>
        <Button variant="alt" style={{ width: 40, height: 34, fontSize: 18 }} title="One step shorter" disabled={total <= MIN_STEPS} onClick={() => setSteps(total - 1)}>
          −
        </Button>
        <Button
          variant="alt"
          style={{ width: 84, height: 34, fontSize: 14 }}
          title="Sequence length in steps (8–128) — tap to type"
          onClick={() => numberEdit(total, MIN_STEPS, MAX_STEPS, setSteps, 3)}
        >
          {total} steps
        </Button>
        <Button variant="alt" style={{ width: 40, height: 34, fontSize: 18 }} title="One step longer" disabled={total >= MAX_STEPS} onClick={() => setSteps(total + 1)}>
          +
        </Button>
        <Button variant="alt" style={{ width: 84, height: 34, fontSize: 14 }} title="Generate a random melody" onClick={() => setRandomOpen(true)}>
          Random
        </Button>
        <Button variant="alt" style={{ width: 84, height: 34, fontSize: 14 }} title="Move the faders up an octave" disabled={low >= HIGHEST_LOW} onClick={() => shiftOctave(12)}>
          ▲ Oct
        </Button>
        <Button variant="alt" style={{ width: 84, height: 34, fontSize: 14 }} title="Move the faders down an octave" disabled={low <= LOWEST} onClick={() => shiftOctave(-12)}>
          ▼ Oct
        </Button>
        <span className="mono" style={{ fontSize: 12, color: "var(--pal-text-dim)" }}>
          {noteName(low)} – {noteName(low + SPAN)}
        </span>
        <div style={{ display: "flex", gap: 6, marginLeft: 8 }}>
          {(
            [
              ["semi", "½ tone", "Snap faders to every semitone"],
              ["whole", "1 tone", "Snap faders to whole tones (every second semitone)"],
              ["free", "Free", "No detents while dragging — the nearest note plays"],
            ] as const
          ).map(([id, label, title]) => (
            <Button
              key={id}
              variant={snap === id ? "active" : "alt"}
              style={{ width: 66, height: 34, fontSize: 14 }}
              title={title}
              onClick={() => setSnap(id)}
            >
              {label}
            </Button>
          ))}
        </div>
        <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
          <Button
            variant={rowMode === "16" ? "active" : "alt"}
            style={{ width: 64, height: 34, fontSize: 14 }}
            title="One row of 16 steps"
            onClick={() => setRowMode("16")}
          >
            1×16
          </Button>
          <Button
            variant={rowMode === "8" ? "active" : "alt"}
            style={{ width: 64, height: 34, fontSize: 14 }}
            title="Two rows of 8 steps"
            onClick={() => setRowMode("8")}
          >
            2×8
          </Button>
        </div>
      </div>

      {randomOpen && (
        <RandomPopup
          block={block}
          low={low}
          snap={snap}
          hasNotes={notes.length > 0}
          testRunning={preview.playing}
          onClose={() => setRandomOpen(false)}
        />
      )}

      {rows.map((row) => (
        <div key={row[0]} style={{ display: "flex", gap: 4, flexShrink: 0 }}>
          {row.map((step) => {
            const entry = byStep.get(step);
            return (
              <SeqStep
                key={step}
                step={step}
                entry={entry}
                restPitch={pitchOf(step)}
                low={low}
                snap={snap}
                faderH={faderH}
                heldOver={held.has(step)}
                playing={head === step}
                beatStart={step % 4 === 0}
                onPitch={setPitch}
                onGate={() => toggleGate(step)}
                onAccent={toggleAccent}
                onTie={cycleTie}
              />
            );
          })}
        </div>
      ))}
      <div style={{ fontSize: 12, color: "var(--pal-text-dim)", paddingBottom: 8, flexShrink: 0 }}>
        Fader = pitch · Bus 1 GATE = note / rest · Bus 2 ACC = accent · Bus 3 TIE = longer note (tap to cycle 1–4 steps)
      </div>
    </div>
  );
}

function SeqStep({
  step,
  entry,
  restPitch,
  low,
  snap,
  faderH,
  heldOver,
  playing,
  beatStart,
  onPitch,
  onGate,
  onAccent,
  onTie,
}: {
  step: number;
  entry: { main: MelodyNote; extra: number } | undefined;
  /** Tonhöhe, die der Fader bei einer Pause zeigt. */
  restPitch: number;
  low: number;
  snap: Snap;
  faderH: number;
  heldOver: boolean;
  playing: boolean;
  beatStart: boolean;
  onPitch: (step: number, from: number | null, next: number) => void;
  onGate: () => void;
  onAccent: (n: MelodyNote) => void;
  onTie: (n: MelodyNote) => void;
}) {
  const n = entry?.main;
  const on = !!n;
  const accent = on && (n.velocity ?? NORMAL_VELOCITY) >= ACCENT_AT;
  const len = n?.lengthSteps ?? 1;
  const pitch = n?.note ?? restPitch;

  // Beim schnellen Ziehen läuft das Echo des Servers dem Fader hinterher: die
  // nächste Änderung muss von der ZULETZT geschickten Tonhöhe ausgehen, sonst
  // findet der Server die „alte" Note nicht mehr und ignoriert sie.
  const sent = useRef<number | null>(n?.note ?? null);
  const lastSend = useRef(0);
  useEffect(() => {
    if (performance.now() - lastSend.current > 700) sent.current = n?.note ?? null;
  }, [n?.note]);

  const move = (next: number) => {
    const from = n ? sent.current : null;
    if (n && from === next) return;
    if (!n && next === restPitch) return;
    if (n) {
      sent.current = next;
      lastSend.current = performance.now();
    }
    onPitch(step, from, next);
  };

  return (
    <div
      style={{
        flex: 1,
        minWidth: 0,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 5,
        padding: "5px 2px 6px",
        borderRadius: 6,
        background: beatStart ? "var(--pal-panel-deep)" : "var(--pal-step-off)",
        border: "1px solid var(--pal-step-border)",
      }}
    >
      {/* Step-Lampe: leuchtet unter dem Playhead, sonst blass, wenn der Step
          eine Note spielt. */}
      <div
        title={`Step ${step + 1}`}
        style={{
          width: 14,
          height: 14,
          borderRadius: 7,
          background: playing ? "var(--pal-white)" : on ? "var(--pal-btn-active)" : "transparent",
          border: "1px solid var(--pal-step-border)",
          boxShadow: playing ? "0 0 8px var(--pal-white)" : undefined,
        }}
      />

      <Fader value={pitch} low={low} snap={snap} height={faderH} lit={on} onChange={move} />

      <div className="mono" style={{ fontSize: 11, fontWeight: 700, height: 14, opacity: on ? 1 : 0.5 }}>
        {noteName(pitch)}
      </div>

      <BusSwitch label="1" caption={on ? "●" : "○"} lit={on} title={on ? "Make this step a rest" : "Play a note on this step"} onClick={onGate} />
      <BusSwitch label="2" caption="ACC" lit={accent} disabled={!on} title="Accent" onClick={() => n && onAccent(n)} />
      <BusSwitch
        label="3"
        caption={on && len > 1 ? `TIE ${Number.isInteger(len) ? len : len.toFixed(1)}` : heldOver ? "━━" : "TIE"}
        lit={len > 1 || heldOver}
        disabled={!on}
        title="Tie — hold the note over the next steps (tap to cycle 1–4)"
        onClick={() => n && onTie(n)}
      />
      <div style={{ fontSize: 10, height: 12, color: "var(--pal-text-dim)" }}>{entry && entry.extra > 0 ? `+${entry.extra}` : ""}</div>
    </div>
  );
}

/** Gate-Bus-Schalter: Nummer des Busses als Mini-Beschriftung, darunter der
 *  Schalter mit LED-Rand. */
function BusSwitch({
  label,
  caption,
  lit,
  disabled,
  title,
  onClick,
}: {
  label: string;
  caption: string;
  lit: boolean;
  disabled?: boolean;
  title: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      title={title}
      onClick={onClick}
      style={{
        width: "100%",
        height: 38,
        padding: 0,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 1,
        borderRadius: 5,
        border: `1px solid ${lit ? "var(--pal-white)" : "var(--pal-step-border)"}`,
        background: lit ? "var(--pal-btn-active)" : "var(--pal-btn)",
        color: "var(--pal-text)",
        opacity: disabled ? 0.35 : 1,
        cursor: disabled ? "default" : "pointer",
        userSelect: "none",
        touchAction: "manipulation",
      }}
    >
      <span style={{ fontSize: 9, opacity: 0.6, lineHeight: "9px" }}>BUS {label}</span>
      <span style={{ fontSize: 12, fontWeight: 700, lineHeight: "13px" }}>{caption}</span>
    </button>
  );
}

/** Senkrechter Pitch-Fader über `SPAN` Halbtöne ab `low`. Der Griff folgt dem
 *  Finger (Antippen springt hin, Ziehen schiebt) und rastet auf Halbtöne ein.
 *  Liegt der Wert außerhalb des Fensters (Note aus der Roll), sitzt der Griff
 *  am Rand und ist rot umrandet — der erste Zug holt ihn ins Fenster. */
function Fader({
  value,
  low,
  snap,
  height,
  lit,
  onChange,
}: {
  value: number;
  low: number;
  snap: Snap;
  height: number;
  lit: boolean;
  onChange: (note: number) => void;
}) {
  const track = useRef<HTMLDivElement | null>(null);
  const drag = useRef<number | null>(null);
  // Free: Griffposition unter dem Finger (0..1), solange gezogen wird — sonst
  // würde der Griff trotzdem auf die Note einrasten, die der Server kennt.
  const [freeFrac, setFreeFrac] = useState<number | null>(null);
  const out = value < low || value > low + SPAN;
  const frac = freeFrac ?? clamp((value - low) / SPAN, 0, 1);
  const knobTop = (1 - frac) * (height - KNOB_H);

  const fromPointer = (clientY: number) => {
    const rect = track.current!.getBoundingClientRect();
    const rel = clamp((clientY - rect.top - KNOB_H / 2) / (height - KNOB_H), 0, 1);
    const raw = (1 - rel) * SPAN;
    setFreeFrac(snap === "free" ? 1 - rel : null);
    const steps = snap === "whole" ? Math.round(raw / 2) * 2 : Math.round(raw);
    onChange(low + steps);
  };

  return (
    <div
      ref={track}
      style={{
        position: "relative",
        width: 30,
        height,
        borderRadius: 6,
        background: "rgba(0,0,0,0.35)",
        border: "1px solid var(--pal-step-border)",
        touchAction: "none",
        cursor: "ns-resize",
        flexShrink: 0,
      }}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture?.(e.pointerId);
        drag.current = e.pointerId;
        fromPointer(e.clientY);
      }}
      onPointerMove={(e) => {
        if (drag.current === e.pointerId) fromPointer(e.clientY);
      }}
      onPointerUp={(e) => {
        if (drag.current === e.pointerId) drag.current = null;
        setFreeFrac(null);
      }}
      onPointerCancel={() => {
        drag.current = null;
        setFreeFrac(null);
      }}
    >
      {/* Oktavlinien (unten, Mitte, oben) zur Orientierung. */}
      {[0, 0.5, 1].map((f) => (
        <div
          key={f}
          style={{
            position: "absolute",
            left: 3,
            right: 3,
            top: KNOB_H / 2 + (1 - f) * (height - KNOB_H),
            height: 1,
            background: "rgba(255,255,255,0.18)",
            pointerEvents: "none",
          }}
        />
      ))}
      {/* Schlitz */}
      <div
        style={{
          position: "absolute",
          left: "50%",
          top: KNOB_H / 2,
          bottom: KNOB_H / 2,
          width: 4,
          marginLeft: -2,
          borderRadius: 2,
          background: "rgba(0,0,0,0.6)",
          pointerEvents: "none",
        }}
      />
      {/* Griff — hinterleuchtet, wenn der Step spielt. */}
      <div
        style={{
          position: "absolute",
          left: 1,
          right: 1,
          top: knobTop,
          height: KNOB_H,
          borderRadius: 5,
          background: lit ? "var(--pal-btn-active)" : "var(--pal-btn)",
          border: `2px solid ${out ? "var(--pal-stop)" : lit ? "var(--pal-white)" : "var(--pal-step-border)"}`,
          boxShadow: lit ? "0 0 8px var(--pal-btn-active)" : undefined,
          opacity: lit ? 1 : 0.6,
          pointerEvents: "none",
        }}
      >
        <div style={{ position: "absolute", left: 3, right: 3, top: "50%", height: 2, marginTop: -1, background: "rgba(255,255,255,0.7)" }} />
      </div>
    </div>
  );
}

/** Zufalls-Generator: Stil (oder freier Wurf), Grundton, drei Mengenregler.
 *  „Roll" würfelt neu mit frischem Seed und ERSETZT die Noten des Bausteins; läuft
 *  der Test-Loop nicht, startet er mit dem ersten Wurf, damit man das Ergebnis
 *  gleich hört. Die Regler bedeuten bei einem Stil „mehr/weniger als typisch"
 *  (50 % = so, wie der Stil es von sich aus macht). */
function RandomPopup({
  block,
  low,
  snap,
  hasNotes,
  testRunning,
  onClose,
}: {
  block: Block;
  low: number;
  snap: Snap;
  hasNotes: boolean;
  testRunning: boolean;
  onClose: () => void;
}) {
  const send = useSend();
  const [style, setStyle] = useLocalPref<string>("melody.1601.rnd.style", "acid");
  const [scale, setScale] = useLocalPref<string>("melody.1601.rnd.scale", "minor");
  const [root, setRoot] = useLocalPref<string>("melody.1601.rnd.root", "0");
  const [density, setDensity] = useLocalPref<string>("melody.1601.rnd.density", "50");
  const [accent, setAccent] = useLocalPref<string>("melody.1601.rnd.accent", "50");
  const [tie, setTie] = useLocalPref<string>("melody.1601.rnd.tie", "50");
  const [rolled, setRolled] = useState(false);

  const pickStyle = (id: string) => {
    setStyle(id);
    // Frischer Stil → Regler auf „typisch" (Random: eigene Wahrscheinlichkeiten).
    const d = id === "random" ? ["70", "30", "15"] : ["50", "50", "50"];
    setDensity(d[0]);
    setAccent(d[1]);
    setTie(d[2]);
  };

  const roll = () => {
    send({
      t: "melody.randomize",
      blockId: block.id,
      style,
      scale: style === "random" ? scale : "",
      root: parseInt(root, 10) || 0,
      low,
      span: SPAN,
      grid: snap === "whole" ? 2 : 1,
      density: (parseInt(density, 10) || 0) / 100,
      accent: (parseInt(accent, 10) || 0) / 100,
      tie: (parseInt(tie, 10) || 0) / 100,
      seed: Math.floor(Math.random() * 2 ** 31),
    });
    setRolled(true);
    if (!testRunning && !rolled) send({ t: "block.play", blockId: block.id, loop: true });
  };

  const hint = STYLES.find(([id]) => id === style)?.[2] ?? "";
  const stepper = (label: string, value: string, set: (v: string) => void) => (
    <label style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 14 }}>
      <span style={{ width: 70 }}>{label}</span>
      <input type="range" min={0} max={100} step={5} value={parseInt(value, 10) || 0} onChange={(e) => set(e.target.value)} style={{ flex: 1, height: 32 }} />
      <span className="mono" style={{ width: 40, textAlign: "right" }}>
        {parseInt(value, 10) || 0}%
      </span>
    </label>
  );

  return (
    <Popup onClose={onClose}>
      <div className="popup-title">Random melody</div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 6 }}>
        {STYLES.map(([id, label]) => (
          <Button key={id} variant={style === id ? "active" : "alt"} style={{ width: 82, height: 38, fontSize: 14 }} onClick={() => pickStyle(id)}>
            {label}
          </Button>
        ))}
      </div>
      <div style={{ fontSize: 12, color: "var(--pal-text-dim)", marginBottom: 10 }}>{hint}</div>

      <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 10 }}>
        <span style={{ width: 70, fontSize: 14 }}>Key</span>
        <Button variant="alt" style={{ width: 40, height: 34, fontSize: 18 }} onClick={() => setRoot(String((((parseInt(root, 10) || 0) + 11) % 12)))}>
          ◂
        </Button>
        <span className="mono" style={{ width: 40, textAlign: "center", fontWeight: 700 }}>
          {KEYS[(parseInt(root, 10) || 0) % 12]}
        </span>
        <Button variant="alt" style={{ width: 40, height: 34, fontSize: 18 }} onClick={() => setRoot(String((((parseInt(root, 10) || 0) + 1) % 12)))}>
          ▸
        </Button>
        {style === "random" && (
          <Button
            variant="alt"
            style={{ width: 130, height: 34, fontSize: 14, marginLeft: 8 }}
            title="Scale for the free random mode"
            onClick={() => {
              const i = SCALES.findIndex(([id]) => id === scale);
              setScale(SCALES[(i + 1) % SCALES.length][0]);
            }}
          >
            {SCALES.find(([id]) => id === scale)?.[1] ?? "Chromatic"}
          </Button>
        )}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 12 }}>
        {stepper("Density", density, setDensity)}
        {stepper("Accents", accent, setAccent)}
        {stepper("Ties", tie, setTie)}
      </div>

      <div style={{ fontSize: 12, color: "var(--pal-text-dim)", marginBottom: 10 }}>
        Notes fall inside the fader window ({noteName(low)}–{noteName(low + SPAN)}) and follow the snap setting.
        {hasNotes && !rolled ? " Rolling replaces every note in this block." : ""}
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <Button variant="default" style={{ flex: 1, height: 48, fontSize: 16 }} onClick={roll}>
          {rolled ? "Roll again" : "Roll"}
        </Button>
        <Button variant="alt" style={{ width: 90, height: 48, fontSize: 16 }} onClick={onClose}>
          Done
        </Button>
      </div>
    </Popup>
  );
}
