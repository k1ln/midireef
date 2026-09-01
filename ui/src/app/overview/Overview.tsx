//! Sequencer-Overview — Geräte/Lanes/Kacheln. Rechts angedockt: das BlockDock,
//! das die im Kachel-KÖRPER angetippte (ausgewählte) Slot-Kachel bearbeitet —
//! ohne Menü-Tauchen, fester Ort. Antippen der Trigger-Leiste löst nur aus und
//! ändert die Auswahl NICHT.

import { useState } from "react";
import type { Block, Device, Lane, Slot } from "../../state";
import { useStoreValue } from "../store";
import { Button } from "../widgets/Button";
import { TRANSPORT_H } from "../layout";
import { DevicePanel } from "./DevicePanel";
import { BlockDock } from "./BlockDock";
import {
  PortPickerPopup,
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

type PopupState =
  | { kind: "port" }
  | { kind: "role"; deviceId: string }
  | { kind: "addBlock"; laneId: string; deviceId: string }
  | { kind: "swap"; laneId: string; deviceId: string; slotId: string; currentBlockId: string }
  | { kind: "ccTarget"; laneId: string; deviceId: string };

export interface OverviewProps {
  onOpenBlock: (blockId: string) => void;
  onOpenLaneControls: (laneId: string) => void;
}

export function Overview({ onOpenBlock, onOpenLaneControls }: OverviewProps) {
  const devices = useStoreValue((s) => s.project?.devices ?? EMPTY_DEVICES);
  const blocks = useStoreValue((s) => (s.project?.blocks as Block[] | undefined) ?? EMPTY_BLOCKS);
  const ports = useStoreValue((s) => s.midiOutputs);
  const [popup, setPopup] = useState<PopupState | null>(null);
  const [sel, setSel] = useState<{ laneId: string; slotId: string } | null>(null);
  const [pinned, setPinned] = useState(false);
  const closePopup = () => setPopup(null);

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

  const selectSlot = (laneId: string, slotId: string) => {
    if (pinned) return; // angepinnt: Dock bleibt, bis man löst
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
          padding: 16,
          paddingRight: dockOpen ? DOCK_W + 16 : 16,
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
              onOpenRolePicker={() => setPopup({ kind: "role", deviceId: dev.id })}
              onOpenAddBlock={(laneId) => setPopup({ kind: "addBlock", laneId, deviceId: dev.id })}
              onSelectSlot={selectSlot}
              selectedSlotId={sel?.slotId ?? null}
              onOpenLaneControls={onOpenLaneControls}
              onOpenCcTarget={(laneId) => setPopup({ kind: "ccTarget", laneId, deviceId: dev.id })}
            />
          ))
        )}

        {popup?.kind === "port" && <PortPickerPopup onClose={closePopup} />}

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

      {dockOpen && (
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
