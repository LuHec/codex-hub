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
  }
  statePath() { return path.join(this.directory, 'state.json'); }
  eventPath(id) { return path.join(this.directory, 'sessions', `${id}.jsonl`); }
  persist(state) {
    const target = this.statePath();
    fs.writeFileSync(`${target}.tmp`, JSON.stringify({ version: 2, ...state }, null, 2), { mode: 0o600 });
    fs.renameSync(`${target}.tmp`, target);
  }
  load() {
    let seq = 0, archived = [];
    const sessions = new Map();
    if (fs.existsSync(this.statePath())) {
      const state = JSON.parse(fs.readFileSync(this.statePath(), 'utf8'));
      if (![1, 2].includes(state.version ?? 1)) throw new Error(`Unsupported state version: ${state.version}`);
      seq = state.seq || 0;
      for (const session of state.sessions || []) sessions.set(session.id, { ...session, owner: migrateOwner(session.owner) });
      archived = state.archived || [];
    }
    // Journals are the recovery source if the process died before state replacement:
    // a journaled snapshot counts only when it is newer than state.json.
    const stateSeq = seq;
    for (const file of fs.readdirSync(path.join(this.directory, 'sessions'))) {
      if (!file.endsWith('.jsonl')) continue;
      const filename = path.join(this.directory, 'sessions', file);
      const data = fs.readFileSync(filename, 'utf8');
      const complete = data.lastIndexOf('\n') + 1;
      if (complete < data.length) fs.truncateSync(filename, Buffer.byteLength(data.slice(0, complete)));
      const rows = data.slice(0, complete).split('\n').filter(Boolean).map(row => JSON.parse(row));
      // Convert legacy fields once, even for v2 states written by an older loader.
      // Atomic replacement makes interrupted migration safe to retry; history stays format-neutral.
      let migrated = false;
      for (const event of rows) {
        for (const [object, key] of [[event.session, 'owner'], [event, 'by']]) {
          if (object && typeof object[key] === 'string') { object[key] = migrateOwner(object[key]); migrated = true; }
        }
        seq = Math.max(seq, event.seq);
        if (event.session && (event.seq > stateSeq || !sessions.has(event.sessionId))) sessions.set(event.sessionId, event.session);
      }
      if (migrated) {
        fs.writeFileSync(`${filename}.tmp`, rows.map(e => JSON.stringify(e) + '\n').join(''), { mode: 0o600 });
        fs.renameSync(`${filename}.tmp`, filename);
      }
    }
    const state = { seq, sessions: [...sessions.values()], archived };
    this.persist(state);
    return state;
  }
  append(event) {
    fs.appendFileSync(this.eventPath(event.sessionId), JSON.stringify(event) + '\n', { mode: 0o600 });
  }
  history(id) {
    const text = fs.existsSync(this.eventPath(id)) ? fs.readFileSync(this.eventPath(id), 'utf8') : '';
    return text.split('\n').filter(Boolean).map(JSON.parse);
  }
}
