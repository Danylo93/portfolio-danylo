// kubectl plugin backed by the in-memory cluster model.
import YAML from "yaml";
import { registerTool } from "../registry";
import type { Shell } from "../shell";
import type { Container, Deployment, Flags, K8sObject, Pod, Service, ToolCtx, ToolResult } from "../types";
import { age, flagStr, hexId, matchLabels, rand, table } from "../util";
import {
  CLUSTER_SCOPED, CP_NODE, NODE_AGE, bumpRevision, can, containerPort, containerReady, controlPlaneVersion, createDeployment, createService,
  deleteObj, endpoints, findDeployment, findObj, findService, jobCompletions, newPod, nodeReady, nsExists, objsOf, podEventsProblem,
  podReady, podRestarts, podStatus, probeResult, pvcStatus, readyCount, reconcile, schedulerHealthy, simplePodSpec,
  staticComponentStatus, trafficAllowed, unschedulableReasons, upsertObj, validImage,
} from "./cluster";
import { applyManifest, deleteAny, deploymentManifest, kindRef, nodeManifest, objectManifest, podManifest, serviceManifest } from "./manifest";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

// ---------- resource names ----------
const RESOURCES: { kind: string; names: string[]; short?: string }[] = [
  { kind: "Pod", names: ["pods", "pod", "po"], short: "po" },
  { kind: "Deployment", names: ["deployments", "deployment", "deploy"], short: "deploy" },
  { kind: "Service", names: ["services", "service", "svc"], short: "svc" },
  { kind: "Node", names: ["nodes", "node", "no"], short: "no" },
  { kind: "Namespace", names: ["namespaces", "namespace", "ns"], short: "ns" },
  { kind: "ConfigMap", names: ["configmaps", "configmap", "cm"], short: "cm" },
  { kind: "Secret", names: ["secrets", "secret"] },
  { kind: "Job", names: ["jobs", "job"] },
  { kind: "CronJob", names: ["cronjobs", "cronjob", "cj"], short: "cj" },
  { kind: "ServiceAccount", names: ["serviceaccounts", "serviceaccount", "sa"], short: "sa" },
  { kind: "Role", names: ["roles", "role"] },
  { kind: "ClusterRole", names: ["clusterroles", "clusterrole"] },
  { kind: "RoleBinding", names: ["rolebindings", "rolebinding"] },
  { kind: "ClusterRoleBinding", names: ["clusterrolebindings", "clusterrolebinding"] },
  { kind: "NetworkPolicy", names: ["networkpolicies", "networkpolicy", "netpol"], short: "netpol" },
  { kind: "PersistentVolume", names: ["persistentvolumes", "persistentvolume", "pv"], short: "pv" },
  { kind: "PersistentVolumeClaim", names: ["persistentvolumeclaims", "persistentvolumeclaim", "pvc"], short: "pvc" },
  { kind: "StorageClass", names: ["storageclasses", "storageclass", "sc"], short: "sc" },
  { kind: "Ingress", names: ["ingresses", "ingress", "ing"], short: "ing" },
  { kind: "HorizontalPodAutoscaler", names: ["horizontalpodautoscalers", "horizontalpodautoscaler", "hpa"], short: "hpa" },
  { kind: "ResourceQuota", names: ["resourcequotas", "resourcequota", "quota"], short: "quota" },
  { kind: "LimitRange", names: ["limitranges", "limitrange", "limits"], short: "limits" },
  { kind: "ReplicaSet", names: ["replicasets", "replicaset", "rs"], short: "rs" },
  { kind: "DaemonSet", names: ["daemonsets", "daemonset", "ds"], short: "ds" },
  { kind: "Endpoints", names: ["endpoints", "ep"], short: "ep" },
  { kind: "Event", names: ["events", "event", "ev"], short: "ev" },
  { kind: "All", names: ["all"] },
];

export const RESOURCE_WORDS = RESOURCES.flatMap((r) => r.names);
const kindOf = (word?: string) => RESOURCES.find((r) => r.names.includes((word ?? "").toLowerCase()))?.kind;
const pluralOf = (kind: string) => RESOURCES.find((r) => r.kind === kind)!.names[0];

// ---------- state ----------
const ctxState = (sh: Shell) => sh.ext("kubectx", () => ({ ns: "default", portForwards: {} as Record<number, { svc: string; ns: string; port: number }> }));

// ---------- helpers ----------
const notFound = (kind: string, name: string) => `Error from server (NotFound): ${kind === "Deployment" ? "deployments.apps" : kind === "Job" || kind === "CronJob" ? `${pluralOf(kind)}.batch` : pluralOf(kind)} "${name}" not found`;
const labelsStr = (l: Record<string, string>) => Object.entries(l).map(([k, v]) => `${k}=${v}`).join(",") || "<none>";

const parseSelector = (sel?: string) => {
  if (!sel) return () => true;
  const parts = sel.split(",").map((p) => p.trim());
  return (labels: Record<string, string>) =>
    parts.every((p) => {
      if (p.includes("!=")) {
        const [k, v] = p.split("!=");
        return labels[k] !== v;
      }
      if (p.includes("=")) {
        const [k, v] = p.split(/==?/);
        return labels[k] === v;
      }
      if (p.startsWith("!")) return !(p.slice(1) in labels);
      return p in labels;
    });
};

const multiFlag = (args: string[], name: string) => {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith(`--${name}=`)) out.push(args[i].slice(name.length + 3));
    else if (args[i] === `--${name}` && args[i + 1]) out.push(args[++i]);
  }
  return out;
};

const parseKV = (s: string) => {
  const i = s.indexOf("=");
  return i < 0 ? [s, ""] : [s.slice(0, i), s.slice(i + 1)];
};

const podsOfDeployment = (sh: Shell, d: Deployment) => sh.state.pods.filter((p) => p.ownerKind === "Deployment" && p.owner === d.name && p.namespace === d.namespace);

const findPod = (sh: Shell, name: string, ns: string) => sh.state.pods.find((p) => p.name === name && p.namespace === ns);

// ---------- output formats ----------
const jsonpath = (data: Json, expr: string) => {
  const evalPath = (obj: Json, path: string): Json[] => {
    const tokens = path.match(/\.[^.[\]]+|\[[^\]]*\]/g) ?? [];
    let cur: Json[] = [obj];
    for (const t of tokens) {
      const next: Json[] = [];
      for (const c of cur) {
        if (c == null) continue;
        if (t === "[*]") next.push(...(Array.isArray(c) ? c : Object.values(c)));
        else if (t.startsWith("[")) {
          const idx = t.slice(1, -1);
          if (/^-?\d+$/.test(idx)) next.push(Array.isArray(c) ? c.at(Number(idx)) : undefined);
          else next.push(c[idx.replace(/^['"]|['"]$/g, "")]);
        } else {
          const key = t.slice(1);
          if (key === "*") next.push(...Object.values(c));
          else next.push(c[key]);
        }
      }
      cur = next;
    }
    return cur.filter((x) => x !== undefined);
  };
  const text = expr.replace(/^['"]|['"]$/g, "");
  return text
    .replace(/\{([^}]*)\}/g, (_, p: string) => {
      const vals = evalPath(data, p.trim() === "" ? "" : p.trim().startsWith(".") ? p.trim() : "." + p.trim());
      return vals.map((v) => (typeof v === "object" ? JSON.stringify(v) : String(v))).join(" ");
    })
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t");
};

const formatOut = (manifests: Json[], output: string | undefined, single: boolean): string | null => {
  if (!output || output === "wide") return null;
  const data = single ? manifests[0] : { apiVersion: "v1", items: manifests, kind: "List", metadata: { resourceVersion: "" } };
  if (output === "yaml") return YAML.stringify(data).trimEnd();
  if (output === "json") return JSON.stringify(data, null, 2);
  if (output === "name") return manifests.map((m) => `${kindRef(m.kind)}/${m.metadata.name}`).join("\n");
  if (output.startsWith("jsonpath=") || output.startsWith("jsonpath-as-json=")) return jsonpath(data, output.slice(output.indexOf("=") + 1));
  if (output.startsWith("custom-columns=")) {
    const cols = output.slice(15).split(",").map((c) => c.split(":"));
    return table([cols.map((c) => c[0]), ...manifests.map((m) => cols.map((c) => jsonpath(m, `{${c[1]}}`) || "<none>"))]);
  }
  return `error: unable to match a printer suitable for the output format "${output}"`;
};

// ---------- pod runtime ----------
const NGINX_HTML = `<!DOCTYPE html>
<html>
<head>
<title>Welcome to nginx!</title>
</head>
<body>
<h1>Welcome to nginx!</h1>
<p>If you see this page, the nginx web server is successfully installed and
working. Further configuration is required.</p>
</body>
</html>`;

const responseOf = (pod: Pod, port: number) => {
  const c = pod.spec.containers.find((x) => containerPort(x) === port) ?? pod.spec.containers[0];
  if (/http-echo/.test(c.image)) return (c.args ?? []).find((a) => a.startsWith("-text="))?.slice(6).replace(/^["']|["']$/g, "") ?? "hello-world";
  if (/httpd/.test(c.image)) return "<html><body><h1>It works!</h1></body></html>";
  if (/nginx/.test(c.image)) return NGINX_HTML;
  return "OK";
};

const secretVal = (v: string) => {
  try {
    return atob(v);
  } catch {
    return v;
  }
};

const podEnv = (sh: Shell, pod: Pod, c: Container) => {
  const env: Record<string, string> = {
    PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    HOSTNAME: pod.name,
    KUBERNETES_SERVICE_HOST: "10.96.0.1",
    KUBERNETES_SERVICE_PORT: "443",
  };
  for (const ef of c.envFrom ?? []) {
    if (ef.configMapRef) Object.assign(env, findObj(sh, "ConfigMap", ef.configMapRef.name, pod.namespace)?.manifest.data ?? {});
    if (ef.secretRef) for (const [k, v] of Object.entries(findObj(sh, "Secret", ef.secretRef.name, pod.namespace)?.manifest.data ?? {})) env[k] = secretVal(String(v));
  }
  for (const e of c.env ?? []) {
    const vf = e.valueFrom as Json;
    if (vf?.configMapKeyRef) env[e.name] = findObj(sh, "ConfigMap", vf.configMapKeyRef.name, pod.namespace)?.manifest.data?.[vf.configMapKeyRef.key] ?? "";
    else if (vf?.secretKeyRef) env[e.name] = secretVal(findObj(sh, "Secret", vf.secretKeyRef.name, pod.namespace)?.manifest.data?.[vf.secretKeyRef.key] ?? "");
    else if (vf?.fieldRef) env[e.name] = vf.fieldRef.fieldPath === "metadata.name" ? pod.name : vf.fieldRef.fieldPath === "metadata.namespace" ? pod.namespace : pod.ip;
    else env[e.name] = String(e.value ?? "");
  }
  return env;
};

const mountedFiles = (sh: Shell, pod: Pod, c: Container) => {
  const files: Record<string, string> = {
    "/etc/hostname": pod.name,
    "/etc/resolv.conf": `search ${pod.namespace}.svc.cluster.local svc.cluster.local cluster.local\nnameserver 10.96.0.10\noptions ndots:5`,
  };
  if (/nginx/.test(c.image)) files["/usr/share/nginx/html/index.html"] = NGINX_HTML;
  for (const vm of c.volumeMounts ?? []) {
    const vol = pod.spec.volumes?.find((v) => v.name === vm.name);
    if (vol?.configMap) for (const [k, v] of Object.entries(findObj(sh, "ConfigMap", vol.configMap.name, pod.namespace)?.manifest.data ?? {})) files[`${vm.mountPath}/${k}`] = String(v);
    if (vol?.secret) for (const [k, v] of Object.entries(findObj(sh, "Secret", vol.secret.secretName, pod.namespace)?.manifest.data ?? {})) files[`${vm.mountPath}/${k}`] = secretVal(String(v));
    if (vol?.persistentVolumeClaim || vol?.emptyDir) {
      const store = sh.ext("podVolumes", () => ({}) as Record<string, Record<string, string>>);
      const key = vol.persistentVolumeClaim ? `pvc:${pod.namespace}/${vol.persistentVolumeClaim.claimName}` : `empty:${pod.namespace}/${pod.name}/${vol.name}`;
      for (const [k, v] of Object.entries(store[key] ?? {})) files[`${vm.mountPath}/${k}`] = v;
    }
  }
  return files;
};

const volumeFor = (sh: Shell, pod: Pod, c: Container, path: string) => {
  for (const vm of c.volumeMounts ?? []) {
    if (!path.startsWith(vm.mountPath + "/")) continue;
    const vol = pod.spec.volumes?.find((v) => v.name === vm.name);
    if (vol?.persistentVolumeClaim || vol?.emptyDir) {
      const store = sh.ext("podVolumes", () => ({}) as Record<string, Record<string, string>>);
      const key = vol.persistentVolumeClaim ? `pvc:${pod.namespace}/${vol.persistentVolumeClaim.claimName}` : `empty:${pod.namespace}/${pod.name}/${vol.name}`;
      store[key] ??= {};
      return { store: store[key], rel: path.slice(vm.mountPath.length + 1) };
    }
  }
  return null;
};

/** Resolves an address as seen from inside a pod (DNS names, ClusterIPs, pod IPs). */
const resolveTarget = (sh: Shell, from: Pod | null, host: string, port: number): { pods: Pod[]; port: number; svc?: Service } | { error: "dns" | "refused" } => {
  const ns = from?.namespace ?? "default";
  const byName = sh.state.services.find((s) => {
    const names = [`${s.name}.${s.namespace}.svc.cluster.local`, `${s.name}.${s.namespace}.svc`, `${s.name}.${s.namespace}`];
    if (s.namespace === ns) names.push(s.name);
    return names.includes(host);
  });
  const svc = byName ?? sh.state.services.find((s) => s.clusterIP === host);
  if (svc) {
    if (port !== svc.port) return { error: "refused" };
    return { pods: endpoints(sh, svc), port: svc.targetPort, svc };
  }
  const pod = sh.state.pods.find((p) => p.ip === host && podStatus(sh, p) === "Running");
  if (pod) return { pods: [pod], port };
  if (from && /^[a-z]/.test(host) && !host.includes(".")) return { error: "dns" };
  if (from && /svc|cluster\.local/.test(host)) return { error: "dns" };
  return { error: "refused" };
};

const podHttp = (sh: Shell, from: Pod | null, host: string, port: number, tool: "wget" | "curl") => {
  const t = resolveTarget(sh, from, host, port);
  if ("error" in t) {
    if (t.error === "dns") return tool === "wget" ? `wget: bad address '${host}'` : `curl: (6) Could not resolve host: ${host}`;
    return tool === "wget" ? `wget: can't connect to remote host (${host}): Connection refused` : `curl: (7) Failed to connect to ${host} port ${port}: Connection refused`;
  }
  if (!t.pods.length) return tool === "wget" ? `wget: can't connect to remote host (${host}): Connection refused` : `curl: (7) Failed to connect to ${host} port ${port}: Connection refused`;
  const target = t.pods[Math.floor(Math.random() * t.pods.length)];
  if (!trafficAllowed(sh, from, target, t.port)) return tool === "wget" ? "wget: download timed out" : `curl: (28) Connection timed out after 5001 milliseconds`;
  if (t.svc) sh.flags.add(`reach:${t.svc.namespace}/${t.svc.name}`);
  if (from) sh.flags.add(`reach-from:${from.name}:${t.svc?.name ?? target.name}`);
  return responseOf(target, t.port);
};

const podExec = (sh: Shell, pod: Pod, c: Container, argv: string[]): string => {
  if (!argv.length) return "error: you must specify at least one command for the container";
  const [cmd, ...a] = argv;
  const env = podEnv(sh, pod, c);
  const files = mountedFiles(sh, pod, c);
  const runAs = (c.securityContext?.runAsUser ?? pod.spec.securityContext?.runAsUser) as number | undefined;
  const readOnly = !!c.securityContext?.readOnlyRootFilesystem;
  const bin = cmd.split("/").pop()!;
  const exit = (msg: string, code = 1) => `${msg}\ncommand terminated with exit code ${code}`;
  switch (bin) {
    case "sh":
    case "bash":
    case "ash":
      if (a[0] === "-c") return a.slice(1).join(" ").split(/\s*(?:&&|;)\s*/).map((part) => podExec(sh, pod, c, part.match(/"[^"]*"|'[^']*'|\S+/g)?.map((x) => x.replace(/^["']|["']$/g, "")) ?? [])).join("\n");
      return "";
    case "env":
    case "printenv":
      return a[0] ? env[a[0]] ?? exit("", 1).trim() : Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n");
    case "echo":
      return a.map((x) => (x.startsWith("$") ? env[x.slice(1).replace(/[{}]/g, "")] ?? "" : x)).join(" ");
    case "cat": {
      const p = a[0];
      const vol = volumeFor(sh, pod, c, p);
      if (vol && vol.rel in vol.store) return vol.store[vol.rel];
      return p in files ? files[p] : exit(`cat: can't open '${p}': No such file or directory`);
    }
    case "ls": {
      const dir = (a.find((x) => !x.startsWith("-")) ?? "/").replace(/\/$/, "");
      const vol = volumeFor(sh, pod, c, dir + "/x");
      const names = new Set<string>(Object.keys(files).filter((f) => f.startsWith(dir + "/")).map((f) => f.slice(dir.length + 1).split("/")[0]));
      if (vol) Object.keys(vol.store).forEach((k) => names.add(k.split("/")[0]));
      if (!names.size && dir !== "") return exit(`ls: ${dir}: No such file or directory`);
      return [...names].sort().join("\n");
    }
    case "touch":
    case "tee": {
      const p = a.find((x) => !x.startsWith("-"))!;
      const vol = volumeFor(sh, pod, c, p);
      if (vol) {
        vol.store[vol.rel] = "";
        return "";
      }
      if (readOnly && !p.startsWith("/tmp/")) return exit(`${bin}: ${p}: Read-only file system`);
      if (readOnly) return exit(`${bin}: ${p}: Read-only file system`);
      return "";
    }
    case "whoami":
      return runAs && runAs !== 0 ? exit("whoami: unknown uid " + runAs) : "root";
    case "id":
      return runAs ? `uid=${runAs} gid=${runAs} groups=${runAs}` : "uid=0(root) gid=0(root) groups=0(root),1(bin),2(daemon)";
    case "hostname":
      return pod.name;
    case "ps":
      return `PID   USER     TIME  COMMAND\n    1 ${runAs ? runAs : "root"}      0:00 ${[...(c.command ?? []), ...(c.args ?? [])].join(" ") || (/nginx/.test(c.image) ? "nginx: master process nginx -g daemon off;" : c.image)}`;
    case "nslookup": {
      const name = a[0];
      const t = resolveTarget(sh, pod, name, (sh.state.services.find((s) => name.startsWith(s.name))?.port) ?? 80);
      const svc = sh.state.services.find((s) => [s.name, `${s.name}.${s.namespace}`, `${s.name}.${s.namespace}.svc`, `${s.name}.${s.namespace}.svc.cluster.local`].includes(name) && (name.includes(".") || s.namespace === pod.namespace));
      if (!svc && "error" in t) return exit(`Server:\t\t10.96.0.10\nAddress:\t10.96.0.10:53\n\n** server can't find ${name}.${pod.namespace}.svc.cluster.local: NXDOMAIN`);
      return `Server:\t\t10.96.0.10\nAddress:\t10.96.0.10:53\n\nName:\t${svc!.name}.${svc!.namespace}.svc.cluster.local\nAddress: ${svc!.clusterIP}`;
    }
    case "wget":
    case "curl": {
      const url = a.find((x) => !x.startsWith("-") && !/^\d+$/.test(x) && x !== "-");
      if (!url) return exit(`${bin}: missing URL`);
      const m = /^(?:https?:\/\/)?([^:/]+)(?::(\d+))?/.exec(url);
      const out = podHttp(sh, pod, m?.[1] ?? "", Number(m?.[2] ?? 80), bin === "wget" ? "wget" : "curl");
      return /^(wget|curl):/.test(out) ? exit(out) : out;
    }
    case "date":
      return new Date().toUTCString();
    case "sleep":
    case "true":
      return "";
    default:
      return `OCI runtime exec failed: exec failed: unable to start container process: exec: "${cmd}": executable file not found in $PATH: unknown\ncommand terminated with exit code 126`;
  }
};

const podLogs = (sh: Shell, pod: Pod, c: Container, previous: boolean) => {
  const st = podStatus(sh, pod);
  if (pod.ownerKind === "Static") {
    const comp = pod.name.replace(`-${CP_NODE}`, "") as Parameters<typeof staticComponentStatus>[1];
    const s = staticComponentStatus(sh, comp);
    return s.logs ?? (s.ok ? `I0923 12:00:01.000000       1 ${comp}.go:92] "Starting ${comp}" version="${controlPlaneVersion(sh)}"` : "");
  }
  if (["ContainerCreating", "Pending", "ErrImagePull", "ImagePullBackOff", "CreateContainerConfigError"].includes(st) || st.startsWith("Init"))
    return `Error from server (BadRequest): container "${c.name}" in pod "${pod.name}" is waiting to start: ${st === "ImagePullBackOff" || st === "ErrImagePull" ? "trying and failing to pull image" : st}`;
  const cl = [...(c.command ?? []), ...(c.args ?? [])].join(" ");
  const echoes = [...cl.matchAll(/echo\s+("[^"]*"|'[^']*'|[^;&|]+)/g)].map((m) => m[1].trim().replace(/^["']|["']$/g, ""));
  if (/while true|while :/.test(cl) && echoes.length) {
    const n = Math.min(8, Math.max(1, Math.floor((Date.now() - (pod.scheduledAt ?? pod.createdAt)) / 5000)));
    return Array.from({ length: n }, () => echoes.map((e) => e.replace(/\$\(date\)/, new Date().toUTCString())).join("\n")).join("\n");
  }
  if (echoes.length) return echoes.join("\n");
  if (st === "CrashLoopBackOff" || st === "Error") return previous ? (cl ? `sh: ${cl.includes("exit") ? "" : "error: "}${cl}` : "") : "";
  if (/nginx/.test(c.image)) {
    const t = new Date(pod.scheduledAt ?? pod.createdAt).toISOString().replace("T", " ").slice(0, 19);
    return [
      "/docker-entrypoint.sh: /docker-entrypoint.d/ is not empty, will attempt to perform configuration",
      "/docker-entrypoint.sh: Launching /docker-entrypoint.d/10-listen-on-ipv6-by-default.sh",
      "/docker-entrypoint.sh: Configuration complete; ready for start up",
      `${t} [notice] 1#1: using the "epoll" event method`,
      `${t} [notice] 1#1: nginx/1.25.5`,
      `${t} [notice] 1#1: start worker processes`,
    ].join("\n");
  }
  if (/redis/.test(c.image)) return "1:M 23 Sep 2026 12:00:00.000 * Ready to accept connections tcp";
  if (/http-echo/.test(c.image)) return `2026/09/23 12:00:00 [INFO] server is listening on :5678`;
  return "";
};

// ---------- tables ----------
const nodeStatus = (sh: Shell, name: string) => {
  const n = sh.state.nodes.find((x) => x.name === name)!;
  return `${nodeReady(sh, n.name) ? "Ready" : "NotReady"}${n.schedulable ? "" : ",SchedulingDisabled"}`;
};

type Row = { ns?: string; cells: string[]; labels?: Record<string, string>; manifest: Json };

const virtualObjects = (sh: Shell, kind: string, ns: string | null): K8sObject[] => {
  const nss = ns === null ? sh.state.namespaces.map((n) => n.name) : [ns];
  if (kind === "ConfigMap") return nss.map((n) => ({ kind, name: "kube-root-ca.crt", namespace: n, manifest: { data: { "ca.crt": "-----BEGIN CERTIFICATE-----…" } }, createdAt: NODE_AGE }));
  if (kind === "ServiceAccount") return nss.map((n) => ({ kind, name: "default", namespace: n, manifest: {}, createdAt: NODE_AGE }));
  if (kind === "StorageClass") return [{ kind, name: "standard", manifest: { provisioner: "rancher.io/local-path", reclaimPolicy: "Delete", volumeBindingMode: "WaitForFirstConsumer", metadata: { annotations: { "storageclass.kubernetes.io/is-default-class": "true" } } }, createdAt: NODE_AGE }];
  if (kind === "ClusterRole") return ["admin", "cluster-admin", "edit", "view"].map((name) => ({ kind, name, manifest: { rules: [{ verbs: name === "view" ? ["get", "list", "watch"] : ["*"], resources: ["*"] }] }, createdAt: NODE_AGE }));
  return [];
};

const listRows = (sh: Shell, kind: string, ns: string | null, wide: boolean, sel: (l: Record<string, string>) => boolean): { head: string[]; rows: Row[] } => {
  const inNs = (n: string) => ns === null || n === ns;
  switch (kind) {
    case "Pod": {
      const head = ["NAME", "READY", "STATUS", "RESTARTS", "AGE", ...(wide ? ["IP", "NODE", "NOMINATED NODE", "READINESS GATES"] : [])];
      const rows = sh.state.pods.filter((p) => inNs(p.namespace) && sel(p.labels)).map((p) => {
        const st = podStatus(sh, p);
        const restarts = podRestarts(sh, p);
        return {
          ns: p.namespace,
          labels: p.labels,
          manifest: podManifest(sh, p),
          cells: [p.name, readyCount(sh, p), st, restarts ? `${restarts} (${Math.max(5, restarts * 12)}s ago)` : "0", age(p.createdAt), ...(wide ? [st === "Running" || p.ownerKind ? p.ip : "<none>", p.node ?? "<none>", "<none>", "<none>"] : [])],
        };
      });
      return { head, rows };
    }
    case "Deployment": {
      const head = ["NAME", "READY", "UP-TO-DATE", "AVAILABLE", "AGE", ...(wide ? ["CONTAINERS", "IMAGES", "SELECTOR"] : [])];
      const rows = sh.state.deployments.filter((d) => inNs(d.namespace) && sel(d.labels)).map((d) => {
        const ready = podsOfDeployment(sh, d).filter((p) => podReady(sh, p)).length;
        return {
          ns: d.namespace,
          labels: d.labels,
          manifest: deploymentManifest(sh, d),
          cells: [d.name, `${ready}/${d.replicas}`, String(d.replicas), String(ready), age(d.createdAt), ...(wide ? [d.template.spec.containers.map((c) => c.name).join(","), d.template.spec.containers.map((c) => c.image).join(","), labelsStr(d.selector)] : [])],
        };
      });
      return { head, rows };
    }
    case "ReplicaSet": {
      const rows = sh.state.deployments.filter((d) => inNs(d.namespace)).map((d) => {
        const pods = podsOfDeployment(sh, d);
        const hash = pods[0]?.labels["pod-template-hash"] ?? rand(9);
        return { ns: d.namespace, manifest: { kind: "ReplicaSet", metadata: { name: `${d.name}-${hash}` } }, cells: [`${d.name}-${hash}`, String(d.replicas), String(pods.length), String(pods.filter((p) => podReady(sh, p)).length), age(d.createdAt)] };
      });
      return { head: ["NAME", "DESIRED", "CURRENT", "READY", "AGE"], rows };
    }
    case "Service": {
      const k8s: Service = { name: "kubernetes", namespace: "default", type: "ClusterIP", clusterIP: "10.96.0.1", port: 443, targetPort: 6443, selector: {}, createdAt: NODE_AGE };
      const dns: Service = { name: "kube-dns", namespace: "kube-system", type: "ClusterIP", clusterIP: "10.96.0.10", port: 53, targetPort: 53, selector: { "k8s-app": "kube-dns" }, createdAt: NODE_AGE };
      const rows = [k8s, dns, ...sh.state.services].filter((s) => inNs(s.namespace) && sel(s.selector)).map((s) => ({
        ns: s.namespace,
        labels: s.selector,
        manifest: serviceManifest(s),
        cells: [s.name, s.type, s.clusterIP, s.type === "LoadBalancer" ? "<pending>" : "<none>", s.name === "kube-dns" ? "53/UDP,53/TCP,9153/TCP" : s.nodePort ? `${s.port}:${s.nodePort}/TCP` : `${s.port}/TCP`, age(s.createdAt), ...(wide ? [Object.keys(s.selector).length ? labelsStr(s.selector) : "<none>"] : [])],
      }));
      return { head: ["NAME", "TYPE", "CLUSTER-IP", "EXTERNAL-IP", "PORT(S)", "AGE", ...(wide ? ["SELECTOR"] : [])], rows };
    }
    case "Endpoints": {
      const rows = sh.state.services.filter((s) => inNs(s.namespace)).map((s) => ({ ns: s.namespace, manifest: { kind: "Endpoints", metadata: { name: s.name } }, cells: [s.name, endpoints(sh, s).map((p) => `${p.ip}:${s.targetPort}`).join(",") || "<none>", age(s.createdAt)] }));
      return { head: ["NAME", "ENDPOINTS", "AGE"], rows };
    }
    case "Node": {
      const head = ["NAME", "STATUS", "ROLES", "AGE", "VERSION", ...(wide ? ["INTERNAL-IP", "EXTERNAL-IP", "OS-IMAGE", "KERNEL-VERSION", "CONTAINER-RUNTIME"] : [])];
      const rows = sh.state.nodes.filter((n) => sel(n.labels)).map((n) => ({
        labels: n.labels,
        manifest: nodeManifest(sh, n),
        cells: [n.name, nodeStatus(sh, n.name), n.role === "control-plane" ? "control-plane" : "<none>", age(NODE_AGE), n.version, ...(wide ? [n.ip, "<none>", "Debian GNU/Linux 12 (bookworm)", "6.8.0-45-generic", "containerd://1.7.18"] : [])],
      }));
      return { head, rows };
    }
    case "Namespace": {
      const rows = sh.state.namespaces.map((n) => ({ labels: { "kubernetes.io/metadata.name": n.name }, manifest: { apiVersion: "v1", kind: "Namespace", metadata: { name: n.name, labels: { "kubernetes.io/metadata.name": n.name, ...(findObj(sh, "Namespace", n.name)?.manifest.metadata?.labels ?? {}) } }, status: { phase: "Active" } }, cells: [n.name, "Active", age(n.createdAt)] }));
      return { head: ["NAME", "STATUS", "AGE"], rows };
    }
    case "DaemonSet": {
      const rows = ["kube-proxy", "kindnet"].filter(() => inNs("kube-system")).map((n) => ({ ns: "kube-system", manifest: { kind: "DaemonSet", metadata: { name: n } }, cells: [n, "3", "3", "3", "3", "3", n === "kube-proxy" ? "kubernetes.io/os=linux" : "<none>", age(NODE_AGE)] }));
      return { head: ["NAME", "DESIRED", "CURRENT", "READY", "UP-TO-DATE", "AVAILABLE", "NODE SELECTOR", "AGE"], rows };
    }
    case "Event": {
      const rows: Row[] = [];
      for (const p of sh.state.pods.filter((x) => inNs(x.namespace) && x.ownerKind !== "Static" && x.ownerKind !== "DaemonSet")) {
        for (const e of podEvents(sh, p)) rows.push({ ns: p.namespace, manifest: { kind: "Event", message: e[4] }, cells: [e[2], e[0], e[1], `pod/${p.name}`, e[4]] });
      }
      return { head: ["LAST SEEN", "TYPE", "REASON", "OBJECT", "MESSAGE"], rows };
    }
    default: {
      const objs = [...virtualObjects(sh, kind, ns), ...(CLUSTER_SCOPED.has(kind) ? objsOf(sh, kind) : sh.state.objects.filter((o) => o.kind === kind && inNs(o.namespace!)))].filter((o) => sel(o.manifest.metadata?.labels ?? {}));
      const m = (o: K8sObject) => o.manifest;
      const cols: Record<string, { head: string[]; cells: (o: K8sObject) => string[] }> = {
        ConfigMap: { head: ["NAME", "DATA", "AGE"], cells: (o) => [o.name, String(Object.keys(m(o).data ?? {}).length), age(o.createdAt)] },
        Secret: { head: ["NAME", "TYPE", "DATA", "AGE"], cells: (o) => [o.name, m(o).type ?? "Opaque", String(Object.keys(m(o).data ?? {}).length), age(o.createdAt)] },
        ServiceAccount: { head: ["NAME", "SECRETS", "AGE"], cells: (o) => [o.name, "0", age(o.createdAt)] },
        Job: { head: ["NAME", "STATUS", "COMPLETIONS", "DURATION", "AGE"], cells: (o) => { const c = jobCompletions(sh, o); return [o.name, c.done >= c.total ? "Complete" : "Running", `${c.done}/${c.total}`, c.done >= c.total ? "5s" : age(o.createdAt), age(o.createdAt)]; } },
        CronJob: { head: ["NAME", "SCHEDULE", "TIMEZONE", "SUSPEND", "ACTIVE", "LAST SCHEDULE", "AGE"], cells: (o) => [o.name, m(o).spec?.schedule ?? "", "<none>", String(!!m(o).spec?.suspend), "0", "<none>", age(o.createdAt)] },
        Role: { head: ["NAME", "CREATED AT"], cells: (o) => [o.name, new Date(o.createdAt).toISOString().replace(/\.\d+Z/, "Z")] },
        ClusterRole: { head: ["NAME", "CREATED AT"], cells: (o) => [o.name, new Date(o.createdAt).toISOString().replace(/\.\d+Z/, "Z")] },
        RoleBinding: { head: ["NAME", "ROLE", "AGE"], cells: (o) => [o.name, `${m(o).roleRef?.kind}/${m(o).roleRef?.name}`, age(o.createdAt)] },
        ClusterRoleBinding: { head: ["NAME", "ROLE", "AGE"], cells: (o) => [o.name, `ClusterRole/${m(o).roleRef?.name}`, age(o.createdAt)] },
        NetworkPolicy: { head: ["NAME", "POD-SELECTOR", "AGE"], cells: (o) => [o.name, Object.keys(m(o).spec?.podSelector?.matchLabels ?? {}).length ? labelsStr(m(o).spec.podSelector.matchLabels) : "<none>", age(o.createdAt)] },
        PersistentVolume: {
          head: ["NAME", "CAPACITY", "ACCESS MODES", "RECLAIM POLICY", "STATUS", "CLAIM", "STORAGECLASS", "VOLUMEATTRIBUTESCLASS", "REASON", "AGE"],
          cells: (o) => {
            const claim = objsOf(sh, "PersistentVolumeClaim", null).find((c) => pvcStatus(sh, c.name, c.namespace).volume === o.name);
            return [o.name, m(o).spec?.capacity?.storage ?? "", (m(o).spec?.accessModes ?? []).map((a: string) => a.replace("ReadWriteOnce", "RWO").replace("ReadOnlyMany", "ROX").replace("ReadWriteMany", "RWX")).join(","), m(o).spec?.persistentVolumeReclaimPolicy ?? "Retain", claim ? "Bound" : "Available", claim ? `${claim.namespace}/${claim.name}` : "", m(o).spec?.storageClassName ?? "", "<unset>", "", age(o.createdAt)];
          },
        },
        PersistentVolumeClaim: {
          head: ["NAME", "STATUS", "VOLUME", "CAPACITY", "ACCESS MODES", "STORAGECLASS", "VOLUMEATTRIBUTESCLASS", "AGE"],
          cells: (o) => {
            const st = pvcStatus(sh, o.name, o.namespace);
            const pv = st.volume ? findObj(sh, "PersistentVolume", st.volume) : undefined;
            return [o.name, st.status, st.volume ?? "", st.status === "Bound" ? pv?.manifest.spec?.capacity?.storage ?? m(o).spec?.resources?.requests?.storage : "", st.status === "Bound" ? (m(o).spec?.accessModes ?? []).map((a: string) => a.replace("ReadWriteOnce", "RWO").replace("ReadWriteMany", "RWX")).join(",") : "", m(o).spec?.storageClassName ?? "", "<unset>", age(o.createdAt)];
          },
        },
        StorageClass: { head: ["NAME", "PROVISIONER", "RECLAIMPOLICY", "VOLUMEBINDINGMODE", "ALLOWVOLUMEEXPANSION", "AGE"], cells: (o) => [o.name === "standard" ? "standard (default)" : o.name, m(o).provisioner ?? "", m(o).reclaimPolicy ?? "Delete", m(o).volumeBindingMode ?? "Immediate", String(!!m(o).allowVolumeExpansion), age(o.createdAt)] },
        Ingress: { head: ["NAME", "CLASS", "HOSTS", "ADDRESS", "PORTS", "AGE"], cells: (o) => [o.name, m(o).spec?.ingressClassName ?? "<none>", (m(o).spec?.rules ?? []).map((r: Json) => r.host ?? "*").join(",") || "*", "", "80", age(o.createdAt)] },
        HorizontalPodAutoscaler: { head: ["NAME", "REFERENCE", "TARGETS", "MINPODS", "MAXPODS", "REPLICAS", "AGE"], cells: (o) => [o.name, `Deployment/${m(o).spec?.scaleTargetRef?.name}`, `cpu: 12%/${m(o).spec?.metrics?.[0]?.resource?.target?.averageUtilization ?? 80}%`, String(m(o).spec?.minReplicas ?? 1), String(m(o).spec?.maxReplicas ?? 1), String(findDeployment(sh, m(o).spec?.scaleTargetRef?.name, o.namespace)?.replicas ?? 0), age(o.createdAt)] },
        ResourceQuota: { head: ["NAME", "AGE", "REQUEST", "LIMIT"], cells: (o) => [o.name, age(o.createdAt), Object.entries(m(o).spec?.hard ?? {}).map(([k, v]) => `${k}: 0/${v}`).join(", "), ""] },
      };
      const c = cols[kind] ?? { head: ["NAME", "AGE"], cells: (o: K8sObject) => [o.name, age(o.createdAt)] };
      return { head: c.head, rows: objs.map((o) => ({ ns: o.namespace, labels: o.manifest.metadata?.labels, manifest: objectManifest(sh, o), cells: c.cells(o) })) };
    }
  }
};

// ---------- events ----------
const podEvents = (sh: Shell, p: Pod): [string, string, string, string, string][] => {
  const a = age(p.scheduledAt ?? p.createdAt);
  const st = podStatus(sh, p);
  const c = p.spec.containers[0];
  if (!p.node) {
    if (!schedulerHealthy(sh) && !p.spec.nodeName) return [];
    return [["Warning", "FailedScheduling", age(p.createdAt), "default-scheduler", unschedulableReasons(sh, p)]];
  }
  const ev: [string, string, string, string, string][] = [["Normal", "Scheduled", a, "default-scheduler", `Successfully assigned ${p.namespace}/${p.name} to ${p.node}`]];
  const bad = p.spec.containers.find((x) => !validImage(x.image));
  if (bad) {
    ev.push(["Normal", "Pulling", a, "kubelet", `Pulling image "${bad.image}"`]);
    ev.push(["Warning", "Failed", a, "kubelet", `Failed to pull image "${bad.image}": rpc error: code = NotFound desc = failed to pull and unpack image "docker.io/library/${bad.image}": failed to resolve reference "docker.io/library/${bad.image}": not found`]);
    ev.push(["Warning", "Failed", a, "kubelet", "Error: ErrImagePull"]);
    ev.push(["Normal", "BackOff", a, "kubelet", `Back-off pulling image "${bad.image}"`]);
    ev.push(["Warning", "Failed", a, "kubelet", "Error: ImagePullBackOff"]);
    return ev;
  }
  const problem = podEventsProblem(sh, p);
  if (problem && st === "ContainerCreating") {
    ev.push(["Warning", "FailedMount", a, "kubelet", `MountVolume.SetUp failed for volume "${p.spec.volumes?.[0]?.name}" : ${problem}`]);
    return ev;
  }
  ev.push(["Normal", "Pulled", a, "kubelet", `Container image "${c.image}" already present on machine`]);
  if (problem) {
    ev.push(["Warning", "Failed", a, "kubelet", `Error: ${problem}`]);
    return ev;
  }
  for (const x of p.spec.containers) {
    ev.push(["Normal", "Created", a, "kubelet", `Created container ${x.name}`]);
    ev.push(["Normal", "Started", a, "kubelet", `Started container ${x.name}`]);
  }
  if (st === "CrashLoopBackOff" || st === "Error") ev.push(["Warning", "BackOff", a, "kubelet", `Back-off restarting failed container ${c.name} in pod ${p.name}_${p.namespace}`]);
  for (const x of p.spec.containers) {
    const r = probeResult(x, x.readinessProbe);
    if (!r.ok) ev.push(["Warning", "Unhealthy", a, "kubelet", `Readiness probe failed: ${r.reason}`]);
    const l = probeResult(x, x.livenessProbe);
    if (!l.ok) {
      ev.push(["Warning", "Unhealthy", a, "kubelet", `Liveness probe failed: ${l.reason}`]);
      ev.push(["Normal", "Killing", a, "kubelet", `Container ${x.name} failed liveness probe, will be restarted`]);
    }
  }
  return ev;
};

const eventsBlock = (ev: [string, string, string, string, string][]) =>
  ev.length
    ? ["Events:", table([["  Type", "Reason", "Age", "From", "Message"], ["  ----", "------", "----", "----", "-------"], ...ev.map((e) => ["  " + e[0], e[1], e[2], e[3], e[4]])])].join("\n")
    : "Events:                      <none>";

// ---------- describe ----------
const describePod = (sh: Shell, p: Pod) => {
  const st = podStatus(sh, p);
  const cBlock = (c: Container) => {
    const r = probeResult(c, c.readinessProbe);
    const lines = [
      `  ${c.name}:`,
      `    Image:          ${c.image}`,
      ...(c.ports?.length ? [`    Port:           ${c.ports[0].containerPort}/TCP`] : []),
      ...(c.command ? [`    Command:\n${c.command.map((x) => `      ${x}`).join("\n")}`] : []),
      ...(c.args ? [`    Args:\n${c.args.map((x) => `      ${x}`).join("\n")}`] : []),
      `    State:          ${st === "Running" ? "Running" : st === "Completed" ? "Terminated" : "Waiting"}`,
      ...(st !== "Running" && st !== "Completed" ? [`      Reason:       ${st}`] : []),
      `    Ready:          ${containerReady(sh, p, c) ? "True" : "False"}`,
      `    Restart Count:  ${podRestarts(sh, p)}`,
      ...(c.resources?.limits ? [`    Limits:\n${Object.entries(c.resources.limits).map(([k, v]) => `      ${k}:     ${v}`).join("\n")}`] : []),
      ...(c.resources?.requests ? [`    Requests:\n${Object.entries(c.resources.requests).map(([k, v]) => `      ${k}:     ${v}`).join("\n")}`] : []),
      ...(c.livenessProbe ? [`    Liveness:       ${probeDesc(c.livenessProbe)}`] : []),
      ...(c.readinessProbe ? [`    Readiness:      ${probeDesc(c.readinessProbe)}${r.ok ? "" : ""}`] : []),
      `    Environment:${c.env?.length || c.envFrom?.length ? "" : "    <none>"}`,
      ...(c.envFrom ?? []).map((e) => `      ${e.configMapRef ? `ConfigMap  ${e.configMapRef.name}` : `Secret  ${e.secretRef?.name}`}  Optional: false`),
      ...(c.env ?? []).map((e) => `      ${e.name}:  ${e.value ?? `<set to the key '${(e.valueFrom as Json)?.configMapKeyRef?.key ?? (e.valueFrom as Json)?.secretKeyRef?.key}' of ${(e.valueFrom as Json)?.configMapKeyRef ? "config map" : "secret"} '${(e.valueFrom as Json)?.configMapKeyRef?.name ?? (e.valueFrom as Json)?.secretKeyRef?.name}'>`}`),
      `    Mounts:${c.volumeMounts?.length ? "" : "         <none>"}`,
      ...(c.volumeMounts ?? []).map((m) => `      ${m.mountPath} from ${m.name}`),
    ];
    return lines.join("\n");
  };
  const node = sh.state.nodes.find((n) => n.name === p.node);
  return [
    `Name:             ${p.name}`,
    `Namespace:        ${p.namespace}`,
    `Priority:         0`,
    `Service Account:  ${p.spec.serviceAccountName ?? "default"}`,
    `Node:             ${p.node ? `${p.node}/${node?.ip}` : "<none>"}`,
    `Labels:           ${labelsStr(p.labels)}`,
    `Status:           ${st === "Running" ? "Running" : st === "Completed" ? "Succeeded" : st === "Error" ? "Failed" : "Pending"}`,
    `IP:               ${st === "Running" ? p.ip : ""}`,
    ...(p.ownerKind === "Deployment" ? [`Controlled By:    ReplicaSet/${p.owner}-${p.labels["pod-template-hash"]}`] : p.ownerKind === "Job" ? [`Controlled By:    Job/${p.owner}`] : []),
    ...(p.spec.initContainers?.length ? ["Init Containers:", ...p.spec.initContainers.map(cBlock)] : []),
    "Containers:",
    ...p.spec.containers.map(cBlock),
    "Conditions:",
    "  Type              Status",
    `  PodScheduled      ${p.node ? "True" : "False"}`,
    `  Ready             ${podReady(sh, p) ? "True" : "False"}`,
    ...(p.spec.volumes?.length ? ["Volumes:", ...p.spec.volumes.map((v) => `  ${v.name}:\n    Type:  ${v.configMap ? `ConfigMap\n    Name:  ${v.configMap.name}` : v.secret ? `Secret\n    SecretName:  ${v.secret.secretName}` : v.persistentVolumeClaim ? `PersistentVolumeClaim\n    ClaimName:  ${v.persistentVolumeClaim.claimName}` : "EmptyDir"}`)] : []),
    `QoS Class:        ${p.spec.containers.every((c) => c.resources?.limits && c.resources?.requests) ? "Guaranteed" : p.spec.containers.some((c) => c.resources?.limits || c.resources?.requests) ? "Burstable" : "BestEffort"}`,
    `Node-Selectors:   ${p.spec.nodeSelector ? labelsStr(p.spec.nodeSelector) : "<none>"}`,
    `Tolerations:      ${(p.spec.tolerations ?? []).map((t) => `${t.key ?? ""}${t.operator === "Exists" ? " op=Exists" : `=${t.value ?? ""}`}:${t.effect ?? ""}`).join("\n                  ") || "node.kubernetes.io/not-ready:NoExecute op=Exists for 300s"}`,
    eventsBlock(podEvents(sh, p)),
  ].join("\n");
};

const probeDesc = (pr: NonNullable<Container["readinessProbe"]>) =>
  pr.httpGet ? `http-get http://:${pr.httpGet.port}${pr.httpGet.path ?? "/"} delay=${pr.initialDelaySeconds ?? 0}s period=${pr.periodSeconds ?? 10}s` : pr.tcpSocket ? `tcp-socket :${pr.tcpSocket.port} delay=${pr.initialDelaySeconds ?? 0}s` : `exec [${pr.exec?.command.join(" ")}] delay=${pr.initialDelaySeconds ?? 0}s`;

const describe = (sh: Shell, kind: string, name: string | undefined, ns: string): string => {
  if (kind === "Node") {
    const nodes = name ? sh.state.nodes.filter((n) => n.name === name) : sh.state.nodes;
    if (!nodes.length) return notFound("Node", name!);
    return nodes.map((n) => {
      const ready = nodeReady(sh, n.name);
      const pods = sh.state.pods.filter((p) => p.node === n.name);
      return [
        `Name:               ${n.name}`,
        `Roles:              ${n.role === "control-plane" ? "control-plane" : "<none>"}`,
        `Labels:             ${Object.entries(n.labels).map(([k, v]) => `${k}=${v}`).join("\n                    ")}`,
        `CreationTimestamp:  ${new Date(NODE_AGE).toUTCString()}`,
        `Taints:             ${n.taints.map((t) => `${t.key}${t.value ? "=" + t.value : ""}:${t.effect}`).join("\n                    ") || "<none>"}${!ready ? "\n                    node.kubernetes.io/unreachable:NoSchedule" : ""}`,
        `Unschedulable:      ${!n.schedulable}`,
        "Conditions:",
        "  Type             Status    Reason                       Message",
        "  ----             ------    ------                       -------",
        ...(ready
          ? [
              "  MemoryPressure   False     KubeletHasSufficientMemory   kubelet has sufficient memory available",
              "  DiskPressure     False     KubeletHasNoDiskPressure     kubelet has no disk pressure",
              "  PIDPressure      False     KubeletHasSufficientPID      kubelet has sufficient PID available",
              "  Ready            True      KubeletReady                 kubelet is posting ready status",
            ]
          : ["  MemoryPressure   Unknown   NodeStatusUnknown            Kubelet stopped posting node status.", "  Ready            Unknown   NodeStatusUnknown            Kubelet stopped posting node status."]),
        "Addresses:",
        `  InternalIP:  ${n.ip}`,
        `  Hostname:    ${n.name}`,
        "Capacity:",
        "  cpu:     4",
        "  memory:  8131016Ki",
        "  pods:    110",
        "System Info:",
        "  Kernel Version:             6.8.0-45-generic",
        "  Container Runtime Version:  containerd://1.7.18",
        `  Kubelet Version:            ${n.version}`,
        `Non-terminated Pods:          (${pods.length} in total)`,
        ...pods.slice(0, 8).map((p) => `  ${p.namespace.padEnd(12)} ${p.name}`),
        "Events:              <none>",
      ].join("\n");
    }).join("\n\n");
  }
  if (kind === "Pod") {
    const pods = name ? sh.state.pods.filter((p) => p.name === name && p.namespace === ns) : sh.state.pods.filter((p) => p.namespace === ns);
    if (!pods.length) return name ? notFound("Pod", name) : `No resources found in ${ns} namespace.`;
    return pods.map((p) => describePod(sh, p)).join("\n\n");
  }
  if (kind === "Deployment") {
    const d = findDeployment(sh, name ?? "", ns);
    if (!d) return notFound("Deployment", name ?? "");
    const pods = podsOfDeployment(sh, d);
    const ready = pods.filter((p) => podReady(sh, p)).length;
    return [
      `Name:                   ${d.name}`,
      `Namespace:              ${d.namespace}`,
      `Labels:                 ${labelsStr(d.labels)}`,
      `Annotations:            deployment.kubernetes.io/revision: ${d.revision}`,
      `Selector:               ${labelsStr(d.selector)}`,
      `Replicas:               ${d.replicas} desired | ${pods.length} updated | ${pods.length} total | ${ready} available | ${Math.max(0, d.replicas - ready)} unavailable`,
      "StrategyType:           RollingUpdate",
      "RollingUpdateStrategy:  25% max unavailable, 25% max surge",
      "Pod Template:",
      `  Labels:  ${labelsStr(d.template.labels)}`,
      "  Containers:",
      ...d.template.spec.containers.map((c) => [`   ${c.name}:`, `    Image:      ${c.image}`, ...(c.resources?.limits ? [`    Limits:     ${Object.entries(c.resources.limits).map(([k, v]) => `${k}=${v}`).join(", ")}`] : []), ...(c.readinessProbe ? [`    Readiness:  ${probeDesc(c.readinessProbe)}`] : [])].join("\n")),
      "Conditions:",
      "  Type           Status  Reason",
      "  ----           ------  ------",
      `  Available      ${ready >= d.replicas ? "True " : "False"}   ${ready >= d.replicas ? "MinimumReplicasAvailable" : "MinimumReplicasUnavailable"}`,
      `  Progressing    True    ${pods.every((p) => validImage(p.image)) ? "NewReplicaSetAvailable" : "ReplicaSetUpdated"}`,
      `NewReplicaSet:   ${d.name}-${pods[0]?.labels["pod-template-hash"] ?? "…"} (${pods.length}/${d.replicas} replicas created)`,
      "Events:",
      `  Normal  ScalingReplicaSet  ${age(d.createdAt)}  deployment-controller  Scaled up replica set ${d.name}-${pods[0]?.labels["pod-template-hash"] ?? ""} to ${d.replicas}`,
    ].join("\n");
  }
  if (kind === "Service") {
    const s = findService(sh, name ?? "", ns);
    if (!s) return notFound("Service", name ?? "");
    const eps = endpoints(sh, s);
    return [
      `Name:                     ${s.name}`,
      `Namespace:                ${s.namespace}`,
      `Selector:                 ${labelsStr(s.selector)}`,
      `Type:                     ${s.type}`,
      `IP:                       ${s.clusterIP}`,
      `Port:                     <unset>  ${s.port}/TCP`,
      `TargetPort:               ${s.targetPort}/TCP`,
      ...(s.nodePort ? [`NodePort:                 <unset>  ${s.nodePort}/TCP`] : []),
      `Endpoints:                ${eps.map((p) => `${p.ip}:${s.targetPort}`).join(",") || "<none>"}`,
      "Session Affinity:         None",
      "Events:                   <none>",
    ].join("\n");
  }
  const objKind = kind;
  const o = findObj(sh, objKind, name ?? "", ns) ?? virtualObjects(sh, objKind, ns).find((x) => x.name === name);
  if (!o) return notFound(objKind, name ?? "");
  const m = o.manifest;
  const head = [`Name:         ${o.name}`, ...(o.namespace ? [`Namespace:    ${o.namespace}`] : []), `Labels:       ${labelsStr(m.metadata?.labels ?? {})}`];
  switch (objKind) {
    case "ConfigMap":
      return [...head, "", "Data", "====", ...Object.entries(m.data ?? {}).flatMap(([k, v]) => [`${k}:`, "----", String(v), ""]), "Events:  <none>"].join("\n");
    case "Secret":
      return [...head, "", `Type:  ${m.type ?? "Opaque"}`, "", "Data", "====", ...Object.entries(m.data ?? {}).map(([k, v]) => `${k}:  ${secretVal(String(v)).length} bytes`)].join("\n");
    case "PersistentVolumeClaim": {
      const st = pvcStatus(sh, o.name, o.namespace);
      return [...head, `StorageClass:  ${m.spec?.storageClassName ?? ""}`, `Status:        ${st.status}`, `Volume:        ${st.volume ?? ""}`, `Capacity:      ${m.spec?.resources?.requests?.storage ?? ""}`, `Access Modes:  ${(m.spec?.accessModes ?? []).join(",")}`, st.status === "Pending" ? `Events:\n  Type     Reason         Age  From                         Message\n  ----     ------         ---  ----                         -------\n  Normal   FailedBinding  5s   persistentvolume-controller  ${st.reason}` : "Events:        <none>"].join("\n");
    }
    case "NetworkPolicy": {
      const spec = m.spec ?? {};
      return [
        ...head,
        "Spec:",
        `  PodSelector:     ${Object.keys(spec.podSelector?.matchLabels ?? {}).length ? labelsStr(spec.podSelector.matchLabels) : "<none> (Allowing the specific traffic to all pods in this namespace)"}`,
        "  Allowing ingress traffic:",
        ...((spec.ingress ?? []).length
          ? spec.ingress.flatMap((r: Json) => [
              `    To Port: ${(r.ports ?? []).map((p: Json) => `${p.port}/${p.protocol ?? "TCP"}`).join(", ") || "<any> (traffic allowed to all ports)"}`,
              "    From:",
              ...((r.from ?? []).length ? r.from.map((f: Json) => `      ${f.podSelector ? `PodSelector: ${labelsStr(f.podSelector.matchLabels ?? {})}` : ""}${f.namespaceSelector ? ` NamespaceSelector: ${labelsStr(f.namespaceSelector.matchLabels ?? {})}` : ""}`) : ["      <any> (traffic not restricted by source)"]),
            ])
          : ["    <none> (Selected pods are isolated for ingress connectivity)"]),
        `  Policy Types: ${(spec.policyTypes ?? ["Ingress"]).join(", ")}`,
      ].join("\n");
    }
    case "Role":
    case "ClusterRole":
      return [...head, "PolicyRule:", "  Resources  Non-Resource URLs  Resource Names  Verbs", "  ---------  -----------------  --------------  -----", ...(m.rules ?? []).map((r: Json) => `  ${(r.resources ?? []).join(",").padEnd(10)} []                 []              [${(r.verbs ?? []).join(" ")}]`)].join("\n");
    case "RoleBinding":
    case "ClusterRoleBinding":
      return [...head, "Role:", `  Kind:  ${m.roleRef?.kind}`, `  Name:  ${m.roleRef?.name}`, "Subjects:", "  Kind            Name     Namespace", "  ----            ----     ---------", ...(m.subjects ?? []).map((s: Json) => `  ${s.kind.padEnd(15)} ${s.name.padEnd(8)} ${s.namespace ?? ""}`)].join("\n");
    default:
      return [...head, YAML.stringify({ Spec: m.spec ?? m.data ?? {} })].join("\n");
  }
};

// ---------- subcommands ----------
const SUB_DESC: Record<string, string> = {
  get: "lista recursos em formato de tabela (visão resumida)",
  describe: "mostra todos os detalhes do recurso, incluindo a seção Events — o melhor amigo do troubleshooting",
  run: "cria um Pod avulso a partir de uma imagem (sem Deployment por trás)",
  create: "cria um recurso de forma imperativa",
  apply: "aplica um manifesto YAML de forma declarativa (cria ou atualiza)",
  replace: "substitui o recurso pelo manifesto (com --force, apaga e recria)",
  edit: "abre o recurso no editor e aplica as mudanças ao salvar",
  delete: "remove um recurso do cluster",
  scale: "altera o número de réplicas desejadas",
  autoscale: "cria um HorizontalPodAutoscaler",
  expose: "cria um Service apontando para os Pods do recurso",
  set: "altera um campo de um recurso existente (image, env, resources…)",
  rollout: "gerencia o ciclo de vida de atualizações de um Deployment",
  logs: "mostra o stdout/stderr do container",
  exec: "executa um comando dentro de um container",
  label: "adiciona/altera/remove labels",
  annotate: "adiciona/altera anotações",
  taint: "adiciona/remove taints em nós",
  cordon: "marca o nó como não-agendável",
  uncordon: "volta a permitir agendamento no nó",
  drain: "esvazia o nó (cordon + eviction dos Pods) para manutenção",
  top: "mostra consumo de CPU/memória (requer metrics-server)",
  auth: "verifica permissões RBAC (auth can-i)",
  "port-forward": "encaminha uma porta local para um Pod/Service",
  version: "mostra a versão do cliente kubectl e do API server",
  "cluster-info": "mostra os endereços do control plane e dos serviços do sistema",
  config: "lê/altera o kubeconfig (~/.kube/config)",
  explain: "documentação dos campos de um recurso",
  "api-resources": "lista os tipos de recurso e suas abreviações",
};

const FLAG_DESC: Record<string, string> = {
  "-o": "formato de saída (wide, yaml, json, name, jsonpath=…)",
  "--output": "formato de saída",
  "-n": "namespace alvo",
  "--namespace": "namespace alvo",
  "-A": "todos os namespaces",
  "--all-namespaces": "todos os namespaces",
  "-l": "filtra por label (ex.: app=web)",
  "--selector": "filtra por label",
  "-f": "arquivo de manifesto",
  "--image": "imagem do container",
  "--replicas": "quantidade de Pods desejada",
  "--port": "porta do container/Service",
  "--target-port": "porta do container para onde o tráfego vai",
  "--type": "tipo do Service (ClusterIP, NodePort, LoadBalancer)",
  "--dry-run": "não cria nada; com -o yaml gera o manifesto (ótimo para a prova!)",
  "--from-literal": "chave=valor para ConfigMap/Secret",
  "--show-labels": "mostra a coluna de labels",
  "--ignore-daemonsets": "ignora Pods de DaemonSet no drain",
  "--delete-emptydir-data": "permite despejar Pods com volumes emptyDir",
  "--force": "força a operação (Pods sem controller no drain; recria no replace)",
  "--previous": "logs da execução anterior do container (útil em CrashLoopBackOff)",
  "-c": "container alvo (Pods com vários containers)",
  "--as": "impersona um usuário/ServiceAccount (auth can-i)",
  "--restart": "Never cria um Pod; OnFailure um Job",
  "--schedule": "expressão cron do CronJob",
  "--verb": "verbos da Role (get,list,watch…)",
  "--resource": "recursos da Role (pods, deployments…)",
  "--role": "Role referenciada pelo RoleBinding",
  "--clusterrole": "ClusterRole referenciada pelo binding",
  "--user": "usuário do binding",
  "--serviceaccount": "ServiceAccount do binding (namespace:nome)",
  "--limits": "limites de CPU/memória",
  "--requests": "requisições de CPU/memória",
  "--overwrite": "sobrescreve label existente",
  "--rm": "remove o Pod ao final (Pod temporário de teste)",
  "-it": "modo interativo com TTY",
  "--labels": "labels do Pod",
  "--env": "variável de ambiente",
  "--min": "mínimo de réplicas (HPA)",
  "--max": "máximo de réplicas (HPA)",
  "--cpu-percent": "alvo de uso de CPU (HPA)",
  "--to-revision": "revisão alvo do rollback",
  "--record": "registra o comando no histórico (depreciado)",
  "--current": "o contexto atual",
  "--tail": "últimas N linhas do log",
};

const VALUE_FLAGS = ["-o", "-n", "-l", "-f", "-c", "--image", "--replicas", "--port", "--type", "--target-port", "--name", "--namespace", "--output", "--selector", "--schedule", "--role", "--clusterrole", "--user", "--serviceaccount", "--limits", "--requests", "--as", "--restart", "--labels", "--min", "--max", "--cpu-percent", "--to-revision", "--tail", "--verb", "--resource", "--from", "--dry-run", "--container", "--hard", "--tcp", "--rule", "--class", "--grace-period", "--timeout", "--field-selector", "--sort-by", "--context", "--cluster"];


const run = (ctx: ToolCtx): ToolResult => {
  const { sh, flags, pos, rest, args } = ctx;
  const kc = ctxState(sh);
  const ns = flagStr(flags, "n", "namespace") ?? kc.ns;
  const allNs = !!(flags.A || flags["all-namespaces"]);
  const output = flagStr(flags, "o", "output");
  const dryRun = typeof flags["dry-run"] === "string" || flags["dry-run"] === true;
  const [sub, ...p] = pos;
  if (ns !== kc.ns && !nsExists(sh, ns) && !["create", "config", "version", "cluster-info", "api-resources", "explain"].includes(sub ?? "") && !(sub === "get" && (p[0] === "ns" || p[0] === "namespaces")))
    return `Error from server (NotFound): namespaces "${ns}" not found`;

  switch (sub) {
    case undefined:
    case "help":
      return `kubectl controls the Kubernetes cluster manager.\n\nBasic Commands:\n${Object.entries(SUB_DESC).map(([s, d]) => `  ${s.padEnd(14)} ${d}`).join("\n")}`;
    case "cluster-info":
      return "Kubernetes control plane is running at https://127.0.0.1:6443\nCoreDNS is running at https://127.0.0.1:6443/api/v1/namespaces/kube-system/services/kube-dns:dns/proxy\n\nTo further debug and diagnose cluster problems, use 'kubectl cluster-info dump'.";
    case "version": {
      const client = `v${sh.hostOf().packages.kubectl?.split("-")[0] ?? "1.30.2"}`;
      if (flags.client) return `Client Version: ${client}\nKustomize Version: v5.0.4-0.20230601165947-6ce0bf390ce3`;
      return `Client Version: ${client}\nKustomize Version: v5.0.4-0.20230601165947-6ce0bf390ce3\nServer Version: ${controlPlaneVersion(sh)}`;
    }
    case "api-resources":
      return table([["NAME", "SHORTNAMES", "KIND"], ...RESOURCES.filter((r) => r.kind !== "All").map((r) => [r.names[0], r.short ?? "", r.kind])]);
    case "explain": {
      const path = (p[0] ?? "").toLowerCase();
      const docs: Record<string, string> = {
        pod: "Pod is a collection of containers that can run on a host.",
        "pod.spec.containers": "List of containers belonging to the pod. Fields: name, image, command, args, ports, env, envFrom, resources, readinessProbe, livenessProbe, volumeMounts, securityContext",
        "pod.spec.containers.readinessprobe": "Periodic probe of container service readiness. Container will be removed from service endpoints if the probe fails. Fields: httpGet, tcpSocket, exec, initialDelaySeconds, periodSeconds",
        "pod.spec.containers.livenessprobe": "Periodic probe of container liveness. Container will be restarted if the probe fails.",
        "pod.spec.tolerations": "If specified, the pod's tolerations. Fields: key, operator (Exists|Equal), value, effect",
        "networkpolicy.spec": "Fields: podSelector, policyTypes, ingress (from, ports), egress (to, ports)",
      };
      return `KIND:       ${path.split(".")[0] || "?"}\n\nDESCRIPTION:\n    ${docs[path] ?? "Consulte https://kubernetes.io/docs/reference/ — no exame você pode usar a documentação oficial."}`;
    }
    case "config": {
      const [action] = p;
      if (action === "current-context") return "kind-lab";
      if (action === "get-contexts") return table([["CURRENT", "NAME", "CLUSTER", "AUTHINFO", "NAMESPACE"], ["*", "kind-lab", "kind-lab", "kind-lab", kc.ns === "default" ? "" : kc.ns]]);
      if (action === "use-context") return p[1] === "kind-lab" ? `Switched to context "kind-lab".` : `error: no context exists with the name: "${p[1]}"`;
      if (action === "set-context") {
        const n = flagStr(flags, "namespace");
        if (n) kc.ns = n;
        return `Context "kind-lab" modified.`;
      }
      if (action === "view") return "apiVersion: v1\nclusters:\n- cluster:\n    certificate-authority-data: DATA+OMITTED\n    server: https://127.0.0.1:6443\n  name: kind-lab\ncontexts:\n- context:\n    cluster: kind-lab\n    user: kind-lab\n  name: kind-lab\ncurrent-context: kind-lab\nkind: Config";
      return `error: unknown command "${action}" for "kubectl config"`;
    }
    case "get":
      return get(sh, p, flags, ns, allNs, output);
    case "describe": {
      const [kindWord, name] = p[0]?.includes("/") ? p[0].split("/") : [p[0], p[1]];
      const kind = kindOf(kindWord);
      if (!kind) return kindWord ? `error: the server doesn't have a resource type "${kindWord}"` : "error: You must specify the type of resource to describe.";
      return describe(sh, kind, name, ns);
    }
    case "run":
      return runPod(sh, p, flags, rest, args, ns, dryRun, output);
    case "create":
      return create(sh, p, flags, rest, args, ns, dryRun, output);
    case "apply":
    case "replace": {
      const mode = sub === "apply" ? "apply" : flags.force ? "replace" : "apply";
      return applyFiles(sh, flags, ns, mode, ctx.stdin);
    }
    case "edit":
      return edit(sh, p, ns);
    case "delete":
      return del(sh, p, flags, ns);
    case "scale": {
      const [kind, name] = ref(p);
      const n = Number(flags.replicas);
      if (Number.isNaN(n)) return "error: --replicas=COUNT is required, and COUNT must be greater than or equal to 0";
      if (kind !== "Deployment") return `error: this lab supports scaling deployments`;
      const d = findDeployment(sh, name ?? "", ns);
      if (!d) return notFound("Deployment", name ?? "");
      d.replicas = n;
      reconcile(sh);
      return `deployment.apps/${name} scaled`;
    }
    case "autoscale": {
      const [kind, name] = ref(p);
      const d = kind === "Deployment" ? findDeployment(sh, name ?? "", ns) : undefined;
      if (!d) return notFound("Deployment", name ?? "");
      const max = Number(flags.max);
      if (!max) return "error: --max=MAXPODS is required and must be at least 1";
      upsertObj(sh, { kind: "HorizontalPodAutoscaler", name: d.name, namespace: ns, manifest: { spec: { scaleTargetRef: { apiVersion: "apps/v1", kind: "Deployment", name: d.name }, minReplicas: Number(flags.min ?? 1), maxReplicas: max, metrics: [{ type: "Resource", resource: { name: "cpu", target: { type: "Utilization", averageUtilization: Number(flags["cpu-percent"] ?? 80) } } }] } } });
      return `horizontalpodautoscaler.autoscaling/${d.name} autoscaled`;
    }
    case "expose":
      return expose(sh, p, flags, ns, dryRun, output);
    case "set":
      return setCmd(sh, p, flags, args, ns);
    case "rollout":
      return rollout(sh, p, flags, ns);
    case "logs": {
      let target = p[0];
      if (!target) return "error: expected 'logs [-f] [-p] (POD | TYPE/NAME) [-c CONTAINER]'.";
      let pod: Pod | undefined;
      if (target.includes("/")) {
        const [kw, name] = target.split("/");
        const kind = kindOf(kw);
        pod = sh.state.pods.find((x) => x.namespace === ns && ((kind === "Deployment" && x.ownerKind === "Deployment" && x.owner === name) || (kind === "Job" && x.ownerKind === "Job" && x.owner === name) || (kind === "Pod" && x.name === name)));
        if (!pod) return `error: ${kind === "Deployment" ? "deployments.apps" : pluralOf(kind ?? "Pod")} "${name}" not found`;
        target = pod.name;
      } else if (typeof flags.l === "string") {
        const sel = parseSelector(flags.l);
        const pods = sh.state.pods.filter((x) => x.namespace === ns && sel(x.labels));
        return pods.map((x) => podLogs(sh, x, x.spec.containers[0], false)).join("\n");
      }
      pod ??= findPod(sh, target, ns);
      if (!pod) return `error: pods "${target}" not found`;
      const cname = flagStr(flags, "c", "container");
      if (!cname && pod.spec.containers.length > 1)
        return `Defaulted container "${pod.spec.containers[0].name}" out of: ${pod.spec.containers.map((c) => c.name).join(", ")}\n${podLogs(sh, pod, pod.spec.containers[0], !!(flags.previous || flags.p))}`;
      const c = cname ? pod.spec.containers.find((x) => x.name === cname) : pod.spec.containers[0];
      if (!c) return `error: container ${cname} is not valid for pod ${pod.name}`;
      const out = podLogs(sh, pod, c, !!(flags.previous || flags.p));
      const tail = Number(flags.tail);
      return tail ? out.split("\n").slice(-tail).join("\n") : out;
    }
    case "exec": {
      let target = p[0];
      if (!target) return "error: expected 'exec (POD | TYPE/NAME) [-c CONTAINER] [flags] -- COMMAND [args...]'";
      if (target.includes("/")) {
        const [, name] = target.split("/");
        target = sh.state.pods.find((x) => x.namespace === ns && (x.name === name || x.owner === name))?.name ?? name;
      }
      const pod = findPod(sh, target, ns);
      if (!pod) return `Error from server (NotFound): pods "${target}" not found`;
      const cname = flagStr(flags, "c", "container");
      const c = cname ? pod.spec.containers.find((x) => x.name === cname) : pod.spec.containers[0];
      if (!c) return `error: container ${cname} not found in pod ${pod.name}`;
      if (podStatus(sh, pod) !== "Running") return `error: unable to upgrade connection: container not found ("${c.name}")`;
      const argv = rest.length ? rest : p.slice(1);
      if (!rest.length && argv.length) return `error: exec [POD] [COMMAND] is not supported anymore. Use exec [POD] -- [COMMAND] instead`;
      return podExec(sh, pod, c, argv);
    }
    case "label":
    case "annotate": {
      const [kind, name, ...kvs] = p[0]?.includes("/") ? [kindOf(p[0].split("/")[0]), p[0].split("/")[1], ...p.slice(1)] : [kindOf(p[0]), p[1], ...p.slice(2)];
      if (!kind) return `error: the server doesn't have a resource type "${p[0]}"`;
      const target = labelTarget(sh, kind, name ?? "", ns, sub === "annotate");
      if (!target) return notFound(kind, name ?? "");
      for (const kv of kvs) {
        if (kv.endsWith("-")) delete target[kv.slice(0, -1)];
        else {
          const [key, val] = parseKV(kv);
          if (key in target && target[key] !== val && !flags.overwrite) return `error: '${key}' already has a value (${target[key]}), and --overwrite is false`;
          target[key] = val;
        }
      }
      return `${kindRef(kind)}/${name} ${sub === "label" ? "labeled" : "annotated"}`;
    }
    case "taint": {
      const [kw, name, ...specs] = p;
      if (kindOf(kw) !== "Node") return "error: taint only supports nodes";
      const n = sh.state.nodes.find((x) => x.name === name);
      if (!n) return notFound("Node", name ?? "");
      for (const s of specs) {
        const remove = s.endsWith("-");
        const m = /^([^=:]+)(?:=([^:]*))?(?::(\w+))?-?$/.exec(s);
        if (!m) return `error: invalid taint spec: ${s}`;
        if (remove) {
          const before = n.taints.length;
          n.taints = n.taints.filter((t) => !(t.key === m[1] && (!m[3] || t.effect === m[3])));
          if (before === n.taints.length) return `error: taint "${m[1]}" not found`;
          return `node/${name} untainted`;
        }
        if (!m[3]) return `error: invalid taint spec: ${s}, effect is required (NoSchedule, PreferNoSchedule or NoExecute)`;
        n.taints = n.taints.filter((t) => t.key !== m[1]).concat({ key: m[1], value: m[2], effect: m[3] });
      }
      return `node/${name} tainted`;
    }
    case "cordon":
    case "uncordon": {
      const n = sh.state.nodes.find((x) => x.name === p[0]);
      if (!n) return notFound("Node", p[0] ?? "");
      const target = sub === "uncordon";
      const already = n.schedulable === target;
      n.schedulable = target;
      return `node/${n.name} ${already ? "already " : ""}${sub}ed`;
    }
    case "drain":
      return drain(sh, p[0], flags);
    case "top": {
      const kind = kindOf(p[0]);
      if (kind === "Node") return table([["NAME", "CPU(cores)", "CPU(%)", "MEMORY(bytes)", "MEMORY(%)"], ...sh.state.nodes.map((n, i) => [n.name, `${180 + i * 45}m`, `${4 + i}%`, `${900 + i * 130}Mi`, `${11 + i}%`])]);
      const pods = sh.state.pods.filter((x) => (allNs || x.namespace === ns) && podStatus(sh, x) === "Running");
      if (!pods.length) return `No resources found in ${ns} namespace.`;
      return table([["NAME", "CPU(cores)", "MEMORY(bytes)"], ...pods.map((x) => [x.name, `${(x.name.length % 7) + 1}m`, `${(x.name.length % 20) + 3}Mi`])]);
    }
    case "auth": {
      if (p[0] === "whoami") return table([["ATTRIBUTE", "VALUE"], ["Username", "kubernetes-admin"], ["Groups", "[kubeadm:cluster-admins system:authenticated]"]]);
      if (p[0] !== "can-i") return `error: unknown command "${p[0]}" for "kubectl auth"`;
      const [, verb, resource] = p;
      if (!verb || !resource) return "error: you must specify two arguments: verb resource";
      const as = flagStr(flags, "as");
      return can(sh, as, verb, resource.includes("/") ? resource.split("/")[0] : (kindOf(resource) ? pluralOf(kindOf(resource)!) : resource), ns) ? "yes" : "no";
    }
    case "port-forward": {
      const target = p[0] ?? "";
      const [local, remote] = (p[1] ?? "").split(":").map(Number);
      const [kw, name] = target.includes("/") ? target.split("/") : ["pod", target];
      const svc = kindOf(kw) === "Service" ? findService(sh, name, ns) : undefined;
      const pod = kindOf(kw) === "Pod" ? findPod(sh, name, ns) : undefined;
      if (!svc && !pod) return `Error from server (NotFound): ${kindOf(kw) === "Service" ? "services" : "pods"} "${name}" not found`;
      kc.portForwards[local] = { svc: svc?.name ?? pod!.name, ns, port: remote || local };
      return `Forwarding from 127.0.0.1:${local} -> ${remote || local}\nForwarding from [::1]:${local} -> ${remote || local}\n(port-forward em background — use curl localhost:${local})`;
    }
    default:
      return `error: unknown command "${sub}" for "kubectl"\nRun 'kubectl --help' for usage.`;
  }
};

const ref = (p: string[]): [string | undefined, string | undefined] =>
  p[0]?.includes("/") ? [kindOf(p[0].split("/")[0]), p[0].split("/")[1]] : [kindOf(p[0]), p[1]];

const labelTarget = (sh: Shell, kind: string, name: string, ns: string, annotations: boolean): Record<string, string> | undefined => {
  if (kind === "Pod") {
    const pod = findPod(sh, name, ns);
    if (!pod) return undefined;
    if (annotations) return ((pod as Pod & { annotations?: Record<string, string> }).annotations ??= {});
    return pod.labels;
  }
  if (kind === "Node") return sh.state.nodes.find((n) => n.name === name)?.labels;
  if (kind === "Deployment") return findDeployment(sh, name, ns)?.labels;
  if (kind === "Namespace") {
    if (!nsExists(sh, name)) return undefined;
    const o = findObj(sh, "Namespace", name) ?? (upsertObj(sh, { kind: "Namespace", name, manifest: { metadata: { name, labels: {} } } }), findObj(sh, "Namespace", name)!);
    o.manifest.metadata ??= {};
    return (o.manifest.metadata.labels ??= {});
  }
  const o = findObj(sh, kind, name, ns);
  if (!o) return undefined;
  o.manifest.metadata ??= {};
  return (o.manifest.metadata[annotations ? "annotations" : "labels"] ??= {});
};

// ---------- get ----------
const get = (sh: Shell, p: string[], flags: Flags, ns: string, allNs: boolean, output?: string): string => {
  if (!p.length) return 'You must specify the type of resource to get. Use "kubectl api-resources" for a complete list of supported resources.';
  const wide = output === "wide";
  const sel = parseSelector(flagStr(flags, "l", "selector"));
  let specs: { kind: string; names: string[] }[];
  if (p[0].includes("/")) specs = p.map((x) => ({ kind: kindOf(x.split("/")[0]) ?? `?${x.split("/")[0]}`, names: [x.split("/")[1]] }));
  else specs = p[0].split(",").map((w) => ({ kind: kindOf(w) ?? `?${w}`, names: p.slice(1) }));
  const bad = specs.find((s) => s.kind.startsWith("?"));
  if (bad) return `error: the server doesn't have a resource type "${bad.kind.slice(1)}"`;
  if (specs.length === 1 && specs[0].kind === "All") specs = ["Pod", "Service", "Deployment", "ReplicaSet"].map((kind) => ({ kind, names: [] }));

  const sections: string[] = [];
  const manifests: Json[] = [];
  const errors: string[] = [];
  const multi = specs.length > 1;
  for (const s of specs) {
    const { head, rows } = listRows(sh, s.kind, allNs ? null : ns, wide, sel);
    let picked = rows;
    if (s.names.length) {
      picked = s.names.map((n) => rows.find((r) => r.cells[0] === n || r.cells[0] === `${n} (default)`)).filter(Boolean) as Row[];
      for (const n of s.names) if (!rows.some((r) => r.cells[0] === n || r.cells[0] === `${n} (default)`)) errors.push(notFound(s.kind, n));
    }
    manifests.push(...picked.map((r) => r.manifest));
    if (!picked.length) continue;
    const prefix = multi ? (r: Row) => `${kindRef(s.kind)}/${r.cells[0]}` : (r: Row) => r.cells[0];
    const withNs = allNs && !CLUSTER_SCOPED.has(s.kind);
    const showLabels = !!flags["show-labels"];
    sections.push(
      table([
        [...(withNs ? ["NAMESPACE"] : []), ...head, ...(showLabels ? ["LABELS"] : [])],
        ...picked.map((r) => [...(withNs ? [r.ns ?? ""] : []), prefix(r), ...r.cells.slice(1), ...(showLabels ? [labelsStr(r.labels ?? {})] : [])]),
      ]),
    );
  }
  const single = specs.length === 1 && specs[0].names.length === 1;
  const formatted = formatOut(manifests, output, single);
  if (formatted !== null) return [formatted, ...errors].filter(Boolean).join("\n");
  if (!sections.length && !errors.length) return allNs ? "No resources found" : `No resources found in ${ns} namespace.`;
  return [...sections.join("\n\n").split("\n"), ...errors].filter((l) => l !== undefined).join("\n");
};

// ---------- run ----------
const runPod = (sh: Shell, p: string[], flags: Flags, rest: string[], args: string[], ns: string, dryRun: boolean, output?: string): string => {
  const name = p[0];
  const image = flagStr(flags, "image");
  if (!name) return "error: NAME is required for run";
  if (!image) return 'error: required flag(s) "image" not set';
  const labels = typeof flags.labels === "string" ? Object.fromEntries(flags.labels.split(",").map(parseKV)) : { run: name };
  const env = multiFlag(args, "env").map((e) => {
    const [k2, v] = parseKV(e);
    return { name: k2, value: v };
  });
  const c: Container = { name, image };
  if (flags.port) c.ports = [{ containerPort: Number(flags.port) }];
  if (env.length) c.env = env;
  if (rest.length) {
    if (flags.command) c.command = rest;
    else c.args = rest;
  }
  const restart = flagStr(flags, "restart") ?? "Always";
  const spec = { containers: [c], restartPolicy: restart, dnsPolicy: "ClusterFirst" } as Pod["spec"];
  if (dryRun) {
    const fake: Pod = { name, namespace: ns, labels, spec, createdAt: Date.now(), ip: "", restarts: 0, image };
    const m = podManifest(sh, fake, true);
    return formatOut([m], output ?? "yaml", true) ?? `pod/${name} created (dry run)`;
  }
  if (findPod(sh, name, ns)) return `Error from server (AlreadyExists): pods "${name}" already exists`;
  if (flags.rm) {
    // temporary pod: run the command from inside the cluster and clean up
    const tmp: Pod = { name, namespace: ns, labels, spec, createdAt: Date.now() - 10000, scheduledAt: Date.now() - 10000, node: "lab-worker", ip: "10.244.1.250", restarts: 0, image };
    const out = rest.length ? podExec(sh, tmp, c, rest) : "";
    return `${out}\npod "${name}" deleted`.trim();
  }
  newPod(sh, { name, namespace: ns, labels, spec });
  let res = `pod/${name} created`;
  if (flags.expose) {
    if (!flags.port) return `${res}\nerror: --port must be set when exposing a service`;
    createService(sh, { name, namespace: ns, port: Number(flags.port), selector: labels });
    res = `service/${name} created\n${res}`;
  }
  return res;
};

// ---------- create ----------
const create = (sh: Shell, p: string[], flags: Flags, rest: string[], args: string[], ns: string, dryRun: boolean, output?: string): string => {
  if (typeof flags.f === "string") return applyFiles(sh, flags, ns, "create");
  const [what, name] = p;
  const emit = (kind: string, manifest: Json, doCreate: () => string) => {
    if (dryRun) return formatOut([{ apiVersion: KIND_API_V[kind] ?? "v1", kind, metadata: { creationTimestamp: null, name, ...(CLUSTER_SCOPED.has(kind) || ns === "default" ? {} : { namespace: ns }), ...(manifest.metadata ?? {}) }, ...Object.fromEntries(Object.entries(manifest).filter(([k2]) => k2 !== "metadata")) }], output ?? "yaml", true) ?? `${kindRef(kind)}/${name} created (dry run)`;
    return doCreate();
  };
  if (!what) return "error: must specify one of -f and -k";
  if (!name && what !== "secret" && what !== "service" && what !== "svc") return `error: exactly one NAME is required, got 0`;
  const exists = (kind: string) => (findObj(sh, kind, name, ns) ? `error: failed to create ${kind.toLowerCase()}: ${pluralOf(kind)} "${name}" already exists` : null);
  switch (kindOf(what) ?? what) {
    case "Namespace": {
      if (dryRun) return formatOut([{ apiVersion: "v1", kind: "Namespace", metadata: { creationTimestamp: null, name }, spec: {}, status: {} }], output ?? "yaml", true)!;
      if (nsExists(sh, name)) return `Error from server (AlreadyExists): namespaces "${name}" already exists`;
      sh.state.namespaces.push({ name, createdAt: Date.now() });
      return `namespace/${name} created`;
    }
    case "Deployment": {
      const image = flagStr(flags, "image");
      if (!image) return 'error: required flag(s) "image" not set';
      const replicas = Number(flags.replicas ?? 1);
      const c: Container = { name, image };
      if (flags.port) c.ports = [{ containerPort: Number(flags.port) }];
      if (rest.length) c.command = rest;
      if (dryRun) {
        const d = { name, namespace: ns, replicas, labels: { app: name }, selector: { app: name }, template: { labels: { app: name }, spec: { containers: [c] } }, createdAt: Date.now(), revision: 1, history: [], image } as Deployment;
        return formatOut([deploymentManifest(sh, d, true)], output ?? "yaml", true)!;
      }
      if (findDeployment(sh, name, ns)) return `error: failed to create deployment: deployments.apps "${name}" already exists`;
      createDeployment(sh, { name, namespace: ns, replicas, template: { labels: { app: name }, spec: { containers: [c] } } });
      return `deployment.apps/${name} created`;
    }
    case "ConfigMap": {
      const data: Record<string, string> = {};
      for (const l of multiFlag(args, "from-literal")) {
        const [k2, v] = parseKV(l);
        data[k2] = v;
      }
      for (const f of multiFlag(args, "from-file")) {
        const [k2, path] = f.includes("=") ? parseKV(f) : [f.split("/").pop()!, f];
        const content = sh.readFile(path);
        if (content === undefined) return `error: error reading ${path}: no such file or directory`;
        data[k2] = content;
      }
      for (const f of multiFlag(args, "from-env-file")) {
        for (const line of (sh.readFile(f) ?? "").split("\n").filter((l) => l.includes("=") && !l.startsWith("#"))) {
          const [k2, v] = parseKV(line);
          data[k2] = v;
        }
      }
      return emit("ConfigMap", { data }, () => exists("ConfigMap") ?? (upsertObj(sh, { kind: "ConfigMap", name, namespace: ns, manifest: { data } }), `configmap/${name} created`));
    }
    case "secret": {
      const [, type, sname] = p;
      if (type !== "generic" && type !== "tls" && type !== "docker-registry") return `error: unknown secret type "${type}" — use: kubectl create secret generic <nome> --from-literal=chave=valor`;
      if (!sname) return "error: exactly one NAME is required, got 0";
      const data: Record<string, string> = {};
      for (const l of multiFlag(args, "from-literal")) {
        const [k2, v] = parseKV(l);
        data[k2] = btoa(v);
      }
      for (const f of multiFlag(args, "from-file")) {
        const [k2, path] = f.includes("=") ? parseKV(f) : [f.split("/").pop()!, f];
        const content = sh.readFile(path);
        if (content === undefined) return `error: error reading ${path}: no such file or directory`;
        data[k2] = btoa(content);
      }
      const manifest = { type: type === "tls" ? "kubernetes.io/tls" : type === "docker-registry" ? "kubernetes.io/dockerconfigjson" : "Opaque", data };
      if (dryRun) return formatOut([{ apiVersion: "v1", kind: "Secret", metadata: { creationTimestamp: null, name: sname }, ...manifest }], output ?? "yaml", true)!;
      if (findObj(sh, "Secret", sname, ns)) return `error: failed to create secret secrets "${sname}" already exists`;
      upsertObj(sh, { kind: "Secret", name: sname, namespace: ns, manifest });
      return `secret/${sname} created`;
    }
    case "Job": {
      const from = flagStr(flags, "from");
      let spec: Json;
      if (from) {
        const cj = findObj(sh, "CronJob", from.split("/")[1] ?? "", ns);
        if (!cj) return notFound("CronJob", from.split("/")[1] ?? "");
        spec = structuredClone(cj.manifest.spec.jobTemplate.spec);
      } else {
        const image = flagStr(flags, "image");
        if (!image) return 'error: required flag(s) "image" not set';
        spec = { template: { spec: { containers: [{ name, image, ...(rest.length ? { command: rest } : {}) }], restartPolicy: "Never" } } };
      }
      return emit("Job", { spec }, () => exists("Job") ?? (upsertObj(sh, { kind: "Job", name, namespace: ns, manifest: { spec } }), `job.batch/${name} created`));
    }
    case "CronJob": {
      const image = flagStr(flags, "image");
      const schedule = flagStr(flags, "schedule");
      if (!image) return 'error: required flag(s) "image" not set';
      if (!schedule) return 'error: required flag(s) "schedule" not set';
      const spec = { schedule, jobTemplate: { spec: { template: { spec: { containers: [{ name, image, ...(rest.length ? { command: rest } : {}) }], restartPolicy: "OnFailure" } } } } };
      return emit("CronJob", { spec }, () => exists("CronJob") ?? (upsertObj(sh, { kind: "CronJob", name, namespace: ns, manifest: { spec } }), `cronjob.batch/${name} created`));
    }
    case "ServiceAccount":
      return emit("ServiceAccount", {}, () => exists("ServiceAccount") ?? (upsertObj(sh, { kind: "ServiceAccount", name, namespace: ns, manifest: {} }), `serviceaccount/${name} created`));
    case "Role":
    case "ClusterRole": {
      const kind = kindOf(what)!;
      const verbs = multiFlag(args, "verb").flatMap((v) => v.split(","));
      const resources = multiFlag(args, "resource").flatMap((v) => v.split(","));
      if (!verbs.length) return "error: at least one verb must be specified";
      if (!resources.length) return "error: at least one resource must be specified";
      const norm = resources.map((r) => (kindOf(r) ? pluralOf(kindOf(r)!) : r));
      const rules = [{ apiGroups: [norm.some((r) => ["deployments", "replicasets"].includes(r)) ? "apps" : ""], resources: norm, verbs }];
      return emit(kind, { rules }, () => (findObj(sh, kind, name, ns) ? `error: failed to create ${kind.toLowerCase()}: ${pluralOf(kind)}.rbac.authorization.k8s.io "${name}" already exists` : (upsertObj(sh, { kind, name, namespace: ns, manifest: { rules } }), `${kind.toLowerCase()}.rbac.authorization.k8s.io/${name} created`)));
    }
    case "RoleBinding":
    case "ClusterRoleBinding": {
      const kind = kindOf(what)!;
      const role = flagStr(flags, "role");
      const cr = flagStr(flags, "clusterrole");
      if (!role && !cr) return "error: exactly one of clusterrole or role must be specified";
      const subjects = [
        ...multiFlag(args, "user").map((u) => ({ apiGroup: "rbac.authorization.k8s.io", kind: "User", name: u })),
        ...multiFlag(args, "group").map((g) => ({ apiGroup: "rbac.authorization.k8s.io", kind: "Group", name: g })),
        ...multiFlag(args, "serviceaccount").map((s) => {
          const [sns, sname] = s.split(":");
          return { kind: "ServiceAccount", name: sname, namespace: sns };
        }),
      ];
      const manifest = { roleRef: { apiGroup: "rbac.authorization.k8s.io", kind: role ? "Role" : "ClusterRole", name: role ?? cr }, subjects };
      return emit(kind, manifest, () => (findObj(sh, kind, name, ns) ? `error: failed to create ${kind.toLowerCase()}: ${pluralOf(kind)}.rbac.authorization.k8s.io "${name}" already exists` : (upsertObj(sh, { kind, name, namespace: ns, manifest }), `${kind.toLowerCase()}.rbac.authorization.k8s.io/${name} created`)));
    }
    case "Service": {
      const [, type, sname] = p;
      const tcp = flagStr(flags, "tcp");
      if (!sname || !tcp) return "error: usage: kubectl create service clusterip|nodeport NAME --tcp=port:targetPort";
      const [port, target] = tcp.split(":").map(Number);
      const t = type === "nodeport" ? "NodePort" : type === "loadbalancer" ? "LoadBalancer" : "ClusterIP";
      if (dryRun) return formatOut([serviceManifest({ name: sname, namespace: ns, type: t, port, targetPort: target || port, selector: { app: sname }, clusterIP: "", createdAt: Date.now() }, true)], output ?? "yaml", true)!;
      if (findService(sh, sname, ns)) return `error: failed to create service: services "${sname}" already exists`;
      createService(sh, { name: sname, namespace: ns, type: t, port, targetPort: target || port, selector: { app: sname } });
      return `service/${sname} created`;
    }
    case "Ingress": {
      const rules = multiFlag(args, "rule").map((r) => {
        const [hostPath, backend] = r.split("=");
        const [host, ...pathParts] = hostPath.split("/");
        const [svc, port] = backend.split(":");
        return { host: host || undefined, http: { paths: [{ path: "/" + pathParts.join("/").replace(/\*$/, ""), pathType: "Prefix", backend: { service: { name: svc, port: { number: Number(port) } } } }] } };
      });
      const spec = { ingressClassName: flagStr(flags, "class") ?? "nginx", rules };
      return emit("Ingress", { spec }, () => exists("Ingress") ?? (upsertObj(sh, { kind: "Ingress", name, namespace: ns, manifest: { spec } }), `ingress.networking.k8s.io/${name} created`));
    }
    case "ResourceQuota": {
      const hard = Object.fromEntries((flagStr(flags, "hard") ?? "").split(",").filter(Boolean).map(parseKV));
      return emit("ResourceQuota", { spec: { hard } }, () => exists("ResourceQuota") ?? (upsertObj(sh, { kind: "ResourceQuota", name, namespace: ns, manifest: { spec: { hard } } }), `resourcequota/${name} created`));
    }
    default:
      return `error: unknown command "${what}" for "kubectl create"`;
  }
};

const KIND_API_V: Record<string, string> = { Deployment: "apps/v1", Job: "batch/v1", CronJob: "batch/v1", Role: "rbac.authorization.k8s.io/v1", ClusterRole: "rbac.authorization.k8s.io/v1", RoleBinding: "rbac.authorization.k8s.io/v1", ClusterRoleBinding: "rbac.authorization.k8s.io/v1", Ingress: "networking.k8s.io/v1" };

// ---------- apply ----------
const applyFiles = (sh: Shell, flags: Flags, ns: string, mode: "apply" | "create" | "replace", stdin?: string): string => {
  const file = flagStr(flags, "f", "filename");
  if (!file) return "error: must specify one of -f and -k";
  let content: string | undefined;
  if (file === "-") content = stdin;
  else if (/^https?:\/\//.test(file)) return `error: unable to read URL "${file}" (sem acesso à internet no lab)`;
  else if (sh.isDir(file) && sh.readFile(file) === undefined) content = sh.listDir(file).filter((f) => /\.ya?ml$/.test(f)).map((f) => sh.readFile(`${file}/${f}`)).join("\n---\n");
  else content = sh.readFile(file);
  if (content === undefined) return `error: the path "${file}" does not exist`;
  let docs: Json[];
  try {
    docs = YAML.parseAllDocuments(content).map((d) => {
      if (d.errors.length) throw new Error(d.errors[0].message);
      return d.toJSON();
    }).filter(Boolean);
  } catch (e) {
    return `error: error parsing ${file}: error converting YAML to JSON: yaml: ${(e as Error).message.split("\n")[0]}`;
  }
  if (!docs.length) return `error: no objects passed to ${mode}`;
  const out: string[] = [];
  for (const d of docs) {
    if (mode === "replace") {
      const kind = d.kind;
      const n = d.metadata?.name;
      const dns = d.metadata?.namespace ?? ns;
      if (deleteAny(sh, kind, n, CLUSTER_SCOPED.has(kind) ? "" : dns)) out.push(`${kind.toLowerCase()} "${n}" deleted`);
    }
    out.push(applyManifest(sh, d, mode, ns));
  }
  return out.join("\n");
};

// ---------- edit ----------
const edit = (sh: Shell, p: string[], ns: string): ToolResult => {
  const [kind, name] = ref(p);
  if (!kind) return `error: the server doesn't have a resource type "${p[0]}"`;
  let manifest: Json;
  if (kind === "Pod") {
    const pod = findPod(sh, name ?? "", ns);
    if (!pod) return notFound("Pod", name ?? "");
    manifest = podManifest(sh, pod);
  } else if (kind === "Deployment") {
    const d = findDeployment(sh, name ?? "", ns);
    if (!d) return notFound("Deployment", name ?? "");
    manifest = deploymentManifest(sh, d);
  } else if (kind === "Service") {
    const s = findService(sh, name ?? "", ns);
    if (!s) return notFound("Service", name ?? "");
    manifest = serviceManifest(s);
  } else if (kind === "Node") {
    const n = sh.state.nodes.find((x) => x.name === name);
    if (!n) return notFound("Node", name ?? "");
    manifest = nodeManifest(sh, n);
  } else {
    const o = findObj(sh, kind, name ?? "", ns);
    if (!o) return notFound(kind, name ?? "");
    manifest = objectManifest(sh, o);
  }
  delete manifest.status;
  const path = `/tmp/kubectl-edit-${hexId(10)}.yaml`;
  const header = "# Please edit the object below. Lines beginning with a '#' will be ignored,\n# and an empty file will abort the edit. If an error occurs while saving this file will be\n# reopened with the relevant failures.\n#\n";
  const content = header + YAML.stringify(manifest);
  sh.editHooks.set(path, (text) => {
    if (!text.trim()) return "Edit cancelled, no changes made.";
    let doc: Json;
    try {
      doc = YAML.parse(text);
    } catch (e) {
      return { output: `error: ${(e as Error).message.split("\n")[0]}`, ok: false };
    }
    if (JSON.stringify(doc) === JSON.stringify(YAML.parse(content))) return "Edit cancelled, no changes made.";
    if (kind === "Node") {
      const n = sh.state.nodes.find((x) => x.name === name)!;
      n.labels = doc.metadata?.labels ?? n.labels;
      n.taints = doc.spec?.taints ?? [];
      n.schedulable = !doc.spec?.unschedulable;
      return `node/${name} edited`;
    }
    const res = applyManifest(sh, doc, "apply", ns);
    if (/Forbidden|invalid|error/i.test(res)) {
      sh.writeFile(path, text);
      return { output: `error: ${kind.toLowerCase()}s "${name}" is invalid\nA copy of your changes has been stored to "${path}"\nerror: Edit cancelled, no valid changes were saved.\n${res}`, ok: false };
    }
    return `${kindRef(kind)}/${name} edited`;
  });
  return { output: "", edit: { path, content } };
};

// ---------- delete ----------
const del = (sh: Shell, p: string[], flags: Flags, ns: string): string => {
  if (typeof flags.f === "string") {
    const content = sh.readFile(flags.f);
    if (content === undefined) return `error: the path "${flags.f}" does not exist`;
    return YAML.parseAllDocuments(content).map((d) => d.toJSON()).filter(Boolean).map((d: Json) => {
      const ok = deleteAny(sh, d.kind, d.metadata?.name, CLUSTER_SCOPED.has(d.kind) ? "" : d.metadata?.namespace ?? ns);
      return ok ? `${kindRef(d.kind)} "${d.metadata?.name}" deleted` : notFound(d.kind, d.metadata?.name);
    }).join("\n");
  }
  let targets: [string, string][];
  if (p[0]?.includes("/")) targets = p.map((x) => [kindOf(x.split("/")[0]) ?? x, x.split("/")[1]]);
  else {
    const kind = kindOf(p[0]);
    if (!kind) return p[0] ? `error: the server doesn't have a resource type "${p[0]}"` : "error: You must provide one or more resources by argument or filename.";
    let names = p.slice(1);
    if (flags.all) {
      const { rows } = listRows(sh, kind, ns, false, () => true);
      names = rows.map((r) => r.cells[0]).filter((n) => n !== "kubernetes" && n !== "kube-root-ca.crt" && n !== "default");
    }
    if (typeof flags.l === "string") {
      const { rows } = listRows(sh, kind, ns, false, parseSelector(flags.l));
      names = rows.map((r) => r.cells[0]);
    }
    if (!names.length) return "error: resource(s) were provided, but no name was specified";
    targets = names.map((n) => [kind, n]);
  }
  const out: string[] = [];
  for (const [kind, name] of targets) {
    if (kind === "Node") {
      const n = sh.state.nodes.find((x) => x.name === name);
      if (!n) {
        out.push(notFound("Node", name));
        continue;
      }
      sh.state.nodes = sh.state.nodes.filter((x) => x !== n);
      out.push(`node "${name}" deleted`);
      continue;
    }
    const ok = deleteAny(sh, kind, name, CLUSTER_SCOPED.has(kind) ? "" : ns);
    out.push(ok ? `${kindRef(kind)} "${name}" deleted${flags.force ? "\nWarning: Immediate deletion does not wait for confirmation that the running resource has been terminated." : ""}` : notFound(kind, name));
  }
  return out.join("\n");
};

// ---------- expose ----------
const expose = (sh: Shell, p: string[], flags: Flags, ns: string, dryRun: boolean, output?: string): string => {
  const [kind, name] = ref(p);
  if (kind !== "Deployment" && kind !== "Pod" && kind !== "Service") return "error: cannot expose this resource type (use deployment, pod or service)";
  let selector: Record<string, string> | undefined;
  let portGuess: number | undefined;
  if (kind === "Deployment") {
    const d = findDeployment(sh, name ?? "", ns);
    if (!d) return notFound("Deployment", name ?? "");
    selector = d.selector;
    portGuess = d.template.spec.containers[0].ports?.[0]?.containerPort;
  } else if (kind === "Pod") {
    const pod = findPod(sh, name ?? "", ns);
    if (!pod) return notFound("Pod", name ?? "");
    selector = { ...pod.labels };
    delete selector["pod-template-hash"];
    portGuess = pod.spec.containers[0].ports?.[0]?.containerPort;
  } else {
    const s = findService(sh, name ?? "", ns);
    if (!s) return notFound("Service", name ?? "");
    selector = s.selector;
    portGuess = s.port;
  }
  const port = Number(flags.port ?? portGuess);
  if (!port) return "error: couldn't find port via --port flag or introspection\nSee 'kubectl expose -h' for help and examples";
  const svcName = flagStr(flags, "name") ?? name!;
  const type = (flagStr(flags, "type") ?? "ClusterIP") as Service["type"];
  if (!["ClusterIP", "NodePort", "LoadBalancer"].includes(type)) return `error: invalid service type "${type}" (use ClusterIP, NodePort or LoadBalancer)`;
  const targetPort = Number(flags["target-port"] ?? port);
  if (dryRun) return formatOut([serviceManifest({ name: svcName, namespace: ns, type, port, targetPort, selector, clusterIP: "", createdAt: Date.now() }, true)], output ?? "yaml", true)!;
  if (findService(sh, svcName, ns)) return `Error from server (AlreadyExists): services "${svcName}" already exists`;
  createService(sh, { name: svcName, namespace: ns, type, port, targetPort, selector });
  return `service/${svcName} exposed`;
};

// ---------- set ----------
const setCmd = (sh: Shell, p: string[], flags: Flags, args: string[], ns: string): string => {
  const [what, target, ...assigns] = p;
  const [kind, name] = ref([target, assigns[0] && !target?.includes("/") ? assigns.shift()! : undefined].filter(Boolean) as string[]);
  const d = kind === "Deployment" ? findDeployment(sh, name ?? "", ns) : undefined;
  const pod = kind === "Pod" ? findPod(sh, name ?? "", ns) : undefined;
  if (!d && !pod) return kind ? notFound(kind, name ?? "") : `error: the server doesn't have a resource type "${target}"`;
  const containers = d ? d.template.spec.containers : pod!.spec.containers;
  const done = (verb: string) => {
    if (d) {
      bumpRevision(d);
      reconcile(sh);
      return `deployment.apps/${name} ${verb}`;
    }
    return `pod/${name} ${verb}`;
  };
  switch (what) {
    case "image": {
      if (!assigns.length || !assigns.every((a) => a.includes("="))) return "error: expected CONTAINER=IMAGE (ex.: nginx=nginx:1.25)";
      for (const a of assigns) {
        const [cname, image] = parseKV(a);
        const targets = cname === "*" ? containers : containers.filter((c) => c.name === cname);
        if (!targets.length) return `error: unable to find container named "${cname}"`;
        if (targets.every((c) => c.image === image)) return `${d ? "deployment.apps" : "pod"}/${name} image unchanged`;
        targets.forEach((c) => (c.image = image));
      }
      if (pod) {
        pod.image = containers[0].image;
        pod.scheduledAt = Date.now();
      }
      return done("image updated");
    }
    case "env": {
      if (pod) return "error: a Pod não pode ter env alterado — edite o Deployment ou recrie o Pod";
      for (const a of assigns) {
        if (a.endsWith("-")) containers.forEach((c) => (c.env = (c.env ?? []).filter((e) => e.name !== a.slice(0, -1))));
        else {
          const [k2, v] = parseKV(a);
          containers.forEach((c) => {
            c.env = (c.env ?? []).filter((e) => e.name !== k2).concat({ name: k2, value: v });
          });
        }
      }
      const fromCm = flagStr(flags, "from");
      if (fromCm) {
        const [fk, fname] = fromCm.split("/");
        containers.forEach((c) => (c.envFrom = [...(c.envFrom ?? []), fk.startsWith("secret") ? { secretRef: { name: fname } } : { configMapRef: { name: fname } }]));
      }
      return done("env updated");
    }
    case "resources": {
      if (pod) return "error: pods are immutable for resources — edit the Deployment or recreate the Pod";
      const parse = (s?: string) => (s ? Object.fromEntries(s.split(",").map(parseKV)) : undefined);
      const limits = parse(flagStr(flags, "limits"));
      const requests = parse(flagStr(flags, "requests"));
      if (!limits && !requests) return "error: you must specify an update to requests or limits (in the form of --requests/--limits)";
      const cname = flagStr(flags, "c", "containers");
      containers.filter((c) => !cname || c.name === cname).forEach((c) => {
        c.resources = { ...(c.resources ?? {}), ...(limits ? { limits: { ...(c.resources?.limits ?? {}), ...limits } } : {}), ...(requests ? { requests: { ...(c.resources?.requests ?? {}), ...requests } } : {}) };
      });
      return done("resource requirements updated");
    }
    case "serviceaccount":
    case "sa": {
      if (!d) return "error: only deployments are supported";
      d.template.spec.serviceAccountName = assigns[0];
      return done("serviceaccount updated");
    }
    default:
      return `error: unknown command "${what}" for "kubectl set" (use image, env, resources ou serviceaccount)`;
  }
  void args;
};

// ---------- rollout ----------
const rollout = (sh: Shell, p: string[], flags: Flags, ns: string): string => {
  const [action, ...r] = p;
  const [kind, name] = ref(r);
  const d = kind === "Deployment" ? findDeployment(sh, name ?? "", ns) : undefined;
  if (!d) return notFound(kind ?? "Deployment", name ?? "");
  const pods = podsOfDeployment(sh, d);
  switch (action) {
    case "status": {
      const bad = pods.find((x) => ["ImagePullBackOff", "ErrImagePull", "CrashLoopBackOff", "CreateContainerConfigError", "Error"].includes(podStatus(sh, x)) || (podStatus(sh, x) === "Running" && !podReady(sh, x)) || !x.node);
      if (bad && Date.now() - (bad.scheduledAt ?? bad.createdAt) > 3000)
        return `Waiting for deployment "${name}" rollout to finish: 0 of ${d.replicas} updated replicas are available...\nerror: deployment "${name}" exceeded its progress deadline`;
      const ready = pods.filter((x) => podReady(sh, x)).length;
      const wait = ready < d.replicas ? `Waiting for deployment "${name}" rollout to finish: ${ready} of ${d.replicas} updated replicas are available...\n` : "";
      return `${wait}deployment "${name}" successfully rolled out`;
    }
    case "history": {
      const rev = Number(flags.revision);
      if (rev) {
        const h = d.history.find((x) => x.revision === rev);
        if (!h) return `error: unable to find the specified revision`;
        const t = JSON.parse(h.template);
        return `deployment.apps/${name} with revision #${rev}\nPod Template:\n  Labels:\t${labelsStr(t.labels)}\n  Containers:\n${t.spec.containers.map((c: Container) => `   ${c.name}:\n    Image:\t${c.image}`).join("\n")}`;
      }
      return `deployment.apps/${name} \n` + table([["REVISION", "CHANGE-CAUSE"], ...d.history.map((h) => [String(h.revision), (h as { cause?: string }).cause ?? "<none>"])]);
    }
    case "undo": {
      if (d.history.length < 2) return `error: no rollout history found for deployment "${name}"`;
      const to = Number(flags["to-revision"]);
      const prev = to ? d.history.find((h) => h.revision === to) : d.history[d.history.length - 2];
      if (!prev) return `error: unable to find specified revision ${to} in history`;
      d.template = JSON.parse(prev.template);
      d.history = d.history.filter((h) => h !== prev);
      bumpRevision(d);
      reconcile(sh);
      return `deployment.apps/${name} rolled back`;
    }
    case "restart":
      sh.state.pods = sh.state.pods.filter((x) => !(x.ownerKind === "Deployment" && x.owner === d.name && x.namespace === d.namespace));
      d.template.labels = { ...d.template.labels };
      (d.template as Json).restartedAt = Date.now();
      reconcile(sh);
      return `deployment.apps/${name} restarted`;
    case "pause":
    case "resume":
      return `deployment.apps/${name} ${action}d`;
    default:
      return `error: unknown command "${action}" for "kubectl rollout" (status, history, undo, restart)`;
  }
};

// ---------- drain ----------
const drain = (sh: Shell, nodeName: string | undefined, flags: Flags): string => {
  const n = sh.state.nodes.find((x) => x.name === nodeName);
  if (!n) return notFound("Node", nodeName ?? "");
  n.schedulable = false;
  const pods = sh.state.pods.filter((p) => p.node === n.name && p.ownerKind !== "Static");
  const ds = pods.filter((p) => p.ownerKind === "DaemonSet");
  const bare = pods.filter((p) => !p.ownerKind);
  const errs: string[] = [];
  if (ds.length && !flags["ignore-daemonsets"]) errs.push(`cannot delete DaemonSet-managed Pods (use --ignore-daemonsets to ignore): ${ds.map((p) => `${p.namespace}/${p.name}`).join(", ")}`);
  if (bare.length && !flags.force) errs.push(`cannot delete Pods that declare no controller (use --force to override): ${bare.map((p) => `${p.namespace}/${p.name}`).join(", ")}`);
  if (errs.length) return `node/${n.name} cordoned\nerror: unable to drain node "${n.name}" due to error: [${errs.join(", ")}], continuing command...\nThere are pending nodes to be drained:\n ${n.name}\n${errs.map((e) => `error: ${e}`).join("\n")}`;
  const evict = pods.filter((p) => p.ownerKind !== "DaemonSet");
  const lines = [`node/${n.name} cordoned`];
  if (ds.length) lines.push(`Warning: ignoring DaemonSet-managed Pods: ${ds.map((p) => `${p.namespace}/${p.name}`).join(", ")}`);
  for (const p of evict) lines.push(`evicting pod ${p.namespace}/${p.name}`);
  sh.state.pods = sh.state.pods.filter((p) => !evict.includes(p));
  for (const p of evict) lines.push(`pod/${p.name} evicted`);
  reconcile(sh);
  lines.push(`node/${n.name} drained`);
  return lines.join("\n");
};

// ---------- tool ----------
registerTool({
  name: "kubectl",
  aliases: ["k"],
  summary: "controla o cluster Kubernetes",
  subcommands: SUB_DESC,
  flags: FLAG_DESC,
  valueFlags: VALUE_FLAGS,
  run,
  explainError: (cmd, output) => {
    if (/pod updates may not change fields/.test(output))
      return "Pods são imutáveis: quase nenhum campo pode ser alterado depois de criado (só a imagem, basicamente). Salve o YAML, e recrie o Pod com kubectl replace --force -f <arquivo> (ou delete + apply).";
    if (/selector` does not match template `labels`/.test(output))
      return "O spec.selector.matchLabels do Deployment precisa ser igual (ou subconjunto) dos labels em spec.template.metadata.labels — é assim que o ReplicaSet encontra os próprios Pods.";
    if (/is not supported anymore. Use exec \[POD\] -- \[COMMAND\]/.test(output)) return "Separe o comando com --. Ex.: kubectl exec meu-pod -- env";
    if (/unable to upgrade connection: container not found/.test(output)) return "O container não está Running, então não dá para executar comandos nele. Veja o motivo com kubectl describe pod.";
    if (/cannot delete DaemonSet-managed Pods/.test(output)) return "Pods de DaemonSet (kube-proxy, CNI) existem em todos os nós e não podem ser despejados. Adicione --ignore-daemonsets ao drain.";
    if (/cannot delete Pods that declare no controller/.test(output)) return "Há Pods avulsos (sem Deployment/ReplicaSet) no nó — eles não seriam recriados. Use --force se puder perdê-los.";
    if (/namespaces "[^"]+" not found/.test(output)) return "Esse namespace não existe. Liste com kubectl get ns ou crie com kubectl create namespace <nome>.";
    if (/error converting YAML to JSON|error parsing/.test(output)) return "O YAML está inválido — geralmente indentação (use espaços, nunca tab) ou um ':' faltando. Abra o arquivo com vi e confira o alinhamento.";
    if (/is invalid: spec.containers\[\d+\]\.(name|image): Required/.test(output)) return "Todo container precisa de name e image no manifesto.";
    if (/already has a value .* --overwrite is false/.test(output)) return "O label já existe com outro valor. Adicione --overwrite para substituir.";
    if (/effect is required/.test(output)) return "Taints precisam de efeito: chave=valor:NoSchedule (ou PreferNoSchedule / NoExecute).";
    void cmd;
    return null;
  },
  http: ({ host, port, path }, sh) => {
    const kc = ctxState(sh);
    if (["localhost", "127.0.0.1"].includes(host) && kc.portForwards[port]) {
      const f = kc.portForwards[port];
      const svc = findService(sh, f.svc, f.ns);
      const pods = svc ? endpoints(sh, svc) : sh.state.pods.filter((p) => p.name === f.svc && p.namespace === f.ns);
      if (!pods.length) return `curl: (52) Empty reply from server`;
      sh.flags.add(`curl-pf:${f.svc}`);
      return responseOf(pods[0], svc ? svc.targetPort : f.port);
    }
    const nodeIps = ["localhost", "127.0.0.1", ...sh.state.nodes.map((n) => n.ip), ...sh.state.nodes.map((n) => n.name)];
    const np = sh.state.services.find((s) => s.nodePort === port && nodeIps.includes(host));
    if (np) {
      const eps = endpoints(sh, np);
      if (!eps.length) return `curl: (52) Empty reply from server`;
      if (!trafficAllowed(sh, null, eps[0], np.targetPort)) return `curl: (28) Connection timed out after 5001 milliseconds`;
      sh.flags.add(`curl-svc:${np.name}`);
      return responseOf(eps[0], np.targetPort);
    }
    if (sh.state.services.some((s) => s.clusterIP === host) || sh.state.pods.some((p) => p.ip === host && p.ownerKind !== "DaemonSet")) {
      const out = podHttp(sh, null, host, port, "curl");
      const svc = sh.state.services.find((s) => s.clusterIP === host);
      if (svc && !out.startsWith("curl:")) sh.flags.add(`curl-svc:${svc.name}`);
      return out;
    }
    if (sh.state.services.some((s) => host === s.name || host.startsWith(`${s.name}.`)))
      return `curl: (6) Could not resolve host: ${host}\n(dica: nomes DNS de Service só resolvem DENTRO do cluster — use kubectl exec ou kubectl run --rm)`;
    void path;
    return null;
  },
});

export { podExec, podHttp, SUB_DESC };
