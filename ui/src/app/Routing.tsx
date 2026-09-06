//! Routing Hub — externe Controller on-the-fly auf Devices routen (architecture
//! doc §4b). Drei Bereiche: Sources (physische MIDI-Eingänge), Routes (Quelle
//! → Device mit Filter/Transform) und Scenes (auf Knopfdruck eine bestimmte
//! Routen-Menge scharfschalten — "alle Controller → Synth B" ohne Kabel/
//! Re-Learn). Die eigentliche Weiterleitung läuft komplett serverseitig
//! (`AppState::forward_via_routing` in server/src/state.rs, angestoßen für
//! JEDE eingehende MIDI-Nachricht) — diese Seite verwaltet nur die
//! Konfiguration.

import { useState, type CSSProperties } from "react";
import type { CcRemapEntry, Device, MidiInputSource, MidiMessageKind, MidiRoute, RouteTransform, RoutingHub, RoutingScene } from "../state";
import { useSend, useStoreValue } from "./store";
import { useTouchKeyboard } from "./TouchKeyboard";
import { useNumberEditor } from "./useNumberEditor";
import { Button } from "./widgets/Button";
import { Popup } from "./widgets/Popup";
import { TRANSPORT_H } from "./layout";

const EMPTY_SOURCES: MidiInputSource[] = [];
const EMPTY_ROUTES: MidiRoute[] = [];
const EMPTY_SCENES: RoutingScene[] = [];
const EMPTY_DEVICES: Device[] = [];
const EMPTY_INPUTS: string[] = [];

export function Routing() {
  const [tab, setTab] = useState<"sources" | "routes" | "scenes">("sources");

  return (
    <div style={{ position: "fixed", top: TRANSPORT_H, left: 0, right: 0, bottom: 0, overflowY: "auto", padding: 16 }}>
      <div className="popup-title">Routing Hub</div>
      <div style={{ fontSize: 13, color: "var(--pal-text-dim)", marginBottom: 16 }}>
        Route external controllers to any device live, with remapping — no cable swap, no re-learning.
      </div>

      <div style={{ display: "flex", gap: 6, marginBottom: 16 }}>
        {(["sources", "routes", "scenes"] as const).map((t) => (
          <Button
            key={t}
            variant={tab === t ? "active" : "alt"}
            style={{ width: 100, height: 38, fontSize: 14 }}
            onClick={() => setTab(t)}
          >
            {t[0].toUpperCase() + t.slice(1)}
          </Button>
        ))}
      </div>

      {tab === "sources" && <SourcesTab />}
      {tab === "routes" && <RoutesTab />}
      {tab === "scenes" && <ScenesTab />}
    </div>
  );
}

function SourcesTab() {
  const send = useSend();
  const openKeyboard = useTouchKeyboard();
  const sources = useStoreValue((s) => (s.project?.routing as RoutingHub | undefined)?.sources ?? EMPTY_SOURCES);
  const midiInputs = useStoreValue((s) => s.midiInputs ?? EMPTY_INPUTS);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);

  const usedPorts = new Set(sources.map((s) => s.port));
  const availablePorts = midiInputs.filter((p) => !usedPorts.has(p));

  return (
    <div>
      <Button
        style={{ width: "100%", height: 50, fontSize: 16, marginBottom: 16 }}
        disabled={availablePorts.length === 0}
        onClick={() => setPickerOpen(true)}
      >
        {availablePorts.length === 0 ? "+ Add source (no free MIDI inputs)" : "+ Add source"}
      </Button>

      {sources.length === 0 && <div style={{ color: "var(--pal-text-dim)", fontSize: 15 }}>No sources yet.</div>}

      {sources.map((src) => (
        <div key={src.id} className="settings-card" style={{ marginBottom: 10, display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 15, fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {src.name}
            </div>
            <div style={{ fontSize: 12, color: "var(--pal-text-dim)" }}>
              {src.port}
              {src.channelFilter ? ` · Ch${src.channelFilter} only` : ""}
            </div>
          </div>
          <Button
            style={{ height: 40, padding: "0 14px", fontSize: 13 }}
            onClick={() => openKeyboard(src.name, 20, (v) => v && send({ t: "routing.updateSource", source: { ...src, name: v } }))}
          >
            Rename
          </Button>
          {confirmingDelete === src.id ? (
            <Button
              variant="danger"
              style={{ height: 40 }}
              onClick={() => {
                setConfirmingDelete(null);
                send({ t: "routing.removeSource", sourceId: src.id });
              }}
            >
              Confirm
            </Button>
          ) : (
            <button type="button" aria-label="Delete source" style={deleteBadge} onClick={() => setConfirmingDelete(src.id)}>
              ✕
            </button>
          )}
        </div>
      ))}

      {pickerOpen && (
        <Popup onClose={() => setPickerOpen(false)}>
          <div className="popup-title">Add source</div>
          {availablePorts.length === 0 ? (
            <div style={{ color: "var(--pal-text-dim)", fontSize: 15 }}>No free MIDI inputs — plug in a controller.</div>
          ) : (
            availablePorts.map((port) => (
              <Button
                key={port}
                className="popup-row"
                onClick={() => {
                  setPickerOpen(false);
                  send({ t: "routing.addSource", source: { id: "", name: port, port } });
                }}
              >
                {port}
              </Button>
            ))
          )}
        </Popup>
      )}
    </div>
  );
}

function RoutesTab() {
  const send = useSend();
  const openKeyboard = useTouchKeyboard();
  const routing = useStoreValue((s) => s.project?.routing as RoutingHub | undefined);
  const routes = routing?.routes ?? EMPTY_ROUTES;
  const sources = routing?.sources ?? EMPTY_SOURCES;
  const devices = useStoreValue((s) => s.project?.devices ?? EMPTY_DEVICES);
  const [addPickerOpen, setAddPickerOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);

  const sourceName = (id: string) => sources.find((s) => s.id === id)?.name ?? "?";
  const deviceName = (id: string) => devices.find((d) => d.id === id)?.name ?? "?";

  return (
    <div>
      <Button
        style={{ width: "100%", height: 50, fontSize: 16, marginBottom: 16 }}
        disabled={sources.length === 0 || devices.length === 0}
        onClick={() => setAddPickerOpen(true)}
      >
        {sources.length === 0
          ? "+ Add route (add a source first)"
          : devices.length === 0
            ? "+ Add route (add a device first)"
            : "+ Add route"}
      </Button>

      {routes.length === 0 && <div style={{ color: "var(--pal-text-dim)", fontSize: 15 }}>No routes yet.</div>}

      {routes.map((route) => (
        <div key={route.id} className="settings-card" style={{ marginBottom: 10 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <Button
              variant={route.enabled ? "active" : "alt"}
              style={{ flex: 1, height: 50, fontSize: 14, justifyContent: "flex-start", paddingLeft: 14, textAlign: "left" }}
              onClick={() => send({ t: "routing.setRouteEnabled", routeId: route.id, enabled: !route.enabled })}
            >
              <span>
                <span style={{ display: "block", fontWeight: 700 }}>{route.name}</span>
                <span style={{ display: "block", fontSize: 11, opacity: 0.8 }}>
                  {sourceName(route.sourceId)} → {deviceName(route.transform.deviceId)}
                </span>
              </span>
            </Button>
            <Button
              style={{ width: 64, height: 50, fontSize: 13 }}
              onClick={() => setEditingId(editingId === route.id ? null : route.id)}
            >
              {editingId === route.id ? "Close" : "Edit"}
            </Button>
          </div>

          {editingId === route.id && (
            <>
              <RouteEditor
                route={route}
                devices={devices}
                onRename={() =>
                  openKeyboard(route.name, 20, (v) => v && send({ t: "routing.updateRoute", route: { ...route, name: v } }))
                }
              />
              {confirmingDelete === route.id ? (
                <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                  <Button
                    variant="danger"
                    style={{ flex: 1, height: 40 }}
                    onClick={() => {
                      setConfirmingDelete(null);
                      setEditingId(null);
                      send({ t: "routing.removeRoute", routeId: route.id });
                    }}
                  >
                    Confirm delete
                  </Button>
                  <Button style={{ flex: 1, height: 40 }} onClick={() => setConfirmingDelete(null)}>
                    Cancel
                  </Button>
                </div>
              ) : (
                <Button variant="danger" style={{ width: "100%", height: 40, marginTop: 12 }} onClick={() => setConfirmingDelete(route.id)}>
                  Delete route
                </Button>
              )}
            </>
          )}
        </div>
      ))}

      {addPickerOpen && <AddRoutePopup sources={sources} devices={devices} onClose={() => setAddPickerOpen(false)} />}
    </div>
  );
}

function AddRoutePopup({ sources, devices, onClose }: { sources: MidiInputSource[]; devices: Device[]; onClose: () => void }) {
  const send = useSend();
  const [sourceId, setSourceId] = useState<string | null>(null);

  if (!sourceId) {
    return (
      <Popup onClose={onClose}>
        <div className="popup-title">Add route — pick a source</div>
        {sources.map((s) => (
          <Button key={s.id} className="popup-row" onClick={() => setSourceId(s.id)}>
            {s.name}
          </Button>
        ))}
      </Popup>
    );
  }

  return (
    <Popup onClose={onClose}>
      <div className="popup-title">Add route — pick a target device</div>
      {devices.map((d) => (
        <Button
          key={d.id}
          className="popup-row"
          onClick={() => {
            onClose();
            const route: MidiRoute = {
              id: "",
              name: d.name,
              enabled: true,
              sourceId,
              messageFilter: "all",
              transform: { deviceId: d.id },
            };
            send({ t: "routing.addRoute", route });
          }}
        >
          {d.name}
        </Button>
      ))}
    </Popup>
  );
}

const ALL_KINDS: MidiMessageKind[] = ["note", "cc", "pitchBend", "aftertouch", "programChange"];
const KIND_LABEL: Record<MidiMessageKind, string> = {
  note: "Note",
  cc: "CC",
  pitchBend: "Pitch bend",
  aftertouch: "Aftertouch",
  programChange: "Prog change",
};

function RouteEditor({ route, devices, onRename }: { route: MidiRoute; devices: Device[]; onRename: () => void }) {
  const send = useSend();
  const numberEdit = useNumberEditor();

  const update = (patch: Partial<MidiRoute>) => send({ t: "routing.updateRoute", route: { ...route, ...patch } });
  const updateTransform = (patch: Partial<RouteTransform>) => update({ transform: { ...route.transform, ...patch } });

  const filter = route.messageFilter;
  const isAll = filter === "all";
  const ccRemap = route.transform.ccRemap ?? [];

  return (
    <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <div style={{ flex: 1, fontSize: 13 }}>Name</div>
        <Button style={{ height: 36, padding: "0 12px", fontSize: 13 }} onClick={onRename}>
          {route.name}
        </Button>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <div style={{ flex: 1, fontSize: 13 }}>Target device</div>
        <span style={{ fontSize: 13, fontWeight: 700 }}>{devices.find((d) => d.id === route.transform.deviceId)?.name ?? "?"}</span>
      </div>

      <div>
        <div style={{ fontSize: 12, color: "var(--pal-text-dim)", marginBottom: 4 }}>Messages</div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          <Button variant={isAll ? "active" : "alt"} style={{ height: 34, padding: "0 12px", fontSize: 12 }} onClick={() => update({ messageFilter: "all" })}>
            All
          </Button>
          {ALL_KINDS.map((k) => {
            const active = !isAll && Array.isArray(filter) && filter.includes(k);
            return (
              <Button
                key={k}
                variant={active ? "active" : "alt"}
                style={{ height: 34, padding: "0 12px", fontSize: 12 }}
                onClick={() => {
                  const cur = isAll ? [] : (filter as MidiMessageKind[]);
                  const next = cur.includes(k) ? cur.filter((x) => x !== k) : [...cur, k];
                  update({ messageFilter: next.length === 0 ? "all" : next });
                }}
              >
                {KIND_LABEL[k]}
              </Button>
            );
          })}
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <div style={{ flex: 1, fontSize: 13 }}>Channel remap</div>
        <Button
          style={{ height: 36, padding: "0 12px", fontSize: 13, minWidth: 50 }}
          onClick={() => numberEdit(route.transform.channel ?? 1, 1, 16, (v) => updateTransform({ channel: v }))}
        >
          {route.transform.channel ?? "—"}
        </Button>
        {route.transform.channel != null && (
          <button type="button" aria-label="Clear channel remap" style={smallClearBtn} onClick={() => updateTransform({ channel: undefined })}>
            ↺
          </button>
        )}
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <div style={{ flex: 1, fontSize: 13 }}>Note transpose</div>
        <Button
          style={{ height: 36, padding: "0 12px", fontSize: 13, minWidth: 50 }}
          onClick={() => numberEdit(route.transform.noteTranspose ?? 0, -48, 48, (v) => updateTransform({ noteTranspose: v || undefined }))}
        >
          {route.transform.noteTranspose ? `${route.transform.noteTranspose > 0 ? "+" : ""}${route.transform.noteTranspose}` : "0"}
        </Button>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <div style={{ flex: 1, fontSize: 13 }}>Velocity scale</div>
        <Button
          style={{ height: 36, padding: "0 12px", fontSize: 13, minWidth: 50 }}
          onClick={() =>
            numberEdit(Math.round((route.transform.velocityScale ?? 1) * 100), 0, 200, (v) =>
              updateTransform({ velocityScale: v === 100 ? undefined : v / 100 }),
            )
          }
        >
          {Math.round((route.transform.velocityScale ?? 1) * 100)}%
        </Button>
      </div>

      <div>
        <div style={{ fontSize: 12, color: "var(--pal-text-dim)", marginBottom: 4 }}>CC remap</div>
        {ccRemap.map((entry: CcRemapEntry, i: number) => (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
            <span style={{ fontSize: 13 }}>
              CC{entry.from} → CC{entry.to}
            </span>
            <button
              type="button"
              aria-label="Remove CC remap"
              style={smallClearBtn}
              onClick={() => updateTransform({ ccRemap: ccRemap.filter((_, j) => j !== i) })}
            >
              ✕
            </button>
          </div>
        ))}
        <Button
          style={{ height: 34, padding: "0 12px", fontSize: 12 }}
          onClick={() =>
            numberEdit(1, 0, 127, (from) =>
              numberEdit(1, 0, 127, (to) => updateTransform({ ccRemap: [...ccRemap, { from, to }] })),
            )
          }
        >
          + CC remap
        </Button>
      </div>
    </div>
  );
}

function ScenesTab() {
  const send = useSend();
  const openKeyboard = useTouchKeyboard();
  const routing = useStoreValue((s) => s.project?.routing as RoutingHub | undefined);
  const scenes = routing?.scenes ?? EMPTY_SCENES;
  const routes = routing?.routes ?? EMPTY_ROUTES;
  const activeSceneId = routing?.activeSceneId;
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);

  return (
    <div>
      <Button
        style={{ width: "100%", height: 50, fontSize: 16, marginBottom: 8 }}
        disabled={routes.length === 0}
        onClick={() => openKeyboard("", 20, (v) => v && send({ t: "routing.saveScene", name: v }))}
      >
        + Save current routing as scene
      </Button>
      <div style={{ fontSize: 12, color: "var(--pal-text-dim)", marginBottom: 16 }}>
        Captures which routes are currently on. Activating a scene later switches to EXACTLY that set — everything else
        turns off.
      </div>

      {scenes.length === 0 && <div style={{ color: "var(--pal-text-dim)", fontSize: 15 }}>No routing scenes yet.</div>}

      {scenes.map((scene) => (
        <div key={scene.id} className="settings-card" style={{ marginBottom: 10, display: "flex", alignItems: "center", gap: 10 }}>
          <Button
            variant={activeSceneId === scene.id ? "active" : undefined}
            style={{ flex: 1, height: 50, fontSize: 15, fontWeight: 700 }}
            onClick={() => send({ t: "routing.activateScene", sceneId: scene.id })}
          >
            ▶ {scene.name}
          </Button>
          {confirmingDelete === scene.id ? (
            <Button
              variant="danger"
              style={{ height: 50 }}
              onClick={() => {
                setConfirmingDelete(null);
                send({ t: "routing.deleteScene", sceneId: scene.id });
              }}
            >
              Confirm
            </Button>
          ) : (
            <button type="button" aria-label="Delete scene" style={deleteBadge} onClick={() => setConfirmingDelete(scene.id)}>
              ✕
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

const deleteBadge: CSSProperties = {
  width: 32,
  height: 32,
  borderRadius: "50%",
  border: "none",
  background: "var(--pal-danger)",
  color: "var(--pal-white)",
  fontSize: 14,
  fontWeight: 700,
  cursor: "pointer",
};

const smallClearBtn: CSSProperties = {
  width: 28,
  height: 28,
  border: "none",
  borderRadius: "50%",
  background: "var(--pal-btn-alt)",
  color: "var(--pal-text)",
  fontSize: 13,
  fontWeight: 700,
  cursor: "pointer",
};
