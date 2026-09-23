// Converts cluster objects to/from Kubernetes manifests (YAML/JSON) and applies manifests.
import type { Shell } from "../shell";
import type { Deployment, NodeState, Pod, PodSpec, Service } from "../types";
import {
  CLUSTER_SCOPED, bumpRevision, containerReady, createDeployment, createService, deleteObj, findDeployment, findObj, findService,
  newPod, nodeReady, nsExists, podRestarts, podStatus, pvcStatus, reconcile, upsertObj,
} from "./cluster";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const ts = (t: number) => new Date(t).toISOString().replace(/\.\d+Z$/, "Z");

export const KIND_API: Record<string, string> = {
  Pod: "v1", Service: "v1", ConfigMap: "v1", Secret: "v1", Namespace: "v1", ServiceAccount: "v1", PersistentVolume: "v1",
  PersistentVolumeClaim: "v1", ResourceQuota: "v1", LimitRange: "v1", Node: "v1",
  Deployment: "apps/v1", DaemonSet: "apps/v1", StatefulSet: "apps/v1", ReplicaSet: "apps/v1",
  Job: "batch/v1", CronJob: "batch/v1",
  Role: "rbac.authorization.k8s.io/v1", ClusterRole: "rbac.authorization.k8s.io/v1",
  RoleBinding: "rbac.authorization.k8s.io/v1", ClusterRoleBinding: "rbac.authorization.k8s.io/v1",
  NetworkPolicy: "networking.k8s.io/v1", Ingress: "networking.k8s.io/v1", StorageClass: "storage.k8s.io/v1",
  HorizontalPodAutoscaler: "autoscaling/v2",
};

// ---------- to manifest ----------
export const podManifest = (sh: Shell, p: Pod, dryRun = false): Json => {
  const base: Json = {
    apiVersion: "v1",
    kind: "Pod",
    metadata: { ...(dryRun ? { creationTimestamp: null } : { creationTimestamp: ts(p.createdAt) }), labels: p.labels, name: p.name, ...(p.namespace !== "default" || !dryRun ? { namespace: p.namespace } : {}) },
    spec: { ...p.spec, containers: p.spec.containers.map((c) => ({ ...c, resources: c.resources ?? {} })), ...(p.node && !dryRun ? { nodeName: p.node } : {}), restartPolicy: p.spec.restartPolicy ?? (dryRun ? "Always" : "Always") },
    status: dryRun ? {} : undefined,
  };
  if (!dryRun) {
    const st = podStatus(sh, p);
    base.status = {
      phase: st === "Running" ? "Running" : st === "Completed" ? "Succeeded" : st === "Error" ? "Failed" : "Pending",
      hostIP: p.node ? sh.state.nodes.find((n) => n.name === p.node)?.ip : undefined,
      podIP: st === "Running" ? p.ip : undefined,
      containerStatuses: p.spec.containers.map((c) => ({ name: c.name, image: c.image, ready: containerReady(sh, p, c), restartCount: podRestarts(sh, p), state: st === "Running" ? { running: { startedAt: ts(p.scheduledAt ?? p.createdAt) } } : { waiting: { reason: st } } })),
    };
  }
  return base;
};

export const deploymentManifest = (sh: Shell, d: Deployment, dryRun = false): Json => {
  const pods = sh.state.pods.filter((p) => p.ownerKind === "Deployment" && p.owner === d.name && p.namespace === d.namespace);
  const ready = pods.filter((p) => podStatus(sh, p) === "Running" && p.spec.containers.every((c) => containerReady(sh, p, c))).length;
  return {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: { ...(dryRun ? { creationTimestamp: null } : { creationTimestamp: ts(d.createdAt), generation: d.revision }), labels: d.labels, name: d.name, ...(dryRun && d.namespace === "default" ? {} : { namespace: d.namespace }), ...(dryRun ? {} : { annotations: { "deployment.kubernetes.io/revision": String(d.revision) } }) },
    spec: {
      replicas: d.replicas,
      selector: { matchLabels: d.selector },
      strategy: dryRun ? {} : { rollingUpdate: { maxSurge: "25%", maxUnavailable: "25%" }, type: "RollingUpdate" },
      template: { metadata: { ...(dryRun ? { creationTimestamp: null } : {}), labels: d.template.labels }, spec: { ...d.template.spec, containers: d.template.spec.containers.map((c) => ({ ...c, resources: c.resources ?? {} })) } },
    },
    status: dryRun ? {} : { availableReplicas: ready, readyReplicas: ready, replicas: pods.length, updatedReplicas: pods.length },
  };
};

export const serviceManifest = (s: Service, dryRun = false): Json => ({
  apiVersion: "v1",
  kind: "Service",
  metadata: { ...(dryRun ? { creationTimestamp: null } : { creationTimestamp: ts(s.createdAt) }), labels: s.selector, name: s.name, ...(dryRun && s.namespace === "default" ? {} : { namespace: s.namespace }) },
  spec: {
    ...(dryRun ? {} : { clusterIP: s.clusterIP }),
    ports: [{ port: s.port, protocol: "TCP", targetPort: s.targetPort, ...(s.nodePort && !dryRun ? { nodePort: s.nodePort } : {}) }],
    selector: s.selector,
    type: s.type,
  },
  status: { loadBalancer: {} },
});

export const nodeManifest = (sh: Shell, n: NodeState): Json => ({
  apiVersion: "v1",
  kind: "Node",
  metadata: { labels: n.labels, name: n.name },
  spec: { ...(n.taints.length ? { taints: n.taints } : {}), ...(n.schedulable ? {} : { unschedulable: true }) },
  status: {
    addresses: [{ address: n.ip, type: "InternalIP" }, { address: n.name, type: "Hostname" }],
    capacity: { cpu: "4", memory: "8131016Ki", pods: "110" },
    conditions: [{ type: "Ready", status: nodeReady(sh, n.name) ? "True" : "Unknown" }],
    nodeInfo: { kubeletVersion: n.version, containerRuntimeVersion: "containerd://1.7.18", osImage: "Debian GNU/Linux 12 (bookworm)" },
  },
});

export const objectManifest = (sh: Shell, o: { kind: string; name: string; namespace?: string; manifest: Json; createdAt: number }): Json => {
  const m = structuredClone(o.manifest);
  m.apiVersion = m.apiVersion ?? KIND_API[o.kind] ?? "v1";
  m.kind = o.kind;
  m.metadata = { ...(m.metadata ?? {}), name: o.name, ...(o.namespace ? { namespace: o.namespace } : {}), creationTimestamp: ts(o.createdAt) };
  if (o.kind === "PersistentVolumeClaim") {
    const st = pvcStatus(sh, o.name, o.namespace);
    m.status = { phase: st.status };
    if (st.volume) m.spec = { ...m.spec, volumeName: st.volume };
  }
  return m;
};

// ---------- from manifest ----------
const toPodSpec = (spec: Json): PodSpec => ({ ...spec, containers: spec?.containers ?? [] });

const validatePodSpec = (spec: Json, where: string): string | null => {
  if (!Array.isArray(spec?.containers) || !spec.containers.length) return `The ${where} is invalid: spec.containers: Required value`;
  for (const [i, c] of spec.containers.entries()) {
    if (!c.name) return `The ${where} is invalid: spec.containers[${i}].name: Required value`;
    if (!c.image) return `The ${where} is invalid: spec.containers[${i}].image: Required value`;
  }
  return null;
};

const plural = (kind: string) => kind.toLowerCase() + (kind.endsWith("s") ? "es" : kind.endsWith("y") ? "" : "s");
const kindRef = (kind: string) => (["Deployment", "DaemonSet", "StatefulSet", "ReplicaSet"].includes(kind) ? `${kind.toLowerCase()}.apps` : ["Job", "CronJob"].includes(kind) ? `${kind.toLowerCase()}.batch` : ["Role", "ClusterRole", "RoleBinding", "ClusterRoleBinding"].includes(kind) ? `${kind.toLowerCase()}.rbac.authorization.k8s.io` : ["NetworkPolicy", "Ingress"].includes(kind) ? `${kind.toLowerCase()}.networking.k8s.io` : kind.toLowerCase());

export type ApplyMode = "apply" | "create" | "replace";

/** Applies one manifest document. Returns the kubectl output line (or an error). */
export const applyManifest = (sh: Shell, doc: Json, mode: ApplyMode, defaultNs = "default"): string => {
  if (!doc || typeof doc !== "object") return "error: error validating data: invalid object";
  const kind: string = doc.kind;
  const name: string | undefined = doc.metadata?.name;
  if (!kind) return `error: error validating data: kind not set`;
  if (!name) return `error: error when retrieving current configuration: resource name may not be empty`;
  const ns: string = CLUSTER_SCOPED.has(kind) ? "" : doc.metadata?.namespace ?? defaultNs;
  if (ns && !nsExists(sh, ns) && kind !== "Namespace") return `Error from server (NotFound): error when creating: namespaces "${ns}" not found`;
  const ref = kindRef(kind);
  const exists = (() => {
    if (kind === "Pod") return !!sh.state.pods.find((p) => p.name === name && p.namespace === ns);
    if (kind === "Deployment") return !!findDeployment(sh, name, ns);
    if (kind === "Service") return !!findService(sh, name, ns);
    if (kind === "Namespace") return nsExists(sh, name);
    return !!findObj(sh, kind, name, ns || undefined);
  })();
  if (mode === "create" && exists) return `Error from server (AlreadyExists): error when creating: ${plural(kind)} "${name}" already exists`;
  if (mode === "replace" && exists) deleteAny(sh, kind, name, ns);
  const verb = (created: boolean, changed = true) => (mode === "replace" ? "replaced" : created ? "created" : changed ? "configured" : "unchanged");

  switch (kind) {
    case "Namespace": {
      if (!nsExists(sh, name)) sh.state.namespaces.push({ name, createdAt: Date.now() });
      upsertObj(sh, { kind, name, manifest: doc });
      return `namespace/${name} ${verb(!exists, false)}`;
    }
    case "Pod": {
      const err = validatePodSpec(doc.spec, `Pod "${name}"`);
      if (err) return err;
      const existing = sh.state.pods.find((p) => p.name === name && p.namespace === ns);
      if (existing && mode !== "replace") {
        const next = toPodSpec(doc.spec);
        const onlyImage =
          JSON.stringify(next.containers.map((c) => ({ ...c, image: "" }))) === JSON.stringify(existing.spec.containers.map((c) => ({ ...c, image: "" }))) &&
          JSON.stringify({ ...next, containers: [] }) === JSON.stringify({ ...existing.spec, containers: [] });
        if (JSON.stringify(next) === JSON.stringify(existing.spec)) return `pod/${name} unchanged`;
        if (!onlyImage)
          return `The Pod "${name}" is invalid: spec: Forbidden: pod updates may not change fields other than \`spec.containers[*].image\`,\`spec.initContainers[*].image\`,\`spec.activeDeadlineSeconds\`,\`spec.tolerations\` (only additions to existing tolerations),\`spec.terminationGracePeriodSeconds\` (allow it to be set to 1 if it was previously negative)`;
        existing.spec = next;
        existing.image = next.containers[0].image;
        existing.scheduledAt = Date.now();
        return `pod/${name} configured`;
      }
      newPod(sh, { name, namespace: ns, labels: doc.metadata?.labels ?? {}, spec: toPodSpec(doc.spec) });
      return `pod/${name} ${verb(true)}`;
    }
    case "Deployment": {
      const spec = doc.spec ?? {};
      const tpl = spec.template ?? {};
      const err = validatePodSpec(tpl.spec, `Deployment.apps "${name}"`);
      if (err) return err;
      const selector = spec.selector?.matchLabels ?? {};
      const labels = tpl.metadata?.labels ?? {};
      if (!Object.keys(selector).length) return `The Deployment "${name}" is invalid: spec.selector: Required value`;
      if (!Object.entries(selector).every(([k, v]) => labels[k] === v))
        return `The Deployment "${name}" is invalid: spec.template.metadata.labels: Invalid value: ${JSON.stringify(labels)}: \`selector\` does not match template \`labels\``;
      const d = findDeployment(sh, name, ns);
      const template = { labels, spec: toPodSpec(tpl.spec) };
      if (!d) {
        createDeployment(sh, { name, namespace: ns, replicas: spec.replicas ?? 1, template, labels: doc.metadata?.labels ?? labels });
        return `deployment.apps/${name} ${verb(true)}`;
      }
      const changedTpl = JSON.stringify(d.template) !== JSON.stringify(template);
      const changed = changedTpl || d.replicas !== (spec.replicas ?? 1);
      d.template = template;
      d.replicas = spec.replicas ?? 1;
      if (changedTpl) bumpRevision(d);
      reconcile(sh);
      return `deployment.apps/${name} ${verb(false, changed)}`;
    }
    case "Service": {
      const spec = doc.spec ?? {};
      const port = spec.ports?.[0];
      if (!port?.port) return `The Service "${name}" is invalid: spec.ports: Required value`;
      const existing = findService(sh, name, ns);
      if (existing) {
        existing.type = spec.type ?? "ClusterIP";
        existing.port = Number(port.port);
        existing.targetPort = Number(port.targetPort ?? port.port);
        existing.selector = spec.selector ?? {};
        if (existing.type !== "ClusterIP") existing.nodePort = port.nodePort ?? existing.nodePort ?? 30000 + Math.floor(Math.random() * 2767);
        return `service/${name} configured`;
      }
      createService(sh, { name, namespace: ns, type: spec.type, port: Number(port.port), targetPort: Number(port.targetPort ?? port.port), nodePort: port.nodePort, selector: spec.selector ?? {} });
      return `service/${name} ${verb(true)}`;
    }
    default: {
      if (!KIND_API[kind]) return `error: resource mapping not found for name: "${name}" namespace: "${ns}" from "STDIN": no matches for kind "${kind}" in version "${doc.apiVersion}"`;
      if (kind === "Secret" && doc.stringData) {
        doc.data = { ...(doc.data ?? {}), ...Object.fromEntries(Object.entries(doc.stringData).map(([k, v]) => [k, btoa(String(v))])) };
        delete doc.stringData;
      }
      const r = upsertObj(sh, { kind, name, namespace: ns || undefined, manifest: doc });
      return `${ref}/${name} ${mode === "replace" ? "replaced" : r}`;
    }
  }
};

export const deleteAny = (sh: Shell, kind: string, name: string, ns: string): boolean => {
  switch (kind) {
    case "Pod": {
      const p = sh.state.pods.find((x) => x.name === name && x.namespace === ns);
      if (!p) return false;
      sh.state.pods = sh.state.pods.filter((x) => x !== p);
      reconcile(sh);
      return true;
    }
    case "Deployment": {
      if (!findDeployment(sh, name, ns)) return false;
      sh.state.deployments = sh.state.deployments.filter((d) => !(d.name === name && d.namespace === ns));
      reconcile(sh);
      return true;
    }
    case "Service": {
      if (!findService(sh, name, ns)) return false;
      sh.state.services = sh.state.services.filter((s) => !(s.name === name && s.namespace === ns));
      return true;
    }
    case "Namespace": {
      if (!nsExists(sh, name)) return false;
      sh.state.namespaces = sh.state.namespaces.filter((n) => n.name !== name);
      sh.state.pods = sh.state.pods.filter((p) => p.namespace !== name);
      sh.state.deployments = sh.state.deployments.filter((d) => d.namespace !== name);
      sh.state.services = sh.state.services.filter((s) => s.namespace !== name);
      sh.state.objects = sh.state.objects.filter((o) => o.namespace !== name && !(o.kind === "Namespace" && o.name === name));
      return true;
    }
    default:
      return deleteObj(sh, kind, name, ns || undefined);
  }
};

export { kindRef, plural };
