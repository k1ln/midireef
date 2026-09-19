//! Laufzeit-Feedback der Wiedergabe ("was läuft gerade?").
//!
//! Der Server schickt alle 16tel ein `lane.runtime`-Event mit dem laufenden
//! Baustein je Lane und dessen Puls-Position (s. clock.rs `broadcast_runtime`).
//! Daraus wird hier ein flüssiges Bild:
//!
//!  • pro Snapshot wird der Sweep NICHT selbst weitergerechnet, sondern nur
//!    das Ziel + die Dauer bis zum nächsten Snapshot ins DOM geschrieben
//!    (CSS-Variable `--play` + `--play-dur`); die Bewegung dazwischen
//!    interpoliert der Browser per CSS-Transition. Das läuft auf der
//!    Animations-Uhr statt auf unserem rAF neben dem Pixi-Renderer → kein
//!    Ruckeln unter GPU-Last, und kein React-Re-Render pro Frame.
//!  • ein React-Re-Render pro Frame für jede Slot-Kachel wäre auf dem
//!    Touch-Gerät ohnehin sinnlos teuer — dieselbe Überlegung wie bei
//!    Transport.tsx' eigener Tick-Subscription.
//!
//! Komponenten melden ihre DOM-Knoten über `setTile()`/`setLane()` an (via
//! `useRuntimeTile()`/`useRuntimeLane()` als ref-Callback) und bekommen dann:
//!   .playing   — dieser Baustein läuft (grüner Rahmen, blitzt an)
//!   .starting  — kurzer Aufblitz-Puls im Moment des Blockstarts
//!   --play     — 0..1 Fortschritt im Block (Playhead/Balken)
//!   --play-step / --play-steps — aktueller Step und Step-Anzahl
//!   .hit       — auf der Lane: es wurden gerade Noten gesendet
//! Das Ausblenden am Blockende macht CSS (transition auf .play-glow), nicht JS.
//!
//! Dasselbe noch einmal für den offenen Baustein-Detail-Editor (`setBlock()` /
//! `setBlockStatus()`, adressiert über die BLOCK-Id statt über Lane+Slot): dort
//! wandert derselbe `--play-step` als Spalten-Playhead über das Step-Raster und
//! der Status-Chip sagt in Worten, was gerade rausgeht — inklusive des Falls
//! „CC-Baustein läuft, aber die Lane hat kein Ziel, es kommt nichts an".

import type { Net } from "../net";

/** Ein Snapshot-Stand pro Lane, Basis der Weiterrechnung bis zum nächsten. */
interface LaneState {
  slotId: string;
  blockId: string;
  kind: string; // "melody" | "beat" | "cc"
  pos: number; // Puls-Position zum Snapshot-Zeitpunkt
  len: number; // Block-Länge in Pulsen
  steps: number;
  hits: number;
  /** Nur CC: Ziel-CC der Lane (undefined = kein Ziel → es geht nichts raus). */
  ccNumber?: number;
  /** Nur CC: zuletzt tatsächlich gesendeter Wert 0..127. */
  ccValue?: number;
  at: number; // performance.now() des Snapshots
  /** Dieser Snapshot ist ein Sprung (Blockstart/Loop) → Sweep hart setzen,
   *  nicht rückwärts hin animieren. */
  justLooped?: boolean;
  /** Per Touch vorgemerkte Kachel, die noch auf ihre Quantisierungsgrenze
   *  wartet (Server: `LaneRuntime.queued_slot_id`). */
  queuedSlotId?: string;
  /** `false` = die Lane ist noch stumm und nur vorgemerkt (getaktete Lanes).
   *  Dann darf die Kachel NICHT als laufend leuchten. */
  running?: boolean;
}

/** Fallback-Text des Status-Chips, bis die Komponente ihren eigenen Grund
 *  mitliefert (sie weiß, ob der Baustein überhaupt in einer Lane hängt). */
const IDLE_TEXT = "idle";

const SEP = "\0";

export class RuntimeFeed {
  private lanes = new Map<string, LaneState>();
  private tiles = new Map<string, HTMLElement>(); // Key: laneId + SEP + slotId
  private laneNodes = new Map<string, HTMLElement>();
  /** Offener Baustein-Detail-Editor: Wurzel (Klassen + CSS-Variablen) und
   *  Status-Chip (Text), beide je Baustein-Id. Normalerweise höchstens einer. */
  private blockNodes = new Map<string, HTMLElement>();
  private blockStatusNodes = new Map<string, HTMLElement>();
  /** Was der Chip sagen soll, solange der Baustein nicht läuft. */
  private blockIdleText = new Map<string, string>();
  /** Bausteine, deren Chip nur "step/total" statt ausgeschriebener Sätze
   *  zeigen soll — s. `BlockRuntimeStatus`s `compact`-Prop. */
  private compactBlocks = new Set<string>();
  /** Welche Kachel je Lane momentan als "playing" markiert ist. */
  private lit = new Map<string, string>();
  /** Zuletzt als „wartend" markierte Kachel je Lane — damit die Markierung
   *  wieder abgeräumt wird, sobald der Trigger scharf geworden (oder
   *  zurückgenommen) ist. */
  private armed = new Map<string, string>();
  private playing = false;
  private pulsesPerSec = 48; // 120 BPM * 24 PPQN / 60, bis der erste Snapshot kommt
  /** Abstand der letzten beiden Snapshots (s) — Dauer der CSS-Interpolation. */
  private snapDur = 0.13;
  private lastSnapAt = 0;

  /** Abonniert die `lane.runtime`-Events. Gibt die Abmelde-Funktion zurück. */
  attach(net: Net): () => void {
    return net.onEvent((evt: any) => {
      if (evt.t !== "lane.runtime") return;
      this.playing = !!evt.playing;
      if (typeof evt.pulsesPerSec === "number" && evt.pulsesPerSec > 0) {
        this.pulsesPerSec = evt.pulsesPerSec;
      }

      const now = performance.now();
      // Abstand zum vorigen Snapshot = Dauer, über die CSS bis zum nächsten
      // interpolieren soll (auf einen sinnvollen Bereich begrenzt).
      const interval = this.lastSnapAt ? (now - this.lastSnapAt) / 1000 : 0.13;
      this.snapDur = Math.max(0.03, Math.min(0.4, interval));
      this.lastSnapAt = now;

      // Summe frisch gesendeter Noten in diesem Snapshot — treibt die
      // Wiedergabe-Reaktivität des Pixi-Hintergrunds (background.ts hört auf
      // `mr-note` / `mr-runtime`; ohne aktivierte Reaktivität passiert nichts).
      let newHits = 0;
      const seen = new Set<string>();
      for (const l of (evt.lanes ?? []) as any[]) {
        seen.add(l.laneId);
        const prev = this.lanes.get(l.laneId);
        // Sprung erkennen: neuer Slot (anderer Block) oder Positions-Rücksprung
        // (Loop/Trigger) → Sweep hart setzen statt rückwärts animieren.
        const justLooped =
          !prev || prev.slotId !== l.slotId || (l.pos ?? 0) < prev.pos;
        this.lanes.set(l.laneId, {
          slotId: l.slotId,
          blockId: l.blockId ?? "",
          kind: l.kind ?? "",
          pos: l.pos ?? 0,
          len: Math.max(1, l.lenPulses ?? 1),
          steps: Math.max(1, l.steps ?? 1),
          hits: l.hits ?? 0,
          ccNumber: l.ccNumber ?? undefined,
          ccValue: l.ccValue ?? undefined,
          queuedSlotId: l.queuedSlotId ?? undefined,
          running: l.running !== false,
          at: now,
          justLooped,
        });
        // Nur echte Noten-Sends blitzen — Step-Grenzen können leer sein.
        if (prev && prev.hits !== (l.hits ?? 0)) {
          newHits += Math.max(1, (l.hits ?? 0) - prev.hits);
          this.flashLane(l.laneId);
          this.flashBlock(l.blockId);
        }
        // Positions-Rücksprung bei GLEICHEM Slot = der Block hat neu begonnen
        // (Loop oder Touch-Trigger). Ohne das würde eine Lane mit nur einem
        // (oder einem endlos geloopten) Baustein nie wieder anblitzen, weil
        // sich die aktive Kachel nicht ändert.
        if (prev && prev.slotId === l.slotId && (l.pos ?? 0) < prev.pos) {
          this.flashTile(l.laneId, l.slotId);
        }
      }
      for (const laneId of [...this.lanes.keys()]) {
        if (!seen.has(laneId)) this.lanes.delete(laneId);
      }

      // Hintergrund-Reaktivität füttern (entkoppelt über Fensterevents, weil
      // der Pixi-Hintergrund neben React läuft, s. main.tsx).
      window.dispatchEvent(
        new CustomEvent("mr-runtime", {
          detail: { playing: this.playing, pulsesPerSec: this.pulsesPerSec },
        }),
      );
      if (newHits > 0) {
        window.dispatchEvent(
          new CustomEvent("mr-note", { detail: { strength: Math.min(3, newHits) } }),
        );
      }

      this.apply(now); // Ziel + Dauer setzen, CSS interpoliert selbst
      });
    }

  /** Aktueller Step eines Bausteins, live berechnet — für das Live-Einspielen
   *  (s. PlayIn.tsx `mode: "live"`): eine gespielte Note braucht ihre
   *  Step-Position JETZT, beim Drücken/Loslassen, nicht erst beim nächsten
   *  DOM-Write von `apply()`. Dieselbe Interpolation wie dort, nur auf Abruf
   *  statt geschrieben. `null`, wenn der Baustein gerade in keiner Lane läuft
   *  (gestoppt, gemutet, oder in keiner Lane eingehängt) — dann gibt es keine
   *  Live-Position, an die man schreiben könnte. Läuft er in mehreren Lanes,
   *  zählt (wie bei `paintBlock`) die erste gefundene. */
  currentStep(blockId: string): number | null {
    const now = performance.now();
    for (const st of this.lanes.values()) {
      if (st.blockId !== blockId || st.running === false) continue;
      const pos = Math.min(st.len, st.pos + ((now - st.at) / 1000) * this.pulsesPerSec);
      const frac = pos / st.len;
      return Math.min(st.steps - 1, Math.floor(frac * st.steps));
    }
    return null;
  }

  /** Läuft der Transport gerade? (s. `currentStep` — Live-Einspielen startet
   *  ihn selbst, wenn nicht.) */
  isPlaying(): boolean {
    return this.playing;
  }

  /** Ist GENAU diese Kachel gerade die leuchtende (laufende) einer Lane? Für
   *  "manual"-Lanes entscheidet das, ob ein Tipp auf die Trigger-Leiste die
   *  Lane stoppen (aktive Kachel erneut getippt) oder starten soll (s.
   *  `SlotTile`s Trigger-Leiste) — reicht dafür `this.lit` direkt durch statt
   *  denselben Stand aus einem Snapshot neu herzuleiten. */
  isPlayingSlot(laneId: string, slotId: string): boolean {
    return this.lit.get(laneId) === slotId;
  }

  /** ref-Callback-Ziel einer Slot-Kachel (`null` = Komponente unmountet). */
  setTile(laneId: string, slotId: string, el: HTMLElement | null) {
    const key = laneId + SEP + slotId;
    if (!el) {
      this.tiles.delete(key);
      return;
    }
    this.tiles.set(key, el);
    // Neu gemountete Kachel eines gerade laufenden Blocks direkt einfärben —
    // ohne Start-Blitz, sie fängt ja mitten im Lauf an (z.B. nach Screen-Wechsel).
    if (this.lit.get(laneId) === slotId) el.classList.add("playing");
  }

  /** ref-Callback-Ziel einer Lane-Zeile (für den Noten-Puls). */
  setLane(laneId: string, el: HTMLElement | null) {
    if (el) this.laneNodes.set(laneId, el);
    else this.laneNodes.delete(laneId);
  }

  /** ref-Callback-Ziel der Wurzel des Baustein-Detail-Editors. */
  setBlock(blockId: string, el: HTMLElement | null) {
    if (el) {
      this.blockNodes.set(blockId, el);
      this.apply(performance.now()); // läuft der Baustein schon, sofort einfärben
    } else {
      this.blockNodes.delete(blockId);
    }
  }

  /** ref-Callback-Ziel des Status-Chips. Seinen Text schreibt AUSSCHLIESSLICH
   *  diese Klasse — die Komponente rendert ihn leer, sonst überschriebe ein
   *  React-Re-Render die Laufzeit-Anzeige mit dem statischen JSX-Kind. */
  setBlockStatus(blockId: string, el: HTMLElement | null, idleText = IDLE_TEXT, compact = false) {
    if (el) {
      this.blockStatusNodes.set(blockId, el);
      this.blockIdleText.set(blockId, idleText);
      if (compact) this.compactBlocks.add(blockId);
      else this.compactBlocks.delete(blockId);
      el.textContent = idleText;
      this.apply(performance.now());
    } else {
      this.blockStatusNodes.delete(blockId);
      this.blockIdleText.delete(blockId);
      this.compactBlocks.delete(blockId);
    }
  }

  /** Setzt Ziel + Interpolationsdauer des Sweeps auf einem Knoten. Zwischen
   *  den Snapshots bewegt die CSS-Transition `--play` selbst weiter. */
  private armPlay(
    el: HTMLElement,
    st: LaneState,
    pos: number,
    frac: number,
    step: number,
  ) {
    let target: number;
    let dur: number;
    if (st.justLooped || !this.playing) {
      // Sprung/Stop: hart auf den Ist-Stand, keine Rückwärts-Animation.
      target = frac;
      dur = 0;
    } else {
      // Ziel = voraussichtlicher Stand beim nächsten Snapshot, Dauer = dessen
      // Abstand → der Sweep läuft in Echtzeit, ohne dass wir pro Frame rechnen.
      const aheadPulses = this.snapDur * this.pulsesPerSec;
      target = Math.min(1, (pos + aheadPulses) / st.len);
      dur = this.snapDur;
    }
    el.style.setProperty("--play-dur", `${dur.toFixed(3)}s`);
    el.style.setProperty("--play", target.toFixed(4));
    el.style.setProperty("--play-step", String(step));
    el.style.setProperty("--play-steps", String(st.steps));
  }

  /** Schreibt den Stand in das DOM. Aufgerufen pro Snapshot und beim Mounten. */
  private apply(now: number) {
    // Bausteine, für die in diesem Durchlauf schon gemalt wurde — läuft
    // derselbe Baustein in mehreren Lanes, zeigt der Editor die erste davon.
    const paintedBlocks = new Set<string>();

    for (const [laneId, st] of this.lanes) {
      const pos = Math.min(st.len, st.pos + ((now - st.at) / 1000) * this.pulsesPerSec);
      const frac = pos / st.len;
      const el = this.tiles.get(laneId + SEP + st.slotId);

      // Nur vorgemerkt (getaktete Lane, wartet auf ihre Grenze): der Eintrag
      // existiert allein für die „scharf"-Markierung — nicht als laufend zeigen.
      if (st.running === false) {
        const prev = this.lit.get(laneId);
        if (prev) {
          this.unlight(laneId, prev);
          this.lit.delete(laneId);
        }
      } else if (this.lit.get(laneId) !== st.slotId) {
        const prev = this.lit.get(laneId);
        if (prev) this.unlight(laneId, prev);
        this.lit.set(laneId, st.slotId);
        if (el) {
          el.classList.add("playing");
          restartAnimation(el, "starting");
        }
      }

      // Vorgemerkte Kachel markieren: der Touch ist angekommen, der Baustein
      // wartet nur noch auf seine Grenze (Beat/Takt/Blockende).
      const prevArmed = this.armed.get(laneId);
      if (prevArmed !== st.queuedSlotId) {
        if (prevArmed) {
          this.tiles.get(laneId + SEP + prevArmed)?.classList.remove("queued");
        }
        if (st.queuedSlotId) {
          this.tiles.get(laneId + SEP + st.queuedSlotId)?.classList.add("queued");
          this.armed.set(laneId, st.queuedSlotId);
        } else {
          this.armed.delete(laneId);
        }
      }

      const step = Math.min(st.steps - 1, Math.floor(frac * st.steps));
      if (el) this.armPlay(el, st, pos, frac, step);

      if (this.blockNodes.has(st.blockId) && !paintedBlocks.has(st.blockId)) {
        paintedBlocks.add(st.blockId);
        this.paintBlock(st, pos, frac, step);
      }

      st.justLooped = false; // nur einmal hart setzen
    }

    // Offener Editor eines Bausteins, der gerade NICHT läuft: zurück auf idle.
    for (const [blockId, el] of this.blockNodes) {
      if (paintedBlocks.has(blockId)) continue;
      el.classList.remove("playing");
      const status = this.blockStatusNodes.get(blockId);
      const idle = this.blockIdleText.get(blockId) ?? IDLE_TEXT;
      if (status && status.textContent !== idle) status.textContent = idle;
    }

    // Lanes, die nicht mehr laufen (Stop, gelöscht, gemutet): ausblenden lassen.
    for (const [laneId, slotId] of [...this.lit]) {
      if (!this.lanes.has(laneId)) {
        this.unlight(laneId, slotId);
        this.disarm(laneId);
        this.lit.delete(laneId);
      }
    }
  }

  private unlight(laneId: string, slotId: string) {
    const el = this.tiles.get(laneId + SEP + slotId);
    el?.classList.remove("playing", "starting");
  }

  /** Wartemarkierungen einer Lane abräumen (Stop, Lane weg). */
  private disarm(laneId: string) {
    const slotId = this.armed.get(laneId);
    if (!slotId) return;
    this.tiles.get(laneId + SEP + slotId)?.classList.remove("queued");
    this.armed.delete(laneId);
  }

  /** Start-Blitz auf einer Kachel neu auslösen. */
  private flashTile(laneId: string, slotId: string) {
    const el = this.tiles.get(laneId + SEP + slotId);
    if (el) restartAnimation(el, "starting");
  }

  private flashLane(laneId: string) {
    const el = this.laneNodes.get(laneId);
    if (el) restartAnimation(el, "hit");
  }

  /** Blitz auf dem Status-Chip: „genau jetzt ist etwas rausgegangen". Bewusst
   *  auf dem kleinen Chip und nicht auf der Editor-Wurzel — `restartAnimation`
   *  erzwingt ein Reflow, und das über ein großes Step-Raster zu tun wäre pro
   *  gesendetem Step unnötig teuer. */
  private flashBlock(blockId: string) {
    const el = this.blockStatusNodes.get(blockId);
    if (el) restartAnimation(el, "hit");
  }

  /** Laufzeit-Stand in den offenen Baustein-Detail-Editor schreiben. */
  private paintBlock(st: LaneState, pos: number, frac: number, step: number) {
    const el = this.blockNodes.get(st.blockId);
    if (!el) return;
    el.classList.add("playing");
    // Sweep wie bei den Kacheln per CSS interpolieren lassen.
    let target: number;
    let dur: number;
    if (st.justLooped || !this.playing) {
      target = frac;
      dur = 0;
    } else {
      target = Math.min(1, (pos + this.snapDur * this.pulsesPerSec) / st.len);
      dur = this.snapDur;
    }
    el.style.setProperty("--play-dur", `${dur.toFixed(3)}s`);
    el.style.setProperty("--play", target.toFixed(4));
    el.style.setProperty("--play-step", String(step));
    el.style.setProperty("--play-steps", String(st.steps));
    if (st.ccValue !== undefined) {
      el.style.setProperty("--cc01", (st.ccValue / 127).toFixed(4));
    }

    const status = this.blockStatusNodes.get(st.blockId);
    if (!status) return;
    const text = statusText(st, step, this.compactBlocks.has(st.blockId));
    if (status.textContent !== text) status.textContent = text;
  }
}

/** Was der Status-Chip sagt, während der Baustein läuft. Für CC-Bausteine ist
 *  die wichtigste Auskunft nicht der Wert, sondern OB überhaupt etwas rausgeht:
 *  ohne Ziel-Knob an der Lane läuft die Automation ins Leere (s. `resolve_cc_target`
 *  in engine.rs), und das sah bisher genauso aus wie eine stille Kurve.
 *  `compact` (Piano-Rolle, s. Nutzer-Feedback): nur "step/total", ohne Satz
 *  drumherum — der volle Grund/Wert steht dort ohnehin nicht zur Verfügung. */
function statusText(st: LaneState, step: number, compact: boolean): string {
  if (compact) return `${step + 1}/${st.steps}`;
  const pos = `▶ step ${step + 1}/${st.steps}`;
  if (st.kind !== "cc") return pos;
  if (st.ccNumber === undefined) return `${pos} · no CC target on the lane — nothing is sent`;
  const val = st.ccValue === undefined ? "–" : String(st.ccValue);
  return `${pos} · sending CC ${st.ccNumber} = ${val}`;
}

/** Startet eine CSS-Animation neu — Klasse ab, Reflow erzwingen, Klasse dran. */
function restartAnimation(el: HTMLElement, cls: string) {
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
}
