// WS 事件订阅：内核事件（日志/bot 状态/登录进度/消息/会话变化）实时推到面板。
// 模块级单例连接 + 自动重连；组件用 useServerEvent / useWsConnected。
import { useEffect, useState } from "react";

export interface ServerEvent {
  type: "hello" | "log" | "bot_status" | "login" | "message" | "session_update" | (string & {});
  payload: unknown;
  at: string;
}

type Listener = (event: ServerEvent) => void;

class EventHub {
  private ws: WebSocket | null = null;
  private listeners = new Set<Listener>();
  private statusListeners = new Set<(connected: boolean) => void>();
  connected = false;

  connect() {
    if (typeof window === "undefined" || this.ws) return;
    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${protocol}://${window.location.host}/ws`);
    this.ws = ws;
    ws.onopen = () => this.setStatus(true);
    ws.onclose = () => {
      this.setStatus(false);
      this.ws = null;
      setTimeout(() => this.connect(), 2_000);
    };
    ws.onerror = () => ws.close();
    ws.onmessage = (message) => {
      try {
        const event = JSON.parse(String(message.data)) as ServerEvent;
        for (const listener of this.listeners) listener(event);
      } catch {
        /* 忽略无法解析的帧 */
      }
    };
  }

  private setStatus(connected: boolean) {
    if (this.connected === connected) return;
    this.connected = connected;
    for (const listener of this.statusListeners) listener(connected);
  }

  subscribe(listener: Listener) {
    this.listeners.add(listener);
    this.connect();
    return () => {
      this.listeners.delete(listener);
    };
  }

  watchStatus(listener: (connected: boolean) => void) {
    this.statusListeners.add(listener);
    listener(this.connected);
    return () => {
      this.statusListeners.delete(listener);
    };
  }
}

export const eventHub = new EventHub();

export function useServerEvent(handler: Listener) {
  useEffect(() => eventHub.subscribe(handler), [handler]);
}

export function useWsConnected() {
  const [connected, setConnected] = useState(eventHub.connected);
  useEffect(() => eventHub.watchStatus(setConnected), []);
  return connected;
}
