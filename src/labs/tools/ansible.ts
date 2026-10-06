/* eslint-disable @typescript-eslint/no-explicit-any -- playbooks, vars and module args are free-form YAML. */
// Simulated Ansible: ansible, ansible-playbook, ansible-vault, ansible-inventory and ansible-galaxy.
// Managed nodes are shell hosts (sh.state.hosts); files written on them live in host.files.
import YAML from "yaml";
import { registerTool } from "../registry";
import type { Shell } from "../shell";
import type { Host } from "../types";
import { tokenize } from "../util";

type Vars = Record<string, any>;
type Group = { hosts: string[]; vars: Vars; children: string[] };
type Inventory = { path: string; hosts: Record<string, Vars>; order: string[]; groups: Record<string, Group> };

export type AnsibleRun = {
  check: boolean;
  serial?: number;
  limit?: string;
  tags: string[];
  hosts: string[];
  /** false when the run aborted with ERROR! */
  completed: boolean;
  failed: boolean;
  changed: Record<string, number>;
  error?: string;
};
export type AnsibleState = {
  runs: AnsibleRun[];
  pings: Set<string>;
  restarts: Record<string, number>;
  adhoc: { module: string; args: string; hosts: string[]; ok: boolean }[];
  graph: boolean;
};
export const ansibleState = (sh: Shell) => sh.ext<AnsibleState>("ansible", () => ({ runs: [], pings: new Set(), restarts: {}, adhoc: [], graph: false }));

class AnsibleError extends Error {}
class UndefinedVar extends Error {
  constructor(readonly varName: string) {
    super(`'${varName}' is undefined`);
  }
}

const VERSION = "ansible [core 2.17.5]";
const MANAGED = "Ansible managed";

// ------------------------------------------------------------------ small helpers

const banner = (title: string) => `${title} ${"*".repeat(Math.max(3, 79 - title.length))}`;

/** json.dumps-like formatting (", " and ": " separators), as Ansible prints task results. */
const pyJson = (v: unknown): string => {
  if (Array.isArray(v)) return `[${v.map(pyJson).join(", ")}]`;
  if (v && typeof v === "object") return `{${Object.entries(v).map(([k, x]) => `${JSON.stringify(k)}: ${pyJson(x)}`).join(", ")}}`;
  return JSON.stringify(v ?? null);
};

const toList = (v: unknown): string[] => (v == null ? [] : Array.isArray(v) ? v.map(String) : String(v).split(",").map((s) => s.trim()).filter(Boolean));

const scalar = (v: string): any => {
  const s = v.replace(/^(['"])(.*)\1$/, "$2");
  if (s !== v) return s;
  if (/^-?\d+$/.test(v)) return Number(v);
  if (/^(true|yes)$/i.test(v)) return true;
  if (/^(false|no)$/i.test(v)) return false;
  return v;
};

/** key=value pairs (free-form module args or -e "a=1 b=2"). */
const kvArgs = (text: string): Vars => {
  const out: Vars = {};
  const raw: string[] = [];
  for (const t of tokenize(text)) {
    const eq = t.indexOf("=");
    if (eq > 0 && /^\w+$/.test(t.slice(0, eq))) out[t.slice(0, eq)] = scalar(t.slice(eq + 1));
    else raw.push(t);
  }
  if (raw.length) out._raw_params = raw.join(" ");
  return out;
};

/** All values of a repeatable flag (e.g. several -e or --tags). */
const multi = (args: string[], names: string[]) => {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const name = names.find((n) => a === n || a.startsWith(`${n}=`));
    if (!name) continue;
    if (a === name) {
      if (args[i + 1] !== undefined) out.push(args[++i]);
    } else out.push(a.slice(name.length + 1));
  }
  return out;
};

const has = (args: string[], ...names: string[]) => args.some((a) => names.includes(a));

const dirOf = (p: string) => p.slice(0, p.lastIndexOf("/")) || "/";

const truthy = (v: unknown) => !(v === false || v === 0 || v === "" || v == null || (Array.isArray(v) && !v.length) || (typeof v === "string" && /^(false|no|off)$/i.test(v)));

// ------------------------------------------------------------------ config & vault

function readConfig(sh: Shell): Record<string, string> {
  const text = sh.readFile("ansible.cfg") ?? sh.readFile("~/.ansible.cfg") ?? "";
  const out: Record<string, string> = {};
  let section = "";
  for (const line of text.split("\n")) {
    const l = line.trim();
    if (!l || l.startsWith("#") || l.startsWith(";")) continue;
    const s = /^\[(.+)\]$/.exec(l);
    if (s) section = s[1];
    else if (section === "defaults") {
      const m = /^([\w-]+)\s*=\s*(.*)$/.exec(l);
      if (m) out[m[1]] = m[2].trim();
    }
  }
  return out;
}

const VAULT_HEADER = "$ANSIBLE_VAULT;1.1;AES256";
const MAGIC = "dlab-vault:";
const isVault = (text: string) => text.trimStart().startsWith("$ANSIBLE_VAULT;");

// Not real AES: a keyed, reversible encoding that looks like vault output and fails on a wrong password.
function vaultEncrypt(plain: string, password: string) {
  const key = new TextEncoder().encode(password);
  const bytes = new TextEncoder().encode(MAGIC + plain);
  const hex = Array.from(bytes, (b, i) => (b ^ key[i % key.length] ^ ((i * 31) & 0xff)).toString(16).padStart(2, "0")).join("");
  return `${VAULT_HEADER}\n${hex.match(/.{1,80}/g)!.join("\n")}\n`;
}

export function vaultDecrypt(text: string, password: string): string | null {
  const hex = text.trim().split("\n").slice(1).join("").replace(/\s+/g, "");
  if (!/^([0-9a-f]{2})*$/.test(hex)) return null;
  const key = new TextEncoder().encode(password);
  const bytes = Uint8Array.from(hex.match(/../g) ?? [], (h, i) => parseInt(h, 16) ^ key[i % key.length] ^ ((i * 31) & 0xff));
  const plain = new TextDecoder().decode(bytes);
  return plain.startsWith(MAGIC) ? plain.slice(MAGIC.length) : null;
}

/** Password from --vault-password-file, $ANSIBLE_VAULT_PASSWORD_FILE or ansible.cfg. */
function vaultPassword(sh: Shell, args: string[], env: Record<string, string>): string | undefined {
  if (has(args, "--ask-vault-pass", "--ask-vault-password", "-J")) throw new AnsibleError("ERROR! Este terminal não é interativo e não consegue pedir a senha do vault. Use --vault-password-file ~/.vault_pass.");
  const file = multi(args, ["--vault-password-file", "--vault-pass-file"])[0] ?? env.ANSIBLE_VAULT_PASSWORD_FILE ?? readConfig(sh).vault_password_file;
  if (!file) return undefined;
  const content = sh.readFile(file);
  if (content === undefined) throw new AnsibleError(`ERROR! The vault password file ${sh.resolve(file)} was not found`);
  const pass = content.split("\n")[0].trim();
  if (!pass) throw new AnsibleError(`ERROR! Invalid vault password was provided from file (${sh.resolve(file)})`);
  return pass;
}

class VaultValue {
  constructor(readonly cipher: string) {}
}
const YAML_TAGS = [{ tag: "!vault", resolve: (value: string) => new VaultValue(value) }];

function parseYaml(text: string, file: string): any {
  try {
    return YAML.parse(text, { customTags: YAML_TAGS as any });
  } catch (e) {
    throw new AnsibleError(`ERROR! We were unable to read either as JSON nor YAML, these are the errors we got from each:\nJSON: Expecting value: line 1 column 1 (char 0)\n\nSyntax Error while loading YAML.\n  ${(e as Error).message.split("\n")[0]}\n\nThe error appears to be in '${file}'`);
  }
}

/** Reads a vars/tasks file, decrypting vault files and inline !vault values. */
function loadYamlFile(sh: Shell, path: string, pass: string | undefined): any {
  let text = sh.readFile(path);
  if (text === undefined) return undefined;
  if (isVault(text)) {
    if (pass === undefined) throw new AnsibleError("ERROR! Attempting to decrypt but no vault secrets found");
    const plain = vaultDecrypt(text, pass);
    if (plain === null) throw new AnsibleError(`ERROR! Decryption failed (no vault secrets were found that could decrypt) on ${sh.resolve(path)}`);
    text = plain;
  }
  const decryptInline = (v: any): any => {
    if (v instanceof VaultValue) {
      if (pass === undefined) throw new AnsibleError("ERROR! Attempting to decrypt but no vault secrets found");
      const plain = vaultDecrypt(v.cipher, pass);
      if (plain === null) throw new AnsibleError(`ERROR! Decryption failed (no vault secrets were found that could decrypt) on ${sh.resolve(path)}`);
      return plain;
    }
    if (Array.isArray(v)) return v.map(decryptInline);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, decryptInline(x)]));
    return v;
  };
  return decryptInline(parseYaml(text, sh.resolve(path)));
}

// ------------------------------------------------------------------ inventory

function parseInventory(sh: Shell, path: string): Inventory {
  const abs = sh.resolve(path);
  const text = sh.readFile(path);
  const inv: Inventory = { path: abs, hosts: {}, order: [], groups: { all: { hosts: [], vars: {}, children: [] }, ungrouped: { hosts: [], vars: {}, children: [] } } };
  if (text === undefined) return inv;
  const group = (name: string) => (inv.groups[name] ??= { hosts: [], vars: {}, children: [] });
  let section = "ungrouped";
  let kind = "hosts";
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\s+[#;].*$/, "").trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const header = /^\[([^\]:]+)(?::(vars|children))?\]$/.exec(line);
    if (header) {
      section = header[1];
      kind = header[2] ?? "hosts";
      group(section);
      continue;
    }
    if (kind === "vars") {
      const m = /^([\w.-]+)\s*=\s*(.*)$/.exec(line);
      if (m) group(section).vars[m[1]] = scalar(m[2].trim());
    } else if (kind === "children") {
      group(line);
      if (!group(section).children.includes(line)) group(section).children.push(line);
    } else {
      const [host, ...rest] = tokenize(line);
      if (!inv.hosts[host]) {
        inv.hosts[host] = {};
        inv.order.push(host);
      }
      for (const kv of rest) {
        const eq = kv.indexOf("=");
        if (eq > 0) inv.hosts[host][kv.slice(0, eq)] = scalar(kv.slice(eq + 1));
      }
      if (!group(section).hosts.includes(host)) group(section).hosts.push(host);
    }
  }
  const grouped = new Set(Object.entries(inv.groups).filter(([n]) => n !== "ungrouped" && n !== "all").flatMap(([, g]) => g.hosts));
  inv.groups.ungrouped.hosts = inv.order.filter((h) => !grouped.has(h));
  inv.groups.all.hosts = [...inv.order];
  return inv;
}

function members(inv: Inventory, name: string, seen = new Set<string>()): string[] {
  if (name === "all") return [...inv.order];
  const g = inv.groups[name];
  if (!g || seen.has(name)) return [];
  seen.add(name);
  const set = new Set([...g.hosts, ...g.children.flatMap((c) => members(inv, c, seen))]);
  return inv.order.filter((h) => set.has(h));
}

const groupNames = (inv: Inventory, host: string) => Object.keys(inv.groups).filter((g) => g !== "all" && members(inv, g).includes(host));

/** Host patterns: all, group, host, a:b / a,b, !exclude, &intersect and * wildcards. */
function matchHosts(inv: Inventory, pattern: string): { hosts: string[]; unmatched: string[] } {
  const unmatched: string[] = [];
  const resolve = (item: string): string[] => {
    if (item === "all" || item === "*") return [...inv.order];
    if (inv.groups[item]) return members(inv, item);
    if (inv.hosts[item]) return [item];
    if (item.includes("*")) {
      const re = new RegExp(`^${item.split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
      return [...new Set([...inv.order.filter((h) => re.test(h)), ...Object.keys(inv.groups).filter((g) => re.test(g)).flatMap((g) => members(inv, g))])];
    }
    unmatched.push(item);
    return [];
  };
  let set = new Set<string>();
  const items = pattern.split(/[,:]/).map((s) => s.trim()).filter(Boolean);
  for (const item of items.filter((i) => !/^[!&]/.test(i))) for (const h of resolve(item)) set.add(h);
  for (const item of items.filter((i) => i.startsWith("&"))) {
    const keep = new Set(resolve(item.slice(1)));
    set = new Set([...set].filter((h) => keep.has(h)));
  }
  for (const item of items.filter((i) => i.startsWith("!"))) for (const h of resolve(item.slice(1))) set.delete(h);
  return { hosts: inv.order.filter((h) => set.has(h)), unmatched };
}

function inventoryPath(sh: Shell, args: string[]) {
  return multi(args, ["-i", "--inventory", "--inventory-file"])[0] ?? readConfig(sh).inventory ?? "/etc/ansible/hosts";
}

// ------------------------------------------------------------------ Jinja2 subset

const UNDEF = Symbol("undefined");
type Undef = { [UNDEF]: string };
const undef = (name: string): Undef => ({ [UNDEF]: name });
const isUndef = (v: unknown): v is Undef => !!v && typeof v === "object" && UNDEF in (v as object);
const must = (v: unknown) => {
  if (isUndef(v)) throw new UndefinedVar(v[UNDEF]);
  return v;
};

/** Splits on a separator at depth 0, outside quotes. */
function splitTopLevel(expr: string, sep: string | RegExp): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = "";
  let cur = "";
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i];
    if (quote) {
      if (c === quote) quote = "";
      cur += c;
      continue;
    }
    if (c === "'" || c === '"') quote = c;
    else if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    if (depth === 0 && !quote) {
      const rest = expr.slice(i);
      const m = typeof sep === "string" ? (rest.startsWith(sep) ? sep : null) : sep.exec(rest)?.index === 0 ? sep.exec(rest)![0] : null;
      if (m && (typeof sep !== "string" || sep !== "|" || expr[i + 1] !== "|")) {
        out.push(cur);
        cur = "";
        i += m.length - 1;
        continue;
      }
    }
    cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

export class Renderer {
  private depth = 0;
  constructor(private vars: Vars) {}

  lookup(name: string): unknown {
    if (!(name in this.vars)) return undef(name);
    return this.resolveValue(this.vars[name]);
  }

  /** Values may themselves be templates ("{{ vault_api_token }}"): render lazily, like Ansible. */
  resolveValue(v: unknown): unknown {
    if (typeof v === "string" && /\{\{|\{%/.test(v)) {
      if (++this.depth > 30) throw new AnsibleError("ERROR! recursive loop detected in template string");
      try {
        return this.renderValue(v);
      } finally {
        this.depth--;
      }
    }
    if (Array.isArray(v)) return v.map((x) => this.resolveValue(x));
    if (v && typeof v === "object" && !(v instanceof VaultValue)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, this.resolveValue(x)]));
    return v;
  }

  /** A string that is exactly "{{ expr }}" keeps the native type (list, number); otherwise text. */
  renderValue(s: string): unknown {
    const only = /^\s*\{\{(.*?)\}\}\s*$/s.exec(s);
    if (only && !only[1].includes("}}")) return must(this.expr(only[1]));
    return this.render(s);
  }

  render(tpl: string): string {
    type Node = { t: "text"; v: string } | { t: "expr"; v: string } | { t: "for"; name: string; iter: string; body: Node[] } | { t: "if"; branches: { cond: string | null; body: Node[] }[] };
    const root: Node[] = [];
    const stack: { nodes: Node[]; node?: Node }[] = [{ nodes: root }];
    const re = /\{\{(.*?)\}\}|\{%-?\s*(.*?)\s*-?%\}\n?|\{#.*?#\}/gs;
    let last = 0;
    for (let m = re.exec(tpl); m; m = re.exec(tpl)) {
      const top = stack[stack.length - 1];
      if (m.index > last) top.nodes.push({ t: "text", v: tpl.slice(last, m.index) });
      last = re.lastIndex;
      if (m[1] !== undefined) top.nodes.push({ t: "expr", v: m[1] });
      else if (m[2] !== undefined) {
        const stmt = m[2];
        const forM = /^for\s+(\w+)\s+in\s+(.+)$/.exec(stmt);
        const ifM = /^if\s+(.+)$/.exec(stmt);
        const elifM = /^elif\s+(.+)$/.exec(stmt);
        if (forM) {
          const node: Node = { t: "for", name: forM[1], iter: forM[2], body: [] };
          top.nodes.push(node);
          stack.push({ nodes: node.body, node });
        } else if (ifM) {
          const node: Node = { t: "if", branches: [{ cond: ifM[1], body: [] }] };
          top.nodes.push(node);
          stack.push({ nodes: node.branches[0].body, node });
        } else if ((elifM || stmt === "else") && top.node?.t === "if") {
          const branch = { cond: elifM ? elifM[1] : null, body: [] as Node[] };
          top.node.branches.push(branch);
          top.nodes = branch.body;
        } else if ((stmt === "endfor" && top.node?.t === "for") || (stmt === "endif" && top.node?.t === "if")) stack.pop();
        else throw new AnsibleError(`template error while templating string: Encountered unknown tag '${stmt.split(/\s/)[0]}'.`);
      }
    }
    if (last < tpl.length) stack[stack.length - 1].nodes.push({ t: "text", v: tpl.slice(last) });
    if (stack.length > 1) throw new AnsibleError(`template error while templating string: Unexpected end of template. Jinja was looking for the following tags: 'end${stack[stack.length - 1].node!.t}'.`);
    const out = (nodes: Node[]): string =>
      nodes
        .map((n) => {
          if (n.t === "text") return n.v;
          if (n.t === "expr") {
            const v = must(this.expr(n.v));
            return v && typeof v === "object" ? JSON.stringify(v) : String(v ?? "");
          }
          if (n.t === "for") {
            const list = must(this.expr(n.iter));
            const items = Array.isArray(list) ? list : list && typeof list === "object" ? Object.keys(list) : [];
            const saved = this.vars[n.name];
            const had = n.name in this.vars;
            const text = items.map((item) => {
              this.vars[n.name] = item;
              return out(n.body);
            }).join("");
            if (had) this.vars[n.name] = saved;
            else delete this.vars[n.name];
            return text;
          }
          const branch = n.branches.find((b) => b.cond === null || truthy(must(this.expr(b.cond))));
          return branch ? out(branch.body) : "";
        })
        .join("");
    return out(root);
  }

  /** Evaluates a Jinja expression. Returns an Undef marker instead of throwing, so default() and "is defined" work. */
  expr(src: string): unknown {
    const e = src.trim();
    const ors = splitTopLevel(e, / or /);
    if (ors.length > 1) return ors.some((p) => truthy(must(this.expr(p))));
    const ands = splitTopLevel(e, / and /);
    if (ands.length > 1) return ands.every((p) => truthy(must(this.expr(p))));
    if (/^not\s+/.test(e)) return !truthy(must(this.expr(e.replace(/^not\s+/, ""))));
    const test = /^(.+?)\s+is\s+(not\s+)?(defined|undefined|none)$/.exec(e);
    if (test) {
      const v = this.expr(test[1]);
      const r = test[3] === "defined" ? !isUndef(v) : test[3] === "undefined" ? isUndef(v) : v === null;
      return test[2] ? !r : r;
    }
    for (const op of ["==", "!=", ">=", "<=", ">", "<", " in "]) {
      const parts = splitTopLevel(e, op);
      if (parts.length === 2) {
        const a = must(this.expr(parts[0])) as any;
        const b = must(this.expr(parts[1])) as any;
        switch (op) {
          case "==": return a == b;
          case "!=": return a != b;
          case ">=": return a >= b;
          case "<=": return a <= b;
          case ">": return a > b;
          case "<": return a < b;
          default: return Array.isArray(b) ? b.includes(a) : typeof b === "string" ? b.includes(String(a)) : !!b && typeof b === "object" && a in b;
        }
      }
    }
    const [base, ...filters] = splitTopLevel(e, "|");
    let v = this.primary(base);
    for (const f of filters) v = this.filter(v, f);
    return v;
  }

  private primary(src: string): unknown {
    const s = src.trim();
    if (/^\(.*\)$/s.test(s)) return this.expr(s.slice(1, -1));
    if (/^'.*'$|^".*"$/s.test(s)) return s.slice(1, -1);
    if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
    if (/^(true|True)$/.test(s)) return true;
    if (/^(false|False)$/.test(s)) return false;
    if (/^(none|None)$/.test(s)) return null;
    if (/^\[.*\]$/s.test(s)) return splitTopLevel(s.slice(1, -1), ",").filter(Boolean).map((x) => must(this.expr(x)));
    const path = /^([A-Za-z_]\w*)((?:\.\w+|\[[^\]]+\])*)$/.exec(s);
    if (!path) throw new AnsibleError(`template error while templating string: unexpected '${s}'.`);
    let v = this.lookup(path[1]);
    const parts = [...path[2].matchAll(/\.(\w+)|\[([^\]]+)\]/g)];
    let name = path[1];
    for (const p of parts) {
      if (isUndef(v)) return v;
      const key = p[1] ?? must(this.expr(p[2]));
      name += p[1] ? `.${p[1]}` : `[${p[2]}]`;
      v = v != null && typeof v === "object" && String(key) in (v as object) ? (v as any)[key as any] : undef(name);
    }
    return v;
  }

  private filter(v: unknown, src: string): unknown {
    const m = /^(\w+)\s*(?:\((.*)\))?$/s.exec(src.trim());
    if (!m) throw new AnsibleError(`template error while templating string: expected token 'end of print statement', got '${src}'.`);
    const args = m[2] ? splitTopLevel(m[2], ",").filter(Boolean).map((a) => must(this.expr(a))) : [];
    const name = m[1];
    if (name === "default" || name === "d") return isUndef(v) || (args[1] && !truthy(v)) ? args[0] ?? "" : v;
    const x = must(v) as any;
    switch (name) {
      case "upper": return String(x).toUpperCase();
      case "lower": return String(x).toLowerCase();
      case "trim": return String(x).trim();
      case "int": return parseInt(String(x), 10) || 0;
      case "string": return String(x);
      case "bool": return truthy(x);
      case "length":
      case "count": return x == null ? 0 : typeof x === "object" ? Object.keys(x).length : String(x).length;
      case "join": return Array.isArray(x) ? x.join(args[0] === undefined ? "" : String(args[0])) : String(x);
      case "first": return Array.isArray(x) ? x[0] : String(x)[0];
      case "last": return Array.isArray(x) ? x[x.length - 1] : String(x).slice(-1);
      case "replace": return String(x).split(String(args[0])).join(String(args[1] ?? ""));
      case "to_json": return JSON.stringify(x);
      case "to_nice_yaml": return YAML.stringify(x);
      case "mandatory":
        if (isUndef(v)) throw new UndefinedVar(v[UNDEF]);
        return x;
      default: throw new AnsibleError(`template error while templating string: No filter named '${name}'.`);
    }
  }
}

// ------------------------------------------------------------------ remote hosts

const NGINX_VERSION = "1.24.0-2ubuntu7.1";
const DEFAULT_NGINX_CONF = `user www-data;
worker_processes auto;
pid /run/nginx.pid;

events {
	worker_connections 768;
}

http {
	sendfile on;
	include /etc/nginx/sites-enabled/*;
}
`;

const filesOf = (host: Host) => (host.files ??= {});

function installPackage(host: Host, name: string) {
  host.packages[name] = name === "nginx" ? NGINX_VERSION : "1.0.0-1";
  if (name === "nginx") {
    host.services.nginx = { active: true, enabled: true, logs: ["systemd[1]: Started nginx.service - A high performance web server and a reverse proxy server."] };
    filesOf(host)["/etc/nginx/nginx.conf"] = DEFAULT_NGINX_CONF;
    filesOf(host)["/var/www/html/index.nginx-debian.html"] = "<h1>Welcome to nginx!</h1>\n";
  }
}

/** Tiny command runner for the command/shell modules on a managed node. */
function remoteCommand(host: Host, line: string, shell: boolean): { stdout: string; stderr: string; rc: number } {
  const [cmd, ...args] = tokenize(line);
  const files = filesOf(host);
  const ok = (stdout: string) => ({ stdout, stderr: "", rc: 0 });
  switch (cmd) {
    case "cat": {
      const missing = args.find((f) => files[f] === undefined);
      if (missing) return { stdout: "", stderr: `cat: ${missing}: No such file or directory`, rc: 1 };
      return ok(args.map((f) => files[f]).join("").replace(/\n$/, ""));
    }
    case "grep": {
      const flags = args.filter((a) => /^-[a-zA-Z]+$/.test(a)).join("");
      const [pattern, ...targets] = args.filter((a) => !/^-[a-zA-Z]+$/.test(a));
      const missing = targets.find((f) => files[f] === undefined);
      if (missing) return { stdout: "", stderr: `grep: ${missing}: No such file or directory`, rc: 2 };
      const re = new RegExp(pattern ?? "", flags.includes("i") ? "i" : "");
      const hits = targets.flatMap((f) => files[f].split("\n").filter((l) => re.test(l) !== flags.includes("v")).map((l) => (targets.length > 1 ? `${f}:${l}` : l)));
      return hits.length ? ok(hits.join("\n")) : { stdout: "", stderr: "", rc: 1 };
    }
    case "hostname":
      return ok(host.name);
    case "whoami":
      return ok("root");
    case "uptime":
      return ok(" 12:00:01 up 12 days,  3:04,  0 users,  load average: 0.08, 0.03, 0.01");
    case "echo":
      return ok(args.join(" "));
    case "ls": {
      const dir = (args.find((a) => !a.startsWith("-")) ?? "/root").replace(/\/$/, "");
      const names = [...new Set(Object.keys(files).filter((f) => f.startsWith(`${dir}/`)).map((f) => f.slice(dir.length + 1).split("/")[0]))].sort();
      return names.length ? ok(names.join("\n")) : { stdout: "", stderr: `ls: cannot access '${dir}': No such file or directory`, rc: 2 };
    }
    case "systemctl": {
      const [action, unit] = args.filter((a) => !a.startsWith("-"));
      const svc = host.services[(unit ?? "").replace(/\.service$/, "")];
      if (action === "is-active") return svc?.active ? ok("active") : { stdout: "inactive", stderr: "", rc: 3 };
      if (action === "is-enabled") return svc?.enabled ? ok("enabled") : { stdout: "disabled", stderr: "", rc: 1 };
      return { stdout: "", stderr: `systemctl ${action}: use o módulo service/systemd no Ansible`, rc: 1 };
    }
    case "nginx":
      if (!host.packages.nginx) break;
      if (args.includes("-v")) return { stdout: "", stderr: "nginx version: nginx/1.24.0 (Ubuntu)", rc: 0 };
      if (args.includes("-t")) return { stdout: "", stderr: "nginx: the configuration file /etc/nginx/nginx.conf syntax is ok\nnginx: configuration file /etc/nginx/nginx.conf test is successful", rc: 0 };
      break;
  }
  return shell ? { stdout: "", stderr: `/bin/sh: 1: ${cmd}: not found`, rc: 127 } : { stdout: "", stderr: `[Errno 2] No such file or directory: b'${cmd}'`, rc: 2 };
}

// ------------------------------------------------------------------ diff

function unifiedDiff(before: string | undefined, after: string, beforeLabel: string, afterLabel: string) {
  const a = before === undefined ? [] : before.replace(/\n$/, "").split("\n");
  const b = after.replace(/\n$/, "").split("\n");
  const lcs = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const lines: string[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      lines.push(` ${a[i++]}`);
      j++;
    } else if (j < b.length && (i >= a.length || lcs[i][j + 1] >= lcs[i + 1][j])) lines.push(`+${b[j++]}`);
    else lines.push(`-${a[i++]}`);
  }
  return [`--- ${beforeLabel}`, `+++ ${afterLabel}`, `@@ -${a.length ? 1 : 0},${a.length} +1,${b.length} @@`, ...lines, ""].join("\n");
}

// ------------------------------------------------------------------ modules

type ModuleResult = { changed?: boolean; failed?: boolean; skipped?: boolean; msg?: string; diff?: string; stdout?: string; stderr?: string; rc?: number; data?: Vars; facts?: Vars };
type ModuleCtx = { sh: Shell; host: Host; check: boolean; become: boolean; searchDirs: string[]; hostVars: Vars };

const MODULE_ALIASES: Record<string, string> = { package: "apt", systemd: "service", systemd_service: "service", yum: "apt", dnf: "apt" };
const MODULES = ["ping", "apt", "template", "copy", "file", "service", "command", "shell", "debug", "assert", "set_fact", "setup", "meta", "fail"];
const moduleName = (key: string) => {
  const short = key.replace(/^ansible\.(builtin|legacy)\./, "");
  return MODULE_ALIASES[short] ?? short;
};

const privileged = (path: string) => /^\/(etc|var|usr|opt|root)\//.test(path);

function findFile(sh: Shell, name: string, dirs: string[]) {
  const candidates = name.startsWith("/") ? [name] : dirs.map((d) => `${d}/${name}`);
  const found = candidates.find((p) => sh.readFile(p) !== undefined);
  return { found, candidates };
}

function runModule(module: string, args: Vars, ctx: ModuleCtx): ModuleResult {
  const { sh, host, check } = ctx;
  const files = filesOf(host);
  switch (module) {
    case "ping":
    case "setup":
      return { changed: false, data: module === "ping" ? { ping: "pong" } : { ansible_facts: { ansible_hostname: host.name, ansible_default_ipv4: { address: host.ip }, ansible_distribution: "Ubuntu", ansible_distribution_version: "24.04", ansible_os_family: "Debian" } } };
    case "apt": {
      const names = toList(args.name ?? args.pkg ?? args._raw_params);
      const state = String(args.state ?? "present");
      if (!names.length && !args.update_cache) return { failed: true, msg: "missing required arguments: name" };
      const todo = state === "absent" ? names.filter((n) => host.packages[n]) : names.filter((n) => !host.packages[n]);
      if (!todo.length) return { changed: false };
      if (!ctx.become) return { failed: true, msg: "Failed to lock apt for exclusive operation: Failed to lock directory /var/lib/apt/lists/: E:Could not open lock file /var/lib/apt/lists/lock - open (13: Permission denied)" };
      if (!check)
        for (const n of todo) {
          if (state === "absent") {
            delete host.packages[n];
            delete host.services[n];
          } else installPackage(host, n);
        }
      return { changed: true, stdout: todo.map((n) => `Setting up ${n} ...`).join("\n") };
    }
    case "template":
    case "copy": {
      const dest = args.dest ? String(args.dest) : "";
      if (!dest) return { failed: true, msg: "missing required arguments: dest" };
      let content: string;
      let label: string;
      if (module === "copy" && args.content !== undefined) {
        content = String(args.content);
        label = "dynamically generated";
      } else {
        const src = args.src ? String(args.src) : "";
        if (!src) return { failed: true, msg: "missing required arguments: src" };
        const { found, candidates } = findFile(sh, src, ctx.searchDirs.map((d) => `${d}/${module === "template" ? "templates" : "files"}`).concat(ctx.searchDirs));
        if (!found) return { failed: true, msg: `Could not find or access '${src}'\nSearched in:\n\t${candidates.join("\n\t")} on the Ansible Controller.` };
        const raw = sh.readFile(found)!;
        try {
          content = module === "template" ? new Renderer({ ...ctx.hostVars }).render(raw) : raw;
        } catch (e) {
          if (e instanceof UndefinedVar) return { failed: true, msg: `AnsibleUndefinedVariable: ${e.message}. ${e.message}` };
          return { failed: true, msg: `AnsibleError: ${(e as Error).message.replace(/^ERROR! /, "")}` };
        }
        label = sh.resolve(found);
      }
      const before = files[dest];
      if (before === content) return { changed: false };
      if (privileged(dest) && !ctx.become) return { failed: true, msg: `Destination ${dirOf(dest)} not writable` };
      if (!check) files[dest] = content;
      return { changed: true, diff: unifiedDiff(before, content, before === undefined ? "before" : `before: ${dest}`, `after: ${label}`) };
    }
    case "file": {
      const path = String(args.path ?? args.dest ?? "");
      const state = String(args.state ?? "file");
      if (!path) return { failed: true, msg: "missing required arguments: path" };
      const dirs = sh.ext<Record<string, Set<string>>>("ansible-dirs", () => ({}));
      const hostDirs = (dirs[host.name] ??= new Set());
      const exists = path in files || hostDirs.has(path) || Object.keys(files).some((f) => f.startsWith(`${path}/`));
      if (state === "absent") {
        if (!exists) return { changed: false };
        if (!check) {
          for (const f of Object.keys(files)) if (f === path || f.startsWith(`${path}/`)) delete files[f];
          hostDirs.delete(path);
        }
        return { changed: true };
      }
      if (state === "directory" || state === "touch") {
        if (exists && state === "directory") return { changed: false };
        if (privileged(path) && !ctx.become) return { failed: true, msg: `There was an issue creating ${path} as requested: [Errno 13] Permission denied: b'${path}'` };
        if (!check && state === "directory") hostDirs.add(path);
        else if (!check) files[path] ??= "";
        return { changed: true };
      }
      return exists ? { changed: false } : { failed: true, msg: `file (${path}) is absent, cannot continue` };
    }
    case "service": {
      const name = String(args.name ?? "").replace(/\.service$/, "");
      if (!name) return { failed: true, msg: "missing required arguments: name" };
      const svc = host.services[name];
      if (!svc) return check ? { changed: true } : { failed: true, msg: `Could not find the requested service ${name}: host` };
      const state = args.state ? String(args.state) : undefined;
      const wantEnabled = args.enabled === undefined ? undefined : truthy(args.enabled);
      const changed = state === "restarted" || state === "reloaded" || (state === "started" && !svc.active) || (state === "stopped" && svc.active) || (wantEnabled !== undefined && wantEnabled !== svc.enabled);
      if (!changed) return { changed: false };
      if (!ctx.become) return { failed: true, msg: `Unable to ${state === "stopped" ? "stop" : "start"} service ${name}: Failed to ${state === "restarted" ? "restart" : "start"} ${name}.service: Access denied` };
      if (!check) {
        if (state === "restarted" || state === "reloaded") {
          const st = ansibleState(sh);
          st.restarts[host.name] = (st.restarts[host.name] ?? 0) + 1;
          svc.logs.push(`systemd[1]: ${state === "reloaded" ? "Reloaded" : "Restarted"} ${name}.service.`);
        }
        if (state === "started" || state === "restarted" || state === "reloaded") svc.active = true;
        if (state === "stopped") svc.active = false;
        if (wantEnabled !== undefined) svc.enabled = wantEnabled;
      }
      return { changed: true };
    }
    case "command":
    case "shell": {
      const cmd = String(args.cmd ?? args._raw_params ?? "");
      if (!cmd) return { failed: true, msg: "no command given" };
      if (check) return { skipped: true, msg: "Command would have run if not in check mode" };
      const r = remoteCommand(host, cmd, module === "shell");
      if (r.stderr.startsWith("[Errno")) return { failed: true, msg: r.stderr, rc: r.rc };
      return { changed: true, stdout: r.stdout, stderr: r.stderr, rc: r.rc, failed: r.rc !== 0, msg: r.rc !== 0 ? "non-zero return code" : undefined };
    }
    case "debug":
      return { changed: false };
    case "set_fact":
      return { changed: false, facts: Object.fromEntries(Object.entries(args).filter(([k]) => k !== "cacheable")) };
    case "fail":
      return { failed: true, msg: String(args.msg ?? "Failed as requested from task") };
    default:
      return { failed: true, msg: `couldn't resolve module/action '${module}'` };
  }
}

// ------------------------------------------------------------------ playbook model

const TASK_KEYS = new Set(["name", "when", "notify", "tags", "loop", "with_items", "register", "changed_when", "failed_when", "ignore_errors", "no_log", "become", "become_user", "vars", "listen", "delegate_to", "run_once", "check_mode", "diff", "loop_control", "environment", "args", "retries", "delay", "until", "timeout"]);

type Task = { raw: Vars; name: string; module: string; args: any; role?: string; tags: string[]; file: string };
type Play = { name: string; hosts: string; become: boolean; gather: boolean; serial?: number | string; vars: Vars; defaults: Vars; searchDirs: string[]; tasks: Task[]; handlers: Task[] };

function toTask(raw: any, file: string, role?: string, inheritedTags: string[] = []): Task {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new AnsibleError(`ERROR! A malformed block was encountered while loading tasks: ${pyJson(raw)} should be a list or None\n\nThe error appears to be in '${file}'`);
  const actions = Object.keys(raw).filter((k) => !TASK_KEYS.has(k));
  if (!actions.length) throw new AnsibleError(`ERROR! no module/action detected in task.\n\nThe error appears to be in '${file}'`);
  if (actions.length > 1) throw new AnsibleError(`ERROR! conflicting action statements: ${actions.join(", ")}\n\nThe error appears to be in '${file}'`);
  const module = moduleName(actions[0]);
  if (!MODULES.includes(module)) throw new AnsibleError(`ERROR! couldn't resolve module/action '${actions[0]}'. This often indicates a misspelling, missing collection, or incorrect module path.\n\nThe error appears to be in '${file}'`);
  const argsRaw = raw[actions[0]];
  const args = typeof argsRaw === "string" ? (module === "command" || module === "shell" ? { _raw_params: argsRaw } : kvArgs(argsRaw)) : argsRaw ?? {};
  const name = raw.name ? String(raw.name) : actions[0];
  return { raw, name, module, args, role, tags: [...inheritedTags, ...toList(raw.tags)], file };
}

function loadRole(sh: Shell, spec: any, playDir: string, rolesPath: string[], pass: string | undefined) {
  const name = typeof spec === "string" ? spec : String(spec?.role ?? spec?.name ?? "");
  const dir = rolesPath.map((p) => `${p}/${name}`).find((d) => sh.isDir(d));
  if (!dir) throw new AnsibleError(`ERROR! the role '${name}' was not found in ${rolesPath.join(":")}:${playDir}\n\nThe error appears to be in '${playDir}': the role could not be found.`);
  const tags = typeof spec === "object" ? toList(spec?.tags) : [];
  const list = (sub: string) => {
    const f = `${dir}/${sub}/main.yml`;
    const data = loadYamlFile(sh, f, pass) ?? loadYamlFile(sh, `${dir}/${sub}/main.yaml`, pass);
    return { data, file: sh.resolve(f) };
  };
  const tasks = list("tasks");
  const handlers = list("handlers");
  return {
    name,
    dir: sh.resolve(dir),
    defaults: (list("defaults").data ?? {}) as Vars,
    vars: { ...((list("vars").data ?? {}) as Vars), ...(typeof spec === "object" ? spec?.vars ?? {} : {}) },
    tasks: ((tasks.data ?? []) as any[]).map((t) => toTask(t, tasks.file, name, tags)),
    handlers: ((handlers.data ?? []) as any[]).map((t) => toTask(t, handlers.file, name, tags)),
  };
}

function loadPlaybook(sh: Shell, file: string, pass: string | undefined, rolesPathCfg: string | undefined): Play[] {
  const abs = sh.resolve(file);
  const text = sh.readFile(file);
  if (text === undefined) throw new AnsibleError(`ERROR! the playbook: ${file} could not be found`);
  const data = parseYaml(text, abs);
  if (!Array.isArray(data)) throw new AnsibleError(`ERROR! A playbook must be a list of plays, got a ${data === null ? "NoneType" : typeof data === "object" ? "AnsibleMapping" : typeof data} instead\n\nThe error appears to be in '${abs}'`);
  const playDir = dirOf(abs);
  const rolesPath = [...toList(rolesPathCfg).map((p) => sh.resolve(p)), `${playDir}/roles`];
  return data.map((p: any) => {
    if (!p || typeof p !== "object") throw new AnsibleError(`ERROR! playbook entries must be either valid plays or 'import_playbook' statements\n\nThe error appears to be in '${abs}'`);
    if (!p.hosts) throw new AnsibleError(`ERROR! the field 'hosts' is required but was not set\n\nThe error appears to be in '${abs}'`);
    const roles = ((p.roles ?? []) as any[]).map((r) => loadRole(sh, r, playDir, rolesPath, pass));
    const own = (key: string) => ((p[key] ?? []) as any[]).map((t) => toTask(t, abs));
    return {
      name: String(p.name ?? p.hosts),
      hosts: Array.isArray(p.hosts) ? p.hosts.join(",") : String(p.hosts),
      become: truthy(p.become ?? false),
      gather: p.gather_facts === undefined ? true : truthy(p.gather_facts),
      serial: p.serial,
      vars: { ...(p.vars ?? {}), ...Object.assign({}, ...roles.map((r) => r.vars)) },
      defaults: Object.assign({}, ...roles.map((r) => r.defaults)),
      searchDirs: [...roles.map((r) => r.dir), playDir],
      tasks: [...own("pre_tasks"), ...roles.flatMap((r) => r.tasks), ...own("tasks"), ...own("post_tasks")],
      handlers: [...roles.flatMap((r) => r.handlers), ...own("handlers")],
    } satisfies Play;
  });
}

/** group_vars / host_vars next to the inventory and the playbook (file, .yml, .yaml or a directory of files). */
function dirVars(sh: Shell, bases: string[], kind: "group_vars" | "host_vars", name: string, pass: string | undefined): Vars {
  const out: Vars = {};
  for (const base of bases) {
    const root = `${base}/${kind}/${name}`;
    const candidates = sh.isDir(root) && sh.readFile(root) === undefined ? sh.listDir(root).filter((f) => !f.endsWith("/") && /\.(ya?ml|json)$|^[^.]+$/.test(f)).map((f) => `${root}/${f}`) : [root, `${root}.yml`, `${root}.yaml`];
    for (const f of candidates) Object.assign(out, loadYamlFile(sh, f, pass) ?? {});
  }
  return out;
}

function hostVars(sh: Shell, inv: Inventory, host: string, bases: string[], pass: string | undefined, play: { vars: Vars; defaults: Vars }, extra: Vars, check: boolean): Vars {
  const groups = groupNames(inv, host);
  const ordered = ["all", ...groups.filter((g) => g !== "ungrouped")];
  const h = sh.state.hosts[host];
  return {
    ansible_host: inv.hosts[host].ansible_host ?? host,
    ansible_managed: MANAGED,
    ansible_check_mode: check,
    ...play.defaults,
    ...Object.assign({}, ...ordered.map((g) => inv.groups[g]?.vars ?? {})),
    ...Object.assign({}, ...ordered.map((g) => dirVars(sh, bases, "group_vars", g, pass))),
    ...inv.hosts[host],
    ...dirVars(sh, bases, "host_vars", host, pass),
    ansible_hostname: host,
    ansible_distribution: "Ubuntu",
    ansible_os_family: "Debian",
    ansible_default_ipv4: { address: h?.ip ?? inv.hosts[host].ansible_host },
    ...play.vars,
    ...extra,
    inventory_hostname: host,
    group_names: groups.filter((g) => g !== "ungrouped"),
    groups: Object.fromEntries(Object.keys(inv.groups).map((g) => [g, members(inv, g)])),
  };
}

function extraVars(sh: Shell, args: string[]): Vars {
  const out: Vars = {};
  for (const e of multi(args, ["-e", "--extra-vars"])) {
    if (e.startsWith("@")) Object.assign(out, loadYamlFile(sh, e.slice(1), undefined) ?? {});
    else if (e.trim().startsWith("{")) Object.assign(out, JSON.parse(e));
    else Object.assign(out, kvArgs(e));
  }
  return out;
}

function reachable(sh: Shell, inv: Inventory, host: string) {
  const target = String(inv.hosts[host]?.ansible_host ?? host);
  return Object.values(sh.state.hosts).find((h) => h.name === host || h.ip === target || h.name === target);
}

const unreachableMsg = (inv: Inventory, host: string) => {
  const target = String(inv.hosts[host]?.ansible_host ?? host);
  return `Failed to connect to the host via ssh: ssh: connect to host ${target} port 22: ${/^\d/.test(target) ? "No route to host" : `Could not resolve hostname ${target}: Name or service not known`}`;
};

// ------------------------------------------------------------------ ansible-playbook

type HostRun = { vars: Vars; failed: boolean; unreachable: boolean; notified: Set<string>; stats: { ok: number; changed: number; failed: number; skipped: number; ignored: number; unreachable: number } };

function taskSelected(task: Task, only: string[], skip: string[]) {
  const tags = task.tags;
  if (skip.length && tags.some((t) => skip.includes(t))) return false;
  if (tags.includes("always")) return true;
  if (!only.length || only.includes("all")) return !tags.includes("never");
  if (only.includes("tagged")) return tags.length > 0;
  if (only.includes("untagged")) return tags.length === 0;
  return tags.some((t) => only.includes(t));
}

function playbook(sh: Shell, args: string[], pos: string[], env: Record<string, string>): { output: string; ok: boolean } {
  if (has(args, "--version")) return { output: `ansible-playbook [core 2.17.5]\n  config file = ${sh.readFile("ansible.cfg") !== undefined ? sh.resolve("ansible.cfg") : "None"}\n  python version = 3.12.3`, ok: true };
  const files = pos;
  if (!files.length) return { output: "usage: ansible-playbook [-h] [--version] [-v] [-k] ... playbook [playbook ...]\nansible-playbook: error: the following arguments are required: playbook", ok: false };
  const check = has(args, "--check", "-C");
  const showDiff = has(args, "--diff", "-D");
  const limit = multi(args, ["-l", "--limit"]).join(",") || undefined;
  const only = multi(args, ["-t", "--tags"]).flatMap(toList);
  const skip = multi(args, ["--skip-tags"]).flatMap(toList);
  const cfg = readConfig(sh);
  const state = ansibleState(sh);
  const out: string[] = [];
  const run: AnsibleRun = { check, limit, tags: only, hosts: [], completed: false, failed: false, changed: {} };
  const stats = new Map<string, HostRun>();
  const finish = (ok: boolean) => {
    state.runs.push(run);
    return { output: out.join("\n").replace(/\n{3,}/g, "\n\n").trim(), ok };
  };
  try {
    const pass = vaultPassword(sh, args, env);
    const invPath = inventoryPath(sh, args);
    const inv = parseInventory(sh, invPath);
    if (sh.readFile(invPath) === undefined) out.push(`[WARNING]: Unable to parse ${sh.resolve(invPath)} as an inventory source`, "[WARNING]: No inventory was parsed, only implicit localhost is available");
    const extra = extraVars(sh, args);
    const plays = files.flatMap((f) => loadPlaybook(sh, f, pass, cfg.roles_path));
    if (has(args, "--syntax-check")) {
      run.completed = true;
      out.push("", `playbook: ${files.join(" ")}`);
      return finish(true);
    }
    const limitSet = limit ? matchHosts(inv, limit) : undefined;
    if (limitSet?.unmatched.length) out.push(`[WARNING]: Could not match supplied host pattern, ignoring: ${limitSet.unmatched.join(", ")}`);
    if (limitSet && !limitSet.hosts.length) throw new AnsibleError("ERROR! Specified inventory, host pattern and/or --limit leaves us with no hosts to target.");
    const bases = [...new Set([dirOf(inv.path), ...files.map((f) => dirOf(sh.resolve(f)))])];

    for (const play of plays) {
      let targets = matchHosts(inv, play.hosts).hosts;
      if (limitSet) targets = targets.filter((h) => limitSet.hosts.includes(h));
      const serial = typeof play.serial === "string" && play.serial.endsWith("%") ? Math.max(1, Math.floor((targets.length * parseInt(play.serial, 10)) / 100)) : play.serial !== undefined ? Number(play.serial) : undefined;
      if (run.serial === undefined && serial !== undefined) run.serial = serial;
      run.hosts = [...new Set([...run.hosts, ...targets])];
      if (!targets.length) {
        out.push("", banner(`PLAY [${play.name}]`), "skipping: no hosts matched");
        continue;
      }
      const batches: string[][] = [];
      const size = serial && serial > 0 ? serial : targets.length;
      for (let i = 0; i < targets.length; i += size) batches.push(targets.slice(i, i + size));
      for (const batch of batches) {
        out.push("", banner(`PLAY [${play.name}]`));
        for (const h of batch) {
          const vars = hostVars(sh, inv, h, bases, pass, play, extra, check);
          const prev = stats.get(h);
          stats.set(h, { vars, failed: false, unreachable: false, notified: new Set(), stats: prev?.stats ?? { ok: 0, changed: 0, failed: 0, skipped: 0, ignored: 0, unreachable: 0 } });
        }
        const active = () => batch.filter((h) => !stats.get(h)!.failed && !stats.get(h)!.unreachable);
        if (play.gather) {
          out.push("", banner("TASK [Gathering Facts]"));
          for (const h of batch) {
            const hr = stats.get(h)!;
            if (!reachable(sh, inv, h)) {
              hr.unreachable = true;
              hr.stats.unreachable++;
              out.push(`fatal: [${h}]: UNREACHABLE! => ${pyJson({ changed: false, msg: unreachableMsg(inv, h), unreachable: true })}`);
            } else {
              hr.stats.ok++;
              out.push(`ok: [${h}]`);
            }
          }
        }
        const runTask = (task: Task, hosts: string[], handler: boolean) => {
          const label = `${task.role ? `${task.role} : ` : ""}${task.name}`;
          // Role tasks look in their role (templates/, files/) and then next to the playbook.
          const playDir = play.searchDirs[play.searchDirs.length - 1];
          const roleDir = task.role ? play.searchDirs.find((d) => d.endsWith(`/${task.role}`)) : undefined;
          const searchDirs = roleDir ? [roleDir, playDir] : [playDir];
          out.push("", banner(`${handler ? "RUNNING HANDLER" : "TASK"} [${label}]`));
          for (const h of hosts) {
            const hr = stats.get(h)!;
            const host = reachable(sh, inv, h);
            if (!host) {
              hr.unreachable = true;
              hr.stats.unreachable++;
              out.push(`fatal: [${h}]: UNREACHABLE! => ${pyJson({ changed: false, msg: unreachableMsg(inv, h), unreachable: true })}`);
              continue;
            }
            const renderer = new Renderer({ ...hr.vars, ...(task.raw.vars ?? {}) });
            const noLog = truthy(task.raw.no_log ?? false);
            const fail = (msg: string) => {
              hr.failed = !truthy(task.raw.ignore_errors ?? false);
              hr.stats[hr.failed ? "failed" : "ignored"]++;
              out.push(`fatal: [${h}]: FAILED! => ${pyJson({ changed: false, msg: noLog ? "the output has been hidden due to the fact that 'no_log: true' was specified for this result" : msg })}`);
              if (!hr.failed) out.push("...ignoring");
            };
            try {
              const when = task.raw.when;
              if (when !== undefined && !(Array.isArray(when) ? when : [when]).every((c) => truthy(must(renderer.expr(String(c).replace(/^\{\{|\}\}$/g, "")))))) {
                hr.stats.skipped++;
                out.push(`skipping: [${h}]`);
                continue;
              }
              const loopRaw = task.raw.loop ?? task.raw.with_items;
              const items = loopRaw === undefined ? [undefined] : (renderer.resolveValue(loopRaw) as unknown[]);
              if (!Array.isArray(items)) throw new AnsibleError(`Invalid data passed to 'loop', it requires a list, got this instead: ${pyJson(items)}.`);
              let anyChanged = false;
              let anyFailed = false;
              const results: ModuleResult[] = [];
              for (const item of items) {
                const r = new Renderer({ ...hr.vars, ...(task.raw.vars ?? {}), ...(item === undefined ? {} : { item }) });
                const become = truthy(task.raw.become ?? play.become);
                const margs = r.resolveValue(task.args) as Vars;
                let result: ModuleResult;
                if (task.module === "debug") {
                  const payload = margs.var !== undefined ? { [String(margs.var)]: must(r.expr(String(margs.var))) } : { msg: margs.msg ?? "Hello world!" };
                  out.push(`ok: [${h}]${item === undefined ? "" : ` => (item=${item})`} => ${JSON.stringify(payload, null, 4)}`);
                  hr.stats.ok++;
                  continue;
                }
                if (task.module === "assert") {
                  const conds = Array.isArray(margs.that) ? margs.that : [margs.that];
                  const bad = conds.find((c: unknown) => !truthy(must(r.expr(String(c)))));
                  result = bad === undefined ? { changed: false, msg: String(margs.success_msg ?? "All assertions passed") } : { failed: true, msg: String(margs.fail_msg ?? margs.msg ?? "Assertion failed") };
                } else result = runModule(task.module, margs, { sh, host, check, become, searchDirs, hostVars: { ...hr.vars, ...(item === undefined ? {} : { item }) } });
                if (task.raw.changed_when !== undefined) result.changed = truthy(typeof task.raw.changed_when === "string" ? must(r.expr(task.raw.changed_when)) : task.raw.changed_when);
                if (task.raw.failed_when !== undefined) result.failed = truthy(typeof task.raw.failed_when === "string" ? must(new Renderer({ ...hr.vars, [task.raw.register ?? "result"]: result }).expr(task.raw.failed_when)) : task.raw.failed_when);
                if (result.facts) Object.assign(hr.vars, r.resolveValue(result.facts));
                results.push(result);
                if (result.diff && showDiff && !noLog) out.push(result.diff);
                const suffix = item === undefined ? "" : ` => (item=${typeof item === "object" ? pyJson(item) : item})`;
                if (result.skipped) out.push(`skipping: [${h}]${suffix}`);
                else if (result.failed) {
                  anyFailed = true;
                  const body = { changed: !!result.changed, msg: noLog ? "the output has been hidden due to the fact that 'no_log: true' was specified for this result" : result.msg, ...(result.rc !== undefined && !noLog ? { rc: result.rc, stdout: result.stdout ?? "", stderr: result.stderr ?? "" } : {}) };
                  out.push(`fatal: [${h}]: FAILED! => ${pyJson(body)}`);
                } else {
                  if (result.changed) anyChanged = true;
                  out.push(`${result.changed ? "changed" : "ok"}: [${h}]${suffix}`);
                }
              }
              if (task.module === "debug") continue;
              if (task.raw.register) hr.vars[task.raw.register] = results.length === 1 ? { ...results[0], changed: !!results[0].changed, failed: !!results[0].failed } : { results, changed: anyChanged };
              if (anyFailed) {
                hr.failed = !truthy(task.raw.ignore_errors ?? false);
                hr.stats[hr.failed ? "failed" : "ignored"]++;
                if (!hr.failed) out.push("...ignoring");
                continue;
              }
              if (results.length && results.every((x) => x.skipped)) {
                hr.stats.skipped++;
                continue;
              }
              if (anyChanged) {
                hr.stats.changed++;
                hr.stats.ok++;
                for (const n of toList(task.raw.notify)) {
                  const target = play.handlers.find((x) => x.name === n || toList(x.raw.listen).includes(n) || (x.role && `${x.role} : ${x.name}` === n));
                  if (!target) throw new AnsibleError(`ERROR! The requested handler '${n}' was not found in either the main handlers list nor in the listening handlers list`);
                  hr.notified.add(n);
                }
              } else hr.stats.ok++;
            } catch (e) {
              if (e instanceof UndefinedVar) fail(`The task includes an option with an undefined variable. The error was: ${e.message}. ${e.message}`);
              else if (e instanceof AnsibleError && !e.message.startsWith("ERROR!")) fail(e.message);
              else throw e;
            }
          }
        };
        const flush = () => {
          for (const hd of play.handlers) {
            const hosts = active().filter((h) => {
              const n = stats.get(h)!.notified;
              return n.has(hd.name) || toList(hd.raw.listen).some((l) => n.has(l)) || (hd.role !== undefined && n.has(`${hd.role} : ${hd.name}`));
            });
            if (!hosts.length) continue;
            for (const h of hosts) {
              const n = stats.get(h)!.notified;
              n.delete(hd.name);
              for (const l of toList(hd.raw.listen)) n.delete(l);
            }
            runTask(hd, hosts, true);
          }
        };
        for (const task of play.tasks) {
          if (!active().length) break;
          if (task.module === "meta") {
            if (String(task.args._raw_params ?? "") === "flush_handlers") flush();
            continue;
          }
          if (!taskSelected(task, only, skip)) continue;
          runTask(task, active(), false);
        }
        if (active().length) flush();
        if (!active().length) {
          out.push("", "NO MORE HOSTS LEFT *************************************************************");
          break;
        }
      }
    }
    run.completed = true;
  } catch (e) {
    if (!(e instanceof AnsibleError)) throw e;
    run.error = e.message;
    out.push(e.message);
    for (const [h, hr] of stats) run.changed[h] = hr.stats.changed;
    run.failed = true;
    return finish(false);
  }
  out.push("", banner("PLAY RECAP"));
  for (const [h, hr] of stats) {
    const s = hr.stats;
    run.changed[h] = s.changed;
    if (s.failed || s.unreachable) run.failed = true;
    out.push(`${h.padEnd(26)} : ok=${String(s.ok).padEnd(4)} changed=${String(s.changed).padEnd(4)} unreachable=${String(s.unreachable).padEnd(4)} failed=${String(s.failed).padEnd(4)} skipped=${String(s.skipped).padEnd(4)} rescued=0    ignored=${s.ignored}`);
  }
  return finish(!run.failed);
}

// ------------------------------------------------------------------ ad-hoc

function adhoc(sh: Shell, args: string[], pos: string[], env: Record<string, string>): { output: string; ok: boolean } {
  if (has(args, "--version")) return { output: `${VERSION}\n  config file = ${sh.readFile("ansible.cfg") !== undefined ? sh.resolve("ansible.cfg") : "None"}\n  python version = 3.12.3\n  jinja version = 3.1.4`, ok: true };
  const pattern = pos[0];
  if (!pattern) return { output: "usage: ansible [-h] [--version] [-v] [-b] [-i INVENTORY] [-m MODULE_NAME] [-a MODULE_ARGS] pattern\nansible: error: the following arguments are required: pattern", ok: false };
  const state = ansibleState(sh);
  try {
    const inv = parseInventory(sh, inventoryPath(sh, args));
    const { hosts, unmatched } = matchHosts(inv, pattern);
    const warn = unmatched.length ? `[WARNING]: Could not match supplied host pattern, ignoring: ${unmatched.join(", ")}\n` : "";
    if (!hosts.length) return { output: `${warn}[WARNING]: No hosts matched, nothing to do`, ok: true };
    if (has(args, "--list-hosts")) return { output: `  hosts (${hosts.length}):\n${hosts.map((h) => `    ${h}`).join("\n")}`, ok: true };
    const moduleKey = multi(args, ["-m", "--module-name"])[0] ?? "command";
    const module = moduleName(moduleKey);
    const argText = multi(args, ["-a", "--args"])[0] ?? "";
    if (!MODULES.includes(module) || module === "meta") return { output: `${warn}ERROR! couldn't resolve module/action '${moduleKey}'. This often indicates a misspelling, missing collection, or incorrect module path.`, ok: false };
    if ((module === "command" || module === "shell") && !argText) return { output: "ERROR! No argument passed to command module", ok: false };
    const check = has(args, "--check", "-C");
    const become = has(args, "-b", "--become");
    const pass = vaultPassword(sh, args, env);
    const bases = [dirOf(inv.path)];
    const extra = extraVars(sh, args);
    const out: string[] = [];
    let allOk = true;
    for (const h of hosts) {
      const host = reachable(sh, inv, h);
      if (!host) {
        allOk = false;
        out.push(`${h} | UNREACHABLE! => ${JSON.stringify({ changed: false, msg: unreachableMsg(inv, h), unreachable: true }, null, 4)}`);
        continue;
      }
      const vars = hostVars(sh, inv, h, bases, pass, { vars: {}, defaults: {} }, extra, check);
      const r = new Renderer(vars);
      let margs: Vars;
      try {
        margs = r.resolveValue(module === "command" || module === "shell" ? { _raw_params: argText } : module === "debug" && !argText ? {} : kvArgs(argText)) as Vars;
      } catch (e) {
        if (!(e instanceof UndefinedVar)) throw e;
        allOk = false;
        out.push(`${h} | FAILED! => ${JSON.stringify({ changed: false, msg: `The task includes an option with an undefined variable. The error was: ${e.message}` }, null, 4)}`);
        continue;
      }
      if (module === "debug") {
        out.push(`${h} | SUCCESS => ${JSON.stringify(margs.var !== undefined ? { [String(margs.var)]: must(r.expr(String(margs.var))) } : { msg: margs.msg ?? "Hello world!" }, null, 4)}`);
        continue;
      }
      const res = runModule(module, margs, { sh, host, check, become, searchDirs: [sh.cwd], hostVars: vars });
      if (module === "ping") state.pings.add(h);
      if (module === "command" || module === "shell") {
        if (res.skipped) out.push(`${h} | SKIPPED`);
        else if (res.failed) {
          allOk = false;
          out.push(/^\[Errno/.test(res.msg ?? "") ? `${h} | FAILED! => ${JSON.stringify({ changed: false, cmd: tokenize(argText), msg: res.msg, rc: res.rc ?? 2 }, null, 4)}` : `${h} | FAILED | rc=${res.rc} >>\n${[res.stdout, res.stderr, "non-zero return code"].filter(Boolean).join("\n")}`);
        } else out.push(`${h} | CHANGED | rc=0 >>\n${[res.stdout, res.stderr].filter(Boolean).join("\n")}`);
        continue;
      }
      const body = { ...(module === "ping" ? { ansible_facts: { discovered_interpreter_python: "/usr/bin/python3" } } : {}), changed: !!res.changed, ...(res.data ?? {}), ...(res.msg ? { msg: res.msg } : {}) };
      if (res.failed) allOk = false;
      if (res.diff && has(args, "--diff", "-D")) out.push(res.diff);
      out.push(`${h} | ${res.failed ? "FAILED!" : res.changed ? "CHANGED" : "SUCCESS"} => ${JSON.stringify(body, null, 4)}`);
    }
    state.adhoc.push({ module, args: argText, hosts, ok: allOk });
    return { output: warn + out.join("\n"), ok: allOk };
  } catch (e) {
    if (e instanceof AnsibleError) return { output: e.message, ok: false };
    throw e;
  }
}

// ------------------------------------------------------------------ ansible-inventory

function inventoryCmd(sh: Shell, args: string[]): { output: string; ok: boolean } {
  const path = inventoryPath(sh, args);
  if (sh.readFile(path) === undefined) return { output: `[WARNING]: Unable to parse ${sh.resolve(path)} as an inventory source\n[WARNING]: No inventory was parsed, only implicit localhost is available\n{}`, ok: false };
  const inv = parseInventory(sh, path);
  const showVars = has(args, "--vars");
  if (has(args, "--graph")) {
    ansibleState(sh).graph = true;
    const start = args[args.indexOf("--graph") + 1];
    const root = start && !start.startsWith("-") && inv.groups[start] ? start : "all";
    const lines = [`@${root}:`];
    const walk = (g: string, indent: string) => {
      const group = inv.groups[g];
      // Like Ansible, top-level groups (not a child of another group) hang from @all, ungrouped included.
      const children = g === "all" ? Object.keys(inv.groups).filter((x) => x !== "all" && !Object.values(inv.groups).some((o) => o.children.includes(x))) : group.children;
      for (const c of [...children].sort((a, b) => (a === "ungrouped" ? -1 : b === "ungrouped" ? 1 : a.localeCompare(b)))) {
        lines.push(`${indent}|--@${c}:`);
        walk(c, `${indent}|  `);
      }
      if (g !== "all")
        for (const h of group.hosts) {
          lines.push(`${indent}|--${h}`);
          if (showVars) for (const [k, v] of Object.entries(inv.hosts[h])) lines.push(`${indent}|  |--{${k} = ${v}}`);
        }
      if (showVars && g !== "all") for (const [k, v] of Object.entries(group.vars)) lines.push(`${indent}|--{${k} = ${v}}`);
    };
    walk(root, "  ");
    return { output: lines.join("\n"), ok: true };
  }
  const hostArg = multi(args, ["--host"])[0];
  const bases = [dirOf(inv.path)];
  let pass: string | undefined;
  try {
    pass = vaultPassword(sh, args, {});
    if (hostArg) {
      if (!inv.hosts[hostArg]) return { output: `ERROR! You must pass a single valid host to --host parameter`, ok: false };
      const groups = groupNames(inv, hostArg).filter((g) => g !== "ungrouped");
      const vars = { ...Object.assign({}, ...["all", ...groups].map((g) => inv.groups[g]?.vars ?? {})), ...Object.assign({}, ...["all", ...groups].map((g) => dirVars(sh, bases, "group_vars", g, pass))), ...inv.hosts[hostArg], ...dirVars(sh, bases, "host_vars", hostArg, pass) };
      return { output: JSON.stringify(vars, null, 4), ok: true };
    }
    const data: Vars = { _meta: { hostvars: Object.fromEntries(inv.order.map((h) => [h, inv.hosts[h]])) }, all: { children: Object.keys(inv.groups).filter((g) => g !== "all") } };
    for (const [g, group] of Object.entries(inv.groups)) if (g !== "all" && (group.hosts.length || group.children.length)) data[g] = { ...(group.hosts.length ? { hosts: group.hosts } : {}), ...(group.children.length ? { children: group.children } : {}) };
    return { output: JSON.stringify(data, null, 4), ok: true };
  } catch (e) {
    if (e instanceof AnsibleError) return { output: e.message, ok: false };
    throw e;
  }
}

// ------------------------------------------------------------------ ansible-vault

function vault(sh: Shell, args: string[], pos: string[], env: Record<string, string>): { output: string; ok: boolean; edit?: { path: string; content: string } } {
  const [action, ...targets] = pos;
  const actions = ["create", "decrypt", "edit", "view", "encrypt", "encrypt_string", "rekey"];
  if (!action || !actions.includes(action)) return { output: `usage: ansible-vault [-h] [--version] [-v]\n                     {create,decrypt,edit,view,encrypt,encrypt_string,rekey}\n                     ...\nansible-vault: error: argument action: invalid choice: '${action ?? ""}' (choose from ${actions.map((a) => `'${a}'`).join(", ")})`, ok: false };
  let pass: string | undefined;
  try {
    pass = vaultPassword(sh, args, env);
  } catch (e) {
    if (e instanceof AnsibleError) return { output: e.message, ok: false };
    throw e;
  }
  if (pass === undefined) return { output: "ERROR! Este terminal não é interativo e não consegue pedir a senha do vault. Use --vault-password-file ~/.vault_pass (ou vault_password_file no ansible.cfg).", ok: false };
  const files = targets.filter((t) => !t.startsWith("-"));
  if (action === "encrypt_string") {
    const name = multi(args, ["-n", "--name"])[0];
    const secret = files[0];
    if (secret === undefined) return { output: "ERROR! Informe o valor: ansible-vault encrypt_string 'segredo' --name 'minha_var' (este terminal não lê da entrada padrão).", ok: false };
    const cipher = vaultEncrypt(secret, pass).trimEnd().split("\n").map((l) => `          ${l}`).join("\n");
    return { output: `${name ? `${name}: ` : ""}!vault |\n${cipher}\nEncryption successful`, ok: true };
  }
  if (!files.length) return { output: `ERROR! ansible-vault ${action} requires at least one filename argument`, ok: false };
  const out: string[] = [];
  for (const f of files) {
    const text = sh.readFile(f);
    if (action === "create") {
      if (text !== undefined) return { output: `ERROR! ${f} exists, please use 'edit' instead`, ok: false };
      const path = sh.resolve(f);
      sh.editHooks.set(path, (content) => {
        sh.writeFile(path, vaultEncrypt(content, pass!));
        return "";
      });
      return { output: "", ok: true, edit: { path, content: "" } };
    }
    if (text === undefined) return { output: `ERROR! [Errno 2] No such file or directory: '${sh.resolve(f)}'`, ok: false };
    if (action === "encrypt") {
      if (isVault(text)) return { output: "ERROR! input is already encrypted", ok: false };
      sh.writeFile(f, vaultEncrypt(text, pass));
      continue;
    }
    if (!isVault(text)) return { output: `ERROR! input is not vault encrypted data. ${f} is not a vault encrypted file for ${sh.resolve(f)}`, ok: false };
    const plain = vaultDecrypt(text, pass);
    if (plain === null) return { output: `ERROR! Decryption failed (no vault secrets were found that could decrypt) on ${sh.resolve(f)} for ${sh.resolve(f)}`, ok: false };
    if (action === "view") out.push(plain.replace(/\n$/, ""));
    else if (action === "decrypt") sh.writeFile(f, plain);
    else if (action === "rekey") {
      const next = multi(args, ["--new-vault-password-file"])[0];
      const nextPass = next ? sh.readFile(next)?.split("\n")[0].trim() : undefined;
      if (!nextPass) return { output: "ERROR! Informe a nova senha com --new-vault-password-file <arquivo>.", ok: false };
      sh.writeFile(f, vaultEncrypt(plain, nextPass));
    } else {
      const path = sh.resolve(f);
      sh.editHooks.set(path, (content) => {
        sh.writeFile(path, vaultEncrypt(content, pass!));
        return "";
      });
      return { output: "", ok: true, edit: { path, content: plain } };
    }
  }
  if (action === "view") return { output: out.join("\n"), ok: true };
  return { output: `${action === "encrypt" ? "Encryption" : action === "decrypt" ? "Decryption" : "Rekey"} successful`, ok: true };
}

// ------------------------------------------------------------------ ansible-galaxy

function galaxy(sh: Shell, pos: string[], args: string[]): string {
  const words = pos[0] === "role" ? pos.slice(1) : pos;
  if (words[0] !== "init" || !words[1]) return "usage: ansible-galaxy role init [--init-path INIT_PATH] role_name\nERROR! Este simulador suporta ansible-galaxy role init <nome>.";
  const base = multi(args, ["--init-path", "-p"])[0] ?? ".";
  const dir = `${base}/${words[1]}`;
  if (sh.isDir(dir)) return `ERROR! - the directory ${sh.resolve(dir)} already exists. You can use --force to re-initialize this directory,\nhowever it will reset any main.yml files that may have\nbeen modified there already.`;
  const header = (what: string) => `---\n# ${what} file for ${words[1]}\n`;
  for (const sub of ["defaults", "handlers", "tasks", "vars"]) sh.writeFile(`${dir}/${sub}/main.yml`, header(sub));
  sh.writeFile(`${dir}/meta/main.yml`, `galaxy_info:\n  author: your name\n  description: your role description\n  min_ansible_version: "2.1"\ndependencies: []\n`);
  sh.writeFile(`${dir}/README.md`, `Role Name\n=========\n\n${words[1]}\n`);
  for (const sub of ["templates", "files", "tests"]) sh.mkdir(`${dir}/${sub}`);
  return `- Role ${words[1]} was created successfully`;
}

// ------------------------------------------------------------------ registration

const COMMON_FLAGS: Record<string, string> = {
  "-i": "inventário (arquivo INI/YAML); o padrão vem de inventory no ansible.cfg",
  "--vault-password-file": "arquivo com a senha do ansible-vault (fora do repositório!)",
  "-e": "variáveis extras (key=value, JSON ou @arquivo); maior precedência",
  "-b": "become: executa com sudo no host gerenciado",
};
const VALUE_FLAGS = ["-i", "--inventory", "-l", "--limit", "-t", "--tags", "--skip-tags", "--vault-password-file", "--vault-pass-file", "-e", "--extra-vars", "-m", "--module-name", "-a", "--args", "-f", "--forks", "-u", "--user", "-n", "--name", "--init-path", "-p", "--new-vault-password-file", "--host"];

registerTool({
  name: "ansible-playbook",
  summary: "executa playbooks do Ansible contra o inventário",
  flags: {
    ...COMMON_FLAGS,
    "--check": "dry-run: mostra o que mudaria sem alterar os hosts",
    "--diff": "mostra o diff dos arquivos (template/copy)",
    "--limit": "restringe os hosts (padrão: host, grupo, a:b, !excluir)",
    "--tags": "roda só as tasks com essas tags",
    "--skip-tags": "pula as tasks com essas tags",
    "--syntax-check": "valida a sintaxe do playbook sem executar",
  },
  valueFlags: VALUE_FLAGS,
  run: ({ sh, args, pos, env }) => playbook(sh, args, pos, env),
  explainError: (_cmd, output) => {
    if (/requested handler '(.+?)' was not found/.test(output)) return "Uma task notificou um handler que não existe com esse nome exato. O nome em notify: precisa ser idêntico ao name: (ou a um listen:) do handler — maiúsculas contam.";
    if (/no vault secrets found/.test(output)) return "Algum arquivo de variáveis está criptografado com ansible-vault. Passe a senha com --vault-password-file ~/.vault_pass.";
    if (/Decryption failed/.test(output)) return "A senha informada não abre esse vault. Confira o arquivo passado em --vault-password-file.";
    if (/AnsibleUndefinedVariable|undefined variable/.test(output)) return "Um template ou argumento usa uma variável que não foi definida para o host. Confira o nome e onde ela deveria vir (defaults da role, group_vars, host_vars ou -e).";
    if (/Permission denied|not writable|Access denied/.test(output)) return "A task precisa de privilégios de root no host gerenciado. Use become: true no play (ou na task).";
    return null;
  },
});

registerTool({
  name: "ansible",
  summary: "comandos ad-hoc do Ansible (ping, command, shell, service…)",
  flags: { ...COMMON_FLAGS, "-m": "módulo a executar (padrão: command)", "-a": "argumentos do módulo", "--list-hosts": "lista os hosts que casam com o padrão" },
  valueFlags: VALUE_FLAGS,
  run: ({ sh, args, pos, env }) => adhoc(sh, args, pos, env),
  explainError: (_cmd, output) => (/UNREACHABLE/.test(output) ? "O Ansible não conseguiu abrir SSH até o host. Confira ansible_host no inventário e a conectividade." : null),
  // curl/wget to a managed node answers when Ansible installed and started nginx on it.
  http: ({ host, path }, sh) => {
    const node = Object.values(sh.state.hosts).find((h) => (h.name === host || h.ip === host) && h.packages.nginx);
    if (!node?.services.nginx?.active) return null;
    const files = filesOf(node);
    if (path.startsWith("/healthz")) return /location \/healthz/.test(files["/etc/nginx/nginx.conf"] ?? "") ? "ok" : "<html><head><title>404 Not Found</title></head><body><center><h1>404 Not Found</h1></center><hr><center>nginx/1.24.0 (Ubuntu)</center></body></html>";
    return (files["/var/www/html/index.html"] ?? files["/var/www/html/index.nginx-debian.html"] ?? "").trimEnd();
  },
});

registerTool({
  name: "ansible-vault",
  summary: "criptografa arquivos e valores sensíveis usados pelo Ansible",
  subcommands: { encrypt: "criptografa um arquivo", decrypt: "descriptografa um arquivo", view: "mostra o conteúdo sem gravar em claro", edit: "edita no editor e recriptografa ao salvar", create: "cria um arquivo já criptografado", encrypt_string: "gera um valor !vault para colar num YAML", rekey: "troca a senha" },
  flags: { "--vault-password-file": COMMON_FLAGS["--vault-password-file"], "--name": "nome da variável em encrypt_string" },
  valueFlags: VALUE_FLAGS,
  run: ({ sh, args, pos, env }) => vault(sh, args, pos, env),
  explainError: (_cmd, output) => (/already encrypted/.test(output) ? "Esse arquivo já está criptografado. Use ansible-vault view ou edit." : null),
});

registerTool({
  name: "ansible-inventory",
  summary: "mostra o inventário interpretado pelo Ansible",
  flags: { "--graph": "árvore de grupos e hosts", "--list": "inventário completo em JSON", "--host": "variáveis de um host", "--vars": "inclui variáveis no --graph", "-i": COMMON_FLAGS["-i"] },
  valueFlags: VALUE_FLAGS,
  run: ({ sh, args }) => inventoryCmd(sh, args),
});

registerTool({
  name: "ansible-galaxy",
  summary: "cria o esqueleto de uma role (ansible-galaxy role init)",
  subcommands: { role: "operações com roles", init: "cria a estrutura de uma role" },
  valueFlags: VALUE_FLAGS,
  run: ({ sh, args, pos }) => galaxy(sh, pos, args),
});
