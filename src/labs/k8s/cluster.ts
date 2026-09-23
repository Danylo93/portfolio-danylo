// In-memory Kubernetes cluster model: scheduling, pod lifecycle, probes, endpoints, RBAC, NetworkPolicy.
import YAML from "yaml";
import type { Shell } from "../shell";
import type { Container, Deployment, K8sObject, NodeState, Pod, PodSpec, Service } from "../types";
import { matchLabels, rand } from "../util";

export const CP_NODE = "lab-control-plane";
export const CP_TAINT = { key: "node-role.kubernetes.io/control-plane", effect: "NoSchedule" };
export const NODE_AGE = Date.now() - 1000 * 60 * 60 * 26;

export const initialNodes = (): NodeState[] => [
  { name: CP_NODE, role: "control-plane", ip: "172.18.0.2", version: "v1.30.0", schedulable: true, taints: [{ ...CP_TAINT }], labels: { "kubernetes.io/hostname": CP_NODE, "node-role.kubernetes.io/control-plane": "" } },
  { name: "lab-worker", role: "worker", ip: "172.18.0.3", version: "v1.30.0", schedulable: true, taints: [], labels: { "kubernetes.io/hostname": "lab-worker" } },
  { name: "lab-worker2", role: "worker", ip: "172.18.0.4", version: "v1.30.0", schedulable: true, taints: [], labels: { "kubernetes.io/hostname": "lab-worker2" } },
];

// ---------- images ----------
const GOOD_IMAGE =
  /^(docker\.io\/)?(library\/)?(nginx|httpd|redis|busybox|alpine|node|python|postgres|mysql|traefik|memcached|ubuntu|debian|hashicorp\/http-echo|bitnami\/[\w-]+|kodekloud\/[\w-]+|registry\.k8s\.io\/[\w./-]+|ghcr\.io\/[\w./-]+|[\w.-]+\.dkr\.ecr\.[\w-]+\.amazonaws\.com\/[\w./-]+|quay\.io\/[\w./-]+)(:[\w.-]+)?(@sha256:[a-f0-9]+)?$/;
const BAD_TAGS = /:(latestt|doesnotexist|9\.9\.9|lastest)$/;
export const validImage = (img: string) => GOOD_IMAGE.test(img) && !BAD_TAGS.test(img);

const SHORT_LIVED = /^(docker\.io\/)?(library\/)?(busybox|alpine|ubuntu|debian|python|node)(:|$)/;
export const defaultPort = (image: string) => {
  if (/redis/.test(image)) return 6379;
  if (/postgres/.test(image)) return 5432;
  if (/mysql/.test(image)) return 3306;
  if (/http-echo/.test(image)) return 5678;
  if (/memcached/.test(image)) return 11211;
  return 80;
};

// ---------- ids ----------
let ipSeq = 10;
export const nextPodIp = () => {
  ipSeq++;
  return `10.244.${1 + (ipSeq % 2)}.${ipSeq % 250}`;
};
export const nextClusterIp = () => `10.96.${Math.floor(Math.random() * 200) + 20}.${Math.floor(Math.random() * 250) + 2}`;

// ---------- namespaces ----------
export const SYSTEM_NAMESPACES = ["default", "kube-node-lease", "kube-public", "kube-system", "local-path-storage"];
export const nsExists = (sh: Shell, ns: string) => sh.state.namespaces.some((n) => n.name === ns);

// ---------- objects ----------
export const CLUSTER_SCOPED = new Set(["Node", "Namespace", "PersistentVolume", "StorageClass", "ClusterRole", "ClusterRoleBinding"]);

export const findObj = (sh: Shell, kind: string, name: string, ns?: string) =>
  sh.state.objects.find((o) => o.kind === kind && o.name === name && (CLUSTER_SCOPED.has(kind) || o.namespace === (ns ?? "default")));

export const objsOf = (sh: Shell, kind: string, ns?: string | null) =>
  sh.state.objects.filter((o) => o.kind === kind && (CLUSTER_SCOPED.has(kind) || ns === null || o.namespace === (ns ?? "default")));

export const upsertObj = (sh: Shell, obj: Omit<K8sObject, "createdAt"> & { createdAt?: number }) => {
  const existing = findObj(sh, obj.kind, obj.name, obj.namespace);
  if (existing) {
    const changed = JSON.stringify(existing.manifest) !== JSON.stringify(obj.manifest);
    existing.manifest = obj.manifest;
    return changed ? "configured" : "unchanged";
  }
  sh.state.objects.push({ ...obj, namespace: CLUSTER_SCOPED.has(obj.kind) ? undefined : obj.namespace ?? "default", createdAt: obj.createdAt ?? Date.now() });
  if (obj.kind === "Job") spawnJobPods(sh, sh.state.objects[sh.state.objects.length - 1]);
  return "created";
};

export const deleteObj = (sh: Shell, kind: string, name: string, ns?: string) => {
  const o = findObj(sh, kind, name, ns);
  if (!o) return false;
  sh.state.objects = sh.state.objects.filter((x) => x !== o);
  if (kind === "Job") sh.state.pods = sh.state.pods.filter((p) => !(p.ownerKind === "Job" && p.owner === name && p.namespace === (ns ?? "default")));
  return true;
};

// ---------- pods ----------
export const newPod = (
  sh: Shell,
  opts: { name: string; namespace?: string; labels?: Record<string, string>; spec: PodSpec; owner?: string; ownerKind?: Pod["ownerKind"]; createdAt?: number },
): Pod => {
  const createdAt = opts.createdAt ?? Date.now();
  const pod: Pod = {
    name: opts.name,
    namespace: opts.namespace ?? "default",
    labels: opts.labels ?? {},
    spec: structuredClone(opts.spec),
    createdAt,
    ip: nextPodIp(),
    owner: opts.owner,
    ownerKind: opts.ownerKind,
    restarts: 0,
    image: opts.spec.containers[0]?.image ?? "",
  };
  sh.state.pods.push(pod);
  schedule(sh, pod, createdAt);
  return pod;
};

export const simplePodSpec = (name: string, image: string, extra: Partial<Container> = {}): PodSpec => ({
  containers: [{ name, image, ...extra }],
});

export const deletePod = (sh: Shell, pod: Pod) => {
  sh.state.pods = sh.state.pods.filter((p) => p !== pod);
};

// ---------- scheduling ----------
export const nodeReady = (sh: Shell, node: string) => sh.state.hosts[node]?.services.kubelet?.active !== false;

const tolerates = (spec: PodSpec, taint: { key: string; value?: string; effect: string }) =>
  (spec.tolerations ?? []).some(
    (t) =>
      (t.operator === "Exists" && (!t.key || t.key === taint.key)) ||
      (t.key === taint.key && (t.operator === "Exists" || (t.value ?? "") === (taint.value ?? "")) && (!t.effect || t.effect === taint.effect)),
  );

export const schedulerHealthy = (sh: Shell) => staticComponentStatus(sh, "kube-scheduler").ok;

/** Explains why each node rejected the pod (FailedScheduling message). */
export const unschedulableReasons = (sh: Shell, pod: Pod) => {
  const reasons: Record<string, number> = {};
  const add = (r: string) => (reasons[r] = (reasons[r] ?? 0) + 1);
  for (const n of sh.state.nodes) {
    if (!nodeReady(sh, n.name)) add("node(s) had untolerated taint {node.kubernetes.io/unreachable: }");
    else if (!n.schedulable) add("node(s) were unschedulable");
    else if (n.taints.some((t) => (t.effect === "NoSchedule" || t.effect === "NoExecute") && !tolerates(pod.spec, t)))
      add(`node(s) had untolerated taint {${n.taints.find((t) => !tolerates(pod.spec, t))!.key}: ${n.taints.find((t) => !tolerates(pod.spec, t))!.value ?? ""}}`);
    else if (pod.spec.nodeSelector && !matchLabels(pod.spec.nodeSelector, n.labels)) add("node(s) didn't match Pod's node affinity/selector");
    else if (pendingClaim(sh, pod)) add("pod has unbound immediate PersistentVolumeClaims");
  }
  const total = sh.state.nodes.length;
  return `0/${total} nodes are available: ${Object.entries(reasons).map(([r, c]) => `${c} ${r}`).join(", ")}. preemption: 0/${total} nodes are available.`;
};

const pendingClaim = (sh: Shell, pod: Pod) =>
  (pod.spec.volumes ?? []).some((v) => v.persistentVolumeClaim && pvcStatus(sh, v.persistentVolumeClaim.claimName, pod.namespace).status !== "Bound");

export const feasibleNodes = (sh: Shell, pod: Pod) =>
  sh.state.nodes.filter(
    (n) =>
      nodeReady(sh, n.name) &&
      n.schedulable &&
      !n.taints.some((t) => (t.effect === "NoSchedule" || t.effect === "NoExecute") && !tolerates(pod.spec, t)) &&
      (!pod.spec.nodeSelector || matchLabels(pod.spec.nodeSelector, n.labels)),
  );

export const schedule = (sh: Shell, pod: Pod, at = Date.now()) => {
  if (pod.node || pod.ownerKind === "Static") return;
  if (pod.spec.nodeName) {
    pod.node = pod.spec.nodeName;
    pod.scheduledAt = at;
    return;
  }
  if (!schedulerHealthy(sh) || pendingClaim(sh, pod)) return;
  const nodes = feasibleNodes(sh, pod);
  if (!nodes.length) return;
  const load = (n: string) => sh.state.pods.filter((p) => p.node === n).length;
  const node = [...nodes].sort((a, b) => load(a.name) - load(b.name))[0];
  pod.node = node.name;
  pod.scheduledAt = at;
};

/** Called before every command: binds pending pods when possible and applies etcd restores. */
export const tick = (sh: Shell) => {
  applyEtcdRestore(sh);
  for (const p of sh.state.pods) if (!p.node) schedule(sh, p);
};

// ---------- config refs ----------
const missingRefs = (sh: Shell, pod: Pod): string | null => {
  for (const c of pod.spec.containers) {
    for (const ef of c.envFrom ?? []) {
      if (ef.configMapRef && !findObj(sh, "ConfigMap", ef.configMapRef.name, pod.namespace)) return `configmap "${ef.configMapRef.name}" not found`;
      if (ef.secretRef && !findObj(sh, "Secret", ef.secretRef.name, pod.namespace)) return `secret "${ef.secretRef.name}" not found`;
    }
    for (const e of c.env ?? []) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const vf = e.valueFrom as any;
      if (vf?.configMapKeyRef) {
        const cm = findObj(sh, "ConfigMap", vf.configMapKeyRef.name, pod.namespace);
        if (!cm) return `configmap "${vf.configMapKeyRef.name}" not found`;
        if (!(vf.configMapKeyRef.key in (cm.manifest.data ?? {}))) return `couldn't find key ${vf.configMapKeyRef.key} in ConfigMap ${pod.namespace}/${vf.configMapKeyRef.name}`;
      }
      if (vf?.secretKeyRef) {
        const s = findObj(sh, "Secret", vf.secretKeyRef.name, pod.namespace);
        if (!s) return `secret "${vf.secretKeyRef.name}" not found`;
        if (!(vf.secretKeyRef.key in (s.manifest.data ?? {}))) return `couldn't find key ${vf.secretKeyRef.key} in Secret ${pod.namespace}/${vf.secretKeyRef.name}`;
      }
    }
  }
  return null;
};

const missingVolume = (sh: Shell, pod: Pod): string | null => {
  for (const v of pod.spec.volumes ?? []) {
    if (v.configMap && !findObj(sh, "ConfigMap", v.configMap.name, pod.namespace)) return `configmap "${v.configMap.name}" not found`;
    if (v.secret && !findObj(sh, "Secret", v.secret.secretName, pod.namespace)) return `secret "${v.secret.secretName}" not found`;
  }
  return null;
};

// ---------- probes ----------
export const containerPort = (c: Container) => c.ports?.[0]?.containerPort ?? defaultPort(c.image);

export const probeResult = (c: Container, probe?: Container["readinessProbe"]): { ok: boolean; reason?: string } => {
  if (!probe) return { ok: true };
  const port = probe.httpGet?.port ?? probe.tcpSocket?.port;
  const expected = containerPort(c);
  if (port !== undefined && Number(port) !== expected)
    return { ok: false, reason: `${probe.httpGet ? "Get" : "dial tcp"} "http://10.244.1.5:${port}${probe.httpGet?.path ?? ""}": dial tcp 10.244.1.5:${port}: connect: connection refused` };
  if (probe.httpGet?.path && /nginx|httpd/.test(c.image) && !["/", "/index.html"].includes(probe.httpGet.path))
    return { ok: false, reason: `HTTP probe failed with statuscode: 404` };
  if (probe.exec?.command?.join(" ").includes("/tmp/healthy") && !(c.command ?? []).concat(c.args ?? []).join(" ").includes("touch /tmp/healthy"))
    return { ok: false, reason: "cat: can't open '/tmp/healthy': No such file or directory" };
  return { ok: true };
};

const cmdline = (c: Container) => [...(c.command ?? []), ...(c.args ?? [])].join(" ");
const crashes = (pod: Pod, c: Container) => {
  const cl = cmdline(c);
  if (/exit [1-9]/.test(cl)) return true;
  if (pod.ownerKind === "Job") return false;
  if (SHORT_LIVED.test(c.image) && !/sleep|while|tail -f|httpd|nc -l|http\.server|serve/.test(cl)) return true;
  return false;
};

// ---------- static pods ----------
const STATIC = ["etcd", "kube-apiserver", "kube-controller-manager", "kube-scheduler"] as const;
export type StaticComponent = (typeof STATIC)[number];

export const controlPlaneVersion = (sh: Shell) => sh.ext("controlPlane", () => ({ version: "v1.30.0" })).version;

export const staticManifest = (sh: Shell, comp: StaticComponent) => sh.readFile(`/etc/kubernetes/manifests/${comp}.yaml`);

export const staticComponentStatus = (sh: Shell, comp: StaticComponent): { ok: boolean; status: string; reason?: string; logs?: string } => {
  const raw = staticManifest(sh, comp);
  if (raw === undefined) return { ok: false, status: "Missing", reason: `/etc/kubernetes/manifests/${comp}.yaml não existe` };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let m: any;
  try {
    m = YAML.parse(raw);
  } catch {
    return { ok: false, status: "Missing", reason: "manifest YAML inválido" };
  }
  const c = m?.spec?.containers?.[0];
  if (!c) return { ok: false, status: "Missing", reason: "manifest sem containers" };
  const img: string = c.image ?? "";
  if (!validImage(img) || !img.startsWith(`registry.k8s.io/${comp}:`)) return { ok: false, status: "ImagePullBackOff", reason: `Failed to pull image "${img}": not found` };
  const cmd: string[] = c.command ?? [];
  if (cmd[0] !== comp)
    return { ok: false, status: "CrashLoopBackOff", reason: `Error: failed to create containerd task: failed to create shim task: OCI runtime create failed: exec: "${cmd[0]}": executable file not found in $PATH: unknown` };
  if (comp === "kube-scheduler") {
    const kc = cmd.find((x) => x.startsWith("--kubeconfig="))?.split("=")[1];
    if (kc !== "/etc/kubernetes/scheduler.conf")
      return { ok: false, status: "CrashLoopBackOff", logs: `E0923 12:01:44.118273       1 run.go:74] "command failed" err="stat ${kc}: no such file or directory"` };
  }
  return { ok: true, status: "Running" };
};

// ---------- status ----------
export const podStatus = (sh: Shell, p: Pod): string => {
  if (p.fixedStatus) return p.fixedStatus;
  if (p.ownerKind === "Static") {
    const comp = STATIC.find((c) => p.name.startsWith(c + "-"));
    return comp ? staticComponentStatus(sh, comp).status : "Running";
  }
  if (!p.node) return "Pending";
  const since = Date.now() - (p.scheduledAt ?? p.createdAt);
  const bad = p.spec.containers.find((c) => !validImage(c.image));
  if (bad) return since < 4000 ? "ErrImagePull" : "ImagePullBackOff";
  if (missingVolume(sh, p)) return "ContainerCreating";
  if (missingRefs(sh, p)) return "CreateContainerConfigError";
  if (since < 2500) return (p.spec.initContainers?.length ? "Init:0/1" : "ContainerCreating");
  const main = p.spec.containers[0];
  if (p.ownerKind === "Job" || p.spec.restartPolicy === "Never" || p.spec.restartPolicy === "OnFailure") {
    const finite = SHORT_LIVED.test(main.image) && !/sleep [0-9]{4,}|sleep infinity|while true/.test(cmdline(main));
    if (finite && since > 4000) return /exit [1-9]/.test(cmdline(main)) ? "Error" : "Completed";
  }
  if (p.spec.containers.some((c) => crashes(p, c))) return since < 6000 ? "Error" : "CrashLoopBackOff";
  return "Running";
};

export const podRestarts = (sh: Shell, p: Pod) => {
  const since = Date.now() - (p.scheduledAt ?? p.createdAt);
  const st = podStatus(sh, p);
  // back-off grows to 5 minutes, so restarts grow fast at first and slowly afterwards
  if (st === "CrashLoopBackOff" || st === "Error") return Math.max(1, Math.min(Math.floor(since / 15000) + (st === "CrashLoopBackOff" ? 1 : 0), 6 + Math.floor(since / 300000)));
  if (st === "Running" && p.spec.containers.some((c) => !probeResult(c, c.livenessProbe).ok)) return Math.floor(since / 12000);
  return p.restarts;
};

export const containerReady = (sh: Shell, p: Pod, c: Container) =>
  podStatus(sh, p) === "Running" && probeResult(c, c.readinessProbe).ok && probeResult(c, c.livenessProbe).ok;

export const podReady = (sh: Shell, p: Pod) => podStatus(sh, p) === "Running" && p.spec.containers.every((c) => containerReady(sh, p, c));

export const readyCount = (sh: Shell, p: Pod) => `${p.spec.containers.filter((c) => containerReady(sh, p, c)).length}/${p.spec.containers.length}`;

export const podEventsProblem = (sh: Shell, p: Pod): string | null => missingRefs(sh, p) ?? missingVolume(sh, p);

// ---------- deployments ----------
export const syncImage = (d: Deployment) => {
  d.image = d.template.spec.containers[0]?.image ?? "";
};

export const createDeployment = (
  sh: Shell,
  opts: { name: string; image?: string; replicas?: number; namespace?: string; template?: Deployment["template"]; labels?: Record<string, string>; createdAt?: number },
): Deployment => {
  const labels = opts.labels ?? { app: opts.name };
  // Container is named after the deployment so "kubectl set image deployment/x x=img" works.
  const template = opts.template ?? { labels: { ...labels }, spec: simplePodSpec(opts.name, opts.image!) };
  const d: Deployment = {
    name: opts.name,
    namespace: opts.namespace ?? "default",
    replicas: opts.replicas ?? 1,
    createdAt: opts.createdAt ?? Date.now(),
    revision: 1,
    labels,
    selector: { ...template.labels },
    template,
    history: [],
    image: "",
  };
  syncImage(d);
  d.history.push({ revision: 1, image: d.image, template: JSON.stringify(d.template) });
  sh.state.deployments.push(d);
  reconcile(sh, d.createdAt);
  return d;
};

/** Records a new revision after the pod template changed. */
export const bumpRevision = (d: Deployment) => {
  syncImage(d);
  d.revision++;
  d.history.push({ revision: d.revision, image: d.image, template: JSON.stringify(d.template) });
};

export const findDeployment = (sh: Shell, name: string, ns = "default") => sh.state.deployments.find((d) => d.name === name && d.namespace === ns);

const templateKey = (t: Deployment["template"]) => JSON.stringify(t);

export const reconcile = (sh: Shell, createdAt = Date.now()) => {
  for (const d of sh.state.deployments) {
    const key = templateKey(d.template);
    let owned = sh.state.pods.filter((p) => p.ownerKind === "Deployment" && p.owner === d.name && p.namespace === d.namespace);
    const stale = owned.filter((p) => (p as Pod & { tpl?: string }).tpl !== key);
    if (stale.length) {
      sh.state.pods = sh.state.pods.filter((p) => !stale.includes(p));
      owned = owned.filter((p) => !stale.includes(p));
    }
    const rsHash = (d as Deployment & { rs?: Record<string, string> }).rs?.[key] ?? rand(10).slice(0, 9);
    (d as Deployment & { rs?: Record<string, string> }).rs = { ...((d as Deployment & { rs?: Record<string, string> }).rs ?? {}), [key]: rsHash };
    while (owned.length < d.replicas) {
      const pod = newPod(sh, {
        name: `${d.name}-${rsHash}-${rand(5)}`,
        namespace: d.namespace,
        labels: { ...d.template.labels, "pod-template-hash": rsHash },
        spec: d.template.spec,
        owner: d.name,
        ownerKind: "Deployment",
        createdAt,
      });
      (pod as Pod & { tpl?: string }).tpl = key;
      owned.push(pod);
    }
    while (owned.length > d.replicas) {
      const victim = owned.pop()!;
      sh.state.pods = sh.state.pods.filter((p) => p !== victim);
    }
  }
  const alive = new Set(sh.state.deployments.map((d) => `${d.namespace}/${d.name}`));
  sh.state.pods = sh.state.pods.filter((p) => p.ownerKind !== "Deployment" || alive.has(`${p.namespace}/${p.owner}`));
};

export const deploymentReady = (sh: Shell, name: string, ns = "default") => {
  const d = findDeployment(sh, name, ns);
  if (!d) return false;
  const pods = sh.state.pods.filter((p) => p.ownerKind === "Deployment" && p.owner === name && p.namespace === ns);
  return pods.length === d.replicas && pods.every((p) => podReady(sh, p));
};

// ---------- jobs ----------
export const spawnJobPods = (sh: Shell, job: K8sObject) => {
  const tpl = job.manifest.spec?.template ?? {};
  const completions = job.manifest.spec?.completions ?? 1;
  const parallel = Math.min(job.manifest.spec?.parallelism ?? 1, completions);
  for (let i = 0; i < Math.max(parallel, completions); i++)
    newPod(sh, {
      name: `${job.name}-${rand(5)}`,
      namespace: job.namespace,
      labels: { "job-name": job.name, ...(tpl.metadata?.labels ?? {}) },
      spec: { restartPolicy: "Never", ...tpl.spec },
      owner: job.name,
      ownerKind: "Job",
      createdAt: job.createdAt,
    });
};

export const jobCompletions = (sh: Shell, job: K8sObject) => {
  const pods = sh.state.pods.filter((p) => p.ownerKind === "Job" && p.owner === job.name && p.namespace === job.namespace);
  return { done: pods.filter((p) => podStatus(sh, p) === "Completed").length, total: job.manifest.spec?.completions ?? 1 };
};

// ---------- services ----------
export const createService = (
  sh: Shell,
  opts: { name: string; namespace?: string; type?: Service["type"]; port: number; targetPort?: number; nodePort?: number; selector: Record<string, string> },
): Service => {
  const type = opts.type ?? "ClusterIP";
  const svc: Service = {
    name: opts.name,
    namespace: opts.namespace ?? "default",
    type,
    port: opts.port,
    targetPort: opts.targetPort ?? opts.port,
    clusterIP: nextClusterIp(),
    nodePort: type === "ClusterIP" ? undefined : opts.nodePort ?? 30000 + Math.floor(Math.random() * 2767),
    selector: opts.selector,
    createdAt: Date.now(),
  };
  sh.state.services.push(svc);
  return svc;
};

export const findService = (sh: Shell, name: string, ns = "default") => sh.state.services.find((s) => s.name === name && s.namespace === ns);

export const endpoints = (sh: Shell, svc: Service) =>
  sh.state.pods.filter((p) => p.namespace === svc.namespace && matchLabels(svc.selector, p.labels) && podReady(sh, p));

// ---------- storage ----------
const toGi = (q: string) => {
  const m = /^(\d+(?:\.\d+)?)(Mi|Gi|Ti|M|G)?$/.exec(q ?? "");
  if (!m) return 0;
  const n = Number(m[1]);
  return m[2] === "Mi" || m[2] === "M" ? n / 1024 : m[2] === "Ti" ? n * 1024 : n;
};

export const pvcStatus = (sh: Shell, name: string, ns = "default"): { status: string; volume?: string; reason?: string } => {
  const pvc = findObj(sh, "PersistentVolumeClaim", name, ns);
  if (!pvc) return { status: "Missing" };
  const spec = pvc.manifest.spec ?? {};
  const want = toGi(spec.resources?.requests?.storage);
  const modes: string[] = spec.accessModes ?? [];
  const sc = spec.storageClassName ?? "";
  const claimed = new Set(
    objsOf(sh, "PersistentVolumeClaim", null)
      .filter((o) => o !== pvc)
      .map((o) => (o as K8sObject & { boundTo?: string }).boundTo),
  );
  const pv = objsOf(sh, "PersistentVolume").find((v) => {
    const s = v.manifest.spec ?? {};
    return !claimed.has(v.name) && (s.storageClassName ?? "") === sc && toGi(s.capacity?.storage) >= want && modes.every((m) => (s.accessModes ?? []).includes(m));
  });
  if (pv) {
    (pvc as K8sObject & { boundTo?: string }).boundTo = pv.name;
    return { status: "Bound", volume: pv.name };
  }
  if (sc === "standard") return { status: "Bound", volume: `pvc-${rand(8)}` };
  return { status: "Pending", reason: "no persistent volumes available for this claim and no storage class is set" };
};

// ---------- RBAC ----------
type Rule = { verbs: string[]; resources: string[] };
const BUILTIN_CLUSTER_ROLES: Record<string, Rule[]> = {
  "cluster-admin": [{ verbs: ["*"], resources: ["*"] }],
  admin: [{ verbs: ["*"], resources: ["*"] }],
  edit: [{ verbs: ["get", "list", "watch", "create", "update", "patch", "delete"], resources: ["*"] }],
  view: [{ verbs: ["get", "list", "watch"], resources: ["*"] }],
};
const rulesOf = (o?: K8sObject): Rule[] => (o?.manifest.rules ?? []).map((r: Rule) => ({ verbs: r.verbs ?? [], resources: r.resources ?? [] }));

export const can = (sh: Shell, subject: string | undefined, verb: string, resource: string, ns = "default"): boolean => {
  if (!subject) return true; // cluster-admin
  const subjects = (b: K8sObject) => (b.manifest.subjects ?? []) as { kind: string; name: string; namespace?: string }[];
  const isMe = (s: { kind: string; name: string; namespace?: string }) =>
    subject.startsWith("system:serviceaccount:")
      ? s.kind === "ServiceAccount" && `system:serviceaccount:${s.namespace ?? ns}:${s.name}` === subject
      : s.kind === "User" && s.name === subject;
  const bindings = [
    ...objsOf(sh, "RoleBinding", ns).filter((b) => subjects(b).some(isMe)),
    ...objsOf(sh, "ClusterRoleBinding").filter((b) => subjects(b).some(isMe)),
  ];
  const res = resource.split("/")[0].toLowerCase();
  return bindings.some((b) => {
    const ref = b.manifest.roleRef ?? {};
    const role = ref.kind === "ClusterRole" ? findObj(sh, "ClusterRole", ref.name) : findObj(sh, "Role", ref.name, b.namespace);
    const rules = role ? rulesOf(role) : ref.kind === "ClusterRole" ? BUILTIN_CLUSTER_ROLES[ref.name] ?? [] : [];
    return rules.some(
      (r) => (r.verbs.includes("*") || r.verbs.includes(verb)) && (r.resources.includes("*") || r.resources.includes(res) || r.resources.includes(res.replace(/s$/, ""))),
    );
  });
};

// ---------- NetworkPolicy ----------
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const selects = (sel: any, labels: Record<string, string>) => !sel || !sel.matchLabels || Object.keys(sel.matchLabels).length === 0 || matchLabels(sel.matchLabels, labels);

export const nsLabels = (sh: Shell, ns: string): Record<string, string> => {
  const o = findObj(sh, "Namespace", ns);
  return { "kubernetes.io/metadata.name": ns, ...(o?.manifest.metadata?.labels ?? {}) };
};

/** Whether traffic from `from` (a pod, or null for node/host traffic) may reach `to` on `port`. */
export const trafficAllowed = (sh: Shell, from: Pod | null, to: Pod, port: number) => {
  const policies = objsOf(sh, "NetworkPolicy", to.namespace).filter((np) => {
    const spec = np.manifest.spec ?? {};
    const types: string[] = spec.policyTypes ?? (spec.ingress ? ["Ingress"] : ["Ingress"]);
    return types.includes("Ingress") && selects(spec.podSelector, to.labels);
  });
  if (!policies.length) return true;
  return policies.some((np) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (np.manifest.spec.ingress ?? []).some((rule: any) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const portOk = !rule.ports?.length || rule.ports.some((p: any) => Number(p.port) === port);
      if (!portOk) return false;
      if (!rule.from?.length) return true;
      if (!from) return false;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return rule.from.some((f: any) => {
        const podOk = f.podSelector ? selects(f.podSelector, from.labels) : true;
        const nsOk = f.namespaceSelector ? selects(f.namespaceSelector, nsLabels(sh, from.namespace)) : from.namespace === to.namespace;
        return (f.podSelector || f.namespaceSelector) && podOk && nsOk;
      });
    }),
  );
};

// ---------- etcd snapshot / restore ----------
type EtcdState = { dataDir: string; snapshots: Record<string, string>; restored: Record<string, string> };
export const etcdState = (sh: Shell) => sh.ext<EtcdState>("etcd", () => ({ dataDir: "/var/lib/etcd", snapshots: {}, restored: {} }));

export const serializeCluster = (sh: Shell) =>
  JSON.stringify({
    deployments: sh.state.deployments,
    services: sh.state.services,
    objects: sh.state.objects,
    namespaces: sh.state.namespaces,
    pods: sh.state.pods.filter((p) => p.ownerKind !== "Static"),
  });

const etcdDataDir = (sh: Shell) => {
  const raw = staticManifest(sh, "etcd");
  if (!raw) return undefined;
  try {
    const m = YAML.parse(raw);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const vol = (m?.spec?.volumes ?? []).find((v: any) => v.name === "etcd-data");
    return vol?.hostPath?.path as string | undefined;
  } catch {
    return undefined;
  }
};

const applyEtcdRestore = (sh: Shell) => {
  const st = etcdState(sh);
  const dir = etcdDataDir(sh);
  if (!dir || dir === st.dataDir || !st.restored[dir]) return;
  const snap = JSON.parse(st.restored[dir]);
  const statics = sh.state.pods.filter((p) => p.ownerKind === "Static");
  Object.assign(sh.state, { deployments: snap.deployments, services: snap.services, objects: snap.objects, namespaces: snap.namespaces });
  sh.state.pods = [...statics, ...snap.pods];
  st.dataDir = dir;
};

// ---------- manifests ----------
export const staticPodYaml = (comp: StaticComponent, version = "v1.30.0", overrides: { command?: string[]; image?: string; dataDir?: string } = {}) => {
  const commands: Record<StaticComponent, string[]> = {
    etcd: ["etcd", "--advertise-client-urls=https://172.18.0.2:2379", "--cert-file=/etc/kubernetes/pki/etcd/server.crt", "--data-dir=/var/lib/etcd", "--key-file=/etc/kubernetes/pki/etcd/server.key", "--listen-client-urls=https://127.0.0.1:2379,https://172.18.0.2:2379", "--trusted-ca-file=/etc/kubernetes/pki/etcd/ca.crt"],
    "kube-apiserver": ["kube-apiserver", "--advertise-address=172.18.0.2", "--authorization-mode=Node,RBAC", "--etcd-servers=https://127.0.0.1:2379", "--secure-port=6443", "--service-cluster-ip-range=10.96.0.0/16"],
    "kube-controller-manager": ["kube-controller-manager", "--kubeconfig=/etc/kubernetes/controller-manager.conf", "--leader-elect=true", "--cluster-cidr=10.244.0.0/16"],
    "kube-scheduler": ["kube-scheduler", "--authentication-kubeconfig=/etc/kubernetes/scheduler.conf", "--authorization-kubeconfig=/etc/kubernetes/scheduler.conf", "--bind-address=127.0.0.1", "--kubeconfig=/etc/kubernetes/scheduler.conf", "--leader-elect=true"],
  };
  const image = overrides.image ?? (comp === "etcd" ? "registry.k8s.io/etcd:3.5.12-0" : `registry.k8s.io/${comp}:${version}`);
  const doc = {
    apiVersion: "v1",
    kind: "Pod",
    metadata: { labels: { component: comp, tier: "control-plane" }, name: comp, namespace: "kube-system" },
    spec: {
      containers: [{ command: overrides.command ?? commands[comp], image, imagePullPolicy: "IfNotPresent", name: comp }],
      hostNetwork: true,
      priorityClassName: "system-node-critical",
      ...(comp === "etcd" ? { volumes: [{ hostPath: { path: "/etc/kubernetes/pki/etcd", type: "DirectoryOrCreate" }, name: "etcd-certs" }, { hostPath: { path: overrides.dataDir ?? "/var/lib/etcd", type: "DirectoryOrCreate" }, name: "etcd-data" }] } : {}),
    },
  };
  return YAML.stringify(doc);
};
