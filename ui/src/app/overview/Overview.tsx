//! Sequencer-Overview — Geräte/Lanes/Kacheln. Rechts angedockt: das BlockDock,
//! das die im Kachel-KÖRPER angetippte (ausgewählte) Slot-Kachel bearbeitet —
//! ohne Menü-Tauchen, fester Ort. Antippen der Trigger-Leiste löst nur aus und
//! ändert die Auswahl NICHT.

import { useState } from "react";
import type { Block, Device, Lane, Slot } from "../../state";
import { useStoreValue } from "../store";
import { OVERVIEW_FS, OVERVIEW_GAP } from "../uiSizes";
import { TRANSPORT_H } from "../layout";
import { DevicePanel } from "./DevicePanel";
import { BlockDock } from "./BlockDock";
import { LaneSettingsDock, DeviceSettingsDock } from "./SettingsDock";
import {
  RolePickerPopup,
  AddBlockPickerPopup,
  SwapPickerPopup,
  CcTargetPickerPopup,
} from "./popups";

// Stable reference so the useSyncExternalStore selector below returns the
// same identity across calls when there's no project yet — a fresh `[]`
// each call would never satisfy Object.is and spin React into an infinite
// update loop.
const EMPTY_DEVICES: Device[] = [];
const EMPTY_BLOCKS: Block[] = [];

// Schmal gehalten: Zielgerät ist ein 7"-Raspi-Display (800×480) — s. .block-dock.
const DOCK_W = 148;
// Das Einstellungs-Menü (SettingsDock) trägt größere, touch-sichere Schalter.
// Etwas breiter als früher, damit auch bei hochgestellter Regler-Größe
// (--ctrl-scale) Beschriftungen wie „✕ Delete" nicht aus dem Knopf laufen.
const SETTINGS_W = 252;

type PopupState =
  | { kind: "role"; deviceId: string }
  | { kind: "addBlock"; laneId: string; deviceId: string }
  | { kind: "swap"; laneId: string; deviceId: string; slotId: string; currentBlockId: string }
  | { kind: "ccTarget"; laneId: string; deviceId: string };

type SettingsState = { kind: "lane"; laneId: string } | { kind: "device"; deviceId: string };

export interface OverviewProps {
  onOpenBlock: (blockId: string) => void;
}

export function Overview({ onOpenBlock }: OverviewProps) {
  const devices = useStoreValue((s) => s.project?.devices ?? EMPTY_DEVICES);
  const blocks = useStoreValue((s) => (s.project?.blocks as Block[] | undefined) ?? EMPTY_BLOCKS);
  const ports = useStoreValue((s) => s.midiOutputs);
  const [popup, setPopup] = useState<PopupState | null>(null);
  const [sel, setSel] = useState<{ laneId: string; slotId: string } | null>(null);
  const [pinned, setPinned] = useState(false);
  const [settings, setSettings] = useState<SettingsState | null>(null);
  const closePopup = () => setPopup(null);

  const openLaneSettings = (laneId: string) => {
    setPinned(false);
    setSel(null);
    setSettings({ kind: "lane", laneId });
  };
  const openDeviceSettings = (deviceId: string) => {
    setPinned(false);
    setSel(null);
    setSettings({ kind: "device", deviceId });
  };

  const findDevice = (id: string): Device | undefined => devices.find((d) => d.id === id);

  // Ausgewählte Lane/Slot auflösen — verschwindet der Slot (gelöscht, Projekt-
  // wechsel), fällt das Dock weg.
  let selLane: Lane | null = null;
  let selSlot: Slot | null = null;
  for (const d of devices) {
    const l = d.lanes.find((x) => x.id === sel?.laneId);
    const sl = l?.slots.find((x) => x.id === sel?.slotId);
    if (l && sl) {
      selLane = l;
      selSlot = sl;
      break;
    }
  }
  if (sel && !selSlot && devices.length > 0) {
    // Auswahl zeigt ins Leere (Slot gelöscht) → im nächsten Tick räumen.
    queueMicrotask(() => setSel((cur) => (cur === sel ? null : cur)));
  }
  const selBlk = selSlot ? blocks.find((b) => b.id === selSlot!.blockId) : undefined;
  const dockOpen = !!(selLane && selSlot);

  // Einstellungs-Ziel auflösen — verschwindet Lane/Gerät, fällt das Menü weg.
  let settingsLane: { lane: Lane; device: Device } | null = null;
  let settingsDevice: Device | null = null;
  if (settings?.kind === "lane") {
    for (const d of devices) {
      const l = d.lanes.find((x) => x.id === settings.laneId);
      if (l) {
        settingsLane = { lane: l, device: d };
        break;
      }
    }
  } else if (settings?.kind === "device") {
    settingsDevice = devices.find((d) => d.id === settings.deviceId) ?? null;
  }
  if (settings && !settingsLane && !settingsDevice && devices.length > 0) {
    queueMicrotask(() => setSettings((cur) => (cur === settings ? null : cur)));
  }
  const settingsOpen = !!(settingsLane || settingsDevice);

  const selectSlot = (laneId: string, slotId: string) => {
    if (pinned) return; // angepinnt: Dock bleibt, bis man löst
    setSettings(null);
    setSel({ laneId, slotId });
  };

  return (
    <>
      <div
        style={{
          position: "fixed",
          top: TRANSPORT_H,
          left: 0,
          right: 0,
          bottom: 0,
          overflowY: "auto",
          padding: OVERVIEW_GAP * 2,
          paddingRight:
            (settingsOpen ? SETTINGS_W : dockOpen ? DOCK_W : 0) + OVERVIEW_GAP * 2,
          display: "flex",
          flexDirection: "column",
          gap: OVERVIEW_GAP,
        }}
      >
        {ports.length === 0 && (
          <div style={{ color: "var(--pal-text-dim)", fontSize: OVERVIEW_FS, fontWeight: 600 }}>
            No MIDI devices found — connect a device.
          </div>
        )}

        {devices.length === 0 ? (
          <div style={{ color: "var(--pal-text-dim)", fontSize: OVERVIEW_FS }}>
            {ports.length > 0 ? "No devices yet — tap “＋ Device” in the top bar." : ""}
          </div>
        ) : (
          devices.map((dev) => (
            <DevicePanel
              key={dev.id}
              dev={dev}
              onOpenDeviceSettings={() => openDeviceSettings(dev.id)}
              onOpenLaneSettings={openLaneSettings}
              onOpenAddBlock={(laneId) => setPopup({ kind: "addBlock", laneId, deviceId: dev.id })}
              onSelectSlot={selectSlot}
              selectedSlotId={sel?.slotId ?? null}
            />
          ))
        )}


        {popup?.kind === "role" && <RolePickerPopup deviceId={popup.deviceId} onClose={closePopup} />}

        {popup?.kind === "addBlock" &&
          (() => {
            const dev = findDevice(popup.deviceId);
            const lane = dev?.lanes.find((l) => l.id === popup.laneId);
            return dev && lane ? <AddBlockPickerPopup lane={lane} onClose={closePopup} /> : null;
          })()}

        {popup?.kind === "ccTarget" &&
          (() => {
            const dev = findDevice(popup.deviceId);
            const lane = dev?.lanes.find((l) => l.id === popup.laneId);
            return dev && lane ? <CcTargetPickerPopup lane={lane} dev={dev} onClose={closePopup} /> : null;
          })()}

        {popup?.kind === "swap" &&
          (() => {
            const dev = findDevice(popup.deviceId);
            const lane = dev?.lanes.find((l) => l.id === popup.laneId);
            return dev && lane ? (
              <SwapPickerPopup
                lane={lane}
                slotId={popup.slotId}
                currentBlockId={popup.currentBlockId}
                onClose={closePopup}
              />
            ) : null;
          })()}
      </div>

      {settingsLane && (
        <LaneSettingsDock
          lane={settingsLane.lane}
          onOpenCcTarget={() =>
            setPopup({ kind: "ccTarget", laneId: settingsLane!.lane.id, deviceId: settingsLane!.device.id })
          }
          onClose={() => setSettings(null)}
        />
      )}

      {settingsDevice && (
        <DeviceSettingsDock
          device={settingsDevice}
          onOpenAddLane={() => setPopup({ kind: "role", deviceId: settingsDevice!.id })}
          onClose={() => setSettings(null)}
        />
      )}

      {dockOpen && !settingsOpen && (
        <BlockDock
          lane={selLane!}
          slot={selSlot!}
          blk={selBlk}
          pinned={pinned}
          onTogglePin={() => setPinned((p) => !p)}
          onClose={() => {
            setPinned(false);
            setSel(null);
          }}
          onEdit={() => selSlot!.blockId && onOpenBlock(selSlot!.blockId)}
          onSwap={() => {
            const dev = devices.find((d) => d.lanes.some((l) => l.id === selLane!.id));
            if (dev && selSlot!.blockId) {
              setPopup({
                kind: "swap",
                laneId: selLane!.id,
                deviceId: dev.id,
                slotId: selSlot!.id,
                currentBlockId: selSlot!.blockId,
              });
            }
          }}
        />
      )}
    </>
  );
}
