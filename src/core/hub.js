// bot 实例注册表：加载 data/bots.json → 按渠道 provider 实例化 → 启停 → 状态上报。
// 将来新增渠道（如飞书）只需在这里注册 provider，其余不动。
export class Hub {
  constructor({ providers, paths, config, state, saveState, router, logger, events, signal }) {
    this.providers = providers;
    this.paths = paths;
    this.config = config;
    this.state = state;
    this.saveState = saveState;
    this.router = router;
    this.log = logger;
    this.events = events;
    this.signal = signal;
    this.entries = []; // bots.json 条目
    this.bots = new Map(); // id -> { instance, startPromise }
  }

  emit(type, payload) {
    this.events?.emit("event", { type, payload, at: new Date().toISOString() });
  }

  // ---------- 生命周期 ----------

  async init() {
    const { loadBots } = await import("../store.js");
    this.entries = await loadBots(this.paths.botsFile, this.paths.tokenFile, {
      defaultAgent: this.config.defaultAgent,
    });
    for (const entry of this.entries) {
      await this.startEntry(entry, { silent: true });
    }
    this.log.info(`hub: ${this.entries.length} bot(s) loaded [${this.entries.map((e) => `${e.id}:${e.provider}`).join(", ") || "-"}]`);
  }

  async shutdown() {
    await Promise.allSettled([...this.bots.keys()].map((id) => this.stopBot(id)));
  }

  providerFor(entry) {
    const provider = this.providers[entry.provider];
    if (!provider) throw new Error(`unknown provider: ${entry.provider}`);
    if (provider.singleton && this.entries.some((e) => e.provider === entry.provider && e.id !== entry.id)) {
      throw new Error(`provider ${entry.provider} 仅允许一个实例`);
    }
    return provider;
  }

  async startEntry(entry, { silent = false } = {}) {
    const provider = this.providerFor(entry);
    // 同 id 旧实例先停干净再换新（如微信重新扫码绑定）。
    await this.stopBot(entry.id);

    const id = entry.id;
    this.state.cursors ??= {};
    this.state.cursors[id] ??= { buf: null, initialized: false };

    const instance = provider.createBot({
      entry,
      getCursor: () => this.state.cursors[id],
      setCursor: (patch) => {
        this.state.cursors[id] = { ...this.state.cursors[id], ...patch };
        void this.saveState(this.state);
      },
      onMessage: (message) => this.router.handleInbound(instance, message),
      onStatus: (status) => {
        this.emit("bot_status", { id, provider: entry.provider, status, lastError: instance.lastError });
      },
      logger: this.log,
      signal: this.signal,
    });

    this.bots.set(id, { instance, startPromise: null });
    const record = this.bots.get(id);
    record.startPromise = instance
      .start()
      .catch((error) => this.log.error(`bot ${id} crashed: ${error.message}`));
    if (!silent) this.log.info(`hub: bot ${id} (${entry.provider}) started`);
    this.emit("bot_status", { id, provider: entry.provider, status: instance.status });
  }

  async stopBot(id) {
    const record = this.bots.get(id);
    if (!record) return;
    this.bots.delete(id);
    await record.instance.stop();
    await record.startPromise;
    this.log.info(`hub: bot ${id} stopped`);
  }

  // ---------- 增删改（登录成功 / 面板操作） ----------

  // upsert：优先按 id 匹配（如飞书同一 app 重新扫码）；
  // 单例渠道（微信）按 provider 替换；其余追加新实例。
  async upsertBot(entry) {
    const provider = this.providerFor(entry);
    const byId = this.entries.find((e) => e.id === entry.id);
    if (byId) {
      Object.assign(byId, entry);
      await this.persist();
      await this.startEntry(byId);
      return byId;
    }
    if (provider.singleton) {
      const existing = this.entries.find((e) => e.provider === entry.provider);
      if (existing) {
        Object.assign(existing, entry, { id: existing.id });
        await this.persist();
        await this.startEntry(existing);
        return existing;
      }
    }
    this.entries.push(entry);
    await this.persist();
    await this.startEntry(entry);
    return entry;
  }

  // 面板给 bot 换绑 agent（不需要重启连接，路由即时生效）。
  async patchBot(id, { agent }) {
    const entry = this.entries.find((e) => e.id === id);
    if (!entry) throw new Error(`bot not found: ${id}`);
    entry.agent = agent;
    await this.persist();
    const record = this.bots.get(id);
    if (record) record.instance.agent = agent;
    this.emit("bot_status", {
      id,
      provider: entry.provider,
      status: record?.instance.status ?? "stopped",
      agent,
    });
    return entry;
  }

  async removeBot(id) {
    const index = this.entries.findIndex((e) => e.id === id);
    if (index < 0) throw new Error(`bot not found: ${id}`);
    this.entries.splice(index, 1);
    await this.stopBot(id);
    // 停掉该 bot 名下仍在执行/排队的任务，避免任务完成后继续向 IM 回复。
    const stopped = this.router?.stopBotTasks?.(id) ?? 0;
    if (stopped > 0) this.log.info(`hub: aborted ${stopped} running task(s) of bot ${id}`);
    await this.persist();
    this.emit("bot_status", { id, provider: "-", status: "removed" });
  }

  async persist() {
    const { saveBots } = await import("../store.js");
    await saveBots(this.paths.botsFile, this.entries);
  }

  // ---------- 状态 ----------

  status() {
    return this.entries.map((entry) => {
      const record = this.bots.get(entry.id);
      const instance = record?.instance;
      return {
        id: entry.id,
        provider: entry.provider,
        agent: entry.agent,
        label: instance?.label ?? entry.credentials?.appName ?? null,
        credentials: { botId: entry.credentials?.botId ?? entry.credentials?.appId ?? null },
        status: instance?.status ?? "stopped",
        lastError: instance?.lastError ?? null,
        connectedAt: instance?.connectedAt ?? null,
      };
    });
  }
}
