//! MidiDrift UI — Einstiegspunkt. Initialisiert PixiJS, Unterwasser-Szene,
//! Start-/Sequencer-Screen, Transport-Leiste und die WebSocket-Verbindung.

import { Application } from "pixi.js";
import { Net } from "./net";
import { Store } from "./state";
import { UnderwaterScene } from "./scene/underwater";
import { TransportBar } from "./ui/transport";
import { SequencerOverview } from "./ui/overview";
import { MainScreen } from "./ui/mainscreen";
import { BlockDetailScreen } from "./ui/blockdetail";
import { LaneControlsScreen } from "./ui/lanecontrols";
import { BlockLibraryScreen } from "./ui/blocklibrary";
import { TouchKeyboard } from "./ui/keyboard";
import { wireGlobalRipples } from "./ui/ripple";

async function main() {
  const app = new Application();
  await app.init({
    background: 0x000000,
    resizeTo: window,
    antialias: false, // harte Kanten / Pixel-Look
    resolution: window.devicePixelRatio || 1,
    autoDensity: true,
  });
  document.getElementById("app")!.appendChild(app.canvas);

  // Maus wie Touch: Rechtsklick-Kontextmenü unterdrücken (Rechtsklick = 2-Finger).
  app.canvas.addEventListener("contextmenu", (e) => e.preventDefault());

  const store = new Store();
  const net = new Net();
  const sendCmd = (cmd: object) => net.send(cmd);

  const scene = new UnderwaterScene();
  app.stage.addChild(scene.container);

  const keyboard = new TouchKeyboard();

  const mainScreen = new MainScreen(store, sendCmd, keyboard);
  const blockDetail = new BlockDetailScreen(store, sendCmd, keyboard);
  const laneControls = new LaneControlsScreen(store, sendCmd, keyboard);
  const blockLibrary = new BlockLibraryScreen(store, sendCmd, (blockId) => blockDetail.open(blockId));
  const overview = new SequencerOverview(
    store,
    sendCmd,
    keyboard,
    (blockId) => blockDetail.open(blockId),
    (laneId) => laneControls.open(laneId),
    (deviceId) => blockLibrary.open(deviceId),
  );
  app.stage.addChild(mainScreen.container);
  app.stage.addChild(overview.container);
  app.stage.addChild(blockDetail.container);
  app.stage.addChild(laneControls.container);
  app.stage.addChild(blockLibrary.container);

  // Navigation Start ↔ Sequencer, gesteuert über die Transport-Leiste.
  const setView = (v: "start" | "seq") => {
    mainScreen.container.visible = v === "start";
    overview.container.visible = v === "seq";
    transport.setView(v);
  };

  const transport = new TransportBar(sendCmd, setView);
  app.stage.addChild(transport.container);

  const layout = () => {
    scene.resize(app.screen.width, app.screen.height);
    mainScreen.resize(app.screen.width, app.screen.height);
    overview.resize(app.screen.width, app.screen.height);
    blockDetail.resize(app.screen.width, app.screen.height);
    laneControls.resize(app.screen.width, app.screen.height);
    blockLibrary.resize(app.screen.width, app.screen.height);
    transport.resize(app.screen.width);
    keyboard.resize(app.screen.width, app.screen.height);
  };
  layout();
  setView("start");
  window.addEventListener("resize", layout);

  // Ripple layer stays topmost, added after every other screen/overlay.
  app.stage.addChild(keyboard.container);
  wireGlobalRipples(app.stage);

  app.ticker.add((ticker) => scene.update(ticker));

  net.onEvent((evt) => {
    switch (evt.t) {
      case "transport.tick":
        if (evt.transport) {
          store.setTransport(evt.transport);
          transport.applyTransport(evt.transport);
        }
        break;
      case "state.snapshot":
        if (evt.transport) transport.applyTransport(evt.transport);
        if (evt.project) store.setProject(evt.project);
        break;
      case "midi.ports":
        transport.applyPorts(evt.outputs ?? []);
        store.setPorts(evt.outputs ?? []);
        break;
      case "learn.armed":
        mainScreen.setArmed(!!evt.armed);
        break;
      case "learn.captured":
        if (evt.controlId) mainScreen.onLearned(evt.controlId, evt.mapping);
        break;
      case "control.sendError":
        if (evt.message) mainScreen.showSendError(evt.message);
        break;
    }
  });
  net.connect();
}

main();
