import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import readline from 'node:readline';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { HubClient } from '../src/client.mjs';

test('client detects old protocol; CLI restart replaces old server with its own package, then restarts again', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hub-restart-'));
  const endpoint = process.platform === 'win32' ? String.raw`\\.\pipe\${path.basename(directory)}` : path.join(directory, 'hub.sock');
  // Node is a portable fake CODEX_BIN: the hub invokes it with the argument "app-server".
  fs.writeFileSync(path.join(directory, 'app-server'), `
    require('node:readline').createInterface({ input: process.stdin }).on('line', row => {
      const m = JSON.parse(row);
      if (m.id !== undefined) process.stdout.write(JSON.stringify({ id: m.id, result: m.method === 'model/list' ? { data: [] } : {} }) + '\\n');
    });
  `);
  const sockets = new Set();
  const old = net.createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {});
    readline.createInterface({ input: socket }).on('line', row => {
      const m = JSON.parse(row);
      socket.write(JSON.stringify({ id: m.id, result: m.method === 'hello' ? { version: 'legacy', pid: process.pid } : {} }) + '\n');
      if (m.method === 'hub.stop') { old.close(); for (const s of sockets) s.end(); }
    });
  });
  await new Promise(resolve => old.listen(endpoint, resolve));
  const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
  const env = { ...process.env, CODEX_HUB_ENDPOINT: endpoint, CODEX_HUB_HOME: directory, CODEX_BIN: process.execPath };
  delete env.CODEX_HUB_OWNER;
  const run = (...args) => new Promise((resolve, reject) => execFile(process.execPath, [cli, ...args, '--json'],
    { cwd: directory, env, windowsHide: true, timeout: 40000 }, (error, stdout, stderr) =>
      error ? reject(new Error(stderr || error.message)) : resolve(JSON.parse(stdout))));
  t.after(async () => {
    try { await run('hub', 'stop'); } finally {
      for (const s of sockets) s.destroy();
      if (old.listening) old.close();
      for (let i = 0; i < 100 && fs.existsSync(path.join(directory, 'hub.lock')); i++) await new Promise(r => setTimeout(r, 50));
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
  const client = new HubClient({ endpoint, autoStart: false });
  await assert.rejects(client.connect(), { code: 'PROTOCOL_MISMATCH' });
  assert.equal(client.closed, true);
  const first = await run('hub', 'restart');
  assert.equal(first.protocol, 1);
  assert.notEqual(first.pid, process.pid);
  const second = await run('hub', 'restart');
  assert.equal(second.protocol, 1);
  assert.notEqual(second.pid, first.pid);
  assert.equal((await run('hub', 'status')).pid, second.pid);
});
