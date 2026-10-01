// Opt-in smoke test: real inference, CLI lifecycle and the actual TUI renderer.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hub-smoke-'));
const endpoint = process.platform === 'win32' ? String.raw`\\.\pipe\codex-hub-standalone-test` : path.join(directory, 'hub.sock');
const env = { ...process.env, CODEX_HUB_ENDPOINT: endpoint, CODEX_HUB_HOME: path.join(directory, 'state'), CODEX_HUB_OWNER: 'smoke:live' };
const cliPath = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
const children = new Set();
const report = { directory, endpoint };
function cli(...args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args, '--json'], { env, cwd: directory, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    children.add(child);
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', s => { stdout += s; });
    child.stderr.setEncoding('utf8').on('data', s => { stderr += s; });
    const timer = setTimeout(() => { child.kill(); reject(new Error(`CLI timeout: ${args[0]}`)); }, 100000);
    child.on('error', reject);
    child.on('exit', code => {
      clearTimeout(timer); children.delete(child);
      if (code && !(args[0] === 'wait' && code === 1 && stdout)) return reject(new Error(stderr || stdout));
      try { resolve(JSON.parse(stdout)); } catch { reject(new Error(`Invalid CLI response: ${stdout} ${stderr}`)); }
    });
  });
}
const delay = ms => new Promise(r => setTimeout(r, ms));
try {
  console.log(`Evidence: ${directory}`);
  assert.equal((await cli('hub', 'status')).running, false, 'The dedicated smoke endpoint must be unused');
  report.ownsHub = true;
  const session = await cli('new', '--cwd', directory, '--title', 'Standalone smoke', '--model', 'gpt-6.1-sol', '--effort', 'low', 'Reply with exactly HUB_OK. Do not use tools or subagents.');
  report.id = session.id;
  report.created = session.status;
  report.hello = await cli('hub', 'status');
  report.appServerPid = JSON.parse(fs.readFileSync(path.join(env.CODEX_HUB_HOME, 'hub.lock'))).appServerPid;
  console.log(`Created ${session.id}; waiting for tiny prompt.`);
  const done = await cli('wait', session.id, '--timeout', '90');
  assert.equal(done.status, 'idle', done.lastLine);
  assert.match(done.lastMessage, /HUB_OK/);
  report.completed = { status: done.status, message: done.lastMessage };
  assert.equal((await cli('send', session.id, 'Use a shell command to pause for 30 seconds, then reply SECOND. Do not use subagents.')).status, 'running');
  await cli('stop', session.id);
  report.stoppedTurn = (await cli('wait', session.id, '--timeout', '15')).status;
  assert.equal(report.stoppedTurn, 'interrupted');
  const listed = await cli('ls', '--mine');
  assert.ok(listed.some(s => s.id === session.id));
  const shown = await cli('show', session.id, '--events', '20');
  assert.equal(shown.session.id, session.id);
  assert.ok(shown.events.some(e => e.kind === 'message.done' && /HUB_OK/.test(e.text)));
  report.listed = listed.length; report.shownEvents = shown.events.length;
  const tui = spawn(process.execPath, [cliPath, 'tui'], { env, cwd: directory, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  children.add(tui);
  let output = '', errors = '';
  tui.stdout.setEncoding('utf8').on('data', s => { output += s; });
  tui.stderr.setEncoding('utf8').on('data', s => { errors += s; });
  for (let i = 0; i < 150 && !output.includes('Standalone smoke'); i++) await delay(100);
  fs.writeFileSync(path.join(directory, 'tui.ansi'), output);
  assert.ok(output.includes('Standalone smoke'), `TUI did not list the session: ${errors}`);
  assert.ok(output.includes('smoke:live'), 'TUI must display the object owner');
  const exited = new Promise(resolve => tui.once('exit', resolve));
  tui.stdin.write('q');
  assert.equal(await Promise.race([exited, delay(5000).then(() => 'timeout')]), 0);
  children.delete(tui);
  report.tui = { listed: true, ownerDisplayed: true, exited: true };
  report.passed = true;
  console.log('Create, wait, send, stop, ls, show and TUI passed.');
} catch (error) {
  report.error = error.stack; console.error(error); process.exitCode = 1;
} finally {
  for (const child of children) child.kill();
  if (report.ownsHub) {
    await cli('hub', 'stop');
    for (let i = 0; i < 100 && fs.existsSync(path.join(env.CODEX_HUB_HOME, 'hub.lock')); i++) await delay(100);
    report.hubStopped = (await cli('hub', 'status')).running === false;
    report.processesStopped = {};
    for (const [name, pid] of Object.entries({ hub: report.hello?.pid, appServer: report.appServerPid })) {
      if (!pid) continue;
      for (let i = 0; i < 50; i++) {
        try { process.kill(pid, 0); report.processesStopped[name] = false; }
        catch (e) { report.processesStopped[name] = e.code === 'ESRCH'; break; }
        await delay(100);
      }
    }
    assert.equal(report.hubStopped, true);
    assert.ok(Object.values(report.processesStopped).every(Boolean));
  }
  fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
