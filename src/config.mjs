import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import metadata from '../package.json' with { type: 'json' };

export const VERSION = metadata.version;
export function hubEndpoint() {
  return process.env.CODEX_HUB_ENDPOINT || (process.platform === 'win32'
    ? `\\\\.\\pipe\\codex-hub-${os.userInfo().username}`
    : process.env.XDG_RUNTIME_DIR ? path.join(process.env.XDG_RUNTIME_DIR, 'codex-hub.sock')
      : `/tmp/codex-hub-${process.getuid()}.sock`);
}
export function stateDirectory() {
  return path.resolve(process.env.CODEX_HUB_HOME || path.join(os.homedir(), '.codex-hub'));
}
export function resolveCodexCommand() {
  if (process.env.CODEX_BIN) return process.env.CODEX_BIN;
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    try {
      const root = path.join(process.env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin');
      const bins = fs.readdirSync(root).map(name => path.join(root, name, 'codex.exe'))
        .filter(p => fs.existsSync(p)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
      if (bins.length) return bins[0];
    } catch { /* Fall back to PATH. */ }
  }
  return 'codex';
}
// Environment syntax is a CLI convention; the wire always carries an owner object.
export function controllerOwner() {
  const value = process.env.CODEX_HUB_OWNER;
  if (value === undefined) return undefined;
  const at = value.indexOf(':');
  const owner = { harness: value.slice(0, at), id: value.slice(at + 1) };
  if (at < 1 || !/^[a-z][a-z0-9_-]*$/.test(owner.harness) || !owner.id || /\s/.test(owner.id)) {
    throw Object.assign(new Error('CODEX_HUB_OWNER must be harness:id (lowercase harness, nonempty ID without whitespace)'), { code: 'INVALID_PARAMS' });
  }
  return owner;
}
export const sameOwner = (a, b) => a?.harness === b?.harness && a?.id === b?.id;
export const ownerLabel = owner => owner ? `${owner.harness}:${owner.id}` : '-';
