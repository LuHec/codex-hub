import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { Hub } from '../src/server.mjs';
import { HubClient } from '../src/client.mjs';
import { Dsh, translateDsh } from '../src/dsh.mjs';
import { Model } from '../src/tui/model.mjs';
import { loadModels } from '../src/tui/models.mjs';
import { render } from '../src/tui/view.mjs';
import { renderFocus } from '../src/tui/focus.mjs';

const command = fileURLToPath(new URL('./fixtures/dsh.mjs', import.meta.url));
test('DSH startup removes deleted and archived sessions and keeps resumable sessions', async t => {
  const f = await fixture(t);
  const created = [];
  for (let i = 0; i < 3; i++) {
    const session = await f.client.request('session.create', { backend: 'dsh', cwd: f.directory, prompt: 'hello' });
    await f.client.request('session.wait', { id: session.id });
    created.push(session);
  }
  const [active, archived, deleted] = created;
  fs.unlinkSync(path.join(f.directory, 'dsh', deleted.dsh.id));
  const storage = path.join(f.directory, 'dsh', 'storages');
  fs.mkdirSync(storage);
  fs.writeFileSync(path.join(storage, 'workspace.json'), JSON.stringify({ unit: { name: 'workspace', version: 2 },
    global: { initialized: true, workspaceIds: [], archivedSessionIds: [archived.dsh.id] }, tables: {} }));
  await f.restart();
  assert.deepEqual((await f.client.request('session.list')).map(s => s.id), [active.id]);
  for (const session of [archived, deleted]) {
    assert.equal(fs.existsSync(f.hub.sessions.store.eventPath(session.id)), false);
    await assert.rejects(f.client.request('session.get', { id: session.id }), { code: 'NOT_FOUND' });
  }
  assert.ok(fs.existsSync(path.join(f.directory, 'dsh', archived.dsh.id)));
  await f.client.request('session.send', { id: active.id, prompt: 'continue' });
  assert.equal((await f.client.request('session.wait', { id: active.id })).status, 'idle');
  await f.restart();
  assert.deepEqual((await f.client.request('session.list')).map(s => s.id), [active.id]);
});

test('DSH startup rejects partial pages, unsupported listing, loaded sessions and malformed archives', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-sync-validation-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const dsh = new Dsh({ directory, home: directory });
  dsh.start = async () => {};
  await assert.rejects(dsh.activeThreadIds(), /does not offer/);
  dsh.sessionCapabilities = { list: {} };
  dsh.sessions.set('loaded', {});
  await assert.rejects(dsh.activeThreadIds(), /unloaded/);
  dsh.sessions.clear();
  dsh.request = async () => ({ sessions: [{ sessionId: 'active' }], nextCursor: 'loop' });
  await assert.rejects(dsh.activeThreadIds(), /Repeated/);
  dsh.request = async () => ({ sessions: [{ sessionId: null }] });
  await assert.rejects(dsh.activeThreadIds(), /Invalid/);
  dsh.request = async (_, p) => {
    if (p.cursor) throw Error('later page unavailable');
    return { sessions: [], nextCursor: 'second' };
  };
  await assert.rejects(dsh.activeThreadIds(), /later page/);
  dsh.request = async () => ({ sessions: [{ sessionId: 'active' }, { sessionId: 'archived' }] });
  fs.mkdirSync(path.join(directory, 'storages', 'workspace'), { recursive: true });
  const file = path.join(directory, 'storages', 'workspace', 'global.json');
  fs.writeFileSync(file, '{broken');
  await assert.rejects(dsh.activeThreadIds());
  fs.writeFileSync(file, JSON.stringify({ version: 2, record: { initialized: true, workspaceIds: [], archivedSessionIds: ['archived'] } }));
  assert.deepEqual([...await dsh.activeThreadIds()], ['dsh:active']);
});

test('DSH listing timeout does not kill the ACP connection', async () => {
  const dsh = new Dsh({ directory: os.tmpdir(), onExit() { assert.fail('must not exit'); } });
  dsh.write = () => {};
  await assert.rejects(dsh.request('session/list', {}, 5, { fatal: false }), /timed out/);
  assert.equal(dsh.dead, undefined);
  assert.equal(dsh.pending.size, 0);
  dsh.write = msg => dsh.receive({ id: msg.id, result: { sessions: [] } });
  assert.deepEqual(await dsh.request('session/list', {}), { sessions: [] });
});
async function fixture(t, codexMissing = false) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-dsh-test-'));
  const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\${path.basename(directory)}` : path.join(directory, 'hub.sock');
  const calls = [];
  const cleanup = [];
  const build = () => new Hub({ directory, endpoint,
    appFactory: () => ({ async start() { if (codexMissing) throw Error('Codex unavailable'); }, async close() {}, async request(method) {
      calls.push(method);
      if (method === 'model/list') return { data: [] };
      if (method === 'thread/start') return { thread: { id: 'codex-native' } };
      if (method === 'turn/start') return { turn: { id: 'codex-turn' } };
      return {};
    } }), dshFactory: options => new Dsh({ ...options, command, home: path.join(directory, 'dsh') }),
  });
  let hub = build();
  let client;
  const connect = async () => {
    client = new HubClient({ endpoint, autoStart: false, owner: { harness: 'test', id: 'dsh' } });
    await hub.start(); await client.connect();
  };
  t.after(async () => {
    for (const close of cleanup) await close();
    client?.close(); await hub.stop();
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  await connect();
  return { directory, endpoint, calls, cleanup, get hub() { return hub; }, get client() { return client; },
    async restart() { client.close(); await hub.stop(); hub = build(); await connect(); } };
}

test('DSH ACP: create, events, follow-up, isolated cancellation, persistence and resume', async t => {
  const f = await fixture(t);
  const request = (method, params) => f.client.request(method, params);
  const create = prompt => request('session.create', { backend: 'dsh', cwd: f.directory, prompt });
  const one = await create('hello');
  assert.equal(one.id, 'dsh:native-1');
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.directory, 'hub.lock'))).dshPid, f.hub.dsh.proc.pid);
  const done = await request('session.wait', { id: one.id, timeoutMs: 3000 });
  assert.equal(done.status, 'idle'); assert.equal(done.lastMessage, '完成 hello');
  assert.equal(done.model, 'flash');
  const events = await request('session.events', { id: one.id });
  assert.ok(events.some(e => e.kind === 'tool.updated' && e.title === 'read_file'));
  assert.ok(events.some(e => e.kind === 'message.done' && e.text === '完成 hello'));
  assert.ok(!events.some(e => e.kind.endsWith('.delta')));
  assert.ok(fs.existsSync(path.join(f.directory, 'sessions', 'dsh%3Anative-1.jsonl')));
  const two = await create('hold');
  await request('session.send', { id: one.id, prompt: 'hold' });
  const wait = request('session.wait', { id: one.id, timeoutMs: 3000 });
  await request('session.interrupt', { id: one.id });
  assert.equal((await wait).status, 'interrupted');
  assert.equal((await request('session.get', { id: two.id })).status, 'running');
  await request('session.configure', { id: one.id, model: 'pro', effort: 'max' });
  assert.equal((await request('session.get', { id: one.id })).model, 'pro');
  await assert.rejects(request('session.steer', { id: two.id, text: 'change' }), { code: 'UNSUPPORTED' });
  await assert.rejects(request('session.configure', { id: one.id, model: 'gpt-codex' }), { code: 'INVALID_PARAMS' });
  await assert.rejects(request('session.configure', { id: one.id, backend: 'codex' }), { code: 'INVALID_PARAMS' });
  assert.deepEqual(f.calls, []);
  await request('session.configure', { id: two.id, model: 'pro', effort: 'max' });
  assert.equal((await request('session.get', { id: two.id })).status, 'running');
  await f.restart();
  await request('session.send', { id: one.id, prompt: 'again' });
  const resumed = await request('session.wait', { id: one.id, timeoutMs: 3000 });
  assert.equal(resumed.lastMessage, '完成 again');
  assert.equal(resumed.model, 'pro'); assert.equal(resumed.effort, 'max');
  assert.equal(resumed.turns, 3);
  assert.equal((await request('session.events', { id: one.id })).filter(e => e.kind === 'turn.started').length, 3);
});

test('DSH works without Codex; unsupported access is rejected before spawning', async t => {
  const f = await fixture(t, true);
  await assert.rejects(f.client.request('session.create', { backend: 'dsh', cwd: f.directory, prompt: 'hello', network: true }), { code: 'UNSUPPORTED' });
  assert.equal(f.hub.dsh.proc, undefined);
  const s = await f.client.request('session.create', { backend: 'dsh', cwd: f.directory, prompt: 'hello' });
  assert.equal((await f.client.request('session.wait', { id: s.id, timeoutMs: 3000 })).lastMessage, '完成 hello');
  assert.deepEqual(f.calls, []);
  await assert.rejects(f.client.request('session.create', { cwd: f.directory, prompt: 'hello' }), /Codex unavailable/);
  assert.equal((await f.client.request('session.get', { id: s.id })).status, 'idle');
});

test('TUI keyboard creates DSH, preserves a mid-turn draft, stops and sends it', async t => {
  const f = await fixture(t);
  const ui = spawn(process.execPath, [fileURLToPath(new URL('../src/tui/index.mjs', import.meta.url))], {
    cwd: f.directory, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CODEX_HUB_ENDPOINT: f.endpoint, CODEX_HUB_HOME: f.directory, CODEX_HUB_OWNER: 'test:tui' },
  });
  let output = '', stderr = '';
  ui.stdout.setEncoding('utf8').on('data', text => { output += text; });
  ui.stderr.setEncoding('utf8').on('data', text => { stderr += text; });
  const exited = new Promise(resolve => ui.on('exit', resolve));
  f.cleanup.push(async () => { ui.kill(); await exited; });
  const until = async predicate => {
    const end = Date.now() + 6000;
    while (!await predicate()) {
      if (Date.now() > end) throw Error(`TUI timeout: ${stderr}\n${output.slice(-1500)}`);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  };
  const key = async (text, expected) => {
    output = ''; ui.stdin.write(text);
    if (expected) await until(() => output.includes(expected));
  };
  await until(() => output.includes('codex-hub'));
  await key('n', 'new: codex / dsh');
  await key('\r', 'workspace');
  await key('\r', 'task');
  await key('hold', 'hold');
  await key('\r', "talking to DSH");
  const session = (await f.client.request('session.list')).find(s => s.dsh);
  assert.ok(session);
  await key('draft', 'draft');
  await key('\r', 'esc to stop');
  assert.equal((await f.client.request('session.get', { id: session.id })).status, 'running');
  await key('\x1b');
  await until(async () => (await f.client.request('session.get', { id: session.id })).status === 'interrupted');
  await key('\r');
  await until(async () => (await f.client.request('session.get', { id: session.id })).lastMessage === '完成 draft');
  assert.deepEqual(f.calls, []);
});

test('DSH provider failure, token limit and process exit remain DSH failures', async t => {
  const f = await fixture(t);
  const codex = await f.client.request('session.create', { cwd: f.directory, prompt: 'hold' });
  for (const prompt of ['error', 'limit', 'crash']) {
    const s = await f.client.request('session.create', { backend: 'dsh', cwd: f.directory, prompt });
    assert.equal((await f.client.request('session.wait', { id: s.id, timeoutMs: 3000 })).status, 'failed');
  }
  assert.equal((await f.client.request('session.get', { id: codex.id })).status, 'running');
  assert.deepEqual(f.calls, ['model/list', 'thread/start', 'turn/start']);
});

test('ACP replies to owned permission requests and leaves other requests unsupported', () => {
  const replies = [];
  const dsh = new Dsh({ directory: os.tmpdir(), onEvent() {}, onExit() {} });
  dsh.write = message => replies.push(message);
  dsh.sessions.set('owned', {});
  dsh.receive({ id: 1, method: 'session/request_permission', params: { sessionId: 'owned', options: [
    { optionId: 'yes', kind: 'allow_once' }, { optionId: 'no', kind: 'reject_once' },
  ] } });
  assert.deepEqual(replies[0].result.outcome, { outcome: 'selected', optionId: 'yes' });
  dsh.receive({ id: 2, method: 'session/request_permission', params: { sessionId: 'owned', options: [] } });
  assert.deepEqual(replies[1].result.outcome, { outcome: 'cancelled' });
  dsh.receive({ id: 3, method: 'session/request_permission', params: { sessionId: 'other' } });
  assert.equal(replies[2].error.code, -32601);
});

test('DSH TUI uses its own model options, tool lifecycle and backend labels', async t => {
  const f = await fixture(t);
  const s = await f.client.request('session.create', { backend: 'dsh', cwd: f.directory, prompt: 'hello' });
  const done = await f.client.request('session.wait', { id: s.id, timeoutMs: 3000 });
  const models = loadModels(done);
  assert.deepEqual(models.map(m => m.label), ['flash', 'pro']);
  assert.deepEqual(models[0].efforts, ['high', 'max']);
  assert.deepEqual(models[1].efforts, []); // fetch the new model's efforts after selection
  const model = new Model(); model.connected = true; model.setSessions([done]);
  for (const e of await f.client.request('session.events', { id: s.id })) model.apply(e);
  assert.equal(model.blocksFor(s.id).find(b => b.type === 'tool').status, 'completed');
  const ui = { selected: 0, selectedId: s.id, tick: 0, scroll: 0, expanded: true, focus: 'list', input: { text: '' } };
  const strip = lines => lines.join('\n').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
  const focus = strip(renderFocus(model, ui, 120, 40));
  assert.match(focus, /talking to DSH directly/); assert.match(focus, /Message DSH/);
  assert.match(focus, /Read\(hello.txt\)/); assert.match(focus, /file result/);
  ui.input = null;
  const list = strip(render(model, ui, 120, 30));
  assert.match(list, /DSH/); assert.doesNotMatch(list.split('\n').at(-1), /steer/);
  model.sessions.get(s.id).status = 'running';
  assert.match(strip(renderFocus(model, ui, 120, 40)), /Esc to stop, then send/);
  assert.deepEqual(translateDsh({ sessionUpdate: 'unknown' }), []);
});

test('committed DSH messages keep their live order in history and after restart', async t => {
  const f = await fixture(t);
  const live = [];
  await f.client.subscribe(event => live.push(event));
  const session = await f.client.request('session.create', { backend: 'dsh', cwd: f.directory, prompt: 'ordered-hold' });
  const deadline = Date.now() + 3000;
  while (!live.some(e => e.kind === 'message.done' && e.text === 'After tool')) {
    assert.ok(Date.now() < deadline, 'DSH text was not committed during the running turn');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const display = events => {
    const model = new Model(); for (const event of events) model.apply(event);
    return model.blocksFor(session.id).filter(b => ['message', 'tool'].includes(b.type)).map(b => b.text ?? b.title);
  };
  assert.deepEqual(display(live), ['Before tool', 'read_file', 'After tool']);
  const history = await f.client.request('session.events', { id: session.id });
  assert.deepEqual(display(history), display(live));
  assert.equal((await f.client.request('session.get', { id: session.id })).status, 'running');
  await f.restart();
  assert.deepEqual(display(await f.client.request('session.events', { id: session.id })), display(history));
});

test('DSH returns patches without mutating shared records and rolls back rejected selection', async t => {
  const f = await fixture(t);
  const session = await f.client.request('session.create', { backend: 'dsh', cwd: f.directory, prompt: 'hello' });
  const done = await f.client.request('session.wait', { id: session.id, timeoutMs: 3000 });
  const freeze = object => {
    if (object && typeof object === 'object') { Object.values(object).forEach(freeze); Object.freeze(object); }
    return object;
  };
  const frozen = freeze(structuredClone(done));
  const patch = await f.hub.dsh.configure(frozen, { model: 'pro', effort: 'max' });
  assert.equal(frozen.model, 'flash'); assert.equal(patch.model, 'pro');
  assert.notEqual(patch.dsh.configOptions, frozen.dsh.configOptions);
  // Restore through the service before testing a rejected two-setting mutation.
  await f.client.request('session.configure', { id: session.id, model: 'flash', effort: 'high' });
  await assert.rejects(f.client.request('session.configure', { id: session.id, model: 'pro', effort: 'invalid' }), { code: 'INVALID_PARAMS' });
  const unchanged = await f.client.request('session.get', { id: session.id });
  assert.equal(unchanged.model, 'flash'); assert.equal(unchanged.effort, 'high');
  assert.equal(f.hub.dsh.snapshot(unchanged).model, 'flash');
});
