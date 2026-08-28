//! Ein gelernter Taster/Regler auf dem Dashboard — React-Port von
//! mainscreen.ts's controlWidget(). Taster antippen → Note-On/Off; Regler
//! vertikal ziehen → CC-Wert. Rechtsklick / Zwei-Finger → Kontextmenü
//! (an Dashboard delegiert, da es die Multi-Pointer-Verfolgung besitzt).

import { useRef, useState } from "react";
import { useSend } from "../store";

export interface LiveControl {
  id: string;
  name: string;
  kind: string;
  mapping?: { channel: number; kind: string; number?: number }; // number fehlt nur bei kind="keyboard" (Wildcard-Mapping)
  deviceId?: string | null;
  x: number;
  y: number;
  w: number;
  h: number;
  value?: number;
}

/** MIDI-Notennummer → Frequenz in Hz (A4 = 69 = 440 Hz, 12-TET). */
function noteToFreq(note: number): number {
  return 440 * Math.pow(2, (note - 69) / 12);
}

export interface ControlWidgetProps {
  ctrl: LiveControl;
  deviceName: string | undefined;
  editMode: boolean;
  zoom: number;
  onContextMenu: (x: number, y: number) => void;
  /** Fired at the start/end of any gesture (drag, button hold, knob turn) —
   *  Dashboard tracks "which control is currently pressed" so a 2nd finger
   *  landing on the background can open that control's context menu. */
  onPress: () => void;
  onRelease: () => void;
  /** True while the physical device itself reports this control as "on"
   *  (matching Note-On came in over MIDI) — lights the button up the same
   *  way a touch/click on it would, independent of local pointer state. */
  externalActive?: boolean;
  /** True while this ("keyboard"-kind) control is linked to a melody lane
   *  via `record.arm` — shows a small REC badge. */
  recording?: boolean;
}

export function ControlWidget({ ctrl, deviceName, editMode, zoom, onContextMenu, onPress, onRelease, externalActive, recording }: ControlWidgetProps) {
  const send = useSend();
  const isKeyboard = ctrl.kind === "keyboard";
  const isButton = ctrl.kind === "button" || isKeyboard || ctrl.mapping?.kind === "note";
  const size = ctrl.w ?? 130;

  const [dragPos, setDragPos] = useState<{ x: number; y: number } | null>(null);
  const [dragValue, setDragValue] = useState<number | null>(null);
  const [pressed, setPressed] = useState(false);
  const lit = pressed || !!externalActive;
  const mode = useRef<"none" | "drag" | "turn">("none");
  const start = useRef({ gx: 0, gy: 0, x: 0, y: 0, value: 0 });

  const x = dragPos?.x ?? ctrl.x ?? 60;
  const y = dragPos?.y ?? ctrl.y ?? 60;
  const value = dragValue ?? ctrl.value ?? 0;

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    // Don't let this bubble to the Dashboard background handler — it would
    // start the MIDI-learn long-press timer for what's actually a press on
    // this control.
    e.stopPropagation();
    onPress();
    if (e.button === 2) {
      onContextMenu(e.clientX, e.clientY);
      return;
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    start.current = { gx: e.clientX, gy: e.clientY, x, y, value };
    if (editMode) {
      mode.current = "drag";
    } else if (isKeyboard) {
      // Reine Live-Aktivitäts-Anzeige (leuchtet nur, wenn das physische
      // Keyboard tatsächlich gespielt wird) — kein Touch-Trigger hier.
      mode.current = "none";
    } else if (isButton) {
      mode.current = "none";
      setPressed(true);
      send({ t: "control.press", controlId: ctrl.id });
    } else {
      mode.current = "turn";
    }
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (mode.current === "drag") {
      setDragPos({
        x: start.current.x + (e.clientX - start.current.gx) / zoom,
        y: Math.max(30, start.current.y + (e.clientY - start.current.gy) / zoom),
      });
    } else if (mode.current === "turn") {
      const dy = start.current.gy - e.clientY;
      const v = Math.min(127, Math.max(0, Math.round(start.current.value + dy * 0.7)));
      setDragValue(v);
      send({ t: "control.setValue", controlId: ctrl.id, value: v });
    }
  };

  const endGesture = () => {
    onRelease();
    if (mode.current === "drag") {
      send({ t: "control.move", controlId: ctrl.id, x: Math.round(x), y: Math.round(y - 30) });
      setDragPos(null);
    } else if (isButton && !isKeyboard) {
      setPressed(false);
      send({ t: "control.release", controlId: ctrl.id });
    }
    mode.current = "none";
  };

  return (
    <div
      style={{ position: "absolute", left: x, top: y, cursor: "pointer", touchAction: "none" }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endGesture}
      onPointerCancel={endGesture}
      onContextMenu={(e) => e.preventDefault()}
    >
      {recording && (
        <div
          style={{
            position: "absolute",
            top: -8,
            right: -8,
            padding: "2px 6px",
            borderRadius: 4,
            background: "var(--pal-danger)",
            color: "var(--pal-white)",
            fontSize: 10,
            fontWeight: 700,
            zIndex: 1,
          }}
        >
          REC
        </div>
      )}
      {isButton ? (
        <div
          style={{
            width: size,
            height: size,
            border: "3px solid rgba(255, 255, 255, 0.7)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <div style={{ width: size - 16, height: size - 16, background: "var(--pal-btn)", opacity: lit ? 0.6 : 0.95 }} />
        </div>
      ) : (
        <svg width={size} height={size} style={{ display: "block" }}>
          <circle cx={size / 2} cy={size / 2} r={size / 2 - 6} fill="none" stroke="rgba(255,255,255,0.7)" strokeWidth={3} />
          <circle cx={size / 2} cy={size / 2} r={size / 2 - 14} fill="var(--pal-btn)" opacity={0.9} />
          <line
            x1={size / 2}
            y1={size / 2}
            x2={size / 2 + Math.sin((-135 + (value / 127) * 270) * (Math.PI / 180)) * (size / 2 - 16)}
            y2={size / 2 - Math.cos((-135 + (value / 127) * 270) * (Math.PI / 180)) * (size / 2 - 16)}
            stroke="var(--pal-white)"
            strokeWidth={3}
          />
        </svg>
      )}

      {/* Info-Block direkt unter dem Button/Regler: Gerät, Name, Mapping,
          Frequenz — als eine zusammenhängende Beschriftung. */}
      <div style={{ width: size, textAlign: "center", marginTop: 4 }}>
        {deviceName && <div style={{ fontSize: 13, fontWeight: 700, color: "var(--pal-white)" }}>{deviceName}</div>}
        <div style={{ fontSize: 16, fontWeight: 600 }}>{ctrl.name || "(new)"}</div>
        {ctrl.mapping && (
          <>
            <div style={{ fontSize: 11, color: "var(--pal-text-dim)" }}>
              {isKeyboard ? "KEYBOARD (any key)" : `${ctrl.mapping.kind.toUpperCase()} ${ctrl.mapping.number}`} · Ch{ctrl.mapping.channel}
            </div>
            {ctrl.mapping.kind === "note" && !isKeyboard && ctrl.mapping.number != null && (
              <div style={{ fontSize: 11, color: "var(--pal-text-dim)" }}>{noteToFreq(ctrl.mapping.number).toFixed(1)} Hz</div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
