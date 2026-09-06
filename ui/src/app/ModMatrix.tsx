//! Mod-Matrix — globale Modulatoren (taktsynchrone LFOs), unabhängig von
//! jeder Lane, jeweils auf mehrere CC-Ziele gleichzeitig routbar (architecture
//! doc §4c). Das IST zugleich der "Multi-Parameter-Macro-Knob": ein
//! Modulator routet auf beliebig viele (Device, Kanal, CC)-Ziele mit je
//! eigener Tiefe. Läuft serverseitig immer mit
//! (`Engine::eval_global_modulators` in engine.rs, CC zentriert um 64,
//! skaliert mit der Tiefe) — diese Seite verwaltet nur die Konfiguration.

import { useState, type CSSProperties } from "react";
import type { Device, GlobalModulator, LfoWaveform, ModRoute } from "../state";
import { useSend, useStoreValue } from "./store";
import { useTouchKeyboard } from "./TouchKeyboard";
import { useNumberEditor } from "./useNumberEditor";
import { Button } from "./widgets/Button";
import { Popup } from "./widgets/Popup";
import { TRANSPORT_H } from "./layout";

const EMPTY_MODULATORS: GlobalModulator[] = [];
const EMPTY_ROUTES: ModRoute[] = [];
const EMPTY_DEVICES: Device[] = [];

const WAVEFORMS: LfoWaveform[] = ["sine", "triangle", "sawUp", "sawDown", "square"];

export function ModMatrix() {
  const send = useSend();
  const openKeyboard = useTouchKeyboard();
  const numberEdit = useNumberEditor();
  const modulators = useStoreValue((s) => (s.project?.modulators as GlobalModulator[] | undefined) ?? EMPTY_MODULATORS);
  const routes = useStoreValue((s) => (s.project?.modRoutes as ModRoute[] | undefined) ?? EMPTY_ROUTES);
  const devices = useStoreValue((s) => s.project?.devices ?? EMPTY_DEVICES);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  const [addTargetFor, setAddTargetFor] = useState<string | null>(null);

  const deviceName = (id: string) => devices.find((d) => d.id === id)?.name ?? "?";

  return (
    <div style={{ position: "fixed", top: TRANSPORT_H, left: 0, right: 0, bottom: 0, overflowY: "auto", padding: 16 }}>
      <div className="popup-title">Mod-Matrix</div>
      <div style={{ fontSize: 13, color: "var(--pal-text-dim)", marginBottom: 16 }}>
        Global LFOs, each routable to several CC targets at once — a multi-parameter macro. Runs continuously, no lane
        needed.
      </div>

      <Button
        style={{ width: "100%", height: 50, fontSize: 16, marginBottom: 16 }}
        onClick={() =>
          openKeyboard("", 20, (v) => {
            if (!v) return;
            const modulator: GlobalModulator = { id: "", name: v, waveform: "sine", rateBars: 4, phase: 0, bipolar: true };
            send({ t: "mod.addModulator", modulator });
          })
        }
      >
        + New modulator
      </Button>

      {modulators.length === 0 && <div style={{ color: "var(--pal-text-dim)", fontSize: 15 }}>No modulators yet.</div>}

      {modulators.map((mod) => {
        const modRoutes = routes.filter((r) => r.modulatorId === mod.id);
        return (
          <div key={mod.id} className="settings-card" style={{ marginBottom: 12 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 16, fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {mod.name}
                </div>
                <div style={{ fontSize: 12, color: "var(--pal-text-dim)" }}>
                  {mod.waveform} · {mod.rateBars} bar{mod.rateBars === 1 ? "" : "s"} · {modRoutes.length} target
                  {modRoutes.length === 1 ? "" : "s"}
                </div>
              </div>
              <Button
                style={{ width: 64, height: 50, fontSize: 13 }}
                onClick={() => setExpanded(expanded === mod.id ? null : mod.id)}
              >
                {expanded === mod.id ? "Close" : "Edit"}
              </Button>
            </div>

            {expanded === mod.id && (
              <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 10 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <div style={{ flex: 1, fontSize: 13 }}>Name</div>
                  <Button
                    style={{ height: 36, padding: "0 12px", fontSize: 13 }}
                    onClick={() => openKeyboard(mod.name, 20, (v) => v && send({ t: "mod.updateModulator", modulator: { ...mod, name: v } }))}
                  >
                    {mod.name}
                  </Button>
                </div>

                <div>
                  <div style={{ fontSize: 12, color: "var(--pal-text-dim)", marginBottom: 4 }}>Waveform</div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                    {WAVEFORMS.map((w) => (
                      <Button
                        key={w}
                        variant={mod.waveform === w ? "active" : "alt"}
                        style={{ height: 34, padding: "0 12px", fontSize: 12 }}
                        onClick={() => send({ t: "mod.updateModulator", modulator: { ...mod, waveform: w } })}
                      >
                        {w}
                      </Button>
                    ))}
                  </div>
                </div>

                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <div style={{ flex: 1, fontSize: 13 }}>Rate (bars)</div>
                  <Button
                    style={{ height: 36, padding: "0 12px", fontSize: 13, minWidth: 50 }}
                    onClick={() => numberEdit(mod.rateBars, 1, 64, (v) => send({ t: "mod.updateModulator", modulator: { ...mod, rateBars: v } }))}
                  >
                    {mod.rateBars}
                  </Button>
                </div>

                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <div style={{ flex: 1, fontSize: 13 }}>Phase</div>
                  <Button
                    style={{ height: 36, padding: "0 12px", fontSize: 13, minWidth: 50 }}
                    onClick={() =>
                      numberEdit(Math.round(mod.phase * 100), 0, 99, (v) => send({ t: "mod.updateModulator", modulator: { ...mod, phase: v / 100 } }))
                    }
                  >
                    {Math.round(mod.phase * 100)}%
                  </Button>
                </div>

                <div style={{ display: "flex", gap: 6 }}>
                  {[true, false].map((b) => (
                    <Button
                      key={String(b)}
                      variant={mod.bipolar === b ? "active" : "alt"}
                      style={{ flex: 1, height: 36, fontSize: 13 }}
                      onClick={() => send({ t: "mod.updateModulator", modulator: { ...mod, bipolar: b } })}
                    >
                      {b ? "Bipolar (±)" : "Unipolar (+)"}
                    </Button>
                  ))}
                </div>

                <div style={{ fontSize: 12, color: "var(--pal-text-dim)", marginTop: 4 }}>Targets</div>
                {modRoutes.length === 0 && <div style={{ color: "var(--pal-text-dim)", fontSize: 13 }}>No targets yet.</div>}
                {modRoutes.map((route) => (
                  <div
                    key={route.id}
                    style={{ display: "flex", alignItems: "center", gap: 8, background: "var(--pal-panel-deep)", borderRadius: 8, padding: "8px 10px" }}
                  >
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {deviceName(route.deviceId)} · CC{route.ccNumber}
                        {route.channel ? ` · Ch${route.channel}` : ""}
                      </div>
                    </div>
                    <Button
                      style={{ height: 32, padding: "0 10px", fontSize: 12, minWidth: 54 }}
                      onClick={() =>
                        numberEdit(Math.round(route.depth * 100), -100, 100, (v) =>
                          send({ t: "mod.updateRoute", route: { ...route, depth: v / 100 } }),
                        )
                      }
                    >
                      {Math.round(route.depth * 100)}%
                    </Button>
                    <button
                      type="button"
                      aria-label="Remove target"
                      style={smallClearBtn}
                      onClick={() => send({ t: "mod.removeRoute", routeId: route.id })}
                    >
                      ✕
                    </button>
                  </div>
                ))}

                <Button style={{ width: "100%", height: 40, fontSize: 13 }} onClick={() => setAddTargetFor(mod.id)}>
                  + Add target
                </Button>

                {confirmingDelete === mod.id ? (
                  <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
                    <Button
                      variant="danger"
                      style={{ flex: 1, height: 40 }}
                      onClick={() => {
                        setConfirmingDelete(null);
                        setExpanded(null);
                        send({ t: "mod.removeModulator", modulatorId: mod.id });
                      }}
                    >
                      Confirm delete
                    </Button>
                    <Button style={{ flex: 1, height: 40 }} onClick={() => setConfirmingDelete(null)}>
                      Cancel
                    </Button>
                  </div>
                ) : (
                  <Button variant="danger" style={{ width: "100%", height: 40, marginTop: 4 }} onClick={() => setConfirmingDelete(mod.id)}>
                    Delete modulator
                  </Button>
                )}
              </div>
            )}
          </div>
        );
      })}

      {addTargetFor &&
        (() => {
          const mod = modulators.find((m) => m.id === addTargetFor);
          return mod ? <AddTargetPopup modulator={mod} devices={devices} onClose={() => setAddTargetFor(null)} /> : null;
        })()}
    </div>
  );
}

function AddTargetPopup({ modulator, devices, onClose }: { modulator: GlobalModulator; devices: Device[]; onClose: () => void }) {
  const send = useSend();
  const numberEdit = useNumberEditor();

  return (
    <Popup onClose={onClose}>
      <div className="popup-title">Add target — {modulator.name}</div>
      {devices.length === 0 ? (
        <div style={{ color: "var(--pal-text-dim)", fontSize: 15 }}>No devices yet.</div>
      ) : (
        devices.map((d) => (
          <Button
            key={d.id}
            className="popup-row"
            onClick={() =>
              numberEdit(1, 0, 127, (ccNumber) => {
                onClose();
                const route: ModRoute = { id: "", modulatorId: modulator.id, deviceId: d.id, ccNumber, depth: 0.5 };
                send({ t: "mod.addRoute", route });
              })
            }
          >
            {d.name}
          </Button>
        ))
      )}
    </Popup>
  );
}

const smallClearBtn: CSSProperties = {
  width: 26,
  height: 26,
  border: "none",
  borderRadius: "50%",
  background: "var(--pal-danger)",
  color: "var(--pal-white)",
  fontSize: 12,
  fontWeight: 700,
  cursor: "pointer",
};
