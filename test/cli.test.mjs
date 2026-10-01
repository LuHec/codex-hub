import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
const run = (args, env) => new Promise(resolve => execFile(process.execPath, [cli, ...args], { env, windowsHide: true },
  (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr })));

test('guide prints the shared guide without contacting a hub', async () => {
  const result = await run(['guide'], { ...process.env, CODEX_HUB_ENDPOINT: 'unused' });
  assert.equal(result.code, 0);
  assert.equal(result.stdout, fs.readFileSync(new URL('../GUIDE.md', import.meta.url), 'utf8'));
});

test('the CLI reads only CODEX_HUB_OWNER, never a harness-specific variable', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hub-cli-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const env = { ...process.env, CLAUDE_SESSION_ID: 'abcdef', CODEX_HUB_HOME: directory,
    CODEX_HUB_ENDPOINT: process.platform === 'win32' ? String.raw`\.\pipe\codex-hub-cli-${process.pid}` : path.join(directory, 'hub.sock') };
  delete env.CODEX_HUB_OWNER;
  const result = await run(['ls', '--mine', '--json'], env);
  assert.equal(result.code, 1);
  assert.equal(JSON.parse(result.stderr).error.code, 'INVALID_PARAMS');
  assert.equal(fs.existsSync(path.join(directory, 'hub.lock')), false);
});
