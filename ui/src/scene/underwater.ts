//! Unterwasser-Szene (Schwarzweiß): schwarzes Wasser mit Wellen-Verzerrung,
//! Kaustik-Licht, aufsteigende weiße Blasen, wiegende Algen und weiße Fische,
//! die in Schwimmrichtung schauen und blinzeln. Pixel-Look über einen
//! Pixelate-Filter, Wasser-Bewegung über einen animierten Displacement-Filter.

import {
  Container,
  DisplacementFilter,
  Graphics,
  Sprite,
  Texture,
  Ticker,
} from "pixi.js";
import {
  AdvancedBloomFilter,
  GodrayFilter,
  PixelateFilter,
} from "pixi-filters";
import { PAL } from "../theme";
import type { BgConfig } from "../app/bgConfig";

export const THEME = {
  ray: PAL.white,
  algae: 0xcfcfcf,
  bubble: PAL.white,
  fish: PAL.white,
};

function gradientTexture(w: number, h: number): Texture {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, "#1a1a1a"); // etwas helleres Schwarz an der Oberfläche
  g.addColorStop(0.5, "#0d0d0d");
  g.addColorStop(1, "#000000"); // reines Schwarz in der Tiefe
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  return Texture.from(canvas);
}

/** Weiche, mehrlagige Wellen-Textur als Displacement-Map. Mehrere Oktaven
 *  überlagerter Sinuswellen ergeben eine organischere, weniger regelmäßige
 *  Verzerrung als eine einzelne Frequenz. */
function displacementTexture(size = 256): Texture {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const img = ctx.createImageData(size, size);
  // Kachelbare Oktaven: ganzzahlige Frequenzen über 2π.
  const oct = [
    { fx: 1, fy: 1, a: 1.0, p: 0.0 },
    { fx: 2, fy: 3, a: 0.55, p: 1.3 },
    { fx: 5, fy: 4, a: 0.28, p: 2.7 },
    { fx: 8, fy: 7, a: 0.14, p: 0.6 },
  ];
  let norm = 0;
  for (const o of oct) norm += o.a;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const u = (x / size) * Math.PI * 2;
      const v = (y / size) * Math.PI * 2;
      let rx = 0;
      let ry = 0;
      for (const o of oct) {
        rx += o.a * Math.sin(u * o.fx + Math.cos(v * o.fy) + o.p);
        ry += o.a * Math.sin(v * o.fy + Math.cos(u * o.fx) * 1.5 + o.p);
      }
      img.data[i] = 128 + (110 * rx) / norm;
      img.data[i + 1] = 128 + (110 * ry) / norm;
      img.data[i + 2] = 128;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = Texture.from(canvas);
  tex.source.wrapMode = "repeat";
  return tex;
}

/** Weicher radialer Lichtfleck (Glow) — für Kaustik-Lichtpfützen am Boden. */
function glowTexture(size = 128): Texture {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const g = ctx.createRadialGradient(
    size / 2,
    size / 2,
    0,
    size / 2,
    size / 2,
    size / 2,
  );
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.4, "rgba(255,255,255,0.35)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return Texture.from(canvas);
}

/** Tiefen-Vignette: dunkelt Ränder und Boden ab → atmosphärische Tiefe. */
function vignetteTexture(w: number, h: number): Texture {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  // Radiale Vignette (Ränder abdunkeln).
  const rad = ctx.createRadialGradient(
    w / 2,
    h * 0.42,
    Math.min(w, h) * 0.2,
    w / 2,
    h * 0.5,
    Math.max(w, h) * 0.75,
  );
  rad.addColorStop(0, "rgba(0,0,0,0)");
  rad.addColorStop(1, "rgba(0,0,0,0.85)");
  ctx.fillStyle = rad;
  ctx.fillRect(0, 0, w, h);
  return Texture.from(canvas);
}

/** Kürzester Abstand zwischen zwei Noten-Stößen (ms). Bei 16teln/120 BPM
 *  kämen sonst 8 Stöße pro Sekunde. */
const PULSE_MIN_MS = 120;
/** Absolute Obergrenze an Blasen. Greift, wenn sehr dicht gespielt wird. */
const BUBBLE_HARD_CAP = 90;

interface Bubble {
  g: Graphics;
  speed: number;
  wobble: number;
  phase: number;
  /** Aus einem Noten-Stoß (`pulse`) entstanden: verschwindet oben endgültig,
   *  statt wie die Grundmenge wieder unten aufzutauchen. Ohne diese
   *  Unterscheidung wächst die Blasenzahl während der Wiedergabe unbegrenzt. */
  transient?: boolean;
}

/** Plankton: 1 Pixel breit, driftet frei in alle Richtungen (nicht nur nach oben). */
interface Plankton {
  g: Graphics;
  vx: number;
  vy: number;
  phase: number;
}

interface Fish {
  c: Container;
  eye: Graphics;
  kind: "fish" | "shark" | "turtle";
  scaleBase: number;
  speed: number;
  dir: number;
  phase: number;
  nextBlink: number;
  blink: number; // verbleibende Blinzel-Zeit
}

/** Qualle: treibt, pulsiert, wird von Schildkröten gefressen. */
interface Jelly {
  c: Container;
  bell: Graphics;
  x: number;
  y: number;
  driftX: number;
  vy: number;
  phase: number;
  scaleBase: number;
}

interface Algae {
  g: Graphics;
  baseX: number;
  maxHeight: number;
  growth: number; // 0..1 aktuelle Höhe (wird abgefressen / wächst nach)
  maxGrowth: number; // individuelle Obergrenze (< 1)
  regrow: number; // Nachwachs-Rate pro Sekunde
  phase: number;
  growthPhase: number; // für unregelmäßiges Wachstum
  segments: number;
  kind: "kelp" | "grass" | "feather"; // Wuchsform
  seed: number; // deterministische Variation innerhalb der Form
  strands: number; // Anzahl paralleler Halme (grass) bzw. Nebenstiele
  width: number; // Grundbreite des Stiels
}

/** Tintenfisch: treibt und schießt in Stößen (Rückstoßantrieb) durchs Bild,
 *  der Mantel zieht sich beim Stoß zusammen. Blickt/fährt mantelvoran. */
interface Squid {
  c: Container;
  x: number;
  y: number;
  vx: number;
  vy: number;
  aim: number; // Fahrtrichtung (rad)
  burstCd: number; // Sekunden bis zum nächsten Stoß
  squish: number; // 0..1 Mantelkontraktion, klingt ab
  scaleBase: number;
}

/** Hydrothermale Schlot-Quelle am Boden: ein massiver Felskegel ("black
 *  smoker"), aus dem eine dichte, wallende Rauchschwade quillt. */
interface Chimney {
  c: Container;
  x: number;
  ventY: number; // y der Austrittsöffnung
  mouth: number; // Breite der Öffnung → Streuung der Schwaden
  emit: number; // Sekunden bis zum nächsten Schwadenstoß
  particles: ChimneyParticle[];
}

interface ChimneyParticle {
  s: Sprite; // weiche Rauch-Wolke (Glow-Textur)
  x: number; // Welt-Koordinaten (float; werden auf s.x/s.y geschrieben)
  y: number;
  vx: number;
  vy: number; // negativ = Auftrieb
  age: number;
  life: number;
  sway: number;
  size0: number; // Start-Durchmesser
  size1: number; // End-Durchmesser (Schwade weitet sich beim Aufsteigen)
  turb: number; // Turbulenz-Frequenzfaktor pro Partikel
}

/** Boden-Tier (Krabbe/Schnecke), das zu Algen läuft und sie abfrisst. */
interface Grazer {
  c: Container;
  kind: "crab" | "snail";
  x: number;
  dir: number;
  scale: number;
  speed: number;
  targetIndex: number;
  state: "approach" | "eat" | "leave";
  legPhase: number;
}

/** Neuzeichnungen der Algen-Geometrie pro Pflanze und Sekunde (s. redrawAlgae). */
const ALGAE_HZ = 10;

export class UnderwaterScene {
  readonly container = new Container();
  private scene = new Container();
  private bg: Sprite;
  private caustics = new Container();
  private lightPools = new Container();
  private dispSprite: Sprite;
  private dispSprite2: Sprite;
  private dispFilter: DisplacementFilter;
  private dispFilter2: DisplacementFilter;
  private godray: GodrayFilter;
  private vignette: Sprite;
  private pools: { s: Sprite; baseX: number; baseY: number; phase: number; r: number }[] = [];
  private bubbles: Bubble[] = [];
  private lastPulseAt = 0;
  private plankton: Plankton[] = [];
  private fishes: Fish[] = [];
  private jellies: Jelly[] = [];
  private squids: Squid[] = [];
  private chimneys: Chimney[] = [];
  private algae: Algae[] = [];
  private algaeCursor = 0; // Rundlauf-Zeiger für die verteilte Neuzeichnung
  private algaeBudget = 0; // aufgelaufener Bruchteil einer fälligen Pflanze
  // Scratch-Puffer für stalkPoints(): pro Halm und Frame würde ein frisches
  // Punkte-Array sonst den GC füttern (segments ≤ 10, 64 ist reichlich).
  private stalkX = new Float64Array(64);
  private stalkY = new Float64Array(64);
  private grazers: Grazer[] = [];
  private grazerCooldown = 1; // Sekunden bis das nächste Tier kommt
  private glowTex = glowTexture(128);
  private w = 0;
  private h = 0;
  private time = 0;
  /** Nutzer-Konfiguration (Preset + Kreaturenzahl + Reaktivität). */
  private cfg: BgConfig;
  /** Strömungs-/Bewegungs-Faktor: 1 = normal, folgt bei laufender Wiedergabe
   *  weich dem Tempo (s. setTempo). */
  private tempo = 1;
  private tempoTarget = 1;
  /** Kurzer Ausschlag nach einer Notensendung (s. pulse) — klingt pro Frame ab
   *  und hebt God-Rays/Kaustik an. */
  private noteFlash = 0;

  constructor(cfg: BgConfig) {
    this.cfg = cfg;
    this.container.addChild(this.scene);

    this.bg = new Sprite(gradientTexture(8, 256));
    this.scene.addChild(this.bg);

    // Kaustik-Lichtpfützen am Boden (unter allem Leben, additiv → weiches Glimmen).
    this.lightPools.blendMode = "add";
    this.scene.addChild(this.lightPools);
    this.scene.addChild(this.caustics);

    // Zwei Displacement-Ebenen mit unterschiedlicher Skalierung/Geschwindigkeit
    // → mehrlagige, organische Wasser-Turbulenz statt einer festen Frequenz.
    this.dispSprite = new Sprite(displacementTexture(256));
    this.dispSprite.renderable = false;
    this.dispSprite.scale.set(2.4);
    this.scene.addChild(this.dispSprite);
    this.dispFilter = new DisplacementFilter({
      sprite: this.dispSprite,
      scale: 16,
    });

    this.dispSprite2 = new Sprite(displacementTexture(256));
    this.dispSprite2.renderable = false;
    this.dispSprite2.scale.set(0.9);
    this.scene.addChild(this.dispSprite2);
    this.dispFilter2 = new DisplacementFilter({
      sprite: this.dispSprite2,
      scale: 6,
    });

    // Volumetrische Lichtstrahlen von der Oberfläche (God Rays).
    this.godray = new GodrayFilter({
      angle: 28,
      gain: 0.4,
      lacunarity: 2.4,
      alpha: 0.5,
    });

    // Dezentes Nachleuchten heller Elemente (Streulicht im Wasser) — weich,
    // nicht flächig ausbrennend. Niedrige Qualität/Blur = weniger Blur-Pässe.
    const bloom = new AdvancedBloomFilter({
      threshold: 0.55,
      bloomScale: 0.45,
      brightness: 1.0,
      blur: 3,
      quality: 4,
    });

    // Filterkette: Wasser-Verzerrung (2 Lagen) → Lichtstrahlen → Bloom →
    // harter Pixel-Look über die gesamte Szene.
    this.scene.filters = [
      this.dispFilter,
      this.dispFilter2,
      this.godray,
      bloom,
      new PixelateFilter(2),
    ];

    // Tiefen-Vignette liegt ÜBER der gefilterten Szene (kein Bloom/Displacement),
    // damit die Ränder sauber ins Schwarz abtauchen.
    this.vignette = new Sprite(Texture.WHITE);
    this.vignette.alpha = 1;
    this.container.addChild(this.vignette);
  }

  resize(w: number, h: number) {
    this.w = w;
    this.h = h;
    this.bg.width = w;
    this.bg.height = h;
    this.dispSprite.width = w;
    this.dispSprite.height = h;
    this.dispSprite2.width = w;
    this.dispSprite2.height = h;
    this.vignette.texture = vignetteTexture(Math.max(2, w), Math.max(2, h));
    this.vignette.width = w;
    this.vignette.height = h;
    this.buildCaustics();
    this.buildLightPools();
    this.buildAlgae();
    this.drawAllAlgae();
    this.ensureBubbles();
    this.ensurePlankton();
    this.syncFishes();
    this.syncJellies();
    this.syncSquids();
    this.syncChimneys();
  }

  /** Neue Nutzer-Konfiguration übernehmen: Kreaturenzahl live nachziehen,
   *  Algen-Feld neu aufbauen, wenn sich die Dichte geändert hat. */
  setConfig(cfg: BgConfig) {
    const kelpChanged = cfg.kelp !== this.cfg.kelp;
    this.cfg = cfg;
    if (kelpChanged) this.buildAlgae();
    this.syncFishes();
    this.syncJellies();
    this.syncSquids();
    this.syncChimneys();
  }

  /** Strömungs-Faktor setzen (background.ts, aus dem laufenden Tempo). Wird im
   *  update() weich angefahren, damit ein Tempowechsel nicht ruckt. */
  setTempo(factor: number) {
    this.tempoTarget = Math.max(0.25, Math.min(3, factor));
  }

  /** Eine Notensendung der Wiedergabe: Blasenstoß vom Boden + kurzer Lichtblitz. */
  /** Noten-Stoß: kurzer Aufblitz + ein Schwung Blasen.
   *
   *  Zwei Bremsen, ohne die eine dichte Sequenz den Hintergrund flutet: bei
   *  16teln auf 120 BPM kommen bis zu 8 Stöße/s, und jede Blase braucht 6–12 s
   *  nach oben. Ungebremst stehen nach kurzer Zeit mehrere Hundert gleichzeitig
   *  im Bild — das war die Ursache für „viele Blasen" UND für das Ruckeln des
   *  Baustein-Sweeps (der Pi rendert dann nichts anderes mehr flüssig). */
  pulse(strength = 1) {
    this.noteFlash = Math.min(1, this.noteFlash + 0.25 * strength);

    // 1) Nicht öfter als alle PULSE_MIN_MS ein Stoß.
    const now = performance.now();
    if (now - this.lastPulseAt < PULSE_MIN_MS) return;
    this.lastPulseAt = now;

    // 2) Nie mehr als BUBBLE_HARD_CAP Blasen insgesamt.
    const room = BUBBLE_HARD_CAP - this.bubbles.length;
    if (room <= 0) return;
    const count = Math.min(room, 3 + Math.min(6, strength * 2));

    const x = Math.random() * this.w;
    for (let i = 0; i < count; i++) {
      const b = this.makeBubble();
      b.g.x = x + (Math.random() - 0.5) * 40;
      b.g.y = this.h + Math.random() * 20;
      b.speed = 60 + Math.random() * 60;
      b.transient = true; // oben entsorgen, nicht wieder unten einsetzen
      this.bubbles.push(b);
    }
  }

  private buildLightPools() {
    this.lightPools.removeChildren();
    this.pools = [];
    const count = Math.max(3, Math.floor(this.w / 320));
    for (let i = 0; i < count; i++) {
      const s = new Sprite(this.glowTex);
      s.anchor.set(0.5);
      const r = 140 + Math.random() * 220;
      const baseX = Math.random() * this.w;
      const baseY = this.h - 20 - Math.random() * (this.h * 0.28);
      s.width = r * 2;
      s.height = r * 1.1;
      s.x = baseX;
      s.y = baseY;
      s.alpha = 0.05 + Math.random() * 0.05;
      this.lightPools.addChild(s);
      this.pools.push({ s, baseX, baseY, phase: Math.random() * Math.PI * 2, r });
    }
  }

  private buildCaustics() {
    this.caustics.removeChildren();
    // Horizontale Lichtbänder, die wandern → Wasseroberflächen-Reflexe.
    const bands = Math.max(5, Math.floor(this.h / 120));
    for (let i = 0; i < bands; i++) {
      const g = new Graphics();
      (g as any).__baseY = (this.h / bands) * i;
      this.caustics.addChild(g);
    }
  }

  /** Algen-Feld auf die konfigurierte Zahl bringen. Bewusst INKREMENTELL:
   *  am Kelp-Regler zu ziehen feuert BG_CONFIG_EVENT im Dutzend — würde jedes
   *  davon alle Pflanzen neu anlegen (und neu tessellieren), ruckelt der Pi. */
  private buildAlgae() {
    const count = this.cfg.kelp;
    while (this.algae.length > count) this.algae.pop()!.g.destroy();
    while (this.algae.length < count) {
      const g = new Graphics();
      this.scene.addChild(g);
      const a = { g, ...this.randomAlgaeTraits() };
      this.algae.push(a);
      this.drawAlgae(a); // sofort zeichnen, sonst blitzt sie erst später auf
    }
  }

  /** Alle Pflanzen sofort neu zeichnen (nach einem Resize: die alte Geometrie
   *  hängt an der alten Höhe und darf nicht erst nach und nach nachziehen). */
  private drawAllAlgae() {
    for (const a of this.algae) this.drawAlgae(a);
  }

  /** Zufällige Wuchs-Eigenschaften einer Pflanze (neu wachsend / nachwachsend). */
  private randomAlgaeTraits(): Omit<Algae, "g"> {
    const kinds: Algae["kind"][] = ["kelp", "grass", "feather"];
    const kind = kinds[Math.floor(Math.random() * kinds.length)];
    return {
      baseX: Math.random() * this.w,
      maxHeight: 70 + Math.random() * 230,
      growth: 0.2 + Math.random() * 0.6,
      maxGrowth: 0.65 + Math.random() * 0.35, // Obergrenze pro Pflanze
      regrow: 0.03 + Math.random() * 0.06,
      phase: Math.random() * Math.PI * 2,
      growthPhase: Math.random() * Math.PI * 2,
      segments: 6 + Math.floor(Math.random() * 5),
      kind,
      seed: Math.random() * 1000,
      strands: kind === "grass" ? 3 + Math.floor(Math.random() * 4) : 1,
      width: kind === "kelp" ? 5 + Math.random() * 3 : 2.5 + Math.random() * 2,
    };
  }

  private ensurePlankton() {
    const target = Math.max(60, Math.floor((this.w * this.h) / 7000));
    while (this.plankton.length < target)
      this.plankton.push(this.makePlankton());
  }

  private makePlankton(): Plankton {
    const g = new Graphics();
    // Nur ein Pixel breit (der Pixelate-Filter macht daraus einen Punkt).
    g.rect(0, 0, 1, 1).fill({ color: PAL.white, alpha: 0.5 + Math.random() * 0.4 });
    g.x = Math.random() * this.w;
    g.y = Math.random() * this.h;
    this.scene.addChild(g);
    const ang = Math.random() * Math.PI * 2;
    const spd = 4 + Math.random() * 10;
    return {
      g,
      vx: Math.cos(ang) * spd,
      vy: Math.sin(ang) * spd,
      phase: Math.random() * Math.PI * 2,
    };
  }

  private makeGrazer(kind: Grazer["kind"]): Grazer {
    const c = new Container();
    const scale = 0.9 + Math.random() * 0.9;
    if (kind === "crab") drawCrab(c);
    else drawSnail(c);
    this.scene.addChild(c);
    // Tritt von einem Rand ein und läuft zur Zielpflanze.
    const fromLeft = Math.random() < 0.5;
    const x = fromLeft ? -20 : this.w + 20;
    const g: Grazer = {
      c,
      kind,
      x,
      dir: fromLeft ? 1 : -1,
      scale,
      speed: 28 + Math.random() * 22,
      targetIndex: -1,
      state: "approach",
      legPhase: Math.random() * Math.PI * 2,
    };
    this.pickTarget(g);
    return g;
  }

  private pickTarget(g: Grazer) {
    // Ziel: eine gut gewachsene Alge; sonst gleich wieder abwandern.
    let best = -1;
    let bestGrowth = 0.3;
    for (let i = 0; i < this.algae.length; i++) {
      const gr = this.algae[i].growth;
      if (gr > bestGrowth) {
        bestGrowth = gr;
        best = i;
      }
    }
    g.targetIndex = best;
    if (best < 0) g.state = "leave";
  }

  /** Frisst die Pflanze ganz auf → sie wächst zufällig woanders neu. */
  private consumePlant(idx: number) {
    const a = this.algae[idx];
    if (!a) return;
    Object.assign(a, this.randomAlgaeTraits(), { growth: 0 });
  }

  private drawAlgae(a: Algae) {
    const g = a.g;
    g.clear();
    const h = a.maxHeight * a.growth;
    if (h < 5) {
      // Abgefressen: nur ein kleiner Stummel am Boden.
      g.moveTo(a.baseX, this.h)
        .lineTo(a.baseX, this.h - 5)
        .stroke({ color: THEME.algae, width: 5, alpha: 0.4, cap: "round" });
      return;
    }
    if (a.kind === "grass") this.drawGrass(a, h);
    else if (a.kind === "feather") this.drawFeather(a, h);
    else this.drawKelp(a, h);
  }

  /** Gemeinsamer, sanft wiegender Stiel. Schreibt die Punkte in stalkX/stalkY
   *  und liefert deren Anzahl — allokationsfrei, weil das pro Halm und Frame
   *  läuft. */
  private stalkPoints(
    baseX: number,
    h: number,
    segments: number,
    phase: number,
    seed: number,
    xOffset = 0,
  ): number {
    const sway = Math.sin(this.time * 0.9 + phase) * 4;
    const n = Math.min(segments, this.stalkX.length - 1);
    for (let s = 0; s <= n; s++) {
      const t = s / n;
      // Zwei Frequenzen → organischere, sich langsam wellende Krümmung.
      const bend =
        Math.sin(this.time * 0.9 + phase + t * 1.6) * sway * t +
        Math.sin(this.time * 0.5 + seed + t * 3.0) * 3 * t;
      this.stalkX[s] = baseX + xOffset + bend;
      this.stalkY[s] = this.h - h * t;
    }
    return n + 1;
  }

  /** Breittang: kräftiger, sich verjüngender Stiel mit gefiederten Blättern. */
  private drawKelp(a: Algae, h: number) {
    const g = a.g;
    const n = this.stalkPoints(a.baseX, h, a.segments, a.phase, a.seed);
    const px = this.stalkX;
    const py = this.stalkY;
    // Verjüngender Stiel als EIN Polygon (links hinauf, rechts zurück) statt
    // eines Strokes je Segment: ein Tessellations- und Batch-Vorgang statt
    // zehn. Der Stiel steht nahezu senkrecht, daher genügt ein horizontaler
    // Versatz als Normale.
    const halfW = (t: number) => a.width * (1 - t * 0.7) * 0.5;
    g.moveTo(px[0] - halfW(0), py[0]);
    for (let i = 1; i < n; i++) g.lineTo(px[i] - halfW(i / (n - 1)), py[i]);
    for (let i = n - 1; i >= 0; i--) g.lineTo(px[i] + halfW(i / (n - 1)), py[i]);
    g.fill({ color: THEME.algae, alpha: 0.5 });
    // Blätter: an fast jedem Knoten, wechselseitig, als geschwungene Klingen —
    // alle in EINEN Pfad, dann ein einziger Stroke.
    const leaves = Math.min(n - 1, Math.max(1, Math.floor((a.segments - 1) * a.growth)));
    for (let i = 1; i <= leaves; i++) {
      const bx = px[i];
      const by = py[i];
      const side = i % 2 === 0 ? 1 : -1;
      const len = (30 - i * 1.8) * a.growth;
      const wobble = Math.sin(this.time * 1.1 + a.seed + i) * 4;
      g.moveTo(bx, by).quadraticCurveTo(
        bx + side * len * 0.6 + wobble,
        by - 4,
        bx + side * len * 0.4 + wobble * 1.5,
        by - 12 - i,
      );
    }
    g.stroke({ color: THEME.algae, width: 2.5, alpha: 0.4, cap: "round" });
  }

  /** Seegras: mehrere schlanke, unterschiedlich hohe Halme aus einem Büschel.
   *  Alle Halme landen in einem Pfad → ein Stroke pro Büschel. */
  private drawGrass(a: Algae, h: number) {
    const g = a.g;
    const px = this.stalkX;
    const py = this.stalkY;
    for (let s = 0; s < a.strands; s++) {
      const off = (s - (a.strands - 1) / 2) * 4;
      const sh = h * (0.7 + ((s * 37) % 30) / 100); // je Halm etwas andere Höhe
      const n = this.stalkPoints(
        a.baseX,
        sh,
        a.segments,
        a.phase + s * 0.6,
        a.seed + s * 13,
        off,
      );
      g.moveTo(px[0], py[0]);
      for (let i = 1; i < n; i++) g.lineTo(px[i], py[i]);
    }
    // Ein Stroke heißt eine Breite für alle Halme (vorher verjüngte sich jeder
    // Halm um 6 %); die Variation trägt ohnehin Höhe und Phase.
    g.stroke({
      color: THEME.algae,
      width: a.width * (1 - (a.strands - 1) * 0.03),
      alpha: 0.4,
      cap: "round",
    });
  }

  /** Federalge: Mittelrippe mit dicht stehenden, feinen Seitenfiedern. */
  private drawFeather(a: Algae, h: number) {
    const g = a.g;
    const n = this.stalkPoints(a.baseX, h, a.segments, a.phase, a.seed);
    const px = this.stalkX;
    const py = this.stalkY;
    // Mittelrippe.
    g.moveTo(px[0], py[0]);
    for (let i = 1; i < n; i++) g.lineTo(px[i], py[i]);
    g.stroke({ color: THEME.algae, width: a.width, alpha: 0.5, cap: "round" });
    // Feine Fiedern paarweise an jedem Segment — ebenfalls ein Pfad, ein Stroke.
    const grown = Math.floor((n - 1) * a.growth);
    let any = false;
    for (let i = 1; i <= grown; i++) {
      const len = (14 - i * 0.8) * a.growth;
      if (len <= 1) continue;
      const bx = px[i];
      const by = py[i];
      const wob = Math.sin(this.time * 1.3 + a.seed + i * 0.5) * 2;
      g.moveTo(bx, by)
        .lineTo(bx + len + wob, by - 6)
        .moveTo(bx, by)
        .lineTo(bx - len + wob, by - 6);
      any = true;
    }
    if (any)
      g.stroke({ color: THEME.algae, width: 1, alpha: 0.32, cap: "round" });
  }

  /** Algen-Geometrie über die Frames verteilen. Jede Pflanze pro Frame neu zu
   *  tessellieren war der teuerste Posten der Szene (bei 480 Kelp: ~500 Pfade
   *  je Frame, samt Buffer-Upload). Das Wiegen läuft mit ~0.9 rad/s, also über
   *  7 s je Schwingung — ALGAE_HZ Aktualisierungen pro Pflanze und Sekunde
   *  sind davon nicht zu unterscheiden, kosten aber nur einen Bruchteil.
   *  Bruchteile einer fälligen Pflanze werden über die Frames aufsummiert,
   *  damit auch dichte Felder gleichmäßig durchlaufen. */
  private redrawAlgae(dt: number) {
    const n = this.algae.length;
    if (n === 0) return;
    if (this.algaeCursor >= n) this.algaeCursor = 0; // Feld wurde verkleinert
    this.algaeBudget = Math.min(n, this.algaeBudget + n * ALGAE_HZ * dt);
    let due = Math.floor(this.algaeBudget);
    this.algaeBudget -= due;
    while (due-- > 0) {
      this.drawAlgae(this.algae[this.algaeCursor]);
      this.algaeCursor = (this.algaeCursor + 1) % n;
    }
  }

  private updateGrazers(dt: number) {
    for (let i = this.grazers.length - 1; i >= 0; i--) {
      const g = this.grazers[i];
      g.legPhase += dt * 8;

      // Zahl im Betrieb gesenkt: die überzähligen (am Ende der Liste) abwandern.
      if (i >= this.cfg.crabs && g.state !== "leave") g.state = "leave";

      if (g.state === "leave") {
        // Vom Bild ablaufen, dann entfernen; Cooldown bis zum nächsten Tier.
        g.x += g.dir * g.speed * dt;
        g.c.y = this.h - 4 + Math.sin(g.legPhase) * 1;
        if (g.x < -60 || g.x > this.w + 60) {
          g.c.destroy();
          this.grazers.splice(i, 1);
          this.grazerCooldown = 2 + Math.random() * 4;
          continue;
        }
      } else {
        const a = this.algae[g.targetIndex];
        if (!a) {
          g.state = "leave";
        } else if (g.state === "approach") {
          const dx = a.baseX - g.x;
          if (Math.abs(dx) < 6) {
            g.state = "eat";
          } else {
            g.dir = dx < 0 ? -1 : 1;
            g.x += g.dir * g.speed * dt;
          }
          g.c.y = this.h - 4 + Math.sin(g.legPhase) * 1;
        } else {
          // eat: die Pflanze ganz auffressen.
          a.growth = Math.max(0, a.growth - 0.35 * dt);
          g.c.y = this.h - 4 + Math.sin(g.legPhase * 2) * 1.5;
          if (a.growth <= 0.02) {
            this.consumePlant(g.targetIndex);
            g.dir = Math.random() < 0.5 ? -1 : 1; // zufällig weggehen
            g.state = "leave";
          }
        }
      }

      g.c.x = g.x;
      g.c.scale.set(g.dir * g.scale, g.scale);
    }
  }

  private ensureBubbles() {
    // Deutlich weniger Blasen (Plankton übernimmt die Fülle).
    const target = Math.max(8, Math.floor((this.w * this.h) / 90000));
    while (this.bubbles.length < target) this.bubbles.push(this.makeBubble());
  }

  private makeBubble(): Bubble {
    const g = new Graphics();
    const radius = 2 + Math.random() * 7;
    g.circle(0, 0, radius).stroke({ color: THEME.bubble, width: 1, alpha: 0.35 });
    g.circle(-radius * 0.3, -radius * 0.3, radius * 0.3).fill({
      color: 0xffffff,
      alpha: 0.5,
    });
    g.x = Math.random() * this.w;
    g.y = this.h + Math.random() * this.h;
    this.scene.addChild(g);
    return {
      g,
      speed: 20 + Math.random() * 45,
      wobble: 8 + Math.random() * 20,
      phase: Math.random() * Math.PI * 2,
    };
  }

  /** Kreaturen-Pool auf die Zielzahl bringen (wächst UND schrumpft — anders als
   *  die alten ensureX(), die nur auffüllten). */
  private syncPool<T>(pool: T[], target: number, make: () => T, kill: (t: T) => void) {
    while (pool.length < target) pool.push(make());
    while (pool.length > target) kill(pool.pop()!);
  }

  private syncFishes() {
    // Überwiegend Fische; ein einzelner Hai, sobald genug Fische da sind.
    this.syncPool(
      this.fishes,
      this.cfg.fish,
      () => {
        const wantShark = this.fishes.length >= 4 && !this.fishes.some((f) => f.kind === "shark");
        return this.makeFish(wantShark && Math.random() < 0.5 ? "shark" : "fish");
      },
      (f) => f.c.destroy(),
    );
  }

  private syncJellies() {
    this.syncPool(this.jellies, this.cfg.jellyfish, () => this.makeJelly(), (j) => j.c.destroy());
  }

  private syncSquids() {
    this.syncPool(this.squids, this.cfg.squid, () => this.makeSquid(), (s) => s.c.destroy());
  }

  private syncChimneys() {
    this.syncPool(
      this.chimneys,
      this.cfg.chimneys,
      () => this.makeChimney(),
      (ch) => {
        for (const p of ch.particles) p.s.destroy();
        ch.c.destroy();
      },
    );
  }

  private makeSquid(): Squid {
    const c = new Container();
    const eye = new Graphics();
    drawSquid(c, eye);
    c.addChild(eye);
    const scaleBase = 0.8 + Math.random() * 0.7;
    const x = Math.random() * this.w;
    const y = 60 + Math.random() * (this.h - 160);
    c.x = x;
    c.y = y;
    this.scene.addChild(c);
    return {
      c,
      x,
      y,
      vx: (Math.random() - 0.5) * 20,
      vy: (Math.random() - 0.5) * 20,
      aim: Math.random() * Math.PI * 2,
      burstCd: Math.random() * 2,
      squish: 0,
      scaleBase,
    };
  }

  private makeChimney(): Chimney {
    const c = new Container();
    const g = new Graphics();
    // Deutlich massiver als früher (war 22–52 hoch / 9–19 breit): ein
    // gewachsener Schlot mit breitem Fuß und schmaler Öffnung.
    const hgt = 46 + Math.random() * 60;
    const wdt = 20 + Math.random() * 24;
    const mouth = 5 + Math.random() * 6;
    const lean = (Math.random() - 0.5) * 10; // Spitze leicht versetzt

    // Geröll-Hügel um den Fuß → sitzt im Boden, nicht aufgesetzt.
    g.ellipse(0, -3, wdt * 1.9, 13).fill({ color: PAL.black, alpha: 0.5 });

    // Hauptkegel mit rauer, gestufter Silhouette.
    g.moveTo(-wdt, 0)
      .lineTo(-wdt * 0.74, -hgt * 0.3)
      .lineTo(-wdt * 0.52, -hgt * 0.33)
      .lineTo(-wdt * 0.44, -hgt * 0.64)
      .lineTo(-mouth, -hgt)
      .lineTo(lean - mouth * 0.5, -hgt - 4)
      .lineTo(lean + mouth * 0.5, -hgt - 4)
      .lineTo(mouth, -hgt)
      .lineTo(wdt * 0.46, -hgt * 0.6)
      .lineTo(wdt * 0.54, -hgt * 0.34)
      .lineTo(wdt * 0.8, -hgt * 0.28)
      .lineTo(wdt, 0)
      .closePath()
      .fill({ color: PAL.black, alpha: 0.72 })
      .stroke({ color: THEME.algae, width: 1.5, alpha: 0.38 });

    // Ein paar Gesteinsschichten als Struktur/Masse.
    for (let i = 1; i <= 3; i++) {
      const y = -hgt * (i / 4);
      const half = wdt * (1 - i / 4) * 0.85;
      g.moveTo(-half, y)
        .lineTo(half, y)
        .stroke({ color: PAL.black, width: 2, alpha: 0.38 });
    }

    // Schwacher Glutschimmer direkt an der Öffnung.
    const vent = new Sprite(this.glowTex);
    vent.anchor.set(0.5);
    vent.width = vent.height = mouth * 3.4;
    vent.x = lean;
    vent.y = -hgt;
    vent.alpha = 0.1;
    c.addChild(g, vent);

    const x = 30 + Math.random() * Math.max(1, this.w - 60);
    c.x = x;
    c.y = this.h;
    this.scene.addChild(c);
    return {
      c,
      x: x + lean,
      ventY: this.h - hgt,
      mouth,
      emit: 0,
      particles: [],
    };
  }

  private makeJelly(): Jelly {
    const c = new Container();
    const bell = new Graphics();
    drawJelly(bell);
    c.addChild(bell);
    const scaleBase = 0.7 + Math.random() * 0.9;
    const x = Math.random() * this.w;
    const y = Math.random() * (this.h - 120);
    c.x = x;
    c.y = y;
    c.scale.set(scaleBase);
    this.scene.addChild(c);
    return {
      c,
      bell,
      x,
      y,
      driftX: (Math.random() - 0.5) * 14,
      vy: -6 - Math.random() * 8,
      phase: Math.random() * Math.PI * 2,
      scaleBase,
    };
  }

  private makeFish(kind: Fish["kind"]): Fish {
    const c = new Container();
    const dir = Math.random() < 0.5 ? 1 : -1;
    const scale =
      kind === "shark"
        ? 1.4 + Math.random() * 0.8
        : kind === "turtle"
          ? 1.1 + Math.random() * 0.5
          : 0.7 + Math.random() * 1.0;

    // Schaut standardmäßig nach RECHTS: Nase bei +x, Schwanz bei -x.
    const eye = new Graphics();
    if (kind === "shark") drawShark(c, eye);
    else if (kind === "turtle") drawTurtle(c, eye);
    else drawFishShape(c, eye);
    c.addChild(eye);

    // dir bestimmt Blickrichtung: nach rechts (1) unverändert, nach links (-1) gespiegelt.
    c.scale.set(dir * scale, scale);
    c.x = dir > 0 ? -20 : this.w + 20;
    c.y = 60 + Math.random() * (this.h - 200);
    this.scene.addChild(c);

    return {
      c,
      eye,
      kind,
      scaleBase: scale,
      dir,
      speed:
        kind === "shark"
          ? 45 + Math.random() * 35
          : kind === "turtle"
            ? 14 + Math.random() * 12
            : 30 + Math.random() * 40,
      phase: Math.random() * Math.PI * 2,
      nextBlink: 1 + Math.random() * 4,
      blink: 0,
    };
  }

  update(ticker: Ticker) {
    const dt = ticker.deltaMS / 1000;
    this.time += dt;

    // Strömungs-Faktor weich ans Ziel-Tempo führen; Notenblitz abklingen lassen.
    this.tempo += (this.tempoTarget - this.tempo) * Math.min(1, dt * 2);
    this.noteFlash = Math.max(0, this.noteFlash - dt * 2.2);
    const flow = this.tempo;

    // Wasser-Verzerrung animieren: zwei Displacement-Ebenen gegenläufig driften
    // lassen → sich überlagernde Wellenfronten wie an einer echten Oberfläche.
    this.dispSprite.x = Math.sin(this.time * 0.3) * 40;
    this.dispSprite.y = this.time * 12;
    this.dispFilter.scale.x = 14 + Math.sin(this.time * 0.7) * 5;
    this.dispFilter.scale.y = 14 + Math.cos(this.time * 0.5) * 5;

    this.dispSprite2.x = -this.time * 22;
    this.dispSprite2.y = -Math.cos(this.time * 0.4) * 30 - this.time * 6;
    this.dispFilter2.scale.x = 6 + Math.cos(this.time * 1.1) * 3;
    this.dispFilter2.scale.y = 6 + Math.sin(this.time * 0.9) * 3;

    // Volumetrische Lichtstrahlen: lebendiger wandernder Einfallswinkel +
    // schwankende Intensität → das Licht flackert wie an einer bewegten Oberfläche.
    this.godray.time = this.time * 0.9;
    this.godray.angle =
      26 + Math.sin(this.time * 0.35) * 12 + Math.sin(this.time * 0.11) * 6;
    // Bei einer Notensendung kurz aufhellen (reactNotes).
    this.godray.gain = 0.4 + Math.sin(this.time * 0.5) * 0.12 + this.noteFlash * 0.5;

    // Kaustik-Lichtpfützen am Boden atmen/wandern leicht.
    for (const p of this.pools) {
      p.phase += dt * 0.4;
      p.s.x = p.baseX + Math.sin(p.phase) * 30;
      p.s.y = p.baseY + Math.cos(p.phase * 0.7) * 12;
      p.s.alpha = 0.05 + (Math.sin(p.phase * 1.3) * 0.5 + 0.5) * 0.06;
    }

    // Kaustik-Bänder wandern (feine Lichtadern an der Oberfläche).
    for (const child of this.caustics.children) {
      const g = child as Graphics;
      const baseY = (g as any).__baseY as number;
      g.clear();
      const y = baseY + Math.sin(this.time * 0.8 + baseY * 0.02) * 18;
      g.moveTo(0, y);
      for (let x = 0; x <= this.w; x += 40) {
        g.lineTo(x, y + Math.sin(this.time * 1.4 + x * 0.02) * 6);
      }
      g.stroke({ color: PAL.white, width: 2, alpha: 0.05 + this.noteFlash * 0.15 });
    }

    // Blasen aufsteigen + wackeln. Rückwärts laufen, damit das Entfernen
    // transienter Blasen den Index nicht verschiebt.
    for (let i = this.bubbles.length - 1; i >= 0; i--) {
      const b = this.bubbles[i];
      b.g.y -= b.speed * dt * flow;
      b.g.x += Math.sin(this.time * 1.5 + b.phase) * b.wobble * dt;
      if (b.g.y < -20) {
        if (b.transient) {
          // Stoß-Blase hat ihren Weg hinter sich — abräumen. Genau das fehlte:
          // vorher wurde JEDE Blase unten neu eingesetzt und nie zerstört.
          b.g.destroy();
          this.bubbles.splice(i, 1);
        } else {
          b.g.y = this.h + 20;
          b.g.x = Math.random() * this.w;
        }
      }
    }

    // Plankton driftet frei umher (Richtung wandert langsam), wrap an den Rändern.
    for (const p of this.plankton) {
      p.phase += dt;
      const wander = 6 * dt;
      p.vx += Math.cos(p.phase * 1.7) * wander;
      p.vy += Math.sin(p.phase * 1.3) * wander;
      // Geschwindigkeit begrenzen, damit es sanft treibt.
      const max = 16;
      p.vx = Math.max(-max, Math.min(max, p.vx));
      p.vy = Math.max(-max, Math.min(max, p.vy));
      p.g.x += p.vx * dt * flow;
      p.g.y += p.vy * dt * flow;
      if (p.g.x < -2) p.g.x = this.w + 2;
      else if (p.g.x > this.w + 2) p.g.x = -2;
      if (p.g.y < -2) p.g.y = this.h + 2;
      else if (p.g.y > this.h + 2) p.g.y = -2;
    }

    // Algen wachsen unregelmäßig nach, bis zur individuellen Obergrenze. Das
    // ist reine Zahlenarbeit und läuft für alle; die teure Geometrie holt
    // redrawAlgae() reihum nach.
    for (const a of this.algae) {
      a.growthPhase += dt;
      // Wachstumsrate schwankt (mal schneller, mal fast Stillstand).
      const rate = a.regrow * Math.max(0, 0.3 + Math.sin(a.growthPhase * 0.7) + 0.5);
      a.growth = Math.min(a.maxGrowth, a.growth + rate * dt);
    }
    this.redrawAlgae(dt);

    // Boden-Tiere: bis zur konfigurierten Zahl gleichzeitig; jedes frisst eine
    // Pflanze ganz auf und wandert wieder ab. Wird die Zahl gesenkt, schickt
    // updateGrazers die überzähligen von selbst aus dem Bild.
    this.grazerCooldown -= dt;
    if (this.grazers.length < this.cfg.crabs && this.grazerCooldown <= 0) {
      const kind: Grazer["kind"] = Math.random() < 0.5 ? "crab" : "snail";
      this.grazers.push(this.makeGrazer(kind));
      this.grazerCooldown = 2 + Math.random() * 4;
    }
    this.updateGrazers(dt);

    // Tintenfische: Rückstoßstöße + Gleiten.
    this.updateSquids(dt, flow);

    // Schlot-Quellen: Flimmer-Partikel aufsteigen lassen.
    this.updateChimneys(dt, flow);

    // Fische schwimmen (mit seitlichem Wackeln) + blinzeln + jagen.
    for (const f of this.fishes) {
      // Fische & Haie schwimmen IMMER vorwärts (kein Wenden/Rückwärts). Beute
      // wird nur vertikal angesteuert — liegt sie hinter dem Tier, wird sie
      // eben verpasst.
      const prey = this.huntTarget(f);

      // Vortrieb pulsiert leicht, als würde mit dem Schwanz geschlagen.
      const surge = 0.7 + 0.3 * Math.abs(Math.sin(this.time * 8 + f.phase));
      f.c.x += f.dir * f.speed * surge * dt * flow;

      // Sanftes Auf und Ab; beim Jagen vertikal zur Beute steuern (nur wenn die
      // Beute in Schwimmrichtung voraus liegt).
      f.c.y += Math.sin(this.time * 1.1 + f.phase) * 12 * dt;
      const preyAhead = prey ? (prey.x - f.c.x) * f.dir > 0 : false;
      if (prey && preyAhead) {
        const dy = prey.y - f.c.y;
        f.c.y += Math.max(-1, Math.min(1, dy / 40)) * f.speed * 0.5 * dt;
      }
      f.c.y = Math.max(40, Math.min(this.h - 40, f.c.y));

      // Seitliches Wackeln: Körper staucht/streckt sich horizontal.
      const wag = Math.sin(this.time * 9 + f.phase) * 0.16;
      f.c.scale.x = f.dir * f.scaleBase * (1 + wag);
      f.c.scale.y = f.scaleBase * (1 - wag * 0.35);
      f.c.rotation = 0;

      // Blinzeln: Auge periodisch kurz schließen (y-Skalierung → 0 → 1).
      f.nextBlink -= dt;
      if (f.blink > 0) {
        f.blink -= dt;
        const p = Math.max(0, f.blink / 0.14);
        f.eye.scale.y = Math.abs(p - 0.5) * 2;
        if (f.blink <= 0) f.eye.scale.y = 1;
      } else if (f.nextBlink <= 0) {
        f.blink = 0.14;
        f.nextBlink = 2 + Math.random() * 4;
      }

      const out = f.dir > 0 ? f.c.x > this.w + 30 : f.c.x < -30;
      if (out) {
        f.c.y = 60 + Math.random() * (this.h - 200);
        f.c.x = f.dir > 0 ? -30 : this.w + 30;
      }
    }

    // Quallen treiben, pulsieren und steigen langsam auf (wrap an den Rändern).
    for (const j of this.jellies) {
      j.phase += dt;
      j.x += (j.driftX + Math.sin(j.phase * 0.8) * 6) * dt * flow;
      j.y += j.vy * dt * flow;
      if (j.y < -40) j.y = this.h + 40;
      if (j.x < -30) j.x = this.w + 30;
      else if (j.x > this.w + 30) j.x = -30;
      // Pulsieren der Glocke.
      const pulse = 1 + Math.sin(j.phase * 3) * 0.14;
      j.c.scale.set(j.scaleBase, j.scaleBase * pulse);
      j.c.x = j.x;
      j.c.y = j.y;
    }

    // Fressverhalten: Haie fressen Fische, Fische fressen Quallen.
    this.updatePredation();
  }

  /** Nächste Beute in Sichtweite: Haie jagen Fische, Fische jagen Quallen. */
  private huntTarget(f: Fish): { x: number; y: number } | null {
    let best: { x: number; y: number } | null = null;
    let bestD = 260 * 260;
    if (f.kind === "shark") {
      for (const prey of this.fishes) {
        if (prey.kind !== "fish") continue;
        const d = dist2(f.c.x, f.c.y, prey.c.x, prey.c.y);
        if (d < bestD) {
          bestD = d;
          best = { x: prey.c.x, y: prey.c.y };
        }
      }
    } else if (f.kind === "fish") {
      for (const j of this.jellies) {
        const d = dist2(f.c.x, f.c.y, j.x, j.y);
        if (d < bestD) {
          bestD = d;
          best = { x: j.x, y: j.y };
        }
      }
    }
    return best;
  }

  private updatePredation() {
    for (const pred of this.fishes) {
      if (pred.kind === "shark") {
        for (const prey of this.fishes) {
          if (prey.kind !== "fish") continue;
          if (near(pred.c, prey.c, 26)) this.respawnFish(prey);
        }
      } else if (pred.kind === "fish") {
        for (const j of this.jellies) {
          if (near(pred.c, j.c, 22)) this.respawnJelly(j);
        }
      }
    }
  }

  private respawnFish(f: Fish) {
    f.c.x = f.dir > 0 ? -30 : this.w + 30;
    f.c.y = 60 + Math.random() * (this.h - 200);
  }

  private respawnJelly(j: Jelly) {
    j.x = Math.random() * this.w;
    j.y = this.h + 40; // taucht unten neu auf und steigt wieder
  }

  /** Tintenfische: alle paar Sekunden ein Rückstoßstoß in (grob) Blickrichtung,
   *  dazwischen gleiten sie mit Wasserwiderstand aus. Der Mantel zieht sich beim
   *  Stoß zusammen (squish) und der Körper zeigt mantelvoran in Fahrtrichtung. */
  private updateSquids(dt: number, flow: number) {
    for (const s of this.squids) {
      s.burstCd -= dt * flow;
      if (s.burstCd <= 0) {
        s.burstCd = 1.4 + Math.random() * 2.4;
        const ang = s.aim + (Math.random() - 0.5) * 1.2;
        s.aim = ang;
        s.vx += Math.cos(ang) * 130;
        s.vy += Math.sin(ang) * 130;
        s.squish = 1;
      }
      s.squish = Math.max(0, s.squish - dt * 3);
      // Wasserwiderstand + leichtes Absinken zwischen den Stößen.
      s.vx *= 0.985;
      s.vy = s.vy * 0.985 + 7 * dt;
      s.x += s.vx * dt * flow;
      s.y += s.vy * dt * flow;
      if (s.x < -40) s.x = this.w + 40;
      else if (s.x > this.w + 40) s.x = -40;
      if (s.y < 44) {
        s.y = 44;
        s.vy = Math.abs(s.vy) * 0.4;
      } else if (s.y > this.h - 28) {
        s.y = this.h - 28;
        s.vy = -Math.abs(s.vy) * 0.4;
      }
      const speed = Math.hypot(s.vx, s.vy);
      if (speed > 10) s.aim = Math.atan2(s.vy, s.vx);
      // Gezeichnet mit Mantelspitze bei -x → +Math.PI, damit sie voran zeigt.
      s.c.rotation = s.aim + Math.PI;
      const stretch = 1 + s.squish * 0.35;
      s.c.scale.set(s.scaleBase * stretch, s.scaleBase * (1 - s.squish * 0.2));
      s.c.x = s.x;
      s.c.y = s.y;
    }
  }

  /** Schlot-Quellen: stoßen dichte Schwaden weicher Rauch-Wolken aus, die
   *  aufsteigen, sich weiten, turbulent wabern und langsam vergehen — eine
   *  schwere, wallende Säule statt einzelner Flimmer. */
  private updateChimneys(dt: number, flow: number) {
    const CAP = 60; // Wolken pro Schlot — Füllraten-Deckel (Pi läuft auf 30 fps)
    for (const ch of this.chimneys) {
      // ── Emission: mehrere Puffs pro Stoß, in kurzen Abständen ──
      ch.emit -= dt * flow;
      while (ch.emit <= 0) {
        ch.emit += 0.028 + Math.random() * 0.03;
        const puffs = 2 + ((Math.random() * 2.5) | 0);
        for (let k = 0; k < puffs && ch.particles.length < CAP; k++) {
          const s = new Sprite(this.glowTex);
          s.anchor.set(0.5);
          const size0 = 6 + Math.random() * 8;
          const px = ch.x + (Math.random() - 0.5) * ch.mouth * 1.4;
          const py = ch.ventY - Math.random() * 4;
          s.width = s.height = size0;
          s.x = px;
          s.y = py;
          s.alpha = 0;
          this.scene.addChild(s);
          ch.particles.push({
            s,
            x: px,
            y: py,
            vx: (Math.random() - 0.5) * 10,
            vy: -(34 + Math.random() * 42),
            age: 0,
            life: 2.4 + Math.random() * 2.8,
            sway: Math.random() * Math.PI * 2,
            size0,
            size1: size0 * (3.4 + Math.random() * 3.2),
            turb: 0.7 + Math.random() * 0.9,
          });
        }
      }
      // ── Aufstieg, Turbulenz, Weitung ──
      for (let i = ch.particles.length - 1; i >= 0; i--) {
        const pt = ch.particles[i];
        pt.age += dt;
        const t = pt.age / pt.life;
        if (t >= 1) {
          pt.s.destroy();
          ch.particles.splice(i, 1);
          continue;
        }
        // Auftrieb lässt oben nach (Wasser bremst die Schwade ab).
        pt.vy += 24 * dt;
        // Seitliche Turbulenz, gedämpft → wabert, driftet nicht weg.
        pt.vx += Math.sin(pt.age * 2.3 * pt.turb + pt.sway) * 32 * dt;
        pt.vx -= pt.vx * 0.9 * dt;
        pt.x += pt.vx * dt * flow;
        pt.y += pt.vy * dt * flow;
        // Wolke weitet sich beim Aufsteigen auf.
        const size = pt.size0 + (pt.size1 - pt.size0) * Math.pow(t, 0.6);
        pt.s.width = pt.s.height = size;
        pt.s.x = pt.x + Math.sin(pt.age * 1.6 + pt.sway) * 6;
        pt.s.y = pt.y;
        // Schnell auf-, weich abblenden; bleibt unscheinbar (nie hart weiß).
        pt.s.alpha = 0.26 * Math.min(1, t * 6) * (1 - t) * (1 - t);
      }
    }
  }
}

/** Distanz-Check zwischen zwei Containern. */
function near(a: Container, b: Container, r: number): boolean {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy < r * r;
}

/** Quadratische Distanz zwischen zwei Punkten. */
function dist2(ax: number, ay: number, bx: number, by: number): number {
  const dx = ax - bx;
  const dy = ay - by;
  return dx * dx + dy * dy;
}

/** Tintenfisch, monochrom. Mantelspitze zeigt nach -x (Fahrtrichtung, s.
 *  updateSquids' Rotations-Offset), Kopf + Tentakel nach +x. Auge separat. */
function drawSquid(c: Container, eye: Graphics) {
  const body = new Graphics();
  // Mantel: spitze Tüte von der Spitze (-14) bis zum Kopfansatz (+6).
  body
    .moveTo(-14, 0)
    .quadraticCurveTo(-4, -5, 6, -4)
    .quadraticCurveTo(9, 0, 6, 4)
    .quadraticCurveTo(-4, 5, -14, 0)
    .closePath()
    .fill({ color: THEME.fish, alpha: 0.9 });
  // Seitenflossen an der Mantelspitze (rautenförmig).
  body
    .moveTo(-14, 0)
    .lineTo(-20, -5)
    .lineTo(-15, 0)
    .lineTo(-20, 5)
    .closePath()
    .fill({ color: THEME.fish, alpha: 0.85 });
  // Kurze Tentakel am Kopf.
  for (let i = -2; i <= 2; i++) {
    body
      .moveTo(6, i * 1.6)
      .lineTo(14, i * 2.4)
      .stroke({ color: THEME.fish, width: 1, alpha: 0.75 });
  }
  c.addChild(body);
  eye.circle(2, -1.6, 1.4).fill({ color: PAL.black, alpha: 0.9 });
}

/** Qualle (Blickrichtung egal): Glocke + Tentakel, monochrom. */
function drawJelly(g: Graphics) {
  const stroke = { color: PAL.white, width: 1.5, alpha: 0.8 } as const;
  // Glockenkuppel
  g.moveTo(-8, 2);
  g.arc(0, 2, 8, Math.PI, 0);
  g.lineTo(8, 2);
  g.closePath();
  g.fill({ color: PAL.white, alpha: 0.12 }).stroke(stroke);
  // Tentakel
  for (let i = -3; i <= 3; i++) {
    const x = i * 2.2;
    g.moveTo(x, 3)
      .lineTo(x + 1, 9)
      .lineTo(x - 1, 15)
      .stroke({ color: PAL.white, width: 1, alpha: 0.6 });
  }
}

/** Kleiner weißer Fisch (Blickrichtung rechts). Auge separat für Blinzeln. */
function drawFishShape(c: Container, eye: Graphics) {
  const body = new Graphics();
  body
    .ellipse(0, 0, 9, 4)
    .fill({ color: THEME.fish, alpha: 0.95 })
    // Schwanzflosse links
    .moveTo(-9, 0)
    .lineTo(-15, -4)
    .lineTo(-15, 4)
    .closePath()
    .fill({ color: THEME.fish, alpha: 0.95 });
  c.addChild(body);
  eye.circle(5, -1, 1.6).fill({ color: PAL.black, alpha: 0.9 });
}

/** Hai (größer, schlanker, Rückenflosse), Blickrichtung rechts. */
function drawShark(c: Container, eye: Graphics) {
  const body = new Graphics();
  body
    .ellipse(0, 0, 16, 5)
    .fill({ color: THEME.fish, alpha: 0.95 })
    // Schwanzflosse
    .moveTo(-16, 0)
    .lineTo(-24, -7)
    .lineTo(-22, 0)
    .lineTo(-24, 7)
    .closePath()
    .fill({ color: THEME.fish, alpha: 0.95 })
    // Rückenflosse
    .moveTo(-2, -5)
    .lineTo(2, -13)
    .lineTo(6, -5)
    .closePath()
    .fill({ color: THEME.fish, alpha: 0.95 })
    // Brustflosse
    .moveTo(4, 3)
    .lineTo(10, 9)
    .lineTo(10, 3)
    .closePath()
    .fill({ color: THEME.fish, alpha: 0.95 });
  c.addChild(body);
  // Kiemenschlitze + Auge
  body
    .moveTo(9, -2)
    .lineTo(9, 2)
    .moveTo(11, -2)
    .lineTo(11, 2)
    .stroke({ color: PAL.black, width: 1, alpha: 0.5 });
  eye.circle(12, -1.5, 1.4).fill({ color: PAL.black, alpha: 0.9 });
}

/** Schildkröte (Panzer + Flossen + Kopf), Blickrichtung rechts. */
function drawTurtle(c: Container, eye: Graphics) {
  const g = new Graphics();
  const seg = { color: PAL.black, width: 1, alpha: 0.4 } as const;
  // Panzer
  g.ellipse(0, -1, 12, 8).fill({ color: THEME.fish, alpha: 0.95 });
  // Panzer-Segmente
  g.moveTo(-12, -1)
    .lineTo(12, -1)
    .moveTo(-5, -8)
    .lineTo(-5, 6)
    .moveTo(5, -8)
    .lineTo(5, 6)
    .stroke(seg);
  // Kopf vorne rechts
  g.ellipse(14, 1, 4, 3).fill({ color: THEME.fish, alpha: 0.95 });
  // Flossen
  g.ellipse(6, 7, 5, 2.5).fill({ color: THEME.fish, alpha: 0.9 });
  g.ellipse(-8, 7, 5, 2.5).fill({ color: THEME.fish, alpha: 0.9 });
  g.ellipse(-13, 2, 4, 2).fill({ color: THEME.fish, alpha: 0.9 });
  c.addChild(g);
  eye.circle(15, 0, 1.2).fill({ color: PAL.black, alpha: 0.9 });
}

/** Kleine weiße Krabbe (Blickrichtung rechts), monochrom. */
function drawCrab(c: Container) {
  const g = new Graphics();
  const stroke = { color: PAL.white, width: 1.5, alpha: 0.85 } as const;
  // Panzer
  g.ellipse(0, 0, 9, 5).fill({ color: PAL.black, alpha: 0.5 }).stroke(stroke);
  // Augen auf Stielen
  g.moveTo(-3, -4).lineTo(-3, -8).moveTo(3, -4).lineTo(3, -8).stroke(stroke);
  g.circle(-3, -9, 1.4).fill({ color: PAL.white });
  g.circle(3, -9, 1.4).fill({ color: PAL.white });
  // Scheren vorne
  g.moveTo(8, 1).lineTo(14, -3).stroke(stroke);
  g.circle(15, -4, 2.2).stroke(stroke);
  g.moveTo(-8, 1).lineTo(-14, -3).stroke(stroke);
  g.circle(-15, -4, 2.2).stroke(stroke);
  // Beine (je Seite drei)
  for (let i = 0; i < 3; i++) {
    const y = 2 + i * 2;
    g.moveTo(7, y).lineTo(13, y + 3).stroke(stroke);
    g.moveTo(-7, y).lineTo(-13, y + 3).stroke(stroke);
  }
  c.addChild(g);
}

/** Kleine weiße Schnecke (Blickrichtung rechts), monochrom. */
function drawSnail(c: Container) {
  const g = new Graphics();
  const stroke = { color: PAL.white, width: 1.5, alpha: 0.85 } as const;
  // Fuß
  g.ellipse(0, 4, 12, 3).fill({ color: PAL.black, alpha: 0.5 }).stroke(stroke);
  // Kopf + Fühler vorne rechts
  g.ellipse(11, 1, 4, 3).fill({ color: PAL.black, alpha: 0.5 }).stroke(stroke);
  g.moveTo(13, -2).lineTo(15, -7).stroke(stroke);
  g.circle(15, -7, 1).fill({ color: PAL.white });
  // Schneckenhaus (Spirale)
  g.circle(-2, -1, 7).stroke(stroke);
  g.circle(-2, -1, 4).stroke(stroke);
  g.circle(-2, -1, 1.6).stroke(stroke);
  c.addChild(g);
}
