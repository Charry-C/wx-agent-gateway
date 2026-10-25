// 本地 agent 适配器：把「一条用户消息 → agent 执行 → 一条回复 + 会话 ID」抽象成统一接口。
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commandEnv, findCommand, probeVersion } from "./agent-discovery.js";

const DEFAULT_TIMEOUT_MS = 15 * 60_000;

export function runCommand(cmd, args, { cwd, timeoutMs = DEFAULT_TIMEOUT_MS, signal, onStdoutLine } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("任务已被终止"));
    const bin = findCommand(cmd);
    if (!bin) return reject(new Error(`未找到 ${cmd} CLI，请安装后重新检测（或设置 WX_AGENT_${cmd.toUpperCase()}_PATH）`));
    const child = spawn(bin, args, {
      cwd,
      env: commandEnv(bin, { cwd }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let pendingKill = null;
    let timeout = null;
    let timedOut = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(pendingKill);
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      resolve({ ...result, child });
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(pendingKill);
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      reject(error);
    };
    const kill = (sig) => {
      try {
        child.kill(sig);
      } catch {
        /* already dead */
      }
    };
    const onAbort = () => {
      clearTimeout(timeout);
      kill("SIGTERM");
      clearTimeout(pendingKill);
      pendingKill = setTimeout(() => kill("SIGKILL"), 5_000);
    };

    if (signal?.aborted) {
      kill("SIGKILL");
      fail(new Error("aborted before start"));
      return;
    }
    signal?.addEventListener("abort", onAbort);
    timeout = setTimeout(() => {
      timedOut = true;
      kill("SIGTERM");
      pendingKill = setTimeout(() => kill("SIGKILL"), 5_000);
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (onStdoutLine) {
        let index;
        while ((index = stdout.indexOf("\n")) >= 0) {
          const line = stdout.slice(0, index);
          stdout = stdout.slice(index + 1);
          if (line.trim()) onStdoutLine(line);
        }
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", fail);
    child.on("close", (code, signalName) => {
      if (onStdoutLine && stdout.trim()) onStdoutLine(stdout);
      if (signal?.aborted) {
        fail(new Error("任务已被终止"));
      } else if (timedOut) {
        fail(new Error(`${cmd} 执行超时（${Math.round(timeoutMs / 1000)} 秒）`));
      } else if (code === 0) {
        finish({ stdout, stderr });
      } else if (signalName) {
        fail(new Error(`${cmd} 被信号 ${signalName} 终止`));
      } else {
        fail(new Error(`${cmd} exited with code ${code}: ${stderr.slice(-500) || stdout.slice(-500)}`));
      }
    });
  });
}

function parseJsonLoose(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

// ---------- grok build ----------
// grok -p "<text>" [--resume <id>] --output-format json --always-approve --cwd <dir>
// stdout 为单个 JSON：{ text, sessionId, ... }

const grokAdapter = {
  name: "grok",
  label: "Grok Build",
  async run({ text, sessionId, cwd, timeoutMs, signal }) {
    const args = [
      "-p", text,
      "--output-format", "json",
      "--always-approve",
      "--cwd", cwd,
    ];
    if (sessionId) args.push("-r", sessionId);
    const { stdout } = await runCommand("grok", args, { cwd, timeoutMs, signal });
    const parsed = parseJsonLoose(stdout);
    const reply = typeof parsed?.text === "string" ? parsed.text : stdout.trim();
    const newSessionId = typeof parsed?.sessionId === "string" ? parsed.sessionId : null;
    return { reply, sessionId: newSessionId ?? sessionId ?? null };
  },
};

// ---------- codex ----------
// codex exec [--json --skip-git-repo-check --output-last-message <file>] "<text>"
// codex exec resume <sessionId> ... "<text>"
// stdout 为 JSONL 事件流：thread.started 携带 thread_id；最终文本落盘到 --output-last-message。

const codexAdapter = {
  name: "codex",
  label: "Codex CLI",
  async run({ text, sessionId, cwd, timeoutMs, signal, config, images = [] }) {
    const sandboxMode = config?.codexSandbox ?? "workspace-write";
    // exec 支持 -s <mode>；resume 不继承 -s，改用 -c sandbox_mode=... 配置覆盖。
    const sandboxArgs = sessionId
      ? sandboxMode === "full"
        ? ["--dangerously-bypass-approvals-and-sandbox"]
        : ["-c", `sandbox_mode="${sandboxMode}"`]
      : sandboxMode === "full"
        ? ["--dangerously-bypass-approvals-and-sandbox"]
        : ["-s", sandboxMode];

    const tmpDir = await mkdtemp(join(tmpdir(), "wxgw-codex-"));
    const lastMessageFile = join(tmpDir, "last-message.txt");
    let threadId = sessionId ?? null;
    let fallbackText = "";

    const base = sessionId ? ["exec", "resume", sessionId] : ["exec"];
    const args = [
      ...base,
      "--json",
      "--skip-git-repo-check",
      "--output-last-message", lastMessageFile,
      ...sandboxArgs,
      ...images.flatMap((image) => ["-i", image]),
      text,
    ];
    try {
      await runCommand("codex", args, {
        cwd,
        timeoutMs,
        signal,
        onStdoutLine: (line) => {
          const event = parseJsonLoose(line);
          if (!event || typeof event !== "object") return;
          if (!threadId && typeof event.thread_id === "string") threadId = event.thread_id;
          if (!threadId && typeof event.session_id === "string") threadId = event.session_id;
          const item = event.item;
          if (event.type === "item.completed" && item?.type === "agent_message" && typeof item.text === "string") {
            fallbackText = item.text;
          }
        },
      });
      let finalText = "";
      try {
        finalText = (await readFile(lastMessageFile, "utf8")).trim();
      } catch {
        /* file may be absent when nothing was produced */
      }
      const reply = finalText || fallbackText || "(codex finished without a final message)";
      return { reply, sessionId: threadId ?? sessionId ?? null };
    } finally {
      await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
    }
  },
};

// ---------- agy ----------
// agy -p "<text>" --output-format json --dangerously-skip-permissions [--conversation <id>]
// stdout 为单个 JSON：{ conversation_id, status: "SUCCESS", response, ... }；conversation_id 即续接 ID。
// 注意：--dangerously-skip-permissions 等同 grok 的 --always-approve，无沙箱、能力等同本人。

const agyAdapter = {
  name: "agy",
  label: "AgY",
  async run({ text, sessionId, cwd, timeoutMs, signal }) {
    const args = ["-p", text, "--output-format", "json", "--dangerously-skip-permissions"];
    if (sessionId) args.push("--conversation", sessionId);
    const { stdout } = await runCommand("agy", args, { cwd, timeoutMs, signal });
    const parsed = parseJsonLoose(stdout);
    if (parsed && typeof parsed === "object" && parsed.status && parsed.status !== "SUCCESS") {
      throw new Error(`agy ${parsed.status}: ${String(parsed.response ?? "").slice(0, 500)}`);
    }
    const reply = typeof parsed?.response === "string" ? parsed.response : stdout.trim();
    const newSessionId = typeof parsed?.conversation_id === "string" ? parsed.conversation_id : null;
    return { reply, sessionId: newSessionId ?? sessionId ?? null };
  },
};

const claudeAdapter = {
  name: "claude",
  label: "Claude Code",
  async run({ text, sessionId, cwd, timeoutMs, signal }) {
    // 非交互调用保留 Claude 自身的权限策略；需要交互审批的工具会被拒绝。
    const args = ["-p", "--output-format", "json"];
    if (sessionId) args.push("--resume", sessionId);
    args.push("--", text);
    const { stdout } = await runCommand("claude", args, { cwd, timeoutMs, signal });
    const result = parseJsonLoose(stdout);
    if (result?.is_error) throw new Error(result.result || result.errors?.join("; ") || "Claude Code 执行失败");
    if (typeof result?.result !== "string") throw new Error("Claude Code 未返回有效回复");
    return { reply: result.result, sessionId: result.session_id ?? sessionId ?? null };
  },
};

const opencodeAdapter = {
  name: "opencode",
  label: "OpenCode",
  async run({ text, sessionId, cwd, timeoutMs, signal }) {
    const args = ["run", "--format", "json"];
    if (sessionId) args.push("--session", sessionId);
    args.push("--", text);
    const replies = [];
    let newSessionId = sessionId ?? null;
    let error = null;
    let finished = false;
    await runCommand("opencode", args, {
      cwd, timeoutMs, signal,
      onStdoutLine(line) {
        const event = parseJsonLoose(line);
        if (!event) return;
        if (typeof event.sessionID === "string") newSessionId = event.sessionID;
        if (event.type === "text" && typeof event.part?.text === "string") replies.push(event.part.text);
        if (event.type === "step_start") finished = false;
        if (event.type === "step_finish") finished = event.part?.reason === "stop";
        if (event.type === "error") error = event.error?.data?.message ?? event.error?.message ?? "OpenCode 执行失败";
      },
    });
    if (error) throw new Error(error);
    if (!finished || !replies.length) throw new Error("OpenCode 未返回完整回复，请检查模型配置或登录状态");
    return { reply: replies.join("\n\n"), sessionId: newSessionId };
  },
};

const piAdapter = {
  name: "pi",
  label: "Pi Coding Agent",
  async run({ text, sessionId, cwd, timeoutMs, signal }) {
    const args = ["--print", "--mode", "json"];
    if (sessionId) args.push("--session", sessionId);
    args.push("--", text);
    let newSessionId = sessionId ?? null;
    let lastMessage = null;
    let finished = false;
    await runCommand("pi", args, {
      cwd, timeoutMs, signal,
      onStdoutLine(line) {
        const event = parseJsonLoose(line);
        if (!event) return;
        if (event.type === "session" && typeof event.id === "string") newSessionId = event.id;
        if (["message_end", "turn_end"].includes(event.type) && event.message?.role === "assistant") lastMessage = event.message;
        if (event.type === "agent_end") {
          finished = true;
          lastMessage = event.messages?.filter((message) => message.role === "assistant").at(-1) ?? lastMessage;
        }
      },
    });
    if (["error", "aborted", "length"].includes(lastMessage?.stopReason)) throw new Error(lastMessage.errorMessage || `Pi: ${lastMessage.stopReason}`);
    const reply = lastMessage?.content?.filter((part) => part.type === "text").map((part) => part.text).join("\n");
    if (!finished || !reply) throw new Error("Pi 未返回完整回复，请检查模型配置或登录状态");
    return { reply, sessionId: newSessionId };
  },
};

export const adapters = {
  grok: grokAdapter,
  codex: codexAdapter,
  agy: agyAdapter,
  claude: claudeAdapter,
  opencode: opencodeAdapter,
  pi: piAdapter,
};

export function getAdapter(name) {
  return Object.hasOwn(adapters, name) ? adapters[name] : null;
}

export function listAdapters() {
  return Object.values(adapters).map(({ name, label }) => ({ name, label }));
}

export function discoverAgents() {
  return listAdapters().map((adapter) => {
    const path = findCommand(adapter.name);
    return { ...adapter, installed: Boolean(path), path };
  });
}

export async function detectAgents() {
  return Promise.all(discoverAgents().map(async (agent) => ({
    ...agent,
    ...(agent.path ? await probeVersion(agent.path) : { version: null, probeError: null }),
  })));
}
