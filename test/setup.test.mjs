import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { configureProfile } from '../src/setup.mjs';

// JSON is valid YAML; inject a codec to test merge behavior without dependencies.
const yaml = { load: JSON.parse, dump: value => JSON.stringify(value) };
test('setup preserves profiles, references existing credentials and is idempotent', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-setup-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'dsh'), credentials = path.join(root, 'credentials.yaml');
  fs.writeFileSync(credentials, 'private credential fixture');
  const first = configureProfile({ home, credentials, yaml });
  const patch = path.join(first.profile, 'cordis.patch.yml');
  const rows = JSON.parse(fs.readFileSync(patch));
  rows.push({ id: 'custom', config: { value: 1 } });
  rows.find(r => r.id === 'llm-pi-ai').config.providers.zai.baseUrl = 'https://example.invalid';
  fs.writeFileSync(patch, JSON.stringify(rows));
  configureProfile({ home, credentials, yaml });
  const once = fs.readFileSync(patch, 'utf8');
  configureProfile({ home, credentials, yaml });
  assert.equal(fs.readFileSync(patch, 'utf8'), once);
  assert.ok(once.includes('custom'));
  assert.ok(once.includes('example.invalid'));
  assert.ok(!once.includes('private credential fixture'));
  assert.equal(JSON.parse(once).filter(r => r.id === 'credentials').length, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(first.profile, 'package.json'))).dsh.profile.bundles,
    ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-acp-app']);
});
test('setup without credentials still enables Z.ai without inventing keys', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-setup-empty-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const { profile } = configureProfile({ home, credentials: path.join(home, 'missing'), yaml });
  const rows = JSON.parse(fs.readFileSync(path.join(profile, 'cordis.patch.yml')));
  assert.equal(rows.some(r => r.id === 'credentials'), false);
  assert.equal(rows[0].config.providers.zai.apiKeyEnv, 'ZAI_API_KEY');
});
