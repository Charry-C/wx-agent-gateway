// 渠道扫码登录会话的公共基座：状态机外壳（状态/监听/取消/二维码出图），
// 各渠道 provider 只需填自己的"取码 + 轮询"流程并驱动 session.status。
// status: pending(等扫码) | scanned(已扫待确认) | refreshing(换码中) | success | cancelled | error
import { randomUUID } from "node:crypto";
import QRCode from "qrcode";

export function createLoginSessionBase({ provider }) {
  const session = {
    id: randomUUID(),
    provider,
    status: "pending",
    qrImage: null,
    qrPng: null,
    expiresAt: null,
    error: null,
    credentials: null,
    endedAt: null,
    listeners: new Set(),
    onChange(listener) {
      session.listeners.add(listener);
      return () => session.listeners.delete(listener);
    },
    cancel() {
      if (session.status === "success") return;
      session.status = "cancelled";
      session.endedAt = Date.now();
      session.notify();
    },
    notify() {
      for (const listener of session.listeners) listener();
    },
    // 二维码 PNG：渠道给官方原图字节则直接用，否则按二维码链接自行生成。
    async qrBuffer() {
      if (session.qrPng) return session.qrPng;
      if (!session.qrImage) return null;
      return QRCode.toBuffer(session.qrImage, { type: "png", width: 480, margin: 2 });
    },
  };
  return session;
}

export function snapshotLoginSession(session) {
  return {
    loginId: session.id,
    provider: session.provider,
    status: session.status,
    expiresAt: session.expiresAt,
    hasQr: Boolean(session.qrImage),
    error: session.error,
    credentials: session.credentials
      ? { botId: session.credentials.botId ?? session.credentials.appId ?? null }
      : null,
  };
}
