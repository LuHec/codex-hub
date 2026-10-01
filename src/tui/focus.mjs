// Focus mode: one session, full screen, laid out like the controller terminal.
// The transcript flows top-down with the input right under it; once it fills the
// screen the input pins to the bottom and older lines scroll off the top.
import path from "node:path";
import { renderMarkdown } from "./md.mjs";
import { BOLD, ITALIC, RESET, bg, fg, truncate, width, wrap } from "./text.mjs";
import { C, SPIN, at, cleanCommand, clock, drawPicker, ownerTag } from "./view.mjs";

const USER_BG = bg("#2A303B");
const CHIP = bg("#8FB8DE") + fg("#141820");
const STAR = "·✢✳✶✻✽✻✶✳✢";
const PROMPT_PREVIEW = 8;

export const COMMANDS = [
  ["model", "switch model and effort"],
  ["effort", "set effort: /effort high"],
  ["stop", "interrupt the running turn"],
  ["rename", "rename: /rename <title>"],
  ["archive", "hide this session and go back"],
  ["expand", "show or fold tool calls (ctrl+o)"],
  ["back", "back to the session list (← ←)"],
  ["exit", "quit codex-hub"]
];

// Commands matching what is typed after "/", while the name is still being typed.
export function commandMatches(text) {
  const m = /^\/(\S*)$/.exec(text);
  return m ? COMMANDS.filter(([name]) => name.startsWith(m[1].toLowerCase())) : [];
}

function duration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

function logo(s, w) {
  const meta = [s.model, s.effort, s.owner ? `owner ${ownerTag(s.owner)}` : ""].filter(Boolean).join(" · ");
  return [
    "",
    ` ${C.accent}▄▄▄▄▄▄▄▄${RESET}   ${BOLD}${C.text}Codex${RESET} ${C.muted}${truncate(s.title || s.id, w - 20)}${RESET}`,
    ` ${CHIP}${BOLD}  ›_    ${RESET}   ${C.muted}${truncate(meta, w - 13)}${RESET}`,
    ` ${C.accent}▀▀▀▀▀▀▀▀${RESET}   ${C.muted}${truncate(s.cwd ?? "", w - 13)}${RESET}`,
    "",
    ` ${C.faint}You're talking to Codex directly · ← ← back to sessions · / for commands${RESET}`
  ];
}

// "● Title(args)" with the result hanging under it on "⎿" lines.
function tool(out, dot, name, args, w) {
  out.push("");
  out.push(`${dot}● ${RESET}${BOLD}${C.text}${name}${RESET}${args ? `${C.muted}(${truncate(args, w - width(name) - 4)})${RESET}` : ""}`);
}

function transcript(blocks, w, tick, expanded) {
  const out = [];
  out.toggles = new Set();
  const result = (color, text, cap = Infinity) => {
    const lines = wrap(text, Math.max(8, w - 5));
    const shown = lines.length > cap ? [...lines.slice(0, cap), `… +${lines.length - cap} lines`] : lines;
    shown.forEach((ln, i) => out.push(`${C.faint}${i === 0 ? "  ⎿  " : "     "}${color}${ln}${RESET}`));
  };
  const user = (mark, color, text, tag) => {
    out.push("");
    const lines = wrap(text, Math.max(8, w - 3));
    const cut = !expanded && lines.length > PROMPT_PREVIEW + 1;
    (cut ? lines.slice(0, PROMPT_PREVIEW) : lines).forEach((ln, i) => {
      const lead = i === 0 ? `${color}${mark} ` : "  ";
      const right = i === 0 && tag ? `${at(w - width(tag) + 1)}${C.faint}${tag}` : "";
      out.push(`${USER_BG}${" ".repeat(w)}${at(2)}${lead}${C.text}${ln}${right}${RESET}`);
    });
    if (cut) {
      out.toggles.add(out.length);
      out.push(`${USER_BG}${" ".repeat(w)}${at(2)}  ${C.faint}… +${lines.length - PROMPT_PREVIEW} lines (ctrl+o to expand)${RESET}`);
    }
  };

  // Collapsed, each run of tool activity folds into one line.
  const rows = [];
  for (const b of blocks) {
    const foldable = !expanded && ["command", "files", "image", "reasoning"].includes(b.type);
    const last = rows[rows.length - 1];
    if (foldable && last?.type === "group") last.items.push(b);
    else rows.push(foldable ? { type: "group", items: [b] } : b);
  }

  let turnStart = null;
  for (const b of rows) {
    switch (b.type) {
      case "turn":
        turnStart = b.ts;
        if (b.prompt) user(">", C.accent, b.prompt, b.by ? `from ${ownerTag(b.by)}` : "");
        break;
      case "steer":
        user("↳", C.steer, b.text, `steer${b.by ? ` · ${ownerTag(b.by)}` : ""}`);
        break;
      case "message":
        out.push("");
        out.push(...renderMarkdown(b.text, w, { prefix: `${C.text}● ${RESET}`, base: C.text }));
        break;
      case "group": {
        const commands = b.items.filter((x) => x.type === "command");
        const running = commands.find((x) => x.exitCode === undefined);
        if (running) {
          tool(out, C.run, "Bash", cleanCommand(running.command), w);
          result(C.muted, `Running…${commands.length > 1 ? `  (+${commands.length - 1} earlier)` : ""}`);
          break;
        }
        const failed = commands.filter((x) => x.exitCode !== 0).length;
        const files = new Set(b.items.filter((x) => x.type === "files").flatMap((x) => [...x.paths]));
        const images = b.items.filter((x) => x.type === "image").length;
        const parts = [];
        if (commands.length) parts.push(`ran ${commands.length} command${commands.length > 1 ? "s" : ""}`);
        if (files.size) parts.push(`edited ${files.size} file${files.size > 1 ? "s" : ""}`);
        if (images) parts.push(`generated ${images} image${images > 1 ? "s" : ""}`);
        if (!parts.length) break; // reasoning only
        const text = parts.join(", ");
        out.push("");
        out.toggles.add(out.length);
        out.push(
          `${failed ? C.bad : C.ok}● ${RESET}${C.text}${text[0].toUpperCase()}${text.slice(1)}${RESET}` +
            `${failed ? ` ${C.bad}(${failed} failed)` : ""} ${C.faint}(ctrl+o to expand)${RESET}`
        );
        break;
      }
      case "command": {
        const dot = b.exitCode === undefined ? C.run : b.exitCode === 0 ? C.ok : C.bad;
        tool(out, dot, "Bash", cleanCommand(b.command), w);
        if (b.exitCode === undefined) result(C.muted, "Running…");
        else if (b.exitCode !== 0) result(C.bad, `Exit code ${b.exitCode ?? "?"}`);
        break;
      }
      case "files":
        tool(out, C.ok, "Update", [...b.paths].map((p) => path.basename(p)).join(", "), w);
        break;
      case "image":
        tool(out, C.steer, "Image", b.path ? path.basename(b.path) : "", w);
        if (b.path) result(C.muted, b.path);
        break;
      case "reasoning":
        if (b.text.trim()) {
          out.push("");
          wrap(b.text.trim(), w - 2).forEach((ln, i) => out.push(`${C.muted}${i === 0 ? "∴ " : "  "}${ITALIC}${ln}${RESET}`));
        }
        break;
      case "end":
        if (b.status === "interrupted") result(C.bad, "Interrupted");
        else if (b.status === "failed") result(C.bad, `Failed${b.error ? `: ${b.error}` : ""}`, 4);
        else if (turnStart) {
          out.push("");
          out.push(`${C.faint}✻ Worked for ${duration(b.ts - turnStart)} · ${clock(b.ts)}${RESET}`);
        }
        turnStart = null;
        break;
      case "error":
        result(C.bad, b.text, 4);
        break;
      default:
        break;
    }
  }
  return out;
}

export function renderFocus(model, ui, cols, rows) {
  const s = model.sessions.get(ui.selectedId);
  ui.cursor = null;
  ui.layout = { toggleRows: new Set(), rows, cols };
  if (!s) return [];
  const now = Date.now();
  const w = cols - 2; // one column of margin on each side
  const running = s.status === "running";

  // ---- bottom: spinner + plan, input box, status or command menu ----
  const bottom = [];
  if (running) {
    const star = STAR[Math.floor(ui.tick / 2) % STAR.length];
    const took = s.turnStartedAt ? duration(now - s.turnStartedAt) : "";
    bottom.push("");
    bottom.push(` ${C.run}${star} Working…${RESET} ${C.muted}(${took}${took ? " · " : ""}esc to interrupt)${RESET}`);
    const plan = s.plan ?? [];
    plan.slice(0, 5).forEach((step, i) => {
      const [mark, color] = step.status === "completed" ? ["✓", C.muted] : step.status === "inProgress" ? ["▸", C.run] : ["○", C.muted];
      bottom.push(` ${C.faint}${i === 0 ? "  ⎿  " : "     "}${color}${mark} ${truncate(step.step, w - 8)}${RESET}`);
    });
    if (plan.length > 5) bottom.push(` ${C.faint}     … +${plan.length - 5} more${RESET}`);
  }
  bottom.push("");
  bottom.push(`${C.faint}${"─".repeat(cols)}${RESET}`);
  const text = ui.input?.text ?? "";
  const inputLines = text ? wrap(text, cols - 4).slice(-6) : [""];
  const inputRow = bottom.length; // index of the first input line within bottom
  inputLines.forEach((ln, i) => {
    const lead = i === 0 ? `${running ? C.steer : C.text}> ${RESET}` : "  ";
    const hint = !text ? `${C.faint}${running ? "Steer the running turn…" : "Message Codex…"}` : "";
    bottom.push(`${lead}${C.text}${ln}${hint}${RESET}`);
  });
  bottom.push(`${C.faint}${"─".repeat(cols)}${RESET}`);

  const menu = commandMatches(text);
  if (menu.length) {
    ui.menuIndex = Math.min(ui.menuIndex ?? 0, menu.length - 1);
    const nameW = Math.max(...COMMANDS.map(([n]) => n.length)) + 4;
    menu.forEach(([name, desc], i) => {
      const on = i === ui.menuIndex;
      bottom.push(`  ${on ? C.accent + BOLD : C.muted}/${name}${RESET}${at(3 + nameW)}${on ? C.text : C.faint}${desc}${RESET}`);
    });
  } else {
    const [color, left] = ui.flash
      ? [ui.flash.color === "bad" ? C.bad : C.ok, ui.flash.text]
      : ui.hint
        ? [C.muted, ui.hint]
        : [C.faint, `← ← sessions · ctrl+o ${ui.expanded ? "fold" : "expand"} · ${running ? "esc interrupt" : "/ commands"}`];
    const right = `${C.muted}${s.model ?? "?"} ${C.faint}·${RESET} ${C.accent}●${RESET} ${C.muted}${s.effort ?? "default"} ${C.faint}· /model ${RESET}`;
    bottom.push(`  ${color}${truncate(left, cols - width(right) - 4)}${RESET}${at(cols - width(right) + 1)}${right}`);
  }

  // ---- transcript fills whatever is above ----
  const raw = transcript(model.blocksFor(s.id), w, ui.tick, ui.expanded);
  const lines = [...logo(s, w), ...raw];
  const offset = lines.length - raw.length;
  const room = Math.max(1, rows - bottom.length);
  const maxScroll = Math.max(0, lines.length - room);
  ui.scroll = Math.min(ui.scroll, maxScroll);
  const end = lines.length - ui.scroll;
  const start = Math.max(0, end - room);
  const visible = lines.slice(start, end).map((l) => ` ${l}`);
  if (ui.scroll > 0) visible[visible.length - 1] = ` ${C.accent}↓ ${ui.scroll} more lines (pgdn)${RESET}`;
  for (const k of raw.toggles) {
    const row = k + offset - start;
    if (row >= 0 && row < visible.length) ui.layout.toggleRows.add(row + 1);
  }

  const frame = [...visible, ...bottom];
  const last = inputLines[inputLines.length - 1];
  ui.cursor = { row: visible.length + inputRow + inputLines.length, col: 3 + width(last) };
  while (frame.length < rows) frame.push("");
  if (ui.picker) {
    ui.cursor = null;
    drawPicker(frame, ui, s, cols, rows);
  }
  return frame.slice(0, rows);
}
