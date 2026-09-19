//! Flat-Übersicht — alle Lanes aller Geräte auf einmal, dicht gepackt statt
//! als eine Zeile pro Lane. Jedes Gerät bekommt eine eigene umrandete Gruppen-
//! Box (Rahmenfarbe = Gerätefarbe) mit einem schmalen, senkrechten Namens-
//! Reiter links — so bleibt sichtbar, welche Lanes zusammengehören, auch wenn
//! eine Gruppe beim Umbruch mehrzeilig wird. Innerhalb einer Box packen sich
//! die Lanes des Geräts nebeneinander, solange Platz ist, und brechen sonst
//! ganz normal um (flex-wrap); reicht die Breite nicht mehr für die ganze
//! Box in der aktuellen Zeile, rutscht die komplette Box in die nächste.

import type { Block, Device, Lane, Slot } from "../../state";
import { useSend } from "../store";
import { SlotTile } from "./SlotTile";

export interface FlatOverviewProps {
  devices: Device[];
  blocks: Block[];
  /** "row" = Geräte-Boxen packen sich nebeneinander und brechen nach unten um
   *  (Standard). "column" = reine senkrechte Liste, eine Box pro Zeile —
   *  s. „Sequencer 'All lanes' view" in ProjectSettings.tsx. */
  direction: "row" | "column";
  selectedSlotId: string | null;
  onSelectSlot: (laneId: string, slotId: string) => void;
  onOpenBlock: (blockId: string) => void;
  onOpenLaneSettings: (laneId: string) => void;
  onOpenDeviceSettings: (deviceId: string) => void;
  onOpenAddBlock: (laneId: string, deviceId: string) => void;
}

export function FlatOverview({
  devices,
  blocks,
  direction,
  selectedSlotId,
  onSelectSlot,
  onOpenBlock,
  onOpenLaneSettings,
  onOpenDeviceSettings,
  onOpenAddBlock,
}: FlatOverviewProps) {
  return (
    <div className={`overview-flat overview-flat-${direction}`}>
      {devices.map((dev) => (
        <div
          key={dev.id}
          className="flat-device-group"
          style={{ borderColor: dev.color || "var(--pal-text-dim)", opacity: dev.muted ? 0.5 : 1 }}
        >
          <div className="overview-name-wrap device">
            <button
              type="button"
              className="overview-name-btn device vertical"
              title="Device settings"
              onClick={() => onOpenDeviceSettings(dev.id)}
            >
              {dev.name}
            </button>
          </div>
          <div className="flat-device-lanes">
            {dev.lanes.map((lane) => (
              <FlatLaneRow
                key={lane.id}
                dev={dev}
                lane={lane}
                blocks={blocks}
                selectedSlotId={selectedSlotId}
                onSelectSlot={(slotId) => onSelectSlot(lane.id, slotId)}
                onOpenBlock={onOpenBlock}
                onOpenSettings={() => onOpenLaneSettings(lane.id)}
                onOpenAddBlock={() => onOpenAddBlock(lane.id, dev.id)}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

interface FlatLaneRowProps {
  dev: Device;
  lane: Lane;
  blocks: Block[];
  selectedSlotId: string | null;
  onSelectSlot: (slotId: string) => void;
  onOpenBlock: (blockId: string) => void;
  onOpenSettings: () => void;
  onOpenAddBlock: () => void;
}

function FlatLaneRow({
  dev,
  lane,
  blocks,
  selectedSlotId,
  onSelectSlot,
  onOpenBlock,
  onOpenSettings,
  onOpenAddBlock,
}: FlatLaneRowProps) {
  const send = useSend();
  const slots: Slot[] = lane.slots ?? [];

  return (
    <div className="flat-lane-row" style={{ opacity: lane.enabled ? 1 : 0.5 }}>
      <button
        type="button"
        className={`lane-run${lane.enabled ? " on" : ""}`}
        title={lane.enabled ? "Stop this lane" : "Start this lane"}
        onClick={() => send({ t: "lane.setEnabled", laneId: lane.id, enabled: !lane.enabled })}
      >
        {lane.enabled ? "■" : "▶"}
      </button>

      <button
        type="button"
        className="flat-lane-chip"
        style={{ background: lane.color || "var(--pal-text-dim)" }}
        title={`${dev.name} · ${lane.name}`}
        aria-label={`${dev.name} · ${lane.name} — settings`}
        onClick={onOpenSettings}
      />

      <div className="lane-slots">
        {slots.map((slot) => {
          const blk = blocks.find((b) => b.id === slot.blockId);
          return (
            <SlotTile
              key={slot.id}
              lane={lane}
              slot={slot}
              blk={blk}
              locked={false}
              selected={slot.id === selectedSlotId}
              onSelect={() => onSelectSlot(slot.id)}
              onOpenBlock={onOpenBlock}
            />
          );
        })}
        <button type="button" className="slot-tile slot-add" onClick={onOpenAddBlock} aria-label="Add block">
          ＋
        </button>
      </div>
    </div>
  );
}
