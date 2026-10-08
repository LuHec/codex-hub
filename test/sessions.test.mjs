import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { Codex } from '../src/codex-backend.mjs';
import { Sessions } from '../src/sessions.mjs';

// Exercise the service without a server, sockets or filesystem-backed store.
test('Sessions depends only on the injected store, backend and event sink', async () => {
  let snapshot = { seq: 0, sessions: [], archived: [] };
  const journal = [], events = [], calls = [];
  const store = {
    load: () => structuredClone(snapshot),
    persist: state => { snapshot = structuredClone(state); },
    append: event => journal.push(structuredClone(event)),
    history: id => journal.filter(e => e.sessionId === id),
  };
  const app = {
    async start() {}, async close() {},
    async request(method, params) {
      calls.push(method);
      if (method === 'thread/start') return { thread: { id: 'thread-1' } };
      if (method === 'turn/start') return { turn: { id: 'turn-1' } };
      if (method === 'turn/interrupt') codex.notification('turn/completed', {
        threadId: params.threadId, turn: { id: 'turn-1', status: 'interrupted' },
      });
      return {};
    },
  };
  const codex = new Codex({ app, onEvent: (id, event) => sessions.event(id, event) });
  const sessions = new Sessions({ store, codex, onEvent: event => events.push(event) });
  sessions.load();
  const owner = { client: 'cli', owner: { harness: 'first', id: 'a' } };
  const caller = { client: 'cli', owner: { harness: 'second', id: 'b' } };
  try {
    const created = await sessions.create({ cwd: os.tmpdir(), prompt: 'work' }, owner);
    const session = sessions.resolve(created.id);
    const abort = new AbortController();
    const wait = sessions.wait(session, undefined, abort.signal);
    abort.abort();
    assert.equal((await wait).status, 'running');
    assert.equal(sessions.waiters.size, 0);
    await sessions.mutate(session, { force: true }, caller, () => sessions.interrupt(session));
    assert.deepEqual(session.owner, caller.owner);
    assert.equal(session.status, 'interrupted');
    const before = calls.length;
    assert.deepEqual(await sessions.interrupt(session), { result: {}, transferOwnership: false });
    assert.deepEqual(await sessions.mutate(session, { force: true }, owner, () => sessions.interrupt(session)), {});
    assert.equal(calls.length, before);
    assert.deepEqual(snapshot.sessions[0].owner, caller.owner);
    assert.deepEqual(sessions.events(created.id), journal);
    assert.ok(events.some(e => e.kind === 'session.updated'));
  } finally { await sessions.stop(); }
});

test('shutdown drains an admitted creation without publishing a late session', async () => {
  const events = [];
  let created;
  const backend = {
    create: () => new Promise(resolve => { created = resolve; }),
    close: async () => { created({ id: 'late', model: 'test' }); },
  };
  const store = { load: () => ({ sessions: [], archived: [], seq: 0 }), persist() {}, append() {}, history: () => [] };
  const sessions = new Sessions({ store, codex: backend, onEvent: event => events.push(event) });
  sessions.load();
  const creation = sessions.create({ cwd: os.tmpdir(), prompt: 'work' }, { client: 'tui' });
  const rejected = assert.rejects(creation, { code: 'HUB_STOPPING' });
  await sessions.stop(); await rejected;
  assert.equal(sessions.records.size, 0);
  assert.equal(sessions.creating.size, 0);
  assert.equal(sessions.stopped, true);
  assert.deepEqual(events, []);
});
