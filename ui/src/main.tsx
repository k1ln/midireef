//! MidiReef UI — Einstiegspunkt. Mountet den Pixi-Hintergrund (#pixi-bg,
//! nur die Unterwasser-Szene) und die React-Oberfläche (#react-root,
//! das eigentliche Frontend) — siehe docs/ARCHITECTURE.md §2/§6.

import { createRoot } from "react-dom/client";
import { mountBackground } from "./background";
import { App } from "./app/App";
import { wireTouchScroll } from "./ui/touchScroll";
import { wireGlobalRipples } from "./ui/ripple";
// Geist (self-hosted Variable-Fonts, gebündelt via Vite — funktioniert offline).
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "./theme.css";

// Maus wie Touch: Rechtsklick-Kontextmenü unterdrücken (Rechtsklick = 2-Finger,
// siehe mainscreen.ts/Dashboard's eigenes Kontextmenü).
document.addEventListener("contextmenu", (e) => e.preventDefault());

// Zwei-Finger-Scrollen + Ziehen an der Scrollleiste (s. ui/touchScroll.ts).
// Ergänzt das native Ein-Finger-Scrollen, ersetzt es nicht.
wireTouchScroll();

// Tipp-Rückmeldung (Wassertropfen am Finger, s. ui/ripple.ts). Hängt bewusst
// NICHT mehr am Pixi-Hintergrund: sie muss auch dann kommen, wenn die Szene
// abgeschaltet ist — und sie muss ÜBER der Oberfläche liegen, nicht dahinter.
wireGlobalRipples();

const bgHost = document.getElementById("pixi-bg")!;
mountBackground(bgHost);

const reactHost = document.getElementById("react-root")!;
createRoot(reactHost).render(<App />);
