// kubesec: security risk score for Kubernetes workloads.
import YAML from "yaml";
import { registerTool } from "../registry";
import type { Shell } from "../shell";

type Rule = { id: string; selector: string; reason: string; points: number };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const specOf = (doc: Json) => (doc.kind === "Pod" ? doc.spec : doc.kind === "CronJob" ? doc.spec?.jobTemplate?.spec?.template?.spec : doc.spec?.template?.spec) ?? {};
const containersOf = (spec: Json): Json[] => [...(spec.containers ?? []), ...(spec.initContainers ?? [])];
const scs = (spec: Json) => containersOf(spec).map((c) => c.securityContext ?? {});

const CRITICAL: (Rule & { test: (spec: Json, doc: Json) => boolean })[] = [
  { id: "Privileged", selector: "containers[] .securityContext .privileged == true", reason: "Privileged containers can allow almost completely unrestricted host access", points: -30, test: (s) => scs(s).some((x) => x.privileged === true) },
  { id: "CapSysAdmin", selector: "containers[] .securityContext .capabilities .add == SYS_ADMIN", reason: "CAP_SYS_ADMIN is the most privileged capability and should always be avoided", points: -30, test: (s) => scs(s).some((x) => (x.capabilities?.add ?? []).includes("SYS_ADMIN")) },
  { id: "HostNetwork", selector: ".spec .hostNetwork == true", reason: "Sharing the host's network namespace permits processes in the pod to communicate with processes bound to the host's loopback adapter", points: -9, test: (s) => s.hostNetwork === true },
  { id: "HostPID", selector: ".spec .hostPID == true", reason: "Sharing the host's PID namespace allows visibility of processes on the host, potentially leaking information such as environment variables and configuration", points: -9, test: (s) => s.hostPID === true },
  { id: "HostIPC", selector: ".spec .hostIPC == true", reason: "Sharing the host's IPC namespace allows container processes to communicate with processes on the host", points: -9, test: (s) => s.hostIPC === true },
  { id: "DockerSock", selector: "volumes[] .hostPath .path == /var/run/docker.sock", reason: "Mounting the docker.socket leaks information about other containers and can allow container breakout", points: -9, test: (s) => (s.volumes ?? []).some((v: Json) => v.hostPath?.path === "/var/run/docker.sock") },
];

const ADVISE: (Rule & { test: (spec: Json, doc: Json) => boolean })[] = [
  { id: "ApparmorAny", selector: '.metadata .annotations ."container.apparmor.security.beta.kubernetes.io/nginx"', reason: "Well defined AppArmor policies may provide greater protection from unknown threats. WARNING: NOT PRODUCTION READY", points: 3, test: (s, d) => JSON.stringify(d).includes("apparmor") || scs(s).some((x) => x.appArmorProfile) },
  { id: "ServiceAccountName", selector: ".spec .serviceAccountName", reason: "Service accounts restrict Kubernetes API access and should be configured with least privilege", points: 3, test: (s) => !!s.serviceAccountName },
  { id: "SeccompAny", selector: ".spec .securityContext .seccompProfile .type", reason: "Seccomp profiles set minimum privilege and secure against unknown threats", points: 1, test: (s) => !!s.securityContext?.seccompProfile || scs(s).some((x) => x.seccompProfile) },
  { id: "AutomountServiceAccountToken", selector: ".spec .automountServiceAccountToken == false", reason: "Mounting service account tokens inside pods can provide an avenue for privilege escalation attacks where an attacker is able to compromise a single pod in the cluster", points: 1, test: (s) => s.automountServiceAccountToken === false },
  { id: "LimitsCPU", selector: "containers[] .resources .limits .cpu", reason: "Enforcing CPU limits prevents DOS via resource exhaustion", points: 1, test: (s) => containersOf(s).every((c) => c.resources?.limits?.cpu) },
  { id: "LimitsMemory", selector: "containers[] .resources .limits .memory", reason: "Enforcing memory limits prevents DOS via resource exhaustion", points: 1, test: (s) => containersOf(s).every((c) => c.resources?.limits?.memory) },
  { id: "RequestsCPU", selector: "containers[] .resources .requests .cpu", reason: "Enforcing CPU requests aids a fair balancing of resources across the cluster", points: 1, test: (s) => containersOf(s).every((c) => c.resources?.requests?.cpu) },
  { id: "RequestsMemory", selector: "containers[] .resources .requests .memory", reason: "Enforcing memory requests aids a fair balancing of resources across the cluster", points: 1, test: (s) => containersOf(s).every((c) => c.resources?.requests?.memory) },
  { id: "CapDropAny", selector: "containers[] .securityContext .capabilities .drop", reason: "Reducing kernel capabilities available to a container limits its attack surface", points: 1, test: (s) => scs(s).every((x) => (x.capabilities?.drop ?? []).length > 0) },
  { id: "CapDropAll", selector: "containers[] .securityContext .capabilities .drop | index(\"ALL\")", reason: "Drop all capabilities and add only those required to reduce syscall attack surface", points: 1, test: (s) => scs(s).every((x) => (x.capabilities?.drop ?? []).map((c: string) => String(c).toUpperCase()).includes("ALL")) },
  { id: "ReadOnlyRootFilesystem", selector: "containers[] .securityContext .readOnlyRootFilesystem == true", reason: "An immutable root filesystem can prevent malicious binaries being added to PATH and increase attack cost", points: 1, test: (s) => scs(s).every((x) => x.readOnlyRootFilesystem === true) },
  { id: "RunAsNonRoot", selector: "containers[] .securityContext .runAsNonRoot == true", reason: "Force the running image to run as a non-root user to ensure least privilege", points: 1, test: (s) => scs(s).every((x) => (x.runAsNonRoot ?? s.securityContext?.runAsNonRoot) === true) },
  { id: "RunAsUser", selector: "containers[] .securityContext .runAsUser -gt 10000", reason: "Run as a high-UID user to avoid conflicts with the host's user table", points: 1, test: (s) => scs(s).every((x) => (x.runAsUser ?? s.securityContext?.runAsUser ?? 0) > 10000) },
];

export type KubesecResult = { object: string; valid: boolean; fileName: string; message: string; score: number; critical: string[]; passed: string[] };

/** Scores every workload in a YAML file. */
export const kubesecScore = (content: string, fileName: string): KubesecResult[] | { error: string } => {
  let docs: Json[];
  try {
    docs = YAML.parseAllDocuments(content).map((d) => {
      if (d.errors.length) throw new Error(d.errors[0].message);
      return d.toJS();
    });
  } catch (e) {
    return { error: (e as Error).message };
  }
  return docs
    .filter((d) => d && typeof d === "object" && d.kind)
    .map((d) => {
      const obj = `${d.kind}/${d.metadata?.name ?? "unknown"}.${d.metadata?.namespace ?? "default"}`;
      if (!["Pod", "Deployment", "StatefulSet", "DaemonSet", "ReplicaSet", "Job", "CronJob"].includes(d.kind))
        return { object: obj, valid: false, fileName, message: `This resource kind is not supported by kubesec`, score: 0, critical: [], passed: [] };
      const spec = specOf(d);
      const crit = CRITICAL.filter((r) => r.test(spec, d));
      const passed = ADVISE.filter((r) => r.test(spec, d));
      const score = crit.length ? crit.reduce((n, r) => n + r.points, 0) : passed.reduce((n, r) => n + r.points, 0);
      return { object: obj, valid: true, fileName, message: crit.length ? `Failed with a score of ${score} points` : `Passed with a score of ${score} points`, score, critical: crit.map((r) => r.id), passed: passed.map((r) => r.id) };
    });
};

export const kubesecState = (sh: Shell) => sh.ext("sec:kubesec", () => ({ runs: [] as { file: string; results: KubesecResult[] }[] }));

const rule = (r: Rule) => ({ id: r.id, selector: r.selector, reason: r.reason, points: r.points });

registerTool({
  name: "kubesec",
  summary: "dá uma nota de risco de segurança para Pods/Deployments do Kubernetes",
  subcommands: { scan: "analisa um manifesto YAML e devolve score, críticos e conselhos", version: "mostra a versão" },
  flags: { "-o": "formato: json (padrão) ou template" },
  valueFlags: ["-o", "--format", "--exit-code"],
  run: ({ sh, pos, stdin }) => {
    const [sub, file] = pos;
    if (!sub) return "Validate Kubernetes resource security policies\n\nUsage:\n  kubesec [command]\n\nAvailable Commands:\n  scan        Scans Kubernetes resource YAML or JSON\n  version     Prints kubesec version";
    if (sub === "version") return "version 2.14.1\ngit commit 0000000\nbuild date 2024-08-01";
    if (sub !== "scan") return { output: `Error: unknown command "${sub}" for "kubesec"\nRun 'kubesec --help' for usage.`, ok: false };
    if (!file) return { output: "Error: file path is required", ok: false };
    const content = file === "-" ? stdin : sh.readFile(file);
    if (content === undefined) return { output: `Error: open ${file}: no such file or directory`, ok: false };
    const res = kubesecScore(content, file);
    if ("error" in res) return { output: `Error: failed to parse ${file}: ${res.error}`, ok: false };
    kubesecState(sh).runs.push({ file: file === "-" ? "STDIN" : sh.resolve(file), results: res });
    if (file !== "-") sh.flags.add(`sec:config-scanned:${sh.resolve(file)}`);
    const out = res.map((r) => ({
      object: r.object,
      valid: r.valid,
      fileName: r.fileName,
      message: r.message,
      score: r.score,
      scoring: {
        ...(r.critical.length ? { critical: CRITICAL.filter((x) => r.critical.includes(x.id)).map(rule) } : {}),
        ...(r.passed.length ? { passed: ADVISE.filter((x) => r.passed.includes(x.id)).map(rule) } : {}),
        advise: ADVISE.filter((x) => !r.passed.includes(x.id)).map(rule),
      },
    }));
    return { output: JSON.stringify(out, null, 2), ok: res.every((r) => r.score >= 0) };
  },
  explainError: (cmd, output) => {
    if (/Failed with a score of -\d+/.test(output))
      return "Score negativo = há itens críticos (ex.: privileged: true vale -30). kubesec sai com código 1 nesse caso, então também serve de gate em CI. Corrija os itens em scoring.critical e depois some pontos com os de advise.";
    if (/no such file/.test(output)) return "Arquivo não encontrado. Use ls k8s/ para ver os manifestos.";
    return null;
  },
});
