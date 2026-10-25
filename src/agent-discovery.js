// 检测与执行共用路径解析；无需依赖启动网关的终端是否加载 nvm/Homebrew。
import { accessSync, constants, readdirSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";

function subdirectories(root) {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => entry.name)
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
      .map((name) => join(root, name, "bin"));
  } catch {
    return [];
  }
}

export function searchPathDirs({ env = process.env, home = homedir(), execPath = process.execPath } = {}) {
  const dirs = [
    ...(env.PATH ?? "").split(delimiter),
    dirname(execPath),
    join(home, ".local/bin"), join(home, ".opencode/bin"),
    join(home, ".bun/bin"), join(home, ".npm-global/bin"), join(home, ".npm/bin"),
    join(home, "Library/pnpm"), join(home, ".local/share/pnpm"),
    join(home, ".volta/bin"), join(home, ".asdf/shims"), join(home, ".local/share/mise/shims"),
    env.PNPM_HOME, env.BUN_INSTALL && join(env.BUN_INSTALL, "bin"),
    env.VOLTA_HOME && join(env.VOLTA_HOME, "bin"),
    env.npm_config_prefix && join(env.npm_config_prefix, "bin"),
    "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin",
    ...subdirectories(join(env.NVM_DIR || join(home, ".nvm"), "versions/node")),
    ...subdirectories(join(home, ".local/share/fnm/node-versions")).map((dir) => join(dirname(dir), "installation/bin")),
    ...subdirectories(join(home, "Library/Application Support/fnm/node-versions")).map((dir) => join(dirname(dir), "installation/bin")),
    ...subdirectories(join(home, ".local/share/mise/installs/node")),
  ];
  // 不把空 PATH 项或相对路径视为安装目录，避免从项目目录误执行同名文件。
  return [...new Set(dirs.filter((dir) => dir && isAbsolute(dir)))];
}

function isExecutable(file) {
  try {
    accessSync(file, constants.X_OK);
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

export function findCommand(name, options = {}) {
  const env = options.env ?? process.env;
  const override = env[`WX_AGENT_${name.toUpperCase().replaceAll("-", "_")}_PATH`];
  if (override) return isAbsolute(override) && isExecutable(override) ? override : null;
  if (isAbsolute(name)) return isExecutable(name) ? name : null;
  for (const dir of searchPathDirs(options)) {
    const candidate = join(dir, name);
    if (isExecutable(candidate)) return resolve(candidate);
  }
  return null;
}

export function commandEnv(bin, { cwd, ...options } = {}) {
  return {
    ...(options.env ?? process.env),
    PATH: [...new Set([dirname(bin), ...searchPathDirs(options)])].join(delimiter),
    ...(cwd ? { PWD: cwd } : {}),
  };
}

// 只执行 --version，不发起模型请求；版本探测失败仍保留“已安装”的检测结果。
export function probeVersion(bin) {
  return new Promise((resolveVersion) => {
    let output = "";
    const child = spawn(bin, ["--version"], {
      env: commandEnv(bin), stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolveVersion({ version: null, probeError: "版本检测超时" });
    }, 4_000);
    const collect = (chunk) => { output = (output + chunk).slice(-8_000); };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolveVersion({ version: null, probeError: error.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const lines = output.replace(/\x1b\[[0-9;]*m/g, "").trim().split(/\r?\n/);
      const version = lines.find((line) => /\d+\.\d+/.test(line) && !/warning|error/i.test(line)) ?? null;
      resolveVersion({ version: code === 0 ? version : null, probeError: code === 0 && version ? null : "无法读取版本，请检查 CLI 是否能正常启动" });
    });
  });
}
