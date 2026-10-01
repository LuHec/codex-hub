// Opt-in real inference integration test. Keeps evidence in an OS temporary directory.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { HubClient } from '../src/client.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hub-live-'));
fs.mkdirSync(directory, { recursive: true });
const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\codex-hub-standalone-test` : path.join(directory, 'hub.sock');
const env = { ...process.env, CODEX_HUB_ENDPOINT: endpoint, CODEX_HUB_HOME: path.join(directory, 'state') };
const cliPath = path.join(root, 'src', 'cli.mjs');
const children = new Set();
function cli(owner, ...args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args, '--json'], {
      cwd: root, env: { ...env, CODEX_HUB_OWNER: `test:${owner}` }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.add(child);
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', s => { stdout += s; });
    child.stderr.setEncoding('utf8').on('data', s => { stderr += s; });
    child.on('error', reject);
    child.on('exit', code => {
      children.delete(child);
      if (args[0] === 'wait' && [0, 1].includes(code) && stdout.trim()) {
        try {
          const session = JSON.parse(stdout);
          report.waitExitCodes ??= {}; report.waitExitCodes[session.id] = code;
          resolve(session); return;
        } catch { /* Report malformed output below. */ }
      }
      if (code !== 0) return reject(new Error(`CLI ${args[0]} exit ${code}: ${stderr || stdout}`));
      try { resolve(JSON.parse(stdout)); } catch { reject(new Error(`Bad CLI output: ${stdout} ${stderr}`)); }
    });
  });
}
const aDir = path.join(directory, 'task-a'), bDir = path.join(directory, 'task-b');
fs.mkdirSync(aDir); fs.mkdirSync(bDir);
const promptA = 'Tiny integration task. Use a shell command to pause for 12 seconds, then create answer.txt containing exactly ALPHA. Read it back and report the contents. Do not use subagents. A steering update may arrive during the pause.';
const promptB = 'Tiny integration task. Create answer.txt containing exactly BETA. Read it back and report the contents. Do not use subagents.';
const observer = new HubClient({ endpoint, autoStart: false, owner: { harness: 'test', id: 'live-observer' } });
let report = { directory, endpoint };
const watchdog = setTimeout(() => { console.error('Live test timed out'); void cleanup().then(() => process.exit(1)); }, 240_000);
async function cleanup() {
  observer.close();
  try { if (report.ownsHub) await cli('cleanup', 'hub', 'stop'); } catch (e) { console.error(e.message); }
  for (const child of children) child.kill();
}
try {
  console.log(`Evidence: ${directory}`);
  assert.equal((await cli('cleanup', 'hub', 'status')).running, false, 'Dedicated test endpoint must be unused');
  report.ownsHub = true;
  const [a, b] = await Promise.all([
    cli('controller-A', 'new', '--cwd', aDir, '--model', 'gpt-6.1-sol', '--effort', 'low', '--title', 'Live A', promptA),
    cli('controller-B', 'new', '--cwd', bDir, '--model', 'gpt-6.1-sol', '--effort', 'low', '--title', 'Live B', promptB),
  ]);
  report.sessions = [a, b]; console.log(`Started ${a.id} and ${b.id}`);
  assert.equal(a.status, 'running'); assert.equal(b.status, 'running');
  const [mineA, mineB] = await Promise.all([cli('controller-A', 'ls', '--mine'), cli('controller-B', 'ls', '--mine')]);
  assert.deepEqual(mineA.map(s => s.id), [a.id]); assert.deepEqual(mineB.map(s => s.id), [b.id]);
  await observer.connect();
  let networkBlocked;
  const blocked = new Promise(resolve => { networkBlocked = resolve; });
  const pushed = []; const snapshot = await observer.subscribe(e => {
    pushed.push(e);
    if (process.env.CODEX_SANDBOX_NETWORK_DISABLED === '1' && e.kind === 'error' && /network|connect/i.test(e.message)) networkBlocked(e.message);
  }, { replay: 20 });
  report.pid = observer.hello.pid;
  report.appServerPid = JSON.parse(fs.readFileSync(path.join(env.CODEX_HUB_HOME, 'hub.lock'), 'utf8')).appServerPid;
  assert.equal(snapshot.sessions.length, 2);
  // Start two independent blocking controllers, then steer while they are waiting.
  const waits = Promise.all([cli('controller-A', 'wait', a.id, '--timeout', '180'), cli('controller-B', 'wait', b.id, '--timeout', '180')]);
  waits.catch(() => {});
  await cli('controller-A', 'steer', a.id, 'Change the required contents of answer.txt to exactly STEERED instead of ALPHA. Finish the same task and report STEERED.');
  console.log('Steer accepted; both CLI wait controllers active.');
  const outcome = await Promise.race([waits.then(completed => ({ completed })), blocked.then(message => ({ message }))]);
  if (outcome.message) {
    report.inferenceBlocked = `CODEX_SANDBOX_NETWORK_DISABLED=1: ${outcome.message}`;
    await Promise.all([cli('controller-A', 'stop', a.id), cli('controller-B', 'stop', b.id)]);
    process.exitCode = 1;
  }
  const completed = outcome.completed || await waits;
  const expectedStatus = report.inferenceBlocked ? 'interrupted' : 'idle';
  assert.ok(completed.every(s => s.status === expectedStatus && s.turns === 1));
  if (!report.inferenceBlocked) {
    assert.equal(fs.readFileSync(path.join(aDir, 'answer.txt'), 'utf8').trim(), 'STEERED');
    assert.equal(fs.readFileSync(path.join(bDir, 'answer.txt'), 'utf8').trim(), 'BETA');
  }
  const listed = await cli('controller-A', 'ls');
  assert.ok(listed.every(s => s.status === expectedStatus));
  const logs = [a, b].map(s => fs.readFileSync(path.join(env.CODEX_HUB_HOME, 'sessions', `${s.id}.jsonl`), 'utf8').trim().split('\n').map(JSON.parse));
  for (const events of logs) {
    for (const kind of ['session.created', 'turn.started', 'turn.completed', ...(report.inferenceBlocked ? [] : ['message.done'])]) assert.ok(events.some(e => e.kind === kind), `missing ${kind}`);
    assert.ok(events.every((e, i) => !i || e.seq > events[i - 1].seq));
  }
  assert.ok(logs[0].some(e => e.kind === 'steer' && e.by?.harness === 'test' && e.by.id === 'controller-A'));
  const seqs = logs.flat().map(e => e.seq); assert.equal(new Set(seqs).size, seqs.length);
  assert.ok(pushed.some(e => e.kind === 'turn.completed'));
  report = { ...report, completed, listed, events: logs.map(events => ({ count: events.length, kinds: [...new Set(events.map(e => e.kind))] })), pushed: pushed.length, infrastructurePassed: true, passed: !report.inferenceBlocked };
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  report.error = error.stack; console.error(error); process.exitCode = 1;
} finally {
  clearTimeout(watchdog);
  await cleanup();
  // Endpoint must go away; status does not auto-start a fresh hub.
  for (let attempt = 0; attempt < 50; attempt++) {
    const status = await cli('cleanup', 'hub', 'status');
    if (status.running === false) { report.stopped = true; break; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  report.processesStopped = {};
  for (const [name, pid] of Object.entries({ hub: report.pid, appServer: report.appServerPid })) {
    if (!pid) continue;
    for (let attempt = 0; attempt < 30; attempt++) {
      try { process.kill(pid, 0); report.processesStopped[name] = false; }
      catch (error) { report.processesStopped[name] = error.code === 'ESRCH'; break; }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  if (!report.stopped || Object.values(report.processesStopped).includes(false)) process.exitCode = 1;
  fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`Hub stopped: ${report.stopped === true}`);
}
