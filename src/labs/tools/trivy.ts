// trivy: vulnerability (image, fs, sbom), secret and misconfiguration (config, k8s) scanner.
import YAML from "yaml";
import { registerTool } from "../registry";
import type { Shell } from "../shell";
import type { Flags } from "../types";
import {
  SEVERITIES, boxTable, countBySev, digestOf, dockerFacts, findSecrets, imageInfo, isDockerfile, isRootUser, isTerraform, isYaml, k8sWorkloads,
  lockfileVulns, logTime, parseHcl, parseRef, relTo, tfResources, usesLatest, walkFiles, hclStr,
  type HclBlock, type HclFile, type Severity, type Vuln,
} from "./sec-common";

// ---------------------------------------------------------------- state (read by lab checks)
export type TrivyRun = {
  mode: "image" | "fs" | "config" | "sbom" | "k8s" | "repo";
  /** normalized image ref or absolute path */
  target: string;
  /** counts after every filter (severity, ignore-unfixed, .trivyignore) */
  counts: Record<Severity, number>;
  total: number;
  severities: Severity[];
  ignoreUnfixed: boolean;
  exitCode: number;
  /** true when --exit-code was set and findings made trivy exit non-zero */
  gateFailed: boolean;
  misconfigIds: string[];
  files: string[];
};

export const trivyState = (sh: Shell) => sh.ext("sec:trivy", () => ({ runs: [] as TrivyRun[] }));
export const lastTrivyRun = (sh: Shell, mode?: TrivyRun["mode"]) => {
  const runs = trivyState(sh).runs.filter((r) => !mode || r.mode === mode);
  return runs[runs.length - 1];
};

// ---------------------------------------------------------------- misconfiguration checks
export type Misconfig = { id: string; sev: Severity; title: string; message: string; desc: string; line: number; endLine?: number; resolution: string };
export type ConfigResult = { file: string; abs: string; type: "dockerfile" | "kubernetes" | "terraform"; tests: number; failures: Misconfig[]; error?: string };

const avdUrl = (id: string) => `https://avd.aquasec.com/misconfig/${id.replace(/^AVD-/, "").replace(/-/g, "").toLowerCase().replace(/^aws/, "aws/")}`;

const ignoredBy = (lines: string[], m: Misconfig, fileIgnores: Set<string>) => {
  if (fileIgnores.has(m.id) || fileIgnores.has(m.id.replace(/^AVD-/, ""))) return true;
  const around = [lines[m.line - 2], lines[m.line - 1]].filter(Boolean).join("\n");
  const re = /trivy:ignore:([\w-]+)/g;
  let x: RegExpExecArray | null;
  while ((x = re.exec(around))) if (x[1] === m.id || `AVD-${x[1]}` === m.id || x[1] === m.id.replace(/^AVD-/, "")) return true;
  return false;
};

export const dockerfileMisconfigs = (content: string): Misconfig[] => {
  const f = dockerFacts(content);
  const out: Misconfig[] = [];
  for (const from of f.froms)
    if (usesLatest(from.image) && from.image.toLowerCase() !== "scratch" && !f.froms.some((x) => x !== from && content.match(new RegExp(`AS\\s+${from.image}\\b`, "i"))))
      out.push({
        id: "AVD-DS-0001", sev: "MEDIUM", title: "':latest' tag used", line: from.line,
        message: `Specify a tag in the 'FROM' statement for image '${from.image.split(":")[0]}'`,
        desc: "When using a 'FROM' statement you should use a specific tag to avoid uncontrolled behavior when the image is updated.",
        resolution: "Add a tag to the image in the 'FROM' statement",
      });
  if (isRootUser(f.lastUser?.user))
    out.push({
      id: "AVD-DS-0002", sev: "HIGH", title: "Image user should not be 'root'", line: f.lastUser?.line ?? f.lastLine,
      message: f.lastUser ? "Last USER command in Dockerfile should not be 'root'" : "Specify at least 1 USER command in Dockerfile with non-root user as argument",
      desc: "Running containers with 'root' user can lead to a container escape situation. It is a best practice to run containers as non-root users, which can be done by adding a 'USER' statement to the Dockerfile.",
      resolution: "Add 'USER <non root user name>' line to the Dockerfile",
    });
  if (f.expose22)
    out.push({ id: "AVD-DS-0004", sev: "MEDIUM", title: "Port 22 exposed", line: f.expose22, message: "Port 22 should not be exposed in Dockerfile", desc: "Exposing port 22 might allow users to SSH into the container.", resolution: "Remove 'EXPOSE 22' statement from the Dockerfile" });
  if (f.add)
    out.push({ id: "AVD-DS-0005", sev: "LOW", title: "ADD instead of COPY", line: f.add, message: "Consider using 'COPY' command instead of 'ADD'", desc: "You should use COPY instead of ADD unless you want to extract a tar file. Note that an ADD command will extract a tar file, which adds the risk of Zip-based vulnerabilities.", resolution: "Use COPY instead of ADD" });
  if (!f.healthcheck)
    out.push({ id: "AVD-DS-0026", sev: "LOW", title: "No HEALTHCHECK defined", line: 1, endLine: f.lastLine, message: "Add HEALTHCHECK instruction in your Dockerfile", desc: "You should add HEALTHCHECK instruction in your docker container images to perform the health check on running containers.", resolution: "Add HEALTHCHECK instruction in Dockerfile" });
  return out;
};

export const k8sMisconfigs = (content: string): { failures: Misconfig[]; error?: string } => {
  const { workloads, error } = k8sWorkloads(content);
  const out: Misconfig[] = [];
  for (const w of workloads) {
    const who = `${w.kind} '${w.name}'`;
    const specPrefix = w.kind === "Pod" ? "spec" : "spec.template.spec";
    const add = (id: string, sev: Severity, title: string, message: string, desc: string, line: number, resolution: string) =>
      out.push({ id, sev, title, message, desc, line, resolution });
    for (const c of w.containers) {
      const cw = `Container '${c.name}' of ${who}`;
      if (c.allowPrivEsc) add("KSV001", "MEDIUM", "Can elevate its own privileges", `${cw} should set 'securityContext.allowPrivilegeEscalation' to false`, "A program inside the container can elevate its own privileges and run as root, which might give the program control over the container and node.", c.lines.allowPrivilegeEscalation, "Set 'set containers[].securityContext.allowPrivilegeEscalation' to 'false'.");
      if (!c.dropAll) add("KSV003", "LOW", "Default capabilities: some containers do not drop all", `${cw} should add 'ALL' to 'securityContext.capabilities.drop'`, "The container should drop all default capabilities and add only those that are needed for its execution.", c.lines.securityContext, "Add 'ALL' to containers[].securityContext.capabilities.drop.");
      if (!c.limits) add("KSV011", "LOW", "CPU not limited", `${cw} should set 'resources.limits.cpu'`, "Enforcing CPU limits prevents DoS via resource exhaustion.", c.line, "Set a limit value under 'containers[].resources.limits.cpu'.");
      if (!c.runAsNonRoot) add("KSV012", "MEDIUM", "Runs as root user", `${cw} should set 'securityContext.runAsNonRoot' to true`, "Force the running image to run as a non-root user to ensure least privileges.", c.lines.securityContext, "Set 'containers[].securityContext.runAsNonRoot' to true.");
      if (usesLatest(c.image)) add("KSV013", "MEDIUM", "Image tag \":latest\" used", `${cw} should specify an image tag`, "It is best to avoid using the ':latest' image tag when deploying containers in production.", c.lines.image, "Use a specific container image tag that is not 'latest'.");
      if (!c.readOnlyRoot) add("KSV014", "HIGH", "Root file system is not read-only", `${cw} should set 'securityContext.readOnlyRootFilesystem' to true`, "An immutable root file system prevents applications from writing to their local disk. This can limit intrusions, as attackers will not be able to tamper with the file system or write foreign executables to disk.", c.lines.readOnlyRootFilesystem, "Change 'containers[].securityContext.readOnlyRootFilesystem' to 'true'.");
      if (c.privileged) add("KSV017", "HIGH", "Privileged container", `${cw} should set 'securityContext.privileged' to false`, "Privileged containers share namespaces with the host system and do not offer any security. They should be used exclusively for system containers that require high privileges.", c.lines.privileged, "Change 'containers[].securityContext.privileged' to 'false'.");
      if (!c.limits) add("KSV018", "LOW", "Memory not limited", `${cw} should set 'resources.limits.memory'`, "Enforcing memory limits prevents DoS via resource exhaustion.", c.line, "Set a limit value under 'containers[].resources.limits.memory'.");
      if (c.addCaps.some((x) => x !== "NET_BIND_SERVICE")) add("KSV022", "MEDIUM", "Non-default capabilities added", `${cw} should not set securityContext.capabilities.add`, "Adding NET_RAW or capabilities beyond the default set must be disallowed.", c.lines.securityContext, "Do not set spec.containers[*].securityContext.capabilities.add and spec.initContainers[*].securityContext.capabilities.add.");
    }
    if (w.hostIPC) add("KSV008", "HIGH", "Access to host IPC namespace", `${who} should not set '${specPrefix}.hostIPC' to true`, "Sharing the host's IPC namespace allows container processes to communicate with processes on the host.", w.startLine, "Do not set 'spec.template.spec.hostIPC' to true.");
    if (w.hostNetwork) add("KSV009", "HIGH", "Access to host network", `${who} should not set '${specPrefix}.hostNetwork' to true`, "Sharing the host's network namespace permits processes in the pod to communicate with processes bound to the host's loopback adapter.", w.startLine, "Do not set 'spec.template.spec.hostNetwork' to true.");
    if (w.hostPID) add("KSV010", "HIGH", "Access to host PID", `${who} should not set '${specPrefix}.hostPID' to true`, "Sharing the host's PID namespace allows visibility on host processes, potentially leaking information such as environment variables and configuration.", w.startLine, "Do not set 'spec.template.spec.hostPID' to true.");
    if (w.hostPaths.length) add("KSV023", "MEDIUM", "hostPath volumes mounted", `${who} should not set '${specPrefix}.volumes.hostPath'`, "According to pod security standard 'HostPath Volumes', HostPath volumes must be forbidden.", w.startLine, "Do not set 'spec.volumes[*].hostPath'.");
  }
  return { failures: out, error };
};

/** Resources of type `type` whose `bucket` argument points at the given aws_s3_bucket. */
export const s3Companions = (f: HclFile, bucket: HclBlock, type: string) => {
  const name = bucket.labels[1];
  const literal = hclStr(bucket.attrs.bucket);
  return tfResources(f).filter((r) => {
    if (r.labels[0] !== type) return false;
    const b = hclStr(r.attrs.bucket);
    return b.startsWith(`aws_s3_bucket.${name}.`) || (!!literal && b === literal);
  });
};

const ingressRules = (f: HclFile) => {
  const rules: { res: HclBlock; block: HclBlock | null; from: number; to: number; protocol: string; cidrs: string[]; line: number; desc: string }[] = [];
  const cidrsOf = (b: { attrs: Record<string, unknown> }) =>
    [...((b.attrs.cidr_blocks as string[]) ?? []), ...((b.attrs.ipv6_cidr_blocks as string[]) ?? []), ...(b.attrs.cidr_ipv4 ? [String(b.attrs.cidr_ipv4)] : [])].map(String);
  for (const r of tfResources(f)) {
    if (r.labels[0] === "aws_security_group")
      for (const b of r.blocks.filter((x) => x.type === "ingress"))
        rules.push({ res: r, block: b, from: Number(b.attrs.from_port ?? 0), to: Number(b.attrs.to_port ?? 0), protocol: hclStr(b.attrs.protocol), cidrs: cidrsOf(b), line: b.start, desc: hclStr(b.attrs.description) });
    if ((r.labels[0] === "aws_security_group_rule" && hclStr(r.attrs.type) === "ingress") || r.labels[0] === "aws_vpc_security_group_ingress_rule")
      rules.push({ res: r, block: null, from: Number(r.attrs.from_port ?? 0), to: Number(r.attrs.to_port ?? 0), protocol: hclStr(r.attrs.protocol ?? r.attrs.ip_protocol), cidrs: cidrsOf(r), line: r.start, desc: hclStr(r.attrs.description) });
  }
  return rules;
};
export const openToWorld = (cidrs: string[]) => cidrs.some((c) => c === "0.0.0.0/0" || c === "::/0");
export const coversPort = (r: { from: number; to: number; protocol: string }, port: number) => r.protocol === "-1" || r.protocol === "all" || (r.from <= port && port <= r.to);
export { ingressRules };

export const tfMisconfigs = (content: string): { failures: Misconfig[]; error?: string; resources: number } => {
  let f: HclFile;
  try {
    f = parseHcl(content);
  } catch (e) {
    return { failures: [], error: (e as Error).message, resources: 0 };
  }
  const out: Misconfig[] = [];
  const add = (id: string, sev: Severity, title: string, message: string, desc: string, r: { start: number; end: number }, resolution: string) =>
    out.push({ id, sev, title, message, desc, line: r.start, endLine: r.end, resolution });
  const res = tfResources(f);
  for (const b of res.filter((r) => r.labels[0] === "aws_s3_bucket")) {
    const pab = s3Companions(f, b, "aws_s3_bucket_public_access_block")[0];
    const on = (k: string) => pab?.attrs[k] === true;
    if (!on("block_public_acls")) add("AVD-AWS-0086", "HIGH", "S3 Access block should block public ACL", "No public access block so not blocking public acls", "S3 buckets should block public ACLs on buckets and any objects they contain. By blocking, PUTs with fail if the object has any public ACL a.", pab ?? b, "Enable blocking any PUT calls with a public ACL specified");
    if (!on("block_public_policy")) add("AVD-AWS-0087", "HIGH", "S3 Access block should block public policy", "No public access block so not blocking public policies", "S3 bucket policy should have block public policy to prevent users from putting a policy that enable public access.", pab ?? b, "Prevent policies that allow public access being PUT");
    const sse = s3Companions(f, b, "aws_s3_bucket_server_side_encryption_configuration")[0];
    const inlineSse = b.blocks.find((x) => x.type === "server_side_encryption_configuration");
    const algo = JSON.stringify(sse ?? inlineSse ?? {}).match(/"sse_algorithm":"([^"]+)"/)?.[1];
    if (!algo) add("AVD-AWS-0088", "HIGH", "Unencrypted S3 bucket.", "Bucket does not have encryption enabled", "S3 Buckets should be encrypted to protect the data that is stored within them if access is compromised.", b, "Configure bucket encryption");
    if (!s3Companions(f, b, "aws_s3_bucket_logging").length && !b.blocks.some((x) => x.type === "logging"))
      add("AVD-AWS-0089", "LOW", "S3 Bucket Logging", "Bucket has logging disabled", "Ensures S3 bucket logging is enabled for S3 buckets", b, "Add a logging block to the resource to enable access logging");
    const ver = s3Companions(f, b, "aws_s3_bucket_versioning")[0];
    const verOn = ver ? /"status":"Enabled"/.test(JSON.stringify(ver.blocks.map((x) => x.attrs))) : b.blocks.some((x) => x.type === "versioning" && x.attrs.enabled === true);
    if (!verOn) add("AVD-AWS-0090", "MEDIUM", "S3 Data should be versioned", "Bucket does not have versioning enabled", "Versioning in Amazon S3 is a means of keeping multiple variants of an object in the same bucket.", ver ?? b, "Enable versioning to protect against accidental/malicious removal or modification");
    if (!on("ignore_public_acls")) add("AVD-AWS-0091", "HIGH", "S3 Access Block should Ignore Public Acl", "No public access block so not ignoring public acls", "S3 buckets should ignore public ACLs on buckets and any objects they contain.", pab ?? b, "Enable ignoring the application of public ACLs in PUT calls");
    for (const acl of [...s3Companions(f, b, "aws_s3_bucket_acl"), b])
      if (/^public-read(-write)?$|^authenticated-read$/.test(hclStr(acl.attrs.acl)))
        add("AVD-AWS-0092", "HIGH", "S3 Buckets not publicly accessible through ACL.", `Bucket has a public ACL: "${hclStr(acl.attrs.acl)}"`, "Buckets should not have ACLs that allow public access", acl, "Don't use canned ACLs or switch to private acl");
    if (!on("restrict_public_buckets")) add("AVD-AWS-0093", "HIGH", "S3 Access block should restrict public bucket to limit access", "No public access block so not restricting public buckets", "S3 buckets should restrict public policies for the bucket.", pab ?? b, "Limit the access to public buckets to only the owner or AWS Services (eg; CloudFront)");
    if (!pab) add("AVD-AWS-0094", "LOW", "S3 buckets should each define an aws_s3_bucket_public_access_block", "Bucket does not have a corresponding public access block.", "The \"block public access\" settings in S3 override individual policies that apply to a given bucket.", b, "Define a aws_s3_bucket_public_access_block for the given bucket to control public access policies");
    if (algo && algo !== "aws:kms" && algo !== "aws:kms:dsse") add("AVD-AWS-0132", "HIGH", "S3 encryption should use Customer Managed Keys", "Bucket does not encrypt data with a customer managed key.", "Encryption using AWS keys provides protection for your S3 buckets. To increase control of the encryption and manage factors like rotation use customer managed keys.", sse ?? b, "Enable encryption using customer managed keys");
  }
  for (const r of ingressRules(f))
    if (openToWorld(r.cidrs))
      out.push({ id: "AVD-AWS-0107", sev: "CRITICAL", title: "An ingress security group rule allows traffic from /0.", message: "Security group rule allows ingress from public internet.", desc: "Opening up ports to the public internet is generally to be avoided. You should restrict access to IP addresses or ranges that explicitly require it where possible.", line: r.line, endLine: r.block?.end ?? r.res.end, resolution: "Set a more restrictive cidr range" });
  for (const r of res.filter((x) => x.labels[0] === "aws_security_group"))
    for (const e of r.blocks.filter((x) => x.type === "egress"))
      if (openToWorld(((e.attrs.cidr_blocks as string[]) ?? []).map(String)))
        out.push({ id: "AVD-AWS-0104", sev: "CRITICAL", title: "A security group rule should not allow unrestricted egress to any IP address.", message: "Security group rule allows unrestricted egress to any IP address.", desc: "Opening up ports to connect out to the public internet is generally to be avoided.", line: e.start, endLine: e.end, resolution: "Set a more restrictive cidr range" });
  return { failures: out, resources: res.length };
};

/** Scans every config file under target. */
export const configScan = (sh: Shell, target: string): ConfigResult[] => {
  const results: ConfigResult[] = [];
  const ignores = trivyIgnores(sh);
  for (const abs of walkFiles(sh, target)) {
    const content = sh.state.files[abs] ?? "";
    const file = relTo(sh, target, abs);
    const lines = content.split("\n");
    let r: ConfigResult | null = null;
    if (isDockerfile(abs)) r = { file, abs, type: "dockerfile", tests: 27, failures: dockerfileMisconfigs(content) };
    else if (isTerraform(abs)) {
      const t = tfMisconfigs(content);
      r = { file, abs, type: "terraform", tests: 12 * Math.max(1, t.resources), failures: t.failures, error: t.error };
    } else if (isYaml(abs) && /^\s*kind:/m.test(content) && /^\s*apiVersion:/m.test(content)) {
      const k = k8sMisconfigs(content);
      r = { file, abs, type: "kubernetes", tests: 94, failures: k.failures, error: k.error };
    }
    if (!r) continue;
    r.failures = r.failures.filter((m) => !ignoredBy(lines, m, ignores));
    results.push(r);
  }
  return results;
};

const trivyIgnores = (sh: Shell) =>
  new Set((sh.readFile(".trivyignore") ?? "").split("\n").map((l) => l.replace(/#.*/, "").trim()).filter(Boolean));

// ---------------------------------------------------------------- rendering helpers
const sevList = (flags: Flags): Severity[] | null => {
  const raw = flags.severity ?? flags.s;
  if (typeof raw !== "string") return SEVERITIES;
  const list = raw.split(",").map((x) => x.trim().toUpperCase());
  if (list.some((x) => !SEVERITIES.includes(x as Severity))) return null;
  return SEVERITIES.filter((x) => list.includes(x));
};

const totalLine = (label: string, items: { sev: Severity }[], sevs: Severity[]) => {
  const c = countBySev(items);
  return `${label}: ${items.length} (${sevs.map((s) => `${s}: ${c[s]}`).join(", ")})`;
};

const heading = (s: string) => `${s}\n${"=".repeat(s.length)}`;
const trunc = (s: string, n: number) => (s.length > n ? s.slice(0, n - 3) + "..." : s);

const vulnTable = (vulns: Vuln[]) =>
  boxTable(
    ["Library", "Vulnerability", "Severity", "Status", "Installed Version", "Fixed Version", "Title"],
    [...vulns]
      .sort((a, b) => a.pkg.localeCompare(b.pkg) || SEVERITIES.indexOf(b.sev) - SEVERITIES.indexOf(a.sev) || a.id.localeCompare(b.id))
      .map((x) => [x.pkg, x.id, x.sev, x.status ?? "fixed", x.installed, x.fixed, trunc(x.title, 58)]),
  );

const LEGEND = "Legend:\n- '-': Not scanned\n- '0': Clean (no security findings detected)\n";

const scannersOf = (flags: Flags, def: string[]) => {
  const raw = flags.scanners ?? flags["security-checks"];
  return typeof raw === "string" ? raw.split(",").map((x) => x.trim()).map((x) => (x === "config" ? "misconfig" : x)) : def;
};

// ---------------------------------------------------------------- secrets (trivy flavour)
const AWS_SECRET = /aws_?secret_?access_?key\W{0,5}\s*[:=]\s*["']?([A-Za-z0-9/+=]{40})["']?/i;

type TrivySecret = { ruleId: string; category: string; title: string; sev: Severity; line: number; text: string; secret: string };

const trivySecrets = (content: string): TrivySecret[] => {
  const out: TrivySecret[] = [];
  for (const h of findSecrets(content))
    if (h.rule.trivyId) out.push({ ruleId: h.rule.trivyId, category: h.rule.category, title: h.rule.trivyTitle, sev: h.rule.sev, line: h.line, text: h.text, secret: h.secret });
  content.split("\n").forEach((text, i) => {
    const m = AWS_SECRET.exec(text);
    if (m && !/process\.env|os\.environ|getenv/.test(text)) out.push({ ruleId: "aws-secret-access-key", category: "AWS", title: "AWS Secret Access Key", sev: "CRITICAL", line: i + 1, text, secret: m[1] });
  });
  return out.sort((a, b) => a.line - b.line);
};

const secretDetail = (file: string, content: string, s: TrivySecret) => {
  const lines = content.split("\n");
  const mask = (t: string) => t.split(s.secret).join("*".repeat(s.secret.length));
  const ctx = [s.line - 1, s.line, s.line + 1].filter((n) => n >= 1 && n <= lines.length);
  return [
    `${s.sev}: ${s.category} (${s.ruleId})`,
    "═".repeat(40),
    s.title,
    "─".repeat(40),
    ` ${file}:${s.line} (offset: ${lines.slice(0, s.line - 1).join("\n").length + 1} bytes)`,
    "─".repeat(40),
    ...ctx.map((n) => `${String(n).padStart(4)} ${n === s.line ? "[" : " "} ${mask(lines[n - 1])}`),
    "─".repeat(40),
    "",
  ].join("\n");
};

const misconfigDetail = (file: string, content: string, m: Misconfig) => {
  const lines = content.split("\n");
  const end = Math.min(m.endLine ?? m.line, m.line + 6, lines.length);
  const shown: string[] = [];
  for (let n = m.line; n <= end; n++) shown.push(`${String(n).padStart(4)} ${n === m.line ? "┌" : n === end ? "└" : "│"} ${lines[n - 1] ?? ""}`);
  if (m.line === end) shown[0] = `${String(m.line).padStart(4)} [ ${lines[m.line - 1] ?? ""}`;
  return [
    `${m.id} (${m.sev}): ${m.message}`,
    "═".repeat(40),
    m.desc,
    "",
    `See ${avdUrl(m.id)}`,
    "─".repeat(40),
    ` ${file}:${m.line}${end > m.line ? `-${end}` : ""}`,
    "─".repeat(40),
    ...shown,
    "─".repeat(40),
    "",
  ].join("\n");
};

// ---------------------------------------------------------------- the tool
const SUBS: Record<string, string> = {
  image: "escaneia uma imagem de container (pacotes do SO e de linguagem)",
  fs: "escaneia um diretório local (lockfiles, segredos e, com --scanners misconfig, IaC)",
  filesystem: "o mesmo que fs",
  config: "procura misconfigurations em Dockerfile, Kubernetes YAML e Terraform",
  sbom: "escaneia um SBOM (SPDX/CycloneDX) em busca de CVEs",
  k8s: "escaneia os workloads do cluster Kubernetes atual",
  kubernetes: "o mesmo que k8s",
  repo: "escaneia um repositório remoto",
  version: "mostra a versão do trivy e do banco de vulnerabilidades",
  clean: "limpa o cache local",
};

const fatal = (msg: string) => ({ output: `${logTime()}\tFATAL\tFatal error\t${msg}`, ok: false });

registerTool({
  name: "trivy",
  summary: "scanner de segurança: CVEs em imagens, segredos e misconfigurations de IaC",
  subcommands: SUBS,
  flags: {
    "--severity": "filtra por severidade (ex.: HIGH,CRITICAL)",
    "-s": "o mesmo que --severity",
    "--exit-code": "código de saída quando houver achados — é o que transforma o scan num gate de CI",
    "--ignore-unfixed": "esconde CVEs que ainda não têm correção publicada",
    "-f": "formato do relatório: table (padrão) ou json",
    "--format": "formato do relatório: table (padrão) ou json",
    "-o": "grava o relatório num arquivo",
    "--output": "grava o relatório num arquivo",
    "--scanners": "quais scanners rodar: vuln, secret, misconfig",
    "-q": "modo silencioso (sem logs INFO)",
    "--quiet": "modo silencioso (sem logs INFO)",
    "--report": "k8s: summary ou all",
    "--skip-dirs": "diretórios a ignorar",
  },
  valueFlags: ["--severity", "-s", "--exit-code", "-f", "--format", "-o", "--output", "--scanners", "--security-checks", "--report", "--skip-dirs", "--timeout", "--include-namespaces", "--namespace", "-n"],
  run: ({ sh, flags, pos }) => {
    const [sub, target] = pos;
    const quiet = !!(flags.q || flags.quiet);
    const logs: string[] = [];
    const info = (msg: string) => !quiet && logs.push(`${logTime()}\tINFO\t${msg}`);
    const warn = (msg: string) => !quiet && logs.push(`${logTime()}\tWARN\t${msg}`);
    const format = String(flags.f ?? flags.format ?? "table");
    const outFile = typeof (flags.o ?? flags.output) === "string" ? String(flags.o ?? flags.output) : undefined;
    const exitCode = Number(flags["exit-code"] ?? 0) || 0;
    const ignoreUnfixed = !!flags["ignore-unfixed"];
    const sevs = sevList(flags);

    if (!sub || flags.h || flags.help)
      return `Scanner for vulnerabilities in container images, file systems, and Git repositories, as well as for configuration issues and hard-coded secrets

Usage:
  trivy [global flags] command [flags] target

Scanning Commands
  config      Scan config files for misconfigurations
  filesystem  Scan local filesystem (alias: fs)
  image       Scan a container image (alias: i)
  kubernetes  [EXPERIMENTAL] Scan kubernetes cluster (alias: k8s)
  repository  Scan a repository (alias: repo)
  sbom        Scan SBOM for vulnerabilities and licenses

Management Commands
  clean       Remove cached files
  version     Print the version`;
    if (sub === "version" || flags.version) return "Version: 0.56.2\nVulnerability DB:\n  Version: 2\n  UpdatedAt: 2026-09-23 06:12:40.129381903 +0000 UTC\n  NextUpdate: 2026-09-24 06:12:40.129381644 +0000 UTC";
    if (sub === "clean") return `${logTime()}\tINFO\tRemoving scan cache...`;
    if (!sevs) return fatal(`flag error: unable to parse severity: invalid severity "${flags.severity ?? flags.s}"`);
    if (!["table", "json"].includes(format)) return fatal(`flag error: report flag error: invalid argument "${format}" for "--format" flag: must be one of: table, json`);

    const finish = (report: string, run: Omit<TrivyRun, "gateFailed" | "exitCode" | "severities" | "ignoreUnfixed">) => {
      const gateFailed = exitCode !== 0 && run.total > 0;
      trivyState(sh).runs.push({ ...run, severities: sevs, ignoreUnfixed, exitCode, gateFailed });
      sh.flags.add(`trivy:${run.mode}:${run.target}`);
      if (outFile) {
        sh.writeFile(outFile, report);
        return { output: logs.join("\n"), ok: !gateFailed };
      }
      return { output: [logs.join("\n"), report].filter(Boolean).join("\n\n"), ok: !gateFailed };
    };

    // ---------------- image / sbom
    if (sub === "image" || sub === "i" || sub === "sbom") {
      if (!target) return fatal(sub === "sbom" ? "sbom scan error: SBOM path required" : `image name is required\n\nUsage:\n  trivy image [flags] IMAGE_NAME`);
      let ref = target;
      if (sub === "sbom") {
        const raw = sh.readFile(target);
        if (raw === undefined) return fatal(`sbom scan error: open ${target}: no such file or directory`);
        try {
          const j = JSON.parse(raw);
          ref = j.name ?? j.metadata?.component?.name ?? "";
          if (!j.spdxVersion && !j.bomFormat) throw new Error("x");
        } catch {
          return fatal("sbom scan error: failed to detect SBOM format: unknown format");
        }
        info("Detected SBOM format\tformat=\"spdx-json\"");
      }
      const infoRes = imageInfo(ref);
      const r = parseRef(ref);
      if (!infoRes)
        return fatal(
          `run error: image scan error: scan error: unable to initialize a scan service: unable to initialize an image scan service: unable to find the specified image "${target}" in ["docker" "containerd" "podman" "remote"]: 4 errors occurred:\n\t* docker error: unable to inspect the image (${target}): Error response from daemon: No such image: ${target}\n\t* containerd error: containerd socket not found: /run/containerd/containerd.sock\n\t* podman error: unable to initialize Podman client: no podman socket found: stat podman/podman.sock: no such file or directory\n\t* remote error: GET https://${r.repo.includes(".") ? r.repo.split("/")[0] : "index.docker.io"}/v2/${r.repo.includes("/") ? r.repo.replace(/^[^/]*\.[^/]*\//, "") : `library/${r.repo}`}/manifests/${r.tag ?? r.digest}: MANIFEST_UNKNOWN: manifest unknown; unknown tag=${r.tag}`,
        );
      const scanners = scannersOf(flags, sub === "sbom" ? ["vuln"] : ["vuln", "secret"]);
      if (scanners.includes("vuln")) info("[vuln] Vulnerability scanning is enabled");
      if (scanners.includes("secret")) {
        info("[secret] Secret scanning is enabled");
        info("[secret] If your scanning is slow, please try '--scanners vuln' to disable secret scanning");
      }
      const [family, version] = infoRes.os.split(" ");
      info(`Detected OS\tfamily="${family}" version="${version}"`);
      info(`[${family}] Detecting vulnerabilities...\tos_version="${version.split(".").slice(0, family === "alpine" ? 2 : 1).join(".")}" pkg_num=${infoRes.pkgs}`);
      if (infoRes.lang?.length) {
        info(`Number of language-specific files\tnum=${infoRes.lang.length}`);
        for (const l of infoRes.lang) info(`[${l.type}] Detecting vulnerabilities...`);
      }
      if (/^debian 10/.test(infoRes.os)) {
        warn(`This OS version is no longer supported by the distribution\tfamily="debian" version="${version}"`);
        warn("The vulnerability detection may be insufficient because security updates are not provided");
      }
      const ignores = trivyIgnores(sh);
      const filt = (vs: Vuln[]) => (scanners.includes("vuln") ? vs : []).filter((x) => sevs.includes(x.sev) && (!ignoreUnfixed || x.status === "fixed") && !ignores.has(x.id));
      const targets = [
        { name: `${r.full} (${infoRes.os})`, type: family, vulns: filt(infoRes.vulns) },
        ...(infoRes.lang ?? []).map((l) => ({ name: l.target, type: l.type, vulns: filt(l.vulns) })),
      ];
      const all = targets.flatMap((t) => t.vulns);
      let report: string;
      if (format === "json") {
        report = JSON.stringify(
          {
            SchemaVersion: 2,
            CreatedAt: new Date().toISOString(),
            ArtifactName: target,
            ArtifactType: sub === "sbom" ? "spdx" : "container_image",
            Metadata: { OS: { Family: family, Name: version }, ImageID: digestOf(`${r.full}#config`), RepoDigests: [`${r.repo}@${digestOf(ref)}`] },
            Results: targets.map((t, i) => ({
              Target: t.name,
              Class: i === 0 ? "os-pkgs" : "lang-pkgs",
              Type: t.type,
              Vulnerabilities: t.vulns.map((x) => ({ VulnerabilityID: x.id, PkgName: x.pkg, InstalledVersion: x.installed, FixedVersion: x.fixed || undefined, Status: x.status, Severity: x.sev, Title: x.title, PrimaryURL: `https://avd.aquasec.com/nvd/${x.id.toLowerCase()}` })),
            })),
          },
          null,
          2,
        );
      } else {
        const summary = boxTable(
          ["Target", "Type", "Vulnerabilities", "Secrets"],
          targets.map((t, i) => [t.name, t.type, scanners.includes("vuln") ? String(t.vulns.length) : "-", scanners.includes("secret") && i === 0 ? "-" : "-"]),
          [1, 2, 3],
        );
        const details = targets
          .filter((t, i) => i === 0 || t.vulns.length)
          .map((t, i) => [heading(i ? `${t.name} (${t.type})` : t.name), totalLine("Total", t.vulns, sevs), "", t.vulns.length ? vulnTable(t.vulns) : ""].join("\n").trimEnd());
        report = ["Report Summary", "", summary, LEGEND, "", ...details].join("\n");
      }
      return finish(report, { mode: sub === "sbom" ? "sbom" : "image", target: r.full, counts: countBySev(all), total: all.length, misconfigIds: [], files: [] });
    }

    // ---------------- fs / config
    if (sub === "fs" || sub === "filesystem" || sub === "config" || sub === "repo") {
      if (sub === "repo") return fatal(`repository scan error: git clone error: authentication required (${target ?? "no repository"})`);
      if (!target) return fatal(`${sub === "config" ? "config" : "filesystem"} scan error: path required\n\nUsage:\n  trivy ${sub} [flags] PATH`);
      if (!sh.exists(target)) return fatal(`${sub === "config" ? "config" : "filesystem"} scan error: lstat ${target}: no such file or directory`);
      const scanners = sub === "config" ? ["misconfig"] : scannersOf(flags, ["vuln", "secret"]);
      const skip = typeof flags["skip-dirs"] === "string" ? String(flags["skip-dirs"]).split(",").map((d) => sh.resolve(d)) : [];
      const files = walkFiles(sh, target).filter((f) => !skip.some((d) => f.startsWith(d + "/")));
      const ignores = trivyIgnores(sh);
      if (scanners.includes("vuln")) info("[vuln] Vulnerability scanning is enabled");
      if (scanners.includes("misconfig")) info("Misconfiguration scanning is enabled");
      if (scanners.includes("secret")) info("[secret] Secret scanning is enabled");
      type Row = { name: string; type: string; vulns: Vuln[]; secrets: TrivySecret[]; mis: Misconfig[]; tests?: number; content: string; error?: string };
      const rows: Row[] = [];
      if (scanners.includes("vuln"))
        for (const abs of files) {
          const lf = lockfileVulns(abs, sh.state.files[abs] ?? "");
          if (lf) rows.push({ name: relTo(sh, target, abs), type: lf.type, vulns: lf.vulns.filter((x) => sevs.includes(x.sev) && !ignores.has(x.id)), secrets: [], mis: [], content: "" });
        }
      if (scanners.includes("misconfig")) {
        const cfg = configScan(sh, target).filter((c) => files.includes(c.abs));
        info(`Detected config files\tnum=${cfg.length}`);
        for (const c of cfg) {
          sh.flags.add(`sec:config-scanned:${c.abs}`);
          if (c.error) warn(`[misconfig] Failed to parse ${c.file}\terr="${c.error}"`);
          rows.push({ name: c.file, type: c.type, vulns: [], secrets: [], mis: c.failures.filter((m) => sevs.includes(m.sev)), tests: c.tests, content: sh.state.files[c.abs] ?? "", error: c.error });
        }
      }
      if (scanners.includes("secret"))
        for (const abs of files) {
          const content = sh.state.files[abs] ?? "";
          const s = trivySecrets(content).filter((x) => sevs.includes(x.sev));
          if (s.length) rows.push({ name: relTo(sh, target, abs), type: "text", vulns: [], secrets: s, mis: [], content });
        }
      const all = [...rows.flatMap((r) => r.vulns), ...rows.flatMap((r) => r.secrets), ...rows.flatMap((r) => r.mis)];
      let report: string;
      if (format === "json") {
        report = JSON.stringify(
          {
            SchemaVersion: 2,
            CreatedAt: new Date().toISOString(),
            ArtifactName: target,
            ArtifactType: "filesystem",
            Results: rows.map((r) => ({
              Target: r.name,
              Class: r.type === "text" ? "secret" : r.mis.length || r.tests ? "config" : "lang-pkgs",
              Type: r.type,
              ...(r.vulns.length ? { Vulnerabilities: r.vulns.map((x) => ({ VulnerabilityID: x.id, PkgName: x.pkg, InstalledVersion: x.installed, FixedVersion: x.fixed, Severity: x.sev, Title: x.title })) } : {}),
              ...(r.tests ? { MisconfSummary: { Successes: r.tests - r.mis.length, Failures: r.mis.length }, Misconfigurations: r.mis.map((m) => ({ ID: m.id, Title: m.title, Message: m.message, Severity: m.sev, Resolution: m.resolution, CauseMetadata: { StartLine: m.line, EndLine: m.endLine ?? m.line } })) } : {}),
              ...(r.secrets.length ? { Secrets: r.secrets.map((s) => ({ RuleID: s.ruleId, Category: s.category, Severity: s.sev, Title: s.title, StartLine: s.line, EndLine: s.line, Match: s.text.split(s.secret).join("*".repeat(s.secret.length)).trim() })) } : {}),
            })),
          },
          null,
          2,
        );
      } else {
        const cols = ["Target", "Type", ...(scanners.includes("vuln") ? ["Vulnerabilities"] : []), ...(scanners.includes("secret") ? ["Secrets"] : []), ...(scanners.includes("misconfig") ? ["Misconfigurations"] : [])];
        const summary = rows.length
          ? boxTable(
              cols,
              rows.map((r) => [
                r.name,
                r.type,
                ...(scanners.includes("vuln") ? [r.type === "npm" || r.type === "pip" ? String(r.vulns.length) : "-"] : []),
                ...(scanners.includes("secret") ? [r.type === "text" ? String(r.secrets.length) : "-"] : []),
                ...(scanners.includes("misconfig") ? [r.tests ? String(r.mis.length) : "-"] : []),
              ]),
              cols.map((_, i) => i).slice(1),
            )
          : "No results found";
        const details: string[] = [];
        for (const r of rows) {
          if (r.vulns.length) details.push([heading(`${r.name} (${r.type})`), totalLine("Total", r.vulns, sevs), "", vulnTable(r.vulns)].join("\n"));
          if (r.tests && (r.mis.length || r.error))
            details.push(
              [
                heading(`${r.name} (${r.type})`),
                `Tests: ${r.tests} (SUCCESSES: ${r.tests - r.mis.length}, FAILURES: ${r.mis.length})`,
                totalLine("Failures", r.mis, sevs),
                "",
                ...[...r.mis].sort((a, b) => a.line - b.line).map((m) => misconfigDetail(r.name, r.content, m)),
              ].join("\n"),
            );
          if (r.secrets.length) details.push([heading(`${r.name} (secrets)`), totalLine("Total", r.secrets, sevs), "", ...r.secrets.map((s) => secretDetail(r.name, r.content, s))].join("\n"));
        }
        report = ["Report Summary", "", summary, LEGEND, "", ...details].join("\n").trimEnd();
      }
      return finish(report, {
        mode: sub === "config" ? "config" : "fs",
        target: sh.resolve(target),
        counts: countBySev(all),
        total: all.length,
        misconfigIds: rows.flatMap((r) => r.mis.map((m) => m.id)),
        files: rows.map((r) => r.name),
      });
    }

    // ---------------- k8s
    if (sub === "k8s" || sub === "kubernetes") {
      const report = String(flags.report ?? "summary");
      const nsFilter = typeof flags["include-namespaces"] === "string" ? String(flags["include-namespaces"]).split(",") : null;
      const deps = sh.state.deployments.filter((d) => (nsFilter ? nsFilter.includes(d.namespace) : d.namespace !== "kube-system"));
      info("Node scanning is enabled");
      info("If you want to disable Node scanning via an in-tree Kubernetes cluster, use '--disable-node-collector' flag.");
      const rowsK: string[][] = [];
      const all: { sev: Severity }[] = [];
      const ids: string[] = [];
      const details: string[] = [];
      for (const d of deps) {
        const manifest = YAML.stringify({ apiVersion: "apps/v1", kind: "Deployment", metadata: { name: d.name, namespace: d.namespace }, spec: { template: { spec: d.template.spec } } });
        const mis = k8sMisconfigs(manifest).failures.filter((m) => sevs.includes(m.sev));
        const vulns = d.template.spec.containers.flatMap((c) => imageInfo(c.image)?.vulns ?? []).filter((x) => sevs.includes(x.sev) && (!ignoreUnfixed || x.status === "fixed"));
        const cv = countBySev(vulns);
        const cm = countBySev(mis);
        const cell = (c: Record<Severity, number>) => ["CRITICAL", "HIGH", "MEDIUM", "LOW"].map((s) => String(c[s as Severity] || "-")).join(" | ");
        rowsK.push([d.namespace, `Deployment/${d.name}`, cell(cv), cell(cm)]);
        all.push(...vulns, ...mis);
        ids.push(...mis.map((m) => m.id));
        if (report === "all" && mis.length) details.push([heading(`${d.namespace}/Deployment/${d.name} (kubernetes)`), totalLine("Failures", mis, sevs), "", ...mis.map((m) => `${m.id} (${m.sev}): ${m.message}`)].join("\n"));
      }
      const table = boxTable(["Namespace", "Resource", "Vulnerabilities (C | H | M | L)", "Misconfigurations (C | H | M | L)"], rowsK, [2, 3]);
      const out = [`Summary Report for kind-lab`, "", "", "Workload Assessment", table, "Severities: C=CRITICAL H=HIGH M=MEDIUM L=LOW U=UNKNOWN", ...details].join("\n");
      return finish(out, { mode: "k8s", target: "cluster", counts: countBySev(all), total: all.length, misconfigIds: ids, files: [] });
    }

    return { output: `Error: unknown command "${sub}" for "trivy"\nRun 'trivy --help' for usage.`, ok: false };
  },
  explainError: (cmd, output) => {
    if (/unable to find the specified image/.test(output)) return "O trivy não encontrou essa imagem nem localmente nem no registry. Confira nome e tag (ex.: node:14, nginx:1.27-alpine) — tags são exatas.";
    if (/invalid severity/.test(output)) return "Severidades válidas: UNKNOWN, LOW, MEDIUM, HIGH, CRITICAL — separadas por vírgula e sem espaço. Ex.: --severity HIGH,CRITICAL";
    if (/no such file or directory/.test(output)) return "O caminho informado não existe. Use ls para ver os arquivos e rode, por exemplo, trivy config . a partir da raiz do projeto.";
    if (/must be one of: table, json/.test(output)) return "Neste ambiente o trivy aceita -f table (padrão) ou -f json.";
    if (/--exit-code/.test(cmd) && !/FATAL/.test(output))
      return "O scan terminou com achados e, como você passou --exit-code, o trivy saiu com código diferente de zero. Numa pipeline isso quebra o build — é exatamente o gate de segurança funcionando. Corrija os achados (ou ajuste --severity) e rode de novo.";
    return null;
  },
});
