//! Device-Panel — trägt nur noch EINEN Knopf: den Gerätenamen (senkrecht an
//! der linken Kante). Ein Tipp öffnet das Einstellungs-Menü rechts
//! (SettingsDock) mit Clock/Add-Lane/Collapse/Delete als große Schalter.
//! Rechts daneben die Lanes.

import type { Device } from "../../state";
import { useLocalPref } from "../useLocalPref";
import { useSend } from "../store";
import { LaneRow } from "./LaneRow";

export interface DevicePanelProps {
  dev: Device;
  onOpenDeviceSettings: () => void;
  onOpenLaneSettings: (laneId: string) => void;
  onOpenAddBlock: (laneId: string) => void;
  onSelectSlot: (laneId: string, slotId: string) => void;
  selectedSlotId: string | null;
}

export function DevicePanel({
  dev,
  onOpenDeviceSettings,
  onOpenLaneSettings,
  onOpenAddBlock,
  onSelectSlot,
  selectedSlotId,
}: DevicePanelProps) {
  const send = useSend();
  // Einklapp-Zustand ist eine reine Ansichts-Vorliebe (localStorage),
  // umgeschaltet im SettingsDock — hier nur gelesen.
  const [collapsedPref] = useLocalPref<"0" | "1">(`device.collapsed.${dev.id}`, "0");
  const collapsed = collapsedPref === "1";
  const laneCount = dev.lanes.length;
  const muted = !!dev.muted;

  // Stopp-Schild ganz links: mutet in EINEM Griff alle Lanes des Geräts
  // (sie laufen weiter, s. `dev_muted` in engine.rs). Rot = gemutet.
  const muteButton = (
    <button
      type="button"
      className={`device-mute${muted ? " on" : ""}`}
      title={muted ? "Unmute this device" : "Mute the whole device"}
      onClick={() => send({ t: "device.setMuted", deviceId: dev.id, muted: !muted })}
    >
      <span className="octagon" aria-hidden="true" />
    </button>
  );

  const nameButton = (vertical: boolean) => (
    <button
      type="button"
      className={`overview-name-btn device${vertical ? " vertical" : ""}`}
      title="Device settings"
      onClick={onOpenDeviceSettings}
    >
      {dev.name}
    </button>
  );

  if (collapsed) {
    return (
      <div className="panel" style={{ padding: 6, display: "flex", alignItems: "center", gap: 8 }}>
        {muteButton}
        {nameButton(false)}
        <span className="overview-dim">
          · {laneCount} lane{laneCount === 1 ? "" : "s"}
        </span>
        {!dev.midiOutPort && <span className="overview-warn">no MIDI port</span>}
      </div>
    );
  }

  return (
    <div className="panel" style={{ padding: 6, display: "flex", gap: 6, alignItems: "stretch" }}>
      {muteButton}
      {/* Name in einem 0-hohen Stretch-Wrapper: er kommt auf die von den Lanes
          bestimmte Höhe und darf lange Portnamen NICHT nach unten austreiben. */}
      <div className="overview-name-wrap device">{nameButton(true)}</div>

      <div style={{ display: "flex", flexDirection: "column", gap: 4, flex: 1, minWidth: 0 }}>
        {dev.lanes.map((lane) => (
          <LaneRow
            key={lane.id}
            lane={lane}
            onOpenSettings={() => onOpenLaneSettings(lane.id)}
            onOpenAddBlock={() => onOpenAddBlock(lane.id)}
            onSelectSlot={(slotId) => onSelectSlot(lane.id, slotId)}
            selectedSlotId={selectedSlotId}
          />
        ))}
      </div>
    </div>
  );
}
