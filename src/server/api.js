// REST API：面板所需的全部接口。安全约束（本机绑定/Origin/写操作自定义头）在 main.js 的中间件统一处理。
import { readFile } from "node:fs/promises";
import express from "express";
import { detectAgents, discoverAgents, getAdapter } from "../agents.js";
import { findCommand } from "../agent-discovery.js";
import { saveJson } from "../store.js";
import { snapshotLoginSession } from "../channels/login-session.js";

// 渠道目录：面板据此渲染卡片。singleton 渠道单 bot；非单例渠道可加多个 bot（一 bot 一 agent）。
const CHANNEL_CATALOG = [
  {
    id: "weixin",
    label: "微信",
    available: true,
    singleton: true,
    note: "个人微信扫码绑定，单 bot（平台限制）",
  },
  {
    id: "feishu",
    label: "飞书",
    available: true,
    singleton: false,
    note: "扫码一键创建自建应用 + WebSocket 长连接，无需公网；可添加多个 bot 各绑一个 agent",
  },
];

const CONFIG_BOUNDS = {
  agentTimeoutMs: [30_000, 86_400_000],
  replyChunkLength: [200, 8_000],
  webPort: [1024, 65_535],
};
const SANDBOX_MODES = ["read-only", "workspace-write", "full"];
const LOGIN_SESSION_TTL_MS = 10 * 60_000;

// ---------- API ----------

export function createApi(deps) {
  const { paths, config, state, saveState, router, hub, logger, events, providers, version } = deps;
  const api = express();
  // 登录会话表：loginId -> provider 登录会话（含轮询/自动换码），成功后由 hub 拉起 bot。
  const logins = new Map();

  const h = (handler) => (req, res) => {
    handler(req, res).catch((error) => {
      logger?.error(`api ${req.method} ${req.path}: ${error.message}`);
      res.status(500).json({ error: error.message });
    });
  };

  function loginSnapshot(session) {
    return snapshotLoginSession(session);
  }

  // 登录成功后组装 bots.json 条目：单例渠道 id 固定为渠道 id，飞书按 appId。
  function entryFromCredentials(channelId, credentials, agent) {
    const provider = providers[channelId];
    return {
      id: provider.singleton ? channelId : (credentials.appId ?? channelId),
      provider: channelId,
      agent,
      credentials,
    };
  }

  function pruneLogins() {
    const now = Date.now();
    for (const [id, session] of logins) {
      const terminal = session.status === "success" || session.status === "cancelled" || session.status === "error";
      if (terminal && now - (session.endedAt ?? 0) > LOGIN_SESSION_TTL_MS) logins.delete(id);
    }
  }

  api.get(
    "/overview",
    h(async (req, res) => {
      res.json({
        version,
        startedAt: deps.startedAt,
        owner: { userId: state.ownerUserId, displayName: state.ownerDisplayName },
        bots: hub.status(),
        channels: CHANNEL_CATALOG,
        agents: discoverAgents().filter((agent) => agent.installed),
      });
    }),
  );

  // ---------- bots ----------

  api.get(
    "/bots",
    h(async (req, res) => {
      res.json({ bots: hub.status() });
    }),
  );

  api.delete(
    "/bots/:id",
    h(async (req, res) => {
      await hub.removeBot(req.params.id);
      res.json({ ok: true });
    }),
  );

  // 给 bot 换绑 agent（路由即时生效，无需重启连接）。
  api.patch(
    "/bots/:id",
    h(async (req, res) => {
      const agent = req.body?.agent;
      if (!getAdapter(agent) || !findCommand(agent)) {
        res.status(400).json({ error: `agent 未安装或不支持: ${String(agent)}，请到 Agent 页面重新检测` });
        return;
      }
      await hub.patchBot(req.params.id, { agent });
      res.json({ ok: true });
    }),
  );

  // ---------- 扫码登录 ----------

  api.post(
    "/channels/:channelId/login",
    h(async (req, res) => {
      const channelId = req.params.channelId;
      const provider = providers[channelId];
      if (!provider?.startLogin) {
        res.status(404).json({ error: `channel not available: ${channelId}` });
        return;
      }
      // 非单例渠道允许在登录时指定该 bot 绑定的 agent。
      const agent = provider.singleton ? config.defaultAgent : (req.body?.agent ?? config.defaultAgent);
      if (!getAdapter(agent) || !findCommand(agent)) {
        res.status(400).json({ error: `agent 未安装或不支持: ${String(agent)}，请到 Agent 页面重新检测` });
        return;
      }
      pruneLogins();
      // 同渠道旧登录会话全部作废，避免两个二维码竞争同一个绑定位。
      for (const session of logins.values()) {
        if (session.provider === channelId) session.cancel();
      }
      const session = provider.startLogin({ logger });
      logins.set(session.id, session);
      const markEnded = () => (session.endedAt = Date.now());
      session.onChange(() => {
        if (["success", "cancelled", "error"].includes(session.status)) markEnded();
        events.emit("event", { type: "login", payload: loginSnapshot(session), at: new Date().toISOString() });
      });
      session.result
        .then(async (credentials) => {
          if (!credentials) return;
          await hub.upsertBot(entryFromCredentials(channelId, credentials, agent));
          logger?.info(`channel ${channelId}: bot bound via web (agent=${agent})`);
        })
        .catch((error) => logger?.error(`login flow failed: ${error.message}`));
      res.json({ loginId: session.id, ...loginSnapshot(session) });
    }),
  );

  // 手动绑定（飞书兜底：开放平台自建应用，粘贴 App ID/Secret；应用需开启机器人能力与长连接事件模式）。
  api.post(
    "/channels/:channelId/bind",
    h(async (req, res) => {
      const channelId = req.params.channelId;
      const provider = providers[channelId];
      if (!provider?.verifyCredentials) {
        res.status(404).json({ error: `channel 不支持手动绑定: ${channelId}` });
        return;
      }
      const agent = req.body?.agent ?? config.defaultAgent;
      if (!getAdapter(agent) || !findCommand(agent)) {
        res.status(400).json({ error: `agent 未安装或不支持: ${String(agent)}，请到 Agent 页面重新检测` });
        return;
      }
      const credentials = await provider.verifyCredentials({
        appId: String(req.body?.appId ?? ""),
        appSecret: String(req.body?.appSecret ?? ""),
      });
      const entry = await hub.upsertBot(entryFromCredentials(channelId, credentials, agent));
      res.json({ ok: true, bot: hub.status().find((bot) => bot.id === entry.id) });
    }),
  );

  api.get(
    "/login/:id",
    h(async (req, res) => {
      const session = logins.get(req.params.id);
      if (!session) {
        res.status(404).json({ error: "login session not found" });
        return;
      }
      res.json(loginSnapshot(session));
    }),
  );

  api.get(
    "/login/:id/qr.png",
    h(async (req, res) => {
      const session = logins.get(req.params.id);
      if (!session) {
        res.status(404).json({ error: "login session not found" });
        return;
      }
      const buffer = await session.qrBuffer();
      if (!buffer) {
        res.status(404).json({ error: "qr not ready yet" });
        return;
      }
      res.type("image/png").send(buffer);
    }),
  );

  api.delete(
    "/login/:id",
    h(async (req, res) => {
      const session = logins.get(req.params.id);
      session?.cancel();
      if (session) session.endedAt = Date.now();
      res.json({ ok: true });
    }),
  );

  // ---------- agents ----------

  api.get(
    "/agents",
    h(async (req, res) => {
      const agents = await detectAgents();
      res.json({ agents });
    }),
  );

  // ---------- config ----------

  api.get(
    "/config",
    h(async (req, res) => {
      res.json({ config });
    }),
  );

  api.put(
    "/config",
    h(async (req, res) => {
      const patch = req.body ?? {};
      const next = {};
      const problems = [];
      if ("defaultAgent" in patch) {
        if ((!getAdapter(patch.defaultAgent) || !findCommand(patch.defaultAgent)) && patch.defaultAgent !== config.defaultAgent) problems.push("defaultAgent 不可用");
        else next.defaultAgent = patch.defaultAgent;
      }
      if ("defaultCwd" in patch) {
        if (typeof patch.defaultCwd !== "string" || !patch.defaultCwd.startsWith("/")) problems.push("defaultCwd 须为绝对路径");
        else next.defaultCwd = patch.defaultCwd;
      }
      if ("codexSandbox" in patch) {
        if (!SANDBOX_MODES.includes(patch.codexSandbox)) problems.push(`codexSandbox 须为 ${SANDBOX_MODES.join("/")}`);
        else next.codexSandbox = patch.codexSandbox;
      }
      if ("allowedUsers" in patch) {
        if (!Array.isArray(patch.allowedUsers) || patch.allowedUsers.some((v) => typeof v !== "string")) {
          problems.push("allowedUsers 须为字符串数组");
        } else {
          next.allowedUsers = patch.allowedUsers.map((v) => v.trim()).filter(Boolean);
        }
      }
      for (const key of Object.keys(CONFIG_BOUNDS)) {
        if (!(key in patch)) continue;
        const [min, max] = CONFIG_BOUNDS[key];
        const value = Number(patch[key]);
        if (!Number.isInteger(value) || value < min || value > max) problems.push(`${key} 须为 ${min}-${max} 的整数`);
        else next[key] = value;
      }
      if (problems.length) {
        res.status(400).json({ error: problems.join("; ") });
        return;
      }
      Object.assign(config, next);
      await saveJson(paths.configFile, config);
      res.json({ config, restartNeeded: "webPort" in next });
    }),
  );

  // ---------- sessions ----------

  api.get(
    "/sessions",
    h(async (req, res) => {
      res.json({ sessions: router.sessionsSnapshot(), owner: { userId: state.ownerUserId, displayName: state.ownerDisplayName } });
    }),
  );

  api.post(
    "/sessions/:key/stop",
    h(async (req, res) => {
      const key = decodeURIComponent(req.params.key);
      res.json({ stopped: router.stopTask(key) });
    }),
  );

  // ---------- logs ----------

  api.get(
    "/logs",
    h(async (req, res) => {
      const tail = Math.min(Number(req.query.tail) || 300, 2_000);
      let text = "";
      try {
        text = await readFile(paths.logFile, "utf8");
      } catch {
        /* 尚无日志 */
      }
      const lines = text.split("\n").filter(Boolean);
      res.json({ lines: lines.slice(-tail) });
    }),
  );

  return api;
}
