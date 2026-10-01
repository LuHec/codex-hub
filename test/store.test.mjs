import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.mjs';
import { Hub } from '../src/server.mjs';

test('v1 migration preserves sessions, archives and journals; v2 reload is idempotent', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hub-migrate-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.mkdirSync(path.join(directory, 'sessions'));
  const state = { version: 1, seq: 50, archived: ['one'], sessions: [
    { id: 'one', owner: 'alpha:a:b', title: 'preserved', status: 'idle' },
    { id: 'two', owner: 'legacy', status: 'running' },
    { id: 'three', owner: null, status: 'failed' },
  ] };
  const file = path.join(directory, 'state.json');
  fs.writeFileSync(file, JSON.stringify(state));
  const journal = path.join(directory, 'sessions', 'one.jsonl');
  const rows = [{ seq: 1, sessionId: 'one', kind: 'session.created', session: state.sessions[0] },
    { seq: 2, sessionId: 'one', kind: 'turn.started', by: 'alpha:a:b', prompt: 'p' }];
  const bytes = rows.map(e => JSON.stringify(e) + '\n').join('');
  fs.writeFileSync(journal, bytes);
  const store = new Store(directory); store.load();
  assert.deepEqual([...store.sessions.values()], [
    { ...state.sessions[0], owner: { harness: 'alpha', id: 'a:b' } },
    { ...state.sessions[1], owner: { harness: 'claude', id: 'legacy' } },
    state.sessions[2],
  ]);
  assert.deepEqual([...store.archived], ['one']);
  assert.equal(store.seq, 50);
  assert.equal(JSON.parse(fs.readFileSync(file)).version, 2);
  assert.equal(fs.readFileSync(journal, 'utf8'), bytes);
  assert.deepEqual(store.history('one')[0].session.owner, { harness: 'alpha', id: 'a:b' });
  assert.deepEqual(store.history('one')[1].by, { harness: 'alpha', id: 'a:b' });
  const migrated = fs.readFileSync(file, 'utf8');
  new Store(directory).load();
  assert.equal(fs.readFileSync(file, 'utf8'), migrated);
});

test('unsupported storage versions fail without replacing the state', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hub-future-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'state.json');
  const data = JSON.stringify({ version: 99, sessions: [{ id: 'precious' }] });
  fs.writeFileSync(file, data);
  const hub = new Hub({ directory, endpoint: 'unused', appFactory: () => ({ async close() {} }) });
  await assert.rejects(hub.start(), /Unsupported state version/);
  assert.equal(fs.readFileSync(file, 'utf8'), data);
  assert.equal(fs.existsSync(path.join(directory, 'hub.lock')), false);
});
