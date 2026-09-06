//! Lane-Controls — React-Port von ui/lanecontrols.ts: die "Schnellbedienung"
//! einer Lane (Drum-/Note-Buttons, Macro-Knobs, MIDI-Signal-Buttons). Feuert
//! live, direkt am Playback-Server vorbei, unabhängig von der Baustein-
//! Bibliothek/Engine. Öffnet von der Sequencer-Übersicht per 🎛-Taste.

import { useMemo, useRef, useState, type HTMLAttributes } from "react";
import type { Block, Device, Lane, LaneControl } from "../state";
import { useSend, useStoreValue } from "./store";
import type { LiveControl } from "./dashboard/ControlWidget";
import { useNotePicker, noteName } from "./NotePicker";
import { useNumberEditor } from "./useNumberEditor";
import { Button } from "./widgets/Button";
import { Popup } from "./widgets/Popup";
import { TRANSPORT_H } from "./layout";

const TILE_W = 100;
const TILE_H = 76;

// Stable reference for the useSyncExternalStore selector below — see the
// EMPTY_DEVICES comment in Dashboard.tsx.
const EMPTY_DEVICES: Device[] = [];
const EMPTY_CONTROLS: LiveControl[] = [];
const EMPTY_BLOCKS: Block[] = [];

export interface LaneControlsProps {
  laneId: string;
  onClose: () => void;
}

interface FoundLane {
  lane: Lane;
  device: Device;
}

/** „Ch3 · CC74 · Cutoff" — Kanal, CC-Nummer und Name des Ziel-Knobs einer
 *  CC-Lane. In den Lane-Details sonst nirgends sichtbar (der Knob lebt im
 *  Dashboard), aber nötig, um zu wissen, was die Schnellbedienung fernsteuert. */
function ccTargetLabel(lane: Lane, controls: LiveControl[]): string {
  const knob = lane.ccControlId ? controls.find((c) => c.id === lane.ccControlId) : undefined;
  if (!knob) return `Ch${lane.channel} · no CC target`;
  const cc = knob.mapping?.number != null ? `CC${knob.mapping.number}` : "CC ?";
  const ch = `Ch${knob.mapping?.channel ?? lane.channel}`;
  return `${ch} · ${cc} · ${knob.name || "(unnamed)"}`;
}

export function LaneControls({ laneId, onClose }: LaneControlsProps) {
  const devices = useStoreValue((s) => s.project?.devices ?? EMPTY_DEVICES);
  const controls = useStoreValue((s) => (s.project?.controls as LiveControl[] | undefined) ?? EMPTY_CONTROLS);
  // Derived via useMemo (not directly in the useSyncExternalStore selector)
  // because constructing a fresh `{ lane, device }` object on every
  // getSnapshot call would never satisfy Object.is and spin React into an
  // infinite update loop.
  const found = useMemo<FoundLane | undefined>(() => {
    for (const dev of devices) {
      const lane = dev.lanes.find((l) => l.id === laneId);
      if (lane) return { lane, device: dev };
    }
    return undefined;
  }, [devices, laneId]);
  const [activeToggles, setActiveToggles] = useState<Set<string>>(new Set());
  const [addPickerOpen, setAddPickerOpen] = useState(false);
  const [muteTargetPicker, setMuteTargetPicker] = useState(false);

  return (
    <div style={{ position: "fixed", inset: 0, top: TRANSPORT_H, background: "var(--pal-water-deep)", overflowY: "auto", padding: 16 }}>
      <Button variant="alt" style={{ width: 130, height: 40, fontSize: 17 }} onClick={onClose}>
        ← Back
      </Button>

      {!found ? (
        <div style={{ marginTop: 24, color: "var(--pal-text-dim)", fontSize: 18 }}>Lane no longer exists.</div>
      ) : (
        <>
          <div style={{ margin: "20px 0 4px", fontSize: 24, fontWeight: 700 }}>{found.lane.name}</div>
          <div style={{ fontSize: 13, color: "var(--pal-text-dim)", fontWeight: 600, marginBottom: found.lane.role === "cc" ? 4 : 20 }}>
            {found.lane.role.toUpperCase()}
          </div>
          {found.lane.role === "cc" && (
            <div style={{ fontSize: 13, color: "var(--pal-text-dim)", fontWeight: 600, marginBottom: 20 }}>
              {ccTargetLabel(found.lane, controls)}
            </div>
          )}

          {(found.lane.role === "melody" ||
            found.lane.role === "chord" ||
            found.lane.role === "arp" ||
            found.lane.role === "beat") && <LiveFxRow lane={found.lane} />}

          <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
            {(found.lane.controls ?? []).map((ctrl) => (
              <ControlTile
                key={ctrl.id}
                ctrl={ctrl}
                laneId={found.lane.id}
                active={activeToggles.has(ctrl.id)}
                onToggleActive={() =>
                  setActiveToggles((prev) => {
                    const next = new Set(prev);
                    if (next.has(ctrl.id)) next.delete(ctrl.id);
                    else next.add(ctrl.id);
                    return next;
                  })
                }
              />
            ))}
            <Button variant="alt" style={{ width: TILE_W, height: TILE_H, fontSize: 30 }} onClick={() => setAddPickerOpen(true)}>
              ＋
            </Button>
          </div>

          {addPickerOpen && (
            <AddControlPicker
              lane={found.lane}
              device={found.device}
              onClose={() => setAddPickerOpen(false)}
              onPickMuteButton={() => {
                setAddPickerOpen(false);
                setMuteTargetPicker(true);
              }}
            />
          )}

          {muteTargetPicker && (
            <MuteTargetPicker lane={found.lane} onClose={() => setMuteTargetPicker(false)} />
          )}
        </>
      )}
    </div>
  );
}

/** "Live FX": Beat-repeat/Scatter (hold) and Echo (toggle), always available
 *  on every note-producing lane — no need to add a control first. This is
 *  the "insert chain" for the live overlay effects: they already compose
 *  with each other and with Groove/Echo settings, so a quick surface to
 *  reach for them beats requiring setup ahead of time. Roll stays an
 *  addable custom control below (it needs a note picked, so it doesn't fit
 *  a zero-setup row). */
function LiveFxRow({ lane }: { lane: Lane }) {
  const send = useSend();
  const [repeatHeld, setRepeatHeld] = useState(false);
  const [scatterHeld, setScatterHeld] = useState(false);

  const fxBtn: React.CSSProperties = {
    width: 100,
    height: 56,
    borderRadius: 12,
    border: "1.5px solid rgba(255, 255, 255, 0.3)",
    fontSize: 13,
    fontWeight: 700,
    cursor: "pointer",
    touchAction: "none",
  };

  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ fontSize: 12, color: "var(--pal-text-dim)", marginBottom: 6 }}>Live FX</div>
      <div style={{ display: "flex", gap: 10 }}>
        <button
          type="button"
          aria-label="Beat repeat"
          style={{
            ...fxBtn,
            background: repeatHeld ? "var(--pal-btn-active)" : "var(--pal-btn)",
            color: repeatHeld ? "var(--pal-ink)" : "var(--pal-text)",
          }}
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            setRepeatHeld(true);
            send({ t: "lane.pressBeatRepeat", laneId: lane.id, steps: 2 });
          }}
          onPointerUp={() => {
            setRepeatHeld(false);
            send({ t: "lane.releaseBeatRepeat", laneId: lane.id });
          }}
          onPointerCancel={() => {
            setRepeatHeld(false);
            send({ t: "lane.releaseBeatRepeat", laneId: lane.id });
          }}
        >
          ▶▶ Repeat
        </button>
        <button
          type="button"
          aria-label="Scatter"
          style={{
            ...fxBtn,
            background: scatterHeld ? "var(--pal-btn-active)" : "var(--pal-btn)",
            color: scatterHeld ? "var(--pal-ink)" : "var(--pal-text)",
          }}
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            setScatterHeld(true);
            send({ t: "lane.pressScatter", laneId: lane.id });
          }}
          onPointerUp={() => {
            setScatterHeld(false);
            send({ t: "lane.releaseScatter", laneId: lane.id });
          }}
          onPointerCancel={() => {
            setScatterHeld(false);
            send({ t: "lane.releaseScatter", laneId: lane.id });
          }}
        >
          ✳ Scatter
        </button>
        <button
          type="button"
          aria-label="Echo"
          style={{
            ...fxBtn,
            background: lane.echo ? "var(--pal-btn-active)" : "var(--pal-btn)",
            color: lane.echo ? "var(--pal-ink)" : "var(--pal-text)",
          }}
          onClick={() =>
            send({
              t: "lane.setEcho",
              laneId: lane.id,
              echo: lane.echo ? null : { repeats: 3, rateDiv: 8, decay: 0.6 },
            })
          }
        >
          ~ Echo
        </button>
      </div>
    </div>
  );
}

function ControlTile({
  ctrl,
  laneId,
  active,
  onToggleActive,
}: {
  ctrl: LaneControl;
  laneId: string;
  active: boolean;
  onToggleActive: () => void;
}) {
  const send = useSend();
  const [pressed, setPressed] = useState(false);
  const dragRef = useRef<{ startY: number; startValue: number } | null>(null);
  // Der Macro-Knob hält keinen eigenen Wert — der lebt am verknüpften
  // Dashboard-Knob, damit beide Ansichten denselben Regler zeigen. Während des
  // Ziehens läuft `local` vorweg, weil `laneControl.setValue` bewusst keinen
  // Snapshot broadcastet (sonst ein Autosave pro Wert).
  const controls = useStoreValue((s) => (s.project?.controls as LiveControl[] | undefined) ?? EMPTY_CONTROLS);
  const target = ctrl.kind === "macroKnob" ? controls.find((c) => c.id === ctrl.controlId) : undefined;
  const [local, setLocal] = useState<number | null>(null);
  const macroValue = local ?? target?.value ?? 0;

  const isMacro = ctrl.kind === "macroKnob";
  // Beat-Repeat/Roll/Scatter kennen kein oneShot/toggle — Halten IST der
  // ganze Punkt.
  const momentary =
    ctrl.kind === "macroKnob"
      ? false
      : ctrl.kind === "beatRepeat" || ctrl.kind === "roll" || ctrl.kind === "scatter"
        ? true
        : ctrl.kind === "drumButton"
          ? ctrl.action === "trigger"
          : ctrl.trigger === "momentary";
  const isToggle =
    ctrl.kind !== "macroKnob" &&
    ctrl.kind !== "drumButton" &&
    ctrl.kind !== "beatRepeat" &&
    ctrl.kind !== "roll" &&
    ctrl.kind !== "scatter" &&
    ctrl.trigger === "toggle";
  const isActive = isMacro ? false : isToggle ? active : pressed;

  const tileProps: HTMLAttributes<HTMLDivElement> = {};
  if (isMacro) {
    tileProps.onPointerDown = (e) => {
      e.currentTarget.setPointerCapture(e.pointerId);
      dragRef.current = { startY: e.clientY, startValue: macroValue };
    };
    tileProps.onPointerMove = (e) => {
      if (!dragRef.current) return;
      const dy = dragRef.current.startY - e.clientY;
      const value = Math.min(127, Math.max(0, Math.round(dragRef.current.startValue + dy * 0.7)));
      setLocal(value);
      send({ t: "laneControl.setValue", laneId, controlId: ctrl.id, value });
    };
    const endDrag = () => {
      dragRef.current = null;
    };
    tileProps.onPointerUp = endDrag;
    tileProps.onPointerCancel = endDrag;
  } else if (momentary) {
    tileProps.onPointerDown = (e) => {
      e.currentTarget.setPointerCapture(e.pointerId);
      setPressed(true);
      send({ t: "laneControl.press", laneId, controlId: ctrl.id });
    };
    const release = () => {
      setPressed(false);
      send({ t: "laneControl.release", laneId, controlId: ctrl.id });
    };
    tileProps.onPointerUp = release;
    tileProps.onPointerCancel = release;
  } else if (isToggle) {
    tileProps.onClick = () => {
      send({ t: active ? "laneControl.release" : "laneControl.press", laneId, controlId: ctrl.id });
      onToggleActive();
    };
  } else {
    tileProps.onClick = () => send({ t: "laneControl.press", laneId, controlId: ctrl.id });
  }

  return (
    <div
      {...tileProps}
      style={{
        width: TILE_W,
        height: TILE_H,
        position: "relative",
        borderRadius: 12,
        background: isActive ? "var(--pal-btn-active)" : "var(--pal-btn)",
        border: "1.5px solid rgba(255, 255, 255, 0.3)",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        cursor: "pointer",
        color: isActive ? "var(--pal-ink)" : "var(--pal-text)",
        touchAction: "none",
      }}
    >
      <span style={{ fontSize: 14, fontWeight: 600 }}>{ctrl.label || ctrl.kind}</span>
      {isMacro && (
        <span style={{ fontSize: 12, marginTop: 6, color: isActive ? "var(--pal-ink)" : "var(--pal-text-dim)" }}>
          {target ? `${macroValue} · CC${target.mapping?.number}` : "unlinked"}
        </span>
      )}
      <button
        type="button"
        aria-label="Remove"
        onClick={(e) => {
          e.stopPropagation();
          send({ t: "laneControl.remove", laneId, controlId: ctrl.id });
        }}
        style={{
          position: "absolute",
          top: 2,
          right: 2,
          width: 20,
          height: 20,
          borderRadius: "50%",
          background: "var(--pal-danger)",
          color: "var(--pal-white)",
          fontSize: 10,
          fontWeight: 700,
          border: "none",
          cursor: "pointer",
        }}
      >
        ✕
      </button>
    </div>
  );
}

/** Schnell-Anlegen — rollenabhängig (siehe LaneRole → anlegbare Controls in
 *  ARCHITECTURE.md §4a). */
function AddControlPicker({
  lane,
  device,
  onClose,
  onPickMuteButton,
}: {
  lane: Lane;
  device: Device;
  onClose: () => void;
  onPickMuteButton: () => void;
}) {
  const send = useSend();
  const openNotePicker = useNotePicker();
  const numberEdit = useNumberEditor();
  const controls = useStoreValue((s) => (s.project?.controls as LiveControl[] | undefined) ?? EMPTY_CONTROLS);
  const projectBlocks = useStoreValue((s) => (s.project?.blocks as Block[] | undefined) ?? EMPTY_BLOCKS);
  const deviceKnobs = controls.filter(
    (c) => c.kind === "knob" && c.deviceId === device.id && c.mapping?.kind === "cc",
  );

  const rows: { text: string; onTap: () => void }[] = [];

  switch (lane.role) {
    case "melody":
    case "chord":
    case "arp":
      rows.push({
        text: "Add note",
        onTap: () => {
          onClose();
          openNotePicker(60, (note) =>
            send({
              t: "laneControl.add",
              laneId: lane.id,
              control: { kind: "note", label: noteName(note), note, velocity: 100, trigger: "momentary" },
            }),
          );
        },
      });
      break;
    case "beat": {
      rows.push({
        text: "Trigger note",
        onTap: () => {
          onClose();
          openNotePicker(36, (note) =>
            send({
              t: "laneControl.add",
              laneId: lane.id,
              control: { kind: "drumButton", label: noteName(note), action: "trigger", note, velocity: 100 },
            }),
          );
        },
      });
      const beatBlocks = projectBlocks.filter(
        (b: Block) => b.type === "beat" && lane.slots.some((s) => s.blockId === b.id),
      );
      if (beatBlocks.length > 0) {
        rows.push({ text: "Mute button", onTap: onPickMuteButton });
      }
      break;
    }
    case "cc":
      // Kein freies CC mehr: ein Macro-Knob fernsteuert einen gelernten Knob
      // DIESES Geräts. Eine frei getippte CC-Nummer hing an nichts — man konnte
      // sie am Regler ziehen und das Gerät reagierte nicht, ohne dass die UI
      // je verriet warum.
      for (const knob of deviceKnobs) {
        rows.push({
          text: `${knob.name || "(unnamed)"} — CC${knob.mapping?.number} ch${knob.mapping?.channel}`,
          onTap: () => {
            onClose();
            send({
              t: "laneControl.add",
              laneId: lane.id,
              control: { kind: "macroKnob", label: (knob.name || `CC${knob.mapping?.number}`).slice(0, 8), controlId: knob.id },
            });
          },
        });
      }
      break;
    case "programChange":
      rows.push({
        text: "Program button",
        onTap: () => {
          onClose();
          numberEdit(0, 0, 127, (program) =>
            send({
              t: "laneControl.add",
              laneId: lane.id,
              control: {
                kind: "midiSignal",
                label: `PC${program}`,
                message: { atStep: 0, kind: "programChange", data1: program },
                trigger: "oneShot",
              },
            }),
          );
        },
      });
      break;
    case "patternShift":
      rows.push({
        text: "Pattern button (CC number)",
        onTap: () => {
          onClose();
          numberEdit(0, 0, 127, (cc) =>
            send({
              t: "laneControl.add",
              laneId: lane.id,
              control: {
                kind: "midiSignal",
                label: `CC${cc}`,
                message: { atStep: 0, kind: "cc", data1: cc, data2: 127 },
                trigger: "oneShot",
              },
            }),
          );
        },
      });
      break;
  }

  // Beat-repeat/stutter: hold to loop the last N steps of whatever's playing
  // on this lane. Makes sense for anything with steppable note content —
  // not for cc/programChange/patternShift, which have no "steps" to loop.
  if (lane.role === "melody" || lane.role === "chord" || lane.role === "arp" || lane.role === "beat") {
    rows.push({
      text: "Beat repeat",
      onTap: () => {
        onClose();
        numberEdit(1, 1, 16, (steps) =>
          send({
            t: "laneControl.add",
            laneId: lane.id,
            control: { kind: "beatRepeat", label: `Rpt ${steps}`, steps },
          }),
        );
      },
    });
    // Manual roll: hold to retrigger ONE note at a fixed rate, independent
    // of the pattern's own steps — a finger-drumming roll/snare fill.
    rows.push({
      text: "Roll",
      onTap: () => {
        onClose();
        openNotePicker(lane.role === "beat" ? 36 : 60, (note) =>
          numberEdit(4, 1, 16, (rateDiv) =>
            send({
              t: "laneControl.add",
              laneId: lane.id,
              control: { kind: "roll", label: `Roll ${noteName(note)}`, note, velocity: 100, rateDiv },
            }),
          ),
        );
      },
    });
    // Scatter/glitch: hold to make every step read a random step's content
    // instead of its own — timing stays on the grid, only content glitches.
    rows.push({
      text: "Scatter",
      onTap: () => {
        onClose();
        send({ t: "laneControl.add", laneId: lane.id, control: { kind: "scatter", label: "Scatter" } });
      },
    });
  }

  return (
    <Popup onClose={onClose}>
      <div className="popup-title">Add control</div>
      {rows.length === 0 ? (
        <div style={{ color: "var(--pal-text-dim)", fontSize: 15 }}>
          {lane.role === "cc"
            ? "No knobs learned for this device yet — turn one on the device with MIDI-Learn armed on the Dashboard."
            : "Nothing to add for this lane type yet."}
        </div>
      ) : (
        rows.map((r) => (
          <Button key={r.text} className="popup-row" onClick={r.onTap}>
            {r.text}
          </Button>
        ))
      )}
    </Popup>
  );
}

function MuteTargetPicker({ lane, onClose }: { lane: Lane; onClose: () => void }) {
  const send = useSend();
  const projectBlocks = useStoreValue((s) => (s.project?.blocks as Block[] | undefined) ?? EMPTY_BLOCKS);
  const beatBlocks = projectBlocks.filter(
    (b: Block) => b.type === "beat" && lane.slots.some((s) => s.blockId === b.id),
  );

  return (
    <Popup onClose={onClose}>
      <div className="popup-title">Choose beat line</div>
      {beatBlocks.map((b) =>
        (b.lines ?? []).map((line) => (
          <Button
            key={line.id}
            className="popup-row"
            onClick={() => {
              onClose();
              send({
                t: "laneControl.add",
                laneId: lane.id,
                control: {
                  kind: "drumButton",
                  label: line.name.slice(0, 8),
                  action: "muteToggle",
                  note: line.note,
                  velocity: 100,
                  targetBlockId: b.id,
                  targetLineId: line.id,
                },
              });
            }}
          >
            {b.name} / {line.name}
          </Button>
        )),
      )}
    </Popup>
  );
}
