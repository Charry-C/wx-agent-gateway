// data/ 目录下的 JSON 状态存储：token、配置、会话状态。
// 全部原子写（tmp + rename），掉电不腐蚀。
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { discoverAgents } from "./agents.js";

export function createPaths(root) {
  const dataDir = join(root, "data");
  return {
    dataDir,
    tokenFile: join(dataDir, "token.json"),
    botsFile: join(dataDir, "bots.json"),
    configFile: join(dataDir, "config.json"),
    stateFile: join(dataDir, "state.json"),
    logFile: join(dataDir, "gateway.log"),
  };
}

export async function loadJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return structuredClone(fallback);
  }
}

// 按 file 串行化保存：网关里存在多处并发 saveState（所有者绑定、游标、会话），
// 共用同一 tmp 路径会互相 rename 丢失文件（ENOENT），排队后按调用顺序落盘。
const saveChains = new Map();

export function saveJson(file, value) {
  const previous = saveChains.get(file) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(async () => {
    await mkdir(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
    await writeFile(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
    await rename(tmp, file);
  });
  saveChains.set(file, next);
  return next;
}

const DEFAULT_CONFIG = {
  defaultAgent: "grok",
  defaultCwd: process.cwd(),
  agentTimeoutMs: 15 * 60_000,
  codexSandbox: "workspace-write",
  // 微信发送者白名单（wxid/from_user_id）。留空时：第一个发消息的人自动绑定为所有者。
  allowedUsers: [],
  replyChunkLength: 2000,
  // web 控制台端口（只监听 127.0.0.1）。
  webPort: 4619,
};

export async function loadConfig(configFile) {
  const stored = await loadJson(configFile, {});
  const defaultAgent = typeof stored.defaultAgent === "string"
    ? stored.defaultAgent
    : (discoverAgents().find((agent) => agent.installed)?.name ?? DEFAULT_CONFIG.defaultAgent);
  const merged = { ...DEFAULT_CONFIG, ...stored, defaultAgent };
  if (!existsSync(configFile)) await saveJson(configFile, merged);
  return merged;
}

// ---------- bots.json（多 bot 实例注册表） ----------
// 每个条目：{ id, provider, agent, credentials }。微信为单例（id 固定 weixin），
// 飞书将来可多条（一 bot 绑一 agent）。旧版只有 data/token.json 单凭据，读时自动迁移。

export async function loadBots(botsFile, tokenFile, { defaultAgent = "grok" } = {}) {
  const stored = await loadJson(botsFile, null);
  if (Array.isArray(stored)) return stored.filter((bot) => bot && typeof bot.id === "string");
  const token = await loadJson(tokenFile, {});
  if (token.botToken) {
    const bots = [
      {
        id: "weixin",
        provider: "weixin",
        agent: defaultAgent,
        credentials: { botToken: token.botToken, botId: token.botId ?? null },
      },
    ];
    await saveJson(botsFile, bots);
    return bots;
  }
  return [];
}

export async function saveBots(botsFile, bots) {
  await saveJson(botsFile, bots);
}

// 旧版 state：conversations key 无 bot 前缀（dm:xxx），微信游标 buf/bufInitialized 平铺在顶层。
// 读时原地迁移到新布局：key 加 bot 前缀、游标收进 cursors.weixin。

export function migrateState(state, { weixinBotId = "weixin" } = {}) {
  if (state.conversations) {
    for (const key of Object.keys(state.conversations)) {
      if (key.startsWith("dm:") || key.startsWith("group:")) {
        state.conversations[`${weixinBotId}:${key}`] = state.conversations[key];
        delete state.conversations[key];
      }
    }
  }
  if (state.buf !== undefined || state.bufInitialized !== undefined) {
    state.cursors ??= {};
    state.cursors.weixin ??= {};
    state.cursors.weixin.buf = state.buf ?? state.cursors.weixin.buf ?? null;
    state.cursors.weixin.initialized = state.bufInitialized ?? state.cursors.weixin.initialized ?? false;
    delete state.buf;
    delete state.bufInitialized;
  }
  // botId 属于 bots.json 的 weixin credentials，不再留在全局 state。
  delete state.botToken;
  delete state.botId;
  return state;
}

const DEFAULT_STATE = {
  botToken: null,
  botId: null,
  buf: null,
  bufInitialized: false,
  ownerUserId: null,
  ownerDisplayName: null,
  conversations: {},
};

export async function loadState(stateFile) {
  return { ...structuredClone(DEFAULT_STATE), ...(await loadJson(stateFile, {})) };
}

export function createLogger(logFile, { onLine } = {}) {
  const queue = [];
  let writing = false;
  async function drain() {
    if (writing) return;
    writing = true;
    try {
      while (queue.length) {
        const line = queue.shift();
        await mkdir(dirname(logFile), { recursive: true });
        await writeFile(logFile, line + "\n", { flag: "a" });
      }
    } catch {
      /* logging must never break the gateway */
    } finally {
      writing = false;
    }
  }
  return {
    log(level, message) {
      const line = `${new Date().toISOString()} [${level}] ${String(message).replace(/\n/g, "\\n")}`;
      console.log(line);
      queue.push(line);
      void drain();
      onLine?.({ at: new Date().toISOString(), level, message: String(message) });
    },
    info(message) {
      this.log("INFO", message);
    },
    warn(message) {
      this.log("WARN", message);
    },
    error(message) {
      this.log("ERROR", message);
    },
  };
}
