//! Shared step-grid primitives — every Block Detail editor (Melody, Beat,
//! Chord, Program Change, Pattern Shift, CC stepped/envelope layers) is a
//! row (or several) of `totalSteps` cells. Wrapped in `overflow-x: auto` so
//! wide grids (multi-bar blocks) scroll instead of clipping off-screen —
//! the old Pixi canvas had no such bound, this is a small genuine fix.

import { useRef, type ReactNode } from "react";

export function StepScroller({ children }: { children: ReactNode }) {
  return <div style={{ overflowX: "auto", paddingBottom: 4 }}>{children}</div>;
}

export function StepRuler({
  totalSteps,
  stepsPerBar,
  cellW,
}: {
  totalSteps: number;
  stepsPerBar: number;
  cellW: number;
}) {
  const marker = Math.max(1, stepsPerBar / 4);
  return (
    <div style={{ display: "flex", marginBottom: 4 }}>
      {Array.from({ length: totalSteps }, (_, step) => (
        <div key={step} style={{ width: cellW, fontSize: 10, color: "var(--pal-text-dim)" }}>
          {step % marker === 0 ? step + 1 : ""}
        </div>
      ))}
    </div>
  );
}

export interface StepCellProps {
  width: number;
  height: number;
  active: boolean;
  mutedLook?: boolean;
  onClick: () => void;
  /** Held-down timer that fires after 500ms — used to clear a step's value
   *  without a separate delete gesture. Pass undefined when there's nothing
   *  to clear (mirrors the old `if (!note) return;` guard). */
  onHoldClear?: () => void;
  children?: ReactNode;
}

export function StepCell({ width, height, active, mutedLook, onClick, onHoldClear, children }: StepCellProps) {
  const timer = useRef<number | undefined>(undefined);
  const cancel = () => {
    window.clearTimeout(timer.current);
    timer.current = undefined;
  };
  return (
    <div
      className="step-cell"
      style={{
        width: width - 2,
        height: height - 2,
        background: active ? "var(--pal-btn-active)" : "var(--pal-btn)",
        opacity: active ? 1 : mutedLook ? 0.3 : 0.5,
        color: active ? "var(--pal-ink)" : "var(--pal-text)",
      }}
      onPointerDown={() => {
        if (onHoldClear) timer.current = window.setTimeout(onHoldClear, 500);
      }}
      onPointerUp={cancel}
      onPointerLeave={cancel}
      onClick={onClick}
    >
      {children}
    </div>
  );
}
