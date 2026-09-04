//! Runder Drehregler für Felder mit großer Spanne (CC Output min/max, Phase,
//! LFO-Rate): die GANZE min..max-Spanne liegt auf einem festen, bequemen
//! Ziehweg statt auf hunderten/tausenden Listenzeilen — für „schnell grob
//! hinsetzen" schneller als das Wertrad, das dafür bei sehr feiner/exakter
//! Einstellung (und bei Bereichen mit fixen Rasterpunkten wie Notenwerten)
//! weiter die bessere Wahl bleibt.
//!
//! Dieselbe Physik wie WheelPicker (flywheel.ts): ein Ziehen weiter oben
//! zieht den Wert hoch, schnelle Bewegung beschleunigt überproportional
//! (`acceleratedDelta`), und ein Loslassen mit Schwung lässt den Wert nach
//! Reibung auslaufen statt abrupt stehenzubleiben. Langes Halten öffnet
//! denselben Ziffernblock wie das Wertrad für den exakten Wert.

import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Popup } from "./Popup";
import { Button } from "./Button";
import { NumericKeypadGrid, useKeypadText } from "./NumericKeypad";
import { acceleratedDelta, pushHistory, startHistory, velocityFromHistory, type Sample } from "./flywheel";

const FRICTION = 0.986;
const FLING_BOOST = 1.9;
const MIN_VELOCITY_PX = 0.05; // px/Frame, darunter gilt der Schwung als ausgelaufen
const LONG_PRESS_MS = 480;
const TAP_SLOP = 6;
/** Ziehweg (px), der — ohne Beschleunigung — die volle min..max-Spanne
 *  abdeckt: ein bequemer Wisch, unabhängig davon wie groß der Wertebereich
 *  numerisch ist (ob 0..100 oder 0..12700). */
const BASE_DRAG_PX = 220;

export interface KnobProps {
  label: string;
  value: number;
  min: number;
  max: number;
  /** Rasterung beim Runden (Default 1). */
  step?: number;
  unit?: string;
  format?: (v: number) => string;
  onChange: (v: number) => void;
  size?: number;
}

export function Knob({ label, value, min, max, step = 1, unit, format, onChange, size = 72 }: KnobProps) {
  const [dragValue, setDragValue] = useState<number | null>(null);
  const [editing, setEditing] = useState(false);
  const keypad = useKeypadText(value);

  const draggingRef = useRef(false);
  const movedRef = useRef(false);
  const downYRef = useRef(0);
  const startValueRef = useRef(value);
  const liveValueRef = useRef(value);
  const historyRef = useRef<Sample[]>([]);
  const velocityRef = useRef(0);
  const rafRef = useRef<number | undefined>(undefined);
  const longPressTimerRef = useRef<number | undefined>(undefined);

  const clamp = (v: number) => Math.min(max, Math.max(min, Math.round(v / step) * step));
  const unitsPerPx = (max - min) / BASE_DRAG_PX;

  const displayValue = dragValue ?? value;
  const fmt = (v: number) => `${format ? format(v) : String(v)}${unit ?? ""}`;

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

  const push = (v: number) => {
    const c = clamp(v);
    liveValueRef.current = c;
    setDragValue(c);
    onChange(c);
    return c;
  };

  const momentumStep = () => {
    const next = liveValueRef.current + velocityRef.current * unitsPerPx;
    velocityRef.current *= FRICTION;
    const clamped = push(next);
    // Am Anschlag oder ausgelaufen: fertig — dragValue fällt zurück auf die
    // Server-bestätigte `value` aus den Props (dieselbe Lehre wie beim
    // Dashboard-Knopf: NIE für immer auf dem lokalen Wert stehen bleiben).
    if (clamped <= min || clamped >= max || Math.abs(velocityRef.current) < MIN_VELOCITY_PX) {
      setDragValue(null);
      return;
    }
    rafRef.current = requestAnimationFrame(momentumStep);
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (editing) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    stopAnim();
    draggingRef.current = true;
    movedRef.current = false;
    downYRef.current = e.clientY;
    startValueRef.current = value;
    liveValueRef.current = value;
    historyRef.current = startHistory(e.clientY, e.timeStamp);
    clearLongPress();
    longPressTimerRef.current = window.setTimeout(() => {
      if (!movedRef.current) {
        draggingRef.current = false;
        keypad.reset(String(value));
        setEditing(true);
      }
    }, LONG_PRESS_MS);
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    const totalDy = e.clientY - downYRef.current;
    if (Math.abs(totalDy) > TAP_SLOP) {
      movedRef.current = true;
      clearLongPress();
    }
    historyRef.current = pushHistory(historyRef.current, e.clientY, e.timeStamp);
    // Nach oben ziehen = Wert rauf, wie ein echter Regler.
    push(startValueRef.current + acceleratedDelta(-totalDy, unitsPerPx));
  };

  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    clearLongPress();
    if (!draggingRef.current) return;
    draggingRef.current = false;
    if (!movedRef.current) return; // reiner Tap — nichts zu ändern
    const v = -velocityFromHistory(historyRef.current, e.clientY, e.timeStamp) * FLING_BOOST;
    if (Math.abs(v) < MIN_VELOCITY_PX) {
      setDragValue(null);
      return;
    }
    velocityRef.current = v;
    rafRef.current = requestAnimationFrame(momentumStep);
  };

  const onPointerCancel = () => {
    clearLongPress();
    draggingRef.current = false;
    stopAnim();
    setDragValue(null);
  };

  const finishEdit = (commitValue: boolean) => {
    if (commitValue) {
      const n = parseFloat(keypad.text);
      if (!Number.isNaN(n)) onChange(clamp(n));
    }
    setEditing(false);
  };

  const frac = (displayValue - min) / Math.max(1e-9, max - min);
  const angle = -135 + frac * 270;

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", width: size + 16 }}>
      <div
        style={{ touchAction: "none", cursor: "pointer" }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
      >
        <svg width={size} height={size} style={{ display: "block", borderRadius: "50%" }}>
          <circle cx={size / 2} cy={size / 2} r={size / 2 - 6} fill="none" stroke="rgba(255,255,255,0.5)" strokeWidth={3} />
          <circle cx={size / 2} cy={size / 2} r={size / 2 - 14} fill="var(--pal-btn)" opacity={0.9} />
          <line
            x1={size / 2}
            y1={size / 2}
            x2={size / 2 + Math.sin((angle * Math.PI) / 180) * (size / 2 - 16)}
            y2={size / 2 - Math.cos((angle * Math.PI) / 180) * (size / 2 - 16)}
            stroke="var(--pal-white)"
            strokeWidth={3}
          />
        </svg>
      </div>
      <div style={{ fontSize: 10, fontWeight: 700, color: "var(--pal-text-dim)", marginTop: 3, textAlign: "center" }}>
        {label}
      </div>
      <div style={{ fontSize: 13, fontWeight: 700, textAlign: "center" }}>{fmt(displayValue)}</div>

      {editing && (
        <Popup onClose={() => setEditing(false)} fullscreen>
          <div className="wheel-fs-head">
            <Button className="wheel-fs-close" onClick={() => setEditing(false)}>
              ✕
            </Button>
            <div className="popup-title" style={{ flex: 1, textAlign: "center", marginRight: 40 }}>
              {label}
            </div>
          </div>
          <div style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "center", minHeight: 0 }}>
            <NumericKeypadGrid
              text={keypad.text}
              unit={unit}
              allowNegative={min < 0}
              onDigit={keypad.appendDigit}
              onBackspace={keypad.backspace}
              onToggleSign={keypad.toggleSign}
              onCancel={() => finishEdit(false)}
              onCommit={() => finishEdit(true)}
            />
          </div>
        </Popup>
      )}
    </div>
  );
}
