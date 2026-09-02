//! Lane-Zeile — trägt nur noch EINEN Knopf: den Lane-Namen (senkrecht an der
//! linken Kante). Ein Tipp öffnet das Einstellungs-Menü rechts (SettingsDock)
//! mit allen Lane-Reglern als große Schalter. Rechts daneben die Baustein-
//! Kacheln. Eingeklappt bleibt eine schmale Kopfzeile mit Namensknopf und
//! Baustein-Zahl.

import type { Block, Lane } from "../../state";
import { useRuntimeLane, useSend, useStoreValue } from "../store";
import { useLocalPref } from "../useLocalPref";
import { SlotTile } from "./SlotTile";

// Stable reference for the useSyncExternalStore selector — see the
// EMPTY_DEVICES comment in Dashboard.tsx.
const EMPTY_BLOCKS: Block[] = [];

export interface LaneRowProps {
  lane: Lane;
  onOpenSettings: () => void;
  onOpenAddBlock: () => void;
  onSelectSlot: (slotId: string) => void;
  selectedSlotId: string | null;
}

export function LaneRow({ lane, onOpenSettings, onOpenAddBlock, onSelectSlot, selectedSlotId }: LaneRowProps) {
  const send = useSend();
  const runtimeRef = useRuntimeLane(lane.id);
  const blocks = useStoreValue((s) => (s.project?.blocks as Block[] | undefined) ?? EMPTY_BLOCKS);
  // Lock ist eine lokale Ansichts-Vorliebe (umgeschaltet im SettingsDock) — hier
  // nur gelesen, um im gesperrten Zustand den Kachel-Körper stillzulegen.
  const [lockedPref] = useLocalPref<"0" | "1">(`lane.locked.${lane.id}`, "0");
  const locked = lockedPref === "1";
  const collapsed = !!lane.collapsed;
  const blockCount = lane.slots?.length ?? 0;

  const nameButton = (vertical: boolean) => (
    <button
      type="button"
      className={`overview-name-btn${vertical ? " vertical" : ""}`}
      title="Lane settings"
      onClick={onOpenSettings}
    >
      {lane.name}
    </button>
  );

  // Schnell-Start/Stop ganz links: schaltet die Lane scharf/stumm.
  const runButton = (
    <button
      type="button"
      className={`lane-run${lane.enabled ? " on" : ""}`}
      title={lane.enabled ? "Stop this lane" : "Start this lane"}
      onClick={() => send({ t: "lane.setEnabled", laneId: lane.id, enabled: !lane.enabled })}
    >
      {lane.enabled ? "■" : "▶"}
    </button>
  );

  return (
    <div
      className="panel-deep lane-row"
      ref={runtimeRef}
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 4,
        padding: 4,
        opacity: lane.enabled ? 1 : 0.5,
        borderLeft: `4px solid color-mix(in srgb, ${lane.color || "var(--pal-white)"} 55%, transparent)`,
      }}
    >
      {/* Noten-Puls: blitzt am linken Rand, sobald diese Lane Noten sendet —
          so sieht man auch bei zugescrollten Kacheln, dass sie läuft. */}
      <div className="lane-pulse" aria-hidden="true" />

      {runButton}

      {collapsed ? (
        <div style={{ display: "flex", alignItems: "center", gap: 6, flex: 1 }}>
          {nameButton(false)}
          <span className="overview-dim">
            {blockCount} block{blockCount === 1 ? "" : "s"}
          </span>
        </div>
      ) : (
        <>
          <div className="overview-name-wrap">{nameButton(true)}</div>

          <div className="lane-slots">
            {(lane.slots ?? []).map((slot) => {
              const blk = blocks.find((b) => b.id === slot.blockId);
              return (
                <SlotTile
                  key={slot.id}
                  lane={lane}
                  slot={slot}
                  blk={blk}
                  locked={locked}
                  selected={slot.id === selectedSlotId}
                  onSelect={() => onSelectSlot(slot.id)}
                />
              );
            })}
            <button
              type="button"
              className="slot-tile slot-add"
              disabled={locked}
              onClick={onOpenAddBlock}
              aria-label="Add block"
            >
              ＋
            </button>
          </div>
        </>
      )}
    </div>
  );
}
