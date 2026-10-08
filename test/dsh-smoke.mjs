// Real installed DSH, isolated home, no inference request or API key required.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Dsh, choices, selection } from '../src/dsh.mjs';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-dsh-smoke-'));
const home = path.join(directory, 'dsh');
const make = () => new Dsh({ directory, home, onEvent() {}, onExit() {} });
let dsh = make();
try {
  const session = { cwd: directory, ...await dsh.create({ cwd: directory }) };
  const models = choices(session.dsh.configOptions.find(o => o.id === 'model'));
  const selected = models.find(o => o.value.includes('deepseek-flash')) ?? models[0];
  assert.ok(selected);
  Object.assign(session, await dsh.configure(session, { model: selected.value }));
  const expected = selection(session.dsh.configOptions);
  await dsh.release(session.dsh.id);
  await dsh.close();
  dsh = make();
  const restored = await dsh.prepare(session, {});
  assert.deepEqual(selection(restored.dsh.configOptions), expected);
  await dsh.release(session.dsh.id);
  console.log(JSON.stringify({ initialize: true, create: true, configure: true, close: true, resumeAfterRestart: true, ...expected, inference: 'not requested' }, null, 2));
} finally {
  await dsh.close();
  assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
  fs.rmSync(directory, { recursive: true, force: true });
}
