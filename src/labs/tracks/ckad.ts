import "../k8s/kubectl";
import type { Shell } from "../shell";
import type { Lab, Track } from "../types";
import { createDeployment, createService, endpoints, findDeployment, findObj, findService, jobCompletions } from "../k8s/cluster";
import { applyManifest } from "../k8s/manifest";
import YAML from "yaml";

export const track: Track = {
  id: "ckad",
  title: "CKAD · Certified Kubernetes Application Developer",
  desc: "O dia a dia de quem entrega aplicações no Kubernetes: ConfigMaps e Secrets, multi-container, probes, recursos, Jobs e CronJobs, estratégias de deploy e troubleshooting — com o jeito rápido de fazer na prova (dry-run + edit).",
  color: "#8b5cf6",
  icon: "🧑‍💻",
  badge: "Certificação",
};

const pod = (sh: Shell, name: string, ns = "default") => sh.state.pods.find((p) => p.name === name && p.namespace === ns);
const podsOf = (sh: Shell, owner: string, ns = "default") => sh.state.pods.filter((p) => p.namespace === ns && p.owner === owner);

export const SIDECAR_BASE = `apiVersion: v1
kind: Pod
metadata:
  name: app
  labels:
    app: app
spec:
  volumes:
  - name: logs
    emptyDir: {}
  containers:
  - name: app
    image: busybox:1.36
    command: ["sh", "-c", "while true; do echo \\"$(date) pedido processado\\" >> /var/log/app.log; sleep 5; done"]
    volumeMounts:
    - name: logs
      mountPath: /var/log
`;

export const SIDECAR_FULL = `${SIDECAR_BASE}  - name: log-agent
    image: busybox:1.36
    command: ["sh", "-c", "tail -f /var/log/app.log"]
    volumeMounts:
    - name: logs
      mountPath: /var/log
`;

const SHOP_YAML = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: shop
  labels:
    app: shop
spec:
  replicas: 2
  selector:
    matchLabels:
      app: shop
  template:
    metadata:
      labels:
        app: shop
    spec:
      containers:
      - name: shop
        image: nginx:1.25
        ports:
        - containerPort: 80
        readinessProbe:
          httpGet:
            path: /healthz
            port: 80
          periodSeconds: 5
`;

const CANARY_V1 = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: web-v1
spec:
  replicas: 3
  selector:
    matchLabels:
      app: web
      version: v1
  template:
    metadata:
      labels:
        app: web
        version: v1
    spec:
      containers:
      - name: web
        image: hashicorp/http-echo
        args: ["-text=v1"]
        ports:
        - containerPort: 5678
`;

export const CANARY_V2 = CANARY_V1.replace(/v1/g, "v2").replace("replicas: 3", "replicas: 1");

const ORDERS_YAML = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: orders
spec:
  replicas: 2
  selector:
    matchLabels:
      app: orders
  template:
    metadata:
      labels:
        app: orders
    spec:
      containers:
      - name: orders
        image: nginx:1.25
        envFrom:
        - configMapRef:
            name: orders-config
`;

const WORKER_YAML = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: worker
spec:
  replicas: 1
  selector:
    matchLabels:
      app: worker
  template:
    metadata:
      labels:
        app: worker
    spec:
      containers:
      - name: worker
        image: busybox:1.36
        command: ["sh", "-c", "echo processando fila; echo fila vazia, saindo"]
`;

const seedYaml = (sh: Shell, yaml: string, ageMs = 600_000) => {
  applyManifest(sh, YAML.parse(yaml), "apply");
  const doc = YAML.parse(yaml);
  const d = findDeployment(sh, doc.metadata.name);
  if (d) {
    d.createdAt = Date.now() - ageMs;
    for (const p of podsOf(sh, d.name)) {
      p.createdAt = d.createdAt;
      p.scheduledAt = d.createdAt;
    }
  }
};

export const labs: Lab[] = [
  // ------------------------------------------------------------------ config
  {
    id: "ckad-config-secrets",
    track: "ckad",
    kind: "lab",
    title: "ConfigMaps e Secrets na aplicação",
    summary: "Configuração fora da imagem, injetada como variáveis de ambiente.",
    level: "Iniciante",
    minutes: 12,
    skills: ["ConfigMap", "Secret", "envFrom", "dry-run"],
    intro: "12-factor app: a mesma imagem roda em dev e prod, e o que muda é a configuração. Você vai criar um ConfigMap e um Secret e injetá-los no Pod webapp.",
    steps: [
      {
        title: "Criar o ConfigMap",
        body: ["Crie o ConfigMap app-config com APP_ENV=production e LOG_LEVEL=info."],
        code: ["kubectl create configmap app-config --from-literal=APP_ENV=production --from-literal=LOG_LEVEL=info"],
        hints: ["ConfigMap guarda configuração não sensível como pares chave/valor.", "kubectl create configmap <nome> --from-literal=CHAVE=valor (repita a flag para cada chave)", "kubectl create configmap app-config --from-literal=APP_ENV=production --from-literal=LOG_LEVEL=info"],
        explain: ["O ConfigMap tem 2 chaves (veja com kubectl describe cm app-config). Também dá para criar a partir de arquivos (--from-file) ou .env (--from-env-file).", "ConfigMaps não são criptografados — nada de senhas aqui."],
        diagnose: (sh) => {
          const cm = findObj(sh, "ConfigMap", "app-config");
          if (cm && (cm.manifest.data.APP_ENV !== "production" || cm.manifest.data.LOG_LEVEL !== "info")) return "O ConfigMap existe, mas os valores não batem. Apague (kubectl delete cm app-config) e recrie com APP_ENV=production e LOG_LEVEL=info.";
          return null;
        },
        check: (sh) => findObj(sh, "ConfigMap", "app-config")?.manifest.data?.APP_ENV === "production" && findObj(sh, "ConfigMap", "app-config")?.manifest.data?.LOG_LEVEL === "info",
      },
      {
        title: "Criar o Secret",
        body: ["Crie o Secret genérico db-secret com DB_PASSWORD=S3nhaF0rte."],
        code: ["kubectl create secret generic db-secret --from-literal=DB_PASSWORD=S3nhaF0rte"],
        hints: ["Secrets do tipo generic (Opaque) guardam dados sensíveis codificados em base64.", "kubectl create secret generic <nome> --from-literal=CHAVE=valor", "kubectl create secret generic db-secret --from-literal=DB_PASSWORD=S3nhaF0rte"],
        explain: [
          "O valor fica em base64 — isso é codificação, não criptografia! Teste: kubectl get secret db-secret -o jsonpath='{.data.DB_PASSWORD}' | base64 -d.",
          "Em produção: encryption at rest no etcd (KMS no EKS) e, idealmente, External Secrets Operator puxando do AWS Secrets Manager.",
        ],
        check: (sh) => atobSafe(findObj(sh, "Secret", "db-secret")?.manifest.data?.DB_PASSWORD) === "S3nhaF0rte",
      },
      {
        title: "Gerar o YAML do Pod",
        body: ["Gere (sem criar) o manifesto do Pod webapp com nginx:1.25 e salve em webapp.yaml."],
        code: ["kubectl run webapp --image=nginx:1.25 --dry-run=client -o yaml > webapp.yaml"],
        hints: ["--dry-run=client -o yaml imprime o objeto em vez de criá-lo. Redirecione para um arquivo.", "kubectl run <nome> --image=<imagem> --dry-run=client -o yaml > arquivo.yaml", "kubectl run webapp --image=nginx:1.25 --dry-run=client -o yaml > webapp.yaml"],
        explain: ["Você tem um esqueleto válido de Pod em segundos. Dica de prova: export do=\"--dry-run=client -o yaml\" e depois kubectl run x --image=y $do.", "O mesmo truque funciona com create deployment, create job, expose, create cronjob…"],
        check: (sh) => /kind: Pod/.test(sh.readFile("webapp.yaml") ?? "") && /name: webapp/.test(sh.readFile("webapp.yaml") ?? ""),
      },
      {
        title: "Injetar ConfigMap e Secret e criar o Pod",
        body: [
          "Edite webapp.yaml: carregue TODO o app-config com envFrom e a variável DB_PASSWORD a partir do db-secret (secretKeyRef). Aplique.",
        ],
        code: ["vi webapp.yaml", "kubectl apply -f webapp.yaml"],
        hints: [
          "envFrom importa todas as chaves de um ConfigMap/Secret; env com valueFrom pega uma chave específica.",
          "No container: envFrom → configMapRef.name app-config; env → name DB_PASSWORD, valueFrom.secretKeyRef (name db-secret, key DB_PASSWORD).",
          "    envFrom:\n    - configMapRef:\n        name: app-config\n    env:\n    - name: DB_PASSWORD\n      valueFrom:\n        secretKeyRef:\n          name: db-secret\n          key: DB_PASSWORD",
        ],
        explain: [
          "O Pod subiu com as 3 variáveis. Se o ConfigMap não existisse, o Pod ficaria em CreateContainerConfigError.",
          "Variáveis de ambiente não atualizam sozinhas quando o ConfigMap muda — é preciso recriar os Pods (rollout restart). Volumes de ConfigMap, sim, se atualizam.",
        ],
        diagnose: (sh) => {
          const p = pod(sh, "webapp");
          if (!p) return "O Pod webapp ainda não foi criado. Salve o YAML e rode kubectl apply -f webapp.yaml.";
          const c = p.spec.containers[0];
          if (!c.envFrom?.some((e) => e.configMapRef?.name === "app-config")) return "Falta o envFrom com configMapRef app-config. Como Pods são imutáveis, recrie com kubectl replace --force -f webapp.yaml.";
          if (!c.env?.some((e) => e.name === "DB_PASSWORD")) return "Falta a variável DB_PASSWORD vinda do secret (valueFrom.secretKeyRef). Recrie com kubectl replace --force -f webapp.yaml.";
          return null;
        },
        check: (sh) => {
          const p = pod(sh, "webapp");
          const c = p?.spec.containers[0];
          return !!p && sh.podReady(p) && !!c?.envFrom?.some((e) => e.configMapRef?.name === "app-config") && !!c?.env?.some((e) => e.name === "DB_PASSWORD" && (e.valueFrom as { secretKeyRef?: { name: string } })?.secretKeyRef?.name === "db-secret");
        },
      },
      {
        title: "Conferir dentro do container",
        body: ["Liste as variáveis de ambiente do container."],
        code: ["kubectl exec webapp -- env"],
        hints: ["Execute um comando dentro do Pod.", "kubectl exec <pod> -- <comando>", "kubectl exec webapp -- env"],
        explain: ["APP_ENV, LOG_LEVEL e DB_PASSWORD estão lá — já decodificado, porque o kubelet entrega o valor real ao container.", "Qualquer um com permissão de exec (ou de ler Secrets) vê a senha. Proteja com RBAC."],
        check: (sh) => sh.ran(/(kubectl|k) exec webapp .*-- (env|printenv)/),
      },
    ],
    outro: "Configuração separada da imagem: mesmo artefato em todos os ambientes.",
  },

  // ------------------------------------------------------------------ sidecar
  {
    id: "ckad-multicontainer",
    track: "ckad",
    kind: "lab",
    title: "Pod multi-container com sidecar de logs",
    summary: "Volume compartilhado emptyDir e kubectl logs -c.",
    level: "Intermediário",
    minutes: 12,
    skills: ["sidecar", "emptyDir", "logs -c"],
    seed: { files: { "app.yaml": SIDECAR_BASE } },
    intro: "Uma aplicação legada grava logs em arquivo (/var/log/app.log), não no stdout — então kubectl logs não mostra nada. Solução clássica: um container sidecar que lê o arquivo e escreve no stdout.",
    steps: [
      {
        title: "Subir a aplicação",
        body: ["Aplique app.yaml."],
        code: ["kubectl apply -f app.yaml"],
        hints: ["O manifesto já está pronto no diretório.", "kubectl apply -f <arquivo>", "kubectl apply -f app.yaml"],
        explain: ["O Pod app está Running. Repare no volume logs do tipo emptyDir: vive enquanto o Pod viver e pode ser compartilhado entre containers.", "Esse é o padrão para compartilhar arquivos entre containers do mesmo Pod."],
        check: (sh) => !!pod(sh, "app") && sh.podReady(pod(sh, "app")!),
      },
      {
        title: "Tentar ler os logs",
        body: ["Veja os logs do Pod."],
        code: ["kubectl logs app"],
        hints: ["Logs no Kubernetes = stdout/stderr do container.", "kubectl logs <pod>", "kubectl logs app"],
        explain: ["Vazio! A app escreve em arquivo, e o runtime só captura stdout/stderr. Nenhum coletor de logs (Fluent Bit, Datadog agent) veria essas linhas.", "Por isso o padrão da CNCF é: aplicações logam em stdout."],
        check: (sh) => sh.ran(/(kubectl|k) logs app\b/),
      },
      {
        title: "Adicionar o sidecar",
        body: [
          "Adicione em app.yaml um segundo container log-agent (busybox:1.36) que roda tail -f /var/log/app.log montando o mesmo volume logs.",
          "Pods são imutáveis: recrie com kubectl replace --force -f app.yaml.",
        ],
        code: ["vi app.yaml", "kubectl replace --force -f app.yaml"],
        hints: [
          "Novo item na lista containers, com o mesmo volumeMounts do container app.",
          "- name: log-agent / image: busybox:1.36 / command: [\"sh\",\"-c\",\"tail -f /var/log/app.log\"] / volumeMounts logs em /var/log",
          "  - name: log-agent\n    image: busybox:1.36\n    command: [\"sh\", \"-c\", \"tail -f /var/log/app.log\"]\n    volumeMounts:\n    - name: logs\n      mountPath: /var/log",
        ],
        explain: [
          "READY 2/2: os dois containers compartilham rede, volumes e ciclo de vida. Se você tentasse kubectl apply, receberia Forbidden: pod updates may not change fields… — por isso o replace --force.",
          "A partir do Kubernetes 1.29, sidecars \"nativos\" são initContainers com restartPolicy: Always (iniciam antes e terminam depois do app).",
        ],
        diagnose: (sh) => {
          const p = pod(sh, "app");
          if (!p) return "O Pod app não existe — aplique com kubectl apply -f app.yaml (ou replace --force).";
          if (p.spec.containers.length < 2) return "O Pod em execução ainda tem 1 container. Salve o YAML com o log-agent e recrie com kubectl replace --force -f app.yaml.";
          const la = p.spec.containers.find((c) => c.name === "log-agent");
          if (!la?.volumeMounts?.some((m) => m.name === "logs")) return "O log-agent precisa montar o volume logs em /var/log para enxergar o arquivo.";
          return null;
        },
        check: (sh) => {
          const p = pod(sh, "app");
          const la = p?.spec.containers.find((c) => c.name === "log-agent");
          return !!p && sh.podReady(p) && !!la?.volumeMounts?.some((m) => m.name === "logs" && m.mountPath === "/var/log");
        },
      },
      {
        title: "Ler os logs pelo sidecar",
        body: ["Leia os logs do container log-agent."],
        code: ["kubectl logs app -c log-agent"],
        hints: ["Com vários containers, escolha qual.", "kubectl logs <pod> -c <container>", "kubectl logs app -c log-agent"],
        explain: ["As linhas \"pedido processado\" aparecem: o sidecar transformou o arquivo em stdout, visível para kubectl logs e para qualquer coletor.", "Outros usos de sidecar: proxy de service mesh (Envoy), sync de config, renovação de certificados."],
        check: (sh) => sh.ran(/(kubectl|k) logs app .*(-c|--container)[ =]log-agent/),
      },
    ],
    outro: "Sidecar pattern aplicado. Multi-container é tema garantido na CKAD.",
  },

  // ------------------------------------------------------------------ probes
  {
    id: "ckad-probes-resources",
    track: "ckad",
    kind: "challenge",
    title: "Readiness, liveness e recursos",
    summary: "Um Deployment Running mas sem tráfego — e sem limites de recursos.",
    level: "Intermediário",
    minutes: 12,
    skills: ["readinessProbe", "livenessProbe", "requests/limits", "kubectl edit"],
    seed: {
      setup: (sh) => {
        seedYaml(sh, SHOP_YAML);
        createService(sh, { name: "shop", port: 80, selector: { app: "shop" } });
      },
    },
    intro: "🚨 O Deployment shop aparece como Running, mas o Service shop não entrega tráfego para ninguém. Descubra o motivo e deixe o app com probes e recursos corretos.",
    steps: [
      {
        title: "Observar os Pods",
        body: ["Liste os Pods do shop."],
        code: ["kubectl get pods -l app=shop"],
        hints: ["Olhe a coluna READY, não só STATUS.", "kubectl get pods -l app=shop", "kubectl get pods -l app=shop"],
        explain: ["STATUS Running com READY 0/1: o container está vivo, mas não passou na readiness probe, então foi retirado dos Endpoints do Service.", "Running ≠ pronto para receber tráfego. É exatamente para isso que a readiness existe."],
        check: (sh) => sh.ran(/(kubectl|k) get (pods?|po)\b/),
      },
      {
        title: "Encontrar a probe que falha",
        body: ["Descreva um Pod do shop e leia os eventos."],
        code: ["kubectl describe pod <nome-do-pod>"],
        hints: ["Probes que falham geram eventos Unhealthy.", "kubectl describe pod shop-… (Tab completa)", "kubectl describe pod shop-xxxxxxxxx-xxxxx (troque pelo nome real)"],
        explain: ["Readiness probe failed: HTTP probe failed with statuscode: 404 — o nginx não tem /healthz. A probe aponta para um endpoint que não existe.", "Probes devem checar algo barato e real. Para nginx estático, / basta; para APIs, um /healthz/ready que verifique dependências críticas."],
        check: (sh) => sh.ran(/(kubectl|k) describe (pods?|po)[ /]shop-/),
      },
      {
        title: "Corrigir a readiness probe",
        body: ["Edite o Deployment e troque o path da readinessProbe para /."],
        code: ["kubectl edit deployment shop"],
        hints: ["Deployments aceitam edição ao vivo; o rollout recria os Pods.", "kubectl edit deployment shop → readinessProbe.httpGet.path: /", "readinessProbe:\n  httpGet:\n    path: /\n    port: 80"],
        explain: ["O rollout criou Pods novos com a probe correta; ao ficarem Ready, entraram nos Endpoints e o Service voltou a funcionar.", "Confira: kubectl get endpoints shop agora lista 2 IPs."],
        diagnose: (sh) => {
          const d = findDeployment(sh, "shop");
          const path = d?.template.spec.containers[0].readinessProbe?.httpGet?.path;
          if (path && path !== "/" && path !== "/index.html") return `A probe ainda aponta para ${path}. Use / (ou /index.html).`;
          return "Os Pods novos ainda estão subindo — aguarde alguns segundos.";
        },
        check: (sh) => {
          const s = findService(sh, "shop");
          return sh.deploymentReady("shop") && !!s && endpoints(sh, s).length === 2;
        },
      },
      {
        title: "Adicionar requests e limits",
        body: ["Defina requests cpu=100m,memory=128Mi e limits cpu=250m,memory=256Mi para o shop."],
        code: ["kubectl set resources deployment shop --requests=cpu=100m,memory=128Mi --limits=cpu=250m,memory=256Mi"],
        hints: [
          "requests = o que o scheduler reserva; limits = o teto (CPU é estrangulada, memória acima do limite = OOMKilled).",
          "kubectl set resources deployment <nome> --requests=cpu=…,memory=… --limits=cpu=…,memory=…",
          "kubectl set resources deployment shop --requests=cpu=100m,memory=128Mi --limits=cpu=250m,memory=256Mi",
        ],
        explain: ["Com requests e limits o Pod virou QoS Burstable e o scheduler passou a considerar 100m de CPU por réplica.", "Sem requests, o HPA não consegue calcular % de CPU, e um vizinho barulhento pode estrangular seu app."],
        check: (sh) => {
          const c = findDeployment(sh, "shop")?.template.spec.containers[0];
          return c?.resources?.requests?.cpu === "100m" && c?.resources?.limits?.memory === "256Mi" && c?.resources?.limits?.cpu === "250m" && c?.resources?.requests?.memory === "128Mi" && sh.deploymentReady("shop");
        },
      },
      {
        title: "Adicionar liveness probe",
        body: ["Adicione uma livenessProbe tcpSocket na porta 80 ao container shop (kubectl edit)."],
        code: ["kubectl edit deployment shop"],
        hints: ["Liveness decide se o container deve ser REINICIADO; readiness decide se recebe tráfego.", "No container: livenessProbe → tcpSocket.port 80 (initialDelaySeconds 10 é uma boa prática).", "livenessProbe:\n  tcpSocket:\n    port: 80\n  initialDelaySeconds: 10"],
        explain: ["Agora o kubelet reinicia o container se a porta 80 parar de responder (deadlock, processo travado).", "Cuidado: liveness agressiva demais (ou checando dependências externas) causa restarts em cascata. Para apps lentos no boot, use startupProbe."],
        diagnose: (sh) => {
          const c = findDeployment(sh, "shop")?.template.spec.containers[0];
          if (c?.livenessProbe && Number(c.livenessProbe.tcpSocket?.port ?? c.livenessProbe.httpGet?.port) !== 80) return "A liveness aponta para uma porta errada — os containers seriam reiniciados em loop. Use a porta 80.";
          return null;
        },
        check: (sh) => {
          const c = findDeployment(sh, "shop")?.template.spec.containers[0];
          return !!c?.livenessProbe && Number(c.livenessProbe.tcpSocket?.port ?? c.livenessProbe.httpGet?.port) === 80 && sh.deploymentReady("shop");
        },
      },
    ],
    outro: "App saudável de verdade: readiness controla tráfego, liveness controla restarts e requests/limits controlam capacidade.",
  },

  // ------------------------------------------------------------------ jobs
  {
    id: "ckad-jobs-cronjobs",
    track: "ckad",
    kind: "lab",
    title: "Jobs e CronJobs",
    summary: "Tarefas que terminam, agendamento e execução manual a partir de um CronJob.",
    level: "Iniciante",
    minutes: 10,
    skills: ["Job", "CronJob", "create job --from"],
    intro: "Nem tudo é servidor: migrations, backups e relatórios rodam até terminar. Jobs garantem a conclusão; CronJobs agendam Jobs.",
    steps: [
      {
        title: "Criar um Job",
        body: ["Crie o Job pi com busybox:1.36 executando sh -c \"echo 3.14159\"."],
        code: ["kubectl create job pi --image=busybox:1.36 -- sh -c \"echo 3.14159\""],
        hints: ["Tudo depois de -- vira o comando do container.", "kubectl create job <nome> --image=<imagem> -- <comando>", "kubectl create job pi --image=busybox:1.36 -- sh -c \"echo 3.14159\""],
        explain: ["O Job criou um Pod que rodou até o fim: STATUS Completed e COMPLETIONS 1/1.", "Se o Pod falhar, o Job tenta de novo até backoffLimit (padrão 6). completions e parallelism controlam quantas execuções e quantas em paralelo."],
        check: (sh) => {
          const j = findObj(sh, "Job", "pi");
          return !!j && jobCompletions(sh, j).done >= 1;
        },
      },
      {
        title: "Ler o resultado",
        body: ["Veja a saída do Job."],
        code: ["kubectl logs job/pi"],
        hints: ["Logs funcionam com tipo/nome.", "kubectl logs job/<nome>", "kubectl logs job/pi"],
        explain: ["3.14159 — a saída do Pod do Job. Pods Completed continuam existindo (para você ler os logs) até o Job ser apagado ou o ttlSecondsAfterFinished expirar.", "Em produção, configure ttlSecondsAfterFinished para não acumular Pods antigos."],
        check: (sh) => sh.ran(/(kubectl|k) logs (job\/pi|pi-)/),
      },
      {
        title: "Agendar um CronJob",
        body: ["Crie o CronJob backup (busybox:1.36) a cada 5 minutos executando sh -c \"echo backup ok\"."],
        code: ["kubectl create cronjob backup --image=busybox:1.36 --schedule=\"*/5 * * * *\" -- sh -c \"echo backup ok\""],
        hints: ["A expressão cron tem 5 campos: minuto hora dia mês dia-da-semana.", "kubectl create cronjob <nome> --image=<img> --schedule=\"<cron>\" -- <comando>", "kubectl create cronjob backup --image=busybox:1.36 --schedule=\"*/5 * * * *\" -- sh -c \"echo backup ok\""],
        explain: ["*/5 * * * * = a cada 5 minutos. O CronJob cria um Job novo a cada disparo, com histórico controlado por successfulJobsHistoryLimit.", "concurrencyPolicy: Forbid evita dois backups simultâneos se um atrasar."],
        diagnose: (sh) => {
          const c = findObj(sh, "CronJob", "backup");
          return c && c.manifest.spec.schedule !== "*/5 * * * *" ? `O schedule ficou "${c.manifest.spec.schedule}". Use aspas: --schedule="*/5 * * * *".` : null;
        },
        check: (sh) => findObj(sh, "CronJob", "backup")?.manifest.spec?.schedule === "*/5 * * * *",
      },
      {
        title: "Disparar o CronJob manualmente",
        body: ["Sem esperar o agendamento, crie o Job backup-manual a partir do CronJob backup."],
        code: ["kubectl create job backup-manual --from=cronjob/backup"],
        hints: ["Você pode instanciar um Job usando o template de um CronJob.", "kubectl create job <nome> --from=cronjob/<cronjob>", "kubectl create job backup-manual --from=cronjob/backup"],
        explain: ["backup-manual rodou com exatamente o mesmo template do CronJob — ótimo para testar antes do primeiro disparo ou reexecutar uma rotina que falhou.", "Confira com kubectl logs job/backup-manual."],
        check: (sh) => {
          const j = findObj(sh, "Job", "backup-manual");
          return !!j && jobCompletions(sh, j).done >= 1;
        },
      },
    ],
    outro: "Jobs e CronJobs dominados — incluindo o truque do --from=cronjob para testes.",
  },

  // ------------------------------------------------------------------ canary
  {
    id: "ckad-canary",
    track: "ckad",
    kind: "lab",
    title: "Canary deployment com labels",
    summary: "Dois Deployments atrás do mesmo Service, proporção pelas réplicas.",
    level: "Intermediário",
    minutes: 12,
    skills: ["canary", "labels & selectors", "kubectl scale"],
    seed: {
      files: { "web-v2.yaml": CANARY_V2 },
      setup: (sh) => {
        seedYaml(sh, CANARY_V1, 3600_000);
        createService(sh, { name: "web", port: 80, targetPort: 5678, selector: { app: "web" } });
      },
    },
    intro: "A v1 do web está em produção com 3 réplicas atrás do Service web (selector app=web). Você vai lançar a v2 para ~25% do tráfego, validar e promover — sem ferramenta extra, só com labels.",
    steps: [
      {
        title: "Entender o selector",
        body: ["Veja o selector do Service e os labels dos Pods."],
        code: ["kubectl get pods --show-labels", "kubectl describe svc web"],
        hints: ["O Service escolhe Pods por label, não por Deployment.", "Compare o Selector do Service com os labels dos Pods.", "kubectl get pods --show-labels"],
        explain: ["O Service seleciona só app=web — ignora version. Então qualquer Pod com app=web, de qualquer Deployment, recebe tráfego.", "É essa brecha que permite um canary simples."],
        check: (sh) => sh.ran(/(kubectl|k) get (pods?|po).*--show-labels/) || sh.ran(/(kubectl|k) describe (svc|services?)[ /]web/),
      },
      {
        title: "Lançar a v2 como canary",
        body: ["Aplique web-v2.yaml (1 réplica, labels app=web e version=v2)."],
        code: ["kubectl apply -f web-v2.yaml"],
        hints: ["O arquivo já está pronto.", "kubectl apply -f <arquivo>", "kubectl apply -f web-v2.yaml"],
        explain: ["Agora há 4 endpoints: 3 v1 + 1 v2 → ~25% das requisições vão para a v2.", "A proporção só é controlável pelo número de réplicas. Para porcentagens exatas (1%, 5%), use Argo Rollouts, Flagger ou um service mesh."],
        check: (sh) => {
          const s = findService(sh, "web");
          return !!s && endpoints(sh, s).some((p) => p.labels.version === "v2") && endpoints(sh, s).length === 4;
        },
      },
      {
        title: "Validar o canary",
        body: ["Faça algumas requisições ao Service de dentro do cluster e veja as duas versões responderem."],
        code: ["kubectl run tmp --rm -it --image=busybox --restart=Never -- wget -qO- web"],
        hints: ["Teste pelo DNS do Service.", "kubectl run tmp --rm -it --image=busybox --restart=Never -- wget -qO- <service>", "kubectl run tmp --rm -it --image=busybox --restart=Never -- wget -qO- web"],
        explain: ["As respostas alternam entre v1 e v2 conforme o kube-proxy escolhe o endpoint.", "Num canary real, você compara taxa de erro e latência da v2 contra a v1 (ex.: Prometheus com label version) antes de promover."],
        check: (sh) => sh.flags.has("reach:default/web"),
      },
      {
        title: "Promover a v2",
        body: ["Escale web-v2 para 3 réplicas e web-v1 para 0."],
        code: ["kubectl scale deployment web-v2 --replicas=3", "kubectl scale deployment web-v1 --replicas=0"],
        hints: ["Promover = inverter a proporção.", "kubectl scale deployment <nome> --replicas=<n> (duas vezes)", "kubectl scale deployment web-v2 --replicas=3 && kubectl scale deployment web-v1 --replicas=0"],
        explain: ["100% do tráfego está na v2. Manter o Deployment v1 com 0 réplicas permite rollback instantâneo (scale de volta).", "Suba primeiro a v2 e só depois zere a v1 — assim a capacidade nunca cai."],
        check: (sh) => findDeployment(sh, "web-v2")?.replicas === 3 && findDeployment(sh, "web-v1")?.replicas === 0 && sh.deploymentReady("web-v2"),
      },
    ],
    outro: "Canary feito só com labels e réplicas — entender isso é a base para Argo Rollouts e service meshes.",
  },

  // ------------------------------------------------------------------ troubleshoot
  {
    id: "ckad-troubleshoot-app",
    track: "ckad",
    kind: "challenge",
    title: "Troubleshooting: CreateContainerConfigError e CrashLoopBackOff",
    summary: "Dois Deployments quebrados por motivos diferentes.",
    level: "Intermediário",
    minutes: 12,
    skills: ["CreateContainerConfigError", "CrashLoopBackOff", "logs --previous"],
    seed: {
      setup: (sh) => {
        seedYaml(sh, ORDERS_YAML, 300_000);
        seedYaml(sh, WORKER_YAML, 300_000);
      },
    },
    intro: "🚨 Deploy de sexta-feira: orders e worker não sobem. Cada um tem um problema diferente — trate um de cada vez.",
    steps: [
      {
        title: "Visão geral",
        body: ["Liste os Pods e anote o STATUS de cada Deployment."],
        code: ["kubectl get pods"],
        hints: ["Comece pelo panorama.", "kubectl get pods", "kubectl get pods"],
        explain: ["orders: CreateContainerConfigError (o container nem foi criado). worker: CrashLoopBackOff (o container sobe, termina e é reiniciado com back-off crescente).", "Cada STATUS aponta para uma ferramenta: config error → describe; crash → logs --previous."],
        check: (sh) => sh.ran(/(kubectl|k) get (pods?|po|all)\b/),
      },
      {
        title: "Diagnosticar o orders",
        body: ["Descreva um Pod do orders."],
        code: ["kubectl describe pod <nome-do-pod>"],
        hints: ["Erros de configuração aparecem nos Events.", "kubectl describe pod orders-… (Tab completa)", "kubectl describe pod orders-xxxxxxxxx-xxxxx (troque pelo nome real)"],
        explain: ["Error: configmap \"orders-config\" not found — o Deployment referencia um ConfigMap que ninguém criou.", "Esse erro também acontece com Secrets e com chaves inexistentes dentro de um ConfigMap."],
        check: (sh) => sh.ran(/(kubectl|k) describe (pods?|po)[ /]orders-/) || sh.ran(/(kubectl|k) get (events|ev)/),
      },
      {
        title: "Corrigir o orders",
        body: ["Crie o ConfigMap orders-config com QUEUE=orders."],
        code: ["kubectl create configmap orders-config --from-literal=QUEUE=orders"],
        hints: ["Basta criar o que falta; o kubelet tenta de novo sozinho.", "kubectl create configmap <nome> --from-literal=CHAVE=valor", "kubectl create configmap orders-config --from-literal=QUEUE=orders"],
        explain: ["Os Pods do orders saíram de CreateContainerConfigError para Running sem precisar recriar nada — o kubelet reavalia periodicamente.", "Em GitOps, ConfigMaps e Deployments ficam no mesmo repositório/Helm chart, e esse erro some."],
        check: (sh) => sh.deploymentReady("orders"),
      },
      {
        title: "Diagnosticar o worker",
        body: ["Veja os logs da execução ANTERIOR do container do worker."],
        code: ["kubectl logs deployment/worker --previous"],
        hints: ["Em CrashLoopBackOff, o container atual pode ainda não ter logado nada — olhe a execução anterior.", "kubectl logs <pod ou deployment/nome> --previous", "kubectl logs deployment/worker --previous"],
        explain: ["\"processando fila\" / \"fila vazia, saindo\": o processo termina com sucesso… e é esse o problema. Em um Deployment (restartPolicy Always), todo container que termina é reiniciado.", "Tarefas que terminam deveriam ser Job/CronJob; um worker de fila precisa de um loop que nunca termina."],
        check: (sh) => sh.ran(/(kubectl|k) logs .*(worker).*(--previous|-p\b)/) || sh.ran(/(kubectl|k) logs (--previous|-p) .*worker/),
      },
      {
        title: "Corrigir o worker",
        body: ["Edite o Deployment worker para o container ficar em loop: sh -c \"while true; do echo processando fila; sleep 10; done\"."],
        code: ["kubectl edit deployment worker"],
        hints: ["Troque o command do container por um loop infinito.", "command: [\"sh\", \"-c\", \"while true; do echo processando fila; sleep 10; done\"]", "command:\n- sh\n- -c\n- while true; do echo processando fila; sleep 10; done"],
        explain: ["Com o loop, o container não termina mais: Running e estável.", "Na vida real a correção seria no código (consumir a fila continuamente) ou transformar em CronJob, se for mesmo uma tarefa pontual."],
        check: (sh) => sh.deploymentReady("worker"),
      },
    ],
    outro: "Dois incidentes, dois caminhos: describe para erros de configuração, logs --previous para crashes.",
  },

  // ------------------------------------------------------------------ services & ingress
  {
    id: "ckad-services-ingress",
    track: "ckad",
    kind: "lab",
    title: "Services, DNS e Ingress",
    summary: "ClusterIP, resolução DNS interna e roteamento HTTP por host.",
    level: "Intermediário",
    minutes: 10,
    skills: ["ClusterIP", "DNS", "Ingress"],
    seed: { seedDeployments: [{ name: "api", image: "nginx:1.25", replicas: 2, ageSec: 1800 }] },
    intro: "O Deployment api está rodando, mas ninguém consegue falar com ele de forma estável. Exponha-o internamente, valide o DNS e publique com um Ingress.",
    steps: [
      {
        title: "Criar o Service ClusterIP",
        body: ["Exponha o Deployment api na porta 80."],
        code: ["kubectl expose deployment api --port=80"],
        hints: ["Sem --type, o Service é ClusterIP (só interno).", "kubectl expose deployment <nome> --port=<porta>", "kubectl expose deployment api --port=80"],
        explain: ["O Service api ganhou um ClusterIP estável e um nome DNS: api.default.svc.cluster.local.", "ClusterIP é o tipo certo para comunicação entre microserviços; exposição externa fica com Ingress/LoadBalancer."],
        check: (sh) => findService(sh, "api")?.type === "ClusterIP",
      },
      {
        title: "Resolver o nome pelo DNS",
        body: ["De um Pod temporário, resolva o nome api."],
        code: ["kubectl run dns --rm -it --image=busybox --restart=Never -- nslookup api"],
        hints: ["O CoreDNS responde nomes de Services dentro do cluster.", "kubectl run <nome> --rm -it --image=busybox --restart=Never -- nslookup <service>", "kubectl run dns --rm -it --image=busybox --restart=Never -- nslookup api"],
        explain: ["api resolve para o ClusterIP. De outro namespace, use api.default (o search do resolv.conf completa o resto).", "Se o nslookup falhar para todos os nomes, verifique os Pods do CoreDNS em kube-system."],
        check: (sh) => sh.ran(/(kubectl|k) run .*--rm.*nslookup api/),
      },
      {
        title: "Chamar a API pelo nome",
        body: ["Faça uma requisição HTTP ao Service a partir de um Pod temporário."],
        code: ["kubectl run tmp --rm -it --image=busybox --restart=Never -- wget -qO- api"],
        hints: ["Mesmo esquema, agora com wget.", "kubectl run tmp --rm -it --image=busybox --restart=Never -- wget -qO- <service>", "kubectl run tmp --rm -it --image=busybox --restart=Never -- wget -qO- api"],
        explain: ["Resposta do nginx: DNS → ClusterIP → kube-proxy → Pod.", "Do nó (fora dos Pods), nomes de Service não resolvem — por isso sempre teste de dentro do cluster."],
        check: (sh) => sh.flags.has("reach:default/api"),
      },
      {
        title: "Publicar com Ingress",
        body: ["Crie o Ingress api (classe nginx) roteando api.danylo.dev/* para o Service api:80."],
        code: ["kubectl create ingress api --class=nginx --rule=\"api.danylo.dev/*=api:80\""],
        hints: ["Ingress roteia HTTP por host/caminho para Services.", "kubectl create ingress <nome> --class=<classe> --rule=\"host/caminho=service:porta\"", "kubectl create ingress api --class=nginx --rule=\"api.danylo.dev/*=api:80\""],
        explain: ["O Ingress declara a regra; quem executa é o Ingress Controller (ingress-nginx, AWS Load Balancer Controller → ALB).", "No EKS, anotações do ALB controller definem certificado ACM, WAF e health checks."],
        check: (sh) => {
          const ing = findObj(sh, "Ingress", "api");
          const rule = ing?.manifest.spec?.rules?.[0];
          return rule?.host === "api.danylo.dev" && rule?.http?.paths?.[0]?.backend?.service?.name === "api";
        },
      },
    ],
    outro: "Service para estabilidade, DNS para descoberta e Ingress para exposição HTTP.",
  },
];

function atobSafe(v?: string) {
  try {
    return v ? atob(v) : undefined;
  } catch {
    return undefined;
  }
}
