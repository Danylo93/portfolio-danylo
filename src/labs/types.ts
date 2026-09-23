import type { Shell } from "./shell";

// ---------------- Kubernetes model ----------------
export type Container = {
  name: string;
  image: string;
  command?: string[];
  args?: string[];
  ports?: { containerPort: number }[];
  env?: { name: string; value?: string; valueFrom?: unknown }[];
  envFrom?: { configMapRef?: { name: string }; secretRef?: { name: string } }[];
  resources?: { requests?: Record<string, string>; limits?: Record<string, string> };
  readinessProbe?: Probe;
  livenessProbe?: Probe;
  volumeMounts?: { name: string; mountPath: string }[];
  securityContext?: Record<string, unknown>;
};

export type Probe = {
  httpGet?: { path?: string; port: number | string };
  tcpSocket?: { port: number | string };
  exec?: { command: string[] };
  initialDelaySeconds?: number;
  periodSeconds?: number;
};

export type PodSpec = {
  containers: Container[];
  initContainers?: Container[];
  volumes?: { name: string; configMap?: { name: string }; secret?: { secretName: string }; persistentVolumeClaim?: { claimName: string }; emptyDir?: object }[];
  nodeSelector?: Record<string, string>;
  tolerations?: { key?: string; operator?: string; value?: string; effect?: string }[];
  serviceAccountName?: string;
  restartPolicy?: string;
  securityContext?: Record<string, unknown>;
  nodeName?: string;
};

export type Pod = {
  name: string;
  namespace: string;
  labels: Record<string, string>;
  spec: PodSpec;
  createdAt: number;
  /** when the scheduler bound the pod to a node */
  scheduledAt?: number;
  node?: string;
  ip: string;
  owner?: string;
  ownerKind?: "Deployment" | "Job" | "Static" | "DaemonSet";
  restarts: number;
  /** Ignores status simulation (used by kube-system pods) */
  fixedStatus?: string;
  /** image kept for backwards compatibility: first container image */
  image: string;
};

export type Deployment = {
  name: string;
  namespace: string;
  replicas: number;
  createdAt: number;
  revision: number;
  labels: Record<string, string>;
  selector: Record<string, string>;
  template: { labels: Record<string, string>; spec: PodSpec };
  history: { revision: number; image: string; template: string }[];
  /** first container image (kept in sync with template) */
  image: string;
};

export type Service = {
  name: string;
  namespace: string;
  type: "ClusterIP" | "NodePort" | "LoadBalancer";
  clusterIP: string;
  port: number;
  targetPort: number;
  nodePort?: number;
  selector: Record<string, string>;
  createdAt: number;
};

export type K8sObject = {
  kind: string;
  name: string;
  namespace?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  manifest: any;
  createdAt: number;
};

export type NodeState = {
  name: string;
  role: "control-plane" | "worker";
  ip: string;
  version: string;
  schedulable: boolean;
  taints: { key: string; value?: string; effect: string }[];
  labels: Record<string, string>;
};

// ---------------- Hosts (Linux) ----------------
export type ServiceUnit = { active: boolean; enabled: boolean; logs: string[]; failReason?: string };
export type Host = {
  name: string;
  ip: string;
  services: Record<string, ServiceUnit>;
  packages: Record<string, string>;
};

// ---------------- Docker ----------------
export type DockerContainer = {
  id: string;
  name: string;
  image: string;
  ports?: { host: number; container: number };
  status: "running" | "exited";
  createdAt: number;
  env?: Record<string, string>;
  volumes?: string[];
  network?: string;
};

export type LabState = {
  pods: Pod[];
  deployments: Deployment[];
  services: Service[];
  objects: K8sObject[];
  namespaces: { name: string; createdAt: number }[];
  nodes: NodeState[];
  images: string[];
  containers: DockerContainer[];
  tf: { initialized: boolean; planned: boolean; applied: boolean };
  /** absolute path → content. Directories are implied by paths. */
  files: Record<string, string>;
  hosts: Record<string, Host>;
};

export type Seed = {
  /** Files relative to the project dir (/home/danylo/project) or absolute. */
  files?: Record<string, string>;
  images?: string[];
  containers?: DockerContainer[];
  tf?: LabState["tf"];
  seedDeployments?: { name: string; image: string; replicas: number; ageSec?: number; namespace?: string }[];
  /** Arbitrary initial state tweaks, run at the end of the Shell constructor. */
  setup?: (sh: Shell) => void;
};

// ---------------- Terminal / tools ----------------
export type Entry = { cmd: string; output: string; ok: boolean };

export type Flags = Record<string, string | true>;

export type ToolCtx = {
  sh: Shell;
  /** raw args after the command name */
  args: string[];
  /** parsed flags (--k=v, --k v for valueFlags, -x, -x v for valueFlags) */
  flags: Flags;
  /** positional args (no flags), excluding anything after a bare "--" */
  pos: string[];
  /** args after a bare "--" (e.g. kubectl exec pod -- cmd) */
  rest: string[];
  /** env vars for this command (VAR=x prefix + exported) */
  env: Record<string, string>;
  /** piped input, when the command is on the right side of a pipe */
  stdin?: string;
};

export type EditRequest = { path: string; content: string };

export type ToolResult = string | { output: string; ok?: boolean; edit?: EditRequest; clear?: boolean };

export type Tool = {
  name: string;
  aliases?: string[];
  /** one-line description shown in help and the command explainer */
  summary: string;
  /** subcommand → description, used by the explainer and "did you mean" */
  subcommands?: Record<string, string>;
  /** flag (e.g. "--image", "-o") → description, used by the explainer */
  flags?: Record<string, string>;
  /** flags that consume the next token as their value */
  valueFlags?: string[];
  run: (ctx: ToolCtx) => ToolResult;
  /** Friendly explanation for an error produced by this tool, or null. */
  explainError?: (cmd: string, output: string, sh: Shell) => string | null;
  /** Serve HTTP for curl/wget. Return null when the address is not handled. */
  http?: (req: { host: string; port: number; path: string }, sh: Shell) => string | null;
};

// ---------------- Labs ----------------
export type Step = {
  title: string;
  body: string[];
  code?: string[];
  /** Progressive hints: concept → syntax → full solution (last one). */
  hints: string[];
  /** Shown after a successful check: what happened and why it matters. */
  explain: string[];
  /** Step-specific reason why the check is failing, or null to fall back to generic diagnosis. */
  diagnose?: (sh: Shell) => string | null;
  check: (sh: Shell) => boolean;
  fail?: string;
};

export type Level = "Iniciante" | "Intermediário" | "Avançado";

export type Lab = {
  id: string;
  track: string;
  kind: "lab" | "challenge";
  title: string;
  summary: string;
  level: Level;
  minutes: number;
  skills: string[];
  seed?: Seed;
  intro: string;
  steps: Step[];
  outro: string;
};

export type Track = {
  id: string;
  title: string;
  desc: string;
  color: string;
  icon: string;
  /** e.g. "Certificação" for CKA/CKAD */
  badge?: string;
};
