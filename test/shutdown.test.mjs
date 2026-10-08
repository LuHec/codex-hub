import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hub } from '../src/server.mjs';
import { HubClient } from '../src/client.mjs';

test('backend shutdown failure still closes both backends, clients, listener and lock', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-stop-test-'));
  const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\${path.basename(directory)}` : path.join(directory, 'hub.sock');
  const closedBackends = [];
  const hub = new Hub({ directory, endpoint,
    appFactory: () => ({ close() { closedBackends.push('codex'); throw Error('backend close failed'); } }),
    dshFactory: () => ({ async close() { closedBackends.push('dsh'); } }),
  });
  const client = new HubClient({ endpoint, autoStart: false });
  t.after(async () => {
    client.close(); await hub.stop().catch(() => {});
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  await hub.start(); await client.connect();
  const disconnected = new Promise(resolve => client.socket.once('close', resolve));
  await assert.rejects(hub.stop(), /backend close failed/);
  await disconnected;
  assert.deepEqual(closedBackends.sort(), ['codex', 'dsh']);
  assert.equal(hub.server.listening, false);
  assert.equal(hub.stopped, true);
  assert.equal(hub.sessions.stopped, true);
  assert.equal(fs.existsSync(path.join(directory, 'hub.lock')), false);
});
