import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Loader2, Square, Terminal } from "lucide-react";
import { api, type SessionInfo } from "@/api";
import { useServerEvent } from "@/ws";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const MAX_LOG_LINES = 200;

export default function Sessions() {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [logs, setLogs] = useState<string[]>([]);
  const [logsOpen, setLogsOpen] = useState(true);
  const logBoxRef = useRef<HTMLDivElement>(null);
  const [stopping, setStopping] = useState<string | null>(null);

  const refresh = useCallback(() => {
    api.sessions().then((data) => setSessions(data.sessions)).catch(() => undefined);
  }, []);
  useEffect(refresh, [refresh]);

  useEffect(() => {
    api.logs(MAX_LOG_LINES).then((data) => setLogs(data.lines)).catch(() => undefined);
  }, []);

  useServerEvent(
    useCallback(
      (event) => {
        if (event.type === "session_update" || event.type === "message") refresh();
        if (event.type === "log") {
          const line = event.payload as { message: string };
          setLogs((previous) => [...previous.slice(-MAX_LOG_LINES + 1), line.message]);
        }
      },
      [refresh],
    ),
  );

  useEffect(() => {
    if (logsOpen) logBoxRef.current?.scrollTo({ top: logBoxRef.current.scrollHeight });
  }, [logs, logsOpen]);

  const stop = async (key: string) => {
    setStopping(key);
    try {
      await api.stopSession(key);
    } finally {
      setStopping(null);
      refresh();
    }
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>会话列表</CardTitle>
        </CardHeader>
        <CardContent>
          {sessions.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              还没有会话。在 IM 里给机器人发一条消息，会话就会出现在这里。
            </p>
          ) : (
            <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="border-b border-border text-left text-[11px] uppercase tracking-wider text-muted-foreground">
                  <th className="pb-2 pr-3 font-medium">会话</th>
                  <th className="pb-2 pr-3 font-medium">Agent</th>
                  <th className="pb-2 pr-3 font-medium">工作目录</th>
                  <th className="pb-2 pr-3 font-medium">上下文</th>
                  <th className="pb-2 pr-3 font-medium">状态</th>
                  <th className="pb-2 font-medium"></th>
                </tr>
              </thead>
              <tbody>
                {sessions.map((session) => (
                  <tr key={session.key} className="border-b border-border/60 last:border-0">
                    <td className="py-2.5 pr-3">
                      <div className="flex items-center gap-2">
                        <Badge variant="outline">{session.botId}</Badge>
                        <code className="max-w-52 truncate text-xs text-muted-foreground" title={session.userId}>
                          {session.userId}
                        </code>
                      </div>
                    </td>
                    <td className="py-2.5 pr-3">{session.agent ?? "默认"}</td>
                    <td className="py-2.5 pr-3">
                      <code className="max-w-52 truncate text-xs" title={session.cwd ?? ""}>
                        {session.cwd ?? "默认目录"}
                      </code>
                    </td>
                    <td className="whitespace-nowrap py-2.5 pr-3 text-xs text-muted-foreground">
                      {Object.keys(session.sessions).length
                        ? Object.entries(session.sessions)
                            .map(([agent, id]) => `${agent}=${id.slice(0, 8)}`)
                            .join(" ")
                        : "无"}
                    </td>
                    <td className="py-2.5 pr-3">
                      {session.busy ? (
                        <span className="inline-flex items-center gap-1.5 text-xs text-warning">
                          <Loader2 className="h-3 w-3 animate-spin" />
                          执行中{session.currentText ? `：${session.currentText.slice(0, 24)}` : ""}
                        </span>
                      ) : session.queued > 0 ? (
                        <span className="text-xs text-muted-foreground">排队 {session.queued}</span>
                      ) : (
                        <span className="text-xs text-muted-foreground/70">空闲</span>
                      )}
                    </td>
                    <td className="py-2.5 text-right">
                      {(session.busy || session.queued > 0) && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => stop(session.key)}
                          disabled={stopping === session.key}
                        >
                          <Square className="h-3 w-3" />
                          {stopping === session.key ? "停止中…" : "停止"}
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <button
            className="flex cursor-pointer items-center gap-1.5 text-sm font-semibold"
            onClick={() => setLogsOpen((open) => !open)}
          >
            {logsOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            <Terminal className="h-4 w-4 text-muted-foreground" />
            运行日志
          </button>
        </CardHeader>
        {logsOpen && (
          <CardContent>
            <div
              ref={logBoxRef}
              className="h-64 overflow-y-auto rounded-lg bg-foreground/[0.035] p-3 font-mono text-[11px] leading-relaxed text-foreground/80"
            >
              {logs.length === 0 ? "暂无日志" : logs.map((line, index) => <div key={index}>{line}</div>)}
            </div>
          </CardContent>
        )}
      </Card>
    </div>
  );
}
