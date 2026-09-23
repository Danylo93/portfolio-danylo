// checkov: policy-as-code scanner for Terraform, Kubernetes manifests and Dockerfiles.
import { registerTool } from "../registry";
import type { Shell } from "../shell";
import { dockerFacts, hclStr, isDockerfile, isRootUser, isTerraform, isYaml, k8sWorkloads, parseHcl, relTo, tfResources, usesLatest, walkFiles, type HclBlock, type HclFile } from "./sec-common";
import { coversPort, ingressRules, openToWorld, s3Companions } from "./trivy";

export type Framework = "terraform" | "kubernetes" | "dockerfile";
export type CheckRecord = {
  id: string;
  name: string;
  framework: Framework;
  resource: string;
  file: string;
  lines: [number, number];
  result: "PASSED" | "FAILED" | "SKIPPED";
  suppress?: string;
  guide: string;
};

const G = "https://docs.prismacloud.io/en/enterprise-edition/policy-reference";
const CHECKS: Record<string, { name: string; guide: string }> = {
  CKV_AWS_18: { name: "Ensure the S3 bucket has access logging enabled", guide: `${G}/aws-policies/s3-policies/s3-13-enable-logging` },
  CKV_AWS_19: { name: "Ensure all data stored in the S3 bucket is securely encrypted at rest", guide: `${G}/aws-policies/s3-policies/s3-14-data-encrypted-at-rest` },
  CKV_AWS_20: { name: "Ensure the S3 bucket does not allow READ permissions to everyone", guide: `${G}/aws-policies/s3-policies/s3-1-acl-read-permissions-everyone` },
  CKV_AWS_21: { name: "Ensure all data stored in the S3 bucket have versioning enabled", guide: `${G}/aws-policies/s3-policies/s3-16-enable-versioning` },
  CKV_AWS_57: { name: "Ensure the S3 bucket does not allow WRITE permissions to everyone", guide: `${G}/aws-policies/s3-policies/s3-2-acl-write-permissions-everyone` },
  CKV_AWS_145: { name: "Ensure that S3 buckets are encrypted with KMS by default", guide: `${G}/aws-policies/aws-general-policies/ensure-that-s3-buckets-are-encrypted-with-kms-by-default` },
  CKV2_AWS_6: { name: "Ensure that S3 bucket has a Public Access block", guide: `${G}/aws-policies/aws-networking-policies/s3-bucket-should-have-public-access-blocks-defaults-to-false-if-the-public-access-block-is-not-attached` },
  CKV_AWS_53: { name: "Ensure S3 bucket has block public ACLS enabled", guide: `${G}/aws-policies/s3-policies/bc-aws-s3-19` },
  CKV_AWS_54: { name: "Ensure S3 bucket has block public policy enabled", guide: `${G}/aws-policies/s3-policies/bc-aws-s3-20` },
  CKV_AWS_55: { name: "Ensure S3 bucket has ignore public ACLs enabled", guide: `${G}/aws-policies/s3-policies/bc-aws-s3-21` },
  CKV_AWS_56: { name: "Ensure S3 bucket has 'restrict_public_buckets' enabled", guide: `${G}/aws-policies/s3-policies/bc-aws-s3-22` },
  CKV_AWS_23: { name: "Ensure every security group and rule has a description", guide: `${G}/aws-policies/aws-networking-policies/networking-31` },
  CKV_AWS_24: { name: "Ensure no security groups allow ingress from 0.0.0.0:0 to port 22", guide: `${G}/aws-policies/aws-networking-policies/networking-1-port-security` },
  CKV_AWS_25: { name: "Ensure no security groups allow ingress from 0.0.0.0:0 to port 3389", guide: `${G}/aws-policies/aws-networking-policies/networking-2` },
  CKV_AWS_260: { name: "Ensure no security groups allow ingress from 0.0.0.0:0 to port 80", guide: `${G}/aws-policies/aws-networking-policies/ensure-aws-security-groups-do-not-allow-ingress-from-00000-to-port-80` },
  CKV_AWS_8: { name: "Ensure all data stored in the Launch configuration or instance Elastic Blocks Store is securely encrypted", guide: `${G}/aws-policies/aws-general-policies/general-13` },
  CKV_AWS_79: { name: "Ensure Instance Metadata Service Version 1 is not enabled", guide: `${G}/aws-policies/aws-general-policies/bc-aws-general-31` },
  CKV_K8S_11: { name: "CPU limits should be set", guide: `${G}/kubernetes-policies/kubernetes-policy-index/bc-k8s-10` },
  CKV_K8S_13: { name: "Memory limits should be set", guide: `${G}/kubernetes-policies/kubernetes-policy-index/bc-k8s-12` },
  CKV_K8S_14: { name: "Image Tag should be fixed - not latest or blank", guide: `${G}/kubernetes-policies/kubernetes-policy-index/bc-k8s-13` },
  CKV_K8S_16: { name: "Container should not be privileged", guide: `${G}/kubernetes-policies/kubernetes-policy-index/bc-k8s-15` },
  CKV_K8S_17: { name: "Containers should not share the host process ID namespace", guide: `${G}/kubernetes-policies/kubernetes-policy-index/bc-k8s-16` },
  CKV_K8S_19: { name: "Containers should not share the host network namespace", guide: `${G}/kubernetes-policies/kubernetes-policy-index/bc-k8s-18` },
  CKV_K8S_20: { name: "Containers should not run with allowPrivilegeEscalation", guide: `${G}/kubernetes-policies/kubernetes-policy-index/bc-k8s-19` },
  CKV_K8S_22: { name: "Use read-only filesystem for containers where possible", guide: `${G}/kubernetes-policies/kubernetes-policy-index/bc-k8s-21` },
  CKV_K8S_23: { name: "Minimize the admission of root containers", guide: `${G}/kubernetes-policies/kubernetes-policy-index/bc-k8s-22` },
  CKV_K8S_28: { name: "Minimize the admission of containers with the NET_RAW capability", guide: `${G}/kubernetes-policies/kubernetes-policy-index/bc-k8s-27` },
  CKV_K8S_37: { name: "Minimize the admission of containers with capabilities assigned", guide: `${G}/kubernetes-policies/kubernetes-policy-index/bc-k8s-34` },
  CKV_DOCKER_1: { name: "Ensure port 22 is not exposed", guide: `${G}/docker-policies/docker-policy-index/ensure-port-22-is-not-exposed` },
  CKV_DOCKER_2: { name: "Ensure that HEALTHCHECK instructions have been added to container images", guide: `${G}/docker-policies/docker-policy-index/ensure-that-healthcheck-instructions-have-been-added-to-container-images` },
  CKV_DOCKER_3: { name: "Ensure that a user for the container has been created", guide: `${G}/docker-policies/docker-policy-index/ensure-that-a-user-for-the-container-has-been-created` },
  CKV_DOCKER_4: { name: "Ensure that COPY is used instead of ADD in Dockerfiles", guide: `${G}/docker-policies/docker-policy-index/ensure-that-copy-is-used-instead-of-add-in-dockerfiles` },
  CKV_DOCKER_7: { name: "Ensure the base image uses a non latest version tag", guide: `${G}/docker-policies/docker-policy-index/ensure-the-base-image-uses-a-non-latest-version-tag` },
};
export const CHECK_IDS = Object.keys(CHECKS);

const inlineSkips = (f: HclFile, r: HclBlock) => {
  const out = new Map<string, string>();
  for (const c of f.comments)
    if (c.line >= r.start - 1 && c.line <= r.end) {
      const m = /checkov:skip=([A-Z0-9_]+)(?::(.*))?/.exec(c.text);
      if (m) out.set(m[1], (m[2] ?? "").trim() || "No comment provided");
    }
  return out;
};

type Eval = { id: string; pass: boolean };

const tfChecks = (f: HclFile, r: HclBlock): Eval[] => {
  const type = r.labels[0];
  const ev: Eval[] = [];
  if (type === "aws_s3_bucket") {
    const sse = s3Companions(f, r, "aws_s3_bucket_server_side_encryption_configuration")[0] ?? r.blocks.find((b) => b.type === "server_side_encryption_configuration");
    const algo = JSON.stringify(sse ?? {}).match(/"sse_algorithm":"([^"]+)"/)?.[1];
    const ver = s3Companions(f, r, "aws_s3_bucket_versioning")[0];
    const verOn = ver ? /"status":"Enabled"/.test(JSON.stringify(ver.blocks.map((x) => x.attrs))) : r.blocks.some((x) => x.type === "versioning" && x.attrs.enabled === true);
    const pab = s3Companions(f, r, "aws_s3_bucket_public_access_block")[0];
    ev.push({ id: "CKV_AWS_18", pass: !!s3Companions(f, r, "aws_s3_bucket_logging").length || r.blocks.some((b) => b.type === "logging") });
    ev.push({ id: "CKV_AWS_19", pass: !!algo });
    ev.push({ id: "CKV_AWS_145", pass: algo === "aws:kms" || algo === "aws:kms:dsse" });
    ev.push({ id: "CKV_AWS_21", pass: verOn });
    ev.push({ id: "CKV2_AWS_6", pass: !!pab && pab.attrs.block_public_acls === true && pab.attrs.block_public_policy === true });
    if (r.attrs.acl !== undefined) {
      ev.push({ id: "CKV_AWS_20", pass: !/^public-read(-write)?$/.test(hclStr(r.attrs.acl)) });
      ev.push({ id: "CKV_AWS_57", pass: hclStr(r.attrs.acl) !== "public-read-write" });
    }
  }
  if (type === "aws_s3_bucket_acl") {
    ev.push({ id: "CKV_AWS_20", pass: !/^public-read(-write)?$/.test(hclStr(r.attrs.acl)) });
    ev.push({ id: "CKV_AWS_57", pass: hclStr(r.attrs.acl) !== "public-read-write" });
  }
  if (type === "aws_s3_bucket_public_access_block") {
    ev.push({ id: "CKV_AWS_53", pass: r.attrs.block_public_acls === true });
    ev.push({ id: "CKV_AWS_54", pass: r.attrs.block_public_policy === true });
    ev.push({ id: "CKV_AWS_55", pass: r.attrs.ignore_public_acls === true });
    ev.push({ id: "CKV_AWS_56", pass: r.attrs.restrict_public_buckets === true });
  }
  if (type === "aws_security_group" || type === "aws_security_group_rule" || type === "aws_vpc_security_group_ingress_rule") {
    const rules = ingressRules(f).filter((x) => x.res === r);
    const bad = (port: number) => rules.some((x) => openToWorld(x.cidrs) && coversPort(x, port));
    ev.push({ id: "CKV_AWS_24", pass: !bad(22) });
    ev.push({ id: "CKV_AWS_25", pass: !bad(3389) });
    ev.push({ id: "CKV_AWS_260", pass: !bad(80) });
    const allBlocks = [...r.blocks.filter((b) => b.type === "ingress" || b.type === "egress")];
    ev.push({ id: "CKV_AWS_23", pass: !!hclStr(r.attrs.description) && allBlocks.every((b) => !!hclStr(b.attrs.description)) });
  }
  if (type === "aws_instance") {
    ev.push({ id: "CKV_AWS_8", pass: r.blocks.some((b) => b.type === "root_block_device" && b.attrs.encrypted === true) });
    ev.push({ id: "CKV_AWS_79", pass: r.blocks.some((b) => b.type === "metadata_options" && hclStr(b.attrs.http_tokens) === "required") });
  }
  return ev;
};

export type CheckovOpts = { frameworks?: Framework[]; checks?: string[]; skipChecks?: string[] };

const matchId = (list: string[], id: string) => list.some((p) => (p.endsWith("*") ? id.startsWith(p.slice(0, -1)) : p === id));

/** Runs all checks on the files under target. Pure: used by the tool and by lab checks. */
export const checkovScan = (sh: Shell, target: string, opts: CheckovOpts = {}): { records: CheckRecord[]; parseErrors: string[] } => {
  const records: CheckRecord[] = [];
  const parseErrors: string[] = [];
  const fw = opts.frameworks;
  const push = (rec: Omit<CheckRecord, "name" | "guide">, skips: Map<string, string>) => {
    if (opts.checks?.length && !matchId(opts.checks, rec.id)) return;
    if (opts.skipChecks?.length && matchId(opts.skipChecks, rec.id)) return;
    const meta = CHECKS[rec.id];
    const suppress = skips.get(rec.id);
    records.push({ ...rec, name: meta.name, guide: meta.guide, ...(suppress ? { result: "SKIPPED", suppress } : {}) });
  };
  const single = sh.readFile(target) !== undefined;
  for (const abs of walkFiles(sh, target)) {
    const content = sh.state.files[abs] ?? "";
    const file = "/" + (single ? target.replace(/^\.\//, "") : relTo(sh, target, abs));
    if (isTerraform(abs) && (!fw || fw.includes("terraform"))) {
      let f: HclFile;
      try {
        f = parseHcl(content);
      } catch (e) {
        parseErrors.push(`${file}: ${(e as Error).message}`);
        continue;
      }
      for (const r of tfResources(f)) {
        const skips = inlineSkips(f, r);
        for (const e of tfChecks(f, r))
          push({ id: e.id, framework: "terraform", resource: `${r.labels[0]}.${r.labels[1]}`, file, lines: [r.start, r.end], result: e.pass ? "PASSED" : "FAILED" }, skips);
      }
    } else if (isDockerfile(abs) && (!fw || fw.includes("dockerfile"))) {
      const d = dockerFacts(content);
      const skips = new Map<string, string>();
      for (const m of content.matchAll(/checkov:skip=([A-Z0-9_]+)(?::(.*))?/g)) skips.set(m[1], (m[2] ?? "").trim() || "No comment provided");
      const all: [number, number] = [1, d.lastLine];
      const res = `${file}.`;
      const add = (id: string, pass: boolean, lines: [number, number] = all) => push({ id, framework: "dockerfile", resource: res, file, lines, result: pass ? "PASSED" : "FAILED" }, skips);
      add("CKV_DOCKER_1", !d.expose22, d.expose22 ? [d.expose22, d.expose22] : all);
      add("CKV_DOCKER_2", d.healthcheck);
      add("CKV_DOCKER_3", !isRootUser(d.lastUser?.user), d.lastUser && isRootUser(d.lastUser.user) ? [d.lastUser.line, d.lastUser.line] : all);
      add("CKV_DOCKER_4", !d.add, d.add ? [d.add, d.add] : all);
      const latest = d.froms.find((x) => usesLatest(x.image) && x.image !== "scratch");
      add("CKV_DOCKER_7", !latest, latest ? [latest.line, latest.line] : all);
    } else if (isYaml(abs) && (!fw || fw.includes("kubernetes")) && /^\s*kind:/m.test(content)) {
      const { workloads, error } = k8sWorkloads(content);
      if (error) parseErrors.push(`${file}: ${error}`);
      const annotations = content.matchAll(/checkov\.io\/skip\d+:\s*["']?([A-Z0-9_]+)=?([^"'\n]*)/g);
      const skips = new Map<string, string>();
      for (const m of annotations) skips.set(m[1], m[2].trim() || "No comment provided");
      for (const w of workloads) {
        const cs = w.containers;
        const res = `${w.kind}.${w.namespace}.${w.name}`;
        const add = (id: string, pass: boolean) => push({ id, framework: "kubernetes", resource: res, file, lines: [w.startLine, w.endLine], result: pass ? "PASSED" : "FAILED" }, skips);
        add("CKV_K8S_11", cs.every((c) => c.limits));
        add("CKV_K8S_13", cs.every((c) => c.limits));
        add("CKV_K8S_14", cs.every((c) => !usesLatest(c.image)));
        add("CKV_K8S_16", cs.every((c) => !c.privileged));
        add("CKV_K8S_17", !w.hostPID);
        add("CKV_K8S_19", !w.hostNetwork);
        add("CKV_K8S_20", cs.every((c) => !c.allowPrivEsc));
        add("CKV_K8S_22", cs.every((c) => c.readOnlyRoot));
        add("CKV_K8S_23", cs.every((c) => c.runAsNonRoot));
        add("CKV_K8S_28", cs.every((c) => c.dropNetRaw && !c.addCaps.includes("NET_RAW")));
        add("CKV_K8S_37", cs.every((c) => c.dropAll));
      }
    }
  }
  return { records, parseErrors };
};

// ---------------------------------------------------------------- state
export type CheckovRun = { target: string; passed: number; failed: number; skipped: number; failedIds: string[]; skippedIds: string[]; skipChecks: string[]; frameworks: Framework[] };
export const checkovState = (sh: Shell) => sh.ext("sec:checkov", () => ({ runs: [] as CheckovRun[] }));
export const lastCheckovRun = (sh: Shell) => checkovState(sh).runs[checkovState(sh).runs.length - 1];

const LOGO = `
       _               _
   ___| |__   ___  ___| | _______   __
  / __| '_ \\ / _ \\/ __| |/ / _ \\ \\ / /
 | (__| | | |  __/ (__|   < (_) \\ V /
  \\___|_| |_|\\___|\\___|_|\\_\\___/ \\_/

By Prisma Cloud | version: 3.2.255
`;

const listFlag = (args: string[], ...names: string[]) => {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    for (const n of names) {
      if (a === n && args[i + 1]) out.push(...args[i + 1].split(","));
      else if (a.startsWith(n + "=")) out.push(...a.slice(n.length + 1).split(","));
    }
  }
  return out.map((x) => x.trim()).filter(Boolean);
};

registerTool({
  name: "checkov",
  summary: "policy-as-code: verifica Terraform, Kubernetes e Dockerfile contra centenas de boas práticas de segurança",
  flags: {
    "-d": "diretório a escanear",
    "--directory": "diretório a escanear",
    "-f": "arquivo a escanear",
    "--file": "arquivo a escanear",
    "--framework": "limita os frameworks: terraform, kubernetes, dockerfile",
    "--check": "roda só estes checks (ex.: CKV_AWS_20,CKV_AWS_24)",
    "-c": "o mesmo que --check",
    "--skip-check": "ignora estes checks (ex.: CKV_AWS_18) — prefira o comentário inline com justificativa",
    "--compact": "não imprime o trecho de código de cada falha",
    "--quiet": "mostra só os checks que falharam",
    "--soft-fail": "sempre sai com código 0 (não quebra a pipeline)",
    "-o": "formato de saída: cli (padrão) ou json",
    "--output": "formato de saída: cli (padrão) ou json",
  },
  valueFlags: ["-d", "--directory", "-f", "--file", "--framework", "--check", "-c", "--skip-check", "-o", "--output"],
  run: ({ sh, flags, args }) => {
    if (flags.h || flags.help || !args.length)
      return "usage: checkov [-h] [-v] [-d DIRECTORY] [-f FILE] [--framework FRAMEWORK] [-c CHECK] [--skip-check SKIP_CHECK] [--compact] [--quiet] [--soft-fail] [-o {cli,json}]\n\nInfrastructure as code static analysis";
    if (flags.v || flags.version) return "3.2.255";
    const dir = flags.d ?? flags.directory;
    const fileArg = flags.f ?? flags.file;
    const target = typeof fileArg === "string" ? fileArg : typeof dir === "string" ? dir : undefined;
    if (!target) return { output: "checkov: error: one of the arguments -d/--directory -f/--file is required", ok: false };
    if (typeof fileArg === "string" ? sh.readFile(fileArg) === undefined : !sh.isDir(target))
      return { output: `checkov: error: ${typeof fileArg === "string" ? "file" : "directory"} ${target} does not exist`, ok: false };
    const fwList = listFlag(args, "--framework");
    const valid: Framework[] = ["terraform", "kubernetes", "dockerfile"];
    const bad = fwList.find((x) => x !== "all" && !valid.includes(x as Framework));
    if (bad) return { output: `checkov: error: argument --framework: invalid choice: '${bad}' (choose from 'all', 'dockerfile', 'kubernetes', 'terraform', ...)`, ok: false };
    const frameworks = fwList.length && !fwList.includes("all") ? (fwList as Framework[]) : undefined;
    const checks = listFlag(args, "--check", "-c");
    const skipChecks = listFlag(args, "--skip-check");
    const { records, parseErrors } = checkovScan(sh, target, { frameworks, checks, skipChecks });
    const passed = records.filter((r) => r.result === "PASSED");
    const failed = records.filter((r) => r.result === "FAILED");
    const skipped = records.filter((r) => r.result === "SKIPPED");
    const usedFw = valid.filter((f) => records.some((r) => r.framework === f));
    checkovState(sh).runs.push({ target: sh.resolve(target), passed: passed.length, failed: failed.length, skipped: skipped.length, failedIds: failed.map((r) => r.id), skippedIds: skipped.map((r) => r.id), skipChecks, frameworks: usedFw });
    sh.flags.add("checkov:scanned");
    const soft = !!flags["soft-fail"];
    const fmt = String(flags.o ?? flags.output ?? "cli");
    if (fmt === "json") {
      const per = usedFw.map((fw) => {
        const rs = records.filter((r) => r.framework === fw);
        const j = (r: CheckRecord) => ({ check_id: r.id, check_name: r.name, check_result: { result: r.result, ...(r.suppress ? { suppress_comment: r.suppress } : {}) }, resource: r.resource, file_path: r.file, file_line_range: r.lines, guideline: r.guide });
        return {
          check_type: fw,
          results: { passed_checks: rs.filter((r) => r.result === "PASSED").map(j), failed_checks: rs.filter((r) => r.result === "FAILED").map(j), skipped_checks: rs.filter((r) => r.result === "SKIPPED").map(j), parsing_errors: parseErrors },
          summary: { passed: rs.filter((r) => r.result === "PASSED").length, failed: rs.filter((r) => r.result === "FAILED").length, skipped: rs.filter((r) => r.result === "SKIPPED").length, parsing_errors: parseErrors.length, resource_count: new Set(rs.map((r) => r.resource)).size, checkov_version: "3.2.255" },
        };
      });
      return { output: JSON.stringify(per.length === 1 ? per[0] : per, null, 2), ok: soft || !failed.length };
    }
    const compact = !!flags.compact;
    const quiet = !!flags.quiet;
    const out: string[] = [LOGO];
    for (const e of parseErrors) out.push(`[ ERROR ] Failed to parse file ${e}`);
    const show = (r: CheckRecord) => {
      const lines = [`Check: ${r.id}: "${r.name}"`, `\t${r.result} for resource: ${r.resource}`];
      if (r.suppress) lines.push(`\tSuppress comment: ${r.suppress}`);
      lines.push(`\tFile: ${r.file}:${r.lines[0]}-${r.lines[1]}`, `\tGuide: ${r.guide}`);
      if (r.result === "FAILED" && !compact) {
        const abs = sh.readFile(target) !== undefined ? sh.resolve(target) : sh.resolve(`${target}/${r.file.slice(1)}`);
        const src = (sh.state.files[abs] ?? "").split("\n");
        const w = String(r.lines[1]).length;
        lines.push("");
        for (let n = r.lines[0]; n <= Math.min(r.lines[1], r.lines[0] + 24); n++) lines.push(`\t\t${String(n).padEnd(w)} | ${src[n - 1] ?? ""}`);
      }
      return lines.join("\n") + "\n";
    };
    for (const fw of usedFw) {
      const rs = records.filter((r) => r.framework === fw);
      const p = rs.filter((r) => r.result === "PASSED");
      const f = rs.filter((r) => r.result === "FAILED");
      const s = rs.filter((r) => r.result === "SKIPPED");
      out.push(`${fw} scan results:\n`, `Passed checks: ${p.length}, Failed checks: ${f.length}, Skipped checks: ${s.length}\n`);
      for (const r of [...(quiet ? [] : p), ...f, ...(quiet ? [] : s)]) out.push(show(r));
    }
    if (!usedFw.length) out.push("No files found to scan (Terraform, Kubernetes or Dockerfile).");
    return { output: out.join("\n").trimEnd(), ok: soft || !failed.length };
  },
  explainError: (cmd, output) => {
    if (/Failed checks: [1-9]/.test(output))
      return "O checkov achou violações e saiu com código 1 — em CI isso bloqueia o merge. Cada bloco Check mostra o ID, o recurso e as linhas; o Guide explica como corrigir. Para aceitar um risco conscientemente, use um comentário #checkov:skip=ID:justificativa dentro do recurso.";
    if (/one of the arguments -d\/--directory -f\/--file is required/.test(output)) return "Diga ao checkov o que escanear: checkov -d . (diretório) ou checkov -f main.tf (arquivo).";
    if (/does not exist/.test(output)) return "Esse caminho não existe. Use ls para conferir e rode a partir da raiz do projeto: checkov -d .";
    if (/invalid choice/.test(output)) return "Frameworks suportados aqui: terraform, kubernetes, dockerfile (ou all).";
    if (/Failed to parse file/.test(output)) return "Algum arquivo tem erro de sintaxe e foi ignorado pelo scan. Abra o arquivo com vi e confira chaves {}, aspas e o formato chave = valor.";
    return null;
  },
});

