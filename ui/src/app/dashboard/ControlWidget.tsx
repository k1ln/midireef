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
  /** Highlight-Ring, solange dieses Control im rechten Dock bearbeitet wird. */
  selected?: boolean;
  /** Normaler Tipp/Klick → dieses Control ins rechte Dock holen (wie eine
   *  Kachel/Lane in der Sequencer-Übersicht). Der Tipp löst zusätzlich wie
   *  gehabt aus / dreht — Auswahl ist zerstörungsfrei. */
  onSelect: () => void;
  /** Zwei-Finger / Rechtsklick → dasselbe, aber „übernimmt" die Geste: eine
   *  ggf. gehaltene Note wird vorher freigegeben. */
  onContextMenu: () => void;
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

export function ControlWidget({ ctrl, deviceName, editMode, zoom, selected, onSelect, onContextMenu, onPress, onRelease, externalActive, recording }: ControlWidgetProps) {
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
  // Pointer IDs currently down on THIS widget — lets a second finger landing
  // on the knob itself (not just one on the knob + one on the background)
  // open the context menu too. Separate from Dashboard's own multi-touch
  // tracking, which never sees this widget's pointers at all (see
  // stopPropagation below).
  const activePointers = useRef<Set<number>>(new Set());
  // Which pointer's gesture (drag/turn/button) is actually in progress — a
  // 2nd finger that only opened the context menu must NOT be able to end it
  // early when that finger lifts while the 1st is still down.
  const primaryPointer = useRef<number | null>(null);

  const x = dragPos?.x ?? ctrl.x ?? 60;
  const y = dragPos?.y ?? ctrl.y ?? 60;
  const value = dragValue ?? ctrl.value ?? 0;

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    // Don't let this bubble to the Dashboard background handler — it would
    // start the MIDI-learn long-press timer for what's actually a press on
    // this control.
    e.stopPropagation();
    if (e.button === 2) {
      onPress();
      onContextMenu();
      return;
    }
    // A second finger landing on the knob while the first is still down →
    // touch equivalent of two-finger-click. Don't start a 2nd drag/turn
    // gesture with it; just open the menu for the gesture already in progress.
    if (activePointers.current.size >= 1) {
      activePointers.current.add(e.pointerId);
      onContextMenu();
      return;
    }
    activePointers.current.add(e.pointerId);
    primaryPointer.current = e.pointerId;
    onPress();
    // Normaler Tipp holt das Control ins rechte Dock (wie eine Kachel in der
    // Sequencer-Übersicht) — im „Move"-Modus nicht, da ist der Tipp zum Ziehen.
    if (!editMode) onSelect();
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
    if (e.pointerId !== primaryPointer.current) return;
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

  const endGesture = (e: React.PointerEvent<HTMLDivElement>) => {
    activePointers.current.delete(e.pointerId);
    // A 2nd finger that only opened the context menu isn't the one running
    // the gesture — lifting it must not end/release what the 1st is doing.
    if (e.pointerId !== primaryPointer.current) return;
    primaryPointer.current = null;
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
      {/* Innen zoomt die Regler-Größe (Settings → Controls & fonts) mit — wie
          bei den .btn-Elementen. Die Position (left/top oben) bleibt davon
          unberührt, nur die sichtbare Größe skaliert. */}
      <div style={{ position: "relative", zoom: "var(--ctrl-scale, 1)" }}>
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
            outline: selected ? "3px solid var(--pal-shimmer)" : undefined,
            outlineOffset: 3,
          }}
        >
          <div style={{ width: size - 16, height: size - 16, background: "var(--pal-btn)", opacity: lit ? 0.6 : 0.95 }} />
        </div>
      ) : (
        <svg
          width={size}
          height={size}
          style={{
            display: "block",
            borderRadius: "50%",
            outline: selected ? "3px solid var(--pal-shimmer)" : undefined,
            outlineOffset: 3,
          }}
        >
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
            <div className="mono" style={{ fontSize: 11, color: "var(--pal-text-dim)" }}>
              {isKeyboard ? "KEYBOARD (any key)" : `${ctrl.mapping.kind.toUpperCase()} ${ctrl.mapping.number}`} · Ch{ctrl.mapping.channel}
            </div>
            {ctrl.mapping.kind === "note" && !isKeyboard && ctrl.mapping.number != null && (
              <div className="mono" style={{ fontSize: 11, color: "var(--pal-text-dim)" }}>
                {noteToFreq(ctrl.mapping.number).toFixed(1)} Hz
              </div>
            )}
          </>
        )}
      </div>
      </div>
    </div>
  );
}
