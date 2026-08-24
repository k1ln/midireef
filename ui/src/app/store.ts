//! React-Anbindung an den bestehenden Store/Net (state.ts/net.ts bleiben
//! unverändert — sie sind bereits framework-agnostisch). Ein Context statt
//! Props-Drilling durch jede Komponente, wie main.ts es bisher für jede
//! Pixi-Screen-Klasse als Konstruktor-Argument gemacht hat.

import { createContext, useContext, useSyncExternalStore } from "react";
import type { Store } from "../state";
import type { Net } from "../net";

type Send = (cmd: object) => void;

interface AppCtx {
  store: Store;
  send: Send;
  /** Raw event access (e.g. Transport's own `transport.tick` fast lane —
   *  see Transport.tsx — which deliberately bypasses the Store so a tick
   *  30-60x/sec doesn't re-render the whole app, only the transport bar). */
  net: Net;
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

export function useNet(): Net {
  return useAppCtx().net;
}

/** Subscribes to the Store and re-renders on change, à la useSyncExternalStore. */
export function useStoreValue<T>(selector: (s: Store) => T): T {
  const { store } = useAppCtx();
  return useSyncExternalStore(
    (onChange) => store.subscribe(onChange),
    () => selector(store),
  );
}
