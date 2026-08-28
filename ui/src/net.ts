//! WebSocket-Client zum MidiReef-Server. Sendet Commands, empfängt Events.

export interface TransportState {
  playing: boolean;
  recording: boolean;
  bpm: number;
  clockSource: "internal" | "externalMidi" | "link";
  bar: number;
  beat: number;
  tick: number;
  ppqn: number;
  fillActive: boolean;
  songMode: boolean;
}

export interface MidiPorts {
  outputs: string[];
  inputs: string[];
}

type EventHandler = (evt: any) => void;

export class Net {
  private ws?: WebSocket;
  private url: string;
  private handlers: EventHandler[] = [];
  private reconnectTimer?: number;

  constructor(url?: string) {
    // Server läuft standardmäßig auf Port 8787 desselben Hosts.
    const host = location.hostname || "localhost";
    this.url = url ?? `ws://${host}:8787/ws`;
  }

  connect() {
    this.ws = new WebSocket(this.url);
    this.ws.onmessage = (e) => {
      try {
        const evt = JSON.parse(e.data);
        for (const h of this.handlers) h(evt);
      } catch {
        /* ignorieren */
      }
    };
    this.ws.onclose = () => this.scheduleReconnect();
    this.ws.onerror = () => this.ws?.close();
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, 1000);
  }

  /** Returns an unsubscribe function — React components mount/unmount, so
   *  callers must clean up (mirrors Store.subscribe in state.ts). */
  onEvent(h: EventHandler): () => void {
    this.handlers.push(h);
    return () => {
      const i = this.handlers.indexOf(h);
      if (i !== -1) this.handlers.splice(i, 1);
    };
  }

  send(cmd: object) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(cmd));
    }
  }
}
