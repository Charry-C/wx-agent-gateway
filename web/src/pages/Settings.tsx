import { useEffect, useState } from "react";
import { api, type GatewayConfig } from "@/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Label, Select } from "@/components/ui/input";

const SANDBOX_MODES = ["read-only", "workspace-write", "full"] as const;

export default function Settings() {
  const [form, setForm] = useState<(GatewayConfig & { timeoutMinutes: string; allowedUsersText: string }) | null>(null);
  const [agentNames, setAgentNames] = useState<string[]>([]);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    Promise.all([api.getConfig(), api.agents()])
      .then(([{ config }, { agents }]) => {
        setForm({
          ...config,
          timeoutMinutes: String(Math.round(config.agentTimeoutMs / 60_000)),
          allowedUsersText: config.allowedUsers.join("\n"),
        });
        setAgentNames(agents.filter((a) => a.installed).map((a) => a.name));
      })
      .catch((e) => setMessage({ kind: "error", text: String(e.message) }));
  }, []);

  if (!form) return <p className="text-sm text-muted-foreground">加载配置…</p>;

  const update = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) =>
    setForm((previous) => (previous ? { ...previous, [key]: value } : previous));

  const save = async () => {
    if (!form) return;
    setSaving(true);
    setMessage(null);
    try {
      const allowedUsers = form.allowedUsersText.split("\n").map((line) => line.trim()).filter(Boolean);
      const { config } = await api.putConfig({
        defaultAgent: form.defaultAgent,
        defaultCwd: form.defaultCwd,
        agentTimeoutMs: Number(form.timeoutMinutes) * 60_000,
        codexSandbox: form.codexSandbox,
        allowedUsers,
        replyChunkLength: Number(form.replyChunkLength),
        webPort: Number(form.webPort),
      });
      setForm((previous) =>
        previous
          ? { ...previous, ...config, timeoutMinutes: String(Math.round(config.agentTimeoutMs / 60_000)), allowedUsersText: config.allowedUsers.join("\n") }
          : previous,
      );
      setMessage({ kind: "ok", text: "已保存（端口修改需重启生效）" });
    } catch (e) {
      setMessage({ kind: "error", text: String((e as Error).message) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="max-w-2xl space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>网关配置</CardTitle>
          <CardDescription>对应 data/config.json，保存后立即对新消息生效。</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-5 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label>默认 agent</Label>
            <Select value={form.defaultAgent} onChange={(e) => update("defaultAgent", e.target.value)}>
              {!agentNames.includes(form.defaultAgent) && <option value={form.defaultAgent} disabled>{form.defaultAgent}（未安装）</option>}
              {agentNames.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>codex 沙箱</Label>
            <Select value={form.codexSandbox} onChange={(e) => update("codexSandbox", e.target.value as GatewayConfig["codexSandbox"])}>
              {SANDBOX_MODES.map((mode) => (
                <option key={mode} value={mode}>
                  {mode}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label>默认工作目录（绝对路径）</Label>
            <Input value={form.defaultCwd} onChange={(e) => update("defaultCwd", e.target.value)} placeholder="/absolute/path/to/project" />
          </div>
          <div className="space-y-1.5">
            <Label>任务超时（分钟）</Label>
            <Input
              type="number"
              min={1}
              max={1440}
              value={form.timeoutMinutes}
              onChange={(e) => update("timeoutMinutes", e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label>回复分片长度（字符）</Label>
            <Input
              type="number"
              min={200}
              max={8000}
              value={form.replyChunkLength}
              onChange={(e) => update("replyChunkLength", Number(e.target.value))}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Web 端口（重启后生效）</Label>
            <Input type="number" value={form.webPort} onChange={(e) => update("webPort", Number(e.target.value))} />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label>发送者白名单（每行一个 ID，留空 = 首个发消息者自动绑定为所有者）</Label>
            <textarea
              value={form.allowedUsersText}
              onChange={(e) => update("allowedUsersText", e.target.value)}
              rows={3}
              spellCheck={false}
              className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs shadow-xs transition-[border-color,box-shadow] placeholder:text-muted-foreground/70 hover:border-muted-foreground/35 focus-visible:border-ring focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/20"
            />
          </div>
        </CardContent>
        <div className="flex flex-wrap items-center justify-end gap-3 border-t border-border px-5 py-3.5">
          {message && (
            <span className={`text-xs ${message.kind === "ok" ? "text-success" : "text-destructive"}`}>{message.text}</span>
          )}
          <Button size="sm" onClick={save} disabled={saving}>
            {saving ? "保存中…" : "保存"}
          </Button>
        </div>
      </Card>
    </div>
  );
}
