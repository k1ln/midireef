//! Stand der Baustein-Vorschau („▶ Play" im Baustein-Detail, `block.play`), vom
//! Server als `block.preview` gemeldet (einmal je Step, `blockId: null` =
//! beendet). Gemeinsam für die Play-Knöpfe der Kopfzeile und den Test-Knopf der
//! 1601-Ansicht, damit beide denselben Zustand zeigen — egal, wo gestartet wurde.

import { useEffect, useState } from "react";
import { useNet } from "../store";

export function useBlockPreview(blockId: string): { playing: boolean; step: number | null } {
  const net = useNet();
  const [state, setState] = useState<{ playing: boolean; step: number | null }>({ playing: false, step: null });
  useEffect(() => {
    setState({ playing: false, step: null });
    return net.onEvent((evt) => {
      if (evt.t !== "block.preview") return;
      if (evt.blockId === blockId) setState({ playing: true, step: typeof evt.step === "number" ? evt.step : null });
      else setState((s) => (s.playing ? { playing: false, step: null } : s));
    });
  }, [net, blockId]);
  return state;
}
