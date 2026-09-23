import YAML from "yaml";
import "../k8s/kubectl";
import "../tools/trivy";
import "../tools/gitleaks";
import "../tools/checkov";
import "../tools/cosign";
import "../tools/sec-syft";
import "../tools/sec-kubesec";
import { createDeployment, findDeployment } from "../k8s/cluster";
import type { Shell } from "../shell";
import type { Lab, Lesson, Track } from "../types";
import { PROJECT } from "../util";
import { checkovScan, lastCheckovRun } from "../tools/checkov";
import { cosignState, isSignedBy } from "../tools/cosign";
import { lastGitleaksRun, loadLeaksConfig } from "../tools/gitleaks";
import { findSecrets, finalBaseImage, imageInfo, k8sWorkloads, parseRef } from "../tools/sec-common";
import { dockerfileMisconfigs, lastTrivyRun, trivyState } from "../tools/trivy";

export const track: Track = {
  id: "devsecops",
  title: "DevSecOps",
  desc: "Segurança shift-left na prática: scan de CVEs em imagens com Trivy, caça a segredos vazados com Gitleaks, policy-as-code em Terraform com Checkov, hardening de Pods e cadeia de suprimentos com SBOM e assinatura Cosign.",
  color: "#f87171",
  icon: "🛡",
};

// ---------------------------------------------------------------- helpers used by checks
const P = (rel: string) => `${PROJECT}/${rel}`;
const file = (sh: Shell, rel: string) => sh.readFile(P(rel));

/** HIGH/CRITICAL vulns (OS + language) of an image, or null if unknown. */
const highCrit = (ref: string) => {
  const info = imageInfo(ref);
  if (!info) return null;
  return [...info.vulns, ...(info.lang ?? []).flatMap((l) => l.vulns)].filter((v) => v.sev === "HIGH" || v.sev === "CRITICAL");
};
const baseOf = (sh: Shell) => finalBaseImage(file(sh, "Dockerfile") ?? "")?.image;
const baseIsClean = (sh: Shell) => {
  const b = baseOf(sh);
  if (!b || /:latest$|^[^:]+$/.test(b)) return false;
  const v = highCrit(b);
  return !!v && v.length === 0;
};

const entriesMatching = (sh: Shell, cmd: RegExp, out: RegExp) => sh.entries.some((e) => cmd.test(e.cmd) && out.test(e.output));

type Json = ReturnType<typeof YAML.parse>;
const hardenedFacts = (content: string | undefined) => {
  if (!content) return null;
  const w = k8sWorkloads(content).workloads.find((x) => x.kind === "Deployment" && x.name === "api");
  const c = w?.containers[0];
  if (!c) return null;
  return {
    privileged: !c.privileged,
    allowPrivilegeEscalation: !c.allowPrivEsc,
    readOnlyRootFilesystem: c.readOnlyRoot,
    runAsNonRoot: c.runAsNonRoot,
    runAsUser: (c.runAsUser ?? 0) > 0,
    dropAll: c.dropAll,
  };
};
const MISSING_LABEL: Record<string, string> = {
  privileged: "privileged ainda está true (remova ou use false)",
  allowPrivilegeEscalation: "falta allowPrivilegeEscalation: false",
  readOnlyRootFilesystem: "falta readOnlyRootFilesystem: true",
  runAsNonRoot: "falta runAsNonRoot: true",
  runAsUser: "falta runAsUser com um UID diferente de 0 (ex.: 1000)",
  dropAll: "falta capabilities.drop: [\"ALL\"]",
};
const missingHardening = (content: string | undefined) => {
  const f = hardenedFacts(content);
  if (!f) return ["o arquivo não tem mais o Deployment api com um container válido"];
  return Object.entries(f).filter(([, ok]) => !ok).map(([k]) => MISSING_LABEL[k]);
};

const s3Failures = (sh: Shell) =>
  checkovScan(sh, PROJECT, { frameworks: ["terraform"] }).records.filter((r) => r.result === "FAILED" && /^aws_s3/.test(r.resource) && r.id !== "CKV_AWS_18");

// ---------------------------------------------------------------- seeds
const APP_DOCKERFILE = `FROM node:14
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
EXPOSE 3000
CMD ["node", "server.js"]
`;

const PACKAGE_JSON = `{
  "name": "orders-api",
  "version": "1.4.0",
  "main": "server.js",
  "dependencies": {
    "express": "4.21.0"
  }
}
`;

const PACKAGE_LOCK = `{
  "name": "orders-api",
  "version": "1.4.0",
  "lockfileVersion": 3,
  "packages": {
    "": { "name": "orders-api", "version": "1.4.0" },
    "node_modules/express": { "version": "4.21.0" },
    "node_modules/body-parser": { "version": "1.20.3" }
  }
}
`;

const SERVER_JS = `const express = require("express");
const app = express();
app.get("/healthz", (_req, res) => res.send("ok"));
app.listen(3000, () => console.log("orders-api listening on :3000"));
`;

// Fake credentials for the leak lab. Assembled at runtime so no literal key lives in the
// repository (GitHub push protection would block it, and scanners would flag the source).
export const FAKE = {
  awsKey: ["AK", "IA", "4XJ2WPLM7QRSZ3KD"].join(""),
  awsSecret: ["q7Vd2mR9xK4pLw8Zt", "N3bYc6HjF1sGe5aUo0iQrTz"].join(""),
  ghToken: ["gh", "p_", "R8x2Kd9LmQ4vT7wZ1nB5cY3hJ6pF0sA2eG9u"].join(""),
  fixtureKey: ["AK", "IA", "Q3EGUXSTFIXTURE7"].join(""),
};

const LEAKY_CONFIG = `// Configuração da aplicação (orders-api)
module.exports = {
  region: "us-east-1",
  awsAccessKeyId: "${FAKE.awsKey}",
  awsSecretAccessKey: "${FAKE.awsSecret}",
  bucket: "danylo-uploads",
};
`;

const LEAKY_ENV = `NODE_ENV=production
DB_HOST=db.internal
DB_PASSWORD=S3nh4-Pr0d!2024#xK
GITHUB_TOKEN=${FAKE.ghToken}
`;

const FIXTURE = `{
  "accessKeyId": "${FAKE.fixtureKey}",
  "region": "us-east-1"
}
`;

const MAIN_TF = `terraform {
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

resource "aws_s3_bucket" "logs" {
  bucket = "danylo-app-logs"
}

resource "aws_s3_bucket_acl" "logs" {
  bucket = aws_s3_bucket.logs.id
  acl    = "public-read"
}

resource "aws_security_group" "bastion" {
  name        = "bastion-ssh"
  description = "Acesso SSH ao bastion"
  vpc_id      = "vpc-0a1b2c3d4e5f67890"

  ingress {
    description = "SSH"
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
}
`;

export const API_DEPLOYMENT = `apiVersion: apps/v1
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
            privileged: true
`;

// ---------------------------------------------------------------- lessons
export const lessons: Lesson[] = [
  {
    id: "learn-devsecops-shift-left",
    track: "devsecops",
    title: "Shift-left e vulnerabilidades em imagens",
    summary: "CVE, CVSS, severidade, imagens base e como transformar um scanner num gate de CI.",
    minutes: 6,
    before: "devsecops-image-cves",
    blocks: [
      { type: "text", text: "**Shift-left** é mover a verificação de segurança para o começo do ciclo: no PR, no build, no pre-commit — e não num pentest trimestral depois do deploy. Corrigir uma CVE trocando a imagem base custa uma linha no Dockerfile; corrigir depois de um incidente custa uma semana." },
      { type: "flow", caption: "Onde cada controle entra na esteira", steps: [
        { label: "pre-commit", detail: "gitleaks protect" },
        { label: "PR / CI", detail: "trivy fs, checkov" },
        { label: "build", detail: "trivy image --exit-code 1" },
        { label: "registry", detail: "SBOM + cosign sign" },
        { label: "admission", detail: "verify / políticas" },
      ] },
      { type: "heading", text: "CVE, CVSS e severidade" },
      { type: "text", text: "Uma **CVE** identifica uma vulnerabilidade pública (ex.: `CVE-2022-37434` no zlib). O **CVSS** dá uma nota de 0 a 10 que o Trivy mapeia para `LOW`, `MEDIUM`, `HIGH` e `CRITICAL`. O scanner compara os pacotes instalados na imagem (dpkg/apk + lockfiles de linguagem) com bancos como NVD e os avisos de segurança de cada distro." },
      { type: "table", head: ["Status no Trivy", "Significado", "O que fazer"], rows: [
        ["fixed", "Existe versão corrigida do pacote", "Atualizar a imagem base / pacote"],
        ["affected", "Vulnerável e sem correção ainda", "Avaliar exposição, mitigar, monitorar"],
        ["will_not_fix", "A distro decidiu não corrigir", "Trocar de base ou aceitar com justificativa"],
      ] },
      { type: "heading", text: "A imagem base é a maior alavanca" },
      { type: "list", items: [
        "`node:14` (Debian 10, EOL) arrasta centenas de pacotes que sua aplicação nunca usa — e dezenas de CVEs.",
        "Variantes `-slim` e `-alpine` reduzem a superfície; imagens **distroless** removem até shell e gerenciador de pacotes.",
        "Menos pacotes = menos CVEs = menos ruído para triar.",
      ] },
      { type: "code", lang: "bash", caption: "Gate típico de CI: só quebra por CRITICAL que tenha correção", code: "trivy image --exit-code 1 --severity CRITICAL --ignore-unfixed registry.example.com/app:${GIT_SHA}" },
      { type: "callout", tone: "warn", text: "Sem `--exit-code 1` o trivy sempre sai com 0 — o relatório aparece, mas a pipeline passa. Um scanner que não pode falhar o build é só um log." },
      { type: "callout", tone: "tip", text: "Use `.trivyignore` (com comentário e data de revisão) para aceitar riscos conhecidos, em vez de relaxar o `--severity` do pipeline inteiro." },
    ],
    quiz: [
      { q: "Qual flag faz o trivy quebrar o pipeline quando encontra achados?", options: ["--severity CRITICAL", "--exit-code 1", "--ignore-unfixed", "-f json"], answer: 1, explain: "--severity e --ignore-unfixed só filtram o que conta; quem define o código de saída é --exit-code." },
      { q: "Uma CVE CRITICAL aparece com status will_not_fix na imagem node:20 (Debian). Qual a ação mais efetiva?", options: ["Esperar o próximo patch da distro", "Rodar apt-get upgrade no Dockerfile", "Trocar para uma base menor (alpine/distroless) sem o pacote vulnerável", "Aumentar o --severity para esconder"], answer: 2, explain: "will_not_fix significa que não virá correção; upgrade não resolve. Remover o pacote trocando de base elimina o risco." },
      { q: "Por que imagens distroless costumam ter menos CVEs?", options: ["São compiladas com flags de segurança", "Têm muito menos pacotes instalados (sem shell, sem apt)", "O Trivy não consegue escaneá-las", "Usam kernel próprio"], answer: 1, explain: "CVEs vêm de pacotes. Menos pacotes = menos superfície de ataque e menos achados. O Trivy escaneia distroless normalmente." },
    ],
  },
  {
    id: "learn-devsecops-secrets",
    track: "devsecops",
    title: "Segredos no código: detectar, rotacionar, prevenir",
    summary: "Por que apagar o segredo não basta, como o gitleaks funciona e onde colocar credenciais.",
    minutes: 6,
    before: "devsecops-secret-leak",
    blocks: [
      { type: "text", text: "Credenciais em repositório são uma das causas mais comuns de incidentes em cloud: bots varrem o GitHub público e usam uma chave `AKIA…` vazada em **minutos**. Em repositórios privados o risco continua — qualquer pessoa com acesso de leitura (ou um fork, ou um backup) tem a chave." },
      { type: "flow", caption: "Resposta a um segredo vazado — a ordem importa", steps: [
        { label: "Revogar/rotacionar", detail: "a chave antiga morre" },
        { label: "Investigar", detail: "CloudTrail / audit log" },
        { label: "Remover do código", detail: "env / secret manager" },
        { label: "Prevenir", detail: "pre-commit + CI" },
      ] },
      { type: "callout", tone: "warn", text: "Remover a linha e commitar **não** apaga o segredo: ele continua no histórico do git, em forks e em caches. A única correção real é **rotacionar** a credencial." },
      { type: "heading", text: "Como o gitleaks detecta" },
      { type: "list", items: [
        "Regras com regex específicas: `aws-access-token` (AKIA…), `github-pat` (ghp_…), `private-key` (-----BEGIN … PRIVATE KEY-----).",
        "Regra genérica (`generic-api-key`) para `password=`, `token:` etc., filtrada por **entropia** para evitar falsos positivos como `password=changeme`.",
        "`gitleaks detect` lê o histórico git; `--no-git` (ou `gitleaks dir`) lê só os arquivos atuais.",
      ] },
      { type: "code", lang: "toml", caption: ".gitleaks.toml: mantém as regras padrão e libera só fixtures", code: "[extend]\nuseDefault = true\n\n[allowlist]\ndescription = \"Credenciais falsas usadas em testes\"\npaths = ['''^test/fixtures/''']" },
      { type: "table", head: ["Onde guardar", "Quando usar"], rows: [
        ["IAM Role / IRSA / Workload Identity", "Acesso a APIs da cloud — sem chave nenhuma"],
        ["Secrets Manager / Vault / SSM", "Senhas de banco, tokens de terceiros"],
        ["Variável de ambiente injetada", "Runtime, vinda de um dos acima (nunca do repo)"],
        [".env local no .gitignore", "Só desenvolvimento, com valores de dev"],
      ] },
      { type: "callout", tone: "exam", text: "Em entrevistas de SRE/Security: a primeira resposta para \"vazou uma chave\" é **rotacionar**, não \"fazer git revert\"." },
    ],
    quiz: [
      { q: "Uma chave AWS foi commitada e o commit já foi para o remoto. Qual o primeiro passo?", options: ["git revert do commit", "Reescrever o histórico com git filter-repo", "Desativar/rotacionar a chave na AWS", "Adicionar o arquivo ao .gitignore"], answer: 2, explain: "Enquanto a chave estiver ativa, qualquer cópia do histórico serve para usá-la. Rotacionar primeiro; limpar histórico é opcional e vem depois." },
      { q: "Você criou um .gitleaks.toml só com [allowlist] e o gitleaks parou de achar tudo. Por quê?", options: ["O allowlist ficou amplo demais", "Sem [extend] useDefault = true as regras padrão não são carregadas", "O gitleaks ignora arquivos .js", "Faltou --verbose"], answer: 1, explain: "Um config customizado substitui o padrão. Sem [extend] useDefault = true não há nenhuma regra ativa." },
      { q: "Por que a regra genérica usa entropia?", options: ["Para acelerar o scan", "Para diferenciar segredos aleatórios de valores triviais como 'changeme'", "Para descobrir o tipo de chave", "Para validar a chave na API"], answer: 1, explain: "Segredos reais têm alta aleatoriedade; placeholders e nomes de variáveis não. A entropia reduz falsos positivos." },
    ],
  },
  {
    id: "learn-devsecops-policy-as-code",
    track: "devsecops",
    title: "Policy-as-code para IaC e Kubernetes",
    summary: "Checkov, trivy config e kubesec: regras que falham o PR antes de a infra existir.",
    minutes: 7,
    before: "devsecops-iac-checkov",
    blocks: [
      { type: "text", text: "Em IaC, a misconfiguration é escrita antes de existir: um `acl = \"public-read\"` ou um `0.0.0.0/0` na porta 22 está no `main.tf` muito antes do `terraform apply`. Scanners estáticos leem esse código e aplicam centenas de políticas — isso é **policy-as-code**." },
      { type: "table", head: ["Ferramenta", "Cobre", "IDs"], rows: [
        ["checkov", "Terraform, K8s, Dockerfile, CloudFormation, Helm…", "CKV_AWS_20, CKV_K8S_16, CKV_DOCKER_3"],
        ["trivy config", "Dockerfile, K8s, Terraform, Helm", "AVD-AWS-0107, KSV017, DS002"],
        ["kubesec", "Workloads K8s (score)", "Privileged, RunAsNonRoot…"],
      ] },
      { type: "heading", text: "Os achados que mais aparecem" },
      { type: "list", items: [
        "S3: ACL pública, sem `aws_s3_bucket_public_access_block`, sem criptografia (SSE-KMS), sem versionamento.",
        "Security Group: ingress `0.0.0.0/0` em 22/3389 — use VPN, SSM Session Manager ou CIDR corporativo.",
        "Pods: `privileged: true`, rodando como root, root filesystem gravável, capabilities padrão.",
      ] },
      { type: "code", lang: "hcl", caption: "Aceitar um risco com justificativa, no próprio recurso", code: "resource \"aws_s3_bucket\" \"logs\" {\n  #checkov:skip=CKV_AWS_18:bucket de destino dos access logs\n  bucket = \"danylo-app-logs\"\n}" },
      { type: "callout", tone: "tip", text: "Prefira o skip **inline com justificativa** a `--skip-check` na pipeline: o inline vale só para aquele recurso e passa por code review; o `--skip-check` desliga a regra para todo o repositório." },
      { type: "heading", text: "securityContext mínimo de um Pod" },
      { type: "code", lang: "yaml", code: "securityContext:\n  runAsNonRoot: true\n  runAsUser: 1000\n  allowPrivilegeEscalation: false\n  readOnlyRootFilesystem: true\n  capabilities:\n    drop: [\"ALL\"]" },
      { type: "callout", tone: "exam", text: "CKS: esses campos equivalem ao Pod Security Standard **restricted**. Com o label `pod-security.kubernetes.io/enforce=restricted` no namespace, o API server rejeita Pods que não os cumprem." },
    ],
    quiz: [
      { q: "O que o checkov faz quando encontra '#checkov:skip=CKV_AWS_18:motivo' dentro de um recurso?", options: ["Ignora o arquivo inteiro", "Marca o check como SKIPPED só para aquele recurso, mostrando o motivo", "Falha com erro de sintaxe", "Desativa CKV_AWS_18 em todos os recursos"], answer: 1, explain: "O skip inline é por recurso e aparece no relatório como SKIPPED com o comentário — auditável." },
      { q: "Qual combinação resolve CKV_AWS_24?", options: ["Adicionar description ao ingress", "Trocar 0.0.0.0/0 por um CIDR restrito na regra da porta 22", "Mudar protocol para udp", "Adicionar egress restrito"], answer: 1, explain: "CKV_AWS_24 verifica ingress de 0.0.0.0/0 na porta 22; restringir o CIDR (ou remover a regra e usar SSM) resolve." },
      { q: "readOnlyRootFilesystem: true quebrou a aplicação que escreve em /tmp. Melhor correção?", options: ["Voltar para false", "Montar um volume emptyDir em /tmp", "Rodar como root", "Adicionar a capability SYS_ADMIN"], answer: 1, explain: "Um emptyDir dá um diretório gravável e efêmero só onde é necessário, mantendo o resto do filesystem imutável." },
    ],
  },
  {
    id: "learn-devsecops-supply-chain",
    track: "devsecops",
    title: "Cadeia de suprimentos: SBOM e assinatura de imagens",
    summary: "O que é um SBOM, como o cosign assina por digest e onde a verificação acontece.",
    minutes: 6,
    before: "devsecops-supply-chain",
    blocks: [
      { type: "text", text: "Ataques de supply chain (SolarWinds, Codecov, xz-utils) não exploram sua aplicação — eles trocam **o que você executa**. Duas perguntas precisam de resposta verificável: *o que tem dentro desta imagem?* (SBOM) e *foi o meu CI que construiu esta imagem?* (assinatura)." },
      { type: "flow", caption: "Esteira com proveniência", steps: [
        { label: "build", detail: "digest sha256:…" },
        { label: "syft", detail: "SBOM spdx-json" },
        { label: "cosign sign", detail: "assinatura no registry" },
        { label: "cosign attest", detail: "SBOM assinado" },
        { label: "admission", detail: "verify antes de rodar" },
      ] },
      { type: "table", head: ["Conceito", "Para que serve"], rows: [
        ["SBOM (SPDX / CycloneDX)", "Inventário de pacotes e versões; responde \"estou afetado pela CVE X?\" em segundos"],
        ["Assinatura (cosign)", "Prova que o digest foi assinado por quem tem a chave privada"],
        ["Atestação (in-toto)", "Metadado assinado: SBOM, proveniência SLSA, resultado de scan"],
        ["Rekor (transparency log)", "Registro público e imutável de que a assinatura existiu"],
      ] },
      { type: "callout", tone: "warn", text: "Tags são mutáveis: `api:1.4.0` pode apontar para outra imagem amanhã. O cosign assina o **digest**; por isso avisa quando você passa uma tag, e o deploy seguro referencia `imagem@sha256:…`." },
      { type: "code", lang: "bash", code: "syft ghcr.io/danylo/api:1.4.0 -o spdx-json > sbom.json\ncosign generate-key-pair\ncosign sign --yes --key cosign.key ghcr.io/danylo/api:1.4.0\ncosign verify --key cosign.pub ghcr.io/danylo/api:1.4.0" },
      { type: "callout", tone: "tip", text: "Em produção, prefira **keyless** (OIDC do GitHub Actions/GitLab + Fulcio): não há chave privada para vazar. E verifique no cluster com Kyverno `verifyImages` ou o Sigstore policy-controller." },
    ],
    quiz: [
      { q: "Por que assinar pelo digest em vez da tag?", options: ["Digests são mais curtos", "A tag é mutável e pode passar a apontar para outra imagem", "Tags não são suportadas por registries OCI", "O digest criptografa a imagem"], answer: 1, explain: "O digest é o hash do conteúdo; qualquer alteração muda o digest. A tag é só um ponteiro que pode ser movido." },
      { q: "cosign verify retornou 'no signatures found' para api:1.4.1. O que isso indica?", options: ["A chave pública está corrompida", "Esse digest nunca foi assinado — não deve ser implantado", "O Rekor está fora do ar", "A imagem tem CVEs"], answer: 1, explain: "Não há assinatura para aquele digest. Uma política de admission bloquearia a imagem." },
      { q: "Qual a vantagem de ter o SBOM de cada imagem publicada?", options: ["Deixa a imagem menor", "Permite responder rapidamente quais imagens contêm um pacote vulnerável recém-divulgado", "Substitui o scan de vulnerabilidades", "Impede o uso de tags"], answer: 1, explain: "Com o inventário pronto (ex.: no Dependency-Track), um novo CVE vira uma consulta, não uma caça manual." },
    ],
  },
];

// ---------------------------------------------------------------- labs
export const labs: Lab[] = [
  // ================================================================ 1. image CVEs
  {
    id: "devsecops-image-cves",
    track: "devsecops",
    kind: "lab",
    title: "Scan de imagem e correção de CVEs",
    summary: "Encontre CVEs críticas na imagem base com Trivy, troque a base e crie um gate de CI.",
    level: "Intermediário",
    minutes: 15,
    skills: ["trivy image", "trivy config", "imagem base mínima", "security gate"],
    seed: { files: { Dockerfile: APP_DOCKERFILE, "package.json": PACKAGE_JSON, "package-lock.json": PACKAGE_LOCK, "server.js": SERVER_JS } },
    intro: "A orders-api ainda é construída sobre node:14 — uma base Debian 10 fora de suporte. O time de segurança pediu um relatório de CVEs e um gate no pipeline que impeça imagens com vulnerabilidades críticas de chegar a produção.",
    steps: [
      {
        title: "Escanear a imagem base atual",
        body: ["Veja no Dockerfile qual é a imagem base e escaneie-a com o Trivy, mostrando só HIGH e CRITICAL."],
        code: ["trivy image --severity HIGH,CRITICAL node:14"],
        hints: [
          "O Trivy compara os pacotes da imagem (SO e npm) com bancos de CVEs. A base está na linha FROM do Dockerfile.",
          "trivy image --severity <SEVERIDADES> <imagem>:<tag>",
          "trivy image --severity HIGH,CRITICAL node:14",
        ],
        explain: [
          "A node:14 roda sobre Debian 10 (EOL): o Trivy até avisa que a distro não recebe mais correções. Há CVEs CRITICAL no zlib, OpenSSL e libexpat, e também no npm embutido (minimist, semver).",
          "Repare na coluna Status: fixed tem correção, will_not_fix nunca terá. Atualizar pacotes um a um não escala — a alavanca é trocar a imagem base.",
        ],
        diagnose: (sh) => {
          const r = lastTrivyRun(sh, "image");
          if (r && r.target !== "node:14") return `Você escaneou ${r.target}. Este passo pede a base atual do Dockerfile: node:14.`;
          return null;
        },
        check: (sh) => trivyState(sh).runs.some((r) => r.mode === "image" && r.target === "node:14"),
      },
      {
        title: "Trocar a imagem base",
        body: ["Edite o Dockerfile (vi Dockerfile) e troque a base por uma imagem suportada e mínima, sem vulnerabilidades HIGH/CRITICAL: node:20-alpine."],
        code: ["vi Dockerfile"],
        hints: [
          "Variantes -alpine têm poucos pacotes e recebem correções rápido. Node 20 é LTS.",
          "No vi, troque a primeira linha para FROM <imagem>:<tag> e salve com :wq.",
          "vi Dockerfile — troque a linha 1 por FROM node:20-alpine",
        ],
        explain: [
          "Com a base alpine, a imagem cai de ~900 MB para ~130 MB e de dezenas de CVEs para um LOW. Menos pacotes = menos superfície de ataque e menos ruído de triagem.",
          "Em produção, fixe também o digest (FROM node:20-alpine@sha256:…) e deixe o Renovate/Dependabot abrir PRs de atualização da base.",
        ],
        diagnose: (sh) => {
          const b = baseOf(sh);
          if (!b) return "O Dockerfile ficou sem linha FROM. A primeira instrução deve ser FROM node:20-alpine.";
          if (b === "node:14") return "O Dockerfile ainda usa FROM node:14. Abra com vi Dockerfile e troque a base.";
          if (/:latest$|^[^:@]+$/.test(b)) return `${b} usa a tag latest (implícita ou explícita): o build deixa de ser reproduzível. Use uma tag fixa, ex.: node:20-alpine.`;
          const v = highCrit(b);
          if (!v) return `A imagem ${b} não existe no registry deste lab. Use node:20-alpine.`;
          if (v.length) return `${b} ainda tem ${v.length} vulnerabilidades HIGH/CRITICAL (a base Debian traz CVEs sem correção). Use uma variante mínima: node:20-alpine.`;
          return null;
        },
        check: (sh) => baseIsClean(sh),
      },
      {
        title: "Procurar misconfigurations no Dockerfile",
        body: ["CVE não é o único risco. Rode o scanner de configuração do Trivy no diretório do projeto e veja o que ele aponta no Dockerfile."],
        code: ["trivy config ."],
        hints: [
          "trivy config procura más práticas em Dockerfile, YAML de Kubernetes e Terraform — não CVEs.",
          "trivy config <diretório>",
          "trivy config .",
        ],
        explain: [
          "O achado HIGH é o AVD-DS-0002: nenhuma instrução USER, então o processo roda como root dentro do container. Se alguém explorar a aplicação, ganha root no container — metade do caminho para um container escape.",
          "O LOW AVD-DS-0026 (sem HEALTHCHECK) é recomendação; em Kubernetes os probes cumprem esse papel.",
        ],
        check: (sh) => trivyState(sh).runs.some((r) => (r.mode === "config" || (r.mode === "fs" && r.misconfigIds.length > 0)) && r.target === PROJECT),
      },
      {
        title: "Rodar como usuário não-root",
        body: ["Adicione uma instrução USER ao Dockerfile antes do CMD. A imagem oficial do Node já traz o usuário node (UID 1000)."],
        code: ["vi Dockerfile"],
        hints: [
          "A instrução USER define com qual usuário as instruções seguintes e o processo final rodam.",
          "Adicione USER <usuário> antes do CMD e salve.",
          "vi Dockerfile — adicione a linha USER node antes do CMD",
        ],
        explain: [
          "Com USER node o processo roda com UID 1000. Combinado com runAsNonRoot no Kubernetes, o kubelet se recusa a subir o container se alguém voltar a imagem para root.",
          "Se a aplicação precisar escutar na porta 80, prefira uma porta alta (3000/8080) em vez de voltar para root ou adicionar NET_BIND_SERVICE.",
        ],
        diagnose: (sh) => {
          const df = file(sh, "Dockerfile") ?? "";
          if (/^\s*USER\s+(root|0)\b/im.test(df)) return "USER root não resolve: o último USER precisa ser um usuário sem privilégio, ex.: USER node.";
          if (!baseIsClean(sh)) return "A base voltou a ser uma imagem com CVEs HIGH/CRITICAL. Mantenha FROM node:20-alpine.";
          return null;
        },
        check: (sh) => baseIsClean(sh) && !dockerfileMisconfigs(file(sh, "Dockerfile") ?? "").some((m) => m.id === "AVD-DS-0002"),
      },
      {
        title: "Criar o gate de CI",
        body: [
          "No pipeline, o scan precisa falhar o build quando houver vulnerabilidade crítica. Rode o trivy contra a nova base com --exit-code 1 e --severity CRITICAL e confirme que ele passa.",
        ],
        code: ["trivy image --exit-code 1 --severity CRITICAL node:20-alpine"],
        hints: [
          "Por padrão o trivy sempre sai com 0. --exit-code define o código quando há achados, e --severity define o que conta.",
          "trivy image --exit-code 1 --severity CRITICAL <nova-base>",
          "trivy image --exit-code 1 --severity CRITICAL node:20-alpine",
        ],
        explain: [
          "Total: 0 (CRITICAL: 0) e código de saída 0 — o gate passa. Se alguém voltar para node:14, o mesmo comando sai com 1 e o job falha antes do push da imagem.",
          "Em times maduros o gate costuma ser CRITICAL com --ignore-unfixed (não bloqueia o que ninguém consegue corrigir), e HIGH vira ticket com SLA. Riscos aceitos vão para o .trivyignore com justificativa.",
        ],
        diagnose: (sh) => {
          const r = lastTrivyRun(sh, "image");
          if (!r) return null;
          if (!r.exitCode) return "O scan rodou, mas sem --exit-code 1 ele nunca falha o pipeline. Adicione --exit-code 1.";
          if (r.target === "node:14" && r.gateFailed) return "Isso! O gate barra a node:14 (saiu com código 1). Agora rode o mesmo gate contra a base nova, node:20-alpine.";
          if (r.target !== parseRef(baseOf(sh) ?? "").full) return `Escaneie a base que está no Dockerfile (${baseOf(sh)}).`;
          if (!r.severities.includes("CRITICAL")) return "O gate precisa incluir a severidade CRITICAL.";
          return null;
        },
        check: (sh) =>
          trivyState(sh).runs.some((r) => r.mode === "image" && r.exitCode !== 0 && r.severities.includes("CRITICAL") && !r.gateFailed && r.target === parseRef(baseOf(sh) ?? "x").full && baseIsClean(sh)),
      },
    ],
    outro: "Você reduziu a superfície de ataque trocando a base, removeu o root do container e criou um gate reproduzível. Próximo: segredos que escapam para o repositório.",
  },

  // ================================================================ 2. leaked secrets
  {
    id: "devsecops-secret-leak",
    track: "devsecops",
    kind: "challenge",
    title: "Desafio: segredo vazado no repositório",
    summary: "Ache chaves AWS e tokens com Gitleaks, tire-os do código, libere só a fixture de teste e deixe o scan limpo.",
    level: "Intermediário",
    minutes: 15,
    skills: ["gitleaks", "rotação de credenciais", ".gitignore", "allowlist"],
    seed: {
      files: {
        "src/config.js": LEAKY_CONFIG,
        ".env": LEAKY_ENV,
        ".env.example": "NODE_ENV=development\nDB_HOST=localhost\nDB_PASSWORD=\nGITHUB_TOKEN=\n",
        ".gitignore": "node_modules/\ncoverage/\n",
        "test/fixtures/fake-aws.json": FIXTURE,
        "package.json": PACKAGE_JSON,
      },
    },
    intro: "Um alerta do GitHub Secret Scanning chegou às 3h da manhã: há credenciais no repositório da orders-api. As chaves já foram revogadas no IAM pelo time de plantão — sua missão agora é limpar o código e deixar o gitleaks verde, sem perder a fixture de teste que usa uma chave falsa.",
    steps: [
      {
        title: "Varrer o projeto",
        body: ["Rode o gitleaks no diretório atual em modo verbose. O projeto não é um repositório git neste ambiente, então escaneie os arquivos diretamente."],
        code: ["gitleaks detect --source . -v --no-git"],
        hints: [
          "Sem flags, gitleaks detect tenta ler o histórico do git. Há uma flag para escanear só os arquivos.",
          "gitleaks detect --source <dir> -v --no-git",
          "gitleaks detect --source . -v --no-git",
        ],
        explain: [
          "5 achados: chave AWS e secret key em src/config.js, senha do banco e token do GitHub no .env, e uma chave AKIA… em test/fixtures — essa última é falsa, usada em teste.",
          "O gitleaks saiu com código 1 (leaks found): num pre-commit hook ou no CI isso bloquearia o commit. Em repositórios git reais, rode sem --no-git para varrer também o histórico.",
        ],
        diagnose: (sh) => (sh.entries.some((e) => /^gitleaks/.test(e.cmd) && /not a git repository/.test(e.output)) ? "Este diretório não é um repositório git — adicione --no-git para escanear os arquivos." : null),
        check: (sh) => (lastGitleaksRun(sh)?.leaks.length ?? 0) > 0,
      },
      {
        title: "Tirar as credenciais do código",
        body: [
          "Edite src/config.js (vi src/config.js) e troque os valores literais por variáveis de ambiente: process.env.AWS_ACCESS_KEY_ID e process.env.AWS_SECRET_ACCESS_KEY.",
          "Em produção, a aplicação na AWS nem precisaria de chave: usaria a IAM Role do Pod (IRSA) — o SDK lê as credenciais sozinho.",
        ],
        code: ["vi src/config.js"],
        hints: [
          "Código não deve conter segredo nenhum — só a referência de onde ele vem em runtime.",
          "awsAccessKeyId: process.env.<VAR>, awsSecretAccessKey: process.env.<VAR>",
          "vi src/config.js — troque os dois valores por process.env.AWS_ACCESS_KEY_ID e process.env.AWS_SECRET_ACCESS_KEY",
        ],
        explain: [
          "O arquivo agora só referencia variáveis. Os valores vêm do ambiente (injetados de um Secrets Manager/External Secrets) e podem ser rotacionados sem novo deploy do código.",
          "Lembre: a chave antiga continua no histórico do git. Por isso a revogação no IAM foi o passo 0 — limpar o arquivo só impede novos vazamentos.",
        ],
        diagnose: (sh) => {
          const c = file(sh, "src/config.js");
          if (c === undefined) return "Não apague o src/config.js — a aplicação precisa dele. Só troque os valores por process.env.…";
          const s = findSecrets(c);
          if (s.length) return `Ainda há ${s.length} segredo(s) em src/config.js (linha ${s[0].line}). Use process.env.NOME_DA_VARIAVEL no lugar do valor.`;
          if (!/process\.env/.test(c)) return "Os valores sumiram, mas a config precisa ler de algum lugar: use process.env.AWS_ACCESS_KEY_ID e process.env.AWS_SECRET_ACCESS_KEY.";
          return null;
        },
        check: (sh) => {
          const c = file(sh, "src/config.js");
          return !!c && findSecrets(c).length === 0 && /process\.env/.test(c);
        },
      },
      {
        title: "Tirar o .env do repositório",
        body: ["O .env com valores reais não pode ser versionado. Adicione .env ao .gitignore e remova o arquivo do projeto (o .env.example, sem valores, continua como documentação)."],
        code: ["echo \".env\" >> .gitignore"],
        hints: [
          "Dois movimentos: impedir que ele volte (gitignore) e tirá-lo do projeto.",
          "echo \"<padrão>\" >> .gitignore e depois rm <arquivo>",
          "echo \".env\" >> .gitignore && rm .env",
        ],
        explain: [
          ".env no .gitignore evita o erro mais comum de todos: git add . levando credenciais locais. O .env.example documenta quais variáveis existem sem expor valores.",
          "Num repositório git, rode também git rm --cached .env se ele já tinha sido commitado — o .gitignore não remove arquivos já rastreados.",
        ],
        diagnose: (sh) => {
          const gi = file(sh, ".gitignore") ?? "";
          const env = file(sh, ".env");
          if (!/^\.env\s*$/m.test(gi) && !/^\.env\*?\s*$/m.test(gi)) return "O .gitignore ainda não tem a linha .env. Use echo \".env\" >> .gitignore (>> acrescenta; > sobrescreveria o arquivo).";
          if (!/node_modules/.test(gi)) return "Cuidado: o .gitignore perdeu o node_modules/ — você usou > em vez de >>? Recoloque as linhas originais.";
          if (env !== undefined && findSecrets(env).length) return "O .env com as credenciais ainda está no projeto. Remova com rm .env.";
          return null;
        },
        check: (sh) => {
          const gi = file(sh, ".gitignore") ?? "";
          const env = file(sh, ".env");
          return /^\.env\*?\s*$/m.test(gi) && /node_modules/.test(gi) && (env === undefined || findSecrets(env).length === 0);
        },
      },
      {
        title: "Liberar só a fixture de teste",
        body: [
          "A chave em test/fixtures/fake-aws.json é falsa e os testes precisam dela. Crie um .gitleaks.toml (vi .gitleaks.toml) que mantenha as regras padrão e adicione um allowlist apenas para o caminho test/fixtures/.",
        ],
        code: ["vi .gitleaks.toml"],
        hints: [
          "Um config próprio substitui o padrão — use [extend] useDefault = true para herdar as regras. Depois, [allowlist] com paths (regex).",
          "[extend] useDefault = true  +  [allowlist] paths = ['''<regex-do-diretório>''']",
          "vi .gitleaks.toml — [extend] useDefault = true e [allowlist] paths = ['''^test/fixtures/''']",
        ],
        explain: [
          "O allowlist por caminho é cirúrgico: só a pasta de fixtures é ignorada, e o motivo fica versionado em code review. Um allowlist por regex genérico (.*) ou por arquivo de código esconderia vazamentos reais.",
          "Para casos pontuais numa linha de código, o gitleaks também aceita o comentário gitleaks:allow no fim da linha.",
        ],
        diagnose: (sh) => {
          const raw = file(sh, ".gitleaks.toml");
          if (raw === undefined) return "Crie o arquivo .gitleaks.toml na raiz do projeto com vi .gitleaks.toml.";
          const cfg = loadLeaksConfig(sh, PROJECT);
          if (cfg.error) return `O TOML tem erro de sintaxe: ${cfg.error}`;
          if (!cfg.useDefault) return "Falta [extend] com useDefault = true: sem isso o gitleaks desliga todas as regras padrão e não detecta mais nada.";
          const paths = cfg.allowlists.flatMap((a) => a.paths);
          if (!paths.some((re) => re.test("test/fixtures/fake-aws.json"))) return "O allowlist ainda não cobre test/fixtures/fake-aws.json. Use paths = ['''^test/fixtures/'''].";
          if (paths.some((re) => re.test("src/config.js") || re.test(".env") || re.test("src/app.js"))) return "O allowlist está amplo demais (cobre código de produção). Restrinja ao diretório test/fixtures/.";
          return null;
        },
        check: (sh) => {
          if (file(sh, ".gitleaks.toml") === undefined) return false;
          const cfg = loadLeaksConfig(sh, PROJECT);
          const paths = cfg.allowlists.flatMap((a) => a.paths);
          return !cfg.error && cfg.useDefault && paths.some((re) => re.test("test/fixtures/fake-aws.json")) && !paths.some((re) => re.test("src/config.js") || re.test(".env") || re.test("src/app.js"));
        },
      },
      {
        title: "Scan limpo",
        body: ["Rode o gitleaks de novo. O resultado esperado é no leaks found — e só porque os segredos saíram, não porque as regras foram desligadas."],
        code: ["gitleaks detect --source . -v --no-git"],
        hints: [
          "Mesmo comando do primeiro passo — agora o .gitleaks.toml é carregado automaticamente.",
          "gitleaks detect --source . -v --no-git",
          "gitleaks detect --source . -v --no-git",
        ],
        explain: [
          "no leaks found com as regras padrão ativas. Coloque o mesmo comando num pre-commit hook (gitleaks protect --staged) e no CI para que isso não se repita.",
          "Checklist de incidente: 1) revogar/rotacionar (feito pelo plantão), 2) checar CloudTrail pelo uso da chave, 3) remover do código, 4) prevenir com hook + CI, 5) postmortem sem culpados.",
        ],
        diagnose: (sh) => {
          const r = lastGitleaksRun(sh);
          if (r && r.leaks.length) return `Ainda há ${r.leaks.length} achado(s): ${r.leaks.map((l) => `${l.file}:${l.line}`).join(", ")}.`;
          if (r && !r.useDefault) return "O scan passou, mas sem as regras padrão — confira o [extend] useDefault = true.";
          return null;
        },
        check: (sh) => {
          const r = lastGitleaksRun(sh);
          return !!r && r.leaks.length === 0 && r.useDefault && r.allowlisted > 0;
        },
      },
    ],
    outro: "Repositório limpo, fixture preservada e regras padrão ativas. O ponto que mais cai em entrevista: remover do código não desfaz o vazamento — rotacionar sim.",
  },

  // ================================================================ 3. IaC with checkov
  {
    id: "devsecops-iac-checkov",
    track: "devsecops",
    kind: "lab",
    title: "Segurança de IaC com Checkov",
    summary: "Encontre um bucket S3 público e SSH aberto para a internet no Terraform e corrija até o Checkov passar.",
    level: "Intermediário",
    minutes: 20,
    skills: ["checkov", "S3 hardening", "security groups", "checkov:skip"],
    seed: { files: { "main.tf": MAIN_TF } },
    intro: "Um PR de Terraform cria o bucket de logs da aplicação e um security group para o bastion. Antes do terraform apply, o pipeline roda Checkov — e ele não está feliz.",
    steps: [
      {
        title: "Rodar o Checkov",
        body: ["Escaneie o diretório atual com o Checkov e leia os checks que falharam."],
        code: ["checkov -d ."],
        hints: [
          "O Checkov descobre sozinho os frameworks (Terraform, Kubernetes, Dockerfile) a partir dos arquivos.",
          "checkov -d <diretório>",
          "checkov -d .",
        ],
        explain: [
          "7 falhas: o bucket aceita leitura pública (CKV_AWS_20), não tem public access block (CKV2_AWS_6), criptografia (CKV_AWS_19/145), versionamento (CKV_AWS_21) nem access logging (CKV_AWS_18); e o SG libera SSH para 0.0.0.0/0 (CKV_AWS_24).",
          "Cada check traz o recurso, o intervalo de linhas e o Guide com a correção. O Checkov saiu com código 1: no CI, o merge fica bloqueado.",
        ],
        check: (sh) => (lastCheckovRun(sh)?.failed ?? 0) > 0,
      },
      {
        title: "Fechar o bucket S3",
        body: [
          "Edite main.tf (vi main.tf): remova o aws_s3_bucket_acl público e adicione, para o bucket logs:",
          "aws_s3_bucket_public_access_block com os 4 bloqueios em true; aws_s3_bucket_versioning com status Enabled; aws_s3_bucket_server_side_encryption_configuration com sse_algorithm = \"aws:kms\" (crie um aws_kms_key).",
        ],
        code: ["vi main.tf"],
        hints: [
          "No provider AWS v5, cada configuração do bucket é um recurso separado que referencia bucket = aws_s3_bucket.logs.id.",
          "resource \"aws_s3_bucket_public_access_block\" \"logs\" { bucket = aws_s3_bucket.logs.id  block_public_acls = true … } — idem para versioning e server_side_encryption_configuration",
          "vi main.tf — apague o aws_s3_bucket_acl e adicione public_access_block, versioning (Enabled) e SSE aws:kms",
        ],
        explain: [
          "O public access block é o cinto de segurança do S3: mesmo que alguém aplique uma ACL ou policy pública depois, a AWS ignora. SSE-KMS com chave própria dá controle de rotação e auditoria de uso no CloudTrail.",
          "Versionamento protege contra deleção acidental e ransomware; em buckets de log, combine com lifecycle para expirar versões antigas.",
        ],
        diagnose: (sh) => {
          const scan = checkovScan(sh, PROJECT, { frameworks: ["terraform"] });
          if (scan.parseErrors.length) return `O main.tf tem erro de sintaxe: ${scan.parseErrors[0]}`;
          const f = s3Failures(sh);
          return f.length ? `Ainda falham: ${[...new Set(f.map((r) => r.id))].join(", ")} (${f[0].name}).` : null;
        },
        check: (sh) => {
          const scan = checkovScan(sh, PROJECT, { frameworks: ["terraform"] });
          return !scan.parseErrors.length && scan.records.some((r) => r.resource === "aws_s3_bucket.logs") && s3Failures(sh).length === 0;
        },
      },
      {
        title: "Tirar o SSH da internet",
        body: ["O security group do bastion aceita SSH de 0.0.0.0/0. Restrinja o ingress da porta 22 à rede interna 10.0.0.0/16 (ou a VPN corporativa)."],
        code: ["vi main.tf"],
        hints: [
          "A regra problemática é o bloco ingress com cidr_blocks = [\"0.0.0.0/0\"].",
          "cidr_blocks = [\"<CIDR interno>\"]",
          "vi main.tf — troque cidr_blocks = [\"0.0.0.0/0\"] por [\"10.0.0.0/16\"] no ingress da porta 22",
        ],
        explain: [
          "SSH aberto para a internet recebe tentativas de brute force em minutos. Com o CIDR interno, só quem está na VPC/VPN alcança o bastion.",
          "Melhor ainda: elimine o bastion e a porta 22 usando AWS SSM Session Manager — acesso auditado, sem chave SSH e sem ingress nenhum.",
        ],
        diagnose: (sh) => {
          const r = checkovScan(sh, PROJECT, { checks: ["CKV_AWS_24"] }).records;
          if (!r.length) return "Não encontrei mais o aws_security_group.bastion — corrija a regra, não apague o recurso.";
          return null;
        },
        check: (sh) => {
          const r = checkovScan(sh, PROJECT, { checks: ["CKV_AWS_24"] }).records;
          return r.length > 0 && r.every((x) => x.result === "PASSED");
        },
      },
      {
        title: "Justificar a exceção de logging",
        body: [
          "CKV_AWS_18 pede access logging no bucket — mas este é o próprio bucket de destino dos logs; logar nele mesmo criaria um loop. Aceite o risco com um comentário inline dentro do resource aws_s3_bucket.logs:",
          "#checkov:skip=CKV_AWS_18:<justificativa>",
        ],
        code: ["vi main.tf"],
        hints: [
          "O skip inline vale só para aquele recurso e deixa a justificativa no código, visível no review.",
          "Dentro do bloco resource \"aws_s3_bucket\" \"logs\" { … } adicione #checkov:skip=CKV_AWS_18:<motivo>",
          "vi main.tf — adicione #checkov:skip=CKV_AWS_18:bucket de destino dos access logs dentro do aws_s3_bucket.logs",
        ],
        explain: [
          "O Checkov passa a reportar CKV_AWS_18 como SKIPPED com o seu comentário. Auditores e revisores veem a decisão e o motivo.",
          "Evite --skip-check CKV_AWS_18 no pipeline: ele desliga a regra para todos os buckets do repositório, inclusive os que deveriam ter logging.",
        ],
        diagnose: (sh) => {
          const tf = file(sh, "main.tf") ?? "";
          if (/checkov:skip=CKV_AWS_18\s*$/m.test(tf) || /checkov:skip=CKV_AWS_18:\s*$/m.test(tf)) return "O skip precisa de justificativa depois do segundo dois-pontos: #checkov:skip=CKV_AWS_18:motivo.";
          if (/checkov:skip=CKV_AWS_18/.test(tf)) return "O comentário precisa ficar DENTRO do bloco resource \"aws_s3_bucket\" \"logs\" { … }.";
          return null;
        },
        check: (sh) => {
          const r = checkovScan(sh, PROJECT, { checks: ["CKV_AWS_18"] }).records;
          return r.length > 0 && r.every((x) => x.result === "PASSED" || (x.result === "SKIPPED" && x.suppress !== "No comment provided"));
        },
      },
      {
        title: "Pipeline verde",
        body: ["Rode o Checkov de novo, sem --skip-check, e confirme Failed checks: 0."],
        code: ["checkov -d ."],
        hints: ["Mesmo comando do primeiro passo.", "checkov -d <diretório>", "checkov -d ."],
        explain: [
          "Failed checks: 0, com um SKIPPED justificado. O PR pode seguir para o terraform plan.",
          "Em CI, rode checkov -d . --compact (ou -o sarif para o GitHub Code Scanning). Para o plan real, checkov -f tfplan.json também avalia valores calculados.",
        ],
        diagnose: (sh) => {
          const r = lastCheckovRun(sh);
          if (r?.skipChecks.length) return "Rode sem --skip-check: a exceção já está documentada no código.";
          if (r && r.failed) return `Ainda há ${r.failed} falha(s): ${r.failedIds.join(", ")}.`;
          return null;
        },
        check: (sh) => {
          const r = lastCheckovRun(sh);
          return !!r && r.failed === 0 && r.passed > 0 && r.skipChecks.length === 0 && r.frameworks.includes("terraform");
        },
      },
    ],
    outro: "Você transformou um PR inseguro num código que passa na política — com a única exceção documentada. Esse é o ciclo diário de policy-as-code.",
  },

  // ================================================================ 4. pod hardening
  {
    id: "devsecops-k8s-pod-hardening",
    track: "devsecops",
    kind: "lab",
    title: "Hardening de Pod no Kubernetes",
    summary: "Um Deployment roda como root e privilegiado. Prove o risco, escaneie, corrija o securityContext e verifique no cluster.",
    level: "Avançado",
    minutes: 20,
    skills: ["securityContext", "kubesec", "trivy config", "Pod Security Standards"],
    seed: {
      files: { "k8s/deployment.yaml": API_DEPLOYMENT },
      setup: (sh) => {
        const doc: Json = YAML.parse(API_DEPLOYMENT);
        createDeployment(sh, {
          name: "api",
          replicas: 1,
          labels: { app: "api" },
          template: { labels: { ...doc.spec.template.metadata.labels }, spec: structuredClone(doc.spec.template.spec) },
          createdAt: Date.now() - 3 * 3600 * 1000,
        });
      },
    },
    intro: "A api está rodando em produção com privileged: true — alguém copiou esse trecho de um DaemonSet de monitoramento. Um container privilegiado e root equivale a root no nó. Vamos provar, corrigir e validar.",
    steps: [
      {
        title: "Provar que o container roda como root",
        body: ["Execute id dentro do container do Deployment api."],
        code: ["kubectl exec deploy/api -- id"],
        hints: [
          "kubectl exec roda um comando dentro de um container em execução; tudo depois de -- é o comando.",
          "kubectl exec deploy/<nome> -- <comando>",
          "kubectl exec deploy/api -- id",
        ],
        explain: [
          "uid=0(root). Somado a privileged: true, o processo tem todas as capabilities e acesso aos devices do nó — um RCE na aplicação vira controle do nó.",
          "Por padrão, containers rodam com o usuário da imagem (muitas vezes root). O securityContext é quem impõe limites.",
        ],
        check: (sh) => entriesMatching(sh, /kubectl exec .*\bid\b/, /uid=0\(root\)/),
      },
      {
        title: "Escanear o manifesto",
        body: ["Dê uma nota de risco ao manifesto com o kubesec (ou use trivy config k8s/)."],
        code: ["kubesec scan k8s/deployment.yaml"],
        hints: [
          "Scanners estáticos leem o YAML antes do apply — o ideal é rodar no PR.",
          "kubesec scan <arquivo.yaml>",
          "kubesec scan k8s/deployment.yaml",
        ],
        explain: [
          "Score -30: Privileged é crítico. Em advise aparecem os pontos que faltam: RunAsNonRoot, ReadOnlyRootFilesystem, CapDropAll…",
          "trivy config k8s/ mostra a mesma coisa como KSV017 (privileged), KSV012 (root), KSV014 (fs gravável), KSV001 (privilege escalation) e KSV003 (capabilities).",
        ],
        check: (sh) => sh.flags.has(`sec:config-scanned:${P("k8s/deployment.yaml")}`),
      },
      {
        title: "Corrigir o securityContext",
        body: [
          "Edite k8s/deployment.yaml (vi k8s/deployment.yaml). No securityContext do container: remova privileged, e defina runAsNonRoot: true, runAsUser: 1000, allowPrivilegeEscalation: false, readOnlyRootFilesystem: true e capabilities.drop: [\"ALL\"].",
        ],
        code: ["vi k8s/deployment.yaml"],
        hints: [
          "Esses campos são o Pod Security Standard restricted: sem root, sem escalada, sem capabilities, fs imutável.",
          "securityContext: { runAsNonRoot: true, runAsUser: <uid>, allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: [\"ALL\"] } }",
          "vi k8s/deployment.yaml — troque privileged: true pelos 5 campos do securityContext restrito",
        ],
        explain: [
          "Cada campo fecha uma porta: runAsNonRoot/runAsUser tiram o root, allowPrivilegeEscalation impede setuid/sudo, drop ALL remove capabilities do kernel e readOnlyRootFilesystem impede que um invasor grave binários.",
          "Se a app precisar escrever em /tmp, monte um emptyDir ali em vez de liberar o filesystem inteiro.",
        ],
        diagnose: (sh) => {
          const miss = missingHardening(file(sh, "k8s/deployment.yaml"));
          return miss.length ? `Ainda falta: ${miss.join("; ")}.` : null;
        },
        check: (sh) => missingHardening(file(sh, "k8s/deployment.yaml")).length === 0,
      },
      {
        title: "Aplicar no cluster",
        body: ["Aplique o manifesto e espere o novo Pod ficar Running."],
        code: ["kubectl apply -f k8s/deployment.yaml"],
        hints: [
          "Mudar o template dispara um rollout: o Pod antigo é substituído.",
          "kubectl apply -f <arquivo>",
          "kubectl apply -f k8s/deployment.yaml",
        ],
        explain: [
          "O Deployment ganhou uma nova revisão e o Pod foi recriado com o securityContext restrito.",
          "Para impedir regressões, rotule o namespace com pod-security.kubernetes.io/enforce=restricted: o API server passa a recusar Pods privilegiados ou root.",
        ],
        diagnose: (sh) => {
          const d = findDeployment(sh, "api");
          if (!d) return "O Deployment api sumiu. Rode kubectl apply -f k8s/deployment.yaml.";
          const sc = d.template.spec.containers[0]?.securityContext ?? {};
          if (sc.privileged === true) return "O cluster ainda roda a versão privilegiada. Aplique o arquivo corrigido com kubectl apply -f k8s/deployment.yaml.";
          return null;
        },
        check: (sh) => {
          const d = findDeployment(sh, "api");
          if (!d) return false;
          const yaml = YAML.stringify({ apiVersion: "apps/v1", kind: "Deployment", metadata: { name: "api" }, spec: { template: { spec: d.template.spec } } });
          return missingHardening(yaml).length === 0 && sh.deploymentReady("api");
        },
      },
      {
        title: "Verificar no container",
        body: ["Rode id de novo no container e tente criar um arquivo na raiz com touch /x. O primeiro deve mostrar UID 1000; o segundo deve falhar com Read-only file system."],
        code: ["kubectl exec deploy/api -- id", "kubectl exec deploy/api -- touch /x"],
        hints: [
          "Valide o efeito real, não só o YAML: o que o processo consegue fazer dentro do container?",
          "kubectl exec deploy/api -- <comando> — rode id e depois touch /x",
          "kubectl exec deploy/api -- id && kubectl exec deploy/api -- touch /x",
        ],
        explain: [
          "uid=1000 e Read-only file system: o processo não é root e não consegue alterar a imagem em runtime. O touch falhando é o resultado esperado.",
          "Esse tipo de verificação (teste negativo) é ótimo como smoke test pós-deploy ou como política no admission controller.",
        ],
        diagnose: (sh) => {
          const idOk = entriesMatching(sh, /kubectl exec .*\bid\b/, /uid=[1-9]\d*/);
          const roOk = entriesMatching(sh, /kubectl exec .*touch/, /Read-only file system/);
          if (!idOk) return "Rode kubectl exec deploy/api -- id e confira que o uid não é 0.";
          if (!roOk) return "Agora tente escrever na raiz: kubectl exec deploy/api -- touch /x (deve falhar).";
          return null;
        },
        check: (sh) => entriesMatching(sh, /kubectl exec .*\bid\b/, /uid=[1-9]\d*/) && entriesMatching(sh, /kubectl exec .*touch/, /Read-only file system/),
      },
    ],
    outro: "Você provou o risco, corrigiu e validou o efeito real no container. Esse securityContext deveria ser o padrão de todo Deployment — um bom candidato para um template Helm da empresa.",
  },

  // ================================================================ 5. supply chain
  {
    id: "devsecops-supply-chain",
    track: "devsecops",
    kind: "lab",
    title: "Supply chain: SBOM e assinatura com Cosign",
    summary: "Gere o SBOM da imagem, crie um par de chaves, assine, verifique e veja uma imagem não assinada ser rejeitada.",
    level: "Avançado",
    minutes: 15,
    skills: ["syft", "SBOM", "cosign sign", "cosign verify"],
    seed: { files: { "README.md": "# Release 1.4.0\nImagem: ghcr.io/danylo/api:1.4.0\n" } },
    intro: "A release 1.4.0 da api foi publicada em ghcr.io/danylo/api:1.4.0. A política nova exige que toda imagem em produção tenha SBOM e assinatura verificável. Um job suspeito publicou também a tag 1.4.1 fora do pipeline.",
    steps: [
      {
        title: "Gerar o SBOM",
        body: ["Gere o SBOM da imagem no formato SPDX JSON e salve em sbom.json."],
        code: ["syft ghcr.io/danylo/api:1.4.0 -o spdx-json > sbom.json"],
        hints: [
          "O syft cataloga todos os pacotes (apk, npm…) da imagem. SPDX e CycloneDX são os formatos padrão.",
          "syft <imagem> -o <formato> > <arquivo>",
          "syft ghcr.io/danylo/api:1.4.0 -o spdx-json > sbom.json",
        ],
        explain: [
          "sbom.json lista cada pacote com versão e purl (pkg:apk/…, pkg:npm/…). Quando sair o próximo CVE famoso, você responde \"estamos afetados?\" com uma busca — ou com trivy sbom sbom.json.",
          "Publique o SBOM junto da imagem (cosign attest) ou num Dependency-Track para acompanhar o inventário de todas as imagens.",
        ],
        diagnose: (sh) => {
          const raw = file(sh, "sbom.json");
          if (raw === undefined) return null;
          if (!/spdxVersion/.test(raw)) return "O sbom.json não está em SPDX. Use -o spdx-json.";
          return null;
        },
        check: (sh) => {
          try {
            const j = JSON.parse(file(sh, "sbom.json") ?? "");
            return !!j.spdxVersion && Array.isArray(j.packages) && j.packages.length > 0 && /danylo\/api/.test(j.name);
          } catch {
            return false;
          }
        },
      },
      {
        title: "Criar o par de chaves",
        body: ["Gere um par de chaves do cosign no diretório atual."],
        code: ["cosign generate-key-pair"],
        hints: [
          "O cosign gera uma chave privada criptografada com senha (cosign.key) e a pública (cosign.pub).",
          "cosign generate-key-pair",
          "cosign generate-key-pair",
        ],
        explain: [
          "cosign.key é segredo (vai para o secret manager do CI, com a senha em COSIGN_PASSWORD); cosign.pub é distribuída para quem verifica — o cluster, por exemplo.",
          "Em GitHub Actions/GitLab, prefira o modo keyless (OIDC + Fulcio): o certificado é efêmero e não existe chave para vazar.",
        ],
        check: (sh) => /PRIVATE KEY/.test(file(sh, "cosign.key") ?? "") && /PUBLIC KEY/.test(file(sh, "cosign.pub") ?? ""),
      },
      {
        title: "Assinar a imagem",
        body: ["Assine ghcr.io/danylo/api:1.4.0 com a chave privada. Use --yes para aceitar os termos sem prompt, como num pipeline."],
        code: ["cosign sign --yes --key cosign.key ghcr.io/danylo/api:1.4.0"],
        hints: [
          "Assinar usa a chave PRIVADA. A assinatura é gravada no registry, ao lado da imagem.",
          "cosign sign --yes --key <chave-privada> <imagem>",
          "cosign sign --yes --key cosign.key ghcr.io/danylo/api:1.4.0",
        ],
        explain: [
          "A assinatura foi para o registry (tag sha256-<digest>.sig) e registrada no log de transparência Rekor. Note o WARNING: o cosign assina o digest para o qual a tag apontava agora.",
          "No pipeline, assine pelo digest que o build produziu (imagem@sha256:…) para não correr o risco de assinar outra coisa.",
        ],
        diagnose: (sh) =>
          sh.entries.some((e) => /^cosign sign/.test(e.cmd) && /cosign\.pub/.test(e.cmd)) ? "Para assinar use a chave privada (--key cosign.key). A .pub é para verificar." : null,
        check: (sh) => isSignedBy(sh, "ghcr.io/danylo/api:1.4.0", P("cosign.pub")),
      },
      {
        title: "Verificar a assinatura",
        body: ["Verifique a imagem com a chave pública."],
        code: ["cosign verify --key cosign.pub ghcr.io/danylo/api:1.4.0"],
        hints: [
          "Verificar usa a chave PÚBLICA — é o que o cluster/admission controller faria antes de rodar a imagem.",
          "cosign verify --key <chave-pública> <imagem>",
          "cosign verify --key cosign.pub ghcr.io/danylo/api:1.4.0",
        ],
        explain: [
          "As três checagens passaram: claims válidas, presença no transparency log e assinatura conferida com a chave pública. A saída JSON traz o docker-manifest-digest assinado.",
          "No Kubernetes, o Kyverno (verifyImages) ou o Sigstore policy-controller fazem exatamente esse verify no admission e ainda reescrevem a tag para o digest.",
        ],
        check: (sh) => cosignState(sh).verifies.some((v) => v.ref === "ghcr.io/danylo/api:1.4.0" && v.ok),
      },
      {
        title: "Barrar a imagem não assinada",
        body: ["A tag 1.4.1 foi publicada fora do pipeline. Rode o verify contra ela e confirme que é rejeitada."],
        code: ["cosign verify --key cosign.pub ghcr.io/danylo/api:1.4.1"],
        hints: [
          "Mesmo comando do passo anterior, com a outra tag.",
          "cosign verify --key cosign.pub <imagem-suspeita>",
          "cosign verify --key cosign.pub ghcr.io/danylo/api:1.4.1",
        ],
        explain: [
          "no signatures found: o digest da 1.4.1 nunca foi assinado pelo seu CI. Com uma política de admission, esse Pod nem seria criado — e o incidente vira um alerta, não uma invasão.",
          "Próximos passos de maturidade: cosign attest --type spdxjson --predicate sbom.json para anexar o SBOM assinado e proveniência SLSA gerada pelo builder.",
        ],
        diagnose: (sh) => {
          const ok = cosignState(sh).verifies.filter((v) => v.ref === "ghcr.io/danylo/api:1.4.1" && v.ok);
          return ok.length ? "A 1.4.1 foi verificada com sucesso — você a assinou? Neste passo a ideia é ver o verify falhar para uma imagem que o CI não assinou." : null;
        },
        check: (sh) => cosignState(sh).verifies.some((v) => v.ref === "ghcr.io/danylo/api:1.4.1" && !v.ok),
      },
    ],
    outro: "SBOM gerado, imagem assinada e verificação funcionando nos dois sentidos. Juntando com os labs anteriores, você tem a esteira shift-left completa: segredos, CVEs, IaC, runtime e proveniência.",
  },
];
