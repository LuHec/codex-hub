import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { stateDirectory } from './config.mjs';

export function configureProfile({ home, credentials, yaml }) {
  const profile = path.join(home, 'profiles', 'acp');
  fs.mkdirSync(profile, { recursive: true });
  const manifestPath = path.join(profile, 'package.json');
  const manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : { name: 'dsh-profile-acp', private: true };
  manifest.dsh ??= {}; manifest.dsh.profile ??= {};
  manifest.dsh.profile.bundles ??= ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-acp-app'];
  for (const bundle of ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-acp-app']) {
    if (!manifest.dsh.profile.bundles.includes(bundle)) manifest.dsh.profile.bundles.push(bundle);
  }
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  const root = path.join(profile, 'cordis.yml');
  if (!fs.existsSync(root)) fs.writeFileSync(root, '[]\n');
  const patchPath = path.join(profile, 'cordis.patch.yml');
  const rows = fs.existsSync(patchPath) ? yaml.load(fs.readFileSync(patchPath, 'utf8')) ?? [] : [];
  if (!Array.isArray(rows)) throw Error('ACP patch must be an array');
  // Hub workers use the same full-access default as Codex.
  for (const [id, values] of [['sandbox-policy', { mode: 'danger-full-access' }],
    ['approval', { policy: 'never' }], ['permission', { defaultPreset: 'danger-full-access' }]]) {
    let row = rows.find(row => row.id === id);
    if (!row) rows.push(row = { id, config: {} });
    row.config = { ...row.config, ...values };
  }
  let llm = rows.find(row => row.id === 'llm-pi-ai');
  if (!llm) rows.push(llm = { id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai', config: {} });
  llm.config ??= {}; llm.config.providers ??= {};
  llm.config.providers.zai ??= { apiKeyEnv: 'ZAI_API_KEY' };
  let credential = rows.find(row => row.id === 'credentials');
  if (!credential && credentials && fs.existsSync(credentials)) rows.push(credential = { id: 'credentials', config: { path: credentials.replace(/\\/g, '/') } });
  fs.writeFileSync(patchPath, yaml.dump(rows, { lineWidth: -1 }));
  return { profile, credentials: credential?.config?.path ?? path.join(home, '.credentials.yaml') };
}

export function setup() {
  if (Number(process.versions.node.split('.')[0]) < 22) throw Error('Node.js 22+ is required');
  const home = process.env.CODEX_HUB_DSH_HOME || path.join(stateDirectory(), 'dsh');
  const runtime = path.join(home, 'runtime');
  fs.mkdirSync(runtime, { recursive: true });
  const runtimeManifest = path.join(runtime, 'package.json');
  if (!fs.existsSync(runtimeManifest)) fs.writeFileSync(runtimeManifest, JSON.stringify({ name: 'codex-hub-dsh-runtime', private: true }));
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = spawnSync(npm, ['install', '--prefix', runtime, '--no-audit', '--no-fund', '@deepseek-ai/dsh@latest', 'js-yaml@4.1.0'], {
    stdio: 'inherit', shell: process.platform === 'win32', windowsHide: true,
  });
  if (result.error || result.status !== 0) throw Error('DSH installation failed');
  const require = createRequire(runtimeManifest);
  const configured = configureProfile({ home, yaml: require('js-yaml'),
    credentials: path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), '.credentials.yaml') });
  console.log('DSH and Z.ai configured: ' + configured.profile);
  console.log('Credentials: ' + configured.credentials);
  console.log('Existing credentials are reused without copying keys. Otherwise set DEEPSEEK_API_KEY or ZAI_API_KEY before starting the hub.');
  console.log('Restart an existing hub when idle to use the installed runtime.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { setup(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
