// 微信 iLink 机器人 API 客户端。
// 请求/响应字段形状参考 zai-org/ZCode (Apache-2.0) 的
// packages/services/src/bots/providers/weixinRegistration.ts 与 weixinProvider.ts，
// 按本项目需要做了简化改写。
import { randomInt, randomUUID } from "node:crypto";

export const ILINK_BASE_URL = "https://ilinkai.weixin.qq.com";
const API_PREFIX = "/ilink/bot";
const CHANNEL_VERSION = "2.0.0";
const REGISTRATION_INTERVAL_MS = 3_000;
const REGISTRATION_EXPIRE_SECONDS = 120;
const REQUEST_TIMEOUT_MS = 30_000;
export const GET_UPDATES_TIMEOUT_MS = 90_000;

function isRecord(value) {
  return typeof value === "object" && value !== null;
}
function readString(record, key) {
  return isRecord(record) && typeof record[key] === "string" ? record[key] : "";
}
function readNumber(record, key) {
  if (!isRecord(record)) return null;
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function unwrapData(payload) {
  if (!isRecord(payload)) return {};
  return isRecord(payload.data) ? { ...payload, ...payload.data } : payload;
}
function checkBusinessCode(merged, path) {
  const ret = readNumber(merged, "ret");
  const errcode = readNumber(merged, "errcode");
  if ((ret !== null && ret !== 0) || (errcode !== null && errcode !== 0)) {
    const message = readString(merged, "errmsg") || readString(merged, "message") ||
      `ret=${ret ?? ""} errcode=${errcode ?? ""}`.trim();
    throw new Error(`iLink ${path} failed: ${message}`);
  }
}

async function getRegistrationJson(path) {
  const response = await fetch(`${ILINK_BASE_URL}${API_PREFIX}${path}`, {
    method: "GET",
    headers: { "iLink-App-ClientVersion": "1" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`iLink GET ${path} failed: HTTP ${response.status}`);
  const merged = unwrapData(await response.json());
  checkBusinessCode(merged, path);
  return merged;
}

// ---------- 扫码注册 ----------

export async function beginRegistration() {
  const payload = await getRegistrationJson("/get_bot_qrcode?bot_type=3");
  const qrPayload = readString(payload, "qrcode") || readString(payload, "qr_code");
  const qrImage = readString(payload, "qrcode_img_content") || readString(payload, "qrcode_url") || qrPayload;
  if (!qrPayload && !qrImage) throw new Error("iLink did not return a QR code");
  const expireSeconds =
    readNumber(payload, "expires_in") ?? readNumber(payload, "expire_time") ?? REGISTRATION_EXPIRE_SECONDS;
  return {
    qrPayload: qrPayload || qrImage,
    qrImage,
    intervalMs: REGISTRATION_INTERVAL_MS,
    expiresAt: Date.now() + expireSeconds * 1_000,
  };
}

function normalizeQrStatus(status) {
  if (typeof status === "number") {
    if (status === 0) return "pending";
    if (status === 1) return "scanned";
    if (status === 2) return "success";
    if (status === 3 || status === 4) return "expired";
    return "pending";
  }
  if (typeof status !== "string") return "pending";
  const value = status.toLowerCase();
  if (["confirmed", "confirm", "authorized", "success", "ok"].includes(value)) return "success";
  if (["scaned", "scanned", "scan", "confirmed_wait"].includes(value)) return "scanned";
  if (["expired", "timeout", "cancel", "cancelled", "canceled"].includes(value)) return "expired";
  if (["error", "failed", "fail"].includes(value)) return "error";
  return "pending";
}

export async function pollRegistration(qrPayload) {
  let payload;
  try {
    payload = await getRegistrationJson(`/get_qrcode_status?qrcode=${encodeURIComponent(qrPayload)}`);
  } catch (error) {
    // 扫码状态接口可能在等待手机确认时长时间挂起，超时不等于失败，继续轮询。
    if (error instanceof Error && error.name === "TimeoutError") {
      return { status: "pending", intervalMs: REGISTRATION_INTERVAL_MS };
    }
    throw error;
  }
  const status = normalizeQrStatus(
    payload.status ?? payload["qrcode_status"] ?? payload["qr_status"],
  );
  if (status === "success") {
    const botToken = readString(payload, "bot_token") || readString(payload, "token");
    if (!botToken) return { status: "error", message: "success without bot_token" };
    return {
      status: "success",
      botToken,
      botId: readString(payload, "ilink_bot_id") || readString(payload, "bot_id") || undefined,
    };
  }
  if (status === "expired") return { status: "expired" };
  if (status === "error") {
    return { status: "error", message: readString(payload, "errmsg") || "login failed" };
  }
  return { status, intervalMs: REGISTRATION_INTERVAL_MS };
}

// ---------- 机器人会话（收发消息） ----------

function buildBotHeaders(token) {
  return {
    "content-type": "application/json",
    AuthorizationType: "ilink_bot_token",
    Authorization: `Bearer ${token}`,
    "X-WECHAT-UIN": Buffer.from(String(randomInt(0, 0x1_0000_0000)), "utf8").toString("base64"),
  };
}

export function createBotClient({ token }) {
  async function post(path, body, timeoutMs = REQUEST_TIMEOUT_MS, signal) {
    const response = await fetch(`${ILINK_BASE_URL}${API_PREFIX}${path}`, {
      method: "POST",
      headers: buildBotHeaders(token),
      body: JSON.stringify({ base_info: { channel_version: CHANNEL_VERSION }, ...body }),
      signal: signal ?? AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(`iLink POST ${path} failed: HTTP ${response.status}`);
    const merged = unwrapData(await response.json());
    checkBusinessCode(merged, path);
    return merged;
  }

  return {
    async getUpdates(buf, signal) {
      const payload = await post("/getupdates", { get_updates_buf: buf ?? "" }, GET_UPDATES_TIMEOUT_MS, signal);
      return {
        messages: parseInboundMessages(payload),
        buf: readNextBuf(payload) ?? buf,
      };
    },

    async sendMessage({ toUserId, text, contextToken, fromUserId = "" }) {
      await this.sendItem({
        toUserId,
        item: { type: 1, text_item: { text } },
        contextToken,
        fromUserId,
      });
    },

    // 通用消息发送：item_list 恒为单项（媒体消息的通行约定，参考 openclaw-weixin）。
    async sendItem({ toUserId, item, contextToken, fromUserId = "" }) {
      await post("/sendmessage", {
        msg: {
          from_user_id: fromUserId,
          to_user_id: toUserId,
          client_id: `wxgw-${randomUUID()}`,
          message_type: 2,
          message_state: 2,
          ...(contextToken ? { context_token: contextToken } : {}),
          item_list: [item],
        },
      });
    },

    // 媒体上传第一步：拿 CDN 预签名上传参数（协议字段见 openclaw-weixin 逆向文档）。
    async getUploadUrl({ filekey, mediaType, toUserId, rawsize, rawfilemd5, filesize, aeskey }) {
      const payload = await post("/getuploadurl", {
        filekey,
        media_type: mediaType,
        to_user_id: toUserId,
        rawsize,
        rawfilemd5,
        filesize,
        no_need_thumb: true,
        aeskey,
      });
      const uploadParam =
        readString(payload, "upload_param") || readString(payload, "uploadParam") || "";
      if (!uploadParam) throw new Error("iLink getuploadurl returned no upload_param");
      return { uploadParam };
    },

    async fetchTypingTicket(userId, contextToken) {
      const payload = await post("/getconfig", {
        ilink_user_id: userId,
        ...(contextToken ? { context_token: contextToken } : {}),
      });
      return readString(payload, "typing_ticket") || null;
    },

    async sendTyping(userId, ticket) {
      await post("/sendtyping", { ilink_user_id: userId, typing_ticket: ticket, status: 1 });
    },
  };
}

// ---------- 入站消息解析 ----------

function firstString(source, keys) {
  for (const key of keys) {
    const value = readString(source, key);
    if (value) return value;
  }
  return "";
}

function readInboundText(message, inner) {
  const direct = firstString(message, ["text", "content", "message"]);
  if (direct) return direct;
  const itemList = Array.isArray(message.item_list)
    ? message.item_list
    : Array.isArray(inner?.item_list)
      ? inner.item_list
      : [];
  const joined = itemList
    .map((item) => (isRecord(item) && isRecord(item.text_item) ? readString(item.text_item, "text") : ""))
    .filter(Boolean)
    .join("\n");
  return joined || firstString(inner ?? {}, ["text", "content"]);
}

function readInboundAttachments(message, inner) {
  const itemList = Array.isArray(message.item_list)
    ? message.item_list
    : Array.isArray(inner?.item_list)
      ? inner.item_list
      : [];
  return itemList.some(
    (item) =>
      isRecord(item) &&
      (isRecord(item.image_item) || isRecord(item.file_item) || isRecord(item.video_item) ||
        isRecord(item.audio_item) || isRecord(item.media_item)),
  );
}

// 入站图片：image_item.media 里 full_url 是 CDN 下载地址，aes_key 用于 AES-128-ECB 解密
// （hex 形式的 aeskey 字段优先，参考 ZCode 对该协议的注释）。
function readInboundImages(message, inner) {
  return readMediaItems(message, inner, "image_item").map(({ url, aesKey }) => ({ url, aesKey }));
}

// 入站文件：file_item 与图片同构（CDN 下载 + AES 解密），额外带 file_name。
function readInboundFiles(message, inner) {
  return readMediaItems(message, inner, "file_item").map(({ url, aesKey, holder }) => ({
    url,
    aesKey,
    fileName: firstString(holder, ["file_name", "fileName", "name"]) || null,
  }));
}

function readMediaItems(message, inner, itemKey) {
  const itemList = Array.isArray(message.item_list)
    ? message.item_list
    : Array.isArray(inner?.item_list)
      ? inner.item_list
      : [];
  const items = [];
  for (const item of itemList) {
    if (!isRecord(item) || !isRecord(item[itemKey])) continue;
    const holder = item[itemKey];
    const media = isRecord(holder.media) ? holder.media : holder;
    const url = firstString(media, ["full_url", "url", "download_url", "downloadUrl"]);
    if (!url) continue;
    const aesKey =
      firstString(holder, ["aeskey", "aes_key"]) ||
      firstString(media, ["aeskey", "aes_key", "aesKey"]);
    items.push({ url, aesKey: aesKey || null, holder });
  }
  return items;
}

function parseInboundMessage(message) {
  const inner = isRecord(message.msg) ? message.msg : isRecord(message.message) ? message.message : null;
  const from = isRecord(message.from) ? message.from : null;
  const sender = isRecord(message.sender) ? message.sender : null;
  const userId =
    firstString(message, ["from_user_id", "from", "from_user", "fromUser", "user", "user_id", "userId"]) ||
    readString(from, "id") || readString(from, "wxid") ||
    readString(sender, "id") || readString(sender, "wxid");
  if (!userId) return null;
  const messageId =
    firstString(message, ["id", "msgid", "msgId", "message_id"]) ||
    firstString(inner ?? {}, ["id", "msgid", "msgId", "message_id"]) ||
    `noid-${userId}-${Date.now()}`;
  return {
    id: messageId,
    userId,
    chatId: firstString(message, ["room", "room_id", "roomId", "chat", "chat_id", "chatId"]) || null,
    displayName:
      firstString(message, ["name", "displayName", "nickname"]) ||
      readString(from, "name") || readString(from, "nickname") ||
      readString(sender, "name") || readString(sender, "nickname") ||
      firstString(inner ?? {}, ["sender_name"]) || null,
    text: readInboundText(message, inner).trim(),
    images: readInboundImages(message, inner),
    files: readInboundFiles(message, inner),
    hasAttachments: readInboundAttachments(message, inner),
    contextToken:
      firstString(message, ["context_token", "contextToken", "context"]) ||
      firstString(inner ?? {}, ["context_token"]) ||
      null,
    receivedAt: Date.now(),
  };
}

export function parseInboundMessages(payload) {
  const container = unwrapData(payload);
  const raw = container.msgs ?? container.messages ?? container.updates ?? container.items ?? container.list;
  const list = Array.isArray(raw) ? raw.filter(isRecord) : isRecord(raw) ? [raw] : [];
  return list.map(parseInboundMessage).filter(Boolean);
}

function readNextBuf(payload) {
  const container = unwrapData(payload);
  return (
    firstString(container, ["get_updates_buf", "buf", "next_buf", "nextBuf", "getUpdatesBuf", "syncKey"]) ||
    null
  );
}
