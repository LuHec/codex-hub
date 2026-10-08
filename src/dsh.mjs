import { spawn } from 'node:child_process';
import readline from 'node:readline';
import path from 'node:path';
import fs from 'node:fs';
import { fault } from './protocol.mjs';
import { VERSION } from './config.mjs';

// ACP selectors are kept verbatim; only the display name is shortened.
export const choices = option => (option?.options ?? []).flatMap(o => o.options ?? [o]);
export function modelName(value) {
  try { const route = JSON.parse(value); if (Array.isArray(route) && route.length === 2) return route[1]; } catch {}
  return value;
}
export function selection(options) {
  const model = options.find(o => o.id === 'model')?.currentValue;
  return { model: modelName(model) ?? null, effort: options.find(o => o.id === 'reasoning_effort')?.currentValue ?? null };
}

// One ACP process, independent sessions. No Codex protocol or state enters here.
export class Dsh {
  constructor({ directory, onEvent, onExit, command = process.env.DSH_BIN || 'dsh', home = process.env.CODEX_HUB_DSH_HOME || path.join(directory, 'dsh') }) {
    this.home = home;
    this.onEvent = onEvent;
    this.onExit = onExit;
    const bundled = path.join(home, 'runtime', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
    this.command = command === 'dsh' && !process.env.DSH_BIN && fs.existsSync(bundled) ? bundled : command;
    this.pending = new Map();
    this.sessions = new Map();
    this.nextId = 1;
  }
  start() {
    if (this.closing) return Promise.reject(fault('DSH_ERROR', 'DSH stopped'));
    return this.started ??= this.boot().catch(async error => {
      this.fail(error);
      await this.close();
      throw error;
    });
  }
  async boot() {
    const script = /\.[cm]?js$/i.test(this.command);
    const shell = !script && process.platform === 'win32' && (this.command === 'dsh' || /\.(cmd|bat)$/i.test(this.command));
    const executable = script ? process.execPath : shell && /\s/.test(this.command) ? `"${this.command}"` : this.command;
    this.proc = spawn(executable, [...(script ? [this.command] : []), '--profile', 'acp'], {
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell,
      env: { ...process.env, DSH_HOME: this.home },
    });
    this.stderr = '';
    this.exited = new Promise(resolve => { this.resolveExit = resolve; });
    this.proc.stderr.setEncoding('utf8').on('data', text => { this.stderr = (this.stderr + text).slice(-8192); });
    this.proc.on('error', error => { this.resolveExit(); this.fail(fault('DSH_ERROR', error.message)); });
    this.proc.on('exit', (code, signal) => {
      this.resolveExit();
      this.fail(fault('DSH_ERROR', `dsh exited (${signal || code})`));
    });
    this.proc.stdin.on('error', error => this.fail(fault('DSH_ERROR', error.message)));
    this.lines = readline.createInterface({ input: this.proc.stdout });
    this.lines.on('line', line => {
      try { this.receive(JSON.parse(line)); }
      catch (error) { this.fail(fault('DSH_ERROR', `Invalid ACP frame: ${error.message}`)); }
    });
    const hello = await this.request('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'codex-hub', version: VERSION } });
    if (hello.protocolVersion !== 1 || !hello.agentCapabilities?.sessionCapabilities?.resume) {
      throw fault('DSH_ERROR', 'DSH must support ACP v1 session/resume (tested with 0.1.5-rc.1).');
    }
  }
  write(message) {
    if (this.dead) throw this.dead;
    this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
  }
  receive(msg) {
    if (msg.method && msg.id !== undefined) {
      if (msg.method === 'session/request_permission' && this.sessions.has(msg.params?.sessionId)) {
        const option = msg.params.options?.find(o => o.kind === 'allow_once');
        this.write({ id: msg.id, result: { outcome: option ? { outcome: 'selected', optionId: option.optionId } : { outcome: 'cancelled' } } });
      } else this.write({ id: msg.id, error: { code: -32601, message: `Unsupported ACP request: ${msg.method}` } });
    } else if (msg.id !== undefined) {
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id); clearTimeout(pending.timer);
      msg.error ? pending.reject(fault(msg.error.code === -32602 ? 'INVALID_PARAMS' : 'DSH_ERROR', msg.error.message)) : pending.resolve(msg.result);
    } else if (msg.method === 'session/update') this.notification(msg.params.sessionId, msg.params.update);
  }
  request(method, params, timeoutMs = 30_000) {
    if (this.dead) return Promise.reject(this.dead);
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      // A prompt may run for hours; cancellation is a separate ACP notification.
      const timer = timeoutMs ? setTimeout(() => this.fail(fault('DSH_ERROR', `ACP request timed out: ${method}`)), timeoutMs) : null;
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ id, method, params }); } catch (error) { this.fail(error); }
    });
  }
  snapshot(session) {
    const id = session.dsh.id;
    const options = this.sessions.get(id)?.options ?? session.dsh.configOptions;
    const model = options.find(o => o.id === 'model');
    const effort = options.find(o => o.id === 'reasoning_effort');
    return structuredClone({ dsh: { id, configOptions: options }, ...selection(options),
      modelValue: model?.currentValue ?? null,
      modelOptions: choices(model).map(o => ({ slug: o.value, label: o.name,
        efforts: o.value === model.currentValue ? choices(effort).map(e => e.value) : [], def: effort?.currentValue })) });
  }
  access(p) {
    if (p.dirs?.length || p.network !== undefined || (p.sandbox !== undefined && p.sandbox !== 'danger-full-access')) {
      throw fault('UNSUPPORTED', 'DSH uses its own workspace policy; dirs, network and workspace-write are not supported.');
    }
  }
  async create(p) {
    this.access(p);
    await this.start();
    const result = await this.request('session/new', { cwd: p.cwd, mcpServers: [] });
    const state = { id: result.sessionId, options: result.configOptions ?? [], texts: new Map() };
    this.sessions.set(state.id, state);
    const session = { id: 'dsh:' + state.id, cwd: p.cwd, dsh: { id: state.id, configOptions: state.options } };
    try { return { id: session.id, ...await this.prepare(session, p) }; }
    catch (error) { await this.release(state.id).catch(() => {}); throw error; }
  }
  async resume(session) {
    await this.start();
    if (this.sessions.has(session.dsh.id)) return this.sessions.get(session.dsh.id);
    const previous = session.dsh.configOptions;
    const result = await this.request('session/resume', { sessionId: session.dsh.id, cwd: session.cwd, mcpServers: [] });
    const state = { id: session.dsh.id, options: result.configOptions ?? [], texts: new Map(), configuring: true };
    this.sessions.set(state.id, state);
    try {
      await this.apply(state, { model: previous.find(o => o.id === 'model')?.currentValue,
        effort: previous.find(o => o.id === 'reasoning_effort')?.currentValue });
      return state;
    } catch (error) { await this.release(state.id).catch(() => {}); throw error; }
    finally { state.configuring = false; }
  }
  async apply(state, p) {
    for (const [field, configId] of [['model', 'model'], ['effort', 'reasoning_effort']]) {
      if (p[field] == null) continue;
      const option = state.options.find(o => o.id === configId);
      let found = choices(option).filter(o => o.value === p[field] || (field === 'model' && modelName(o.value) === p[field]));
      // Prefer the current provider for a short model name shared by several routes.
      if (field === 'model' && found.length > 1) {
        try {
          const provider = JSON.parse(option.currentValue)[0];
          found = found.filter(o => JSON.parse(o.value)[0] === provider);
        } catch { /* Require an explicit selector when route identity is unavailable. */ }
      }
      if (found.length !== 1) throw fault('INVALID_PARAMS', field + ' is not offered by DSH: ' + p[field]);
      if (option.currentValue === found[0].value) continue;
      const result = await this.request('session/set_config_option', { sessionId: state.id, configId, value: found[0].value });
      state.options = result.configOptions;
    }
  }
  async prepare(session, p) {
    const state = await this.resume(session);
    const previous = structuredClone(state.options);
    state.configuring = true;
    try { await this.apply(state, p); }
    catch (error) {
      try {
        await this.apply(state, { model: previous.find(o => o.id === 'model')?.currentValue,
          effort: previous.find(o => o.id === 'reasoning_effort')?.currentValue });
      } catch (rollback) {
        this.onEvent(session.id, { kind: 'settings.updated', patch: this.snapshot(session) });
        throw fault('DSH_ERROR', error.message + '; restoring selection failed: ' + rollback.message);
      }
      throw error;
    } finally { state.configuring = false; }
    return this.snapshot(session);
  }
  configure(session, p) {
    this.access(p);
    if (!p.model && !p.effort) throw fault('INVALID_PARAMS', 'configure needs model or effort');
    return this.prepare(session, p);
  }
  async run(session, text) {
    const state = this.sessions.get(session.dsh.id);
    const turnId = 'dsh-turn-' + (session.turns + 1);
    state.turnId = turnId; state.texts.clear();
    // Prompt stays pending on ACP; completion goes through the same event sink as Codex.
    state.task = this.request('session/prompt', { sessionId: state.id, prompt: [{ type: 'text', text }] }, 0).then(result => {
      if (state.turnId !== turnId) return;
      const status = result.stopReason === 'cancelled' ? 'interrupted' : result.stopReason === 'end_turn' ? 'completed' : 'failed';
      state.turnId = null;
      this.onEvent(session.id, { kind: 'execution.completed', status,
        ...(status === 'failed' ? { error: { message: 'DSH stopped: ' + result.stopReason } } : {}) });
    }, error => {
      if (state.turnId !== turnId) return;
      state.turnId = null;
      this.onEvent(session.id, { kind: 'execution.completed', status: this.closing ? 'interrupted' : 'failed', error });
    });
  }
  notification(id, update) {
    const state = this.sessions.get(id);
    if (!state) return;
    if (update.sessionUpdate === 'config_option_update') {
      state.options = update.configOptions;
      if (!state.configuring) this.onEvent('dsh:' + id, { kind: 'settings.updated', patch: this.snapshot({ dsh: { id } }) });
      return;
    }
    if (!state.turnId) return;
    for (const event of translateDsh(update, state.turnId + ':' + (update.messageId ?? 'answer'))) {
      if (event.kind === 'message.done' || event.kind === 'reasoning.done') {
        const key = event.kind + ':' + event.itemId;
        event.text = (state.texts.get(key) ?? '') + event.text;
        state.texts.set(key, event.text);
      } else if (event.kind === 'tool.updated') event.itemId = state.turnId + ':' + event.itemId;
      this.onEvent('dsh:' + id, event);
    }
  }
  steer() { throw fault('UNSUPPORTED', 'DSH does not support steering; stop the turn, then send a follow-up.'); }
  interrupt(session) { this.write({ method: 'session/cancel', params: { sessionId: session.dsh.id } }); }
  async release(id) {
    if (!this.sessions.has(id) || this.dead) return;
    await this.request('session/close', { sessionId: id });
    this.sessions.delete(id);
  }
  fail(error) {
    if (this.dead) return;
    this.dead = error;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
    this.pending.clear();
    if (!this.closing) this.onExit(error);
  }
  close() { return this.closed ??= this.shutdown(); }
  async shutdown() {
    this.closing = true;
    if (!this.proc) return;
    this.proc.stdin.end();
    let timer;
    const exited = await Promise.race([this.exited.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), 3000); })]);
    clearTimeout(timer);
    if (!exited && this.proc.pid) {
      if (process.platform === 'win32') await new Promise(resolve => {
        const killer = spawn('taskkill', ['/PID', String(this.proc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        killer.on('error', resolve); killer.on('exit', resolve);
      });
      this.proc.kill('SIGKILL');
      const stopped = await Promise.race([this.exited.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), 3000); })]);
      clearTimeout(timer);
      if (!stopped) throw fault('DSH_ERROR', `Could not stop dsh pid ${this.proc.pid}`);
    }
    this.fail(fault('DSH_ERROR', 'DSH stopped'));
    this.lines?.close();
  }
}

// ACP reports generic tools, not shell exit codes or Codex file-change items.
export function translateDsh(update, itemId) {
  switch (update.sessionUpdate) {
    case 'agent_message_chunk':
    case 'agent_thought_chunk':
      return update.content?.type === 'text' ? [{ kind: update.sessionUpdate === 'agent_message_chunk' ? 'message.done' : 'reasoning.done', itemId, text: update.content.text, final: update.sessionUpdate === 'agent_message_chunk' }] : [];
    case 'tool_call':
    case 'tool_call_update':
      return [{ kind: 'tool.updated', itemId: update.toolCallId, ...Object.fromEntries(['title', 'status', 'rawInput', 'content'].filter(k => update[k] !== undefined).map(k => [k, update[k]])) }];
    default: return [];
  }
}
