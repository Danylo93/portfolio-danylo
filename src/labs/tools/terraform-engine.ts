// Simulated Terraform core: configuration loading, evaluation, state storage (local / S3),
// a fake AWS "cloud" (for refresh, drift and import) and plan/apply.
import type { Shell } from "../shell";
import { closest, hexId, normalizePath } from "../util";
import {
  type Attr, type Block, type Diag, type Expr, type Obj, type Value,
  HclError, SPLAT_IT, UNK, Unknown, callsOf, clone, exprToAddr, hasUnknown, isObj, parseHcl, refsOf, valEq,
} from "./terraform-hcl";

export const TF_VERSION = "1.9.5";
export const ACCOUNT_ID = "123456789012";
export const PROVIDER_VERSIONS: Record<string, string> = {
  aws: "5.62.0", random: "3.6.2", kubernetes: "2.32.0", helm: "2.15.0", tls: "4.0.5", null: "3.2.3", local: "2.5.2",
};

export type Attrs = Obj;

// ---------------- configuration ----------------
export type ResCfg = { mode: "managed" | "data"; type: string; name: string; body: Block; count?: Attr; forEach?: Attr; preventDestroy: boolean };
export type VarCfg = { name: string; def?: Expr; type?: string; line: number; file: string; sensitive: boolean };
export type ModCall = { name: string; source: string; attrs: Attr[]; line: number; file: string };
export type BackendBlock = { type: string; attrs: Attr[]; line: number; file: string };
export type ModCfg = {
  dir: string;
  files: Record<string, string>;
  variables: Record<string, VarCfg>;
  locals: Record<string, Attr & { file: string }>;
  outputs: Record<string, { expr: Expr; sensitive: boolean; line: number; file: string }>;
  resources: ResCfg[];
  modules: Record<string, ModCall>;
  children: Record<string, ModCfg | null>;
  moved: { from: string; to: string; line: number; file: string }[];
  imports: { to: string; id: Expr; line: number; file: string }[];
  backend?: BackendBlock;
  required: Record<string, { source: string; version?: string }>;
  region: string;
};

const TOP_BLOCKS = ["terraform", "provider", "resource", "data", "variable", "locals", "output", "module", "moved", "import", "removed", "check"];
const META_ATTRS = new Set(["count", "for_each", "depends_on", "provider"]);

const litValue = (e: Expr): Value | undefined => {
  if (e.t === "lit") return e.v;
  if (e.t === "list") {
    const items = e.items.map(litValue);
    return items.some((i) => i === undefined) ? undefined : (items as Value[]);
  }
  if (e.t === "obj") {
    const o: Obj = {};
    for (const it of e.items) {
      const k = it.k.t === "var" ? it.k.name : litValue(it.k);
      const v = litValue(it.v);
      if (typeof k !== "string" || v === undefined) return undefined;
      o[k] = v;
    }
    return o;
  }
  return undefined;
};

const typeText = (e: Expr): string =>
  e.t === "var" ? e.name : e.t === "call" ? `${e.name}(${e.args.map(typeText).join(", ")})` : e.t === "lit" ? String(e.v) : "any";

export const blockHeader = (b: Block) => [b.type, ...b.labels.map((l) => `"${l}"`)].join(" ");

/** Loads a module directory (and local child modules). Parse and structural errors go to diags. */
export const loadModule = (sh: Shell, dir: string, diags: Diag[], depth = 0, rootDir = dir): ModCfg => {
  const mod: ModCfg = {
    dir, files: {}, variables: {}, locals: {}, outputs: {}, resources: [], modules: {}, children: {}, moved: [], imports: [], required: {}, region: "us-east-1",
  };
  const names = sh.listDir(dir).filter((n) => n.endsWith(".tf")).sort();
  for (const n of names) {
    const src = sh.readFile(`${dir}/${n}`) ?? "";
    mod.files[n] = src;
    const shown = dir === rootDir ? n : `${dir.slice(rootDir.length + 1)}/${n}`;
    let body;
    try {
      body = parseHcl(src, shown);
    } catch (e) {
      if (e instanceof HclError) {
        diags.push({ ...e.diag, file: shown });
        continue;
      }
      throw e;
    }
    for (const b of body.blocks) addBlock(mod, b, diags);
    for (const a of body.attrs)
      diags.push({ summary: "Unsupported argument", detail: `An argument named "${a.name}" is not expected here.`, file: shown, line: a.line });
  }
  for (const call of Object.values(mod.modules)) {
    if (/^\.\.?\//.test(call.source)) {
      const childDir = normalizePath(`${dir}/${call.source}`);
      mod.children[call.name] = sh.isDir(childDir) && depth < 5 ? loadModule(sh, childDir, diags, depth + 1, rootDir) : null;
    } else mod.children[call.name] = null;
  }
  return mod;
};

const addBlock = (mod: ModCfg, b: Block, diags: Diag[]) => {
  const at = { file: b.file, line: b.line };
  const attr = (name: string) => b.attrs.find((a) => a.name === name);
  switch (b.type) {
    case "terraform":
      for (const sub of b.blocks) {
        if (sub.type === "backend") mod.backend = { type: sub.labels[0] ?? "", attrs: sub.attrs, line: sub.line, file: sub.file };
        if (sub.type === "required_providers")
          for (const a of sub.attrs) {
            const v = litValue(a.expr);
            if (isObj(v)) mod.required[a.name] = { source: String(v.source ?? `hashicorp/${a.name}`), version: v.version as string | undefined };
            else if (typeof v === "string") mod.required[a.name] = { source: `hashicorp/${a.name}`, version: v };
          }
      }
      return;
    case "provider": {
      const r = attr("region");
      const v = r && litValue(r.expr);
      if (typeof v === "string") mod.region = v;
      return;
    }
    case "resource":
    case "data": {
      const [type, name] = b.labels;
      if (!type || !name) {
        diags.push({ ...at, summary: `Missing name for ${b.type}`, detail: `All ${b.type} blocks must have 2 labels (type, name).` });
        return;
      }
      const mode = b.type === "data" ? "data" : "managed";
      const dup = mod.resources.find((r) => r.mode === mode && r.type === type && r.name === name);
      if (dup) {
        diags.push({
          ...at,
          summary: `Duplicate ${mode === "data" ? "data" : "resource"} "${type}" configuration`,
          detail: `A ${type} ${mode === "data" ? "data resource" : "resource"} named "${name}" was already declared at ${dup.body.file}:${dup.body.line}. Resource names must be unique per type in each module.`,
          ctx: `in ${blockHeader(b)}`,
        });
        return;
      }
      const lc = b.blocks.find((x) => x.type === "lifecycle");
      const pd = lc?.attrs.find((a) => a.name === "prevent_destroy");
      mod.resources.push({ mode, type, name, body: b, count: attr("count"), forEach: attr("for_each"), preventDestroy: !!pd && litValue(pd.expr) === true });
      return;
    }
    case "variable": {
      const name = b.labels[0];
      if (mod.variables[name]) {
        diags.push({ ...at, summary: "Duplicate variable declaration", detail: `A variable named "${name}" was already declared at ${mod.variables[name].file}:${mod.variables[name].line}. Variable names must be unique within a module.` });
        return;
      }
      const t = attr("type");
      mod.variables[name] = { name, def: attr("default")?.expr, type: t ? typeText(t.expr) : undefined, line: b.line, file: b.file, sensitive: litValue(attr("sensitive")?.expr ?? { t: "lit", v: false }) === true };
      return;
    }
    case "locals":
      for (const a of b.attrs) mod.locals[a.name] = { ...a, file: b.file };
      return;
    case "output": {
      const v = attr("value");
      if (!v) {
        diags.push({ ...at, summary: "Missing required argument", detail: 'The argument "value" is required, but no definition was found.', ctx: `in ${blockHeader(b)}` });
        return;
      }
      mod.outputs[b.labels[0]] = { expr: v.expr, sensitive: litValue(attr("sensitive")?.expr ?? { t: "lit", v: false }) === true, line: b.line, file: b.file };
      return;
    }
    case "module": {
      const src = attr("source");
      const s = src && litValue(src.expr);
      if (typeof s !== "string") {
        diags.push({ ...at, summary: "Missing required argument", detail: 'The argument "source" is required, but no definition was found.', ctx: `in ${blockHeader(b)}` });
        return;
      }
      mod.modules[b.labels[0]] = { name: b.labels[0], source: s, attrs: b.attrs.filter((a) => !["source", "version", "providers", "depends_on", "count", "for_each"].includes(a.name)), line: b.line, file: b.file };
      return;
    }
    case "moved": {
      const from = attr("from");
      const to = attr("to");
      const f = from && exprToAddr(from.expr);
      const t = to && exprToAddr(to.expr);
      if (!f || !t) {
        diags.push({ ...at, summary: "Invalid address", detail: 'A moved block requires "from" and "to" arguments with resource or module addresses, e.g. from = aws_s3_bucket.logs.', ctx: "in moved" });
        return;
      }
      mod.moved.push({ from: f, to: t, ...at });
      return;
    }
    case "import": {
      const to = attr("to");
      const id = attr("id");
      const t = to && exprToAddr(to.expr);
      if (!t || !id) {
        diags.push({ ...at, summary: "Missing required argument", detail: 'An import block requires the "to" and "id" arguments.', ctx: "in import" });
        return;
      }
      mod.imports.push({ to: t, id: id.expr, ...at });
      return;
    }
    case "removed":
    case "check":
      return;
    default: {
      const sug = closest(b.type, TOP_BLOCKS);
      diags.push({ ...at, summary: "Unsupported block type", detail: `Blocks of type "${b.type}" are not expected here.${sug ? ` Did you mean "${sug}"?` : ""}` });
    }
  }
};

// ---------------- semantic validation ----------------
const FUNCS_KNOWN = [
  "length", "lower", "upper", "toset", "tolist", "tomap", "tostring", "tonumber", "merge", "concat", "join", "split", "format", "lookup", "element", "keys", "values",
  "contains", "try", "coalesce", "jsonencode", "cidrsubnet", "replace", "trimspace", "max", "min", "flatten", "distinct", "range", "file", "templatefile",
  "can", "sort", "zipmap", "substr", "title", "abs", "ceil", "floor", "one", "startswith", "endswith", "base64encode", "sha256", "md5", "timestamp", "uuid",
];
const REF_ROOTS = new Set(["var", "local", "module", "data", "count", "each", "path", "terraform", "self"]);

type ExprAt = { expr: Expr; line: number; file: string; ctx: string };

const exprsOf = (mod: ModCfg): ExprAt[] => {
  const out: ExprAt[] = [];
  const fromBlock = (b: Block, file: string, ctx: string) => {
    for (const a of b.attrs) out.push({ expr: a.expr, line: a.line, file, ctx });
    for (const sb of b.blocks) if (sb.type !== "lifecycle") fromBlock(sb, file, ctx);
  };
  for (const r of mod.resources) fromBlock(r.body, r.body.file, `in ${blockHeader(r.body)}`);
  for (const [n, l] of Object.entries(mod.locals)) out.push({ expr: l.expr, line: l.line, file: l.file, ctx: `in locals` + (n ? "" : "") });
  for (const [n, o] of Object.entries(mod.outputs)) out.push({ expr: o.expr, line: o.line, file: o.file, ctx: `in output "${n}"` });
  for (const m of Object.values(mod.modules)) for (const a of m.attrs) out.push({ expr: a.expr, line: a.line, file: m.file, ctx: `in module "${m.name}"` });
  return out;
};

export const validateModule = (mod: ModCfg, diags: Diag[], where = "the root module") => {
  for (const x of exprsOf(mod)) {
    for (const fn of callsOf(x.expr))
      if (!FUNCS_KNOWN.includes(fn)) {
        const sug = closest(fn, FUNCS_KNOWN);
        diags.push({ summary: "Call to unknown function", detail: `There is no function named "${fn}".${sug ? ` Did you mean "${sug}"?` : ""}`, file: x.file, line: x.line, ctx: x.ctx });
      }
    for (const p of refsOf(x.expr)) {
      const [root, a, b] = p;
      const at = { file: x.file, line: x.line, ctx: x.ctx };
      if (root === "var" && a && !mod.variables[a]) {
        const sug = closest(a, Object.keys(mod.variables));
        diags.push({ ...at, summary: "Reference to undeclared input variable", detail: `An input variable with the name "${a}" has not been declared.${sug ? ` Did you mean "${sug}"?` : ` This variable can be declared with a variable "${a}" {} block.`}` });
      } else if (root === "local" && a && !mod.locals[a]) {
        const sug = closest(a, Object.keys(mod.locals));
        diags.push({ ...at, summary: "Reference to undeclared local value", detail: `A local value with the name "${a}" has not been declared.${sug ? ` Did you mean "${sug}"?` : ""}` });
      } else if (root === "module" && a && !mod.modules[a]) {
        diags.push({ ...at, summary: "Reference to undeclared module", detail: `No module call named "${a}" is declared in ${where}.` });
      } else if (root === "module" && a && b && mod.children[a] && !mod.children[a]!.outputs[b]) {
        diags.push({ ...at, summary: "Unsupported attribute", detail: `This object does not have an attribute named "${b}".` });
      } else if (root === "data" && a && b && !mod.resources.some((r) => r.mode === "data" && r.type === a && r.name === b)) {
        diags.push({ ...at, summary: "Reference to undeclared resource", detail: `A data resource "${a}" "${b}" has not been declared in ${where}.` });
      } else if (!REF_ROOTS.has(root) && root.includes("_") && a) {
        if (!mod.resources.some((r) => r.mode === "managed" && r.type === root && r.name === a)) {
          const sug = closest(a, mod.resources.filter((r) => r.type === root).map((r) => r.name));
          diags.push({ ...at, summary: "Reference to undeclared resource", detail: `A managed resource "${root}" "${a}" has not been declared in ${where}.${sug ? ` Did you mean "${root}.${sug}"?` : ""}` });
        }
      }
    }
  }
  for (const [n, c] of Object.entries(mod.children)) if (c) validateModule(c, diags, `module.${n}`);
};

// ---------------- cloud (fake AWS account) ----------------
export type LockInfo = { ID: string; Path: string; Operation: string; Who: string; Version: string; Created: string; Info: string };
export type Cloud = {
  /** `${type}|${id}` → remote object attributes */
  objects: Record<string, Attrs>;
  /** `${bucket}/${key}` → state JSON */
  s3: Record<string, string>;
  /** lock path (bucket/key) → lock */
  locks: Record<string, LockInfo>;
};
export type SavedPlan = { dir: string; ws: string; lineage: string; serial: number; opts: RunOpts };
export type PlanSummary = {
  dir: string; ws: string; backend: string; add: number; change: number; destroy: number; imported: number; moved: number; drift: number;
  refreshOnly: boolean; destroyMode: boolean; noChanges: boolean; errors: number;
};
export type TfExt = { cloud: Cloud; plans: Record<string, SavedPlan>; lastPlan?: PlanSummary; lastApply?: PlanSummary; outputsIn: string[] };

export const tfExt = (sh: Shell) => sh.ext<TfExt>("terraform", () => ({ cloud: { objects: {}, s3: {}, locks: {} }, plans: {}, outputsIn: [] }));
export const cloudKey = (type: string, id: string) => `${type}|${id}`;

// ---------------- state ----------------
export type StateRes = { type: string; attrs: Attrs; tainted?: boolean };
export type TfState = { serial: number; lineage: string; resources: Record<string, StateRes>; outputs: Record<string, { value: Value; sensitive: boolean }> };

export const emptyState = (): TfState => ({ serial: 0, lineage: `${hexId(8)}-${hexId(4)}-${hexId(4)}-${hexId(4)}-${hexId(12)}`, resources: {}, outputs: {} });

export const ADDR_RE = /^((?:module\.[\w-]+(?:\[[^\]]+\])?\.)*)(data\.)?([\w-]+)\.([\w-]+)(\[(\d+|"[^"]*")\])?$/;
export const parseAddr = (addr: string) => {
  const m = ADDR_RE.exec(addr);
  if (!m) return null;
  return { module: m[1].replace(/\.$/, ""), mode: m[2] ? "data" : "managed", type: m[3], name: m[4], key: m[6] === undefined ? undefined : /^\d+$/.test(m[6]) ? Number(m[6]) : (JSON.parse(m[6]) as string) };
};

const outType = (v: Value): unknown =>
  typeof v === "string" ? "string" : typeof v === "number" ? "number" : typeof v === "boolean" ? "bool"
  : Array.isArray(v) ? ["tuple", v.map(outType)] : isObj(v) ? ["object", Object.fromEntries(Object.entries(v).map(([k, x]) => [k, outType(x)]))] : "dynamic";

export const stateToJson = (st: TfState) => {
  const groups = new Map<string, { module?: string; mode: string; type: string; name: string; provider: string; instances: unknown[] }>();
  for (const [addr, r] of Object.entries(st.resources).sort(([a], [b]) => (a < b ? -1 : 1))) {
    const p = parseAddr(addr);
    if (!p) continue;
    const gk = `${p.module}|${p.type}.${p.name}`;
    if (!groups.has(gk))
      groups.set(gk, { ...(p.module ? { module: p.module } : {}), mode: "managed", type: p.type, name: p.name, provider: `provider["registry.terraform.io/hashicorp/${p.type.split("_")[0]}"]`, instances: [] });
    groups.get(gk)!.instances.push({ ...(p.key !== undefined ? { index_key: p.key } : {}), ...(r.tainted ? { status: "tainted" } : {}), schema_version: 0, attributes: r.attrs, sensitive_attributes: [] });
  }
  return JSON.stringify(
    {
      version: 4, terraform_version: TF_VERSION, serial: st.serial, lineage: st.lineage,
      outputs: Object.fromEntries(Object.entries(st.outputs).map(([k, o]) => [k, { value: o.value, type: outType(o.value), ...(o.sensitive ? { sensitive: true } : {}) }])),
      resources: [...groups.values()], check_results: null,
    },
    null,
    2,
  );
};

export const stateFromJson = (s: string): TfState | null => {
  try {
    const j = JSON.parse(s);
    const st: TfState = { serial: j.serial ?? 0, lineage: j.lineage ?? "", resources: {}, outputs: {} };
    for (const [k, o] of Object.entries<{ value: Value; sensitive?: boolean }>(j.outputs ?? {})) st.outputs[k] = { value: o.value, sensitive: !!o.sensitive };
    for (const r of j.resources ?? []) {
      if (r.mode !== "managed") continue;
      for (const i of r.instances ?? []) {
        const key = i.index_key === undefined ? "" : typeof i.index_key === "number" ? `[${i.index_key}]` : `[${JSON.stringify(i.index_key)}]`;
        st.resources[`${r.module ? r.module + "." : ""}${r.type}.${r.name}${key}`] = { type: r.type, attrs: i.attributes ?? {}, ...(i.status === "tainted" ? { tainted: true } : {}) };
      }
    }
    return st;
  } catch {
    return null;
  }
};

// ---------------- backends & workspaces ----------------
export type Backend = { type: string; config: Record<string, Value>; block: Record<string, Value> };
export const LOCAL: Backend = { type: "local", config: {}, block: {} };

export const tfDir = (dir: string) => `${dir}/.terraform`;
export const providersInstalled = (sh: Shell, dir: string) => sh.readFile(`${dir}/.terraform.lock.hcl`) !== undefined && sh.isDir(`${dir}/.terraform/providers`);
export const everInitialized = (sh: Shell, dir: string) => sh.isDir(`${dir}/.terraform`);

/** Backend recorded by the last `terraform init` (local when none). */
export const storedBackend = (sh: Shell, dir: string): Backend => {
  const raw = sh.readFile(`${dir}/.terraform/terraform.tfstate`);
  if (!raw) return LOCAL;
  try {
    const j = JSON.parse(raw);
    return j.backend ? { type: j.backend.type, config: j.backend.config ?? {}, block: j.backend.block ?? {} } : LOCAL;
  } catch {
    return LOCAL;
  }
};

export const writeStoredBackend = (sh: Shell, dir: string, be: Backend) => {
  if (be.type === "local") sh.removePath(`${dir}/.terraform/terraform.tfstate`);
  else
    sh.writeFile(
      `${dir}/.terraform/terraform.tfstate`,
      JSON.stringify({ version: 3, terraform_version: TF_VERSION, backend: { type: be.type, config: be.config, block: be.block, hash: 1000000000 + JSON.stringify(be.block).length * 7919 } }, null, 2),
    );
};

export const currentWorkspace = (sh: Shell, dir: string) => (sh.readFile(`${dir}/.terraform/environment`) ?? "default").trim() || "default";
export const setWorkspace = (sh: Shell, dir: string, ws: string) => {
  if (ws === "default") sh.removePath(`${dir}/.terraform/environment`);
  else sh.writeFile(`${dir}/.terraform/environment`, ws);
};

export const s3StateKey = (be: Backend, ws: string) => {
  const prefix = String(be.config.workspace_key_prefix ?? "env:");
  return ws === "default" ? `${be.config.bucket}/${be.config.key}` : `${be.config.bucket}/${prefix}/${ws}/${be.config.key}`;
};
export const lockingEnabled = (be: Backend) => be.type === "s3" && (!!be.config.dynamodb_table || be.config.use_lockfile === true);
const localStatePath = (dir: string, ws: string) => (ws === "default" ? `${dir}/terraform.tfstate` : `${dir}/terraform.tfstate.d/${ws}/terraform.tfstate`);

export const readState = (sh: Shell, dir: string, be: Backend, ws: string): TfState | null => {
  const raw = be.type === "s3" ? tfExt(sh).cloud.s3[s3StateKey(be, ws)] : sh.readFile(localStatePath(dir, ws));
  return raw ? stateFromJson(raw) : null;
};

export const writeState = (sh: Shell, dir: string, be: Backend, ws: string, st: TfState) => {
  const json = stateToJson(st);
  if (be.type === "s3") tfExt(sh).cloud.s3[s3StateKey(be, ws)] = json;
  else {
    const p = localStatePath(dir, ws);
    const prev = sh.readFile(p);
    if (prev) sh.writeFile(p.replace(/terraform\.tfstate$/, "terraform.tfstate.backup"), prev);
    sh.writeFile(p, json);
  }
};

export const listWorkspaces = (sh: Shell, dir: string, be: Backend): string[] => {
  const out = new Set(["default"]);
  if (be.type === "s3") {
    const prefix = `${be.config.bucket}/${String(be.config.workspace_key_prefix ?? "env:")}/`;
    for (const k of Object.keys(tfExt(sh).cloud.s3))
      if (k.startsWith(prefix) && k.endsWith(`/${be.config.key}`)) out.add(k.slice(prefix.length).split("/")[0]);
  } else if (sh.isDir(`${dir}/terraform.tfstate.d`)) for (const n of sh.listDir(`${dir}/terraform.tfstate.d`)) out.add(n.replace(/\/$/, ""));
  return ["default", ...[...out].filter((w) => w !== "default").sort()];
};

export const createWorkspace = (sh: Shell, dir: string, be: Backend, ws: string) => {
  if (be.type === "s3") tfExt(sh).cloud.s3[s3StateKey(be, ws)] = stateToJson(emptyState());
  else sh.mkdir(`${dir}/terraform.tfstate.d/${ws}`);
};

export const deleteWorkspace = (sh: Shell, dir: string, be: Backend, ws: string) => {
  if (be.type === "s3") delete tfExt(sh).cloud.s3[s3StateKey(be, ws)];
  else sh.removePath(`${dir}/terraform.tfstate.d/${ws}`);
};

export const lockPath = (be: Backend, ws: string) => s3StateKey(be, ws);

// ---------------- AWS resource behaviour ----------------
const FORCE_NEW: Record<string, string[]> = {
  aws_s3_bucket: ["bucket"], aws_s3_bucket_versioning: ["bucket"], aws_s3_bucket_public_access_block: ["bucket"], aws_s3_bucket_server_side_encryption_configuration: ["bucket"],
  aws_vpc: ["cidr_block"], aws_subnet: ["cidr_block", "availability_zone", "vpc_id"], aws_instance: ["ami", "subnet_id", "availability_zone"],
  aws_eks_cluster: ["name"], aws_eks_node_group: ["node_group_name", "cluster_name", "instance_types"], aws_dynamodb_table: ["name", "hash_key"],
  aws_security_group: ["name", "vpc_id"], aws_iam_role: ["name"], aws_db_instance: ["identifier", "engine"], aws_cloudwatch_log_group: ["name"],
  aws_ecr_repository: ["name"], aws_kms_alias: ["name"], aws_route53_zone: ["name"],
};

const hex17 = () => hexId(17);
const arn = (svc: string, region: string, res: string) => `arn:aws:${svc}:${region}:${ACCOUNT_ID}:${res}`;
/** Attributes the provider computes on create, per type. */
const COMPUTED: Record<string, (a: Attrs, region: string) => Attrs> = {
  aws_s3_bucket: (a) => ({ id: a.bucket, arn: `arn:aws:s3:::${a.bucket}`, bucket_domain_name: `${a.bucket}.s3.amazonaws.com`, hosted_zone_id: "Z7KQH4QJS55SO" }),
  aws_s3_bucket_versioning: (a) => ({ id: a.bucket }),
  aws_s3_bucket_public_access_block: (a) => ({ id: a.bucket }),
  aws_s3_bucket_server_side_encryption_configuration: (a) => ({ id: a.bucket }),
  aws_dynamodb_table: (a, r) => ({ id: a.name, arn: arn("dynamodb", r, `table/${a.name}`) }),
  aws_vpc: (_, r) => {
    const id = `vpc-${hex17()}`;
    return { id, arn: arn("ec2", r, `vpc/${id}`), default_security_group_id: `sg-${hex17()}`, main_route_table_id: `rtb-${hex17()}` };
  },
  aws_subnet: (_, r) => {
    const id = `subnet-${hex17()}`;
    return { id, arn: arn("ec2", r, `subnet/${id}`) };
  },
  aws_security_group: (_, r) => {
    const id = `sg-${hex17()}`;
    return { id, arn: arn("ec2", r, `security-group/${id}`) };
  },
  aws_instance: (_, r) => {
    const id = `i-${hex17()}`;
    return { id, arn: arn("ec2", r, `instance/${id}`), private_ip: `10.0.${Math.floor(Math.random() * 200) + 1}.${Math.floor(Math.random() * 250) + 2}`, instance_state: "running" };
  },
  aws_eks_cluster: (a, r) => ({ id: a.name, arn: arn("eks", r, `cluster/${a.name}`), endpoint: `https://${hexId(32).toUpperCase()}.gr7.${r}.eks.amazonaws.com`, status: "ACTIVE" }),
  aws_eks_node_group: (a, r) => ({ id: `${a.cluster_name}:${a.node_group_name ?? "workers"}`, arn: arn("eks", r, `nodegroup/${a.cluster_name}/${a.node_group_name ?? "workers"}/${hexId(8)}`), status: "ACTIVE" }),
  aws_iam_role: (a) => ({ id: a.name, arn: `arn:aws:iam::${ACCOUNT_ID}:role/${a.name}`, unique_id: `AROA${hexId(17).toUpperCase()}` }),
  aws_cloudwatch_log_group: (a, r) => ({ id: a.name, arn: arn("logs", r, `log-group:${a.name}`) }),
  aws_ecr_repository: (a, r) => ({ id: a.name, arn: arn("ecr", r, `repository/${a.name}`), repository_url: `${ACCOUNT_ID}.dkr.ecr.${r}.amazonaws.com/${a.name}` }),
  aws_internet_gateway: (_, r) => {
    const id = `igw-${hex17()}`;
    return { id, arn: arn("ec2", r, `internet-gateway/${id}`) };
  },
  aws_route_table: () => ({ id: `rtb-${hex17()}` }),
  aws_eip: () => ({ id: `eipalloc-${hex17()}`, public_ip: `54.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` }),
  aws_nat_gateway: () => ({ id: `nat-${hex17()}` }),
  aws_kms_key: (_, r) => {
    const id = `${hexId(8)}-${hexId(4)}-${hexId(4)}-${hexId(4)}-${hexId(12)}`;
    return { id, key_id: id, arn: arn("kms", r, `key/${id}`) };
  },
  aws_sqs_queue: (a, r) => ({ id: `https://sqs.${r}.amazonaws.com/${ACCOUNT_ID}/${a.name}`, arn: arn("sqs", r, String(a.name)) }),
};
const computedFor = (type: string, a: Attrs, region: string): Attrs => {
  const f = COMPUTED[type];
  const out = f ? f(a, region) : { id: hexId(16) };
  if (!("id" in out) || out.id === undefined) out.id = hexId(16);
  return out;
};
const computedKeys = (type: string) => Object.keys(computedFor(type, { bucket: "x", name: "x", cluster_name: "x" }, "us-east-1"));

const DURATION: Record<string, [string, string?]> = {
  aws_eks_cluster: ["9m58s", "9m50s"], aws_eks_node_group: ["2m11s", "2m0s"], aws_db_instance: ["6m32s", "6m20s"], aws_nat_gateway: ["1m45s", "1m40s"],
  aws_instance: ["13s"], aws_vpc: ["2s"], aws_dynamodb_table: ["8s"],
};
const dur = (type: string) => DURATION[type] ?? ["1s"];

const dataSource = (type: string, cfg: Attrs, region: string, cloud: Cloud): Attrs | Unknown => {
  switch (type) {
    case "aws_caller_identity":
      return { id: ACCOUNT_ID, account_id: ACCOUNT_ID, arn: `arn:aws:iam::${ACCOUNT_ID}:user/danylo`, user_id: "AIDA4EXAMPLEUSERID" };
    case "aws_region":
      return { id: region, name: region, description: region };
    case "aws_availability_zones":
      return { id: region, names: ["a", "b", "c"].map((z) => region + z) };
    case "aws_ami":
      return { id: "ami-0c1a7f89451184c8b", name: "ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-20240801" };
    case "aws_s3_bucket":
      return cloud.objects[cloudKey("aws_s3_bucket", String(cfg.bucket))] ?? UNK;
    default:
      return UNK;
  }
};

// ---------------- functions ----------------
const str = (v: Value): string => (typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : JSON.stringify(v));
const cidrsubnet = (prefix: string, newbits: number, netnum: number): string => {
  const [ip, len] = prefix.split("/");
  const n = ip.split(".").reduce((acc, o) => acc * 256 + Number(o), 0);
  const newLen = Number(len) + newbits;
  const addr = n + netnum * 2 ** (32 - newLen);
  return `${[24, 16, 8, 0].map((s) => Math.floor(addr / 2 ** s) % 256).join(".")}/${newLen}`;
};
const FUNCS: Record<string, (args: Value[], sh: Shell, dir: string) => Value> = {
  length: ([v]) => (Array.isArray(v) ? v.length : isObj(v) ? Object.keys(v).length : str(v).length),
  lower: ([v]) => str(v).toLowerCase(),
  upper: ([v]) => str(v).toUpperCase(),
  title: ([v]) => str(v).replace(/\b\w/g, (c) => c.toUpperCase()),
  toset: ([v]) => (Array.isArray(v) ? [...new Map<string, Value>(v.map((x): [string, Value] => [JSON.stringify(x), x])).values()] : v),
  distinct: ([v]) => (Array.isArray(v) ? [...new Map<string, Value>(v.map((x): [string, Value] => [JSON.stringify(x), x])).values()] : v),
  tolist: ([v]) => v,
  tomap: ([v]) => v,
  tostring: ([v]) => str(v),
  tonumber: ([v]) => Number(v),
  merge: (args) => Object.assign({}, ...args.filter(isObj)),
  concat: (args) => args.flatMap((a) => (Array.isArray(a) ? a : [])),
  flatten: ([v]) => (Array.isArray(v) ? v.flat(Infinity as 1) as Value[] : v),
  join: ([sep, list]) => (Array.isArray(list) ? list.map(str).join(str(sep)) : ""),
  split: ([sep, s]) => str(s).split(str(sep)),
  format: ([f, ...rest]) => {
    let i = 0;
    return str(f).replace(/%[sdv]/g, () => str(rest[i++] ?? ""));
  },
  lookup: ([m, k, d]) => (isObj(m) && str(k) in m ? m[str(k)] : d ?? null),
  element: ([l, i]) => (Array.isArray(l) && l.length ? l[Number(i) % l.length] : null),
  keys: ([m]) => (isObj(m) ? Object.keys(m).sort() : []),
  values: ([m]) => (isObj(m) ? Object.keys(m).sort().map((k) => m[k]) : []),
  contains: ([l, v]) => Array.isArray(l) && l.some((x) => valEq(x, v)),
  coalesce: (args) => args.find((a) => a !== null && a !== "") ?? null,
  try: (args) => args.find((a) => a !== undefined) ?? null,
  can: () => true,
  one: ([l]) => (Array.isArray(l) ? l[0] ?? null : l),
  jsonencode: ([v]) => JSON.stringify(v),
  cidrsubnet: ([p, b, n]) => cidrsubnet(str(p), Number(b), Number(n)),
  replace: ([s, a, b]) => str(s).split(str(a)).join(str(b)),
  trimspace: ([s]) => str(s).trim(),
  substr: ([s, o, l]) => str(s).substr(Number(o), Number(l) < 0 ? undefined : Number(l)),
  max: (args) => Math.max(...args.map(Number)),
  min: (args) => Math.min(...args.map(Number)),
  abs: ([n]) => Math.abs(Number(n)),
  ceil: ([n]) => Math.ceil(Number(n)),
  floor: ([n]) => Math.floor(Number(n)),
  range: ([a, b]) => (b === undefined ? Array.from({ length: Number(a) }, (_, i) => i) : Array.from({ length: Number(b) - Number(a) }, (_, i) => Number(a) + i)),
  sort: ([l]) => (Array.isArray(l) ? [...l].map(str).sort() : l),
  zipmap: ([k, v]) => (Array.isArray(k) && Array.isArray(v) ? Object.fromEntries(k.map((x, i) => [str(x), v[i]])) : {}),
  startswith: ([s, p]) => str(s).startsWith(str(p)),
  endswith: ([s, p]) => str(s).endsWith(str(p)),
  base64encode: ([s]) => btoa(str(s)),
  sha256: ([s]) => hexId(64) + str(s).slice(0, 0),
  md5: ([s]) => hexId(32) + str(s).slice(0, 0),
  timestamp: () => new Date().toISOString().replace(/\.\d+Z$/, "Z"),
  uuid: () => `${hexId(8)}-${hexId(4)}-${hexId(4)}-${hexId(4)}-${hexId(12)}`,
  file: ([p], sh, dir) => sh.readFile(`${dir}/${str(p).replace(/^\$\{path\.module\}\/?/, "")}`) ?? "",
  templatefile: ([p], sh, dir) => sh.readFile(`${dir}/${str(p)}`) ?? "",
};

// ---------------- evaluation ----------------
class LazyObj {
  constructor(public get: (k: string) => Value | undefined) {}
}
type EV = Value | LazyObj;

export class EvalError extends Error {
  constructor(public diag: Diag) {
    super(diag.summary);
  }
}

type Scope = { m: ModInst; count?: number; each?: { key: string; value: Value }; locals?: Record<string, Value>; at?: { file: string; line: number; ctx?: string } };

type Inst = { addr: string; cfg: ResCfg; m: ModInst; count?: number; each?: { key: string; value: Value } };

class ModInst {
  private varCache = new Map<string, Value>();
  private localCache = new Map<string, Value>();
  private keysCache = new Map<ResCfg, (number | string)[] | null>();
  children = new Map<string, ModInst>();
  constructor(
    public eng: Engine,
    public cfg: ModCfg,
    public prefix: string,
    public argOf: (name: string) => Value | undefined,
  ) {
    for (const [n, c] of Object.entries(cfg.children)) {
      if (!c) continue;
      const call = cfg.modules[n];
      const parent: Scope = { m: this };
      this.children.set(n, new ModInst(eng, c, `${prefix}module.${n}.`, (v) => {
        const a = call.attrs.find((x) => x.name === v);
        return a ? eng.eval(a.expr, { ...parent, at: { file: call.file, line: a.line, ctx: `in module "${n}"` } }) : undefined;
      }));
    }
  }

  getVar(name: string): Value {
    if (this.varCache.has(name)) return this.varCache.get(name)!;
    const decl = this.cfg.variables[name];
    let v = this.argOf(name);
    if (v === undefined) v = decl?.def ? this.eng.eval(decl.def, { m: this }) : null;
    if (decl?.type === "number" && typeof v === "string" && v.trim() !== "" && !isNaN(Number(v))) v = Number(v);
    if (decl?.type === "bool" && (v === "true" || v === "false")) v = v === "true";
    this.varCache.set(name, v);
    return v;
  }

  getLocal(name: string): Value {
    if (this.localCache.has(name)) return this.localCache.get(name)!;
    const l = this.cfg.locals[name];
    this.localCache.set(name, UNK);
    const v = l ? this.eng.eval(l.expr, { m: this, at: { file: l.file, line: l.line, ctx: "in locals" } }) : UNK;
    this.localCache.set(name, v);
    return v;
  }

  output(name: string): Value | undefined {
    const o = this.cfg.outputs[name];
    return o ? this.eng.eval(o.expr, { m: this, at: { file: o.file, line: o.line, ctx: `in output "${name}"` } }) : undefined;
  }

  baseAddr(r: ResCfg) {
    return `${this.prefix}${r.mode === "data" ? "data." : ""}${r.type}.${r.name}`;
  }

  /** Instance keys: null = single instance, [] = none. */
  keys(r: ResCfg): (number | string)[] | null {
    if (this.keysCache.has(r)) return this.keysCache.get(r)!;
    let keys: (number | string)[] | null = null;
    const at = (a: Attr) => ({ file: r.body.file, line: a.line, ctx: `in ${blockHeader(r.body)}` });
    if (r.count) {
      const v = this.eng.eval(r.count.expr, { m: this, at: at(r.count) });
      if (v instanceof Unknown)
        throw new EvalError({ ...at(r.count), summary: "Invalid count argument", detail: 'The "count" value depends on resource attributes that cannot be determined until apply, so Terraform cannot predict how many instances will be created. To work around this, use the -target argument to first apply only the resources that the count depends on.' });
      const n = Number(v);
      if (!Number.isInteger(n) || n < 0) throw new EvalError({ ...at(r.count), summary: "Invalid count argument", detail: `The given "count" argument value is unsuitable: must be a whole number, got ${JSON.stringify(v)}.` });
      keys = Array.from({ length: n }, (_, i) => i);
    } else if (r.forEach) {
      const v = this.eng.eval(r.forEach.expr, { m: this, at: at(r.forEach) });
      if (v instanceof Unknown || hasUnknown(v))
        throw new EvalError({ ...at(r.forEach), summary: "Invalid for_each argument", detail: 'The "for_each" map includes keys derived from resource attributes that cannot be determined until apply, and so Terraform cannot determine the full set of keys that will identify the instances of this resource.' });
      if (isObj(v)) keys = Object.keys(v).sort();
      else if (Array.isArray(v)) keys = v.map(str).sort();
      else throw new EvalError({ ...at(r.forEach), summary: "Invalid for_each argument", detail: 'The given "for_each" argument value is unsuitable: the "for_each" argument must be a map, or set of strings.' });
    }
    this.keysCache.set(r, keys);
    return keys;
  }

  instances(r: ResCfg): Inst[] {
    const base = this.baseAddr(r);
    const keys = this.keys(r);
    if (keys === null) return [{ addr: base, cfg: r, m: this }];
    if (r.count) return keys.map((k) => ({ addr: `${base}[${k}]`, cfg: r, m: this, count: k as number }));
    const fe = this.eng.eval(r.forEach!.expr, { m: this });
    return keys.map((k) => ({ addr: `${base}[${JSON.stringify(k)}]`, cfg: r, m: this, each: { key: String(k), value: isObj(fe) ? fe[k] : k } }));
  }

  resourceValue(type: string, name: string, mode: "managed" | "data"): EV {
    const r = this.cfg.resources.find((x) => x.mode === mode && x.type === type && x.name === name);
    if (!r) return UNK;
    const insts = this.instances(r);
    if (r.count) return insts.map((i) => this.eng.resolve(i));
    if (r.forEach) return Object.fromEntries(insts.map((i) => [i.each!.key, this.eng.resolve(i)]));
    return this.eng.resolve(insts[0]);
  }

  allInstances(): Inst[] {
    const out: Inst[] = [];
    for (const r of this.cfg.resources) if (r.mode === "managed") out.push(...this.instances(r));
    for (const c of this.children.values()) out.push(...c.allInstances());
    return out;
  }
}

export type Change = {
  addr: string;
  type: string;
  action: "create" | "update" | "replace" | "delete" | "noop";
  before: Attrs | null;
  after: Attrs | null;
  forces: string[];
  movedFrom?: string;
  importId?: string;
  reason?: "not-in-config" | "requested" | "tainted" | "deleted-remote";
};

export type RunOpts = { destroy?: boolean; refreshOnly?: boolean; refresh?: boolean; vars: Record<string, Value>; targets: string[]; replace: string[] };

export type RunResult = {
  ok: boolean;
  diags: Diag[];
  refreshLines: string[];
  applyLines: string[];
  changes: Change[];
  drift: Change[];
  moves: { from: string; to: string }[];
  outputs: Record<string, { value: Value; sensitive: boolean }>;
  prevOutputs: Record<string, { value: Value; sensitive: boolean }>;
  state: TfState;
  counts: { add: number; change: number; destroy: number; imported: number };
};

const matchesAddr = (addr: string, target: string) =>
  addr === target || addr.startsWith(target + ".") || addr.startsWith(target + "[");

export class Engine {
  state: TfState;
  root!: ModInst;
  resolved = new Map<string, Attrs>();
  resolving = new Set<string>();
  changes = new Map<string, Change>();
  applyLines: string[] = [];
  imported = new Map<string, string>();
  movedFrom = new Map<string, string>();
  cloud: Cloud;

  constructor(
    public sh: Shell,
    public cfg: ModCfg,
    public mode: "plan" | "apply" | "console",
    public ws: string,
    prior: TfState,
    public rootVars: Record<string, Value>,
    public replaceAddrs: string[] = [],
  ) {
    this.state = { ...prior, resources: clone(prior.resources as unknown as Value) as unknown as TfState["resources"] };
    this.cloud = tfExt(sh).cloud;
    this.root = new ModInst(this, cfg, "", (n) => rootVars[n]);
  }

  get region() {
    return this.cfg.region;
  }

  eval(e: Expr, s: Scope): Value {
    const v = this.ev(e, s);
    return this.materialize(v);
  }

  private materialize(v: EV): Value {
    if (v instanceof LazyObj) return UNK;
    return v;
  }

  private fail(s: Scope, summary: string, detail: string): never {
    throw new EvalError({ summary, detail, file: s.at?.file, line: s.at?.line, ctx: s.at?.ctx });
  }

  private getAttr(v: EV, k: string, s: Scope): EV {
    if (v instanceof Unknown) return UNK;
    if (v instanceof LazyObj) {
      const r = v.get(k);
      return r === undefined ? UNK : r;
    }
    if (isObj(v)) return k in v ? v[k] : null;
    if (Array.isArray(v)) this.fail(s, "Unsupported attribute", `Can't access attributes on a list of objects. Did you mean to access attribute "${k}" for a specific element of the list, or across all elements of the list?`);
    return UNK;
  }

  private ev(e: Expr, s: Scope): EV {
    switch (e.t) {
      case "lit":
        return e.v;
      case "tpl": {
        if (e.parts.length === 1 && typeof e.parts[0] !== "string") return this.ev(e.parts[0], s);
        let out = "";
        for (const p of e.parts) {
          if (typeof p === "string") out += p;
          else {
            const v = this.materialize(this.ev(p, s));
            if (hasUnknown(v)) return UNK;
            out += str(v);
          }
        }
        return out;
      }
      case "list":
        return e.items.map((i) => this.materialize(this.ev(i, s)));
      case "obj": {
        const o: Obj = {};
        for (const it of e.items) {
          const k = it.k.t === "var" ? it.k.name : this.materialize(this.ev(it.k, s));
          o[str(k)] = this.materialize(this.ev(it.v, s));
        }
        return o;
      }
      case "var":
        return this.root_(e.name, s);
      case "get":
        return this.getAttr(this.ev(e.o, s), e.name, s);
      case "idx": {
        const o = this.ev(e.o, s);
        const k = this.materialize(this.ev(e.i, s));
        if (o instanceof Unknown || k instanceof Unknown) return UNK;
        if (o instanceof LazyObj) return o.get(str(k)) ?? UNK;
        if (Array.isArray(o)) {
          if (typeof k !== "number" || k >= o.length)
            this.fail(s, "Invalid index", `The given key does not identify an element in this collection value${typeof k === "number" ? `: the collection has ${o.length} elements.` : "."}`);
          return o[k];
        }
        if (isObj(o)) {
          if (!(str(k) in o)) this.fail(s, "Invalid index", `The given key does not identify an element in this collection value.`);
          return o[str(k)];
        }
        return UNK;
      }
      case "splat": {
        const o = this.materialize(this.ev(e.o, s));
        if (o instanceof Unknown) return UNK;
        const list = Array.isArray(o) ? o : o === null ? [] : [o];
        return list.map((it) => this.materialize(this.ev(e.each, { ...s, locals: { ...s.locals, [SPLAT_IT]: it } })));
      }
      case "call": {
        let args = e.args.map((a) => this.materialize(this.ev(a, s)));
        if (e.expand && Array.isArray(args[args.length - 1])) args = [...args.slice(0, -1), ...(args[args.length - 1] as Value[])];
        if (e.name !== "length" && e.name !== "try" && e.name !== "coalesce" && args.some(hasUnknown)) return UNK;
        if (e.name === "length" && args[0] instanceof Unknown) return UNK;
        const f = FUNCS[e.name];
        if (!f) this.fail(s, "Call to unknown function", `There is no function named "${e.name}".`);
        return f(args, this.sh, s.m.cfg.dir);
      }
      case "un": {
        const a = this.materialize(this.ev(e.a, s));
        if (a instanceof Unknown) return UNK;
        return e.op === "!" ? !a : -Number(a);
      }
      case "bin": {
        const a = this.materialize(this.ev(e.a, s));
        const b = this.materialize(this.ev(e.b, s));
        if (a instanceof Unknown || b instanceof Unknown) return UNK;
        switch (e.op) {
          case "==": return valEq(a, b);
          case "!=": return !valEq(a, b);
          case "&&": return !!a && !!b;
          case "||": return !!a || !!b;
          case "<": return Number(a) < Number(b);
          case ">": return Number(a) > Number(b);
          case "<=": return Number(a) <= Number(b);
          case ">=": return Number(a) >= Number(b);
          case "+": return Number(a) + Number(b);
          case "-": return Number(a) - Number(b);
          case "*": return Number(a) * Number(b);
          case "/": return Number(a) / Number(b);
          case "%": return Number(a) % Number(b);
        }
        return UNK;
      }
      case "cond": {
        const c = this.materialize(this.ev(e.c, s));
        if (c instanceof Unknown) return UNK;
        return this.ev(c ? e.a : e.b, s);
      }
      case "for": {
        const coll = this.materialize(this.ev(e.coll, s));
        if (coll instanceof Unknown) return UNK;
        const entries: [Value, Value][] = Array.isArray(coll) ? coll.map((v, i) => [i, v]) : isObj(coll) ? Object.entries(coll) : [];
        const outList: Value[] = [];
        const outObj: Obj = {};
        for (const [k, v] of entries) {
          const locals = { ...s.locals, [e.v]: v, ...(e.k ? { [e.k]: k } : {}) };
          const sc = { ...s, locals };
          if (e.cond && !this.materialize(this.ev(e.cond, sc))) continue;
          const val = this.materialize(this.ev(e.val, sc));
          if (e.obj) outObj[str(this.materialize(this.ev(e.key!, sc)))] = val;
          else outList.push(val);
        }
        return e.obj ? outObj : outList;
      }
    }
  }

  private root_(name: string, s: Scope): EV {
    if (s.locals && name in s.locals) return s.locals[name];
    const m = s.m;
    switch (name) {
      case "var":
        return new LazyObj((k) => m.getVar(k));
      case "local":
        return new LazyObj((k) => m.getLocal(k));
      case "module":
        return new LazyObj((k) => {
          const c = m.children.get(k);
          if (!c) return m.cfg.modules[k] ? UNK : undefined;
          return new LazyObj((o) => c.output(o)) as unknown as Value;
        });
      case "data":
        return new LazyObj((t) => new LazyObj((n) => m.resourceValue(t, n, "data") as Value) as unknown as Value);
      case "count":
        return { index: s.count ?? 0 };
      case "each":
        return s.each ? { key: s.each.key, value: s.each.value } : UNK;
      case "terraform":
        return { workspace: this.ws };
      case "path":
        return { module: m.cfg.dir === this.cfg.dir ? "." : m.cfg.dir.replace(this.cfg.dir + "/", ""), root: ".", cwd: this.cfg.dir };
      case "self":
        return UNK;
      default:
        if (m.cfg.resources.some((r) => r.type === name)) return new LazyObj((n) => m.resourceValue(name, n, "managed") as Value);
        return UNK;
    }
  }

  /** Evaluates a resource body (attributes + nested blocks) into an attribute map. */
  evalBody(b: Block, s: Scope): Attrs {
    const out: Attrs = {};
    for (const a of b.attrs) {
      if (META_ATTRS.has(a.name)) continue;
      const v = this.eval(a.expr, { ...s, at: { file: b.file, line: a.line, ctx: s.at?.ctx } });
      if (v !== null) out[a.name] = v;
    }
    for (const nb of b.blocks) {
      if (nb.type === "lifecycle" || nb.type === "dynamic" || nb.type === "timeouts") continue;
      const list = (out[nb.type] as Value[] | undefined) ?? [];
      list.push(this.evalBody(nb, s));
      out[nb.type] = list;
    }
    return out;
  }

  private cfgValues(inst: Inst): Attrs {
    return this.evalBody(inst.cfg.body, { m: inst.m, count: inst.count, each: inst.each, at: { file: inst.cfg.body.file, line: inst.cfg.body.line, ctx: `in ${blockHeader(inst.cfg.body)}` } });
  }

  /** Planned (plan mode) or final (apply mode) attributes of a resource instance. */
  resolve(inst: Inst): Attrs {
    const { addr, cfg } = inst;
    if (this.resolved.has(addr)) return this.resolved.get(addr)!;
    if (this.resolving.has(addr)) return {};
    this.resolving.add(addr);
    try {
      const out = cfg.mode === "data" ? this.resolveData(inst) : this.resolveManaged(inst);
      this.resolved.set(addr, out);
      return out;
    } finally {
      this.resolving.delete(addr);
    }
  }

  private resolveData(inst: Inst): Attrs {
    const v = dataSource(inst.cfg.type, this.cfgValues(inst), this.region, this.cloud);
    if (v instanceof Unknown) return { id: UNK };
    return v;
  }

  private resolveManaged(inst: Inst): Attrs {
    const { addr, cfg } = inst;
    const prior = this.state.resources[addr];
    if (this.mode === "console") return prior ? prior.attrs : {};
    const want = this.cfgValues(inst);
    const ck = computedKeys(cfg.type);
    let action: Change["action"];
    let forces: string[] = [];
    let reason: Change["reason"];
    if (!prior) action = "create";
    else {
      const changed = Object.keys(want).filter((k) => !valEq(want[k], prior.attrs[k]));
      const removed = Object.keys(prior.attrs).filter((k) => !(k in want) && !ck.includes(k) && prior.attrs[k] !== null && !(Array.isArray(prior.attrs[k]) && !(prior.attrs[k] as Value[]).length) && !(isObj(prior.attrs[k]) && !Object.keys(prior.attrs[k] as Obj).length));
      forces = changed.filter((k) => (FORCE_NEW[cfg.type] ?? []).includes(k));
      if (this.replaceAddrs.includes(addr)) reason = "requested";
      else if (prior.tainted) reason = "tainted";
      action = forces.length || reason ? "replace" : changed.length || removed.length ? "update" : "noop";
    }
    if (prior && action !== "noop" && action !== "update" && cfg.preventDestroy)
      throw new EvalError({
        summary: "Instance cannot be destroyed", file: cfg.body.file, line: cfg.body.line, ctx: `in ${blockHeader(cfg.body)}`,
        detail: `Resource ${addr} has lifecycle.prevent_destroy set, but the plan calls for this resource to be destroyed. To avoid this error and continue with the plan, either disable lifecycle.prevent_destroy or reduce the scope of the plan using the -target option.`,
      });
    let after: Attrs;
    if (action === "create" || action === "replace") after = { ...want, ...Object.fromEntries(ck.filter((k) => !(k in want)).map((k) => [k, UNK])) };
    else if (action === "update") {
      after = { ...Object.fromEntries(Object.entries(prior!.attrs).filter(([k]) => k in want || ck.includes(k))), ...want };
    } else after = prior!.attrs;
    const change: Change = { addr, type: cfg.type, action, before: prior ? prior.attrs : null, after, forces, reason, movedFrom: this.movedFrom.get(addr), importId: this.imported.get(addr) };
    this.changes.set(addr, change);
    if (this.mode !== "apply") return after;
    return this.execute(change, inst);
  }

  private execute(c: Change, inst: Inst): Attrs {
    const { addr, type } = c;
    const L = this.applyLines;
    const [took, still] = dur(type);
    const create = (): Attrs => {
      const want = this.cfgValues(inst);
      const final = { ...computedFor(type, want, this.region), ...want };
      if (type === "aws_s3_bucket" && !("tags" in final)) final.tags = {};
      L.push(`${addr}: Creating...`);
      if (still) L.push(`${addr}: Still creating... [${still} elapsed]`);
      L.push(`${addr}: Creation complete after ${took} [id=${final.id}]`);
      this.cloud.objects[cloudKey(type, String(final.id))] = clone(final);
      this.state.resources[addr] = { type, attrs: final };
      return final;
    };
    if (c.importId) {
      L.push(`${addr}: Importing... [id=${c.importId}]`);
      L.push(`${addr}: Import complete [id=${c.importId}]`);
    }
    switch (c.action) {
      case "create":
        return create();
      case "replace": {
        const id = String(c.before!.id);
        L.push(`${addr}: Destroying... [id=${id}]`);
        delete this.cloud.objects[cloudKey(type, id)];
        L.push(`${addr}: Destruction complete after 1s`);
        return create();
      }
      case "update": {
        const want = this.cfgValues(inst);
        const ck = computedKeys(type);
        const final = { ...Object.fromEntries(Object.entries(c.before!).filter(([k]) => k in want || ck.includes(k))), ...want };
        L.push(`${addr}: Modifying... [id=${final.id}]`);
        L.push(`${addr}: Modifications complete after ${type === "aws_instance" ? "32s" : "1s"} [id=${final.id}]`);
        this.cloud.objects[cloudKey(type, String(final.id))] = clone(final);
        this.state.resources[addr] = { type, attrs: final };
        return final;
      }
      default:
        return c.before ?? {};
    }
  }

  /** Applies moved blocks from every module to the working state. */
  applyMoves(diags: Diag[]): { from: string; to: string }[] {
    const moves: { from: string; to: string }[] = [];
    const walk = (m: ModInst) => {
      for (const mv of m.cfg.moved) {
        const from = m.prefix + mv.from;
        const to = m.prefix + mv.to;
        for (const addr of Object.keys(this.state.resources)) {
          if (!matchesAddr(addr, from)) continue;
          const dest = to + addr.slice(from.length);
          if (this.state.resources[dest]) {
            diags.push({ warning: true, summary: "Moved object still exists", detail: `This statement declares a move from ${addr}, but that resource instance is still declared in the configuration. Terraform will ignore this move.`, file: mv.file, line: mv.line, ctx: "in moved" });
            continue;
          }
          const fp = parseAddr(addr);
          const tp = parseAddr(dest);
          if (fp && tp && fp.type !== tp.type) {
            diags.push({ summary: "Resource type mismatch", detail: `This statement declares a move from ${addr} to ${dest}, which is a resource of a different type.`, file: mv.file, line: mv.line, ctx: "in moved" });
            continue;
          }
          this.state.resources[dest] = this.state.resources[addr];
          delete this.state.resources[addr];
          this.movedFrom.set(dest, addr);
          moves.push({ from: addr, to: dest });
        }
      }
      for (const c of m.children.values()) walk(c);
    };
    walk(this.root);
    return moves;
  }

  /** Reads every object from the fake cloud. Returns drift changes. */
  refresh(lines: string[]): Change[] {
    const drift: Change[] = [];
    for (const addr of Object.keys(this.state.resources).sort()) {
      const r = this.state.resources[addr];
      const id = String(r.attrs.id ?? "");
      lines.push(`${addr}: Refreshing state... [id=${id}]`);
      const remote = this.cloud.objects[cloudKey(r.type, id)];
      if (!remote) {
        drift.push({ addr, type: r.type, action: "delete", before: r.attrs, after: null, forces: [], reason: "deleted-remote" });
        delete this.state.resources[addr];
      } else if (!valEq(remote, r.attrs)) {
        drift.push({ addr, type: r.type, action: "update", before: r.attrs, after: clone(remote), forces: [] });
        r.attrs = clone(remote);
      }
    }
    return drift;
  }

  /** Processes import blocks of the root module. */
  applyImports(lines: string[], insts: Map<string, Inst>) {
    for (const im of this.cfg.imports) {
      if (this.state.resources[im.to]) continue;
      const idv = this.eval(im.id, { m: this.root, at: { file: im.file, line: im.line, ctx: "in import" } });
      const id = str(idv);
      const inst = insts.get(im.to);
      if (!inst)
        throw new EvalError({ summary: "Configuration for import target does not exist", detail: `The configuration for the given import target ${im.to} does not exist. All target instances must have an associated configuration to be imported.`, file: im.file, line: im.line, ctx: "in import" });
      const remote = this.cloud.objects[cloudKey(inst.cfg.type, id)];
      if (!remote)
        throw new EvalError({ summary: "Cannot import non-existent remote object", detail: `While attempting to import an existing object to "${im.to}", the provider detected that no object exists with the given id. Only pre-existing objects can be imported; check that the id is correct and that it is associated with the provider's configured region or endpoint, or use "terraform apply" to create a new remote object for this resource.`, file: im.file, line: im.line, ctx: "in import" });
      lines.push(`${im.to}: Preparing import... [id=${id}]`);
      lines.push(`${im.to}: Refreshing state... [id=${id}]`);
      this.state.resources[im.to] = { type: inst.cfg.type, attrs: clone(remote) };
      this.imported.set(im.to, id);
    }
  }

  outputs(): Record<string, { value: Value; sensitive: boolean }> {
    const out: Record<string, { value: Value; sensitive: boolean }> = {};
    for (const [n, o] of Object.entries(this.cfg.outputs)) out[n] = { value: this.root.output(n) ?? null, sensitive: o.sensitive };
    return out;
  }
}

/** Runs a plan or an apply. The state passed in is not mutated; the result has the new state. */
export const runEngine = (sh: Shell, cfg: ModCfg, ws: string, prior: TfState, mode: "plan" | "apply", opts: RunOpts): RunResult => {
  const eng = new Engine(sh, cfg, mode, ws, prior, opts.vars, opts.replace);
  const diags: Diag[] = [];
  const refreshLines: string[] = [];
  const res: RunResult = {
    ok: false, diags, refreshLines, applyLines: eng.applyLines, changes: [], drift: [], moves: [], outputs: {}, prevOutputs: prior.outputs, state: eng.state,
    counts: { add: 0, change: 0, destroy: 0, imported: 0 },
  };
  try {
    res.moves = opts.destroy || opts.refreshOnly ? [] : eng.applyMoves(diags);
    if (diags.some((d) => !d.warning)) return res;
    if (opts.refresh !== false) res.drift = eng.refresh(refreshLines);
    if (opts.refreshOnly) {
      res.outputs = mode === "apply" ? eng.outputs() : prior.outputs;
      res.ok = true;
      return res;
    }
    if (opts.destroy) {
      const addrs = Object.keys(eng.state.resources).filter((a) => !opts.targets.length || opts.targets.some((t) => matchesAddr(a, t))).sort();
      for (const addr of addrs) {
        const r = eng.state.resources[addr];
        res.changes.push({ addr, type: r.type, action: "delete", before: r.attrs, after: null, forces: [] });
      }
    } else {
      const insts = new Map(eng.root.allInstances().map((i) => [i.addr, i]));
      eng.applyImports(refreshLines, insts);
      for (const inst of insts.values()) if (!opts.targets.length || opts.targets.some((t) => matchesAddr(inst.addr, t))) eng.resolve(inst);
      res.changes = [...eng.changes.values()];
      for (const addr of Object.keys(eng.state.resources))
        if (!insts.has(addr) && (!opts.targets.length || opts.targets.some((t) => matchesAddr(addr, t))))
          res.changes.push({ addr, type: eng.state.resources[addr].type, action: "delete", before: eng.state.resources[addr].attrs, after: null, forces: [], reason: "not-in-config", movedFrom: eng.movedFrom.get(addr) });
      res.outputs = eng.outputs();
    }
    res.changes.sort((a, b) => (a.addr < b.addr ? -1 : 1));
    if (mode === "apply") {
      for (const c of [...res.changes].reverse().filter((c) => c.action === "delete")) {
        const id = String(c.before!.id);
        eng.applyLines.push(`${c.addr}: Destroying... [id=${id}]`);
        eng.applyLines.push(`${c.addr}: Destruction complete after ${c.type === "aws_eks_cluster" ? "3m12s" : "1s"}`);
        delete eng.cloud.objects[cloudKey(c.type, id)];
        delete eng.state.resources[c.addr];
      }
      if (opts.destroy) res.outputs = {};
    }
    for (const c of res.changes) {
      if (c.action === "create") res.counts.add++;
      if (c.action === "update") res.counts.change++;
      if (c.action === "delete") res.counts.destroy++;
      if (c.action === "replace") {
        res.counts.add++;
        res.counts.destroy++;
      }
      if (c.importId) res.counts.imported++;
    }
    res.ok = true;
  } catch (e) {
    if (e instanceof EvalError || e instanceof HclError) diags.push(e.diag);
    else throw e;
  }
  return res;
};

/** Root variable values from defaults, TF_VAR_*, terraform.tfvars, *.auto.tfvars and CLI args. */
export const collectVars = (
  sh: Shell,
  dir: string,
  cfg: ModCfg,
  cli: { kind: "var" | "file"; value: string }[],
  env: Record<string, string>,
  diags: Diag[],
): Record<string, Value> => {
  const vars: Record<string, Value> = {};
  const parseFile = (path: string, shown: string) => {
    const src = sh.readFile(path);
    if (src === undefined) {
      diags.push({ summary: "Failed to read variables file", detail: `Given variables file ${shown} does not exist.` });
      return;
    }
    try {
      const body = parseHcl(src, shown);
      for (const a of body.attrs) {
        const v = litValue(a.expr);
        if (v === undefined) diags.push({ summary: "Variables not allowed", detail: "Variables may not be used here.", file: shown, line: a.line });
        else if (!cfg.variables[a.name])
          diags.push({ warning: true, summary: "Value for undeclared variable", detail: `The root module does not declare a variable named "${a.name}" but a value was found in file "${shown}". If you meant to use this value, add a "variable" block to the configuration.` });
        else vars[a.name] = v;
      }
    } catch (e) {
      if (e instanceof HclError) diags.push(e.diag);
      else throw e;
    }
  };
  for (const [k, v] of Object.entries(env)) if (k.startsWith("TF_VAR_") && cfg.variables[k.slice(7)]) vars[k.slice(7)] = v;
  if (sh.readFile(`${dir}/terraform.tfvars`) !== undefined) parseFile(`${dir}/terraform.tfvars`, "terraform.tfvars");
  for (const n of sh.listDir(dir).filter((n) => n.endsWith(".auto.tfvars")).sort()) parseFile(`${dir}/${n}`, n);
  for (const c of cli) {
    if (c.kind === "file") parseFile(sh.resolve(c.value), c.value);
    else {
      const eq = c.value.indexOf("=");
      if (eq < 1) {
        diags.push({ summary: "Invalid -var option", detail: `The given -var option ${JSON.stringify(c.value)} is not correctly specified. It must be a variable name and value separated an equals sign, like -var="key=value".` });
        continue;
      }
      const name = c.value.slice(0, eq);
      const raw = c.value.slice(eq + 1);
      if (!cfg.variables[name]) {
        diags.push({ summary: "Value for undeclared variable", detail: `A variable named "${name}" was assigned on the command line, but the root module does not declare a variable of that name. To use this value, add a "variable" block to the configuration.` });
        continue;
      }
      let v: Value = raw;
      if (/^[[{]/.test(raw.trim()))
        try {
          const lv = litValue(parseHclExprSafe(raw));
          if (lv !== undefined) v = lv;
        } catch {
          /* keep string */
        }
      vars[name] = v;
    }
  }
  for (const v of Object.values(cfg.variables))
    if (!(v.name in vars) && !v.def)
      diags.push({
        summary: "No value for required variable", file: v.file, line: v.line,
        detail: `The root module input variable "${v.name}" is not set, and has no default value. Use a -var or -var-file command line argument to provide a value for this variable.`,
      });
  return vars;
};

const parseHclExprSafe = (s: string): Expr => {
  const body = parseHcl(`x = ${s}\n`, "<value>");
  return body.attrs[0].expr;
};

/** Evaluates a backend block (literals only). */
export const backendFromBlock = (b: BackendBlock | undefined, diags: Diag[]): Backend => {
  if (!b) return LOCAL;
  const block: Record<string, Value> = {};
  for (const a of b.attrs) {
    const v = litValue(a.expr);
    if (v === undefined) diags.push({ summary: "Variables not allowed", detail: "Variables may not be used here.", file: b.file, line: a.line, ctx: "in terraform" });
    else block[a.name] = v;
  }
  return { type: b.type, config: { ...block }, block };
};

export const sameBackend = (a: Backend, b: Backend) => a.type === b.type && valEq(a.block as Value, b.block as Value);
