//! Dashboard-Popups — React-Port der openContextMenu()/openDevicePicker()/
//! openKindPicker()-Methoden aus ui/mainscreen.ts. Context-Menü und Device-
//! Picker sind am Tap-Punkt verankert (nicht zentriert) — daher ein eigener
//! AnchoredPopup statt des generischen zentrierten <Popup>.

import { useState, type ReactNode } from "react";
import type { Block, Device, Lane } from "../../state";
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

/** Flat (device, lane) picker — used both for "Record into lane …" (melody
 *  only, the default) and for "＋ Lane switch" on the Dashboard (any lane).
 *  Flat list because the link isn't scoped to one device the way "Device …" is. */
export function LanePickerPopup({
  x,
  y,
  devices,
  onClose,
  onPick,
  filter = (l) => l.role === "melody",
  prompt = "Record into which melody lane?",
  emptyText = "No melody lane set up yet",
}: {
  x: number;
  y: number;
  devices: Device[];
  onClose: () => void;
  onPick: (lane: Lane) => void;
  filter?: (lane: Lane) => boolean;
  prompt?: string;
  emptyText?: string;
}) {
  const lanes = devices.flatMap((d) => (d.lanes ?? []).filter(filter).map((l) => ({ dev: d, lane: l })));
  return (
    <AnchoredPopup x={x} y={y} width={260} onClose={onClose}>
      <div style={{ fontSize: 13, color: "var(--pal-text-dim)", marginBottom: 8 }}>{prompt}</div>
      {lanes.length === 0 ? (
        <div style={{ color: "var(--pal-text-dim)", fontSize: 15 }}>{emptyText}</div>
      ) : (
        lanes.map(({ dev, lane }) => (
          <Button key={lane.id} className="popup-row" style={{ height: 40, marginBottom: 8, flexDirection: "column", alignItems: "flex-start", paddingLeft: 12 }} onClick={() => onPick(lane)}>
            <span style={{ fontWeight: 700 }}>{lane.name}</span>
            <span style={{ fontSize: 11, color: "var(--pal-text-dim)" }}>{dev.name}</span>
          </Button>
        ))
      )}
    </AnchoredPopup>
  );
}

/** Bindet die Note eines Dashboard-Controls an einen Lane-Slot — dann löst
 *  eine passende eingehende Note diesen Slot aus (z.B. einen gespeicherten
 *  Filter-Effekt in einer CC-Lane). Flache Liste (Gerät › Lane › Slot). */
export function TriggerPickerPopup({
  x,
  y,
  devices,
  blocks,
  active,
  onClose,
  onPick,
  onClear,
}: {
  x: number;
  y: number;
  devices: Device[];
  blocks: Block[];
  active?: { laneId: string; slotId: string; setsKeytrack?: boolean; starts?: boolean };
  onClose: () => void;
  onPick: (laneId: string, slotId: string, setsKeytrack: boolean, starts: boolean) => void;
  onClear: () => void;
}) {
  const blockName = (id?: string) => {
    const b = blocks.find((x) => x.id === id);
    if (!b) return "?";
    const slot = b.slot ? `${b.slot.row}-${b.slot.col}` : "?";
    return `${slot} ${b.name || ""}`.trim();
  };
  const rows = devices.flatMap((d) =>
    (d.lanes ?? []).flatMap((l) => (l.slots ?? []).map((s) => ({ dev: d, lane: l, slot: s }))),
  );
  // Zwei unabhängig schaltbare Wirkungen derselben Note (Gegenstück zu
  // Lane.keytrackSourceStarts fürs melodiebasierte Pendant) — Default beide
  // an, wie bisher fest verdrahtet.
  const setsKeytrack = active?.setsKeytrack ?? true;
  const starts = active?.starts ?? true;
  return (
    <AnchoredPopup x={x} y={y} width={280} onClose={onClose}>
      <div style={{ fontSize: 13, color: "var(--pal-text-dim)", marginBottom: 8 }}>
        Fire which lane slot on this note?
      </div>
      {rows.length === 0 ? (
        <div style={{ color: "var(--pal-text-dim)", fontSize: 15 }}>No lane slots yet.</div>
      ) : (
        rows.map(({ dev, lane, slot }) => (
          <Button
            key={slot.id}
            variant={active?.slotId === slot.id ? "active" : "default"}
            className="popup-row"
            style={{ height: 44, marginBottom: 6, flexDirection: "column", alignItems: "flex-start", paddingLeft: 12 }}
            onClick={() => onPick(lane.id, slot.id, setsKeytrack, starts)}
          >
            <span style={{ fontWeight: 700 }}>
              {lane.name} · {blockName(slot.blockId)}
            </span>
            <span style={{ fontSize: 11, color: "var(--pal-text-dim)" }}>{dev.name}</span>
          </Button>
        ))
      )}
      {active && (
        <>
          <Button
            variant={starts ? "active" : "default"}
            className="popup-row"
            style={{ height: 40, marginBottom: 6, flexDirection: "column", alignItems: "flex-start", paddingLeft: 12 }}
            onClick={() => onPick(active.laneId, active.slotId, setsKeytrack, !starts)}
          >
            <span style={{ fontWeight: 700 }}>{starts ? "✓ Starts / holds the slot" : "Starts / holds the slot"}</span>
            <span style={{ fontSize: 11, color: "var(--pal-text-dim)" }}>
              {starts ? "Note-On presses it, Note-Off releases a hold" : "Off — this note won't press/release it"}
            </span>
          </Button>
          <Button
            variant={setsKeytrack ? "active" : "default"}
            className="popup-row"
            style={{ height: 40, marginBottom: 6, flexDirection: "column", alignItems: "flex-start", paddingLeft: 12 }}
            onClick={() => onPick(active.laneId, active.slotId, !setsKeytrack, starts)}
          >
            <span style={{ fontWeight: 700 }}>{setsKeytrack ? "✓ Sets key-track" : "Sets key-track"}</span>
            <span style={{ fontSize: 11, color: "var(--pal-text-dim)" }}>
              {setsKeytrack ? "Drives a CC block's LFO rate-key-track" : "Off — this note won't drive key-track"}
            </span>
          </Button>
          <Button variant="danger" className="popup-row" onClick={onClear}>
            Clear binding
          </Button>
        </>
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

export interface SteerTarget {
  id: string;
  deviceId: string;
  cc: number;
  channel?: number;
  min?: number;
  max?: number;
}

/**
 * Fan-out-Ziel eines Knobs anlegen/bearbeiten: ein Encoder fährt damit den
 * Cutoff (o.ä.) mehrerer Synths zugleich — jedes Ziel mit eigener CC-Nummer
 * und optional eigenem Wertebereich (0–127-Knob → [min, max], invertierbar).
 * `profileCcsFor` liefert die benannten CCs des Geräte-Profils (leer ⇒ nur
 * Rohnummer). Ohne `target` = Anlegen (Button „Add"), mit `target` =
 * Bearbeiten (Änderungen wirken sofort, plus „Remove").
 */
export function SteerTargetPopup({
  devices,
  profileCcsFor,
  target,
  onAdd,
  onUpdate,
  onRemove,
  onClose,
}: {
  devices: Device[];
  profileCcsFor: (deviceId: string) => { number: number; name: string }[];
  target?: SteerTarget;
  onAdd: (deviceId: string, cc: number) => void;
  onUpdate: (patch: { deviceId?: string; cc?: number; channel?: number; min?: number; max?: number }) => void;
  onRemove: () => void;
  onClose: () => void;
}) {
  const editing = !!target;
  const [deviceId, setDeviceId] = useState(target?.deviceId ?? devices[0]?.id ?? "");
  const [cc, setCc] = useState(target?.cc ?? 74);
  const [min, setMin] = useState(target?.min ?? 0);
  const [max, setMax] = useState(target?.max ?? 127);
  const profileCcs = deviceId ? profileCcsFor(deviceId) : [];

  const pickDevice = (d: string) => {
    setDeviceId(d);
    if (editing) onUpdate({ deviceId: d });
  };
  const pickCc = (n: number) => {
    const v = Math.max(0, Math.min(127, n | 0));
    setCc(v);
    if (editing) onUpdate({ cc: v });
  };

  return (
    <Popup onClose={onClose} boxStyle={{ width: 380 }}>
      <div className="popup-title" style={{ marginBottom: 4 }}>
        {editing ? "Edit synth target" : "Steer another synth"}
      </div>
      <div style={{ fontSize: 13, color: "var(--pal-text-dim)", marginBottom: 14 }}>
        The knob's value also drives this synth's CC. Add one row per synth — each keeps its own CC number and range.
      </div>

      <div style={{ fontSize: 12, color: "var(--pal-text-dim)", marginBottom: 6 }}>Synth</div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 14 }}>
        {devices.length === 0 ? (
          <div style={{ color: "var(--pal-text-dim)", fontSize: 14 }}>No devices yet — add one in the sequencer.</div>
        ) : (
          devices.map((d) => (
            <Button
              key={d.id}
              variant={deviceId === d.id ? "active" : "default"}
              style={{ height: 36, flex: "1 1 45%", fontSize: 13 }}
              onClick={() => pickDevice(d.id)}
            >
              {d.name}
            </Button>
          ))
        )}
      </div>

      <div style={{ fontSize: 12, color: "var(--pal-text-dim)", marginBottom: 6 }}>Target CC</div>
      {profileCcs.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
          {profileCcs.map((p) => (
            <Button
              key={p.number}
              variant={cc === p.number ? "active" : "default"}
              style={{ height: 32, fontSize: 12 }}
              onClick={() => pickCc(p.number)}
            >
              {p.name} · {p.number}
            </Button>
          ))}
        </div>
      )}
      <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, marginBottom: 14 }}>
        Raw CC
        <input
          type="number"
          min={0}
          max={127}
          value={cc}
          onChange={(e) => pickCc(Number(e.target.value))}
          style={{ width: 72, height: 32, fontSize: 14, textAlign: "center" }}
        />
      </label>

      {editing && (
        <>
          <div style={{ fontSize: 12, color: "var(--pal-text-dim)", marginBottom: 6 }}>
            Range — knob 0…127 maps to {min}…{max} {min > max ? "(inverted)" : ""}
          </div>
          {(["min", "max"] as const).map((k) => (
            <div key={k} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
              <span style={{ width: 30, fontSize: 12, color: "var(--pal-text-dim)" }}>{k}</span>
              <input
                className="dock-range"
                type="range"
                min={0}
                max={127}
                value={k === "min" ? min : max}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  if (k === "min") {
                    setMin(v);
                    onUpdate({ min: v });
                  } else {
                    setMax(v);
                    onUpdate({ max: v });
                  }
                }}
              />
              <span style={{ width: 28, fontSize: 12, textAlign: "right" }}>{k === "min" ? min : max}</span>
            </div>
          ))}
        </>
      )}

      {editing ? (
        <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
          <Button variant="danger" style={{ flex: 1, height: 44 }} onClick={onRemove}>
            Remove
          </Button>
          <Button variant="alt" style={{ flex: 1, height: 44 }} onClick={onClose}>
            Done
          </Button>
        </div>
      ) : (
        <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
          <Button
            variant="active"
            style={{ flex: 1, height: 44 }}
            onClick={() => deviceId && onAdd(deviceId, cc)}
          >
            Add target
          </Button>
          <Button variant="alt" style={{ flex: 1, height: 44 }} onClick={onClose}>
            Cancel
          </Button>
        </div>
      )}
    </Popup>
  );
}
