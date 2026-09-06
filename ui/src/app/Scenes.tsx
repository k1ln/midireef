//! Scenes — mehrere Lanes/Devices mit einem Touch starten/stoppen (architecture
//! doc §4c/§5.6). Eine Scene ist eine Momentaufnahme: pro Ziel-Lane entweder
//! "diesen Slot triggern" (ohne slotId: aktueller/erster Slot) oder "diese Lane
//! stoppen". `scene.trigger` feuert sie serverseitig über den Clock-Thread
//! (`Engine::fire_scene_target` in server/src/engine.rs) — dieselbe Quantisierung
//! wie ein normaler Touch auf eine Kachel gilt pro Ziel-Lane individuell.
//!
//! Bewusst eine flache Liste statt eines 9×9-Rasters wie die Block-Bibliothek:
//! Scenes sind wenige, benannte Dinge zum Antippen während des Spielens, keine
//! große Sammlung.

import { useState } from "react";
import type { Device, Block, Scene, SceneTarget } from "../state";
import { useSend, useStoreValue } from "./store";
import { useTouchKeyboard } from "./TouchKeyboard";
import { Button } from "./widgets/Button";
import { Popup } from "./widgets/Popup";
import { TRANSPORT_H } from "./layout";
import { Songs } from "./Songs";

const EMPTY_SCENES: Scene[] = [];
const EMPTY_DEVICES: Device[] = [];
const EMPTY_BLOCKS: Block[] = [];

/** Ein Screen, zwei Tabs (architecture doc §5.6: "Scenes & Song" ist EIN
 *  Eintrag in der Screen-Liste) — Song baut direkt auf Scenes auf, es lohnt
 *  sich also nicht, sie als getrennte Top-Level-Views zu führen. */
export function Scenes() {
  const [tab, setTab] = useState<"scenes" | "song">("scenes");

  return (
    <div
      style={{
        position: "fixed",
        top: TRANSPORT_H,
        left: 0,
        right: 0,
        bottom: 0,
        overflowY: "auto",
        padding: 16,
      }}
    >
      <div className="popup-title">Scenes &amp; Song</div>

      <div style={{ display: "flex", gap: 6, marginBottom: 16 }}>
        <Button
          variant={tab === "scenes" ? "active" : "alt"}
          style={{ width: 120, height: 38, fontSize: 14 }}
          onClick={() => setTab("scenes")}
        >
          Scenes
        </Button>
        <Button
          variant={tab === "song" ? "active" : "alt"}
          style={{ width: 120, height: 38, fontSize: 14 }}
          onClick={() => setTab("song")}
        >
          Song
        </Button>
      </div>

      {tab === "scenes" ? <ScenesTab /> : <Songs />}
    </div>
  );
}

function ScenesTab() {
  const send = useSend();
  const openKeyboard = useTouchKeyboard();
  const scenes = useStoreValue((s) => (s.project?.scenes as Scene[] | undefined) ?? EMPTY_SCENES);
  const devices = useStoreValue((s) => s.project?.devices ?? EMPTY_DEVICES);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  const [pickerFor, setPickerFor] = useState<string | null>(null);

  const laneById = (id: string) => devices.flatMap((d) => d.lanes ?? []).find((l) => l.id === id);
  const deviceOfLane = (id: string) => devices.find((d) => (d.lanes ?? []).some((l) => l.id === id));

  return (
    <div>
      <div style={{ fontSize: 13, color: "var(--pal-text-dim)", marginBottom: 16 }}>
        Fire several lanes across devices with one touch. Tap a scene to play it, tap “Edit” to change what it does.
      </div>

      <Button
        style={{ width: "100%", height: 50, fontSize: 16, marginBottom: 16 }}
        onClick={() => openKeyboard("", 24, (v) => v && send({ t: "scene.create", name: v }))}
      >
        + New scene
      </Button>

      {scenes.length === 0 && <div style={{ color: "var(--pal-text-dim)", fontSize: 15 }}>No scenes yet.</div>}

      {scenes.map((scene) => (
        <div key={scene.id} className="settings-card" style={{ marginBottom: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Button
              style={{ flex: 1, height: 54, fontSize: 17, fontWeight: 700 }}
              onClick={() => send({ t: "scene.trigger", sceneId: scene.id })}
            >
              ▶ {scene.name}
            </Button>
            <Button
              style={{ width: 64, height: 54, fontSize: 13 }}
              onClick={() => setExpanded(expanded === scene.id ? null : scene.id)}
            >
              {expanded === scene.id ? "Close" : "Edit"}
            </Button>
          </div>

          {expanded === scene.id && (
            <div style={{ marginTop: 12 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
                <div style={{ flex: 1, fontSize: 14 }}>Name</div>
                <Button
                  style={{ height: 40, padding: "0 14px", fontSize: 14 }}
                  onClick={() =>
                    openKeyboard(scene.name, 24, (v) => v != null && send({ t: "scene.update", scene: { ...scene, name: v } }))
                  }
                >
                  {scene.name}
                </Button>
              </div>

              {scene.targets.length === 0 && (
                <div style={{ color: "var(--pal-text-dim)", fontSize: 13, marginBottom: 10 }}>
                  No targets yet — add one below.
                </div>
              )}
              {scene.targets.map((t, i) => {
                const lane = laneById(t.laneId);
                const dev = deviceOfLane(t.laneId);
                return (
                  <div
                    key={i}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      background: "var(--pal-panel-deep)",
                      borderRadius: 8,
                      padding: "8px 10px",
                      marginBottom: 6,
                    }}
                  >
                    <div>
                      <div style={{ fontSize: 14, fontWeight: 600 }}>
                        {t.action === "stop" ? "■ Stop" : "▶ Trigger"} {lane?.name ?? "?"}
                      </div>
                      <div style={{ fontSize: 11, color: "var(--pal-text-dim)" }}>
                        {dev?.name ?? "?"}
                        {t.action === "trigger" && !t.slotId ? " · current/first slot" : ""}
                      </div>
                    </div>
                    <button
                      type="button"
                      aria-label="Remove target"
                      style={{
                        width: 26,
                        height: 26,
                        borderRadius: "50%",
                        border: "none",
                        background: "var(--pal-danger)",
                        color: "var(--pal-white)",
                        fontSize: 12,
                        fontWeight: 700,
                        cursor: "pointer",
                      }}
                      onClick={() => {
                        const targets = scene.targets.filter((_, j) => j !== i);
                        send({ t: "scene.update", scene: { ...scene, targets } });
                      }}
                    >
                      ✕
                    </button>
                  </div>
                );
              })}

              <Button style={{ width: "100%", height: 42, fontSize: 14, marginTop: 4 }} onClick={() => setPickerFor(scene.id)}>
                + Add target
              </Button>

              {confirmingDelete === scene.id ? (
                <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                  <Button
                    variant="danger"
                    style={{ flex: 1, height: 42 }}
                    onClick={() => {
                      setConfirmingDelete(null);
                      setExpanded(null);
                      send({ t: "scene.delete", sceneId: scene.id });
                    }}
                  >
                    Confirm delete
                  </Button>
                  <Button style={{ flex: 1, height: 42 }} onClick={() => setConfirmingDelete(null)}>
                    Cancel
                  </Button>
                </div>
              ) : (
                <Button
                  variant="danger"
                  style={{ width: "100%", height: 42, fontSize: 14, marginTop: 12 }}
                  onClick={() => setConfirmingDelete(scene.id)}
                >
                  Delete scene
                </Button>
              )}
            </div>
          )}
        </div>
      ))}

      {pickerFor &&
        (() => {
          const scene = scenes.find((s) => s.id === pickerFor);
          return scene ? <AddSceneTargetPopup scene={scene} onClose={() => setPickerFor(null)} /> : null;
        })()}
    </div>
  );
}

/** Popup zum Hinzufügen EINES Scene-Targets: entweder einen konkreten Slot
 *  triggern (Gerät › Lane › Slot, wie `ChainSlotPickerPopup`) oder eine ganze
 *  Lane stoppen. */
function AddSceneTargetPopup({ scene, onClose }: { scene: Scene; onClose: () => void }) {
  const send = useSend();
  const devices = useStoreValue((s) => s.project?.devices ?? EMPTY_DEVICES);
  const blocks = useStoreValue((s) => (s.project?.blocks as Block[] | undefined) ?? EMPTY_BLOCKS);
  const blockName = (id?: string) => {
    const b = blocks.find((x) => x.id === id);
    if (!b) return "?";
    const slot = b.slot ? `${b.slot.row}-${b.slot.col}` : "?";
    return `${slot} ${b.name || ""}`.trim();
  };

  const addTarget = (target: SceneTarget) => {
    onClose();
    send({ t: "scene.update", scene: { ...scene, targets: [...scene.targets, target] } });
  };

  const laneRows = devices.flatMap((d) => (d.lanes ?? []).map((l) => ({ dev: d, lane: l })));
  const slotRows = laneRows.flatMap(({ dev, lane }) => (lane.slots ?? []).map((s) => ({ dev, lane, slot: s })));

  return (
    <Popup onClose={onClose}>
      <div className="popup-title">Add target — {scene.name}</div>

      <div style={{ fontSize: 13, fontWeight: 700, marginTop: 4, marginBottom: 6 }}>Trigger a slot</div>
      {slotRows.length === 0 ? (
        <div style={{ color: "var(--pal-text-dim)", fontSize: 13, marginBottom: 12 }}>No slots yet.</div>
      ) : (
        slotRows.map(({ dev, lane, slot }) => (
          <Button
            key={slot.id}
            className="popup-row"
            style={{ height: 44, marginBottom: 6, flexDirection: "column", alignItems: "flex-start", paddingLeft: 12 }}
            onClick={() => addTarget({ laneId: lane.id, action: "trigger", slotId: slot.id })}
          >
            <span style={{ fontWeight: 700 }}>
              {lane.name} · {blockName(slot.blockId)}
            </span>
            <span style={{ fontSize: 11, color: "var(--pal-text-dim)" }}>{dev.name}</span>
          </Button>
        ))
      )}

      <div style={{ fontSize: 13, fontWeight: 700, marginTop: 14, marginBottom: 6 }}>Stop a lane</div>
      {laneRows.length === 0 ? (
        <div style={{ color: "var(--pal-text-dim)", fontSize: 13 }}>No lanes yet.</div>
      ) : (
        laneRows.map(({ dev, lane }) => (
          <Button
            key={lane.id}
            variant="danger"
            className="popup-row"
            style={{ height: 40, marginBottom: 6 }}
            onClick={() => addTarget({ laneId: lane.id, action: "stop" })}
          >
            {lane.name} <span style={{ fontSize: 11, opacity: 0.8, marginLeft: 6 }}>{dev.name}</span>
          </Button>
        ))
      )}
    </Popup>
  );
}
