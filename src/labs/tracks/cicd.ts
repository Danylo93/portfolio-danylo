import "../k8s/kubectl";
import "../tools/git";
import "../tools/gh";
import "../tools/argocd";
import { findDeployment } from "../k8s/cluster";
import type { Shell } from "../shell";
import { argoApp, argoState, appStatus } from "../tools/argocd";
import { ghState, latestRun, parseWorkflow, secretsOf, triggers, type Run } from "../tools/gh";
import { commitOf, findRepo, headSha, seedGit, serverOf, serverRev } from "../tools/git";
import type { Lab, Lesson, Track } from "../types";
import { PROJECT } from "../util";

export const track: Track = {
  id: "cicd",
  title: "CI/CD & GitOps",
  desc: "Do git push ao cluster: pipelines no GitHub Actions, depuração de builds quebrados, secrets e OIDC para publicar imagens, e entrega contínua com Argo CD (sync, drift, self-heal e rollback).",
  color: "#f472b6",
  icon: "🔁",
};

export const REPO_URL = "https://github.com/danylo/webapp.git";
const CI_PATH = ".github/workflows/ci.yml";
const IMAGE = "ghcr.io/danylo/webapp";

// ---------- seed files ----------
const PACKAGE_JSON = `{
  "name": "webapp",
  "version": "1.0.0",
  "private": true,
  "engines": {
    "node": ">=20"
  },
  "scripts": {
    "test": "jest",
    "build": "vite build",
    "lint": "eslint ."
  },
  "devDependencies": {
    "eslint": "^9.11.0",
    "jest": "^29.7.0",
    "vite": "^5.4.8"
  }
}
`;

const APP_FILES: Record<string, string> = {
  "package.json": PACKAGE_JSON,
  "package-lock.json": `{\n  "name": "webapp",\n  "version": "1.0.0",\n  "lockfileVersion": 3,\n  "requires": true,\n  "packages": {}\n}\n`,
  ".npmrc": "engine-strict=true\n",
  ".gitignore": "node_modules/\ndist/\n",
  "src/sum.js": "function sum(a, b) { return a + b; }\n\nmodule.exports = { sum };\n",
  "src/sum.test.js": `const { sum } = require("./sum");

test("soma 1 + 2 = 3", () => {
  expect(sum(1, 2)).toBe(3);
});

test("soma números negativos", () => {
  expect(sum(-2, -3)).toBe(-5);
});
`,
  Dockerfile: `FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
EXPOSE 3000
CMD ["node", "src/server.js"]
`,
};

export const CI_YML = `name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - run: npm ci
      - run: npm test
`;

export const BROKEN_CI_YML = `name: CI

on:
  push:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-node@v4
        with:
          node-version: 16
      - run: npm ci
      - run: npm test
`;

export const RELEASE_YML = `name: Release

on:
  push:
    tags: ["v*.*.*"]

permissions:
  contents: read
  id-token: write   # OIDC: o job pede um token para assumir a role na AWS

env:
  AWS_REGION: sa-east-1
  ECR_REPOSITORY: webapp

jobs:
  image:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: \${{ secrets.AWS_ROLE_ARN }}
          aws-region: \${{ env.AWS_REGION }}
      - id: ecr
        uses: aws-actions/amazon-ecr-login@v2
      - uses: docker/setup-buildx-action@v3
      - uses: docker/build-push-action@v6
        with:
          context: .
          push: true
          tags: \${{ steps.ecr.outputs.registry }}/\${{ env.ECR_REPOSITORY }}:\${{ github.ref_name }}
`;

export const deploymentYaml = (tag: string) => `apiVersion: apps/v1
kind: Deployment
metadata:
  name: webapp
  labels:
    app: webapp
spec:
  replicas: 2
  selector:
    matchLabels:
      app: webapp
  template:
    metadata:
      labels:
        app: webapp
    spec:
      containers:
        - name: webapp
          image: ${IMAGE}:${tag}
          ports:
            - containerPort: 80
`;

const SERVICE_YAML = `apiVersion: v1
kind: Service
metadata:
  name: webapp
spec:
  type: ClusterIP
  selector:
    app: webapp
  ports:
    - port: 80
      targetPort: 80
`;

const PUBLISH = ["git init", "git add .", 'git commit -m "feat: soma e testes"', `git remote add origin ${REPO_URL}`, "git push -u origin main"];

// ---------- helpers for checks ----------
const repoOf = (sh: Shell) => findRepo(sh, PROJECT);
const server = (sh: Shell) => serverOf(sh, REPO_URL);
const remoteMain = (sh: Shell) => {
  const s = server(sh);
  return s ? serverRev(sh, s, "main") : null;
};
const runsFor = (sh: Shell, pred: (r: Run) => boolean) => ghState(sh).runs.filter(pred);
const latestOnMain = (sh: Shell, file = CI_PATH) => {
  const rev = remoteMain(sh);
  return rev ? latestRun(sh, (r) => r.sha === rev.sha && r.file === file) : undefined;
};

type Step = Record<string, unknown>;
const wfSteps = (content: string | undefined): Step[] | null => {
  if (content === undefined) return null;
  const p = parseWorkflow(CI_PATH, content);
  if (!p.ok) return null;
  return Object.values((p.wf.jobs ?? {}) as Record<string, { steps?: Step[] }>).flatMap((j) => j.steps ?? []);
};
const usesIdx = (steps: Step[], action: string) => steps.findIndex((s) => String(s.uses ?? "").startsWith(action + "@"));
const runIdx = (steps: Step[], re: RegExp) => steps.findIndex((s) => re.test(String(s.run ?? "")));
const nodeVersionOf = (steps: Step[]) => {
  const s = steps[usesIdx(steps, "actions/setup-node")] as { with?: Record<string, unknown> } | undefined;
  return s?.with?.["node-version"] === undefined ? undefined : Number(String(s.with["node-version"]).split(".")[0]);
};

/** Why the learner's CI workflow is not what lab 1 asks for (null = ok). */
export const ciProblem = (content: string | undefined): string | null => {
  if (content === undefined) return "O arquivo .github/workflows/ci.yml ainda não existe. Crie com vi .github/workflows/ci.yml (o caminho precisa ser exatamente esse — o GitHub só lê .github/workflows/).";
  const p = parseWorkflow(CI_PATH, content);
  if (!p.ok) return `O YAML não é válido (${p.error}${p.line ? `, linha ${p.line}` : ""}). Confira a indentação: só espaços, 2 por nível, e "- " antes de cada step.`;
  if (!triggers(p.wf.on, { event: "push", refName: "main", refType: "branch", sha: "" })) return "O workflow não dispara em push na main. Confira o bloco on: → push: → branches: [main].";
  const steps = wfSteps(content)!;
  const co = usesIdx(steps, "actions/checkout");
  const ci = runIdx(steps, /\bnpm ci\b/);
  if (co < 0) return "Falta o step uses: actions/checkout@v4. Sem ele o runner começa vazio — não há package.json para o npm.";
  if (usesIdx(steps, "actions/setup-node") < 0) return "Falta o step uses: actions/setup-node@v4 (com node-version: 20).";
  if (ci < 0) return "Falta o step run: npm ci (instala as dependências a partir do package-lock.json).";
  if (runIdx(steps, /\bnpm (test|t|run test)\b/) < 0) return "Falta o step run: npm test.";
  if (co > ci) return "O checkout precisa vir antes do npm ci — os steps rodam na ordem em que aparecem.";
  return null;
};

const depImage = (sh: Shell) => findDeployment(sh, "webapp")?.image;

// ---------- labs ----------
export const labs: Lab[] = [
  {
    id: "cicd-first-pipeline",
    track: "cicd",
    kind: "lab",
    title: "Primeiro pipeline no GitHub Actions",
    summary: "Versione o projeto, escreva um workflow de CI e veja o primeiro run verde.",
    level: "Iniciante",
    minutes: 12,
    skills: ["git init", "git commit", "git push", "GitHub Actions", "gh run watch"],
    seed: { files: { ...APP_FILES } },
    intro:
      "O diretório ~/project tem uma aplicação Node (src/sum.js + testes com Jest), mas ainda não está versionado nem tem CI. Você vai criar o repositório, escrever um workflow que roda os testes a cada push na main e publicar no GitHub (simulado).",
    steps: [
      {
        title: "Inicializar o repositório",
        body: ["Transforme o diretório do projeto em um repositório Git. A branch inicial será main."],
        code: ["git init"],
        hints: [
          "Todo repositório Git começa com um diretório .git que guarda objetos e referências.",
          "O subcomando que cria esse diretório é init, rodado na raiz do projeto.",
          "git init",
        ],
        explain: [
          "O git init criou ~/project/.git: a partir de agora o Git compara seus arquivos com o último commit (ainda não há nenhum, então tudo aparece como untracked no git status).",
          "Repare no .gitignore com node_modules/ e dist/: dependências e artefatos de build nunca vão para o repositório — o CI os recria de forma reprodutível.",
        ],
        check: (sh) => !!repoOf(sh),
      },
      {
        title: "Escrever o workflow de CI",
        body: [
          "Crie .github/workflows/ci.yml com vi. O workflow deve disparar em push na main e ter um job que faz checkout, instala o Node 20, roda npm ci e npm test:",
          CI_YML,
        ],
        code: ["vi .github/workflows/ci.yml"],
        hints: [
          "O GitHub Actions só procura workflows em .github/workflows/*.yml. Cada job roda num runner limpo, então o primeiro step costuma ser o checkout do código.",
          "Estrutura: name → on (push/branches) → jobs → <id> → runs-on + steps (uses: ação@versão ou run: comando).",
          "vi .github/workflows/ci.yml — cole o YAML do enunciado e salve com :wq",
        ],
        explain: [
          "on define os gatilhos (push na main e pull requests), runs-on escolhe a imagem do runner (ubuntu-latest) e steps roda em ordem: checkout traz o código, setup-node instala o Node 20 com cache do npm, npm ci instala exatamente o que está no package-lock.json e npm test roda o Jest.",
          "npm ci (e não npm install) é o padrão em CI: falha se o lockfile estiver dessincronizado e nunca o altera — builds reprodutíveis. Fixar as ações por versão (@v4) evita que uma mudança upstream quebre seu pipeline.",
        ],
        diagnose: (sh) => ciProblem(sh.readFile(`${PROJECT}/${CI_PATH}`)),
        check: (sh) => ciProblem(sh.readFile(`${PROJECT}/${CI_PATH}`)) === null,
      },
      {
        title: "Primeiro commit",
        body: ["Coloque tudo no stage e crie o primeiro commit com uma mensagem descritiva (ex.: ci: pipeline de testes). Use git status antes e depois para ver a diferença."],
        code: ["git add .", 'git commit -m "ci: pipeline de testes"'],
        hints: [
          "O commit grava apenas o que está no stage (índice). Arquivos novos precisam ser adicionados antes.",
          "git add . coloca tudo do diretório atual no stage; depois git commit -m \"mensagem\".",
          'git add . && git commit -m "ci: pipeline de testes"',
        ],
        explain: [
          "git add copiou os arquivos para o índice e git commit gravou um snapshot imutável com autor, data e mensagem. A saída (root-commit) indica o primeiro commit da branch.",
          "Mensagens no formato Conventional Commits (feat:, fix:, ci:) facilitam changelog automático e versionamento semântico em pipelines de release.",
        ],
        diagnose: (sh) => {
          const repo = repoOf(sh);
          if (!repo) return "Não há repositório — volte ao passo 1 (git init).";
          if (!headSha(repo)) return Object.keys(repo.index).length ? "Os arquivos estão no stage, falta o git commit -m \"...\"." : "Nada está no stage ainda: rode git add . antes do commit.";
          return "O último commit não contém .github/workflows/ci.yml. Adicione com git add .github e faça outro commit.";
        },
        check: (sh) => {
          const repo = repoOf(sh);
          return !!repo && commitOf(sh, headSha(repo))?.tree[CI_PATH] !== undefined;
        },
      },
      {
        title: "Publicar no GitHub",
        body: [`Cadastre o remoto origin (${REPO_URL}) e envie a main. Use -u no primeiro push para gravar o upstream.`],
        code: [`git remote add origin ${REPO_URL}`, "git push -u origin main"],
        hints: [
          "O repositório local ainda não conhece o GitHub: primeiro cadastre um remoto, depois envie a branch.",
          "git remote add origin <url> e depois git push -u origin main.",
          `git remote add origin ${REPO_URL} && git push -u origin main`,
        ],
        explain: [
          "O push enviou os commits e o GitHub leu .github/workflows/ci.yml do commit enviado: como o gatilho push em main casou, um workflow run foi enfileirado automaticamente.",
          "O -u gravou origin/main como upstream: daqui em diante basta git push e o git status informa se você está à frente ou atrás do remoto.",
        ],
        diagnose: (sh) => {
          const repo = repoOf(sh);
          if (!repo || !headSha(repo)) return "Faça o commit antes do push (passo anterior).";
          if (!repo.remotes.origin) return `O remoto origin ainda não existe: git remote add origin ${REPO_URL}`;
          return "O remoto existe, mas a main ainda não foi enviada: git push -u origin main.";
        },
        check: (sh) => {
          const repo = repoOf(sh);
          const rev = remoteMain(sh);
          return !!repo && !!rev && rev.sha === headSha(repo) && runsFor(sh, (r) => r.sha === rev.sha).length > 0;
        },
      },
      {
        title: "Acompanhar o run",
        body: ["Acompanhe a execução até o fim com o GitHub CLI e confirme que o job test ficou verde (✓)."],
        code: ["gh run watch"],
        hints: [
          "O gh descobre o repositório pelo remoto origin e lista as execuções do GitHub Actions.",
          "gh run list mostra as execuções; gh run watch <id> acompanha uma até terminar (sem ID, usa a mais recente).",
          "gh run watch",
        ],
        explain: [
          "O run passou: checkout → setup-node → npm ci → npm test, com os 2 testes do Jest verdes. Cada step tem log próprio (gh run view <id> --log).",
          "Em equipe, esse check vira obrigatório via branch protection: nenhum PR entra na main sem o CI verde. gh run watch --exit-status é útil em scripts porque falha se o run falhar.",
        ],
        diagnose: (sh) => {
          const r = latestOnMain(sh);
          if (!r) return "Não há run para o commit atual da main — confira o passo anterior (git push).";
          if (r.conclusion === "failure") return "O run falhou. Leia o motivo com gh run view --log-failed, corrija o ci.yml, faça commit e push de novo.";
          return "Use gh run watch (ou gh run view <id>) para acompanhar o run.";
        },
        check: (sh) => {
          const r = latestOnMain(sh);
          return !!r && r.conclusion === "success" && (sh.flags.has(`gh:watch:${r.id}`) || sh.flags.has(`gh:view:${r.id}`));
        },
      },
    ],
    outro: "Pipeline de CI no ar: todo push na main agora roda os testes num runner limpo. Próximo passo: quebrar (e consertar) um pipeline como no dia a dia.",
  },
  {
    id: "cicd-broken-pipeline",
    track: "cicd",
    kind: "challenge",
    title: "Desafio: pipeline quebrado",
    summary: "O CI da main está vermelho. Leia os logs, ache a causa, corrija e deixe verde.",
    level: "Intermediário",
    minutes: 15,
    skills: ["gh run view --log-failed", "actions/checkout", "engines/EBADENGINE", "git commit -am"],
    seed: {
      files: { ...APP_FILES, [CI_PATH]: BROKEN_CI_YML },
      setup: (sh) => seedGit(sh, PUBLISH),
    },
    intro:
      "Alguém publicou o workflow de CI da webapp e o build da main quebrou. Nada de chutar: investigue pelos logs, corrija uma causa por vez e prove que o pipeline voltou a ficar verde.",
    steps: [
      {
        title: "Encontrar o run com falha",
        body: ["Liste as execuções do GitHub Actions do repositório e identifique a que falhou (X)."],
        code: ["gh run list"],
        hints: ["O GitHub CLI lista as execuções do repositório do remoto origin.", "gh run list (filtre com --workflow CI ou --branch main).", "gh run list"],
        explain: [
          "A coluna STATUS mostra X para falha, ✓ para sucesso e * para em andamento; TITLE é a mensagem do commit que disparou o run e ID é o que você usa nos próximos comandos.",
          "Triagem de incidente em CI começa igual à de produção: qual commit, qual workflow, desde quando.",
        ],
        check: (sh) => sh.ran(/^gh run (list|ls)\b/),
      },
      {
        title: "Ler o log da falha",
        body: ["Veja só o log do step que falhou. Qual erro o npm mostrou?"],
        code: ["gh run view --log-failed"],
        hints: [
          "O log completo é longo; o gh tem uma opção que filtra só os steps com falha.",
          "gh run view <id> --log-failed (sem ID, usa o run mais recente).",
          "gh run view --log-failed",
        ],
        explain: [
          "npm ci falhou com ENOENT: não existe package.json no diretório do job. O runner começa vazio — sem o step actions/checkout o código do repositório nunca é baixado.",
          "Todo job é isolado (outra VM). Se um workflow tiver vários jobs, cada um precisa do próprio checkout.",
        ],
        check: (sh) => {
          const first = ghState(sh).runs[0];
          return !!first && [...sh.flags].some((f) => f.startsWith(`gh:log-failed:${first.id}:`));
        },
      },
      {
        title: "Adicionar o checkout",
        body: [
          "Edite .github/workflows/ci.yml e adicione - uses: actions/checkout@v4 como primeiro step. Depois faça commit e push.",
          "Dica: git commit -am inclui automaticamente arquivos já rastreados que foram modificados.",
        ],
        code: ["vi .github/workflows/ci.yml", 'git commit -am "ci: adiciona checkout"', "git push"],
        hints: [
          "O checkout precisa vir antes de qualquer step que use arquivos do repositório.",
          "Em steps:, antes do setup-node, adicione a linha - uses: actions/checkout@v4 (mesma indentação dos outros itens). Depois git commit -am \"...\" e git push.",
          'vi .github/workflows/ci.yml — adicione "- uses: actions/checkout@v4" como primeiro step; depois git commit -am "ci: adiciona checkout" && git push',
        ],
        explain: [
          "O push disparou um novo run com o workflow corrigido. Corrigir uma causa por vez e validar é mais rápido do que mudar tudo de uma vez e não saber o que resolveu.",
          "git commit -am pula o git add para arquivos já rastreados — prático, mas não inclui arquivos novos.",
        ],
        diagnose: (sh) => {
          const local = wfSteps(sh.readFile(`${PROJECT}/${CI_PATH}`));
          if (!local) return "O ci.yml local não é um YAML válido — confira a indentação.";
          if (usesIdx(local, "actions/checkout") < 0) return "O ci.yml local ainda não tem o step - uses: actions/checkout@v4.";
          if (usesIdx(local, "actions/checkout") > runIdx(local, /npm ci/)) return "O checkout está depois do npm ci; ele precisa ser o primeiro step.";
          return "A correção está só no seu diretório. O GitHub só vê o que foi commitado e enviado: git commit -am \"...\" && git push.";
        },
        check: (sh) => {
          const rev = remoteMain(sh);
          const steps = wfSteps(rev?.tree[CI_PATH]);
          return !!rev && !!steps && usesIdx(steps, "actions/checkout") >= 0 && usesIdx(steps, "actions/checkout") < runIdx(steps, /npm ci/) && !!latestOnMain(sh);
        },
      },
      {
        title: "Ler a nova falha",
        body: ["O run novo ainda falhou, mas em outro ponto. Leia o log do step com falha e descubra a nova causa."],
        code: ["gh run view --log-failed"],
        hints: [
          "Um erro corrigido pode revelar o próximo. Volte ao log dos steps com falha do run mais recente.",
          "gh run view <id> --log-failed; procure a linha com EBADENGINE.",
          "gh run view --log-failed",
        ],
        explain: [
          "EBADENGINE: o package.json exige \"node\": \">=20\" e o .npmrc tem engine-strict=true, mas o workflow instala o Node 16. Com engine-strict o npm transforma o aviso em erro.",
          "Isso é proposital: o time declarou a versão mínima do runtime no próprio projeto, e o CI apontou a divergência antes de ela chegar em produção.",
        ],
        diagnose: (sh) => {
          const r = latestOnMain(sh);
          if (r?.conclusion === "success") return "O run já ficou verde? Então alguém corrigiu tudo de uma vez — mesmo assim, rode gh run view <id> --log-failed no run anterior para ver o erro.";
          return "Rode gh run view --log-failed no run mais recente (o que foi disparado pelo seu push).";
        },
        check: (sh) => {
          const r = latestOnMain(sh);
          return !!r && r.id !== ghState(sh).runs[0]?.id && r.conclusion === "failure" && sh.flags.has(`gh:log-failed:${r.id}:${r.attempt}`);
        },
      },
      {
        title: "Corrigir a versão do Node",
        body: ["Ajuste o workflow para usar a versão de Node exigida pelo projeto, faça commit e push, e confirme que o run ficou verde."],
        code: ["vi .github/workflows/ci.yml", 'git commit -am "ci: usa Node 20"', "git push"],
        hints: [
          "Quem manda é o package.json (engines). O workflow é que precisa acompanhar — não o contrário.",
          "No step setup-node troque node-version: 16 por node-version: 20. Depois commit e push.",
          'vi .github/workflows/ci.yml — troque node-version: 16 por 20; depois git commit -am "ci: usa Node 20" && git push',
        ],
        explain: [
          "Com Node 20 o npm ci instalou as dependências e os testes passaram: o run da main voltou a ficar verde.",
          "Para não ter a versão em dois lugares, use node-version-file: .nvmrc (ou package.json) no setup-node, e uma matrix [20, 22] quando precisar testar mais de uma versão.",
        ],
        diagnose: (sh) => {
          const pkg = sh.readFile(`${PROJECT}/package.json`) ?? "";
          if (!/">=20"/.test(pkg)) return "Você alterou o engines do package.json. Rebaixar o requisito esconde o problema; o certo é o workflow usar o Node que o projeto exige (node-version: 20).";
          const local = wfSteps(sh.readFile(`${PROJECT}/${CI_PATH}`));
          if (local && (nodeVersionOf(local) ?? 0) < 20) return "O ci.yml ainda instala um Node menor que 20 (node-version).";
          const r = latestOnMain(sh);
          if (r?.conclusion === "failure") return "O último run ainda falhou — leia com gh run view --log-failed.";
          return "A correção precisa chegar ao GitHub: git commit -am \"...\" && git push.";
        },
        check: (sh) => {
          const r = latestOnMain(sh);
          const steps = wfSteps(remoteMain(sh)?.tree[CI_PATH]);
          return !!r && r.conclusion === "success" && !!steps && (nodeVersionOf(steps) ?? 0) >= 20;
        },
      },
    ],
    outro: "Pipeline verde de novo, com duas causas corrigidas em sequência a partir dos logs. Esse é o ciclo real: ler o erro, corrigir a menor coisa possível, validar.",
  },
  {
    id: "cicd-release-image",
    track: "cicd",
    kind: "lab",
    title: "Release: build e push da imagem para o ECR",
    summary: "Uma tag v1.0.0 dispara o build da imagem; configure o secret da role OIDC e publique.",
    level: "Intermediário",
    minutes: 14,
    skills: ["git tag -a", "gh secret set", "OIDC na AWS", "docker/build-push-action", "gh run rerun"],
    seed: {
      files: { ...APP_FILES, [CI_PATH]: CI_YML, ".github/workflows/release.yml": RELEASE_YML },
      setup: (sh) => seedGit(sh, PUBLISH),
    },
    intro:
      "A webapp tem dois workflows: CI (testes em todo push na main) e Release (.github/workflows/release.yml), que roda quando uma tag v*.*.* é enviada: assume uma role na AWS via OIDC, faz login no ECR e publica a imagem com a tag da versão. Leia o release.yml com cat antes de começar.",
    steps: [
      {
        title: "Criar a tag da versão",
        body: ["Crie uma tag anotada v1.0.0 no commit atual, com a mensagem \"Release 1.0.0\"."],
        code: ['git tag -a v1.0.0 -m "Release 1.0.0"'],
        hints: [
          "Tags marcam versões. As anotadas guardam autor, data e mensagem — são as recomendadas para releases.",
          "git tag -a <versão> -m \"mensagem\"",
          'git tag -a v1.0.0 -m "Release 1.0.0"',
        ],
        explain: [
          "A tag anotada é um objeto próprio (autor, data, mensagem) apontando para o commit. Veja com git show v1.0.0.",
          "Versionamento semântico (MAJOR.MINOR.PATCH) comunica o impacto: v1.0.1 é correção, v1.1.0 funcionalidade compatível, v2.0.0 quebra compatibilidade.",
        ],
        diagnose: (sh) => (repoOf(sh)?.tags["v1.0.0"] && !repoOf(sh)!.tags["v1.0.0"].annotated ? "A tag v1.0.0 existe mas é leve (sem -a). Apague com git tag -d v1.0.0 e recrie com -a -m." : null),
        check: (sh) => !!repoOf(sh)?.tags["v1.0.0"]?.annotated,
      },
      {
        title: "Enviar a tag",
        body: ["Tags não vão junto com git push da branch. Envie a tag v1.0.0 para o origin e veja o workflow Release disparar."],
        code: ["git push origin v1.0.0"],
        hints: ["O push de uma tag é explícito.", "git push origin <tag> (ou --tags para todas).", "git push origin v1.0.0"],
        explain: [
          "O GitHub recebeu refs/tags/v1.0.0 e o gatilho on.push.tags: [\"v*.*.*\"] do release.yml casou — o CI (que só escuta a branch main) não rodou.",
          "Separar CI (todo commit) de release (tag) é um padrão comum: só versões marcadas geram artefatos publicados.",
        ],
        check: (sh) => !!server(sh)?.tags["v1.0.0"] && runsFor(sh, (r) => r.branch === "v1.0.0" && r.workflow === "Release").length > 0,
      },
      {
        title: "Investigar a falha",
        body: ["O Release falhou. Leia o log do step com falha e descubra o que faltou."],
        code: ["gh run view --log-failed"],
        hints: ["Os logs dizem exatamente qual step quebrou.", "gh run view <id> --log-failed", "gh run view --log-failed"],
        explain: [
          "configure-aws-credentials não recebeu role-to-assume: ${{ secrets.AWS_ROLE_ARN }} virou string vazia porque o secret não existe no repositório. Secret ausente não é erro de YAML — a expressão simplesmente resolve para vazio.",
          "Com OIDC não há chave de acesso guardada no GitHub: o job apresenta um token assinado e a AWS devolve credenciais temporárias da role. O secret só guarda o ARN da role.",
        ],
        check: (sh) => {
          const r = latestRun(sh, (x) => x.workflow === "Release");
          return !!r && [...sh.flags].some((f) => f.startsWith(`gh:log-failed:${r.id}:`));
        },
      },
      {
        title: "Cadastrar o secret",
        body: ["Cadastre o secret AWS_ROLE_ARN com o ARN da role que o time de plataforma criou: arn:aws:iam::123456789012:role/gha-ecr-push"],
        code: ["gh secret set AWS_ROLE_ARN --body arn:aws:iam::123456789012:role/gha-ecr-push"],
        hints: [
          "Secrets do Actions ficam no GitHub, criptografados, e são injetados via ${{ secrets.NOME }}.",
          "gh secret set NOME --body <valor>",
          "gh secret set AWS_ROLE_ARN --body arn:aws:iam::123456789012:role/gha-ecr-push",
        ],
        explain: [
          "O secret foi gravado no repositório. gh secret list mostra só nomes e datas — o valor nunca é exibido de volta, e nos logs aparece mascarado como ***.",
          "Em produção prefira secrets de environment (ex.: production) com revisores obrigatórios: só jobs com environment: production os recebem.",
        ],
        diagnose: (sh) => {
          const s = server(sh);
          const v = s ? secretsOf(sh, s.slug).AWS_ROLE_ARN?.value : undefined;
          if (v !== undefined && !/^arn:aws:iam::\d{12}:role\//.test(v)) return "O secret existe, mas o valor não é um ARN de role válido (arn:aws:iam::<conta>:role/<nome>).";
          return null;
        },
        check: (sh) => {
          const s = server(sh);
          return !!s && /^arn:aws:iam::\d{12}:role\/[\w+=,.@/-]+$/.test(secretsOf(sh, s.slug).AWS_ROLE_ARN?.value ?? "");
        },
      },
      {
        title: "Reexecutar o release",
        body: ["Secrets são lidos na hora da execução, então não precisa de commit novo: reexecute o run que falhou e confirme que a imagem foi publicada."],
        code: ["gh run rerun"],
        hints: [
          "O código não mudou — só a configuração do repositório. Basta rodar de novo o mesmo run.",
          "gh run rerun <id> (use o ID do run do Release; sem ID, o mais recente). Depois gh run watch.",
          "gh run rerun",
        ],
        explain: [
          "Na segunda tentativa (Attempt #2) a role foi assumida via OIDC, o login no ECR funcionou e o build-push-action publicou 123456789012.dkr.ecr.sa-east-1.amazonaws.com/webapp:v1.0.0.",
          "Tag de imagem = tag do Git dá rastreabilidade (qual commit está rodando?). Em registries de produção, ative imutabilidade de tags para ninguém sobrescrever uma versão publicada.",
        ],
        diagnose: (sh) => {
          const r = latestRun(sh, (x) => x.workflow === "Release");
          if (r && r.attempt > 1 && r.conclusion === "failure") return "O rerun falhou de novo — confira o valor do secret e leia gh run view --log-failed.";
          return null;
        },
        check: (sh) => {
          const r = latestRun(sh, (x) => x.workflow === "Release");
          return !!r && r.conclusion === "success" && ghState(sh).images.some((i) => i.endsWith("/webapp:v1.0.0"));
        },
      },
    ],
    outro: "Release automatizado: tag → workflow → OIDC → ECR, sem nenhuma chave de longa duração guardada no GitHub.",
  },
  {
    id: "cicd-argocd-gitops",
    track: "cicd",
    kind: "lab",
    title: "GitOps com Argo CD",
    summary: "Crie uma Application a partir do diretório k8s/ do repositório e entregue uma nova versão só com git push.",
    level: "Avançado",
    minutes: 15,
    skills: ["argocd app create", "argocd app sync", "GitOps", "argocd app history"],
    seed: {
      files: { ...APP_FILES, [CI_PATH]: CI_YML, "k8s/deployment.yaml": deploymentYaml("1.0.0"), "k8s/service.yaml": SERVICE_YAML },
      setup: (sh) => seedGit(sh, PUBLISH),
    },
    intro:
      "O repositório webapp já tem os manifests em k8s/ (Deployment + Service) e o Argo CD roda no cluster. Em GitOps ninguém faz kubectl apply à mão: o Git é a fonte da verdade e o Argo CD aplica o que está no remoto.",
    steps: [
      {
        title: "Login no Argo CD",
        body: ["Autentique o CLI no servidor argocd.lab.local com o usuário admin (senha lab-admin). O certificado é autoassinado."],
        code: ["argocd login argocd.lab.local --username admin --password lab-admin --insecure"],
        hints: [
          "O CLI conversa com a API do argocd-server; primeiro ele precisa de um token.",
          "argocd login <servidor> --username <u> --password <p> --insecure",
          "argocd login argocd.lab.local --username admin --password lab-admin --insecure",
        ],
        explain: [
          "O token ficou salvo em ~/.config/argocd/config, no contexto argocd.lab.local — como um kubeconfig.",
          "Em produção use SSO (argocd login --sso) e RBAC do Argo CD por projeto; a conta admin local deve ser desativada depois do bootstrap.",
        ],
        check: (sh) => argoState(sh).loggedIn,
      },
      {
        title: "Criar a Application",
        body: [`Crie a Application webapp apontando para ${REPO_URL}, path k8s, no próprio cluster (https://kubernetes.default.svc), namespace default. Sync manual por enquanto.`],
        code: [`argocd app create webapp --repo ${REPO_URL} --path k8s --dest-server https://kubernetes.default.svc --dest-namespace default`],
        hints: [
          "Uma Application liga uma origem (repo + path + revisão) a um destino (cluster + namespace).",
          "argocd app create <nome> --repo <url> --path <dir> --dest-server <api> --dest-namespace <ns>",
          `argocd app create webapp --repo ${REPO_URL} --path k8s --dest-server https://kubernetes.default.svc --dest-namespace default`,
        ],
        explain: [
          "A Application existe, mas nada foi aplicado ainda: argocd app get webapp mostra OutOfSync e Health Missing — o Git descreve recursos que o cluster não tem.",
          "https://kubernetes.default.svc é o endereço do API server visto de dentro do cluster (o próprio cluster onde o Argo CD roda). Outros clusters são cadastrados com argocd cluster add.",
        ],
        diagnose: (sh) => (sh.entries.some((e) => /app path does not exist/.test(e.output)) ? "O --path precisa ser k8s (o diretório dos manifests no repositório)." : null),
        check: (sh) => argoApp(sh, "webapp")?.path.replace(/\/$/, "") === "k8s",
      },
      {
        title: "Primeiro sync",
        body: ["Sincronize a Application e confira que o Deployment webapp foi criado com a imagem 1.0.0."],
        code: ["argocd app sync webapp"],
        hints: ["Sync = aplicar no cluster o estado desejado que está no Git.", "argocd app sync <app>", "argocd app sync webapp"],
        explain: [
          "O Argo CD renderizou k8s/*.yaml na revisão do remoto e aplicou Deployment e Service. Sync Status virou Synced; Health fica Progressing até os Pods ficarem prontos (kubectl get pods).",
          "Sync Status compara Git × cluster; Health diz se os recursos estão funcionando. São independentes: dá para estar Synced e Degraded (ex.: imagem inexistente).",
        ],
        check: (sh) => depImage(sh) === `${IMAGE}:1.0.0` && appStatus(sh, argoApp(sh, "webapp")!).sync === "Synced",
      },
      {
        title: "Entregar a versão 1.1.0 via Git",
        body: [
          "Atualize a imagem em k8s/deployment.yaml para ghcr.io/danylo/webapp:1.1.0, faça commit e push, e sincronize a Application.",
          "Nada de kubectl set image: a mudança passa pelo Git.",
        ],
        code: ["vi k8s/deployment.yaml", 'git commit -am "deploy: webapp 1.1.0"', "git push", "argocd app sync webapp"],
        hints: [
          "O Argo CD lê o remoto — uma edição local não commitada/enviada não existe para ele.",
          "Edite a linha image:, depois git commit -am \"...\", git push e argocd app sync webapp.",
          'vi k8s/deployment.yaml — troque a tag para 1.1.0; depois git commit -am "deploy: webapp 1.1.0" && git push && argocd app sync webapp',
        ],
        explain: [
          "O commit virou a nova revisão desejada: a Application ficou OutOfSync logo após o push e o sync aplicou o novo template — o Deployment fez rolling update para 1.1.0.",
          "Esse é o ganho do GitOps: toda mudança em produção tem autor, revisão (PR) e histórico no Git, e o rollback é um git revert.",
        ],
        diagnose: (sh) => {
          const local = sh.readFile(`${PROJECT}/k8s/deployment.yaml`) ?? "";
          if (!local.includes(`${IMAGE}:1.1.0`)) return "O k8s/deployment.yaml local ainda não tem a imagem ghcr.io/danylo/webapp:1.1.0.";
          if (!remoteMain(sh)?.tree["k8s/deployment.yaml"]?.includes("1.1.0")) return "A mudança não chegou ao GitHub. Faça git commit -am \"...\" e git push.";
          return "O Git já tem a 1.1.0, falta sincronizar: argocd app sync webapp.";
        },
        check: (sh) => depImage(sh) === `${IMAGE}:1.1.0` && !!remoteMain(sh)?.tree["k8s/deployment.yaml"]?.includes("1.1.0"),
      },
      {
        title: "Ver o histórico de deploys",
        body: ["Liste o histórico de syncs da Application. Cada linha aponta para o commit do Git que foi aplicado."],
        code: ["argocd app history webapp"],
        hints: ["O Argo CD guarda cada deploy com a revisão Git correspondente.", "argocd app history <app>", "argocd app history webapp"],
        explain: [
          "ID 0 é o deploy da 1.0.0 e ID 1 o da 1.1.0, cada um com o SHA do commit. argocd app rollback webapp 0 voltaria para o primeiro.",
          "Em GitOps, prefira git revert para voltar versões (o Git continua sendo a verdade); o rollback do Argo CD é o botão de emergência — e exige desligar o auto-sync.",
        ],
        check: (sh) => sh.flags.has("argocd:history:webapp") && (argoApp(sh, "webapp")?.history.length ?? 0) >= 2,
      },
    ],
    outro: "Entrega contínua via Git: commit → push → sync → rolling update, com histórico auditável de cada deploy.",
  },
  {
    id: "cicd-argocd-drift",
    track: "cicd",
    kind: "challenge",
    title: "Desafio: drift, self-heal e rollback",
    summary: "Alguém escalou o Deployment na mão. Detecte o drift, ligue o self-heal e faça um rollback de emergência.",
    level: "Avançado",
    minutes: 15,
    skills: ["argocd app diff", "self-heal", "argocd app set", "argocd app rollback"],
    seed: {
      files: { ...APP_FILES, [CI_PATH]: CI_YML, "k8s/deployment.yaml": deploymentYaml("1.0.0"), "k8s/service.yaml": SERVICE_YAML },
      setup: (sh) => {
        seedGit(sh, [
          ...PUBLISH,
          "argocd login argocd.lab.local --username admin --password lab-admin --insecure",
          `argocd app create webapp --repo ${REPO_URL} --path k8s --dest-server https://kubernetes.default.svc --dest-namespace default --sync-policy automated`,
        ]);
        sh.writeFile(`${PROJECT}/k8s/deployment.yaml`, deploymentYaml("1.1.0"));
        seedGit(sh, ['git commit -am "deploy: webapp 1.1.0"', "git push", "kubectl scale deployment webapp --replicas=5"]);
      },
    },
    intro:
      "A Application webapp tem sync automático (cada push na main é aplicado sozinho). Durante um pico de tráfego, alguém rodou kubectl scale direto no cluster. O Git diz 2 réplicas; o cluster tem outra coisa. Resolva do jeito GitOps.",
    steps: [
      {
        title: "Detectar o drift",
        body: ["Veja o estado da Application webapp. Ela está Synced?"],
        code: ["argocd app get webapp"],
        hints: ["O Argo CD compara continuamente o Git com o cluster.", "argocd app get <app> mostra Sync Status e o status por recurso.", "argocd app get webapp"],
        explain: [
          "Sync Status: OutOfSync, e só o Deployment está OutOfSync — o cluster divergiu do Git. O auto-sync não corrigiu porque ele só age quando a revisão do Git muda.",
          "Drift acontece com hotfix manual, HPA mal configurado, operadores ou kubectl edit. Sem self-heal, o Argo CD apenas sinaliza.",
        ],
        check: (sh) => sh.flags.has("argocd:saw-outofsync:webapp"),
      },
      {
        title: "Ver a diferença",
        body: ["Mostre exatamente o que difere entre o cluster (live) e o Git (desired)."],
        code: ["argocd app diff webapp"],
        hints: ["Há um subcomando que faz o diff live × desired, como um kubectl diff.", "argocd app diff <app>", "argocd app diff webapp"],
        explain: [
          "As linhas < são o estado vivo (replicas: 5) e as > o desejado no Git (replicas: 2).",
          "argocd app diff sai com código 1 quando há diferença — útil em pipelines para bloquear um deploy se o ambiente foi alterado manualmente.",
        ],
        check: (sh) => sh.flags.has("argocd:diff:webapp"),
      },
      {
        title: "Ligar o self-heal",
        body: ["O time decidiu: o Git manda. Ative o self-heal na Application e confirme que o Deployment voltou para 2 réplicas."],
        code: ["argocd app set webapp --self-heal"],
        hints: [
          "Self-heal é uma opção do sync automático que reverte mudanças feitas direto no cluster.",
          "argocd app set <app> --self-heal",
          "argocd app set webapp --self-heal",
        ],
        explain: [
          "Com self-heal o controller viu o drift e reaplicou o Git: o Deployment voltou a 2 réplicas (veja em argocd app history — há um sync novo, iniciado pela política automática).",
          "Se a escala precisa variar, ela não pode estar fixa no Git: use um HPA e remova replicas do manifest (ou ignoreDifferences), senão Argo CD e HPA brigam.",
        ],
        diagnose: (sh) => (argoApp(sh, "webapp")?.selfHeal ? null : "Use argocd app set webapp --self-heal."),
        check: (sh) => !!argoApp(sh, "webapp")?.selfHeal && findDeployment(sh, "webapp")?.replicas === 2,
      },
      {
        title: "Provar o self-heal",
        body: ["Simule de novo a mudança manual: escale para 5 réplicas com kubectl e, em seguida, consulte o Deployment."],
        code: ["kubectl scale deployment webapp --replicas=5", "kubectl get deployment webapp"],
        hints: [
          "Faça o drift e observe o estado logo depois.",
          "kubectl scale deployment <nome> --replicas=N e depois kubectl get deployment <nome>.",
          "kubectl scale deployment webapp --replicas=5 && kubectl get deployment webapp",
        ],
        explain: [
          "O scale funcionou, mas segundos depois o Argo CD reverteu: o get já mostra 2 réplicas desejadas. Mudança fora do Git não sobrevive.",
          "Isso transforma o Git na única porta de entrada para produção — e dá um motivo técnico para o time abrir PR em vez de rodar kubectl à mão.",
        ],
        diagnose: (sh) => (!sh.ran(/^(kubectl|k) scale /) ? "Rode kubectl scale deployment webapp --replicas=5 para gerar o drift." : "Agora consulte o Deployment: kubectl get deployment webapp."),
        check: (sh) => sh.ran(/^(kubectl|k) scale /) && (argoApp(sh, "webapp")?.healCount ?? 0) >= 2 && findDeployment(sh, "webapp")?.replicas === 2,
      },
      {
        title: "Rollback de emergência",
        body: [
          "A versão 1.1.0 está com bug em produção. Volte para o deploy de ID 0 (1.0.0) com o Argo CD.",
          "Atenção: o Argo CD recusa rollback com auto-sync ligado — senão ele reaplicaria o Git em seguida.",
        ],
        code: ["argocd app set webapp --sync-policy none", "argocd app rollback webapp 0"],
        hints: [
          "Primeiro tire a Application do modo automático; depois volte para um ID do histórico (argocd app history webapp).",
          "argocd app set <app> --sync-policy none e argocd app rollback <app> <id>.",
          "argocd app set webapp --sync-policy none && argocd app rollback webapp 0",
        ],
        explain: [
          "O Deployment voltou para a imagem 1.0.0 e a Application ficou OutOfSync: o cluster roda 1.0.0 e o Git ainda diz 1.1.0. É esperado num rollback de emergência.",
          "Fechando o ciclo: git revert do commit da 1.1.0, push, e religar --sync-policy automated --self-heal. Assim Git e cluster voltam a concordar.",
        ],
        diagnose: (sh) => (argoApp(sh, "webapp")?.automated ? "O auto-sync ainda está ligado. Desligue com argocd app set webapp --sync-policy none antes do rollback." : "Faça o rollback para o ID 0: argocd app rollback webapp 0."),
        check: (sh) => !argoApp(sh, "webapp")?.automated && depImage(sh) === `${IMAGE}:1.0.0`,
      },
    ],
    outro: "Drift detectado, corrigido automaticamente e um rollback de emergência feito do jeito certo. Próximo passo em produção: git revert + religar o automated.",
  },
];

// ---------- lessons ----------
export const lessons: Lesson[] = [
  {
    id: "learn-cicd-git-actions",
    track: "cicd",
    title: "Git e anatomia de um workflow do GitHub Actions",
    summary: "Working tree, stage e commit; como um push vira um workflow run.",
    minutes: 6,
    before: "cicd-first-pipeline",
    blocks: [
      { type: "heading", text: "Os três estados de um arquivo" },
      {
        type: "text",
        text: "O Git compara três lugares: o **working tree** (seus arquivos), o **índice/stage** (o que vai no próximo commit) e o **último commit** (HEAD). `git status` é exatamente esse diff: untracked e modified comparam working tree × índice; *Changes to be committed* compara índice × HEAD.",
      },
      {
        type: "flow",
        steps: [
          { label: "working tree", detail: "vi, sed…" },
          { label: "stage", detail: "git add" },
          { label: "commit", detail: "git commit" },
          { label: "remoto", detail: "git push" },
          { label: "workflow run", detail: "GitHub Actions" },
        ],
        caption: "Do arquivo editado ao pipeline",
      },
      { type: "heading", text: "Anatomia do workflow" },
      {
        type: "code",
        lang: "yaml",
        caption: ".github/workflows/ci.yml",
        code: "on:\n  push:\n    branches: [main]      # gatilho\njobs:\n  test:                   # cada job = runner novo\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4   # ação pronta, versão fixada\n      - run: npm ci                 # comando shell",
      },
      {
        type: "table",
        head: ["Chave", "Para que serve"],
        rows: [
          ["on", "gatilhos: push, pull_request, workflow_dispatch, schedule"],
          ["jobs.<id>.runs-on", "imagem/label do runner"],
          ["needs", "ordem e dependência entre jobs (senão rodam em paralelo)"],
          ["steps[].uses", "ação reutilizável (owner/repo@versão)"],
          ["steps[].run", "script no shell do runner"],
        ],
      },
      {
        type: "callout",
        tone: "warn",
        text: "Cada job começa numa VM vazia. Esquecer o `actions/checkout` é a causa nº 1 de \"package.json not found\" no primeiro pipeline.",
      },
      { type: "callout", tone: "tip", text: "Use `npm ci` em CI: instala exatamente o lockfile e falha se ele estiver dessincronizado — build reprodutível." },
    ],
    quiz: [
      {
        q: "Você criou src/app.js e rodou git commit -m \"feat\". O commit falhou com \"nothing added to commit\". Por quê?",
        options: ["Faltou git push", "O arquivo não estava no stage (faltou git add)", "O repositório não tem remoto", "Mensagens precisam de prefixo feat:"],
        answer: 1,
        explain: "O commit grava o índice. Arquivos novos ficam untracked até um git add.",
      },
      {
        q: "Dois jobs sem needs no mesmo workflow…",
        options: ["rodam em sequência na ordem do arquivo", "rodam em paralelo, cada um em seu runner", "compartilham o mesmo diretório de trabalho", "só rodam se o anterior passar"],
        answer: 1,
        explain: "Sem needs os jobs são independentes e paralelos, e cada um tem sua VM — sem arquivos compartilhados.",
      },
      {
        q: "Por que fixar actions/checkout@v4 em vez de @main?",
        options: ["@main não existe", "É mais rápido", "Evita que mudanças upstream quebrem ou comprometam seu pipeline", "O GitHub exige"],
        answer: 2,
        explain: "Versões fixas (ou SHA, mais seguro ainda) dão reprodutibilidade e reduzem risco de supply chain.",
      },
    ],
  },
  {
    id: "learn-cicd-debug-pipelines",
    track: "cicd",
    title: "Depurando pipelines que falham",
    summary: "Como ler logs do Actions e as causas mais comuns de build vermelho.",
    minutes: 5,
    before: "cicd-broken-pipeline",
    blocks: [
      {
        type: "text",
        text: "Pipeline vermelho é incidente de produtividade: o time inteiro fica bloqueado. O método é o mesmo de produção — **observar, isolar, corrigir a menor coisa, validar**. Comece pelo step que falhou, não pelo YAML inteiro.",
      },
      {
        type: "flow",
        steps: [
          { label: "gh run list", detail: "qual run/commit" },
          { label: "gh run view", detail: "qual job/step" },
          { label: "--log-failed", detail: "a mensagem" },
          { label: "fix + push", detail: "uma causa" },
          { label: "gh run watch", detail: "validar" },
        ],
      },
      {
        type: "table",
        head: ["Sintoma no log", "Causa provável"],
        rows: [
          ["ENOENT … package.json", "faltou actions/checkout no job"],
          ["EBADENGINE / Unsupported engine", "node-version diferente do engines do package.json"],
          ["Dependencies lock file is not found", "cache: npm sem package-lock.json (ou antes do checkout)"],
          ["Input required and not supplied", "with: obrigatório vazio — muitas vezes um secret inexistente"],
          ["Invalid workflow file … line N", "YAML inválido (indentação, tab)"],
        ],
      },
      { type: "code", lang: "bash", code: "gh run list --workflow CI --limit 5\ngh run view 1234567890 --log-failed\ngh run rerun 1234567890 --failed   # só para falhas transitórias ou mudanças de secret" },
      {
        type: "callout",
        tone: "warn",
        text: "`gh run rerun` executa o **mesmo commit**. Se a causa está no código ou no YAML, rerun falha igual — é preciso commit + push.",
      },
      { type: "callout", tone: "exam", text: "Em entrevistas: \"funciona na minha máquina\" quase sempre é versão de runtime, lockfile ou variável de ambiente diferente. Declare versões no repositório (engines, .nvmrc)." },
    ],
    quiz: [
      {
        q: "O log mostra EBADENGINE com Required >=20 e Actual v16. Qual a correção adequada?",
        options: ["Remover engines do package.json", "Ajustar node-version do setup-node para 20", "Trocar npm ci por npm install --force", "Rodar gh run rerun"],
        answer: 1,
        explain: "O projeto declarou o runtime mínimo; o pipeline deve segui-lo. Rebaixar o requisito só esconde o problema.",
      },
      {
        q: "Quando gh run rerun resolve uma falha?",
        options: ["Quando o YAML tinha erro de indentação", "Quando faltava um secret que já foi cadastrado, ou numa falha transitória de rede", "Quando um teste está quebrado", "Sempre, pois baixa o código de novo"],
        answer: 1,
        explain: "Rerun usa o mesmo commit; só muda o ambiente (secrets, rede, runner).",
      },
      {
        q: "npm ci falhou com ENOENT package.json no primeiro step de run. O que checar primeiro?",
        options: ["Se o actions/checkout está antes do npm ci no mesmo job", "Se a versão do npm é a 10", "Se o repositório é público", "Se o runner é ubuntu-22.04"],
        answer: 0,
        explain: "Sem checkout o workspace está vazio. É o erro mais comum em pipelines novos.",
      },
    ],
  },
  {
    id: "learn-cicd-secrets-oidc",
    track: "cicd",
    title: "Secrets, OIDC e releases por tag",
    summary: "Como publicar imagens sem chaves de longa duração e versionar releases.",
    minutes: 6,
    before: "cicd-release-image",
    blocks: [
      {
        type: "text",
        text: "Guardar `AWS_ACCESS_KEY_ID` como secret funciona, mas é uma credencial de longa duração que vaza em fork, log ou ação maliciosa. Com **OIDC** o GitHub emite um token assinado por job e a AWS troca por credenciais temporárias de uma role cuja trust policy só aceita o seu repositório/branch/tag.",
      },
      {
        type: "flow",
        steps: [
          { label: "git push tag v1.2.0" },
          { label: "job pede JWT", detail: "id-token: write" },
          { label: "STS AssumeRoleWithWebIdentity" },
          { label: "credenciais 1h" },
          { label: "push no ECR" },
        ],
      },
      {
        type: "code",
        lang: "yaml",
        code: "permissions:\n  id-token: write   # sem isso o token OIDC não é emitido\n  contents: read\nsteps:\n  - uses: aws-actions/configure-aws-credentials@v4\n    with:\n      role-to-assume: ${{ secrets.AWS_ROLE_ARN }}\n      aws-region: sa-east-1",
      },
      {
        type: "table",
        head: ["Abordagem", "Risco", "Rotação"],
        rows: [
          ["Access key em secret", "alto: vale até ser revogada", "manual"],
          ["OIDC + role", "baixo: token por job, escopo por repo/ref", "automática"],
        ],
      },
      {
        type: "callout",
        tone: "warn",
        text: "Secret inexistente não gera erro de sintaxe: `${{ secrets.X }}` vira string vazia e o erro aparece lá na frente (\"Credentials could not be loaded\").",
      },
      { type: "callout", tone: "tip", text: "Release por tag anotada (`git tag -a v1.0.0 -m ...`) + imagem com a mesma tag = rastreabilidade direta do que roda em produção. Ative tag immutability no ECR." },
    ],
    quiz: [
      {
        q: "O configure-aws-credentials falha dizendo para setar a permissão id-token. O que falta?",
        options: ["O secret AWS_SECRET_ACCESS_KEY", "permissions: id-token: write no workflow/job", "Rodar aws configure no step anterior", "Trocar para runs-on: self-hosted"],
        answer: 1,
        explain: "Sem id-token: write o runner não recebe o token OIDC para assumir a role.",
      },
      {
        q: "Por que git push (da branch) não disparou o workflow on.push.tags?",
        options: ["Tags não são enviadas no push da branch; é preciso git push origin <tag> ou --tags", "Workflows de tag só rodam à noite", "Porque a tag era anotada", "Porque falta workflow_dispatch"],
        answer: 0,
        explain: "Tags são refs separadas e o push delas é explícito.",
      },
      {
        q: "Após cadastrar um secret que faltava, qual a forma mais simples de validar?",
        options: ["Criar um commit vazio", "gh run rerun no run que falhou", "Apagar e recriar a tag", "Editar o workflow"],
        answer: 1,
        explain: "Secrets são lidos em tempo de execução; o mesmo commit agora passa.",
      },
    ],
  },
  {
    id: "learn-cicd-gitops-argocd",
    track: "cicd",
    title: "GitOps com Argo CD: sync, health, drift e rollback",
    summary: "O modelo pull, os dois status de uma Application e as políticas de sync.",
    minutes: 7,
    before: "cicd-argocd-gitops",
    blocks: [
      {
        type: "text",
        text: "No CI/CD clássico o pipeline **empurra** (kubectl apply com credencial de cluster no CI). No GitOps um agente dentro do cluster **puxa** o estado desejado do Git e converge continuamente. O CI só publica imagem e altera manifest; o cluster nunca expõe credenciais ao CI.",
      },
      {
        type: "flow",
        steps: [
          { label: "PR / commit", detail: "manifest com tag nova" },
          { label: "Git (main)", detail: "fonte da verdade" },
          { label: "Argo CD", detail: "compara Git × cluster" },
          { label: "sync", detail: "apply" },
          { label: "cluster", detail: "Healthy" },
        ],
      },
      {
        type: "table",
        head: ["Campo", "Pergunta que responde", "Valores"],
        rows: [
          ["Sync Status", "O cluster é igual ao Git?", "Synced / OutOfSync"],
          ["Health Status", "Os recursos estão funcionando?", "Healthy / Progressing / Degraded / Missing"],
          ["automated", "Aplicar sozinho quando o Git muda?", "on/off"],
          ["selfHeal", "Reverter mudanças feitas direto no cluster?", "on/off"],
          ["prune", "Apagar o que saiu do Git?", "on/off"],
        ],
      },
      { type: "code", lang: "bash", code: "argocd app create web --repo https://github.com/org/app.git --path k8s \\\n  --dest-server https://kubernetes.default.svc --dest-namespace prod \\\n  --sync-policy automated --self-heal --auto-prune\nargocd app diff web\nargocd app history web" },
      {
        type: "callout",
        tone: "warn",
        text: "`argocd app rollback` é recusado com auto-sync ligado. Em GitOps o caminho normal de rollback é `git revert` + push; o rollback do Argo CD é para emergências.",
      },
      { type: "callout", tone: "exam", text: "Synced + Degraded é possível: o Git foi aplicado fielmente, mas descreve algo quebrado (ex.: tag de imagem inexistente)." },
    ],
    quiz: [
      {
        q: "A Application tem sync automático sem self-heal. Alguém roda kubectl scale. O que acontece?",
        options: ["O Argo CD reverte imediatamente", "Fica OutOfSync até alguém sincronizar ou o Git mudar", "O Argo CD apaga o Deployment", "O kubectl é bloqueado"],
        answer: 1,
        explain: "O auto-sync reage a novas revisões do Git; reverter drift é trabalho do self-heal.",
      },
      {
        q: "Qual a vantagem de segurança do modelo pull (GitOps)?",
        options: ["Não precisa de RBAC", "O CI não precisa de credenciais de admin do cluster", "Dispensa revisão de código", "Imagens não precisam de registry"],
        answer: 1,
        explain: "O agente roda dentro do cluster e só lê o Git; o CI não guarda kubeconfig de produção.",
      },
      {
        q: "Você editou k8s/deployment.yaml localmente e rodou argocd app sync. Nada mudou. Por quê?",
        options: ["Faltou --prune", "O Argo CD lê o repositório remoto: faltou commit e push", "O sync só funciona com automated", "Precisa reiniciar o argocd-server"],
        answer: 1,
        explain: "A fonte é a revisão no Git remoto, não o seu disco.",
      },
    ],
  },
];
