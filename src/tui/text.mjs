// Terminal text helpers: display width (CJK/emoji aware), truncation, wrapping, color.

function isWide(cp) {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  );
}

function charWidth(ch) {
  const cp = ch.codePointAt(0);
  if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if (cp >= 0x300 && cp <= 0x36f) return 0; // combining marks
  if (cp === 0x200d || (cp >= 0xfe00 && cp <= 0xfe0f)) return 0; // ZWJ, variation selectors
  return isWide(cp) ? 2 : 1;
}

const NO_LINE_START = "，。、；：！？）」』》〉”’…";

const ANSI = /\x1b\[[0-9;]*m/g;

export function width(s) {
  let w = 0;
  for (const ch of s.replace(ANSI, "")) w += charWidth(ch);
  return w;
}

// Truncate plain text to a display width, adding an ellipsis when cut.
export function truncate(s, max) {
  if (max <= 0) return "";
  if (width(s) <= max) return s;
  let out = "";
  let w = 0;
  for (const ch of s) {
    const cw = charWidth(ch);
    if (w + cw > max - 1) break;
    out += ch;
    w += cw;
  }
  return out + "…";
}

export function padEnd(s, len) {
  const w = width(s);
  return w >= len ? s : s + " ".repeat(len - w);
}

// Word-aware wrap of plain text into lines no wider than max (CJK breaks anywhere).
export function wrap(text, max) {
  const lines = [];
  for (const raw of String(text).replace(/\t/g, "  ").split("\n")) {
    let line = "";
    let w = 0;
    const tokens = raw.match(/[\x00-\x7f]+?(?=\s|$)|\s+|[\s\S]/gu) ?? [""];
    for (const tok of tokens) {
      const tw = width(tok);
      if (w + tw <= max) {
        line += tok;
        w += tw;
        continue;
      }
      if (tw > max) {
        for (const ch of tok) {
          const cw = charWidth(ch);
          if (w + cw > max) {
            lines.push(line);
            line = "";
            w = 0;
          }
          line += ch;
          w += cw;
        }
        continue;
      }
      // Keep closing CJK punctuation off the start of a line: pull the previous char down with it.
      let carry = "";
      if (NO_LINE_START.includes(tok) && [...line].length > 1) {
        carry = [...line].slice(-1).join("");
        line = [...line].slice(0, -1).join("");
      }
      lines.push(line.trimEnd());
      line = carry + (/^\s+$/.test(tok) ? "" : tok);
      w = width(line);
    }
    lines.push(line.trimEnd());
  }
  return lines;
}

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)).join(";");
export const fg = (h) => `\x1b[38;2;${hex(h)}m`;
export const bg = (h) => `\x1b[48;2;${hex(h)}m`;
export const RESET = "\x1b[0m";
export const BOLD = "\x1b[1m";
export const ITALIC = "\x1b[3m";
