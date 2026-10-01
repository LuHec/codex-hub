// Small Markdown → styled terminal lines renderer (headings, lists, quotes, fenced code,
// **bold**, *italic*, `code`, [links](url)). Wraps styled text to a display width.
import { BOLD, ITALIC, RESET, fg, width } from "./text.mjs";

const CODE = fg("#D7B98E");
const LINK = fg("#8FB8DE");
const RULE = fg("#454C5A");
const MUTED = fg("#7C8494");
const UNDERLINE = "\x1b[4m";
const WIDE = "\\u1100-\\u115f\\u2e80-\\u303e\\u3041-\\u33ff\\u3400-\\u4dbf\\u4e00-\\u9fff\\uac00-\\ud7a3\\uf900-\\ufaff\\uff00-\\uff60";
const NO_LINE_START = "，。、；：！？）」』》〉”’…";
const WORD = new RegExp(`[^\\s${WIDE}]+|\\s+|[${WIDE}]`, "gu");

// Inline markup → runs of { text, style }.
function inline(text, base) {
  const runs = [];
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\[[^\]]+\]\([^)]*\))|((?<![\w*])\*[^*\s][^*]*\*(?![\w*]))/g;
  let at = 0;
  for (const m of text.matchAll(re)) {
    if (m.index > at) runs.push({ text: text.slice(at, m.index), style: base });
    const t = m[0];
    if (m[1]) runs.push({ text: t.slice(1, -1), style: CODE });
    else if (m[2]) runs.push({ text: t.slice(2, -2), style: base + BOLD });
    else if (m[3]) runs.push({ text: t.slice(1, t.indexOf("](")), style: LINK + UNDERLINE });
    else runs.push({ text: t.slice(1, -1), style: base + ITALIC });
    at = m.index + t.length;
  }
  if (at < text.length) runs.push({ text: text.slice(at), style: base });
  return runs;
}

// Wrap runs to `max` display columns; returns styled strings (no prefix).
function wrapRuns(runs, max) {
  const lines = [];
  let line = "";
  let w = 0;
  let lastPiece = null; // last whole token appended to `line`
  const flush = () => {
    lines.push(line);
    line = "";
    w = 0;
    lastPiece = null;
  };
  for (const run of runs) {
    // Words stay whole (including ’ é …); wide CJK characters are breakable one by one.
    const tokens = run.text.match(WORD) ?? [];
    for (const tok of tokens) {
      if (/^\s+$/.test(tok)) {
        if (w > 0 && w < max) {
          line += " ";
          w += 1;
          lastPiece = null;
        }
        continue;
      }
      const tw = width(tok);
      if (w + tw > max && w > 0) {
        // Keep closing CJK punctuation off the start of a line: carry the previous char down.
        const carry = NO_LINE_START.includes(tok) && lastPiece && w - lastPiece.w > 0 ? lastPiece : null;
        if (carry) line = line.slice(0, line.length - carry.s.length);
        flush();
        if (carry) {
          line = carry.s;
          w = carry.w;
        }
      }
      if (tw > max) {
        // Hard-break an overlong token (paths, URLs).
        let rest = [...tok];
        while (rest.length) {
          let piece = "";
          let pw = 0;
          while (rest.length && pw + width(rest[0]) <= max - w) {
            pw += width(rest[0]);
            piece += rest.shift();
          }
          if (!piece) {
            flush();
            continue;
          }
          line += run.style + piece + RESET;
          w += pw;
          lastPiece = null;
          if (rest.length) flush();
        }
        continue;
      }
      lastPiece = { s: run.style + tok + RESET, w: tw };
      line += lastPiece.s;
      w += tw;
    }
  }
  if (line || lines.length === 0) lines.push(line);
  return lines.map((l) => l.replace(/ +$/, ""));
}

// Render markdown into lines no wider than `w`, each starting with `prefix` (first line)
// or an equal-width indent (continuations).
export function renderMarkdown(text, w, { prefix = "", indent = null, base = "" } = {}) {
  const pad = indent ?? " ".repeat(width(prefix));
  const out = [];
  const push = (lead, cont, runs) => {
    const avail = Math.max(8, w - width(pad) - width(lead));
    wrapRuns(runs, avail).forEach((ln, i) => out.push((i === 0 ? lead : cont) + ln));
  };
  let inCode = false;
  for (const raw of String(text ?? "").replace(/\r/g, "").replace(/\t/g, "  ").split("\n")) {
    if (/^\s*```/.test(raw)) {
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      push(`${RULE}│ ${RESET}`, `${RULE}│ ${RESET}`, [{ text: raw, style: CODE }]);
      continue;
    }
    const line = raw.trimEnd();
    let m;
    if (!line.trim()) out.push("");
    else if ((m = line.match(/^(#{1,6})\s+(.*)$/))) push("", "", inline(m[2], base + BOLD + LINK));
    else if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) out.push(RULE + "─".repeat(Math.max(3, Math.min(40, w - width(pad)))) + RESET);
    else if ((m = line.match(/^(\s*)[-*+]\s+(.*)$/))) {
      const lead = " ".repeat(Math.min(m[1].length, 6)) + `${MUTED}•${RESET} `;
      push(lead, " ".repeat(width(lead)), inline(m[2], base));
    } else if ((m = line.match(/^(\s*)(\d+[.)])\s+(.*)$/))) {
      const lead = " ".repeat(Math.min(m[1].length, 6)) + `${MUTED}${m[2]}${RESET} `;
      push(lead, " ".repeat(width(lead)), inline(m[3], base));
    } else if ((m = line.match(/^>\s?(.*)$/))) push(`${RULE}▎ ${RESET}`, `${RULE}▎ ${RESET}`, inline(m[1], MUTED + ITALIC));
    else push("", "", inline(line.trim(), base));
  }
  while (out.length && out[out.length - 1] === "") out.pop();
  while (out.length && out[0] === "") out.shift();
  return out.map((l, i) => (i === 0 ? prefix : pad) + l);
}
