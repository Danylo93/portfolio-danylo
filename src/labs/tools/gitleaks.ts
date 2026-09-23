// gitleaks: detects hard-coded secrets (API keys, tokens, private keys, passwords) in files.
import { registerTool } from "../registry";
import type { Shell } from "../shell";
import { SECRET_RULES, entropy, findSecrets, hashHex, relTo, walkFiles, type SecretRule } from "./sec-common";

// ---------------------------------------------------------------- tiny TOML reader (enough for .gitleaks.toml)
type TomlVal = string | number | boolean | TomlVal[] | { [k: string]: TomlVal };
type TomlDoc = Record<string, TomlVal>;

export const parseToml = (src: string): TomlDoc => {
  const root: TomlDoc = {};
  let cur: Record<string, TomlVal> = root;
  let i = 0;
  let line = 1;
  const err = (m: string): never => {
    throw new Error(`toml: line ${line}: ${m}`);
  };
  const ws = (nl = false) => {
    for (;;) {
      const c = src[i];
      if (c === " " || c === "\t" || c === "\r") i++;
      else if (c === "#") while (i < src.length && src[i] !== "\n") i++;
      else if (nl && c === "\n") {
        line++;
        i++;
      } else break;
    }
  };
  const value = (): TomlVal => {
    ws();
    if (src.startsWith("'''", i) || src.startsWith('"""', i)) {
      const q = src.slice(i, i + 3);
      const end = src.indexOf(q, i + 3);
      if (end < 0) err("unterminated multi-line string");
      let s = src.slice(i + 3, end);
      line += (s.match(/\n/g) ?? []).length;
      if (s.startsWith("\n")) s = s.slice(1);
      i = end + 3;
      return s;
    }
    if (src[i] === '"' || src[i] === "'") {
      const q = src[i];
      let j = i + 1;
      let s = "";
      while (j < src.length && src[j] !== q) {
        if (src[j] === "\n") err("unterminated string");
        if (q === '"' && src[j] === "\\") {
          const n = src[j + 1];
          s += n === "n" ? "\n" : n === "t" ? "\t" : n;
          j += 2;
          continue;
        }
        s += src[j++];
      }
      if (j >= src.length) err("unterminated string");
      i = j + 1;
      return s;
    }
    if (src[i] === "[") {
      i++;
      const arr: TomlVal[] = [];
      for (;;) {
        ws(true);
        if (src[i] === "]") {
          i++;
          return arr;
        }
        arr.push(value());
        ws(true);
        if (src[i] === ",") i++;
        else if (src[i] !== "]") err("expected ',' or ']' in array");
      }
    }
    const m = /^(true|false|-?\d+(\.\d+)?)/.exec(src.slice(i));
    if (!m) err(`invalid value starting with "${src.slice(i, i + 12).split("\n")[0]}"`);
    i += m[0].length;
    return m[1] === "true" ? true : m[1] === "false" ? false : Number(m[0]);
  };
  while (i < src.length) {
    ws(true);
    if (i >= src.length) break;
    if (src.startsWith("[[", i)) {
      const end = src.indexOf("]]", i);
      if (end < 0) err("unterminated table array header");
      const name = src.slice(i + 2, end).trim();
      const arr = (root[name] ??= []) as TomlVal[];
      cur = {};
      arr.push(cur);
      i = end + 2;
    } else if (src[i] === "[") {
      const end = src.indexOf("]", i);
      if (end < 0) err("unterminated table header");
      const name = src.slice(i + 1, end).trim();
      const parts = name.split(".");
      let t: Record<string, TomlVal> = root;
      for (const p of parts) {
        const existing = t[p];
        if (Array.isArray(existing)) t = existing[existing.length - 1] as Record<string, TomlVal>;
        else t = (t[p] ??= {}) as Record<string, TomlVal>;
      }
      cur = t;
      i = end + 1;
    } else {
      const m = /^([A-Za-z0-9_.-]+|"[^"]*")\s*=/.exec(src.slice(i));
      if (!m) err(`expected key = value, found "${src.slice(i, i + 20).split("\n")[0]}"`);
      i += m[0].length;
      cur[m[1].replace(/"/g, "")] = value();
    }
    ws();
    if (i < src.length && src[i] !== "\n") err(`unexpected "${src[i]}" after value`);
  }
  return root;
};

// ---------------------------------------------------------------- config
export type Allowlist = { description?: string; paths: RegExp[]; regexes: RegExp[]; stopwords: string[] };
export type LeaksConfig = { path?: string; useDefault: boolean; rules: { id: string; description: string; re: RegExp }[]; allowlists: Allowlist[]; error?: string };

const toRe = (x: TomlVal) => {
  try {
    return new RegExp(String(x).replace(/^\(\?i\)/, ""), /^\(\?i\)/.test(String(x)) ? "i" : "");
  } catch {
    return null;
  }
};

const readAllowlist = (t: Record<string, TomlVal>): Allowlist => ({
  description: t.description ? String(t.description) : undefined,
  paths: ((t.paths as TomlVal[]) ?? []).map(toRe).filter((x): x is RegExp => !!x),
  regexes: ((t.regexes as TomlVal[]) ?? []).map(toRe).filter((x): x is RegExp => !!x),
  stopwords: ((t.stopwords as TomlVal[]) ?? []).map(String),
});

/** Loads .gitleaks.toml from the source dir (or the explicit --config path). */
export const loadLeaksConfig = (sh: Shell, source: string, explicit?: string): LeaksConfig => {
  const path = explicit ?? `${sh.resolve(source)}/.gitleaks.toml`;
  const raw = sh.readFile(path);
  if (raw === undefined) return { useDefault: true, rules: [], allowlists: [], ...(explicit ? { error: `open ${explicit}: no such file or directory` } : {}) };
  try {
    const doc = parseToml(raw);
    const extend = (doc.extend ?? {}) as Record<string, TomlVal>;
    const rules = ((doc.rules as Record<string, TomlVal>[]) ?? []).map((r) => ({ id: String(r.id ?? "custom-rule"), description: String(r.description ?? ""), re: toRe(r.regex ?? "") ?? /$^/ }));
    const allowlists: Allowlist[] = [];
    if (doc.allowlist && typeof doc.allowlist === "object" && !Array.isArray(doc.allowlist)) allowlists.push(readAllowlist(doc.allowlist as Record<string, TomlVal>));
    for (const a of (doc.allowlists as Record<string, TomlVal>[]) ?? []) allowlists.push(readAllowlist(a));
    return { path, useDefault: extend.useDefault === true, rules, allowlists };
  } catch (e) {
    return { path, useDefault: false, rules: [], allowlists: [], error: (e as Error).message };
  }
};

// Paths ignored by the default gitleaks config.
const DEFAULT_PATH_ALLOW = [/(^|\/)gitleaks\.toml$/, /\.(jpe?g|png|gif|svg|ico|pdf|woff2?|ttf|eot)$/i, /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|go\.sum|poetry\.lock)$/, /(^|\/)node_modules\//, /(^|\/)vendor\//];

export type Leak = { rule: string; description: string; file: string; line: number; col: number; match: string; secret: string; entropy: number };

const RULE_DESC: Record<string, string> = {
  "aws-access-token": "Identified a pattern that may indicate AWS credentials, risking unauthorized cloud resource access and data breaches on AWS platforms.",
  "github-pat": "Uncovered a GitHub Personal Access Token, potentially leading to unauthorized repository access and sensitive content exposure.",
  "github-fine-grained-pat": "Found a GitHub Fine-Grained Personal Access Token, risking unauthorized repository access and code manipulation.",
  "slack-bot-token": "Identified a Slack Bot token, which may compromise bot integrations and communication channel security.",
  "private-key": "Identified a Private Key, which may compromise cryptographic security and sensitive data encryption.",
  "generic-api-key": "Detected a Generic API Key, potentially exposing access to various services and sensitive operations.",
};

/** Scans files under source with the given config. Pure: used by the tool and by lab checks. */
export const scanLeaks = (sh: Shell, source: string, cfg: LeaksConfig, skip: string[] = []): Leak[] => {
  const leaks: Leak[] = [];
  const builtin: SecretRule[] = cfg.useDefault ? SECRET_RULES : [];
  for (const abs of walkFiles(sh, source)) {
    if (skip.includes(abs)) continue;
    const file = relTo(sh, source, abs);
    if (cfg.useDefault && DEFAULT_PATH_ALLOW.some((re) => re.test(file))) continue;
    if (cfg.allowlists.some((a) => a.paths.some((re) => re.test(file)))) continue;
    const content = sh.state.files[abs] ?? "";
    const lines = content.split("\n");
    const hits: Leak[] = [];
    for (const h of findSecrets(content)) {
      if (!builtin.includes(h.rule)) continue;
      hits.push({ rule: h.rule.id, description: RULE_DESC[h.rule.id] ?? h.rule.id, file, line: h.line, col: h.col, match: h.rule.id === "generic-api-key" ? h.match : h.secret, secret: h.secret, entropy: entropy(h.secret) });
    }
    for (const r of cfg.rules)
      lines.forEach((text, i) => {
        const m = r.re.exec(text);
        if (m) hits.push({ rule: r.id, description: r.description, file, line: i + 1, col: m.index + 1, match: m[0], secret: m[1] ?? m[0], entropy: entropy(m[1] ?? m[0]) });
      });
    for (const h of hits) {
      if (/gitleaks:allow/.test(lines[h.line - 1])) continue;
      if (cfg.allowlists.some((a) => a.regexes.some((re) => re.test(h.secret)) || a.stopwords.some((w) => h.secret.toLowerCase().includes(w.toLowerCase())))) continue;
      leaks.push(h);
    }
  }
  return leaks;
};

// ---------------------------------------------------------------- state
export type GitleaksRun = { source: string; leaks: Leak[]; configPath?: string; useDefault: boolean; allowlisted: number };
export const gitleaksState = (sh: Shell) => sh.ext("sec:gitleaks", () => ({ runs: [] as GitleaksRun[], reports: [] as string[] }));
export const lastGitleaksRun = (sh: Shell) => gitleaksState(sh).runs[gitleaksState(sh).runs.length - 1];

const clock = () => {
  const d = new Date();
  const h = d.getHours();
  return `${((h + 11) % 12) + 1}:${String(d.getMinutes()).padStart(2, "0")}${h < 12 ? "AM" : "PM"}`;
};

const BANNER = `
    ○
    │╲
    │ ○
    ○ ░
    ░    gitleaks
`;

registerTool({
  name: "gitleaks",
  summary: "detecta segredos (chaves AWS, tokens, senhas, chaves privadas) em arquivos e no histórico git",
  subcommands: {
    detect: "procura segredos no repositório (histórico git ou, com --no-git, nos arquivos)",
    dir: "procura segredos num diretório ou arquivo (sem git)",
    git: "procura segredos no histórico de commits",
    protect: "procura segredos em mudanças ainda não commitadas (pre-commit)",
    version: "mostra a versão",
  },
  flags: {
    "--source": "diretório a escanear (padrão: .)",
    "-s": "o mesmo que --source",
    "-v": "verbose: mostra cada achado (arquivo, linha, regra)",
    "--verbose": "mostra cada achado (arquivo, linha, regra)",
    "--no-git": "escaneia os arquivos como diretório comum, sem ler o histórico git",
    "--redact": "esconde o valor do segredo na saída e no relatório",
    "--report-path": "grava o relatório (JSON) nesse arquivo",
    "-r": "o mesmo que --report-path",
    "--report-format": "formato do relatório: json, csv, sarif",
    "--config": "arquivo de configuração (padrão: .gitleaks.toml na raiz escaneada)",
    "-c": "o mesmo que --config",
    "--exit-code": "código de saída quando houver vazamentos (padrão 1)",
    "--staged": "protect: só as mudanças em stage",
  },
  valueFlags: ["--source", "-s", "--report-path", "-r", "--report-format", "-f", "--config", "-c", "--exit-code", "--log-level", "-l"],
  run: ({ sh, flags, pos }) => {
    const [sub, pathArg] = pos;
    if (!sub || flags.h || flags.help)
      return `Gitleaks scans code, past or present, for secrets

Usage:
  gitleaks [command]

Available Commands:
  detect      detect secrets in code
  dir         scan directories or files for secrets
  git         scan git repositories for secrets
  help        Help about any command
  protect     protect secrets in code
  version     display gitleaks version`;
    if (sub === "version") return "8.21.2";
    if (!["detect", "dir", "git", "protect"].includes(sub)) return { output: `Error: unknown command "${sub}" for "gitleaks"\nRun 'gitleaks --help' for usage.`, ok: false };
    const source = String(flags.source ?? flags.s ?? (sub === "dir" || sub === "git" ? pathArg ?? "." : "."));
    const t = clock();
    const noGit = sub === "dir" || !!flags["no-git"];
    if (!sh.exists(source)) return { output: `${BANNER}\n${t} FTL could not scan ${source}: lstat ${source}: no such file or directory`, ok: false };
    if (!noGit && !sh.isDir(`${source}/.git`))
      return {
        output: `${BANNER}\n${t} ERR [git] fatal: not a git repository (or any of the parent directories): .git\n${t} ERR failed to scan Git repository error="stderr is not empty"\n${t} WRN partial scan completed in 11.2ms\n${t} WRN no leaks found in partial scan`,
        ok: false,
      };
    const explicit = typeof (flags.config ?? flags.c) === "string" ? String(flags.config ?? flags.c) : undefined;
    const cfg = loadLeaksConfig(sh, source, explicit);
    if (cfg.error) return { output: `${BANNER}\n${t} FTL unable to load gitleaks config, err: ${cfg.error}`, ok: false };
    const st = gitleaksState(sh);
    const unfiltered = scanLeaks(sh, source, { ...cfg, allowlists: [] }, st.reports).length;
    const leaks = scanLeaks(sh, source, cfg, st.reports);
    const redact = !!flags.redact;
    const verbose = !!(flags.v || flags.verbose);
    const bytes = walkFiles(sh, source).reduce((n, f) => n + (sh.state.files[f]?.length ?? 0), 0);
    const out: string[] = [BANNER];
    if (cfg.path && !explicit) out.push(`${t} INF using config file ${relTo(sh, source, cfg.path)}`);
    if (verbose)
      for (const l of leaks) {
        const commit = noGit ? [] : [`Commit:      ${hashHex(l.file + l.line, 40)}`, "Author:      Danylo Oliveira", "Email:       danylo@example.com", "Date:        2026-09-20T14:02:11Z"];
        out.push(
          [
            `Finding:     ${redact ? l.match.replace(l.secret, "REDACTED") : l.match}`,
            `Secret:      ${redact ? "REDACTED" : l.secret}`,
            `RuleID:      ${l.rule}`,
            `Entropy:     ${l.entropy.toFixed(6)}`,
            `File:        ${l.file}`,
            `Line:        ${l.line}`,
            ...commit,
            `Fingerprint: ${noGit ? "" : hashHex(l.file + l.line, 40) + ":"}${l.file}:${l.rule}:${l.line}`,
            "",
          ].join("\n"),
        );
      }
    const reportPath = typeof (flags["report-path"] ?? flags.r) === "string" ? String(flags["report-path"] ?? flags.r) : undefined;
    if (reportPath) {
      const fmt = String(flags["report-format"] ?? flags.f ?? "json");
      const rows = leaks.map((l) => ({
        RuleID: l.rule, Description: l.description, StartLine: l.line, EndLine: l.line, StartColumn: l.col, EndColumn: l.col + l.match.length - 1,
        Match: redact ? l.match.replace(l.secret, "REDACTED") : l.match, Secret: redact ? "REDACTED" : l.secret, File: l.file, SymlinkFile: "", Commit: "",
        Entropy: Number(l.entropy.toFixed(6)), Author: "", Email: "", Date: "", Message: "", Tags: [], Fingerprint: `${l.file}:${l.rule}:${l.line}`,
      }));
      sh.writeFile(reportPath, fmt === "csv" ? ["RuleID,File,StartLine,Secret", ...rows.map((r) => `${r.RuleID},${r.File},${r.StartLine},${r.Secret}`)].join("\n") : JSON.stringify(rows, null, 1));
      st.reports.push(sh.resolve(reportPath));
    }
    st.runs.push({ source: sh.resolve(source), leaks, configPath: cfg.path, useDefault: cfg.useDefault, allowlisted: unfiltered - leaks.length });
    sh.flags.add("gitleaks:scanned");
    out.push(`${t} INF ${noGit ? "" : "1 commits scanned.\n" + t + " INF "}scanned ~${bytes} bytes (${(bytes / 1000).toFixed(2)} KB) in 23.8ms`);
    if (!cfg.useDefault && !cfg.rules.length) out.push(`${t} WRN no rules loaded: config does not extend the default config (add [extend] useDefault = true)`);
    const exit = flags["exit-code"] !== undefined ? Number(flags["exit-code"]) : 1;
    if (leaks.length) {
      out.push(`${t} WRN leaks found: ${leaks.length}`);
      return { output: out.join("\n"), ok: exit === 0 };
    }
    out.push(`${t} INF no leaks found`);
    return out.join("\n");
  },
  explainError: (cmd, output) => {
    if (/not a git repository/.test(output))
      return "Por padrão o gitleaks detect lê o histórico do git, e este diretório não é um repositório. Para escanear só os arquivos, use --no-git (ou o subcomando gitleaks dir .).";
    if (/leaks found: \d+/.test(output))
      return "O gitleaks encontrou segredos e saiu com código 1 — numa pipeline ou pre-commit hook isso bloqueia a mudança. Rode com -v para ver arquivo, linha e regra de cada achado.";
    if (/unable to load gitleaks config/.test(output)) return "O .gitleaks.toml tem erro de sintaxe TOML. Strings de regex costumam ir entre três aspas simples: '''^test/fixtures/'''.";
    return null;
  },
});
