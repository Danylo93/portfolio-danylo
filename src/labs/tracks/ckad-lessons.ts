import type { Lesson } from "../types";

export const lessons: Lesson[] = [
  {
    id: "learn-ckad-config",
    track: "ckad",
    title: "Configuração: ConfigMaps, Secrets e 12-factor",
    summary: "Separar configuração da imagem e as formas de injetá-la no container.",
    minutes: 5,
    before: "ckad-config-secrets",
    blocks: [
      { type: "text", text: "Uma imagem deve ser a mesma em dev, homologação e produção. O que muda é a **configuração**, que vem de fora: ConfigMaps para dados comuns e Secrets para dados sensíveis." },
      {
        type: "table",
        head: ["Forma de injetar", "YAML", "Atualiza sem reiniciar?"],
        rows: [
          ["Todas as chaves como env", "`envFrom.configMapRef`", "Não"],
          ["Uma chave específica", "`env[].valueFrom.configMapKeyRef`", "Não"],
          ["Arquivos num diretório", "`volumes[].configMap` + `volumeMounts`", "Sim (com atraso de ~1 min)"],
        ],
      },
      { type: "code", lang: "yaml", code: "envFrom:\n- configMapRef:\n    name: app-config\nenv:\n- name: DB_PASSWORD\n  valueFrom:\n    secretKeyRef:\n      name: db-secret\n      key: DB_PASSWORD" },
      {
        type: "flow",
        steps: [
          { label: "Secret no etcd", detail: "base64 (+ criptografia em repouso)" },
          { label: "kubelet", detail: "busca ao criar o Pod" },
          { label: "container", detail: "recebe o valor em texto puro" },
        ],
      },
      { type: "callout", tone: "warn", text: "base64 não é criptografia. Quem tem `get secrets` lê suas senhas. Em produção: encryption at rest com KMS e, idealmente, External Secrets Operator + AWS Secrets Manager." },
      { type: "callout", tone: "exam", text: "Se o ConfigMap referenciado não existir, o Pod fica em CreateContainerConfigError — e se recupera sozinho quando você cria o ConfigMap." },
    ],
    quiz: [
      { q: "Você alterou um ConfigMap usado via envFrom. Os Pods já veem o novo valor?", options: ["Sim, imediatamente", "Não, precisa recriar os Pods (ex.: rollout restart)", "Só após 24h", "Só se for Secret"], answer: 1, explain: "Variáveis de ambiente são lidas na criação do container. Volumes de ConfigMap, sim, são atualizados." },
      { q: "Como o valor de um Secret é armazenado por padrão no objeto?", options: ["Criptografado com AES", "Codificado em base64", "Em texto puro sem codificação", "Como hash SHA-256"], answer: 1, explain: "O campo data é base64. Criptografia exige configurar encryption at rest." },
      { q: "Pod em CreateContainerConfigError: causa mais provável?", options: ["Imagem inexistente", "ConfigMap ou Secret referenciado ausente", "Falta de CPU", "Porta errada"], answer: 1, explain: "O kubelet não consegue montar a configuração do container; describe mostra qual objeto falta." },
    ],
  },
  {
    id: "learn-ckad-pod-design",
    track: "ckad",
    title: "Design de Pods: multi-container, Jobs e CronJobs",
    summary: "Sidecar, init containers e cargas que terminam.",
    minutes: 5,
    before: "ckad-multicontainer",
    blocks: [
      { type: "text", text: "Um Pod pode ter vários containers quando eles precisam compartilhar ciclo de vida, rede e disco. Os padrões clássicos têm nome:" },
      {
        type: "table",
        head: ["Padrão", "Exemplo", "Como compartilha"],
        rows: [
          ["Sidecar", "Agente de logs, proxy Envoy", "Volume emptyDir / localhost"],
          ["Init container", "Esperar o banco, rodar migration", "Roda ANTES e precisa terminar com sucesso"],
          ["Ambassador", "Proxy para um serviço externo", "localhost"],
          ["Adapter", "Converter métricas para o formato Prometheus", "Volume ou localhost"],
        ],
      },
      {
        type: "flow",
        steps: [
          { label: "initContainers", detail: "rodam em sequência até o fim" },
          { label: "containers", detail: "app + sidecars em paralelo" },
          { label: "emptyDir", detail: "disco compartilhado enquanto o Pod viver" },
        ],
      },
      { type: "heading", text: "Jobs e CronJobs" },
      { type: "code", lang: "shell", code: "kubectl create job pi --image=busybox -- sh -c \"echo 3.14\"\nkubectl create cronjob backup --image=busybox --schedule=\"*/5 * * * *\" -- sh -c \"echo ok\"\nkubectl create job teste --from=cronjob/backup" },
      { type: "callout", tone: "tip", text: "Em CronJobs críticos use `concurrencyPolicy: Forbid` e `startingDeadlineSeconds`, e defina `ttlSecondsAfterFinished` nos Jobs para não acumular Pods antigos." },
      { type: "callout", tone: "exam", text: "Pods são imutáveis: para adicionar um sidecar a um Pod existente use `kubectl replace --force -f pod.yaml` (apaga e recria)." },
    ],
    quiz: [
      { q: "Qual padrão resolve \"a app escreve log em arquivo e o coletor só lê stdout\"?", options: ["Init container", "Sidecar lendo o arquivo via volume compartilhado", "Ambassador", "HPA"], answer: 1, explain: "O sidecar faz tail do arquivo no emptyDir e escreve no próprio stdout." },
      { q: "Quando um init container falha…", options: ["Os containers principais sobem mesmo assim", "O Pod não inicia os containers principais e o init é reexecutado", "O Pod é apagado", "O nó é drenado"], answer: 1, explain: "Init containers precisam terminar com sucesso, em ordem, antes dos containers da app." },
      { q: "Qual objeto garante que uma tarefa rode até completar com sucesso?", options: ["Deployment", "Job", "DaemonSet", "Service"], answer: 1, explain: "Jobs reexecutam Pods que falham até atingir as completions ou o backoffLimit." },
    ],
  },
  {
    id: "learn-ckad-probes",
    track: "ckad",
    title: "Probes e recursos: saúde e capacidade",
    summary: "readiness × liveness × startup, requests × limits e classes de QoS.",
    minutes: 6,
    before: "ckad-probes-resources",
    blocks: [
      {
        type: "table",
        head: ["Probe", "Se falhar…", "Use para"],
        rows: [
          ["readinessProbe", "Pod sai dos Endpoints (sem tráfego)", "App ainda carregando, dependência indisponível"],
          ["livenessProbe", "Container é REINICIADO", "Deadlock, processo travado"],
          ["startupProbe", "Adia as outras probes até passar", "Apps com boot lento (JVM)"],
        ],
      },
      { type: "code", lang: "yaml", code: "readinessProbe:\n  httpGet: { path: /healthz/ready, port: 8080 }\n  periodSeconds: 5\nlivenessProbe:\n  tcpSocket: { port: 8080 }\n  initialDelaySeconds: 15\nresources:\n  requests: { cpu: 100m, memory: 128Mi }\n  limits:   { cpu: 500m, memory: 256Mi }" },
      {
        type: "flow",
        steps: [
          { label: "requests", detail: "o scheduler reserva" },
          { label: "uso real", detail: "pode passar de requests" },
          { label: "limit de CPU", detail: "throttling (fica lento)" },
          { label: "limit de memória", detail: "OOMKilled (reinicia)" },
        ],
      },
      { type: "list", items: ["**Guaranteed**: requests = limits para CPU e memória — último a ser despejado.", "**Burstable**: tem requests/limits, mas diferentes.", "**BestEffort**: nada definido — primeiro a ser despejado sob pressão."] },
      { type: "callout", tone: "warn", text: "Liveness checando o banco de dados é um antipadrão: se o banco cair, TODOS os Pods reiniciam em cascata sem resolver nada. Liveness deve checar só o próprio processo." },
      { type: "callout", tone: "exam", text: "`kubectl set resources deployment x --requests=cpu=100m --limits=memory=256Mi` é bem mais rápido que editar YAML." },
    ],
    quiz: [
      { q: "Um Pod está Running mas não recebe tráfego do Service. Qual probe está falhando?", options: ["livenessProbe", "readinessProbe", "startupProbe", "Nenhuma — é o kube-proxy"], answer: 1, explain: "Readiness reprovada remove o Pod dos Endpoints sem reiniciá-lo." },
      { q: "O container ultrapassa o limit de memória. O que acontece?", options: ["Fica lento", "É morto (OOMKilled) e reiniciado", "O nó ganha mais memória", "Nada"], answer: 1, explain: "Memória não é comprimível: acima do limit o kernel mata o processo. CPU acima do limit só sofre throttling." },
      { q: "Qual classe de QoS é despejada por último em pressão de memória?", options: ["BestEffort", "Burstable", "Guaranteed", "Todas iguais"], answer: 2, explain: "Guaranteed (requests = limits) tem a maior prioridade de permanência." },
    ],
  },
  {
    id: "learn-ckad-deploy-strategies",
    track: "ckad",
    title: "Estratégias de deploy: rolling, blue/green e canary",
    summary: "Como lançar versões novas com risco controlado.",
    minutes: 5,
    before: "ckad-canary",
    blocks: [
      {
        type: "table",
        head: ["Estratégia", "Como funciona", "Rollback"],
        rows: [
          ["Rolling update", "Troca Pods aos poucos (padrão do Deployment)", "`rollout undo`"],
          ["Recreate", "Derruba tudo e sobe a versão nova", "Novo deploy (com downtime)"],
          ["Blue/green", "Duas versões completas; o Service troca de uma vez", "Voltar o selector"],
          ["Canary", "Pequena fração do tráfego na versão nova", "Escalar a canary para 0"],
        ],
      },
      {
        type: "flow",
        steps: [
          { label: "v2 com 1 réplica", detail: "labels app=web, version=v2" },
          { label: "~25% do tráfego", detail: "Service seleciona só app=web" },
          { label: "Observar", detail: "erros e latência por version" },
          { label: "Promover", detail: "v2 → 3 réplicas, v1 → 0" },
        ],
      },
      { type: "text", text: "Com labels puros, a proporção do canary depende do número de réplicas. Para porcentagens precisas (1%, 5%) e promoção automática por métricas, use **Argo Rollouts**, **Flagger** ou um service mesh." },
      { type: "callout", tone: "tip", text: "Sempre suba a versão nova ANTES de reduzir a antiga — a capacidade total nunca deve cair durante a troca." },
      { type: "callout", tone: "exam", text: "Blue/green com Service: mude `spec.selector.version` de blue para green (`kubectl edit svc` ou `kubectl patch`). É uma questão frequente na CKAD." },
    ],
    quiz: [
      { q: "Com v1 em 3 réplicas e v2 em 1, atrás do mesmo Service, quanto tráfego vai para v2?", options: ["50%", "~25%", "100%", "0% até promover"], answer: 1, explain: "O kube-proxy distribui entre os 4 endpoints; 1 de 4 ≈ 25%." },
      { q: "Qual estratégia tem downtime por definição?", options: ["Rolling update", "Recreate", "Canary", "Blue/green"], answer: 1, explain: "Recreate derruba todos os Pods antes de subir os novos." },
      { q: "Qual ferramenta automatiza canary com análise de métricas?", options: ["kubectl scale", "Argo Rollouts", "kube-proxy", "CoreDNS"], answer: 1, explain: "Argo Rollouts (ou Flagger) faz o shift gradual e promove/aborta com base em métricas." },
    ],
  },
];
