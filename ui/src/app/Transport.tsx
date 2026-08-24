//! Transport-Leiste (oben, eine Reihe) — React-Port von ui/transport.ts.
//! Play ▶, Stop ■, SQ (Sequencer), Start-Symbol (⌂), SAVE, dann BPM −/+
//! (Auto-Repeat beim Halten) und Position/MIDI-Port-Anzeige.
//!
//! `transport.tick` kommt gethrottelt aber trotzdem häufig (~30-60 Hz) rein
//! — das läuft bewusst über eine eigene net.onEvent()-Subscription statt
//! über den Store, damit nicht bei jedem Tick die ganze App re-rendert,
//! sondern nur diese Leiste.

import { useEffect, useRef, useState } from "react";
import type { TransportState } from "../net";
import { useNet, useSend } from "./store";
import { Button } from "./widgets/Button";
import { TRANSPORT_H } from "./layout";

const BTN = 60;

export interface TransportProps {
  view: "start" | "seq";
  onNav: (view: "start" | "seq") => void;
}

export function Transport({ view, onNav }: TransportProps) {
  const net = useNet();
  const send = useSend();
  const [t, setT] = useState<TransportState | null>(null);
  const [ports, setPorts] = useState<string[]>([]);
  const bpmRef = useRef(120);
  const [bpmDisplay, setBpmDisplay] = useState(120);

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
        background: "rgba(17, 17, 17, 0.82)",
        borderBottom: "2px solid rgba(255, 255, 255, 0.25)",
      }}
    >
      <Button
        style={{ width: BTN, height: BTN, fontSize: 24, opacity: t?.playing ? 1 : 0.7 }}
        onClick={() => send({ t: "transport.play" })}
      >
        ▶
      </Button>
      <Button
        style={{ width: BTN, height: BTN, fontSize: 24, opacity: t?.playing ? 0.7 : 1, marginRight: 6 }}
        onClick={() => {
          send({ t: "transport.stop" });
          send({ t: "transport.panic" });
        }}
      >
        ■
      </Button>
      <Button
        style={{ width: BTN, height: BTN, fontSize: 20, opacity: view === "seq" ? 1 : 0.55 }}
        onClick={() => onNav("seq")}
      >
        SQ
      </Button>
      <Button
        style={{ width: BTN, height: BTN, fontSize: 26, opacity: view === "start" ? 1 : 0.55 }}
        onClick={() => onNav("start")}
      >
        ⌂
      </Button>
      <Button
        style={{ width: 84, height: BTN, fontSize: 16, marginRight: 16 }}
        onClick={() => send({ t: "project.save" })}
      >
        SAVE
      </Button>

      <RepeatButton width={56} height={BTN} onFire={() => nudgeBpm(-1)}>
        −
      </RepeatButton>
      <div style={{ width: 120, textAlign: "center", fontSize: 24, fontWeight: 700 }}>
        {bpmDisplay} BPM
      </div>
      <RepeatButton width={56} height={BTN} onFire={() => nudgeBpm(1)}>
        +
      </RepeatButton>

      <div style={{ marginLeft: "auto", textAlign: "right" }}>
        <div style={{ fontFamily: "ui-monospace, monospace", fontSize: 30, fontWeight: 700, color: "var(--pal-white)" }}>
          {posText}
        </div>
        <div style={{ fontSize: 14, color: "var(--pal-text-dim)" }}>{portText}</div>
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
