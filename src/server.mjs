#!/usr/bin/env node
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { AppServer } from './codex.mjs';
import { Sessions } from './sessions.mjs';
import { hubEndpoint, stateDirectory, VERSION } from './config.mjs';
import { PROTOCOL, methods, validate, fault } from './protocol.mjs';

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

export class Hub extends Sessions {
  constructor({ endpoint = hubEndpoint(), directory = stateDirectory(), appFactory } = {}) {
    super(directory);
    this.endpoint = endpoint;
    this.clients = new Set();
    this.app = appFactory ? appFactory(this) : new AppServer(
      (method, params) => this.notification(method, params),
      error => { console.error(error.message); void this.stop(); },
    );
  }
  lock() {
    fs.mkdirSync(path.join(this.directory, 'sessions'), { recursive: true, mode: 0o700 });
    this.lockPath = path.join(this.directory, 'hub.lock');
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fd = fs.openSync(this.lockPath, 'wx', 0o600);
        fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, endpoint: this.endpoint }));
        fs.closeSync(fd);
        this.ownsLock = true;
        return;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        let old;
        try { old = JSON.parse(fs.readFileSync(this.lockPath, 'utf8')); }
        catch { throw new Error('Hub startup lock is incomplete; retry shortly'); }
        if (alive(old.pid)) throw new Error(`Hub already running/starting (pid ${old.pid})`);
        fs.unlinkSync(this.lockPath);
      }
    }
    throw new Error('Could not acquire hub lock');
  }
  async start() {
    this.lock();
    try {
      this.load();
      this.server = net.createServer(socket => this.accept(socket));
      if (process.platform !== 'win32' && fs.existsSync(this.endpoint)) {
        const live = await new Promise((resolve, reject) => {
          const probe = net.connect(this.endpoint);
          probe.on('connect', () => { probe.destroy(); resolve(true); });
          probe.on('error', e => ['ECONNREFUSED', 'ENOENT'].includes(e.code) ? resolve(false) : reject(e));
        });
        if (live) throw new Error('Hub endpoint is already in use');
        fs.unlinkSync(this.endpoint);
      }
      // Bind first: simultaneous auto-starts cannot create multiple app-servers.
      await new Promise((resolve, reject) => {
        this.server.once('error', reject);
        this.server.listen(this.endpoint, () => { this.server.off('error', reject); resolve(); });
      });
      this.bound = true;
      if (process.platform !== 'win32') fs.chmodSync(this.endpoint, 0o600);
      this.ready = this.initialize();
      await this.ready;
      fs.writeFileSync(this.lockPath, JSON.stringify({ pid: process.pid, endpoint: this.endpoint, appServerPid: this.app.proc?.pid ?? null }));
      this.server.on('error', error => { console.error(error); void this.stop(); });
      return this;
    } catch (error) { await this.stop(); throw error; }
  }
  async initialize() {
    await this.app.start();
    try {
      const models = [];
      let cursor;
      do {
        const page = await this.app.request('model/list', { includeHidden: true, ...(cursor ? { cursor } : {}) }, { timeoutMs: 5000, fatal: false });
        if (!Array.isArray(page.data)) return;
        models.push(...page.data);
        cursor = page.nextCursor;
      } while (cursor);
      if (models.length) this.models = models;
    } catch { /* Discovery is optional; Codex remains the authority. */ }
  }
  emit(id, payload) {
    const event = super.emit(id, payload);
    for (const client of this.clients) {
      if (client.replaying) client.backlog.push(event);
      else if (client.subscribed) this.write(client, { event });
    }
    return event;
  }
  hello(client, p) {
    if (p.protocol !== PROTOCOL) throw fault('PROTOCOL_MISMATCH', 'Protocol mismatch; run codex-hub hub restart when idle.');
    if (client.identity) throw fault('INVALID_PARAMS', 'hello: connection identity is fixed');
    client.identity = Object.freeze({ client: p.client, owner: p.owner });
    return { protocol: PROTOCOL, version: VERSION, pid: process.pid };
  }
  async dispatch(client, method, p) {
    if (this.stopping) throw fault('HUB_STOPPING', 'Hub is stopping');
    const entry = Object.hasOwn(methods, method) && methods[method];
    if (!entry) throw fault('NOT_FOUND', `Unknown method: ${method}`);
    validate(p, entry.params);
    if (method === 'hello') return entry.handler(this, p, client);
    if (!client.identity && method !== 'hub.stop') throw fault('OWNER_REQUIRED', 'Send hello before making requests.');
    await this.ready;
    if (this.stopping) throw fault('HUB_STOPPING', 'Hub is stopping');
    const session = p.id === undefined ? undefined : this.resolve(p.id);
    if (entry.mutation && session) return this.mutate(session, p, client, entry.handler);
    if (session) await this.queues.get(session.id)?.catch(() => {});
    return entry.handler(this, p, client, session);
  }
  subscribe(client, p) {
    const sessions = this.list();
    const events = p.replay ? sessions.flatMap(s => this.events(s.id, 0, p.replay)).sort((a, b) => a.seq - b.seq) : [];
    client.replaying = true; client.subscribed = true;
    setImmediate(() => {
      for (const event of [...events, ...client.backlog]) this.write(client, { event });
      client.backlog = []; client.replaying = false;
    });
    return { sessions, seq: this.seq };
  }
  write(client, value) {
    if (client.socket.destroyed) return;
    // Disconnect slow consumers; they can recover with subscribe/replay.
    if (client.socket.writableLength > 8 * 1024 * 1024) { client.socket.destroy(); return; }
    client.socket.write(JSON.stringify(value) + '\n');
  }
  accept(socket) {
    const client = { socket, identity: null, subscribed: false, replaying: false, backlog: [] };
    this.clients.add(client);
    socket.on('error', () => {});
    socket.on('close', () => this.clients.delete(client));
    const reader = readline.createInterface({ input: socket });
    reader.on('error', () => {});
    reader.on('line', row => {
      let message;
      try { message = JSON.parse(row); }
      catch { this.write(client, { id: null, error: { code: 'INVALID_PARAMS', message: 'Invalid JSON' } }); return; }
      const { id, method, params = {} } = message || {};
      Promise.resolve().then(async () => {
        if (!message || typeof message !== 'object' || Array.isArray(message)) throw fault('INVALID_PARAMS', 'request must be an object');
        this.write(client, { id, result: await this.dispatch(client, method, params) });
      }).catch(error => this.write(client, { id: id ?? null, error: { ...error, code: error.code ?? 'CODEX_ERROR', message: error.message } }));
    });
  }
  stop() {
    if (this.stopPromise) return this.stopPromise;
    this.stopping = true;
    this.stopPromise = (async () => {
      const serverClosed = this.bound ? new Promise(resolve => this.server.close(resolve)) : Promise.resolve();
      await this.app.close();
      await Promise.allSettled([...this.queues.values()]);
      for (const session of this.sessions.values()) {
        if (session.status === 'running') this.finish(session, { status: 'interrupted', error: { message: 'Hub stopped' } });
      }
      if (this.ownsLock && this.loaded) { this.flush(); this.persist(); }
      // Let pending wait RPCs send terminal session snapshots before ending sockets.
      await new Promise(resolve => setImmediate(resolve));
      for (const client of this.clients) client.socket.end();
      const sockets = [...this.clients].map(c => c.socket);
      const timer = setTimeout(() => sockets.forEach(s => s.destroy()), 200);
      await serverClosed;
      clearTimeout(timer);
      if (this.ownsLock) { fs.unlinkSync(this.lockPath); this.ownsLock = false; }
      this.stopped = true;
    })();
    return this.stopPromise;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const hub = new Hub();
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => void hub.stop());
  hub.start().then(() => console.error(`codex-hub ${VERSION} pid=${process.pid} ${hub.endpoint}`))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
