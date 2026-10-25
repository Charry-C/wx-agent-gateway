#!/usr/bin/env node
// 开发模式：后端 node --watch + 前端 Vite dev server 并行，Ctrl+C 一起退出。
// Vite 已把 /api、/ws 代理到本地后端（见 vite.config.ts）。
import { spawn } from "node:child_process";

const children = [];

function run(name, command, args, color) {
  const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  const prefix = `${color}[${name}]\x1b[0m`;
  const pipe = (stream) =>
    stream.on("data", (chunk) => {
      for (const line of String(chunk).split("\n").filter(Boolean)) {
        console.log(`${prefix} ${line}`);
      }
    });
  pipe(child.stdout);
  pipe(child.stderr);
  child.on("exit", (code) => {
    if (code !== null && code !== 0) console.log(`${prefix} exited with code ${code}`);
  });
  return child;
}

run("api", "node", ["--watch", "src/server/main.js"], "\x1b[36m");
run("web", "npx", ["vite"], "\x1b[35m");

function shutdown() {
  for (const child of children) child.kill("SIGTERM");
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
