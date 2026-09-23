// GitHub CLI + a deterministic GitHub Actions engine. `git push` (tools/git.ts) triggers the workflows found in
// .github/workflows/*.yml of the pushed commit; each step is simulated against that commit's files.
import YAML from "yaml";
import { registerTool } from "../registry";
import type { Shell } from "../shell";
import type { ToolResult } from "../types";
import { table } from "../util";
import { commitOf, findRepo, pushHooks, serverOf, serverRev, short, type PushEvent, type Server, type Tree } from "./git";

type Conclusion = "success" | "failure" | "skipped";
export type StepRun = { name: string; conclusion: Conclusion; log: string[]; secs: number };
export type JobRun = { id: number; name: string; conclusion: Conclusion; steps: StepRun[]; secs: number; annotation?: string };
export type Run = {
  id: number;
  number: number;
  attempt: number;
  workflow: string;
  file: string;
  event: string;
  branch: string;
  refType: "branch" | "tag";
  sha: string;
  title: string;
  slug: string;
  createdAt: number;
  conclusion: Exclude<Conclusion, "skipped">;
  jobs: JobRun[];
  invalid?: string;
  /** secret names referenced by the workflow but not set */
  missingSecrets: string[];
};
type GhState = { runs: Run[]; secrets: Record<string, Record<string, { value: string; updated: number }>>; nextRun: number; nextJob: number; images: string[] };

export const ghState = (sh: Shell) => sh.ext<GhState>("gh", () => ({ runs: [], secrets: {}, nextRun: 10_482_311_904, nextJob: 29_031_455_100, images: [] }));

/** A run looks "in progress" for this long after it was queued. */
export const RUN_MS = 3000;
export const runDone = (r: Run) => Date.now() - r.createdAt >= RUN_MS;

export const secretsOf = (sh: Shell, slug: string) => (ghState(sh).secrets[slug] ??= {});

// ---------- expressions ----------
type ExprCtx = {
  secrets: Record<string, string>;
  github: Record<string, string>;
  matrix: Record<string, unknown>;
  env: Record<string, string>;
  outputs: Record<string, Record<string, string>>;
  missing: Set<string>;
};

const exprValue = (raw: string, x: ExprCtx): string => {
  const e = raw.trim();
  let m: RegExpExecArray | null;
  if ((m = /^secrets\.(\w+)$/.exec(e))) {
    if (m[1] === "GITHUB_TOKEN") return "ghs_" + "x".repeat(36);
    if (!(m[1] in x.secrets)) x.missing.add(m[1]);
    return x.secrets[m[1]] ?? "";
  }
  if ((m = /^github\.(\w+)$/.exec(e))) return x.github[m[1]] ?? "";
  if ((m = /^matrix\.([\w-]+)$/.exec(e))) return String(x.matrix[m[1]] ?? "");
  if ((m = /^env\.(\w+)$/.exec(e))) return x.env[m[1]] ?? "";
  if ((m = /^steps\.([\w-]+)\.outputs\.([\w-]+)$/.exec(e))) return x.outputs[m[1]]?.[m[2]] ?? "";
  if (e === "runner.os") return "Linux";
  if (/^'.*'$/.test(e)) return e.slice(1, -1);
  return "";
};

const subst = (s: unknown, x: ExprCtx): string =>
  s === undefined || s === null ? "" : String(s).replace(/\$\{\{\s*(.*?)\s*\}\}/g, (_, e: string) => exprValue(e, x));

const condition = (raw: unknown, x: ExprCtx, failed: boolean): boolean => {
  if (raw === undefined || raw === null) return !failed;
  const e = String(raw).trim().replace(/^\$\{\{\s*/, "").replace(/\s*\}\}$/, "");
  if (/\balways\(\)/.test(e)) return true;
  if (/\bfailure\(\)/.test(e)) return failed;
  if (/\bcancelled\(\)/.test(e)) return false;
  if (failed) return false;
  const operand = (s: string) => (/^'.*'$/.test(s.trim()) ? s.trim().slice(1, -1) : exprValue(s, x));
  return e.split("&&").every((c0) => {
    const c = c0.trim().replace(/^success\(\)$/, "true");
    if (c === "true") return true;
    if (c === "false") return false;
    let m = /^(.+?)\s*(==|!=)\s*(.+)$/.exec(c);
    if (m) return (operand(m[1]) === operand(m[3])) === (m[2] === "==");
    m = /^startsWith\((.+?),\s*(.+)\)$/.exec(c);
    if (m) return operand(m[1]).startsWith(operand(m[2]));
    m = /^contains\((.+?),\s*(.+)\)$/.exec(c);
    if (m) return operand(m[1]).includes(operand(m[2]));
    return true;
  });
};

// ---------- tiny evaluator for test assertions ----------
type Fn = { params: string[]; body: string };
type Val = number | string | boolean;

const collectFns = (tree: Tree) => {
  const fns: Record<string, Fn> = {};
  const params = (s: string) => s.split(",").map((p) => p.trim()).filter(Boolean);
  for (const [p, c] of Object.entries(tree)) {
    if (!/\.(c|m)?[jt]sx?$/.test(p) || /\.(test|spec)\./.test(p)) continue;
    for (const m of c.matchAll(/function\s+(\w+)\s*\(([^)]*)\)\s*\{\s*return\s+([^;}]+);?\s*\}/g)) fns[m[1]] = { params: params(m[2]), body: m[3] };
    for (const m of c.matchAll(/(?:const|let|var)\s+(\w+)\s*=\s*\(([^)]*)\)\s*=>\s*([^;\n{]+)/g)) fns[m[1]] = { params: params(m[2]), body: m[3] };
  }
  return fns;
};

const evaluate = (src: string, scope: Record<string, Val>, fns: Record<string, Fn>, depth = 0): Val => {
  if (depth > 20) throw new Error("depth");
  const toks = src.match(/\d+(?:\.\d+)?|'[^']*'|"[^"]*"|`[^`]*`|===|!==|==|!=|[\w$]+|[-+*/%(),]/g) ?? [];
  let i = 0;
  const peek = () => toks[i];
  const primary = (): Val => {
    const t = toks[i++];
    if (t === undefined) throw new Error("eof");
    if (t === "(") {
      const v = add();
      i++;
      return v;
    }
    if (t === "-") return -Number(primary());
    if (/^\d/.test(t)) return Number(t);
    if (/^['"`]/.test(t)) return t.slice(1, -1);
    if (t === "true" || t === "false") return t === "true";
    if (peek() === "(") {
      i++;
      const args: Val[] = [];
      while (peek() !== ")") {
        args.push(add());
        if (peek() === ",") i++;
        if (i > toks.length) throw new Error("eof");
      }
      i++;
      const fn = fns[t];
      if (!fn) throw new Error(`unknown fn ${t}`);
      return evaluate(fn.body, Object.fromEntries(fn.params.map((p, k) => [p, args[k]])), fns, depth + 1);
    }
    if (t in scope) return scope[t];
    throw new Error(`unknown ${t}`);
  };
  const mul = (): Val => {
    let v = primary();
    while (["*", "/", "%"].includes(peek())) {
      const op = toks[i++];
      const r = Number(primary());
      v = op === "*" ? Number(v) * r : op === "/" ? Number(v) / r : Number(v) % r;
    }
    return v;
  };
  const add = (): Val => {
    let v = mul();
    while (peek() === "+" || peek() === "-") {
      const op = toks[i++];
      const r = mul();
      v = op === "+" ? (typeof v === "string" || typeof r === "string" ? String(v) + String(r) : Number(v) + Number(r)) : Number(v) - Number(r);
    }
    return v;
  };
  return add();
};

type TestCase = { name: string; ok: boolean; expected?: string; received?: string; line: number };
const runTestFile = (content: string, fns: Record<string, Fn>): TestCase[] => {
  const cases: TestCase[] = [];
  let cur: TestCase | null = null;
  content.split("\n").forEach((line, idx) => {
    const t = /\b(?:test|it)\(\s*(['"`])(.+?)\1/.exec(line);
    if (t) {
      cur = { name: t[2], ok: true, line: idx + 1 };
      cases.push(cur);
    }
    const e = /expect\((.*)\)\.(toBe|toEqual|toStrictEqual)\((.*)\)\s*;?\s*(\}\);?)?\s*$/.exec(line);
    if (e && cur && cur.ok) {
      try {
        const got = evaluate(e[1], {}, fns);
        const want = evaluate(e[3], {}, fns);
        if (got !== want) {
          cur.ok = false;
          cur.expected = JSON.stringify(want);
          cur.received = JSON.stringify(got);
          cur.line = idx + 1;
        }
      } catch {
        /* not evaluable: assume it passes */
      }
    }
  });
  return cases;
};

// ---------- step simulation ----------
const NODE: Record<string, [string, string]> = {
  "16": ["16.20.2", "8.19.4"],
  "18": ["18.20.4", "10.7.0"],
  "20": ["20.17.0", "10.8.2"],
  "22": ["22.9.0", "10.8.3"],
};
const DEFAULT_NODE = "20";

const nodeMajor = (v: string) => {
  const s = String(v).trim().replace(/^v/, "");
  if (/^lts/.test(s) || s === "latest" || s === "node") return "20";
  return s.split(".")[0];
};

/** Minimal "engines.node" check: >=X, ^X, ~X, X, X.x → minimum major (and maximum for ^/~/X). */
const engineOk = (range: string, major: number) =>
  range.split("||").some((part) => {
    const p = part.trim();
    let m: RegExpExecArray | null;
    if ((m = />=\s*v?(\d+)/.exec(p))) {
      const max = /<\s*v?(\d+)/.exec(p);
      return major >= Number(m[1]) && (!max || major < Number(max[1]));
    }
    if ((m = /^[\^~]?\s*v?(\d+)(\.[\dx*]+)*$/.exec(p))) return major === Number(m[1]);
    return true;
  });

type JobEnv = {
  ws: Tree | null;
  wsPath: string;
  node: string;
  npm: string;
  npmInstalled: boolean;
  aws: { region: string; account: string } | null;
  logins: Set<string>;
  built: Set<string>;
  idToken: boolean;
  x: ExprCtx;
  server: Server;
  sha: string;
  tree: Tree;
  runId: number;
  pushed: string[];
};

type StepOut = { ok: boolean; log: string[]; secs: number };
const ok = (log: string[], secs = 1): StepOut => ({ ok: true, log, secs });
const bad = (log: string[], secs = 1): StepOut => ({ ok: false, log, secs });

const registryOf = (image: string) => {
  const first = image.split("/")[0];
  return image.includes("/") && /[.:]/.test(first) ? first : "docker.io";
};

const npmErr = (j: JobEnv) => (Number(j.npm.split(".")[0]) >= 10 ? "npm error" : "npm ERR!");

const readPkg = (j: JobEnv): { pkg?: Record<string, unknown>; err?: string[] } => {
  const e = npmErr(j);
  const raw = j.ws?.["package.json"];
  if (raw === undefined)
    return {
      err: [
        `${e} code ENOENT`,
        `${e} syscall open`,
        `${e} path ${j.wsPath}/package.json`,
        `${e} errno -2`,
        `${e} enoent Could not read package.json: Error: ENOENT: no such file or directory, open '${j.wsPath}/package.json'`,
        `${e} enoent This is related to npm not being able to find a file.`,
      ],
    };
  try {
    return { pkg: JSON.parse(raw) };
  } catch (err) {
    return { err: [`${e} code EJSONPARSE`, `${e} JSON.parse Invalid package.json: ${(err as Error).message}`] };
  }
};

const npmInstall = (j: JobEnv, ci: boolean): StepOut => {
  const e = npmErr(j);
  const { pkg, err } = readPkg(j);
  if (!pkg) return bad([...err!, "", "##[error]Process completed with exit code 254."]);
  if (ci && j.ws!["package-lock.json"] === undefined)
    return bad([
      `${e} code EUSAGE`,
      e,
      `${e} The \`npm ci\` command can only install with an existing package-lock.json or`,
      `${e} npm-shrinkwrap.json with lockfileVersion >= 1. Run an install with npm@5 or`,
      `${e} later to generate a package-lock.json file, then try again.`,
      "",
      "##[error]Process completed with exit code 1.",
    ]);
  const engines = (pkg.engines as Record<string, string> | undefined)?.node;
  const major = Number(nodeMajor(j.node));
  const strict = /engine-strict\s*=\s*true/.test(j.ws![".npmrc"] ?? "");
  const out: string[] = [];
  if (engines && !engineOk(engines, major)) {
    const lines = [
      `code EBADENGINE`,
      `engine Unsupported engine`,
      `engine Not compatible with your version of node/npm: ${pkg.name ?? "app"}@${pkg.version ?? "1.0.0"}`,
      `notsup Required: {"node":"${engines}"}`,
      `notsup Actual:   {"npm":"${j.npm}","node":"v${j.node}"}`,
    ];
    if (strict) return bad([...lines.map((l) => `${e} ${l}`), "", `${e} A complete log of this run can be found in: /home/runner/.npm/_logs/debug-0.log`, "##[error]Process completed with exit code 1."], 4);
    out.push(`npm WARN EBADENGINE Unsupported engine {`, `npm WARN EBADENGINE   package: '${pkg.name}@${pkg.version}',`, `npm WARN EBADENGINE   required: { node: '${engines}' },`, `npm WARN EBADENGINE   current: { node: 'v${j.node}', npm: '${j.npm}' }`, `npm WARN EBADENGINE }`);
  }
  j.npmInstalled = true;
  const deps = Object.keys({ ...((pkg.dependencies as object) ?? {}), ...((pkg.devDependencies as object) ?? {}) }).length;
  const n = 40 + deps * 67;
  return ok([...out, "", `added ${n} packages, and audited ${n + 1} packages in 7s`, "", `${Math.floor(n / 6)} packages are looking for funding`, "  run `npm fund` for details", "", "found 0 vulnerabilities"], 8);
};

const runTests = (j: JobEnv, script: string): StepOut => {
  const fns = collectFns(j.ws!);
  const files = Object.keys(j.ws!).filter((p) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(p) && !p.startsWith("node_modules/")).sort();
  const vitest = /vitest/.test(script);
  if (!files.length)
    return bad([vitest ? "No test files found, exiting with code 1" : "No tests found, exiting with code 1", "Run with `--passWithNoTests` to exit with code 0", "", "##[error]Process completed with exit code 1."]);
  const out: string[] = [];
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  for (const f of files) {
    const cases = runTestFile(j.ws![f], fns);
    const fileOk = cases.every((c) => c.ok);
    out.push(`${fileOk ? "PASS" : "FAIL"} ${f}`);
    for (const c of cases) {
      out.push(`  ${c.ok ? "✓" : "✕"} ${c.name} (${2 + (c.name.length % 5)} ms)`);
      if (c.ok) passed++;
      else {
        failed++;
        failures.push(
          `  ● ${c.name}`,
          "",
          "    expect(received).toBe(expected) // Object.is equality",
          "",
          `    Expected: ${c.expected}`,
          `    Received: ${c.received}`,
          "",
          `      at Object.toBe (${f}:${c.line}:${20})`,
          "",
        );
      }
    }
  }
  const suitesFailed = files.filter((f) => runTestFile(j.ws![f], fns).some((c) => !c.ok)).length;
  out.push("", ...failures);
  out.push(
    `Test Suites: ${suitesFailed ? `${suitesFailed} failed, ` : ""}${files.length - suitesFailed ? `${files.length - suitesFailed} passed, ` : ""}${files.length} total`,
    `Tests:       ${failed ? `${failed} failed, ` : ""}${passed ? `${passed} passed, ` : ""}${passed + failed} total`,
    "Snapshots:   0 total",
    "Time:        1.284 s",
    "Ran all test suites.",
  );
  if (failed) return bad([...out, "##[error]Process completed with exit code 1."], 5);
  return ok(out, 5);
};

const npmRun = (j: JobEnv, name: string): StepOut => {
  const e = npmErr(j);
  const { pkg, err } = readPkg(j);
  if (!pkg) return bad([...err!, "", "##[error]Process completed with exit code 254."]);
  const scripts = (pkg.scripts as Record<string, string>) ?? {};
  const script = scripts[name];
  if (!script)
    return bad([`${e} Missing script: "${name}"`, e, `${e} To see a list of scripts, run:`, `${e}   npm run`, "", "##[error]Process completed with exit code 1."]);
  const head = ["", `> ${pkg.name ?? "app"}@${pkg.version ?? "1.0.0"} ${name}`, `> ${script}`, ""];
  const bin = script.split(/\s+/)[0];
  const deps = { ...((pkg.dependencies as object) ?? {}), ...((pkg.devDependencies as object) ?? {}) } as Record<string, string>;
  if (bin in deps && !j.npmInstalled) return bad([...head, `sh: 1: ${bin}: not found`, "##[error]Process completed with exit code 127."]);
  if (/\b(jest|vitest|mocha)\b|node --test/.test(script)) {
    const r = runTests(j, script);
    return { ...r, log: [...head, ...r.log] };
  }
  if (/\b(vite|tsc|webpack|next|react-scripts)\b/.test(script))
    return ok([...head, "vite v5.4.8 building for production...", "✓ 42 modules transformed.", "dist/index.html                  0.46 kB │ gzip:  0.30 kB", "dist/assets/index-DiwrgTda.js  143.36 kB │ gzip: 46.09 kB", "✓ built in 1.84s"], 6);
  if (/\beslint\b/.test(script)) return ok([...head, ""], 3);
  if (/^echo /.test(script)) return ok([...head, script.slice(5).replace(/^['"]|['"]$/g, "")]);
  if (/exit 1/.test(script)) return bad([...head, "##[error]Process completed with exit code 1."]);
  return ok(head, 2);
};

const dockerCmd = (j: JobEnv, argv: string[]): StepOut => {
  const [sub, ...rest] = argv[0] === "buildx" ? argv.slice(1) : argv;
  if (sub === "build") {
    const tags: string[] = [];
    let file = "Dockerfile";
    let ctx = ".";
    let pushFlag = false;
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "-t" || rest[i] === "--tag") tags.push(rest[++i]);
      else if (rest[i] === "-f" || rest[i] === "--file") file = rest[++i];
      else if (rest[i] === "--push") pushFlag = true;
      else if (!rest[i].startsWith("-")) ctx = rest[i];
    }
    const path = (ctx === "." ? "" : ctx.replace(/^\.\//, "").replace(/\/$/, "") + "/") + file.replace(/^\.\//, "");
    if (!j.ws || j.ws[path] === undefined)
      return bad(["#0 building with \"default\" instance using docker driver", "", "#1 [internal] load build definition from Dockerfile", "#1 transferring dockerfile: 2B done", "#1 DONE 0.0s", `ERROR: failed to solve: failed to read dockerfile: open ${file}: no such file or directory`, "##[error]Process completed with exit code 1."]);
    for (const t of tags) j.built.add(t);
    const out = ["#1 [internal] load build definition from Dockerfile", "#1 DONE 0.0s", "#5 [2/4] WORKDIR /app", "#6 [3/4] COPY package*.json ./", "#7 [4/4] RUN npm ci --omit=dev", "#8 exporting to image", ...tags.map((t) => `#8 naming to ${t} done`), "#8 DONE 1.9s"];
    if (pushFlag) for (const t of tags) {
      const r = dockerCmd(j, ["push", t]);
      if (!r.ok) return { ...r, log: [...out, ...r.log] };
      out.push(...r.log);
    }
    return ok(out, 25);
  }
  if (sub === "push") {
    const image = rest.find((a) => !a.startsWith("-")) ?? "";
    if (!j.built.has(image)) return bad([`An image does not exist locally with the tag: ${image}`, "##[error]Process completed with exit code 1."]);
    const reg = registryOf(image);
    if (!j.logins.has(reg))
      return bad([`The push refers to repository [${image.split(":")[0]}]`, reg.includes(".ecr.") ? "no basic auth credentials" : "unauthorized: authentication required", "##[error]Process completed with exit code 1."]);
    j.pushed.push(image);
    return ok([`The push refers to repository [${image.split(":")[0]}]`, "5f70bf18a086: Pushed", `${image.split(":")[1] ?? "latest"}: digest: sha256:4c2d7e1b9a0f3e8d6c5b4a3928170f6e5d4c3b2a1908f7e6d5c4b3a291807f6e size: 1570`], 6);
  }
  if (sub === "login") {
    const reg = rest.filter((a) => !a.startsWith("-")).pop() ?? "docker.io";
    j.logins.add(reg);
    return ok(["WARNING! Your password will be stored unencrypted in /home/runner/.docker/config.json.", "Login Succeeded"]);
  }
  return ok([], 1);
};

const runScript = (j: JobEnv, script: string): StepOut => {
  const log: string[] = [];
  let secs = 1;
  const cmds = script
    .split("\n")
    .flatMap((l) => l.split("&&"))
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
  for (const c of cmds) {
    const argv = c.split(/\s+/);
    let r: StepOut;
    if (/^npm (ci|clean-install)\b/.test(c)) r = npmInstall(j, true);
    else if (/^npm (install|i)\b/.test(c)) r = npmInstall(j, false);
    else if (/^npm (test|t)\b/.test(c)) r = npmRun(j, "test");
    else if (/^npm run(-script)? /.test(c)) r = npmRun(j, argv[2]);
    else if (/^node (-v|--version)/.test(c)) r = ok([`v${j.node}`]);
    else if (/^npm (-v|--version)/.test(c)) r = ok([j.npm]);
    else if (argv[0] === "docker") r = dockerCmd(j, argv.slice(1));
    else if (argv[0] === "echo") r = ok([c.slice(5).replace(/^['"]|['"]$/g, "")]);
    else if (argv[0] === "exit") r = Number(argv[1] ?? 0) ? bad([`##[error]Process completed with exit code ${argv[1]}.`]) : ok([]);
    else if (argv[0] === "aws")
      r = j.aws ? ok([]) : bad(['Unable to locate credentials. You can configure credentials by running "aws configure".', "##[error]Process completed with exit code 253."]);
    else if (argv[0] === "cat") r = j.ws?.[argv[1]] !== undefined ? ok(j.ws![argv[1]].split("\n")) : bad([`cat: ${argv[1]}: No such file or directory`, "##[error]Process completed with exit code 1."]);
    else if (argv[0] === "ls") r = ok(j.ws ? [...new Set(Object.keys(j.ws).map((p) => p.split("/")[0]))].sort() : []);
    else r = ok([]);
    log.push(...r.log);
    secs += r.secs;
    if (!r.ok) return bad(log, secs);
  }
  return ok(log, secs);
};

const withOf = (step: Record<string, unknown>, x: ExprCtx) =>
  Object.fromEntries(Object.entries((step.with as Record<string, unknown>) ?? {}).map(([k, v]) => [k, subst(v, x)]));

const runAction = (j: JobEnv, uses: string, w: Record<string, string>): StepOut => {
  const [name] = uses.split("@");
  switch (name) {
    case "actions/checkout":
      j.ws = { ...j.tree };
      return ok([
        `Syncing repository: ${j.server.slug}`,
        "Getting Git version info",
        `Initializing the repository`,
        `Fetching the repository`,
        `Determining the checkout info`,
        `/usr/bin/git checkout --progress --force ${j.sha}`,
        `HEAD is now at ${short(j.sha)}`,
      ]);
    case "actions/setup-node": {
      const want = w["node-version"] || (w["node-version-file"] ? j.ws?.[w["node-version-file"]]?.trim() ?? "" : "");
      if (w["node-version-file"] && !want) return bad([`Error: The specified node version file at: ${j.wsPath}/${w["node-version-file"]} does not exist`]);
      const major = want ? nodeMajor(want) : DEFAULT_NODE;
      const v = NODE[major] ?? [`${major}.0.0`, "10.8.2"];
      const log = want ? [`Attempting to download ${want}...`, `Found in cache @ /opt/hostedtoolcache/node/${v[0]}/x64`] : ["Node version not specified, using the version preinstalled on the runner"];
      if (w.cache) {
        if (!j.ws) return bad([...log, `Error: Dependencies lock file is not found in ${j.wsPath}. Supported file patterns: package-lock.json,npm-shrinkwrap.json,yarn.lock`]);
        if (w.cache === "npm" && j.ws["package-lock.json"] === undefined && j.ws["npm-shrinkwrap.json"] === undefined)
          return bad([...log, `Error: Dependencies lock file is not found in ${j.wsPath}. Supported file patterns: package-lock.json,npm-shrinkwrap.json,yarn.lock`]);
      }
      j.node = v[0];
      j.npm = v[1];
      return ok([...log, "Environment details", `  node: v${v[0]}`, `  npm: ${v[1]}`, "  yarn: 1.22.22", ...(w.cache ? [`${w.cache} cache is not found`] : [])], 3);
    }
    case "docker/setup-buildx-action":
    case "docker/setup-qemu-action":
      return ok(["Docker info", "Creating a new builder instance", "Booting builder", "Buildx version: github.com/docker/buildx v0.17.1"], 4);
    case "docker/login-action": {
      const reg = w.registry || "docker.io";
      if (/\.dkr\.ecr\./.test(reg) && !w.username) {
        if (!j.aws) return bad(["Error: Could not load credentials from any providers"]);
        j.logins.add(reg);
        return ok([`Retrieving registries data through AWS SDK...`, `Logging into ${reg}...`, "Login Succeeded!"]);
      }
      if (!w.username || !w.password) return bad(["Error: Username and password required"]);
      j.logins.add(reg);
      return ok([`Logging into ${reg}...`, "Login Succeeded!"], 2);
    }
    case "aws-actions/configure-aws-credentials": {
      if (!w["aws-region"]) return bad(["Error: Input required and not supplied: aws-region"]);
      const role = w["role-to-assume"];
      const keys = w["aws-access-key-id"] && w["aws-secret-access-key"];
      if (role) {
        if (!j.idToken)
          return bad([
            "It looks like you might be trying to authenticate with OIDC. Did you mean to set the `id-token` permission? If you are not trying to authenticate with OIDC and the action is working successfully, you can ignore this message.",
            "Error: Credentials could not be loaded, please check your action inputs: Could not load credentials from any providers",
          ]);
        const m = /^arn:aws:iam::(\d{12}):role\/[\w+=,.@/-]+$/.exec(role);
        if (!m) return bad(["Assuming role with OIDC", "Error: Could not assume role with OIDC: Request ARN is invalid"]);
        j.aws = { region: w["aws-region"], account: m[1] };
        return ok(["Assuming role with OIDC", `Authenticated as assumedRoleId AROA3XFRBF23EXAMPLE:GitHubActions`], 2);
      }
      if (!keys) return bad(["Error: Credentials could not be loaded, please check your action inputs: Could not load credentials from any providers"]);
      j.aws = { region: w["aws-region"], account: "123456789012" };
      return ok(["Proceeding with IAM user credentials"]);
    }
    case "aws-actions/amazon-ecr-login": {
      if (!j.aws) return bad(["Error: Could not load credentials from any providers"]);
      const reg = `${j.aws.account}.dkr.ecr.${j.aws.region}.amazonaws.com`;
      j.logins.add(reg);
      return ok([`Logging into registry ${reg}`, "Login Succeeded!"], 2);
    }
    case "docker/build-push-action": {
      const tags = (w.tags ?? "").split(/[\n,]/).map((t) => t.trim()).filter(Boolean);
      const push = w.push === "true";
      const ctxTree = w.context ? j.ws : j.tree;
      const ctx = !w.context || w.context === "." ? "" : w.context.replace(/^\.\//, "").replace(/\/$/, "") + "/";
      const file = w.file ? w.file.replace(/^\.\//, "") : `${ctx}Dockerfile`;
      if (!ctxTree || ctxTree[file] === undefined)
        return bad(["#1 [internal] load build definition from Dockerfile", `ERROR: failed to solve: failed to read dockerfile: open ${file.split("/").pop()}: no such file or directory`, "Error: buildx failed with: ERROR: failed to solve: failed to read dockerfile"], 3);
      if (push && !tags.length) return bad(["ERROR: tag is needed when pushing to registry", "Error: buildx failed with: ERROR: tag is needed when pushing to registry"]);
      const log = ["#1 [internal] load build definition from Dockerfile", "#1 DONE 0.1s", "#6 [2/4] WORKDIR /app", "#7 [3/4] COPY . .", "#8 [4/4] RUN npm ci --omit=dev", "#8 DONE 9.3s", "#9 exporting to image"];
      for (const t of tags) {
        j.built.add(t);
        if (push) {
          const reg = registryOf(t);
          if (!j.logins.has(reg))
            return bad([...log, `#9 pushing layers`, `#9 ERROR: failed to push ${t}: unexpected status from HEAD request to https://${reg}/v2/: 401 Unauthorized`, `Error: buildx failed with: ERROR: failed to solve: failed to push ${t}: 401 Unauthorized`], 20);
          j.pushed.push(t);
          log.push(`#9 pushing manifest for ${t}@sha256:9b1c2d7e0f3a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f9a0b1c2d3e done`);
        } else log.push(`#9 naming to ${t} done`);
      }
      log.push("#9 DONE 4.2s");
      return ok(log, 35);
    }
    default:
      return ok([`Download action repository '${uses}' (SHA:${"8e5e7e5ab8b370d6c329ec480221332ada57f0ab".slice(0, 40)})`], 2);
  }
};

// ---------- workflow evaluation ----------
type WfEvent = { event: string; refName: string; refType: "branch" | "tag"; sha: string };

const glob = (pat: string, s: string) => new RegExp("^" + pat.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "§§").replace(/\*/g, "[^/]*").replace(/§§/g, ".*") + "$").test(s);
const list = (v: unknown) => (Array.isArray(v) ? v.map(String) : v === undefined || v === null ? undefined : [String(v)]);

/** Does this workflow's `on:` block fire for the event? */
export const triggers = (on: unknown, ev: WfEvent) => {
  if (typeof on === "string") return on === ev.event;
  if (Array.isArray(on)) return on.includes(ev.event);
  if (!on || typeof on !== "object") return false;
  const obj = on as Record<string, unknown>;
  if (!(ev.event in obj)) return false;
  if (ev.event !== "push" && ev.event !== "pull_request") return true;
  const cfg = (obj[ev.event] ?? {}) as Record<string, unknown>;
  const branches = list(cfg.branches);
  const branchesIgnore = list(cfg["branches-ignore"]);
  const tags = list(cfg.tags);
  const tagsIgnore = list(cfg["tags-ignore"]);
  if (ev.refType === "tag") {
    if (tags) return tags.some((t) => glob(t, ev.refName));
    if (tagsIgnore) return !tagsIgnore.some((t) => glob(t, ev.refName));
    return !branches && !branchesIgnore;
  }
  if (branches) return branches.some((b) => glob(b, ev.refName));
  if (branchesIgnore) return !branchesIgnore.some((b) => glob(b, ev.refName));
  return !tags && !tagsIgnore;
};

export type ParsedWorkflow = { ok: boolean; wf: Record<string, unknown>; name: string; error?: string; line?: number };

export const parseWorkflow = (file: string, content: string): ParsedWorkflow => {
  const doc = YAML.parseDocument(content, { prettyErrors: true });
  if (doc.errors.length) {
    const e = doc.errors[0];
    const line = e.linePos?.[0]?.line;
    return { ok: false, wf: {}, name: file, line, error: `You have an error in your yaml syntax on line ${line ?? 1}` };
  }
  const wf = doc.toJS() as Record<string, unknown>;
  const name = typeof wf?.name === "string" ? wf.name : file;
  if (!wf || typeof wf !== "object") return { ok: false, wf: {}, name: file, error: "The workflow is not valid. Unexpected value" };
  if (wf.on === undefined) return { ok: false, wf: {}, name, error: "The workflow is not valid. Required property is missing: on" };
  if (!wf.jobs || typeof wf.jobs !== "object") return { ok: false, wf: {}, name, error: "The workflow is not valid. Required property is missing: jobs" };
  for (const [id, job] of Object.entries(wf.jobs as Record<string, Record<string, unknown>>)) {
    if (!job || typeof job !== "object") return { ok: false, wf: {}, name, error: `The workflow is not valid. .github/workflows: Job '${id}' is invalid` };
    if (!job["runs-on"] && !job.uses) return { ok: false, wf: {}, name, error: `The workflow is not valid. Job '${id}': Required property is missing: runs-on` };
    for (const n of list(job.needs) ?? []) if (!(n in (wf.jobs as object))) return { ok: false, wf: {}, name, error: `The workflow is not valid. Job '${id}' depends on unknown job '${n}'.` };
    if (!job.uses && !Array.isArray(job.steps)) return { ok: false, wf: {}, name, error: `The workflow is not valid. Job '${id}': Required property is missing: steps` };
  }
  return { ok: true, wf, name };
};

const expandMatrix = (job: Record<string, unknown>): Record<string, unknown>[] => {
  const matrix = (job.strategy as Record<string, unknown> | undefined)?.matrix as Record<string, unknown> | undefined;
  if (!matrix) return [{}];
  let combos: Record<string, unknown>[] = [{}];
  for (const [k, v] of Object.entries(matrix)) {
    if (k === "include" || k === "exclude" || !Array.isArray(v)) continue;
    combos = combos.flatMap((c) => v.map((val) => ({ ...c, [k]: val })));
  }
  return combos;
};

const topo = (jobs: Record<string, Record<string, unknown>>) => {
  const order: string[] = [];
  const visit = (id: string, seen: Set<string>) => {
    if (order.includes(id) || seen.has(id)) return;
    seen.add(id);
    for (const n of list(jobs[id].needs) ?? []) visit(n, seen);
    order.push(id);
  };
  for (const id of Object.keys(jobs)) visit(id, new Set());
  return order;
};

const stepName = (s: Record<string, unknown>, x: ExprCtx) =>
  s.name ? subst(s.name, x) : s.uses ? `Run ${s.uses}` : `Run ${String(s.run ?? "").trim().split("\n")[0]}`;

const evaluateRun = (sh: Shell, server: Server, tree: Tree, file: string, parsed: ParsedWorkflow, ev: WfEvent, run: Run) => {
  const st = ghState(sh);
  run.jobs = [];
  run.missingSecrets = [];
  if (!parsed.ok) {
    run.invalid = `Invalid workflow file: ${file}${parsed.line ? `#L${parsed.line}` : ""}\n${parsed.error}`;
    run.conclusion = "failure";
    return;
  }
  run.invalid = undefined;
  const wf = parsed.wf;
  const secrets = Object.fromEntries(Object.entries(secretsOf(sh, server.slug)).map(([k, v]) => [k, v.value]));
  const repoName = server.slug.split("/")[1];
  const github = {
    sha: ev.sha,
    ref: `refs/${ev.refType === "tag" ? "tags" : "heads"}/${ev.refName}`,
    ref_name: ev.refName,
    ref_type: ev.refType,
    repository: server.slug,
    repository_owner: server.slug.split("/")[0],
    actor: "danylo",
    event_name: ev.event,
    run_id: String(run.id),
    run_number: String(run.number),
    workspace: `/home/runner/work/${repoName}/${repoName}`,
  };
  const missing = new Set<string>();
  const jobs = wf.jobs as Record<string, Record<string, unknown>>;
  const results: Record<string, Conclusion> = {};
  for (const id of topo(jobs)) {
    const job = jobs[id];
    const needs = list(job.needs) ?? [];
    for (const matrix of expandMatrix(job)) {
      const x: ExprCtx = { secrets, github, matrix, env: {}, outputs: {}, missing };
      const displayName = (job.name ? subst(job.name, x) : id) + (Object.keys(matrix).length ? ` (${Object.values(matrix).join(", ")})` : "");
      const jr: JobRun = { id: st.nextJob++, name: displayName, conclusion: "success", steps: [], secs: 0 };
      run.jobs.push(jr);
      const needsFailed = needs.some((n) => results[n] !== "success");
      if (needsFailed || !condition(job.if, x, false)) {
        jr.conclusion = "skipped";
        results[id] = results[id] === "failure" ? "failure" : "skipped";
        continue;
      }
      x.env = Object.fromEntries(Object.entries({ ...((wf.env as object) ?? {}), ...((job.env as object) ?? {}) }).map(([k, v]) => [k, subst(v, x)]));
      const perms = (job.permissions ?? wf.permissions) as Record<string, string> | string | undefined;
      const j: JobEnv = {
        ws: null,
        wsPath: github.workspace,
        node: NODE[DEFAULT_NODE][0],
        npm: NODE[DEFAULT_NODE][1],
        npmInstalled: false,
        aws: null,
        logins: new Set(),
        built: new Set(),
        idToken: perms === "write-all" || (typeof perms === "object" && perms?.["id-token"] === "write"),
        x,
        server,
        sha: ev.sha,
        tree,
        runId: run.id,
        pushed: [],
      };
      jr.steps.push({ name: "Set up job", conclusion: "success", secs: 1, log: ["Current runner version: '2.319.1'", "Operating System", "  Ubuntu", "  22.04.5", "LTS", `Runner Image`, `  Image: ${String(job["runs-on"])}`, `GITHUB_TOKEN Permissions`, ...(j.idToken ? ["  IdToken: write"] : []), "  Contents: read"] });
      let failed = false;
      for (const s of job.steps as Record<string, unknown>[]) {
        const name = stepName(s, x);
        if (!condition(s.if, x, failed)) {
          jr.steps.push({ name, conclusion: "skipped", log: [], secs: 0 });
          continue;
        }
        const stepEnv = Object.fromEntries(Object.entries((s.env as object) ?? {}).map(([k, v]) => [k, subst(v, x)]));
        const prevEnv = x.env;
        x.env = { ...x.env, ...stepEnv };
        let r: StepOut;
        if (s.uses) {
          const w = withOf(s, x);
          r = runAction(j, String(s.uses), w);
          r.log = [`##[group]Run ${s.uses}`, ...Object.entries(w).map(([k, v]) => `with:\n  ${k}: ${/secret|password|token|key/i.test(k) && v ? "***" : v}`), "##[endgroup]", ...r.log];
          if (String(s.uses).startsWith("aws-actions/amazon-ecr-login") && r.ok && j.aws && s.id) x.outputs[String(s.id)] = { registry: `${j.aws.account}.dkr.ecr.${j.aws.region}.amazonaws.com` };
          if (!r.ok && !r.log.some((l) => l.startsWith("##[error]"))) r.log.push(`##[error]${r.log[r.log.length - 1].replace(/^Error: /, "")}`);
        } else {
          const script = subst(s.run, x);
          r = runScript(j, script);
          r.log = [`##[group]Run ${script.trim().split("\n")[0]}`, ...script.trim().split("\n"), "shell: /usr/bin/bash -e {0}", ...(Object.keys(stepEnv).length ? ["env:", ...Object.keys(stepEnv).map((k) => `  ${k}: ***`)] : []), "##[endgroup]", ...r.log];
        }
        x.env = prevEnv;
        jr.steps.push({ name, conclusion: r.ok ? "success" : "failure", log: r.log, secs: r.secs });
        if (!r.ok && !s["continue-on-error"]) {
          failed = true;
          jr.annotation = r.log.filter((l) => l.startsWith("##[error]")).pop()?.slice(9) ?? "Process completed with exit code 1.";
        }
      }
      jr.steps.push({ name: "Complete job", conclusion: "success", secs: 0, log: ["Cleaning up orphan processes"] });
      jr.secs = jr.steps.reduce((a, s) => a + s.secs, 0);
      jr.conclusion = failed ? "failure" : "success";
      st.images.push(...(failed ? [] : j.pushed));
      results[id] = results[id] === "failure" || failed ? "failure" : "success";
    }
  }
  run.missingSecrets = [...missing];
  run.conclusion = run.jobs.some((jr) => jr.conclusion === "failure") ? "failure" : "success";
};

const createRun = (sh: Shell, server: Server, tree: Tree, file: string, parsed: ParsedWorkflow, ev: WfEvent): Run => {
  const st = ghState(sh);
  const run: Run = {
    id: st.nextRun,
    number: st.runs.filter((r) => r.slug === server.slug && r.file === file).length + 1,
    attempt: 1,
    workflow: parsed.name,
    file,
    event: ev.event,
    branch: ev.refName,
    refType: ev.refType,
    sha: ev.sha,
    title: commitOf(sh, ev.sha)?.message.split("\n")[0] ?? "",
    slug: server.slug,
    createdAt: Date.now(),
    conclusion: "success",
    jobs: [],
    missingSecrets: [],
  };
  st.nextRun += 1 + Math.floor(Math.random() * 40);
  evaluateRun(sh, server, tree, file, parsed, ev, run);
  st.runs.push(run);
  return run;
};

const workflowFiles = (tree: Tree) => Object.keys(tree).filter((p) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(p)).sort();

/** Evaluates every workflow of the pushed commit. Returns the created runs. */
export const triggerPush = (sh: Shell, ev: PushEvent) => {
  const rev = serverRev(sh, ev.server, ev.sha);
  if (!rev) return [];
  const out: Run[] = [];
  for (const file of workflowFiles(rev.tree)) {
    const parsed = parseWorkflow(file, rev.tree[file]);
    const wfEv: WfEvent = { event: "push", refName: ev.refName, refType: ev.refType, sha: ev.sha };
    if (parsed.ok && !triggers(parsed.wf.on, wfEv)) continue;
    out.push(createRun(sh, ev.server, rev.tree, file, parsed, wfEv));
  }
  return out;
};
pushHooks.push((sh, ev) => void triggerPush(sh, ev));

export const runsOf = (sh: Shell, slug?: string) => ghState(sh).runs.filter((r) => !slug || r.slug === slug);
export const latestRun = (sh: Shell, pred: (r: Run) => boolean = () => true) => [...ghState(sh).runs].reverse().find(pred);

// ---------- formatting ----------
const ago = (t: number) => {
  const s = Math.floor((Date.now() - t) / 1000);
  if (s < 60) return "less than a minute ago";
  const m = Math.floor(s / 60);
  if (m < 2) return "about 1 minute ago";
  if (m < 60) return `about ${m} minutes ago`;
  const h = Math.floor(m / 60);
  return h < 2 ? "about 1 hour ago" : `about ${h} hours ago`;
};
const dur = (s: number) => (s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${s % 60}s`);
const icon = (c: Conclusion | "in_progress") => (c === "success" ? "✓" : c === "failure" ? "X" : c === "in_progress" ? "*" : "-");
const runSecs = (r: Run) => r.jobs.reduce((a, j) => a + j.secs, 0) || 1;
const runIcon = (r: Run) => (runDone(r) ? icon(r.conclusion) : "*");

const viewRun = (r: Run, verbose: boolean, jobId?: number) => {
  const out = ["", `${runIcon(r)} ${r.branch} ${r.workflow} · ${r.id}${r.attempt > 1 ? ` (Attempt #${r.attempt})` : ""}`, `Triggered via ${r.event} ${ago(r.createdAt)}`, ""];
  if (!runDone(r)) {
    out.push("JOBS", ...r.jobs.map((j) => `* ${j.name} (ID ${j.id})`), "", `To see live progress, try: gh run watch ${r.id}`);
    return out.join("\n");
  }
  if (r.invalid) {
    const [head, detail] = r.invalid.split("\n");
    out.push("X This run likely failed because of a workflow file issue.", "", "ANNOTATIONS", `X ${detail}`, `${head.replace("Invalid workflow file: ", "")}`, "", `For more information, see: https://github.com/${r.slug}/actions/runs/${r.id}`);
    return out.join("\n");
  }
  const jobs = jobId ? r.jobs.filter((j) => j.id === jobId) : r.jobs;
  out.push("JOBS");
  for (const j of jobs) {
    out.push(`${icon(j.conclusion)} ${j.name} in ${dur(j.secs)} (ID ${j.id})`);
    if (verbose || jobId || j.conclusion === "failure") for (const s of j.steps) out.push(`  ${icon(s.conclusion)} ${s.name}`);
  }
  const ann = jobs.filter((j) => j.annotation);
  if (ann.length) {
    out.push("", "ANNOTATIONS");
    for (const j of ann) out.push(`X ${j.annotation}`, `${j.name}: .github#${1 + (j.id % 40)}`, "");
    out.pop();
  }
  out.push("");
  if (r.conclusion === "failure") out.push(`To see what failed, try: gh run view ${r.id} --log-failed`);
  else out.push("For more information about a job, try: gh run view --job=<job-id>");
  out.push(`View this run on GitHub: https://github.com/${r.slug}/actions/runs/${r.id}`);
  return out.join("\n");
};

const logLines = (r: Run, onlyFailed: boolean, jobId?: number) => {
  if (r.invalid) return r.invalid;
  const base = r.createdAt;
  const out: string[] = [];
  let t = 0;
  for (const j of r.jobs) {
    if (jobId && j.id !== jobId) continue;
    if (onlyFailed && j.conclusion !== "failure") continue;
    for (const s of j.steps) {
      if (onlyFailed && s.conclusion !== "failure") continue;
      for (const l of s.log) out.push(`${j.name}\t${s.name}\t${new Date(base + (t += 37)).toISOString().replace("Z", "0000Z")} ${l}`);
    }
  }
  return out.join("\n");
};

// ---------- gh command ----------
type Ctx = { sh: Shell; server?: Server; err?: string };
const repoCtx = (sh: Shell, flagRepo?: string): Ctx => {
  if (flagRepo) {
    const server = serverOf(sh, `https://github.com/${flagRepo}`, true);
    return server ? { sh, server } : { sh, err: `could not resolve to a Repository with the name '${flagRepo}'` };
  }
  const repo = findRepo(sh);
  if (!repo) return { sh, err: "failed to run git: fatal: not a git repository (or any of the parent directories): .git" };
  const url = repo.remotes.origin ?? Object.values(repo.remotes)[0];
  if (!url) return { sh, err: "no git remotes found" };
  const server = serverOf(sh, url, true);
  if (!server) return { sh, err: "none of the git remotes configured for this repository point to a known GitHub host. To tell gh about a new GitHub host, please use `gh auth login`" };
  return { sh, server };
};

const fail = (output: string): ToolResult => ({ output, ok: false });
const good = (output: string): ToolResult => ({ output, ok: true });

const pickRun = (sh: Shell, server: Server, idArg?: string): Run | string => {
  if (!idArg) {
    const r = latestRun(sh, (x) => x.slug === server.slug);
    return r ?? "found no runs";
  }
  if (!/^\d+$/.test(idArg)) return `invalid run ID: ${idArg}`;
  return ghState(sh).runs.find((x) => x.id === Number(idArg) && x.slug === server.slug) ?? `could not find any workflow run with ID ${idArg}`;
};

const serverWorkflows = (sh: Shell, server: Server) => {
  const rev = serverRev(sh, server, "HEAD");
  if (!rev) return [];
  return workflowFiles(rev.tree).map((file) => ({ file, parsed: parseWorkflow(file, rev.tree[file]), id: 11_000_000 + (file.length * 7919) % 900_000 }));
};

const runCmd = (sh: Shell, sub: string, pos: string[], flags: Record<string, string | true>, server: Server): ToolResult => {
  switch (sub) {
    case "list":
    case "ls": {
      let runs = runsOf(sh, server.slug).slice().reverse();
      const wf = typeof flags.workflow === "string" ? flags.workflow : typeof flags.w === "string" ? flags.w : undefined;
      if (wf) runs = runs.filter((r) => r.workflow === wf || r.file.endsWith("/" + wf));
      const br = typeof flags.branch === "string" ? flags.branch : typeof flags.b === "string" ? flags.b : undefined;
      if (br) runs = runs.filter((r) => r.branch === br);
      runs = runs.slice(0, Number(flags.L ?? flags.limit ?? 20));
      if (!runs.length) return good("no runs found");
      return good(
        table([
          ["STATUS", "TITLE", "WORKFLOW", "BRANCH", "EVENT", "ID", "ELAPSED", "AGE"],
          ...runs.map((r) => [runIcon(r), r.title.length > 40 ? r.title.slice(0, 39) + "…" : r.title, r.workflow, r.branch, r.event, String(r.id), dur(runSecs(r)), ago(r.createdAt)]),
        ]),
      );
    }
    case "view": {
      const jobId = flags.job ? Number(flags.job) : undefined;
      let r: Run | string;
      if (jobId && !pos[0]) r = ghState(sh).runs.find((x) => x.jobs.some((j) => j.id === jobId)) ?? `could not find job ${jobId}`;
      else r = pickRun(sh, server, pos[0]);
      if (typeof r === "string") return fail(r);
      if (flags.log || flags["log-failed"]) {
        if (!runDone(r)) return fail(`run ${r.id} is still in progress; logs will be available when it is complete`);
        sh.flags.add(`gh:log:${r.id}`);
        if (flags["log-failed"]) sh.flags.add(`gh:log-failed:${r.id}:${r.attempt}`);
        return good(logLines(r, !!flags["log-failed"], jobId));
      }
      sh.flags.add(`gh:view:${r.id}`);
      const out = viewRun(r, !!flags.verbose, jobId);
      return flags["exit-status"] && r.conclusion === "failure" ? fail(out) : good(out);
    }
    case "watch": {
      const r = pickRun(sh, server, pos[0]);
      if (typeof r === "string") return fail(r === "found no runs" ? "found no in progress runs to watch" : r);
      if (!runDone(r)) r.createdAt = Date.now() - RUN_MS;
      sh.flags.add(`gh:watch:${r.id}`);
      const body = viewRun(r, true).split("\n").filter((l) => !/^(To see|For more|View this)/.test(l));
      const out = [`Refreshing run status every 3 seconds. Press Ctrl+C to quit.`, ...body, `${icon(r.conclusion)} Run ${r.workflow} (${r.id}) completed with '${r.conclusion}'`].join("\n");
      return flags["exit-status"] && r.conclusion === "failure" ? fail(out) : good(out);
    }
    case "rerun": {
      const r = pickRun(sh, server, pos[0]);
      if (typeof r === "string") return fail(r);
      if (!runDone(r)) return fail(`run ${r.id} cannot be rerun; it is still in progress`);
      const rev = serverRev(sh, server, r.sha);
      if (!rev) return fail(`could not find commit ${r.sha}`);
      r.attempt++;
      r.createdAt = Date.now();
      evaluateRun(sh, server, rev.tree, r.file, parseWorkflow(r.file, rev.tree[r.file] ?? ""), { event: r.event, refName: r.branch, refType: r.refType, sha: r.sha }, r);
      return good(`✓ Requested rerun ${flags.failed ? "(failed jobs) " : ""}of run ${r.id}`);
    }
    case "cancel":
      return good(`✓ Request to cancel workflow ${pos[0] ?? ""} submitted.`);
    default:
      return fail(`unknown command "${sub}" for "gh run"`);
  }
};

const workflowCmd = (sh: Shell, sub: string, pos: string[], flags: Record<string, string | true>, server: Server): ToolResult => {
  const wfs = serverWorkflows(sh, server);
  switch (sub) {
    case "list":
    case "ls":
      if (!wfs.length) return fail("no workflows found");
      return good(table([["NAME", "STATE", "ID"], ...wfs.map((w) => [w.parsed.name, "active", String(w.id)])]));
    case "view": {
      const w = wfs.find((x) => x.parsed.name === pos[0] || x.file.endsWith("/" + pos[0]) || String(x.id) === pos[0]);
      if (!w) return fail(`could not find any workflows named ${pos[0]}`);
      const runs = runsOf(sh, server.slug).filter((r) => r.file === w.file).slice(-5).reverse();
      return good([`${w.parsed.name} - ${w.file.split("/").pop()}`, `ID: ${w.id}`, "", `Total runs ${runs.length}`, "Recent runs", ...runs.map((r) => `${icon(r.conclusion)}  ${r.title}  ${r.workflow}  ${r.branch}  ${r.event}  ${r.id}`)].join("\n"));
    }
    case "run": {
      const w = wfs.find((x) => x.parsed.name === pos[0] || x.file.endsWith("/" + pos[0]) || String(x.id) === pos[0]);
      if (!pos[0]) return fail("workflow ID, name, or filename required when not running interactively");
      if (!w) return fail(`could not find any workflows named ${pos[0]}`);
      if (!w.parsed.ok) return fail(`could not create workflow dispatch event: HTTP 422: ${w.parsed.error}`);
      if (!triggers(w.parsed.wf.on, { event: "workflow_dispatch", refName: "", refType: "branch", sha: "" }))
        return fail(`could not create workflow dispatch event: HTTP 422: Workflow does not have 'workflow_dispatch' trigger (https://api.github.com/repos/${server.slug}/actions/workflows/${w.id}/dispatches)`);
      const ref = typeof flags.ref === "string" ? flags.ref : typeof flags.r === "string" ? flags.r : server.defaultBranch;
      const rev = serverRev(sh, server, ref);
      if (!rev) return fail(`could not create workflow dispatch event: HTTP 422: No ref found for: ${ref}`);
      const isTag = !!server.tags[ref];
      const parsed = parseWorkflow(w.file, rev.tree[w.file] ?? "");
      if (!rev.tree[w.file]) return fail(`could not create workflow dispatch event: HTTP 404: workflow ${w.file} not found on the default branch`);
      createRun(sh, server, rev.tree, w.file, parsed, { event: "workflow_dispatch", refName: ref, refType: isTag ? "tag" : "branch", sha: rev.sha });
      return good(`✓ Created workflow_dispatch event for ${w.file.split("/").pop()} at ${ref}\n\nTo see runs for this workflow, try: gh run list --workflow=${w.file.split("/").pop()}`);
    }
    default:
      return fail(`unknown command "${sub}" for "gh workflow"`);
  }
};

const secretCmd = (sh: Shell, sub: string, pos: string[], flags: Record<string, string | true>, server: Server, stdin?: string): ToolResult => {
  const secrets = secretsOf(sh, server.slug);
  switch (sub) {
    case "set": {
      const name = pos[0];
      if (!name) return fail("must pass name argument");
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || /^GITHUB_/i.test(name))
        return fail(`HTTP 422: Secret names can only contain alphanumeric characters ([a-z], [A-Z], [0-9]) or underscores (_), must not start with a number or GITHUB_ (${name})`);
      const body = typeof flags.body === "string" ? flags.body : typeof flags.b === "string" ? flags.b : stdin?.trim();
      if (body === undefined || body === "") return fail("no secret value provided: use --body <valor> or pipe it via stdin (gh secret set NAME < arquivo)");
      secrets[name.toUpperCase()] = { value: body, updated: Date.now() };
      return good(`✓ Set Actions secret ${name.toUpperCase()} for ${server.slug}`);
    }
    case "list":
    case "ls": {
      const names = Object.keys(secrets).sort();
      if (!names.length) return good("no secrets found");
      return good(table([["NAME", "UPDATED"], ...names.map((n) => [n, ago(secrets[n].updated)])]));
    }
    case "delete":
    case "remove": {
      if (!secrets[pos[0]]) return fail(`failed to delete secret ${pos[0]}: HTTP 404: Not Found`);
      delete secrets[pos[0]];
      return good(`✓ Deleted Actions secret ${pos[0]} from ${server.slug}`);
    }
    default:
      return fail(`unknown command "${sub}" for "gh secret"`);
  }
};

const SUBS: Record<string, string> = {
  run: "execuções do GitHub Actions: list, view (--log, --log-failed, --job), watch, rerun",
  workflow: "workflows do repositório: list, view, run (dispara workflow_dispatch)",
  secret: "secrets do Actions: set NOME --body valor, list, delete",
  auth: "status do login no GitHub (auth status)",
  repo: "informações do repositório (repo view)",
};

registerTool({
  name: "gh",
  summary: "GitHub CLI: GitHub Actions (runs, workflows) e secrets",
  subcommands: SUBS,
  flags: {
    "--log": "run view: mostra o log completo da execução",
    "--log-failed": "run view: mostra só o log dos steps que falharam",
    "--job": "run view: limita a um job (ID)",
    "--verbose": "run view: mostra os steps de todos os jobs",
    "--exit-status": "run watch/view: sai com erro se a execução falhou (útil em scripts)",
    "--body": "secret set: valor do secret",
    "-b": "secret set: valor do secret",
    "--ref": "workflow run: branch ou tag onde disparar",
    "--workflow": "run list: filtra por workflow",
    "-L": "run list: quantidade máxima de execuções",
    "-R": "usa outro repositório (OWNER/REPO)",
    "--failed": "run rerun: reexecuta só os jobs que falharam",
  },
  valueFlags: ["--body", "-b", "--job", "-L", "--limit", "--ref", "-r", "-R", "--repo", "-w", "--workflow", "--branch", "--env", "-e", "--json"],
  run: ({ sh, pos, flags, stdin }) => {
    const [group, sub, ...rest] = pos;
    if (!group) return `Work seamlessly with GitHub from the command line.\n\nUSAGE\n  gh <command> <subcommand> [flags]\n\nCORE COMMANDS\n${Object.entries(SUBS).map(([k, v]) => `  ${k.padEnd(10)} ${v}`).join("\n")}`;
    if (flags.version || group === "version") return "gh version 2.57.0 (2024-09-16)";
    if (!SUBS[group]) return fail(`unknown command "${group}" for "gh"`);
    if (group === "auth") {
      if (sub !== "status") return good("✓ Logged in to github.com account danylo (keyring)");
      return good("github.com\n  ✓ Logged in to github.com account danylo (keyring)\n  - Active account: true\n  - Git operations protocol: https\n  - Token: gho_************************************\n  - Token scopes: 'gist', 'read:org', 'repo', 'workflow'");
    }
    const ctx = repoCtx(sh, typeof flags.R === "string" ? flags.R : typeof flags.repo === "string" ? flags.repo : undefined);
    if (!ctx.server) return fail(ctx.err!);
    const server = ctx.server;
    if (!sub) return fail(`unknown command "" for "gh ${group}"`);
    if (group === "run") return runCmd(sh, sub, rest, flags, server);
    if (group === "workflow") return workflowCmd(sh, sub, rest, flags, server);
    if (group === "secret") return secretCmd(sh, sub, rest, flags, server, stdin);
    if (group === "repo")
      return good(`${server.slug}\nNo description provided\n\nbranches: ${Object.keys(server.branches).join(", ") || "(none)"}\ntags: ${Object.keys(server.tags).join(", ") || "(none)"}\nView this repository on GitHub: https://github.com/${server.slug}`);
    return fail(`unknown command "${sub}" for "gh ${group}"`);
  },
  explainError: (_cmd, output) => {
    if (/no git remotes found/.test(output)) return "O gh descobre o repositório pelo remoto do Git. Cadastre o remoto (git remote add origin <url>) ou passe -R dono/repo.";
    if (/not a git repository/.test(output)) return "Você não está dentro de um repositório Git, então o gh não sabe de qual repositório falar. Entre no diretório do projeto ou use -R dono/repo.";
    if (/workflow_dispatch/.test(output)) return "Esse workflow não aceita disparo manual. Adicione workflow_dispatch: ao bloco on: do YAML (e faça push) para poder usar gh workflow run.";
    if (/could not find any workflow run with ID|invalid run ID/.test(output)) return "Esse ID de execução não existe. Liste as execuções com gh run list e copie o valor da coluna ID.";
    if (/found no (in progress )?runs|no runs found/.test(output)) return "Ainda não há execuções. Workflows rodam quando você faz git push de um commit que contém .github/workflows/*.yml.";
    if (/could not find any workflows named/.test(output)) return "Não há workflow com esse nome na branch padrão do remoto. Veja os nomes com gh workflow list (vale o name: do YAML ou o nome do arquivo).";
    if (/no secret value provided/.test(output)) return "Informe o valor do secret: gh secret set NOME --body \"valor\". Nunca coloque o valor no YAML — ele fica no GitHub, criptografado.";
    if (/Secret names can only contain/.test(output)) return "Nome de secret inválido: use letras, números e _, sem começar com número nem com GITHUB_ (prefixo reservado).";
    if (/still in progress/.test(output)) return "A execução ainda está rodando. Acompanhe com gh run watch <id> e veja o log quando ela terminar.";
    if (/unknown command/.test(output)) return "Subcomando inexistente. Os grupos mais usados são gh run, gh workflow e gh secret — veja gh <grupo> para as opções.";
    return null;
  },
});
