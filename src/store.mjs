import fs from 'node:fs';
import path from 'node:path';

// The sole historical harness assumption, confined to v1 storage migration.
function migrateOwner(owner) {
  if (typeof owner !== 'string') return owner ?? null;
  const at = owner.indexOf(':');
  return at < 0 ? { harness: 'claude', id: owner } : { harness: owner.slice(0, at), id: owner.slice(at + 1) };
}
export class Store {
  constructor(directory) {
    this.directory = directory;
    this.sessions = new Map();
    this.archived = new Set();
    this.seq = 0;
  }
  statePath() { return path.join(this.directory, 'state.json'); }
  eventPath(id) { return path.join(this.directory, 'sessions', `${id}.jsonl`); }
  persist() {
    const target = this.statePath();
    fs.writeFileSync(`${target}.tmp`, JSON.stringify({ version: 2, seq: this.seq,
      sessions: [...this.sessions.values()], archived: [...this.archived] }, null, 2), { mode: 0o600 });
    fs.renameSync(`${target}.tmp`, target);
  }
  load() {
    if (fs.existsSync(this.statePath())) {
      const state = JSON.parse(fs.readFileSync(this.statePath(), 'utf8'));
      if (![1, 2].includes(state.version ?? 1)) throw new Error(`Unsupported state version: ${state.version}`);
      this.seq = state.seq || 0;
      for (const session of state.sessions || []) this.sessions.set(session.id, { ...session, owner: migrateOwner(session.owner) });
      this.archived = new Set(state.archived || []);
    }
    // Journals are the recovery source if the process died before state replacement:
    // a journaled snapshot counts only when it is newer than state.json.
    const stateSeq = this.seq;
    for (const file of fs.readdirSync(path.join(this.directory, 'sessions'))) {
      if (!file.endsWith('.jsonl')) continue;
      const filename = path.join(this.directory, 'sessions', file);
      const data = fs.readFileSync(filename, 'utf8');
      const complete = data.lastIndexOf('\n') + 1;
      if (complete < data.length) fs.truncateSync(filename, Buffer.byteLength(data.slice(0, complete)));
      const rows = data.slice(0, complete).split('\n').filter(Boolean).map(row => JSON.parse(row));
      for (const event of rows) {
        this.seq = Math.max(this.seq, event.seq);
        if (event.session && (event.seq > stateSeq || !this.sessions.has(event.sessionId))) this.sessions.set(event.sessionId, { ...event.session, owner: migrateOwner(event.session.owner) });
      }
    }
    this.persist();
    this.loaded = true;
  }
  append(event) {
    fs.appendFileSync(this.eventPath(event.sessionId), JSON.stringify(event) + '\n', { mode: 0o600 });
  }
  history(id) {
    const text = fs.existsSync(this.eventPath(id)) ? fs.readFileSync(this.eventPath(id), 'utf8') : '';
    return text.split('\n').filter(Boolean).map(row => {
      const event = JSON.parse(row);
      if (event.session) event.session.owner = migrateOwner(event.session.owner);
      if ('by' in event) event.by = migrateOwner(event.by);
      return event;
    });
  }
}
