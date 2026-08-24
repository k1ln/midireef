//! React-Wurzel: verbindet Store/Net (unverändert aus state.ts/net.ts) und
//! stellt sie über AppProvider bereit. Screens werden phasenweise ergänzt —
//! siehe docs/ARCHITECTURE.md für den aktuellen Migrationsstand.

import { useEffect, useState } from "react";
import { Net } from "../net";
import { Store } from "../state";
import type { BlockType } from "../state";
import { AppProvider } from "./store";
import { Transport } from "./Transport";
import { TouchKeyboardProvider } from "./TouchKeyboard";
import { NotePickerProvider } from "./NotePicker";
import { Overview } from "./overview/Overview";
import { BlockDetail } from "./BlockDetail";
import { BlockLibrary } from "./BlockLibrary";
import { LaneControls } from "./LaneControls";
import { Dashboard } from "./Dashboard";

type SubScreen =
  | { kind: "blockDetail"; blockId: string }
  | { kind: "laneControls"; laneId: string }
  | { kind: "blockLibrary"; deviceId: string; moveBlockId?: string; moveBlockType?: BlockType }
  | null;

export function App() {
  const [store] = useState(() => new Store());
  const [net] = useState(() => new Net());
  const [view, setView] = useState<"start" | "seq">("start");
  const [sub, setSub] = useState<SubScreen>(null);

  useEffect(() => {
    const off = net.onEvent((evt) => {
      switch (evt.t) {
        case "state.snapshot":
          if (evt.project) store.setProject(evt.project);
          break;
        case "midi.ports":
          store.setPorts(evt.outputs ?? []);
          break;
      }
    });
    net.connect();
    return off;
  }, [net, store]);

  return (
    <AppProvider value={{ store, send: (cmd) => net.send(cmd), net }}>
      <TouchKeyboardProvider>
        <NotePickerProvider>
          <Transport view={view} onNav={setView} />

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
        </NotePickerProvider>
      </TouchKeyboardProvider>
    </AppProvider>
  );
}
