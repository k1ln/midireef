//! Dashboard-Popups — React-Port der openContextMenu()/openDevicePicker()/
//! openKindPicker()-Methoden aus ui/mainscreen.ts. Context-Menü und Device-
//! Picker sind am Tap-Punkt verankert (nicht zentriert) — daher ein eigener
//! AnchoredPopup statt des generischen zentrierten <Popup>.

import type { ReactNode } from "react";
import type { Device } from "../../state";
import { Button } from "../widgets/Button";
import { Popup } from "../widgets/Popup";

const TOP = 100;

function AnchoredPopup({
  x,
  y,
  width,
  onClose,
  children,
}: {
  x: number;
  y: number;
  width: number;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <div
      style={{ position: "fixed", inset: 0, zIndex: 10 }}
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="modal-box"
        style={{
          position: "absolute",
          left: `clamp(8px, ${x}px, calc(100vw - ${width}px - 8px))`,
          top: `clamp(${TOP + 8}px, ${y}px, calc(100vh - 8px))`,
          width,
          maxHeight: "none",
        }}
        onPointerDown={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}

export function ContextMenuPopup({
  x,
  y,
  onClose,
  onMove,
  onDevice,
  onRemove,
}: {
  x: number;
  y: number;
  onClose: () => void;
  onMove: () => void;
  onDevice: () => void;
  onRemove: () => void;
}) {
  return (
    <AnchoredPopup x={x} y={y} width={200} onClose={onClose}>
      <Button className="popup-row" style={{ marginBottom: 8 }} onClick={onMove}>
        Move
      </Button>
      <Button className="popup-row" style={{ marginBottom: 8 }} onClick={onDevice}>
        Device …
      </Button>
      <Button variant="danger" className="popup-row" onClick={onRemove}>
        Remove
      </Button>
    </AnchoredPopup>
  );
}

export function DevicePickerPopup({
  x,
  y,
  devices,
  activeDeviceId,
  onClose,
  onPick,
}: {
  x: number;
  y: number;
  devices: Device[];
  activeDeviceId?: string | null;
  onClose: () => void;
  onPick: (deviceId: string) => void;
}) {
  return (
    <AnchoredPopup x={x} y={y} width={220} onClose={onClose}>
      {devices.length === 0 ? (
        <div style={{ color: "var(--pal-text-dim)", fontSize: 15 }}>No device set up</div>
      ) : (
        devices.map((d) => (
          <Button
            key={d.id}
            variant={activeDeviceId === d.id ? "active" : "default"}
            className="popup-row"
            style={{ height: 36, marginBottom: 8 }}
            onClick={() => onPick(d.id)}
          >
            {d.name}
          </Button>
        ))
      )}
    </AnchoredPopup>
  );
}

export function KindPickerPopup({
  onCancel,
  onPick,
}: {
  onCancel: () => void;
  onPick: (kind: "knob" | "button") => void;
}) {
  return (
    <Popup onClose={onCancel} boxStyle={{ width: 340 }}>
      <div className="popup-title" style={{ marginBottom: 4 }}>
        CC learned — how should it act?
      </div>
      <div style={{ fontSize: 13, color: "var(--pal-text-dim)", marginBottom: 16 }}>
        e.g. a “Play” button often sends CC instead of Note.
      </div>
      <Button className="popup-row" style={{ height: 50 }} onClick={() => onPick("knob")}>
        Knob (turn)
      </Button>
      <Button className="popup-row" style={{ height: 50 }} onClick={() => onPick("button")}>
        Button (tap — sends 127/0)
      </Button>
      <Button variant="danger" className="popup-row" style={{ height: 44 }} onClick={onCancel}>
        Cancel
      </Button>
    </Popup>
  );
}
