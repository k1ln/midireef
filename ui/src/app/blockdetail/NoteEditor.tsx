//! Ein Tipper auf eine Note öffnet diesen Editor: Tonhöhe UND Länge in EINEM
//! Popup. Vorher lagen die beiden weit auseinander — die Tonhöhe hinter dem
//! 128-Zeilen-Note-Picker, die Länge hinter dem Ziffern-Keyboard, das mit dem
//! bisherigen Wert VORBELEGT aufgeht: aus „1" tippte man dort ein „12" statt
//! einer „2", solange man nicht erst ⌫ drückte. Genau deshalb gibt es hier
//! Schnell-Längen zum Antippen und einen ±-Stepper; das Keyboard braucht die
//! Notenlänge gar nicht mehr.
//!
//! Der Editor hält KEINEN eigenen Zustand: er liest die Note bei jedem Render
//! frisch aus dem Baustein und schickt pro Änderung ein Kommando. So zeigt er
//! immer das, was der Server wirklich gespeichert hat (der z.B. eine Tonhöhe
//! ablehnt, die am selben Step schon belegt ist).

import type { Block } from "../../state";
import { useSend } from "../store";
import { useNotePicker, noteName } from "../NotePicker";
import { Button } from "../widgets/Button";
import { Popup } from "../widgets/Popup";

/** Schnell-Längen in Steps. Was länger als der Baustein ist, fällt raus. */
const LENGTH_PRESETS = [1, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64];

/** Schnell-Anschlagstärken — grob von „gerade noch da" bis Vollgas. 0 fehlt
 *  absichtlich: das wäre auf dem Draht ein Note-Off (s. `melody.setNoteVelocity`). */
const VELOCITY_PRESETS = [20, 40, 60, 80, 100, 127];

/** Schrittweite der ±-Tasten für die Velocity — 1 wäre auf dem Touchdisplay
 *  nicht zu treffen, und hörbar wird ohnehin erst ein größerer Sprung. */
const VELOCITY_STEP = 5;

/** Eine Note wird über (Step, Tonhöhe) adressiert — wie in den Kommandos. */
export interface NoteRef {
  step: number;
  note: number;
}

export function NoteEditorPopup({
  block,
  target,
  onRetarget,
  onClose,
}: {
  block: Block;
  target: NoteRef;
  /** Tonhöhe geändert → der Aufrufer muss seine Auswahl mitziehen, sonst
   *  zeigt das Popup ins Leere und schließt sich beim nächsten Render. */
  onRetarget: (next: NoteRef) => void;
  onClose: () => void;
}) {
  const send = useSend();
  const openNotePicker = useNotePicker();

  const stepsPerBar = block.stepsPerBar ?? 16;
  const totalSteps = stepsPerBar * (block.lengthBars ?? 1);
  const notes = block.notes ?? [];
  const note = notes.find((n) => n.step === target.step && n.note === target.note);
  if (!note) return null;

  const len = Math.max(1, note.lengthSteps ?? 1);
  const vel = Math.min(127, Math.max(1, note.velocity ?? 100));
  // Am selben Step schon vergebene Tonhöhen: der Server lehnt ein Umziehen
  // dorthin ab (Akkord-Stack darf keine Dublette enthalten), also sperren wir
  // die Schritte hier gleich, statt sie stumm verpuffen zu lassen.
  const taken = new Set(notes.filter((n) => n.step === target.step && n !== note).map((n) => n.note));

  const setPitch = (next: number) => {
    const clamped = Math.min(127, Math.max(0, next));
    if (clamped === note.note || taken.has(clamped)) return;
    send({ t: "melody.setNotePitch", blockId: block.id, step: target.step, note: note.note, newNote: clamped });
    onRetarget({ step: target.step, note: clamped });
  };

  const setLength = (next: number) => {
    const clamped = Math.min(totalSteps, Math.max(1, next));
    if (clamped === len) return;
    send({ t: "melody.setNoteLength", blockId: block.id, step: target.step, note: note.note, lengthSteps: clamped });
  };

  const setVelocity = (next: number) => {
    const clamped = Math.min(127, Math.max(1, next));
    if (clamped === vel) return;
    send({ t: "melody.setNoteVelocity", blockId: block.id, step: target.step, note: note.note, velocity: clamped });
  };

  const canPitch = (delta: number) => {
    const next = note.note + delta;
    return next >= 0 && next <= 127 && !taken.has(next);
  };

  const presets = LENGTH_PRESETS.filter((n) => n <= totalSteps);

  return (
    <Popup onClose={onClose} boxStyle={{ width: 320 }}>
      <div className="popup-title">Note · step {target.step + 1}</div>

      {/* ── Tonhöhe ── */}
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 14 }}>
        <Button variant="alt" style={STEP_BTN} disabled={!canPitch(-12)} onClick={() => setPitch(note.note - 12)}>
          −12
        </Button>
        <Button variant="alt" style={STEP_BTN} disabled={!canPitch(-1)} onClick={() => setPitch(note.note - 1)}>
          −1
        </Button>
        <Button
          style={{ flex: 1, height: 46, fontSize: 17, fontWeight: 700 }}
          onClick={() => openNotePicker(note.note, setPitch)}
        >
          {noteName(note.note)} ({note.note})
        </Button>
        <Button variant="alt" style={STEP_BTN} disabled={!canPitch(1)} onClick={() => setPitch(note.note + 1)}>
          +1
        </Button>
        <Button variant="alt" style={STEP_BTN} disabled={!canPitch(12)} onClick={() => setPitch(note.note + 12)}>
          +12
        </Button>
      </div>

      {/* ── Länge ── */}
      <div style={{ fontSize: 13, color: "var(--pal-text-dim)", marginBottom: 6 }}>
        Length — {len} {len === 1 ? "step" : "steps"} · {barLabel(len, stepsPerBar)}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 10 }}>
        {presets.map((n) => (
          <Button
            key={n}
            variant={n === len ? "active" : "alt"}
            style={{ width: 46, height: 40, fontSize: 15 }}
            onClick={() => setLength(n)}
          >
            {n}
          </Button>
        ))}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 16 }}>
        <Button variant="alt" style={STEP_BTN} disabled={len <= 1} onClick={() => setLength(len - 1)}>
          −
        </Button>
        <Button variant="alt" style={STEP_BTN} disabled={len >= totalSteps} onClick={() => setLength(len + 1)}>
          +
        </Button>
        <Button
          variant="alt"
          style={{ flex: 1, height: 46, fontSize: 14 }}
          disabled={len >= totalSteps - target.step}
          onClick={() => setLength(totalSteps - target.step)}
        >
          Hold to end
        </Button>
      </div>

      {/* ── Anschlagstärke ── */}
      <div style={{ fontSize: 13, color: "var(--pal-text-dim)", marginBottom: 6 }}>Velocity — {vel}</div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 10 }}>
        {VELOCITY_PRESETS.map((n) => (
          <Button
            key={n}
            variant={n === vel ? "active" : "alt"}
            style={{ width: 46, height: 40, fontSize: 15 }}
            onClick={() => setVelocity(n)}
          >
            {n}
          </Button>
        ))}
      </div>
      <div style={{ display: "flex", gap: 6, marginBottom: 16 }}>
        <Button variant="alt" style={STEP_BTN} disabled={vel <= 1} onClick={() => setVelocity(vel - VELOCITY_STEP)}>
          −
        </Button>
        <Button variant="alt" style={STEP_BTN} disabled={vel >= 127} onClick={() => setVelocity(vel + VELOCITY_STEP)}>
          +
        </Button>
        {/* Balken statt nur Zahl: beim Durchtippen der Presets sieht man die
            Dynamik einer Melodie schneller als am Zahlenwert. */}
        <div style={{ flex: 1, alignSelf: "center", height: 8, borderRadius: 4, background: "var(--pal-step-off)" }}>
          <div style={{ width: `${(vel / 127) * 100}%`, height: "100%", borderRadius: 4, background: "var(--pal-btn-active)" }} />
        </div>
      </div>

      <div style={{ display: "flex", gap: 8 }}>
        <Button
          variant="danger"
          style={{ flex: 1, height: 46, fontSize: 15 }}
          onClick={() => {
            send({ t: "melody.removeNote", blockId: block.id, step: target.step, note: note.note });
            onClose();
          }}
        >
          Remove
        </Button>
        <Button variant="active" style={{ flex: 1, height: 46, fontSize: 15 }} onClick={onClose}>
          Done
        </Button>
      </div>
    </Popup>
  );
}

const STEP_BTN = { width: 52, height: 46, fontSize: 15 } as const;

/** Länge zusätzlich in Takten ausdrücken — „4 steps" sagt bei 16/Takt wenig,
 *  „¼ bar" dafür sofort etwas. */
function barLabel(len: number, stepsPerBar: number): string {
  if (len % stepsPerBar === 0) {
    const bars = len / stepsPerBar;
    return `${bars} ${bars === 1 ? "bar" : "bars"}`;
  }
  if (stepsPerBar % len === 0) return `1/${stepsPerBar / len} bar`;
  return `${len}/${stepsPerBar} bar`;
}
