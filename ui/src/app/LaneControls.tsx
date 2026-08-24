//! Lane-Controls — React-Port von ui/lanecontrols.ts: die "Schnellbedienung"
//! einer Lane (Drum-/Note-Buttons, Macro-Knobs, MIDI-Signal-Buttons). Feuert
//! live, direkt am Playback-Server vorbei, unabhängig von der Baustein-
//! Bibliothek/Engine. Öffnet von der Sequencer-Übersicht per 🎛-Taste.

import { useMemo, useRef, useState, type HTMLAttributes } from "react";
import type { Block, Device, Lane, LaneControl } from "../state";
import { useSend, useStoreValue } from "./store";
import { useNotePicker, noteName } from "./NotePicker";
import { useNumberEditor } from "./useNumberEditor";
import { Button } from "./widgets/Button";
import { Popup } from "./widgets/Popup";
import { TRANSPORT_H } from "./layout";

const TILE_W = 100;
const TILE_H = 76;

// Stable reference for the useSyncExternalStore selector below — see the
// EMPTY_DEVICES comment in Dashboard.tsx.
const EMPTY_DEVICES: Device[] = [];

export interface LaneControlsProps {
  laneId: string;
  onClose: () => void;
}

interface FoundLane {
  lane: Lane;
  device: Device;
}

export function LaneControls({ laneId, onClose }: LaneControlsProps) {
  const devices = useStoreValue((s) => s.project?.devices ?? EMPTY_DEVICES);
  // Derived via useMemo (not directly in the useSyncExternalStore selector)
  // because constructing a fresh `{ lane, device }` object on every
  // getSnapshot call would never satisfy Object.is and spin React into an
  // infinite update loop.
  const found = useMemo<FoundLane | undefined>(() => {
    for (const dev of devices) {
      const lane = dev.lanes.find((l) => l.id === laneId);
      if (lane) return { lane, device: dev };
    }
    return undefined;
  }, [devices, laneId]);
  const [activeToggles, setActiveToggles] = useState<Set<string>>(new Set());
  const [addPickerOpen, setAddPickerOpen] = useState(false);
  const [muteTargetPicker, setMuteTargetPicker] = useState(false);

  return (
    <div style={{ position: "fixed", inset: 0, top: TRANSPORT_H, background: "var(--pal-water-deep)", overflowY: "auto", padding: 16 }}>
      <Button variant="alt" style={{ width: 130, height: 40, fontSize: 17 }} onClick={onClose}>
        ← Back
      </Button>

      {!found ? (
        <div style={{ marginTop: 24, color: "var(--pal-text-dim)", fontSize: 18 }}>Lane no longer exists.</div>
      ) : (
        <>
          <div style={{ margin: "20px 0 4px", fontSize: 24, fontWeight: 700 }}>{found.lane.name}</div>
          <div style={{ fontSize: 13, color: "var(--pal-text-dim)", fontWeight: 600, marginBottom: 20 }}>
            {found.lane.role.toUpperCase()}
          </div>

          <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
            {(found.lane.controls ?? []).map((ctrl) => (
              <ControlTile
                key={ctrl.id}
                ctrl={ctrl}
                laneId={found.lane.id}
                active={activeToggles.has(ctrl.id)}
                onToggleActive={() =>
                  setActiveToggles((prev) => {
                    const next = new Set(prev);
                    if (next.has(ctrl.id)) next.delete(ctrl.id);
                    else next.add(ctrl.id);
                    return next;
                  })
                }
              />
            ))}
            <Button variant="alt" style={{ width: TILE_W, height: TILE_H, fontSize: 30 }} onClick={() => setAddPickerOpen(true)}>
              ＋
            </Button>
          </div>

          {addPickerOpen && (
            <AddControlPicker
              lane={found.lane}
              device={found.device}
              onClose={() => setAddPickerOpen(false)}
              onPickMuteButton={() => {
                setAddPickerOpen(false);
                setMuteTargetPicker(true);
              }}
            />
          )}

          {muteTargetPicker && (
            <MuteTargetPicker lane={found.lane} device={found.device} onClose={() => setMuteTargetPicker(false)} />
          )}
        </>
      )}
    </div>
  );
}

function ControlTile({
  ctrl,
  laneId,
  active,
  onToggleActive,
}: {
  ctrl: LaneControl;
  laneId: string;
  active: boolean;
  onToggleActive: () => void;
}) {
  const send = useSend();
  const [pressed, setPressed] = useState(false);
  const dragRef = useRef<{ startY: number; startValue: number } | null>(null);

  const isMacro = ctrl.kind === "macroKnob";
  const momentary = ctrl.kind === "macroKnob" ? false : ctrl.kind === "drumButton" ? ctrl.action === "trigger" : ctrl.trigger === "momentary";
  const isToggle = ctrl.kind !== "macroKnob" && ctrl.kind !== "drumButton" && ctrl.trigger === "toggle";
  const isActive = isMacro ? false : isToggle ? active : pressed;

  const tileProps: HTMLAttributes<HTMLDivElement> = {};
  if (isMacro) {
    tileProps.onPointerDown = (e) => {
      e.currentTarget.setPointerCapture(e.pointerId);
      dragRef.current = { startY: e.clientY, startValue: ctrl.value ?? 0 };
    };
    tileProps.onPointerMove = (e) => {
      if (!dragRef.current) return;
      const dy = dragRef.current.startY - e.clientY;
      const value = Math.min(127, Math.max(0, Math.round(dragRef.current.startValue + dy * 0.7)));
      send({ t: "laneControl.setValue", laneId, controlId: ctrl.id, value });
    };
    const endDrag = () => {
      dragRef.current = null;
    };
    tileProps.onPointerUp = endDrag;
    tileProps.onPointerCancel = endDrag;
  } else if (momentary) {
    tileProps.onPointerDown = (e) => {
      e.currentTarget.setPointerCapture(e.pointerId);
      setPressed(true);
      send({ t: "laneControl.press", laneId, controlId: ctrl.id });
    };
    const release = () => {
      setPressed(false);
      send({ t: "laneControl.release", laneId, controlId: ctrl.id });
    };
    tileProps.onPointerUp = release;
    tileProps.onPointerCancel = release;
  } else if (isToggle) {
    tileProps.onClick = () => {
      send({ t: active ? "laneControl.release" : "laneControl.press", laneId, controlId: ctrl.id });
      onToggleActive();
    };
  } else {
    tileProps.onClick = () => send({ t: "laneControl.press", laneId, controlId: ctrl.id });
  }

  return (
    <div
      {...tileProps}
      style={{
        width: TILE_W,
        height: TILE_H,
        position: "relative",
        borderRadius: 12,
        background: isActive ? "var(--pal-btn-active)" : "var(--pal-btn)",
        border: "1.5px solid rgba(255, 255, 255, 0.3)",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        cursor: "pointer",
        color: isActive ? "var(--pal-ink)" : "var(--pal-text)",
        touchAction: "none",
      }}
    >
      <span style={{ fontSize: 14, fontWeight: 600 }}>{ctrl.label || ctrl.kind}</span>
      {isMacro && (
        <span style={{ fontSize: 12, marginTop: 6, color: isActive ? "var(--pal-ink)" : "var(--pal-text-dim)" }}>
          {ctrl.value ?? 0}
        </span>
      )}
      <button
        type="button"
        aria-label="Remove"
        onClick={(e) => {
          e.stopPropagation();
          send({ t: "laneControl.remove", laneId, controlId: ctrl.id });
        }}
        style={{
          position: "absolute",
          top: 2,
          right: 2,
          width: 20,
          height: 20,
          borderRadius: "50%",
          background: "var(--pal-danger)",
          color: "var(--pal-white)",
          fontSize: 10,
          fontWeight: 700,
          border: "none",
          cursor: "pointer",
        }}
      >
        ✕
      </button>
    </div>
  );
}

/** Schnell-Anlegen — rollenabhängig (siehe LaneRole → anlegbare Controls in
 *  ARCHITECTURE.md §4a). */
function AddControlPicker({
  lane,
  device,
  onClose,
  onPickMuteButton,
}: {
  lane: Lane;
  device: Device;
  onClose: () => void;
  onPickMuteButton: () => void;
}) {
  const send = useSend();
  const openNotePicker = useNotePicker();
  const numberEdit = useNumberEditor();

  const rows: { text: string; onTap: () => void }[] = [];

  switch (lane.role) {
    case "melody":
    case "chord":
    case "arp":
      rows.push({
        text: "Add note",
        onTap: () => {
          onClose();
          openNotePicker(60, (note) =>
            send({
              t: "laneControl.add",
              laneId: lane.id,
              control: { kind: "note", label: noteName(note), note, velocity: 100, trigger: "momentary" },
            }),
          );
        },
      });
      break;
    case "beat": {
      rows.push({
        text: "Trigger note",
        onTap: () => {
          onClose();
          openNotePicker(36, (note) =>
            send({
              t: "laneControl.add",
              laneId: lane.id,
              control: { kind: "drumButton", label: noteName(note), action: "trigger", note, velocity: 100 },
            }),
          );
        },
      });
      const beatBlocks = (device.blocks ?? []).filter(
        (b: Block) => b.type === "beat" && lane.slots.some((s) => s.blockId === b.id),
      );
      if (beatBlocks.length > 0) {
        rows.push({ text: "Mute button", onTap: onPickMuteButton });
      }
      break;
    }
    case "cc":
      rows.push({
        text: "Macro knob (CC number)",
        onTap: () => {
          onClose();
          numberEdit(74, 0, 127, (ccNumber) =>
            send({
              t: "laneControl.add",
              laneId: lane.id,
              control: { kind: "macroKnob", label: `CC${ccNumber}`, ccNumber, min: 0, max: 127, value: 0 },
            }),
          );
        },
      });
      break;
    case "programChange":
      rows.push({
        text: "Program button",
        onTap: () => {
          onClose();
          numberEdit(0, 0, 127, (program) =>
            send({
              t: "laneControl.add",
              laneId: lane.id,
              control: {
                kind: "midiSignal",
                label: `PC${program}`,
                message: { atStep: 0, kind: "programChange", data1: program },
                trigger: "oneShot",
              },
            }),
          );
        },
      });
      break;
    case "patternShift":
      rows.push({
        text: "Pattern button (CC number)",
        onTap: () => {
          onClose();
          numberEdit(0, 0, 127, (cc) =>
            send({
              t: "laneControl.add",
              laneId: lane.id,
              control: {
                kind: "midiSignal",
                label: `CC${cc}`,
                message: { atStep: 0, kind: "cc", data1: cc, data2: 127 },
                trigger: "oneShot",
              },
            }),
          );
        },
      });
      break;
  }

  return (
    <Popup onClose={onClose}>
      <div className="popup-title">Add control</div>
      {rows.map((r) => (
        <Button key={r.text} className="popup-row" onClick={r.onTap}>
          {r.text}
        </Button>
      ))}
    </Popup>
  );
}

function MuteTargetPicker({ lane, device, onClose }: { lane: Lane; device: Device; onClose: () => void }) {
  const send = useSend();
  const beatBlocks = (device.blocks ?? []).filter(
    (b: Block) => b.type === "beat" && lane.slots.some((s) => s.blockId === b.id),
  );

  return (
    <Popup onClose={onClose}>
      <div className="popup-title">Choose beat line</div>
      {beatBlocks.map((b) =>
        (b.lines ?? []).map((line) => (
          <Button
            key={line.id}
            className="popup-row"
            onClick={() => {
              onClose();
              send({
                t: "laneControl.add",
                laneId: lane.id,
                control: {
                  kind: "drumButton",
                  label: line.name.slice(0, 8),
                  action: "muteToggle",
                  note: line.note,
                  velocity: 100,
                  targetBlockId: b.id,
                  targetLineId: line.id,
                },
              });
            }}
          >
            {b.name} / {line.name}
          </Button>
        )),
      )}
    </Popup>
  );
}
