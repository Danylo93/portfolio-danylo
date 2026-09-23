// Argo CD CLI (GitOps). Applications read manifests from the simulated GitHub repo (tools/git.ts) at the pushed
// revision and apply them to the Kubernetes model. Automated sync reacts to pushes; self-heal reverts drift before
// the next kubectl/argocd command (like the application controller would a few seconds later).
import YAML from "yaml";
import "../k8s/kubectl";
import { findDeployment, findObj, findService, nsExists } from "../k8s/cluster";
import { applyManifest, deleteAny } from "../k8s/manifest";
import { getTool, registerTool } from "../registry";
import type { Shell } from "../shell";
import type { ToolResult } from "../types";
import { table } from "../util";
import { lineDiff, pushHooks, serverOf, serverRev, short } from "./git";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
type HistoryEntry = { id: number; revision: string; deployedAt: number; docs: Json[] };
export type ArgoApp = {
  name: string;
  project: string;
  repo: string;
  path: string;
  target: string;
  destServer: string;
  destNs: string;
  automated: boolean;
  prune: boolean;
  selfHeal: boolean;
  createNs: boolean;
  history: HistoryEntry[];
  syncedRev?: string;
  managed: string[];
  messages: Record<string, string>;
  operation?: { kind: "Sync" | "Rollback"; phase: "Succeeded" | "Failed"; message: string; rev: string; at: number; by: string };
  healCount: number;
  createdAt: number;
};
type ArgoState = { loggedIn: boolean; server: string; apps: Record<string, ArgoApp> };

export const IN_CLUSTER = "https://kubernetes.default.svc";
export const argoState = (sh: Shell) => sh.ext<ArgoState>("argocd", () => ({ loggedIn: false, server: "", apps: {} }));
export const argoApp = (sh: Shell, name: string) => argoState(sh).apps[name];

const FATA = (msg: string): ToolResult => ({ output: `FATA[0000] ${msg}`, ok: false });
const iso = (t: number) => new Date(t).toISOString().replace(/\.\d+Z$/, "+00:00");

// ---------- desired state (git) ----------
type Desired = { sha: string; docs: Json[]; error?: undefined } | { error: string; sha?: string; docs?: undefined };

export const desiredOf = (sh: Shell, app: Pick<ArgoApp, "repo" | "path" | "target">): Desired => {
  const server = serverOf(sh, app.repo);
  if (!server) return { error: "repository not accessible: repository not found" };
  const rev = serverRev(sh, server, app.target);
  if (!rev) return { error: `unable to resolve '${app.target}' to a commit SHA` };
  const dir = app.path.replace(/^\.\//, "").replace(/\/$/, "");
  const files = Object.keys(rev.tree)
    .filter((p) => (dir === "." || dir === "" ? !p.includes("/") : p.startsWith(dir + "/") && !p.slice(dir.length + 1).includes("/")) && /\.ya?ml$/.test(p))
    .sort();
  if (!files.length) return { sha: rev.sha, error: `Manifest generation error (cached): ${dir}: app path does not exist` };
  const docs: Json[] = [];
  for (const f of files) {
    for (const d of YAML.parseAllDocuments(rev.tree[f])) {
      if (d.errors.length) return { sha: rev.sha, error: `Manifest generation error: failed to unmarshal ${f}: ${d.errors[0].message.split("\n")[0]}` };
      const js = d.toJS();
      if (js && typeof js === "object" && js.kind) docs.push(js);
    }
  }
  return { sha: rev.sha, docs };
};

const nsOf = (app: ArgoApp, doc: Json) => doc.metadata?.namespace ?? app.destNs;
const keyOf = (app: ArgoApp, doc: Json) => `${doc.kind}/${nsOf(app, doc)}/${doc.metadata?.name}`;
const group = (kind: string) => (["Deployment", "StatefulSet", "DaemonSet", "ReplicaSet"].includes(kind) ? "apps" : kind === "Ingress" || kind === "NetworkPolicy" ? "networking.k8s.io" : "");

// ---------- comparison ----------
const normDeploy = (replicas: number, containers: { name: string; image: string }[]) => ({
  spec: { replicas, template: { spec: { containers: containers.map((c) => ({ name: c.name, image: c.image })) } } },
});

/** Live vs desired (normalized to the fields this lab cares about). null live = missing. */
const compareDoc = (sh: Shell, app: ArgoApp, doc: Json): { live: Json | null; want: Json; health: string } => {
  const name = doc.metadata?.name;
  const ns = nsOf(app, doc);
  if (doc.kind === "Deployment") {
    const want = normDeploy(doc.spec?.replicas ?? 1, doc.spec?.template?.spec?.containers ?? []);
    const d = findDeployment(sh, name, ns);
    if (!d) return { live: null, want, health: "Missing" };
    const pods = sh.state.pods.filter((p) => p.ownerKind === "Deployment" && p.owner === d.name && p.namespace === ns);
    const ready = sh.deploymentReady(d.name, ns);
    const degraded = pods.some((p) => /BackOff|ErrImage|Error|InvalidImageName/.test(sh.podStatus(p)));
    return { live: normDeploy(d.replicas, d.template.spec.containers), want, health: ready ? "Healthy" : degraded ? "Degraded" : "Progressing" };
  }
  if (doc.kind === "Service") {
    const p = doc.spec?.ports?.[0] ?? {};
    const want = { spec: { type: doc.spec?.type ?? "ClusterIP", port: Number(p.port), targetPort: Number(p.targetPort ?? p.port), selector: doc.spec?.selector ?? {} } };
    const s = findService(sh, name, ns);
    if (!s) return { live: null, want, health: "Missing" };
    return { live: { spec: { type: s.type, port: s.port, targetPort: s.targetPort, selector: s.selector } }, want, health: "Healthy" };
  }
  if (doc.kind === "Namespace") return { live: nsExists(sh, name) ? {} : null, want: {}, health: nsExists(sh, name) ? "Healthy" : "Missing" };
  const o = findObj(sh, doc.kind, name, ns);
  const want = { data: doc.data ?? doc.spec ?? {} };
  if (!o) return { live: null, want, health: "Missing" };
  return { live: { data: o.manifest.data ?? o.manifest.spec ?? {} }, want, health: "" };
};

type Row = { key: string; kind: string; ns: string; name: string; sync: "Synced" | "OutOfSync"; health: string; live: Json | null; want: Json | null; prune?: boolean };

const liveExists = (sh: Shell, key: string) => {
  const [kind, ns, name] = key.split("/");
  if (kind === "Deployment") return !!findDeployment(sh, name, ns);
  if (kind === "Service") return !!findService(sh, name, ns);
  if (kind === "Namespace") return nsExists(sh, name);
  return !!findObj(sh, kind, name, ns);
};

export const appStatus = (sh: Shell, app: ArgoApp) => {
  const d = desiredOf(sh, app);
  if (d.error !== undefined) return { error: d.error, sha: d.sha, sync: "Unknown", health: "Missing", rows: [] as Row[] };
  const rows: Row[] = d.docs.map((doc) => {
    const c = compareDoc(sh, app, doc);
    const inSync = c.live !== null && JSON.stringify(c.live) === JSON.stringify(c.want);
    return { key: keyOf(app, doc), kind: doc.kind, ns: nsOf(app, doc), name: doc.metadata?.name, sync: inSync ? "Synced" : "OutOfSync", health: c.health, live: c.live, want: c.want };
  });
  const wanted = new Set(rows.map((r) => r.key));
  for (const k of app.managed)
    if (!wanted.has(k) && liveExists(sh, k)) {
      const [kind, ns, name] = k.split("/");
      rows.push({ key: k, kind, ns, name, sync: "OutOfSync", health: "Healthy", live: {}, want: null, prune: true });
    }
  const sync = rows.every((r) => r.sync === "Synced") ? "Synced" : "OutOfSync";
  const hs = rows.map((r) => r.health).filter(Boolean);
  const health = hs.includes("Degraded") ? "Degraded" : hs.includes("Missing") ? "Missing" : hs.includes("Progressing") ? "Progressing" : "Healthy";
  return { error: undefined, sha: d.sha, sync, health, rows, docs: d.docs };
};

// ---------- sync ----------
export const syncApp = (sh: Shell, app: ArgoApp, opts: { by: string; prune?: boolean; docs?: Json[]; rev?: string; kind?: "Sync" | "Rollback" }) => {
  let docs = opts.docs;
  let rev = opts.rev;
  if (!docs) {
    const d = desiredOf(sh, app);
    if (d.error !== undefined) return { ok: false, message: d.error };
    docs = d.docs;
    rev = d.sha;
  }
  const errors: string[] = [];
  if (!nsExists(sh, app.destNs)) {
    if (app.createNs) applyManifest(sh, { apiVersion: "v1", kind: "Namespace", metadata: { name: app.destNs } }, "apply");
  }
  const keys: string[] = [];
  for (const doc of docs) {
    const k = keyOf(app, doc);
    keys.push(k);
    const msg = applyManifest(sh, structuredClone(doc), "apply", app.destNs);
    app.messages[k] = msg;
    if (/^(error|Error|The )/.test(msg)) errors.push(msg);
  }
  const pruneNow = opts.prune ?? app.prune;
  for (const k of app.managed)
    if (!keys.includes(k)) {
      const [kind, ns, name] = k.split("/");
      if (pruneNow && deleteAny(sh, kind, name, ns)) app.messages[k] = "pruned";
    }
  app.managed = [...new Set([...keys, ...(pruneNow ? [] : app.managed.filter((k) => liveExists(sh, k)))])];
  const now = Date.now();
  const phase = errors.length ? "Failed" : "Succeeded";
  app.operation = { kind: opts.kind ?? "Sync", phase, message: errors.length ? `one or more objects failed to apply, reason: ${errors[0]}` : "successfully synced (all tasks run)", rev: rev ?? "", at: now, by: opts.by };
  if (!errors.length) {
    app.history.push({ id: app.history.length, revision: rev ?? "", deployedAt: now, docs: structuredClone(docs) });
    if (opts.kind !== "Rollback") app.syncedRev = rev;
  }
  return { ok: !errors.length, message: app.operation.message };
};

/** The application controller loop: automated sync on new revisions, self-heal on drift. */
export const reconcileApps = (sh: Shell) => {
  const st = argoState(sh);
  for (const app of Object.values(st.apps)) {
    if (!app.automated) continue;
    const s = appStatus(sh, app);
    if (s.error !== undefined || s.sync !== "OutOfSync") continue;
    if (s.sha !== app.syncedRev) syncApp(sh, app, { by: "automated sync policy" });
    else if (app.selfHeal) {
      syncApp(sh, app, { by: "automated sync policy (self-heal)" });
      app.healCount++;
    }
  }
};

pushHooks.push((sh) => reconcileApps(sh));

// Self-heal reacts to drift made with kubectl: reconcile before every kubectl command.
const kubectl = getTool("kubectl") as (ReturnType<typeof getTool> & { __argocd?: boolean }) | undefined;
if (kubectl && !kubectl.__argocd) {
  const orig = kubectl.run;
  kubectl.run = (ctx) => {
    if (Object.keys(argoState(ctx.sh).apps).length) reconcileApps(ctx.sh);
    return orig(ctx);
  };
  kubectl.__argocd = true;
}

// ---------- output ----------
const policyText = (app: ArgoApp) => (app.automated ? `Automated${app.prune || app.selfHeal ? ` (${[app.prune && "Prune", app.selfHeal && "Self Heal"].filter(Boolean).join(", ")})` : ""}` : "Manual");

const resourceTable = (app: ArgoApp, rows: Row[]) =>
  table([
    ["GROUP", "KIND", "NAMESPACE", "NAME", "STATUS", "HEALTH", "HOOK", "MESSAGE"],
    ...rows.map((r) => [group(r.kind), r.kind, r.ns, r.name, r.sync, r.health, "", r.prune ? "ignored (requires pruning)" : app.messages[r.key] ?? ""]),
  ]);

const header = (sh: Shell, app: ArgoApp) => {
  const s = appStatus(sh, app);
  const out = [
    `Name:               argocd/${app.name}`,
    `Project:            ${app.project}`,
    `Server:             ${app.destServer}`,
    `Namespace:          ${app.destNs}`,
    `URL:                https://${argoState(sh).server || "argocd.lab.local"}/applications/${app.name}`,
    "Source:",
    `- Repo:             ${app.repo}`,
    `  Target:           ${app.target}`,
    `  Path:             ${app.path}`,
    "SyncWindow:         Sync Allowed",
    `Sync Policy:        ${policyText(app)}`,
    `Sync Status:        ${s.sync === "Synced" ? "Synced to" : s.sync === "OutOfSync" ? "OutOfSync from" : "Unknown"} ${app.target}${s.sha ? ` (${short(s.sha)})` : ""}`,
    `Health Status:      ${s.health}`,
  ];
  if (s.error !== undefined) out.push("", "CONDITION        MESSAGE", `ComparisonError  ${s.error}`);
  return { text: out.join("\n"), s };
};

const operationText = (app: ArgoApp) => {
  const op = app.operation;
  if (!op) return "";
  return [
    "",
    `Operation:          ${op.kind}`,
    `Sync Revision:      ${op.rev}`,
    `Phase:              ${op.phase}`,
    `Start:              ${iso(op.at)}`,
    `Finished:           ${iso(op.at + 1000)}`,
    "Duration:           1s",
    `Message:            ${op.message}`,
    `Initiated by:       ${op.by}`,
  ].join("\n");
};

const yamlLines = (o: Json) => (o ? YAML.stringify(o).trimEnd().split("\n") : []);

const diffText = (rows: Row[]) => {
  const out: string[] = [];
  for (const r of rows) {
    if (r.sync === "Synced") continue;
    out.push(`===== ${group(r.kind) ? group(r.kind) + "/" : "/"}${r.kind} ${r.ns}/${r.name} ======`);
    const ops = lineDiff(yamlLines(r.live), yamlLines(r.want));
    let a = 0;
    let b = 0;
    for (let i = 0; i < ops.length; ) {
      if (ops[i][0] === " ") {
        a++;
        b++;
        i++;
        continue;
      }
      const dels: string[] = [];
      const adds: string[] = [];
      const a0 = a + 1;
      const b0 = b + 1;
      while (i < ops.length && ops[i][0] !== " ") {
        if (ops[i][0] === "-") {
          dels.push(ops[i][1]);
          a++;
        } else {
          adds.push(ops[i][1]);
          b++;
        }
        i++;
      }
      const rng = (s: number, n: number) => (n > 1 ? `${s},${s + n - 1}` : `${n ? s : s - 1}`);
      out.push(`${rng(a0, dels.length)}${dels.length && adds.length ? "c" : dels.length ? "d" : "a"}${rng(b0, adds.length)}`);
      out.push(...dels.map((l) => `< ${l}`), ...(dels.length && adds.length ? ["---"] : []), ...adds.map((l) => `> ${l}`));
    }
  }
  return out.join("\n");
};

// ---------- commands ----------
const appCreate = (sh: Shell, name: string | undefined, flags: Record<string, string | true>): ToolResult => {
  if (!name) return FATA("accepts 1 argument: the application name");
  const str = (k: string) => (typeof flags[k] === "string" ? (flags[k] as string) : undefined);
  const repo = str("repo");
  const path = str("path");
  if (!repo) return FATA("Must specify --repo");
  if (!path) return FATA(`rpc error: code = InvalidArgument desc = application spec for ${name} is invalid: InvalidSpecError: spec.source.path is required`);
  const destServer = str("dest-server") ?? (str("dest-name") === "in-cluster" ? IN_CLUSTER : undefined);
  const destNs = str("dest-namespace");
  if (!destServer) return FATA(`rpc error: code = InvalidArgument desc = application destination spec for ${name} is invalid: server or name is required`);
  if (destServer.replace(/\/$/, "") !== IN_CLUSTER)
    return FATA(`rpc error: code = InvalidArgument desc = application destination spec for ${name} is invalid: unable to find destination server: there are no clusters with this URL: ${destServer}`);
  if (!destNs) return FATA(`rpc error: code = InvalidArgument desc = application destination spec for ${name} is invalid: namespace is required`);
  const policy = str("sync-policy");
  const automated = policy === "automated" || policy === "auto" || policy === "automatic";
  const app: ArgoApp = {
    name,
    project: str("project") ?? "default",
    repo,
    path,
    target: str("revision") ?? "HEAD",
    destServer: IN_CLUSTER,
    destNs,
    automated,
    prune: automated && !!flags["auto-prune"],
    selfHeal: automated && !!flags["self-heal"] && flags["self-heal"] !== "false",
    createNs: /CreateNamespace=true/.test(String(flags["sync-option"] ?? "")),
    history: [],
    managed: [],
    messages: {},
    healCount: 0,
    createdAt: Date.now(),
  };
  const d = desiredOf(sh, app);
  if (d.error !== undefined)
    return FATA(`rpc error: code = InvalidArgument desc = application spec for ${name} is invalid: InvalidSpecError: Unable to generate manifests in ${path}: rpc error: code = Unknown desc = ${d.error}`);
  const st = argoState(sh);
  const prev = st.apps[name];
  if (prev) {
    const same = prev.repo === app.repo && prev.path === app.path && prev.destNs === app.destNs;
    if (!same && !flags.upsert) return FATA("rpc error: code = InvalidArgument desc = existing application spec is different, use upsert flag to force update");
    if (same) return `application '${name}' unchanged`;
  }
  st.apps[name] = app;
  reconcileApps(sh);
  return `application '${name}' ${prev ? "updated" : "created"}`;
};

const syncOutput = (sh: Shell, app: ArgoApp, before: Row[]) => {
  const now = iso(Date.now());
  const after = appStatus(sh, app);
  const ts = table([
    ["TIMESTAMP", "GROUP", "KIND", "NAMESPACE", "NAME", "STATUS", "HEALTH", "HOOK", "MESSAGE"],
    ...before.map((r) => [now, group(r.kind), r.kind, r.ns, r.name, r.sync, r.health, "", ""]),
    ...after.rows.map((r) => [now, group(r.kind), r.kind, r.ns, r.name, r.sync, r.health, "", app.messages[r.key] ?? ""]),
  ]);
  return [ts, "", header(sh, app).text, operationText(app), "", resourceTable(app, after.rows)].join("\n");
};

const appCmd = (sh: Shell, sub: string, pos: string[], flags: Record<string, string | true>): ToolResult => {
  const st = argoState(sh);
  const name = pos[0];
  const need = (): ArgoApp | ToolResult => {
    if (!name) return FATA(`accepts 1 argument: the application name`);
    return st.apps[name] ?? FATA(`rpc error: code = NotFound desc = applications.argoproj.io "${name}" not found`);
  };
  const isApp = (x: ArgoApp | ToolResult): x is ArgoApp => typeof x === "object" && "history" in x;
  switch (sub) {
    case "create":
      return appCreate(sh, name, flags);
    case "list": {
      const apps = Object.values(st.apps);
      return table([
        ["NAME", "CLUSTER", "NAMESPACE", "PROJECT", "STATUS", "HEALTH", "SYNCPOLICY", "CONDITIONS", "REPO", "PATH", "TARGET"],
        ...apps.map((a) => {
          const s = appStatus(sh, a);
          return [`argocd/${a.name}`, a.destServer, a.destNs, a.project, s.sync, s.health, a.automated ? (a.prune ? "Auto-Prune" : "Auto") : "<none>", s.error !== undefined ? "ComparisonError" : "<none>", a.repo, a.path, a.target];
        }),
      ]);
    }
    case "get": {
      const app = need();
      if (!isApp(app)) return app;
      const h = header(sh, app);
      if (h.s.sync === "OutOfSync") sh.flags.add(`argocd:saw-outofsync:${app.name}`);
      sh.flags.add(`argocd:get:${app.name}`);
      return [h.text, app.operation && flags["show-operation"] ? operationText(app) : "", "", resourceTable(app, h.s.rows)].filter((x, i) => i !== 1 || x).join("\n");
    }
    case "sync": {
      const app = need();
      if (!isApp(app)) return app;
      const before = appStatus(sh, app);
      if (before.error !== undefined) return FATA(`rpc error: code = FailedPrecondition desc = error resolving repo revision: ${before.error}`);
      const r = syncApp(sh, app, { by: "admin", prune: !!flags.prune || app.prune });
      sh.flags.add(`argocd:synced:${app.name}`);
      const out = syncOutput(sh, app, before.rows);
      return r.ok ? out : { output: `${out}\nFATA[0001] Operation has completed with phase: Failed`, ok: false };
    }
    case "diff": {
      const app = need();
      if (!isApp(app)) return app;
      const s = appStatus(sh, app);
      if (s.error !== undefined) return FATA(`rpc error: code = Unknown desc = ${s.error}`);
      sh.flags.add(`argocd:diff:${app.name}`);
      return { output: diffText(s.rows), ok: true };
    }
    case "history": {
      const app = need();
      if (!isApp(app)) return app;
      sh.flags.add(`argocd:history:${app.name}`);
      return [`SOURCE  ${app.repo}`, table([["ID", "DATE", "REVISION"], ...app.history.map((h) => [String(h.id), iso(h.deployedAt).replace("T", " ").replace("+00:00", " +0000 UTC"), `${app.target} (${short(h.revision)})`])])].join("\n");
    }
    case "rollback": {
      const app = need();
      if (!isApp(app)) return app;
      if (app.automated) return FATA("rpc error: code = FailedPrecondition desc = rollback cannot be initiated when auto-sync is enabled");
      const id = pos[1] !== undefined ? Number(pos[1]) : app.history.length - 2;
      const h = app.history.find((x) => x.id === id);
      if (!h) return FATA(`Application '${app.name}' does not have deployment id '${pos[1] ?? id}' in history`);
      const before = appStatus(sh, app);
      syncApp(sh, app, { by: "admin", docs: h.docs, rev: h.revision, kind: "Rollback" });
      return syncOutput(sh, app, before.rows);
    }
    case "set": {
      const app = need();
      if (!isApp(app)) return app;
      const policy = flags["sync-policy"];
      if (policy === "none" || policy === "manual") {
        app.automated = false;
        app.selfHeal = false;
        app.prune = false;
      } else if (policy === "automated" || policy === "auto" || policy === "automatic") app.automated = true;
      if (flags["self-heal"] !== undefined) {
        if (!app.automated && flags["self-heal"] !== "false") return FATA("rpc error: code = InvalidArgument desc = --self-heal requires automated sync (--sync-policy automated)");
        app.selfHeal = flags["self-heal"] !== "false";
      }
      if (flags["auto-prune"] !== undefined) {
        if (!app.automated && flags["auto-prune"] !== "false") return FATA("rpc error: code = InvalidArgument desc = --auto-prune requires automated sync (--sync-policy automated)");
        app.prune = flags["auto-prune"] !== "false";
      }
      if (typeof flags.revision === "string") app.target = flags.revision;
      if (typeof flags.path === "string") app.path = flags.path;
      reconcileApps(sh);
      return "";
    }
    case "delete": {
      const app = need();
      if (!isApp(app)) return app;
      if (flags.cascade !== "false")
        for (const k of app.managed) {
          const [kind, ns, n] = k.split("/");
          deleteAny(sh, kind, n, ns);
        }
      delete st.apps[app.name];
      return flags.y || flags.yes ? "" : `Are you sure you want to delete '${app.name}' and all its resources? [y/n] y\napplication '${app.name}' deleted`;
    }
    case "manifests": {
      const app = need();
      if (!isApp(app)) return app;
      const d = desiredOf(sh, app);
      if (d.error !== undefined) return FATA(d.error);
      return d.docs.map((x) => YAML.stringify(x).trimEnd()).join("\n---\n");
    }
    default:
      return { output: `Error: unknown command "${sub}" for "argocd app"`, ok: false };
  }
};

const SUBS: Record<string, string> = {
  login: "autentica no servidor do Argo CD",
  logout: "encerra a sessão",
  app: "gerencia Applications: create, list, get, sync, diff, history, rollback, set, delete",
  cluster: "clusters de destino (cluster list)",
  repo: "repositórios Git cadastrados (repo list, repo add)",
  version: "versões do CLI e do servidor",
};

registerTool({
  name: "argocd",
  summary: "Argo CD (GitOps): Applications sincronizadas a partir do Git",
  subcommands: SUBS,
  flags: {
    "--repo": "app create: URL do repositório Git com os manifests",
    "--path": "app create: diretório dos manifests dentro do repositório",
    "--dest-server": "app create: API server de destino (https://kubernetes.default.svc = o próprio cluster)",
    "--dest-namespace": "app create: namespace onde os recursos serão aplicados",
    "--sync-policy": "automated (sincroniza sozinho a cada commit) ou none (manual)",
    "--self-heal": "reverte mudanças feitas direto no cluster (drift)",
    "--auto-prune": "apaga do cluster o que foi removido do Git",
    "--revision": "branch, tag ou commit a acompanhar (padrão HEAD)",
    "--prune": "app sync: remove recursos que não existem mais no Git",
    "--username": "login: usuário",
    "--password": "login: senha",
    "--insecure": "login: aceita certificado TLS autoassinado",
    "--sync-option": "opções de sync, ex.: CreateNamespace=true",
  },
  valueFlags: ["--repo", "--path", "--dest-server", "--dest-namespace", "--dest-name", "--sync-policy", "--revision", "--project", "--username", "--password", "--sync-option", "-o", "--output", "--server"],
  run: ({ sh, pos, flags }) => {
    const [group, sub, ...rest] = pos;
    if (!group) return `argocd controls a Argo CD server\n\nUsage:\n  argocd [command]\n\nAvailable Commands:\n${Object.entries(SUBS).map(([k, v]) => `  ${k.padEnd(10)} ${v}`).join("\n")}`;
    if (!SUBS[group]) return { output: `Error: unknown command "${group}" for "argocd"`, ok: false };
    const st = argoState(sh);
    if (group === "version") return "argocd: v2.12.3+6b9cd82\n  BuildDate: 2024-08-27T11:57:48Z\n  GoVersion: go1.22.4\nargocd-server: v2.12.3+6b9cd82";
    if (group === "login") {
      if (!sub) return FATA("accepts 1 arg(s), received 0");
      st.loggedIn = true;
      st.server = sub;
      return `'${typeof flags.username === "string" ? flags.username : "admin"}:login' logged in successfully\nContext '${sub}' updated`;
    }
    if (group === "logout") {
      st.loggedIn = false;
      return `Logged out from '${st.server}'`;
    }
    if (!st.loggedIn) return FATA("Argo CD server address unspecified");
    reconcileApps(sh);
    if (group === "cluster") return table([["SERVER", "NAME", "VERSION", "STATUS", "MESSAGE", "PROJECT"], [IN_CLUSTER, "in-cluster", "1.30", "Successful", "", ""]]);
    if (group === "repo") {
      if (sub === "add") return `Repository '${rest[0] ?? ""}' added`;
      const repos = [...new Set(Object.values(st.apps).map((a) => a.repo))];
      return table([["TYPE", "NAME", "REPO", "INSECURE", "OCI", "LFS", "CREDS", "STATUS", "MESSAGE", "PROJECT"], ...repos.map((r) => ["git", "", r, "false", "false", "false", "false", "Successful", "", ""])]);
    }
    if (!sub) return { output: `Error: unknown command "" for "argocd app"`, ok: false };
    return appCmd(sh, sub, rest, flags);
  },
  explainError: (_cmd, output) => {
    if (/server address unspecified/.test(output)) return "O CLI ainda não sabe com qual servidor Argo CD falar. Faça login antes: argocd login <servidor> --username admin --password <senha> --insecure.";
    if (/app path does not exist/.test(output)) return "O --path não existe no repositório (na revisão enviada ao GitHub). Confira o diretório dos manifests e lembre: o Argo CD lê o remoto, não seus arquivos locais — faça git push primeiro.";
    if (/repository not found|repository not accessible/.test(output)) return "O Argo CD não encontrou esse repositório. Use a mesma URL do remoto (git remote -v) e confirme que já houve um git push.";
    if (/rollback cannot be initiated when auto-sync is enabled/.test(output))
      return "Com auto-sync ligado o Argo CD reaplicaria o Git logo depois do rollback. Desligue antes: argocd app set <app> --sync-policy none; depois conserte o Git (revert) e religue o automated.";
    if (/applications.argoproj.io .* not found/.test(output)) return "Não existe Application com esse nome. Liste com argocd app list.";
    if (/there are no clusters with this URL/.test(output)) return "Cluster de destino desconhecido. Para o próprio cluster onde o Argo CD roda use --dest-server https://kubernetes.default.svc.";
    if (/requires automated sync/.test(output)) return "Self-heal e auto-prune são opções do sync automático. Ligue junto: argocd app set <app> --sync-policy automated --self-heal.";
    if (/existing application spec is different/.test(output)) return "Já existe uma Application com esse nome e outra configuração. Use --upsert para sobrescrever ou argocd app set para ajustar.";
    if (/does not have deployment id/.test(output)) return "Esse ID não está no histórico. Veja os IDs com argocd app history <app>.";
    if (/namespaces? .* not found/.test(output)) return "O namespace de destino não existe. Crie com kubectl create namespace <ns> ou use --sync-option CreateNamespace=true.";
    if (/unknown command/.test(output)) return "Subcomando inexistente. Os principais: argocd app create|get|sync|diff|history|rollback|set.";
    return null;
  },
});
