//! Transport-Leiste (oben, eine Reihe) — React-Port von ui/transport.ts.
//! Play/Stop (ein Knopf, grün ▶ / rot glühend ■), SQ (Sequencer),
//! Start-Symbol (⌂), ⚙ (Projekte), dann
//! BPM −/+ (Auto-Repeat beim Halten) und Position/MIDI-Port-Anzeige.
//!
//! Bewusst flach gehalten: die Leiste steht auf JEDEM Screen und nimmt dem
//! eigentlichen Inhalt Platz weg. Speichern hängt deshalb nicht mehr hier,
//! sondern im Projekt-Menü hinter dem Zahnrad (dort, wo auch geladen und
//! umbenannt wird) — der Server sichert strukturelle Änderungen ohnehin
//! automatisch, der Knopf war ein Notnagel.
//!
//! `transport.tick` kommt gethrottelt aber trotzdem häufig (~30-60 Hz) rein
//! — das läuft bewusst über eine eigene net.onEvent()-Subscription statt
//! über den Store, damit nicht bei jedem Tick die ganze App re-rendert,
//! sondern nur diese Leiste.

import { useEffect, useRef, useState } from "react";
import type { TransportState } from "../net";
import { useNet, useSend } from "./store";
import { Button } from "./widgets/Button";
import { FpsMeter } from "./FpsMeter";
import { TRANSPORT_H } from "./layout";
import { getBgConfig, BG_CONFIG_EVENT } from "./bgConfig";

const BTN = 50;
/** BPM-Wippe: kleiner als die Transport-Tasten, aber noch fingerbreit. */
const NUDGE = 46;

export type TransportView = "start" | "seq" | "library" | "settings";

export interface TransportProps {
  /** Which top-level page is showing — every one of them is reached from
   *  this bar (⌂ Dashboard, SQ Sequencer, ▤ Library, ⚙ Projects), so the
   *  matching button lights up rather than opening a modal. */
  view: TransportView;
  onNav: (view: TransportView) => void;
}

export function Transport({ view, onNav }: TransportProps) {
  const net = useNet();
  const send = useSend();
  const [t, setT] = useState<TransportState | null>(null);
  const [ports, setPorts] = useState<string[]>([]);
  const bpmRef = useRef(120);
  const [bpmDisplay, setBpmDisplay] = useState(120);
  /** Optionale FPS-Anzeige (⚙ → Background scene). Nur der Schalter landet
   *  hier — den Rest der Szenen-Konfiguration liest background.ts selbst. */
  const [showFps, setShowFps] = useState(() => getBgConfig().showFps);

  useEffect(() => {
    const sync = () => setShowFps(getBgConfig().showFps);
    window.addEventListener(BG_CONFIG_EVENT, sync);
    return () => window.removeEventListener(BG_CONFIG_EVENT, sync);
  }, []);

  useEffect(() => {
    const off = net.onEvent((evt) => {
      if ((evt.t === "transport.tick" || evt.t === "state.snapshot") && evt.transport) {
        setT(evt.transport);
        bpmRef.current = Math.round(evt.transport.bpm);
        setBpmDisplay(bpmRef.current);
      }
      if (evt.t === "midi.ports") setPorts(evt.outputs ?? []);
    });
    return off;
  }, [net]);

  const nudgeBpm = (delta: number) => {
    const next = Math.min(300, Math.max(20, bpmRef.current + delta));
    bpmRef.current = next;
    setBpmDisplay(next);
    send({ t: "transport.setBpm", bpm: next });
  };

  const posText = t ? `${t.bar} : ${t.beat}` : "1 : 1";
  const portText = ports.length > 0 ? `MIDI: ${ports.length} Out` : "MIDI: no ports";

  return (
    <div
      className="hifi-rail"
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        height: TRANSPORT_H,
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "0 16px",
        // Nur die Farbe hier — den Glas-Verlauf (background-image) und die
        // Fase liefert .hifi-rail in theme.css.
        backgroundColor: "rgba(17, 17, 17, 0.82)",
        borderBottom: "2px solid rgba(255, 255, 255, 0.25)",
      }}
    >
      <Button
        className={t?.playing ? "transport-stop" : "transport-play"}
        style={{ width: BTN, height: BTN, fontSize: 24, marginRight: 6 }}
        title={t?.playing ? "Stop" : "Play"}
        onClick={() => {
          if (t?.playing) {
            send({ t: "transport.stop" });
            send({ t: "transport.panic" });
          } else {
            send({ t: "transport.play" });
          }
        }}
      >
        {t?.playing ? "■" : "▶"}
      </Button>
      <Button
        className={view === "seq" ? "transport-nav on" : "transport-nav"}
        style={{ width: BTN, height: BTN, fontSize: 20 }}
        onClick={() => onNav("seq")}
      >
        SQ
      </Button>
      <Button
        className={view === "start" ? "transport-nav on" : "transport-nav"}
        style={{ width: BTN, height: BTN, fontSize: 26 }}
        onClick={() => onNav("start")}
      >
        ⌂
      </Button>
      <Button
        className={view === "library" ? "transport-nav on" : "transport-nav"}
        style={{ width: BTN, height: BTN, fontSize: 22 }}
        title="Block library"
        onClick={() => onNav("library")}
      >
        ▤
      </Button>
      <Button
        className={view === "settings" ? "transport-nav on" : "transport-nav"}
        style={{ width: BTN, height: BTN, fontSize: 26, marginRight: 16 }}
        title="Projects"
        onClick={() => onNav("settings")}
      >
        ⚙
      </Button>

      <RepeatButton width={NUDGE} height={NUDGE} onFire={() => nudgeBpm(-1)}>
        −
      </RepeatButton>
      <div className="mono" style={{ width: 84, textAlign: "center", fontSize: 18, fontWeight: 700 }}>
        {bpmDisplay}
        <span style={{ fontSize: 11, color: "var(--pal-text-dim)", marginLeft: 3 }}>BPM</span>
      </div>
      <RepeatButton width={NUDGE} height={NUDGE} onFire={() => nudgeBpm(1)}>
        +
      </RepeatButton>

      <div style={{ marginLeft: "auto", textAlign: "right" }}>
        <div
          className="mono"
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "flex-end",
            gap: 10,
            fontSize: 24,
            fontWeight: 700,
            color: "var(--pal-white)",
          }}
        >
          {showFps && <FpsMeter />}
          {/* Metronom-Punkt: der `key` wechselt mit jedem Beat, React montiert
              das Element also neu — dadurch startet die CSS-Animation von
              vorn, ohne dass hier ein Timer oder eine Klasse verwaltet wird.
              Beat 1 blitzt heller (Taktanfang). */}
          {t?.playing && (
            <span
              key={`${t.bar}:${t.beat}`}
              className={t.beat === 1 ? "beat-dot downbeat" : "beat-dot"}
              aria-hidden="true"
            />
          )}
          {posText}
        </div>
        <div style={{ fontSize: 12, color: "var(--pal-text-dim)" }}>{portText}</div>
      </div>

      {/* Wortmarke ganz rechts: "MIDI" über "REEF", zwei Zeilen, bewusst klein.
          Gleiche Schrift wie die BPM-Anzeige (system-ui, fett), aber mit
          gebürstetem-Metall-Schimmer — s. .hifi-mark in theme.css. */}
      <div className="hifi-mark" aria-label="MIDI REEF" title="MIDI REEF">
        <span>MIDI</span>
        <span>REEF</span>
      </div>
    </div>
  );
}

/** Hold → fires immediately, then repeats every 70ms after a 350ms delay
 *  (matches ui/transport.ts's makeButton({ repeat: true })). */
function RepeatButton({
  width,
  height,
  onFire,
  children,
}: {
  width: number;
  height: number;
  onFire: () => void;
  children: React.ReactNode;
}) {
  const holdTimer = useRef<number | undefined>(undefined);
  const repeatTimer = useRef<number | undefined>(undefined);

  const stop = () => {
    window.clearTimeout(holdTimer.current);
    window.clearInterval(repeatTimer.current);
  };

  return (
    <Button
      style={{ width, height, fontSize: 20 }}
      onPointerDown={() => {
        onFire();
        holdTimer.current = window.setTimeout(() => {
          repeatTimer.current = window.setInterval(onFire, 70);
        }, 350);
      }}
      onPointerUp={stop}
      onPointerLeave={stop}
    >
      {children}
    </Button>
  );
}
