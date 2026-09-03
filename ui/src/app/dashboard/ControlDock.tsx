//! Rechts angedocktes Menü für das im Dashboard ausgewählte Control — dieselbe
//! Bauform wie BlockDock/SettingsDock in der Sequencer-Übersicht. Ersetzt das
//! früher am Finger schwebende Kontextmenü. „Size" skaliert genau diesen einen
//! Taster/Regler frei (control.setSize) — der globale Regler-Zoom (Settings →
//! Controls & fonts) kommt zusätzlich obendrauf.

import { useEffect, useState } from "react";
import type { LiveControl } from "./ControlWidget";
import { useTouchKeyboard } from "../TouchKeyboard";
import { Button } from "../widgets/Button";
import { TRANSPORT_H } from "../layout";

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
}: ControlDockProps) {
  const openKeyboard = useTouchKeyboard();
  const [confirmRemove, setConfirmRemove] = useState(false);
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
    <div className="settings-dock" style={{ top: TRANSPORT_H }}>
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

      <div className="settings-dock-field">
        <div className="settings-dock-label">Size · {size}px</div>
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
      </div>

      <Button variant="alt" className="settings-dock-row" onClick={onMove}>
        ✥ Move
      </Button>
      <Button variant="alt" className="settings-dock-row" onClick={onDevice}>
        {deviceName ? `→ Device: ${deviceName}` : "→ Device …"}
      </Button>
      {isKeyboard && (
        <Button
          variant={isRecording ? "danger" : "alt"}
          className="settings-dock-row"
          onClick={onRecord}
        >
          {isRecording ? "■ Stop recording" : "● Record into lane …"}
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
    </div>
  );
}
