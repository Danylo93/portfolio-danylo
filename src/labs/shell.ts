// Simulated Linux shell. Tools (kubectl, docker, terraform, ansible, …) are plugins from the registry.
import { allTools, getTool, toolNames } from "./registry";
import type { EditRequest, Entry, Host, LabState, Pod, Seed, ServiceUnit, ToolResult } from "./types";
import { HOME, PROJECT, normalizePath, parseFlags, resolvePath, splitTop, tokenize } from "./util";
import {
  CP_NODE, createDeployment, deploymentReady as k8sDeploymentReady, initialNodes, podReady as k8sPodReady,
  podStatus as k8sPodStatus, reconcile, staticPodYaml, tick, SYSTEM_NAMESPACES, NODE_AGE, newPod,
} from "./k8s/cluster";

export type { Entry, LabState, Seed } from "./types";

export type ExecResult = { output: string; clear?: boolean; edit?: EditRequest };

const ERROR_OUT =
  /(^|\n)(error|Error|ERROR|bash:|docker: |curl: \(|wget: |cat: |ls: |cd: |rm: |cp: |mv: |mkdir: |sed: |grep: |ssh: |│ Error|fatal:|FATAL|E: |Failed to |"docker \w+" requires|command terminated with exit code)/;

const BUILTINS = [
  "help", "clear", "ls", "cd", "pwd", "cat", "echo", "touch", "mkdir", "rm", "cp", "mv", "sed", "grep", "head", "tail", "wc", "sort", "uniq",
  "base64", "tee", "whoami", "id", "hostname", "date", "uname", "history", "export", "unset", "env", "printenv", "which", "exit", "logout",
  "ssh", "systemctl", "journalctl", "apt-get", "apt", "apt-mark", "apt-cache", "vi", "vim", "nano", "curl", "wget", "alias", "true", "false", "sleep", "watch", "source",
];

const HELP_BASE = `Comandos do shell: ls, cd, cat, vi/nano, echo, grep, head, tail, sed, curl, ssh, systemctl, journalctl, apt-get, export, alias
Recursos: pipes (|), && , redirecionamento (> e >>), variáveis ($VAR)
Atalhos: ↑/↓ histórico · Tab autocompletar · Ctrl+L limpar`;

const hostTemplate = (name: string, ip: string): Host => ({
  name,
  ip,
  services: {
    kubelet: { active: true, enabled: true, logs: [] },
    containerd: { active: true, enabled: true, logs: [] },
  },
  packages: { kubelet: "1.30.0-1.1", kubeadm: "1.30.0-1.1", kubectl: "1.30.0-1.1" },
});

export class Shell {
  state: LabState;
  /** successful command segments, in order (used by step checks) */
  log: string[] = [];
  /** one entry per submitted line, with output and success */
  entries: Entry[] = [];
  /** free-form markers set by tools (e.g. "curl-svc:web") */
  flags = new Set<string>();
  env: Record<string, string> = { HOME, USER: "danylo", SHELL: "/bin/bash", PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", KUBECONFIG: `${HOME}/.kube/config` };
  aliases: Record<string, string> = {};
  cwd = PROJECT;
  host = CP_NODE;
  readonly homeHost = CP_NODE;
  /** save hooks for editor sessions opened by tools (e.g. kubectl edit) */
  editHooks = new Map<string, (content: string) => ToolResult>();
  private store = new Map<string, unknown>();

  constructor(seed: Seed = {}) {
    const nodes = initialNodes();
    this.state = {
      pods: [],
      deployments: [],
      services: [],
      objects: [],
      namespaces: SYSTEM_NAMESPACES.map((name) => ({ name, createdAt: NODE_AGE })),
      nodes,
      images: seed.images ?? [],
      containers: seed.containers ?? [],
      tf: seed.tf ?? { initialized: false, planned: false, applied: false },
      files: {},
      hosts: Object.fromEntries(nodes.map((n) => [n.name, hostTemplate(n.name, n.ip)])),
    };
    this.writeFile(`${PROJECT}/README.md`, "# Lab environment\nCluster: kind-lab (3 nodes)\nUse `help` to list available commands.");
    for (const comp of ["etcd", "kube-apiserver", "kube-controller-manager", "kube-scheduler"] as const)
      this.writeFile(`/etc/kubernetes/manifests/${comp}.yaml`, staticPodYaml(comp));
    for (const f of ["ca.crt", "ca.key", "server.crt", "server.key", "peer.crt", "peer.key"]) this.writeFile(`/etc/kubernetes/pki/etcd/${f}`, "-----BEGIN CERTIFICATE-----\n…\n-----END CERTIFICATE-----");
    for (const f of ["admin.conf", "scheduler.conf", "controller-manager.conf", "kubelet.conf"]) this.writeFile(`/etc/kubernetes/${f}`, "apiVersion: v1\nkind: Config\nclusters:\n- cluster:\n    server: https://172.18.0.2:6443\n  name: kind-lab");
    this.writeFile(`/var/lib/kubelet/config.yaml`, "apiVersion: kubelet.config.k8s.io/v1beta1\nkind: KubeletConfiguration\nstaticPodPath: /etc/kubernetes/manifests\nclusterDNS:\n- 10.96.0.10");
    this.writeFile(`${HOME}/.kube/config`, "apiVersion: v1\nkind: Config\ncurrent-context: kind-lab");
    for (const [p, c] of Object.entries(seed.files ?? {})) this.writeFile(p.startsWith("/") ? p : `${PROJECT}/${p}`, c);

    this.seedSystemPods();
    for (const d of seed.seedDeployments ?? [])
      createDeployment(this, { name: d.name, image: d.image, replicas: d.replicas, namespace: d.namespace, createdAt: Date.now() - (d.ageSec ?? 600) * 1000 });
    seed.setup?.(this);
  }

  private seedSystemPods() {
    for (const comp of ["etcd", "kube-apiserver", "kube-controller-manager", "kube-scheduler"]) {
      const p = newPod(this, {
        name: `${comp}-${CP_NODE}`,
        namespace: "kube-system",
        labels: { component: comp, tier: "control-plane" },
        spec: { containers: [{ name: comp, image: `registry.k8s.io/${comp}:v1.30.0` }] },
        ownerKind: "Static",
        createdAt: NODE_AGE,
      });
      p.node = CP_NODE;
      p.scheduledAt = NODE_AGE;
      p.ip = "172.18.0.2";
    }
    for (const n of this.state.nodes)
      for (const ds of ["kube-proxy", "kindnet"]) {
        const p = newPod(this, {
          name: `${ds}-${Math.random().toString(36).slice(2, 7)}`,
          namespace: "kube-system",
          labels: { "k8s-app": ds },
          spec: { containers: [{ name: ds, image: ds === "kube-proxy" ? "registry.k8s.io/kube-proxy:v1.30.0" : "docker.io/kindest/kindnetd:v20240513" }], tolerations: [{ operator: "Exists" }] },
          ownerKind: "DaemonSet",
          owner: ds,
          createdAt: NODE_AGE,
        });
        p.node = n.name;
        p.scheduledAt = NODE_AGE;
        p.fixedStatus = "Running";
        p.ip = n.ip;
      }
    createDeployment(this, {
      name: "coredns",
      namespace: "kube-system",
      replicas: 2,
      labels: { "k8s-app": "kube-dns" },
      template: { labels: { "k8s-app": "kube-dns" }, spec: { containers: [{ name: "coredns", image: "registry.k8s.io/coredns/coredns:v1.11.1", ports: [{ containerPort: 53 }] }], tolerations: [{ key: "node-role.kubernetes.io/control-plane", effect: "NoSchedule" }] } },
      createdAt: NODE_AGE,
    });
  }

  // ---------- generic plugin state ----------
  ext<T>(key: string, init: () => T): T {
    if (!this.store.has(key)) this.store.set(key, init());
    return this.store.get(key) as T;
  }

  // ---------- hosts ----------
  hostOf(name = this.host): Host {
    if (!this.state.hosts[name]) this.state.hosts[name] = { name, ip: `10.0.1.${10 + Object.keys(this.state.hosts).length}`, services: {}, packages: {} };
    return this.state.hosts[name];
  }

  prompt() {
    const dir = this.cwd === HOME ? "~" : this.cwd.startsWith(HOME + "/") ? "~" + this.cwd.slice(HOME.length) : this.cwd;
    return `danylo@${this.host}:${dir}$`;
  }

  // ---------- filesystem ----------
  resolve(p: string) {
    return resolvePath(this.cwd, p);
  }
  readFile(p: string): string | undefined {
    return this.state.files[this.resolve(p)];
  }
  writeFile(p: string, content: string) {
    this.state.files[this.resolve(p)] = content;
  }
  exists(p: string) {
    const abs = this.resolve(p);
    return abs in this.state.files || this.isDir(abs);
  }
  isDir(p: string) {
    const abs = this.resolve(p);
    if (abs === "/") return true;
    return Object.keys(this.state.files).some((f) => f.startsWith(abs + "/")) || this.dirs().has(abs);
  }
  private dirs() {
    return this.ext("dirs", () => new Set<string>([HOME, PROJECT, "/tmp", "/opt", "/etc", "/var/lib"]));
  }
  mkdir(p: string) {
    let cur = this.resolve(p);
    while (cur !== "/") {
      this.dirs().add(cur);
      cur = normalizePath(cur + "/..");
    }
  }
  listDir(p: string) {
    const abs = this.resolve(p);
    const prefix = abs === "/" ? "/" : abs + "/";
    const names = new Set<string>();
    for (const f of [...Object.keys(this.state.files), ...this.dirs()]) {
      if (f.startsWith(prefix) && f !== abs) names.add(f.slice(prefix.length).split("/")[0] + (f.slice(prefix.length).includes("/") ? "/" : ""));
    }
    return [...names].sort();
  }
  removePath(p: string) {
    const abs = this.resolve(p);
    let n = 0;
    for (const f of Object.keys(this.state.files))
      if (f === abs || f.startsWith(abs + "/")) {
        delete this.state.files[f];
        n++;
      }
    for (const d of [...this.dirs()])
      if (d === abs || d.startsWith(abs + "/")) {
        this.dirs().delete(d);
        n++;
      }
    return n > 0;
  }

  // ---------- k8s helpers used by lab checks ----------
  podStatus(p: Pod) {
    return k8sPodStatus(this, p);
  }
  podReady(p: Pod) {
    return k8sPodReady(this, p);
  }
  deploymentReady(name: string, ns = "default") {
    return k8sDeploymentReady(this, name, ns);
  }
  reconcile() {
    reconcile(this);
  }

  ran(re: RegExp) {
    return this.log.some((l) => re.test(l));
  }

  commandNames() {
    return Array.from(new Set([...toolNames(), ...BUILTINS, ...Object.keys(this.aliases)])).sort();
  }

  // ---------- execution ----------
  exec(line: string): ExecResult {
    const trimmed = line.trim();
    if (!trimmed) return { output: "" };
    tick(this);
    const outputs: string[] = [];
    let ok = true;
    let clear = false;
    let edit: EditRequest | undefined;
    for (const seg of splitTop(trimmed, "&&")) {
      if (!seg) continue;
      const r = this.runSegment(seg);
      if (r.clear) clear = true;
      if (r.edit) edit = r.edit;
      if (r.output) outputs.push(r.output);
      if (r.ok) this.log.push(seg);
      else {
        ok = false;
        break;
      }
      if (edit) break;
    }
    const output = outputs.join("\n");
    this.entries.push({ cmd: trimmed, output, ok });
    return { output: clear ? "" : output, clear, edit };
  }

  /** Called by the terminal editor when the user saves. */
  saveEdit(path: string, content: string): string {
    tick(this);
    const hook = this.editHooks.get(path);
    let output: string;
    let ok = true;
    if (hook) {
      this.editHooks.delete(path);
      const r = hook(content);
      output = typeof r === "string" ? r : r.output;
      ok = typeof r === "string" ? !ERROR_OUT.test(r) : r.ok ?? !ERROR_OUT.test(r.output);
    } else {
      this.writeFile(path, content);
      output = `"${path}" ${content.split("\n").length}L, ${content.length}B written`;
    }
    const cmd = `:wq ${path}`;
    tick(this);
    if (ok) this.log.push(cmd);
    this.entries.push({ cmd, output, ok });
    return output;
  }

  private runSegment(seg: string): { output: string; ok: boolean; clear?: boolean; edit?: EditRequest } {
    // strip stderr redirects we don't model
    let s = seg.replace(/\s2>&1/g, "").replace(/\s2>\s*\/dev\/null/g, "");
    let redirect: { file: string; append: boolean } | undefined;
    const m = /^(.*?[^>])\s*(>>?)\s*(\S+)\s*$/.exec(s);
    if (m && !/['"]/.test(m[3]) && splitTop(s, ">").length > 1) {
      s = m[1].trim();
      redirect = { file: m[3], append: m[2] === ">>" };
    }
    let stdin: string | undefined;
    let res: { output: string; ok: boolean; clear?: boolean; edit?: EditRequest } = { output: "", ok: true };
    for (const stage of splitTop(s, "|")) {
      res = this.runCommand(stage, stdin);
      if (!res.ok) return res;
      stdin = res.output;
    }
    if (redirect) {
      if (redirect.file !== "/dev/null") {
        const target = this.resolve(redirect.file);
        const prev = redirect.append ? this.state.files[target] ?? "" : "";
        this.state.files[target] = prev + (prev && !prev.endsWith("\n") ? "\n" : "") + res.output + (res.output ? "\n" : "");
      }
      return { ...res, output: "" };
    }
    return res;
  }

  private expandVars(line: string) {
    // $VAR / ${VAR} outside single quotes
    let out = "";
    let inSingle = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === "'") inSingle = !inSingle;
      if (c === "$" && !inSingle) {
        const m = /^\$(\{(\w+)\}|(\w+))/.exec(line.slice(i));
        if (m) {
          out += this.env[m[2] ?? m[3]] ?? "";
          i += m[0].length - 1;
          continue;
        }
      }
      out += c;
    }
    return out;
  }

  private runCommand(stage: string, stdin?: string): { output: string; ok: boolean; clear?: boolean; edit?: EditRequest } {
    let tokens = tokenize(this.expandVars(stage));
    const env: Record<string, string> = { ...this.env };
    while (tokens[0] === "sudo" || /^[A-Za-z_]\w*=/.test(tokens[0] ?? "")) {
      if (tokens[0] === "sudo") tokens = tokens.slice(tokens[1] === "-i" || tokens[1] === "-E" ? 2 : 1);
      else {
        const [k, ...v] = tokens[0].split("=");
        env[k] = v.join("=");
        tokens = tokens.slice(1);
      }
    }
    if (!tokens.length) return { output: "", ok: true };
    if (this.aliases[tokens[0]]) tokens = [...tokenize(this.aliases[tokens[0]]), ...tokens.slice(1)];
    const [cmd, ...args] = tokens;

    const tool = getTool(cmd);
    if (tool) {
      const { flags, pos, rest } = parseFlags(args, tool.valueFlags);
      let r: ToolResult;
      try {
        r = tool.run({ sh: this, args, flags, pos, rest, env, stdin });
      } catch (e) {
        return { output: (e as Error).message, ok: false };
      }
      if (typeof r === "string") return { output: r, ok: !ERROR_OUT.test(r) };
      return { output: r.output, ok: r.ok ?? !ERROR_OUT.test(r.output), edit: r.edit, clear: r.clear };
    }
    try {
      const out = this.builtin(cmd, args, stdin, env);
      if (out === null) return { output: `bash: ${cmd}: command not found`, ok: false };
      if (typeof out === "object") return { ...out, ok: true };
      return { output: out, ok: !ERROR_OUT.test(out) };
    } catch (e) {
      return { output: (e as Error).message, ok: false };
    }
  }

  // ---------- builtins ----------
  private builtin(cmd: string, args: string[], stdin: string | undefined, env: Record<string, string>): string | { output: string; clear?: boolean; edit?: EditRequest } | null {
    const inputOf = (files: string[]) => (files.length ? files.map((f) => this.readFile(f) ?? "").join("\n") : stdin ?? "");
    switch (cmd) {
      case "help":
        return `${HELP_BASE}\n\nFerramentas:\n${allTools().map((t) => `  ${t.name.padEnd(16)} ${t.summary}`).join("\n")}`;
      case "clear":
        return { output: "", clear: true };
      case "true":
      case "sleep":
      case "source":
        return "";
      case "false":
        return "Error: false";
      case "pwd":
        return this.cwd;
      case "cd": {
        const target = this.resolve(args[0] ?? "~");
        if (!this.isDir(target)) return `bash: cd: ${args[0]}: No such file or directory`;
        this.cwd = target;
        return "";
      }
      case "ls": {
        const long = args.some((a) => /^-\w*l/.test(a));
        const all = args.some((a) => /^-\w*a/.test(a));
        const paths = args.filter((a) => !a.startsWith("-"));
        const target = paths[0] ?? ".";
        if (this.readFile(target) !== undefined) return target;
        if (!this.isDir(target)) return `ls: cannot access '${target}': No such file or directory`;
        const items = this.listDir(target).filter((n) => all || !n.startsWith("."));
        if (!long) return items.map((n) => n.replace(/\/$/, "")).join("  ");
        return [`total ${items.length * 4}`, ...items.map((n) => {
          const isDir = n.endsWith("/");
          const size = isDir ? 4096 : (this.readFile(`${target}/${n}`) ?? "").length;
          return `${isDir ? "drwxr-xr-x" : "-rw-r--r--"} 1 danylo danylo ${String(size).padStart(6)} Sep 23 12:00 ${n.replace(/\/$/, "")}`;
        })].join("\n");
      }
      case "cat": {
        if (!args.length) return stdin ?? "";
        return args
          .map((f) => {
            if (this.isDir(f) && this.readFile(f) === undefined) return `cat: ${f}: Is a directory`;
            return this.readFile(f) ?? `cat: ${f}: No such file or directory`;
          })
          .join("\n");
      }
      case "echo":
        return args.filter((a) => a !== "-e" && a !== "-n").join(" ");
      case "touch":
        for (const f of args) if (this.readFile(f) === undefined) this.writeFile(f, "");
        return "";
      case "mkdir":
        for (const d of args.filter((a) => !a.startsWith("-"))) this.mkdir(d);
        return "";
      case "rm": {
        const targets = args.filter((a) => !a.startsWith("-"));
        const recursive = args.some((a) => /^-\w*r/i.test(a));
        const out: string[] = [];
        for (const t of targets) {
          if (this.isDir(t) && this.readFile(t) === undefined && !recursive) out.push(`rm: cannot remove '${t}': Is a directory`);
          else if (!this.removePath(t) && !args.some((a) => /^-\w*f/.test(a))) out.push(`rm: cannot remove '${t}': No such file or directory`);
        }
        return out.join("\n");
      }
      case "cp":
      case "mv": {
        const [src, dst] = args.filter((a) => !a.startsWith("-"));
        const content = this.readFile(src ?? "");
        if (content === undefined) return `${cmd}: cannot stat '${src}': No such file or directory`;
        const target = this.isDir(dst) ? `${dst}/${src.split("/").pop()}` : dst;
        this.writeFile(target, content);
        if (cmd === "mv") this.removePath(src);
        return "";
      }
      case "sed": {
        const inPlace = args.includes("-i");
        const rest = args.filter((a) => a !== "-i" && a !== "-e");
        const expr = rest[0] ?? "";
        const m = /^s(.)(.*?)\1(.*?)\1(g?)$/.exec(expr);
        if (!m) return `sed: -e expression #1, char ${expr.length}: unknown command`;
        const re = new RegExp(m[2], m[4] ? "g" : "");
        const file = rest[1];
        const content = file ? this.readFile(file) : stdin;
        if (content === undefined) return `sed: can't read ${file}: No such file or directory`;
        const result = content.split("\n").map((l) => l.replace(re, m[3])).join("\n");
        if (inPlace && file) {
          this.writeFile(file, result);
          return "";
        }
        return result;
      }
      case "grep": {
        const opts = args.filter((a) => /^-[a-zA-Z]+$/.test(a)).join("");
        const rest = args.filter((a) => !/^-[a-zA-Z]+$/.test(a) && !/^-[AB]\d+$/.test(a));
        const pattern = rest[0];
        if (pattern === undefined) return "Usage: grep [OPTION]... PATTERNS [FILE]...";
        const files = rest.slice(1);
        if (files.some((f) => this.readFile(f) === undefined)) return `grep: ${files.find((f) => this.readFile(f) === undefined)}: No such file or directory`;
        let re: RegExp;
        try {
          re = new RegExp(opts.includes("F") ? pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : pattern, opts.includes("i") ? "i" : "");
        } catch {
          re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
        }
        const lines = inputOf(files).split("\n");
        const hits = lines.map((l, i) => ({ l, i })).filter(({ l }) => re.test(l) !== opts.includes("v"));
        if (opts.includes("c")) return String(hits.length);
        const after = Number(args.find((a) => /^-A\d+$/.test(a))?.slice(2) ?? 0);
        const before = Number(args.find((a) => /^-B\d+$/.test(a))?.slice(2) ?? 0);
        if (after || before) {
          const keep = new Set<number>();
          hits.forEach(({ i }) => {
            for (let k = i - before; k <= i + after; k++) keep.add(k);
          });
          return [...keep].filter((k) => k >= 0 && k < lines.length).sort((a, b) => a - b).map((k) => lines[k]).join("\n");
        }
        return hits.map(({ l, i }) => (opts.includes("n") ? `${i + 1}:${l}` : l)).join("\n");
      }
      case "head":
      case "tail": {
        const nArg = args.find((a) => /^-n?\d+$/.test(a)) ?? (args.includes("-n") ? args[args.indexOf("-n") + 1] : undefined);
        const n = Number((nArg ?? "10").replace(/^-n?/, "")) || 10;
        const files = args.filter((a) => !a.startsWith("-") && a !== nArg);
        const lines = inputOf(files).split("\n");
        return (cmd === "head" ? lines.slice(0, n) : lines.slice(-n)).join("\n");
      }
      case "wc": {
        const text = inputOf(args.filter((a) => !a.startsWith("-")));
        const lines = text ? text.split("\n").length : 0;
        return args.includes("-l") ? String(lines) : `${lines} ${text.split(/\s+/).filter(Boolean).length} ${text.length}`;
      }
      case "sort":
        return inputOf(args.filter((a) => !a.startsWith("-"))).split("\n").sort().join("\n");
      case "uniq":
        return inputOf(args).split("\n").filter((l, i, a) => l !== a[i - 1]).join("\n");
      case "base64": {
        const decode = args.includes("-d") || args.includes("--decode");
        const text = (inputOf(args.filter((a) => !a.startsWith("-"))) ?? "").trim();
        try {
          return decode ? atob(text) : btoa(text);
        } catch {
          return "base64: invalid input";
        }
      }
      case "tee": {
        const file = args.find((a) => !a.startsWith("-"));
        if (file) this.writeFile(file, (args.includes("-a") ? (this.readFile(file) ?? "") : "") + (stdin ?? ""));
        return stdin ?? "";
      }
      case "whoami":
        return "danylo";
      case "id":
        return "uid=1000(danylo) gid=1000(danylo) groups=1000(danylo),27(sudo),999(docker)";
      case "hostname":
        return this.host;
      case "date":
        return new Date().toString();
      case "uname":
        return args.includes("-a") ? `Linux ${this.host} 6.8.0-45-generic #45-Ubuntu SMP x86_64 GNU/Linux` : "Linux";
      case "history":
        return this.log.map((l, i) => `${String(i + 1).padStart(4)}  ${l}`).join("\n");
      case "export":
      case "alias": {
        const joined = args.join(" ");
        const m = /^(\w[\w-]*)=(.*)$/.exec(joined);
        if (!m) return cmd === "alias" ? Object.entries(this.aliases).map(([k, v]) => `alias ${k}='${v}'`).join("\n") : Object.entries(this.env).map(([k, v]) => `declare -x ${k}="${v}"`).join("\n");
        const value = m[2].replace(/^["']|["']$/g, "");
        if (cmd === "alias") this.aliases[m[1]] = value;
        else this.env[m[1]] = value;
        return "";
      }
      case "unset":
        for (const a of args) delete this.env[a];
        return "";
      case "env":
      case "printenv":
        return args[0] ? env[args[0]] ?? "" : Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n");
      case "which": {
        const t = args[0];
        return getTool(t) || BUILTINS.includes(t) ? `/usr/local/bin/${t}` : "";
      }
      case "exit":
      case "logout":
        if (this.host !== this.homeHost) {
          const from = this.host;
          this.host = this.homeHost;
          this.cwd = PROJECT;
          return `logout\nConnection to ${from} closed.`;
        }
        return "logout (sessão principal — use o botão ↺ para reiniciar o ambiente)";
      case "ssh": {
        const target = args.filter((a) => !a.startsWith("-")).pop()?.split("@").pop();
        if (!target) return "usage: ssh [-i identity_file] [user@]hostname";
        if (!this.state.hosts[target]) return `ssh: Could not resolve hostname ${target}: Name or service not known`;
        this.host = target;
        this.cwd = HOME;
        return `Welcome to Ubuntu 24.04 LTS (GNU/Linux 6.8.0-45-generic x86_64)\nLast login: ${new Date().toUTCString()} from 172.18.0.1`;
      }
      case "systemctl":
        return this.systemctl(args);
      case "journalctl": {
        const unit = args.includes("-u") ? args[args.indexOf("-u") + 1] : args.find((a) => a.startsWith("--unit="))?.split("=")[1];
        const svc = unit ? this.hostOf().services[unit.replace(/\.service$/, "")] : undefined;
        if (!unit || !svc) return "-- No entries --";
        const lines = svc.logs.length ? svc.logs : [`${unit}[1042]: started successfully`];
        const nArg = args.includes("-n") ? Number(args[args.indexOf("-n") + 1]) : lines.length;
        return lines.slice(-nArg).map((l) => `Sep 23 12:00:${String(Math.floor(Math.random() * 60)).padStart(2, "0")} ${this.host} ${l}`).join("\n");
      }
      case "apt-get":
      case "apt":
        return this.apt(args);
      case "apt-mark":
        return args.slice(1).map((p) => `${p} ${args[0] === "hold" ? "set on hold" : "was already not on hold"}.`).join("\n");
      case "apt-cache": {
        const pkg = args[args.length - 1];
        return ["1.31.1-1.1", "1.31.0-1.1", "1.30.2-1.1", "1.30.0-1.1"].map((v) => `   ${pkg} | ${v} | https://pkgs.k8s.io/core:/stable:/v${v.slice(0, 4)}/deb  Packages`).join("\n");
      }
      case "vi":
      case "vim":
      case "nano": {
        const file = args.find((a) => !a.startsWith("-"));
        if (!file) return `${cmd}: informe um arquivo, ex.: ${cmd} deployment.yaml`;
        const path = this.resolve(file);
        return { output: "", edit: { path, content: this.state.files[path] ?? "" } };
      }
      case "watch":
        return this.exec(args.filter((a) => !a.startsWith("-") && !/^\d+$/.test(a)).join(" ")).output;
      case "curl":
      case "wget":
        return this.http(cmd, args);
      default:
        return null;
    }
  }

  private systemctl(args: string[]): string {
    const [action, unitArg] = args.filter((a) => !a.startsWith("-"));
    const host = this.hostOf();
    if (action === "daemon-reload") return "";
    if (action === "list-units")
      return Object.entries(host.services).map(([n, s]) => `${(n + ".service").padEnd(24)} loaded ${s.active ? "active   running" : "failed   failed "} ${n}`).join("\n");
    if (!unitArg) return `Too few arguments.`;
    const name = unitArg.replace(/\.service$/, "");
    const svc: ServiceUnit | undefined = host.services[name];
    if (!svc) return `Failed to ${action} ${name}.service: Unit ${name}.service not found.`;
    const failed = `Job for ${name}.service failed because the control process exited with error code.\nSee "systemctl status ${name}.service" and "journalctl -xeu ${name}.service" for details.`;
    const setActive = (v: boolean) => {
      svc.active = v;
      svc.logs.push(`systemd[1]: ${v ? "Started" : "Stopped"} ${name}.service.`);
      if (name === "kubelet" && v) {
        const node = this.state.nodes.find((n) => n.name === host.name);
        if (node && host.packages.kubelet) node.version = `v${host.packages.kubelet.split("-")[0]}`;
      }
    };
    switch (action) {
      case "start":
      case "restart":
      case "reload":
        if (svc.failReason) {
          svc.logs.push(svc.failReason);
          return failed;
        }
        setActive(true);
        return "";
      case "stop":
        setActive(false);
        return "";
      case "enable":
        svc.enabled = true;
        if (args.includes("--now") && !svc.failReason) setActive(true);
        return `Created symlink /etc/systemd/system/multi-user.target.wants/${name}.service → /lib/systemd/system/${name}.service.`;
      case "disable":
        svc.enabled = false;
        return `Removed /etc/systemd/system/multi-user.target.wants/${name}.service.`;
      case "is-active":
        return svc.active ? "active" : "inactive";
      case "is-enabled":
        return svc.enabled ? "enabled" : "disabled";
      case "status":
        return [
          `${svc.active ? "●" : "○"} ${name}.service - ${name}`,
          `     Loaded: loaded (/lib/systemd/system/${name}.service; ${svc.enabled ? "enabled" : "disabled"}; preset: enabled)`,
          `     Active: ${svc.active ? "active (running)" : svc.failReason ? "activating (auto-restart) (Result: exit-code)" : "inactive (dead)"} since ${new Date().toUTCString()}`,
          ...(svc.failReason ? [`    Process: 2211 ExecStart=/usr/bin/${name} (code=exited, status=1/FAILURE)`] : []),
          ...svc.logs.slice(-3).map((l) => `${new Date().toTimeString().slice(0, 8)} ${host.name} ${l}`),
        ].join("\n");
      default:
        return `Unknown command verb ${action}.`;
    }
  }

  private apt(args: string[]): string {
    const action = args.find((a) => !a.startsWith("-"));
    const host = this.hostOf();
    if (action === "update") return "Hit:1 http://archive.ubuntu.com/ubuntu noble InRelease\nGet:2 https://pkgs.k8s.io/core:/stable:/v1.31/deb  InRelease [1186 B]\nReading package lists... Done";
    if (action === "install" || action === "upgrade") {
      const pkgs = args.filter((a) => !a.startsWith("-") && a !== action);
      const lines = ["Reading package lists... Done", "Building dependency tree... Done"];
      for (const p of pkgs) {
        const [name, ver] = p.replace(/['"]/g, "").split("=");
        const version = ver ?? host.packages[name] ?? "latest";
        const prev = host.packages[name];
        host.packages[name] = version;
        lines.push(prev ? `Preparing to unpack .../${name}_${version}_amd64.deb ...\nUnpacking ${name} (${version}) over (${prev}) ...` : `Setting up ${name} (${version}) ...`);
        if (!host.services[name] && ["nginx", "apache2", "docker.io", "containerd", "redis-server", "postgresql"].includes(name))
          host.services[name] = { active: true, enabled: true, logs: [] };
      }
      return lines.join("\n");
    }
    return `E: Invalid operation ${action}`;
  }

  // ---------- curl / wget ----------
  private http(cmd: string, args: string[]): string {
    const url = args.find((a) => !a.startsWith("-") && !/^\d+$/.test(a));
    if (!url) return `${cmd}: try '${cmd} --help' for more information`;
    const m = /^(?:(https?):\/\/)?([^:/]+)(?::(\d+))?(\/.*)?$/.exec(url);
    const host = m?.[2] ?? "";
    const port = Number(m?.[3] ?? (m?.[1] === "https" ? 443 : 80));
    const path = m?.[4] ?? "/";
    for (const t of allTools()) {
      const r = t.http?.({ host, port, path }, this);
      if (r != null) return r;
    }
    return cmd === "curl"
      ? `curl: (7) Failed to connect to ${host} port ${port} after 0 ms: Connection refused`
      : `wget: can't connect to remote host (${host}): Connection refused`;
  }
}

export { HOME, PROJECT };
