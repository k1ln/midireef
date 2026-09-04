//! Touch-Scroll-Wertrad — ein Picker im iOS-Stil, bei dem das Scrollen SELBST
//! die Auswahl ist: die Zeile, die unter dem Mittelband liegt, ist der Wert.
//! Nativer Schwung + `scroll-snap` machen das „luftige" Gefühl (keine +/–
//! Knöpfe). Für jedes Feld mit festem Anfang und Ende (min..max) — CC-Bereich,
//! Ramp-Enden, LFO-Phase/Rate, … — an Stelle des Touch-Keyboard-Umwegs.
//!
//! Muster wie NotePicker: ein Provider stellt `useWheelPicker()` bereit, jede
//! Stelle ruft es mit { title, min, max, value, onPick } auf.

import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Popup } from "./Popup";
import { Button } from "./Button";

const ROW_H = 44;
const VISIBLE = 5; // ungerade → genau eine Zeile mittig
const PAD = ((VISIBLE - 1) / 2) * ROW_H;

export interface WheelRequest {
  title: string;
  min: number;
  max: number;
  /** Schrittweite der Rasterung (Default 1). */
  step?: number;
  value: number;
  /** Hinter der Zahl in Titel + Mittelzeile, z.B. "%" oder " Hz". */
  unit?: string;
  /** Bildet den Rohwert auf seine Anzeige ab (vor `unit`). */
  format?: (v: number) => string;
  onPick: (v: number) => void;
}

type OpenFn = (req: WheelRequest) => void;
const Ctx = createContext<OpenFn | null>(null);

export function useWheelPicker(): OpenFn {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useWheelPicker() used outside <WheelPickerProvider>");
  return ctx;
}

export function WheelPickerProvider({ children }: { children: ReactNode }) {
  const [req, setReq] = useState<WheelRequest | null>(null);
  return (
    <Ctx.Provider value={setReq}>
      {children}
      {req && <WheelPopup req={req} onClose={() => setReq(null)} />}
    </Ctx.Provider>
  );
}

function WheelPopup({ req, onClose }: { req: WheelRequest; onClose: () => void }) {
  const step = req.step && req.step > 0 ? req.step : 1;
  const count = Math.max(1, Math.floor((req.max - req.min) / step + 1e-9) + 1);
  const values = useRef<number[]>([]);
  if (values.current.length !== count) {
    values.current = Array.from({ length: count }, (_, i) => req.min + i * step);
  }
  const clampIdx = (i: number) => Math.max(0, Math.min(count - 1, i));
  const nearestIdx = (v: number) => clampIdx(Math.round((v - req.min) / step));

  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const [sel, setSel] = useState(() => nearestIdx(req.value));
  const selRef = useRef(sel);
  selRef.current = sel;
  // Letzter an onPick gemeldeter Wert — sonst feuert jedes Settle erneut und
  // löst am Server einen Snapshot/Autosave ohne Änderung aus.
  const committedRef = useRef(req.value);
  const rafRef = useRef<number | undefined>(undefined);
  const settleRef = useRef<number | undefined>(undefined);

  // Beim Öffnen mittig auf dem aktuellen Wert — kein sanftes Scrollen, es soll
  // schon „dort sein", wenn der Popup erscheint.
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (el) el.scrollTop = nearestIdx(req.value) * ROW_H;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const commit = (i: number) => {
    const v = values.current[clampIdx(i)];
    if (v !== committedRef.current) {
      committedRef.current = v;
      req.onPick(v);
    }
  };

  useEffect(
    () => () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      if (settleRef.current) window.clearTimeout(settleRef.current);
    },
    [],
  );

  const fmt = (v: number) => `${req.format ? req.format(v) : String(v)}${req.unit ?? ""}`;

  const onScroll = () => {
    const el = scrollerRef.current;
    if (!el) return;
    // Sichtbare Auswahl rAF-gedrosselt nachziehen (nur Anzeige).
    if (!rafRef.current) {
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = undefined;
        const i = clampIdx(Math.round(el.scrollTop / ROW_H));
        if (i !== selRef.current) setSel(i);
      });
    }
    // Nach dem Auslaufen des Schwungs hart auf die mittige Zeile rasten (als
    // Ergänzung zu CSS-`scroll-snap`, das manche Touch-Browser lose anwenden)
    // und DANN den Wert übernehmen — „loslassen auf einem Wert = gewählt".
    if (settleRef.current) window.clearTimeout(settleRef.current);
    settleRef.current = window.setTimeout(() => {
      const i = clampIdx(Math.round(el.scrollTop / ROW_H));
      const target = i * ROW_H;
      if (Math.abs(el.scrollTop - target) > 0.5) el.scrollTo({ top: target, behavior: "smooth" });
      commit(i);
    }, 110);
  };

  return (
    <Popup
      onClose={() => {
        commit(selRef.current);
        onClose();
      }}
      boxStyle={{ width: 300 }}
    >
      <div className="popup-title" style={{ marginBottom: 2 }}>
        {req.title}
      </div>
      <div
        style={{
          fontSize: 26,
          fontWeight: 800,
          textAlign: "center",
          color: "var(--pal-run)",
          margin: "2px 0 10px",
        }}
      >
        {fmt(values.current[sel] ?? req.value)}
      </div>

      <div style={{ position: "relative", height: VISIBLE * ROW_H }}>
        {/* Mittelband */}
        <div
          aria-hidden
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            top: PAD,
            height: ROW_H,
            borderTop: "1.5px solid rgba(255, 255, 255, 0.35)",
            borderBottom: "1.5px solid rgba(255, 255, 255, 0.35)",
            pointerEvents: "none",
          }}
        />
        {/* Ränder ausblenden */}
        <div
          aria-hidden
          style={{
            position: "absolute",
            inset: 0,
            zIndex: 2,
            pointerEvents: "none",
            background:
              "linear-gradient(180deg, rgba(17,17,17,0.97), rgba(17,17,17,0) 32%, rgba(17,17,17,0) 68%, rgba(17,17,17,0.97))",
          }}
        />
        <div ref={scrollerRef} onScroll={onScroll} className="wheel-scroller">
          <div style={{ height: PAD }} />
          {values.current.map((v, i) => {
            const d = Math.abs(i - sel);
            return (
              <div
                key={v}
                className="wheel-row"
                onClick={() => scrollerRef.current?.scrollTo({ top: i * ROW_H, behavior: "smooth" })}
                style={{
                  height: ROW_H,
                  fontSize: d === 0 ? 22 : 18,
                  fontWeight: d === 0 ? 800 : 600,
                  color: d === 0 ? "var(--pal-text)" : "var(--pal-text-dim)",
                  opacity: d === 0 ? 1 : Math.max(0.28, 0.9 - d * 0.24),
                }}
              >
                {fmt(v)}
              </div>
            );
          })}
          <div style={{ height: PAD }} />
        </div>
      </div>

      <Button
        variant="active"
        style={{ width: "100%", height: 46, marginTop: 12 }}
        onClick={() => {
          commit(selRef.current);
          onClose();
        }}
      >
        Done
      </Button>
    </Popup>
  );
}
