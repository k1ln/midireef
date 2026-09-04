//! Rechts angedocktes Menü für das im Dashboard ausgewählte Control — dieselbe
//! Bauform wie BlockDock/SettingsDock, aber schmaler, damit es nicht die halbe
//! Fläche verdeckt. „Size" öffnet einen kleinen Schieber-Popup (control.setSize
//! skaliert genau diesen einen Taster/Regler; der globale Regler-Zoom aus den
//! Einstellungen kommt zusätzlich obendrauf).

import { useEffect, useState } from "react";
import type { LiveControl } from "./ControlWidget";
import { useTouchKeyboard } from "../TouchKeyboard";
import { Button } from "../widgets/Button";
import { Popup } from "../widgets/Popup";
import { TRANSPORT_H } from "../layout";

export const CONTROL_DOCK_W = 168;

const SIZE_MIN = 70;
const SIZE_MAX = 320;
const DEFAULT_SIZE = 130;

export interface ControlDockProps {
  ctrl: LiveControl;
  deviceName: string | undefined;
  isRecording: boolean;
  onClose: () => void;
  onRename: (name: string) => void;
  onSetSize: (px: number) => void;
  onMove: () => void;
  onDevice: () => void;
  onRecord: () => void;
  onRemove: () => void;
  /** „Trigger" — Bindung Note → Lane-Slot wählen/lösen (öffnet den Picker). */
  onTrigger: () => void;
  /** Bindung scharf/aus schalten, ohne sie zu lösen. */
  onToggleTrigger: () => void;
  /** Kurzer Name der aktuellen Bindung, sonst undefined. */
  triggerLabel?: string;
  /** true = Bindung feuert, false = pausiert. */
  triggerEnabled?: boolean;
}

export function ControlDock({
  ctrl,
  deviceName,
  isRecording,
  onClose,
  onRename,
  onSetSize,
  onMove,
  onDevice,
  onRecord,
  onRemove,
  onTrigger,
  onToggleTrigger,
  triggerLabel,
  triggerEnabled,
}: ControlDockProps) {
  const openKeyboard = useTouchKeyboard();
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [sizeOpen, setSizeOpen] = useState(false);
  // Lokaler Wert fürs flüssige Ziehen; folgt dem Snapshot, wenn er sich (von
  // außen) ändert.
  const [size, setSize] = useState(Math.round(ctrl.w ?? DEFAULT_SIZE));
  useEffect(() => {
    setSize(Math.round(ctrl.w ?? DEFAULT_SIZE));
  }, [ctrl.w]);

  const isKeyboard = ctrl.kind === "keyboard";
  const mappingText = ctrl.mapping
    ? isKeyboard
      ? `KEYBOARD · Ch${ctrl.mapping.channel}`
      : `${ctrl.mapping.kind.toUpperCase()}${
          ctrl.mapping.number != null ? ` ${ctrl.mapping.number}` : ""
        } · Ch${ctrl.mapping.channel}`
    : "unmapped";

  return (
    <div className="settings-dock" style={{ top: TRANSPORT_H, width: CONTROL_DOCK_W }}>
      <div className="settings-dock-head">
        <span className="settings-dock-title" title={ctrl.name || "(new)"}>
          {ctrl.name || "(new)"}
        </span>
        <Button
          variant="alt"
          className="settings-dock-icon"
          title="Rename"
          onClick={() =>
            openKeyboard(ctrl.name ?? "", 24, (v) => {
              if (v) onRename(v);
            })
          }
        >
          ✎
        </Button>
        <Button variant="alt" className="settings-dock-icon" title="Close" onClick={onClose}>
          ✕
        </Button>
      </div>
      <div className="settings-dock-sub">{deviceName ? `${deviceName} · ${mappingText}` : mappingText}</div>

      <Button variant="alt" className="settings-dock-row" onClick={() => setSizeOpen(true)}>
        Size · {size}px
      </Button>
      <Button variant="alt" className="settings-dock-row" onClick={onMove}>
        ✥ Move
      </Button>
      <Button variant="alt" className="settings-dock-row" onClick={onDevice}>
        → Device …
      </Button>
      {triggerLabel ? (
        <>
          <Button
            variant={triggerEnabled ? "active" : "alt"}
            className="settings-dock-row"
            title="Tap to arm / pause — the binding stays either way"
            onClick={onToggleTrigger}
          >
            {triggerEnabled ? `▶ ${triggerLabel}` : `❙❙ ${triggerLabel} — off`}
          </Button>
          <Button
            variant="alt"
            className="settings-dock-row"
            style={{ height: 34, fontSize: 12 }}
            onClick={onTrigger}
          >
            ↳ change / clear …
          </Button>
        </>
      ) : (
        <Button
          variant="alt"
          className="settings-dock-row"
          title="Bind this control's note to fire a lane slot (e.g. a stored filter effect)"
          onClick={onTrigger}
        >
          ▶ Trigger …
        </Button>
      )}
      {isKeyboard && (
        <Button variant={isRecording ? "danger" : "alt"} className="settings-dock-row" onClick={onRecord}>
          {isRecording ? "■ Stop rec" : "● Record …"}
        </Button>
      )}

      {confirmRemove ? (
        <div className="settings-dock-confirm">
          <span>Remove this control?</span>
          <div className="settings-dock-actions">
            <Button
              variant="danger"
              onClick={() => {
                setConfirmRemove(false);
                onRemove();
              }}
            >
              Remove
            </Button>
            <Button variant="alt" onClick={() => setConfirmRemove(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <Button variant="danger" className="settings-dock-row" onClick={() => setConfirmRemove(true)}>
          ✕ Remove
        </Button>
      )}

      {sizeOpen && (
        <Popup onClose={() => setSizeOpen(false)} boxStyle={{ width: 320 }}>
          <div className="popup-title">Size — {size}px</div>
          <div style={{ fontSize: 13, color: "var(--pal-text-dim)", margin: "-6px 0 16px" }}>
            Scales just this control. The global control size (Settings) still applies on top.
          </div>
          <input
            className="dock-range"
            type="range"
            min={SIZE_MIN}
            max={SIZE_MAX}
            step={2}
            value={size}
            onChange={(e) => {
              const v = Number(e.target.value);
              setSize(v);
              onSetSize(v);
            }}
          />
          <div style={{ display: "flex", gap: 6, marginTop: 12 }}>
            {[90, 130, 180, 240].map((px) => (
              <Button
                key={px}
                variant={size === px ? "active" : "alt"}
                style={{ flex: 1, height: 44, fontSize: 14 }}
                onClick={() => {
                  setSize(px);
                  onSetSize(px);
                }}
              >
                {px}
              </Button>
            ))}
          </div>
        </Popup>
      )}
    </div>
  );
}
