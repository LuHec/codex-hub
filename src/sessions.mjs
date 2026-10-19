import { fault, directory } from './protocol.mjs';
import { sameOwner, ownerLabel } from './config.mjs';

const copy = value => structuredClone(value);
// Streamed to live clients but never journaled: deltas settle into one *.done event per item,
// and session snapshots live in state.json.
const TRANSIENT = new Set(['message.delta', 'reasoning.delta', 'session.updated']);
const line = text => String(text).trim().split(/\r?\n/).filter(Boolean).at(-1)?.slice(0, 240) || '';
export class Sessions {
  constructor({ store, codex, dsh, onEvent }) {
    this.store = store;
    this.codex = codex;
    this.dsh = dsh;
    this.onEvent = onEvent;
    this.records = new Map();
    this.archived = new Set();
    this.deleted = new Set();
    this.seq = 0;
    this.runtime = new Map();
    this.queues = new Map();
    this.waiters = new Map();
    this.creating = new Set();
  }
  load() {
    const state = this.store.load();
    this.records = new Map(state.sessions.map(s => [s.id, s]));
    this.archived = new Set(state.archived);
    this.deleted = new Set(state.deleted ?? []);
    this.seq = state.seq;
    this.loaded = true;
    for (const session of this.records.values()) {
      Object.assign(session, this.backend(session).snapshot(session));
      this.runtime.set(session.id, { finalMessage: null, live: [] });
      if (session.status === 'running') {
        this.update(session, { status: 'interrupted', turnStartedAt: null, lastLine: 'Hub restarted; turn interrupted' });
        this.emit(session.id, { kind: 'turn.completed', status: 'interrupted', error: 'Hub restarted' });
      } else if (session.status !== 'idle' || session.turnStartedAt !== null) {
        this.update(session, { status: 'idle', turnStartedAt: null });
      }
    }
    this.persist();
  }
  backend(session) { return session.dsh ? this.dsh : this.codex; }
  persist() { this.store.persist({ seq: this.seq, sessions: [...this.records.values()], archived: [...this.archived], deleted: [...this.deleted] }); }
  async reconcileBackend(name) {
    const candidates = [...this.records.values()].filter(s => !!s.dsh === (name === 'dsh'));
    if (!candidates.length) return;
    const active = await this[name].activeThreadIds();
    if (this.stopping) return;
    const removed = candidates.filter(s => !active.has(s.id)).map(s => s.id);
    if (!removed.length) return;
    const deleted = new Set([...this.deleted, ...removed]);
    const records = new Map([...this.records].filter(([id]) => !deleted.has(id)));
    const archived = new Set([...this.archived].filter(id => !deleted.has(id)));
    // Commit tombstones before removing journals, so crash recovery cannot resurrect them.
    this.store.persist({ seq: this.seq, sessions: [...records.values()], archived: [...archived], deleted: [...deleted] });
    this.records = records; this.archived = archived; this.deleted = deleted;
    for (const id of removed) {
      this.runtime.delete(id);
      this.store.removeHistory(id);
    }
  }
  settled(id) { return this.queues.get(id)?.catch(() => {}); }
  async stop() {
    this.stopping = true;
    const closed = await Promise.allSettled([this.codex, this.dsh].filter(Boolean).map(backend => Promise.resolve().then(() => backend.close())));
    await Promise.allSettled([...this.creating, ...this.queues.values()]);
    try {
      for (const session of this.records.values()) {
        if (session.status === 'running') this.finish(session, { status: 'interrupted', error: { message: 'Hub stopped' } });
      }
      if (this.loaded) { this.flush(); this.persist(); }
    } finally { this.stopped = true; }
    const failed = closed.find(r => r.status === 'rejected');
    if (failed) throw failed.reason;
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
    const backend = this.backend(session);
    const patch = await backend.prepare(copy(session), params);
    if (this.stopping) throw fault('HUB_STOPPING', 'Hub is stopping');
    const runtime = this.runtime.get(session.id);
    Object.assign(runtime, { finalMessage: null, texts: new Map() });
    this.update(session, { ...patch, status: 'running', turnStartedAt: Date.now(), plan: [], lastLine: line(params.prompt) });
    this.emit(session.id, { kind: 'turn.started', prompt: params.prompt, by: owner ?? null });
    try {
      await backend.run(copy(session), params.prompt);
      return copy(session);
    } catch (error) {
      this.finish(session, { status: this.stopping ? 'interrupted' : 'failed', error });
      throw error;
    }
  }
  finish(session, turn) {
    if (session.status !== 'running') return;
    const runtime = this.runtime.get(session.id);
    const status = ['completed', 'failed', 'interrupted'].includes(turn.status) ? turn.status : 'failed';
    // An interrupted item never completes; keep whatever text it streamed.
    for (const e of [...runtime.live]) if (runtime.live.includes(e)) this.settle(session, e.kind.split('.')[0], e.itemId);
    const final = turn.finalMessage;
    this.update(session, { status: status === 'completed' ? 'idle' : status, turnStartedAt: null,
      turns: session.turns + 1, lastMessage: final ?? runtime.finalMessage,
      lastLine: line(turn.error?.message || final || runtime.finalMessage || status) });
    this.emit(session.id, { kind: 'turn.completed', status, ...(turn.error?.message ? { error: turn.error.message } : {}) });
    this.persist();
    for (const done of this.waiters.get(session.id) || []) done();
  }
  event(id, event) {
    const session = this.records.get(id);
    if (!session || this.stopped) return;
    if (event.kind === 'settings.updated') { this.update(session, event.patch); return; }
    if (event.kind === 'execution.completed') {
      return this.finish(session, { ...event, status: this.stopping ? 'interrupted' : event.status });
    }
    if (session.status !== 'running') return;
    const runtime = this.runtime.get(id);
    const { final, activity, ...payload } = event;
    const { kind, itemId, text } = payload;
    if (kind === 'message.done' || kind === 'reasoning.done') {
      this.settle(session, kind.split('.')[0], itemId, text);
      if (kind === 'message.done' && final) runtime.finalMessage = text;
    } else this.emit(id, payload);
    if (kind.endsWith('.delta')) {
      runtime.texts ??= new Map();
      const key = kind + ':' + itemId;
      const partial = (runtime.texts.get(key) || '') + text;
      runtime.texts.set(key, partial.slice(-1000));
      this.activity(session, partial);
    } else if (kind === 'plan.updated') this.update(session, { plan: event.plan, lastLine: 'Plan updated' });
    else this.activity(session, activity || text || event.message || event.command || event.path || event.title || kind);
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
  create(p, identity) {
    if (this.stopping) throw fault('HUB_STOPPING', 'Hub is stopping');
    const owner = this.mutationOwner(identity);
    const cwd = directory(p.cwd, 'cwd');
    const task = this.createSession({ ...p, cwd }, owner);
    this.creating.add(task);
    task.finally(() => this.creating.delete(task)).catch(() => {});
    return task;
  }
  async createSession(p, owner) {
    const backend = p.backend === 'dsh' ? this.dsh : this.codex;
    const record = await backend.create(p);
    if (this.stopping) throw fault('HUB_STOPPING', 'Hub is stopping');
    const now = Date.now();
    const session = { ...record, title: p.title ?? p.prompt.split(/\r?\n/)[0].slice(0, 100), cwd: p.cwd,
      owner, status: 'idle', createdAt: now, turnStartedAt: null, lastActivityAt: now,
      lastLine: '', plan: [], turns: 0, lastMessage: null };
    this.records.set(session.id, session);
    this.runtime.set(session.id, { finalMessage: null, live: [] });
    this.emit(session.id, { kind: 'session.created', session }); this.persist();
    return this.serialize(session.id, () => this.startTurn(session, { prompt: p.prompt }, owner));
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
    if (session.status !== 'running') throw fault('NOT_RUNNING', 'Session is not running');
    await this.backend(session).steer(copy(session), p.text);
    this.emit(session.id, { kind: 'steer', text: p.text, by: callerOwner ?? null }); this.activity(session, p.text);
    return {};
  }
  async interrupt(session) {
    if (session.status !== 'running') return { result: {}, transferOwnership: false };
    await this.backend(session).interrupt(copy(session));
    return {};
  }
  rename(session, p) { this.update(session, { title: p.title }); return copy(session); }
  async configure(session, p) {
    const patch = await this.backend(session).configure(copy(session), p);
    this.update(session, patch);
    return copy(session);
  }
  archive(session) { this.archived.add(session.id); this.update(session, { archived: true }); return {}; }

  backendFailed(backend, error) {
    for (const session of this.records.values()) {
      if (!!session.dsh === (backend === 'dsh')) this.finish(session, { status: this.stopping ? 'interrupted' : 'failed', error });
    }
  }
}
