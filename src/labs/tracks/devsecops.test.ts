import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Shell } from "../shell";
import { expectLessonWellFormed, expectSolvable, expectWellFormed, type Solution } from "../test-utils";
import { checkovScan } from "../tools/checkov";
import { cosignState } from "../tools/cosign";
import { lastGitleaksRun } from "../tools/gitleaks";
import { countBySev, imageInfo, parseHcl } from "../tools/sec-common";
import { lastTrivyRun } from "../tools/trivy";
import { FAKE, labs, lessons, track } from "./devsecops";

const FIXED_DOCKERFILE = `FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
USER node
EXPOSE 3000
CMD ["node", "server.js"]
`;

const FIXED_CONFIG = `// Configuração da aplicação (orders-api)
module.exports = {
  region: process.env.AWS_REGION || "us-east-1",
  awsAccessKeyId: process.env.AWS_ACCESS_KEY_ID,
  awsSecretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  bucket: "danylo-uploads",
};
`;

const GITLEAKS_TOML = `title = "orders-api"

[extend]
useDefault = true

[allowlist]
description = "Credenciais falsas usadas em testes"
paths = [
  '''^test/fixtures/''',
]
`;

const TF_HEAD = `terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = "us-east-1"
}
`;

const S3_FIXED = (skip: boolean) => `
resource "aws_s3_bucket" "logs" {
${skip ? "  #checkov:skip=CKV_AWS_18:bucket de destino dos access logs, logar nele mesmo criaria um loop\n" : ""}  bucket = "danylo-app-logs"
}

resource "aws_s3_bucket_public_access_block" "logs" {
  bucket                  = aws_s3_bucket.logs.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "logs" {
  bucket = aws_s3_bucket.logs.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_kms_key" "logs" {
  description         = "Chave do bucket de logs"
  enable_key_rotation = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "logs" {
  bucket = aws_s3_bucket.logs.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.logs.arn
    }
  }
}
`;

const SG = (cidr: string) => `
resource "aws_security_group" "bastion" {
  name        = "bastion-ssh"
  description = "Acesso SSH ao bastion"
  vpc_id      = "vpc-0a1b2c3d4e5f67890"

  ingress {
    description = "SSH"
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = ["${cidr}"]
  }
}
`;

const HARDENED = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: api
  labels:
    app: api
spec:
  replicas: 1
  selector:
    matchLabels:
      app: api
  template:
    metadata:
      labels:
        app: api
    spec:
      containers:
        - name: api
          image: ghcr.io/danylo/api:1.4.0
          ports:
            - containerPort: 8080
          resources:
            requests:
              cpu: 100m
              memory: 128Mi
            limits:
              cpu: 500m
              memory: 256Mi
          securityContext:
            runAsNonRoot: true
            runAsUser: 1000
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities:
              drop: ["ALL"]
`;

const P = "/home/danylo/project";

const SOLUTIONS: Record<string, Solution> = {
  "devsecops-image-cves": [
    [() => "trivy image --severity HIGH,CRITICAL node:14"],
    [(sh) => void sh.saveEdit(`${P}/Dockerfile`, (sh.readFile("Dockerfile") ?? "").replace("FROM node:14", "FROM node:20-alpine"))],
    [() => "trivy config ."],
    [(sh) => void sh.saveEdit(`${P}/Dockerfile`, FIXED_DOCKERFILE)],
    [() => "trivy image --exit-code 1 --severity CRITICAL node:20-alpine"],
  ],
  "devsecops-secret-leak": [
    [() => "gitleaks detect --source . -v --no-git"],
    [(sh) => void sh.saveEdit(`${P}/src/config.js`, FIXED_CONFIG)],
    [() => 'echo ".env" >> .gitignore', () => "rm .env"],
    [(sh) => void sh.saveEdit(`${P}/.gitleaks.toml`, GITLEAKS_TOML)],
    [() => "gitleaks detect --source . -v --no-git"],
  ],
  "devsecops-iac-checkov": [
    [() => "checkov -d ."],
    [(sh) => void sh.saveEdit(`${P}/main.tf`, TF_HEAD + S3_FIXED(false) + SG("0.0.0.0/0"))],
    [(sh) => void sh.saveEdit(`${P}/main.tf`, TF_HEAD + S3_FIXED(false) + SG("10.0.0.0/16"))],
    [(sh) => void sh.saveEdit(`${P}/main.tf`, TF_HEAD + S3_FIXED(true) + SG("10.0.0.0/16"))],
    [() => "checkov -d ."],
  ],
  "devsecops-k8s-pod-hardening": [
    [() => "kubectl exec deploy/api -- id"],
    [() => "kubesec scan k8s/deployment.yaml"],
    [(sh) => void sh.saveEdit(`${P}/k8s/deployment.yaml`, HARDENED)],
    [() => "kubectl apply -f k8s/deployment.yaml"],
    [() => "kubectl exec deploy/api -- id", () => "kubectl exec deploy/api -- touch /x"],
  ],
  "devsecops-supply-chain": [
    [() => "syft ghcr.io/danylo/api:1.4.0 -o spdx-json > sbom.json"],
    [() => "cosign generate-key-pair"],
    [() => "cosign sign --yes --key cosign.key ghcr.io/danylo/api:1.4.0"],
    [() => "cosign verify --key cosign.pub ghcr.io/danylo/api:1.4.0"],
    [() => "cosign verify --key cosign.pub ghcr.io/danylo/api:1.4.1"],
  ],
};

describe("devsecops track", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("track metadata", () => {
    expect(track.id).toBe("devsecops");
    expect(labs).toHaveLength(5);
    for (const l of labs) expect(l.track).toBe("devsecops");
  });

  it.each(labs.map((l) => [l.id, l] as const))("%s is well formed and solvable", (_, lab) => {
    expectWellFormed(lab);
    expectSolvable(lab, SOLUTIONS[lab.id]);
  });

  it.each(lessons.map((l) => [l.id, l] as const))("lesson %s", (_, lesson) => {
    expectLessonWellFormed(lesson);
    expect(lesson.track).toBe("devsecops");
    expect(labs.some((l) => l.id === lesson.before)).toBe(true);
  });
});

describe("devsecops engines", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("trivy: node:14 has many HIGH/CRITICAL, node:20-alpine only LOW", () => {
    const old = imageInfo("node:14")!;
    const c14 = countBySev([...old.vulns, ...(old.lang ?? []).flatMap((l) => l.vulns)]);
    expect(c14.CRITICAL).toBeGreaterThanOrEqual(5);
    expect(c14.HIGH).toBeGreaterThanOrEqual(5);
    const c20 = countBySev(imageInfo("docker.io/library/node:20-alpine")!.vulns);
    expect(c20.CRITICAL + c20.HIGH + c20.MEDIUM).toBe(0);

    const sh = new Shell();
    const r1 = sh.exec("trivy image --severity CRITICAL --exit-code 1 node:14");
    expect(r1.output).toMatch(/Total: \d+ \(CRITICAL: \d+\)/);
    expect(sh.entries[0].ok).toBe(false);
    expect(lastTrivyRun(sh)!.gateFailed).toBe(true);
    sh.exec("trivy image --severity CRITICAL --ignore-unfixed node:14");
    expect(lastTrivyRun(sh)!.total).toBeLessThan(c14.CRITICAL);
    sh.exec("trivy image --exit-code 1 --severity HIGH,CRITICAL node:20-alpine");
    expect(sh.entries[2].ok).toBe(true);
    const bad = sh.exec("trivy image nodee:14");
    expect(bad.output).toMatch(/unable to find the specified image/);
    const json = sh.exec("trivy image -q -f json node:20-alpine").output;
    expect(JSON.parse(json).Results[0].Vulnerabilities[0].VulnerabilityID).toBe("CVE-2024-9143");
  });

  it("trivy fs and config find lockfile CVEs, secrets and misconfigs", () => {
    const sh = new Shell({
      files: {
        "package-lock.json": JSON.stringify({ packages: { "node_modules/lodash": { version: "4.17.15" } } }),
        "app.env": `GITHUB_TOKEN=${FAKE.ghToken}\n`,
        Dockerfile: "FROM python:latest\nADD . /app\nEXPOSE 22\n",
        "main.tf": SG("0.0.0.0/0"),
      },
    });
    const fs = sh.exec("trivy fs .").output;
    expect(fs).toMatch(/CVE-2021-23337/);
    expect(fs).toMatch(/github-pat/);
    const cfg = sh.exec("trivy config .").output;
    for (const id of ["AVD-DS-0001", "AVD-DS-0002", "AVD-DS-0004", "AVD-DS-0005", "AVD-AWS-0107"]) expect(cfg).toContain(id);
    sh.writeFile(".trivyignore", "AVD-DS-0026\n");
    sh.exec("trivy config .");
    expect(lastTrivyRun(sh)!.misconfigIds).not.toContain("AVD-DS-0026");
  });

  it("gitleaks: allowlist, gitleaks:allow and useDefault", () => {
    const sh = new Shell({
      files: {
        "a.js": `const k = "${FAKE.awsKey}";\nconst ok = "${FAKE.fixtureKey}"; // gitleaks:allow\n`,
        "test/fixtures/x.json": `{"k":"${FAKE.fixtureKey}"}`,
      },
    });
    expect(sh.exec("gitleaks detect --source .").output).toMatch(/not a git repository/);
    const out = sh.exec("gitleaks detect --source . -v --no-git --redact").output;
    expect(out).toMatch(/leaks found: 2/);
    expect(out).toMatch(/Secret:\s+REDACTED/);
    sh.writeFile(".gitleaks.toml", "[allowlist]\npaths = ['''^test/fixtures/''']\n");
    sh.exec("gitleaks dir .");
    expect(lastGitleaksRun(sh).leaks).toHaveLength(0); // no default rules!
    sh.writeFile(".gitleaks.toml", GITLEAKS_TOML);
    sh.exec("gitleaks dir . --report-path leaks.json");
    expect(lastGitleaksRun(sh).leaks.map((l) => l.file)).toEqual(["a.js"]);
    expect(JSON.parse(sh.readFile("leaks.json")!)[0].RuleID).toBe("aws-access-token");
  });

  it("checkov: fails on the seed, passes after the fix, honors skips", () => {
    const sh = new Shell({ files: { "main.tf": TF_HEAD + '\nresource "aws_s3_bucket" "logs" {\n  bucket = "x"\n}\n' + SG("0.0.0.0/0") } });
    const out = sh.exec("checkov -d .").output;
    expect(out).toMatch(/Passed checks: \d+, Failed checks: [1-9]/);
    expect(out).toMatch(/FAILED for resource: aws_security_group\.bastion/);
    expect(out).toMatch(/File: \/main\.tf:\d+-\d+/);
    sh.writeFile("main.tf", TF_HEAD + S3_FIXED(true) + SG("10.0.0.0/16"));
    const ok = sh.exec("checkov -d . --compact");
    expect(ok.output).toMatch(/Failed checks: 0, Skipped checks: 1/);
    expect(sh.entries[1].ok).toBe(true);
    sh.writeFile("main.tf", TF_HEAD + S3_FIXED(false) + SG("10.0.0.0/16"));
    expect(checkovScan(sh, ".", { skipChecks: ["CKV_AWS_18"] }).records.filter((r) => r.result === "FAILED")).toHaveLength(0);
    expect(sh.exec("checkov -f main.tf --check CKV_AWS_24").output).toMatch(/Passed checks: 1, Failed checks: 0/);
    expect(() => parseHcl('resource "a" "b" {\n  x = \n')).toThrow();
  });

  it("checkov + trivy on k8s manifests", () => {
    const sh = new Shell({ files: { "k8s/d.yaml": HARDENED.replace("runAsNonRoot: true", "privileged: true") } });
    const out = sh.exec("checkov -d k8s --framework kubernetes").output;
    expect(out).toMatch(/CKV_K8S_16[\s\S]*FAILED for resource: Deployment\.default\.api/);
    expect(sh.exec("trivy config k8s").output).toMatch(/KSV017/);
    expect(sh.exec("kubesec scan k8s/d.yaml").output).toMatch(/"score": -30/);
  });

  it("cosign: verify fails for unsigned images and wrong keys, passes when signed", () => {
    const sh = new Shell();
    sh.exec("COSIGN_PASSWORD=abc cosign generate-key-pair");
    sh.exec("cosign generate-key-pair --output-key-prefix other");
    expect(sh.exec("cosign verify --key cosign.pub ghcr.io/danylo/api:1.4.0").output).toMatch(/no signatures found/);
    expect(sh.exec("cosign sign --yes --key cosign.key ghcr.io/danylo/api:1.4.0").output).toMatch(/decryption failed/);
    expect(sh.exec("COSIGN_PASSWORD=abc cosign sign --yes --key cosign.key ghcr.io/danylo/api:1.4.0").output).toMatch(/Pushing signature/);
    expect(sh.exec("cosign verify --key other.pub ghcr.io/danylo/api:1.4.0").output).toMatch(/no matching signatures/);
    expect(sh.exec("cosign verify --key cosign.pub ghcr.io/danylo/api:1.4.0").output).toMatch(/Verification for ghcr\.io\/danylo\/api:1\.4\.0/);
    expect(sh.exec("cosign verify --key cosign.pub ghcr.io/danylo/api:1.4.1").output).toMatch(/no signatures found/);
    expect(cosignState(sh).verifies.map((v) => v.ok)).toEqual([false, false, true, false]);
    sh.exec("syft ghcr.io/danylo/api:1.4.0 -o cyclonedx-json > bom.json");
    expect(sh.exec("COSIGN_PASSWORD=abc cosign attest --yes --key cosign.key --type cyclonedx --predicate bom.json ghcr.io/danylo/api:1.4.0").output).not.toMatch(/Error/);
    expect(sh.exec("cosign verify-attestation --key cosign.pub --type cyclonedx ghcr.io/danylo/api:1.4.0").output).toMatch(/payloadType/);
    expect(sh.exec("trivy sbom bom.json").output).toMatch(/alpine 3\.20\.3/);
  });
});
