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

interface Bubble {
  g: Graphics;
  speed: number;
  wobble: number;
  phase: number;
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
  private plankton: Plankton[] = [];
  private fishes: Fish[] = [];
  private jellies: Jelly[] = [];
  private algae: Algae[] = [];
  private grazers: Grazer[] = [];
  private grazerCooldown = 1; // Sekunden bis das nächste Tier kommt
  private glowTex = glowTexture(128);
  private w = 0;
  private h = 0;
  private time = 0;

  constructor() {
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
    this.ensureBubbles();
    this.ensurePlankton();
    this.ensureFishes();
    this.ensureJellies();
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

  private buildAlgae() {
    for (const a of this.algae) a.g.destroy();
    this.algae = [];
    // Mehr Algen, unregelmäßig über die gesamte Breite verteilt (nicht im Raster).
    const count = Math.max(14, Math.floor(this.w / 60));
    for (let i = 0; i < count; i++) {
      const g = new Graphics();
      this.scene.addChild(g);
      this.algae.push({ g, ...this.randomAlgaeTraits() });
    }
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

  /** Gemeinsamer, sanft wiegender Stiel; liefert die Punkte für Anbauten. */
  private stalkPoints(a: Algae, h: number, xOffset = 0) {
    const sway = Math.sin(this.time * 0.9 + a.phase) * 4;
    const pts: { x: number; y: number; t: number }[] = [];
    for (let s = 0; s <= a.segments; s++) {
      const t = s / a.segments;
      // Zwei Frequenzen → organischere, sich langsam wellende Krümmung.
      const bend =
        Math.sin(this.time * 0.9 + a.phase + t * 1.6) * sway * t +
        Math.sin(this.time * 0.5 + a.seed + t * 3.0) * 3 * t;
      pts.push({ x: a.baseX + xOffset + bend, y: this.h - h * t, t });
    }
    return pts;
  }

  /** Breittang: kräftiger, sich verjüngender Stiel mit gefiederten Blättern. */
  private drawKelp(a: Algae, h: number) {
    const g = a.g;
    const pts = this.stalkPoints(a, h);
    // Verjüngender Stiel: von unten (dick) nach oben (dünn) in Segmenten.
    for (let i = 1; i < pts.length; i++) {
      const w = a.width * (1 - pts[i].t * 0.7);
      g.moveTo(pts[i - 1].x, pts[i - 1].y)
        .lineTo(pts[i].x, pts[i].y)
        .stroke({ color: THEME.algae, width: w, alpha: 0.5, cap: "round" });
    }
    // Blätter: an fast jedem Knoten, wechselseitig, als geschwungene Klingen.
    const leaves = Math.max(1, Math.floor((a.segments - 1) * a.growth));
    for (let i = 1; i <= leaves; i++) {
      const base = pts[i];
      const side = i % 2 === 0 ? 1 : -1;
      const len = (30 - i * 1.8) * a.growth;
      const wobble = Math.sin(this.time * 1.1 + a.seed + i) * 4;
      const midX = base.x + side * len * 0.6 + wobble;
      const midY = base.y - 4;
      const tipX = base.x + side * len * 0.4 + wobble * 1.5;
      const tipY = base.y - 12 - i;
      g.moveTo(base.x, base.y)
        .quadraticCurveTo(midX, midY, tipX, tipY)
        .stroke({ color: THEME.algae, width: 2.5, alpha: 0.4, cap: "round" });
    }
  }

  /** Seegras: mehrere schlanke, unterschiedlich hohe Halme aus einem Büschel. */
  private drawGrass(a: Algae, h: number) {
    const g = a.g;
    for (let s = 0; s < a.strands; s++) {
      const off = (s - (a.strands - 1) / 2) * 4;
      const sh = h * (0.7 + ((s * 37) % 30) / 100); // je Halm etwas andere Höhe
      const pts = this.stalkPoints(
        { ...a, phase: a.phase + s * 0.6, seed: a.seed + s * 13 },
        sh,
        off,
      );
      g.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) g.lineTo(pts[i].x, pts[i].y);
      g.stroke({
        color: THEME.algae,
        width: a.width * (1 - s * 0.06),
        alpha: 0.4,
        cap: "round",
      });
    }
  }

  /** Federalge: Mittelrippe mit dicht stehenden, feinen Seitenfiedern. */
  private drawFeather(a: Algae, h: number) {
    const g = a.g;
    const pts = this.stalkPoints(a, h);
    // Mittelrippe.
    g.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) g.lineTo(pts[i].x, pts[i].y);
    g.stroke({ color: THEME.algae, width: a.width, alpha: 0.5, cap: "round" });
    // Feine Fiedern paarweise an jedem Segment.
    const grown = Math.floor((pts.length - 1) * a.growth);
    for (let i = 1; i <= grown; i++) {
      const base = pts[i];
      const len = (14 - i * 0.8) * a.growth;
      if (len <= 1) continue;
      const wob = Math.sin(this.time * 1.3 + a.seed + i * 0.5) * 2;
      const dy = -6;
      g.moveTo(base.x, base.y)
        .lineTo(base.x + len + wob, base.y + dy)
        .moveTo(base.x, base.y)
        .lineTo(base.x - len + wob, base.y + dy)
        .stroke({ color: THEME.algae, width: 1, alpha: 0.32, cap: "round" });
    }
  }

  private updateGrazers(dt: number) {
    for (let i = this.grazers.length - 1; i >= 0; i--) {
      const g = this.grazers[i];
      g.legPhase += dt * 8;

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

  private ensureFishes() {
    // Überwiegend Fische; Haie sehr selten (keine Schildkröten).
    const target = 6;
    while (this.fishes.length < target) {
      const sharkCount = this.fishes.filter((f) => f.kind === "shark").length;
      const kind: Fish["kind"] =
        sharkCount === 0 && Math.random() < 0.2 ? "shark" : "fish";
      this.fishes.push(this.makeFish(kind));
    }
  }

  private ensureJellies() {
    // Quallen sind häufiger als Fische.
    const target = Math.max(6, Math.floor(this.w / 260));
    while (this.jellies.length < target) this.jellies.push(this.makeJelly());
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
    this.godray.gain = 0.4 + Math.sin(this.time * 0.5) * 0.12;

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
      g.stroke({ color: PAL.white, width: 2, alpha: 0.05 });
    }

    // Blasen aufsteigen + wackeln.
    for (const b of this.bubbles) {
      b.g.y -= b.speed * dt;
      b.g.x += Math.sin(this.time * 1.5 + b.phase) * b.wobble * dt;
      if (b.g.y < -20) {
        b.g.y = this.h + 20;
        b.g.x = Math.random() * this.w;
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
      p.g.x += p.vx * dt;
      p.g.y += p.vy * dt;
      if (p.g.x < -2) p.g.x = this.w + 2;
      else if (p.g.x > this.w + 2) p.g.x = -2;
      if (p.g.y < -2) p.g.y = this.h + 2;
      else if (p.g.y > this.h + 2) p.g.y = -2;
    }

    // Algen wachsen unregelmäßig nach, bis zur individuellen Obergrenze.
    for (const a of this.algae) {
      a.growthPhase += dt;
      // Wachstumsrate schwankt (mal schneller, mal fast Stillstand).
      const rate = a.regrow * Math.max(0, 0.3 + Math.sin(a.growthPhase * 0.7) + 0.5);
      a.growth = Math.min(a.maxGrowth, a.growth + rate * dt);
      this.drawAlgae(a);
    }

    // Boden-Tiere: mehrere gleichzeitig; frisst eine Pflanze ganz auf und geht wieder.
    this.grazerCooldown -= dt;
    if (this.grazers.length < 3 && this.grazerCooldown <= 0) {
      const kind: Grazer["kind"] = Math.random() < 0.5 ? "crab" : "snail";
      this.grazers.push(this.makeGrazer(kind));
      this.grazerCooldown = 2 + Math.random() * 4;
    }
    this.updateGrazers(dt);

    // Fische schwimmen (mit seitlichem Wackeln) + blinzeln + jagen.
    for (const f of this.fishes) {
      // Fische & Haie schwimmen IMMER vorwärts (kein Wenden/Rückwärts). Beute
      // wird nur vertikal angesteuert — liegt sie hinter dem Tier, wird sie
      // eben verpasst.
      const prey = this.huntTarget(f);

      // Vortrieb pulsiert leicht, als würde mit dem Schwanz geschlagen.
      const surge = 0.7 + 0.3 * Math.abs(Math.sin(this.time * 8 + f.phase));
      f.c.x += f.dir * f.speed * surge * dt;

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
      j.x += j.driftX * dt + Math.sin(j.phase * 0.8) * 6 * dt;
      j.y += j.vy * dt;
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
