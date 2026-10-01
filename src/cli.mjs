#!/usr/bin/env node
import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { fault } from './protocol.mjs';
import { HubClient } from './client.mjs';
import { controllerOwner, ownerLabel } from './config.mjs';

const help = `codex-hub new --cwd <dir> [--dir <extra writable dir>]... [--network] [--full-access] [--model m] [--effort e] [--title t] (--prompt-file f | "prompt")
codex-hub send <id> (--prompt-file f | "prompt")
codex-hub steer <id> "text" | stop <id>
codex-hub ls [--mine] | show <id> [--events N]
codex-hub wait <id> [--timeout seconds]
codex-hub config <id> [--model m] [--effort e] [--dir d]... [--network | --no-network] [--full-access | --no-full-access]
                  (applies from the next turn; --dir replaces the list)
codex-hub rename <id> "title" | archive <id>
codex-hub hub status | hub stop | hub restart | tui
All commands support --json (errors are JSON on stderr).
send / steer / stop / config / rename / archive support --force to take over after success.
Owner: CODEX_HUB_OWNER=harness:id.`;

let jsonOutput = false;

function display(session) {
  return `${session.id}  ${session.status}  ${session.title}\n  ${session.model}/${session.effort}  owner=${ownerLabel(session.owner)}  turns=${session.turns}${session.dirs?.length ? `  +dirs ${session.dirs.join(', ')}` : ''}${session.network ? '  network' : ''}${session.sandbox === 'danger-full-access' ? '  FULL ACCESS' : ''}\n  ${session.lastLine}`;
}
export async function main(args = process.argv.slice(2)) {
  // Preserve JSON error output even when strict argument parsing itself fails.
  const endOptions = args.indexOf('--');
  jsonOutput = args.slice(0, endOptions < 0 ? args.length : endOptions).includes('--json');
  const { values: flags, positionals: words } = parseArgs({ args, allowPositionals: true, options: {
    cwd: { type: 'string' }, model: { type: 'string' }, effort: { type: 'string' }, title: { type: 'string' },
    'prompt-file': { type: 'string' }, events: { type: 'string' }, timeout: { type: 'string' },
    dir: { type: 'string', multiple: true }, network: { type: 'boolean' }, 'full-access': { type: 'boolean' },
    mine: { type: 'boolean' }, force: { type: 'boolean' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
  }, allowNegative: true });
  jsonOutput = flags.json === true;
  const [command, id, ...rest] = words;
  if (!command || flags.help) { console.log(help); return; }
  if (command === 'tui') { await import('./tui/index.mjs'); return; }
  if (!['new', 'send', 'steer', 'stop', 'ls', 'show', 'wait', 'config', 'rename', 'archive', 'hub'].includes(command)) throw fault('INVALID_PARAMS', help);
  if (command === 'hub' && !['status', 'stop', 'restart'].includes(id)) throw fault('INVALID_PARAMS', 'Use hub status, hub stop or hub restart');
  const owner = controllerOwner();
  if (flags.mine && !owner) throw fault('INVALID_PARAMS', '--mine requires CODEX_HUB_OWNER');
  const client = new HubClient({ client: 'cli', owner, autoStart: command !== 'hub', allowProtocolMismatch: command === 'hub' && id === 'restart' });
  try {
    try { await client.connect(); }
    catch (error) {
      if (command === 'hub' && ['ENOENT', 'ECONNREFUSED'].includes(error.code)) {
        if (id !== 'restart') { console.log(flags.json ? JSON.stringify({ running: false }) : 'Hub stopped'); return; }
      }
      else throw error;
    }
    if (command === 'hub' && id === 'restart') {
      if (!client.closed) {
        const closed = new Promise(resolve => client.socket.once('close', resolve));
        await client.request('hub.stop');
        let timer;
        try { await Promise.race([closed, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Hub did not stop')), 15000); })]); }
        finally { clearTimeout(timer); }
      }
      client.close();
      client.options.autoStart = true;
      client.options.allowProtocolMismatch = false;
      await client.connect();
      console.log(flags.json ? JSON.stringify(client.hello) : `Hub restarted (pid ${client.hello.pid})`);
      return;
    }
    const prompt = () => {
      const positional = (command === 'new' ? words.slice(1) : rest).join(' ');
      if (flags['prompt-file'] && positional) throw fault('INVALID_PARAMS', 'Use either --prompt-file or a positional prompt');
      const text = flags['prompt-file'] ? fs.readFileSync(flags['prompt-file'], 'utf8') : positional;
      if (!text.trim()) throw fault('INVALID_PARAMS', 'A nonempty prompt is required');
      return text;
    };
    const request = (method, params) => client.request(method, params);
    const mutate = (method, params) => request(method, { ...params, force: flags.force });
    const sandbox = () => (flags['full-access'] === undefined ? undefined : flags['full-access'] ? 'danger-full-access' : 'workspace-write');
    let result;
    if (command === 'hub') result = id === 'status' ? client.hello : await request('hub.stop');
    if (command === 'new') {
      if (!flags.cwd) throw fault('INVALID_PARAMS', 'new requires --cwd');
      result = await request('session.create', { cwd: flags.cwd, prompt: prompt(), model: flags.model, effort: flags.effort, title: flags.title, dirs: flags.dir, network: flags.network, sandbox: sandbox() });
    }
    if (command === 'send') result = await mutate('session.send', { id, prompt: prompt(), model: flags.model, effort: flags.effort });
    if (command === 'steer') result = await mutate('session.steer', { id, text: rest.join(' ') });
    if (command === 'stop') result = await mutate('session.interrupt', { id });
    if (command === 'ls') result = await request('session.list', flags.mine ? { owner } : {});
    if (command === 'show') {
      result = await request('session.get', { id });
      if (flags.events !== undefined) result = { session: result, events: await request('session.events', { id, limit: Number(flags.events) }) };
    }
    if (command === 'wait') {
      const timeoutMs = flags.timeout === undefined ? undefined : Number(flags.timeout) * 1000;
      result = await request('session.wait', { id, timeoutMs });
      if (result.status !== 'idle') process.exitCode = 1;
    }
    if (command === 'config') result = await mutate('session.configure', { id, model: flags.model, effort: flags.effort, dirs: flags.dir, network: flags.network, sandbox: sandbox() });
    if (command === 'rename') result = await mutate('session.rename', { id, title: rest.join(' ') });
    if (command === 'archive') result = await mutate('session.archive', { id });
    if (flags.json) console.log(JSON.stringify(result));
    else if (command === 'ls') console.log(result.map(display).join('\n') || 'No sessions');
    else if (command === 'wait') console.log(`${result.id}  ${result.status}\n${result.lastMessage || result.lastLine}`);
    else if (result?.session) console.log(`${display(result.session)}\n${result.events.map(e => JSON.stringify(e)).join('\n')}`);
    else if (result?.id) console.log(display(result));
    else if (command === 'hub') console.log(id === 'status' ? `Hub ${result.version} running (pid ${result.pid})` : 'Hub stopping');
    else console.log('OK');
  } finally { client.close(); }
}

main().catch(error => {
  console.error(jsonOutput ? JSON.stringify({ error: { ...error, code: error.code ?? 'INTERNAL', message: error.message } }) : error.message);
  process.exitCode = 1;
});
