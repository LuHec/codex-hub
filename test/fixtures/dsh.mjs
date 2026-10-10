// ACP peer for tests: no model requests and no user profile access.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
if (process.env.DSH_PERMISSION_MODE !== 'danger-full-access') throw Error('Hub DSH must launch with full access');
const sessions = new Map();
const pending = new Map();
const route = model => JSON.stringify(['deepseek-official', model]);
const options = (model = 'flash', effort = 'high') => [
  { id: 'model', currentValue: route(model), options: [{ group: 'deepseek-official', options: ['flash', 'pro'].map(m => ({ value: route(m), name: m })) }] },
  { id: 'reasoning_effort', currentValue: effort, options: ['high', 'max'].map(value => ({ value })) },
];
fs.mkdirSync(process.env.DSH_HOME, { recursive: true });
const write = msg => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
const update = (sessionId, data) => write({ method: 'session/update', params: { sessionId, update: data } });
let number = 0;
readline.createInterface({ input: process.stdin }).on('line', row => {
  const m = JSON.parse(row), p = m.params ?? {};
  if (m.jsonrpc !== '2.0') process.exit(2);
  const reply = result => write({ id: m.id, result });
  if (m.method === 'initialize') return reply({ protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {}, close: {} } } });
  if (m.method === 'session/new') {
    const sessionId = `native-${++number}`;
    sessions.set(sessionId, options());
    fs.writeFileSync(path.join(process.env.DSH_HOME, sessionId), p.cwd);
    return reply({ sessionId, configOptions: sessions.get(sessionId) });
  }
  if (m.method === 'session/resume') {
    if (fs.readFileSync(path.join(process.env.DSH_HOME, p.sessionId), 'utf8') !== p.cwd) throw Error('wrong cwd');
    sessions.set(p.sessionId, options());
    return reply({ configOptions: sessions.get(p.sessionId) });
  }
  if (m.method === 'session/set_config_option') {
    const configOptions = sessions.get(p.sessionId);
    configOptions.find(o => o.id === p.configId).currentValue = p.value;
    update(p.sessionId, { sessionUpdate: 'config_option_update', configOptions });
    return reply({ configOptions });
  }
  if (m.method === 'session/prompt') {
    const text = p.prompt[0].text;
    if (text === 'crash') return process.exit(3);
    if (text === 'error') return write({ id: m.id, error: { code: -32603, message: 'provider failed' } });
    if (text === 'hold') { pending.set(p.sessionId, m.id); return; }
    if (text === 'ordered-hold') {
      for (const text of ['Before ', 'tool']) update(p.sessionId, { sessionUpdate: 'agent_message_chunk', messageId: 'intro', content: { type: 'text', text } });
      update(p.sessionId, { sessionUpdate: 'tool_call', toolCallId: 'read', title: 'read_file', status: 'in_progress' });
      update(p.sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 'read', status: 'completed' });
      update(p.sessionId, { sessionUpdate: 'agent_message_chunk', messageId: 'answer', content: { type: 'text', text: 'After tool' } });
      pending.set(p.sessionId, m.id); return;
    }
    update(p.sessionId, { sessionUpdate: 'agent_thought_chunk', messageId: 'm1', content: { type: 'text', text: '思考' } });
    update(p.sessionId, { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'read_file', status: 'in_progress', rawInput: { path: 'hello.txt' } });
    update(p.sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'file result' } }] });
    for (const chunk of ['完成 ', text]) update(p.sessionId, { sessionUpdate: 'agent_message_chunk', messageId: 'm2', content: { type: 'text', text: chunk } });
    return reply({ stopReason: text === 'limit' ? 'max_tokens' : 'end_turn' });
  }
  if (m.method === 'session/cancel') {
    const id = pending.get(p.sessionId);
    pending.delete(p.sessionId);
    if (id) write({ id, result: { stopReason: 'cancelled' } });
    return;
  }
  if (m.method === 'session/close') { sessions.delete(p.sessionId); return reply({}); }
});
