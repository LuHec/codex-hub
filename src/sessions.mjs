import { fault, directory } from './protocol.mjs';
import { sameOwner, ownerLabel } from './config.mjs';
import { translate } from './translate.mjs';

const copy = value => structuredClone(value);
// Streamed to live clients but never journaled: deltas settle into one *.done event per item,
// and session snapshots live in state.json.
const TRANSIENT = new Set(['message.delta', 'reasoning.delta', 'session.updated']);
const line = text => String(text).trim().split(/\r?\n/).filter(Boolean).at(-1)?.slice(0, 240) || '';
const input = text => [{ type: 'text', text, text_elements: [] }];
// app-server applies sandbox settings per thread (turn-level writableRoots is rejected), so they go on
// thread/start and on every (re)resume. workspace-write: writes stay in cwd + dirs, reads are unrestricted.
const threadSandbox = session => ({
  sandbox: session.sandbox ?? 'danger-full-access',
  config: { sandbox_workspace_write: { writable_roots: session.dirs ?? [], network_access: !!session.network } },
});
export class Sessions {
  constructor({ store, app, onEvent }) {
    this.store = store;
    this.app = app;
    this.onEvent = onEvent;
    this.records = new Map();
    this.archived = new Set();
    this.seq = 0;
    this.runtime = new Map();
    this.queues = new Map();
    this.waiters = new Map();
  }
  load() {
    const state = this.store.load();
    this.records = new Map(state.sessions.map(s => [s.id, s]));
    this.archived = new Set(state.archived);
    this.seq = state.seq;
    this.loaded = true;
    for (const session of this.records.values()) {
      this.runtime.set(session.id, { resumed: false, turnId: null, finalMessage: null, live: [] });
      if (session.status === 'running') {
        this.update(session, { status: 'interrupted', turnStartedAt: null, lastLine: 'Hub restarted; turn interrupted' });
        this.emit(session.id, { kind: 'turn.completed', status: 'interrupted', error: 'Hub restarted' });
      } else if (session.status !== 'idle' || session.turnStartedAt !== null) {
        this.update(session, { status: 'idle', turnStartedAt: null });
      }
    }
    this.persist();
  }
  async start() {
    await this.app.start();
    try {
      const models = [];
      let cursor;
      do {
        const page = await this.app.request('model/list', { includeHidden: true, ...(cursor ? { cursor } : {}) }, { timeoutMs: 5000, fatal: false });
        if (!Array.isArray(page.data)) return;
        models.push(...page.data);
        cursor = page.nextCursor;
      } while (cursor);
      if (models.length) this.models = models;
    } catch { /* Discovery is optional; Codex remains the authority. */ }
  }
  persist() { this.store.persist({ seq: this.seq, sessions: [...this.records.values()], archived: [...this.archived] }); }
  settled(id) { return this.queues.get(id)?.catch(() => {}); }
  async stop() {
    this.stopping = true;
    await this.app.close();
    await Promise.allSettled([...this.queues.values()]);
    for (const session of this.records.values()) {
      if (session.status === 'running') this.finish(session, { status: 'interrupted', error: { message: 'Hub stopped' } });
    }
    if (this.loaded) { this.flush(); this.persist(); }
    this.stopped = true;
  }
  emit(id, payload) {
    const event = { seq: ++this.seq, ts: Date.now(), sessionId: id, ...copy(payload) };
    if (!TRANSIENT.has(event.kind)) this.store.append(event);
    else if (event.kind.endsWith('.delta')) this.runtime.get(id)?.live.push(event);
    this.onEvent(event);
    return event;
  }
  update(session, patch) {
    Object.assign(session, patch, { lastActivityAt: Date.now() });
    this.dirty?.delete(session.id); // this snapshot already carries any pending activity
    this.emit(session.id, { kind: 'session.updated', session });
    this.persist();
  }
  // Streaming deltas arrive per token; coalesce their lastLine snapshots and state writes.
  activity(session, text) {
    Object.assign(session, { lastLine: line(text), lastActivityAt: Date.now() });
    (this.dirty ??= new Set()).add(session.id);
    this.flushTimer ??= setTimeout(() => this.flush(), 500);
  }
  flush() {
    clearTimeout(this.flushTimer);
    this.flushTimer = null;
    if (!this.dirty?.size || this.stopped) return;
    for (const id of this.dirty) this.emit(id, { kind: 'session.updated', session: this.records.get(id) });
    this.dirty.clear();
    this.persist();
  }
  resolve(id) {
    if (this.records.has(id)) return this.records.get(id);
    const matches = [...this.records.values()].filter(s => s.id.startsWith(id));
    if (matches.length !== 1) throw fault(matches.length ? 'AMBIGUOUS_ID' : 'NOT_FOUND', matches.length ? `Ambiguous session prefix: ${id}` : `Unknown session: ${id}`);
    return matches[0];
  }
  list(owner) {
    return [...this.records.values()].filter(s => !this.archived.has(s.id) && (owner === undefined || sameOwner(s.owner, owner)))
      .sort((a, b) => b.lastActivityAt - a.lastActivityAt || b.createdAt - a.createdAt).map(copy);
  }
  // Replace an item's in-memory deltas with one journaled *.done event.
  settle(session, kind, itemId, text) {
    const runtime = this.runtime.get(session.id);
    const deltas = runtime.live.filter(e => e.kind === `${kind}.delta` && e.itemId === itemId);
    runtime.live = runtime.live.filter(e => !deltas.includes(e));
    text ??= deltas.map(e => e.text).join('');
    if (text) this.emit(session.id, { kind: `${kind}.done`, itemId, text });
  }
  events(id, afterSeq = 0, limit) {
    // Journal plus the running turn's unsettled deltas, so a late viewer sees partial text.
    const events = [...this.store.history(id), ...(this.runtime.get(id)?.live ?? [])]
      .filter(e => e.seq > afterSeq).sort((a, b) => a.seq - b.seq);
    // With a cursor, page forward. Without a cursor, fetch the latest N for the UI.
    return limit === undefined ? events : limit === 0 ? [] : afterSeq > 0 ? events.slice(0, limit) : events.slice(-limit);
  }
  serialize(id, task) {
    const previous = this.queues.get(id) || Promise.resolve();
    const next = previous.catch(() => {}).then(() => {
      if (this.stopping) throw fault('HUB_STOPPING', 'Hub is stopping');
      return task();
    });
    this.queues.set(id, next);
    next.finally(() => { if (this.queues.get(id) === next) this.queues.delete(id); }).catch(() => {});
    return next;
  }
  async startTurn(session, params, owner) {
    if (session.status === 'running') throw fault('BUSY', 'Session is already running');
    const prompt = params.prompt;
    params = { ...params, ...this.settings(params, session) };
    const runtime = this.runtime.get(session.id);
    if (!runtime.resumed) {
      if (runtime.reload) await this.unload(session.id);
      runtime.reload = false;
      await this.app.request('thread/resume', { threadId: session.id, cwd: session.cwd,
        model: params.model || session.model, ...threadSandbox(session), approvalPolicy: 'never' });
      runtime.resumed = true;
    }
    runtime.finalMessage = null;
    runtime.turnId = null;
    runtime.texts = new Map();
    this.update(session, { status: 'running', model: params.model ?? null, effort: params.effort ?? null,
      turnStartedAt: Date.now(), plan: [], lastLine: line(prompt) });
    this.emit(session.id, { kind: 'turn.started', prompt, by: owner ?? null });
    try {
      const result = await this.app.request('turn/start', { threadId: session.id, input: input(prompt),
        model: session.model, effort: session.effort, approvalPolicy: 'never' });
      if (session.status === 'running') runtime.turnId = result.turn.id;
      return copy(session);
    } catch (error) {
      this.finish(session, { status: this.stopping ? 'interrupted' : 'failed', error: { message: error.message } });
      throw error;
    }
  }
  // A loaded thread keeps its sandbox; unload it so the next resume applies new settings.
  async unload(id) {
    const closed = new Promise(resolve => (this.closing ??= new Map()).set(id, resolve));
    try {
      const { status } = await this.app.request('thread/unsubscribe', { threadId: id });
      if (status === 'unsubscribed') await Promise.race([closed, new Promise(resolve => setTimeout(resolve, 5000))]);
    } finally { this.closing.delete(id); }
  }
  finish(session, turn) {
    if (session.status !== 'running') return;
    const runtime = this.runtime.get(session.id);
    if (runtime.turnId && turn.id && runtime.turnId !== turn.id) return;
    const status = ['completed', 'failed', 'interrupted'].includes(turn.status) ? turn.status : 'failed';
    // An interrupted item never completes; keep whatever text it streamed.
    for (const e of [...runtime.live]) if (runtime.live.includes(e)) this.settle(session, e.kind.split('.')[0], e.itemId);
    const final = turn.items?.filter(i => i.type === 'agentMessage' && (i.phase === 'final_answer' || i.phase == null)).at(-1)?.text;
    this.update(session, { status: status === 'completed' ? 'idle' : status, turnStartedAt: null,
      turns: session.turns + 1, lastMessage: final ?? runtime.finalMessage,
      lastLine: line(turn.error?.message || final || runtime.finalMessage || status) });
    this.emit(session.id, { kind: 'turn.completed', status, ...(turn.error?.message ? { error: turn.error.message } : {}) });
    runtime.turnId = null;
    this.persist();
    for (const done of this.waiters.get(session.id) || []) done();
  }
  notification(method, p) {
    if (method === 'thread/closed') return this.closing?.get(p.threadId)?.();
    const session = this.records.get(p.threadId);
    if (!session || this.stopped) return;
    const runtime = this.runtime.get(session.id);
    if (method === 'turn/started') { runtime.turnId = p.turn.id; return; }
    if (p.turnId && runtime.turnId && p.turnId !== runtime.turnId) return;
    if (method === 'turn/completed') return this.finish(session, p.turn);
    for (const event of translate(method, p)) {
      const { kind, itemId, text } = event;
      if (kind.endsWith('.done') && ['message.done', 'reasoning.done'].includes(kind)) {
        this.settle(session, kind.split('.')[0], itemId, text);
        if (kind === 'message.done' && (p.item.phase === 'final_answer' || p.item.phase == null)) runtime.finalMessage = text;
      } else this.emit(session.id, event);
      if (kind.endsWith('.delta')) {
        runtime.texts ??= new Map();
        const partial = (runtime.texts.get(itemId) || '') + text;
        runtime.texts.set(itemId, partial.slice(-1000));
        this.activity(session, partial);
      } else if (kind === 'plan.updated') this.update(session, { plan: event.plan, lastLine: line(p.explanation || 'Plan updated') });
      else if (kind === 'command.done') this.activity(session, `Command exited ${event.exitCode ?? '?'}: ${p.item.command}`);
      else this.activity(session, text || event.message || event.command || event.path || kind);
    }
  }

  wait(session, timeoutMs, signal) {
    if (session.status !== 'running' || timeoutMs === 0 || signal.aborted) return Promise.resolve(copy(session));
    return new Promise(resolve => {
      let timer;
      const set = this.waiters.get(session.id) || new Set();
      this.waiters.set(session.id, set);
      const done = () => {
        clearTimeout(timer); set.delete(done); signal.removeEventListener('abort', done);
        if (!set.size) this.waiters.delete(session.id);
        resolve(copy(session));
      };
      set.add(done);
      signal.addEventListener('abort', done, { once: true });
      if (timeoutMs !== undefined) timer = setTimeout(done, Math.min(timeoutMs, 2_147_483_647));
    });
  }
  settings(p, session) {
    const fallback = this.models?.find(m => m.isDefault) ?? this.models?.[0];
    const model = p.model ?? session?.model ?? fallback?.model;
    const entry = this.models?.find(m => m.model === model);
    if (this.models && model && !entry) throw fault('INVALID_PARAMS', `model is not offered by Codex: ${model}`);
    const effort = p.effort ?? (p.model && p.model !== session?.model ? entry?.defaultReasoningEffort : session?.effort) ?? entry?.defaultReasoningEffort;
    if (entry && effort && !entry.supportedReasoningEfforts.some(e => e.reasoningEffort === effort)) {
      throw fault('INVALID_PARAMS', `effort ${effort} is not offered for model ${model}`);
    }
    return { model, effort };
  }
  async create(p, identity) {
    const owner = this.mutationOwner(identity);
    const cwd = directory(p.cwd, 'cwd');
    const prompt = p.prompt;
    const { model, effort } = this.settings(p);
    const access = { dirs: p.dirs?.map((d, i) => directory(d, `dirs[${i}]`)) ?? [], network: p.network === true, sandbox: p.sandbox ?? 'danger-full-access' };
    const result = await this.app.request('thread/start', { cwd, model, approvalPolicy: 'never', ...threadSandbox(access) });
    const now = Date.now();
    const session = { id: result.thread.id, title: p.title ?? prompt.split(/\r?\n/)[0].slice(0, 100), cwd, model: model ?? result.model ?? null, effort: effort ?? result.reasoningEffort ?? null,
      owner, ...access, status: 'idle', createdAt: now, turnStartedAt: null, lastActivityAt: now,
      lastLine: '', plan: [], turns: 0, lastMessage: null };
    this.records.set(session.id, session);
    this.runtime.set(session.id, { resumed: true, turnId: null, finalMessage: null, live: [] });
    this.emit(session.id, { kind: 'session.created', session }); this.persist();
    return this.serialize(session.id, () => this.startTurn(session, { prompt }, owner));
  }
  mutationOwner(identity, session, force) {
    if (identity?.client === 'tui') return session?.owner ?? identity.owner ?? null;
    const caller = identity?.owner;
    const details = { sessionId: session?.id ?? null, title: session?.title ?? null, owner: session?.owner ?? null, caller: caller ?? null };
    if (!caller) throw fault('OWNER_REQUIRED', 'Set CODEX_HUB_OWNER=harness:id before modifying sessions.', details);
    if (session?.owner && session.owner.harness !== caller.harness && !force) {
      throw fault('OWNER_MISMATCH',
        `Session ${session.id} (${JSON.stringify(session.title)}) belongs to ${ownerLabel(session.owner)}; caller is ${ownerLabel(caller)}. ` +
        `Check codex-hub ls --mine and codex-hub show ${session.id}. To take over, add --force.`, details);
    }
    return !session?.owner || force ? caller : session.owner;
  }
  mutate(session, p, identity, handler) {
    return this.serialize(session.id, async () => {
      const owner = this.mutationOwner(identity, session, p.force);
      const result = await handler();
      if (result?.transferOwnership !== false && identity.client !== 'tui' && !sameOwner(owner, session.owner)) this.update(session, { owner });
      return result?.id === session.id ? copy(session) : result?.transferOwnership === false ? result.result : result;
    });
  }
  async steer(session, p, callerOwner) {
    const text = p.text;
    if (session.status !== 'running') throw fault('NOT_RUNNING', 'Session is not running');
    await this.app.request('turn/steer', { threadId: session.id, expectedTurnId: this.runtime.get(session.id).turnId, input: input(text) });
    this.emit(session.id, { kind: 'steer', text, by: callerOwner ?? null }); this.activity(session, text);
    return {};
  }
  async interrupt(session) {
    if (session.status !== 'running') return { result: {}, transferOwnership: false };
    await this.app.request('turn/interrupt', { threadId: session.id, turnId: this.runtime.get(session.id).turnId });
    return {};
  }
  rename(session, p) { this.update(session, { title: p.title }); return copy(session); }
  configure(session, p) {
    const patch = {};
    const settings = this.settings(p, session);
    if (p.model) patch.model = settings.model;
    if (p.effort || p.model) patch.effort = settings.effort ?? null;
    if (p.dirs !== undefined) patch.dirs = p.dirs.map((d, i) => directory(d, `dirs[${i}]`));
    if (p.network !== undefined) patch.network = p.network === true;
    if (p.sandbox !== undefined) patch.sandbox = p.sandbox;
    if (!Object.keys(patch).length) throw fault('INVALID_PARAMS', 'configure needs model, effort, dirs, network or sandbox');
    // Sandbox changes reach the thread when the next turn reloads it.
    if (['dirs', 'network', 'sandbox'].some(k => k in patch)) {
      const runtime = this.runtime.get(session.id);
      runtime.reload ||= runtime.resumed;
      runtime.resumed = false;
    }
    this.update(session, patch);
    return copy(session);
  }
  archive(session) { this.archived.add(session.id); this.update(session, { archived: true }); return {}; }
}
