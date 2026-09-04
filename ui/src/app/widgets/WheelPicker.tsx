//! Touch-Scroll-Wertrad — ein Picker im iOS-Stil, bei dem das Scrollen SELBST
//! die Auswahl ist: die Zeile, die unter dem Mittelband liegt, ist der Wert.
//! Eigene Schwungrad-Physik (Pointer-Events, keine native Scroll-Engine) für
//! ein „luftiges" Gefühl mit echtem Fling + Rubber-Band an den Enden — an
//! Stelle des Touch-Keyboard-Umwegs, für jedes Feld mit festem Anfang und
//! Ende (min..max): CC-Bereich, Ramp-Enden, LFO-Phase/Rate, …
//!
//! Langes Halten auf dem Mittelband öffnet ein Ziffernblock, um den Wert
//! direkt einzutippen (das Rad kann bei großen Bereichen viele Zeilen
//! brauchen, um von einem Ende zum anderen zu kommen).
//!
//! Muster wie NotePicker: ein Provider stellt `useWheelPicker()` bereit, jede
//! Stelle ruft es mit { title, min, max, value, onPick } auf.

import { createContext, useContext, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { Popup } from "./Popup";
import { Button } from "./Button";

const ROW_H = 44;
const VISIBLE = 7; // ungerade → genau eine Zeile mittig
const PAD = ((VISIBLE - 1) / 2) * ROW_H;

// Schwungrad-Physik. Deutlich mehr Nachlauf als touchScroll.ts's Zwei-
// Finger-Geste (FRICTION 0.94 dort): das Rad ist hier der EINZIGE
// Interaktionsweg für den Wert, es soll sich wie ein echtes freilaufendes
// Rad anfühlen statt wie eine kurze, steife Mini-Liste.
const FRICTION = 0.955;
const FLING_BOOST = 1.25;
const MAX_VELOCITY = 70; // px/Frame Deckel, gegen absurd lange Ausläufe
const MIN_VELOCITY = 0.05; // px/Frame, darunter gilt der Schwung als ausgelaufen
const EDGE_SPRING = 0.2; // Rückfeder-Anteil/Frame jenseits der Enden
const DRAG_RESIST = 0.45; // Rubber-Band-Dämpfung beim Ziehen über die Enden hinaus
const SETTLE_MS = 220;
const LONG_PRESS_MS = 480;
const TAP_SLOP = 6; // px Bewegung, ab der ein Tap zum Drag wird

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

function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

function WheelPopup({ req, onClose }: { req: WheelRequest; onClose: () => void }) {
  const step = req.step && req.step > 0 ? req.step : 1;
  const count = Math.max(1, Math.floor((req.max - req.min) / step + 1e-9) + 1);
  const values = useRef<number[]>([]);
  if (values.current.length !== count) {
    values.current = Array.from({ length: count }, (_, i) => req.min + i * step);
  }
  const maxOffset = (count - 1) * ROW_H;
  const clampIdx = (i: number) => Math.max(0, Math.min(count - 1, i));
  const nearestIdx = (v: number) => clampIdx(Math.round((v - req.min) / step));

  const viewportRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const [sel, setSel] = useState(() => nearestIdx(req.value));
  const selRef = useRef(sel);
  selRef.current = sel;

  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState("");

  // Letzter an onPick gemeldeter Wert — sonst feuert jedes Settle erneut und
  // löst am Server einen Snapshot/Autosave ohne Änderung aus.
  const committedRef = useRef(req.value);
  const offsetRef = useRef(nearestIdx(req.value) * ROW_H);
  const velocityRef = useRef(0);
  const draggingRef = useRef(false);
  const movedRef = useRef(false);
  const dragStartOffsetRef = useRef(0);
  const rawDeltaRef = useRef(0);
  const downYRef = useRef(0);
  const lastYRef = useRef(0);
  const lastTRef = useRef(0);
  const rafRef = useRef<number | undefined>(undefined);
  const longPressTimerRef = useRef<number | undefined>(undefined);
  const wheelIdleRef = useRef<number | undefined>(undefined);

  const fmt = (v: number) => `${req.format ? req.format(v) : String(v)}${req.unit ?? ""}`;

  const applyOffset = (px: number) => {
    offsetRef.current = px;
    if (listRef.current) listRef.current.style.transform = `translateY(${-px}px)`;
    const i = clampIdx(Math.round(px / ROW_H));
    if (i !== selRef.current) setSel(i);
  };

  const rubberBand = (raw: number) => {
    if (raw < 0) return raw * DRAG_RESIST;
    if (raw > maxOffset) return maxOffset + (raw - maxOffset) * DRAG_RESIST;
    return raw;
  };

  const commit = (i: number) => {
    const v = values.current[clampIdx(i)];
    if (v !== committedRef.current) {
      committedRef.current = v;
      req.onPick(v);
    }
  };

  const stopAnim = () => {
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = undefined;
    }
  };

  const clearLongPress = () => {
    if (longPressTimerRef.current) {
      window.clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = undefined;
    }
  };

  const animateTo = (idx: number) => {
    stopAnim();
    const start = offsetRef.current;
    const target = clampIdx(idx) * ROW_H;
    if (Math.abs(start - target) < 0.5) {
      applyOffset(target);
      commit(idx);
      return;
    }
    const t0 = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - t0) / SETTLE_MS);
      applyOffset(start + (target - start) * easeOutCubic(t));
      if (t < 1) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        applyOffset(target);
        commit(idx);
      }
    };
    rafRef.current = requestAnimationFrame(tick);
  };

  const settleToNearest = () => animateTo(Math.round(offsetRef.current / ROW_H));

  const springStep = () => {
    const offset = offsetRef.current;
    const bound = offset < 0 ? 0 : maxOffset;
    const next = offset + (bound - offset) * EDGE_SPRING;
    applyOffset(next);
    if (Math.abs(bound - next) < 0.5) {
      applyOffset(bound);
      settleToNearest();
      return;
    }
    rafRef.current = requestAnimationFrame(springStep);
  };

  const momentumStep = () => {
    const next = offsetRef.current + velocityRef.current;
    velocityRef.current *= FRICTION;
    applyOffset(next);
    if (next < 0 || next > maxOffset) {
      rafRef.current = requestAnimationFrame(springStep);
      return;
    }
    if (Math.abs(velocityRef.current) < MIN_VELOCITY) {
      settleToNearest();
      return;
    }
    rafRef.current = requestAnimationFrame(momentumStep);
  };

  const release = () => {
    const offset = offsetRef.current;
    if (offset < 0 || offset > maxOffset) {
      rafRef.current = requestAnimationFrame(springStep);
      return;
    }
    let v = velocityRef.current * FLING_BOOST;
    v = Math.max(-MAX_VELOCITY, Math.min(MAX_VELOCITY, v));
    if (Math.abs(v) < MIN_VELOCITY) {
      settleToNearest();
      return;
    }
    velocityRef.current = v;
    rafRef.current = requestAnimationFrame(momentumStep);
  };

  const startEditing = () => {
    stopAnim();
    draggingRef.current = false;
    setEditText(String(values.current[selRef.current] ?? req.value));
    setEditing(true);
  };

  const onPointerDown = (e: ReactPointerEvent) => {
    if (editing) return;
    viewportRef.current?.setPointerCapture?.(e.pointerId);
    stopAnim();
    draggingRef.current = true;
    movedRef.current = false;
    dragStartOffsetRef.current = offsetRef.current;
    rawDeltaRef.current = 0;
    downYRef.current = e.clientY;
    lastYRef.current = e.clientY;
    lastTRef.current = e.timeStamp;
    velocityRef.current = 0;

    // Langes Halten löst nur aus, wenn es auf dem Mittelband beginnt — „auf
    // dem gewählten Wert halten", nicht auf einer beliebigen Zeile.
    const rect = viewportRef.current?.getBoundingClientRect();
    const localY = rect ? e.clientY - rect.top : -1;
    clearLongPress();
    if (localY >= PAD && localY <= PAD + ROW_H) {
      longPressTimerRef.current = window.setTimeout(() => {
        if (!movedRef.current) startEditing();
      }, LONG_PRESS_MS);
    }
  };

  const onPointerMove = (e: ReactPointerEvent) => {
    if (!draggingRef.current) return;
    if (Math.abs(e.clientY - downYRef.current) > TAP_SLOP) {
      movedRef.current = true;
      clearLongPress();
    }
    const dy = e.clientY - lastYRef.current;
    const dt = Math.max(1, e.timeStamp - lastTRef.current);
    rawDeltaRef.current -= dy; // Finger runter → Inhalt zeigt weiter oben → Offset sinkt
    lastYRef.current = e.clientY;
    lastTRef.current = e.timeStamp;
    const instV = (-dy / dt) * 16.6667; // auf px/Frame @60fps normiert
    velocityRef.current = velocityRef.current * 0.75 + instV * 0.25;
    applyOffset(rubberBand(dragStartOffsetRef.current + rawDeltaRef.current));
  };

  const onPointerUp = (e: ReactPointerEvent) => {
    clearLongPress();
    if (!draggingRef.current) return;
    draggingRef.current = false;
    if (!movedRef.current) {
      const rect = viewportRef.current?.getBoundingClientRect();
      const localY = rect ? e.clientY - rect.top : PAD + ROW_H / 2;
      const idx = clampIdx(Math.round((offsetRef.current + localY - PAD - ROW_H / 2) / ROW_H));
      animateTo(idx);
      return;
    }
    release();
  };

  const onPointerCancel = () => {
    clearLongPress();
    if (!draggingRef.current) return;
    draggingRef.current = false;
    settleToNearest();
  };

  // Maus-/Trackpad-Rad — nativ als passiv registriert (React), also per
  // addEventListener selbst gebunden, sonst wirft `preventDefault()`.
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const onWheelEvt = (e: WheelEvent) => {
      if (editing) return;
      e.preventDefault();
      stopAnim();
      clearLongPress();
      draggingRef.current = false;
      const dy = e.deltaMode === 1 ? e.deltaY * ROW_H * 0.3 : e.deltaY;
      applyOffset(rubberBand(offsetRef.current + dy));
      velocityRef.current = velocityRef.current * 0.5 + dy * 0.5;
      if (wheelIdleRef.current) window.clearTimeout(wheelIdleRef.current);
      wheelIdleRef.current = window.setTimeout(release, 80);
    };
    el.addEventListener("wheel", onWheelEvt, { passive: false });
    return () => el.removeEventListener("wheel", onWheelEvt);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  useEffect(
    () => () => {
      stopAnim();
      clearLongPress();
      if (wheelIdleRef.current) window.clearTimeout(wheelIdleRef.current);
    },
    [],
  );

  const finishEdit = (commitValue: boolean) => {
    if (commitValue) {
      const n = parseFloat(editText);
      if (!Number.isNaN(n)) {
        const idx = nearestIdx(n);
        applyOffset(idx * ROW_H);
        commit(idx);
      }
    }
    setEditing(false);
  };

  const appendDigit = (d: string) => setEditText((t) => (t === "0" ? d : t + d));
  const backspaceEdit = () => setEditText((t) => t.slice(0, -1));
  const toggleSign = () => setEditText((t) => (t.startsWith("-") ? t.slice(1) : t.length ? `-${t}` : t));

  return (
    <Popup
      onClose={() => {
        commit(selRef.current);
        onClose();
      }}
      fullscreen
    >
      <div className="wheel-fs-head">
        <Button
          className="wheel-fs-close"
          onClick={() => {
            commit(selRef.current);
            onClose();
          }}
        >
          ✕
        </Button>
        <div className="popup-title" style={{ flex: 1, textAlign: "center", marginRight: 40 }}>
          {req.title}
        </div>
      </div>

      <div
        className="wheel-fs-value"
        style={{ fontSize: 30, margin: "6px 0 4px" }}
      >
        {fmt(values.current[sel] ?? req.value)}
      </div>

      <div style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "center", minHeight: 0 }}>
        {editing ? (
          <div className="wheel-keypad">
            <div className="wheel-keypad-display">
              {editText || "0"}
              {req.unit ?? ""}
            </div>
            {[
              ["1", "2", "3"],
              ["4", "5", "6"],
              ["7", "8", "9"],
            ].map((row) => (
              <div key={row.join("")} className="kb-row">
                {row.map((k) => (
                  <Button key={k} className="kb-key" onClick={() => appendDigit(k)}>
                    {k}
                  </Button>
                ))}
              </div>
            ))}
            <div className="kb-row">
              {req.min < 0 ? (
                <Button className="kb-key" onClick={toggleSign}>
                  ±
                </Button>
              ) : (
                <span className="kb-key" />
              )}
              <Button className="kb-key" onClick={() => appendDigit("0")}>
                0
              </Button>
              <Button className="kb-key" onClick={backspaceEdit}>
                ⌫
              </Button>
            </div>
            <div className="kb-row">
              <Button variant="danger" style={{ flex: "1 1 0", height: 52 }} onClick={() => finishEdit(false)}>
                Cancel
              </Button>
              <Button variant="active" style={{ flex: "1 1 0", height: 52 }} onClick={() => finishEdit(true)}>
                OK
              </Button>
            </div>
          </div>
        ) : (
          <div style={{ position: "relative", height: VISIBLE * ROW_H, margin: "0 auto", width: "100%", maxWidth: 320 }}>
            {/* Mittelband — auch der Hit-Bereich fürs lange Halten. */}
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
                  "linear-gradient(180deg, rgba(17,17,17,0.97), rgba(17,17,17,0) 30%, rgba(17,17,17,0) 70%, rgba(17,17,17,0.97))",
              }}
            />
            <div
              ref={viewportRef}
              className="wheel-viewport"
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerCancel}
            >
              <div ref={listRef} className="wheel-list" style={{ transform: `translateY(${-offsetRef.current}px)` }}>
                <div style={{ height: PAD }} />
                {values.current.map((v, i) => {
                  const d = Math.abs(i - sel);
                  return (
                    <div
                      key={v}
                      className="wheel-row"
                      style={{
                        height: ROW_H,
                        fontSize: d === 0 ? 24 : 19,
                        fontWeight: d === 0 ? 800 : 600,
                        color: d === 0 ? "var(--pal-text)" : "var(--pal-text-dim)",
                        opacity: d === 0 ? 1 : Math.max(0.16, 0.92 - d * 0.16),
                        transform: `scale(${Math.max(0.78, 1 - d * 0.06)})`,
                      }}
                    >
                      {fmt(v)}
                    </div>
                  );
                })}
                <div style={{ height: PAD }} />
              </div>
            </div>
          </div>
        )}
      </div>

      {!editing && (
        <Button
          variant="active"
          style={{ width: "100%", maxWidth: 320, height: 52, margin: "10px auto 0", alignSelf: "center" }}
          onClick={() => {
            commit(selRef.current);
            onClose();
          }}
        >
          Done
        </Button>
      )}
    </Popup>
  );
}
