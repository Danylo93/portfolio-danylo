// Simulated shell with an in-memory Kubernetes cluster, Docker engine and Terraform workspace.

export type Pod = {
  name: string;
  image: string;
  createdAt: number;
  node: string;
  ip: string;
  owner?: string;
  labels: Record<string, string>;
};

export type Deployment = {
  name: string;
  image: string;
  replicas: number;
  createdAt: number;
  revision: number;
  history: { revision: number; image: string }[];
};

export type Service = {
  name: string;
  type: "ClusterIP" | "NodePort" | "LoadBalancer";
  clusterIP: string;
  port: number;
  targetPort: number;
  nodePort?: number;
  selector: Record<string, string>;
  createdAt: number;
};

export type Container = {
  id: string;
  name: string;
  image: string;
  ports?: { host: number; container: number };
  status: "running" | "exited";
  createdAt: number;
};

export type Entry = { cmd: string; output: string; ok: boolean };

const ERROR_OUT = /(^|\n)(error|Error|bash:|docker: |curl: \(|cat: |\u2502 Error|"docker \w+" requires)/;

export type LabState = {
  pods: Pod[];
  deployments: Deployment[];
  services: Service[];
  images: string[];
  containers: Container[];
  tf: { initialized: boolean; planned: boolean; applied: boolean };
  files: Record<string, string>;
};

export type Seed = Partial<LabState> & {
  seedDeployments?: { name: string; image: string; replicas: number; ageSec?: number }[];
};

const NODES = [
  { name: "lab-control-plane", role: "control-plane", ip: "172.18.0.2", cpu: "4", mem: "8Gi" },
  { name: "lab-worker", role: "<none>", ip: "172.18.0.3", cpu: "4", mem: "8Gi" },
  { name: "lab-worker2", role: "<none>", ip: "172.18.0.4", cpu: "4", mem: "8Gi" },
];
const WORKERS = NODES.filter((n) => n.role !== "control-plane");
const NODE_AGE = Date.now() - 1000 * 60 * 60 * 26;

const GOOD_IMAGE =
  /^(docker\.io\/)?(library\/)?(nginx|httpd|redis|busybox|alpine|node|python|postgres|mysql|traefik|hashicorp\/http-echo|registry\.k8s\.io\/[\w./-]+)(:[\w.-]+)?$/;
const BAD_TAGS = /:(latestt|doesnotexist|9\.9\.9)$/;

export const validImage = (img: string) => GOOD_IMAGE.test(img) && !BAD_TAGS.test(img);

const HASH_CHARS = "bcdfghjklmnpqrstvwxz2456789";
const rand = (n: number) =>
  Array.from({ length: n }, () => HASH_CHARS[Math.floor(Math.random() * HASH_CHARS.length)]).join("");
const hexId = () => Array.from({ length: 12 }, () => Math.floor(Math.random() * 16).toString(16)).join("");

const age = (from: number) => {
  const s = Math.max(1, Math.floor((Date.now() - from) / 1000));
  if (s < 120) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 10) return `${m}m${s % 60}s`;
  if (m < 60 * 3) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h` : `${Math.floor(h / 24)}d`;
};

const table = (rows: string[][]) => {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => (r[i] ?? "").length)));
  return rows.map((r) => r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i] + 3))).join("")).join("\n");
};

const tokenize = (line: string) => {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
};

const parseFlags = (args: string[]) => {
  const flags: Record<string, string | true> = {};
  const pos: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=");
      if (v !== undefined) flags[k] = v;
      else if (args[i + 1] && !args[i + 1].startsWith("-") && ["replicas", "port", "type", "image", "target-port", "name", "namespace", "output", "selector"].includes(k)) flags[k] = args[++i];
      else flags[k] = true;
    } else if (a.startsWith("-") && a.length > 1) {
      const k = a.slice(1);
      if (["o", "n", "p", "l", "f"].includes(k) && args[i + 1]) flags[k] = args[++i];
      else flags[k] = true;
    } else pos.push(a);
  }
  return { flags, pos };
};

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

const DEFAULT_FILES: Record<string, string> = {
  "README.md": "# Lab environment\nCluster: kind-lab (3 nodes)\nUse `help` to list available commands.",
};

export class Shell {
  state: LabState;
  log: string[] = [];
  entries: Entry[] = [];
  flags = new Set<string>();
  private ipSeq = 10;

  constructor(seed: Seed = {}) {
    this.state = {
      pods: [],
      deployments: [],
      services: [],
      images: seed.images ?? [],
      containers: seed.containers ?? [],
      tf: seed.tf ?? { initialized: false, planned: false, applied: false },
      files: { ...DEFAULT_FILES, ...(seed.files ?? {}) },
    };
    for (const d of seed.seedDeployments ?? []) {
      const createdAt = Date.now() - (d.ageSec ?? 600) * 1000;
      this.state.deployments.push({
        name: d.name, image: d.image, replicas: d.replicas, createdAt, revision: 1,
        history: [{ revision: 1, image: d.image }],
      });
      this.reconcile(createdAt);
    }
  }

  // ---------- cluster helpers ----------
  private nextIp() {
    this.ipSeq++;
    return `10.244.${1 + (this.ipSeq % 2)}.${this.ipSeq}`;
  }

  private newPod(name: string, image: string, labels: Record<string, string>, owner?: string, createdAt = Date.now()): Pod {
    const node = WORKERS[this.state.pods.length % WORKERS.length].name;
    return { name, image, createdAt, node, ip: this.nextIp(), owner, labels };
  }

  private reconcile(createdAt = Date.now()) {
    for (const d of this.state.deployments) {
      let owned = this.state.pods.filter((p) => p.owner === d.name);
      const stale = owned.filter((p) => p.image !== d.image);
      if (stale.length) {
        this.state.pods = this.state.pods.filter((p) => !stale.includes(p));
        owned = owned.filter((p) => !stale.includes(p));
      }
      const rsHash = rand(10).slice(0, 9);
      while (owned.length < d.replicas) {
        const pod = this.newPod(`${d.name}-${rsHash}-${rand(5)}`, d.image, { app: d.name }, d.name, createdAt);
        this.state.pods.push(pod);
        owned.push(pod);
      }
      while (owned.length > d.replicas) {
        const victim = owned.pop()!;
        this.state.pods = this.state.pods.filter((p) => p !== victim);
      }
    }
    const names = new Set(this.state.deployments.map((d) => d.name));
    this.state.pods = this.state.pods.filter((p) => !p.owner || names.has(p.owner));
  }

  podStatus(p: Pod) {
    const ms = Date.now() - p.createdAt;
    if (!validImage(p.image)) return ms < 4000 ? "ErrImagePull" : "ImagePullBackOff";
    return ms < 2500 ? "ContainerCreating" : "Running";
  }

  podReady(p: Pod) {
    return this.podStatus(p) === "Running";
  }

  deploymentReady(name: string) {
    const d = this.state.deployments.find((x) => x.name === name);
    if (!d) return false;
    const pods = this.state.pods.filter((p) => p.owner === name);
    return pods.length === d.replicas && pods.every((p) => this.podReady(p));
  }

  // ---------- entrypoint ----------
  exec(line: string): { output: string; clear?: boolean } {
    const trimmed = line.trim();
    if (!trimmed) return { output: "" };
    const [cmd, ...args] = tokenize(trimmed);
    let output: string;
    let ok = true;
    try {
      switch (cmd) {
        case "clear": this.log.push(trimmed); this.entries.push({ cmd: trimmed, output: "", ok: true }); return { output: "", clear: true };
        case "help": output = HELP; break;
        case "kubectl": case "k": output = this.kubectl(args); break;
        case "docker": output = this.docker(args); break;
        case "terraform": case "tf": output = this.terraform(args); break;
        case "curl": output = this.curl(args); break;
        case "ls": output = Object.keys(this.state.files).sort().join("  "); break;
        case "cat": output = args.map((f) => this.state.files[f] ?? `cat: ${f}: No such file or directory`).join("\n"); break;
        case "pwd": output = "/home/danylo/project"; break;
        case "whoami": output = "danylo"; break;
        case "hostname": output = "lab-control-plane"; break;
        case "date": output = new Date().toString(); break;
        case "uname": output = args.includes("-a") ? "Linux lab-control-plane 6.8.0-45-generic #45-Ubuntu SMP x86_64 GNU/Linux" : "Linux"; break;
        case "echo": output = args.join(" "); break;
        case "history": output = this.log.map((l, i) => `${String(i + 1).padStart(4)}  ${l}`).join("\n"); break;
        case "minikube": case "kind": output = "kind-lab cluster is already running. Use kubectl to interact with it."; break;
        default: output = `bash: ${cmd}: command not found`; ok = false;
      }
    } catch (e) {
      output = (e as Error).message;
      ok = false;
    }
    ok = ok && !ERROR_OUT.test(output);
    if (ok) this.log.push(trimmed);
    this.entries.push({ cmd: trimmed, output, ok });
    return { output };
  }

  ran(re: RegExp) {
    return this.log.some((l) => re.test(l));
  }

  // ---------- kubectl ----------
  private kubectl(args: string[]): string {
    const { flags, pos } = parseFlags(args);
    const [sub, ...rest] = pos;
    const resolve = (r?: string) => {
      if (!r) return "";
      const map: Record<string, string> = {
        no: "nodes", node: "nodes", nodes: "nodes",
        po: "pods", pod: "pods", pods: "pods",
        deploy: "deployments", deployment: "deployments", deployments: "deployments",
        svc: "services", service: "services", services: "services",
        ns: "namespaces", namespace: "namespaces", namespaces: "namespaces",
        all: "all", events: "events", ev: "events", rs: "replicasets", replicaset: "replicasets", replicasets: "replicasets",
      };
      return map[r.toLowerCase()] ?? r;
    };
    const splitRef = (a?: string, b?: string): [string, string | undefined] => {
      if (a?.includes("/")) {
        const [r, n] = a.split("/");
        return [resolve(r), n];
      }
      return [resolve(a), b];
    };

    switch (sub) {
      case undefined:
      case "help":
        return "kubectl controls the Kubernetes cluster manager.\n\nBasic Commands:\n  create, expose, run, set, get, delete, describe, logs, scale, rollout, apply, top, version, cluster-info";
      case "cluster-info":
        return "Kubernetes control plane is running at https://127.0.0.1:6443\nCoreDNS is running at https://127.0.0.1:6443/api/v1/namespaces/kube-system/services/kube-dns:dns/proxy\n\nTo further debug and diagnose cluster problems, use 'kubectl cluster-info dump'.";
      case "version":
        if (flags.client) return "Client Version: v1.30.2\nKustomize Version: v5.0.4-0.20230601165947-6ce0bf390ce3";
        return "Client Version: v1.30.2\nKustomize Version: v5.0.4-0.20230601165947-6ce0bf390ce3\nServer Version: v1.30.0";
      case "config":
        if (rest[0] === "current-context") return "kind-lab";
        if (rest[0] === "get-contexts") return table([["CURRENT", "NAME", "CLUSTER", "AUTHINFO", "NAMESPACE"], ["*", "kind-lab", "kind-lab", "kind-lab", ""]]);
        return "error: unsupported config subcommand in this lab";
      case "get": return this.kGet(...splitRef(rest[0], rest[1]), flags);
      case "describe": return this.kDescribe(...splitRef(rest[0], rest[1]));
      case "run": {
        const name = rest[0];
        const image = flags.image as string;
        if (!name || typeof image !== "string") return "error: required flag(s) \"image\" not set";
        if (this.state.pods.some((p) => p.name === name)) return `Error from server (AlreadyExists): pods "${name}" already exists`;
        this.state.pods.push(this.newPod(name, image, { run: name }));
        return `pod/${name} created`;
      }
      case "create": {
        if (resolve(rest[0]) !== "deployments") return `error: this lab supports "kubectl create deployment" only`;
        const name = rest[1];
        const image = flags.image as string;
        if (!name || typeof image !== "string") return "error: required flag(s) \"image\" not set";
        if (this.state.deployments.some((d) => d.name === name)) return `error: failed to create deployment: deployments.apps "${name}" already exists`;
        const replicas = Number(flags.replicas ?? 1);
        this.state.deployments.push({ name, image, replicas, createdAt: Date.now(), revision: 1, history: [{ revision: 1, image }] });
        this.reconcile();
        return `deployment.apps/${name} created`;
      }
      case "scale": {
        const [r, name] = splitRef(rest[0], rest[1]);
        if (r !== "deployments") return "error: only deployments can be scaled in this lab";
        const d = this.state.deployments.find((x) => x.name === name);
        if (!d) return `Error from server (NotFound): deployments.apps "${name}" not found`;
        const n = Number(flags.replicas);
        if (Number.isNaN(n)) return "error: --replicas=COUNT is required";
        d.replicas = n;
        this.reconcile();
        return `deployment.apps/${name} scaled`;
      }
      case "expose": {
        const [r, name] = splitRef(rest[0], rest[1]);
        if (r !== "deployments" && r !== "pods") return "error: expose supports deployment or pod";
        const exists = r === "deployments" ? this.state.deployments.some((d) => d.name === name) : this.state.pods.some((p) => p.name === name);
        if (!exists) return `Error from server (NotFound): ${r === "deployments" ? "deployments.apps" : "pods"} "${name}" not found`;
        if (!flags.port) return "error: couldn't find port via --port flag or introspection";
        const svcName = typeof flags.name === "string" ? flags.name : name!;
        if (this.state.services.some((s) => s.name === svcName)) return `Error from server (AlreadyExists): services "${svcName}" already exists`;
        const type = (typeof flags.type === "string" ? flags.type : "ClusterIP") as Service["type"];
        const port = Number(flags.port);
        this.state.services.push({
          name: svcName, type, port,
          targetPort: Number(flags["target-port"] ?? port),
          clusterIP: `10.96.${Math.floor(Math.random() * 200) + 20}.${Math.floor(Math.random() * 250) + 2}`,
          nodePort: type === "ClusterIP" ? undefined : 30000 + Math.floor(Math.random() * 2767),
          selector: r === "deployments" ? { app: name! } : { run: name! },
          createdAt: Date.now(),
        });
        return `service/${svcName} exposed`;
      }
      case "set": {
        if (rest[0] !== "image") return "error: only \"kubectl set image\" is supported";
        const [r, name] = splitRef(rest[1]);
        const d = this.state.deployments.find((x) => x.name === name);
        if (r !== "deployments" || !d) return `Error from server (NotFound): deployments.apps "${name}" not found`;
        const assign = rest[2];
        if (!assign?.includes("=")) return "error: expected CONTAINER=IMAGE";
        const [container, image] = assign.split("=");
        if (container !== d.name && container !== "*") return `error: unable to find container named "${container}"`;
        if (image === d.image) return `deployment.apps/${name} image unchanged`;
        d.image = image;
        d.revision++;
        d.history.push({ revision: d.revision, image });
        this.reconcile();
        return `deployment.apps/${name} image updated`;
      }
      case "rollout": {
        const action = rest[0];
        const [r, name] = splitRef(rest[1], rest[2]);
        const d = this.state.deployments.find((x) => x.name === name);
        if (r !== "deployments" || !d) return `Error from server (NotFound): deployments.apps "${name}" not found`;
        if (action === "status") {
          if (!validImage(d.image))
            return `Waiting for deployment "${name}" rollout to finish: 0 of ${d.replicas} updated replicas are available...\nerror: deployment "${name}" exceeded its progress deadline`;
          const ready = this.state.pods.filter((p) => p.owner === name && this.podReady(p)).length;
          const wait = ready < d.replicas ? `Waiting for deployment "${name}" rollout to finish: ${ready} of ${d.replicas} updated replicas are available...\n` : "";
          return `${wait}deployment "${name}" successfully rolled out`;
        }
        if (action === "history")
          return `deployment.apps/${name}\n` + table([["REVISION", "CHANGE-CAUSE"], ...d.history.map((h) => [String(h.revision), `image=${h.image}`])]);
        if (action === "undo") {
          if (d.history.length < 2) return `error: no rollout history found for deployment "${name}"`;
          const prev = d.history[d.history.length - 2];
          d.image = prev.image;
          d.revision++;
          d.history = d.history.filter((h) => h !== prev);
          d.history.push({ revision: d.revision, image: prev.image });
          this.reconcile();
          return `deployment.apps/${name} rolled back`;
        }
        if (action === "restart") {
          this.state.pods = this.state.pods.filter((p) => p.owner !== name);
          this.reconcile();
          return `deployment.apps/${name} restarted`;
        }
        return "error: rollout supports status | history | undo | restart";
      }
      case "delete": {
        const [r, name] = splitRef(rest[0], rest[1]);
        if (r === "pods") {
          const p = this.state.pods.find((x) => x.name === name);
          if (!p) return `Error from server (NotFound): pods "${name}" not found`;
          this.state.pods = this.state.pods.filter((x) => x !== p);
          this.reconcile();
          return `pod "${name}" deleted`;
        }
        if (r === "deployments") {
          if (!this.state.deployments.some((d) => d.name === name)) return `Error from server (NotFound): deployments.apps "${name}" not found`;
          this.state.deployments = this.state.deployments.filter((d) => d.name !== name);
          this.reconcile();
          return `deployment.apps "${name}" deleted`;
        }
        if (r === "services") {
          if (!this.state.services.some((s) => s.name === name)) return `Error from server (NotFound): services "${name}" not found`;
          this.state.services = this.state.services.filter((s) => s.name !== name);
          return `service "${name}" deleted`;
        }
        return `error: the server doesn't have a resource type "${rest[0]}"`;
      }
      case "logs": {
        const p = this.state.pods.find((x) => x.name === rest[0]) ?? this.state.pods.find((x) => rest[0]?.startsWith("deployment/") && x.owner === rest[0].split("/")[1]);
        if (!p) return `error: pods "${rest[0]}" not found`;
        if (!this.podReady(p)) return `Error from server (BadRequest): container "${p.owner ?? p.name}" in pod "${p.name}" is waiting to start: ${this.podStatus(p) === "ContainerCreating" ? "ContainerCreating" : "trying and failing to pull image"}`;
        const t = new Date(p.createdAt).toISOString().replace("T", " ").slice(0, 19);
        return [
          "/docker-entrypoint.sh: /docker-entrypoint.d/ is not empty, will attempt to perform configuration",
          "/docker-entrypoint.sh: Launching /docker-entrypoint.d/10-listen-on-ipv6-by-default.sh",
          "/docker-entrypoint.sh: Configuration complete; ready for start up",
          `${t} [notice] 1#1: using the "epoll" event method`,
          `${t} [notice] 1#1: nginx/1.25.5`,
          `${t} [notice] 1#1: start worker processes`,
        ].join("\n");
      }
      case "apply": {
        const file = flags.f as string;
        const content = this.state.files[file];
        if (!content) return `error: the path "${file}" does not exist`;
        const name = /metadata:\s*\n\s*name:\s*(\S+)/.exec(content)?.[1];
        const image = /image:\s*(\S+)/.exec(content)?.[1];
        const replicas = Number(/replicas:\s*(\d+)/.exec(content)?.[1] ?? 1);
        if (!name || !image) return "error: error validating data: missing metadata.name or image";
        const d = this.state.deployments.find((x) => x.name === name);
        if (!d) {
          this.state.deployments.push({ name, image, replicas, createdAt: Date.now(), revision: 1, history: [{ revision: 1, image }] });
          this.reconcile();
          return `deployment.apps/${name} created`;
        }
        const changed = d.image !== image || d.replicas !== replicas;
        if (d.image !== image) { d.revision++; d.history.push({ revision: d.revision, image }); }
        d.image = image; d.replicas = replicas;
        this.reconcile();
        return `deployment.apps/${name} ${changed ? "configured" : "unchanged"}`;
      }
      case "top":
        if (resolve(rest[0]) === "nodes")
          return table([["NAME", "CPU(cores)", "CPU%", "MEMORY(bytes)", "MEMORY%"], ...NODES.map((n, i) => [n.name, `${180 + i * 45}m`, `${4 + i}%`, `${900 + i * 130}Mi`, `${11 + i}%`])]);
        return table([["NAME", "CPU(cores)", "MEMORY(bytes)"], ...this.state.pods.filter((p) => this.podReady(p)).map((p) => [p.name, "1m", "3Mi"])]);
      default:
        return `error: unknown command "${sub}" for "kubectl"\nRun 'kubectl help' for usage.`;
    }
  }

  private kGet(res: string, name: string | undefined, flags: Record<string, string | true>): string {
    const wide = flags.o === "wide" || flags.output === "wide";
    const sel = typeof flags.l === "string" ? flags.l : typeof flags.selector === "string" ? flags.selector : undefined;
    const match = (labels: Record<string, string>) => {
      if (!sel) return true;
      const [k, v] = sel.split("=");
      return labels[k] === v;
    };
    switch (res) {
      case "nodes": {
        const nodes = NODES.filter((n) => !name || n.name === name);
        if (!nodes.length) return `Error from server (NotFound): nodes "${name}" not found`;
        const head = ["NAME", "STATUS", "ROLES", "AGE", "VERSION"];
        if (wide) head.push("INTERNAL-IP", "OS-IMAGE", "CONTAINER-RUNTIME");
        return table([head, ...nodes.map((n) => {
          const row = [n.name, "Ready", n.role, age(NODE_AGE), "v1.30.0"];
          if (wide) row.push(n.ip, "Debian GNU/Linux 12 (bookworm)", "containerd://1.7.18");
          return row;
        })]);
      }
      case "pods": {
        const pods = this.state.pods.filter((p) => (!name || p.name === name) && match(p.labels));
        if (name && !pods.length) return `Error from server (NotFound): pods "${name}" not found`;
        if (!pods.length) return "No resources found in default namespace.";
        const head = ["NAME", "READY", "STATUS", "RESTARTS", "AGE"];
        if (wide) head.push("IP", "NODE");
        return table([head, ...pods.map((p) => {
          const row = [p.name, this.podReady(p) ? "1/1" : "0/1", this.podStatus(p), "0", age(p.createdAt)];
          if (wide) row.push(this.podStatus(p) === "Running" ? p.ip : "<none>", p.node);
          return row;
        })]);
      }
      case "deployments": {
        const deps = this.state.deployments.filter((d) => !name || d.name === name);
        if (name && !deps.length) return `Error from server (NotFound): deployments.apps "${name}" not found`;
        if (!deps.length) return "No resources found in default namespace.";
        return table([["NAME", "READY", "UP-TO-DATE", "AVAILABLE", "AGE"], ...deps.map((d) => {
          const ready = this.state.pods.filter((p) => p.owner === d.name && this.podReady(p)).length;
          return [d.name, `${ready}/${d.replicas}`, String(d.replicas), String(ready), age(d.createdAt)];
        })]);
      }
      case "services": {
        const k8s: Service = { name: "kubernetes", type: "ClusterIP", clusterIP: "10.96.0.1", port: 443, targetPort: 6443, selector: {}, createdAt: NODE_AGE };
        const svcs = [k8s, ...this.state.services].filter((s) => !name || s.name === name);
        if (!svcs.length) return `Error from server (NotFound): services "${name}" not found`;
        return table([["NAME", "TYPE", "CLUSTER-IP", "EXTERNAL-IP", "PORT(S)", "AGE"], ...svcs.map((s) => [
          s.name, s.type, s.clusterIP, s.type === "LoadBalancer" ? "<pending>" : "<none>",
          s.nodePort ? `${s.port}:${s.nodePort}/TCP` : `${s.port}/TCP`, age(s.createdAt),
        ])]);
      }
      case "namespaces":
        return table([["NAME", "STATUS", "AGE"], ...["default", "kube-node-lease", "kube-public", "kube-system", "local-path-storage"].map((n) => [n, "Active", age(NODE_AGE)])]);
      case "replicasets":
        if (!this.state.deployments.length) return "No resources found in default namespace.";
        return table([["NAME", "DESIRED", "CURRENT", "READY", "AGE"], ...this.state.deployments.map((d) => {
          const pods = this.state.pods.filter((p) => p.owner === d.name);
          const hash = pods[0]?.name.split("-").slice(-2, -1)[0] ?? rand(9);
          return [`${d.name}-${hash}`, String(d.replicas), String(pods.length), String(pods.filter((p) => this.podReady(p)).length), age(d.createdAt)];
        })]);
      case "events": {
        const ev = this.state.pods.flatMap((p) => validImage(p.image)
          ? [["Normal", "Scheduled", `pod/${p.name}`, `Successfully assigned default/${p.name} to ${p.node}`], ["Normal", "Started", `pod/${p.name}`, "Started container"]]
          : [["Warning", "Failed", `pod/${p.name}`, `Failed to pull image "${p.image}": not found`], ["Warning", "BackOff", `pod/${p.name}`, `Back-off pulling image "${p.image}"`]]);
        if (!ev.length) return "No resources found in default namespace.";
        return table([["TYPE", "REASON", "OBJECT", "MESSAGE"], ...ev]);
      }
      case "all": {
        const parts = [this.kGet("pods", undefined, {}), this.kGet("services", undefined, {})];
        if (this.state.deployments.length) parts.push(this.kGet("deployments", undefined, {}));
        return parts.filter((p) => !p.startsWith("No resources")).join("\n\n");
      }
      case "":
        return "You must specify the type of resource to get. Use \"kubectl api-resources\" for a complete list of supported resources.";
      default:
        return `error: the server doesn't have a resource type "${res}"`;
    }
  }

  private kDescribe(res: string, name?: string): string {
    if (res === "nodes") {
      const n = NODES.find((x) => x.name === name) ?? (name ? undefined : NODES[1]);
      if (!n) return `Error from server (NotFound): nodes "${name}" not found`;
      const pods = this.state.pods.filter((p) => p.node === n.name);
      return [
        `Name:               ${n.name}`,
        `Roles:              ${n.role}`,
        `Labels:             kubernetes.io/hostname=${n.name}`,
        `                    kubernetes.io/os=linux`,
        `CreationTimestamp:  ${new Date(NODE_AGE).toUTCString()}`,
        "Conditions:",
        "  Type             Status  Reason                       Message",
        "  ----             ------  ------                       -------",
        "  MemoryPressure   False   KubeletHasSufficientMemory   kubelet has sufficient memory available",
        "  DiskPressure     False   KubeletHasNoDiskPressure     kubelet has no disk pressure",
        "  PIDPressure      False   KubeletHasSufficientPID      kubelet has sufficient PID available",
        "  Ready            True    KubeletReady                 kubelet is posting ready status",
        "Addresses:",
        `  InternalIP:  ${n.ip}`,
        `  Hostname:    ${n.name}`,
        "Capacity:",
        `  cpu:     ${n.cpu}`,
        `  memory:  ${n.mem}`,
        "  pods:    110",
        "System Info:",
        "  Kernel Version:             6.8.0-45-generic",
        "  Container Runtime Version:  containerd://1.7.18",
        "  Kubelet Version:            v1.30.0",
        `Non-terminated Pods:          (${pods.length + 2} in total)`,
      ].join("\n");
    }
    if (res === "pods") {
      const p = this.state.pods.find((x) => x.name === name);
      if (!p) return `Error from server (NotFound): pods "${name}" not found`;
      const st = this.podStatus(p);
      const events = validImage(p.image)
        ? [
            `  Normal  Scheduled  ${age(p.createdAt)}  default-scheduler  Successfully assigned default/${p.name} to ${p.node}`,
            `  Normal  Pulled     ${age(p.createdAt)}  kubelet            Container image "${p.image}" already present on machine`,
            `  Normal  Created    ${age(p.createdAt)}  kubelet            Created container ${p.owner ?? p.name}`,
            `  Normal  Started    ${age(p.createdAt)}  kubelet            Started container ${p.owner ?? p.name}`,
          ]
        : [
            `  Normal   Scheduled  ${age(p.createdAt)}  default-scheduler  Successfully assigned default/${p.name} to ${p.node}`,
            `  Normal   Pulling    ${age(p.createdAt)}  kubelet            Pulling image "${p.image}"`,
            `  Warning  Failed     ${age(p.createdAt)}  kubelet            Failed to pull image "${p.image}": rpc error: code = NotFound desc = failed to resolve reference "docker.io/library/${p.image}": not found`,
            `  Warning  Failed     ${age(p.createdAt)}  kubelet            Error: ErrImagePull`,
            `  Normal   BackOff    ${age(p.createdAt)}  kubelet            Back-off pulling image "${p.image}"`,
            `  Warning  Failed     ${age(p.createdAt)}  kubelet            Error: ImagePullBackOff`,
          ];
      return [
        `Name:             ${p.name}`,
        "Namespace:        default",
        `Node:             ${p.node}/${NODES.find((n) => n.name === p.node)?.ip}`,
        `Labels:           ${Object.entries(p.labels).map(([k, v]) => `${k}=${v}`).join(",")}`,
        `Status:           ${st === "Running" ? "Running" : "Pending"}`,
        `IP:               ${st === "Running" ? p.ip : ""}`,
        ...(p.owner ? [`Controlled By:    ReplicaSet/${p.name.split("-").slice(0, -1).join("-")}`] : []),
        "Containers:",
        `  ${p.owner ?? p.name}:`,
        `    Image:          ${p.image}`,
        `    State:          ${st === "Running" ? "Running" : "Waiting"}`,
        ...(st !== "Running" ? [`      Reason:       ${st}`] : []),
        `    Ready:          ${st === "Running"}`,
        "Events:",
        "  Type    Reason     Age   From               Message",
        "  ----    ------     ---   ----               -------",
        ...events,
      ].join("\n");
    }
    if (res === "deployments") {
      const d = this.state.deployments.find((x) => x.name === name);
      if (!d) return `Error from server (NotFound): deployments.apps "${name}" not found`;
      const ready = this.state.pods.filter((p) => p.owner === d.name && this.podReady(p)).length;
      return [
        `Name:                   ${d.name}`,
        "Namespace:              default",
        `Selector:               app=${d.name}`,
        `Replicas:               ${d.replicas} desired | ${d.replicas} updated | ${d.replicas} total | ${ready} available | ${d.replicas - ready} unavailable`,
        "StrategyType:           RollingUpdate",
        "RollingUpdateStrategy:  25% max unavailable, 25% max surge",
        "Pod Template:",
        `  Labels:  app=${d.name}`,
        "  Containers:",
        `   ${d.name}:`,
        `    Image:  ${d.image}`,
        "Conditions:",
        "  Type           Status  Reason",
        "  ----           ------  ------",
        `  Available      ${ready === d.replicas ? "True " : "False"}   ${ready === d.replicas ? "MinimumReplicasAvailable" : "MinimumReplicasUnavailable"}`,
        `  Progressing    True    ${validImage(d.image) ? "NewReplicaSetAvailable" : "ReplicaSetUpdated"}`,
      ].join("\n");
    }
    if (res === "services") {
      const s = this.state.services.find((x) => x.name === name);
      if (!s) return `Error from server (NotFound): services "${name}" not found`;
      const eps = this.state.pods.filter((p) => Object.entries(s.selector).every(([k, v]) => p.labels[k] === v) && this.podReady(p));
      return [
        `Name:                     ${s.name}`,
        `Selector:                 ${Object.entries(s.selector).map(([k, v]) => `${k}=${v}`).join(",")}`,
        `Type:                     ${s.type}`,
        `IP:                       ${s.clusterIP}`,
        `Port:                     <unset>  ${s.port}/TCP`,
        `TargetPort:               ${s.targetPort}/TCP`,
        ...(s.nodePort ? [`NodePort:                 <unset>  ${s.nodePort}/TCP`] : []),
        `Endpoints:                ${eps.map((p) => `${p.ip}:${s.targetPort}`).join(",") || "<none>"}`,
      ].join("\n");
    }
    return `error: the server doesn't have a resource type "${res}"`;
  }

  // ---------- curl ----------
  private curl(args: string[]): string {
    const url = args.find((a) => !a.startsWith("-"));
    if (!url) return "curl: try 'curl --help' for more information";
    const m = /^(?:https?:\/\/)?([^:/]+)(?::(\d+))?/.exec(url);
    const host = m?.[1] ?? "";
    const port = Number(m?.[2] ?? 80);
    const refused = `curl: (7) Failed to connect to ${host} port ${port} after 0 ms: Connection refused`;

    const container = this.state.containers.find((c) => c.status === "running" && c.ports?.host === port);
    if (["localhost", "127.0.0.1"].includes(host) && container) {
      this.flags.add("curl-docker");
      return NGINX_HTML;
    }
    const svc = this.state.services.find((s) =>
      ((["localhost", "127.0.0.1", ...NODES.map((n) => n.ip)].includes(host)) && s.nodePort === port) ||
      ((host === s.clusterIP || host === s.name) && s.port === port));
    if (!svc) return refused;
    const eps = this.state.pods.filter((p) => Object.entries(svc.selector).every(([k, v]) => p.labels[k] === v) && this.podReady(p));
    if (!eps.length) return `curl: (52) Empty reply from server`;
    this.flags.add(`curl-svc:${svc.name}`);
    return NGINX_HTML;
  }

  // ---------- docker ----------
  private docker(args: string[]): string {
    const { flags, pos } = parseFlags(args);
    const [sub, ...rest] = pos;
    const norm = (i: string) => (i.includes(":") ? i : `${i}:latest`);
    const pull = (img: string) => {
      if (!validImage(img)) throw new Error(`Error response from daemon: pull access denied for ${img.split(":")[0]}, repository does not exist or may require 'docker login'`);
      const tag = norm(img);
      if (!this.state.images.includes(tag)) this.state.images.push(tag);
      return tag;
    };
    switch (sub) {
      case "version":
      case "--version":
        return "Docker version 27.1.1, build 6312585";
      case "pull": {
        if (!rest[0]) return "\"docker pull\" requires exactly 1 argument.";
        const tag = pull(rest[0]);
        return `${tag.split(":")[1]}: Pulling from library/${tag.split(":")[0]}\nc6a83fedfae6: Pull complete\n2c3dc6e1b1c3: Pull complete\nDigest: sha256:${hexId()}${hexId()}\nStatus: Downloaded newer image for ${tag}\ndocker.io/library/${tag}`;
      }
      case "images":
        return table([["REPOSITORY", "TAG", "IMAGE ID", "CREATED", "SIZE"], ...this.state.images.map((i) => {
          const [r, t] = i.split(":");
          return [r, t, hexId(), "2 weeks ago", r === "nginx" && t.includes("alpine") ? "47.9MB" : "188MB"];
        })]);
      case "run": {
        const image = rest[0];
        if (!image) return "\"docker run\" requires at least 1 argument.";
        const note = this.state.images.includes(norm(image)) ? "" : `Unable to find image '${norm(image)}' locally\n`;
        pull(image);
        const name = typeof flags.name === "string" ? flags.name : `${["brave", "eager", "quirky"][Math.floor(Math.random() * 3)]}_${["turing", "hopper", "lovelace"][Math.floor(Math.random() * 3)]}`;
        if (this.state.containers.some((c) => c.name === name)) return `docker: Error response from daemon: Conflict. The container name "/${name}" is already in use.`;
        let ports: Container["ports"];
        if (typeof flags.p === "string") {
          const [h, c] = flags.p.split(":").map(Number);
          if (this.state.containers.some((x) => x.status === "running" && x.ports?.host === h)) return `docker: Error response from daemon: Bind for 0.0.0.0:${h} failed: port is already allocated.`;
          ports = { host: h, container: c };
        }
        const id = hexId() + hexId();
        this.state.containers.push({ id, name, image: norm(image), ports, status: "running", createdAt: Date.now() });
        return note + id + hexId().slice(0, 4);
      }
      case "ps": {
        const list = this.state.containers.filter((c) => flags.a || c.status === "running");
        return table([["CONTAINER ID", "IMAGE", "COMMAND", "CREATED", "STATUS", "PORTS", "NAMES"], ...list.map((c) => [
          c.id.slice(0, 12), c.image, "\"/docker-entrypoint.…\"", `${age(c.createdAt)} ago`,
          c.status === "running" ? `Up ${age(c.createdAt)}` : "Exited (0) 1s ago",
          c.ports && c.status === "running" ? `0.0.0.0:${c.ports.host}->${c.ports.container}/tcp` : "", c.name,
        ])]);
      }
      case "stop":
      case "rm": {
        const c = this.state.containers.find((x) => x.name === rest[0] || x.id.startsWith(rest[0] ?? "-"));
        if (!c) return `Error response from daemon: No such container: ${rest[0]}`;
        if (sub === "stop") c.status = "exited";
        else {
          if (c.status === "running" && !flags.f) return `Error response from daemon: cannot remove container "/${c.name}": container is running: stop the container before removing or force remove`;
          this.state.containers = this.state.containers.filter((x) => x !== c);
        }
        return rest[0];
      }
      case "logs": {
        const c = this.state.containers.find((x) => x.name === rest[0] || x.id.startsWith(rest[0] ?? "-"));
        if (!c) return `Error response from daemon: No such container: ${rest[0]}`;
        return "/docker-entrypoint.sh: Configuration complete; ready for start up\n172.17.0.1 - - \"GET / HTTP/1.1\" 200 615 \"-\" \"curl/8.5.0\"";
      }
      default:
        return `docker: '${sub ?? ""}' is not a docker command.\nSee 'docker --help'`;
    }
  }

  // ---------- terraform ----------
  private terraform(args: string[]): string {
    const [sub] = args;
    const tf = this.state.tf;
    const needInit = "│ Error: Backend initialization required, please run \"terraform init\"";
    switch (sub) {
      case "version":
      case "-version":
      case "--version":
        return "Terraform v1.9.5\non linux_amd64\n+ provider registry.terraform.io/hashicorp/aws v5.62.0";
      case "init":
        tf.initialized = true;
        return "Initializing the backend...\nInitializing provider plugins...\n- Finding hashicorp/aws versions matching \"~> 5.0\"...\n- Installing hashicorp/aws v5.62.0...\n- Installed hashicorp/aws v5.62.0 (signed by HashiCorp)\n\nTerraform has been successfully initialized!";
      case "fmt":
        return "";
      case "validate":
        if (!tf.initialized) return needInit;
        return "Success! The configuration is valid.";
      case "plan":
        if (!tf.initialized) return needInit;
        tf.planned = true;
        return [
          "Terraform used the selected providers to generate the following execution plan.",
          "Resource actions are indicated with the following symbols:",
          "  + create",
          "",
          "Terraform will perform the following actions:",
          "",
          "  # aws_vpc.lab will be created",
          "  + resource \"aws_vpc\" \"lab\" {",
          "      + cidr_block = \"10.0.0.0/16\"",
          "      + id         = (known after apply)",
          "    }",
          "",
          "  # aws_eks_cluster.lab will be created",
          "  + resource \"aws_eks_cluster\" \"lab\" {",
          "      + name     = \"danylo-lab\"",
          "      + version  = \"1.30\"",
          "      + endpoint = (known after apply)",
          "    }",
          "",
          "  # aws_eks_node_group.workers will be created",
          "  + resource \"aws_eks_node_group\" \"workers\" {",
          "      + instance_types = [\"t3.medium\"]",
          "      + scaling_config { desired_size = 2, max_size = 4, min_size = 1 }",
          "    }",
          "",
          "Plan: 3 to add, 0 to change, 0 to destroy.",
        ].join("\n");
      case "apply":
        if (!tf.initialized) return needInit;
        tf.applied = true;
        tf.planned = true;
        return [
          ...(args.includes("-auto-approve") ? [] : ["Do you want to perform these actions?", "  Enter a value: yes", ""]),
          "aws_vpc.lab: Creating...",
          "aws_vpc.lab: Creation complete after 2s [id=vpc-0a1b2c3d4e5f67890]",
          "aws_eks_cluster.lab: Creating...",
          "aws_eks_cluster.lab: Still creating... [9m50s elapsed]",
          "aws_eks_cluster.lab: Creation complete after 9m58s [id=danylo-lab]",
          "aws_eks_node_group.workers: Creating...",
          "aws_eks_node_group.workers: Creation complete after 2m11s [id=danylo-lab:workers]",
          "",
          "Apply complete! Resources: 3 added, 0 changed, 0 destroyed.",
          "",
          "Outputs:",
          "",
          "cluster_endpoint = \"https://A1B2C3D4E5.gr7.sa-east-1.eks.amazonaws.com\"",
          "cluster_name = \"danylo-lab\"",
        ].join("\n");
      case "state":
        if (args[1] !== "list") return "Usage: terraform state list";
        return tf.applied ? "aws_eks_cluster.lab\naws_eks_node_group.workers\naws_vpc.lab" : "";
      case "output":
        return tf.applied ? "cluster_endpoint = \"https://A1B2C3D4E5.gr7.sa-east-1.eks.amazonaws.com\"\ncluster_name = \"danylo-lab\"" : "│ Warning: No outputs found";
      case "destroy":
        if (!tf.applied) return "No changes. No objects need to be destroyed.";
        tf.applied = false;
        return "aws_eks_node_group.workers: Destroying...\naws_eks_cluster.lab: Destroying...\naws_vpc.lab: Destroying...\n\nDestroy complete! Resources: 3 destroyed.";
      default:
        return "Usage: terraform [global options] <subcommand> [args]\n\nMain commands:\n  init, validate, plan, apply, destroy, output, state list";
    }
  }
}

export const COMMANDS = ["kubectl", "docker", "terraform", "curl", "ls", "cat", "clear", "help", "history", "echo", "whoami", "pwd"];
export const KUBECTL_SUBS = ["get", "describe", "create", "run", "expose", "scale", "set", "rollout", "delete", "logs", "apply", "top", "version", "cluster-info", "config"];

const HELP = `Comandos disponíveis neste lab:
  kubectl    get | describe | create | run | expose | scale | set image | rollout | delete | logs | apply | top
  docker     pull | images | run | ps | stop | rm | logs
  terraform  init | validate | plan | apply | state list | output | destroy
  curl       testar serviços HTTP (NodePort, ClusterIP, portas do Docker)
  ls, cat, echo, history, clear, whoami, pwd

Atalhos: ↑/↓ histórico · Tab autocompletar · Ctrl+L limpar`;
