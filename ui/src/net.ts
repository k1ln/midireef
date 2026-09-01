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
  /** Build-Kennung des Servers beim ersten Verbinden — siehe `checkBuild`. */
  private buildId?: string;

  constructor(url?: string) {
    // Server läuft standardmäßig auf Port 8787 desselben Hosts.
    const host = location.hostname || "localhost";
    this.url = url ?? Net.urlFromLocation() ?? `ws://${host}:8787/ws`;
  }

  /** Override der Server-Adresse per `?ws=…` in der URL.
   *
   *  Für den HMR-Dev-Modus: der Kiosk-Browser auf dem Pi lädt die UI vom
   *  Vite-Dev-Server des Macs (Änderungen erscheinen sofort, ohne Build und
   *  ohne Deploy), soll den WebSocket aber weiter zum Pi sprechen — dort
   *  hängt die MIDI-Hardware. Ohne Override würde `location.hostname` auf
   *  den Mac zeigen und der Pi-Server nie erreicht.
   *
   *  Der Wert wird in `sessionStorage` gemerkt, damit ein Reload (etwa durch
   *  `checkBuild`) den Parameter nicht verliert. */
  private static urlFromLocation(): string | undefined {
    let ws: string | null = null;
    try {
      ws = new URLSearchParams(location.search).get("ws");
      if (ws) sessionStorage.setItem("midireef.ws", ws);
      else ws = sessionStorage.getItem("midireef.ws");
    } catch {
      /* sessionStorage kann blockiert sein — dann eben ohne Merken. */
    }
    return ws ?? undefined;
  }

  connect() {
    this.ws = new WebSocket(this.url);
    this.ws.onmessage = (e) => {
      try {
        const evt = JSON.parse(e.data);
        if (evt.t === "server.hello") {
          this.checkBuild(evt.uiBuild);
          return;
        }
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

  /** Lädt die Seite neu, wenn der Server seit dem Laden dieser Seite ein
   *  anderes UI-Build ausliefert. Auf dem Pi läuft der Browser im Kiosk-Modus
   *  ohne Tastatur — nach einem Deploy gäbe es sonst keine Möglichkeit, die
   *  neue UI zu bekommen. Der Reconnect nach dem Dienst-Neustart ist der
   *  Auslöser: der Server meldet dabei seine neue Build-Kennung.
   *
   *  Im Vite-Dev-Betrieb liefert der Server konstant „dev“ — dort macht HMR
   *  das Nachladen, ohne die Seite zu verwerfen. */
  private checkBuild(id: unknown) {
    if (typeof id !== "string") return;
    if (this.buildId === undefined) {
      this.buildId = id;
    } else if (this.buildId !== id) {
      location.reload();
    }
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
