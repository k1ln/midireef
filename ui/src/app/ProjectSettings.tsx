//! Projekt-Menü hinter dem Zahnrad in der Transport-Leiste: gespeicherte
//! Projekte auflisten/öffnen, neues anlegen, das offene duplizieren,
//! umbenennen, speichern, löschen.
//!
//! Die Liste kommt NICHT aus dem Store (dort steht nur das offene Projekt),
//! sondern per `project.list` frisch vom Server — beim Öffnen einmal
//! angefragt, danach schickt der Server sie nach jeder Projekt-Operation von
//! selbst nach. Namen werden über das On-Screen-Keyboard eingegeben (kein
//! OS-Keyboard, siehe ARCHITECTURE.md §7).

import { useEffect, useState } from "react";
import { useNet, useSend, useStoreValue } from "./store";
import { useTouchKeyboard } from "./TouchKeyboard";
import { Button } from "./widgets/Button";
import { Popup } from "./widgets/Popup";
import { getUiScale, setUiScale, UI_SCALE_MIN, UI_SCALE_MAX, UI_SCALE_STEP } from "./uiScale";

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

  const changeScale = (next: number) => setScale(setUiScale(next));

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
    <Popup onClose={onClose} boxStyle={{ width: 420 }}>
      <div className="popup-title">Projects</div>

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

      <div style={{ fontSize: 12, color: "var(--pal-text-dim)", marginBottom: 8 }}>
        Tap a project to open it — the current one is saved first.
      </div>

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

      {/* ── Anzeige: App-eigener Zoom (unabhängig vom Browser-Zoom) ── */}
      <div style={{ borderTop: "1px solid rgba(255,255,255,0.15)", marginTop: 18, paddingTop: 14 }}>
        <div style={{ fontSize: 12, color: "var(--pal-text-dim)", marginBottom: 8 }}>
          Display size — scales the whole interface
        </div>
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
      </div>
    </Popup>
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
