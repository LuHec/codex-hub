import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Hub } from '../src/server.mjs';
import { HubClient } from '../src/client.mjs';
import { sameOwner } from '../src/config.mjs';
const owner = value => { const [harness, id] = value.split(':'); return { harness, id }; };
import { ownerTag } from '../src/tui/view.mjs';

const methods = {
  'session.send': { prompt: 'next' },
  'session.steer': { text: 'adjust' },
  'session.interrupt': {},
  'session.configure': { effort: 'high' },
  'session.rename': { title: 'renamed' },
  'session.archive': {},
};

class FakeApp {
  constructor({ onNotification }) { this.notify = onNotification; this.calls = []; this.number = 0; }
  async start() {}
  async close() {}
  async request(method, params) {
    this.calls.push({ method, params });
    await this.beforeRequest?.(method, params);
    if (method === this.failMethod) throw new Error('app rejected operation');
    if (method === 'thread/start') return { thread: { id: `thread-${++this.number}` } };
    if (method === 'turn/start') {
      const turn = { id: `turn-${this.calls.length}`, status: 'inProgress' };
      this.notify('turn/started', { threadId: params.threadId, turn });
      return { turn };
    }
    if (method === 'turn/interrupt') this.complete(params.threadId, 'interrupted');
    return {};
  }
  complete(id, status = 'completed') {
    this.notify('turn/completed', { threadId: id,
      turn: { status } });
  }
}

async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hub-guard-'));
  const endpoint = process.platform === 'win32'
    ? `\\\\.\\pipe\\${path.basename(directory)}-${process.pid}` : path.join(directory, 'hub.sock');
  const hub = new Hub({ directory, endpoint, appFactory: h => new FakeApp(h) });
  const clients = [];
  t.after(async () => {
    clients.forEach(c => c.close());
    await hub.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  await hub.start();
  const connect = async (owner = null, client) => {
    const c = new HubClient({ endpoint, autoStart: false, owner, ...(client ? { client } : {}) });
    clients.push(c);
    await c.connect();
    return c;
  };
  const create = (client, params = {}) => client.request('session.create', { cwd: directory, prompt: 'work', ...params });
  return { hub, directory, endpoint, connect, create };
}

test('both harnesses are blocked on all six mutations; same harness and reads remain allowed', async t => {
  const { hub, connect, create } = await fixture(t);
  const a = await connect(owner('alpha:a'));
  const b = await connect(owner('beta:b'));
  for (const [creator, caller, expectedOwner, callerOwner] of [
    [a, b, owner('alpha:a'), owner('beta:b')], [b, a, owner('beta:b'), owner('alpha:a')],
  ]) {
    const s = await create(creator);
    const before = structuredClone(hub.sessions.resolve(s.id));
    const calls = hub.app.calls.length;
    for (const [method, params] of Object.entries(methods)) {
      await assert.rejects(caller.request(method, { id: s.id, ...params }), error => {
        assert.deepEqual(error.code, 'OWNER_MISMATCH');
        assert.deepEqual(error.sessionId, s.id);
        assert.deepEqual(error.title, s.title);
        assert.deepEqual(error.owner, expectedOwner);
        assert.deepEqual(error.caller, callerOwner);
        assert.ok(error.message.indexOf('ls --mine') < error.message.indexOf('--force'));
        assert.ok(error.message.includes(`show ${s.id}`));
        return true;
      });
    }
    assert.deepEqual(hub.sessions.resolve(s.id), before);
    assert.deepEqual(hub.app.calls.length, calls);
    assert.deepEqual((await caller.request('session.get', { id: s.id })).owner, expectedOwner);
    assert.deepEqual((await caller.request('session.wait', { id: s.id, timeoutMs: 0 })).status, 'running');
    await caller.request('session.events', { id: s.id });
  }
  const same = await connect(owner('alpha:other'));
  const s = await create(a);
  assert.deepEqual((await same.request('session.rename', { id: s.id, title: 'same harness' })).owner, owner('alpha:a'));
});

test('same-harness force transfers to a new controller ID; ordinary mutations preserve it', async t => {
  const { connect, create } = await fixture(t);
  const a = await connect(owner('alpha:a'));
  const b = await connect(owner('alpha:b'));
  const s = await create(a);
  assert.deepEqual((await b.request('session.rename', { id: s.id, title: 'ordinary' })).owner, owner('alpha:a'));
  assert.deepEqual((await b.request('session.rename', { id: s.id, title: 'takeover', force: true })).owner, owner('alpha:b'));
});

test('force transfers after every successful mutation, persists, broadcasts, and blocks the previous harness', async t => {
  const { hub, directory, connect, create } = await fixture(t);
  const a = await connect(owner('alpha:a'));
  const b = await connect(owner('beta:b'));
  const observer = await connect(null, 'tui');
  const events = [];
  await observer.subscribe(e => events.push(e));
  for (const [method, params] of Object.entries(methods)) {
    const s = await create(a);
    if (method === 'session.send') hub.app.complete(s.id);
    const result = await b.request(method, { id: s.id, ...params, force: true });
    assert.deepEqual(hub.sessions.resolve(s.id).owner, owner('beta:b'));
    if (result.id) assert.deepEqual(result.owner, owner('beta:b'));
    const state = JSON.parse(fs.readFileSync(path.join(directory, 'state.json'), 'utf8'));
    assert.deepEqual(state.sessions.find(row => row.id === s.id).owner, owner('beta:b'));
    await assert.rejects(a.request('session.rename', { id: s.id, title: 'old owner' }), { code: 'OWNER_MISMATCH' });
    await observer.request('session.get', { id: s.id });
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(events.some(e => e.kind === 'session.updated' && e.sessionId === s.id && sameOwner(e.session.owner, owner('beta:b'))));
  }
});

test('force does not bypass validation, running-turn rules, app failures, or transfer on an idle interrupt', async t => {
  const { hub, connect, create } = await fixture(t);
  const a = await connect(owner('alpha:a'));
  const b = await connect(owner('beta:b'));
  const s = await create(a);
  for (const [method, params] of [
    ['session.send', { prompt: 'busy' }],
    ['session.configure', {}],
    ['session.configure', { sandbox: 'invalid' }],
    ['session.rename', { title: '' }],
    ['session.steer', { text: '' }],
  ]) {
    await assert.rejects(b.request(method, { id: s.id, ...params, force: true }));
    assert.deepEqual(hub.sessions.resolve(s.id).owner, owner('alpha:a'));
  }
  await assert.rejects(b.request('session.rename', { id: s.id, title: 'wrong force type', force: 'true' }), { code: 'INVALID_PARAMS' });
  hub.app.failMethod = 'turn/steer';
  await assert.rejects(b.request('session.steer', { id: s.id, text: 'rejected', force: true }), /app rejected/);
  assert.deepEqual(hub.sessions.resolve(s.id).owner, owner('alpha:a'));
  hub.app.complete(s.id);
  await b.request('session.interrupt', { id: s.id, force: true });
  assert.deepEqual(hub.sessions.resolve(s.id).owner, owner('alpha:a'));
  await assert.rejects(b.request('session.steer', { id: s.id, text: 'late', force: true }), /not running/);
  await assert.rejects(b.request('session.send', { id: s.id, prompt: '', force: true }), /nonempty/);
  hub.app.failMethod = 'turn/start';
  await assert.rejects(b.request('session.send', { id: s.id, prompt: 'rejected', force: true }), /app rejected/);
  assert.deepEqual(hub.sessions.resolve(s.id).owner, owner('alpha:a'));
});

test('TUI bypasses all six gates and preserves owner, with or without an inherited owner', async t => {
  const { hub, connect, create } = await fixture(t);
  const a = await connect(owner('alpha:a'));
  for (const identity of [null, owner('beta:inherited')]) {
    const tui = await connect(identity, 'tui');
    for (const [method, params] of Object.entries(methods)) {
      const s = await create(a);
      if (method === 'session.send') hub.app.complete(s.id);
      await tui.request(method, { id: s.id, ...params });
      assert.deepEqual(hub.sessions.resolve(s.id).owner, owner('alpha:a'));
    }
  }
});

test('ownerless sessions are adopted only after a successful non-TUI mutation', async t => {
  const { hub, connect, create } = await fixture(t);
  const tui = await connect(null, 'tui');
  const b = await connect(owner('beta:b'));
  const s = await create(tui);
  await tui.request('session.rename', { id: s.id, title: 'human change' });
  assert.deepEqual(hub.sessions.resolve(s.id).owner, null);
  await assert.rejects(b.request('session.send', { id: s.id, prompt: 'busy' }), /already running/);
  assert.deepEqual(hub.sessions.resolve(s.id).owner, null);
  hub.app.complete(s.id);
  await b.request('session.interrupt', { id: s.id });
  assert.deepEqual(hub.sessions.resolve(s.id).owner, null);
  assert.deepEqual((await b.request('session.configure', { id: s.id, effort: 'low' })).owner, owner('beta:b'));
});

test('missing owner rejects create and all mutations, including force; malformed owners fail hello', async t => {
  const { hub, connect, create } = await fixture(t);
  const a = await connect(owner('alpha:a'));
  const s = await create(a);
  const c = await connect();
  await assert.rejects(create(c), { code: 'OWNER_REQUIRED' });
  for (const [method, params] of Object.entries(methods)) {
    await assert.rejects(c.request(method, { id: s.id, ...params, force: true }), { code: 'OWNER_REQUIRED', sessionId: s.id });
  }
  assert.deepEqual((await c.request('session.get', { id: s.id })).owner, owner('alpha:a'));
  for (const malformed of ['', 'bare-id', 42, {}, { harness: 'Alpha', id: 'a' }, { harness: 'a', id: ' ' }, { harness: 'a', id: 'b', extra: true }]) {
    await assert.rejects(connect(malformed), { code: 'INVALID_PARAMS' });
  }
});

test('hello fixes identity and create rejects owner overrides as unknown fields', async t => {
  const { hub, directory, connect, create } = await fixture(t);
  const a = await connect(owner('alpha:a'));
  await assert.rejects(a.request('hello', { protocol: 1, client: 'tui' }), { code: 'INVALID_PARAMS' });
  await assert.rejects(create(a, { owner: owner('beta:b') }), { code: 'INVALID_PARAMS' });
  await assert.rejects(hub.dispatch({ identity: null }, 'session.create', { cwd: directory, prompt: 'work' }), { code: 'OWNER_REQUIRED' });
  const tui = await connect(null, 'tui');
  assert.equal((await create(tui)).owner, null);
});

test('queued mutations check the owner after the preceding force operation commits', async t => {
  const { hub, connect, create } = await fixture(t);
  const a = await connect(owner('alpha:a'));
  const b = await connect(owner('beta:b'));
  const s = await create(a);
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  hub.app.beforeRequest = async method => {
    if (method === 'turn/steer') { entered(); await held; }
  };
  const takeover = b.request('session.steer', { id: s.id, text: 'take over', force: true });
  await started;
  assert.deepEqual(hub.sessions.resolve(s.id).owner, owner('alpha:a'));
  const queued = assert.rejects(hub.dispatch([...hub.clients].find(c => sameOwner(c.identity?.owner, owner('alpha:a'))),
    'session.rename', { id: s.id, title: 'stale check' }), { code: 'OWNER_MISMATCH' });
  release();
  await takeover;
  await queued;
  assert.deepEqual(hub.sessions.resolve(s.id).title, s.title);
});

function runNode(args, env) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, args, { env, windowsHide: true, timeout: 15000 }, (error, stdout, stderr) => {
      if (error && typeof error.code !== 'number') return reject(error);
      resolve({ code: error?.code ?? 0, stdout, stderr });
    });
  });
}

test('CLI force and JSON errors use only the isolated test hub; strict environment parsing and --mine use object identities', async t => {
  const { hub, directory, endpoint, connect, create } = await fixture(t);
  const a = await connect(owner('alpha:a'));
  const s = await create(a);
  const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
  const env = { ...process.env, CODEX_HUB_ENDPOINT: endpoint, CODEX_HUB_HOME: directory,
    CODEX_HUB_OWNER: 'beta:b' };
  const blocked = await runNode([cli, 'rename', s.id, 'wrong', '--json'], env);
  assert.deepEqual(blocked.code, 1);
  assert.deepEqual(blocked.stdout, '');
  const { error } = JSON.parse(blocked.stderr);
  assert.deepEqual(error.code, 'OWNER_MISMATCH');
  assert.deepEqual(error.sessionId, s.id);
  assert.deepEqual(error.title, s.title);
  assert.deepEqual(error.owner, owner('alpha:a'));
  assert.deepEqual(error.caller, owner('beta:b'));
  const parseError = await runNode([cli, '--json', '--unknown-option'], env);
  assert.deepEqual(parseError.code, 1);
  assert.deepEqual(JSON.parse(parseError.stderr).error.code, 'ERR_PARSE_ARGS_UNKNOWN_OPTION');
  const mine = await runNode([cli, 'ls', '--mine', '--json'], { ...env, CODEX_HUB_OWNER: 'alpha:a' });
  assert.equal(JSON.parse(mine.stdout)[0].id, s.id);
  for (const value of ['a', '', 'bad harness:id']) {
    const result = await runNode([cli, 'ls', '--mine', '--json'], { ...env, CODEX_HUB_OWNER: value });
    assert.equal(result.code, 1);
    assert.equal(JSON.parse(result.stderr).error.code, 'INVALID_PARAMS');
  }
  for (const [command, rest] of [
    ['rename', ['taken']], ['config', ['--effort', 'high']], ['steer', ['adjust']],
    ['stop', []], ['send', ['next']], ['archive', []],
  ]) {
    // Reset through the same successful ownership-transfer path, never by editing state.
    await a.request('session.rename', { id: s.id, title: 'reset', force: true });
    const forced = await runNode([cli, command, s.id, ...rest, '--force', '--json'], env);
    assert.deepEqual(forced.code, 0, forced.stderr);
    assert.deepEqual(hub.sessions.resolve(s.id).owner, owner('beta:b'));
  }
});

test('TUI displays harness plus short ID', () => {
  assert.equal(ownerTag(owner('alpha:abcdef')), 'alpha:abcd');
  assert.equal(ownerTag(owner('beta:abcdef')), 'beta:abcd');
  assert.equal(ownerTag(null), '—');
});
