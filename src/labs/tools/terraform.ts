// Terraform CLI plugin: a realistic mini Terraform (HCL parsing, plan diffs, local/S3 state,
// workspaces, locking, import, drift, moved blocks) on top of a fake AWS account.
import { registerTool } from "../registry";
import type { Shell } from "../shell";
import { closest, tokenize } from "../util";
import {
  type Backend, type Change, type ModCfg, type RunOpts, type RunResult, type TfState, type Attrs, type PlanSummary, type LockInfo,
  LOCAL, PROVIDER_VERSIONS, TF_VERSION, backendFromBlock, cloudKey, collectVars, createWorkspace, currentWorkspace, deleteWorkspace, emptyState,
  everInitialized, listWorkspaces, loadModule, lockPath, lockingEnabled, parseAddr, providersInstalled, readState, runEngine, sameBackend,
  setWorkspace, stateToJson, storedBackend, tfExt, validateModule, writeState, writeStoredBackend, Engine, EvalError,
} from "./terraform-engine";
import { type Diag, type Value, HclError, Unknown, fmtHcl, isObj, parseExpr, parseHcl, valEq } from "./terraform-hcl";

type Res = { output: string; ok: boolean };
const ok = (output: string): Res => ({ output, ok: true });
const bad = (output: string): Res => ({ output, ok: false });

// ---------------- args ----------------
const VALUE_OPTS = new Set(["var", "var-file", "target", "replace", "out", "backend-config", "chdir", "state", "lock-timeout", "parallelism"]);
class Opts {
  map = new Map<string, string[]>();
  pos: string[] = [];
  constructor(args: string[]) {
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a.startsWith("-") && a.length > 1) {
        const body = a.replace(/^--?/, "");
        const eq = body.indexOf("=");
        let name = body;
        let val = "true";
        if (eq > 0) {
          name = body.slice(0, eq);
          val = body.slice(eq + 1);
        } else if (VALUE_OPTS.has(name) && args[i + 1] !== undefined) val = args[++i];
        this.map.set(name, [...(this.map.get(name) ?? []), val]);
      } else this.pos.push(a);
    }
  }
  has(n: string) {
    const v = this.map.get(n);
    return !!v && v[v.length - 1] !== "false";
  }
  get(n: string) {
    const v = this.map.get(n);
    return v ? v[v.length - 1] : undefined;
  }
  all(n: string) {
    return this.map.get(n) ?? [];
  }
}

// ---------------- rendering ----------------
export const renderDiag = (sh: Shell, dir: string, d: Diag) => {
  const lines = [`${d.warning ? "Warning" : "Error"}: ${d.summary}`, ""];
  if (d.file && d.line) {
    lines.push(`  on ${d.file} line ${d.line}${d.ctx ? `, ${d.ctx}` : ""}:`);
    const src = sh.readFile(`${dir}/${d.file}`)?.split("\n")[d.line - 1];
    if (src !== undefined) lines.push(`${String(d.line).padStart(4)}: ${src}`);
    lines.push("");
  }
  lines.push(...d.detail.split("\n"));
  return ["╷", ...lines.map((l) => (l ? `│ ${l}` : "│ ")), "╵"].join("\n");
};
const renderDiags = (sh: Shell, dir: string, diags: Diag[]) => diags.map((d) => renderDiag(sh, dir, d)).join("\n");
const hasErrors = (diags: Diag[]) => diags.some((d) => !d.warning);

const fv = (v: Value | undefined): string =>
  v instanceof Unknown ? "(known after apply)"
  : v === undefined || v === null ? "null"
  : typeof v === "string" ? JSON.stringify(v)
  : typeof v !== "object" ? String(v)
  : Array.isArray(v) ? `[${v.map(fv).join(", ")}]`
  : `{ ${Object.entries(v).map(([k, x]) => `${k} = ${fv(x)}`).join(", ")} }`;

/** Multi-line HCL-ish value (outputs, state show, console). */
export const pretty = (v: Value, ind = 0): string => {
  const pad = " ".repeat(ind);
  if (Array.isArray(v)) return v.length ? `[\n${v.map((x) => `${pad}  ${pretty(x, ind + 2)},`).join("\n")}\n${pad}]` : "[]";
  if (isObj(v)) {
    const ks = Object.keys(v).sort();
    if (!ks.length) return "{}";
    const w = Math.max(...ks.map((k) => JSON.stringify(k).length));
    return `{\n${ks.map((k) => `${pad}  ${JSON.stringify(k).padEnd(w)} = ${pretty(v[k], ind + 2)}`).join("\n")}\n${pad}}`;
  }
  return fv(v);
};

const isBlockList = (v: Value | undefined): v is Attrs[] => Array.isArray(v) && v.length > 0 && v.every(isObj);

type Mode = "create" | "delete" | "update";
const renderAttrs = (b: Attrs | null, a: Attrs | null, mode: Mode, forces: string[], ind: number): string[] => {
  const pad = " ".repeat(ind);
  const keys = [...new Set([...Object.keys(b ?? {}), ...Object.keys(a ?? {})])].sort();
  type Row = { sym: string; key: string; val: string; after?: string[] };
  const rows: (Row | string[])[] = [];
  let hidden = 0;
  const mapRows = (sym: string, key: string, bm: Attrs | null, am: Attrs | null): Row => {
    const inner: string[] = [];
    const ks = [...new Set([...Object.keys(bm ?? {}), ...Object.keys(am ?? {})])].sort();
    const w = Math.max(0, ...ks.map((k) => JSON.stringify(k).length));
    let same = 0;
    for (const k of ks) {
      const q = JSON.stringify(k).padEnd(w);
      const bv = bm?.[k];
      const av = am?.[k];
      if (bm && am && valEq(bv, av)) same++;
      else if (av === undefined) inner.push(`${pad}    - ${q} = ${fv(bv)}${mode === "create" ? "" : " -> null"}`);
      else if (bv === undefined) inner.push(`${pad}    + ${q} = ${fv(av)}`);
      else inner.push(`${pad}    ~ ${q} = ${fv(bv)} -> ${fv(av)}`);
    }
    if (same) inner.push(`${pad}      # (${same} unchanged element${same > 1 ? "s" : ""} hidden)`);
    return { sym, key, val: "{", after: [...inner, `${pad}  }`] };
  };
  const block = (sym: string, key: string, bo: Attrs | null, ao: Attrs | null, m: Mode) => [
    `${pad}${sym} ${key} {`,
    ...renderAttrs(bo, ao, m, forces, ind + 4),
    `${pad}  }`,
  ];
  for (const k of keys) {
    const bv = b?.[k];
    const av = a?.[k];
    if (mode === "create") {
      if (av === undefined || av === null) continue;
      if (isBlockList(av)) av.forEach((o) => rows.push(block("+", k, null, o, "create")));
      else if (isObj(av)) rows.push(mapRows("+", k, null, av));
      else rows.push({ sym: "+", key: k, val: fv(av) });
      continue;
    }
    if (mode === "delete") {
      if (bv === undefined || bv === null) continue;
      if (isBlockList(bv)) bv.forEach((o) => rows.push(block("-", k, o, null, "delete")));
      else if (isObj(bv)) rows.push(mapRows("-", k, bv, null));
      else rows.push({ sym: "-", key: k, val: `${fv(bv)} -> null` });
      continue;
    }
    if (valEq(bv, av)) {
      if (["id", "bucket", "name"].includes(k) && typeof bv !== "object") rows.push({ sym: " ", key: k, val: fv(bv) });
      else hidden++;
      continue;
    }
    if (isBlockList(bv) || isBlockList(av)) {
      const bl = (isBlockList(bv) ? bv : []) as Attrs[];
      const al = (isBlockList(av) ? av : []) as Attrs[];
      for (let i = 0; i < Math.max(bl.length, al.length); i++) {
        if (bl[i] && al[i]) rows.push(block("~", k, bl[i], al[i], "update"));
        else if (al[i]) rows.push(block("+", k, null, al[i], "create"));
        else rows.push(block("-", k, bl[i], null, "delete"));
      }
      continue;
    }
    if (isObj(bv) || isObj(av)) {
      rows.push(mapRows(bv === undefined ? "+" : av === undefined ? "-" : "~", k, isObj(bv) ? bv : null, isObj(av) ? av : null));
      continue;
    }
    const force = forces.includes(k) ? " # forces replacement" : "";
    if (bv === undefined || bv === null) rows.push({ sym: "+", key: k, val: fv(av) + force });
    else if (av === undefined || av === null) rows.push({ sym: "-", key: k, val: `${fv(bv)} -> null` });
    else rows.push({ sym: "~", key: k, val: `${fv(bv)} -> ${fv(av)}${force}` });
  }
  const w = Math.max(0, ...rows.filter((r): r is Row => !Array.isArray(r)).map((r) => r.key.length));
  const out: string[] = [];
  for (const r of [...rows.filter((x) => !Array.isArray(x)), ...rows.filter((x) => Array.isArray(x))]) {
    if (Array.isArray(r)) out.push(...r);
    else {
      out.push(`${pad}${r.sym} ${r.key.padEnd(w)} = ${r.val}`);
      if (r.after) out.push(...r.after);
    }
  }
  if (hidden) out.push(`${pad}  # (${hidden} unchanged attribute${hidden > 1 ? "s" : ""} hidden)`);
  return out;
};

const SYM: Record<Change["action"], string> = { create: "  +", update: "  ~", replace: "-/+", delete: "  -", noop: "   " };

const renderChange = (c: Change, drift = false): string[] => {
  const p = parseAddr(c.addr);
  const head: string[] = [];
  if (drift) head.push(`  # ${c.addr} ${c.action === "delete" ? "has been deleted" : "has changed"}`);
  else if (c.action === "create") head.push(`  # ${c.addr} will be created`);
  else if (c.action === "update") head.push(`  # ${c.addr} will be updated in-place`);
  else if (c.action === "replace")
    head.push(c.reason === "requested" ? `  # ${c.addr} will be replaced, as requested` : c.reason === "tainted" ? `  # ${c.addr} is tainted, so must be replaced` : `  # ${c.addr} must be replaced`);
  else if (c.action === "delete") head.push(`  # ${c.addr} will be destroyed`, ...(c.reason === "not-in-config" ? [`  # (because ${c.addr} is not in configuration)`] : []));
  else if (c.importId) head.push(`  # ${c.addr} will be imported`);
  else if (c.movedFrom) head.push(`  # ${c.movedFrom} has moved to ${c.addr}`);
  if (c.action !== "noop" && c.movedFrom && !drift) head.push(`  # (moved from ${c.movedFrom})`);
  if (c.action !== "noop" && c.importId && !drift) head.push(`  # (imported from "${c.importId}")`);
  const mode: Mode = c.action === "create" ? "create" : c.action === "delete" ? "delete" : "update";
  return [...head, `${SYM[c.action]} resource "${c.type}" "${p?.name ?? c.addr}" {`, ...renderAttrs(c.before, c.after, mode, c.forces, 6), "    }"];
};

const outputChanges = (r: RunResult, destroy: boolean): string[] => {
  const out: string[] = [];
  const next = destroy ? {} : r.outputs;
  const names = [...new Set([...Object.keys(r.prevOutputs), ...Object.keys(next)])].sort();
  const w = Math.max(0, ...names.map((n) => n.length));
  const show = (o: { value: Value; sensitive: boolean }) => (o.sensitive ? "(sensitive value)" : fv(o.value));
  for (const n of names) {
    const b = r.prevOutputs[n];
    const a = next[n];
    if (!b && a) out.push(`  + ${n.padEnd(w)} = ${show(a)}`);
    else if (b && !a) out.push(`  - ${n.padEnd(w)} = ${show(b)} -> null`);
    else if (b && a && !valEq(b.value, a.value)) out.push(`  ~ ${n.padEnd(w)} = ${show(b)} -> ${show(a)}`);
  }
  return out;
};

const RULE = "─".repeat(77);

const renderPlan = (r: RunResult, opts: RunOpts): { text: string; noChanges: boolean } => {
  const L: string[] = [];
  if (r.drift.length) {
    L.push(
      "Note: Objects have changed outside of Terraform", "",
      "Terraform detected the following changes made outside of Terraform since the",
      'last "terraform apply" which may have affected this plan:', "",
    );
    for (const c of r.drift) L.push(...renderChange(c, true), "");
    if (opts.refreshOnly)
      L.push(
        "This is a refresh-only plan, so Terraform will not take any actions to undo",
        "these. If you were expecting these changes then you can apply this plan to",
        "record the updated values in the Terraform state without changing any remote",
        "objects.",
      );
    else
      L.push(
        "Unless you have made equivalent changes to your configuration, or ignored the",
        "relevant attributes using ignore_changes, the following plan may include",
        "actions to undo or respond to these changes.", "", RULE, "",
      );
  }
  if (opts.refreshOnly) {
    if (!r.drift.length)
      L.push(
        "No changes. Your infrastructure still matches the configuration.", "",
        "Terraform has checked that the real remote objects still match the result of",
        "your most recent changes, and found no differences.",
      );
    return { text: L.join("\n"), noChanges: !r.drift.length };
  }
  const visible = r.changes.filter((c) => c.action !== "noop" || c.movedFrom || c.importId);
  const outs = outputChanges(r, !!opts.destroy);
  if (!visible.length && !outs.length) {
    L.push(
      ...(opts.destroy
        ? ["No changes. No objects need to be destroyed.", "", "Either you have not created any objects yet or the existing objects were", "already deleted outside of Terraform."]
        : ["No changes. Your infrastructure matches the configuration.", "", "Terraform has compared your real infrastructure against your configuration", "and found no differences, so no changes are needed."]),
    );
    return { text: L.join("\n"), noChanges: true };
  }
  const acts = new Set(visible.map((c) => c.action));
  if (visible.length) {
    L.push("Terraform used the selected providers to generate the following execution", "plan. Resource actions are indicated with the following symbols:");
    if (acts.has("create")) L.push("  + create");
    if (acts.has("update")) L.push("  ~ update in-place");
    if (acts.has("delete")) L.push("  - destroy");
    if (acts.has("replace")) L.push("-/+ destroy and then create replacement");
    L.push("", "Terraform will perform the following actions:", "");
    for (const c of visible) L.push(...renderChange(c), "");
    const { add, change, destroy, imported } = r.counts;
    L.push(`Plan: ${imported ? `${imported} to import, ` : ""}${add} to add, ${change} to change, ${destroy} to destroy.`);
  }
  if (outs.length) L.push(...(visible.length ? [""] : []), "Changes to Outputs:", ...outs);
  if (!visible.length)
    L.push("", "You can apply this plan to save these new output values to the Terraform", "state, without changing any real infrastructure.");
  return { text: L.join("\n"), noChanges: false };
};

// ---------------- init checks ----------------
const providersOf = (cfg: ModCfg): string[] => {
  const out = new Set(Object.keys(cfg.required));
  const walk = (m: ModCfg) => {
    for (const r of m.resources) out.add(r.type.split("_")[0]);
    for (const c of Object.values(m.children)) if (c) walk(c);
  };
  walk(cfg);
  return [...out].filter((p) => PROVIDER_VERSIONS[p]).sort();
};

const moduleKeys = (cfg: ModCfg, prefix = ""): { key: string; source: string; child: ModCfg | null }[] =>
  Object.values(cfg.modules).flatMap((m) => {
    const key = prefix ? `${prefix}.${m.name}` : m.name;
    const child = cfg.children[m.name];
    return [{ key, source: m.source, child }, ...(child ? moduleKeys(child, key) : [])];
  });

const installedModules = (sh: Shell, dir: string): string[] => {
  try {
    return JSON.parse(sh.readFile(`${dir}/.terraform/modules/modules.json`) ?? "{}").Modules?.map((m: { Key: string }) => m.Key) ?? [];
  } catch {
    return [];
  }
};

const BACKEND_BLURB = [
  "",
  'The "backend" is the interface that Terraform uses to store state,',
  "perform operations, etc. If this message is showing up, it means that the",
  "Terraform configuration you're using is using a custom configuration for",
  "the Terraform backend.",
  "",
  "Changes to backend configurations require reinitialization. This allows",
  "Terraform to set up the new configuration, copy existing state, etc. Please run",
  '"terraform init" with either the "-reconfigure" or "-migrate-state" flags to',
  "use the current configuration.",
  "",
  "If the change reason above is incorrect, please verify your configuration",
  "hasn't changed and try again. At this point, no changes to your existing",
  "configuration or state have been made.",
].join("\n");

const lockFileErr = (providers: string[]): Diag => ({
  summary: "Inconsistent dependency lock file",
  detail: [
    "The following dependency selections recorded in the lock file are",
    "inconsistent with the current configuration:",
    ...providers.map((p) => `  - provider registry.terraform.io/hashicorp/${p}: required by this configuration but no version is selected`),
    "",
    "To make the initial dependency selections that will initialize the",
    "dependency lock file, run:",
    "  terraform init",
  ].join("\n"),
});

type Prepared = { cfg: ModCfg; be: Backend; ws: string; vars: Record<string, Value>; warnings: Diag[] };

const prepare = (sh: Shell, dir: string, o: Opts | null, env: Record<string, string>, validate = true): Prepared | Res => {
  const diags: Diag[] = [];
  const cfg = loadModule(sh, dir, diags);
  if (!Object.keys(cfg.files).length)
    return bad(renderDiag(sh, dir, { summary: "No configuration files", detail: `${o ? "Plan" : "Apply"} requires configuration to be present. Planning without a configuration would\nmark everything for destruction, which is normally not what is desired. If you\nwould like to destroy everything, run plan with the -destroy option. Otherwise,\ncreate a Terraform configuration file (.tf file) and try again.` }));
  if (hasErrors(diags)) return bad(renderDiags(sh, dir, diags));
  const want = backendFromBlock(cfg.backend, diags);
  if (hasErrors(diags)) return bad(renderDiags(sh, dir, diags));
  const stored = storedBackend(sh, dir);
  const providers = providersOf(cfg);
  if (!everInitialized(sh, dir) && want.type === "local") return bad(renderDiag(sh, dir, lockFileErr(providers)));
  if (!everInitialized(sh, dir) || !sameBackend(stored, want)) {
    const reason =
      !everInitialized(sh, dir) || stored.type === "local" ? `Initial configuration of the requested backend "${want.type}"`
      : want.type === "local" ? `Unsetting the previously set backend "${stored.type}"`
      : "Backend configuration block has changed";
    return bad(renderDiag(sh, dir, { summary: 'Backend initialization required, please run "terraform init"', detail: `Reason: ${reason}\n${BACKEND_BLURB}` }));
  }
  if (!providersInstalled(sh, dir)) return bad(renderDiag(sh, dir, lockFileErr(providers)));
  const inst = installedModules(sh, dir);
  for (const m of moduleKeys(cfg))
    if (!inst.includes(m.key)) {
      const call = Object.values(cfg.modules).find((c) => c.name === m.key.split(".")[0])!;
      return bad(renderDiag(sh, dir, { summary: "Module not installed", detail: 'This module is not yet installed. Run "terraform init" to install all\nmodules required by this configuration.', file: call.file, line: call.line }));
    }
  if (validate) validateModule(cfg, diags);
  if (hasErrors(diags)) return bad(renderDiags(sh, dir, diags));
  const ordered: { kind: "var" | "file"; value: string }[] = [];
  if (o) {
    const vars = o.all("var");
    const files = o.all("var-file");
    ordered.push(...files.map((value) => ({ kind: "file" as const, value })), ...vars.map((value) => ({ kind: "var" as const, value })));
  }
  const vars = o ? collectVars(sh, dir, cfg, ordered, env, diags) : {};
  if (hasErrors(diags)) return bad(renderDiags(sh, dir, diags));
  return { cfg, be: stored, ws: currentWorkspace(sh, dir), vars, warnings: diags.filter((d) => d.warning) };
};
const isRes = <T extends object>(x: T | Res): x is Res => "output" in x;

const lockError = (sh: Shell, be: Backend, ws: string, o: Opts | null): string | null => {
  if (!lockingEnabled(be) || (o && o.get("lock") === "false")) return null;
  const cloud = tfExt(sh).cloud;
  const table = be.config.dynamodb_table;
  const body = (msg: string, info?: LockInfo) =>
    [
      "╷",
      "│ Error: Error acquiring the state lock",
      "│ ",
      `│ Error message: ${msg}`,
      ...(info
        ? ["│ Lock Info:", `│   ID:        ${info.ID}`, `│   Path:      ${info.Path}`, `│   Operation: ${info.Operation}`, `│   Who:       ${info.Who}`, `│   Version:   ${info.Version}`, `│   Created:   ${info.Created}`, `│   Info:      ${info.Info}`]
        : []),
      "│ ",
      "│ ",
      "│ Terraform acquires a state lock to protect the state from being written",
      "│ by multiple users at the same time. Please resolve the issue above and try",
      '│ again. For most commands, you can disable locking with the "-lock=false"',
      "│ flag, but this is not recommended.",
      "╵",
    ].join("\n");
  if (table && !cloud.objects[cloudKey("aws_dynamodb_table", String(table))])
    return body(`operation error DynamoDB: PutItem, https response error StatusCode: 400,\n│ RequestID: ${"7Q2KD9PL0V3N8M1B"}, ResourceNotFoundException: Requested resource not found`);
  const lk = cloud.locks[lockPath(be, ws)];
  if (lk)
    return body(
      table
        ? "operation error DynamoDB: PutItem, https response error StatusCode: 400,\n│ RequestID: K1M3OQ9A2C4E6G8I, ConditionalCheckFailedException: The\n│ conditional request failed"
        : "state lock file already exists (412 PreconditionFailed)",
      lk,
    );
  return null;
};
const lockBanner = (be: Backend) => (lockingEnabled(be) ? "Acquiring state lock. This may take a few moments..." : "");
const releaseBanner = (be: Backend) => (lockingEnabled(be) ? "Releasing state lock. This may take a few moments..." : "");

// ---------------- commands ----------------
const INIT_DONE = [
  "",
  "Terraform has been successfully initialized!",
  "",
  'You may now begin working with Terraform. Try running "terraform plan" to see',
  "any changes that are required for your infrastructure. All Terraform commands",
  "should now work.",
  "",
  "If you ever set or change modules or backend configuration for Terraform,",
  "rerun this command to reinitialize your working directory. If you forget, other",
  "commands will detect it and remind you to do so if necessary.",
].join("\n");

const lockHcl = (providers: string[]) =>
  [
    "# This file is maintained automatically by \"terraform init\".",
    "# Manual edits may be lost in future updates.",
    "",
    ...providers.flatMap((p) => [
      `provider "registry.terraform.io/hashicorp/${p}" {`,
      `  version     = "${PROVIDER_VERSIONS[p]}"`,
      `  constraints = "~> ${PROVIDER_VERSIONS[p].split(".")[0]}.0"`,
      "  hashes = [",
      `    "h1:${btoa(p + PROVIDER_VERSIONS[p]).slice(0, 43)}=",`,
      "  ]",
      "}",
      "",
    ]),
  ].join("\n");

const stateHasResources = (sh: Shell, dir: string, be: Backend) =>
  listWorkspaces(sh, dir, be).some((ws) => Object.keys(readState(sh, dir, be, ws)?.resources ?? {}).length > 0);

const parseBackendConfigArg = (sh: Shell, v: string, into: Record<string, Value>, diags: Diag[]) => {
  const eq = v.indexOf("=");
  if (eq > 0 && !sh.readFile(v)) {
    const raw = v.slice(eq + 1);
    into[v.slice(0, eq)] = raw === "true" ? true : raw === "false" ? false : raw;
    return;
  }
  const src = sh.readFile(v);
  if (src === undefined) {
    diags.push({ summary: "Failed to read file", detail: `The file "${v}" could not be read.` });
    return;
  }
  try {
    for (const a of parseHcl(src, v).attrs) if (a.expr.t === "lit") into[a.name] = a.expr.v;
  } catch (e) {
    if (e instanceof HclError) diags.push(e.diag);
  }
};

const cmdInit = (sh: Shell, dir: string, o: Opts): Res => {
  const diags: Diag[] = [];
  const cfg = loadModule(sh, dir, diags);
  if (!Object.keys(cfg.files).length && !hasErrors(diags))
    return ok("Terraform initialized in an empty directory!\n\nThe directory has no Terraform configuration files. You may begin working\nwith Terraform immediately by creating Terraform configuration files.");
  if (hasErrors(diags))
    return bad(
      "There are some problems with the configuration, described below.\n\nThe Terraform configuration must be valid before initialization so that\nTerraform can determine which modules and providers need to be installed.\n" +
        renderDiags(sh, dir, diags),
    );
  const out: string[] = [];
  const next = backendFromBlock(cfg.backend, diags);
  for (const v of o.all("backend-config")) parseBackendConfigArg(sh, v, next.config, diags);
  if (hasErrors(diags)) return bad(renderDiags(sh, dir, diags));
  const prev = everInitialized(sh, dir) ? storedBackend(sh, dir) : LOCAL;
  if (o.get("backend") !== "false") {
    out.push("Initializing the backend...");
    if (next.type === "s3") {
      for (const req of ["bucket", "key", "region"])
        if (!next.config[req])
          return bad(out.join("\n") + "\n" + renderDiag(sh, dir, { summary: "Missing required argument", detail: `The argument "${req}" is required, but was not set.`, file: cfg.backend?.file, line: cfg.backend?.line, ctx: "in terraform" }));
      if (!tfExt(sh).cloud.objects[cloudKey("aws_s3_bucket", String(next.config.bucket))])
        return bad(
          out.join("\n") + "\n" +
            renderDiag(sh, dir, { summary: `Failed to get existing workspaces: S3 bucket "${next.config.bucket}" does not exist.`, detail: "The referenced S3 bucket must have been previously created. If the S3 bucket\nwas created within the last minute, please wait for a minute or two and try\nagain.\n\nError: operation error S3: ListObjectsV2, https response error StatusCode: 404,\nNoSuchBucket: The specified bucket does not exist" }),
        );
    } else if (next.type !== "local")
      return bad(renderDiag(sh, dir, { summary: `Unsupported backend type "${next.type}"`, detail: `There is no backend type named "${next.type}". Supported here: local, s3.`, file: cfg.backend?.file, line: cfg.backend?.line }));
    const changed = prev.type !== next.type || !valEq(prev.config as Value, next.config as Value);
    if (changed) {
      const prevHas = stateHasResources(sh, dir, prev);
      if (o.has("reconfigure")) {
        /* switch without copying */
      } else if (prevHas && !o.has("migrate-state") && everInitialized(sh, dir)) {
        return bad(
          out.join("\n") + "\n" +
            renderDiag(sh, dir, {
              summary: prev.type !== next.type && prev.type === "local" ? "Migration of existing state required" : "Backend configuration changed",
              detail: [
                prev.type !== next.type
                  ? `Terraform detected that the backend type changed from "${prev.type}" to "${next.type}", and existing state was found in the "${prev.type}" backend.`
                  : "A change in the backend configuration has been detected, which may require",
                prev.type !== next.type ? "" : "migrating existing state.",
                "",
                'If you wish to attempt automatic migration of the state, use "terraform',
                'init -migrate-state".',
                "If you wish to store the current configuration with no changes to the",
                'state, use "terraform init -reconfigure".',
              ].filter((l, i) => i !== 1 || l).join("\n"),
            }),
        );
      } else if (prevHas) {
        const nextHas = stateHasResources(sh, dir, next);
        out.push(
          prev.type !== next.type ? `Terraform detected that the backend type changed from "${prev.type}" to "${next.type}".` : `Backend configuration changed!\n\nTerraform has detected that the configuration specified for the backend\nhas changed. Terraform will now check for existing state in the backends.`,
          "",
          "Do you want to copy existing state to the new backend?",
          `  Pre-existing state was found while migrating the previous "${prev.type}" backend to the`,
          `  newly configured "${next.type}" backend. ${nextHas ? `An existing non-empty state already exists in\n  the new backend. The two states have been saved to temporary files that will be\n  removed after responding to this query.` : `No existing state was found in the newly\n  configured "${next.type}" backend.`} Do you want to copy this state to the new "${next.type}"`,
          '  backend? Enter "yes" to copy and "no" to start with an empty state.',
          "",
          "  Enter a value: yes",
          "",
        );
        for (const ws of listWorkspaces(sh, dir, prev)) {
          const st = readState(sh, dir, prev, ws);
          if (st) writeState(sh, dir, next, ws, st);
        }
        if (prev.type === "local") {
          const cur = sh.readFile(`${dir}/terraform.tfstate`);
          if (cur) sh.writeFile(`${dir}/terraform.tfstate.backup`, cur);
          sh.removePath(`${dir}/terraform.tfstate`);
          sh.removePath(`${dir}/terraform.tfstate.d`);
        }
      }
      if (next.type !== "local")
        out.push("", `Successfully configured the backend "${next.type}"! Terraform will automatically`, "use this backend unless the backend configuration changes.");
    }
    writeStoredBackend(sh, dir, next);
  }
  sh.mkdir(`${dir}/.terraform`);
  // modules
  const mods = moduleKeys(cfg);
  if (mods.length) {
    out.push("Initializing modules...");
    for (const m of mods) {
      if (/^\.\.?\//.test(m.source)) {
        if (!m.child)
          return bad(out.join("\n") + "\n" + renderDiag(sh, dir, { summary: "Unreadable module directory", detail: `Unable to evaluate directory symlink: lstat ${m.source.replace(/^\.\//, "")}: no such file or directory` }));
        out.push(`- ${m.key} in ${m.source.replace(/^\.\//, "")}`);
      } else out.push(`Downloading registry.terraform.io/${m.source} 5.13.0 for ${m.key}...`, `- ${m.key} in .terraform/modules/${m.key}`);
    }
  }
  sh.writeFile(`${dir}/.terraform/modules/modules.json`, JSON.stringify({ Modules: [{ Key: "", Source: "", Dir: "." }, ...mods.map((m) => ({ Key: m.key, Source: m.source, Dir: m.source }))] }));
  // providers
  out.push("Initializing provider plugins...");
  const providers = providersOf(cfg);
  const hadLock = sh.readFile(`${dir}/.terraform.lock.hcl`) !== undefined;
  for (const p of providers) {
    const v = PROVIDER_VERSIONS[p];
    if (hadLock && !o.has("upgrade")) out.push(`- Reusing previous version of hashicorp/${p} from the dependency lock file`);
    else out.push(`- Finding hashicorp/${p} versions matching "${cfg.required[p]?.version ?? `~> ${v.split(".")[0]}.0`}"...`);
  }
  for (const p of providers) {
    const v = PROVIDER_VERSIONS[p];
    const path = `${dir}/.terraform/providers/registry.terraform.io/hashicorp/${p}/${v}/linux_amd64/terraform-provider-${p}_v${v}_x5`;
    if (sh.readFile(path) !== undefined && !o.has("upgrade")) out.push(`- Using previously-installed hashicorp/${p} v${v}`);
    else out.push(`- Installing hashicorp/${p} v${v}...`, `- Installed hashicorp/${p} v${v} (signed by HashiCorp)`);
    sh.writeFile(path, "\u007fELF (terraform provider binary)");
  }
  sh.mkdir(`${dir}/.terraform/providers`);
  sh.writeFile(`${dir}/.terraform.lock.hcl`, lockHcl(providers));
  if (!hadLock)
    out.push(
      "Terraform has created a lock file .terraform.lock.hcl to record the provider",
      "selections it made above. Include this file in your version control repository",
      'so that Terraform can guarantee to make the same selections by default when',
      'you run "terraform init" in the future.',
    );
  sh.state.tf.initialized = true;
  return ok(out.join("\n") + "\n" + INIT_DONE);
};

const runOptsFrom = (o: Opts, vars: Record<string, Value>): RunOpts => ({
  vars,
  targets: o.all("target"),
  replace: o.all("replace"),
  refreshOnly: o.has("refresh-only"),
  refresh: o.get("refresh") !== "false",
  destroy: o.has("destroy"),
});

const summarize = (dir: string, ws: string, be: Backend, r: RunResult, opts: RunOpts, noChanges: boolean): PlanSummary => ({
  dir, ws, backend: be.type, ...r.counts, moved: r.moves.length, drift: r.drift.length, refreshOnly: !!opts.refreshOnly, destroyMode: !!opts.destroy, noChanges, errors: 0,
});

const cmdPlan = (sh: Shell, dir: string, o: Opts, env: Record<string, string>): Res => {
  const p = prepare(sh, dir, o, env);
  if (isRes(p)) return p;
  const lk = lockError(sh, p.be, p.ws, o);
  if (lk) return bad(lk);
  const stored = readState(sh, dir, p.be, p.ws);
  const prior = stored ?? emptyState();
  const opts = runOptsFrom(o, p.vars);
  const r = runEngine(sh, p.cfg, p.ws, prior, "plan", opts);
  const head = [lockBanner(p.be), ...r.refreshLines].filter(Boolean);
  if (!r.ok) return bad([...head, "", renderDiags(sh, dir, r.diags), releaseBanner(p.be)].filter((x, i) => x || i === 1).join("\n"));
  const { text, noChanges } = renderPlan(r, opts);
  tfExt(sh).lastPlan = summarize(dir, p.ws, p.be, r, opts, noChanges);
  sh.state.tf.planned = true;
  const out = [...head, ...(head.length ? [""] : []), text];
  const warn = [...p.warnings, ...r.diags.filter((d) => d.warning)];
  if (warn.length) out.push("", renderDiags(sh, dir, warn));
  if (opts.targets.length)
    out.push("", renderDiag(sh, dir, { warning: true, summary: "Resource targeting is in effect", detail: "You are creating a plan with the -target option, which means that the result\nof this plan may not represent all of the changes requested by the current\nconfiguration.\n\nThe -target option is not for routine use, and is provided only for\nexceptional situations such as recovering from errors or mistakes, or when\nTerraform specifically suggests to use it as part of an error message." }));
  const outFile = o.get("out");
  if (outFile) {
    tfExt(sh).plans[sh.resolve(outFile)] = { dir, ws: p.ws, lineage: stored ? prior.lineage : "", serial: prior.serial, opts };
    sh.writeFile(outFile, `PK\u0003\u0004 tfplan (binary) — use "terraform show ${outFile}" to read it`);
    out.push("", RULE, "", `Saved the plan to: ${outFile}`, "", "To perform exactly these actions, run the following command to apply:", `    terraform apply "${outFile}"`);
  } else if (!noChanges)
    out.push("", RULE, "", "Note: You didn't use the -out option to save this plan, so Terraform can't", 'guarantee to take exactly these actions if you run "terraform apply" now.');
  if (lockingEnabled(p.be)) out.push(releaseBanner(p.be));
  return ok(out.join("\n"));
};

const outputsBlock = (outputs: TfState["outputs"]) => {
  const names = Object.keys(outputs).sort();
  if (!names.length) return [];
  return ["", "Outputs:", "", ...names.map((n) => `${n} = ${outputs[n].sensitive ? "<sensitive>" : pretty(outputs[n].value)}`)];
};

const cmdApply = (sh: Shell, dir: string, o: Opts, env: Record<string, string>, forceDestroy = false, forceRefreshOnly = false): Res => {
  const planFile = o.pos[0];
  const saved = planFile ? tfExt(sh).plans[sh.resolve(planFile)] : undefined;
  if (planFile && !saved) {
    const exists = sh.readFile(planFile) !== undefined;
    return bad(renderDiag(sh, dir, { summary: `Failed to load "${planFile}" as a plan file`, detail: exists ? `Error: zip: not a valid zip file` : `Error: stat ${planFile}: no such file or directory` }));
  }
  const p = prepare(sh, dir, saved ? null : o, env);
  if (isRes(p)) return p;
  const lk = lockError(sh, p.be, p.ws, o);
  if (lk) return bad(lk);
  const prior = readState(sh, dir, p.be, p.ws) ?? emptyState();
  let opts: RunOpts;
  if (saved) {
    if (saved.ws !== p.ws || saved.serial !== prior.serial || (saved.lineage && saved.lineage !== prior.lineage))
      return bad(renderDiag(sh, dir, { summary: "Saved plan is stale", detail: "The given plan file can no longer be applied because the state was changed\nby another operation after the plan was created." }));
    opts = saved.opts;
  } else opts = runOptsFrom(o, p.vars);
  if (forceDestroy) opts = { ...opts, destroy: true };
  if (forceRefreshOnly) opts = { ...opts, refreshOnly: true };
  const plan = runEngine(sh, p.cfg, p.ws, prior, "plan", opts);
  const out = [lockBanner(p.be), ...plan.refreshLines].filter(Boolean);
  if (!plan.ok) return bad([...out, "", renderDiags(sh, dir, plan.diags)].join("\n"));
  const { text, noChanges } = renderPlan(plan, opts);
  if (!saved) out.push(...(out.length ? [""] : []), text);
  const autoApprove = o.has("auto-approve") || !!saved || forceRefreshOnly;
  if (!noChanges && !autoApprove) {
    const wsTxt = p.ws !== "default" ? ` in workspace "${p.ws}"` : "";
    out.push(
      "",
      ...(opts.destroy
        ? [`Do you really want to destroy all resources${wsTxt}?`, "  Terraform will destroy all your managed infrastructure, as shown above.", "  There is no undo. Only 'yes' will be accepted to confirm."]
        : [`Do you want to perform these actions${wsTxt}?`, "  Terraform will perform the actions described above.", "  Only 'yes' will be accepted to approve."]),
      "",
      "  Enter a value: yes",
    );
  }
  const r = runEngine(sh, p.cfg, p.ws, prior, "apply", opts);
  if (!r.ok) return bad([...out, "", renderDiags(sh, dir, r.diags)].join("\n"));
  const st: TfState = { ...r.state, serial: prior.serial + 1, lineage: prior.lineage || emptyState().lineage, outputs: r.outputs };
  const changedState = !valEq(stateToJson(st) as Value, stateToJson({ ...prior, serial: prior.serial + 1 }) as Value) || !readState(sh, dir, p.be, p.ws);
  if (changedState) writeState(sh, dir, p.be, p.ws, changedState ? st : prior);
  if (r.applyLines.length) out.push("", ...r.applyLines);
  const { add, change, destroy, imported } = r.counts;
  out.push(
    "",
    opts.destroy
      ? `Destroy complete! Resources: ${destroy} destroyed.`
      : opts.refreshOnly ? "Apply complete! Resources: 0 added, 0 changed, 0 destroyed."
      : `Apply complete! Resources: ${imported ? `${imported} imported, ` : ""}${add} added, ${change} changed, ${destroy} destroyed.`,
  );
  if (!opts.destroy) out.push(...outputsBlock(st.outputs));
  if (lockingEnabled(p.be)) out.push(releaseBanner(p.be));
  sh.state.tf.planned = true;
  sh.state.tf.applied = Object.keys(st.resources).length > 0;
  tfExt(sh).lastApply = summarize(dir, p.ws, p.be, r, opts, noChanges);
  for (const k of Object.keys(tfExt(sh).plans)) if (tfExt(sh).plans[k].dir === dir && tfExt(sh).plans[k].ws === p.ws) delete tfExt(sh).plans[k];
  return ok(out.join("\n"));
};

/** Backend + workspace for state commands (no full config validation). */
const stateCtx = (sh: Shell, dir: string): { be: Backend; ws: string } | Res => {
  const diags: Diag[] = [];
  const cfg = loadModule(sh, dir, diags);
  const want = cfg.backend ? backendFromBlock(cfg.backend, []) : LOCAL;
  const stored = everInitialized(sh, dir) ? storedBackend(sh, dir) : LOCAL;
  if (!sameBackend(stored, want) || (want.type !== "local" && !everInitialized(sh, dir)))
    return bad(renderDiag(sh, dir, { summary: 'Backend initialization required, please run "terraform init"', detail: `Reason: ${stored.type === "local" ? `Initial configuration of the requested backend "${want.type}"` : "Backend configuration block has changed"}\n${BACKEND_BLURB}` }));
  return { be: stored, ws: currentWorkspace(sh, dir) };
};

const addrMatch = (addr: string, pat: string) => addr === pat || addr.startsWith(pat + ".") || addr.startsWith(pat + "[");

const cmdState = (sh: Shell, dir: string, o: Opts): Res => {
  const [sub, ...args] = o.pos;
  const usage = "Usage: terraform [global options] state <subcommand> [options] [args]\n\n  This command has subcommands for advanced state management.\n\n  These subcommands can be used to slice and dice the Terraform state.\n  This is sometimes necessary in advanced cases. For your safety, all\n  state management commands that modify the state create a timestamped\n  backup of the state prior to making modifications.\n\nSubcommands:\n    list                List resources in the state\n    mv                  Move an item in the state\n    pull                Pull current state and output to stdout\n    push                Update remote state from a local state file\n    replace-provider    Replace provider in the state\n    rm                  Remove instances from the state\n    show                Show a resource in the state";
  if (!sub) return ok(usage);
  const c = stateCtx(sh, dir);
  if (isRes(c)) return c;
  const st = readState(sh, dir, c.be, c.ws);
  const addrs = Object.keys(st?.resources ?? {}).sort();
  const noInstance = () =>
    bad(renderDiag(sh, dir, { summary: "No instance found for the given address!", detail: 'This command requires that the address references one specific instance.\nTo view the available instances, use "terraform state list". Please modify\nthe address to reference a specific instance.' }));
  switch (sub) {
    case "list": {
      const list = args.length ? addrs.filter((a) => args.some((p) => addrMatch(a, p))) : addrs;
      return ok(list.join("\n"));
    }
    case "show": {
      const a = args[0];
      const r = a ? st?.resources[a] : undefined;
      if (!r) return noInstance();
      const p = parseAddr(a)!;
      return ok([`# ${a}:`, `resource "${r.type}" "${p.name}" {`, ...renderState(r.attrs, 4), "}"].join("\n"));
    }
    case "pull":
      return ok(st ? stateToJson(st) : "");
    case "mv":
    case "rm": {
      const lk = lockError(sh, c.be, c.ws, o);
      if (lk) return bad(lk);
      if (!st) return bad(renderDiag(sh, dir, { summary: "No state file was found!", detail: "State management commands require a state file. Run this command\nin a directory where Terraform has been run or use the -state flag\nto point the command to a specific state location." }));
      if (sub === "rm") {
        if (!args.length) return bad("Usage: terraform [global options] state rm [options] ADDRESS...");
        const hit = addrs.filter((a) => args.some((p) => addrMatch(a, p)));
        if (!hit.length)
          return bad(renderDiag(sh, dir, { summary: "Invalid target address", detail: 'No matching objects found. To view the available instances, use "terraform\nstate list". Please modify the address to reference a specific instance.' }));
        if (o.has("dry-run")) return ok(hit.map((h) => `Would remove ${h}`).join("\n"));
        for (const h of hit) delete st.resources[h];
        st.serial++;
        writeState(sh, dir, c.be, c.ws, st);
        return ok([...hit.map((h) => `Removed ${h}`), `Successfully removed ${hit.length} resource instance(s).`].join("\n"));
      }
      const [src, dst] = args;
      if (!src || !dst) return bad("Usage: terraform [global options] state mv [options] SOURCE DESTINATION");
      const srcIsMod = /^module\.[\w-]+$/.test(src) || /\.module\.[\w-]+$/.test(src);
      if (!srcIsMod && !parseAddr(src)) return bad(renderDiag(sh, dir, { summary: "Invalid source address", detail: `Cannot move ${src}: invalid resource address syntax.` }));
      if (!/^module\.[\w-]+$/.test(dst) && !parseAddr(dst)) return bad(renderDiag(sh, dir, { summary: "Invalid target address", detail: `Cannot move to ${dst}: invalid resource address syntax.` }));
      const hit = addrs.filter((a) => addrMatch(a, src));
      if (!hit.length) {
        const sug = closest(src, addrs);
        return bad(renderDiag(sh, dir, { summary: "Invalid source address", detail: `Cannot move ${src}: does not match anything in the current state.${sug ? `\n\nDid you mean "${sug}"?` : ""}` }));
      }
      const moves = hit.map((h) => [h, dst + h.slice(src.length)] as const);
      for (const [, to] of moves)
        if (st.resources[to]) return bad(renderDiag(sh, dir, { summary: "Invalid target address", detail: `Cannot move to ${to}: there is already a resource instance at that\naddress in the current state.` }));
      for (const [from, to] of moves) {
        const fp = parseAddr(from);
        const tp = parseAddr(to);
        if (fp && tp && fp.type !== tp.type)
          return bad(renderDiag(sh, dir, { summary: "Invalid state move request", detail: `Cannot move ${from} to ${to}: resource types don't match.` }));
      }
      if (o.has("dry-run")) return ok(moves.map(([f, t]) => `Would move "${f}" to "${t}"`).join("\n"));
      for (const [from, to] of moves) {
        st.resources[to] = st.resources[from];
        delete st.resources[from];
      }
      st.serial++;
      writeState(sh, dir, c.be, c.ws, st);
      return ok([...moves.map(([f, t]) => `Move "${f}" to "${t}"`), `Successfully moved ${moves.length} object(s).`].join("\n"));
    }
    default:
      return bad(usage);
  }
};

const renderState = (attrs: Attrs, ind: number): string[] => {
  const pad = " ".repeat(ind);
  const keys = Object.keys(attrs).sort();
  const simple = keys.filter((k) => !isBlockList(attrs[k]));
  const w = Math.max(0, ...simple.map((k) => k.length));
  const out: string[] = [];
  for (const k of simple) out.push(`${pad}${k.padEnd(w)} = ${pretty(attrs[k], ind)}`);
  for (const k of keys.filter((k) => isBlockList(attrs[k])))
    for (const b of attrs[k] as Attrs[]) out.push("", `${pad}${k} {`, ...renderState(b, ind + 4), `${pad}}`);
  return out;
};

const cmdOutput = (sh: Shell, dir: string, o: Opts): Res => {
  const c = stateCtx(sh, dir);
  if (isRes(c)) return c;
  const st = readState(sh, dir, c.be, c.ws);
  const outs = st?.outputs ?? {};
  tfExt(sh).outputsIn.push(c.ws);
  const name = o.pos[0];
  if (name) {
    const v = outs[name];
    if (!v)
      return bad(renderDiag(sh, dir, { summary: `Output "${name}" not found`, detail: "The output variable requested could not be found in the state\nfile. If you recently added this to your configuration, be\nsure to run `terraform apply`, since the state won't be updated\nwith new output variables until that command is run." }));
    if (o.has("json")) return ok(JSON.stringify(v.value, null, 2));
    if (o.has("raw")) {
      if (typeof v.value === "object" && v.value !== null)
        return bad(renderDiag(sh, dir, { summary: "Unsupported value for raw output", detail: `The -raw option only supports strings, numbers, and boolean values, but output\nvalue "${name}" is ${Array.isArray(v.value) ? "a list" : "an object"}.\n\nUse the -json option for machine-readable representations of output values\nthat have complex types.` }));
      return ok(String(v.value));
    }
    return ok(pretty(v.value));
  }
  const names = Object.keys(outs).sort();
  if (o.has("json"))
    return ok(JSON.stringify(Object.fromEntries(names.map((n) => [n, { sensitive: outs[n].sensitive, type: typeof outs[n].value === "string" ? "string" : typeof outs[n].value === "number" ? "number" : Array.isArray(outs[n].value) ? ["tuple", ["string"]] : "dynamic", value: outs[n].value }])), null, 2));
  if (!names.length)
    return ok(renderDiag(sh, dir, { warning: true, summary: "No outputs found", detail: "The state file either has no outputs defined, or all the defined outputs\nare empty. Please define an output in your configuration with the `output`\nkeyword and run `terraform refresh` for it to become available. If you are\nusing interpolation, please verify the interpolated value is not empty. You\ncan use the `terraform console` command to assist." }));
  return ok(names.map((n) => `${n} = ${outs[n].sensitive ? "<sensitive>" : pretty(outs[n].value)}`).join("\n"));
};

const cmdImport = (sh: Shell, dir: string, o: Opts, env: Record<string, string>): Res => {
  const [addr, id] = o.pos;
  if (!addr || !id)
    return bad("The import command expects two arguments.\nUsage: terraform [global options] import [options] ADDR ID\n\n  Import existing infrastructure into your Terraform state.");
  const p = prepare(sh, dir, o, env);
  if (isRes(p)) return p;
  const lk = lockError(sh, p.be, p.ws, o);
  if (lk) return bad(lk);
  const st = readState(sh, dir, p.be, p.ws) ?? emptyState();
  const eng = new Engine(sh, p.cfg, "console", p.ws, st, p.vars);
  let insts: string[];
  try {
    insts = eng.root.allInstances().map((i) => i.addr);
  } catch (e) {
    if (e instanceof EvalError) return bad(renderDiag(sh, dir, e.diag));
    throw e;
  }
  const pa = parseAddr(addr);
  if (!pa || !insts.includes(addr)) {
    const sug = closest(addr, insts);
    const t = pa?.type ?? addr.split(".")[0];
    const n = pa?.name ?? addr.split(".")[1] ?? "name";
    return bad(
      renderDiag(sh, dir, {
        summary: pa ? "Configuration for import target does not exist" : "Invalid address",
        detail: pa
          ? `The configuration for the given import target ${addr} does not exist. All target\ninstances must have an associated configuration to be imported.${sug ? `\n\nDid you mean "${sug}"?` : `\n\nBefore importing this resource, please create its configuration in the root module. For example:\n\nresource "${t}" "${n}" {\n  # (resource arguments)\n}`}`
          : `The address "${addr}" is not a valid resource address.`,
      }),
    );
  }
  if (st.resources[addr])
    return bad(renderDiag(sh, dir, { summary: "Resource already managed by Terraform", detail: `Terraform is already managing a remote object for ${addr}. To import to this\naddress you must first remove the existing object from the state.` }));
  const remote = tfExt(sh).cloud.objects[cloudKey(pa.type, id)];
  const head = [lockBanner(p.be), `${addr}: Importing from ID "${id}"...`].filter(Boolean);
  if (!remote)
    return bad([...head, renderDiag(sh, dir, { summary: "Cannot import non-existent remote object", detail: `While attempting to import an existing object to "${addr}", the provider\ndetected that no object exists with the given id. Only pre-existing objects\ncan be imported; check that the id is correct and that it is associated with\nthe provider's configured region or endpoint, or use "terraform apply" to\ncreate a new remote object for this resource.` })].join("\n"));
  st.resources[addr] = { type: pa.type, attrs: JSON.parse(JSON.stringify(remote)) };
  st.serial++;
  writeState(sh, dir, p.be, p.ws, st);
  return ok(
    [...head, `${addr}: Import prepared!`, `  Prepared ${pa.type} for import`, `${addr}: Refreshing state... [id=${id}]`, "", "Import successful!", "", "The resources that were imported are shown above. These resources are now in", "your Terraform state and will henceforth be managed by Terraform.", releaseBanner(p.be)]
      .filter((x, i, a) => x || i < a.length - 1)
      .join("\n"),
  );
};

const cmdWorkspace = (sh: Shell, dir: string, o: Opts): Res => {
  const [sub, name] = o.pos;
  const c = stateCtx(sh, dir);
  if (isRes(c)) return c;
  const list = listWorkspaces(sh, dir, c.be);
  const cur = c.ws;
  switch (sub) {
    case "list":
      return ok(list.map((w) => `${w === cur ? "*" : " "} ${w}`).join("\n") + "\n");
    case "show":
      return ok(cur);
    case "new": {
      if (!name) return bad("Expected a single argument: NAME.\n\nUsage: terraform [global options] workspace new [OPTIONS] NAME");
      if (!/^[\w-]+$/.test(name)) return bad(renderDiag(sh, dir, { summary: "Invalid workspace name", detail: `The workspace name "${name}" is not allowed. The name must contain only URL safe\ncharacters, and no path separators.` }));
      if (list.includes(name)) return bad(`Workspace "${name}" already exists`);
      createWorkspace(sh, dir, c.be, name);
      setWorkspace(sh, dir, name);
      return ok(`Created and switched to workspace "${name}"!\n\nYou're now on a new, empty workspace. Workspaces isolate their state,\nso if you run "terraform plan" Terraform will not see any existing state\nfor this configuration.`);
    }
    case "select": {
      if (!name) return bad("Expected a single argument: NAME.\n\nUsage: terraform [global options] workspace select NAME");
      if (!list.includes(name)) {
        if (o.has("or-create")) {
          createWorkspace(sh, dir, c.be, name);
          setWorkspace(sh, dir, name);
          return ok(`Created and switched to workspace "${name}"!`);
        }
        return bad(`\nWorkspace "${name}" doesn't exist.\n\nYou can create this workspace with the "new" subcommand\nor include the "-or-create" flag with the "select" subcommand.`);
      }
      setWorkspace(sh, dir, name);
      return ok(`Switched to workspace "${name}".`);
    }
    case "delete": {
      if (!name) return bad("Expected a single argument: NAME.");
      if (!list.includes(name)) return bad(`Workspace "${name}" doesn't exist.`);
      if (name === "default") return bad(renderDiag(sh, dir, { summary: 'Cannot delete the default workspace', detail: 'The "default" workspace cannot be deleted.' }));
      if (name === cur)
        return bad(`Workspace "${name}" is your active workspace.\n\nYou cannot delete the currently active workspace. Please switch\nto another workspace and try again.`);
      const st = readState(sh, dir, c.be, name);
      const res = Object.keys(st?.resources ?? {});
      if (res.length && !o.has("force"))
        return bad(
          renderDiag(sh, dir, {
            summary: "Workspace is not empty",
            detail: `Workspace "${name}" is currently tracking the following resource instances:\n${res.map((r) => `  - ${r}`).join("\n")}\n\nDeleting this workspace would cause Terraform to lose track of any associated\nremote objects, which would then require you to delete them manually outside\nof Terraform. You should destroy these objects with Terraform before deleting\nthe workspace.\n\nIf you want to delete this workspace anyway, and have Terraform forget about\nthese managed objects, use the -force option to disable this safety check.`,
          }),
        );
      deleteWorkspace(sh, dir, c.be, name);
      return ok(`Deleted workspace "${name}"!`);
    }
    default:
      return bad(`Usage: terraform [global options] workspace\n\n  new, list, show, select and delete Terraform workspaces.\n\nSubcommands:\n    delete    Delete a workspace\n    list      List Workspaces\n    new       Create a new workspace\n    select    Select a workspace\n    show      Show the name of the current workspace`);
  }
};

const cmdForceUnlock = (sh: Shell, dir: string, o: Opts): Res => {
  const id = o.pos[0];
  if (!id) return bad("Expected a single argument: LOCK_ID\n\nUsage: terraform [global options] force-unlock LOCK_ID");
  const c = stateCtx(sh, dir);
  if (isRes(c)) return c;
  if (!lockingEnabled(c.be)) return bad(renderDiag(sh, dir, { summary: "Local state cannot be unlocked by another process", detail: "The local backend holds locks only while a command is running." }));
  const cloud = tfExt(sh).cloud;
  const path = lockPath(c.be, c.ws);
  const lk = cloud.locks[path];
  if (!lk) return bad(renderDiag(sh, dir, { summary: "Failed to unlock state: no lock info found", detail: `There is no lock on "${path}" (workspace "${c.ws}"). Nothing to unlock.` }));
  if (lk.ID !== id) return bad(renderDiag(sh, dir, { summary: `Failed to unlock state: lock ID "${id}" does not match existing lock ID "${lk.ID}"`, detail: "The lock ID must match the ID printed in the Lock Info of the error." }));
  delete cloud.locks[path];
  const prompt = o.has("force")
    ? []
    : ["Do you really want to force-unlock?", "  Terraform will remove the lock on the remote state.", "  This will allow local Terraform commands to modify this state, even though it", "  may still be in use. Only 'yes' will be accepted to confirm.", "", "  Enter a value: yes", ""];
  return ok([...prompt, "Terraform state has been successfully unlocked!", "", "The state has been unlocked, and Terraform commands should now be able to", "obtain a new lock on the remote state."].join("\n"));
};

const cmdValidate = (sh: Shell, dir: string): Res => {
  const diags: Diag[] = [];
  const cfg = loadModule(sh, dir, diags);
  if (!hasErrors(diags)) {
    if (!providersInstalled(sh, dir))
      return bad(renderDiag(sh, dir, { summary: "Missing required provider", detail: `This configuration requires provider registry.terraform.io/hashicorp/${providersOf(cfg)[0] ?? "aws"}, but that\nprovider isn't available. You may be able to install it automatically by\nrunning:\n  terraform init` }));
    const inst = installedModules(sh, dir);
    for (const m of moduleKeys(cfg))
      if (!inst.includes(m.key)) {
        const call = cfg.modules[m.key.split(".")[0]];
        return bad(renderDiag(sh, dir, { summary: "Module not installed", detail: 'This module is not yet installed. Run "terraform init" to install all\nmodules required by this configuration.', file: call?.file, line: call?.line }));
      }
    validateModule(cfg, diags);
  }
  if (hasErrors(diags)) return bad(renderDiags(sh, dir, diags));
  return ok((diags.length ? renderDiags(sh, dir, diags) + "\n" : "") + "Success! The configuration is valid.\n");
};

const cmdFmt = (sh: Shell, dir: string, o: Opts): Res => {
  const target = o.pos[0] ? sh.resolve(o.pos[0]) : dir;
  const files: string[] = [];
  const walk = (d: string, rel: string) => {
    for (const n of sh.listDir(d)) {
      if (n.startsWith(".")) continue;
      if (n.endsWith("/")) {
        if (o.has("recursive")) walk(`${d}/${n.slice(0, -1)}`, `${rel}${n}`);
      } else if (/\.(tf|tfvars)$/.test(n)) files.push(`${rel}${n}`);
    }
  };
  if (sh.readFile(target) !== undefined) files.push(o.pos[0]);
  else walk(target, "");
  const base = sh.readFile(target) !== undefined ? sh.cwd : target;
  const changed: string[] = [];
  const diffs: string[] = [];
  const diags: Diag[] = [];
  for (const f of files) {
    const src = sh.readFile(`${base}/${f}`) ?? sh.readFile(f) ?? "";
    try {
      parseHcl(src, f);
    } catch (e) {
      if (e instanceof HclError) {
        diags.push(e.diag);
        continue;
      }
      throw e;
    }
    const out = fmtHcl(src);
    if (out === src) continue;
    changed.push(f);
    if (o.has("diff")) {
      const a = src.split("\n");
      const b = out.split("\n");
      diffs.push(`--- old/${f}`, `+++ new/${f}`, `@@ -1,${a.length} +1,${b.length} @@`);
      for (let i = 0; i < Math.max(a.length, b.length); i++) {
        if (a[i] === b[i]) diffs.push(` ${a[i] ?? ""}`);
        else {
          if (a[i] !== undefined) diffs.push(`-${a[i]}`);
          if (b[i] !== undefined) diffs.push(`+${b[i]}`);
        }
      }
    }
    if (!o.has("check")) sh.writeFile(`${base}/${f}`, out);
  }
  if (diags.length) return bad(renderDiags(sh, base, diags));
  const text = [...changed, ...diffs].join("\n");
  if (o.has("check") && changed.length) return bad(text);
  return ok(text);
};

const cmdProviders = (sh: Shell, dir: string): Res => {
  const diags: Diag[] = [];
  const cfg = loadModule(sh, dir, diags);
  if (hasErrors(diags)) return bad(renderDiags(sh, dir, diags));
  const lines = ["", "Providers required by configuration:", "."];
  const provLine = (p: string, m: ModCfg) => `provider[registry.terraform.io/hashicorp/${p}]${m.required[p]?.version ? ` ${m.required[p].version}` : ""}`;
  const walk = (m: ModCfg, pre: string) => {
    const provs = [...new Set(m.resources.map((r) => r.type.split("_")[0]))].filter((p) => PROVIDER_VERSIONS[p]);
    const kids = Object.entries(m.children).filter(([, c]) => c) as [string, ModCfg][];
    const items: [string, (() => void) | null][] = [...provs.map((p) => [provLine(p, m), null] as [string, null]), ...kids.map(([n, c]) => [`module.${n}`, () => walk(c, "")] as [string, () => void])];
    items.forEach(([label, sub], i) => {
      const last = i === items.length - 1;
      lines.push(`${pre}${last ? "└── " : "├── "}${label}`);
      if (sub) {
        const before = lines.length;
        sub();
        for (let j = before; j < lines.length; j++) lines[j] = `${pre}${last ? "    " : "│   "}${lines[j]}`;
      }
    });
  };
  walk(cfg, "");
  const c = stateCtx(sh, dir);
  if (!isRes(c)) {
    const st = readState(sh, dir, c.be, c.ws);
    const provs = [...new Set(Object.values(st?.resources ?? {}).map((r) => r.type.split("_")[0]))];
    if (provs.length) lines.push("", "Providers required by state:", "", ...provs.map((p) => `    provider[registry.terraform.io/hashicorp/${p}]`), "");
  }
  return ok(lines.join("\n"));
};

const cmdConsole = (sh: Shell, dir: string, o: Opts, env: Record<string, string>, stdin?: string): Res => {
  if (!stdin) return ok("Terraform console is interactive here only through a pipe. Example:\n  echo 'var.environment' | terraform console");
  const p = prepare(sh, dir, o, env);
  if (isRes(p)) return p;
  const st = readState(sh, dir, p.be, p.ws) ?? emptyState();
  const eng = new Engine(sh, p.cfg, "console", p.ws, st, p.vars);
  const out: string[] = [];
  for (const line of stdin.split("\n").map((l) => l.trim()).filter(Boolean)) {
    try {
      out.push(pretty(eng.eval(parseExpr(line), { m: eng.root })));
    } catch (e) {
      if (e instanceof HclError || e instanceof EvalError) return bad([...out, renderDiag(sh, dir, e.diag)].join("\n"));
      throw e;
    }
  }
  return ok(out.join("\n"));
};

const cmdShow = (sh: Shell, dir: string, o: Opts, env: Record<string, string>): Res => {
  const file = o.pos[0];
  if (file) {
    const saved = tfExt(sh).plans[sh.resolve(file)];
    if (!saved) return bad(renderDiag(sh, dir, { summary: `Failed to read the given file as a state or plan file`, detail: `State read error: Error loading statefile: open ${file}: no such file or directory` }));
    const p = prepare(sh, dir, null, env);
    if (isRes(p)) return p;
    const prior = readState(sh, dir, p.be, p.ws) ?? emptyState();
    const r = runEngine(sh, p.cfg, p.ws, prior, "plan", saved.opts);
    if (!r.ok) return bad(renderDiags(sh, dir, r.diags));
    return ok(renderPlan(r, saved.opts).text);
  }
  const c = stateCtx(sh, dir);
  if (isRes(c)) return c;
  const st = readState(sh, dir, c.be, c.ws);
  if (!st || !Object.keys(st.resources).length) return ok("No state.");
  const out: string[] = [];
  for (const a of Object.keys(st.resources).sort()) {
    const r = st.resources[a];
    out.push(`# ${a}:`, `resource "${r.type}" "${parseAddr(a)?.name}" {`, ...renderState(r.attrs, 4), "}", "");
  }
  out.push(...outputsBlock(st.outputs).slice(1));
  return ok(out.join("\n"));
};

const cmdTaint = (sh: Shell, dir: string, o: Opts, untaint: boolean): Res => {
  const addr = o.pos[0];
  const c = stateCtx(sh, dir);
  if (isRes(c)) return c;
  const st = readState(sh, dir, c.be, c.ws);
  const r = addr ? st?.resources[addr] : undefined;
  if (!st || !r) return bad(renderDiag(sh, dir, { summary: "No such resource instance", detail: `There is no resource instance in the state with the address ${addr ?? "(none)"}. If the resource configuration has just been added, you must run "terraform apply" once to create the corresponding instance(s) before they can be tainted.` }));
  if (untaint) delete r.tainted;
  else r.tainted = true;
  st.serial++;
  writeState(sh, dir, c.be, c.ws, st);
  return ok(untaint ? `Resource instance ${addr} has been successfully untainted.` : `Resource instance ${addr} has been marked as tainted.`);
};

const HELP = `Usage: terraform [global options] <subcommand> [args]

The available commands for execution are listed below.
The primary workflow commands are given first, followed by
less common or more advanced commands.

Main commands:
  init          Prepare your working directory for other commands
  validate      Check whether the configuration is valid
  plan          Show changes required by the current configuration
  apply         Create or update infrastructure
  destroy       Destroy previously-created infrastructure

All other commands:
  console       Try Terraform expressions at an interactive command prompt
  fmt           Reformat your configuration in the standard style
  force-unlock  Release a stuck lock on the current workspace
  import        Associate existing infrastructure with a Terraform resource
  output        Show output values from your root module
  providers     Show the providers required for this configuration
  refresh       Update the state to match remote systems
  show          Show the current state or a saved plan
  state         Advanced state management
  taint         Mark a resource instance as not fully functional
  untaint       Remove the 'tainted' state from a resource instance
  version       Show the current Terraform version
  workspace     Workspace management

Global options (use these before the subcommand, if any):
  -chdir=DIR    Switch to a different working directory before executing the
                given subcommand.
  -help         Show this help output, or the help for a specified subcommand.
  -version      An alias for the "version" subcommand.`;

const SUBCOMMANDS: Record<string, string> = {
  init: "prepara o diretório: configura o backend de state, instala módulos e baixa providers",
  validate: "valida sintaxe e referências do código (sem acessar a nuvem)",
  plan: "compara código × state × nuvem real e mostra o que será criado/alterado/destruído",
  apply: "executa as mudanças do plano na infraestrutura",
  destroy: "destrói todos os recursos gerenciados pelo workspace atual",
  output: "lê os outputs gravados no state",
  state: "gerência avançada do state (list, show, mv, rm, pull)",
  import: "associa um recurso que já existe na nuvem a um endereço do código",
  workspace: "gerencia workspaces — cada um tem seu próprio state (new, select, list, show, delete)",
  "force-unlock": "remove um lock de state preso (ex.: job de CI que morreu no meio do apply)",
  fmt: "formata os arquivos .tf no estilo padrão (use -check no CI)",
  providers: "mostra a árvore de providers exigidos pelo código e pelo state",
  version: "versão do Terraform e dos providers instalados",
  console: "avalia expressões HCL (ex.: echo 'var.env' | terraform console)",
  show: "mostra o state atual ou um plano salvo com -out",
  refresh: "atualiza o state com a realidade (obsoleto: prefira apply -refresh-only)",
  taint: "marca um recurso para ser recriado no próximo apply (prefira -replace)",
  untaint: "remove a marcação de tainted",
};

/** Runs a terraform command line (args after "terraform"). */
export const terraformRun = (sh: Shell, args: string[], env: Record<string, string> = sh.env, stdin?: string): Res => {
  let dir = sh.cwd;
  let i = 0;
  while (args[i]?.startsWith("-")) {
    const a = args[i];
    if (a.startsWith("-chdir=")) dir = sh.resolve(a.slice(7));
    else if (a === "-version" || a === "--version" || a === "-v") return terraformRun(sh, ["version"], env);
    else if (a === "-help" || a === "--help" || a === "-h") return ok(HELP);
    else return bad(`Error: flag provided but not defined: ${a}\n\n${HELP}`);
    i++;
  }
  if (!sh.isDir(dir)) return bad(renderDiag(sh, sh.cwd, { summary: "Invalid -chdir option", detail: `The directory "${dir}" does not exist.` }));
  const sub = args[i];
  const o = new Opts(args.slice(i + 1));
  if (!sub) return ok(HELP);
  if (o.has("help") || o.has("h")) return ok(`Usage: terraform [global options] ${sub} [options]\n\n  ${SUBCOMMANDS[sub] ?? ""}`);
  switch (sub) {
    case "version": {
      const provs = providersInstalled(sh, dir) ? providersOf(loadModule(sh, dir, [])) : [];
      return ok([`Terraform v${TF_VERSION}`, "on linux_amd64", ...provs.map((p) => `+ provider registry.terraform.io/hashicorp/${p} v${PROVIDER_VERSIONS[p]}`)].join("\n"));
    }
    case "init":
      return cmdInit(sh, dir, o);
    case "validate":
      return cmdValidate(sh, dir);
    case "fmt":
      return cmdFmt(sh, dir, o);
    case "plan":
      return cmdPlan(sh, dir, o, env);
    case "apply":
      return cmdApply(sh, dir, o, env, o.has("destroy"));
    case "destroy":
      return cmdApply(sh, dir, o, env, true);
    case "refresh":
      return cmdApply(sh, dir, o, env, false, true);
    case "output":
      return cmdOutput(sh, dir, o);
    case "state":
      return cmdState(sh, dir, o);
    case "import":
      return cmdImport(sh, dir, o, env);
    case "workspace":
    case "env":
      return cmdWorkspace(sh, dir, o);
    case "force-unlock":
      return cmdForceUnlock(sh, dir, o);
    case "providers":
      return cmdProviders(sh, dir);
    case "console":
      return cmdConsole(sh, dir, o, env, stdin);
    case "show":
      return cmdShow(sh, dir, o, env);
    case "taint":
    case "untaint":
      return cmdTaint(sh, dir, o, sub === "untaint");
    case "get":
      return cmdInit(sh, dir, new Opts(["-backend=false"]));
    default: {
      const sug = closest(sub, Object.keys(SUBCOMMANDS));
      return bad(`Terraform has no command named "${sub}".${sug ? ` Did you mean "${sug}"?` : ""}\n\nTo see all of Terraform's top-level commands, run:\n  terraform -help`);
    }
  }
};

// ---------------- mentor ----------------
const addrHelp = (sh: Shell) => {
  const dir = sh.cwd;
  try {
    const c = stateCtx(sh, dir);
    if (isRes(c)) return "";
    const addrs = Object.keys(readState(sh, dir, c.be, c.ws)?.resources ?? {});
    return addrs.length ? ` Endereços no state agora: ${addrs.slice(0, 6).join(", ")}.` : "";
  } catch {
    return "";
  }
};

export const explainTerraformError = (cmd: string, output: string, sh: Shell): string | null => {
  let m = /Terraform has no command named "([^"]+)"/.exec(output);
  if (m) {
    const sug = closest(m[1], Object.keys(SUBCOMMANDS));
    return `"${m[1]}" não é um subcomando do Terraform.${sug ? ` Você quis dizer "${sug}"? Tente: terraform ${sug}${cmd.split(/\s+/).slice(2).length ? " " + cmd.split(/\s+/).slice(2).join(" ") : ""}` : ""} O fluxo principal é init → validate → plan → apply.`;
  }
  m = /Error acquiring the state lock[\s\S]*?│\s+ID:\s+(\S+)[\s\S]*?│\s+Who:\s+([^\n]+)/.exec(output);
  if (m)
    return `Outro processo segura o lock do state (Who: ${m[2].trim()}). Se for um job de CI que morreu, confirme que nada está rodando e libere com: terraform force-unlock -force ${m[1]} — o ID vem do bloco Lock Info. Nunca use -lock=false para "passar por cima" em produção.`;
  if (/ResourceNotFoundException/.test(output))
    return "A tabela DynamoDB de lock configurada no backend (dynamodb_table) não existe nessa conta/região. Confira o nome no bloco backend.";
  if (/does not match existing lock ID "([^"]+)"/.test(output))
    return `O ID informado não é o do lock atual. Copie exatamente o ID do Lock Info: ${/existing lock ID "([^"]+)"/.exec(output)![1]}.`;
  if (/Backend initialization required/.test(output)) {
    if (/Initial configuration/.test(output) && /backend "s3"/.test(output))
      return "Você declarou (ou mudou) um backend, e o diretório ainda aponta para o anterior. Rode terraform init -migrate-state para copiar o state existente para o S3 (ou -reconfigure para começar do zero, sem copiar nada).";
    return "O Terraform ainda não foi inicializado com a configuração de backend atual. Rode terraform init (use -migrate-state se já existe state a copiar, ou -reconfigure para só apontar para o novo backend).";
  }
  if (/Backend configuration changed|Migration of existing state required/.test(output))
    return "A configuração do backend mudou e já existe state. Escolha: terraform init -migrate-state (copia o state para o novo backend — o normal numa migração) ou terraform init -reconfigure (ignora o state antigo; use só se ele já foi copiado).";
  if (/Inconsistent dependency lock file|Missing required provider/.test(output))
    return "O diretório não foi inicializado: faltam os providers. Rode terraform init primeiro — ele baixa o provider AWS e cria o .terraform.lock.hcl.";
  if (/Module not installed/.test(output)) return "Há um bloco module que ainda não foi instalado. Sempre que adicionar ou mudar o source de um módulo, rode terraform init.";
  if (/Unreadable module directory/.test(output)) return "O source do módulo aponta para um diretório que não existe. Confira o caminho (ex.: ./modules/s3-bucket) com ls.";
  m = /Workspace "([^"]+)" doesn't exist/.exec(output);
  if (m) return `O workspace "${m[1]}" não existe. Crie com terraform workspace new ${m[1]} (ou select -or-create). Veja os existentes com terraform workspace list.`;
  if (/already exists/.test(output) && /Workspace/.test(output)) return "Esse workspace já existe — use terraform workspace select <nome> para trocar para ele.";
  if (/Workspace is not empty/.test(output)) return "O workspace ainda gerencia recursos. Rode terraform destroy nele antes de apagá-lo (ou -force, se você sabe que vai perder o rastreio desses recursos).";
  if (/is your active workspace/.test(output)) return "Não dá para apagar o workspace em uso. Troque antes: terraform workspace select default.";
  if (/Invalid source address|Invalid target address|No instance found|does not exist in the configuration|Configuration for import target does not exist|No such resource instance/.test(output)) {
    const sug = /Did you mean "([^"]+)"/.exec(output);
    return `Endereço de recurso inválido ou inexistente.${sug ? ` O mais parecido é ${sug[1]}.` : ""} Formato: tipo.nome (ex.: aws_s3_bucket.logs), dentro de módulo: module.nome.tipo.nome, instâncias: [0] ou ["chave"] — no shell, use aspas simples.${addrHelp(sh)}`;
  }
  if (/Resource already managed by Terraform/.test(output)) return "Esse endereço já está no state. Se o import anterior foi para o recurso errado, remova com terraform state rm <endereço> e importe de novo.";
  if (/Cannot import non-existent remote object/.test(output)) return "Não existe objeto na nuvem com esse ID. Para buckets S3 o ID é o nome do bucket; para EC2, o i-xxxx. Confira no console/CLI da AWS.";
  if (/Invalid block definition/.test(output)) {
    const l = /on (\S+) line (\d+)/.exec(output);
    return `Erro de sintaxe HCL${l ? ` em ${l[1]}, linha ${l[2]}` : ""}: provavelmente faltou o "=" entre o nome e o valor. Argumento é nome = valor; bloco é nome { ... }. Abra o arquivo com vi e corrija.`;
  }
  if (/Unclosed configuration block/.test(output)) return "Faltou fechar uma chave }. O Terraform aponta a linha onde o bloco começou — confira o aninhamento a partir dela (terraform fmt ajuda a enxergar a indentação).";
  if (/Argument or block definition required|Missing newline after argument|Invalid multi-line string|Invalid expression|Missing key\/value separator/.test(output)) {
    const l = /on (\S+) line (\d+)/.exec(output);
    return `Erro de sintaxe HCL${l ? ` em ${l[1]}, linha ${l[2]}` : ""}. Cada argumento vai numa linha própria (nome = valor), strings entre aspas duplas e blocos com { }.`;
  }
  m = /Reference to undeclared (input variable|local value|resource|module)[\s\S]*?(?:Did you mean "([^"]+)")?/.exec(output);
  if (m) {
    const sug = /Did you mean "([^"]+)"/.exec(output)?.[1];
    const l = /on (\S+) line (\d+)/.exec(output);
    return `O código referencia um(a) ${m[1] === "input variable" ? "variável" : m[1] === "local value" ? "local" : m[1] === "module" ? "módulo" : "recurso"} que não foi declarado(a)${l ? ` (${l[1]}:${l[2]})` : ""}.${sug ? ` Provável typo: o nome certo é "${sug}".` : " Declare o bloco correspondente ou corrija o nome."}`;
  }
  if (/Unsupported block type/.test(output)) {
    const sug = /Did you mean "([^"]+)"/.exec(output)?.[1];
    return `Tipo de bloco desconhecido no nível raiz.${sug ? ` Você quis dizer "${sug}"?` : ""} Blocos válidos: terraform, provider, resource, data, variable, locals, output, module, moved, import. O backend fica DENTRO de terraform { }.`;
  }
  if (/Call to unknown function/.test(output)) return "Essa função não existe no Terraform. Confira o nome (ex.: lower, merge, format, cidrsubnet).";
  if (/No value for required variable/.test(output))
    return `Uma variável obrigatória ficou sem valor. Passe o arquivo do ambiente: -var-file=<arquivo>.tfvars (ou -var 'nome=valor').${sh.listDir(sh.cwd).some((n) => n === "env/") ? " Os tfvars deste projeto estão em env/." : ""}`;
  if (/Failed to read variables file/.test(output)) return "O arquivo passado em -var-file não existe. Liste com ls (neste tipo de projeto costuma ficar em env/dev.tfvars, env/prod.tfvars).";
  if (/Value for undeclared variable/.test(output)) return "Você passou um valor para uma variável que o código não declara. Confira o nome (é o mesmo do bloco variable).";
  if (/Saved plan is stale/.test(output)) return "O state mudou depois que o plano foi salvo. Gere um novo: terraform plan -out=tfplan e aplique esse arquivo.";
  if (/Failed to load "[^"]+" as a plan file/.test(output)) return "Esse arquivo de plano não existe. Gere com terraform plan -out=tfplan e depois terraform apply tfplan.";
  if (/S3 bucket "[^"]+" does not exist/.test(output)) return "O bucket do backend não existe. O bucket de state é criado antes (bootstrap) — confira o nome no bloco backend \"s3\".";
  if (/Variables not allowed/.test(output)) return "O bloco backend não aceita variáveis nem expressões: só valores literais. Para variar por ambiente use -backend-config=arquivo.hcl no init.";
  if (/Missing required argument/.test(output) && /terraform/.test(output)) return "Faltou um argumento obrigatório do backend S3: bucket, key e region.";
  if (/Instance cannot be destroyed/.test(output)) return "O recurso tem lifecycle { prevent_destroy = true } e o plano quer destruí-lo. Se for um refactor, use um bloco moved { } em vez de deixar o Terraform recriar.";
  if (/Unsupported value for raw output/.test(output)) return "-raw só funciona com string, número ou bool. Para listas e mapas use -json.";
  if (/Output "[^"]+" not found/.test(output)) return "Esse output não existe no state deste workspace. Liste com terraform output (e confira o workspace atual com terraform workspace show).";
  if (/Invalid count argument|Invalid for_each argument/.test(output)) return "count/for_each precisam ser conhecidos no plan. Use valores de variáveis/locals, não atributos que só existem depois do apply.";
  if (/Invalid index/.test(output)) return "Índice fora da lista/mapa. Lembre que listas começam em 0 e que com count os endereços são recurso[0], recurso[1]…";
  return null;
};

registerTool({
  name: "terraform",
  aliases: ["tf"],
  summary: "Infrastructure as Code: plan/apply, state remoto, workspaces, import e drift",
  subcommands: SUBCOMMANDS,
  flags: {
    "-auto-approve": "aplica sem pedir confirmação (comum em pipelines)",
    "-migrate-state": "no init: copia o state do backend antigo para o novo",
    "-reconfigure": "no init: usa o backend novo sem copiar o state existente",
    "-upgrade": "no init: atualiza providers/módulos para a versão mais nova permitida",
    "-backend-config": "no init: completa o bloco backend (chave=valor ou arquivo .hcl)",
    "-backend": "no init: -backend=false pula a configuração do backend",
    "-var": "define uma variável (nome=valor)",
    "-var-file": "carrega variáveis de um arquivo .tfvars (ex.: um por ambiente)",
    "-target": "limita o plano a um recurso e suas dependências (só para emergências)",
    "-replace": "força recriar um recurso específico",
    "-refresh-only": "só compara state × nuvem real (detecta drift) sem propor mudanças",
    "-refresh": "-refresh=false pula a leitura da nuvem",
    "-out": "salva o plano num arquivo para aplicar exatamente o que foi revisado",
    "-destroy": "gera um plano de destruição",
    "-lock": "-lock=false desativa o lock do state (perigoso)",
    "-check": "no fmt: só verifica, sem alterar (falha se algo precisar de formatação)",
    "-diff": "no fmt: mostra o diff da formatação",
    "-recursive": "no fmt: inclui subdiretórios (módulos)",
    "-json": "saída em JSON (para scripts/pipelines)",
    "-raw": "no output: imprime o valor cru, sem aspas",
    "-force": "não pede confirmação",
    "-or-create": "no workspace select: cria o workspace se não existir",
    "-chdir": "executa em outro diretório (ex.: -chdir=envs/prod)",
    "-dry-run": "no state mv/rm: mostra o que faria, sem alterar",
  },
  valueFlags: ["-var", "-var-file", "-target", "-replace", "-out", "-backend-config", "-chdir"],
  run: ({ sh, args, env, stdin }) => terraformRun(sh, args, env, stdin),
  explainError: explainTerraformError,
});

// ---------------- helpers for lab seeds and checks ----------------
/** Runs terraform silently (no terminal entries). Throws if it fails — used by lab seeds. */
export const tfSeedRun = (sh: Shell, cmd: string, dir?: string) => {
  const prev = sh.cwd;
  if (dir) sh.cwd = sh.resolve(dir);
  try {
    const r = terraformRun(sh, tokenize(cmd).slice(1));
    if (!r.ok) throw new Error(`seed "${cmd}" failed:\n${r.output}`);
    return r.output;
  } finally {
    sh.cwd = prev;
  }
};

export const tfCloud = (sh: Shell) => tfExt(sh).cloud;
export const tfCloudPut = (sh: Shell, type: string, id: string, attrs: Attrs) => {
  tfExt(sh).cloud.objects[cloudKey(type, id)] = attrs;
};
export const tfCloudGet = (sh: Shell, type: string, id: string): Attrs | undefined => tfExt(sh).cloud.objects[cloudKey(type, id)];
export const tfSetLock = (sh: Shell, path: string, info: Partial<LockInfo> & { ID: string }) => {
  tfExt(sh).cloud.locks[path] = { Path: path, Operation: "OperationTypeApply", Who: "runner@gha-runner-7f9c", Version: TF_VERSION, Created: "2026-09-23 03:12:44.912803 +0000 UTC", Info: "", ...info };
};
export const tfLocks = (sh: Shell) => tfExt(sh).cloud.locks;
export const tfBackend = (sh: Shell, dir = sh.cwd) => (everInitialized(sh, dir) ? storedBackend(sh, dir) : LOCAL);
export const tfWorkspace = (sh: Shell, dir = sh.cwd) => currentWorkspace(sh, dir);
export const tfWorkspaces = (sh: Shell, dir = sh.cwd) => listWorkspaces(sh, dir, tfBackend(sh, dir));
/** State of a workspace in the directory's current backend. */
export const tfState = (sh: Shell, ws?: string, dir = sh.cwd): TfState | null => readState(sh, dir, tfBackend(sh, dir), ws ?? currentWorkspace(sh, dir));
export const tfLastPlan = (sh: Shell) => tfExt(sh).lastPlan;
export const tfLastApply = (sh: Shell) => tfExt(sh).lastApply;
export const tfOutputsIn = (sh: Shell) => tfExt(sh).outputsIn;
/** Configuration errors (parse + semantic), as rendered diagnostics. Empty when valid. */
export const tfConfigErrors = (sh: Shell, dir = sh.cwd, semantic = true): Diag[] => {
  const diags: Diag[] = [];
  const cfg = loadModule(sh, dir, diags);
  if (!hasErrors(diags) && semantic) validateModule(cfg, diags);
  return diags.filter((d) => !d.warning);
};
export const tfConfig = (sh: Shell, dir = sh.cwd) => loadModule(sh, dir, []);
/** Silent plan (no locks, no output) — for step checks. Null when the config does not plan. */
export const tfPreview = (sh: Shell, dir = sh.cwd, vars: string[] = []): PlanSummary | null => {
  const p = prepare(sh, dir, new Opts(vars.flatMap((v) => ["-var-file", v])), sh.env);
  if (isRes(p)) return null;
  const prior = readState(sh, dir, p.be, p.ws) ?? emptyState();
  const opts: RunOpts = { vars: p.vars, targets: [], replace: [] };
  const r = runEngine(sh, p.cfg, p.ws, prior, "plan", opts);
  if (!r.ok) return null;
  return summarize(dir, p.ws, p.be, r, opts, renderPlan(r, opts).noChanges);
};
export type { TfState, PlanSummary };
