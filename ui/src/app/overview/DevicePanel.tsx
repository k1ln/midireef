//! Device-Panel — React-Port des devicePanel() aus ui/overview.ts. Header
//! reiht sich per Flexbox/Wrap statt hart von rechts positionierter Buttons
//! (`w - 344`, `w - 560`, …), reflowt also auch auf schmalen Screens sauber.

import type { Device } from "../../state";
import { useSend } from "../store";
import { useTouchKeyboard } from "../TouchKeyboard";
import { Button } from "../widgets/Button";
import { LaneRow } from "./LaneRow";

export interface DevicePanelProps {
  dev: Device;
  onOpenLibrary: () => void;
  onOpenRolePicker: () => void;
  onOpenAddBlock: (laneId: string) => void;
  onOpenBlockMenu: (laneId: string, slotId: string) => void;
  onOpenLaneControls: (laneId: string) => void;
  onOpenCcTarget: (laneId: string) => void;
}

export function DevicePanel({
  dev,
  onOpenLibrary,
  onOpenRolePicker,
  onOpenAddBlock,
  onOpenBlockMenu,
  onOpenLaneControls,
  onOpenCcTarget,
}: DevicePanelProps) {
  const send = useSend();
  const openKeyboard = useTouchKeyboard();
  const transpose = dev.transpose ?? 0;

  return (
    <div className="panel" style={{ padding: 16 }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12, marginBottom: 12 }}>
        <div style={{ minWidth: 160 }}>
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
          <div style={{ fontSize: 13, color: "var(--pal-text-dim)" }}>
            {dev.midiOutPort ? `→ ${dev.midiOutPort}` : "→ no MIDI port"}
          </div>
        </div>

        {/* Kanal — tippen schaltet zum nächsten Kanal (1–16) weiter. */}
        <Button
          style={{ width: 74, height: 40, fontSize: 16 }}
          onClick={() => send({ t: "device.setChannel", deviceId: dev.id, channel: (dev.channel % 16) + 1 })}
        >
          Ch {dev.channel}
        </Button>

        <Button variant="alt" style={{ width: 44, height: 40, fontSize: 18 }} onClick={onOpenLibrary}>
          📚
        </Button>

        {/* Clock — schaltet, ob dieses Device MIDI-Clock/Start/Stop empfängt
            (z.B. aus, wenn ein Synth ohne Clock-Sync unnötig Ticks bekäme). */}
        <Button
          variant={dev.sendClock ? "active" : "default"}
          style={{ width: 92, height: 40, fontSize: 14 }}
          onClick={() => send({ t: "device.setSendClock", deviceId: dev.id, sendClock: !dev.sendClock })}
        >
          Clock {dev.sendClock ? "On" : "Off"}
        </Button>

        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Button
            style={{ width: 28, height: 40, fontSize: 20 }}
            onClick={() => send({ t: "device.setTranspose", deviceId: dev.id, transpose: transpose - 1 })}
          >
            –
          </Button>
          <span style={{ fontSize: 13, color: "var(--pal-text-dim)", fontWeight: 600, minWidth: 40, textAlign: "center" }}>
            T {transpose > 0 ? "+" : ""}
            {transpose}
          </span>
          <Button
            style={{ width: 28, height: 40, fontSize: 20 }}
            onClick={() => send({ t: "device.setTranspose", deviceId: dev.id, transpose: transpose + 1 })}
          >
            +
          </Button>
        </div>

        <Button style={{ width: 110, height: 40, fontSize: 18 }} onClick={onOpenRolePicker}>
          ＋ Lane
        </Button>

        <Button
          variant="danger"
          style={{ width: 44, height: 40, fontSize: 22, marginLeft: "auto" }}
          onClick={() => send({ t: "device.delete", deviceId: dev.id })}
        >
          ✕
        </Button>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {dev.lanes.map((lane) => (
          <LaneRow
            key={lane.id}
            lane={lane}
            dev={dev}
            onOpenAddBlock={() => onOpenAddBlock(lane.id)}
            onOpenBlockMenu={(slotId) => onOpenBlockMenu(lane.id, slotId)}
            onOpenLaneControls={() => onOpenLaneControls(lane.id)}
            onOpenCcTarget={() => onOpenCcTarget(lane.id)}
          />
        ))}
      </div>
    </div>
  );
}
