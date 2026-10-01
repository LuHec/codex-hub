#!/usr/bin/env node
// codex-hub TUI: live view of every Codex session the hub is running.
//   node src/tui/index.mjs          connect to the hub
//   node src/tui/index.mjs --demo   fake sessions, for trying the UI
import process from "node:process";
import { HubClient } from "../client.mjs";
import { controllerOwner } from "../config.mjs";
import { Model } from "./model.mjs";
import { loadModels } from "./models.mjs";
import { COMMANDS, commandMatches, renderFocus } from "./focus.mjs";
import { render } from "./view.mjs";

const out = process.stdout;
const model = new Model();
const ui = {
  mode: "list", // "list" = sessions + live pane, "focus" = one session full screen (enter / ← ←)
  selected: 0,
  selectedId: null,
  focus: "list",
  scroll: 0,
  tick: 0,
  mineOnly: false,
  owner: controllerOwner(),
  narrow: false,
  input: null,
  flash: null,
  hint: null,
  expanded: false, // ctrl+o: show every tool call instead of folded summaries
  ctrlCAt: 0,
  backAt: 0,
  menuIndex: 0,
  hist: null
};

// ---------- hub connection (see PROTOCOL.md; client.mjs auto-starts the hub) ----------

let hub = null;

function request(method, params = {}) {
  return hub ? hub.request(method, params) : Promise.reject(new Error("hub offline"));
}

function onEvent(ev) {
  model.apply(ev);
  schedule();
}

async function connect() {
  const client = new HubClient({ client: "tui", owner: ui.owner });
  let retried = false;
  const retry = () => {
    if (retried) return;
    retried = true;
    if (hub === client) hub = null;
    model.connected = false;
    schedule();
    setTimeout(connect, 2000);
  };
  try {
    await client.connect();
  } catch (e) {
    model.error = e.message;
    return retry();
  }
  hub = client;
  client.socket.on("close", retry);
  try {
    // No replay: each session's full history is fetched when it is first shown (loadHistory).
    const snap = await client.subscribe(onEvent, { replay: 0 });
    model.snapshotSeq = snap.seq ?? 0;
    model.loadedHistory.clear();
    model.setSessions(snap.sessions ?? []);
    model.connected = true;
    model.error = null;
    schedule();
  } catch (e) {
    flash(`subscribe failed: ${e.message}`, "bad");
  }
}

async function loadHistory(id) {
  if (!id || model.loadedHistory.has(id) || !model.connected) return;
  model.loadedHistory.add(id);
  try {
    // Whole transcript; the model de-duplicates against live events by seq and re-sorts.
    const events = await request("session.events", { id });
    for (const ev of events) model.apply(ev);
    schedule();
  } catch {
    model.loadedHistory.delete(id);
  }
}

// ---------- drawing ----------

let frame = [];
let queued = false;

function schedule() {
  if (queued) return;
  queued = true;
  setTimeout(draw, 16);
}

function draw() {
  queued = false;
  const cols = out.columns || 100;
  const rows = out.rows || 30;
  if (ui.mode === "focus" && !model.sessions.get(ui.selectedId)) leaveFocus();
  const next = (ui.mode === "focus" ? renderFocus : render)(model, ui, cols, rows);
  let buf = ui.cursor ? "" : "\x1b[?25l"; // keep the cursor steady while typing
  for (let i = 0; i < rows; i++) {
    const line = next[i] ?? "";
    // Clear first: lines position text with absolute column jumps, not padding.
    if (frame[i] !== line) buf += `\x1b[${i + 1};1H\x1b[0m\x1b[2K${line}\x1b[0m`;
  }
  frame = next;
  // While typing, park the visible cursor at the input so IME candidates appear there.
  if (ui.cursor) buf += `\x1b[${ui.cursor.row};${ui.cursor.col}H\x1b[?25h`;
  out.write(buf);
  const current = currentSession();
  if (current) loadHistory(current.id);
}

function currentSession() {
  if (ui.mode === "focus") return model.sessions.get(ui.selectedId);
  return model.list({ owner: ui.mineOnly ? ui.owner : null })[ui.selected];
}

// Short-lived gray hint in the status line ("Press Ctrl-C again to exit").
function hint(text) {
  ui.hint = text;
  clearTimeout(hint.timer);
  hint.timer = setTimeout(() => {
    ui.hint = null;
    schedule();
  }, 2000);
}

function flash(text, color = "ok") {
  ui.flash = { text, color };
  schedule();
  clearTimeout(flash.timer);
  flash.timer = setTimeout(() => {
    ui.flash = null;
    schedule();
  }, 3500);
}

// ---------- input ----------

async function act(method, params, done) {
  try {
    await request(method, params);
    if (done) flash(done);
  } catch (e) {
    flash(e.message, "bad");
  }
}

// ---------- model / effort picker ----------

function openPicker(session, col = 0) {
  const models = loadModels();
  if (!models.some((m) => m.slug === session.model)) models.unshift({ slug: session.model, efforts: [session.effort].filter(Boolean), def: session.effort });
  const mi = Math.max(0, models.findIndex((m) => m.slug === session.model));
  ui.picker = { id: session.id, models, mi, ei: 0, col };
  pickEffort(session.effort);
}

function pickEffort(preferred) {
  const p = ui.picker;
  const efforts = p.models[p.mi].efforts;
  const i = efforts.indexOf(preferred);
  p.ei = i >= 0 ? i : Math.max(0, efforts.indexOf(p.models[p.mi].def));
}

function onPickerKey(key) {
  const p = ui.picker;
  const efforts = p.models[p.mi].efforts;
  if (key === "\x1b" || key === "\x03" || key === "q") ui.picker = null;
  else if (key === "\x1b[A" || key === "k" || key === "\x1b[B" || key === "j") {
    const d = key === "\x1b[A" || key === "k" ? -1 : 1;
    if (p.col === 0) {
      const effort = efforts[p.ei];
      p.mi = (p.mi + d + p.models.length) % p.models.length;
      pickEffort(effort);
    } else p.ei = (p.ei + d + efforts.length) % efforts.length;
  } else if (key === "\x1b[C" || key === "\x1b[D" || key === "\t" || key === "l" || key === "h") p.col = p.col ? 0 : 1;
  else if (key === "\r") {
    const model = p.models[p.mi].slug;
    const effort = efforts[p.ei];
    ui.picker = null;
    act("session.configure", { id: p.id, model, effort }, `next turn: ${model} · ${effort}`);
  }
  schedule();
}

// Like controller: Esc interrupts a running turn; Ctrl-C clears the input, else press twice to exit.
function onCtrlC() {
  if (ui.mode === "focus" && ui.input?.text) {
    ui.input.text = "";
    return;
  }
  if (Date.now() - ui.ctrlCAt < 2000) return quit();
  ui.ctrlCAt = Date.now();
  hint("Press Ctrl-C again to exit");
}

function onKey(key) {
  if (ui.picker) return onPickerKey(key);
  if (ui.mode === "focus") return onFocusKey(key);
  if (ui.input) return onInputKey(key);
  const sessions = model.list({ owner: ui.mineOnly ? ui.owner : null });
  const current = sessions[ui.selected];
  switch (key) {
    case "q":
      return quit();
    case "\x03":
      onCtrlC();
      break;
    case "\x1b": // esc
    case "x":
      if (current?.status === "running") act("session.interrupt", { id: current.id }, "interrupt sent");
      break;
    case "\x0f": // ctrl+o
      ui.expanded = !ui.expanded;
      ui.scroll = 0;
      break;
    case "\x1b[A":
    case "k":
      ui.selected = Math.max(0, ui.selected - 1);
      ui.selectedId = sessions[ui.selected]?.id ?? null;
      ui.scroll = 0;
      break;
    case "\x1b[B":
    case "j":
      ui.selected = Math.min(sessions.length - 1, ui.selected + 1);
      ui.selectedId = sessions[ui.selected]?.id ?? null;
      ui.scroll = 0;
      break;
    case "\x1b[5~":
      ui.scroll += Math.max(3, (out.rows || 30) - 12);
      break;
    case "\x1b[6~":
      ui.scroll = Math.max(0, ui.scroll - Math.max(3, (out.rows || 30) - 12));
      break;
    case "\x1b[F":
    case "G":
      ui.scroll = 0;
      break;
    case "\t":
      ui.focus = ui.focus === "list" ? "detail" : "list";
      break;
    case "\r":
      enterFocus(current);
      break;
    case "f":
      ui.mineOnly = !ui.mineOnly;
      ui.selected = 0;
      ui.selectedId = null;
      if (ui.mineOnly && !ui.owner) flash("no owner set (CODEX_HUB_OWNER); showing sessions with no owner", "bad");
      break;
    case "s":
      if (current?.status === "running") ui.input = { kind: "steer", id: current.id, text: "" };
      else flash("steer works on a running session", "bad");
      break;
    case "m":
      if (current && current.status !== "running") ui.input = { kind: "send", id: current.id, text: "" };
      else flash("wait for the turn to finish, or steer instead", "bad");
      break;
    case "p":
      if (current) openPicker(current);
      break;
    default:
      return;
  }
  schedule();
}

// ---------- focus mode: a controller-style terminal for one session ----------

function enterFocus(session) {
  if (!session) return;
  Object.assign(ui, { mode: "focus", selectedId: session.id, scroll: 0, menuIndex: 0, hist: null, hint: null });
  ui.input = { kind: "focus", id: session.id, text: "" };
}

function leaveFocus() {
  Object.assign(ui, { mode: "list", input: null, scroll: 0, hint: null, focus: "list" });
}

function onFocusKey(key) {
  const s = model.sessions.get(ui.selectedId);
  const input = ui.input;
  const menu = commandMatches(input.text);
  const page = Math.max(3, (out.rows || 30) - 10);
  if (key !== "\x1b[D") ui.backAt = 0;
  switch (key) {
    case "\x03":
      onCtrlC();
      break;
    case "\x0f":
      ui.expanded = !ui.expanded;
      ui.scroll = 0;
      break;
    case "\x1b": // esc: close the command menu, else interrupt, else clear the input
      if (!menu.length && s?.status === "running") act("session.interrupt", { id: s.id }, null);
      else input.text = "";
      break;
    case "\x1b[D": // ← ← on an empty input goes back to the session list
      if (input.text) break;
      if (Date.now() - ui.backAt < 800) {
        leaveFocus();
        break;
      }
      ui.backAt = Date.now();
      hint("Press ← again to go back");
      break;
    case "\x1b[A":
    case "\x1b[B": {
      const d = key === "\x1b[A" ? -1 : 1;
      if (menu.length) ui.menuIndex = (ui.menuIndex + d + menu.length) % menu.length;
      else recall(s, d);
      break;
    }
    case "\t":
      if (menu.length) input.text = `/${menu[ui.menuIndex][0]} `;
      break;
    case "\x1b[5~":
      ui.scroll += page;
      break;
    case "\x1b[6~":
      ui.scroll = Math.max(0, ui.scroll - page);
      break;
    case "\r":
      submit(s, menu);
      break;
    case "\x7f":
    case "\b":
      input.text = [...input.text].slice(0, -1).join("");
      ui.menuIndex = 0;
      break;
    default:
      if (key.startsWith("\x1b") || key < " ") return;
      input.text += key.replace(/\r\n?/g, "\n"); // pasted text keeps its line breaks
      ui.menuIndex = 0;
      ui.hist = null;
  }
  schedule();
}

// ↑/↓ walk back through what was sent to this session, like shell history.
function recall(s, d) {
  if (!s || (ui.input.text && ui.hist == null)) return;
  const sent = model.blocksFor(s.id).flatMap((b) => (b.type === "turn" && b.prompt ? [b.prompt] : b.type === "steer" ? [b.text] : []));
  if (!sent.length) return;
  const i = Math.max(0, Math.min(sent.length, (ui.hist ?? sent.length) + d));
  ui.hist = i === sent.length ? null : i;
  ui.input.text = sent[i] ?? "";
}

function submit(s, menu) {
  let text = ui.input.text.trim();
  if (menu.length && !COMMANDS.some(([name]) => `/${name}` === text)) text = `/${menu[ui.menuIndex][0]}`;
  if (!text || !s) return;
  ui.input.text = "";
  ui.hist = null;
  ui.scroll = 0;
  if (text.startsWith("/")) return runCommand(s, text);
  // Like typing into controller mid-turn: a running turn is steered, an idle one gets a new turn.
  if (s.status === "running") act("session.steer", { id: s.id, text }, null);
  else act("session.send", { id: s.id, prompt: text }, null);
}

function runCommand(s, line) {
  const [, name = "", rest = ""] = /^\/(\S*)\s*([\s\S]*)$/.exec(line) ?? [];
  const arg = rest.trim();
  switch (name.toLowerCase()) {
    case "model":
      return openPicker(s, 0);
    case "effort": {
      if (!arg) return openPicker(s, 1);
      const efforts = loadModels().find((m) => m.slug === s.model)?.efforts ?? [];
      if (efforts.length && !efforts.includes(arg)) return flash(`${s.model} efforts: ${efforts.join(", ")}`, "bad");
      return act("session.configure", { id: s.id, effort: arg }, `effort ${arg} from the next turn`);
    }
    case "stop":
      if (s.status === "running") return act("session.interrupt", { id: s.id }, null);
      return flash("nothing is running", "bad");
    case "rename":
      if (!arg) return flash("usage: /rename <title>", "bad");
      return act("session.rename", { id: s.id, title: arg }, "renamed");
    case "archive":
      act("session.archive", { id: s.id }, "archived");
      return leaveFocus();
    case "expand":
      ui.expanded = !ui.expanded;
      return;
    case "back":
      return leaveFocus();
    case "exit":
    case "quit":
      return quit();
    default:
      return flash(`unknown command /${name}`, "bad");
  }
}

function onInputKey(key) {
  const input = ui.input;
  if (key === "\x1b" || key === "\x03") ui.input = null;
  else if (key === "\r") {
    const text = input.text.trim();
    ui.input = null;
    if (text) {
      if (input.kind === "steer") act("session.steer", { id: input.id, text }, "steer sent");
      else act("session.send", { id: input.id, prompt: text }, "message sent");
    }
  } else if (key === "\x7f" || key === "\b") input.text = [...input.text].slice(0, -1).join("");
  else if (!key.startsWith("\x1b") && key >= " ") input.text += key;
  schedule();
}

// ---------- mouse (SGR 1006 reports: ESC [ < button ; x ; y M) ----------

function onMouse(button, x, y) {
  const L = ui.layout;
  if (!L || ui.picker) return;
  if (ui.mode === "focus") {
    if (button === 64 || button === 65) ui.scroll = Math.max(0, ui.scroll + (button === 64 ? 3 : -3));
    else if (button === 0 && L.toggleRows.has(y)) {
      ui.expanded = !ui.expanded;
      ui.scroll = 0;
    } else return;
    return schedule();
  }
  const sessions = model.list({ owner: ui.mineOnly ? ui.owner : null });
  const inList = ui.narrow || x <= L.split;
  if (button === 64 || button === 65) {
    // wheel: list moves the selection, detail scrolls the transcript
    const up = button === 64;
    if (inList) {
      ui.selected = Math.max(0, Math.min(sessions.length - 1, ui.selected + (up ? -1 : 1)));
      ui.selectedId = sessions[ui.selected]?.id ?? null;
      ui.scroll = 0;
    } else ui.scroll = Math.max(0, ui.scroll + (up ? 3 : -3));
  } else if (button === 0) {
    if (inList) {
      ui.focus = "list";
      const index = L.listStart + Math.floor((y - 3) / 2);
      if (y >= 3 && index < sessions.length) {
        const same = sessions[index].id === ui.selectedId;
        ui.selected = index;
        ui.selectedId = sessions[index].id;
        ui.scroll = 0;
        if (same) enterFocus(sessions[index]); // click the selected session again to focus it
      }
    } else {
      ui.focus = "detail";
      if (L.toggleRows.has(y)) {
        ui.expanded = !ui.expanded;
        ui.scroll = 0;
      }
    }
  } else return;
  schedule();
}

function onData(chunk) {
  const rest = chunk.replace(/\x1b\[<(\d+);(\d+);(\d+)([Mm])/g, (_, b, x, y, kind) => {
    if (kind === "M") onMouse(Number(b), Number(x), Number(y));
    return "";
  });
  if (rest) onKey(rest);
}

function quit() {
  process.exit(0);
}

// ---------- start ----------

// Autowrap off while running: a line touching the last column can never scroll the screen.
// Mouse: 1000 = clicks + wheel, 1006 = SGR coordinates (any width). Shift+drag still selects text.
out.write("\x1b[?1049h\x1b[?7l\x1b[?1000h\x1b[?1006h\x1b[H\x1b[2J");
process.stdin.setRawMode?.(true);
process.stdin.setEncoding("utf8");
process.stdin.on("data", onData);
out.on("resize", () => {
  frame = [];
  out.write("\x1b[2J");
  schedule();
});
process.on("exit", () => out.write("\x1b[?1006l\x1b[?1000l\x1b[?7h\x1b[?25h\x1b[?1049l"));

setInterval(() => {
  ui.tick++;
  schedule();
}, 120);

if (process.argv.includes("--demo")) {
  const { startDemo } = await import("./demo.mjs");
  model.connected = true;
  startDemo(model, schedule);
} else {
  connect();
}
schedule();
