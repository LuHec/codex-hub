import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hub } from '../src/server.mjs';
import { Store } from '../src/store.mjs';
import { HubClient } from '../src/client.mjs';

function fixture(t, listing, rows = ['active', 'archived', 'deleted', 'dsh']) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-startup-sync-'));
  fs.mkdirSync(path.join(directory, 'sessions'));
  const store = new Store(directory);
  const sessions = rows.map(id => ({ id, title: id, status: 'idle', turnStartedAt: null,
    ...(id === 'dsh' ? { dsh: { sessionId: 'native-dsh' } } : {}) }));
  store.persist({ seq: 10, sessions, archived: ['archived'], deleted: [] });
  for (const session of sessions) store.append({ seq: 1, sessionId: session.id, kind: 'session.created', session });
  const calls = [];
  const hub = new Hub({ directory,
    endpoint: process.platform === 'win32' ? `\\\\.\\pipe\\${path.basename(directory)}` : path.join(directory, 'hub.sock'),
    appFactory: () => ({ async start() { calls.push('start'); }, async close() {},
      async request(method, params, options) {
        calls.push({ method, params, options });
        if (method === 'thread/list') return listing(params);
        return {};
      } }),
    dshFactory: () => ({ snapshot() { return {}; }, async activeThreadIds() { return new Set(['dsh']); }, async close() {} }),
  });
  t.after(async () => { await hub.stop(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { hub, store, calls };
}

test('startup reconciles all pages before serving lists, deletes journals, and preserves DSH', async t => {
  let release, entered;
  const secondPage = new Promise(resolve => { entered = resolve; });
  const { hub, store, calls } = fixture(t, async p => {
    if (!p.cursor) return { data: [{ id: 'unrelated' }], nextCursor: 'page-2' };
    entered();
    return new Promise(resolve => { release = () => resolve({ data: [{ id: 'active' }], nextCursor: null }); });
  });
  const starting = hub.start();
  await secondPage;
  const client = new HubClient({ endpoint: hub.endpoint, autoStart: false });
  t.after(() => client.close());
  await client.connect();
  let served = false;
  const listing = client.request('session.list').then(rows => { served = true; return rows; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(served, false);
  assert.equal(fs.existsSync(store.eventPath('deleted')), true);
  release();
  await starting;
  assert.deepEqual((await listing).map(s => s.id).sort(), ['active', 'dsh']);
  for (const id of ['archived', 'deleted']) {
    assert.throws(() => hub.sessions.resolve(id), { code: 'NOT_FOUND' });
    assert.equal(fs.existsSync(store.eventPath(id)), false);
  }
  assert.equal(fs.existsSync(store.eventPath('dsh')), true);
  const requests = calls.filter(c => c.method === 'thread/list');
  assert.equal(requests.length, 2);
  assert.equal(requests[0].params.archived, false);
  assert.deepEqual(requests[0].params.modelProviders, []);
  assert.ok(requests[0].params.sourceKinds.includes('appServer'));
  assert.ok(requests[0].params.sourceKinds.includes('exec'));
  assert.equal(requests[0].options.fatal, false);
  await client.request('session.list');
  await client.subscribe(() => {});
  assert.equal(calls.filter(c => c.method === 'thread/list').length, 2);
  client.close();
  await hub.stop();
  // Simulate a journal left behind by a crash after the tombstone commit.
  store.append({ seq: 999, sessionId: 'deleted', kind: 'session.created', session: { id: 'deleted' } });
  const reloaded = new Store(store.directory).load();
  assert.deepEqual(reloaded.sessions.map(s => s.id).sort(), ['active', 'dsh']);
  assert.deepEqual(reloaded.archived, []);
  assert.deepEqual(reloaded.deleted.sort(), ['archived', 'deleted']);
  assert.equal(fs.existsSync(store.eventPath('deleted')), false);
});

for (const failure of ['later-page-error', 'malformed', 'missing-cursor', 'repeated-cursor']) {
  test(`startup preserves every local record on ${failure}`, async t => {
    const errors = [];
    t.mock.method(console, 'error', message => errors.push(message));
    const { hub, store } = fixture(t, p => {
      if (!p.cursor) return { data: [], nextCursor: 'next' };
      if (failure === 'later-page-error') throw new Error('query unavailable');
      if (failure === 'malformed') return { data: [{ id: null }], nextCursor: null };
      if (failure === 'missing-cursor') return { data: [] };
      return { data: [], nextCursor: 'next' };
    });
    await hub.start();
    assert.equal(hub.sessions.records.size, 4);
    assert.equal(hub.sessions.deleted.size, 0);
    for (const id of hub.sessions.records.keys()) assert.ok(fs.existsSync(store.eventPath(id)));
    assert.ok(errors.some(e => e.includes('Codex startup sync failed')));
  });
}

test('empty successful Codex list removes all Codex records but keeps DSH', async t => {
  const { hub } = fixture(t, () => ({ data: [], nextCursor: null }));
  await hub.start();
  assert.deepEqual([...hub.sessions.records.keys()], ['dsh']);
});

test('DSH query failure preserves DSH records while Codex reconciliation succeeds', async t => {
  t.mock.method(console, 'error', () => {});
  const { hub, store } = fixture(t, () => ({ data: [], nextCursor: null }));
  hub.dsh.activeThreadIds = async () => { throw Error('DSH unavailable'); };
  await hub.start();
  assert.deepEqual([...hub.sessions.records.keys()], ['dsh']);
  assert.ok(fs.existsSync(store.eventPath('dsh')));
});

test('Codex query failure does not prevent DSH cleanup', async t => {
  t.mock.method(console, 'error', () => {});
  const { hub, store } = fixture(t, () => { throw Error('Codex unavailable'); });
  hub.dsh.activeThreadIds = async () => new Set();
  await hub.start();
  assert.deepEqual([...hub.sessions.records.keys()].sort(), ['active', 'archived', 'deleted']);
  assert.equal(fs.existsSync(store.eventPath('dsh')), false);
});

for (const rows of [[], ['dsh']]) {
  test(`startup without Codex records never starts Codex (${rows.length} local records)`, async t => {
    const { hub, calls } = fixture(t, () => { throw new Error('unexpected query'); }, rows);
    await hub.start();
    assert.deepEqual(calls, []);
  });
}
