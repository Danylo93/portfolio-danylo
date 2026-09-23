import type { Lesson } from "../types";

export const lessons: Lesson[] = [
  {
    id: "learn-cka-exame",
    track: "cka",
    title: "Como é a prova CKA (e como treinar para ela)",
    summary: "Formato, domínios, pesos e os atalhos que economizam minutos preciosos.",
    minutes: 5,
    before: "cka-etcd-backup-restore",
    blocks: [
      { type: "text", text: "A CKA é **100% prática**: cerca de 15–20 tarefas em ~2 horas, num terminal remoto com vários clusters. Nota mínima 66%. Você pode consultar a documentação oficial (kubernetes.io), mas não há tempo para ler do zero." },
      {
        type: "table",
        head: ["Domínio", "Peso aprox.", "Labs desta trilha"],
        rows: [
          ["Troubleshooting", "30%", "Scheduler quebrado, nó NotReady, Service sem endpoints"],
          ["Cluster Architecture, Installation & Configuration", "25%", "etcd backup/restore, upgrade com kubeadm, RBAC"],
          ["Services & Networking", "20%", "NetworkPolicy, Services"],
          ["Workloads & Scheduling", "15%", "Taints, tolerations, nodeSelector"],
          ["Storage", "10%", "PV, PVC, volumes"],
        ],
      },
      { type: "code", lang: "shell", code: "alias k=kubectl\nexport do=\"--dry-run=client -o yaml\"\nk run web --image=nginx $do > web.yaml\nk explain pod.spec.tolerations" },
      {
        type: "flow",
        steps: [
          { label: "Ler a questão", detail: "contexto, namespace, nomes exatos" },
          { label: "Gerar YAML", detail: "imperativo + --dry-run" },
          { label: "Editar", detail: "vi, só o necessário" },
          { label: "Aplicar", detail: "kubectl apply -f" },
          { label: "Validar", detail: "get/describe antes de seguir" },
        ],
      },
      { type: "callout", tone: "exam", text: "Pule questões longas e volte depois: todas valem pontos proporcionais ao peso, e uma questão de 4% não vale 20 minutos." },
      { type: "callout", tone: "warn", text: "O erro mais caro é resolver no contexto errado. Copie o `kubectl config use-context` do enunciado em TODA questão." },
    ],
    quiz: [
      { q: "Qual domínio tem o maior peso na CKA?", options: ["Storage", "Troubleshooting", "Services & Networking", "Workloads & Scheduling"], answer: 1, explain: "Troubleshooting (~30%) é o maior domínio — por isso esta trilha tem vários desafios de diagnóstico." },
      { q: "Qual a forma mais rápida de criar um manifesto de Pod na prova?", options: ["Escrever o YAML do zero", "Copiar da documentação e adaptar", "kubectl run … --dry-run=client -o yaml > arquivo", "kubectl edit"], answer: 2, explain: "Gerar o esqueleto imperativamente evita erros de indentação e economiza minutos." },
      { q: "O que fazer no início de cada questão?", options: ["Reiniciar o terminal", "Trocar para o contexto indicado", "Apagar os recursos antigos", "Rodar kubeadm reset"], answer: 1, explain: "Cada questão pode usar um cluster diferente; o contexto errado anula a resposta." },
    ],
  },
  {
    id: "learn-cka-etcd",
    track: "cka",
    title: "etcd: o coração do cluster",
    summary: "Por que o etcd importa, TLS mútuo e o fluxo correto de backup e restore.",
    minutes: 6,
    before: "cka-etcd-backup-restore",
    blocks: [
      { type: "text", text: "Tudo o que `kubectl get` mostra vem do etcd: Deployments, Secrets, RBAC, ConfigMaps. Perder o etcd sem backup significa reconstruir o cluster inteiro a partir de manifestos — se você os tiver." },
      {
        type: "flow",
        steps: [
          { label: "snapshot save", detail: "etcdctl + TLS → arquivo .db" },
          { label: "guardar fora", detail: "S3 com versionamento" },
          { label: "snapshot restore", detail: "etcdutl → data-dir NOVO" },
          { label: "apontar manifesto", detail: "hostPath do static pod" },
          { label: "validar", detail: "kubectl get em recursos conhecidos" },
        ],
      },
      {
        type: "table",
        head: ["Flag do etcdctl", "Onde achar o valor"],
        rows: [
          ["--endpoints", "`--listen-client-urls` em /etc/kubernetes/manifests/etcd.yaml"],
          ["--cacert", "`--trusted-ca-file`"],
          ["--cert", "`--cert-file`"],
          ["--key", "`--key-file`"],
        ],
      },
      { type: "code", lang: "shell", code: "ETCDCTL_API=3 etcdctl snapshot save /opt/backup.db \\\n  --endpoints=https://127.0.0.1:2379 \\\n  --cacert=/etc/kubernetes/pki/etcd/ca.crt \\\n  --cert=/etc/kubernetes/pki/etcd/server.crt \\\n  --key=/etc/kubernetes/pki/etcd/server.key\n\netcdutl snapshot restore /opt/backup.db --data-dir /var/lib/etcd-from-backup" },
      { type: "callout", tone: "warn", text: "Nunca restaure por cima do diretório em uso (/var/lib/etcd). Restaure em um diretório novo e troque o hostPath no manifesto — assim você ainda tem o original se algo der errado." },
      { type: "callout", tone: "tip", text: "No EKS o etcd é gerenciado pela AWS. Mesmo assim, faça backup dos objetos do cluster (Velero) e mantenha tudo em Git (GitOps) para recriar rápido." },
    ],
    quiz: [
      { q: "O erro \"context deadline exceeded\" no etcdctl geralmente indica…", options: ["Snapshot corrompido", "Falta dos certificados TLS / endpoint errado", "Disco cheio", "Versão errada do kubectl"], answer: 1, explain: "O etcd exige TLS mútuo; sem --cacert/--cert/--key corretos a conexão nunca completa." },
      { q: "Para onde restaurar o snapshot?", options: ["Por cima de /var/lib/etcd", "Para um data-dir novo, depois apontar o manifesto para ele", "Para /tmp e reiniciar o nó", "Para o diretório do kubelet"], answer: 1, explain: "Restaurar em diretório novo é seguro e reversível; o static pod passa a usar o novo caminho via hostPath." },
      { q: "Como o etcd do kubeadm é executado?", options: ["Como Deployment", "Como static pod definido em /etc/kubernetes/manifests", "Como serviço systemd no worker", "Como DaemonSet"], answer: 1, explain: "No kubeadm, etcd e os componentes do control plane são static pods lidos pelo kubelet a partir dessa pasta." },
    ],
  },
  {
    id: "learn-cka-upgrade",
    track: "cka",
    title: "Upgrades com kubeadm e version skew",
    summary: "A ordem que não pode ser quebrada e por que o kubelet vem por último.",
    minutes: 5,
    before: "cka-cluster-upgrade",
    blocks: [
      { type: "text", text: "Kubernetes lança uma minor a cada ~4 meses e cada uma recebe suporte por ~14 meses. Atualizar é rotina — e a ordem dos passos é o que separa um upgrade tranquilo de um incidente." },
      {
        type: "flow",
        steps: [
          { label: "kubeadm", detail: "atualizar o pacote primeiro" },
          { label: "drain", detail: "tirar as cargas do nó" },
          { label: "upgrade apply", detail: "control plane (1º nó) / upgrade node (demais)" },
          { label: "kubelet + kubectl", detail: "pacotes + daemon-reload + restart" },
          { label: "uncordon", detail: "devolver o nó ao cluster" },
        ],
      },
      {
        type: "table",
        head: ["Componente", "Pode ficar atrás do API server?"],
        rows: [
          ["kube-controller-manager / scheduler", "até 1 minor"],
          ["kubelet", "até 3 minors (nunca à frente)"],
          ["kubectl", "±1 minor"],
        ],
      },
      { type: "callout", tone: "warn", text: "Pular minors (1.29 → 1.31) não é suportado. Suba uma por vez, e control plane SEMPRE antes dos workers." },
      { type: "callout", tone: "tip", text: "No EKS o fluxo é igual em espírito: atualize o control plane (console/Terraform), depois os add-ons (CoreDNS, kube-proxy, VPC CNI) e por fim os node groups — com PodDisruptionBudgets protegendo as aplicações." },
    ],
    quiz: [
      { q: "O que deve ser atualizado primeiro?", options: ["O kubelet dos workers", "O pacote kubeadm do control plane", "O kubectl do seu notebook", "O CoreDNS"], answer: 1, explain: "O kubeadm precisa conhecer a versão alvo antes de orquestrar o upgrade do control plane." },
      { q: "Por que fazer drain antes de atualizar o kubelet?", options: ["Para liberar disco", "Para mover as cargas e evitar interrupção quando o kubelet reiniciar", "Porque o kubeadm exige", "Para apagar os DaemonSets"], answer: 1, explain: "Com o nó drenado, as aplicações rodam em outros nós enquanto você mexe neste." },
      { q: "Qual combinação respeita o version skew?", options: ["API server 1.30, kubelet 1.31", "API server 1.31, kubelet 1.29", "API server 1.29, kubelet 1.31", "API server 1.31, kubectl 1.28"], answer: 1, explain: "O kubelet pode ficar até 3 minors atrás, nunca à frente do API server." },
    ],
  },
  {
    id: "learn-cka-rbac",
    track: "cka",
    title: "RBAC: quem pode fazer o quê",
    summary: "Roles, ClusterRoles, bindings e o princípio do menor privilégio.",
    minutes: 5,
    before: "cka-rbac",
    blocks: [
      { type: "text", text: "Toda requisição ao API server passa por **autenticação** (quem é você?) e **autorização** (você pode?). O RBAC responde à segunda pergunta com quatro objetos." },
      {
        type: "table",
        head: ["Objeto", "Escopo", "O que faz"],
        rows: [
          ["Role", "namespace", "Lista de verbos × recursos permitidos"],
          ["ClusterRole", "cluster", "Idem, para o cluster todo ou recursos sem namespace (nodes, PVs)"],
          ["RoleBinding", "namespace", "Dá uma Role OU ClusterRole a sujeitos, só naquele namespace"],
          ["ClusterRoleBinding", "cluster", "Dá uma ClusterRole a sujeitos em todos os namespaces"],
        ],
      },
      {
        type: "flow",
        steps: [
          { label: "Sujeito", detail: "User, Group ou ServiceAccount" },
          { label: "Binding", detail: "RoleBinding / ClusterRoleBinding" },
          { label: "Role", detail: "verbs: get, list, create…" },
          { label: "Recursos", detail: "pods, deployments, secrets…" },
        ],
      },
      { type: "code", lang: "shell", code: "kubectl create role pod-reader --verb=get,list,watch --resource=pods -n dev\nkubectl create rolebinding jane-read --role=pod-reader --user=jane -n dev\nkubectl auth can-i delete pods -n dev --as jane   # no" },
      { type: "callout", tone: "tip", text: "RoleBinding + ClusterRole padrão (view/edit/admin) é o jeito mais limpo de dar acesso por namespace a times e pipelines." },
      { type: "callout", tone: "warn", text: "`list` em secrets permite ler o conteúdo de todos eles. Trate acesso a Secrets como acesso às senhas." },
    ],
    quiz: [
      { q: "Um RoleBinding pode referenciar uma ClusterRole?", options: ["Não, só Roles", "Sim, e as permissões valem só no namespace do binding", "Sim, e vale para o cluster todo", "Só se a ClusterRole for cluster-admin"], answer: 1, explain: "É o padrão para reutilizar ClusterRoles (view, edit) com escopo limitado a um namespace." },
      { q: "Como testar permissões de outro usuário sem ter as credenciais dele?", options: ["kubectl login --user", "kubectl auth can-i … --as usuário", "kubectl describe user", "Não é possível"], answer: 1, explain: "Impersonation (`--as`) pergunta ao API server se aquele sujeito pode realizar a ação." },
      { q: "Existe regra de \"deny\" no RBAC?", options: ["Sim, com verbs: [deny]", "Não — tudo é negado por padrão e as regras só somam permissões", "Sim, em ClusterRoles", "Só para ServiceAccounts"], answer: 1, explain: "RBAC é puramente aditivo." },
    ],
  },
  {
    id: "learn-cka-networkpolicy",
    track: "cka",
    title: "NetworkPolicy: firewall entre Pods",
    summary: "Isolamento por labels, default deny e as pegadinhas de YAML.",
    minutes: 6,
    before: "cka-networkpolicy",
    blocks: [
      { type: "text", text: "Por padrão, qualquer Pod fala com qualquer Pod. Uma **NetworkPolicy** seleciona Pods por label e, a partir daí, só permite o tráfego explicitamente listado." },
      {
        type: "flow",
        steps: [
          { label: "Sem policy", detail: "tudo liberado" },
          { label: "Policy seleciona o Pod", detail: "Pod fica isolado" },
          { label: "Regras ingress", detail: "somam origens permitidas" },
          { label: "Resultado", detail: "só o que foi listado entra" },
        ],
      },
      { type: "code", lang: "yaml", code: "spec:\n  podSelector:\n    matchLabels:\n      app: db\n  policyTypes: [Ingress]\n  ingress:\n  - from:\n    - podSelector:\n        matchLabels:\n          app: api\n    ports:\n    - port: 5432" },
      {
        type: "table",
        head: ["YAML de from", "Significado"],
        rows: [
          ["um item com podSelector E namespaceSelector", "AND: Pods com o label NAQUELES namespaces"],
          ["dois itens (dois hífens)", "OR: qualquer uma das origens"],
          ["from ausente", "qualquer origem (só as portas filtram)"],
          ["ingress ausente + policyTypes Ingress", "nada entra (default deny)"],
        ],
      },
      { type: "callout", tone: "warn", text: "NetworkPolicy só funciona se o CNI suportar (Calico, Cilium, VPC CNI com network policy ligado). Com um CNI sem suporte, as policies são aceitas e simplesmente ignoradas." },
      { type: "callout", tone: "exam", text: "Tráfego bloqueado por policy costuma dar TIMEOUT, não \"connection refused\". Na prova, teste com `wget --timeout=2` para não travar." },
    ],
    quiz: [
      { q: "Uma policy com podSelector app=db e policyTypes [Ingress], sem bloco ingress, faz o quê?", options: ["Libera tudo", "Bloqueia todo ingress nos Pods app=db", "Bloqueia egress", "É inválida"], answer: 1, explain: "Selecionar sem listar origens isola o Pod completamente para entrada." },
      { q: "Duas policies selecionam o mesmo Pod. Como elas se combinam?", options: ["A mais restritiva vence", "A mais recente vence", "As permissões se somam (união)", "Gera erro"], answer: 2, explain: "Policies são aditivas: o tráfego passa se QUALQUER policy aplicável o permitir." },
      { q: "Em `from`, podSelector e namespaceSelector no MESMO item significam…", options: ["OR", "AND", "Apenas namespaceSelector vale", "Erro de validação"], answer: 1, explain: "No mesmo item é AND; em itens separados é OR — a pegadinha mais comum." },
    ],
  },
  {
    id: "learn-cka-storage-scheduling",
    track: "cka",
    title: "Storage e scheduling: PV, PVC, taints e afinidade",
    summary: "Como dados sobrevivem aos Pods e como controlar onde cada Pod roda.",
    minutes: 6,
    before: "cka-storage",
    blocks: [
      { type: "heading", text: "Storage" },
      {
        type: "flow",
        steps: [
          { label: "StorageClass", detail: "como provisionar (ex.: gp3 no EBS)" },
          { label: "PersistentVolume", detail: "o disco" },
          { label: "PersistentVolumeClaim", detail: "o pedido: tamanho, modo, classe" },
          { label: "Pod", detail: "monta o claim em um caminho" },
        ],
      },
      {
        type: "table",
        head: ["accessMode", "Sigla", "Exemplo na AWS"],
        rows: [
          ["ReadWriteOnce", "RWO", "EBS (um nó por vez)"],
          ["ReadWriteMany", "RWX", "EFS (vários nós)"],
          ["ReadOnlyMany", "ROX", "Dados de referência"],
        ],
      },
      { type: "callout", tone: "warn", text: "PVC Pending quase sempre é: storageClassName diferente, accessMode incompatível ou PV menor que o pedido." },
      { type: "heading", text: "Scheduling" },
      { type: "list", items: ["**nodeSelector / nodeAffinity**: ATRAEM o Pod para nós com certos labels.", "**taints**: REPELEM Pods de um nó (NoSchedule, PreferNoSchedule, NoExecute).", "**tolerations**: PERMITEM que um Pod ignore um taint — mas não o atraem."] },
      { type: "callout", tone: "exam", text: "Nó dedicado = taint no nó + toleration e nodeSelector no Pod. Só a toleration não garante que o Pod vá para lá." },
    ],
    quiz: [
      { q: "Qual objeto representa o pedido de armazenamento feito pela aplicação?", options: ["PersistentVolume", "PersistentVolumeClaim", "StorageClass", "VolumeMount"], answer: 1, explain: "O PVC é o pedido; o PV é o disco que atende ao pedido." },
      { q: "Um Pod com toleration para dedicated=db, sem nodeSelector, vai…", options: ["Sempre para o nó com o taint", "Para qualquer nó que ele tolere, inclusive os sem taint", "Ficar Pending", "Ser rejeitado"], answer: 1, explain: "Toleration só remove a repulsão; quem atrai é nodeSelector/afinidade." },
      { q: "EBS na AWS suporta qual accessMode?", options: ["ReadWriteMany", "ReadWriteOnce", "ReadOnlyMany apenas", "Todos"], answer: 1, explain: "Volumes EBS são anexados a uma instância por vez (RWO). Para RWX use EFS." },
    ],
  },
];
