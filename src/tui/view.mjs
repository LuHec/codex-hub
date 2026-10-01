import path from "node:path";
import { renderMarkdown } from "./md.mjs";
import { BOLD, ITALIC, RESET, bg, fg, truncate, width, wrap } from "./text.mjs";

export const C = {
  text: fg("#D8D4CC"),
  muted: fg("#7C8494"),
  faint: fg("#454C5A"),
  accent: fg("#8FB8DE"),
  run: fg("#E5A84B"),
  ok: fg("#8CC084"),
  bad: fg("#E0715A"),
  steer: fg("#C49BE0"),
  selBg: bg("#232A36")
};
export const SPIN = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
const EFFORT = { low: "lo", medium: "md", high: "hi", xhigh: "xh", max: "max", minimal: "min" };

// Full model id; the effort is abbreviated in the compact list and spelled out elsewhere.
export function modelTag(s, full = false) {
  const effort = s.effort ? (full ? s.effort : EFFORT[s.effort] ?? s.effort) : "";
  return `${s.model ?? "?"}${effort ? (full ? " · " : " ") + effort : ""}`;
}

function ago(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export function clock(ts) {
  return new Date(ts).toTimeString().slice(0, 8);
}

export function ownerTag(owner) {
  return owner ? `${owner.harness}:${owner.id.slice(0, 4)}` : "—";
}

function glyph(s, tick) {
  switch (s.status) {
    case "running":
      return C.run + SPIN[tick % SPIN.length];
    case "failed":
      return C.bad + "✗";
    case "interrupted":
      return C.muted + "◌";
    default:
      return s.turns > 0 ? C.ok + "✓" : C.muted + "○";
  }
}

// Strip the Windows shell wrapper so the command reads like what Codex meant.
export function cleanCommand(cmd) {
  let c = String(cmd ?? "").replace(/^"?[^"]*?(pwsh|powershell|bash|cmd)(\.exe)?"?\s+(-Command|-lc|-c|\/c)\s+/i, "");
  if (/^(["']).*\1$/s.test(c)) c = c.slice(1, -1);
  // Undo JSON-style escaping left in Windows command lines (C:\\Users → C:\Users).
  c = c.replace(/\\\\/g, "\\").replace(/\\"/g, '"');
  return c.replace(/\s+/g, " ").trim();
}

// Markdown → plain terminal text: [label](url) → label, **bold** → bold, `code` → code.
export function plain(text) {
  return String(text ?? "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1");
}

const TOOL_TYPES = new Set(["command", "files", "image", "reasoning"]);

// Absolute column jump. Borders and right-aligned text are placed with this instead of
// space padding, so a glyph the terminal draws wider or narrower than expected (CJK,
// ambiguous-width symbols) can never push the layout out of line.
export const at = (col) => `[${col}G`;

// A bordered pane at column x (1-based), w wide, h tall.
function pane(title, body, x, w, h, focused) {
  const b = focused ? C.accent : C.faint;
  const label = title ? truncate(` ${title} `, w - 4) : "";
  const top =
    `${at(x)}${b}╭─${RESET}${focused ? BOLD + C.text : C.muted}${label}${RESET}${b}` +
    `${"─".repeat(Math.max(0, w - 3 - width(label)))}${at(x + w - 1)}╮${RESET}`;
  const lines = [top];
  for (let i = 0; i < h - 2; i++) {
    lines.push(`${at(x)}${b}│${RESET}${body[i] ?? ""}${RESET}${at(x + w - 1)}${b}│${RESET}`);
  }
  lines.push(`${at(x)}${b}╰${"─".repeat(w - 2)}${at(x + w - 1)}╯${RESET}`);
  return lines;
}

function listBody(ui, sessions, x, w, h, now) {
  const inner = w - 2;
  const left = x + 1;
  if (sessions.length === 0) {
    return ["", `${C.muted}  No sessions yet.`, `${C.muted}  Run codex-hub new to start a session.`];
  }
  const rowsVisible = Math.max(1, Math.floor((h - 2) / 2));
  const start = Math.min(Math.max(0, ui.selected - rowsVisible + 1), Math.max(0, sessions.length - rowsVisible));
  ui.layout.listStart = start; // session index shown on screen rows 3-4, the next on 5-6, …
  const out = [];
  sessions.slice(start, start + rowsVisible).forEach((s, i) => {
    const sel = start + i === ui.selected;
    const lead = sel ? `${C.accent}▌` : " ";
    const since = s.status === "running" && s.turnStartedAt ? now - s.turnStartedAt : now - (s.lastActivityAt ?? now);
    const right1 = `${modelTag(s)} ${ago(since).padStart(3)}`;
    const title = truncate(s.title || s.id, inner - 4 - width(right1) - 1);
    const l1 = `${lead}${glyph(s, ui.tick)} ${sel ? BOLD : ""}${C.text}${title}${RESET}${sel ? C.selBg : ""}`;
    const right2 = ownerTag(s.owner);
    const sub = truncate(plain(s.lastLine) || (s.status === "running" ? "working…" : ""), inner - 4 - width(right2) - 1);
    const l2 = `${lead} ${C.muted}  ${sub}`;
    const fill = sel ? `${at(left)}${C.selBg}${" ".repeat(inner)}${at(left)}` : "";
    const keep = sel ? C.selBg : "";
    out.push(`${fill}${l1}${keep}${at(left + inner - width(right1))}${C.muted}${right1}${RESET}`);
    out.push(`${fill}${l2}${keep}${at(left + inner - width(right2))}${C.faint}${right2}${RESET}`);
  });
  return out;
}

// One collapsed line for a run of tool activity, like controller's folded tool calls.
function toolSummary(group, w, tick) {
  const commands = group.filter((b) => b.type === "command");
  const running = commands.find((b) => b.exitCode === undefined);
  const failed = commands.filter((b) => b.exitCode !== undefined && b.exitCode !== 0).length;
  const files = [...new Set(group.filter((b) => b.type === "files").flatMap((b) => [...b.paths].map((p) => path.basename(p))))];
  const images = group.filter((b) => b.type === "image").length;
  if (running) {
    const more = commands.length - 1;
    return `  ${C.run}${SPIN[tick % SPIN.length]} ${C.muted}${truncate(cleanCommand(running.command), w - 12)}${C.faint}${more ? `  +${more}` : ""}${RESET}`;
  }
  const parts = [];
  if (commands.length) parts.push(`${C.muted}${commands.length} command${commands.length > 1 ? "s" : ""}${failed ? `${C.faint}, ${C.bad}${failed} failed` : ""}`);
  if (files.length) parts.push(`${C.muted}edited ${truncate(files.join(", "), Math.max(10, w - 40))}`);
  if (images) parts.push(`${C.steer}${images} image${images > 1 ? "s" : ""}`);
  if (!parts.length) return null; // reasoning only: hidden while collapsed
  return `  ${C.faint}⋯ ${parts.join(`${C.faint} · `)}${RESET}`;
}

const PROMPT_PREVIEW = 6;

function streamLines(blocks, w, tick, expanded) {
  const out = [];
  out.toggles = new Set(); // line indexes that expand/collapse on click
  const md = (text, prefix, base) => out.push(...renderMarkdown(text, w, { prefix, base }));
  const hang = (prefix, color, text, cap = Infinity) => {
    const lines = wrap(text, Math.max(8, w - width(prefix)));
    const shown = lines.length > cap ? ["…", ...lines.slice(-cap)] : lines;
    shown.forEach((ln, i) => out.push(`${i === 0 ? prefix : " ".repeat(width(prefix))}${color}${ln}${RESET}`));
  };
  const rows = [];
  for (const b of blocks) {
    if (!expanded && TOOL_TYPES.has(b.type)) {
      const last = rows[rows.length - 1];
      if (last?.type === "group") last.items.push(b);
      else rows.push({ type: "group", items: [b] });
    } else rows.push(b);
  }
  for (const b of rows) {
    switch (b.type) {
      case "group": {
        const line = toolSummary(b.items, w, tick);
        if (line) {
          out.toggles.add(out.length);
          out.push(line);
        }
        break;
      }
      case "turn": {
        out.push("");
        const label = ` turn · ${clock(b.ts)}${b.by ? " · " + ownerTag(b.by) : ""} `;
        out.push(`${C.faint}──${C.muted}${label}${C.faint}${"─".repeat(Math.max(0, w - 2 - width(label)))}${RESET}`);
        if (b.prompt) {
          // What the controller (a harness or the user) asked Codex to do.
          const lines = renderMarkdown(b.prompt, w, { prefix: `${C.accent}› ${RESET}`, base: C.accent });
          if (expanded || lines.length <= PROMPT_PREVIEW + 1) out.push(...lines);
          else {
            out.push(...lines.slice(0, PROMPT_PREVIEW));
            out.toggles.add(out.length);
            out.push(`  ${C.faint}⋯ ${lines.length - PROMPT_PREVIEW} more lines${RESET}`);
          }
        }
        break;
      }
      case "message":
        out.push("");
        md(b.text, `${C.text}◆ ${RESET}`, C.text);
        break;
      case "reasoning":
        if (b.text.trim()) hang(`  ${C.muted}∴ ${RESET}`, C.muted + ITALIC, b.text.trim(), 3);
        break;
      case "command": {
        const status =
          b.exitCode === undefined
            ? `${C.run}${SPIN[tick % SPIN.length]}`
            : b.exitCode === 0
              ? `${C.ok}✓`
              : `${C.bad}✗ ${b.exitCode ?? "?"}`;
        out.push(`  ${C.faint}$ ${C.muted}${truncate(cleanCommand(b.command), w - 8)} ${status}${RESET}`);
        break;
      }
      case "files":
        out.push(`  ${C.faint}✎ ${C.muted}${truncate([...b.paths].map((p) => path.basename(p)).join("  "), w - 4)}${RESET}`);
        break;
      case "image":
        out.push(`  ${C.steer}▣ ${C.muted}${b.path ? truncate(path.basename(b.path), w - 4) : "image generated"}${RESET}`);
        break;
      case "steer":
        hang(`  ${C.steer}↳ ${RESET}`, C.steer, `${b.text}${b.by ? `  (${ownerTag(b.by)})` : ""}`);
        break;
      case "end": {
        const [color, mark] =
          b.status === "completed" ? [C.ok, "✓ done"] : b.status === "interrupted" ? [C.muted, "◌ interrupted"] : [C.bad, "✗ failed"];
        const label = ` ${mark} · ${clock(b.ts)} `;
        out.push(`${C.faint}──${color}${label}${C.faint}${"─".repeat(Math.max(0, w - 2 - width(label)))}${RESET}`);
        if (b.error) hang(`  ${C.bad}! ${RESET}`, C.bad, b.error, 3);
        break;
      }
      case "error":
        hang(`  ${C.bad}! ${RESET}`, C.bad, b.text, 4);
        break;
      default:
        break;
    }
  }
  return out;
}

function detailBody(ui, s, blocks, w, h) {
  if (!s) return ["", `${C.muted}  Select a session.`];
  const inner = w - 2;
  const head = [];
  head.push(` ${BOLD}${C.text}${truncate(s.title || s.id, inner - 2)}${RESET}`);
  const meta = [modelTag(s, true), `owner ${ownerTag(s.owner)}`, `${s.turns ?? 0} turns`, s.cwd ? truncate(s.cwd, 40) : ""].filter(Boolean);
  head.push(` ${C.muted}${truncate(meta.join("   "), inner - 2)}${RESET}`);
  if (s.plan?.length) {
    head.push("");
    for (const step of s.plan.slice(0, 6)) {
      const [mark, color] =
        step.status === "completed" ? ["✓", C.ok] : step.status === "inProgress" ? ["▸", C.run] : ["○", C.faint];
      const text = step.status === "completed" ? C.muted : step.status === "inProgress" ? BOLD + C.text : C.muted;
      head.push(` ${color}${mark} ${RESET}${text}${truncate(step.step, inner - 5)}${RESET}`);
    }
    if (s.plan.length > 6) head.push(` ${C.faint}  +${s.plan.length - 6} more${RESET}`);
  }
  head.push(`${C.faint}${"─".repeat(inner)}${RESET}`);

  const raw = streamLines(blocks, inner - 2, ui.tick, ui.expanded);
  const stream = raw.map((l) => ` ${l}`);
  const room = Math.max(1, h - 2 - head.length);
  const maxScroll = Math.max(0, stream.length - room);
  ui.scroll = Math.min(ui.scroll, maxScroll);
  const end = stream.length - ui.scroll;
  const start = Math.max(0, end - room);
  const visible = stream.slice(start, end);
  // Screen rows (pane body starts on row 3) whose click toggles expand/collapse.
  ui.layout.toggleRows = new Set([...raw.toggles].filter((k) => k >= start && k < end).map((k) => 3 + head.length + k - start));
  if (ui.scroll > 0 && visible.length) visible[visible.length - 1] = ` ${C.accent}↓ ${ui.scroll} more lines${RESET}`;
  return [...head, ...visible];
}

function header(model, ui, sessions, cols, now) {
  const running = sessions.filter((s) => s.status === "running").length;
  const failed = sessions.filter((s) => s.status === "failed").length;
  const idle = sessions.length - running - failed;
  const left =
    ` ${C.accent}${BOLD}◆ codex-hub${RESET}   ` +
    (model.connected
      ? `${running ? C.run + SPIN[ui.tick % SPIN.length] : C.faint + "·"} ${running} running${RESET}  ${C.ok}✓${C.muted} ${idle} idle${RESET}` +
        (failed ? `  ${C.bad}✗ ${failed} failed${RESET}` : "")
      : `${C.bad}○ hub offline${C.muted} — retrying${RESET}`);
  const right = `${C.muted}${ui.mineOnly ? "mine" : "all"} · ${clock(now)} ${RESET}`;
  return `${left}${at(cols - width(right) + 1)}${right}`;
}

function footer(ui, cols) {
  if (ui.input) {
    const label = ` ${ui.input.kind === "steer" ? "steer" : "send"} ▸ `;
    const hint = "  enter ok · esc cancel";
    // Show the tail of long input so the caret stays visible.
    const room = Math.max(10, cols - width(label) - width(hint) - 2);
    let text = ui.input.text;
    while (width(text) > room) text = [...text].slice(1).join("");
    // The real terminal cursor goes here, so an IME draws its composition at the input.
    ui.cursor = { row: ui.layout.rows, col: width(label) + width(text) + 1 };
    return `${C.steer}${label}${RESET}${C.text}${text}${RESET}${at(ui.cursor.col + 1)}${C.faint}${hint}${RESET}`;
  }
  if (ui.flash) return ` ${ui.flash.color === "bad" ? C.bad : C.ok}${truncate(ui.flash.text, cols - 2)}${RESET}`;
  if (ui.hint) return ` ${C.muted}${truncate(ui.hint, cols - 2)}${RESET}`;
  const keys = [
    ["↑↓", "select"],
    ["enter", "focus"],
    ["ctrl+o", ui.expanded ? "collapse" : "expand"],
    ["s", "steer"],
    ["m", "message"],
    ["p", "model"],
    ["esc", "stop"],
    ["pgup/dn", "scroll"],
    ["f", ui.mineOnly ? "all" : "mine"],
    ["ctrl+c", "quit"]
  ];
  const sep = ui.narrow ? "  " : `  ${C.faint}·${RESET}  `;
  let line;
  do {
    line = " " + keys.map(([k, v]) => `${C.accent}${k}${RESET} ${C.muted}${v}${RESET}`).join(sep);
  } while (width(line) > cols - 1 && keys.pop());
  return line;
}

export function render(model, ui, cols, rows) {
  const now = Date.now();
  const sessions = model.list({ owner: ui.mineOnly ? ui.owner : null });
  const idx = sessions.findIndex((s) => s.id === ui.selectedId);
  ui.selected = idx >= 0 ? idx : Math.min(ui.selected, Math.max(0, sessions.length - 1));
  ui.selectedId = sessions[ui.selected]?.id ?? null;
  const current = sessions[ui.selected];
  const bodyH = rows - 2;
  ui.narrow = cols < 96;
  ui.layout = { listStart: 0, toggleRows: new Set(), split: null, rows, cols, count: sessions.length };
  ui.cursor = null; // set by footer() while typing

  let body;
  if (ui.narrow) {
    const w = cols;
    body = pane(`Sessions ${sessions.length}`, listBody(ui, sessions, 1, w, bodyH, now), 1, w, bodyH, true);
  } else {
    const lw = Math.max(34, Math.min(52, Math.floor(cols * 0.36)));
    const rw = cols - lw;
    ui.layout.split = lw; // columns 1..lw are the session list
    const left = pane(`Sessions ${sessions.length}`, listBody(ui, sessions, 1, lw, bodyH, now), 1, lw, bodyH, ui.focus === "list");
    const right = pane(
      current ? "Live" : "",
      detailBody(ui, current, current ? model.blocksFor(current.id) : [], rw, bodyH),
      lw + 1,
      rw,
      bodyH,
      ui.focus === "detail"
    );
    body = left.map((l, i) => l + right[i]);
  }
  const frame = [header(model, ui, sessions, cols, now), ...body, footer(ui, cols)];
  if (ui.picker) drawPicker(frame, ui, current, cols, rows);
  return frame;
}

// Centered model / effort picker drawn over the frame (later writes on a row win).
export function drawPicker(frame, ui, session, cols, rows) {
  const p = ui.picker;
  const models = p.models;
  const efforts = models[p.mi].efforts;
  const hint = "←→ column · ↑↓ choose · enter apply · esc";
  const lw = Math.max(14, ...models.map((m) => width(m.slug))) + 5;
  const rw = Math.max(9, ...efforts.map((e) => width(e))) + 5;
  const w = Math.min(cols - 2, Math.max(lw + rw + 3, width(hint) + 4));
  const listH = Math.max(models.length, efforts.length);
  const h = listH + 5;
  const x = Math.max(1, Math.floor((cols - w) / 2) + 1);
  const y = Math.max(2, Math.floor((rows - h) / 2));
  const b = C.accent;
  const row = (i, s) => {
    if (frame[y - 1 + i] !== undefined) frame[y - 1 + i] += s;
  };
  // ▌ = cursor in the focused column, › = choice in the other column, • = the session's current value.
  const cell = (label, active, focused, current, cw) => {
    const mark = current ? `${C.ok}• ` : "  ";
    const text = truncate(label, cw - 4);
    if (active && focused) return `${C.selBg}${C.accent}▌${mark}${BOLD}${C.text}${text}${" ".repeat(Math.max(0, cw - 3 - width(text)))}${RESET}`;
    if (active) return `${C.accent}›${mark}${C.text}${text}${RESET}`;
    return ` ${mark}${C.muted}${text}${RESET}`;
  };
  const title = truncate(` Model · ${session?.title ?? ""} `, w - 4);
  row(0, `${at(x)}${b}╭─${BOLD}${C.text}${title}${RESET}${b}${"─".repeat(Math.max(0, w - 3 - width(title)))}╮${RESET}`);
  row(1, `${at(x)}${b}│${at(x + 1)}${" ".repeat(w - 2)}${at(x + 2)}${C.faint}model${at(x + lw + 2)}effort${RESET}${at(x + w - 1)}${b}│${RESET}`);
  for (let i = 0; i < listH; i++) {
    const m = models[i];
    const e = efforts[i];
    const left = m ? cell(m.slug, i === p.mi, p.col === 0, m.slug === session?.model, lw) : "";
    const right = e ? cell(e, i === p.ei, p.col === 1, e === session?.effort && models[p.mi].slug === session?.model, rw) : "";
    row(2 + i, `${at(x)}${b}│${at(x + 1)}${" ".repeat(w - 2)}${at(x + 1)}${left}${at(x + lw + 1)}${C.faint}│${RESET}${at(x + lw + 2)}${right}${at(x + w - 1)}${b}│${RESET}`);
  }
  row(2 + listH, `${at(x)}${b}│${at(x + 1)}${" ".repeat(w - 2)}${RESET}${at(x + w - 1)}${b}│${RESET}`);
  row(3 + listH, `${at(x)}${b}│${at(x + 1)}${" ".repeat(w - 2)}${at(x + 2)}${C.faint}${truncate(hint, w - 4)}${RESET}${at(x + w - 1)}${b}│${RESET}`);
  row(4 + listH, `${at(x)}${b}╰${"─".repeat(w - 2)}╯${RESET}`);
}
