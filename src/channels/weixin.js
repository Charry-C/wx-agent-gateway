// 微信渠道 provider：扫码登录状态机（二维码过期自动刷新）+ bot 实例（iLink 长轮询收发）。
// 轮询循环与游标语义迁自原 gateway.js，行为不变；typing 为微信特有能力，由 router 按需调用。
// 图片收发走 iLink CDN（AES-128-ECB），协议参考 openclaw-weixin 逆向文档与 ZCode 的解密实现。
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { beginRegistration, pollRegistration, createBotClient } from "./ilink.js";
import { createLoginSessionBase } from "./login-session.js";

const POLL_ERROR_BACKOFF_MS = 5_000;
const POLL_MAX_BACKOFF_MS = 30_000;
const TYPING_TICKET_TTL_MS = 5 * 60_000;
const QR_GRACE_MS = 30_000;
const CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";
const UPLOAD_MEDIA_TYPE = { image: 1, video: 2, file: 3, voice: 4 };
const CDN_UPLOAD_RETRIES = 3;

// ---------- CDN 媒体加解密 ----------

// PKCS7 填充后大小：AES-128-ECB 按 16 字节块，明文对齐时补满块。
function aesEcbPaddedSize(size) {
  return size + (16 - (size % 16));
}

function encryptAesEcb(plaintext, key) {
  const cipher = createCipheriv("aes-128-ecb", key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

function decryptAesEcd(ciphertext, key) {
  const decipher = createDecipheriv("aes-128-ecb", key, null);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

// 密钥可能以 hex（32 字符）或 base64 形式出现，两种都试。
function parseAesKey(value) {
  if (typeof value !== "string" || !value) return null;
  if (/^[0-9a-fA-F]{32}$/.test(value)) return Buffer.from(value, "hex");
  try {
    const decoded = Buffer.from(value, "base64");
    if (decoded.length === 16) return decoded;
  } catch {
    /* fallthrough */
  }
  return null;
}

function sniffImageExt(buffer) {
  if (buffer.length > 8 && buffer[0] === 0x89 && buffer[1] === 0x50) return "png";
  if (buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8) return "jpg";
  if (buffer.length > 6 && buffer.slice(0, 3).toString("ascii") === "GIF") return "gif";
  if (buffer.length > 12 && buffer.slice(8, 12).toString("ascii") === "WEBP") return "webp";
  return null;
}

const sleep = (ms, signal) =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = () => {
      clearTimeout(timerId);
      signal?.removeEventListener("abort", timer);
      resolve();
    };
    const timerId = setTimeout(timer, ms);
    signal?.addEventListener("abort", timer);
  });

function describePollError(error) {
  const message = error?.message || String(error);
  const causes = [error, error?.cause, ...(Array.isArray(error?.cause?.errors) ? error.cause.errors : [])];
  const codes = [...new Set(causes.map((cause) => cause?.code).filter((code) => typeof code === "string"))];
  const detail = codes.join(", ") || error?.cause?.message;
  return detail && !message.includes(detail) ? `${message} (${detail})` : message;
}

// 官方二维码原图在浏览器直接访问时是落地页，只有响应真是图片才可用（与 cli.js 同一判断）。
async function downloadOfficialQr(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) return null;
    const buffer = Buffer.from(await response.arrayBuffer());
    const isPng = buffer.length > 100 && buffer[0] === 0x89 && buffer[1] === 0x50;
    const isJpeg = buffer.length > 100 && buffer[0] === 0xff && buffer[1] === 0xd8;
    return isPng || isJpeg ? buffer : null;
  } catch {
    return null;
  }
}

export const weixinProvider = {
  id: "weixin",
  label: "微信",
  capabilities: { typing: true },
  // 微信平台一个账号只能绑一个 bot，注册表里最多一条 weixin 实例。
  singleton: true,

  // ---------- 扫码登录 ----------
  // 返回登录会话：内部自轮询、二维码过期自动重取；cancel() 可随时中止。
  startLogin({ logger } = {}) {
    const session = createLoginSessionBase({ provider: "weixin" });

    const flow = (async () => {
      while (session.status !== "cancelled" && session.status !== "success") {
        let registration;
        try {
          registration = await beginRegistration();
        } catch (error) {
          session.status = "error";
          session.error = `获取二维码失败: ${error.message}`;
          session.endedAt = Date.now();
          session.notify();
          await sleep(POLL_ERROR_BACKOFF_MS);
          continue;
        }
        session.qrImage = registration.qrImage;
        session.expiresAt = registration.expiresAt;
        session.qrPng = await downloadOfficialQr(registration.qrImage);
        session.status = "pending";
        session.error = null;
        session.notify();
        logger?.info(`weixin login: qr ready (expires in ${Math.round((registration.expiresAt - Date.now()) / 1000)}s)`);

        const deadline = registration.expiresAt + QR_GRACE_MS;
        while (Date.now() < deadline && session.status !== "cancelled") {
          await sleep(registration.intervalMs);
          if (session.status === "cancelled") break;
          let result;
          try {
            result = await pollRegistration(registration.qrPayload);
          } catch (error) {
            // 轮询网络抖动不算失败，继续等。
            logger?.warn(`weixin login: poll error: ${error.message}`);
            continue;
          }
          if (result.status === "pending") continue;
          if (result.status === "scanned") {
            if (session.status !== "scanned") {
              session.status = "scanned";
              session.notify();
            }
            continue;
          }
          if (result.status === "success") {
            session.credentials = { botToken: result.botToken, botId: result.botId ?? null };
            session.status = "success";
            session.endedAt = Date.now();
            session.notify();
            return session.credentials;
          }
          // expired / error：换一张二维码重来。
          logger?.info(`weixin login: qr ${result.status}${result.message ? ` (${result.message})` : ""}, refreshing`);
          break;
        }
        if (session.status !== "cancelled" && session.status !== "success") {
          session.status = "refreshing";
          session.notify();
        }
      }
      return null;
    })();

    session.result = flow;
    return session;
  },

  // ---------- bot 实例 ----------
  // deps:
  //   entry      bots.json 条目（credentials.botToken / botId）
  //   getCursor / setCursor   游标读写（state.cursors.weixin，hub 负责持久化）
  //   onMessage(message)      每条入站消息（hub → router）
  //   onStatus(status, bot)   连接状态变化
  //   signal                  全局关停信号
  createBot({ entry, getCursor, setCursor, onMessage, onStatus, logger, signal }) {
    const client = createBotClient({ token: entry.credentials.botToken });
    let controller = null;
    const typingTickets = new Map();

    const bot = {
      id: entry.id,
      provider: "weixin",
      agent: entry.agent,
      label: "微信",
      selfUserId: entry.credentials.botId ?? null,
      status: "stopped",
      lastError: null,
      connectedAt: null,

      setStatus(status, error = null) {
        bot.status = status;
        bot.lastError = error;
        onStatus(status, bot);
      },

      async start() {
        if (controller || signal?.aborted) return;
        controller = new AbortController();
        const onGlobalAbort = () => bot.stop();
        signal?.addEventListener("abort", onGlobalAbort, { once: true });
        bot.setStatus("connecting");
        try {
          await bot.runLoop(controller.signal);
        } finally {
          signal?.removeEventListener("abort", onGlobalAbort);
          controller = null;
          bot.setStatus("stopped");
        }
      },

      async stop() {
        controller?.abort();
      },

      async runLoop(pollSignal) {
        let failures = 0;
        let retryDelay = POLL_ERROR_BACKOFF_MS;
        while (!pollSignal.aborted) {
          const cursor = getCursor();
          try {
            const { messages, buf } = await client.getUpdates(cursor?.buf ?? null, pollSignal);
            if (pollSignal.aborted) return;
            if (bot.status !== "connected") {
              bot.connectedAt = new Date().toISOString();
              bot.setStatus("connected");
              if (failures) logger?.info(`weixin reconnected after ${failures} failed poll(s)`);
            }
            failures = 0;
            retryDelay = POLL_ERROR_BACKOFF_MS;
            if (!cursor?.initialized) {
              // 首次启动：只消费游标，不回放历史消息。
              setCursor({ buf, initialized: true });
              if (messages.length) logger?.info(`weixin: skipped ${messages.length} backlog message(s) on first poll`);
              continue;
            }
            for (const message of messages) {
              if (pollSignal.aborted) return;
              await onMessage(message);
            }
            if (buf && buf !== cursor?.buf) {
              // 游标在本批消息全部进入处理后落盘，中途崩溃不会跳过未处理消息。
              setCursor({ buf });
            }
          } catch (error) {
            if (pollSignal.aborted) return;
            if (error.name === "TimeoutError" || error.name === "AbortError") continue;
            failures++;
            const reason = describePollError(error);
            bot.setStatus("connecting", `${reason}；正在自动重连，${retryDelay / 1000} 秒后重试（第 ${failures} 次）`);
            logger?.warn(`weixin poll failed: ${reason}; retry #${failures} in ${retryDelay / 1000}s`);
            await sleep(retryDelay, pollSignal);
            retryDelay = Math.min(retryDelay * 2, POLL_MAX_BACKOFF_MS);
            if (pollSignal.aborted) return;
          }
        }
      },

      async send({ userId, text, contextToken }) {
        await client.sendMessage({ toUserId: userId, text, contextToken });
      },

      // ---------- 媒体收发（iLink CDN，图片与文件同通道） ----------

      // 收媒体：下载 CDN 密文并解密。返回 { data, imageExt }；无密钥时原样返回（兼容未加密场景）。
      // imageExt 仅在数据是已知图片格式时非空，文件类型以消息携带的 fileName 为准。
      async downloadMedia({ url, aesKey }) {
        const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
        if (!response.ok) throw new Error(`媒体下载失败: HTTP ${response.status}`);
        let data = Buffer.from(await response.arrayBuffer());
        const key = parseAesKey(aesKey);
        if (key) data = decryptAesEcd(data, key);
        return { data, imageExt: sniffImageExt(data) };
      },

      // 发图：getuploadurl → AES 加密 PUT CDN → sendmessage(image_item)。
      async sendImage({ userId, buffer, contextToken }) {
        const plaintext = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
        const rawsize = plaintext.length;
        const rawfilemd5 = createHash("md5").update(plaintext).digest("hex");
        const filesize = aesEcbPaddedSize(rawsize);
        const filekey = randomBytes(16).toString("hex");
        const aeskey = randomBytes(16);

        const { uploadParam } = await client.getUploadUrl({
          filekey,
          mediaType: UPLOAD_MEDIA_TYPE.image,
          toUserId: userId,
          rawsize,
          rawfilemd5,
          filesize,
          aeskey: aeskey.toString("hex"),
        });

        const ciphertext = encryptAesEcb(plaintext, aeskey);
        const cdnUrl =
          `${CDN_BASE_URL}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}` +
          `&filekey=${encodeURIComponent(filekey)}`;
        let downloadParam = null;
        let lastError = null;
        for (let attempt = 1; attempt <= CDN_UPLOAD_RETRIES; attempt++) {
          try {
            const response = await fetch(cdnUrl, {
              method: "POST",
              headers: { "content-type": "application/octet-stream" },
              body: new Uint8Array(ciphertext),
              signal: AbortSignal.timeout(60_000),
            });
            if (response.status >= 400 && response.status < 500) {
              throw new Error(`CDN 4xx: ${response.headers.get("x-error-message") ?? response.status}`);
            }
            if (response.status !== 200) throw new Error(`CDN ${response.status}`);
            downloadParam = response.headers.get("x-encrypted-param");
            if (!downloadParam) throw new Error("CDN 响应缺少 x-encrypted-param");
            break;
          } catch (error) {
            lastError = error;
            if (String(error.message).includes("4xx")) throw error;
          }
        }
        if (!downloadParam) throw lastError ?? new Error("CDN 上传失败");

        await client.sendItem({
          toUserId: userId,
          contextToken,
          item: {
            type: 2,
            image_item: {
              media: {
                encrypt_query_param: downloadParam,
                // 密钥编码对齐 openclaw-weixin：base64(32 位 hex 字符串)。协议支持多种
                // 编码，但接收端若解不开密文会直接显示"已过期或被清理"，跟随后验实现最稳。
                aes_key: Buffer.from(aeskey.toString("hex")).toString("base64"),
                encrypt_type: 1,
              },
              mid_size: ciphertext.length,
            },
          },
        });
      },

      // typing 是尽力而为的体验优化，失败不影响主流程（票据 5 分钟缓存）。
      async sendTyping({ userId, contextToken }) {
        try {
          const cached = typingTickets.get(userId);
          let ticket = cached && Date.now() - cached.at < TYPING_TICKET_TTL_MS ? cached.ticket : null;
          if (!ticket) {
            ticket = await client.fetchTypingTicket(userId, contextToken);
            typingTickets.set(userId, { ticket, at: Date.now() });
          }
          if (ticket) await client.sendTyping(userId, ticket);
        } catch {
          /* best effort */
        }
      },
    };

    return bot;
  },
};
