//! Wassertropfen-Rückmeldung: bei jedem Tipp erscheint am Finger ein kurz
//! aufblühender Ring mit weichem Kern — wie ein Tropfen, der auf Wasser
//! trifft. Auf einem Touchdisplay ohne Mauszeiger ist das die einzige
//! Bestätigung, dass ein Druck überhaupt angekommen ist (und wo).
//!
//! ZWEI Dinge sind hier wichtig:
//!
//! 1) Der Tropfen liegt im DOM, ganz oben (`.ripple-layer`, z-index über allem
//!    inkl. Popups und Schublade) — NICHT mehr im Pixi-Hintergrund wie zuvor.
//!    Dort zeichnete er zwar mit, war aber hinter jeder deckenden Fläche
//!    unsichtbar: Knöpfe, Kacheln, Raster-Zellen, Popups — also praktisch
//!    überall dort, wo man tatsächlich hintippt (die Piano-Rolle etwa besteht
//!    nur aus deckenden Zellen). Und bei Hintergrund-Preset „off" steht der
//!    Pixi-Ticker still, dann kam gar nichts mehr.
//!
//! 2) Animiert werden ausschließlich `transform` und `opacity` — die beiden
//!    Eigenschaften, die der Compositor allein erledigt, ohne die Seite neu zu
//!    rastern. Genau deshalb darf der Tropfen auch bei „Animations: Off"
//!    laufen (s. motionConfig.ts: dieser Schalter zielt auf die DAUERnden
//!    background-position/box-shadow-Animationen, die den Pi wirklich kosten).
//!
//! Ausgelöst wird über EINEN `pointerdown`-Listener am Fenster: alles, was der
//! app-weiten Konvention „anfassbar = `cursor: pointer`" folgt, tropft von
//! selbst — kein Knopf, keine Kachel und keine Zelle muss etwas dafür tun.
//! Reine Zieh-/Schiebeflächen setzen konventionsgemäß kein `cursor: pointer`
//! und bleiben deshalb ruhig; `data-no-ripple` schaltet es punktuell ab.

/** Lebensdauer eines Tropfens — muss die längste Keyframe-Animation in
 *  theme.css (`ripple-ring`) überdauern, sonst verschwindet er zu früh. */
const LIFETIME_MS = 600;

/** Mehr gleichzeitige Tropfen bringt niemand mit zehn Fingern zustande; der
 *  Deckel schützt nur davor, dass ein hängender Timer den Layer vollmüllt. */
const MAX_LIVE = 12;

let layer: HTMLDivElement | null = null;

/** Ein Tropfen an Viewport-Koordinaten (wie `PointerEvent.clientX/Y`).
 *  Öffentlich, damit eine Stelle, die kein `cursor: pointer` trägt, ihn von
 *  Hand auslösen kann. */
export function spawnRipple(x: number, y: number, ink?: string) {
  if (!layer) return;
  while (layer.childElementCount >= MAX_LIVE) layer.firstElementChild!.remove();

  const drop = document.createElement("div");
  drop.className = "ripple-drop";
  drop.style.left = `${x}px`;
  drop.style.top = `${y}px`;
  if (ink) drop.style.setProperty("--ripple-rgb", ink);
  drop.appendChild(document.createElement("i")).className = "ripple-core";
  drop.appendChild(document.createElement("i")).className = "ripple-ring";
  layer.appendChild(drop);

  // Aufräumen per Timer statt `animationend`: der feuert pro Kind einzeln und
  // gar nicht, falls die Animation je doch unterdrückt wird.
  window.setTimeout(() => drop.remove(), LIFETIME_MS);
}

/** Legt die Tropfen-Ebene an und hängt den globalen Auslöser ans Fenster. */
export function wireGlobalRipples() {
  if (layer) return;
  layer = document.createElement("div");
  layer.className = "ripple-layer";
  layer.setAttribute("aria-hidden", "true");
  // Direkt an <body>, nicht in #react-root: dessen `z-index` erzeugt einen
  // Stacking-Context, innerhalb dessen der Tropfen niemals über ein Popup
  // käme. <body> liegt außerdem im selben `zoom`-Kontext wie die Oberfläche
  // (s. uiScale.ts), also passen die clientX/Y direkt.
  document.body.appendChild(layer);

  window.addEventListener(
    "pointerdown",
    (e: PointerEvent) => {
      // Nur der führende Finger: beim Zwei-Finger-Scrollen (touchScroll.ts)
      // soll nicht jeder zweite Kontakt aufblitzen.
      if (!e.isPrimary) return;
      const target = e.target as Element | null;
      if (!target || target.closest("[data-no-ripple]")) return;
      if (getComputedStyle(target).cursor !== "pointer") return;
      spawnRipple(e.clientX, e.clientY, inkFor(target));
    },
    // Passiv: der Tropfen greift nie in die Geste ein (Scrollen soll sofort
    // starten dürfen).
    { passive: true },
  );
}

/** Tropfen-Farbe als "r,g,b" — hell auf dunklem Grund, dunkel auf hellem.
 *  Ohne das bliebe ein weißer Tropfen auf den hellen Flächen (gesetzte Note,
 *  aktiver Knopf) unsichtbar — also genau dort, wo am meisten getippt wird. */
function inkFor(target: Element): string {
  // Der getroffene Knoten ist oft ein <span> ohne eigenen Hintergrund; also
  // aufwärts suchen, bis eine deckende Fläche kommt.
  for (let el: Element | null = target, hops = 0; el && hops < 6; el = el.parentElement, hops++) {
    const bg = getComputedStyle(el).backgroundColor;
    const m = /^rgba?\(([^)]+)\)/.exec(bg);
    if (!m) continue;
    const [r, g, b, a] = m[1].split(",").map((v) => parseFloat(v));
    if ((a ?? 1) < 0.5) continue; // durchsichtig — sagt nichts über den Grund
    // Grobe Helligkeit nach Rec. 601; die Palette ist ohnehin graustufig.
    if (0.299 * r + 0.587 * g + 0.114 * b > 150) return "0,0,0";
    return "255,255,255";
  }
  return "255,255,255";
}
