//! Lane-Zeile — React-Port des laneRow() aus ui/overview.ts. Slot-Kacheln
//! fließen per Flexbox/Wrap statt eines hart geschnittenen `tileMaxX` —
//! Lanes mit vielen Bausteinen wachsen jetzt einfach in die Höhe statt
//! Kacheln über einer festen Anzahl stillschweigend zu verstecken.

import type { Device, Lane } from "../../state";
import { useSend } from "../store";
import { useTouchKeyboard } from "../TouchKeyboard";
import { Button } from "../widgets/Button";
import { PillToggle } from "../widgets/PillToggle";
import { SlotTile } from "./SlotTile";
import { roleLabel } from "./popups";

export interface LaneRowProps {
  lane: Lane;
  dev: Device;
  onOpenAddBlock: () => void;
  onOpenBlockMenu: (slotId: string) => void;
  onOpenLaneControls: () => void;
}

export function LaneRow({ lane, dev, onOpenAddBlock, onOpenBlockMenu, onOpenLaneControls }: LaneRowProps) {
  const send = useSend();
  const openKeyboard = useTouchKeyboard();

  return (
    <div
      className="panel-deep"
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 12,
        padding: 8,
        opacity: lane.enabled ? 1 : 0.5,
        borderLeft: `8px solid ${lane.color || "var(--pal-white)"}`,
      }}
    >
      <div style={{ minWidth: 90 }}>
        <div
          style={{ fontSize: 20, fontWeight: 600, cursor: "pointer" }}
          onClick={() =>
            openKeyboard(lane.name, 24, (v) => {
              if (v) send({ t: "lane.rename", laneId: lane.id, name: v });
            })
          }
        >
          {lane.name}
        </div>
        <div
          style={{
            display: "inline-block",
            marginTop: 8,
            padding: "2px 8px",
            borderRadius: 8,
            background: "rgba(255, 255, 255, 0.12)",
            fontSize: 12,
            fontWeight: 600,
          }}
        >
          {roleLabel(lane.role)}
        </div>
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 10, flex: 1 }}>
        {(lane.slots ?? []).map((slot) => {
          const blk = dev.blocks?.find((b) => b.id === slot.blockId);
          return (
            <SlotTile
              key={slot.id}
              lane={lane}
              slot={slot}
              blk={blk}
              onLongPress={() => onOpenBlockMenu(slot.id)}
            />
          );
        })}
        <Button variant="alt" style={{ width: 34, height: 112, fontSize: 20 }} onClick={onOpenAddBlock}>
          ＋
        </Button>
      </div>

      <div style={{ display: "flex", gap: 8, alignItems: "flex-start", marginLeft: "auto" }}>
        <Button variant="alt" style={{ width: 40, height: 40, fontSize: 18 }} onClick={onOpenLaneControls}>
          🎛
        </Button>
        <PillToggle
          letter="E"
          active={lane.enabled}
          onToggle={() => send({ t: "lane.setEnabled", laneId: lane.id, enabled: !lane.enabled })}
        />
        <PillToggle
          letter="M"
          active={lane.muted}
          onToggle={() => send({ t: "lane.setMuted", laneId: lane.id, muted: !lane.muted })}
        />
        <PillToggle
          letter="S"
          active={lane.solo}
          onToggle={() => send({ t: "lane.setSolo", laneId: lane.id, solo: !lane.solo })}
        />
        <Button
          variant="danger"
          style={{ width: 40, height: 40, fontSize: 18 }}
          onClick={() => send({ t: "lane.delete", laneId: lane.id })}
        >
          ✕
        </Button>
      </div>
    </div>
  );
}
