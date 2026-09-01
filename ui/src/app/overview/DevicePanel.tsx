//! Device-Panel — React-Port des devicePanel() aus ui/overview.ts. Header
//! reiht sich per Flexbox/Wrap statt hart von rechts positionierter Buttons
//! (`w - 344`, `w - 560`, …), reflowt also auch auf schmalen Screens sauber.
//!
//! Das Panel lässt sich über das Chevron einklappen — dann bleibt nur die
//! Kopfzeile mit einer kurzen Zusammenfassung stehen. Der Zustand ist eine
//! reine Ansichts-Vorliebe (localStorage), kein Projekt-Feld.

import { useState } from "react";
import type { Device } from "../../state";
import { useSend } from "../store";
import { useTouchKeyboard } from "../TouchKeyboard";
import { useLocalPref } from "../useLocalPref";
import { Button } from "../widgets/Button";
import { LaneRow } from "./LaneRow";

export interface DevicePanelProps {
  dev: Device;
  onOpenRolePicker: () => void;
  onOpenAddBlock: (laneId: string) => void;
  onSelectSlot: (laneId: string, slotId: string) => void;
  selectedSlotId: string | null;
  onOpenLaneControls: (laneId: string) => void;
  onOpenCcTarget: (laneId: string) => void;
}

export function DevicePanel({
  dev,
  onOpenRolePicker,
  onOpenAddBlock,
  onSelectSlot,
  selectedSlotId,
  onOpenLaneControls,
  onOpenCcTarget,
}: DevicePanelProps) {
  const send = useSend();
  const openKeyboard = useTouchKeyboard();
  const [collapsedPref, setCollapsedPref] = useLocalPref<"0" | "1">(`device.collapsed.${dev.id}`, "0");
  const collapsed = collapsedPref === "1";
  const [confirmDelete, setConfirmDelete] = useState(false);
  const laneCount = dev.lanes.length;

  return (
    <div className="panel" style={{ padding: 16 }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12, marginBottom: collapsed ? 0 : 12 }}>
        <Button
          variant="alt"
          style={{ width: 34, height: 34, fontSize: 16, flex: "0 0 auto" }}
          title={collapsed ? "Expand device" : "Collapse device"}
          onClick={() => setCollapsedPref(collapsed ? "0" : "1")}
        >
          {collapsed ? "▸" : "▾"}
        </Button>

        <div style={{ minWidth: 120 }}>
          <div
            style={{ fontSize: 26, fontWeight: 700, cursor: "pointer" }}
            onClick={() =>
              openKeyboard(dev.name, 24, (v) => {
                if (v) send({ t: "device.rename", deviceId: dev.id, name: v });
              })
            }
          >
            {dev.name}
          </div>
          {!dev.midiOutPort && (
            <div style={{ fontSize: 12, color: "var(--pal-warn, #f6ad55)", fontWeight: 600 }}>no MIDI port</div>
          )}
        </div>

        {collapsed && (
          <span style={{ fontSize: 13, color: "var(--pal-text-dim)", fontWeight: 600 }}>
            · {laneCount} lane{laneCount === 1 ? "" : "s"}
          </span>
        )}

        {!collapsed && (
          <>
            {/* Clock — schaltet, ob dieses Device MIDI-Clock/Start/Stop empfängt
                (z.B. aus, wenn ein Synth ohne Clock-Sync unnötig Ticks bekäme). */}
            <Button
              variant={dev.sendClock ? "active" : "default"}
              style={{ width: 92, height: 40, fontSize: 14 }}
              onClick={() => send({ t: "device.setSendClock", deviceId: dev.id, sendClock: !dev.sendClock })}
            >
              Clock {dev.sendClock ? "On" : "Off"}
            </Button>

            <Button style={{ width: 110, height: 40, fontSize: 18 }} onClick={onOpenRolePicker}>
              ＋ Lane
            </Button>
          </>
        )}

        {confirmDelete ? (
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginLeft: "auto" }}>
            <span style={{ fontSize: 13, color: "var(--pal-text-dim)", fontWeight: 600 }}>Delete device?</span>
            <Button
              variant="danger"
              style={{ height: 40, padding: "0 14px", fontSize: 15 }}
              onClick={() => send({ t: "device.delete", deviceId: dev.id })}
            >
              Delete
            </Button>
            <Button style={{ height: 40, padding: "0 14px", fontSize: 15 }} onClick={() => setConfirmDelete(false)}>
              Cancel
            </Button>
          </div>
        ) : (
          <Button
            variant="danger"
            style={{ width: 44, height: 40, fontSize: 22, marginLeft: "auto" }}
            onClick={() => setConfirmDelete(true)}
          >
            ✕
          </Button>
        )}
      </div>

      {!collapsed && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {dev.lanes.map((lane) => (
            <LaneRow
              key={lane.id}
              lane={lane}
              dev={dev}
              onOpenAddBlock={() => onOpenAddBlock(lane.id)}
              onSelectSlot={(slotId) => onSelectSlot(lane.id, slotId)}
              selectedSlotId={selectedSlotId}
              onOpenLaneControls={() => onOpenLaneControls(lane.id)}
              onOpenCcTarget={() => onOpenCcTarget(lane.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
