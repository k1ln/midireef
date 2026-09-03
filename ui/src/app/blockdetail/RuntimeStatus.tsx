//! „Läuft der Baustein gerade, und geht dabei etwas raus?" — die Zeile, die
//! man beim Schrauben am offenen Editor braucht, vor allem bei CC-Automation:
//! eine Kurve, die ins Leere fährt (Lane ohne Ziel-Knob), sah bisher exakt aus
//! wie eine, die sendet.
//!
//! Text und Pegel schreibt `runtime.ts` pro Frame direkt ins DOM (Chip-Text,
//! `--cc01` auf der Editor-Wurzel) — deshalb rendert der Chip hier bewusst
//! KEIN Kind: React würde es bei jedem Re-Render über die Laufzeit-Anzeige
//! zurückschreiben. Aus demselben Grund kostet dieses Feedback keinen einzigen
//! Re-Render, egal wie schnell die Automation läuft.

import type { Block, Store } from "../../state";
import { useRuntimeBlockStatus, useStoreValue } from "../store";

/** Baustein-Typen, die die Engine wirklich abspielt (s. `compile_block` in
 *  engine.rs — alles andere fällt dort raus und taucht nie im Runtime-Feed
 *  auf). Ohne diesen Hinweis stünde der Editor eines solchen Bausteins bei
 *  laufendem Transport auf „idle" und man suchte den Fehler bei sich. */
const PLAYABLE = ["melody", "beat", "cc", "chord", "arp"];

export function BlockRuntimeStatus({ block }: { block: Block }) {
  const idleText = useStoreValue((s) => idleReason(s, block));
  const statusRef = useRuntimeBlockStatus(block.id, idleText);

  return (
    <div className="runtime-strip">
      <span className="runtime-chip" ref={statusRef} />
      {block.type === "cc" && (
        <span className="cc-meter" title="last value actually sent">
          <i />
        </span>
      )}
    </div>
  );
}

/** Warum gerade nichts zu sehen ist — der statische Teil des Feedbacks, den
 *  der Server nicht liefern kann, weil ein nirgends eingehängter Baustein im
 *  Runtime-Feed schlicht fehlt. */
function idleReason(s: Store, block: Block): string {
  if (!PLAYABLE.includes(block.type)) {
    return `idle — ${block.type} blocks aren't played by the engine yet`;
  }
  const lanes = (s.project?.devices ?? []).flatMap((d) => d.lanes ?? []);
  const inLanes = lanes.filter((l) => (l.slots ?? []).some((sl) => sl.blockId === block.id));
  if (inLanes.length === 0) return "idle — not in any lane, so nothing can play it";
  if (inLanes.every((l) => l.muted || !l.enabled)) return "idle — every lane holding it is muted";
  return "idle — this block is not running";
}
