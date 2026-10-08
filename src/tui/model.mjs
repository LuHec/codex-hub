import { sameOwner } from "../config.mjs";
// Keeps each session's raw hub events (ordered by seq) and folds them into display blocks.
// Live events and on-demand history can arrive in any order; sorting by seq and
// re-folding keeps the transcript complete and correct.

const MAX_EVENTS = 20000;

export class Model {
  constructor() {
    this.sessions = new Map(); // id -> Session
    this.events = new Map(); // id -> Event[] sorted by seq
    this.cache = new Map(); // id -> { blocks, count }
    this.seen = new Set();
    this.loadedHistory = new Set();
    this.snapshotSeq = 0; // sessions from subscribe are newer than any replayed session snapshot
    this.connected = false;
    this.error = null;
  }

  // A subscribe snapshot is the full list: replace, so sessions archived meanwhile disappear.
  setSessions(list) {
    this.sessions.clear();
    for (const s of list) this.sessions.set(s.id, s);
  }

  list({ owner = null } = {}) {
    return [...this.sessions.values()]
      .filter((s) => !s.archived && (!owner || sameOwner(s.owner, owner)))
      .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  }

  apply(ev) {
    if (ev.seq != null) {
      if (this.seen.has(ev.seq)) return;
      this.seen.add(ev.seq);
    }
    if (ev.session && !(ev.seq != null && ev.seq <= this.snapshotSeq)) this.sessions.set(ev.session.id, ev.session);
    if (ev.kind === "plan.updated") {
      const s = this.sessions.get(ev.sessionId);
      if (s) s.plan = ev.plan;
    }
    if (ev.kind === "session.created" || ev.kind === "session.updated") return;
    const list = this.events.get(ev.sessionId) ?? [];
    this.events.set(ev.sessionId, list);
    let i = list.length;
    while (i > 0 && (list[i - 1].seq ?? 0) > (ev.seq ?? Infinity)) i--;
    list.splice(i, 0, ev);
    if (list.length > MAX_EVENTS) list.splice(0, list.length - MAX_EVENTS);
    this.cache.delete(ev.sessionId);
  }

  blocksFor(id) {
    const hit = this.cache.get(id);
    if (hit) return hit;
    const blocks = fold(this.events.get(id) ?? []);
    this.cache.set(id, blocks);
    return blocks;
  }
}

function fold(events) {
  const blocks = [];
  const byItem = new Map();
  for (const ev of events) {
    const last = blocks[blocks.length - 1];
    switch (ev.kind) {
      case "turn.started":
        blocks.push({ type: "turn", ts: ev.ts, prompt: ev.prompt, by: ev.by });
        break;
      case "turn.completed":
        blocks.push({ type: "end", ts: ev.ts, status: ev.status, error: ev.error });
        break;
      case "message.delta":
      case "message.done":
      case "reasoning.delta":
      case "reasoning.done": {
        const type = ev.kind.startsWith("reasoning") ? "reasoning" : "message";
        const key = `${type}:${ev.itemId}`;
        let b = byItem.get(key);
        if (!b) {
          b = { type, itemId: ev.itemId, text: "" };
          byItem.set(key, b);
          blocks.push(b);
        }
        b.text = ev.kind.endsWith(".done") ? ev.text : b.text + ev.text;
        break;
      }
      case "command.started": {
        const b = { type: "command", itemId: ev.itemId, command: ev.command, exitCode: undefined };
        byItem.set(`command:${ev.itemId}`, b);
        blocks.push(b);
        break;
      }
      case "command.done": {
        const b = byItem.get(`command:${ev.itemId}`);
        if (b) b.exitCode = ev.exitCode;
        break;
      }
      case "tool.updated": {
        const key = `tool:${ev.itemId}`;
        let b = byItem.get(key);
        if (!b) {
          b = { type: "tool", itemId: ev.itemId, title: "Tool", status: "in_progress" };
          byItem.set(key, b); blocks.push(b);
        }
        for (const field of ["title", "status", "rawInput", "content"]) if (ev[field] !== undefined) b[field] = ev[field];
        break;
      }
      case "file.changed":
        if (last?.type === "files") last.paths.add(ev.path);
        else blocks.push({ type: "files", paths: new Set([ev.path]) });
        break;
      case "image.generated":
        blocks.push({ type: "image", path: ev.path });
        break;
      case "steer":
        blocks.push({ type: "steer", text: ev.text, by: ev.by });
        break;
      case "error":
        blocks.push({ type: "error", text: ev.message });
        break;
      default:
        break;
    }
  }
  return blocks;
}
