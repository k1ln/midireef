//! Projekt-Menü hinter dem Zahnrad in der Transport-Leiste: gespeicherte
//! Projekte auflisten/öffnen, neues anlegen, das offene duplizieren,
//! umbenennen, speichern, löschen.
//!
//! Die Liste kommt NICHT aus dem Store (dort steht nur das offene Projekt),
//! sondern per `project.list` frisch vom Server — beim Öffnen einmal
//! angefragt, danach schickt der Server sie nach jeder Projekt-Operation von
//! selbst nach. Namen werden über das On-Screen-Keyboard eingegeben (kein
//! OS-Keyboard, siehe ARCHITECTURE.md §7).

import { useEffect, useRef, useState } from "react";
import { useNet, useSend, useStoreValue } from "./store";
import { useTouchKeyboard } from "./TouchKeyboard";
import { Button } from "./widgets/Button";
import { TRANSPORT_H } from "./layout";
import { getUiScale, setUiScale, UI_SCALE_MIN, UI_SCALE_MAX, UI_SCALE_STEP } from "./uiScale";
import { getMotion, setMotion, type Motion } from "./motionConfig";
import {
  getBgConfig,
  setBgConfig,
  bgFromPreset,
  BG_FIELDS,
  BG_PRESET_NAMES,
  type BgConfig,
  type BgCountField,
} from "./bgConfig";

/** Spiegelt `ProjectSummary` aus shared/model.ts (`updatedAt` in Unix-Sekunden). */
interface ProjectSummary {
  id: string;
  name: string;
  updatedAt: number;
  deviceCount: number;
}

const MAX_NAME_LEN = 24;

export function ProjectSettings({ onClose }: { onClose: () => void }) {
  const net = useNet();
  const send = useSend();
  const openKeyboard = useTouchKeyboard();
  const currentId = useStoreValue((s) => s.project?.id ?? "");
  const currentName = useStoreValue((s) => s.project?.name ?? "");
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  /** ID der Zeile, deren Löschen gerade rückgefragt wird (Touch: kein confirm()). */
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [scale, setScale] = useState(getUiScale);
  const [motion, setMotionState] = useState<Motion>(getMotion);
  const [bg, setBg] = useState(getBgConfig);

  const changeScale = (next: number) => setScale(setUiScale(next));
  const changeMotion = (next: Motion) => setMotionState(setMotion(next));
  const applyBg = (next: BgConfig) => setBg(setBgConfig(next));
  const bgOff = bg.preset === "off";

  /** Spiegel des aktuellen `bg`, damit die Halten-Wiederholung im HoldStepper
   *  ohne Render-Warterei aufeinander aufbauende Schritte rechnen kann. */
  const bgRef = useRef(bg);
  useEffect(() => {
    bgRef.current = bg;
  }, [bg]);

  /** Zähler um `delta` verschieben (geklemmt auf 0..max), Preset auf „custom".
   *  Gibt zurück, ob sich etwas geändert hat — der HoldStepper stoppt sonst. */
  const stepBg = (key: BgCountField, delta: number): boolean => {
    const cur = bgRef.current;
    const next = Math.max(0, Math.min(BG_FIELDS[key].max, cur[key] + delta));
    if (next === cur[key]) return false;
    const applied = setBgConfig({ ...cur, preset: "custom", [key]: next });
    bgRef.current = applied; // sofort, damit die nächste Wiederholung darauf aufbaut
    setBg(applied);
    return true;
  };

  useEffect(() => {
    const off = net.onEvent((evt) => {
      if (evt.t === "project.list") {
        setProjects(evt.projects ?? []);
        setPendingDelete(null);
      }
    });
    send({ t: "project.list" });
    return off;
  }, [net, send]);

  const askName = (current: string, done: (name: string) => void) => {
    openKeyboard(current, MAX_NAME_LEN, (v) => {
      const name = v?.trim();
      if (name) done(name);
    });
  };

  return (
    // A plain top-level page — same shape as Dashboard / Sequencer / Library:
    // full-bleed below the transport bar, no modal, no back button. `onClose`
    // now just means "leave settings" (the caller navigates away).
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
      <div className="popup-title">Projects</div>

      {/* Each section keeps its natural (~440px) width; a wider screen packs
          more of them per row instead of stretching any one. */}
      <div className="settings-grid">
        <section className="settings-card">
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 12, color: "var(--pal-text-dim)" }}>Currently open</div>
              <div
                style={{ fontSize: 20, fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
              >
                {currentName || "—"}
              </div>
            </div>
            <Button
              style={{ height: 44, padding: "0 14px", fontSize: 15 }}
              onClick={() => askName(currentName, (name) => send({ t: "project.rename", name }))}
            >
              Rename
            </Button>
            <Button variant="active" style={{ height: 44, padding: "0 14px", fontSize: 15 }} onClick={() => send({ t: "project.save" })}>
              Save
            </Button>
          </div>

          <div className="popup-subtitle">Tap a project to open it — the current one is saved first.</div>

          {projects.length === 0 ? (
            <div style={{ color: "var(--pal-text-dim)", fontSize: 15, marginBottom: 12 }}>Nothing saved yet</div>
          ) : (
            projects.map((p) =>
              pendingDelete === p.id ? (
                <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                  <div style={{ flex: 1, fontSize: 14, color: "var(--pal-text-dim)" }}>Delete “{p.name}”?</div>
                  <Button variant="danger" style={{ height: 46, padding: "0 14px" }} onClick={() => send({ t: "project.delete", projectId: p.id })}>
                    Delete
                  </Button>
                  <Button style={{ height: 46, padding: "0 14px" }} onClick={() => setPendingDelete(null)}>
                    Cancel
                  </Button>
                </div>
              ) : (
                <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                  <Button
                    variant={p.id === currentId ? "active" : "default"}
                    className="popup-row"
                    style={{ flex: 1, minWidth: 0, marginBottom: 0, flexDirection: "column", alignItems: "flex-start", justifyContent: "center", height: 52 }}
                    onClick={() => {
                      if (p.id === currentId) return;
                      send({ t: "project.load", projectId: p.id });
                      onClose();
                    }}
                  >
                    <span style={{ fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "100%" }}>
                      {p.name}
                    </span>
                    <span style={{ fontSize: 11, color: "var(--pal-text-dim)" }}>
                      {p.deviceCount} device{p.deviceCount === 1 ? "" : "s"} · {formatAge(p.updatedAt)}
                    </span>
                  </Button>
                  <Button variant="danger" style={{ width: 52, height: 52, fontSize: 18 }} onClick={() => setPendingDelete(p.id)}>
                    ✕
                  </Button>
                </div>
              ),
            )
          )}

          <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
            <Button
              className="popup-row"
              style={{ flex: 1, minWidth: 0, marginBottom: 0, justifyContent: "center" }}
              onClick={() =>
                askName("", (name) => {
                  send({ t: "project.create", name });
                  onClose();
                })
              }
            >
              New …
            </Button>
            <Button
              className="popup-row"
              style={{ flex: 1, minWidth: 0, marginBottom: 0, justifyContent: "center" }}
              onClick={() =>
                askName(`${currentName} 2`.slice(0, MAX_NAME_LEN), (name) => {
                  send({ t: "project.copy", name });
                  onClose();
                })
              }
            >
              Duplicate …
            </Button>
          </div>
        </section>

        {/* ── Anzeige: App-eigener Zoom (unabhängig vom Browser-Zoom) ── */}
        <section className="settings-card">
          <div className="popup-subtitle">Display size — scales the whole interface</div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <Button
              variant="alt"
              style={{ width: 56, height: 48, fontSize: 24 }}
              disabled={scale <= UI_SCALE_MIN}
              onClick={() => changeScale(scale - UI_SCALE_STEP)}
            >
              −
            </Button>
            <div style={{ flex: 1, textAlign: "center", fontSize: 20, fontWeight: 700 }}>{Math.round(scale * 100)}%</div>
            <Button
              variant="alt"
              style={{ width: 56, height: 48, fontSize: 24 }}
              disabled={scale >= UI_SCALE_MAX}
              onClick={() => changeScale(scale + UI_SCALE_STEP)}
            >
              +
            </Button>
            <Button style={{ height: 48, padding: "0 14px", fontSize: 15 }} disabled={scale === 1} onClick={() => changeScale(1)}>
              Reset
            </Button>
          </div>
        </section>

        {/* ── Animationen: der mit Abstand größte CPU-Posten auf dem Pi ──
             Siehe motionConfig.ts für die Messwerte — „Off" nimmt Chromium
             im Leerlauf von ~71 % auf ~4 % eines Kerns zurück. */}
        <section className="settings-card">
          <div className="popup-subtitle">Animations — “Off” saves a lot of CPU on the Pi</div>
          <div style={{ display: "flex", gap: 6 }}>
            {(["full", "off"] as Motion[]).map((m) => (
              <Button
                key={m}
                variant={motion === m ? undefined : "alt"}
                style={{ flex: 1, height: 48, fontSize: 15 }}
                onClick={() => changeMotion(m)}
              >
                {m === "full" ? "On" : "Off"}
              </Button>
            ))}
          </div>
        </section>

        {/* ── Unterwasser-Hintergrund: Preset + Feinregler + Reaktivität ── */}
        <section className="settings-card">
          <div className="popup-subtitle">Background scene — “Off” shows plain black</div>

          <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
          {BG_PRESET_NAMES.map((p) => (
            <Button
              key={p}
              variant={bg.preset === p ? "active" : "alt"}
              style={{ flex: 1, height: 42, fontSize: 13, textTransform: "capitalize" }}
              onClick={() => applyBg(bgFromPreset(p, bg.showFps))}
            >
              {p}
            </Button>
          ))}
          <Button
            variant={bg.preset === "custom" ? "active" : "alt"}
            disabled={bg.preset !== "custom"}
            style={{ flex: 1, height: 42, fontSize: 13 }}
          >
            Custom
          </Button>
        </div>

        {/* Bewusst AUSSERHALB des bgOff-Wrappers: die Bildrate will man gerade
            auch bei abgeschalteter Szene sehen — das ist der Vergleichswert. */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
          <div style={{ flex: 1, fontSize: 14 }}>Show FPS next to the position</div>
          <Button
            variant={bg.showFps ? "active" : "alt"}
            style={{ width: 72, height: 40, fontSize: 14 }}
            onClick={() => applyBg({ ...bg, showFps: !bg.showFps })}
          >
            {bg.showFps ? "On" : "Off"}
          </Button>
        </div>

        <div style={{ opacity: bgOff ? 0.4 : 1, pointerEvents: bgOff ? "none" : "auto" }}>
          {(Object.keys(BG_FIELDS) as BgCountField[]).map((key) => {
            const f = BG_FIELDS[key];
            const value = bg[key];
            return (
              <div key={key} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                <div style={{ flex: 1, fontSize: 14 }}>{f.label}</div>
                <HoldStepper
                  label="−"
                  disabled={bgOff || value <= 0}
                  onStep={(mag) => stepBg(key, -mag)}
                />
                <div className="mono" style={{ width: 34, textAlign: "center", fontWeight: 700 }}>
                  {value}
                </div>
                <HoldStepper
                  label="+"
                  disabled={bgOff || value >= f.max}
                  onStep={(mag) => stepBg(key, mag)}
                />
              </div>
            );
          })}

          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10 }}>
            <div style={{ flex: 1, fontSize: 14 }}>React to notes played</div>
            <Button
              variant={bg.reactNotes ? "active" : "alt"}
              style={{ width: 72, height: 40, fontSize: 14 }}
              disabled={bgOff}
              onClick={() => applyBg({ ...bg, preset: "custom", reactNotes: !bg.reactNotes })}
            >
              {bg.reactNotes ? "On" : "Off"}
            </Button>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6 }}>
            <div style={{ flex: 1, fontSize: 14 }}>Flow follows tempo when running</div>
            <Button
              variant={bg.reactBpm ? "active" : "alt"}
              style={{ width: 72, height: 40, fontSize: 14 }}
              disabled={bgOff}
              onClick={() => applyBg({ ...bg, preset: "custom", reactBpm: !bg.reactBpm })}
            >
              {bg.reactBpm ? "On" : "Off"}
            </Button>
          </div>
        </div>
      </section>
      </div>
    </div>
  );
}

/** +/–-Stepper mit Auto-Wiederholung: ein Tipp zählt ±1, Gedrückthalten läuft
 *  nach kurzer Verzögerung immer schneller und in wachsenden Schritten (bis ±8)
 *  weiter — so erreicht man auch die 10× überzogenen Obergrenzen zügig. Stoppt
 *  bei Loslassen, verlorenem Pointer-Capture oder sobald `onStep` meldet, dass
 *  die Grenze erreicht ist. */
function HoldStepper({
  label,
  disabled,
  onStep,
}: {
  label: string;
  disabled?: boolean;
  onStep: (magnitude: number) => boolean;
}) {
  const timer = useRef<number | null>(null);
  const ticks = useRef(0);

  const stop = () => {
    if (timer.current != null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    ticks.current = 0;
  };

  // Beim Unmount (Popup schließt mitten im Halten) den Timer aufräumen.
  useEffect(() => stop, []);

  const start = () => {
    if (disabled || !onStep(1)) return;
    ticks.current = 0;
    const tick = () => {
      const n = (ticks.current += 1);
      const magnitude = n > 40 ? 8 : n > 16 ? 3 : 1;
      const wait = Math.max(45, 240 - n * 10); // von ~240 ms auf 45 ms zusammenziehen
      if (!onStep(magnitude)) return stop();
      timer.current = window.setTimeout(tick, wait);
    };
    timer.current = window.setTimeout(tick, 380);
  };

  return (
    <Button
      variant="alt"
      style={{ width: 40, height: 40, fontSize: 20, touchAction: "none" }}
      disabled={disabled}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        start();
      }}
      onPointerUp={stop}
      onPointerCancel={stop}
      onLostPointerCapture={stop}
    >
      {label}
    </Button>
  );
}

/** „vor 5 min" statt eines rohen Zeitstempels — auf dem kleinen Touchscreen
 *  ist „wie alt" die einzige Frage, die die Liste beantworten muss. */
function formatAge(unixSeconds: number): string {
  if (!unixSeconds) return "unknown";
  const mins = Math.max(0, Math.round((Date.now() / 1000 - unixSeconds) / 60));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}
