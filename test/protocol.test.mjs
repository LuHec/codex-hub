import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import readline from 'node:readline';
import { Hub } from '../src/server.mjs';
import { HubClient } from '../src/client.mjs';
import { methods, validate, fault } from '../src/protocol.mjs';
import { translate } from '../src/translate.mjs';
import { AppServer } from '../src/codex.mjs';

const catalog = [{ model: 'reported-model', isDefault: true, defaultReasoningEffort: 'reported-effort',
  supportedReasoningEfforts: [{ reasoningEffort: 'reported-effort' }] },
{ model: 'other-model', defaultReasoningEffort: 'other-effort', supportedReasoningEfforts: [{ reasoningEffort: 'other-effort' }] }];
async function fixture(t, discovery = catalog) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hub-protocol-'));
  const endpoint = process.platform === 'win32' ? String.raw`\\.\pipe\${path.basename(directory)}` : path.join(directory, 'hub.sock');
  const calls = [];
  let number = 0;
  const hub = new Hub({ directory, endpoint, appFactory: () => ({
    async start() {}, async close() {}, async request(method, params) {
      calls.push({ method, params });
      if (method === 'model/list') { if (discovery instanceof Error) throw discovery; return { data: discovery }; }
      if (method === 'thread/start') return { thread: { id: `thread-${++number}` } };
      if (method === 'turn/start') return { turn: { id: `turn-${number}` } };
      throw fault('CODEX_ERROR', 'app failure');
    },
  }) });
  const client = new HubClient({ endpoint, autoStart: false, owner: { harness: 'test', id: 'a:b' } });
  t.after(async () => { client.close(); await hub.stop(); fs.rmSync(directory, { recursive: true, force: true }); });
  await hub.start(); await client.connect();
  return { hub, client, directory, endpoint, calls };
}

test('every method declares a strict spec, mutation flag and handler', () => {
  const sample = { protocol: 1, client: 'cli', owner: { harness: 'test', id: 'a' }, cwd: '.', prompt: 'p', title: 't',
    model: 'm', effort: 'e', backend: 'dsh', dirs: ['.'], network: true, sandbox: 'workspace-write', id: 'id', force: true,
    afterSeq: 0, limit: 1, timeoutMs: 0, replay: 0, text: 't' };
  assert.equal(Object.keys(methods).length, 14);
  for (const entry of Object.values(methods)) {
    assert.equal(typeof entry.mutation, 'boolean');
    assert.equal(typeof entry.handler, 'function');
    const good = Object.fromEntries(Object.keys(entry.params).map(k => [k, sample[k]]));
    validate(good, entry.params);
    for (const bad of [null, [], 'params']) assert.throws(() => validate(bad, entry.params), { code: 'INVALID_PARAMS' });
    assert.throws(() => validate({ ...good, surprise: true }, entry.params), /surprise/);
    for (const field of Object.keys(entry.params)) {
      for (const bad of [null, {}, ...(field === 'dirs' ? [true] : [[]])]) assert.throws(() => validate({ ...good, [field]: bad }, entry.params), e => e.code === 'INVALID_PARAMS' && e.message.includes(field));
    }
    const required = Object.fromEntries(Object.entries(good).filter(([k]) => !entry.params[k].optional));
    validate(required, entry.params);
    for (const field of Object.keys(required)) {
      const missing = { ...required }; delete missing[field];
      assert.throws(() => validate(missing, entry.params), e => e.code === 'INVALID_PARAMS' && e.message.includes(field));
    }
  }
});

test('wire mismatch, invalid frames and owner shape have stable field-specific errors', async t => {
  const { client, endpoint } = await fixture(t);
  assert.equal(client.hello.protocol, 1);
  await assert.rejects(client.request('hello', { protocol: 2, client: 'cli' }), e => e.code === 'PROTOCOL_MISMATCH' && /codex-hub hub restart when idle/.test(e.message));
  for (const [owner, field] of [[null, 'owner'], [{ harness: 'UP', id: 'x' }, 'owner.harness'],
    [{ harness: 'ok', id: 'x y' }, 'owner.id'], [{ harness: 'ok', id: 'x', extra: 0 }, 'owner.extra']]) {
    await assert.rejects(client.request('hello', { protocol: 1, client: 'cli', owner }), e => e.code === 'INVALID_PARAMS' && e.message.includes(field));
  }
  const socket = net.connect(endpoint); t.after(() => socket.destroy());
  const reader = readline.createInterface({ input: socket }); t.after(() => reader.close());
  const next = () => new Promise(resolve => reader.once('line', row => resolve(JSON.parse(row))));
  for (const row of ['{broken', 'null', '[]', '{"id":1,"method":"subscribe","params":{"replay":true}}']) {
    const reply = next(); socket.write(row + '\n'); assert.equal((await reply).error.code, 'INVALID_PARAMS');
  }
});

test('catalog validates model and effort once at startup; codes distinguish session failures', async t => {
  const { hub, client, directory, calls } = await fixture(t);
  const create = p => client.request('session.create', { cwd: directory, prompt: 'p', ...p });
  for (const params of [{ model: 'unknown' }, { effort: 'unknown' }]) await assert.rejects(create(params), { code: 'INVALID_PARAMS' });
  const s = await create({});
  assert.equal(s.model, 'reported-model'); assert.equal(s.effort, 'reported-effort');
  await create({});
  assert.equal(calls.filter(c => c.method === 'model/list').length, 1);
  await assert.rejects(client.request('session.get', { id: 'missing' }), { code: 'NOT_FOUND' });
  await assert.rejects(client.request('session.get', { id: 'thread-' }), { code: 'AMBIGUOUS_ID' });
  await assert.rejects(client.request('no.such.method'), { code: 'NOT_FOUND' });
  await assert.rejects(client.request('session.send', { id: s.id, prompt: 'busy' }), { code: 'BUSY' });
  await assert.rejects(client.request('session.steer', { id: s.id, text: 'x' }), { code: 'CODEX_ERROR', message: 'app failure' });
  hub.sessions.finish(hub.sessions.resolve(s.id), { status: 'completed' });
  await assert.rejects(client.request('session.steer', { id: s.id, text: 'x' }), { code: 'NOT_RUNNING' });
  await assert.rejects(client.request('session.configure', { id: s.id, effort: 'wrong' }), { code: 'INVALID_PARAMS' });
  const changed = await client.request('session.configure', { id: s.id, model: 'other-model' });
  assert.equal(changed.effort, 'other-effort');
  await assert.rejects(client.request('session.send', { id: s.id, prompt: 'x', effort: 'reported-effort' }), { code: 'INVALID_PARAMS' });
  hub.stopping = true;
  await assert.rejects(client.request('session.list'), { code: 'HUB_STOPPING' });
});

test('unexpected handler failures are INTERNAL, not CODEX_ERROR', async t => {
  const { hub, client, directory } = await fixture(t);
  const session = await client.request('session.create', { cwd: directory, prompt: 'p' });
  hub.sessions.rename = () => { throw new TypeError('internal bug'); };
  await assert.rejects(client.request('session.rename', { id: session.id, title: 'x' }),
    { code: 'INTERNAL', message: 'internal bug' });
  assert.equal((await client.request('session.get', { id: session.id })).id, session.id);
});

test('failed discovery passes through model and effort', async t => {
  const { hub, client, directory, calls } = await fixture(t, new Error('catalog unavailable'));
  const s = await client.request('session.create', { cwd: directory, prompt: 'p', model: 'future-model', effort: 'future-effort' });
  assert.equal(s.model, 'future-model'); assert.equal(s.effort, 'future-effort');
  hub.sessions.finish(hub.sessions.resolve(s.id), { status: 'completed' });
  const next = await client.request('session.send', { id: s.id, prompt: 'p', model: 'another-model' });
  assert.equal(next.effort, null);
  assert.equal(calls.at(-1).params.effort, null);
});

test('catalog timeout is nonfatal and the next request remains usable', async () => {
  const app = new AppServer(() => {}, () => assert.fail('catalog timeout must not kill Codex'));
  app.write = () => {};
  await assert.rejects(app.request('model/list', {}, { timeoutMs: 5, fatal: false }), { code: 'CODEX_ERROR' });
  assert.equal(app.pending.size, 0);
  assert.equal(app.dead, undefined);
  const next = app.request('thread/start', {});
  const pending = app.pending.get(2);
  clearTimeout(pending.timer);
  app.pending.delete(2);
  pending.resolve({ thread: { id: 'still-alive' } });
  assert.equal((await next).thread.id, 'still-alive');
});

test('catalog pagination is fetched only during startup', async t => {
  const { hub } = await fixture(t);
  const pages = [];
  hub.app.request = async (method, p) => {
    assert.equal(method, 'model/list'); pages.push(p);
    return p.cursor ? { data: [catalog[1]], nextCursor: null } : { data: [catalog[0]], nextCursor: 'page-2' };
  };
  await hub.codex.start();
  assert.deepEqual(hub.codex.models, catalog);
  assert.deepEqual(pages, [{ includeHidden: true }, { includeHidden: true, cursor: 'page-2' }]);
});

test('translation is pure and ignores unknown notifications', () => {
  const p = { item: { type: 'fileChange', status: 'completed', changes: [{ path: 'a' }, { path: 'b' }] } };
  const before = structuredClone(p);
  assert.deepEqual(translate('item/completed', p), [{ kind: 'file.changed', path: 'a' }, { kind: 'file.changed', path: 'b' }]);
  assert.deepEqual(p, before);
  assert.deepEqual(translate('unknown', {}), []);
});
