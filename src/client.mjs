import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { hubEndpoint, stateDirectory } from './config.mjs';

import { fileURLToPath } from 'node:url';
import { PROTOCOL, fault } from './protocol.mjs';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Independent connection; create one for each controller. No request is retried on disconnect. */
export class HubClient {
  constructor(options = {}) {
    this.options = options;
    this.pending = new Map();
    this.listeners = new Set();
    this.nextId = 1;
    this.closed = true;
  }
  async connect() {
    if (!this.closed) return this;
    if (this.connecting) return this.connecting;
    this.connecting = this.open().finally(() => { this.connecting = null; });
    return this.connecting;
  }
  async open() {
    const endpoint = this.options.endpoint || hubEndpoint();
    const deadline = Date.now() + (this.options.startTimeoutMs ?? 30_000);
    let spawned = false;
    while (true) {
      try {
        this.socket = await new Promise((resolve, reject) => {
          const socket = net.connect(endpoint);
          const timer = setTimeout(() => { socket.destroy(); reject(new Error('Hub connection timed out')); }, 2000);
          socket.once('connect', () => { clearTimeout(timer); socket.off('error', fail); resolve(socket); });
          function fail(error) { clearTimeout(timer); socket.destroy(); reject(error); }
          socket.once('error', fail);
        });
        break;
      } catch (error) {
        if (this.options.autoStart === false || !['ENOENT', 'ECONNREFUSED', 'EBUSY'].includes(error.code)) throw error;
        if (Date.now() >= deadline) throw new Error(`Hub did not start: ${error.message}. See ${path.join(stateDirectory(), 'hub.log')}`);
        if (!spawned) {
          const dir = stateDirectory();
          fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
          const log = fs.openSync(path.join(dir, 'hub.log'), 'a', 0o600);
          try {
            const child = spawn(process.execPath, [fileURLToPath(new URL('./server.mjs', import.meta.url))], {
              detached: true, windowsHide: true, stdio: ['ignore', log, log],
              env: { ...process.env, CODEX_HUB_ENDPOINT: endpoint },
            });
            child.on('error', () => {}); child.unref();
          } finally { fs.closeSync(log); }
          spawned = true;
        }
        await delay(100);
      }
    }
    this.closed = false;
    const connectedSocket = this.socket;
    let buffer = '';
    const drop = error => {
      if (this.socket !== connectedSocket) return;
      this.closed = true;
      for (const p of this.pending.values()) p.reject(error);
      this.pending.clear();
    };
    this.socket.setEncoding('utf8');
    this.socket.on('error', drop);
    this.socket.on('close', () => drop(new Error('Hub disconnected')));
    this.socket.on('data', chunk => {
      buffer += chunk;
      let at;
      while ((at = buffer.indexOf('\n')) >= 0) {
        const row = buffer.slice(0, at); buffer = buffer.slice(at + 1);
        if (!row.trim()) continue;
        let msg;
        try { msg = JSON.parse(row); } catch { drop(new Error('Invalid JSON from hub')); this.socket.destroy(); return; }
        if (msg.event) {
          // Defer beyond promise continuations even if response and replay share a packet.
          setImmediate(() => { for (const callback of this.listeners) callback(msg.event); });
        } else {
          const p = this.pending.get(msg.id);
          if (!p) continue;
          this.pending.delete(msg.id);
          msg.error ? p.reject(Object.assign(new Error(msg.error.message), msg.error)) : p.resolve(msg.result);
        }
      }
    });
    try { this.hello = await this.request('hello', { protocol: PROTOCOL, client: this.options.client ?? 'cli', ...(this.options.owner == null ? {} : { owner: this.options.owner }) }); }
    catch (error) {
      if (!this.options.allowProtocolMismatch || error.code !== 'PROTOCOL_MISMATCH') { this.close(); throw error; }
      this.hello = {};
    }
    if (this.hello.protocol !== PROTOCOL && !this.options.allowProtocolMismatch) { this.close(); throw fault('PROTOCOL_MISMATCH', 'Protocol mismatch; run codex-hub hub restart when idle.'); }
    return this;
  }
  request(method, params = {}) {
    if (this.closed) return Promise.reject(new Error('Client is not connected; call connect()'));
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this.socket.write(JSON.stringify({ id, method, params }) + '\n', error => {
        if (error) { this.pending.delete(id); reject(error); }
      });
    });
  }
  /** Resolves to { sessions, seq }; replay defaults to zero. Events may follow immediately. */
  subscribe(onEvent, options = {}) {
    this.listeners.add(onEvent);
    return this.request('subscribe', options).catch(error => { this.listeners.delete(onEvent); throw error; });
  }
  unsubscribe(onEvent) { this.listeners.delete(onEvent); }
  close() {
    this.closed = true;
    for (const p of this.pending.values()) p.reject(new Error('Client closed'));
    this.pending.clear();
    this.socket?.destroy();
  }
}
