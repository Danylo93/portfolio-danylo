// Minimal HCL2 lexer/parser/formatter used by the simulated Terraform engine.
// Good enough for realistic lab configurations: blocks, attributes, templates, lists, objects,
// function calls, operators, conditionals, for-expressions, splats and heredocs.

export class Unknown {
  toString() {
    return "(known after apply)";
  }
}
/** A value that is only known after apply. */
export const UNK = new Unknown();

export type Value = string | number | boolean | null | Unknown | Value[] | { [k: string]: Value };
export type Obj = { [k: string]: Value };

export const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Unknown);
export const hasUnknown = (v: Value): boolean =>
  v instanceof Unknown || (Array.isArray(v) ? v.some(hasUnknown) : isObj(v) ? Object.values(v).some(hasUnknown) : false);
export const valEq = (a: Value | undefined, b: Value | undefined): boolean => {
  if (a instanceof Unknown || b instanceof Unknown) return false;
  return JSON.stringify(sortKeys(a ?? null)) === JSON.stringify(sortKeys(b ?? null));
};
const sortKeys = (v: Value): Value =>
  Array.isArray(v) ? v.map(sortKeys) : isObj(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])])) : v;
export const clone = <T extends Value>(v: T): T =>
  (Array.isArray(v) ? v.map(clone) : isObj(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clone(x)])) : v) as T;

export type Diag = {
  summary: string;
  detail: string;
  file?: string;
  line?: number;
  /** e.g. `in resource "aws_s3_bucket" "logs"` */
  ctx?: string;
  warning?: boolean;
};

export class HclError extends Error {
  constructor(public diag: Diag) {
    super(diag.summary);
  }
}

// ---------------- lexer ----------------
type Tok = { k: "id" | "str" | "num" | "op" | "nl" | "eof"; v: string; line: number; heredoc?: boolean };

const OPS2 = ["==", "!=", "<=", ">=", "&&", "||", "=>"];
const OPS1 = "{}[]()=,.:?!<>+-*/%";

/** Index of the closing quote of the string starting at i (s[i] === '"'), or -1. */
const scanQuoted = (s: string, i: number): number => {
  let j = i + 1;
  while (j < s.length) {
    const c = s[j];
    if (c === "\\") {
      j += 2;
      continue;
    }
    if (c === "\n") return -1;
    if (c === '"') return j;
    if (c === "$" && s[j + 1] === "$" && s[j + 2] === "{") {
      j += 3;
      continue;
    }
    if ((c === "$" || c === "%") && s[j + 1] === "{") {
      const end = scanInterp(s, j + 2);
      if (end < 0) return -1;
      j = end + 1;
      continue;
    }
    j++;
  }
  return -1;
};

/** Index of the "}" that closes an interpolation whose content starts at j. */
const scanInterp = (s: string, j: number): number => {
  let depth = 1;
  while (j < s.length) {
    const c = s[j];
    if (c === '"') {
      const e = scanQuoted(s, j);
      if (e < 0) return -1;
      j = e + 1;
      continue;
    }
    if (c === "\n") return -1;
    if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return j;
    j++;
  }
  return -1;
};

export const lex = (src: string, file: string, firstLine = 1): Tok[] => {
  const toks: Tok[] = [];
  let i = 0;
  let line = firstLine;
  const fail = (summary: string, detail: string): never => {
    throw new HclError({ summary, detail, file, line });
  };
  while (i < src.length) {
    const c = src[i];
    if (c === "\n") {
      toks.push({ k: "nl", v: "\n", line });
      line++;
      i++;
      continue;
    }
    if (c === " " || c === "\t" || c === "\r") {
      i++;
      continue;
    }
    if (c === "#" || (c === "/" && src[i + 1] === "/")) {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      if (end < 0) fail("Unterminated comment", "There is no \"*/\" closing marker for this comment.");
      line += src.slice(i, end).split("\n").length - 1;
      i = end + 2;
      continue;
    }
    if (c === '"') {
      const end = scanQuoted(src, i);
      if (end < 0)
        fail(
          "Invalid multi-line string",
          'Quoted strings may not be split over multiple lines. To produce a multi-line string, either use the \\n escape to represent a newline character or use the "heredoc" multi-line template syntax.',
        );
      toks.push({ k: "str", v: src.slice(i + 1, end), line });
      i = end + 1;
      continue;
    }
    if (c === "<" && src[i + 1] === "<") {
      const m = /^<<(-?)([A-Za-z_]\w*)[ \t]*\n/.exec(src.slice(i));
      if (m) {
        const startLine = line;
        let j = i + m[0].length;
        line++;
        const body: string[] = [];
        let closed = false;
        while (j < src.length) {
          const nl = src.indexOf("\n", j);
          const l = src.slice(j, nl < 0 ? src.length : nl);
          j = nl < 0 ? src.length : nl;
          if (l.trim() === m[2]) {
            closed = true;
            break;
          }
          body.push(l);
          line++;
          j++;
        }
        if (!closed) {
          line = startLine;
          fail("Unterminated template string", `No closing marker was found for the heredoc started with <<${m[1]}${m[2]}.`);
        }
        let lines = body;
        if (m[1]) {
          const ind = Math.min(...lines.filter((l) => l.trim()).map((l) => /^\s*/.exec(l)![0].length));
          lines = lines.map((l) => l.slice(Number.isFinite(ind) ? ind : 0));
        }
        toks.push({ k: "str", v: lines.join("\n") + "\n", line: startLine, heredoc: true });
        i = j;
        continue;
      }
    }
    const num = /^\d+(\.\d+)?([eE][+-]?\d+)?/.exec(src.slice(i, i + 40));
    if (num) {
      toks.push({ k: "num", v: num[0], line });
      i += num[0].length;
      continue;
    }
    const id = /^[A-Za-z_][\w-]*/.exec(src.slice(i, i + 200));
    if (id) {
      toks.push({ k: "id", v: id[0], line });
      i += id[0].length;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (OPS2.includes(two)) {
      toks.push({ k: "op", v: two, line });
      i += 2;
      continue;
    }
    if (src.slice(i, i + 3) === "...") {
      toks.push({ k: "op", v: "...", line });
      i += 3;
      continue;
    }
    if (OPS1.includes(c)) {
      toks.push({ k: "op", v: c, line });
      i++;
      continue;
    }
    fail("Invalid character", "This character is not used within the language.");
  }
  toks.push({ k: "eof", v: "", line });
  return toks;
};

// ---------------- AST ----------------
export type Expr =
  | { t: "lit"; v: Value }
  | { t: "tpl"; parts: (string | Expr)[] }
  | { t: "list"; items: Expr[] }
  | { t: "obj"; items: { k: Expr; v: Expr }[] }
  | { t: "var"; name: string }
  | { t: "get"; o: Expr; name: string }
  | { t: "idx"; o: Expr; i: Expr }
  | { t: "splat"; o: Expr; each: Expr }
  | { t: "call"; name: string; args: Expr[]; expand?: boolean }
  | { t: "bin"; op: string; a: Expr; b: Expr }
  | { t: "un"; op: string; a: Expr }
  | { t: "cond"; c: Expr; a: Expr; b: Expr }
  | { t: "for"; obj: boolean; k?: string; v: string; coll: Expr; key?: Expr; val: Expr; cond?: Expr };

export type Attr = { name: string; expr: Expr; line: number };
export type Block = { type: string; labels: string[]; attrs: Attr[]; blocks: Block[]; line: number; file: string };
export type Body = { attrs: Attr[]; blocks: Block[] };

/** Placeholder variable used inside splat expressions. */
export const SPLAT_IT = "\u0000it";

const unescape = (s: string) =>
  s.replace(/\\(n|t|r|"|\\|u[0-9a-fA-F]{4})/g, (_, e: string) =>
    e === "n" ? "\n" : e === "t" ? "\t" : e === "r" ? "\r" : e[0] === "u" ? String.fromCharCode(parseInt(e.slice(1), 16)) : e,
  ).replace(/\$\$\{/g, "${");

const BIN_LEVELS = [["||"], ["&&"], ["==", "!="], ["<", ">", "<=", ">="], ["+", "-"], ["*", "/", "%"]];

class Parser {
  i = 0;
  nl = 0;
  constructor(
    private toks: Tok[],
    private file: string,
  ) {}

  private raw() {
    return this.toks[this.i];
  }
  peek(): Tok {
    if (this.nl > 0) while (this.toks[this.i].k === "nl") this.i++;
    return this.toks[this.i];
  }
  next(): Tok {
    const t = this.peek();
    if (t.k !== "eof") this.i++;
    return t;
  }
  isOp(v: string) {
    const t = this.peek();
    return t.k === "op" && t.v === v;
  }
  fail(summary: string, detail: string, line = this.peek().line, ctx?: string): never {
    throw new HclError({ summary, detail, file: this.file, line, ctx });
  }
  expectOp(v: string, what: string) {
    if (!this.isOp(v)) {
      const t = this.peek();
      this.fail(`Missing ${what}`, `Expected "${v}", but found ${t.k === "nl" ? "a newline" : t.k === "eof" ? "the end of the file" : `"${t.v}"`}.`);
    }
    return this.next();
  }

  body(openLine: number | null, ctx?: string): Body {
    const attrs: Attr[] = [];
    const blocks: Block[] = [];
    for (;;) {
      while (this.raw().k === "nl") this.i++;
      const t = this.raw();
      if (t.k === "eof") {
        if (openLine !== null)
          this.fail(
            "Unclosed configuration block",
            "There is no closing brace for this block before the end of the file. This may be caused by incorrect brace nesting elsewhere in this file.",
            openLine,
            ctx,
          );
        return { attrs, blocks };
      }
      if (t.k === "op" && t.v === "}") {
        if (openLine === null) this.fail("Argument or block definition required", "An argument or block definition is required here.", t.line, ctx);
        this.i++;
        return { attrs, blocks };
      }
      if (t.k !== "id") this.fail("Argument or block definition required", "An argument or block definition is required here.", t.line, ctx);
      this.i++;
      const nx = this.raw();
      if (nx.k === "op" && nx.v === "=") {
        this.i++;
        const after = this.raw();
        if (after.k === "nl" || after.k === "eof")
          this.fail("Invalid expression", "Expected the start of an expression, but found the end of the line.", t.line, ctx);
        const expr = this.expr();
        const prev = attrs.find((a) => a.name === t.v);
        if (prev)
          this.fail("Attribute redefined", `The argument "${t.v}" was already set at ${this.file}:${prev.line}. Each argument may be set only once.`, t.line, ctx);
        attrs.push({ name: t.v, expr, line: t.line });
        const end = this.raw();
        if (end.k === "nl") this.i++;
        else if (!(end.k === "eof" || (end.k === "op" && end.v === "}")))
          this.fail("Missing newline after argument", "An argument definition must end with a newline.", end.line, ctx);
        continue;
      }
      const labels: string[] = [];
      while (this.raw().k === "str" || this.raw().k === "id") {
        const l = this.raw();
        this.i++;
        labels.push(l.k === "str" ? unescape(l.v) : l.v);
      }
      const open = this.raw();
      if (!(open.k === "op" && open.v === "{")) {
        if (open.k === "nl" || open.k === "eof")
          this.fail(
            "Invalid block definition",
            'A block definition must have block content delimited by "{" and "}", starting on the same line as the block header.',
            t.line,
            ctx,
          );
        this.fail("Invalid block definition", 'Either a quoted string block label or an opening brace ("{") is expected here.', open.line, ctx);
      }
      this.i++;
      const header = [t.v, ...labels.map((l) => `"${l}"`)].join(" ");
      const inner = this.body(t.line, ctx ?? `in ${header}`);
      blocks.push({ type: t.v, labels, ...inner, line: t.line, file: this.file });
      const end = this.raw();
      if (end.k === "nl") this.i++;
      else if (!(end.k === "eof" || (end.k === "op" && end.v === "}")))
        this.fail("Missing newline after block definition", "A block definition must end with a newline.", end.line, ctx);
    }
  }

  expr(): Expr {
    const c = this.binary(0);
    if (this.isOp("?")) {
      this.next();
      this.nl++;
      const a = this.expr();
      this.expectOp(":", "false expression");
      this.nl--;
      const b = this.expr();
      return { t: "cond", c, a, b };
    }
    return c;
  }

  private binary(level: number): Expr {
    if (level >= BIN_LEVELS.length) return this.unary();
    let left = this.binary(level + 1);
    for (;;) {
      const t = this.peek();
      if (t.k === "op" && BIN_LEVELS[level].includes(t.v)) {
        this.next();
        const right = this.binary(level + 1);
        left = { t: "bin", op: t.v, a: left, b: right };
      } else return left;
    }
  }

  private unary(): Expr {
    if (this.isOp("!") || this.isOp("-")) {
      const op = this.next().v;
      return { t: "un", op, a: this.unary() };
    }
    return this.postfix(this.primary());
  }

  private postfix(e: Expr): Expr {
    for (;;) {
      if (this.isOp(".")) {
        this.next();
        const t = this.next();
        if (t.k === "op" && t.v === "*") return { t: "splat", o: e, each: this.postfix({ t: "var", name: SPLAT_IT }) };
        if (t.k === "num") e = { t: "idx", o: e, i: { t: "lit", v: Number(t.v) } };
        else if (t.k === "id") e = { t: "get", o: e, name: t.v };
        else this.fail("Invalid attribute name", "An attribute name is required after a dot.", t.line);
      } else if (this.isOp("[")) {
        this.next();
        this.nl++;
        if (this.isOp("*")) {
          this.next();
          this.expectOp("]", "closing bracket");
          this.nl--;
          return { t: "splat", o: e, each: this.postfix({ t: "var", name: SPLAT_IT }) };
        }
        const i = this.expr();
        this.expectOp("]", "closing bracket");
        this.nl--;
        e = { t: "idx", o: e, i };
      } else return e;
    }
  }

  private primary(): Expr {
    const t = this.next();
    if (t.k === "num") return { t: "lit", v: Number(t.v) };
    if (t.k === "str") return template(t.v, this.file, t.line, t.heredoc);
    if (t.k === "id") {
      if (t.v === "true" || t.v === "false") return { t: "lit", v: t.v === "true" };
      if (t.v === "null") return { t: "lit", v: null };
      if (this.raw().k === "op" && this.raw().v === "(") {
        this.next();
        this.nl++;
        const args: Expr[] = [];
        let expand = false;
        while (!this.isOp(")")) {
          args.push(this.expr());
          if (this.isOp("...")) {
            this.next();
            expand = true;
          }
          if (this.isOp(",")) this.next();
          else if (!this.isOp(")")) this.fail("Missing argument separator", 'A comma is required to separate each function argument from the next.');
        }
        this.next();
        this.nl--;
        return { t: "call", name: t.v, args, expand };
      }
      return { t: "var", name: t.v };
    }
    if (t.k === "op" && t.v === "(") {
      this.nl++;
      const e = this.expr();
      this.expectOp(")", "closing parenthesis");
      this.nl--;
      return e;
    }
    if (t.k === "op" && t.v === "[") {
      this.nl++;
      if (this.peek().k === "id" && this.peek().v === "for") return this.forExpr(false);
      const items: Expr[] = [];
      while (!this.isOp("]")) {
        if (this.peek().k === "eof") this.fail("Unclosed bracket", "There is no closing bracket for this list.", t.line);
        items.push(this.expr());
        if (this.isOp(",")) this.next();
        else if (!this.isOp("]")) this.fail("Missing item separator", "Expected a comma to mark the beginning of the next item.");
      }
      this.next();
      this.nl--;
      return { t: "list", items };
    }
    if (t.k === "op" && t.v === "{") {
      this.nl++;
      if (this.peek().k === "id" && this.peek().v === "for") return this.forExpr(true);
      const items: { k: Expr; v: Expr }[] = [];
      while (!this.isOp("}")) {
        const kt = this.peek();
        if (kt.k === "eof") this.fail("Unclosed configuration block", "There is no closing brace for this object.", t.line);
        let k: Expr;
        if (kt.k === "id" && this.toks[this.i + 1]?.k === "op" && ["=", ":"].includes(this.toks[this.i + 1].v)) {
          this.next();
          k = { t: "lit", v: kt.v };
        } else k = this.expr();
        if (this.isOp("=") || this.isOp(":")) this.next();
        else this.fail("Missing key/value separator", 'Expected an equals sign ("=") to mark the beginning of the attribute value.');
        const v = this.expr();
        items.push({ k, v });
        if (this.isOp(",")) this.next();
      }
      this.next();
      this.nl--;
      return { t: "obj", items };
    }
    const what = t.k === "nl" ? "a newline" : t.k === "eof" ? "the end of the file" : `"${t.v}"`;
    return this.fail("Invalid expression", `Expected the start of an expression, but found ${what}.`, t.line);
  }

  private forExpr(obj: boolean): Expr {
    this.next(); // for
    const a = this.next();
    let k: string | undefined;
    let v = a.v;
    if (this.isOp(",")) {
      this.next();
      k = a.v;
      v = this.next().v;
    }
    const inTok = this.next();
    if (inTok.v !== "in") this.fail("Invalid 'for' expression", "The 'in' keyword is required after the iterator variable names.", inTok.line);
    const coll = this.expr();
    this.expectOp(":", "colon");
    let key: Expr | undefined;
    let val = this.expr();
    if (obj) {
      this.expectOp("=>", "\"=>\"");
      key = val;
      val = this.expr();
      if (this.isOp("...")) this.next();
    }
    let cond: Expr | undefined;
    if (this.peek().k === "id" && this.peek().v === "if") {
      this.next();
      cond = this.expr();
    }
    this.expectOp(obj ? "}" : "]", obj ? "closing brace" : "closing bracket");
    this.nl--;
    return { t: "for", obj, k, v, coll, key, val, cond };
  }
}

/** Parses a quoted string body into literal parts and interpolations. */
const template = (raw: string, file: string, line: number, heredoc = false): Expr => {
  const parts: (string | Expr)[] = [];
  let buf = "";
  let i = 0;
  while (i < raw.length) {
    if (raw[i] === "\\" && !heredoc) {
      buf += raw.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (raw.startsWith("$${", i)) {
      buf += "$${";
      i += 3;
      continue;
    }
    if (raw.startsWith("${", i)) {
      const end = scanInterp(raw, i + 2);
      if (buf) parts.push(heredoc ? buf : unescape(buf));
      buf = "";
      const inner = raw.slice(i + 2, end).replace(/^~|~$/g, "");
      parts.push(parseExpr(inner, file, line));
      i = end + 1;
      continue;
    }
    buf += raw[i++];
  }
  if (buf || !parts.length) parts.push(heredoc ? buf : unescape(buf));
  if (parts.length === 1 && typeof parts[0] === "string") return { t: "lit", v: parts[0] };
  return { t: "tpl", parts };
};

export const parseExpr = (src: string, file = "<value>", line = 1): Expr => {
  const p = new Parser(lex(src, file, line), file);
  p.nl = 1;
  const e = p.expr();
  const t = p.peek();
  if (t.k !== "eof") p.fail("Extra characters after expression", "An expression was successfully parsed, but extra characters were found after it.", t.line);
  return e;
};

export const parseHcl = (src: string, file: string): Body => new Parser(lex(src, file), file).body(null);

/** Collects every reference traversal (e.g. ["var","env"], ["aws_s3_bucket","logs","arn"]) with local scope handling. */
export const refsOf = (e: Expr, scope: Set<string> = new Set()): string[][] => {
  const out: string[][] = [];
  const path = (x: Expr): string[] | null => {
    if (x.t === "var") return [x.name];
    if (x.t === "get") {
      const p = path(x.o);
      return p ? [...p, x.name] : null;
    }
    if (x.t === "idx") return path(x.o);
    return null;
  };
  const walk = (x: Expr, sc: Set<string>) => {
    switch (x.t) {
      case "var":
      case "get":
      case "idx": {
        const p = path(x);
        if (p && !sc.has(p[0]) && p[0] !== SPLAT_IT) out.push(p);
        if (x.t === "idx") {
          walk(x.i, sc);
          if (!p) walk(x.o, sc);
        } else if (x.t === "get" && !p) walk(x.o, sc);
        break;
      }
      case "tpl":
        x.parts.forEach((p) => typeof p !== "string" && walk(p, sc));
        break;
      case "list":
        x.items.forEach((i) => walk(i, sc));
        break;
      case "obj":
        x.items.forEach((i) => {
          if (i.k.t !== "var") walk(i.k, sc);
          walk(i.v, sc);
        });
        break;
      case "splat":
        walk(x.o, sc);
        walk(x.each, sc);
        break;
      case "call":
        x.args.forEach((a) => walk(a, sc));
        break;
      case "bin":
        walk(x.a, sc);
        walk(x.b, sc);
        break;
      case "un":
        walk(x.a, sc);
        break;
      case "cond":
        walk(x.c, sc);
        walk(x.a, sc);
        walk(x.b, sc);
        break;
      case "for": {
        walk(x.coll, sc);
        const inner = new Set([...sc, x.v, ...(x.k ? [x.k] : [])]);
        if (x.key) walk(x.key, inner);
        walk(x.val, inner);
        if (x.cond) walk(x.cond, inner);
        break;
      }
    }
  };
  walk(e, scope);
  return out;
};

/** Function names used in an expression (with the line of the attribute). */
export const callsOf = (e: Expr): string[] => {
  const out: string[] = [];
  const walk = (x: Expr): void => {
    if (x.t === "call") out.push(x.name);
    for (const v of Object.values(x)) {
      if (Array.isArray(v)) v.forEach((i) => i && typeof i === "object" && ("t" in i ? walk(i as Expr) : "k" in i ? (walk(i.k), walk(i.v)) : null));
      else if (v && typeof v === "object" && "t" in v) walk(v as Expr);
    }
  };
  walk(e);
  return out;
};

/** Converts a traversal expression (moved/import/-target) to an address string. */
export const exprToAddr = (e: Expr): string | null => {
  if (e.t === "var") return e.name;
  if (e.t === "get") {
    const p = exprToAddr(e.o);
    return p === null ? null : `${p}.${e.name}`;
  }
  if (e.t === "idx") {
    const p = exprToAddr(e.o);
    if (p === null || e.i.t !== "lit") return null;
    return `${p}[${typeof e.i.v === "number" ? e.i.v : JSON.stringify(e.i.v)}]`;
  }
  return null;
};

// ---------------- formatter ----------------
const codeOnly = (l: string) => l.replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/(#|\/\/).*$/, "");

/** Formats HCL like `terraform fmt`: 2-space indentation and aligned "=" in attribute runs. */
export const fmtHcl = (src: string): string => {
  const lines = src.replace(/\r/g, "").split("\n");
  const out: string[] = [];
  let depth = 0;
  let heredoc: string | null = null;
  for (const raw of lines) {
    if (heredoc) {
      out.push(raw);
      if (raw.trim() === heredoc) heredoc = null;
      continue;
    }
    let l = raw.trim();
    if (!l) {
      out.push("");
      continue;
    }
    const code = codeOnly(l);
    const lead = /^[}\])]+/.exec(code)?.[0].length ?? 0;
    const opens = (code.match(/[{[(]/g) ?? []).length;
    const closes = (code.match(/[}\])]/g) ?? []).length;
    const m = /^([\w-]+|"[^"]*")\s*=\s*(?![=>])(.*)$/.exec(l);
    if (m) l = `${m[1]} = ${m[2]}`;
    out.push("  ".repeat(Math.max(0, depth - lead)) + l);
    depth = Math.max(0, depth + opens - closes);
    const hd = /<<-?(\w+)\s*$/.exec(code);
    if (hd) heredoc = hd[1];
  }
  // align "=" in runs of single-line attributes with the same indentation
  const isAttr = (l: string) => {
    const m = /^(\s*)([\w-]+|"[^"]*") = (.*)$/.exec(l);
    if (!m) return null;
    const code = codeOnly(m[3]);
    const bal = (code.match(/[{[(]/g) ?? []).length - (code.match(/[}\])]/g) ?? []).length;
    return bal > 0 ? null : m;
  };
  let i = 0;
  while (i < out.length) {
    const first = isAttr(out[i]);
    if (!first) {
      i++;
      continue;
    }
    let j = i;
    const run: RegExpExecArray[] = [];
    while (j < out.length) {
      const m = isAttr(out[j]);
      if (!m || m[1] !== first[1]) break;
      run.push(m);
      j++;
    }
    const w = Math.max(...run.map((m) => m[2].length));
    run.forEach((m, k) => (out[i + k] = `${m[1]}${m[2].padEnd(w)} = ${m[3]}`));
    i = j;
  }
  while (out.length && out[out.length - 1] === "") out.pop();
  return out.join("\n") + "\n";
};
