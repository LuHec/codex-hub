import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { Sessions } from '../src/sessions.mjs';

// Exercise the service without a server, sockets or filesystem-backed store.
test('Sessions depends only on the injected store, app and event sink', async () => {
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
      if (method === 'turn/interrupt') sessions.notification('turn/completed', {
        threadId: params.threadId, turn: { id: 'turn-1', status: 'interrupted' },
      });
      return {};
    },
  };
  const sessions = new Sessions({ store, app, onEvent: event => events.push(event) });
  sessions.load(); await sessions.start();
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
