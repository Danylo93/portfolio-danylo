// Shared engine for the DevSecOps tools (trivy, gitleaks, checkov, cosign, syft, kubesec).
// Everything here is deterministic: the same files/image always give the same findings.
import YAML, { LineCounter, isMap, isSeq, type Document } from "yaml";
import type { Shell } from "../shell";

export type Severity = "UNKNOWN" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
export const SEVERITIES: Severity[] = ["UNKNOWN", "LOW", "MEDIUM", "HIGH", "CRITICAL"];

// ---------------------------------------------------------------- hashing / refs
/** Deterministic hex string of `len` chars derived from `s` (FNV-1a based). */
export const hashHex = (s: string, len = 64) => {
  let out = "";
  let seed = 0;
  while (out.length < len) {
    let h = 0x811c9dc5 ^ seed;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    out += h.toString(16).padStart(8, "0");
    seed++;
  }
  return out.slice(0, len);
};

export type ImageRef = { repo: string; tag?: string; digest?: string; full: string };

/** Normalizes an image reference: strips docker.io/library, defaults the tag to latest. */
export const parseRef = (ref: string): ImageRef => {
  let r = ref.trim().replace(/^docker\.io\//, "").replace(/^library\//, "");
  let digest: string | undefined;
  const at = r.indexOf("@");
  if (at >= 0) {
    digest = r.slice(at + 1);
    r = r.slice(0, at);
  }
  const lastSlash = r.lastIndexOf("/");
  const colon = r.lastIndexOf(":");
  let tag: string | undefined;
  if (colon > lastSlash) {
    tag = r.slice(colon + 1);
    r = r.slice(0, colon);
  }
  if (!tag && !digest) tag = "latest";
  return { repo: r, tag, digest, full: `${r}${tag ? `:${tag}` : ""}${digest ? `@${digest}` : ""}` };
};

// ---------------------------------------------------------------- vulnerability DB
export type Vuln = {
  id: string;
  pkg: string;
  installed: string;
  /** empty when there is no fix yet */
  fixed: string;
  sev: Severity;
  title: string;
  status?: "fixed" | "affected" | "will_not_fix";
};
export type LangTarget = { target: string; type: string; vulns: Vuln[] };
export type ImageInfo = { os: string; family: string; pkgs: number; vulns: Vuln[]; lang?: LangTarget[]; size: string };

const v = (id: string, pkg: string, installed: string, fixed: string, sev: Severity, title: string, status?: Vuln["status"]): Vuln => ({
  id, pkg, installed, fixed, sev, title, status: status ?? (fixed ? "fixed" : "affected"),
});

const BUSTER: Vuln[] = [
  v("CVE-2019-8457", "libdb5.3", "5.3.28+dfsg1-0.5", "", "CRITICAL", "sqlite: heap out-of-bound read in function rtreenode()", "will_not_fix"),
  v("CVE-2022-1292", "libssl1.1", "1.1.1n-0+deb10u1", "1.1.1n-0+deb10u2", "CRITICAL", "openssl: c_rehash script allows command injection"),
  v("CVE-2022-2068", "libssl1.1", "1.1.1n-0+deb10u1", "1.1.1n-0+deb10u3", "CRITICAL", "openssl: the c_rehash script allows command injection"),
  v("CVE-2022-37434", "zlib1g", "1:1.2.11.dfsg-1+deb10u1", "1:1.2.11.dfsg-1+deb10u2", "CRITICAL", "zlib: heap-based buffer over-read and overflow in inflate() in inflate.c via a large gzip header extra field"),
  v("CVE-2022-29155", "libldap-2.4-2", "2.4.47+dfsg-3+deb10u6", "2.4.47+dfsg-3+deb10u7", "CRITICAL", "openldap: OpenLDAP SQL injection"),
  v("CVE-2022-40674", "libexpat1", "2.2.6-2+deb10u4", "2.2.6-2+deb10u5", "CRITICAL", "expat: a use-after-free in the doContent function in xmlparse.c"),
  v("CVE-2023-45853", "zlib1g", "1:1.2.11.dfsg-1+deb10u1", "", "CRITICAL", "zlib: integer overflow and resultant heap-based buffer overflow in zipOpenNewFileInZip4_6", "will_not_fix"),
  v("CVE-2023-0286", "libssl1.1", "1.1.1n-0+deb10u1", "1.1.1n-0+deb10u4", "HIGH", "openssl: X.400 address type confusion in X.509 GeneralName"),
  v("CVE-2022-42898", "libkrb5-3", "1.17-3+deb10u3", "1.17-3+deb10u5", "HIGH", "krb5: integer overflow vulnerabilities in PAC parsing"),
  v("CVE-2023-29491", "libncursesw6", "6.1+20181013-2+deb10u2", "6.1+20181013-2+deb10u4", "HIGH", "ncurses: Local users can trigger security-relevant memory corruption via malformed data"),
  v("CVE-2022-3715", "bash", "5.0-4", "", "HIGH", "bash: a heap-buffer-overflow in valid_parameter_transform"),
  v("CVE-2021-3999", "libc6", "2.28-10+deb10u1", "", "HIGH", "glibc: Off-by-one buffer overflow/underflow in getcwd()"),
  v("CVE-2022-32221", "curl", "7.64.0-4+deb10u2", "7.64.0-4+deb10u4", "HIGH", "curl: POST following PUT confusion"),
  v("CVE-2022-40303", "libxml2", "2.9.4+dfsg1-7+deb10u4", "2.9.4+dfsg1-7+deb10u5", "HIGH", "libxml2: integer overflows with XML_PARSE_HUGE"),
  v("CVE-2023-4641", "passwd", "1:4.5-1.1", "", "MEDIUM", "shadow-utils: possible password leak during passwd(1) change"),
  v("CVE-2022-48303", "tar", "1.30+dfsg-6", "", "MEDIUM", "tar: heap buffer overflow at from_header() in list.c via specially crafted checksum"),
  v("CVE-2023-50495", "libtinfo6", "6.1+20181013-2+deb10u2", "", "MEDIUM", "ncurses: segmentation fault via _nc_wrap_entry()"),
  v("CVE-2011-3374", "apt", "1.8.2.3", "", "LOW", "It was found that apt-key in apt, all versions, do not correctly validate ..."),
  v("CVE-2019-18276", "bash", "5.0-4", "", "LOW", "bash: when effective UID is not equal to its real UID the saved UID is not dropped"),
  v("TEMP-0841856-B18BAF", "bash", "5.0-4", "", "LOW", "[Privilege escalation possible to other user than root]"),
  v("CVE-2016-2781", "coreutils", "8.30-3", "", "LOW", "coreutils: Non-privileged session can escape to the parent session in chroot"),
  v("CVE-2022-0563", "util-linux", "2.33.1-0.1", "", "LOW", "util-linux: partial disclosure of arbitrary files in chfn and chsh when compiled with libreadline"),
];

const BOOKWORM: Vuln[] = [
  v("CVE-2023-45853", "zlib1g", "1:1.2.13.dfsg-1", "", "CRITICAL", "zlib: integer overflow and resultant heap-based buffer overflow in zipOpenNewFileInZip4_6", "will_not_fix"),
  v("CVE-2023-52425", "libexpat1", "2.5.0-1", "", "HIGH", "expat: parsing large tokens can trigger a denial of service"),
  v("CVE-2024-2961", "libc6", "2.36-9+deb12u4", "2.36-9+deb12u7", "HIGH", "glibc: Out of bounds write in iconv may lead to remote code execution"),
  v("CVE-2023-31484", "perl-base", "5.36.0-7+deb12u1", "", "HIGH", "perl: CPAN.pm does not verify TLS certificates when downloading distributions over HTTPS"),
  v("CVE-2024-28182", "libnghttp2-14", "1.52.0-1+deb12u1", "", "MEDIUM", "nghttp2: CONTINUATION frames DoS"),
  v("CVE-2011-3374", "apt", "2.6.1", "", "LOW", "It was found that apt-key in apt, all versions, do not correctly validate ..."),
  v("TEMP-0841856-B18BAF", "bash", "5.2.15-2+b7", "", "LOW", "[Privilege escalation possible to other user than root]"),
  v("CVE-2016-2781", "coreutils", "9.1-1", "", "LOW", "coreutils: Non-privileged session can escape to the parent session in chroot"),
  v("CVE-2022-0563", "util-linux", "2.38.1-5+deb12u1", "", "LOW", "util-linux: partial disclosure of arbitrary files in chfn and chsh when compiled with libreadline"),
];

const BOOKWORM_EXTRA: Vuln[] = [
  v("CVE-2024-45491", "libexpat1", "2.5.0-1", "2.5.0-1+deb12u1", "CRITICAL", "libexpat: Integer Overflow or Wraparound"),
  v("CVE-2024-45492", "libexpat1", "2.5.0-1", "2.5.0-1+deb12u1", "CRITICAL", "libexpat: integer overflow"),
];

const NODE14_PKG: Vuln[] = [
  v("CVE-2021-44906", "minimist", "1.2.5", "1.2.6", "CRITICAL", "minimist: prototype pollution"),
  v("CVE-2022-25883", "semver", "7.3.5", "7.5.2, 6.3.1, 5.7.2", "HIGH", "nodejs-semver: Regular expression denial of service"),
  v("CVE-2022-3517", "minimatch", "3.0.4", "3.0.5", "HIGH", "nodejs-minimatch: ReDoS via the braceExpand function"),
  v("CVE-2023-26136", "tough-cookie", "2.5.0", "4.1.3", "MEDIUM", "tough-cookie: prototype pollution in cookie memstore"),
  v("CVE-2024-28863", "tar", "6.1.11", "6.2.1", "MEDIUM", "node-tar: denial of service while parsing a tar file due to lack of folders depth validation"),
];

const PY38_PKG: Vuln[] = [
  v("CVE-2024-6345", "setuptools", "57.5.0", "70.0.0", "HIGH", "pypa/setuptools: Remote code execution via download functions in the package_index module"),
  v("CVE-2022-40897", "setuptools", "57.5.0", "65.5.1", "MEDIUM", "pypa-setuptools: Regular Expression Denial of Service (ReDoS) in package_index.py"),
  v("CVE-2023-5752", "pip", "23.0.1", "23.3", "MEDIUM", "pip: Mercurial configuration injectable in repo revision when installing via pip"),
];

const ALPINE_LOW: Vuln[] = [
  v("CVE-2024-9143", "libcrypto3", "3.3.2-r0", "3.3.2-r1", "LOW", "openssl: Low-level invalid GF(2^m) parameters lead to OOB memory access"),
];

const img = (os: string, family: string, pkgs: number, size: string, vulns: Vuln[], lang?: LangTarget[]): ImageInfo => ({ os, family, pkgs, size, vulns, lang });

const IMAGES: Record<string, ImageInfo> = {
  "node:14": img("debian 10.13", "debian", 412, "912MB", BUSTER, [{ target: "Node.js", type: "node-pkg", vulns: NODE14_PKG }]),
  "node:16": img("debian 12.1", "debian", 398, "909MB", [...BOOKWORM_EXTRA, ...BOOKWORM], [{ target: "Node.js", type: "node-pkg", vulns: NODE14_PKG.slice(1) }]),
  "node:20": img("debian 12.7", "debian", 402, "1.1GB", BOOKWORM),
  "node:20-slim": img("debian 12.7", "debian", 97, "200MB", BOOKWORM.filter((x) => !["perl-base", "libnghttp2-14"].includes(x.pkg))),
  "node:20-alpine": img("alpine 3.20.3", "alpine", 17, "133MB", ALPINE_LOW),
  "node:22-alpine": img("alpine 3.20.3", "alpine", 17, "155MB", ALPINE_LOW),
  "python:3.8": img("debian 12.7", "debian", 431, "997MB", [...BOOKWORM_EXTRA, ...BOOKWORM], [{ target: "Python", type: "python-pkg", vulns: PY38_PKG }]),
  "python:3.12-slim": img("debian 12.7", "debian", 88, "130MB", BOOKWORM.filter((x) => x.sev === "LOW" || x.sev === "CRITICAL")),
  "python:3.12-alpine": img("alpine 3.20.3", "alpine", 36, "57MB", ALPINE_LOW),
  "nginx:1.19": img("debian 10.9", "debian", 136, "133MB", [
    ...BUSTER.filter((x) => !["bash", "libncursesw6"].includes(x.pkg)),
    v("CVE-2021-23017", "nginx", "1.19.10-1~buster", "", "HIGH", "nginx: Off-by-one in ngx_resolver_copy() when labels are followed by a pointer to a root domain name"),
  ]),
  "nginx:1.27-alpine": img("alpine 3.20.3", "alpine", 67, "47.9MB", ALPINE_LOW),
  "nginx:1.25": img("debian 12.4", "debian", 150, "187MB", BOOKWORM),
  "alpine:3.20": img("alpine 3.20.3", "alpine", 14, "7.8MB", []),
  "gcr.io/distroless/static-debian12": img("debian 12.7", "debian", 3, "2.4MB", []),
  "gcr.io/distroless/nodejs20-debian12": img("debian 12.7", "debian", 11, "129MB", []),
  "ghcr.io/danylo/api:1.4.0": img("alpine 3.20.3", "alpine", 23, "141MB", ALPINE_LOW),
  "ghcr.io/danylo/api:1.4.1": img("alpine 3.20.3", "alpine", 23, "141MB", ALPINE_LOW),
  "ghcr.io/danylo/worker:2.0.1": img("alpine 3.20.3", "alpine", 21, "138MB", ALPINE_LOW),
};

/** Vulnerability data for a known image, or null when the image does not exist in the simulated registry. */
export const imageInfo = (ref: string): ImageInfo | null => {
  const r = parseRef(ref);
  const key = `${r.repo}:${r.tag}`;
  if (IMAGES[key]) return IMAGES[key];
  if (/^gcr\.io\/distroless\//.test(r.repo)) return img("debian 12.7", "debian", 5, "20MB", []);
  if (r.digest && !r.tag) {
    const hit = Object.keys(IMAGES).find((k) => digestOf(k) === r.digest);
    return hit ? IMAGES[hit] : null;
  }
  const known = ["node", "python", "nginx", "alpine", "redis", "postgres", "httpd", "busybox", "ubuntu", "debian", "golang", "openjdk", "eclipse-temurin"];
  if (!known.includes(r.repo)) return null;
  if (r.tag === "latest") return img("debian 12.7", "debian", 150, "190MB", BOOKWORM);
  if (/alpine/.test(r.tag ?? "") || r.repo === "alpine" || r.repo === "busybox") return img("alpine 3.20.3", "alpine", 20, "50MB", []);
  return img("debian 12.7", "debian", 180, "300MB", BOOKWORM);
};

/** sha256 digest of a known image (stable per reference). */
export const digestOf = (ref: string) => {
  const r = parseRef(ref);
  if (r.digest) return r.digest;
  return `sha256:${hashHex(`${r.repo}:${r.tag}`)}`;
};

export const countBySev = (vulns: { sev: Severity }[]) => {
  const c: Record<Severity, number> = { UNKNOWN: 0, LOW: 0, MEDIUM: 0, HIGH: 0, CRITICAL: 0 };
  for (const x of vulns) c[x.sev]++;
  return c;
};

// ---------------------------------------------------------------- lockfiles
type PkgVuln = { name: string; below: string; vuln: Omit<Vuln, "installed" | "pkg"> };
const pv = (name: string, below: string, id: string, sev: Severity, title: string, fixed = below): PkgVuln => ({ name, below, vuln: { id, fixed, sev, title, status: "fixed" } });

const NPM_DB: PkgVuln[] = [
  pv("lodash", "4.17.21", "CVE-2021-23337", "HIGH", "nodejs-lodash: command injection via template"),
  pv("lodash", "4.17.19", "CVE-2020-8203", "HIGH", "nodejs-lodash: prototype pollution in zipObjectDeep function"),
  pv("minimist", "1.2.6", "CVE-2021-44906", "CRITICAL", "minimist: prototype pollution"),
  pv("express", "4.19.2", "CVE-2024-29041", "MEDIUM", "express: cause malformed URLs to be evaluated"),
  pv("jsonwebtoken", "9.0.0", "CVE-2022-23539", "HIGH", "jsonwebtoken: Unrestricted key type could lead to legacy keys usage"),
  pv("axios", "1.6.0", "CVE-2023-45857", "MEDIUM", "axios: exposure of confidential data stored in cookies"),
  pv("node-fetch", "2.6.7", "CVE-2022-0235", "HIGH", "node-fetch: exposure of sensitive information to an unauthorized actor"),
];
const PIP_DB: PkgVuln[] = [
  pv("pyyaml", "5.4", "CVE-2020-14343", "CRITICAL", "PyYAML: incomplete fix for CVE-2020-1747"),
  pv("flask", "2.2.5", "CVE-2023-30861", "HIGH", "flask: possible disclosure of permanent session cookie due to missing Vary: Cookie header"),
  pv("requests", "2.32.0", "CVE-2024-35195", "MEDIUM", "requests: subsequent requests to the same host ignore cert verification"),
  pv("urllib3", "1.26.18", "CVE-2023-45803", "MEDIUM", "urllib3: Request body not stripped after redirect from 303 status changes request method to GET"),
  pv("jinja2", "3.1.4", "CVE-2024-34064", "MEDIUM", "jinja2: accepts keys containing non-attribute characters"),
];

/** Compares dotted versions: negative when a < b. */
export const cmpVersion = (a: string, b: string) => {
  const pa = a.replace(/^[^\d]*/, "").split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const pb = b.replace(/^[^\d]*/, "").split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
};

/** Vulnerabilities of the dependencies declared in a lockfile. */
export const lockfileVulns = (path: string, content: string): { type: string; vulns: Vuln[] } | null => {
  const base = path.split("/").pop()!;
  const deps: [string, string][] = [];
  let db: PkgVuln[];
  let type: string;
  if (base === "package-lock.json") {
    type = "npm";
    db = NPM_DB;
    try {
      const j = JSON.parse(content);
      for (const [k, val] of Object.entries<{ version?: string }>(j.packages ?? {})) if (k && val?.version) deps.push([k.split("node_modules/").pop()!, val.version]);
      for (const [k, val] of Object.entries<{ version?: string }>(j.dependencies ?? {})) if (val?.version && !deps.some((d) => d[0] === k)) deps.push([k, val.version]);
    } catch {
      return { type, vulns: [] };
    }
  } else if (base === "requirements.txt") {
    type = "pip";
    db = PIP_DB;
    for (const line of content.split("\n")) {
      const m = /^\s*([A-Za-z0-9_.-]+)\s*==\s*([\w.]+)/.exec(line);
      if (m) deps.push([m[1].toLowerCase(), m[2]]);
    }
  } else return null;
  const vulns: Vuln[] = [];
  for (const [name, ver] of deps)
    for (const e of db) if (e.name === name && cmpVersion(ver, e.below) < 0) vulns.push({ ...e.vuln, pkg: name, installed: ver });
  return { type, vulns };
};

// ---------------------------------------------------------------- files
/** Absolute paths of the regular files under `dir` (or [dir] when it is a file). */
export const walkFiles = (sh: Shell, target: string) => {
  const abs = sh.resolve(target);
  if (sh.state.files[abs] !== undefined) return [abs];
  const prefix = abs === "/" ? "/" : abs + "/";
  return Object.keys(sh.state.files)
    .filter((f) => f.startsWith(prefix) && !/\/(node_modules|\.git)\//.test(f.slice(prefix.length - 1)))
    .sort();
};

/** Path of `abs` relative to the scan root (like the real tools print). */
export const relTo = (sh: Shell, target: string, abs: string) => {
  const root = sh.resolve(target);
  if (abs === root) return target.replace(/^\.\//, "");
  return abs.startsWith(root + "/") ? abs.slice(root.length + 1) : abs;
};

export const isDockerfile = (p: string) => /(^|\/)(Dockerfile|Containerfile)(\.[\w-]+)?$|\.dockerfile$/i.test(p);
export const isTerraform = (p: string) => /\.tf$/.test(p);
export const isYaml = (p: string) => /\.ya?ml$/.test(p);

// ---------------------------------------------------------------- tables
const center = (s: string, w: number) => {
  const left = Math.floor((w - s.length) / 2);
  return " ".repeat(left) + s + " ".repeat(w - s.length - left);
};

/** Unicode box table like trivy prints. */
export const boxTable = (headers: string[], rows: string[][], centerCols: number[] = []) => {
  const w = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)) + 2);
  const line = (l: string, m: string, r: string) => l + w.map((x) => "─".repeat(x)).join(m) + r;
  const row = (cells: string[], head = false) =>
    "│" + cells.map((c, i) => (head || centerCols.includes(i) ? center(c, w[i]) : " " + c.padEnd(w[i] - 1))).join("│") + "│";
  return [line("┌", "┬", "┐"), row(headers, true), line("├", "┼", "┤"), ...rows.map((r) => row(r)), line("└", "┴", "┘")].join("\n");
};

export const logTime = () => new Date().toISOString().replace(/\.\d+Z$/, "Z");

// ---------------------------------------------------------------- Dockerfile
export type DockerInstr = { cmd: string; args: string; line: number };

export const parseDockerfile = (content: string): DockerInstr[] => {
  const out: DockerInstr[] = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const start = i;
    let text = lines[i];
    while (text.trimEnd().endsWith("\\") && i + 1 < lines.length) text = text.trimEnd().slice(0, -1) + " " + lines[++i].trim();
    const m = /^\s*([A-Za-z]+)\s+(.*)$/.exec(text);
    if (!m || text.trim().startsWith("#")) continue;
    out.push({ cmd: m[1].toUpperCase(), args: m[2].trim(), line: start + 1 });
  }
  return out;
};

/** Image of the final stage, resolving references to earlier stage names. */
export const finalBaseImage = (content: string) => {
  const froms = parseDockerfile(content).filter((x) => x.cmd === "FROM");
  const stages = new Map<string, string>();
  let last: { image: string; line: number } | null = null;
  for (const f of froms) {
    const [image, , alias] = f.args.split(/\s+/);
    const resolved = stages.get(image?.toLowerCase()) ?? image;
    if (alias) stages.set(alias.toLowerCase(), resolved);
    last = { image: resolved, line: f.line };
  }
  return last;
};

export type DockerFacts = {
  froms: { image: string; line: number }[];
  finalImage?: string;
  lastUser?: { user: string; line: number };
  healthcheck: boolean;
  expose22?: number;
  add?: number;
  lastLine: number;
};

export const dockerFacts = (content: string): DockerFacts => {
  const ins = parseDockerfile(content);
  const lastFromIdx = ins.map((x) => x.cmd).lastIndexOf("FROM");
  const finalStage = ins.slice(Math.max(0, lastFromIdx));
  const users = finalStage.filter((x) => x.cmd === "USER");
  const lastUser = users.length ? { user: users[users.length - 1].args.split(/\s+/)[0], line: users[users.length - 1].line } : undefined;
  const expose = ins.find((x) => x.cmd === "EXPOSE" && /(^|\s)22(\/tcp)?(\s|$)/.test(x.args));
  const add = ins.find((x) => x.cmd === "ADD" && !/https?:\/\//.test(x.args) && !/\.(tar|tgz|tar\.gz)\b/.test(x.args));
  return {
    froms: ins.filter((x) => x.cmd === "FROM").map((x) => ({ image: x.args.split(/\s+/)[0], line: x.line })),
    finalImage: finalBaseImage(content)?.image,
    lastUser,
    healthcheck: ins.some((x) => x.cmd === "HEALTHCHECK" && !/^NONE/i.test(x.args)),
    expose22: expose?.line,
    add: add?.line,
    lastLine: content.replace(/\s+$/, "").split("\n").length,
  };
};

export const isRootUser = (u?: string) => !u || /^(root|0)(:.*)?$/.test(u);

// ---------------------------------------------------------------- Kubernetes manifests
export type K8sContainerFacts = {
  name: string;
  image: string;
  line: number;
  privileged: boolean;
  allowPrivEsc: boolean;
  readOnlyRoot: boolean;
  runAsNonRoot: boolean;
  runAsUser?: number;
  dropAll: boolean;
  dropNetRaw: boolean;
  addCaps: string[];
  limits: boolean;
  lines: Record<string, number>;
};

export type K8sWorkload = {
  kind: string;
  name: string;
  namespace: string;
  startLine: number;
  endLine: number;
  hostNetwork: boolean;
  hostPID: boolean;
  hostIPC: boolean;
  hostPaths: string[];
  serviceAccount?: string;
  containers: K8sContainerFacts[];
};

const WORKLOADS = ["Pod", "Deployment", "StatefulSet", "DaemonSet", "ReplicaSet", "Job", "CronJob"];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const podSpecPath = (kind: string): (string | number)[] =>
  kind === "Pod" ? ["spec"] : kind === "CronJob" ? ["spec", "jobTemplate", "spec", "template", "spec"] : ["spec", "template", "spec"];

/** Parses every workload in a YAML file into security-relevant facts (with line numbers). */
export const k8sWorkloads = (content: string): { workloads: K8sWorkload[]; error?: string } => {
  const lc = new LineCounter();
  let docs: Document.Parsed[];
  try {
    docs = YAML.parseAllDocuments(content, { lineCounter: lc }) as Document.Parsed[];
  } catch (e) {
    return { workloads: [], error: (e as Error).message };
  }
  const workloads: K8sWorkload[] = [];
  for (const doc of docs) {
    if (doc.errors?.length) return { workloads, error: doc.errors[0].message };
    const js: Json = doc.toJS();
    if (!js || typeof js !== "object" || !WORKLOADS.includes(js.kind)) continue;
    const range = doc.contents?.range ?? [0, 0, 0];
    const lineAt = (path: (string | number)[], fallback: number) => {
      const node = doc.getIn(path, true) as { range?: [number, number, number] } | undefined;
      if (node && typeof node === "object" && node.range) return lc.linePos(node.range[0]).line;
      // for scalars the key line is the same as the value line; for maps, the first child line
      return fallback;
    };
    const keyLine = (path: (string | number)[], fallback: number) => {
      const parent = doc.getIn(path.slice(0, -1), true);
      if (isMap(parent)) {
        const pair = parent.items.find((it) => (it.key as { value?: unknown })?.value === path[path.length - 1]);
        const kr = (pair?.key as { range?: [number, number, number] })?.range;
        if (kr) return lc.linePos(kr[0]).line;
      }
      return lineAt(path, fallback);
    };
    const specPath = podSpecPath(js.kind);
    let spec: Json = js;
    for (const p of specPath) spec = spec?.[p];
    spec = spec ?? {};
    const startLine = lc.linePos(range[0]).line;
    const endLine = Math.max(startLine, lc.linePos(Math.max(range[0], range[1] - 1)).line);
    const psc = spec.securityContext ?? {};
    const containersNode = doc.getIn([...specPath, "containers"], true);
    const containers: K8sContainerFacts[] = (spec.containers ?? []).map((c: Json, i: number) => {
      const sc = c.securityContext ?? {};
      const base = [...specPath, "containers", i];
      const cLine = isSeq(containersNode) ? lineAt(base, startLine) : startLine;
      const drop: string[] = (sc.capabilities?.drop ?? []).map((x: string) => String(x).toUpperCase());
      const runAsUser = sc.runAsUser ?? psc.runAsUser;
      return {
        name: c.name ?? `container-${i}`,
        image: String(c.image ?? ""),
        line: cLine,
        privileged: sc.privileged === true,
        allowPrivEsc: sc.allowPrivilegeEscalation !== false,
        readOnlyRoot: sc.readOnlyRootFilesystem === true,
        runAsNonRoot: (sc.runAsNonRoot ?? psc.runAsNonRoot) === true || (typeof runAsUser === "number" && runAsUser > 0 && (sc.runAsNonRoot ?? psc.runAsNonRoot) !== false),
        runAsUser: typeof runAsUser === "number" ? runAsUser : undefined,
        dropAll: drop.includes("ALL"),
        dropNetRaw: drop.includes("ALL") || drop.includes("NET_RAW"),
        addCaps: (sc.capabilities?.add ?? []).map((x: string) => String(x).toUpperCase()),
        limits: !!(c.resources?.limits?.cpu && c.resources?.limits?.memory),
        lines: {
          privileged: keyLine([...base, "securityContext", "privileged"], cLine),
          allowPrivilegeEscalation: keyLine([...base, "securityContext", "allowPrivilegeEscalation"], cLine),
          readOnlyRootFilesystem: keyLine([...base, "securityContext", "readOnlyRootFilesystem"], cLine),
          securityContext: keyLine([...base, "securityContext"], cLine),
          image: keyLine([...base, "image"], cLine),
        },
      };
    });
    workloads.push({
      kind: js.kind,
      name: js.metadata?.name ?? "unknown",
      namespace: js.metadata?.namespace ?? "default",
      startLine,
      endLine,
      hostNetwork: spec.hostNetwork === true,
      hostPID: spec.hostPID === true,
      hostIPC: spec.hostIPC === true,
      hostPaths: (spec.volumes ?? []).filter((x: Json) => x?.hostPath).map((x: Json) => String(x.hostPath.path ?? "")),
      serviceAccount: spec.serviceAccountName,
      containers,
    });
  }
  return { workloads };
};

export const usesLatest = (image: string) => !image.includes("@") && (!/:[^/]+$/.test(image) || /:latest$/.test(image));

// ---------------------------------------------------------------- HCL (Terraform) mini parser
export type HclValue = string | number | boolean | null | HclValue[] | { [k: string]: HclValue };
export type HclBlock = { type: string; labels: string[]; attrs: Record<string, HclValue>; blocks: HclBlock[]; start: number; end: number };
export type HclFile = { blocks: HclBlock[]; comments: { line: number; text: string }[]; lines: string[] };

type Tok = { t: "id" | "str" | "num" | "punct" | "nl" | "heredoc"; v: string; line: number };

const tokenizeHcl = (src: string, comments: { line: number; text: string }[]): Tok[] => {
  const toks: Tok[] = [];
  let i = 0;
  let line = 1;
  while (i < src.length) {
    const c = src[i];
    if (c === "\n") {
      toks.push({ t: "nl", v: "\n", line });
      line++;
      i++;
    } else if (c === " " || c === "\t" || c === "\r") i++;
    else if (c === "#" || (c === "/" && src[i + 1] === "/")) {
      const end = src.indexOf("\n", i);
      const text = src.slice(i, end < 0 ? src.length : end);
      comments.push({ line, text });
      i = end < 0 ? src.length : end;
    } else if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      const text = src.slice(i, end < 0 ? src.length : end + 2);
      comments.push({ line, text });
      line += (text.match(/\n/g) ?? []).length;
      i = end < 0 ? src.length : end + 2;
    } else if (c === '"') {
      let j = i + 1;
      let s = "";
      let depth = 0;
      while (j < src.length && (src[j] !== '"' || depth > 0)) {
        if (src[j] === "\\" && j + 1 < src.length) {
          s += src[j + 1];
          j += 2;
          continue;
        }
        if (src[j] === "$" && src[j + 1] === "{") depth++;
        else if (src[j] === "}" && depth > 0) depth--;
        if (src[j] === "\n") throw new Error(`Unterminated template string at line ${line}`);
        s += src[j++];
      }
      if (j >= src.length) throw new Error(`Unterminated template string at line ${line}`);
      toks.push({ t: "str", v: s, line });
      i = j + 1;
    } else if (c === "<" && src[i + 1] === "<") {
      const m = /^<<-?([A-Za-z_]+)[ \t]*\n/.exec(src.slice(i));
      if (!m) throw new Error(`Invalid heredoc at line ${line}`);
      let j = i + m[0].length;
      const body: string[] = [];
      let closed = false;
      while (j < src.length) {
        const nl = src.indexOf("\n", j);
        const l = src.slice(j, nl < 0 ? src.length : nl);
        j = nl < 0 ? src.length : nl;
        if (l.trim() === m[1]) {
          closed = true;
          break;
        }
        body.push(l);
        j++;
      }
      if (!closed) throw new Error(`Unterminated heredoc at line ${line}`);
      toks.push({ t: "heredoc", v: body.join("\n"), line });
      line += body.length + 1;
      i = j;
    } else if (/[0-9]/.test(c) || (c === "-" && /[0-9]/.test(src[i + 1] ?? ""))) {
      const m = /^-?[0-9]+(\.[0-9]+)?/.exec(src.slice(i))!;
      toks.push({ t: "num", v: m[0], line });
      i += m[0].length;
    } else if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][\w-]*(\.[\w*-]+|\[[^\]\n]*\])*/.exec(src.slice(i))!;
      toks.push({ t: "id", v: m[0], line });
      i += m[0].length;
    } else {
      toks.push({ t: "punct", v: c, line });
      i++;
    }
  }
  toks.push({ t: "nl", v: "\n", line });
  return toks;
};

/** Parses a subset of HCL2 (blocks, attributes, lists, objects, references). Throws on syntax errors. */
export const parseHcl = (src: string): HclFile => {
  const comments: { line: number; text: string }[] = [];
  const toks = tokenizeHcl(src, comments);
  let p = 0;
  const peek = (o = 0) => toks[p + o];
  const skipNl = () => {
    while (peek() && peek().t === "nl") p++;
  };
  const err = (msg: string): never => {
    throw new Error(`${msg} on line ${peek()?.line ?? "?"}`);
  };

  const parseExpr = (inBrackets: boolean): HclValue => {
    if (inBrackets) skipNl();
    const t = peek();
    if (!t) return err("Missing expression");
    let val: HclValue;
    if (t.t === "str" || t.t === "heredoc") {
      p++;
      val = t.v;
    } else if (t.t === "num") {
      p++;
      val = Number(t.v);
    } else if (t.t === "id") {
      p++;
      if (t.v === "true" || t.v === "false") val = t.v === "true";
      else if (t.v === "null") val = null;
      else if (peek()?.v === "(") {
        // function call: keep raw text
        let depth = 0;
        let raw = t.v;
        do {
          const x = toks[p++];
          if (!x) err("Unclosed function call");
          if (x.v === "(") depth++;
          if (x.v === ")") depth--;
          raw += x.t === "str" ? `"${x.v}"` : x.t === "nl" ? "" : x.v;
        } while (depth > 0);
        val = raw;
      } else val = t.v;
    } else if (t.v === "[") {
      p++;
      const arr: HclValue[] = [];
      skipNl();
      while (peek() && peek().v !== "]") {
        arr.push(parseExpr(true));
        skipNl();
        if (peek()?.v === ",") p++;
        skipNl();
      }
      if (peek()?.v !== "]") err("Missing close bracket");
      p++;
      val = arr;
    } else if (t.v === "{") {
      p++;
      const obj: Record<string, HclValue> = {};
      skipNl();
      while (peek() && peek().v !== "}") {
        const k = peek();
        if (k.t !== "id" && k.t !== "str") err("Invalid object key");
        p++;
        if (peek()?.v !== "=" && peek()?.v !== ":") err("Missing key/value separator");
        p++;
        obj[k.v] = parseExpr(true);
        skipNl();
        if (peek()?.v === ",") p++;
        skipNl();
      }
      if (peek()?.v !== "}") err("Missing close brace");
      p++;
      val = obj;
    } else if (t.v === "-" || t.v === "!") {
      p++;
      val = `${t.v}${String(parseExpr(inBrackets))}`;
    } else return err(`Invalid expression "${t.v}"`);
    // swallow operators (a ? b : c, a + b, a == b) as raw text
    const isOp = (x?: Tok) => !!x && x.t === "punct" && ("?:+*/%<>&|!-".includes(x.v) || (x.v === "=" && peek(1)?.v === "="));
    while (isOp(peek())) {
      p++;
      while (peek()?.t === "punct" && "=&|".includes(peek().v)) p++;
      parseExpr(inBrackets);
      val = String(val);
    }
    return val;
  };

  const parseBody = (closing: boolean): { attrs: Record<string, HclValue>; blocks: HclBlock[]; end: number } => {
    const attrs: Record<string, HclValue> = {};
    const blocks: HclBlock[] = [];
    for (;;) {
      skipNl();
      const t = peek();
      if (!t) {
        if (closing) err("Missing close brace");
        return { attrs, blocks, end: toks[toks.length - 1].line };
      }
      if (t.v === "}") {
        if (!closing) err('Argument or block definition required: an argument or block definition is required here. Unexpected "}"');
        p++;
        return { attrs, blocks, end: t.line };
      }
      if (t.t !== "id") err(`Argument or block definition required: an argument or block definition is required here`);
      p++;
      if (peek()?.v === "=") {
        p++;
        attrs[t.v] = parseExpr(false);
        if (peek() && peek().t !== "nl" && peek().v !== "}") err(`Missing newline after argument "${t.v}"`);
        continue;
      }
      const labels: string[] = [];
      while (peek() && (peek().t === "str" || peek().t === "id") && peek().v !== "{") labels.push(toks[p++].v);
      if (peek()?.v !== "{") err(`Invalid block definition: Either a quoted string block label or an opening brace ("{") is expected here`);
      p++;
      const body = parseBody(true);
      blocks.push({ type: t.v, labels, attrs: body.attrs, blocks: body.blocks, start: t.line, end: body.end });
    }
  };

  const body = parseBody(false);
  return { blocks: body.blocks, comments, lines: src.split("\n") };
};

export const hclStr = (x: HclValue | undefined) => (x === undefined || x === null ? "" : typeof x === "object" ? JSON.stringify(x) : String(x));

/** Resources of a parsed file as "type.name" → block. */
export const tfResources = (f: HclFile) => f.blocks.filter((b) => b.type === "resource" && b.labels.length >= 2);

// ---------------------------------------------------------------- secrets
export type SecretRule = { id: string; trivyId: string; trivyTitle: string; category: string; sev: Severity; re: RegExp; group?: number; generic?: boolean };

export const SECRET_RULES: SecretRule[] = [
  { id: "aws-access-token", trivyId: "aws-access-key-id", trivyTitle: "AWS Access Key ID", category: "AWS", sev: "CRITICAL", re: /\b((?:A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[A-Z2-7]{16})\b/, group: 1 },
  { id: "github-pat", trivyId: "github-pat", trivyTitle: "GitHub Personal Access Token", category: "GitHub", sev: "CRITICAL", re: /\b(ghp_[0-9a-zA-Z]{36})\b/, group: 1 },
  { id: "github-fine-grained-pat", trivyId: "github-fine-grained-pat", trivyTitle: "GitHub Fine-grained personal access tokens", category: "GitHub", sev: "CRITICAL", re: /\b(github_pat_\w{82})\b/, group: 1 },
  { id: "slack-bot-token", trivyId: "slack-access-token", trivyTitle: "Slack token", category: "Slack", sev: "HIGH", re: /\b(xoxb-[0-9]{10,13}-[0-9]{10,13}[a-zA-Z0-9-]*)\b/, group: 1 },
  { id: "private-key", trivyId: "private-key", trivyTitle: "Asymmetric Private Key", category: "AsymmetricPrivateKey", sev: "HIGH", re: /(-----BEGIN[ A-Z0-9_-]{0,100}PRIVATE KEY( BLOCK)?-----)/, group: 1 },
  {
    id: "generic-api-key",
    trivyId: "",
    trivyTitle: "",
    category: "",
    sev: "MEDIUM",
    re: /(?:secret|token|passwd|password|pwd|api[_-]?key|access[_-]?key|credential)s?[\w.-]{0,20}["']?\s*(?:=|:|:=|=>)\s*["'`]?([A-Za-z0-9/+_=!@#$%^&*.~-]{10,150})["'`]?/i,
    group: 1,
    generic: true,
  },
];

/** Shannon entropy (bits per char), like gitleaks computes it. */
export const entropy = (s: string) => {
  const freq = new Map<string, number>();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let e = 0;
  for (const n of freq.values()) {
    const p = n / s.length;
    e -= p * Math.log2(p);
  }
  return e;
};

export type SecretHit = { rule: SecretRule; line: number; col: number; text: string; secret: string; match: string };

const SAFE_REF = /process\.env|os\.environ|os\.getenv|getenv\(|\$\{|secretsmanager|ssm:|vault:|<[A-Z_ -]+>|valueFrom|secretKeyRef|arn:aws:secretsmanager/i;

/** Finds secrets line by line (one hit per rule per line). */
export const findSecrets = (content: string): SecretHit[] => {
  const hits: SecretHit[] = [];
  const lines = content.split("\n");
  lines.forEach((text, i) => {
    const specific = new Set<string>();
    for (const rule of SECRET_RULES) {
      const m = rule.re.exec(text);
      if (!m) continue;
      const secret = m[rule.group ?? 0] ?? m[0];
      if (rule.generic) {
        if (SAFE_REF.test(text) || specific.size) continue;
        if (entropy(secret) < 3.5 || /^(true|false|null|none|changeme|password|example|xxx+|\*+)$/i.test(secret)) continue;
        if (/^[a-z_.]+$/i.test(secret) && !/\d/.test(secret)) continue; // identifiers like config.db.password
      }
      specific.add(rule.id);
      hits.push({ rule, line: i + 1, col: m.index + 1, text, secret, match: m[0] });
    }
  });
  return hits;
};
