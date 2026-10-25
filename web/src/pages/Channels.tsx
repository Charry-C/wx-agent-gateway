import { useCallback, useEffect, useRef, useState } from "react";
import { MessageCircle, QrCode, Trash2, TriangleAlert } from "lucide-react";
import {
  api,
  type BotStatus,
  type ChannelInfo,
  type LoginStatus,
  type Overview,
} from "@/api";
import { useServerEvent } from "@/ws";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label, Select } from "@/components/ui/input";

const STATUS_TEXT: Record<BotStatus["status"], { label: string; variant: "success" | "warning" | "destructive" | "secondary" }> = {
  connected: { label: "在线", variant: "success" },
  connecting: { label: "连接中", variant: "warning" },
  error: { label: "异常", variant: "destructive" },
  stopped: { label: "已停止", variant: "secondary" },
};

function AgentSelect({
  agents,
  value,
  onChange,
}: {
  agents: { name: string; label: string }[];
  value: string;
  onChange: (name: string) => void;
}) {
  return (
    <Select className="h-7 w-28 text-xs" value={value} onChange={(event) => onChange(event.target.value)}>
      {!agents.some((agent) => agent.name === value) && <option value={value} disabled>{value ? `${value}（未安装）` : "未检测到 Agent"}</option>}
      {agents.map((agent) => (
        <option key={agent.name} value={agent.name}>
          {agent.label}
        </option>
      ))}
    </Select>
  );
}

// ---------- 扫码登录弹窗（非单例渠道可顺带选择绑定的 agent） ----------

function LoginDialog({
  open,
  onClose,
  channelId,
  channelLabel,
  singleton,
  agents,
  onBound,
}: {
  open: boolean;
  onClose: () => void;
  channelId: string;
  channelLabel: string;
  singleton: boolean;
  agents: { name: string; label: string }[];
  onBound: () => void;
}) {
  const [agent, setAgent] = useState(agents[0]?.name ?? "");
  useEffect(() => {
    setAgent((current) => agents.some((item) => item.name === current) ? current : (agents[0]?.name ?? ""));
  }, [agents]);
  const [status, setStatus] = useState<LoginStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = () => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  };

  useEffect(() => {
    if (!open) return;
    setError(null);
    setStatus(null);
    let cancelled = false;
    api
      .startLogin(channelId, singleton ? undefined : agent)
      .then((initial) => {
        if (cancelled) {
          void api.cancelLogin(initial.loginId).catch(() => undefined);
          return;
        }
        setStatus(initial);
        pollRef.current = setInterval(() => {
          api
            .loginStatus(initial.loginId)
            .then((next) => {
              setStatus(next);
              if (next.status === "success") {
                stopPolling();
                onBound();
                setTimeout(onClose, 900);
              }
            })
            .catch(() => undefined);
        }, 1_500);
      })
      .catch((e) => setError(String(e.message)));
    return () => {
      cancelled = true;
      stopPolling();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, channelId]);

  const close = () => {
    if (status && status.status !== "success") {
      void api.cancelLogin(status.loginId).catch(() => undefined);
    }
    onClose();
  };

  const statusLine = () => {
    if (error) return <span className="text-destructive">{error}</span>;
    if (!status) return "正在获取二维码…";
    switch (status.status) {
      case "pending":
        return `打开${channelLabel}「扫一扫」，扫描下方二维码`;
      case "scanned":
        return "已扫码，请在手机上点击确认授权";
      case "refreshing":
        return "二维码已过期，正在更换新码…";
      case "success":
        return "绑定成功，正在启动 bot…";
      case "cancelled":
        return "已取消";
      case "error":
        return <span className="text-destructive">{status.error ?? "出错了"}</span>;
    }
  };

  return (
    <Dialog open={open} onClose={close} title={`添加${channelLabel}机器人`}>
      <div className="flex flex-col items-center gap-4">
        {!singleton && (
          <div className="flex w-full items-center justify-between gap-3 rounded-md border border-border bg-muted/50 px-3 py-2">
            <span className="text-sm text-muted-foreground">该 bot 绑定的 agent</span>
            <div className="w-36">
              <AgentSelect agents={agents} value={agent} onChange={setAgent} />
            </div>
          </div>
        )}
        <div className="rounded-lg border border-border bg-white p-3">
          {status?.hasQr ? (
            <img
              src={api.qrUrl(status.loginId, status.expiresAt ?? 0)}
              alt="登录二维码"
              className="h-56 w-56"
              onError={(event) => ((event.target as HTMLImageElement).style.visibility = "hidden")}
              onLoad={(event) => ((event.target as HTMLImageElement).style.visibility = "visible")}
            />
          ) : (
            <div className="flex h-56 w-56 items-center justify-center text-muted-foreground">
              <QrCode className="h-10 w-10 animate-pulse" />
            </div>
          )}
        </div>
        <p className="text-center text-sm text-muted-foreground">{statusLine()}</p>
        <p className="text-center text-xs text-muted-foreground/70">
          扫码即表示把本机 agent 执行能力开放给该账号对话。
        </p>
      </div>
    </Dialog>
  );
}

// ---------- 手动绑定弹窗（飞书兜底：粘贴 App ID/Secret） ----------

function ManualBindDialog({
  open,
  onClose,
  channelId,
  channelLabel,
  agents,
  onBound,
}: {
  open: boolean;
  onClose: () => void;
  channelId: string;
  channelLabel: string;
  agents: { name: string; label: string }[];
  onBound: () => void;
}) {
  const [appId, setAppId] = useState("");
  const [appSecret, setAppSecret] = useState("");
  const [agent, setAgent] = useState(agents[0]?.name ?? "");
  useEffect(() => {
    setAgent((current) => agents.some((item) => item.name === current) ? current : (agents[0]?.name ?? ""));
  }, [agents]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setAppId("");
      setAppSecret("");
      setError(null);
    }
  }, [open]);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.bindManual(channelId, appId.trim(), appSecret.trim(), agent);
      onBound();
      onClose();
    } catch (e) {
      setError(String((e as Error).message));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title={`手动绑定${channelLabel}应用`}>
      <div className="space-y-4">
        <p className="text-xs leading-relaxed text-muted-foreground">
          在开放平台创建<b>自建应用</b>：开启「机器人」能力，事件订阅选择「使用长连接接收」，开通消息相关权限
         （获取与发送单聊/群聊消息），然后粘贴凭据。
        </p>
        <div className="space-y-1.5">
          <Label>App ID（cli_ 开头）</Label>
          <Input value={appId} onChange={(e) => setAppId(e.target.value)} placeholder="cli_xxxxxxxxxxxx" spellCheck={false} />
        </div>
        <div className="space-y-1.5">
          <Label>App Secret</Label>
          <Input
            type="password"
            value={appSecret}
            onChange={(e) => setAppSecret(e.target.value)}
            placeholder="••••••••"
            spellCheck={false}
          />
        </div>
        <div className="flex items-center justify-between gap-3">
          <Label>绑定 agent</Label>
          <div className="w-36">
            <AgentSelect agents={agents} value={agent} onChange={setAgent} />
          </div>
        </div>
        {error && <p className="text-xs text-destructive">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onClose}>
            取消
          </Button>
          <Button size="sm" onClick={submit} disabled={busy || !appId.trim() || !appSecret.trim()}>
            {busy ? "验证中…" : "验证并绑定"}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

// ---------- 渠道页 ----------

export default function Channels() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [loginFor, setLoginFor] = useState<string | null>(null);
  const [manualFor, setManualFor] = useState<string | null>(null);
  const [unbindTarget, setUnbindTarget] = useState<BotStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    api.overview().then(setOverview).catch((e) => setError(String(e.message)));
  }, []);
  useEffect(() => {
    refresh();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") refresh();
    }, 30_000);
    window.addEventListener("focus", refresh);
    return () => { window.clearInterval(timer); window.removeEventListener("focus", refresh); };
  }, [refresh]);
  useServerEvent(
    useCallback(
      (event) => {
        if (event.type === "bot_status") refresh();
      },
      [refresh],
    ),
  );

  const doUnbind = async () => {
    if (!unbindTarget) return;
    setBusy(true);
    try {
      await api.unbindBot(unbindTarget.id);
      setUnbindTarget(null);
      refresh();
    } catch (e) {
      setError(String((e as Error).message));
    } finally {
      setBusy(false);
    }
  };

  const changeAgent = async (id: string, agent: string) => {
    try {
      await api.patchBot(id, agent);
      refresh();
    } catch (e) {
      setError(String((e as Error).message));
    }
  };

  const botRow = (bot: BotStatus) => {
    const status = STATUS_TEXT[bot.status];
    return (
      <div key={bot.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-border px-3 py-2.5">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium">{bot.label ?? bot.id}</span>
            <Badge variant={status.variant}>{status.label}</Badge>
          </div>
          <code className="block truncate text-xs text-muted-foreground" title={bot.credentials.botId ?? bot.id}>
            {bot.credentials.botId ?? bot.id}
          </code>
          {bot.lastError && <div className="mt-1 truncate text-xs text-destructive" title={bot.lastError}>{bot.lastError}</div>}
        </div>
        <AgentSelect agents={overview?.agents ?? []} value={bot.agent} onChange={(agent) => changeAgent(bot.id, agent)} />
        <Button variant="ghost" size="icon" title="解除绑定" onClick={() => setUnbindTarget(bot)}>
          <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
        </Button>
      </div>
    );
  };

  const channelCard = (channel: ChannelInfo) => {
    const bots = overview?.bots.filter((b) => b.provider === channel.id) ?? [];
    const bound = bots.length > 0;

    // 单例渠道：未绑定=扫码按钮；已绑定=状态摘要。
    if (channel.singleton) {
      const bot = bots[0];
      const status = bot ? STATUS_TEXT[bot.status] : null;
      return (
        <Card key={channel.id}>
          <CardHeader>
            <CardTitle>
              <MessageCircle className="h-4 w-4 text-primary" />
              {channel.label}
              {status && <Badge variant={status.variant}>{status.label}</Badge>}
            </CardTitle>
            <CardDescription>{channel.note}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {bot ? (
              <>
                <div className="space-y-1 text-sm">
                  <div className="flex justify-between gap-4">
                    <span className="text-muted-foreground">bot ID</span>
                    <code className="truncate text-xs">{bot.credentials.botId ?? "—"}</code>
                  </div>
                  <div className="flex items-center justify-between gap-4">
                    <span className="text-muted-foreground">绑定 agent</span>
                    <AgentSelect
                      agents={overview?.agents ?? []}
                      value={bot.agent}
                      onChange={(agent) => changeAgent(bot.id, agent)}
                    />
                  </div>
                  {bot.lastError && (
                    <div className="rounded-md bg-destructive/5 px-2.5 py-1.5 text-xs text-destructive">{bot.lastError}</div>
                  )}
                </div>
                <Button variant="outline" size="sm" onClick={() => setUnbindTarget(bot)}>
                  <Trash2 className="h-3.5 w-3.5" />
                  解除绑定
                </Button>
              </>
            ) : (
              <Button size="sm" disabled={!channel.available} onClick={() => setLoginFor(channel.id)}>
                <QrCode className="h-3.5 w-3.5" />
                扫码绑定
              </Button>
            )}
          </CardContent>
        </Card>
      );
    }

    // 多实例渠道（飞书）：bot 列表 + 添加入口。
    return (
      <Card key={channel.id} className={channel.available ? "" : "opacity-60"}>
        <CardHeader>
          <CardTitle>
            <MessageCircle className="h-4 w-4 text-primary" />
            {channel.label}
            {bound && <Badge variant="secondary">{bots.length} 个 bot</Badge>}
            {!channel.available && <Badge variant="secondary">即将支持</Badge>}
          </CardTitle>
          <CardDescription>{channel.note}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {bots.length > 0 && <div className="space-y-2">{bots.map(botRow)}</div>}
          {channel.available && (
            <div className="flex gap-2">
              <Button size="sm" onClick={() => setLoginFor(channel.id)}>
                <QrCode className="h-3.5 w-3.5" />
                扫码添加 bot
              </Button>
              <Button variant="outline" size="sm" onClick={() => setManualFor(channel.id)}>
                手动绑定
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    );
  };

  const loginChannel = overview?.channels.find((c) => c.id === loginFor);
  const manualChannel = overview?.channels.find((c) => c.id === manualFor);

  return (
    <div className="space-y-4">
      {error && (
        <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-2.5 text-sm text-destructive">
          <TriangleAlert className="h-4 w-4 shrink-0" />
          {error}
        </div>
      )}
      <div className="grid gap-4 md:grid-cols-2">
        {(overview?.channels ?? []).map(channelCard)}
      </div>

      {loginChannel && (
        <LoginDialog
          open
          onClose={() => setLoginFor(null)}
          channelId={loginChannel.id}
          channelLabel={loginChannel.label}
          singleton={loginChannel.singleton}
          agents={overview?.agents ?? []}
          onBound={refresh}
        />
      )}

      {manualChannel && (
        <ManualBindDialog
          open
          onClose={() => setManualFor(null)}
          channelId={manualChannel.id}
          channelLabel={manualChannel.label}
          agents={overview?.agents ?? []}
          onBound={refresh}
        />
      )}

      <Dialog open={Boolean(unbindTarget)} onClose={() => setUnbindTarget(null)} title="解除绑定">
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            将解绑 <b>{unbindTarget?.label ?? unbindTarget?.credentials.botId ?? unbindTarget?.id}</b> 并停止收发消息。
            所有者与会话记录会保留，重新绑定可再次使用。确定继续？
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => setUnbindTarget(null)}>
              取消
            </Button>
            <Button variant="destructive" size="sm" onClick={doUnbind} disabled={busy}>
              {busy ? "解绑中…" : "解除绑定"}
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
