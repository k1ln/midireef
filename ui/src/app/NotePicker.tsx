//! Shared note-name list picker — React port of ui/notepicker.ts. Native
//! `overflow-y: auto` scroll (via .modal-box in theme.css) replaces the old
//! hand-rolled drag-vs-tap threshold logic entirely: a real DOM list has no
//! drag/tap collision to work around in the first place.

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Popup } from "./widgets/Popup";
import { Button } from "./widgets/Button";

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

export function noteName(note: number): string {
  const octave = Math.floor(note / 12) - 1;
  return `${NOTE_NAMES[((note % 12) + 12) % 12]}${octave}`;
}

const ALL_NOTES = Array.from({ length: 128 }, (_, i) => 127 - i);

type OpenFn = (current: number | undefined, onPick: (note: number) => void) => void;

const Ctx = createContext<OpenFn | null>(null);

export function useNotePicker(): OpenFn {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useNotePicker() used outside <NotePickerProvider>");
  return ctx;
}

interface Session {
  current?: number;
  onPick: (note: number) => void;
}

export function NotePickerProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const activeRef = useRef<HTMLButtonElement | null>(null);

  const open: OpenFn = (current, onPick) => setSession({ current, onPick });
  const close = () => setSession(null);

  useEffect(() => {
    if (session) activeRef.current?.scrollIntoView({ block: "center" });
  }, [session]);

  return (
    <Ctx.Provider value={open}>
      {children}
      {session && (
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
