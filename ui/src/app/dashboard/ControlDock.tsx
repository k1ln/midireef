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
  /** Endlos-Encoder: nächsten Deute-Modus für den CC-Wert wählen (zyklisch). */
  onCycleEncoder: () => void;
  /** Fan-out-Ziele (mehrere Synths mit einem Knob fahren). */
  onAddTarget: () => void;
  onEditTarget: (targetId: string) => void;
  /** Anzeigename eines Ziel-Devices. */
  deviceLabel: (deviceId: string) => string;
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
  onCycleEncoder,
  onAddTarget,
  onEditTarget,
  deviceLabel,
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
  const isLaneButton = ctrl.kind === "laneButton";
  const isTempo = ctrl.kind === "tempo";

  // Endlos-Encoder-Umschalter nur für echte CC-Regler (nicht Keyboard/Tempo/
  // Lane-Taster, nicht Note-Controls).
  const isCcKnob = !isKeyboard && !isLaneButton && !isTempo && ctrl.mapping?.kind === "cc";
  const encoderLabel: Record<string, string> = {
    absolute: "Absolute (0–127)",
    "rel-2c": "Relative · 2's-comp",
    "rel-offset": "Relative · offset-64",
    "rel-signed": "Relative · signed-bit",
  };
  const encoderMode = ctrl.mapping?.encoder ?? "absolute";
  const mappingText = isLaneButton
    ? "Lane switch · no MIDI"
    : isTempo
      ? "Tempo knob · no MIDI"
      : ctrl.mapping
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
      {!isLaneButton && !isTempo && (
        <Button variant="alt" className="settings-dock-row" onClick={onDevice}>
          → Device …
        </Button>
      )}
      {isCcKnob && (
        <Button
          variant={encoderMode === "absolute" ? "alt" : "active"}
          className="settings-dock-row"
          style={{ height: 34, fontSize: 12 }}
          title="Endless/relative encoder? Cycle until turning the knob nudges the value smoothly instead of jumping."
          onClick={onCycleEncoder}
        >
          ⟳ {encoderLabel[encoderMode]}
        </Button>
      )}
      {isCcKnob && (
        <>
          {(ctrl.targets ?? []).map((t) => (
            <Button
              key={t.id}
              variant="active"
              className="settings-dock-row"
              style={{ height: 34, fontSize: 12 }}
              title="Edit / remove this synth target"
              onClick={() => onEditTarget(t.id)}
            >
              ⇒ {deviceLabel(t.deviceId)} · CC {t.cc}
              {(t.min ?? 0) !== 0 || (t.max ?? 127) !== 127 ? ` · ${t.min ?? 0}–${t.max ?? 127}` : ""}
            </Button>
          ))}
          <Button
            variant="alt"
            className="settings-dock-row"
            style={{ height: 34, fontSize: 12 }}
            title="Drive another synth's CC (e.g. its cutoff) from this same knob"
            onClick={onAddTarget}
          >
            ＋ Steer another synth …
          </Button>
          {(ctrl.targets?.length ?? 0) > 0 && (
            <div style={{ fontSize: 11, color: "var(--pal-text-dim)", padding: "2px 4px 4px" }}>
              Fan-out active — the single “→ Device” above is bypassed for CC.
            </div>
          )}
        </>
      )}
      {!isLaneButton && !isTempo && (triggerLabel ? (
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
      ))}
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
