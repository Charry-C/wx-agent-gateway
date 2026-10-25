import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { commandEnv, findCommand, probeVersion, searchPathDirs } from "../src/agent-discovery.js";
import { detectAgents, discoverAgents, getAdapter, listAdapters, runCommand } from "../src/agents.js";
import { loadConfig } from "../src/store.js";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "wxgw agents "));
  t.after(() => rm(root, { recursive: true, force: true }));
  const oldEnv = { ...process.env };
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in oldEnv)) delete process.env[key];
    Object.assign(process.env, oldEnv);
  });
  return root;
}

async function executable(file, source) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `#!${process.execPath}\n${source}\n`);
  await chmod(file, 0o755);
  return file;
}

test("finds common installation directories with a minimal PATH and honors PATH order", async (t) => {
  const home = await fixture(t);
  const options = { home, env: { PATH: "/usr/bin:/bin" }, execPath: "/nonexistent/node" };
  for (const dir of [".local/bin", ".opencode/bin", ".nvm/versions/node/v22.0.0/bin", ".bun/bin", ".local/share/fnm/node-versions/v24/installation/bin"]) {
    const file = await executable(join(home, dir, "wxgw-probe"), "");
    assert.equal(findCommand("wxgw-probe", options), file, dir);
    await rm(file);
  }
  const preferred = await executable(join(home, "preferred/wxgw-probe"), "");
  await executable(join(home, ".local/bin/wxgw-probe"), "");
  assert.equal(findCommand("wxgw-probe", { ...options, env: { PATH: dirname(preferred) } }), preferred);
  assert(!searchPathDirs({ ...options, env: { PATH: ":relative/bin" } }).includes("relative/bin"));
});

test("ignores directories, non-executable files, and dangling symlinks; discovers installs/removals immediately", async (t) => {
  const home = await fixture(t);
  const dir = join(home, "bin");
  await mkdir(dir);
  const options = { home, env: { PATH: dir }, execPath: "/nonexistent/node" };
  const file = join(dir, "wxgw-probe");
  await mkdir(file);
  assert.equal(findCommand("wxgw-probe", options), null);
  await rm(file, { recursive: true });
  await writeFile(file, "text", { mode: 0o644 });
  assert.equal(findCommand("wxgw-probe", options), null);
  await rm(file);
  await symlink(join(home, "missing"), file);
  assert.equal(findCommand("wxgw-probe", options), null);
  await rm(file);
  await executable(file, "");
  assert.equal(findCommand("wxgw-probe", options), file);
  await rm(file);
  assert.equal(findCommand("wxgw-probe", options), null);
});

test("detected custom executable is the executable actually run, including paths with spaces", async (t) => {
  const root = await fixture(t);
  const bin = await executable(join(root, "claude"), `
if (process.argv.includes('--version')) console.log('2.1.148 (Claude Code)');
else console.log(JSON.stringify({result: process.argv.at(-1), session_id: 'session-c'}));`);
  process.env.WX_AGENT_CLAUDE_PATH = bin;
  assert.equal(discoverAgents().find((agent) => agent.name === "claude").path, bin);
  assert.equal(commandEnv(bin).PATH.split(":")[0], root);
  assert.deepEqual(await probeVersion(bin), { version: "2.1.148 (Claude Code)", probeError: null });
  assert.equal((await getAdapter("claude").run({ text: "hello", cwd: root })).reply, "hello");
  await rm(bin);
  assert.equal(discoverAgents().find((agent) => agent.name === "claude").installed, false);
  await assert.rejects(runCommand("claude", []), /未找到 claude/);
});

test("version probe failure does not classify an executable as uninstalled", async (t) => {
  const root = await fixture(t);
  for (const { name } of listAdapters()) process.env[`WX_AGENT_${name.toUpperCase()}_PATH`] = join(root, "missing");
  process.env.WX_AGENT_PI_PATH = await executable(join(root, "pi"), "process.exit(1)");
  const agents = await detectAgents();
  const pi = agents.find((agent) => agent.name === "pi");
  assert.equal(pi.installed, true);
  assert.equal(pi.version, null);
  assert.match(pi.probeError, /无法读取版本/);
  assert.equal(agents.filter((agent) => agent.installed).length, 1);
});

test("fresh config picks an installed agent and preserves an existing explicit default", async (t) => {
  const root = await fixture(t);
  for (const { name } of listAdapters()) process.env[`WX_AGENT_${name.toUpperCase()}_PATH`] = join(root, "missing");
  process.env.WX_AGENT_PI_PATH = await executable(join(root, "pi"), "");
  const configFile = join(root, "config.json");
  const freshConfig = await loadConfig(configFile);
  assert.equal(freshConfig.defaultAgent, "pi");
  assert.equal(freshConfig.defaultCwd, process.cwd());
  await writeFile(configFile, JSON.stringify({ defaultCwd: root, allowedUsers: [] }));
  const templateConfig = await loadConfig(configFile);
  assert.equal(templateConfig.defaultAgent, "pi");
  assert.equal(templateConfig.defaultCwd, root);
  await writeFile(configFile, JSON.stringify({ defaultAgent: "claude" }));
  assert.equal((await loadConfig(configFile)).defaultAgent, "claude");
});

test("Claude Code sends prompts literally, resumes the specified session and reports API errors", async (t) => {
  const root = await fixture(t);
  process.env.WX_AGENT_CLAUDE_PATH = await executable(join(root, "claude"), `
const assert = require('node:assert/strict');
const args = process.argv.slice(2);
assert.deepEqual(args.slice(0, 3), ['-p', '--output-format', 'json']);
assert.equal(args[args.indexOf('--resume') + 1], 'session-c');
assert.equal(args.at(-2), '--');
console.log(JSON.stringify(args.at(-1) === 'fail' ? {is_error: true, result: 'authentication failed'} : {result: args.at(-1), session_id: 'session-c'}));`);
  const opts = { sessionId: "session-c", cwd: root };
  assert.deepEqual(await getAdapter("claude").run({ ...opts, text: "--dangerous `literal` 中文\nnext" }), {
    reply: "--dangerous `literal` 中文\nnext", sessionId: "session-c",
  });
  await assert.rejects(getAdapter("claude").run({ ...opts, text: "fail" }), /authentication failed/);
});

test("OpenCode handles batched and fragmented JSONL, resumes and rejects incomplete/error output", async (t) => {
  const root = await fixture(t);
  process.env.WX_AGENT_OPENCODE_PATH = await executable(join(root, "opencode"), `
const assert = require('node:assert/strict');
const args = process.argv.slice(2);
assert.deepEqual(args.slice(0, 3), ['run', '--format', 'json']);
assert.equal(args[args.indexOf('--session') + 1], 'ses-1');
const mode = args.at(-1);
if (mode === 'error') console.log(JSON.stringify({type:'error', error:{data:{message:'bad model'}}}));
else {
 const events = [{type:'step_start',sessionID:'ses-1'}, {type:'text',part:{text:'Hello'}}, {type:'text',part:{text:'world'}}];
 if (mode !== 'incomplete') events.push({type:'step_finish',part:{reason:'stop'}});
 const data = events.map(e => JSON.stringify(e)).join('\\n');
 process.stdout.write(data.slice(0, 13));
 setTimeout(() => process.stdout.write(data.slice(13)), 10);
}`);
  const opts = { cwd: root, sessionId: "ses-1" };
  assert.deepEqual(await getAdapter("opencode").run({ ...opts, text: "ok" }), { reply: "Hello\n\nworld", sessionId: "ses-1" });
  await assert.rejects(getAdapter("opencode").run({ ...opts, text: "error" }), /bad model/);
  await assert.rejects(getAdapter("opencode").run({ ...opts, text: "incomplete" }), /未返回完整回复/);
});

test("Pi preserves the session and extracts final assistant text without tool/thinking events", async (t) => {
  const root = await fixture(t);
  process.env.WX_AGENT_PI_PATH = await executable(join(root, "pi"), `
const assert = require('node:assert/strict');
const args = process.argv.slice(2);
assert.deepEqual(args.slice(0,3), ['--print', '--mode', 'json']);
if (args.includes('--session')) assert.equal(args[args.indexOf('--session') + 1], 'pi-1');
const message = {role:'assistant', stopReason:args.at(-1) === 'error' ? 'error' : 'stop', errorMessage:'no API key', content:[{type:'thinking',thinking:'secret'}, {type:'text',text:'Pi response'}]};
console.log([{type:'session',id:'pi-1'}, {type:'message_end',message:{role:'toolResult',content:[{type:'text',text:'tool output'}]}}, {type:'message_end',message}, {type:'agent_end',messages:[message]}].map(e => JSON.stringify(e)).join('\\n'));`);
  const result = await getAdapter("pi").run({ text: "new", cwd: root });
  assert.deepEqual(result, { reply: "Pi response", sessionId: "pi-1" });
  assert.deepEqual(await getAdapter("pi").run({ text: "resume", cwd: root, sessionId: result.sessionId }), result);
  await assert.rejects(getAdapter("pi").run({ text: "error", cwd: root }), /no API key/);
});

test("Codex still reads every event when a single stdout chunk contains multiple JSON lines", async (t) => {
  const root = await fixture(t);
  process.env.WX_AGENT_CODEX_PATH = await executable(join(root, "codex"), `
console.log(JSON.stringify({type:'thread.started',thread_id:'thread-1'})+'\\n'+JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Codex reply'}}));`);
  assert.deepEqual(await getAdapter("codex").run({ text: "hello", cwd: root }), { reply: "Codex reply", sessionId: "thread-1" });
});

test("timeout and cancellation do not report a successful empty reply", async (t) => {
  const root = await fixture(t);
  const bin = await executable(join(root, "sleepy"), "setInterval(() => {}, 1000)");
  await assert.rejects(runCommand(bin, [], { timeoutMs: 50 }), /执行超时/);
  const controller = new AbortController();
  const result = runCommand(bin, [], { signal: controller.signal });
  controller.abort();
  await assert.rejects(result, /任务已被终止/);
  assert.equal(getAdapter("toString"), null);
});
