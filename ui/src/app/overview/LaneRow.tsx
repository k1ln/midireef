//! Lane-Zeile — React-Port des laneRow() aus ui/overview.ts.
//!
//! Aufbau: eine KOPFZEILE (Name, Kanal-Chip, Schalter) und darunter die
//! Bausteine in EINER Reihe nebeneinander (das „＋" ist selbst eine Kachel am
//! Ende der Kette). Die Zeile lässt sich über das Chevron einklappen — dann
//! bleibt nur der Kopf mit einer kurzen Zusammenfassung stehen.
//! Passen die Kacheln nicht auf den Screen, bricht die Reihe um.

import { useState } from "react";
import type { Block, Device, Lane } from "../../state";
import { useRuntimeLane, useSend, useStoreValue } from "../store";
import { useTouchKeyboard } from "../TouchKeyboard";
import type { LiveControl } from "../dashboard/ControlWidget";
import { Button } from "../widgets/Button";
import { PillToggle } from "../widgets/PillToggle";
import { SelectMenu, type SelectOption } from "../widgets/SelectMenu";
import { useLocalPref } from "../useLocalPref";
import { SlotTile } from "./SlotTile";

// Stable reference for the useSyncExternalStore selector — see the
// EMPTY_DEVICES comment in Dashboard.tsx.
const EMPTY_CONTROLS: LiveControl[] = [];
const EMPTY_BLOCKS: Block[] = [];

const PLAY_MODE_ICON: Record<string, string> = {
  sequential: "▶",
  random: "⇄",
  manual: "✋",
  hold: "✊",
  oneShot: "①",
};
const PLAY_MODE_OPTIONS: SelectOption<string>[] = [
  { value: "sequential", label: "▶ Sequential — run through blocks in order" },
  { value: "random", label: "⇄ Random — jump to a random block" },
  { value: "manual", label: "✋ Manual — repeat the current block" },
  { value: "hold", label: "✊ Hold — silent until a tile is held; plays only while held" },
  { value: "oneShot", label: "① One-shot — silent; one tap plays a tile once through" },
];
const PLAY_MODE_ACTIVE = new Set(["manual", "hold", "oneShot"]);

/** Wann ein angetippter Baustein startet. Kurzzeichen für den 40px-Knopf; die
 *  Langtexte stehen im Menü. Nur Textglyphen — der Pi hat keine Emoji-Fonts. */
const QUANTIZE_ICON: Record<string, string> = {
  immediate: "⚡",
  nextBeat: "♩",
  nextBar: "|",
  nextBlock: "⊣",
};
const QUANTIZE_OPTIONS: SelectOption<string>[] = [
  { value: "immediate", label: "⚡ Immediate — start the moment you tap" },
  { value: "nextBeat", label: "♩ Next beat — snap to the next beat" },
  { value: "nextBar", label: "| Next bar — snap to the next bar (stays in sync)" },
  { value: "nextBlock", label: "⊣ Next block — wait until the running block finishes" },
];

export interface LaneRowProps {
  lane: Lane;
  dev: Device;
  onOpenAddBlock: () => void;
  onSelectSlot: (slotId: string) => void;
  selectedSlotId: string | null;
  onOpenLaneControls: () => void;
  onOpenCcTarget: () => void;
}

export function LaneRow({
  lane,
  dev,
  onOpenAddBlock,
  onSelectSlot,
  selectedSlotId,
  onOpenCcTarget,
}: LaneRowProps) {
  const send = useSend();
  const runtimeRef = useRuntimeLane(lane.id);
  const openKeyboard = useTouchKeyboard();
  const recordArmed = useStoreValue((s) => s.recordArmed);
  const controls = useStoreValue((s) => (s.project?.controls as LiveControl[] | undefined) ?? EMPTY_CONTROLS);
  const blocks = useStoreValue((s) => (s.project?.blocks as Block[] | undefined) ?? EMPTY_BLOCKS);
  const isRecordTarget = recordArmed?.laneId === lane.id;

  // Sperre gegen Fehlgriffe während einer Live-Performance. Bewusst nur lokal
  // (localStorage, pro Gerät) — sie beschreibt den Blick auf die Lane, nicht
  // die Lane selbst, und gehört daher nicht ins Projekt.
  const [lockedPref, setLockedPref] = useLocalPref<"0" | "1">(`lane.locked.${lane.id}`, "0");
  const locked = lockedPref === "1";
  const [confirmDelete, setConfirmDelete] = useState(false);

  const playMode = lane.playMode || "sequential";
  const quantize = lane.triggerQuantize || "nextBar";
  const channelValue = lane.channel || 1;
  const channelOptions: SelectOption<number>[] = Array.from({ length: 16 }, (_, i) => ({
    value: i + 1,
    label: `Ch ${i + 1}`,
  }));
  const collapsed = !!lane.collapsed;

  // Ziel und Kanal sitzen an der Lane, nicht am Baustein — ein Baustein ist
  // reiner Inhalt und steckt womöglich in mehreren Lanes. Bei CC-Lanes kommt
  // zusätzlich die CC-Nummer vom Ziel-Knob; der Kanal aber von der Lane selbst,
  // damit er in der Zeile sichtbar und korrigierbar ist.
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
        <Button
          variant="alt"
          style={{ width: 30, height: 30, fontSize: 14, flex: "0 0 auto" }}
          title={collapsed ? "Expand lane" : "Collapse lane"}
          onClick={() => send({ t: "lane.setCollapsed", laneId: lane.id, collapsed: !collapsed })}
        >
          {collapsed ? "▸" : "▾"}
        </Button>

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

        {collapsed && (
          <span style={{ fontSize: 12, color: "var(--pal-text-dim)", fontWeight: 600 }}>
            {lane.slots?.length ?? 0} block{(lane.slots?.length ?? 0) === 1 ? "" : "s"}
          </span>
        )}

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
            style={{ height: 30, padding: "0 10px", fontSize: 12 }}
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

        {/* Kanal als kompakter Chip. */}
        <SelectMenu
          className="chip"
          style={{ height: 28, padding: "0 8px", fontSize: 12 }}
          buttonTitle="MIDI channel for this lane"
          title="MIDI channel"
          buttonLabel={`Ch ${channelValue}`}
          value={channelValue}
          options={channelOptions}
          onChange={(v) => send({ t: "lane.setChannel", laneId: lane.id, channel: v })}
        />

        <div style={{ display: "flex", gap: 4, alignItems: "center", marginLeft: "auto" }}>
          <SelectMenu
            variant={PLAY_MODE_ACTIVE.has(playMode) ? "active" : "alt"}
            style={{ width: 40, height: 40, fontSize: 18 }}
            title="Play mode"
            buttonTitle="How this lane moves through its blocks"
            buttonLabel={PLAY_MODE_ICON[playMode]}
            value={playMode}
            options={PLAY_MODE_OPTIONS}
            onChange={(mode) => send({ t: "lane.setPlayMode", laneId: lane.id, mode })}
          />
          <SelectMenu
            variant={quantize === "immediate" ? "alt" : "active"}
            style={{ width: 40, height: 40, fontSize: 18 }}
            title="Trigger timing"
            buttonTitle="When a tapped block actually starts"
            buttonLabel={QUANTIZE_ICON[quantize] ?? "|"}
            value={quantize}
            options={QUANTIZE_OPTIONS}
            onChange={(q) => send({ t: "lane.setTriggerQuantize", laneId: lane.id, quantize: q })}
          />
          <Button
            variant={locked ? "active" : "alt"}
            style={{ width: 40, height: 40, fontSize: 18 }}
            title={locked ? "Locked — block edits disabled (live-safe). Tap to unlock." : "Lock this lane's blocks against accidental edits"}
            onClick={() => setLockedPref(locked ? "0" : "1")}
          >
            {locked ? "●" : "○"}
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
          {confirmDelete ? (
            <>
              <span style={{ fontSize: 12, color: "var(--pal-text-dim)", fontWeight: 600 }}>Delete lane?</span>
              <Button
                variant="danger"
                style={{ height: 40, padding: "0 12px", fontSize: 14 }}
                onClick={() => send({ t: "lane.delete", laneId: lane.id })}
              >
                Delete
              </Button>
              <Button
                style={{ height: 40, padding: "0 12px", fontSize: 14 }}
                onClick={() => setConfirmDelete(false)}
              >
                Cancel
              </Button>
            </>
          ) : (
            <Button
              variant="danger"
              style={{ width: 40, height: 40, fontSize: 18 }}
              disabled={locked}
              onClick={() => setConfirmDelete(true)}
            >
              ✕
            </Button>
          )}
        </div>
      </div>

      {/* ── Bausteinkette: immer nebeneinander, bei Bedarf umbrechen. Das „＋"
          ist selbst eine Kachel am Ende der Kette. ── */}
      {!collapsed && (
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
      )}
    </div>
  );
}
