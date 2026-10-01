import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { fault } from './protocol.mjs';
import { resolveCodexCommand, VERSION } from './config.mjs';

export class AppServer {
  constructor(onNotification, onExit) {
    this.pending = new Map();
    this.nextId = 1;
    this.onNotification = onNotification;
    this.onExit = onExit;
  }
  async start() {
    const command = resolveCodexCommand();
    const shell = process.platform === 'win32' && (command === 'codex' || /\.(cmd|bat)$/i.test(command));
    this.proc = spawn(shell && /\s/.test(command) ? `"${command}"` : command, ['app-server'], {
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell,
      detached: process.platform !== 'win32',
    });
    this.stderr = '';
    this.proc.stderr.setEncoding('utf8').on('data', chunk => { this.stderr = (this.stderr + chunk).slice(-8192); });
    this.exited = new Promise(resolve => { this.resolveExit = resolve; });
    this.proc.on('error', error => { this.resolveExit(); this.fail(fault('CODEX_ERROR', error.message)); });
    this.proc.on('exit', (code, signal) => {
      this.resolveExit();
      this.fail(fault('CODEX_ERROR', `codex app-server exited (${signal || code}) ${this.stderr.trim()}`));
    });
    this.proc.stdin.on('error', error => this.fail(fault('CODEX_ERROR', error.message)));
    this.lines = readline.createInterface({ input: this.proc.stdout });
    this.lines.on('error', error => this.fail(fault('CODEX_ERROR', error.message)));
    this.lines.on('line', line => {
      try {
        let msg;
        try { msg = JSON.parse(line); } catch (error) { throw fault('CODEX_ERROR', error.message); }
        if (msg.method && msg.id !== undefined) {
          this.write({ id: msg.id, error: { code: -32601, message: `Unsupported server request: ${msg.method}` } });
        } else if (msg.id !== undefined) {
          const p = this.pending.get(msg.id);
          if (!p) return;
          this.pending.delete(msg.id);
          clearTimeout(p.timer);
          msg.error ? p.reject(fault('CODEX_ERROR', msg.error.message)) : p.resolve(msg.result);
        } else if (msg.method) this.onNotification(msg.method, msg.params || {});
      } catch (error) { this.fail(error); }
    });
    await this.request('initialize', {
      clientInfo: { name: 'codex_hub', title: 'Codex Hub', version: VERSION },
      capabilities: { experimentalApi: false, optOutNotificationMethods: ['item/reasoning/textDelta'] },
    });
    this.write({ method: 'initialized', params: {} });
  }
  write(message) {
    if (this.dead) throw this.dead;
    this.proc.stdin.write(JSON.stringify(message) + '\n');
  }
  request(method, params, { timeoutMs = 120_000, fatal = true } = {}) {
    if (this.dead) return Promise.reject(this.dead);
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        const error = fault('CODEX_ERROR', `app-server request timed out: ${method}`);
        if (fatal) this.fail(error);
        else { this.pending.delete(id); reject(error); }
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ id, method, params }); }
      catch (error) { this.fail(error); }
    });
  }
  fail(error) {
    if (this.dead) return;
    error = error.code ? error : fault('INTERNAL', error.message);
    this.dead = error;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
    this.pending.clear();
    if (!this.closing) this.onExit(error);
  }
  async close() {
    this.closing = true;
    if (!this.proc?.pid) return;
    // Kill only our process tree; includes commands still running at shutdown.
    if (process.platform === 'win32') {
      const killed = await new Promise(resolve => {
        const killer = spawn('taskkill', ['/PID', String(this.proc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        killer.on('error', () => resolve(false)); killer.on('exit', code => resolve(code === 0));
      });
      // Restricted Windows environments can deny taskkill's process enumeration.
      // EOF requests Codex's own cleanup; fall back to terminating our direct child.
      if (!killed) this.proc.stdin.end();
    } else {
      this.proc.stdin.end();
      try { process.kill(-this.proc.pid, 'SIGTERM'); } catch { /* Already exited. */ }
      await new Promise(resolve => setTimeout(resolve, 100));
      try { process.kill(-this.proc.pid, 'SIGKILL'); } catch { /* Already exited. */ }
    }
    const waitForExit = async ms => {
      let timer;
      const result = await Promise.race([this.exited.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), ms); })]);
      clearTimeout(timer);
      return result;
    };
    if (!await waitForExit(1500)) {
      this.proc.kill('SIGKILL');
      if (!await waitForExit(1500)) throw fault('CODEX_ERROR', `Could not stop app-server pid ${this.proc.pid}`);
    }
    this.fail(fault('CODEX_ERROR', 'app-server stopped'));
    this.lines?.close();
  }
}
