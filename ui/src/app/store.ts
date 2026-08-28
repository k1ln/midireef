//! React-Anbindung an den bestehenden Store/Net (state.ts/net.ts bleiben
//! unverändert — sie sind bereits framework-agnostisch). Ein Context statt
//! Props-Drilling durch jede Komponente, wie main.ts es bisher für jede
//! Pixi-Screen-Klasse als Konstruktor-Argument gemacht hat.

import { createContext, useCallback, useContext, useSyncExternalStore } from "react";
import type { Store } from "../state";
import type { Net } from "../net";
import type { RuntimeFeed } from "./runtime";

type Send = (cmd: object) => void;

interface AppCtx {
  store: Store;
  send: Send;
  /** Raw event access (e.g. Transport's own `transport.tick` fast lane —
   *  see Transport.tsx — which deliberately bypasses the Store so a tick
   *  30-60x/sec doesn't re-render the whole app, only the transport bar). */
  net: Net;
  /** Playback feedback (which block is running, how far) — writes straight
   *  into the DOM instead of the Store, see runtime.ts. */
  runtime: RuntimeFeed;
}

const Ctx = createContext<AppCtx | null>(null);

export const AppProvider = Ctx.Provider;

function useAppCtx(): AppCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useSend()/useStoreValue()/useNet() used outside <AppProvider>");
  return ctx;
}

export function useSend(): Send {
  return useAppCtx().send;
}

/** ref-Callback for a slot tile — hands its DOM node to the RuntimeFeed so the
 *  playhead/glow can be driven per frame without re-rendering (see runtime.ts). */
export function useRuntimeTile(laneId: string, slotId: string) {
  const { runtime } = useAppCtx();
  return useCallback(
    (el: HTMLElement | null) => runtime.setTile(laneId, slotId, el),
    [runtime, laneId, slotId],
  );
}

/** ref-Callback for a lane row — drives the note-activity pulse. */
export function useRuntimeLane(laneId: string) {
  const { runtime } = useAppCtx();
  return useCallback((el: HTMLElement | null) => runtime.setLane(laneId, el), [runtime, laneId]);
}

/** ref-Callbacks for the open Block Detail editor — the root carries the
 *  playhead variables, the status chip carries the "what is going out right
 *  now" text. Addressed by BLOCK id: the same block can run in several lanes,
 *  and the editor doesn't know which one is playing it (see runtime.ts). */
export function useRuntimeBlock(blockId: string) {
  const { runtime } = useAppCtx();
  return useCallback((el: HTMLElement | null) => runtime.setBlock(blockId, el), [runtime, blockId]);
}

export function useRuntimeBlockStatus(blockId: string, idleText: string) {
  const { runtime } = useAppCtx();
  return useCallback(
    (el: HTMLElement | null) => runtime.setBlockStatus(blockId, el, idleText),
    [runtime, blockId, idleText],
  );
}

export function useNet(): Net {
  return useAppCtx().net;
}

/** Raw Store instance, for imperative calls (e.g. patching a single field
 *  from a WS event handler) outside of render — use useStoreValue() instead
 *  when you just need to read+subscribe to a value. */
export function useStore(): Store {
  return useAppCtx().store;
}

/** Subscribes to the Store and re-renders on change, à la useSyncExternalStore. */
export function useStoreValue<T>(selector: (s: Store) => T): T {
  const { store } = useAppCtx();
  return useSyncExternalStore(
    (onChange) => store.subscribe(onChange),
    () => selector(store),
  );
}
