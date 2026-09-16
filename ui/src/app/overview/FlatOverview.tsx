//! Flat-Übersicht — alle Lanes aller Geräte auf einmal, dicht gepackt statt
//! als eine Zeile pro Lane. Lane-/Geräte-NAME steht hier nirgends mehr (der
//! ist im Lane-Einstellungsmenü zu sehen, ein Tipp auf den Farbpunkt öffnet
//! es) — an seiner Stelle ein Farbpunkt: Ring = Gerätefarbe, Füllung =
//! Lanefarbe. Lanes desselben Geräts bleiben in Reihenfolge benachbart und
//! packen sich nebeneinander, solange Platz ist; reicht die Breite nicht,
//! bricht die Zeile ganz normal um (flex-wrap) — vor eine neue Geräte-Gruppe
//! setzt sich zusätzlich eine größere Lücke, damit die Zugehörigkeit auch
//! ohne Text erkennbar bleibt.

import type { Block, Device, Lane, Slot } from "../../state";
import { useSend } from "../store";
import { SlotTile } from "./SlotTile";

export interface FlatOverviewProps {
  devices: Device[];
  blocks: Block[];
  /** "row" = Lanes packen sich nebeneinander und brechen nach unten um
   *  (Standard). "column" = reine senkrechte Liste, eine Lane pro Zeile —
   *  s. „Sequencer 'All lanes' view" in ProjectSettings.tsx. */
  direction: "row" | "column";
  selectedSlotId: string | null;
  onSelectSlot: (laneId: string, slotId: string) => void;
  onOpenBlock: (blockId: string) => void;
  onOpenLaneSettings: (laneId: string) => void;
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
  onOpenAddBlock,
}: FlatOverviewProps) {
  return (
    <div className={`overview-flat overview-flat-${direction}`}>
      {devices.flatMap((dev, di) =>
        dev.lanes.map((lane, li) => (
          <FlatLaneRow
            key={lane.id}
            dev={dev}
            lane={lane}
            direction={direction}
            groupStart={di > 0 && li === 0}
            blocks={blocks}
            selectedSlotId={selectedSlotId}
            onSelectSlot={(slotId) => onSelectSlot(lane.id, slotId)}
            onOpenBlock={onOpenBlock}
            onOpenSettings={() => onOpenLaneSettings(lane.id)}
            onOpenAddBlock={() => onOpenAddBlock(lane.id, dev.id)}
          />
        )),
      )}
    </div>
  );
}

interface FlatLaneRowProps {
  dev: Device;
  lane: Lane;
  direction: "row" | "column";
  groupStart: boolean;
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
  direction,
  groupStart,
  blocks,
  selectedSlotId,
  onSelectSlot,
  onOpenBlock,
  onOpenSettings,
  onOpenAddBlock,
}: FlatLaneRowProps) {
  const send = useSend();
  const slots: Slot[] = lane.slots ?? [];
  // Der Abstand vor der ersten Lane eines neuen Geräts markiert die Gruppe —
  // in „row" seitlich (nächste Gruppe steht rechts daneben), in „column" oben
  // (nächste Gruppe folgt darunter).
  const groupGap = groupStart
    ? direction === "row"
      ? { marginInlineStart: 16 }
      : { marginBlockStart: 16 }
    : {};

  return (
    <div
      className="flat-lane-row"
      style={{
        ...groupGap,
        opacity: lane.enabled ? 1 : 0.5,
      }}
    >
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
        style={{ background: lane.color || "var(--pal-text-dim)", borderColor: dev.color || "var(--pal-text-dim)" }}
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
