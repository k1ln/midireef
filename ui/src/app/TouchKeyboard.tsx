//! On-Screen Touch-Keyboard (kein OS-Keyboard, siehe ARCHITECTURE.md §7) —
//! React-Port von ui/keyboard.ts. Global als Provider gemountet; jede
//! Komponente ruft `useTouchKeyboard().open(current, maxLen, onDone)` auf,
//! ohne das Keyboard selbst durchreichen zu müssen.

import { createContext, useContext, useState, type ReactNode } from "react";
import { Button } from "./widgets/Button";

const ROWS = ["1234567890", "qwertzuiop", "asdfghjkl", "yxcvbnm"];

type OpenFn = (current: string, maxLen: number, done: (v: string | null) => void) => void;

const Ctx = createContext<OpenFn | null>(null);

export function useTouchKeyboard(): OpenFn {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useTouchKeyboard() used outside <TouchKeyboardProvider>");
  return ctx;
}

interface Session {
  value: string;
  maxLen: number;
  done: (v: string | null) => void;
}

export function TouchKeyboardProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);

  const open: OpenFn = (current, maxLen, done) => {
    setSession({ value: current, maxLen, done });
  };

  const close = (result: string | null) => {
    session?.done(result);
    setSession(null);
  };

  const type = (ch: string) => {
    setSession((s) => (s && s.value.length < s.maxLen ? { ...s, value: s.value + ch } : s));
  };

  const backspace = () => {
    setSession((s) => (s ? { ...s, value: s.value.slice(0, -1) } : s));
  };

  return (
    <Ctx.Provider value={open}>
      {children}
      {session && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0, 0, 0, 0.85)",
            display: "flex",
            flexDirection: "column",
            justifyContent: "flex-end",
            zIndex: 20,
          }}
        >
          <div style={{ textAlign: "center", fontSize: 34, fontWeight: 700, padding: "0 16px 12px" }}>
            {session.value || " "}
          </div>
          <div
            style={{
              background: "rgba(17, 17, 17, 0.97)",
              borderRadius: "18px 18px 0 0",
              padding: 8,
              maxHeight: "min(420px, 62vh)",
            }}
          >
            {ROWS.map((row) => (
              <div key={row} className="kb-row">
                {row.split("").map((ch) => (
                  <Button key={ch} className="kb-key" onClick={() => type(ch)}>
                    {ch}
                  </Button>
                ))}
              </div>
            ))}
            <div className="kb-row">
              <Button className="kb-key" style={{ flex: "2 1 0" }} onClick={backspace}>
                ⌫
              </Button>
              <Button className="kb-key" style={{ flex: "5 1 0" }} onClick={() => type(" ")}>
                Space
              </Button>
              <Button variant="danger" className="kb-key" style={{ flex: "2.2 1 0" }} onClick={() => close(null)}>
                Cancel
              </Button>
              <Button variant="active" className="kb-key" style={{ flex: "2.2 1 0" }} onClick={() => close(session.value.trim())}>
                OK
              </Button>
            </div>
          </div>
        </div>
      )}
    </Ctx.Provider>
  );
}
