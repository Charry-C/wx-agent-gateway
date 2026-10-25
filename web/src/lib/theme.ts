// 主题三档切换：system（跟随系统）/ light / dark，选择持久化到 localStorage。
// 通过在 <html> 上维护 .dark / .light 类驱动 index.css 中的令牌分支，
// system 模式下监听系统主题变化并同步类。

export type Theme = "system" | "light" | "dark";

const STORAGE_KEY = "theme";

export function getStoredTheme(): Theme {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    if (value === "light" || value === "dark" || value === "system") return value;
  } catch {
    // localStorage 不可用时按跟随系统处理
  }
  return "system";
}

export function applyTheme(theme: Theme) {
  const systemDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const root = document.documentElement;
  root.classList.toggle("dark", theme === "dark" || (theme === "system" && systemDark));
  root.classList.toggle("light", theme === "light");
}

export function setTheme(theme: Theme) {
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // 忽略持久化失败，仅本次会话生效
  }
  applyTheme(theme);
}

export function watchSystemTheme(onChange: () => void) {
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}
