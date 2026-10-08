// Presentation for generic tool records, shared by the list and focus views.
const flat = value => String(value ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim();
export const toolText = b => (b.content ?? []).filter(c => c.type === 'content' && c.content?.type === 'text').map(c => c.content.text).join('\n');
export const toolRunning = b => !['completed', 'failed', 'cancelled'].includes(b.status);

export function describeTool(b, cwd = '') {
  let input = b.rawInput ?? {};
  if (typeof input === 'string') { try { input = JSON.parse(input); } catch { input = { input }; } }
  const file = flat(input.file_path ?? input.path ?? input.filename ?? input.file);
  const root = cwd.replace(/\\/g, '/').replace(/\/$/, '');
  const full = file.replace(/\\/g, '/');
  const relative = root && full.toLowerCase().startsWith(root.toLowerCase() + '/') ? full.slice(root.length + 1) : full;
  const title = String(b.title ?? 'Tool');
  const kind = title.toLowerCase().replace(/[-_]/g, '');
  const text = toolText(b).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
  let name = title, category = 'tool', args = '', summary = '';
  if (['read', 'readfile'].includes(kind)) {
    name = 'Read'; category = 'read'; args = relative;
    const start = input.offset ?? input.start_line;
    if (start != null) args += `:${start}${input.limit != null ? ` (+${input.limit} lines)` : ''}`;
    const count = [...text.matchAll(/^\s*\d+[:|]/gm)].length;
    summary = count ? `${count} lines` : '';
  } else if (['grep', 'search', 'glob'].includes(kind)) {
    name = kind === 'glob' ? 'Glob' : 'Search'; category = 'search';
    args = [flat(input.pattern ?? input.query), relative].filter(Boolean).join(' · ');
    summary = text.match(/(?:Found|No) [^\r\n]+/i)?.[0] ?? (kind === 'glob' && text.trim() ? `${text.trim().split('\n').length} paths` : '');
  } else if (['pwsh', 'powershell', 'bash', 'shell', 'execute'].includes(kind)) {
    name = ['pwsh', 'powershell'].includes(kind) ? 'PowerShell' : 'Shell'; category = 'command';
    args = flat(input.command ?? input.cmd ?? input.script);
    summary = flat(input.description);
  } else if (['edit', 'write', 'writefile', 'strreplace', 'strreplaceeditor', 'applypatch'].includes(kind)) {
    name = kind.startsWith('write') ? 'Write' : 'Edit'; category = 'edit'; args = relative || flat(input.command);
  } else if (['todowrite', 'todo', 'updatetodo', 'updateplan'].includes(kind)) {
    name = 'Plan'; category = 'plan';
    const todos = input.todos ?? input.plan;
    if (Array.isArray(todos)) summary = todos.map(t => `${t.status === 'completed' ? '✓' : ['in_progress', 'inProgress'].includes(t.status) ? '▸' : '○'} ${flat(t.content ?? t.step ?? t.title)}`).join('\n');
  } else if (kind === 'skill') {
    name = 'Skill'; category = 'skill'; args = flat(input.name);
  }
  if (!args && category === 'tool') args = Object.entries(input).filter(([, v]) => ['string', 'number', 'boolean'].includes(typeof v)).map(([k, v]) => `${k}: ${flat(v)}`).join(' · ');
  const failed = b.status === 'failed' || b.status === 'cancelled';
  if (failed) summary = text.trim().split('\n').find(l => l.trim()) || (b.status === 'cancelled' ? 'Cancelled' : 'Failed');
  else if (toolRunning(b)) summary = 'Running…';
  const body = text.replace(/<path>[^]*?<\/path>\s*/g, '').replace(/<type>[^]*?<\/type>\s*/g, '').replace(/<\/?content>\s*/g, '').trim();
  return { name, category, args, summary, body, failed, running: toolRunning(b) };
}

export function summarizeTools(items, cwd) {
  const tools = items.filter(b => b.type === 'tool').map(b => describeTool(b, cwd));
  const count = category => tools.filter(t => t.category === category).length;
  const parts = [];
  for (const [category, singular, plural] of [['read', 'file read', 'files read'], ['search', 'search', 'searches'],
    ['command', 'command', 'commands'], ['edit', 'edit', 'edits'], ['plan', 'plan update', 'plan updates'], ['skill', 'skill', 'skills'], ['tool', 'tool call', 'tool calls']]) {
    const n = count(category); if (n) parts.push(`${n} ${n === 1 ? singular : plural}`);
  }
  return { parts, running: tools.filter(t => t.running), failed: tools.filter(t => t.failed) };
}
