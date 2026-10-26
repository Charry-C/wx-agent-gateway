import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { weixinProvider } from "../src/channels/weixin.js";
import { createBotClient, GET_UPDATES_TIMEOUT_MS } from "../src/channels/ilink.js";

const flush = () => setImmediate();
const update = (buf, msgs = []) => ({ ret: 0, get_updates_buf: buf, msgs });
const message = (id) => ({ message_id: id, from_user_id: "test-user", text: id });
const networkError = (code = "ECONNRESET") => new TypeError("fetch failed", { cause: Object.assign(new Error("socket failure"), { code }) });

function waitForAbort(signal) {
  return new Promise((_, reject) => {
    if (signal.aborted) return reject(signal.reason);
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

function setup(t, steps, { initialized = true, signal } = {}) {
  const requests = [];
  const statuses = [];
  const received = [];
  const logs = [];
  let cursor = { buf: "saved-cursor", initialized };
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(new URL(url).pathname, "/ilink/bot/getupdates");
    requests.push({ ...options, body: JSON.parse(options.body) });
    const next = steps.shift();
    if (next instanceof Error) throw next;
    if (next) return Response.json(next);
    return waitForAbort(options.signal);
  });
  const bot = weixinProvider.createBot({
    entry: { id: "weixin", agent: "codex", credentials: { botToken: "test-token" } },
    getCursor: () => cursor,
    setCursor: (patch) => { cursor = { ...cursor, ...patch }; },
    onMessage: async (msg) => { received.push(msg); },
    onStatus: (status, instance) => { statuses.push({ status, lastError: instance.lastError }); },
    logger: Object.fromEntries(["info", "warn", "error"].map((level) => [level, (text) => logs.push({ level, text })])),
    signal,
  });
  let running;
  t.after(async () => { await bot.stop(); await running; });
  return { bot, requests, statuses, received, logs, cursor: () => cursor, start: () => (running = bot.start()) };
}

test("network recovery restores online status, clears the error, and resumes from the saved cursor", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const f = setup(t, [update("cursor-1"), networkError(), update("cursor-2", [message("new-message")])]);
  f.start();
  await flush();
  assert.equal(f.bot.status, "connecting");
  assert.match(f.bot.lastError, /ECONNRESET.*5 秒后重试/);
  assert.equal(f.cursor().buf, "cursor-1");
  assert.equal(f.requests.length, 2);
  t.mock.timers.tick(4_999);
  await flush();
  assert.equal(f.requests.length, 2);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(f.bot.status, "connected");
  assert.equal(f.bot.lastError, null);
  assert.equal(f.bot.connectedAt, new Date(5_000).toISOString());
  assert.deepEqual(f.statuses.map((entry) => entry.status), ["connecting", "connected", "connecting", "connected"]);
  assert.deepEqual(f.received.map((msg) => msg.id), ["new-message"]);
  assert.equal(f.requests[2].body.get_updates_buf, "cursor-1");
  assert.equal(f.cursor().buf, "cursor-2");
  assert(f.logs.some((entry) => /reconnected after 1 failed/.test(entry.text)));
});

test("consecutive failures back off to 30 seconds and keep retrying without rebinding", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const aggregate = new TypeError("fetch failed", { cause: new AggregateError([Object.assign(new Error(), { code: "ENETUNREACH" }), Object.assign(new Error(), { code: "ETIMEDOUT" })]) });
  const f = setup(t, [aggregate, ...Array.from({ length: 5 }, () => networkError()), update("recovered")]);
  f.start();
  await flush();
  assert.match(f.bot.lastError, /ENETUNREACH, ETIMEDOUT/);
  for (const delay of [5_000, 10_000, 20_000, 30_000, 30_000, 30_000]) {
    const before = f.requests.length;
    assert.match(f.bot.lastError, new RegExp(`${delay / 1000} 秒后重试`));
    t.mock.timers.tick(delay - 1);
    await flush();
    assert.equal(f.requests.length, before);
    t.mock.timers.tick(1);
    await flush();
    assert(f.requests.length > before);
  }
  assert.equal(f.bot.status, "connected");
  assert.equal(f.bot.lastError, null);
  assert(f.requests.every((request) => request.headers.Authorization === "Bearer test-token"));
});

test("a new outage after recovery starts with the initial five-second delay", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = setup(t, [networkError(), networkError(), update("first-recovery"), networkError(), update("second-recovery")]);
  f.start();
  await flush();
  t.mock.timers.tick(5_000);
  await flush();
  assert.match(f.bot.lastError, /10 秒后重试（第 2 次）/);
  t.mock.timers.tick(10_000);
  await flush();
  assert.match(f.bot.lastError, /5 秒后重试（第 1 次）/);
  t.mock.timers.tick(5_000);
  await flush();
  assert.equal(f.bot.status, "connected");
  assert.equal(f.cursor().buf, "second-recovery");
});

test("stop during retry wait cancels the wait and never reconnects again", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = setup(t, [networkError(), update("should-not-be-read")]);
  const running = f.start();
  await flush();
  await f.bot.stop();
  await running;
  assert.equal(f.bot.status, "stopped");
  assert.equal(f.bot.lastError, null);
  t.mock.timers.tick(120_000);
  await flush();
  assert.equal(f.requests.length, 1);
});

test("global shutdown aborts in-flight polling, prevents duplicate starts and does not restart a stopped bot", async (t) => {
  const controller = new AbortController();
  const f = setup(t, [], { signal: controller.signal });
  const running = f.start();
  await flush();
  await f.bot.start();
  assert.equal(f.requests.length, 1);
  controller.abort();
  await running;
  assert.equal(f.requests[0].signal.aborted, true);
  assert.equal(f.bot.status, "stopped");
  await f.bot.start();
  assert.equal(f.requests.length, 1);
  assert(!f.logs.some((entry) => entry.level === "warn"));
});

test("normal long-poll timeout continues polling without a false offline transition", async (t) => {
  const f = setup(t, [update("cursor-1"), new DOMException("poll timeout", "TimeoutError"), update("cursor-2")]);
  f.start();
  await flush();
  assert.equal(f.bot.status, "connected");
  assert.equal(f.bot.lastError, null);
  assert.deepEqual(f.statuses.map((entry) => entry.status), ["connecting", "connected"]);
  assert.equal(f.cursor().buf, "cursor-2");
  assert(!f.logs.some((entry) => entry.level === "warn"));
});

test("first-time initialization still skips backlog after a connection failure", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = setup(t, [networkError(), update("initial", [message("old")]), update("next", [message("new")])], { initialized: false });
  f.start();
  await flush();
  t.mock.timers.tick(5_000);
  await flush();
  assert.deepEqual(f.received.map((msg) => msg.id), ["new"]);
  assert.deepEqual(f.cursor(), { buf: "next", initialized: true });
});

test("request timeout remains active when polling has a caller cancellation signal", async (t) => {
  const timeout = new AbortController();
  const caller = new AbortController();
  const timeouts = [];
  t.mock.method(AbortSignal, "timeout", (ms) => { timeouts.push(ms); return timeout.signal; });
  let fetchSignal;
  t.mock.method(globalThis, "fetch", (_, options) => {
    fetchSignal = options.signal;
    return waitForAbort(fetchSignal);
  });
  const client = createBotClient({ token: "test-token" });
  const request = client.getUpdates("saved-cursor", caller.signal);
  timeout.abort(new DOMException("poll timeout", "TimeoutError"));
  await assert.rejects(request, { name: "TimeoutError" });
  assert.deepEqual(timeouts, [GET_UPDATES_TIMEOUT_MS]);
  assert.equal(fetchSignal.aborted, true);
  assert.equal(caller.signal.aborted, false);
});
