//! Großer waagrechter Schieber für Touch: eine ganze Zeile hoch, der Finger
//! greift überall auf der Zeile (nicht nur am kleinen Griff). Wert = Fingerposition
//! auf der Bahn (absolut); ein Tipp setzt den Wert dorthin. Langes Halten ohne
//! Bewegung öffnet denselben Ziffernblock wie der Knob für den exakten Wert.

import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Popup } from "./Popup";
import { Button } from "./Button";
import { NumericKeypadGrid, useKeypadText } from "./NumericKeypad";

const LONG_PRESS_MS = 480;
const TAP_SLOP = 8;
const THUMB = 44; // Durchmesser des Griffs (px)
const ROW_H = 72; // Höhe der Touchfläche (px)

export interface HSliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  format?: (v: number) => string;
  onChange: (v: number) => void;
  /** Breite der ganzen Zeile (px); Default: füllt den Platz (min 300). */
  width?: number;
}

export function HSlider({ label, value, min, max, step = 1, unit, format, onChange, width }: HSliderProps) {
  const [dragValue, setDragValue] = useState<number | null>(null);
  const [editing, setEditing] = useState(false);
  const keypad = useKeypadText(value);

  const trackRef = useRef<HTMLDivElement>(null);
  const downXRef = useRef(0);
  const downRef = useRef(false);
  const movedRef = useRef(false);
  const longPressTimerRef = useRef<number | undefined>(undefined);

  const clamp = (v: number) => Math.min(max, Math.max(min, Math.round(v / step) * step));
  const displayValue = dragValue ?? value;
  const fmt = (v: number) => `${format ? format(v) : String(v)}${unit ?? ""}`;

  const clearLongPress = () => {
    if (longPressTimerRef.current) {
      window.clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = undefined;
    }
  };

  /** Fingerposition → Wert; der Griff-Mittelpunkt läuft von THUMB/2 bis Breite-THUMB/2. */
  const valueAt = (clientX: number) => {
    const r = trackRef.current?.getBoundingClientRect();
    if (!r) return value;
    const usable = Math.max(1, r.width - THUMB);
    const f = Math.min(1, Math.max(0, (clientX - r.left - THUMB / 2) / usable));
    return clamp(min + f * (max - min));
  };

  const push = (v: number) => {
    setDragValue(v);
    if (v !== value) onChange(v);
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (editing) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    downRef.current = true;
    movedRef.current = false;
    downXRef.current = e.clientX;
    clearLongPress();
    longPressTimerRef.current = window.setTimeout(() => {
      if (!movedRef.current) {
        downRef.current = false;
        keypad.reset(String(value));
        setEditing(true);
      }
    }, LONG_PRESS_MS);
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!downRef.current) return;
    if (!movedRef.current && Math.abs(e.clientX - downXRef.current) > TAP_SLOP) {
      movedRef.current = true;
      clearLongPress();
    }
    if (movedRef.current) push(valueAt(e.clientX));
  };

  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    clearLongPress();
    if (!downRef.current) return;
    downRef.current = false;
    // Tipp (ohne Ziehen): Wert springt zur Fingerposition.
    if (!movedRef.current) onChange(valueAt(e.clientX));
    setDragValue(null);
  };

  const onPointerCancel = () => {
    clearLongPress();
    downRef.current = false;
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

  return (
    <div style={{ flex: width ? `0 0 ${width}px` : "1 1 300px", minWidth: 300 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", padding: "0 4px" }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: "var(--pal-text-dim)", letterSpacing: 1 }}>{label}</div>
        <div style={{ fontSize: 24, fontWeight: 700 }}>{fmt(displayValue)}</div>
      </div>
      <div
        style={{ touchAction: "none", cursor: "pointer", height: ROW_H, position: "relative" }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
      >
        <div ref={trackRef} style={{ position: "absolute", left: 0, right: 0, top: 0, bottom: 0 }}>
          <div
            style={{
              position: "absolute",
              left: THUMB / 2,
              right: THUMB / 2,
              top: ROW_H / 2 - 7,
              height: 14,
              borderRadius: 7,
              background: "rgba(255,255,255,0.18)",
              border: "2px solid rgba(255,255,255,0.5)",
              boxSizing: "border-box",
            }}
          />
          <div
            style={{
              position: "absolute",
              left: THUMB / 2,
              top: ROW_H / 2 - 7,
              height: 14,
              width: `calc((100% - ${THUMB}px) * ${frac})`,
              borderRadius: 7,
              background: "var(--pal-btn)",
              border: "2px solid rgba(255,255,255,0.5)",
              boxSizing: "border-box",
            }}
          />
          <div
            style={{
              position: "absolute",
              top: ROW_H / 2 - THUMB / 2,
              left: `calc((100% - ${THUMB}px) * ${frac})`,
              width: THUMB,
              height: THUMB,
              borderRadius: "50%",
              background: "var(--pal-btn)",
              border: "3px solid var(--pal-white)",
              boxSizing: "border-box",
            }}
          />
        </div>
      </div>

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
