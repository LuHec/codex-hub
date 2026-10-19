import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fault, directory } from './protocol.mjs';
import { translate } from './translate.mjs';

const input = text => [{ type: 'text', text, text_elements: [] }];
// Omitting sources defaults to interactive threads, and would miss app-server threads.
const allSources = ['cli', 'vscode', 'exec', 'appServer', 'subAgent', 'subAgentReview',
  'subAgentCompact', 'subAgentThreadSpawn', 'subAgentOther', 'unknown'];
const sandbox = session => ({
  sandbox: session.sandbox ?? 'danger-full-access',
  config: { sandbox_workspace_write: { writable_roots: session.dirs ?? [], network_access: !!session.network } },
});

// Codex owns its protocol state. Session records are inputs; returned patches are copies.
export class Codex {
  constructor({ app, onEvent }) {
    this.app = app;
    this.onEvent = onEvent;
    this.runtime = new Map();
  }
  start() {
    if (this.app.dead) return Promise.reject(this.app.dead);
    if (this.closing) return Promise.reject(fault('HUB_STOPPING', 'Codex is stopping'));
    return this.started ??= this.boot();
  }
  async boot() {
    await this.app.start();
    try {
      const models = [];
      let cursor;
      do {
        const page = await this.app.request('model/list', { includeHidden: true, ...(cursor ? { cursor } : {}) }, { timeoutMs: 5000, fatal: false });
        if (!Array.isArray(page.data)) return;
        models.push(...page.data); cursor = page.nextCursor;
      } while (cursor);
      if (models.length) this.models = models;
    } catch { /* Discovery is optional; Codex remains the authority. */ }
  }
  state(id) {
    if (!this.runtime.has(id)) this.runtime.set(id, { resumed: false, turnId: null });
    return this.runtime.get(id);
  }
  async activeThreadIds() {
    await this.start();
    const ids = new Set(), cursors = new Set();
    let cursor;
    do {
      const page = await this.app.request('thread/list', {
        archived: false, modelProviders: [], sourceKinds: allSources, limit: 100,
        ...(cursor ? { cursor } : {}),
      }, { timeoutMs: 15_000, fatal: false });
      // Never turn a failed, malformed, or incomplete listing into deletions.
      if (!Array.isArray(page?.data) || page.data.some(t => typeof t?.id !== 'string' || !t.id)
        || !(page.nextCursor === null || (typeof page.nextCursor === 'string' && page.nextCursor))) {
        throw new Error('Invalid Codex thread/list response; startup sync skipped');
      }
      for (const thread of page.data) ids.add(thread.id);
      cursor = page.nextCursor;
      if (cursor && cursors.has(cursor)) throw new Error('Repeated Codex thread/list cursor; startup sync skipped');
      cursors.add(cursor);
    } while (cursor);
    return ids;
  }
  snapshot(session) {
    let modelOptions = session.modelOptions ?? [];
    if (this.models) modelOptions = this.models.map(m => ({ slug: m.model,
      efforts: m.supportedReasoningEfforts.map(e => e.reasoningEffort), def: m.defaultReasoningEffort }));
    else if (!modelOptions.length) {
      try {
        const cache = JSON.parse(fs.readFileSync(path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'models_cache.json'), 'utf8'));
        modelOptions = (cache.models ?? []).filter(m => m.visibility !== 'hide').map(m => ({ slug: m.slug,
          efforts: (m.supported_reasoning_levels ?? []).map(e => e.effort ?? e), def: m.default_reasoning_level }));
      } catch { /* A session's current selection remains available without a cache. */ }
    }
    return { modelValue: session.model, modelOptions: structuredClone(modelOptions) };
  }
  settings(p, session) {
    const fallback = this.models?.find(m => m.isDefault) ?? this.models?.[0];
    const model = p.model ?? session?.model ?? fallback?.model;
    const entry = this.models?.find(m => m.model === model);
    if (this.models && model && !entry) throw fault('INVALID_PARAMS', `model is not offered by Codex: ${model}`);
    const effort = p.effort ?? (p.model && p.model !== session?.model ? entry?.defaultReasoningEffort : session?.effort) ?? entry?.defaultReasoningEffort;
    if (entry && effort && !entry.supportedReasoningEfforts.some(e => e.reasoningEffort === effort)) throw fault('INVALID_PARAMS', `effort ${effort} is not offered for model ${model}`);
    return { model: model ?? null, effort: effort ?? null };
  }
  async create(p) {
    await this.start();
    const settings = this.settings(p);
    const access = { dirs: p.dirs?.map((d, i) => directory(d, `dirs[${i}]`)) ?? [], network: p.network === true, sandbox: p.sandbox ?? 'danger-full-access' };
    const result = await this.app.request('thread/start', { cwd: p.cwd, model: settings.model, approvalPolicy: 'never', ...sandbox(access) });
    const record = { id: result.thread.id, ...access, model: settings.model ?? result.model ?? null, effort: settings.effort ?? result.reasoningEffort ?? null };
    this.state(record.id).resumed = true;
    return { ...record, ...this.snapshot(record) };
  }
  async prepare(session, p) {
    await this.start();
    const settings = this.settings(p, session);
    const state = this.state(session.id);
    if (!state.resumed) {
      if (state.reload) await this.unload(session.id);
      state.reload = false;
      await this.app.request('thread/resume', { threadId: session.id, cwd: session.cwd, model: settings.model,
        ...sandbox(session), approvalPolicy: 'never' });
      state.resumed = true;
    }
    return { ...settings, ...this.snapshot({ ...session, ...settings }) };
  }
  async run(session, prompt) {
    const state = this.state(session.id);
    state.turnId = null;
    const result = await this.app.request('turn/start', { threadId: session.id, input: input(prompt),
      model: session.model, effort: session.effort, approvalPolicy: 'never' });
    state.turnId ??= result.turn.id;
  }
  async configure(session, p) {
    await this.start();
    const settings = this.settings(p, session), patch = {};
    if (p.model) patch.model = settings.model;
    if (p.effort || p.model) patch.effort = settings.effort;
    if (p.dirs !== undefined) patch.dirs = p.dirs.map((d, i) => directory(d, `dirs[${i}]`));
    if (p.network !== undefined) patch.network = p.network === true;
    if (p.sandbox !== undefined) patch.sandbox = p.sandbox;
    if (!Object.keys(patch).length) throw fault('INVALID_PARAMS', 'configure needs model, effort, dirs, network or sandbox');
    if (['dirs', 'network', 'sandbox'].some(k => k in patch)) {
      const state = this.state(session.id);
      state.reload ||= state.resumed; state.resumed = false;
    }
    return { ...patch, ...this.snapshot({ ...session, ...patch }) };
  }
  steer(session, text) { return this.app.request('turn/steer', { threadId: session.id, expectedTurnId: this.state(session.id).turnId, input: input(text) }); }
  interrupt(session) { return this.app.request('turn/interrupt', { threadId: session.id, turnId: this.state(session.id).turnId }); }
  async unload(id) {
    const state = this.state(id);
    const closed = new Promise(resolve => { state.closed = resolve; });
    let timer;
    try {
      const { status } = await this.app.request('thread/unsubscribe', { threadId: id });
      if (status === 'unsubscribed') await Promise.race([closed, new Promise(resolve => { timer = setTimeout(resolve, 5000); })]);
    } finally { clearTimeout(timer); delete state.closed; }
  }
  notification(method, p) {
    if (!p.threadId) return;
    const state = this.state(p.threadId);
    if (method === 'thread/closed') return state.closed?.();
    if (method === 'turn/started') { state.turnId = p.turn.id; return; }
    if (p.turnId && state.turnId && p.turnId !== state.turnId) return;
    if (method === 'turn/completed') {
      if (p.turn.id && state.turnId && p.turn.id !== state.turnId) return;
      const final = p.turn.items?.filter(i => i.type === 'agentMessage' && (i.phase === 'final_answer' || i.phase == null)).at(-1)?.text;
      this.onEvent(p.threadId, { kind: 'execution.completed', status: p.turn.status, error: p.turn.error, finalMessage: final });
      return;
    }
    for (const event of translate(method, p)) {
      this.onEvent(p.threadId, { ...event,
        ...(event.kind === 'message.done' ? { final: p.item.phase === 'final_answer' || p.item.phase == null } : {}),
        ...(event.kind === 'command.done' ? { activity: `Command exited ${event.exitCode ?? '?'}: ${p.item.command}` } : {}) });
    }
  }
  close() { this.closing = true; return this.closed ??= this.app.close(); }
}
