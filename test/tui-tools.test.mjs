import test from 'node:test';
import assert from 'node:assert/strict';
import { Model } from '../src/tui/model.mjs';
import { renderFocus } from '../src/tui/focus.mjs';
import { render } from '../src/tui/view.mjs';
import { describeTool } from '../src/tui/tools.mjs';

const content = text => [{ type: 'content', content: { type: 'text', text } }];
const strip = lines => lines.join('\n').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
function fixture() {
  const model = new Model();
  const session = { id: 'dsh:ui', dsh: {}, cwd: 'E:/work', title: 'Inspect parser', model: 'deepseek-flash', status: 'running', turns: 0 };
  model.setSessions([session]); model.connected = true;
  let seq = 0;
  const add = event => model.apply({ seq: ++seq, ts: Date.now(), sessionId: session.id, ...event });
  add({ kind: 'turn.started', prompt: 'Inspect the parser and run focused tests.' });
  for (let i = 0; i < 11; i++) add({ kind: 'tool.updated', itemId: `r${i}`, title: 'read', rawInput: { file_path: `E:\\work\\src\\file${i}.ts` }, status: 'completed', content: content('<path>file</path>\n<type>file</type>\n<content>\n1: export const value = 1;\n</content>') });
  add({ kind: 'tool.updated', itemId: 'g', title: 'grep', rawInput: { pattern: 'parseInput', path: 'E:/work/src' }, status: 'completed', content: content('Found 3 matches\nsrc/parser.ts:12') });
  add({ kind: 'tool.updated', itemId: 'err', title: 'pwsh', rawInput: { command: 'npm test' }, status: 'failed', content: content('Parser assertion failed') });
  add({ kind: 'tool.updated', itemId: 'active', title: 'read', rawInput: { file_path: 'E:/work/src/parser.ts' }, status: 'in_progress' });
  return { model, session, ui: { selected: 0, selectedId: session.id, tick: 0, scroll: 0, focus: 'list', expanded: false, input: null } };
}
test('collapsed generic tools fold in both views without hiding failures or active paths', () => {
  for (const draw of [renderFocus, render]) {
    const { model, ui } = fixture();
    const screen = strip(draw(model, ui, 140, 42));
    assert.match(screen, /12 files read/i);
    assert.match(screen, /1 search/);
    assert.match(screen, /Parser assertion failed/);
    assert.match(screen, /src\/parser.ts/);
    assert.doesNotMatch(screen, /completed/);
    assert.doesNotMatch(screen, /file0.ts/);
    assert.ok(ui.layout.toggleRows.size > 0);
  }
});
test('expanded generic tools show readable parameters and results in both views', () => {
  for (const draw of [renderFocus, render]) {
    const { model, ui } = fixture(); ui.expanded = true;
    const screen = strip(draw(model, ui, 140, 110));
    assert.match(screen, /Read\s*\(src\/file0.ts\)/);
    assert.match(screen, /Search\s*\(parseInput · src\)/);
    assert.match(screen, /PowerShell\s*\(npm test\)/);
    assert.match(screen, /export const value = 1/);
    assert.doesNotMatch(screen, /<content>|<path>|completed/);
  }
});
test('tool formatting handles plan state, unknown tools, string arguments and terminal controls', () => {
  assert.equal(describeTool({ title: 'glob', rawInput: '{"pattern":"**/*.ts"}', status: 'completed', content: content('a.ts\nb.ts') }).summary, '2 paths');
  assert.match(describeTool({ title: 'todo_write', rawInput: { todos: [{ content: 'Implement', status: 'completed' }, { content: 'Verify', status: 'in_progress' }] }, status: 'completed' }).summary, /✓ Implement\n▸ Verify/);
  const custom = describeTool({ title: 'custom', rawInput: { query: '中文\u001b[2J', options: {} }, status: 'failed', content: content('\u001b[31mFailed safely') });
  assert.match(custom.args, /中文/); assert.doesNotMatch(custom.args + custom.body, /\u001b/);
  assert.equal(custom.failed, true);
});
