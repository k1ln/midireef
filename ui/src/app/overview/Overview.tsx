//! Sequencer-Overview — React-Port von ui/overview.ts. Scrolling ist jetzt
//! native `overflow-y: auto` statt enableDragScroll()'s hand-rolled Pixi
//! drag-pan (kein Threshold-Hack mehr nötig — derselbe Klassenbug wie beim
//! Note-Picker, hier von vornherein nicht vorhanden).

import { useState } from "react";
import type { Device } from "../../state";
import { useStoreValue } from "../store";
import { Button } from "../widgets/Button";
import { TRANSPORT_H } from "../layout";
import { DevicePanel } from "./DevicePanel";
import {
  PortPickerPopup,
  RolePickerPopup,
  AddBlockPickerPopup,
  SwapPickerPopup,
  BlockContextMenuPopup,
} from "./popups";

// Stable reference so the useSyncExternalStore selector below returns the
// same identity across calls when there's no project yet — a fresh `[]`
// each call would never satisfy Object.is and spin React into an infinite
// update loop.
const EMPTY_DEVICES: Device[] = [];

type PopupState =
  | { kind: "port" }
  | { kind: "role"; deviceId: string }
  | { kind: "addBlock"; laneId: string; deviceId: string }
  | { kind: "swap"; laneId: string; deviceId: string; slotId: string; currentBlockId: string }
  | { kind: "blockMenu"; laneId: string; deviceId: string; slotId: string };

export interface OverviewProps {
  onOpenBlock: (blockId: string) => void;
  onOpenLaneControls: (laneId: string) => void;
  onOpenLibrary: (deviceId: string) => void;
}

export function Overview({ onOpenBlock, onOpenLaneControls, onOpenLibrary }: OverviewProps) {
  const devices = useStoreValue((s) => s.project?.devices ?? EMPTY_DEVICES);
  const ports = useStoreValue((s) => s.midiOutputs);
  const [popup, setPopup] = useState<PopupState | null>(null);
  const closePopup = () => setPopup(null);

  const findDevice = (id: string): Device | undefined => devices.find((d) => d.id === id);

  return (
    <div
      style={{
        position: "fixed",
        top: TRANSPORT_H,
        left: 0,
        right: 0,
        bottom: 0,
        overflowY: "auto",
        padding: 16,
        display: "flex",
        flexDirection: "column",
        gap: 16,
      }}
    >
      {ports.length > 0 ? (
        <Button
          variant="alt"
          style={{ width: 200, height: 48, fontSize: 22, alignSelf: "flex-start" }}
          onClick={() => setPopup({ kind: "port" })}
        >
          ＋ Device
        </Button>
      ) : (
        <div style={{ color: "var(--pal-text-dim)", fontSize: 18, fontWeight: 600 }}>
          No MIDI devices found — connect a device.
        </div>
      )}

      {devices.length === 0 ? (
        <div style={{ color: "var(--pal-text-dim)", fontSize: 18 }}>
          {ports.length > 0 ? "No devices yet — tap “＋ Device” above." : ""}
        </div>
      ) : (
        devices.map((dev) => (
          <DevicePanel
            key={dev.id}
            dev={dev}
            onOpenLibrary={() => onOpenLibrary(dev.id)}
            onOpenRolePicker={() => setPopup({ kind: "role", deviceId: dev.id })}
            onOpenAddBlock={(laneId) => setPopup({ kind: "addBlock", laneId, deviceId: dev.id })}
            onOpenBlockMenu={(laneId, slotId) => setPopup({ kind: "blockMenu", laneId, deviceId: dev.id, slotId })}
            onOpenLaneControls={onOpenLaneControls}
          />
        ))
      )}

      {popup?.kind === "port" && <PortPickerPopup onClose={closePopup} />}

      {popup?.kind === "role" && <RolePickerPopup deviceId={popup.deviceId} onClose={closePopup} />}

      {popup?.kind === "addBlock" &&
        (() => {
          const dev = findDevice(popup.deviceId);
          const lane = dev?.lanes.find((l) => l.id === popup.laneId);
          return dev && lane ? <AddBlockPickerPopup lane={lane} dev={dev} onClose={closePopup} /> : null;
        })()}

      {popup?.kind === "swap" &&
        (() => {
          const dev = findDevice(popup.deviceId);
          const lane = dev?.lanes.find((l) => l.id === popup.laneId);
          return dev && lane ? (
            <SwapPickerPopup
              lane={lane}
              dev={dev}
              slotId={popup.slotId}
              currentBlockId={popup.currentBlockId}
              onClose={closePopup}
            />
          ) : null;
        })()}

      {popup?.kind === "blockMenu" &&
        (() => {
          const dev = findDevice(popup.deviceId);
          const lane = dev?.lanes.find((l) => l.id === popup.laneId);
          if (!dev || !lane) return null;
          const slot = lane.slots.find((s) => s.id === popup.slotId);
          const blk = slot ? dev.blocks?.find((b) => b.id === slot.blockId) : undefined;
          const menuState = popup;
          return (
            <BlockContextMenuPopup
              lane={lane}
              slotId={menuState.slotId}
              blk={blk}
              onClose={closePopup}
              onOpenBlock={onOpenBlock}
              onSwap={() => {
                if (blk) {
                  setPopup({
                    kind: "swap",
                    laneId: menuState.laneId,
                    deviceId: menuState.deviceId,
                    slotId: menuState.slotId,
                    currentBlockId: blk.id,
                  });
                }
              }}
            />
          );
        })()}
    </div>
  );
}
