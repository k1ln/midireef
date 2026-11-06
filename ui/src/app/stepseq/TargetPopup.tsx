//! Ziel-Editor eines Step-Sequencers: Liste der Ziele + „hinzufügen". Ein Ziel
//! ist ein Dashboard-Control (Taster/Regler) oder ein Device direkt (Noten bzw.
//! CV-artiger CC-Strom). Jede Änderung geht als komplette Zielliste an den
//! Server (`stepSeq.setTargets`), der Rest folgt dem Echo `stepSeq.state`.

import { useState } from "react";
import type { Device, SeqTarget, StepSeq } from "../../state";
import type { LiveControl } from "../dashboard/ControlWidget";
import { Button } from "../widgets/Button";
import { Popup } from "../widgets/Popup";
import { useWheelPicker } from "../widgets/WheelPicker";

/** Controls, die ein Sequencer überhaupt bespielen kann: gelernter Taster/Regler
 *  mit Note-, CC- oder Program-Change-Mapping (kein Keyboard-Wildcard). */
export function isSeqTargetControl(c: LiveControl): boolean {
  const k = c.mapping?.kind;
  return c.kind !== "keyboard" && (k === "note" || k === "cc" || k === "programChange");
}

function controlLabel(c: LiveControl): string {
  const m = c.mapping;
  const what = m ? `${m.kind === "programChange" ? "PC" : m.kind === "cc" ? "CC" : "Note"}${m.number != null ? ` ${m.number}` : ""} · Ch${m.channel}` : "";
  return `${c.name || "(unnamed)"}  —  ${what}`;
}

export interface TargetPopupProps {
  seq: StepSeq;
  devices: Device[];
  controls: LiveControl[];
  onChange: (targets: SeqTarget[]) => void;
  onClose: () => void;
}

export function TargetPopup({ seq, devices, controls, onChange, onClose }: TargetPopupProps) {
  const wheel = useWheelPicker();
  const [adding, setAdding] = useState<null | "device" | "control">(null);
  const usable = controls.filter(isSeqTargetControl);

  const patch = (i: number, p: Partial<Extract<SeqTarget, { kind: "device" }>>) =>
    onChange(seq.targets.map((t, j) => (j === i && t.kind === "device" ? { ...t, ...p } : t)));
  const remove = (i: number) => onChange(seq.targets.filter((_, j) => j !== i));

  if (adding) {
    return (
      <Popup onClose={() => setAdding(null)} boxStyle={{ width: 460 }}>
        <div className="popup-title">{adding === "device" ? "Send to device" : "Send to dashboard button"}</div>
        {adding === "device" &&
          (devices.length === 0 ? (
            <div className="popup-subtitle">No devices yet — add one in SQ first.</div>
          ) : (
            devices.map((d) => (
              <Button
                key={d.id}
                className="popup-row"
                onClick={() => {
                  onChange([
                    ...seq.targets,
                    { kind: "device", deviceId: d.id, channel: 1, mode: "note", cc: 74 },
                  ]);
                  setAdding(null);
                }}
              >
                {d.name}
              </Button>
            ))
          ))}
        {adding === "control" &&
          (usable.length === 0 ? (
            <div className="popup-subtitle">
              No usable dashboard controls. Learn a button or knob on the dashboard first (note, CC or program change).
            </div>
          ) : (
            usable.map((c) => (
              <Button
                key={c.id}
                className="popup-row"
                onClick={() => {
                  onChange([...seq.targets, { kind: "control", controlId: c.id }]);
                  setAdding(null);
                }}
              >
                {controlLabel(c)}
              </Button>
            ))
          ))}
        <Button className="popup-row" onClick={() => setAdding(null)}>
          Cancel
        </Button>
      </Popup>
    );
  }

  return (
    <Popup onClose={onClose} boxStyle={{ width: 520 }}>
      <div className="popup-title">Targets · {seq.name}</div>
      {seq.targets.length === 0 && (
        <div className="popup-subtitle">No target — the sequencer runs silently. Add a device or a dashboard button.</div>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 12 }}>
        {seq.targets.map((t, i) => {
          if (t.kind === "control") {
            const c = controls.find((x) => x.id === t.controlId);
            const hint =
              c?.mapping?.kind === "note"
                ? "Pitch plays the note, with velocity + gate"
                : c?.mapping?.kind === "cc"
                  ? "Pitch/value is sent as the CC value"
                  : c?.mapping?.kind === "programChange"
                    ? "Pitch/value picks the program"
                    : "";
            return (
              <div key={i} className="panel-deep" style={{ padding: 10, display: "flex", alignItems: "center", gap: 10 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 700, fontSize: 15 }}>{c ? controlLabel(c) : "(button removed)"}</div>
                  <div style={{ fontSize: 12, color: "var(--pal-text-dim)" }}>Dashboard · {hint || "—"}</div>
                </div>
                <Button style={{ width: 44, height: 44 }} onClick={() => remove(i)}>
                  ✕
                </Button>
              </div>
            );
          }
          const dev = devices.find((d) => d.id === t.deviceId);
          return (
            <div key={i} className="panel-deep" style={{ padding: 10 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <div style={{ flex: 1, fontWeight: 700, fontSize: 15 }}>{dev ? dev.name : "(device removed)"}</div>
                <Button style={{ width: 44, height: 44 }} onClick={() => remove(i)}>
                  ✕
                </Button>
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
                <Button
                  style={{ height: 40, padding: "0 12px" }}
                  onClick={() =>
                    wheel({ title: "MIDI channel", min: 1, max: 16, value: t.channel, onPick: (v) => patch(i, { channel: v }) })
                  }
                >
                  Ch {t.channel}
                </Button>
                <Button
                  style={{ height: 40, padding: "0 12px" }}
                  variant={t.mode === "note" ? "active" : "default"}
                  onClick={() => patch(i, { mode: "note" })}
                >
                  Notes
                </Button>
                <Button
                  style={{ height: 40, padding: "0 12px" }}
                  variant={t.mode === "cc" ? "active" : "default"}
                  onClick={() => patch(i, { mode: "cc" })}
                  title="CV-style: the pitch knob streams a CC value"
                >
                  CC stream
                </Button>
                {t.mode === "cc" && (
                  <Button
                    style={{ height: 40, padding: "0 12px" }}
                    onClick={() => wheel({ title: "CC number", min: 0, max: 127, value: t.cc, onPick: (v) => patch(i, { cc: v }) })}
                  >
                    CC {t.cc}
                  </Button>
                )}
                <Button
                  style={{ height: 40, padding: "0 12px" }}
                  onClick={() =>
                    wheel({
                      title: "Mod knob → CC (0 = off)",
                      min: 0,
                      max: 127,
                      value: t.modCc ?? 0,
                      onPick: (v) => patch(i, { modCc: v === 0 ? undefined : v }),
                    })
                  }
                  title="Send each step's Mod knob on this CC"
                >
                  Mod → {t.modCc != null ? `CC ${t.modCc}` : "off"}
                </Button>
              </div>
            </div>
          );
        })}
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <Button className="popup-row" style={{ flex: 1, width: "auto", minWidth: 0 }} onClick={() => setAdding("device")}>
          ＋ Device
        </Button>
        <Button className="popup-row" style={{ flex: 1, width: "auto", minWidth: 0 }} onClick={() => setAdding("control")}>
          ＋ Dashboard button
        </Button>
      </div>
      <Button className="popup-row" variant="alt" onClick={onClose}>
        Done
      </Button>
    </Popup>
  );
}
