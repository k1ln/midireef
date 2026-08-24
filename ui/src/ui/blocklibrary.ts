//! Block Library: the 9×9 grid per block type (architecture doc §4, "the
//! floating table"). One tab per type; tapping an empty cell creates a block
//! AT THAT EXACT slot (unlike the lane "+" button, which takes the next free
//! cell); tapping a filled cell opens the existing block detail editor.

import { Container, Graphics } from "pixi.js";
import type { Store, Device, Block, BlockType } from "../state";
import { button, label } from "./widgets";
import { PAL } from "../theme";

type Send = (cmd: object) => void;

const TOP = 100;
const TYPES: { type: BlockType; label: string }[] = [
  { type: "melody", label: "Melody" },
  { type: "beat", label: "Beat" },
  { type: "cc", label: "CC" },
  { type: "programChange", label: "Prog" },
  { type: "patternShift", label: "Pattern" },
  { type: "chord", label: "Chord" },
  { type: "arp", label: "Arp" },
];

export class BlockLibraryScreen {
  readonly container = new Container();
  private bg = new Graphics();
  private body = new Container();
  private store: Store;
  private send: Send;
  private onOpenBlock: (blockId: string) => void;
  private w = 0;
  private h = 0;
  private deviceId?: string;
  private activeType: BlockType = "melody";

  constructor(store: Store, send: Send, onOpenBlock: (blockId: string) => void) {
    this.store = store;
    this.send = send;
    this.onOpenBlock = onOpenBlock;
    this.container.visible = false;
    this.container.addChild(this.bg);
    this.container.addChild(this.body);
    store.subscribe(() => {
      if (this.container.visible) this.rebuild();
    });
  }

  resize(w: number, h: number) {
    this.w = w;
    this.h = h;
    if (this.container.visible) this.rebuild();
  }

  open(deviceId: string) {
    this.deviceId = deviceId;
    this.container.visible = true;
    this.rebuild();
  }

  close() {
    this.container.visible = false;
    this.deviceId = undefined;
  }

  private findDevice(): Device | undefined {
    return this.store.project?.devices.find((d) => d.id === this.deviceId);
  }

  private rebuild() {
    this.body.removeChildren();
    this.bg.clear();
    this.bg.rect(0, TOP, this.w, this.h - TOP).fill({ color: PAL.waterDeep, alpha: 0.98 });

    const back = button("← Back", { w: 130, h: 40, color: PAL.btnAlt, fontSize: 17 }, () => this.close());
    back.x = 16;
    back.y = TOP + 12;
    this.body.addChild(back);

    const device = this.findDevice();
    if (!device) {
      const gone = label("Device no longer exists.", 18, PAL.textDim, "400");
      gone.x = 16;
      gone.y = TOP + 70;
      this.body.addChild(gone);
      return;
    }

    const title = label(`${device.name} — Block Library`, 22, PAL.text, "700");
    title.x = 160;
    title.y = TOP + 16;
    this.body.addChild(title);

    let tx = 160;
    const tabY = TOP + 52;
    for (const t of TYPES) {
      const active = t.type === this.activeType;
      const tab = button(
        t.label,
        { w: 88, h: 34, color: active ? PAL.btnActive : PAL.btn, fontSize: 14, textColor: active ? PAL.ink : PAL.text },
        () => {
          this.activeType = t.type;
          this.rebuild();
        },
      );
      tab.x = tx;
      tab.y = tabY;
      this.body.addChild(tab);
      tx += 94;
    }

    const blocks = (device.blocks ?? []).filter((b) => b.type === this.activeType);
    const cell = 74;
    const gap = 6;
    const gridW = 9 * cell + 8 * gap;
    const gridX = Math.max(16, (this.w - gridW) / 2);
    const gridY = TOP + 100;

    for (let row = 1; row <= 9; row++) {
      for (let col = 1; col <= 9; col++) {
        const blk = blocks.find((b) => b.slot && b.slot.row === row && b.slot.col === col);
        const x = gridX + (col - 1) * (cell + gap);
        const y = gridY + (row - 1) * (cell + gap);
        this.body.addChild(this.slotCell(device, row, col, blk, x, y, cell));
      }
    }
  }

  private slotCell(
    device: Device,
    row: number,
    col: number,
    blk: Block | undefined,
    x: number,
    y: number,
    size: number,
  ): Container {
    const c = new Container();
    c.x = x;
    c.y = y;
    const g = new Graphics();
    g.roundRect(0, 0, size, size, 8).fill({ color: blk ? PAL.btn : PAL.panelDeep, alpha: blk ? 0.95 : 0.5 });
    g.roundRect(0, 0, size, size, 8).stroke({ color: PAL.line, width: 1, alpha: blk ? 0.3 : 0.15 });
    c.addChild(g);

    const idTxt = label(`${row}-${col}`, 9, PAL.textDim, "400");
    idTxt.x = 4;
    idTxt.y = 3;
    c.addChild(idTxt);

    const center = label(blk ? blk.name || "?" : "+", blk ? 13 : 20, blk ? PAL.text : PAL.textDim, blk ? "700" : "400");
    center.anchor.set(0.5);
    center.x = size / 2;
    center.y = size / 2 + 4;
    c.addChild(center);

    c.eventMode = "static";
    c.cursor = "pointer";
    c.on("pointertap", () => {
      if (blk) {
        this.onOpenBlock(blk.id);
      } else {
        this.send({ t: "block.createAt", deviceId: device.id, blockType: this.activeType, row, col });
      }
    });

    if (blk) {
      // Delete — own hit target (mirrors lanecontrols.ts's tile pattern),
      // so it doesn't also trigger the cell's own open-editor tap.
      const del = new Graphics();
      del.circle(size - 10, 10, 9).fill({ color: PAL.danger, alpha: 0.85 });
      del.eventMode = "static";
      del.cursor = "pointer";
      const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();
      del.on("pointerdown", stop);
      del.on("pointertap", (e) => {
        e.stopPropagation();
        this.send({ t: "block.delete", blockId: blk.id });
      });
      c.addChild(del);
      const delX = label("✕", 10, PAL.white, "700");
      delX.anchor.set(0.5);
      delX.x = size - 10;
      delX.y = 10;
      c.addChild(delX);
    }

    return c;
  }
}
