import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hub } from '../src/server.mjs';
import { HubClient } from '../src/client.mjs';

class FakeApp {
  constructor({ onNotification }) { this.notify = onNotification; this.calls = []; this.number = 0; }
  async start() {}
  async close() {}
  async request(method, params) {
    this.calls.push({ method, params });
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
    this.notify('item/completed', { threadId: id, item: { id: 'answer', type: 'agentMessage', phase: 'final_answer', text: 'Finished' } });
    this.notify('turn/completed', { threadId: id, turn: { status } });
  }
}

test('wire contract, owners, concurrent wait/steer, events, replay, recovery and archive', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hub-test-'));
  const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\codex-hub-test-${process.pid}` : path.join(directory, 'hub.sock');
  const build = () => new Hub({ directory, endpoint, appFactory: hub => new FakeApp(hub) });
  let hub = build();
  const clients = [];
  t.after(async () => { clients.forEach(c => c.close()); await hub.stop(); fs.rmSync(directory, { recursive: true, force: true }); });
  await hub.start();
  async function connect(id) {
    const owner = { harness: 'test', id };
    const client = new HubClient({ endpoint, owner, autoStart: false }); clients.push(client); await client.connect(); return client;
  }
  const [a, b] = await Promise.all([connect('A'), connect('B')]);
  const live = [];
  assert.deepEqual(await a.subscribe(e => live.push(e)), { sessions: [], seq: 0 });
  const [one, two] = await Promise.all([
    a.request('session.create', { cwd: directory, prompt: 'First\nDetails' }),
    b.request('session.create', { cwd: directory, prompt: 'Second' }),
  ]);
  assert.deepEqual(one.owner, { harness: 'test', id: 'A' }); assert.deepEqual(two.owner, { harness: 'test', id: 'B' });
  assert.equal(one.title, 'First'); assert.equal(one.status, 'running');
  assert.equal((await a.request('session.list', { owner: { harness: 'test', id: 'A' } })).length, 1);
  await assert.rejects(a.request('session.get', { id: 'thread-' }), /Ambiguous/);
  await assert.rejects(a.request('session.send', { id: one.id, prompt: 'Busy' }), /already running/);
  const waiting = a.request('session.wait', { id: one.id });
  await b.request('session.steer', { id: one.id, text: 'Update' });
  const steer = hub.app.calls.find(c => c.method === 'turn/steer');
  assert.ok(steer.params.expectedTurnId);
  assert.equal((await b.request('session.wait', { id: two.id, timeoutMs: 5 })).status, 'running');
  hub.codex.notification('item/agentMessage/delta', { threadId: one.id, itemId: 'answer', delta: '你' });
  hub.codex.notification('item/reasoning/summaryTextDelta', { threadId: one.id, itemId: 'r', delta: 'Plan' });
  hub.codex.notification('turn/plan/updated', { threadId: one.id, plan: [{ step: 'Do it', status: 'completed' }] });
  hub.codex.notification('item/started', { threadId: one.id, item: { type: 'commandExecution', id: 'cmd', command: 'echo hello' } });
  hub.codex.notification('item/completed', { threadId: one.id, item: { type: 'commandExecution', id: 'cmd', command: 'echo hello', exitCode: 0 } });
  hub.codex.notification('item/completed', { threadId: one.id, item: { type: 'fileChange', id: 'patch', status: 'completed', changes: [{ path: 'example.txt' }] } });
  hub.codex.notification('item/completed', { threadId: one.id, item: { type: 'imageGeneration', id: 'img', savedPath: '/tmp/image.png' } });
  hub.codex.notification('error', { threadId: one.id, error: { message: 'Retrying' }, willRetry: true });
  assert.equal((await a.request('session.get', { id: one.id })).status, 'running');
  hub.app.complete(one.id);
  assert.equal((await waiting).lastMessage, 'Finished');
  assert.equal((await a.request('session.get', { id: one.id })).turns, 1);
  await assert.rejects(a.request('session.steer', { id: one.id, text: 'Late' }), /not running/);
  const history = await a.request('session.events', { id: one.id });
  assert.ok(history.some(e => e.kind === 'steer' && e.by?.harness === 'test' && e.by.id === 'B'));
  // Finished turns keep settled text only: deltas collapse into one *.done per item.
  assert.ok(history.some(e => e.kind === 'reasoning.done' && e.text === 'Plan'));
  assert.ok(history.some(e => e.kind === 'message.done' && e.itemId === 'answer' && e.text === 'Finished'));
  assert.ok(!history.some(e => e.kind.endsWith('.delta') || e.kind === 'session.updated'));
  assert.ok(history.some(e => e.kind === 'command.done' && e.exitCode === 0));
  assert.ok(history.some(e => e.kind === 'file.changed' && e.path === 'example.txt'));
  assert.ok(history.some(e => e.kind === 'image.generated' && e.path === '/tmp/image.png'));
  assert.equal((await a.request('session.events', { id: one.id, limit: 2 })).length, 2);
  assert.equal((await a.request('session.events', { id: one.id, afterSeq: history[0].seq, limit: 1 }))[0].seq, history[1].seq);
  await assert.rejects(a.request('session.events', { id: one.id, limit: -1 }), /nonnegative/);
  const watcher = await connect('TUI'); const replay = [];
  const snapshot = await watcher.subscribe(e => replay.push(e), { replay: 2 });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(replay.length, 4); assert.equal(snapshot.sessions.length, 2);
  assert.ok(replay.every((e, i) => i === 0 || e.seq > replay[i - 1].seq));
  await a.request('session.rename', { id: one.id, title: 'Renamed' });
  await a.request('session.archive', { id: one.id });
  assert.equal((await a.request('session.list')).length, 1);
  assert.equal((await a.request('session.get', { id: one.id })).title, 'Renamed');
  const oldSeq = hub.sessions.seq;
  clients.forEach(c => c.close()); await hub.stop();
  assert.equal(hub.sessions.resolve(two.id).status, 'interrupted');
  hub = build(); await hub.start();
  const c = await connect('C');
  assert.equal((await c.request('session.get', { id: two.id })).status, 'idle');
  const resuming = c.request('session.send', { id: two.id, prompt: 'Continue', effort: 'low' });
  const readAfterSend = c.request('session.get', { id: two.id });
  const continued = await resuming;
  assert.equal((await readAfterSend).status, 'running');
  assert.equal(continued.effort, 'low');
  assert.ok(hub.app.calls.some(c => c.method === 'thread/resume'));
  assert.ok(hub.sessions.seq > oldSeq);
  await c.request('session.interrupt', { id: two.id });
  assert.equal((await c.request('session.wait', { id: two.id })).status, 'interrupted');
  assert.equal((await c.request('session.list')).length, 1);
  assert.equal(live[0].kind, 'session.created');
  await c.request('session.send', { id: two.id, prompt: 'Shutdown during a turn' });
  const shutdownWait = c.request('session.wait', { id: two.id });
  await c.request('hub.stop');
  assert.equal((await shutdownWait).status, 'interrupted');
});

test('crash recovery uses journal, trims partial row, preserves global sequence', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hub-recovery-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.mkdirSync(path.join(directory, 'sessions'));
  const session = { id: 'lost', title: 'Lost', cwd: directory, model: 'gpt-6.1-sol', effort: 'low', owner: null,
    status: 'running', createdAt: 1, turnStartedAt: 2, lastActivityAt: 3, lastLine: '', plan: [], turns: 0, lastMessage: null };
  fs.writeFileSync(path.join(directory, 'sessions/lost.jsonl'), JSON.stringify({ seq: 999, ts: 3, sessionId: 'lost', kind: 'session.updated', session }) + '\n{"broken');
  const hub = new Hub({ directory, appFactory: h => new FakeApp(h) });
  hub.sessions.load();
  assert.equal(hub.sessions.resolve('lost').status, 'interrupted');
  assert.ok(hub.sessions.seq > 999);
  assert.equal(hub.sessions.events('lost').at(-1).kind, 'turn.completed');
});

test('journal keeps settled text, not deltas or snapshots', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hub-test-'));
  const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\codex-hub-delta-${process.pid}` : path.join(directory, 'hub.sock');
  const hub = new Hub({ directory, endpoint, appFactory: h => new FakeApp(h) });
  t.after(async () => { await hub.stop(); fs.rmSync(directory, { recursive: true, force: true }); });
  await hub.start();
  const client = new HubClient({ endpoint, owner: { harness: 'test', id: 'a' }, autoStart: false });
  t.after(() => client.close());
  await client.connect();
  const { id } = await client.request('session.create', { cwd: directory, prompt: 'go' });
  for (let i = 0; i < 200; i++) hub.codex.notification('item/agentMessage/delta', { threadId: id, itemId: 'm', delta: `w${i} ` });
  hub.codex.notification('item/reasoning/summaryTextDelta', { threadId: id, itemId: 'r', delta: 'think' });
  const journal = () => fs.readFileSync(hub.sessions.store.eventPath(id), 'utf8').split('\n').filter(Boolean).map(JSON.parse);
  // Mid-turn: a late viewer still gets the partial text, but nothing transient is on disk.
  assert.equal(hub.sessions.events(id).filter(e => e.kind === 'message.delta').length, 200);
  assert.ok(journal().every(e => !['message.delta', 'reasoning.delta', 'session.updated'].includes(e.kind)));
  // Interrupted mid-message: the streamed text is settled into *.done events.
  await client.request('session.interrupt', { id });
  const done = journal().filter(e => e.kind.endsWith('.done'));
  assert.ok(done.some(e => e.kind === 'message.done' && e.itemId === 'm' && e.text.startsWith('w0 w1') && e.text.includes('w199')));
  assert.ok(done.some(e => e.kind === 'reasoning.done' && e.text === 'think'));
  assert.equal(hub.sessions.events(id).filter(e => e.kind.endsWith('.delta')).length, 0);
  await client.request('session.archive', { id });
  assert.equal(hub.sessions.resolve(id).archived, true);
});

test('old journals remain unchanged and state.json snapshots win', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hub-test-'));
  fs.mkdirSync(path.join(directory, 'sessions'));
  const s = { id: 'old', title: 'new title', status: 'idle', turnStartedAt: null, turns: 1 };
  fs.writeFileSync(path.join(directory, 'state.json'), JSON.stringify({ seq: 9, sessions: [s], archived: [] }));
  const rows = [
    { seq: 1, sessionId: 'old', kind: 'session.created', session: { ...s, title: 'first title' } },
    { seq: 2, sessionId: 'old', kind: 'message.delta', itemId: 'a', text: 'He' },
    { seq: 3, sessionId: 'old', kind: 'session.updated', session: s },
    { seq: 4, sessionId: 'old', kind: 'message.delta', itemId: 'a', text: 'llo' },
    { seq: 5, sessionId: 'old', kind: 'message.delta', itemId: 'b', text: 'x' },
    { seq: 6, sessionId: 'old', kind: 'message.done', itemId: 'b', text: 'xyz' },
    { seq: 7, sessionId: 'old', kind: 'turn.completed', status: 'interrupted' }
  ];
  fs.writeFileSync(path.join(directory, 'sessions/old.jsonl'), rows.map(r => JSON.stringify(r) + '\n').join(''));
  const hub = new Hub({ directory, endpoint: 'unused', appFactory: h => new FakeApp(h) });
  hub.sessions.load();
  assert.equal(hub.sessions.resolve('old').title, 'new title');
  assert.equal(fs.readFileSync(path.join(directory, 'sessions/old.jsonl'), 'utf8'), rows.map(r => JSON.stringify(r) + '\n').join(''));
  fs.rmSync(directory, { recursive: true, force: true });
});

test('per-session sandbox goes on thread start and on the resume after a change', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hub-test-'));
  const extra = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hub-extra-'));
  const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\codex-hub-dirs-${process.pid}` : path.join(directory, 'hub.sock');
  const hub = new Hub({ directory, endpoint, appFactory: h => new FakeApp(h) });
  t.after(async () => { await hub.stop(); fs.rmSync(directory, { recursive: true, force: true }); fs.rmSync(extra, { recursive: true, force: true }); });
  await hub.start();
  const client = new HubClient({ endpoint, owner: { harness: 'test', id: 'a' }, autoStart: false });
  t.after(() => client.close());
  await client.connect();
  const session = await client.request('session.create', { cwd: directory, dirs: [extra], network: true, sandbox: 'workspace-write', prompt: 'go' });
  const last = method => hub.app.calls.filter(c => c.method === method).at(-1).params;
  const access = p => [p.sandbox, p.config.sandbox_workspace_write];
  assert.deepEqual(access(last('thread/start')), ['workspace-write', { writable_roots: [path.resolve(extra)], network_access: true }]);
  await assert.rejects(client.request('session.configure', { id: session.id, dirs: [path.join(extra, 'missing')] }));
  hub.app.complete(session.id);
  await client.request('session.configure', { id: session.id, dirs: [], network: false, sandbox: 'danger-full-access' });
  await assert.rejects(client.request('session.configure', { id: session.id, sandbox: 'yolo' }), /sandbox must be/);
  await client.request('session.send', { id: session.id, prompt: 'again' });
  assert.deepEqual(access(last('thread/resume')), ['danger-full-access', { writable_roots: [], network_access: false }]);
  const calls = hub.app.calls.map(c => c.method);
  assert.equal(calls[calls.lastIndexOf('thread/resume') - 1], 'thread/unsubscribe');
  hub.app.complete(session.id);
  const resumes = hub.app.calls.filter(c => c.method === 'thread/resume').length;
  await client.request('session.send', { id: session.id, prompt: 'no change, no resume' });
  assert.equal(hub.app.calls.filter(c => c.method === 'thread/resume').length, resumes);
});
