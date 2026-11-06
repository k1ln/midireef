//! Kompakter Step-Knob für die ST-Ansicht: 16 davon müssen nebeneinander auf
//! ein Touchdisplay passen, deshalb eine schlanke Variante des `Knob`-Widgets
//! (kein Label, kein Schwungrad, kein Ziffernblock). Vertikal ziehen ändert den
//! Wert (hoch = mehr), ein reiner Tipp meldet `onTap` — dort öffnen die Aufrufer
//! den exakten Picker (Notenliste bzw. Wertrad). Während des Ziehens zeigt der
//! Knob seinen lokalen Wert sofort; die Änderung geht gedrosselt an den Server.

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

const TAP_SLOP = 5;
const SEND_EVERY_MS = 40;
/** Wie lange der lokale Wert nach dem Loslassen stehen bleibt, falls das Echo
 *  des Servers (z.B. geklemmt) nie exakt zu ihm passt. */
const SETTLE_MS = 600;

export interface StepKnobProps {
  value: number;
  min: number;
  max: number;
  /** Fingerweg in Pixeln pro Werteinheit. */
  pxPerUnit: number;
  onChange: (v: number) => void;
  onTap?: () => void;
  format: (v: number) => string;
  size: number;
  /** Abgeschaltete Steps zeichnen ihre Knobs gedämpft (bleiben aber bedienbar). */
  dim?: boolean;
  round?: (v: number) => number;
  /** Winkelbereich des Zeigers, falls enger als der Ziehbereich (Tonhöhe:
   *  ziehbar 0–127, aber der Zeiger läuft nur über die gängigen drei Oktaven). */
  viewMin?: number;
  viewMax?: number;
}

export function StepKnob({ value, min, max, pxPerUnit, onChange, onTap, format, size, dim, round, viewMin, viewMax }: StepKnobProps) {
  const [live, setLive] = useState<number | null>(null);
  const drag = useRef<{ y: number; start: number; moved: boolean; id: number } | null>(null);
  const lastSent = useRef(0);
  const pending = useRef<number | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const settle = useRef<number | undefined>(undefined);

  // Echo vom Server angekommen → lokalen Wert fallen lassen.
  useEffect(() => {
    if (live !== null && !drag.current && value === live) setLive(null);
  }, [value, live]);
  useEffect(
    () => () => {
      window.clearTimeout(timer.current);
      window.clearTimeout(settle.current);
    },
    [],
  );

  const snap = (v: number) => {
    const c = Math.min(max, Math.max(min, v));
    return round ? round(c) : Math.round(c);
  };

  const flush = () => {
    window.clearTimeout(timer.current);
    timer.current = undefined;
    if (pending.current !== null) {
      onChange(pending.current);
      pending.current = null;
      lastSent.current = performance.now();
    }
  };

  const onDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture?.(e.pointerId);
    window.clearTimeout(settle.current);
    drag.current = { y: e.clientY, start: live ?? value, moved: false, id: e.pointerId };
  };
  const onMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const dy = d.y - e.clientY;
    if (!d.moved && Math.abs(dy) < TAP_SLOP) return;
    d.moved = true;
    const next = snap(d.start + dy / pxPerUnit);
    setLive(next);
    pending.current = next;
    const wait = SEND_EVERY_MS - (performance.now() - lastSent.current);
    if (wait <= 0) flush();
    else if (timer.current === undefined) timer.current = window.setTimeout(flush, wait);
  };
  const onUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    if (!d.moved) {
      setLive(null);
      onTap?.();
      return;
    }
    flush();
    settle.current = window.setTimeout(() => setLive(null), SETTLE_MS);
  };
  const onCancel = () => {
    drag.current = null;
    flush();
    setLive(null);
  };

  const shown = live ?? value;
  const lo = viewMin ?? min;
  const hi = viewMax ?? max;
  const frac = Math.min(1, Math.max(0, (shown - lo) / Math.max(1e-9, hi - lo)));
  const angle = -135 + frac * 270;
  const r = size / 2;
  const rad = (angle * Math.PI) / 180;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        opacity: dim ? 0.42 : 1,
        touchAction: "none",
        cursor: "ns-resize",
        userSelect: "none",
      }}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onCancel}
    >
      <svg width={size} height={size} style={{ display: "block" }}>
        <circle cx={r} cy={r} r={r - 3} fill="none" stroke="rgba(255,255,255,0.4)" strokeWidth={2} />
        <circle cx={r} cy={r} r={r - 8} fill="var(--pal-btn)" />
        <line
          x1={r}
          y1={r}
          x2={r + Math.sin(rad) * (r - 9)}
          y2={r - Math.cos(rad) * (r - 9)}
          stroke="var(--pal-white)"
          strokeWidth={3}
          strokeLinecap="round"
        />
      </svg>
      <div className="mono" style={{ fontSize: 12, fontWeight: 700, marginTop: 1, lineHeight: "14px" }}>
        {format(shown)}
      </div>
    </div>
  );
}
