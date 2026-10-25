// 飞书渠道 provider：
//  - 扫码一键创建自建应用（accounts.feishu.cn device-code 流程，协议对齐 ZCode feishuAppRegistration.ts）
//  - bot 实例：官方 SDK WebSocket 长连接收消息（无需公网），REST API 发消息/回复
//  - 非单例：一个应用一个 bot，一 bot 绑一 agent（bots.json 可多条 feishu 条目）
import { createLoginSessionBase } from "./login-session.js";

const ACCOUNTS_BASE = "https://accounts.feishu.cn";
const REGISTRATION_PATH = "/oauth/v1/app/registration";
const OPEN_BASE = "https://open.feishu.cn";
const REQUEST_TIMEOUT_MS = 15_000;
const POLL_ERROR_BACKOFF_MS = 5_000;
// 兜底超时：正常情况下 onReady/onError 必有一个先触发（含 SDK 自动重试期间）。
const WS_READY_TIMEOUT_MS = 60_000;
const APP_ID_PATTERN = /^cli_[0-9a-zA-Z]+$/;

const sleep = (ms, signal) =>
  new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done);
  });

// SDK 为 CJS 发行，动态加载并做 interop 兜底；只在真正启动长连接时加载。
let larkModule = null;
async function loadSdk() {
  if (larkModule) return larkModule;
  const imported = await import("@larksuiteoapi/node-sdk");
  larkModule = imported.WSClient ? imported : imported.default;
  return larkModule;
}

// ---------- 扫码一键创建应用（device-code） ----------

async function postRegistration(body) {
  const response = await fetch(`${ACCOUNTS_BASE}${REGISTRATION_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`accounts.feishu.cn HTTP ${response.status}`);
  return response.json();
}

async function beginAppRegistration() {
  const init = await postRegistration({ action: "init" });
  if (!Array.isArray(init.supported_auth_methods) || !init.supported_auth_methods.includes("client_secret")) {
    throw new Error("当前飞书环境不支持一键创建应用（client_secret）");
  }
  const begin = await postRegistration({
    action: "begin",
    archetype: "PersonalAgent",
    auth_method: "client_secret",
    request_user_info: "open_id",
  });
  if (!begin.device_code || !begin.verification_uri_complete) {
    throw new Error("飞书未返回 device_code/二维码地址");
  }
  return {
    deviceCode: begin.device_code,
    qrUrl: begin.verification_uri_complete,
    intervalMs: Math.max(2, begin.interval ?? 5) * 1000,
    expiresAt: Date.now() + (begin.expire_in ?? 600) * 1000,
  };
}

async function pollAppRegistration(deviceCode) {
  const payload = await postRegistration({ action: "poll", device_code: deviceCode });
  if (payload.client_id && payload.client_secret) {
    return {
      status: "success",
      appId: payload.client_id,
      appSecret: payload.client_secret,
      appName:
        [payload.app_name, payload.client_name, payload.name]
          .filter((value) => typeof value === "string" && value.trim())
          .map((value) => value.trim())[0] ?? null,
    };
  }
  const error = payload.error ?? "";
  if (!error || error === "authorization_pending") return { status: "pending" };
  if (error === "slow_down") return { status: "pending", slow: true };
  if (error === "access_denied") return { status: "error", message: "用户在手机上拒绝了授权" };
  if (error === "expired_token") return { status: "expired" };
  return { status: "error", message: `${error}: ${payload.error_description ?? "unknown"}` };
}

// ---------- 开放平台 REST（tenant_access_token 鉴权） ----------

async function fetchTenantToken(appId, appSecret) {
  const response = await fetch(`${OPEN_BASE}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const payload = await response.json().catch(() => ({}));
  if (payload.code !== 0) {
    throw new Error(`获取 tenant_access_token 失败: ${payload.code} ${payload.msg ?? ""}`.trim());
  }
  return { token: payload.tenant_access_token, expiresAt: Date.now() + (payload.expire ?? 300) * 1000 };
}

async function apiCall(path, { method = "GET", body, token, query } = {}) {
  const url = new URL(`${OPEN_BASE}${path}`);
  if (query) for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  const response = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const payload = await response.json().catch(() => ({}));
  if (payload.code !== 0) {
    throw new Error(`飞书 ${path} 失败: ${payload.code} ${payload.msg ?? ""}`.trim());
  }
  return payload;
}

// ---------- 入站消息归一化 ----------

function normalizeInbound(data) {
  // SDK 不同版本可能把 event 字段摊平到顶层，与 ZCode 的处理一致做双位置读取。
  const event = data?.event && typeof data.event === "object" ? data.event : data ?? {};
  const message = event.message;
  const sender = event.sender;
  if (!message || typeof message !== "object" || !sender || typeof sender !== "object") return null;
  const messageId = typeof message.message_id === "string" ? message.message_id : "";
  const userId = sender.sender_id?.open_id ?? sender.open_id ?? "";
  if (!messageId || !userId) return null;
  let text = "";
  if (message.message_type === "text") {
    try {
      text = String(JSON.parse(message.content ?? "{}").text ?? "");
    } catch {
      text = "";
    }
  }
  // 群聊里 @机器人 的占位符清掉，避免干扰命令解析。
  text = text.replace(/@_user_\d+/g, "").trim();
  return {
    id: messageId,
    userId,
    chatId: message.chat_type === "group" && message.chat_id ? message.chat_id : null,
    displayName: null,
    text,
    hasAttachments: message.message_type !== "text",
    contextToken: messageId,
    receivedAt: Date.now(),
  };
}

export const feishuProvider = {
  id: "feishu",
  label: "飞书",
  capabilities: { typing: false },
  singleton: false,

  // 扫码一键创建自建应用：扫码确认后直接拿到 appId/appSecret。
  startLogin({ logger } = {}) {
    const session = createLoginSessionBase({ provider: "feishu" });

    const flow = (async () => {
      while (session.status !== "cancelled" && session.status !== "success") {
        let registration;
        try {
          registration = await beginAppRegistration();
        } catch (error) {
          session.status = "error";
          session.error = `获取二维码失败: ${error.message}`;
          session.endedAt = Date.now();
          session.notify();
          await sleep(POLL_ERROR_BACKOFF_MS);
          continue;
        }
        session.qrImage = registration.qrUrl;
        session.expiresAt = registration.expiresAt;
        session.qrPng = null;
        session.status = "pending";
        session.error = null;
        session.notify();
        logger?.info("feishu login: qr ready");

        const deadline = registration.expiresAt + 30_000;
        while (Date.now() < deadline && session.status !== "cancelled") {
          await sleep(registration.intervalMs);
          if (session.status === "cancelled") break;
          let result;
          try {
            result = await pollAppRegistration(registration.deviceCode);
          } catch (error) {
            logger?.warn(`feishu login: poll error: ${error.message}`);
            continue;
          }
          if (result.status === "pending") continue;
          if (result.status === "success") {
            session.credentials = { appId: result.appId, appSecret: result.appSecret, appName: result.appName };
            session.status = "success";
            session.endedAt = Date.now();
            session.notify();
            return session.credentials;
          }
          if (result.status === "expired") {
            logger?.info("feishu login: qr expired, refreshing");
            break;
          }
          session.status = "error";
          session.error = result.message ?? "绑定失败";
          session.endedAt = Date.now();
          session.notify();
          await sleep(POLL_ERROR_BACKOFF_MS);
          break;
        }
        if (session.status !== "cancelled" && session.status !== "success" && session.status !== "error") {
          session.status = "refreshing";
          session.notify();
        }
      }
      return null;
    })();

    session.result = flow;
    return session;
  },

  // 手动绑定（开放平台自建应用兜底）：验证 appId/appSecret 可换 token，顺带取应用名。
  async verifyCredentials({ appId, appSecret }) {
    if (!APP_ID_PATTERN.test(appId ?? "")) throw new Error("App ID 需以 cli_ 开头");
    if (typeof appSecret !== "string" || appSecret.length < 8) throw new Error("App Secret 不合法");
    const { token } = await fetchTenantToken(appId, appSecret);
    let appName = null;
    try {
      const info = await apiCall("/open-apis/bot/v3/info", { token });
      appName = info?.bot?.app_name ?? null;
    } catch {
      /* 应用名取不到不影响绑定 */
    }
    return { appId, appSecret, appName, botId: appId };
  },

  // ---------- bot 实例 ----------
  createBot({ entry, onMessage, onStatus, logger, signal }) {
    const { appId, appSecret, appName } = entry.credentials;
    let ws = null;
    let stopped = false;
    // token 缓存：过期前 60 秒刷新。
    let tokenCache = null;

    async function token() {
      if (tokenCache && tokenCache.expiresAt - Date.now() > 60_000) return tokenCache.token;
      tokenCache = await fetchTenantToken(appId, appSecret);
      return tokenCache.token;
    }

    async function sendText({ userId, text, contextToken }) {
      const bearer = await token();
      const content = JSON.stringify({ text });
      if (contextToken) {
        await apiCall(`/open-apis/im/v1/messages/${encodeURIComponent(contextToken)}/reply`, {
          method: "POST",
          token: bearer,
          body: { msg_type: "text", content },
        });
        return;
      }
      await apiCall("/open-apis/im/v1/messages", {
        method: "POST",
        token: bearer,
        query: { receive_id_type: "open_id" },
        body: { receive_id: userId, msg_type: "text", content },
      });
    }

    const bot = {
      id: entry.id,
      provider: "feishu",
      agent: entry.agent,
      label: appName ?? appId.slice(0, 14),
      selfUserId: appId,
      status: "stopped",
      lastError: null,
      connectedAt: null,

      setStatus(status, error = null) {
        bot.status = status;
        bot.lastError = error;
        onStatus(status, bot);
      },

      async start() {
        if (ws) return;
        bot.setStatus("connecting");
        try {
          const Lark = await loadSdk();
          if (stopped || signal?.aborted) return;
          const dispatcher = new Lark.EventDispatcher({}).register({
            "im.message.receive_v1": (data) => {
              const message = normalizeInbound(data);
              if (message) return onMessage(message);
            },
          });
          // SDK 1.76+ 原生提供就绪/错误/重连回调；start() 本身在握手完成前就会 resolve。
          let readySettled = false;
          let resolveReady = null;
          let rejectReady = null;
          const ready = new Promise((resolve, reject) => {
            resolveReady = resolve;
            rejectReady = reject;
          });
          const client = new Lark.WSClient({
            appId,
            appSecret,
            domain: Lark.Domain.Feishu,
            loggerLevel: Lark.LoggerLevel.warn,
            onReady: () => {
              bot.connectedAt = new Date().toISOString();
              bot.setStatus("connected");
              logger?.info(`feishu bot ${appId}: long connection established`);
              if (!readySettled) {
                readySettled = true;
                resolveReady();
              }
            },
            onError: (error) => {
              logger?.error(`feishu bot ${appId}: ${error.message}`);
              if (!readySettled) {
                readySettled = true;
                rejectReady(error);
                return;
              }
              // 首连成功后的终态失败（自动重连耗尽）。
              bot.setStatus("error", error.message);
            },
            onReconnecting: () => {
              if (bot.status !== "connecting") bot.setStatus("connecting", "连接中断，SDK 自动重连中");
            },
            onReconnected: () => {
              bot.connectedAt = new Date().toISOString();
              bot.setStatus("connected");
            },
          });
          ws = client;
          const onGlobalAbort = () => bot.stop();
          signal?.addEventListener("abort", onGlobalAbort, { once: true });
          try {
            // 注意：start 参数是 { eventDispatcher } 对象；传裸 dispatcher 会被静默忽略。
            await client.start({ eventDispatcher: dispatcher });
            const fallback = new Promise((_, reject) => {
              setTimeout(() => reject(new Error("飞书长连接建立超时（检查应用事件订阅是否为长连接模式）")), WS_READY_TIMEOUT_MS);
            });
            await Promise.race([ready, fallback]);
          } finally {
            signal?.removeEventListener("abort", onGlobalAbort);
          }
        } catch (error) {
          bot.setStatus("error", error.message);
          logger?.error(`feishu bot ${appId} failed to start: ${error.message}`);
          try {
            ws?.close();
          } catch {
            /* already closed */
          }
          ws = null;
        }
      },

      stop() {
        stopped = true;
        try {
          ws?.close();
        } catch {
          /* already closed */
        }
        ws = null;
        bot.setStatus("stopped");
      },

      async send(payload) {
        await sendText(payload);
      },
    };

    return bot;
  },
};
