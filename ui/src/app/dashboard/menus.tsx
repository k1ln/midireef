//! Dashboard-Popups — React-Port der openContextMenu()/openDevicePicker()/
//! openKindPicker()-Methoden aus ui/mainscreen.ts. Context-Menü und Device-
//! Picker sind am Tap-Punkt verankert (nicht zentriert) — daher ein eigener
//! AnchoredPopup statt des generischen zentrierten <Popup>.

import type { ReactNode } from "react";
import type { Device, Lane } from "../../state";
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
  showRecord,
  isRecording,
  onRecord,
}: {
  x: number;
  y: number;
  onClose: () => void;
  onMove: () => void;
  onDevice: () => void;
  onRemove: () => void;
  /** Only "keyboard"-kind controls can be linked to a melody lane. */
  showRecord?: boolean;
  isRecording?: boolean;
  onRecord?: () => void;
}) {
  return (
    <AnchoredPopup x={x} y={y} width={200} onClose={onClose}>
      <Button className="popup-row" style={{ marginBottom: 8 }} onClick={onMove}>
        Move
      </Button>
      <Button className="popup-row" style={{ marginBottom: 8 }} onClick={onDevice}>
        Device …
      </Button>
      {showRecord && (
        <Button
          variant={isRecording ? "danger" : "default"}
          className="popup-row"
          style={{ marginBottom: 8 }}
          onClick={onRecord}
        >
          {isRecording ? "Stop recording" : "Record into lane …"}
        </Button>
      )}
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

/** Melody-lane picker for "Record into lane …" — flat list of (device, lane)
 *  pairs, since a keyboard control's recording link isn't scoped to one
 *  device the way "Device …" is. */
export function LanePickerPopup({
  x,
  y,
  devices,
  onClose,
  onPick,
}: {
  x: number;
  y: number;
  devices: Device[];
  onClose: () => void;
  onPick: (lane: Lane) => void;
}) {
  const melodyLanes = devices.flatMap((d) => (d.lanes ?? []).filter((l) => l.role === "melody").map((l) => ({ dev: d, lane: l })));
  return (
    <AnchoredPopup x={x} y={y} width={260} onClose={onClose}>
      <div style={{ fontSize: 13, color: "var(--pal-text-dim)", marginBottom: 8 }}>Record into which melody lane?</div>
      {melodyLanes.length === 0 ? (
        <div style={{ color: "var(--pal-text-dim)", fontSize: 15 }}>No melody lane set up yet</div>
      ) : (
        melodyLanes.map(({ dev, lane }) => (
          <Button key={lane.id} className="popup-row" style={{ height: 40, marginBottom: 8, flexDirection: "column", alignItems: "flex-start", paddingLeft: 12 }} onClick={() => onPick(lane)}>
            <span style={{ fontWeight: 700 }}>{lane.name}</span>
            <span style={{ fontSize: 11, color: "var(--pal-text-dim)" }}>{dev.name}</span>
          </Button>
        ))
      )}
    </AnchoredPopup>
  );
}

export function KindPickerPopup({
  mappingKind,
  onCancel,
  onPick,
}: {
  /** Which ambiguous MIDI-Learn result this picker is resolving — CC (turn
   *  vs. tap) or note (single key vs. a whole physical keyboard). */
  mappingKind: "cc" | "note";
  onCancel: () => void;
  onPick: (kind: "knob" | "button" | "keyboard") => void;
}) {
  if (mappingKind === "note") {
    return (
      <Popup onClose={onCancel} boxStyle={{ width: 360 }}>
        <div className="popup-title" style={{ marginBottom: 4 }}>
          Note learned — single key or whole keyboard?
        </div>
        <div style={{ fontSize: 13, color: "var(--pal-text-dim)", marginBottom: 16 }}>
          “Whole keyboard” lights up whenever any key on this channel is played — no need to learn every key.
        </div>
        <Button className="popup-row" style={{ height: 50 }} onClick={() => onPick("button")}>
          Single key (this note only)
        </Button>
        <Button className="popup-row" style={{ height: 50 }} onClick={() => onPick("keyboard")}>
          Whole keyboard (any key, this channel)
        </Button>
        <Button variant="danger" className="popup-row" style={{ height: 44 }} onClick={onCancel}>
          Cancel
        </Button>
      </Popup>
    );
  }
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
