import type { Flags } from "./types";

export const HOME = "/home/danylo";
export const PROJECT = `${HOME}/project`;

const HASH_CHARS = "bcdfghjklmnpqrstvwxz2456789";
export const rand = (n: number) =>
  Array.from({ length: n }, () => HASH_CHARS[Math.floor(Math.random() * HASH_CHARS.length)]).join("");
export const hexId = (n = 12) => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join("");

export const age = (from: number) => {
  const s = Math.max(1, Math.floor((Date.now() - from) / 1000));
  if (s < 120) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 10) return `${m}m${s % 60}s`;
  if (m < 60 * 3) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h` : `${Math.floor(h / 24)}d`;
};

/** Pads columns like kubectl/docker tables. */
export const table = (rows: string[][]) => {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => (r[i] ?? "").length)));
  return rows.map((r) => r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i] + 3))).join("")).join("\n");
};

/** Splits on whitespace, honoring single/double quotes. */
export const tokenize = (line: string) => {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) {
    // keep --flag="quoted value" together
    const tok = m[1] ?? m[2] ?? m[3];
    const prev = out[out.length - 1];
    if ((m[1] !== undefined || m[2] !== undefined) && prev?.endsWith("=") && line[m.index - 1] !== " ") out[out.length - 1] = prev + tok;
    else out.push(tok);
  }
  return out;
};

/** Splits a line on a top-level separator (outside quotes). */
export const splitTop = (line: string, sep: string) => {
  const parts: string[] = [];
  let quote: string | null = null;
  let cur = "";
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) quote = null;
      cur += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      cur += c;
    } else if (line.startsWith(sep, i) && !(sep === "|" && (line[i + 1] === "|" || line[i - 1] === "|"))) {
      parts.push(cur);
      cur = "";
      i += sep.length - 1;
    } else cur += c;
  }
  parts.push(cur);
  return parts.map((p) => p.trim());
};

const DEFAULT_VALUE_FLAGS = ["-o", "-n", "-p", "-l", "-f", "-c"];

/**
 * Parses flags. `--k=v` always works; `--k v` / `-k v` only for flags listed in valueFlags
 * (defaults to the short flags above when the tool declares none). Everything after a bare `--` goes to `rest`.
 */
export const parseFlags = (args: string[], valueFlags?: string[]) => {
  const flags: Flags = {};
  const pos: string[] = [];
  let rest: string[] = [];
  const takes = new Set(valueFlags ?? DEFAULT_VALUE_FLAGS);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") {
      rest = args.slice(i + 1);
      break;
    }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > 0) flags[a.slice(2, eq)] = a.slice(eq + 1);
      else if (takes.has(a) && args[i + 1] !== undefined && !args[i + 1].startsWith("-")) flags[a.slice(2)] = args[++i];
      else flags[a.slice(2)] = true;
    } else if (a.startsWith("-") && a.length > 1 && !/^-\d/.test(a)) {
      const eq = a.indexOf("=");
      if (eq > 0) flags[a.slice(1, eq)] = a.slice(eq + 1);
      else if (takes.has(a) && args[i + 1] !== undefined) flags[a.slice(1)] = args[++i];
      else flags[a.slice(1)] = true;
    } else pos.push(a);
  }
  return { flags, pos, rest };
};

export const flagStr = (flags: Flags, ...keys: string[]) => {
  for (const k of keys) if (typeof flags[k] === "string") return flags[k] as string;
  return undefined;
};

// ---------- fuzzy matching ----------
export const lev = (a: string, b: string) => {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
};

export const closest = (word: string, options: string[]) => {
  let best: string | undefined;
  let score = Infinity;
  let bestPrefix = -1;
  const w = word.toLowerCase();
  const prefixLen = (o: string) => {
    let i = 0;
    while (i < w.length && i < o.length && w[i] === o[i]) i++;
    return i;
  };
  for (const o of options) {
    const lo = o.toLowerCase();
    const s = lev(w, lo);
    const pl = prefixLen(lo);
    if (s < score || (s === score && pl > bestPrefix)) {
      score = s;
      best = o;
      bestPrefix = pl;
    }
  }
  return score <= Math.max(2, Math.floor(word.length / 3)) ? best : undefined;
};

// ---------- paths ----------
export const normalizePath = (p: string) => {
  const parts: string[] = [];
  for (const seg of p.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return "/" + parts.join("/");
};

export const resolvePath = (cwd: string, p: string) => {
  if (p === "~") return HOME;
  if (p.startsWith("~/")) return normalizePath(HOME + p.slice(1));
  if (p.startsWith("/")) return normalizePath(p);
  return normalizePath(`${cwd}/${p}`);
};

export const matchLabels = (selector: Record<string, string> | undefined, labels: Record<string, string>) =>
  !!selector && Object.entries(selector).every(([k, v]) => labels[k] === v);
