//! On-Screen Touch-Keyboard (kein OS-Keyboard, siehe ARCHITECTURE.md §7) —
//! React-Port von ui/keyboard.ts. Global als Provider gemountet; jede
//! Komponente ruft `useTouchKeyboard().open(current, maxLen, onDone)` auf,
//! ohne das Keyboard selbst durchreichen zu müssen.

import { createContext, useContext, useState, type ReactNode } from "react";
import { Button } from "./widgets/Button";

const ROWS = ["1234567890", "qwertzuiop", "asdfghjkl", "yxcvbnm"];
/** Symbole, die reine Buchstaben/Ziffern nicht abdecken, aber für Tokens
 *  (GitHub PATs: „ghp_…“, „github_pat_…") und Repo-/Nutzernamen (Bindestriche)
 *  gebraucht werden. ⇧ neben dran togglet Groß-/Kleinschreibung der Buchstaben. */
const SYMBOLS = ["-", "_", ".", "@", "/", ":"];

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
  /** true = der vorhandene Text ist "markiert": der nächste Tastendruck
   *  ersetzt ihn komplett (wie Select-All beim Fokussieren eines Feldes).
   *  ⌫ oder ein Tipp auf den Text hebt die Markierung auf → normales Weiter-
   *  tippen am bestehenden String. */
  primed: boolean;
  done: (v: string | null) => void;
}

export function TouchKeyboardProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  // Toggle statt Einmal-Shift — bei Tokens/Repo-Namen folgen oft mehrere
  // Großbuchstaben hintereinander (z.B. "ghp_", Präfixe), ein Einmal-Shift
  // würde nach jedem Zeichen wieder zurückfallen.
  const [caps, setCaps] = useState(false);

  const open: OpenFn = (current, maxLen, done) => {
    setSession({ value: current, maxLen, primed: current.length > 0, done });
    setCaps(false);
  };

  const close = (result: string | null) => {
    session?.done(result);
    setSession(null);
  };

  const type = (ch: string) => {
    const out = caps ? ch.toUpperCase() : ch;
    setSession((s) => {
      if (!s) return s;
      // Markiert → der erste Tastendruck fängt einen frischen String an.
      if (s.primed) return { ...s, value: out.slice(0, s.maxLen), primed: false };
      return s.value.length < s.maxLen ? { ...s, value: s.value + out } : s;
    });
  };

  const backspace = () => {
    // ⌫ editiert den bestehenden Text weiter, statt ihn (markiert) zu ersetzen.
    setSession((s) => (s ? { ...s, value: s.value.slice(0, -1), primed: false } : s));
  };

  // Tipp auf die Anzeige: Text wieder "markieren" (nächster Tastendruck ersetzt)
  // bzw. Markierung lösen, wenn er schon markiert war.
  const toggleSelect = () => {
    setSession((s) => (s && s.value.length > 0 ? { ...s, primed: !s.primed } : s));
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
            // Über den angedockten Menüs (block-dock / settings-dock, z-index 30)
            // — von dort aus wird umbenannt, und das Menü darf die Tastatur
            // nicht verdecken.
            zIndex: 100,
          }}
        >
          <div style={{ textAlign: "center", padding: "0 16px 12px" }}>
            <span
              onClick={toggleSelect}
              style={{
                display: "inline-block",
                fontSize: 34,
                fontWeight: 700,
                cursor: "pointer",
                padding: "2px 12px",
                borderRadius: 8,
                background: session.primed ? "var(--pal-btn-active)" : "transparent",
                color: session.primed ? "var(--pal-white)" : "inherit",
              }}
            >
              {session.value || " "}
            </span>
          </div>
          <div
            style={{
              background: "rgba(17, 17, 17, 0.97)",
              borderRadius: "18px 18px 0 0",
              padding: 8,
              maxHeight: "min(420px, 62vh)",
            }}
          >
            {ROWS.map((row, i) => (
              <div key={row} className="kb-row">
                {i === ROWS.length - 1 && (
                  <Button
                    variant={caps ? "active" : undefined}
                    className="kb-key"
                    style={{ flex: "1.6 1 0" }}
                    onClick={() => setCaps((c) => !c)}
                  >
                    ⇧
                  </Button>
                )}
                {row.split("").map((ch) => (
                  <Button key={ch} className="kb-key" onClick={() => type(ch)}>
                    {caps ? ch.toUpperCase() : ch}
                  </Button>
                ))}
              </div>
            ))}
            <div className="kb-row">
              {SYMBOLS.map((ch) => (
                <Button key={ch} className="kb-key" onClick={() => type(ch)}>
                  {ch}
                </Button>
              ))}
            </div>
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
