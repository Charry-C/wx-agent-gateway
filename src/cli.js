#!/usr/bin/env node
// CLI 入口（headless 模式）：login（扫码绑定）/ start（启动网关）/ status / agent-test / clear。
// Web 控制台入口见 src/server/main.js（npm run web），两者共享 channels/core 同一套内核。
import { argv, exit } from "node:process";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { EventEmitter } from "node:events";
import qrcode from "qrcode-terminal";
import { weixinProvider } from "./channels/weixin.js";
import { feishuProvider } from "./channels/feishu.js";
import { detectAgents, getAdapter, listAdapters } from "./agents.js";
import { Router } from "./core/router.js";
import { Hub } from "./core/hub.js";
import {
  createPaths,
  loadConfig,
  loadState,
  loadBots,
  saveBots,
  saveJson,
  migrateState,
  createLogger,
} from "./store.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const paths = createPaths(root);

function usage() {
  console.log(`wx-agent-gateway

用法：
  node src/cli.js login [--probe]   扫码绑定微信机器人（--probe 只验证二维码可达，不等待扫码）
  node src/cli.js start             启动网关，headless 模式（Ctrl+C 退出）
  node src/cli.js status            查看配置 / 绑定 / 会话状态
  node src/cli.js agents            自动检测本机 Agent（路径 / 版本）
  node src/cli.js agent-test <name> "<prompt>" [--cwd <dir>]   直接测试某个 agent 适配器
  node src/cli.js clear             清空 data/（解绑并重置全部状态）
  npm run web                       启动 Web 控制台（网关 + 浏览器面板）

可用 agent：${listAdapters().map((a) => `${a.name} (${a.label})`).join("、")}`);
}

async function loadWeixinEntry() {
  const config = await loadConfig(paths.configFile);
  const bots = await loadBots(paths.botsFile, paths.tokenFile, { defaultAgent: config.defaultAgent });
  return { config, entry: bots.find((bot) => bot.provider === "weixin") ?? null, bots };
}

async function cmdLogin(probe) {
  const logger = createLogger(paths.logFile);
  const session = weixinProvider.startLogin({ logger });

  let lastQr = null;
  let lastStatus = null;
  const unsubscribe = session.onChange(() => {
    if (session.qrImage && session.qrImage !== lastQr) {
      lastQr = session.qrImage;
      // 二维码必须编码图片地址（liteapp.weixin.qq.com 链接），
      // 原始 qrcode hex 只是轮询凭证，编进二维码微信只会当成纯文本。
      console.log(`\n请用微信扫码（微信内右上角 + 号 → 扫一扫）。二维码约 120 秒有效，过期自动刷新：\n`);
      qrcode.generate(session.qrImage, { small: true });
      if (session.qrPng) {
        const qrPng = join(paths.dataDir, "wechat-login-qr.png");
        void (async () => {
          try {
            await mkdir(paths.dataDir, { recursive: true });
            await writeFile(qrPng, session.qrPng);
            console.log(`\n扫不出终端二维码时，打开这张官方原图扫：${qrPng}`);
          } catch {
            /* 兜底图写失败不影响扫码 */
          }
        })();
      }
    }
    if (session.status !== lastStatus) {
      lastStatus = session.status;
      if (session.status === "scanned") console.log("\n已扫码，请在手机上确认授权...");
      if (session.status === "refreshing") console.log("\n二维码已过期，正在换新码...");
      if (session.status === "error") console.error(`\n出错: ${session.error}`);
    }
  });

  // 等第一张二维码出来。
  const deadline = Date.now() + 60_000;
  while (!session.qrImage && session.status !== "error" && Date.now() < deadline) {
    await sleep(500);
  }
  if (!session.qrImage) {
    session.cancel();
    unsubscribe();
    console.error(`获取二维码失败: ${session.error ?? "timeout"}`);
    exit(1);
  }
  if (probe) {
    console.log("\n--probe：二维码获取成功，不等待扫码。");
    session.cancel();
    unsubscribe();
    return;
  }

  const result = await session.result;
  unsubscribe();
  if (!result) {
    console.error(`绑定未完成: ${session.status}${session.error ? ` ${session.error}` : ""}`);
    exit(1);
  }
  const { config, bots } = await loadWeixinEntry();
  const existing = bots.find((bot) => bot.provider === "weixin");
  if (existing) {
    Object.assign(existing, {
      credentials: { botToken: result.botToken, botId: result.botId },
    });
  } else {
    bots.push({
      id: "weixin",
      provider: "weixin",
      agent: config.defaultAgent,
      credentials: { botToken: result.botToken, botId: result.botId },
    });
  }
  await saveBots(paths.botsFile, bots);
  logger.info(`bot bound id=${result.botId ?? "unknown"}`);
  console.log("\n绑定成功！现在可以启动网关: npm run start（或 npm run web）");
}

async function cmdStart() {
  const { config, entry } = await loadWeixinEntry();
  if (!entry) {
    console.error("尚未绑定机器人。先运行: npm run login");
    exit(1);
  }
  const state = migrateState(await loadState(paths.stateFile));
  const saveState = (value) => saveJson(paths.stateFile, value);
  const logger = createLogger(paths.logFile);
  const events = new EventEmitter();
  const router = new Router({
    config,
    state,
    saveState,
    logger,
    events,
    mediaDir: join(paths.dataDir, "media"),
  });
  const controller = new AbortController();
  const hub = new Hub({
    providers: { weixin: weixinProvider, feishu: feishuProvider },
    paths,
    config,
    state,
    saveState,
    router,
    logger,
    events,
    signal: controller.signal,
  });
  const shutdown = () => {
    console.log("\nshutting down...");
    controller.abort();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  logger.info(`gateway started agent=${config.defaultAgent} cwd=${config.defaultCwd} owner=${state.ownerUserId ?? "(unbound)"}`);
  await hub.init();
  await new Promise((resolve) => controller.signal.addEventListener("abort", resolve, { once: true }));
  await hub.shutdown();
  console.log("gateway stopped.");
}

async function cmdStatus() {
  const { config, bots } = await loadWeixinEntry();
  const state = migrateState(await loadState(paths.stateFile));
  const weixin = bots.find((bot) => bot.provider === "weixin");
  console.log(`配置文件: ${paths.configFile}`);
  console.log(`机器人: ${weixin ? `已绑定（botId=${weixin.credentials.botId ?? "?"}，agent=${weixin.agent}）` : "未绑定（npm run login）"}`);
  console.log(`默认 agent: ${config.defaultAgent}`);
  console.log(`默认工作目录: ${config.defaultCwd}`);
  console.log(`agent 超时: ${Math.round(config.agentTimeoutMs / 60_000)} 分钟`);
  console.log(`codex 沙箱: ${config.codexSandbox}`);
  console.log(`白名单: ${config.allowedUsers.length ? config.allowedUsers.join(", ") : "(空，首个发消息者自动绑定为所有者)"}`);
  console.log(`所有者: ${state.ownerDisplayName ?? state.ownerUserId ?? "(未绑定)"}`);
  const convs = Object.entries(state.conversations);
  if (convs.length) {
    console.log("会话：");
    for (const [key, conv] of convs) {
      console.log(`  ${key}: agent=${conv.agent ?? config.defaultAgent} cwd=${conv.cwd ?? config.defaultCwd} sessions=${JSON.stringify(conv.sessions ?? {})}`);
    }
  }
}

async function cmdAgentTest(name, prompt, cwdOverride) {
  const adapter = getAdapter(name);
  if (!adapter) {
    console.error(`未知 agent: ${name}`);
    exit(1);
  }
  if (!prompt) {
    console.error("缺少 prompt");
    exit(1);
  }
  const config = await loadConfig(paths.configFile);
  const cwd = cwdOverride ?? config.defaultCwd;
  console.log(`testing ${adapter.label} cwd=${cwd} ...`);
  const startedAt = Date.now();
  const controller = new AbortController();
  process.on("SIGINT", () => controller.abort());
  const result = await adapter.run({
    text: prompt,
    sessionId: null,
    cwd,
    timeoutMs: config.agentTimeoutMs,
    signal: controller.signal,
    config,
  });
  console.log(`--- 回复 ---\n${result.reply}\n--- 会话 ID: ${result.sessionId ?? "(无)"}，耗时 ${Math.round((Date.now() - startedAt) / 1000)}s ---`);
}

async function cmdClear() {
  await rm(paths.dataDir, { recursive: true, force: true });
  console.log(`已清空 ${paths.dataDir}`);
}

async function main() {
  const [command, ...args] = argv.slice(2);
  try {
    switch (command) {
      case "login":
        await cmdLogin(args.includes("--probe"));
        break;
      case "start":
        await cmdStart();
        break;
      case "status":
        await cmdStatus();
        break;
      case "agents":
        for (const agent of await detectAgents()) {
          console.log(`${agent.label} (${agent.name}): ${agent.installed ? `${agent.path} · ${agent.version ?? agent.probeError}` : "未安装"}`);
        }
        break;
      case "agent-test": {
        const name = args[0];
        const cwdIndex = args.indexOf("--cwd");
        const cwdOverride = cwdIndex >= 0 ? args[cwdIndex + 1] : undefined;
        const prompt = args.slice(1).filter((_, i) => i !== cwdIndex - 1 && i !== cwdIndex).join(" ").trim();
        await cmdAgentTest(name, prompt, cwdOverride);
        break;
      }
      case "clear":
        await cmdClear();
        break;
      default:
        usage();
        exit(command ? 1 : 0);
    }
  } catch (error) {
    console.error(`error: ${error.message}`);
    exit(1);
  }
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

await main();
