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
import { WheelPickerProvider } from "./widgets/WheelPicker";
import { Overview } from "./overview/Overview";
import { PortPickerPopup } from "./overview/popups";
import { BlockDetail } from "./BlockDetail";
import { BlockLibrary } from "./BlockLibrary";
import { LaneControls } from "./LaneControls";
import { Dashboard } from "./Dashboard";
import { ProjectSettings } from "./ProjectSettings";
import { applyUiScale, getUiScale } from "./uiScale";
import { applyMotion, getMotion } from "./motionConfig";
import { applyAllSizes } from "./uiSizes";

/** Top-level pages, all reached from the transport bar — no back button, no
 *  modal. Dashboard, Sequencer, Block library and Project settings are peers;
 *  `blockDetail` / `laneControls` are the only real drill-ins (they overlay
 *  whichever page opened them). */
type View = "start" | "seq" | "library" | "settings";

type SubScreen =
  | { kind: "blockDetail"; blockId: string }
  | { kind: "laneControls"; laneId: string }
  | null;

export function App() {
  const [store] = useState(() => new Store());
  const [net] = useState(() => new Net());
  const [runtime] = useState(() => new RuntimeFeed());
  const [view, setView] = useState<View>("start");
  const [sub, setSub] = useState<SubScreen>(null);
  /** Set when "Move" in the block editor sends you to the library with one
   *  block armed for re-placing; cleared when the library is opened plainly
   *  from the transport bar. */
  const [libMove, setLibMove] = useState<{ blockId: string; type: BlockType } | null>(null);
  /** „＋ Device"-Port-Picker — der Knopf sitzt in der Transport-Leiste (nur im
   *  Sequencer), das Popup rendert hier auf oberster Ebene. */
  const [addDeviceOpen, setAddDeviceOpen] = useState(false);
  /** Zähler, den „Center" in der Transport-Leiste hochzählt — das Dashboard
   *  hört darauf und setzt Pan/Zoom zurück (kein eigener Knopf mehr auf dem
   *  Dashboard selbst). */
  const [centerSignal, setCenterSignal] = useState(0);
  /** Zähler, den „＋ Lane switch" in der Transport-Leiste hochzählt — das
   *  Dashboard hört darauf und öffnet dort seinen Lane-Picker (kein eigener
   *  Knopf mehr über dem Canvas, der die Controls zuklebt). */
  const [addLaneSwitchSignal, setAddLaneSwitchSignal] = useState(0);

  const navigate = (next: View) => {
    setSub(null);
    setLibMove(null);
    setAddDeviceOpen(false);
    setView(next);
  };

  // Gespeicherten UI-Zoom und Animations-Einstellung beim Start anwenden
  // (s. uiScale.ts / motionConfig.ts — beides pro Gerät in localStorage).
  useEffect(() => {
    applyUiScale(getUiScale());
    applyMotion(getMotion());
    applyAllSizes();
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
        case "network.state":
          store.setNetwork(evt);
          break;
        case "record.armState":
          store.setRecordArmed(evt.controlId && evt.laneId ? { controlId: evt.controlId, laneId: evt.laneId } : null);
          break;
        // Knob-Wert vom Server (physisch gedreht ODER von einem nicht-
        // destruktiven CC-Baustein auf die Ruhelage zurückgestellt) — hier
        // global nachziehen, damit der Dashboard-Knob auch stimmt, wenn das
        // Dashboard gerade nicht gemountet ist.
        case "control.valueChanged":
          if (evt.controlId != null) store.patchControl(evt.controlId, { value: evt.value });
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
          <WheelPickerProvider>
          <Transport
            view={view}
            onNav={navigate}
            onAddDevice={() => setAddDeviceOpen(true)}
            onCenter={() => setCenterSignal((n) => n + 1)}
            onAddLaneSwitch={() => setAddLaneSwitchSignal((n) => n + 1)}
          />

          {view === "start" && <Dashboard centerSignal={centerSignal} addLaneSwitchSignal={addLaneSwitchSignal} />}

          {view === "seq" && (
            <Overview onOpenBlock={(blockId) => setSub({ kind: "blockDetail", blockId })} />
          )}

          {view === "seq" && addDeviceOpen && <PortPickerPopup onClose={() => setAddDeviceOpen(false)} />}

          {view === "library" && (
            <BlockLibrary
              // Remount when an armed "Move" arrives so the fresh props
              // (target type + moving block) seed the library's local state.
              key={libMove ? `move-${libMove.blockId}` : "browse"}
              initialType={libMove?.type}
              initialMovingBlockId={libMove?.blockId}
              onOpenBlock={(blockId) => setSub({ kind: "blockDetail", blockId })}
            />
          )}

          {view === "settings" && <ProjectSettings onClose={() => navigate("seq")} />}

          {sub?.kind === "blockDetail" && (
            <BlockDetail
              blockId={sub.blockId}
              onClose={() => setSub(null)}
              onMove={(blockId, blockType) => {
                setSub(null);
                setLibMove({ blockId, type: blockType });
                setView("library");
              }}
            />
          )}

          {sub?.kind === "laneControls" && <LaneControls laneId={sub.laneId} onClose={() => setSub(null)} />}
          </WheelPickerProvider>
        </NotePickerProvider>
      </TouchKeyboardProvider>
    </AppProvider>
  );
}
