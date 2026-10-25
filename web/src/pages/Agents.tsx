import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2, RefreshCw, Sparkles, XCircle } from "lucide-react";
import { api, type AgentInfo, type GatewayConfig } from "@/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";

export default function Agents() {
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [config, setConfig] = useState<GatewayConfig | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [scanning, setScanning] = useState(false);
  const [checkedAt, setCheckedAt] = useState<string | null>(null);
  const scanPending = useRef(false);

  const refresh = useCallback(async () => {
    if (scanPending.current) return;
    scanPending.current = true;
    setScanning(true);
    await Promise.all([api.agents(), api.getConfig()])
      .then(([{ agents }, { config }]) => {
        setAgents(agents);
        setConfig(config);
        setError(null);
        setCheckedAt(new Date().toLocaleTimeString());
      })
      .catch((e) => setError(String(e.message)))
      .finally(() => { scanPending.current = false; setScanning(false); });
  }, []);
  useEffect(() => {
    void refresh();
    const onFocus = () => { void refresh(); };
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, 30_000);
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [refresh]);

  const setDefault = async (name: string) => {
    try {
      await api.putConfig({ defaultAgent: name });
      refresh();
    } catch (e) {
      setError(String((e as Error).message));
    }
  };

  const installed = agents.filter((agent) => agent.installed);
  const missing = agents.filter((agent) => !agent.installed);

  const agentCard = (agent: AgentInfo) => (
    <Card key={agent.name}>
      <CardHeader>
        <CardTitle>
          <Sparkles className="h-4 w-4 text-primary" />
          {agent.label}
          {agent.installed ? (
            <Badge variant="success">
              <CheckCircle2 className="h-3 w-3" />
              已安装
            </Badge>
          ) : (
            <Badge variant="destructive">
              <XCircle className="h-3 w-3" />
              未安装
            </Badge>
          )}
          {config?.defaultAgent === agent.name && <Badge>默认</Badge>}
        </CardTitle>
        <CardDescription>
          命令 <code className="rounded bg-muted px-1 py-0.5 text-xs">{agent.name}</code>
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-1 text-sm">
        {agent.installed ? (
          <>
            <div className="text-muted-foreground">版本：{agent.version ?? "未能读取"}</div>
            <code className="block truncate text-xs text-muted-foreground" title={agent.path ?? ""}>
              {agent.path}
            </code>
            {agent.probeError && <p className="text-xs text-warning">{agent.probeError}</p>}
          </>
        ) : (
          <div className="text-muted-foreground">
            未检测到 <code className="text-xs">{agent.name}</code>。安装后会自动识别，也可点击「重新检测」。
          </div>
        )}
      </CardContent>
      {agent.installed && config?.defaultAgent !== agent.name && (
        <CardFooter>
          <Button variant="outline" size="sm" onClick={() => setDefault(agent.name)}>
            设为默认 agent
          </Button>
        </CardFooter>
      )}
    </Card>
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm">{checkedAt ? `已识别 ${installed.length} 个本机 Agent` : "正在检测本机 Agent…"}</p>
          <p className="mt-1 text-xs text-muted-foreground">自动扫描 PATH 和常见安装目录，每 30 秒更新{checkedAt ? ` · 最近检测 ${checkedAt}` : ""}</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={scanning}>
          <RefreshCw className={`h-3.5 w-3.5 ${scanning ? "animate-spin" : ""}`} />
          {scanning ? "检测中…" : "重新检测"}
        </Button>
      </div>
      {error && <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-2.5 text-sm text-destructive">{error}</div>}
      {checkedAt && installed.length === 0 && <p className="text-sm text-muted-foreground">尚未检测到支持的 Agent，请先安装下方任意 CLI。</p>}
      <div className="grid gap-4 md:grid-cols-2">{installed.map(agentCard)}</div>
      {missing.length > 0 && (
        <details className="space-y-3">
          <summary className="cursor-pointer text-sm text-muted-foreground">其他支持的 Agent（{missing.length} 个未安装）</summary>
          <div className="grid gap-4 md:grid-cols-2">{missing.map(agentCard)}</div>
        </details>
      )}
      <p className="text-xs text-muted-foreground">
        已安装表示找到可执行文件，使用前请先在对应 CLI 完成登录和模型配置。bot 绑定的默认 agent 决定新会话用哪个 CLI；会话内可用 <code className="rounded bg-muted px-1">/agent</code> 命令临时切换。
      </p>
    </div>
  );
}
