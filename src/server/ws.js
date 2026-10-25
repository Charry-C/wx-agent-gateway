// WS 推送：内核事件（日志/bot 状态/登录进度/消息收发/会话变化）广播给面板。
// 升级握手校验 Origin 仅允许本机来源，与 HTTP 中间件同一策略。
import { WebSocketServer } from "ws";

const LOCAL_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]"]);

export function isLocalOrigin(origin) {
  if (!origin) return true; // 非浏览器客户端（curl 等）无 Origin
  try {
    return LOCAL_HOSTNAMES.has(new URL(origin).hostname);
  } catch {
    return false;
  }
}

export function attachWebsocket(server, events) {
  const wss = new WebSocketServer({ noServer: true });
  const clients = new Set();

  server.on("upgrade", (request, socket, head) => {
    let pathname = "";
    try {
      pathname = new URL(request.url, "http://localhost").pathname;
    } catch {
      socket.destroy();
      return;
    }
    if (pathname !== "/ws" || !isLocalOrigin(request.headers.origin)) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      clients.add(ws);
      ws.on("close", () => clients.delete(ws));
      ws.on("error", () => clients.delete(ws));
      ws.send(JSON.stringify({ type: "hello", payload: { clients: clients.size }, at: new Date().toISOString() }));
    });
  });

  function broadcast(event) {
    if (clients.size === 0) return;
    const data = JSON.stringify(event);
    for (const ws of clients) {
      if (ws.readyState === ws.OPEN) ws.send(data);
    }
  }

  events.on("event", broadcast);

  return {
    broadcast,
    close() {
      for (const ws of clients) ws.terminate();
      clients.clear();
      wss.close();
    },
  };
}
