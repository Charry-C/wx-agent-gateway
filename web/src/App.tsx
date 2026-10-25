import { useCallback, useEffect, useState } from "react";
import { Bot, Menu, MessagesSquare, Monitor, Moon, Settings2, Sparkles, Sun, X } from "lucide-react";
import { api, type Overview } from "@/api";
import { useServerEvent, useWsConnected } from "@/ws";
import { cn } from "@/lib/utils";
import { applyTheme, getStoredTheme, setTheme, watchSystemTheme, type Theme } from "@/lib/theme";
import Channels from "@/pages/Channels";
import Sessions from "@/pages/Sessions";
import Agents from "@/pages/Agents";
import Settings from "@/pages/Settings";

type PageId = "channels" | "sessions" | "agents" | "settings";

const NAV: { id: PageId; label: string; icon: typeof Bot }[] = [
  { id: "channels", label: "渠道", icon: Bot },
  { id: "sessions", label: "会话", icon: MessagesSquare },
  { id: "agents", label: "Agent", icon: Sparkles },
  { id: "settings", label: "设置", icon: Settings2 },
];

const THEME_OPTIONS: { value: Theme; label: string; icon: typeof Sun }[] = [
  { value: "system", label: "跟随系统", icon: Monitor },
  { value: "light", label: "浅色", icon: Sun },
  { value: "dark", label: "暗色", icon: Moon },
];

// 侧边栏内容：桌面常驻栏与移动端抽屉共用。
function SidebarBody({
  page,
  onNavigate,
  version,
  onlineBots,
  totalBots,
  wsConnected,
  theme,
  onChooseTheme,
}: {
  page: PageId;
  onNavigate: (page: PageId) => void;
  version: string;
  onlineBots: number;
  totalBots: number;
  wsConnected: boolean;
  theme: Theme;
  onChooseTheme: (theme: Theme) => void;
}) {
  return (
    <>
      <div className="flex items-center gap-2.5 px-4 py-4">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-foreground text-background">
          <Bot className="h-4 w-4" />
        </div>
        <div className="leading-tight">
          <div className="text-[13px] font-semibold tracking-tight">Agent Gateway</div>
          <div className="text-[11px] text-muted-foreground">本地 agent · IM 接入</div>
        </div>
      </div>
      <nav className="flex-1 space-y-0.5 px-2">
        {NAV.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => onNavigate(id)}
            className={cn(
              "flex h-9 w-full items-center gap-2 rounded-md px-2.5 text-[13px] transition-colors cursor-pointer md:h-8",
              page === id
                ? "bg-accent font-medium text-foreground"
                : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
            )}
          >
            <Icon className="h-4 w-4 shrink-0" />
            {label}
          </button>
        ))}
      </nav>
      <div className="border-t border-border px-4 py-3 text-[11px] leading-relaxed text-muted-foreground">
        <div className="mb-2 flex items-center justify-between">
          <span>外观</span>
          <div className="flex items-center gap-0.5 rounded-md border border-border bg-card p-0.5">
            {THEME_OPTIONS.map(({ value, label, icon: Icon }) => (
              <button
                key={value}
                title={label}
                aria-label={label}
                aria-pressed={theme === value}
                onClick={() => onChooseTheme(value)}
                className={cn(
                  "flex h-6 w-6 items-center justify-center rounded-[5px] transition-colors cursor-pointer",
                  theme === value
                    ? "bg-accent text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                <Icon className="h-3.5 w-3.5" />
              </button>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <span
            className={cn(
              "inline-block h-1.5 w-1.5 rounded-full",
              wsConnected ? "bg-success" : "bg-muted-foreground/40",
            )}
          />
          {wsConnected ? "实时连接" : "连接中…"}
        </div>
        <div className="mt-1 tabular-nums">v{version} · 在线 bot {onlineBots}/{totalBots}</div>
      </div>
    </>
  );
}

export default function App() {
  const [page, setPage] = useState<PageId>("channels");
  const [navOpen, setNavOpen] = useState(false);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [theme, setThemeState] = useState<Theme>(getStoredTheme);
  const wsConnected = useWsConnected();

  useEffect(() => {
    applyTheme(getStoredTheme());
    // system 档下系统主题变化时重新同步 html 上的类。
    return watchSystemTheme(() => applyTheme(getStoredTheme()));
  }, []);

  const chooseTheme = (next: Theme) => {
    setTheme(next);
    setThemeState(next);
  };

  useEffect(() => {
    if (!navOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setNavOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navOpen]);

  const refresh = useCallback(() => {
    api.overview().then(setOverview).catch(() => undefined);
  }, []);

  useEffect(refresh, [refresh]);
  useServerEvent(
    useCallback(
      (event) => {
        if (event.type === "bot_status" || event.type === "login") refresh();
      },
      [refresh],
    ),
  );

  const onlineBots = overview?.bots.filter((bot) => bot.status === "connected").length ?? 0;
  const totalBots = overview?.bots.length ?? 0;
  const version = overview?.version ?? "…";

  return (
    <div className="flex h-dvh overflow-hidden">
      {/* 桌面常驻侧栏 */}
      <aside className="hidden w-52 shrink-0 flex-col border-r border-border bg-background md:flex">
        <SidebarBody
          page={page}
          onNavigate={setPage}
          version={version}
          onlineBots={onlineBots}
          totalBots={totalBots}
          wsConnected={wsConnected}
          theme={theme}
          onChooseTheme={chooseTheme}
        />
      </aside>

      {/* 移动端抽屉导航 */}
      {navOpen && (
        <div className="fixed inset-0 z-50 md:hidden">
          <div
            className="absolute inset-0 bg-black/40 animate-[overlay-in_0.15s_ease-out]"
            onClick={() => setNavOpen(false)}
          />
          <aside className="relative flex h-full w-64 max-w-[85vw] flex-col border-r border-border bg-card shadow-2xl animate-[drawer-in_0.2s_cubic-bezier(0.16,1,0.3,1)]">
            <button
              onClick={() => setNavOpen(false)}
              aria-label="关闭导航"
              className="absolute right-3 top-4 z-10 flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground cursor-pointer"
            >
              <X className="h-4 w-4" />
            </button>
            <SidebarBody
              page={page}
              onNavigate={(next) => {
                setPage(next);
                setNavOpen(false);
              }}
              version={version}
              onlineBots={onlineBots}
              totalBots={totalBots}
              wsConnected={wsConnected}
              theme={theme}
              onChooseTheme={chooseTheme}
            />
          </aside>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border bg-background px-4 md:h-14 md:gap-3 md:px-6">
          <button
            onClick={() => setNavOpen(true)}
            aria-label="打开导航"
            className="-ml-1.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground cursor-pointer md:hidden"
          >
            <Menu className="h-4.5 w-4.5" />
          </button>
          <h1 className="truncate text-sm font-semibold tracking-tight">
            {NAV.find((item) => item.id === page)?.label}
          </h1>
          <div className="ml-auto hidden shrink-0 text-xs text-muted-foreground sm:block">
            {overview?.owner.userId ? (
              <>所有者：{overview.owner.displayName ?? overview.owner.userId}</>
            ) : (
              "所有者未绑定（首个发消息的人自动绑定）"
            )}
          </div>
        </header>
        <main className="min-h-0 flex-1 overflow-y-auto p-4 md:p-6">
          {page === "channels" && <Channels />}
          {page === "sessions" && <Sessions />}
          {page === "agents" && <Agents />}
          {page === "settings" && <Settings />}
        </main>
      </div>
    </div>
  );
}
