#!/usr/bin/env node
// Web 控制台入口：网关内核 + HTTP/WS API + 静态前端（web/dist）。
// 只监听 127.0.0.1；写操作要求 X-Requested-With 自定义头（跨站简单请求无法伪造），防其他网页打本地接口。
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";
import http from "node:http";
import express from "express";
import {
  createPaths,
  loadConfig,
  loadState,
  saveJson,
  migrateState,
  createLogger,
} from "../store.js";
import { Router } from "../core/router.js";
import { Hub } from "../core/hub.js";
import { weixinProvider } from "../channels/weixin.js";
import { feishuProvider } from "../channels/feishu.js";
import { createApi } from "./api.js";
import { attachWebsocket, isLocalOrigin } from "./ws.js";

const providers = { weixin: weixinProvider, feishu: feishuProvider };

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const paths = createPaths(root);
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;

const config = await loadConfig(paths.configFile);
const state = migrateState(await loadState(paths.stateFile));
const saveState = (value) => saveJson(paths.stateFile, value);

const events = new EventEmitter();
const logger = createLogger(paths.logFile, {
  onLine: (line) => events.emit("event", { type: "log", payload: line, at: line.at }),
});
const router = new Router({
  config,
  state,
  saveState,
  logger,
  events,
  mediaDir: join(paths.dataDir, "media"),
});
await mkdir(join(paths.dataDir, "media"), { recursive: true }).catch(() => undefined);
const controller = new AbortController();
const hub = new Hub({
  providers,
  paths,
  config,
  state,
  saveState,
  router,
  logger,
  events,
  signal: controller.signal,
});

try {
  await hub.init();
} catch (error) {
  logger.error(`hub init failed (panel still available): ${error.message}`);
}

// ---------- HTTP ----------

const app = express();
app.disable("x-powered-by");

const LOCAL_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/;
app.use((req, res, next) => {
  if (!LOCAL_HOST.test(String(req.headers.host ?? ""))) {
    res.status(403).json({ error: "仅允许本机访问" });
    return;
  }
  if (!isLocalOrigin(req.headers.origin)) {
    res.status(403).json({ error: "Origin 不被允许" });
    return;
  }
  // 读接口放行（含 <img> 拉二维码）；写接口必须带本面板自定义头。
  if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && req.headers["x-requested-with"] !== "wx-agent-gateway") {
    res.status(403).json({ error: "写操作缺少本地客户端头" });
    return;
  }
  next();
});
app.use(express.json({ limit: "1mb" }));

app.use(
  "/api",
  createApi({
    paths,
    config,
    state,
    saveState,
    router,
    hub,
    logger,
    events,
    providers,
    version,
    startedAt: new Date().toISOString(),
  }),
);

const distDir = join(root, "web", "dist");
if (existsSync(distDir)) {
  app.use(express.static(distDir));
  // SPA：非 /api 的 GET 一律回 index.html，交给前端路由。
  app.use((req, res, next) => {
    if (req.method !== "GET" || req.path.startsWith("/api/")) {
      next();
      return;
    }
    res.sendFile(join(distDir, "index.html"));
  });
} else {
  app.get("/", (req, res) => {
    res.type("html").send(
      `<!doctype html><meta charset="utf-8"><title>wx-agent-gateway</title>` +
        `<body style="font-family:system-ui;padding:48px;line-height:1.8">` +
        `<h2>wx-agent-gateway API 已运行</h2>` +
        `<p>Web 面板尚未构建：<code>npm run build:web</code> 后刷新本页；开发模式用 <code>npm run dev</code>。</p>` +
        `<p>API 文档见 README（/api/overview 等）。</p></body>`,
    );
  });
}

app.use((err, req, res, next) => {
  if (res.headersSent) {
    next(err);
    return;
  }
  res.status(err?.type === "entity.parse.failed" ? 400 : 500).json({ error: err?.message ?? "internal error" });
});

const server = http.createServer(app);
const wsHub = attachWebsocket(server, events);

// 端口被占说明已有实例在跑（headless CLI 不占端口，需自行确认），快速失败避免双实例重复回复。
server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(
      `端口 ${config.webPort} 已被占用：可能已有一个 wx-agent-gateway 实例在运行（ps aux | grep "src/server\|src/cli"）。请先停掉旧实例。`,
    );
    process.exit(1);
  }
  throw error;
});

server.listen(config.webPort, "127.0.0.1", () => {
  logger.info(`web console: http://127.0.0.1:${config.webPort} (v${version}, panel ${existsSync(distDir) ? "built" : "not built"})`);
});

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  console.log("\nshutting down...");
  controller.abort();
  server.close();
  wsHub.close();
  await hub.shutdown().catch(() => undefined);
  console.log("stopped.");
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
