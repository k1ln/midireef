//! Seiten-Menü der Sequencer-Übersicht — alle Einstellungen einer Lane bzw.
//! eines Geräts, angedockt rechts wie das BlockDock. Die Lane-/Geräte-Zeilen
//! selbst tragen nur noch EINEN Knopf (den Namen); ein Tipp darauf öffnet
//! dieses Menü mit großen, touch-sicheren Schaltern.

import { useState } from "react";
import type { Device, Lane } from "../../state";
import { useSend } from "../store";
import { useTouchKeyboard } from "../TouchKeyboard";
import { useLocalPref } from "../useLocalPref";
import { Button } from "../widgets/Button";
import { SelectMenu, type SelectOption } from "../widgets/SelectMenu";
import { TRANSPORT_H } from "../layout";

const CHANNEL_OPTIONS: SelectOption<number>[] = Array.from({ length: 16 }, (_, i) => ({
  value: i + 1,
  label: `Ch ${i + 1}`,
}));

const PLAY_MODE_OPTIONS: SelectOption<string>[] = [
  { value: "sequential", label: "▶ Sequential — run through blocks in order" },
  { value: "random", label: "⇄ Random — jump to a random block" },
  { value: "manual", label: "✋ Manual — repeat the current block" },
  { value: "hold", label: "✊ Hold — silent until a tile is held; plays only while held" },
  { value: "oneShot", label: "① One-shot — silent; one tap plays a tile once through" },
];
const PLAY_MODE_SHORT: Record<string, string> = {
  sequential: "▶ Sequential",
  random: "⇄ Random",
  manual: "✋ Manual",
  hold: "✊ Hold",
  oneShot: "① One-shot",
};

const QUANTIZE_OPTIONS: SelectOption<string>[] = [
  { value: "immediate", label: "⚡ Immediate — start the moment you tap" },
  { value: "nextBeat", label: "♩ Next beat — snap to the next beat" },
  { value: "nextBar", label: "| Next bar — snap to the next bar (stays in sync)" },
  { value: "nextBlock", label: "⊣ Next block — wait until the running block finishes" },
];
const QUANTIZE_SHORT: Record<string, string> = {
  immediate: "⚡ Immediate",
  nextBeat: "♩ Next beat",
  nextBar: "| Next bar",
  nextBlock: "⊣ Next block",
};

function DockShell({
  title,
  sub,
  onClose,
  onRename,
  children,
}: {
  title: string;
  sub?: string;
  onClose: () => void;
  /** Rename sitzt als „✎" in der Kopfzeile statt als eigene Zeile — auf dem
   *  480px-Display zählt jede gesparte Zeile (das Menü scrollte sonst). */
  onRename?: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="settings-dock" style={{ top: TRANSPORT_H }}>
      <div className="settings-dock-head">
        <span className="settings-dock-title" title={title}>
          {title}
        </span>
        {onRename && (
          <Button variant="alt" className="settings-dock-icon" title="Rename" onClick={onRename}>
            ✎
          </Button>
        )}
        <Button variant="alt" className="settings-dock-icon" title="Close" onClick={onClose}>
          ✕
        </Button>
      </div>
      {sub && <div className="settings-dock-sub">{sub}</div>}
      {children}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="settings-dock-field">
      <div className="settings-dock-label">{label}</div>
      {children}
    </div>
  );
}

function Toggle({ on, onLabel, offLabel, onToggle }: { on: boolean; onLabel: string; offLabel: string; onToggle: () => void }) {
  return (
    <Button variant={on ? "active" : "alt"} className="settings-dock-row" onClick={onToggle}>
      {on ? onLabel : offLabel}
    </Button>
  );
}

export interface LaneSettingsDockProps {
  lane: Lane;
  onOpenCcTarget: () => void;
  onOpenChain: () => void;
  onClose: () => void;
}

export function LaneSettingsDock({ lane, onOpenCcTarget, onOpenChain, onClose }: LaneSettingsDockProps) {
  const send = useSend();
  const openKeyboard = useTouchKeyboard();
  const [lockedPref, setLockedPref] = useLocalPref<"0" | "1">(`lane.locked.${lane.id}`, "0");
  const locked = lockedPref === "1";
  const [confirmDelete, setConfirmDelete] = useState(false);

  const playMode = lane.playMode || "sequential";
  const quantize = lane.triggerQuantize || "nextBar";
  const channel = lane.channel || 1;
  const collapsed = !!lane.collapsed;

  return (
    <DockShell
      title={lane.name}
      sub={lane.role.toUpperCase()}
      onClose={onClose}
      onRename={() =>
        openKeyboard(lane.name, 24, (v) => {
          if (v) send({ t: "lane.rename", laneId: lane.id, name: v });
        })
      }
    >
      <Field label="Channel">
        <SelectMenu
          variant="alt"
          className="settings-dock-row"
          title="MIDI channel"
          buttonLabel={`Ch ${channel}`}
          value={channel}
          options={CHANNEL_OPTIONS}
          onChange={(v) => send({ t: "lane.setChannel", laneId: lane.id, channel: v })}
        />
      </Field>

      <Field label="Play mode / Trigger timing">
        <div className="settings-dock-grid">
          <SelectMenu
            variant="alt"
            title="Play mode"
            buttonLabel={PLAY_MODE_SHORT[playMode] ?? playMode}
            value={playMode}
            options={PLAY_MODE_OPTIONS}
            onChange={(v) => send({ t: "lane.setPlayMode", laneId: lane.id, mode: v })}
          />
          <SelectMenu
            variant="alt"
            title="Trigger timing"
            buttonLabel={QUANTIZE_SHORT[quantize] ?? quantize}
            value={quantize}
            options={QUANTIZE_OPTIONS}
            onChange={(v) => send({ t: "lane.setTriggerQuantize", laneId: lane.id, quantize: v })}
          />
        </div>
      </Field>

      {lane.role === "cc" && (
        <Button
          variant="alt"
          className="settings-dock-row"
          onClick={() => {
            onOpenCcTarget();
            onClose();
          }}
        >
          → CC target
        </Button>
      )}

      <Button
        variant={lane.chainSlot ? "active" : "alt"}
        className="settings-dock-row"
        title="When a slot in this lane is triggered, also fire another lane's slot — e.g. a melody that kicks off a CC effect."
        onClick={() => {
          onOpenChain();
          onClose();
        }}
      >
        {lane.chainSlot ? "⛓ Chain trigger — edit …" : "⛓ Chain trigger …"}
      </Button>

      <Field label="State">
        <div className="settings-dock-grid">
          <Toggle
            on={lane.enabled}
            onLabel="Enabled"
            offLabel="Disabled"
            onToggle={() => send({ t: "lane.setEnabled", laneId: lane.id, enabled: !lane.enabled })}
          />
          <Toggle
            on={lane.solo}
            onLabel="Solo on"
            offLabel="Solo off"
            onToggle={() => send({ t: "lane.setSolo", laneId: lane.id, solo: !lane.solo })}
          />
          <Toggle
            on={locked}
            onLabel="Locked"
            offLabel="Unlocked"
            onToggle={() => setLockedPref(locked ? "0" : "1")}
          />
          <Toggle
            on={collapsed}
            onLabel="Collapsed"
            offLabel="Expanded"
            onToggle={() => send({ t: "lane.setCollapsed", laneId: lane.id, collapsed: !collapsed })}
          />
        </div>
      </Field>

      {confirmDelete ? (
        <div className="settings-dock-confirm">
          <span>Delete this lane?</span>
          <div className="settings-dock-actions">
            <Button
              variant="danger"
              onClick={() => {
                onClose();
                send({ t: "lane.delete", laneId: lane.id });
              }}
            >
              Delete
            </Button>
            <Button variant="alt" onClick={() => setConfirmDelete(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <Button variant="danger" className="settings-dock-row" disabled={locked} onClick={() => setConfirmDelete(true)}>
          ✕ Delete
        </Button>
      )}
    </DockShell>
  );
}

export interface DeviceSettingsDockProps {
  device: Device;
  onOpenAddLane: () => void;
  onClose: () => void;
}

export function DeviceSettingsDock({ device, onOpenAddLane, onClose }: DeviceSettingsDockProps) {
  const send = useSend();
  const openKeyboard = useTouchKeyboard();
  const [collapsedPref, setCollapsedPref] = useLocalPref<"0" | "1">(`device.collapsed.${device.id}`, "0");
  const collapsed = collapsedPref === "1";
  const [confirmDelete, setConfirmDelete] = useState(false);
  const laneCount = device.lanes.length;

  return (
    <DockShell
      title={device.name}
      sub={`${laneCount} lane${laneCount === 1 ? "" : "s"}`}
      onClose={onClose}
      onRename={() =>
        openKeyboard(device.name, 24, (v) => {
          if (v) send({ t: "device.rename", deviceId: device.id, name: v });
        })
      }
    >
      {!device.midiOutPort && <div className="settings-dock-warn">no MIDI port</div>}

      <Field label="State">
        <div className="settings-dock-grid">
          <Toggle
            on={!device.muted}
            onLabel="Sounding"
            offLabel="Muted"
            onToggle={() => send({ t: "device.setMuted", deviceId: device.id, muted: !device.muted })}
          />
          <Toggle
            on={!!device.sendClock}
            onLabel="Clock On"
            offLabel="Clock Off"
            onToggle={() => send({ t: "device.setSendClock", deviceId: device.id, sendClock: !device.sendClock })}
          />
          <Toggle
            on={collapsed}
            onLabel="Collapsed"
            offLabel="Expanded"
            onToggle={() => setCollapsedPref(collapsed ? "0" : "1")}
          />
        </div>
      </Field>

      <Button
        variant="alt"
        className="settings-dock-row"
        onClick={() => {
          onOpenAddLane();
          onClose();
        }}
      >
        ＋ Add lane
      </Button>

      {confirmDelete ? (
        <div className="settings-dock-confirm">
          <span>Delete this device?</span>
          <div className="settings-dock-actions">
            <Button
              variant="danger"
              onClick={() => {
                onClose();
                send({ t: "device.delete", deviceId: device.id });
              }}
            >
              Delete
            </Button>
            <Button variant="alt" onClick={() => setConfirmDelete(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <Button variant="danger" className="settings-dock-row" onClick={() => setConfirmDelete(true)}>
          ✕ Delete
        </Button>
      )}
    </DockShell>
  );
}
