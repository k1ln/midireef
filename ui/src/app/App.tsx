//! React-Wurzel: verbindet Store/Net (unverändert aus state.ts/net.ts) und
//! stellt sie über AppProvider bereit. Screens werden phasenweise ergänzt —
//! siehe docs/ARCHITECTURE.md für den aktuellen Migrationsstand.

import { useEffect, useState } from "react";
import { Net } from "../net";
import { Store } from "../state";
import type { BlockType } from "../state";
import { AppProvider } from "./store";
import { RuntimeFeed } from "./runtime";
import { Transport } from "./Transport";
import { TouchKeyboardProvider } from "./TouchKeyboard";
import { NotePickerProvider } from "./NotePicker";
import { Overview } from "./overview/Overview";
import { BlockDetail } from "./BlockDetail";
import { BlockLibrary } from "./BlockLibrary";
import { LaneControls } from "./LaneControls";
import { Dashboard } from "./Dashboard";
import { ProjectSettings } from "./ProjectSettings";
import { applyUiScale, getUiScale } from "./uiScale";

type SubScreen =
  | { kind: "blockDetail"; blockId: string }
  | { kind: "laneControls"; laneId: string }
  | { kind: "blockLibrary"; deviceId: string; moveBlockId?: string; moveBlockType?: BlockType }
  | null;

export function App() {
  const [store] = useState(() => new Store());
  const [net] = useState(() => new Net());
  const [runtime] = useState(() => new RuntimeFeed());
  const [view, setView] = useState<"start" | "seq">("start");
  const [sub, setSub] = useState<SubScreen>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Gespeicherten UI-Zoom beim Start anwenden (s. uiScale.ts).
  useEffect(() => {
    applyUiScale(getUiScale());
  }, []);

  useEffect(() => {
    const off = net.onEvent((evt) => {
      switch (evt.t) {
        case "state.snapshot":
          if (evt.project) {
            // Projektwechsel: ein offener Unter-Screen zeigt auf einen
            // Baustein/eine Lane des ALTEN Projekts — schließen, statt ihn
            // ins Leere zeigen zu lassen.
            if (store.project && store.project.id !== evt.project.id) setSub(null);
            store.setProject(evt.project);
          }
          break;
        case "midi.ports":
          store.setPorts(evt.outputs ?? []);
          break;
        case "record.armState":
          store.setRecordArmed(evt.controlId && evt.laneId ? { controlId: evt.controlId, laneId: evt.laneId } : null);
          break;
      }
    });
    const offRuntime = runtime.attach(net);
    net.connect();
    return () => {
      off();
      offRuntime();
    };
  }, [net, store, runtime]);

  return (
    <AppProvider value={{ store, send: (cmd) => net.send(cmd), net, runtime }}>
      <TouchKeyboardProvider>
        <NotePickerProvider>
          <Transport
            view={view}
            onNav={setView}
            settingsOpen={settingsOpen}
            onOpenSettings={() => setSettingsOpen(true)}
          />

          {view === "start" ? (
            <Dashboard />
          ) : (
            <Overview
              onOpenBlock={(blockId) => setSub({ kind: "blockDetail", blockId })}
              onOpenLaneControls={(laneId) => setSub({ kind: "laneControls", laneId })}
              onOpenLibrary={(deviceId) => setSub({ kind: "blockLibrary", deviceId })}
            />
          )}

          {sub?.kind === "blockDetail" && (
            <BlockDetail
              blockId={sub.blockId}
              onClose={() => setSub(null)}
              onMove={(deviceId, blockId, blockType) =>
                setSub({ kind: "blockLibrary", deviceId, moveBlockId: blockId, moveBlockType: blockType })
              }
            />
          )}

          {sub?.kind === "blockLibrary" && (
            <BlockLibrary
              deviceId={sub.deviceId}
              initialType={sub.moveBlockType}
              initialMovingBlockId={sub.moveBlockId}
              onClose={() => setSub(null)}
              onOpenBlock={(blockId) => setSub({ kind: "blockDetail", blockId })}
            />
          )}

          {sub?.kind === "laneControls" && <LaneControls laneId={sub.laneId} onClose={() => setSub(null)} />}

          {settingsOpen && <ProjectSettings onClose={() => setSettingsOpen(false)} />}
        </NotePickerProvider>
      </TouchKeyboardProvider>
    </AppProvider>
  );
}
