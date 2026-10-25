// 后端 API 封装。同源访问（dev 由 Vite 代理），写操作带本地客户端自定义头（服务端安全中间件要求）。
const WRITE_HEADER = { "X-Requested-With": "wx-agent-gateway" };

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = init.method ?? "GET";
  const response = await fetch(path, {
    ...init,
    headers: {
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(method !== "GET" && method !== "HEAD" ? WRITE_HEADER : {}),
      ...init.headers,
    },
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(data.error ?? `${method} ${path} → HTTP ${response.status}`);
  return data as T;
}

// ---------- 类型（与 src/server/api.js 的响应对应） ----------

export interface BotStatus {
  id: string;
  provider: string;
  agent: string;
  label: string | null;
  credentials: { botId: string | null };
  status: "connecting" | "connected" | "error" | "stopped";
  lastError: string | null;
  connectedAt: string | null;
}

export interface ChannelInfo {
  id: string;
  label: string;
  available: boolean;
  singleton: boolean;
  note: string;
}

export interface Overview {
  version: string;
  startedAt: string;
  owner: { userId: string | null; displayName: string | null };
  bots: BotStatus[];
  channels: ChannelInfo[];
  agents: { name: string; label: string }[];
}

export interface LoginStatus {
  loginId: string;
  provider: string;
  status: "pending" | "scanned" | "refreshing" | "success" | "cancelled" | "error";
  expiresAt: number | null;
  hasQr: boolean;
  error: string | null;
  credentials: { botId: string | null } | null;
}

export interface AgentInfo {
  name: string;
  label: string;
  installed: boolean;
  path: string | null;
  version: string | null;
  probeError: string | null;
}

export interface GatewayConfig {
  defaultAgent: string;
  defaultCwd: string;
  agentTimeoutMs: number;
  codexSandbox: "read-only" | "workspace-write" | "full";
  allowedUsers: string[];
  replyChunkLength: number;
  webPort: number;
}

export interface SessionInfo {
  key: string;
  botId: string;
  kind: string;
  userId: string;
  agent: string | null;
  cwd: string | null;
  sessions: Record<string, string>;
  busy: boolean;
  queued: number;
  currentText: string | null;
  startedAt: number | null;
}

// ---------- 接口 ----------

export const api = {
  overview: () => request<Overview>("/api/overview"),
  bots: () => request<{ bots: BotStatus[] }>("/api/bots"),
  unbindBot: (id: string) => request<{ ok: boolean }>(`/api/bots/${id}`, { method: "DELETE" }),
  patchBot: (id: string, agent: string) =>
    request<{ ok: boolean }>(`/api/bots/${id}`, { method: "PATCH", body: JSON.stringify({ agent }) }),
  startLogin: (channelId: string, agent?: string) =>
    request<LoginStatus>(`/api/channels/${channelId}/login`, {
      method: "POST",
      body: JSON.stringify(agent ? { agent } : {}),
    }),
  bindManual: (channelId: string, appId: string, appSecret: string, agent?: string) =>
    request<{ ok: boolean; bot: BotStatus }>(`/api/channels/${channelId}/bind`, {
      method: "POST",
      body: JSON.stringify({ appId, appSecret, ...(agent ? { agent } : {}) }),
    }),
  loginStatus: (loginId: string) => request<LoginStatus>(`/api/login/${loginId}`),
  cancelLogin: (loginId: string) => request<{ ok: boolean }>(`/api/login/${loginId}`, { method: "DELETE" }),
  qrUrl: (loginId: string, version: number | string) => `/api/login/${loginId}/qr.png?v=${version}`,
  agents: () => request<{ agents: AgentInfo[] }>("/api/agents"),
  getConfig: () => request<{ config: GatewayConfig }>("/api/config"),
  putConfig: (patch: Partial<GatewayConfig>) =>
    request<{ config: GatewayConfig; restartNeeded: boolean }>("/api/config", {
      method: "PUT",
      body: JSON.stringify(patch),
    }),
  sessions: () =>
    request<{ sessions: SessionInfo[]; owner: { userId: string | null; displayName: string | null } }>(
      "/api/sessions",
    ),
  stopSession: (key: string) =>
    request<{ stopped: boolean }>(`/api/sessions/${encodeURIComponent(key)}/stop`, { method: "POST" }),
  logs: (tail = 300) => request<{ lines: string[] }>(`/api/logs?tail=${tail}`),
};
