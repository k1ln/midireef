//! Shared note picker — React port of ui/notepicker.ts, plus (when a
//! `blockId` is given, s. `OpenFn`) a "learn" mode: play the note on a
//! connected MIDI keyboard, or tap it on an on-screen keyboard, with a Save
//! button so several tries are free before anything is committed. Native
//! `overflow-y: auto` scroll (via .modal-box in theme.css) replaces the old
//! hand-rolled drag-vs-tap threshold logic entirely: a real DOM list has no
//! drag/tap collision to work around in the first place.

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Popup } from "./widgets/Popup";
import { Button } from "./widgets/Button";
import { useNet, useSend } from "./store";
import { PianoKeys, clampFirstC, DEFAULT_VELOCITY } from "./blockdetail/PlayIn";

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

export function noteName(note: number): string {
  const octave = Math.floor(note / 12) - 1;
  return `${NOTE_NAMES[((note % 12) + 12) % 12]}${octave}`;
}

const ALL_NOTES = Array.from({ length: 128 }, (_, i) => 127 - i);

type OpenFn = (
  current: number | undefined,
  onPick: (note: number) => void,
  /** Block whose target device a played/tapped note should sound on, and
   *  whose hardware input should be listened to (`noteInput.listen`) while
   *  the popup is open — s. `NoteLearnPopup`. Omitted: plain list, no
   *  preview/listen (used where no device target exists yet, e.g. a lane's
   *  default note before a block is assigned). */
  blockId?: string,
) => void;

const Ctx = createContext<OpenFn | null>(null);

export function useNotePicker(): OpenFn {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useNotePicker() used outside <NotePickerProvider>");
  return ctx;
}

interface Session {
  current?: number;
  onPick: (note: number) => void;
  blockId?: string;
}

export function NotePickerProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const activeRef = useRef<HTMLButtonElement | null>(null);

  const open: OpenFn = (current, onPick, blockId) => setSession({ current, onPick, blockId });
  const close = () => setSession(null);

  useEffect(() => {
    if (session) activeRef.current?.scrollIntoView({ block: "center" });
  }, [session]);

  return (
    <Ctx.Provider value={open}>
      {children}
      {session && session.blockId && (
        <NoteLearnPopup
          current={session.current}
          blockId={session.blockId}
          onPick={session.onPick}
          onClose={close}
        />
      )}
      {session && !session.blockId && (
        <Popup onClose={close} boxStyle={{ width: 260 }}>
          <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 12 }}>Choose note</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {ALL_NOTES.map((n) => {
              const active = n === session.current;
              return (
                <Button
                  key={n}
                  ref={active ? activeRef : undefined}
                  variant={active ? "active" : "default"}
                  style={{ height: 32, justifyContent: "flex-start", paddingLeft: 12, fontSize: 15 }}
                  onClick={() => {
                    session.onPick(n);
                    close();
                  }}
                >
                  {noteName(n)} ({n})
                </Button>
              );
            })}
          </div>
        </Popup>
      )}
    </Ctx.Provider>
  );
}

/**
 * "Learn" a note for a block: play it on a connected MIDI keyboard, or tap
 * it on the on-screen keyboard below — either way it becomes the candidate
 * (previewed on the block's target device, highlighted here) without being
 * written anywhere yet, so a wrong guess costs nothing. Save commits it,
 * Cancel (or tapping the backdrop) walks away without changing anything —
 * same contract as PlayIn.tsx's hardware arm/disarm, just for a single note
 * instead of a whole piano roll.
 */
function NoteLearnPopup({
  current,
  blockId,
  onPick,
  onClose,
}: {
  current?: number;
  blockId: string;
  onPick: (note: number) => void;
  onClose: () => void;
}) {
  const send = useSend();
  const net = useNet();
  const [candidate, setCandidate] = useState<number | undefined>(current);
  const [firstC, setFirstC] = useState(() => clampFirstC(Math.floor((current ?? 60) / 12) * 12));
  const [held, setHeld] = useState<number[]>([]);
  const heldRef = useRef<Set<number>>(new Set());

  // Arm hardware listening for as long as the popup is open; disarm on
  // close. The server sounds hardware notes on the block's target itself
  // (s. AppState::forward_note_input) — nothing to preview here.
  useEffect(() => {
    send({ t: "noteInput.listen", blockId });
    return () => send({ t: "noteInput.listen", blockId: null });
  }, [send, blockId]);

  useEffect(() => {
    return net.onEvent((evt) => {
      if (evt.t !== "noteInput.note" || evt.blockId !== blockId || !evt.on) return;
      setCandidate(evt.note);
      setFirstC(clampFirstC(Math.floor(evt.note / 12) * 12));
    });
  }, [net, blockId]);

  // On-screen key: short preview tone (block.previewNote) while held, and
  // the tapped note becomes the candidate — same split as PlayIn.tsx's
  // press/release, minus the step-grid bookkeeping this popup has no use for.
  const press = (note: number) => {
    heldRef.current.add(note);
    setHeld([...heldRef.current]);
    setCandidate(note);
    send({ t: "block.previewNote", blockId, note, on: true, velocity: DEFAULT_VELOCITY });
  };
  const release = (note: number) => {
    heldRef.current.delete(note);
    setHeld([...heldRef.current]);
    send({ t: "block.previewNote", blockId, note, on: false });
  };

  return (
    <Popup onClose={onClose} boxStyle={{ width: 380 }}>
      <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 4 }}>Set note</div>
      <div style={{ fontSize: 13, color: "var(--pal-text-dim)", marginBottom: 12 }}>
        Play it on a connected MIDI keyboard, or tap it below.
      </div>
      <div className="mono" style={{ fontSize: 22, fontWeight: 700, textAlign: "center", marginBottom: 10 }}>
        {candidate !== undefined ? `${noteName(candidate)} (${candidate})` : "—"}
      </div>
      <div style={{ display: "flex", gap: 6, justifyContent: "center", marginBottom: 10 }}>
        <Button variant="alt" style={{ width: 60, height: 34 }} onClick={() => setFirstC(clampFirstC(firstC - 12))}>
          −8ve
        </Button>
        <Button variant="alt" style={{ width: 60, height: 34 }} onClick={() => setFirstC(clampFirstC(firstC + 12))}>
          +8ve
        </Button>
      </div>
      <PianoKeys
        firstC={firstC}
        octaves={1}
        held={held}
        selected={candidate !== undefined ? [candidate] : []}
        onPress={press}
        onRelease={release}
      />
      <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
        <Button variant="alt" style={{ flex: 1, height: 40 }} onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="active"
          style={{ flex: 1, height: 40 }}
          disabled={candidate === undefined}
          onClick={() => {
            if (candidate !== undefined) onPick(candidate);
            onClose();
          }}
        >
          Save
        </Button>
      </div>
    </Popup>
  );
}
