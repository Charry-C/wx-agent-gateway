// 消息路由器（渠道无关）：入站去重 → 鉴权/owner 绑定 → 命令分发 → 会话队列 → agent 执行 → 分片回复。
// 图片管线：入站图片经 bot.downloadImage 落盘后以路径并入 prompt（适配器可再走原生图片入参）；
// 回复文本中引用的本机图片文件经 bot.sendImage 以图片消息回传。
import { statSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import { discoverAgents, getAdapter } from "../agents.js";

const DEDUP_MAX = 1_000;
const TYPING_INTERVAL_MS = 25_000;
const UNAUTHORIZED_NOTICE_INTERVAL_MS = 60 * 60_000;
const MAX_IMAGES_PER_MESSAGE = 4;
const MAX_FILES_PER_MESSAGE = 4;
const MAX_IMAGES_PER_REPLY = 3;
const IMAGE_EXTENSION_PATTERN = /\.(png|jpe?g|gif|webp|bmp)$/i;

// IM 传来的文件名不可信：去路径分隔符与控制字符、限长，空名兜底。
function sanitizeFileName(name) {
  const cleaned = String(name ?? "")
    .replace(/[/\\]/g, "_")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/^\.+/, "")
    .slice(0, 80)
    .trim();
  return cleaned || "file.bin";
}

export class Router {
  constructor({ config, state, saveState, logger, events, mediaDir }) {
    this.config = config;
    this.state = state;
    this.saveState = saveState;
    this.log = logger;
    this.events = events;
    this.mediaDir = mediaDir;
    // conversationKey -> { queue: [job], busy, controller, currentText }
    this.conv = new Map();
    this.seen = new Set();
    this.seenOrder = [];
    this.lastUnauthorizedNotice = new Map();
  }

  emit(type, payload) {
    this.events?.emit("event", { type, payload, at: new Date().toISOString() });
  }

  conversationKey(bot, message) {
    return message.chatId ? `${bot.id}:group:${message.chatId}` : `${bot.id}:dm:${message.userId}`;
  }

  getConversation(key) {
    let entry = this.conv.get(key);
    if (!entry) {
      entry = { queue: [], busy: false, controller: null, currentText: null, startedAt: null };
      this.conv.set(key, entry);
    }
    return entry;
  }

  convState(key) {
    const state = this.state.conversations[key] ?? (this.state.conversations[key] = {});
    return state;
  }

  markSeen(id) {
    if (this.seen.has(id)) return false;
    this.seen.add(id);
    this.seenOrder.push(id);
    if (this.seenOrder.length > DEDUP_MAX) {
      const drop = this.seenOrder.shift();
      this.seen.delete(drop);
    }
    return true;
  }

  async reply(bot, message, text) {
    // 回复里引用的本机图片文件先以图片消息回传（agent 生成图表/截图的典型产出方式）。
    if (typeof bot.sendImage === "function") {
      const key = this.conversationKey(bot, message);
      const conv = this.convState(key);
      const cwd = conv.cwd ?? this.config.defaultCwd;
      for (const file of this.detectReplyImages(text, cwd)) {
        try {
          const buffer = await readFile(file);
          await bot.sendImage({ userId: message.userId, buffer, contextToken: message.contextToken });
          this.emit("message", { direction: "out", kind: "image", botId: bot.id, userId: message.userId, text: basename(file) });
        } catch (error) {
          this.log.error(`send image ${basename(file)} failed: ${error.message}`);
        }
      }
    }
    const chunks = chunkText(text, this.config.replyChunkLength ?? 2000);
    for (const chunk of chunks) {
      try {
        await bot.send({ userId: message.userId, text: chunk, contextToken: message.contextToken });
        this.emit("message", { direction: "out", botId: bot.id, userId: message.userId, text: chunk });
      } catch (error) {
        this.log.error(`send message failed to ${message.userId}: ${error.message}`);
        return;
      }
    }
  }

  // 从回复文本中挑出真实存在的本机图片文件：绝对路径 + markdown/相对路径（按会话 cwd 解析）。
  // 排除我们自己的收图目录，避免 agent 复述路径时把用户刚发的图原样弹回去。
  detectReplyImages(text, cwd) {
    if (!text || !this.mediaDir) return [];
    const found = [];
    const push = (candidate) => {
      const file = isAbsolute(candidate) ? candidate : resolve(cwd, candidate);
      if (found.includes(file)) return;
      if (file.startsWith(this.mediaDir)) return;
      try {
        if (!statSync(file).isFile()) return;
      } catch {
        return;
      }
      if (IMAGE_EXTENSION_PATTERN.test(file)) found.push(file);
    };
    // 绝对路径：直接从 "/" 起匹配到图片扩展名，不受前缀标点（含全角冒号）影响。
    for (const match of text.matchAll(/\/[^\s`()（）"'，。；：！？【】]+?\.(?:png|jpe?g|gif|webp|bmp)/gi)) {
      push(match[0]);
    }
    // markdown 相对路径：![...](sub/out.png) 按会话 cwd 解析。
    for (const match of text.matchAll(/!\[[^\]]*\]\(([^)\s]+)[^)]*\)/g)) {
      push(match[1]);
    }
    return found.slice(0, MAX_IMAGES_PER_REPLY);
  }

  async sendTyping(bot, message) {
    if (!bot.sendTyping) return;
    await bot.sendTyping({ userId: message.userId, contextToken: message.contextToken });
  }

  // ---------- 消息入口 ----------

  async handleInbound(bot, message) {
    if (!this.markSeen(message.id)) return;

    this.emit("message", { direction: "in", botId: bot.id, userId: message.userId, displayName: message.displayName, text: message.text });

    // 群聊 v1 暂不处理，避免误触发。
    if (message.chatId) {
      this.log.info(`skip group message from ${message.displayName ?? message.userId}`);
      return;
    }
    // 机器人自身的回声。
    if (bot.selfUserId && message.userId === bot.selfUserId) return;

    if (!this.authorizeSender(bot, message)) return;

    const text = message.text;
    const inbound = await this.saveInboundMedia(bot, message);
    if (!text && !inbound.images.length && !inbound.files.length) {
      if (message.hasAttachments) {
        await this.reply(bot, message, "暂只支持文字、图片和文件；视频/语音请改发文字。");
      }
      return;
    }

    if (text.startsWith("/") && !inbound.images.length && !inbound.files.length) {
      await this.handleCommand(bot, message, text);
      return;
    }
    this.enqueue(bot, message, this.buildPrompt(text, inbound), inbound.images);
  }

  // 收媒体：图片/文件经渠道下载（含解密）后落盘到 mediaDir。
  // 返回 { images: [路径], files: [路径] }；图片路径供适配器原生入参，文件只进 prompt。
  async saveInboundMedia(bot, message) {
    const result = { images: [], files: [] };
    if (typeof bot.downloadMedia !== "function" || !this.mediaDir) return result;
    const stamp = Date.now();
    await mkdir(this.mediaDir, { recursive: true }).catch(() => undefined);
    for (const [index, attachment] of (message.images ?? []).slice(0, MAX_IMAGES_PER_MESSAGE).entries()) {
      try {
        const { data, imageExt } = await bot.downloadMedia(attachment);
        const file = join(this.mediaDir, `wx-${stamp}-${index}.${imageExt ?? "png"}`);
        await writeFile(file, data);
        result.images.push(file);
      } catch (error) {
        this.log.error(`download inbound image failed: ${error.message}`);
      }
    }
    for (const [index, attachment] of (message.files ?? []).slice(0, MAX_FILES_PER_MESSAGE).entries()) {
      try {
        const { data } = await bot.downloadMedia(attachment);
        const file = join(this.mediaDir, `wx-${stamp}-f${index}-${sanitizeFileName(attachment.fileName)}`);
        await writeFile(file, data);
        result.files.push(file);
      } catch (error) {
        this.log.error(`download inbound file failed: ${error.message}`);
      }
    }
    const total = result.images.length + result.files.length;
    if (total) this.log.info(`saved ${total} inbound media item(s) under ${this.mediaDir}`);
    return result;
  }

  buildPrompt(text, { images, files }) {
    if (!images.length && !files.length) return text;
    const sections = [];
    if (images.length) {
      sections.push(`[用户发来 ${images.length} 张图片，已保存到本机：\n${images.join("\n")}]`);
    }
    if (files.length) {
      sections.push(`[用户发来 ${files.length} 个文件，已保存到本机：\n${files.join("\n")}]`);
    }
    const suffix = `\n\n${sections.join("\n")}`;
    return text ? text + suffix : `${sections.join("\n")}。请查看并处理。`;
  }

  authorizeSender(bot, message) {
    const allow = new Set(this.config.allowedUsers ?? []);
    if (allow.size > 0) {
      if (!allow.has(message.userId)) return false;
      this.bindOwnerIfUnset(bot, message);
      return true;
    }
    if (!this.state.ownerUserId) {
      this.state.ownerUserId = message.userId;
      this.state.ownerDisplayName = message.displayName;
      void this.saveState(this.state);
      this.log.info(`owner bound: ${message.displayName ?? message.userId} (${message.userId})`);
      void this.reply(bot, message, `已将你绑定为所有者：${message.userId}\n其他账号将被拒绝。可用 /help 查看命令。`);
      return true;
    }
    if (this.state.ownerUserId === message.userId) return true;
    const last = this.lastUnauthorizedNotice.get(message.userId) ?? 0;
    if (Date.now() - last > UNAUTHORIZED_NOTICE_INTERVAL_MS) {
      this.lastUnauthorizedNotice.set(message.userId, Date.now());
      void this.reply(bot, message, "未授权：该机器人仅对所有者开放。");
    }
    this.log.warn(`rejected sender ${message.userId} (${message.displayName ?? ""})`);
    return false;
  }

  bindOwnerIfUnset(bot, message) {
    if (this.state.ownerUserId) return;
    this.state.ownerUserId = message.userId;
    this.state.ownerDisplayName = message.displayName;
    void this.saveState(this.state);
    this.log.info(`owner bound via allowlist: ${message.userId}`);
  }

  // ---------- 命令 ----------

  async handleCommand(bot, message, text) {
    const key = this.conversationKey(bot, message);
    const [rawCommand, ...rest] = text.slice(1).split(/\s+/);
    const command = rawCommand.toLowerCase();
    const argument = rest.join(" ").trim();
    const conv = this.convState(key);

    switch (command) {
      case "help":
        await this.reply(
          bot,
          message,
          [
            "wx-agent-gateway 命令：",
            "/agent <name> — 切换本会话 agent（" + discoverAgents().filter((a) => a.installed).map((a) => a.name).join("/") + "）",
            "/new — 重置当前会话（新开 agent 上下文）",
            "/cwd <path> — 设置工作目录",
            "/status — 查看当前配置与会话状态",
            "/stop — 终止当前正在执行的任务并清空排队",
            "直接发文字即为对话；对话有上下文，换话题建议先 /new。",
          ].join("\n"),
        );
        return;
      case "agent": {
        const adapter = getAdapter(argument);
        if (!adapter || !discoverAgents().some((a) => a.name === argument && a.installed)) {
          await this.reply(bot, message, `agent 未安装或不支持: ${argument}\n本机可选：${discoverAgents().filter((a) => a.installed).map((a) => a.name).join(", ") || "未检测到 Agent"}`);
          return;
        }
        conv.agent = adapter.name;
        await this.saveState(this.state);
        await this.reply(bot, message, `已切换到 ${adapter.label}（新会话将从下一条消息开始）。发送 /new 立即重置上下文。`);
        this.emit("session_update", { key });
        return;
      }
      case "new": {
        conv.sessions = {};
        await this.saveState(this.state);
        await this.reply(bot, message, "会话已重置，下一条消息将开启新上下文。");
        this.emit("session_update", { key });
        return;
      }
      case "cwd": {
        if (!argument) {
          await this.reply(bot, message, `当前工作目录：${conv.cwd ?? this.config.defaultCwd}\n用法：/cwd /absolute/path`);
          return;
        }
        const target = isAbsolute(argument) ? argument : resolve(this.config.defaultCwd, argument);
        conv.cwd = target;
        conv.sessions = {};
        await this.saveState(this.state);
        await this.reply(bot, message, `工作目录已设置为 ${target}（会话已重置）。`);
        this.emit("session_update", { key });
        return;
      }
      case "status": {
        const running = this.getConversation(key);
        await this.reply(
          bot,
          message,
          [
            `所有者：${this.state.ownerDisplayName ?? this.state.ownerUserId ?? "(未绑定)"}`,
            `agent：${conv.agent ?? bot.agent ?? this.config.defaultAgent}`,
            `工作目录：${conv.cwd ?? this.config.defaultCwd}`,
            `会话：${Object.entries(conv.sessions ?? {})
              .map(([agent, id]) => `${agent}=${String(id).slice(0, 8)}`)
              .join(" ") || "(无)"}`,
            `队列：${running.queue.length} 个排队，${running.busy ? "有任务执行中" : "空闲"}`,
            `codex 沙箱：${this.config.codexSandbox}`,
          ].join("\n"),
        );
        return;
      }
      case "stop": {
        this.stopTask(key);
        const running = this.getConversation(key);
        if (running.lastStopAborted) {
          await this.reply(bot, message, "已发送终止信号，清空排队。");
        } else {
          await this.reply(bot, message, "当前没有正在执行的任务。");
        }
        return;
      }
      default:
        await this.reply(bot, message, `未知命令 /${rawCommand}，/help 查看。`);
    }
  }

  // 面板/命令共用的停任务：终止执行中的任务并清空排队。返回是否有任务被终止。
  stopTask(key) {
    const entry = this.conv.get(key);
    if (!entry || !entry.controller) {
      if (entry) entry.queue.length = 0;
      return false;
    }
    entry.controller.abort();
    entry.queue.length = 0;
    entry.lastStopAborted = true;
    return true;
  }

  // 解绑 bot 时终止其名下所有执行中/排队任务（会话 key 均以 `${botId}:` 开头）。
  stopBotTasks(botId) {
    const prefix = `${botId}:`;
    let stopped = 0;
    for (const key of [...this.conv.keys()]) {
      if (key.startsWith(prefix) && this.stopTask(key)) stopped += 1;
    }
    return stopped;
  }

  // ---------- 队列与执行 ----------

  enqueue(bot, message, text, images = []) {
    const key = this.conversationKey(bot, message);
    const entry = this.getConversation(key);
    entry.queue.push({ bot, message, text, images });
    if (!entry.busy) void this.runQueue(key);
  }

  async runQueue(key) {
    const entry = this.getConversation(key);
    if (entry.busy) return;
    entry.busy = true;
    try {
      while (entry.queue.length) {
        const { bot, message, text, images } = entry.queue.shift();
        entry.controller = new AbortController();
        await this.execute(key, bot, message, text, entry.controller.signal, images);
        entry.controller = null;
      }
    } finally {
      entry.busy = false;
      entry.controller = null;
      entry.currentText = null;
      this.emit("session_update", { key });
    }
  }

  async execute(key, bot, message, text, signal, images = []) {
    const conv = this.convState(key);
    const agentName = conv.agent ?? bot.agent ?? this.config.defaultAgent;
    const adapter = getAdapter(agentName);
    if (!adapter) {
      await this.reply(bot, message, `agent ${agentName} 不可用，/agent 重新选择。`);
      return;
    }
    const cwd = conv.cwd ?? this.config.defaultCwd;
    conv.sessions ??= {};
    const sessionId = conv.sessions[agentName] ?? null;

    const entry = this.getConversation(key);
    entry.currentText = text;
    entry.startedAt = Date.now();
    this.emit("session_update", { key });

    const typingTimer = setInterval(() => void this.sendTyping(bot, message), TYPING_INTERVAL_MS);
    void this.sendTyping(bot, message);
    const startedAt = Date.now();
    this.log.info(`run ${agentName} for ${key} session=${sessionId ?? "new"} cwd=${cwd}`);
    try {
      const result = await adapter.run({
        text,
        images,
        sessionId,
        cwd,
        timeoutMs: this.config.agentTimeoutMs,
        signal,
        config: this.config,
      });
      if (result.sessionId && result.sessionId !== sessionId) {
        conv.sessions[agentName] = result.sessionId;
        await this.saveState(this.state);
      }
      const seconds = Math.round((Date.now() - startedAt) / 1000);
      this.log.info(`done ${agentName} for ${key} in ${seconds}s session=${result.sessionId ?? "-"}`);
      await this.reply(bot, message, result.reply || "(空回复)");
    } catch (error) {
      if (signal.aborted) {
        await this.reply(bot, message, "任务已被终止。");
      } else {
        this.log.error(`agent ${agentName} failed: ${error.message}`);
        await this.reply(bot, message, `执行失败：${String(error.message).slice(0, 500)}`);
      }
    } finally {
      clearInterval(typingTimer);
      entry.currentText = null;
      entry.startedAt = null;
      entry.lastStopAborted = false;
    }
  }

  // ---------- 面板快照 ----------

  sessionsSnapshot() {
    return Object.entries(this.state.conversations).map(([key, conv]) => {
      const runtime = this.conv.get(key);
      const [botId, kind, ...rest] = key.split(":");
      return {
        key,
        botId,
        kind,
        userId: rest.join(":"),
        agent: conv.agent ?? null,
        cwd: conv.cwd ?? null,
        sessions: conv.sessions ?? {},
        busy: runtime?.busy ?? false,
        queued: runtime?.queue.length ?? 0,
        currentText: runtime?.currentText ?? null,
        startedAt: runtime?.startedAt ?? null,
      };
    });
  }
}

function chunkText(text, maxLength) {
  if (text.length <= maxLength) return [text];
  const chunks = [];
  let remaining = text;
  while (remaining.length > maxLength) {
    let split = remaining.lastIndexOf("\n", maxLength);
    if (split < maxLength * 0.5) split = maxLength;
    chunks.push(remaining.slice(0, split));
    remaining = remaining.slice(split).replace(/^\n/, "");
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}
