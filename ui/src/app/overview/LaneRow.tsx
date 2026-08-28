//! Lane-Zeile — React-Port des laneRow() aus ui/overview.ts.
//!
//! Aufbau: eine KOPFZEILE (Name, Rolle, Kanal/Ziel, Schalter) und darunter
//! die Bausteine in EINER Reihe nebeneinander. Vorher stand der Kopf links
//! neben den Kacheln und die Kacheln umbrachen in mehrere Zeilen — damit war
//! weder klar, wo eine Lane aufhört, noch stimmte die Reihenfolge optisch mit
//! der Abspielreihenfolge überein (die Kette läuft von links nach rechts).
//! Passen sie nicht auf den Screen, wird die Reihe quer gescrollt (Touch).

import type { Device, Lane } from "../../state";
import { useRuntimeLane, useSend, useStoreValue } from "../store";
import { useTouchKeyboard } from "../TouchKeyboard";
import type { LiveControl } from "../dashboard/ControlWidget";
import { Button } from "../widgets/Button";
import { PillToggle } from "../widgets/PillToggle";
import { SelectMenu, type SelectOption } from "../widgets/SelectMenu";
import { useLocalPref } from "../useLocalPref";
import { SlotTile } from "./SlotTile";
import { roleLabel } from "./popups";

// Stable reference for the useSyncExternalStore selector — see the
// EMPTY_DEVICES comment in Dashboard.tsx.
const EMPTY_CONTROLS: LiveControl[] = [];

const PLAY_MODE_ICON: Record<string, string> = { sequential: "▶", random: "🔀", manual: "✋" };
const PLAY_MODE_OPTIONS: SelectOption<string>[] = [
  { value: "sequential", label: "▶ Sequential — run through blocks in order" },
  { value: "random", label: "🔀 Random — jump to a random block" },
  { value: "manual", label: "✋ Manual — repeat the current block" },
];

export interface LaneRowProps {
  lane: Lane;
  dev: Device;
  onOpenAddBlock: () => void;
  onOpenBlockMenu: (slotId: string) => void;
  onOpenLaneControls: () => void;
  onOpenCcTarget: () => void;
}

export function LaneRow({ lane, dev, onOpenAddBlock, onOpenBlockMenu, onOpenCcTarget }: LaneRowProps) {
  const send = useSend();
  const runtimeRef = useRuntimeLane(lane.id);
  const openKeyboard = useTouchKeyboard();
  const recordArmed = useStoreValue((s) => s.recordArmed);
  const controls = useStoreValue((s) => (s.project?.controls as LiveControl[] | undefined) ?? EMPTY_CONTROLS);
  const isRecordTarget = recordArmed?.laneId === lane.id;

  // Sperre gegen Fehlgriffe während einer Live-Performance. Bewusst nur lokal
  // (localStorage, pro Gerät) — sie beschreibt den Blick auf die Lane, nicht
  // die Lane selbst, und gehört daher nicht ins Projekt.
  const [lockedPref, setLockedPref] = useLocalPref<"0" | "1">(`lane.locked.${lane.id}`, "0");
  const locked = lockedPref === "1";

  const playMode = lane.playMode || "sequential";
  const channelValue = lane.channel ?? 0;
  const channelOptions: SelectOption<number>[] = [
    { value: 0, label: `Device default (Ch ${dev.channel})` },
    ...Array.from({ length: 16 }, (_, i) => ({ value: i + 1, label: `Ch ${i + 1}` })),
  ];

  // Ziel und Kanal sitzen an der Lane, nicht am Baustein — ein Baustein ist
  // reiner Inhalt und steckt womöglich in mehreren Lanes. Bei CC-Lanes kommt
  // zusätzlich die CC-Nummer vom Ziel-Knob; der Kanal aber wie überall von
  // Lane/Device, damit er in der Zeile sichtbar und korrigierbar ist.
  const isCc = lane.role === "cc";
  const ccTarget = isCc ? controls.find((c) => c.id === lane.ccControlId) : undefined;
  const ccTargetValid = !!ccTarget && ccTarget.deviceId === dev.id && ccTarget.mapping?.kind === "cc";

  return (
    <div
      className="panel-deep lane-row"
      ref={runtimeRef}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 8,
        padding: 8,
        opacity: lane.enabled ? 1 : 0.5,
        borderLeft: `4px solid color-mix(in srgb, ${lane.color || "var(--pal-white)"} 55%, transparent)`,
      }}
    >
      {/* Noten-Puls: blitzt am linken Rand, sobald diese Lane Noten sendet —
          so sieht man auch bei zugescrollten Kacheln, dass sie läuft. */}
      <div className="lane-pulse" aria-hidden="true" />

      {/* ── Kopfzeile ── */}
      <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
        <div
          style={{ fontSize: 20, fontWeight: 600, cursor: "pointer", marginRight: 2 }}
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
            padding: "2px 8px",
            borderRadius: 8,
            background: "rgba(255, 255, 255, 0.12)",
            fontSize: 12,
            fontWeight: 600,
          }}
        >
          {roleLabel(lane.role)}
        </div>

        {isRecordTarget && (
          <div
            style={{ fontSize: 11, fontWeight: 700, color: "var(--pal-danger)", cursor: "pointer" }}
            title="Keyboard is linked to this lane — tap to unlink"
            onClick={() => send({ t: "record.arm", controlId: recordArmed!.controlId, laneId: lane.id })}
          >
            ● REC
          </div>
        )}

        {isCc && (
          <Button
            variant={ccTargetValid ? "default" : "alt"}
            style={{ height: 34, padding: "0 10px", fontSize: 12 }}
            title={
              ccTargetValid
                ? `Sends CC${ccTarget!.mapping?.number} (from knob “${ccTarget!.name || "unnamed"}”)`
                : "No CC target — this lane stays silent until you pick a knob"
            }
            onClick={onOpenCcTarget}
          >
            {ccTargetValid ? `→ CC${ccTarget!.mapping?.number}` : "→ no target"}
          </Button>
        )}

        <SelectMenu
          style={{ height: 34, padding: "0 10px", fontSize: 12 }}
          buttonTitle="MIDI channel for this lane"
          title="MIDI channel"
          buttonLabel={lane.channel ? `Ch ${lane.channel}` : `Ch ${dev.channel} (dev)`}
          value={channelValue}
          options={channelOptions}
          onChange={(v) => send({ t: "lane.setChannel", laneId: lane.id, channel: v === 0 ? null : v })}
        />

        <div style={{ display: "flex", gap: 8, alignItems: "center", marginLeft: "auto" }}>
          <SelectMenu
            variant={playMode === "manual" ? "active" : "alt"}
            style={{ width: 40, height: 40, fontSize: 18 }}
            title="Play mode"
            buttonTitle="How this lane moves through its blocks"
            buttonLabel={PLAY_MODE_ICON[playMode]}
            value={playMode}
            options={PLAY_MODE_OPTIONS}
            onChange={(mode) => send({ t: "lane.setPlayMode", laneId: lane.id, mode })}
          />
          <Button
            variant={locked ? "active" : "alt"}
            style={{ width: 40, height: 40, fontSize: 18 }}
            title={locked ? "Locked — block edits disabled (live-safe). Tap to unlock." : "Lock this lane's blocks against accidental edits"}
            onClick={() => setLockedPref(locked ? "0" : "1")}
          >
            {locked ? "🔒" : "🔓"}
          </Button>
          <PillToggle
            letter="E"
            active={lane.enabled}
            onToggle={() => send({ t: "lane.setEnabled", laneId: lane.id, enabled: !lane.enabled })}
          />
          <PillToggle
            letter="S"
            active={lane.solo}
            onToggle={() => send({ t: "lane.setSolo", laneId: lane.id, solo: !lane.solo })}
          />
          <Button
            variant="danger"
            style={{ width: 40, height: 40, fontSize: 18 }}
            disabled={locked}
            onClick={() => send({ t: "lane.delete", laneId: lane.id })}
          >
            ✕
          </Button>
        </div>
      </div>

      {/* ── Bausteinkette: immer nebeneinander, bei Bedarf quer scrollen ──
          Das "＋" steht bewusst NEBEN dem Scroller, nicht darin: sonst müsste
          man erst bis ans Ende einer langen Kette wischen, um etwas
          hinzuzufügen. */}
      <div style={{ display: "flex", gap: 10, alignItems: "stretch" }}>
        <div className="lane-slots">
          {(lane.slots ?? []).map((slot) => {
            const blk = dev.blocks?.find((b) => b.id === slot.blockId);
            return (
              <SlotTile
                key={slot.id}
                lane={lane}
                slot={slot}
                blk={blk}
                locked={locked}
                onLongPress={() => onOpenBlockMenu(slot.id)}
              />
            );
          })}
        </div>
        <Button
          variant="alt"
          style={{ width: 34, height: 140, fontSize: 20, flex: "0 0 auto" }}
          disabled={locked}
          onClick={onOpenAddBlock}
        >
          ＋
        </Button>
      </div>
    </div>
  );
}
