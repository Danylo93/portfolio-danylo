import "../k8s/kubectl";
import "../k8s/controlplane";
import type { Shell } from "../shell";
import type { Lab, Track } from "../types";
import {
  CP_NODE, can, controlPlaneVersion, createDeployment, createService, etcdState, findDeployment, findObj, findService, endpoints,
  nodeReady, podReady, pvcStatus, schedulerHealthy, staticPodYaml, trafficAllowed,
} from "../k8s/cluster";

export const track: Track = {
  id: "cka",
  title: "CKA · Certified Kubernetes Administrator",
  desc: "Tarefas no formato da prova CKA: backup e restore do etcd, upgrade com kubeadm, RBAC, troubleshooting de control plane e de nós, NetworkPolicy, storage e scheduling — com cronômetro e sem colar.",
  color: "#3b82f6",
  icon: "🎓",
  badge: "Certificação",
};

const ETCD_SAVE =
  "etcdctl snapshot save /opt/etcd-backup.db --endpoints=https://127.0.0.1:2379 --cacert=/etc/kubernetes/pki/etcd/ca.crt --cert=/etc/kubernetes/pki/etcd/server.crt --key=/etc/kubernetes/pki/etcd/server.key";

const podsOf = (sh: Shell, prefix: string, ns = "default") => sh.state.pods.filter((p) => p.namespace === ns && p.name.startsWith(prefix));
const pod = (sh: Shell, name: string, ns = "default") => sh.state.pods.find((p) => p.name === name && p.namespace === ns);
const hasFlag = (sh: Shell, re: RegExp) => [...sh.flags].some((f) => re.test(f));

const NETPOL_EXAMPLE = `# Exemplo da documentação (adapte labels e portas!)
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: exemplo
spec:
  podSelector:
    matchLabels:
      role: backend
  policyTypes:
  - Ingress
  ingress:
  - from:
    - podSelector:
        matchLabels:
          role: frontend
    ports:
    - protocol: TCP
      port: 8080
`;

const DB_DENY = `apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: db-deny-all
spec:
  podSelector:
    matchLabels:
      app: db
  policyTypes:
  - Ingress
`;

const DB_ALLOW = `apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: db-allow-api
spec:
  podSelector:
    matchLabels:
      app: db
  policyTypes:
  - Ingress
  ingress:
  - from:
    - podSelector:
        matchLabels:
          app: api
    ports:
    - protocol: TCP
      port: 5678
`;

export const PV_YAML = `apiVersion: v1
kind: PersistentVolume
metadata:
  name: task-pv
spec:
  capacity:
    storage: 1Gi
  accessModes:
  - ReadWriteOnce
  storageClassName: manual
  hostPath:
    path: /mnt/data
`;

export const PVC_YAML = `apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: task-pvc
spec:
  accessModes:
  - ReadWriteOnce
  storageClassName: manual
  resources:
    requests:
      storage: 500Mi
`;

export const PV_POD_YAML = `apiVersion: v1
kind: Pod
metadata:
  name: web-pv
spec:
  containers:
  - name: web
    image: nginx:1.25
    volumeMounts:
    - name: html
      mountPath: /usr/share/nginx/html
  volumes:
  - name: html
    persistentVolumeClaim:
      claimName: task-pvc
`;

export const labs: Lab[] = [
  // ------------------------------------------------------------------ etcd
  {
    id: "cka-etcd-backup-restore",
    track: "cka",
    kind: "challenge",
    title: "Backup e restore do etcd",
    summary: "Snapshot com TLS, desastre simulado e restauração apontando o static pod para o novo data-dir.",
    level: "Avançado",
    minutes: 15,
    skills: ["etcdctl snapshot", "etcdutl restore", "static pods"],
    seed: {
      setup: (sh) => {
        createDeployment(sh, { name: "payments", image: "nginx:1.25", replicas: 3, createdAt: Date.now() - 3600_000 });
        createService(sh, { name: "payments", port: 80, selector: { app: "payments" } });
      },
    },
    intro: "Tarefa clássica da CKA (≈7% da nota). O etcd guarda TODO o estado do cluster: sem backup, um delete errado ou um disco corrompido significa recriar tudo do zero. Você vai fazer o snapshot, simular um desastre e restaurar.",
    steps: [
      {
        title: "Descobrir endpoints e certificados",
        body: ["O etcd roda como static pod no control-plane e exige TLS mútuo. Os caminhos dos certificados estão no manifesto dele — descubra-os."],
        code: ["cat /etc/kubernetes/manifests/etcd.yaml"],
        hints: [
          "Static pods são definidos por arquivos YAML em /etc/kubernetes/manifests. O kubelet os lê direto do disco.",
          "Leia o manifesto do etcd (ou filtre com grep): procure --cert-file, --key-file, --trusted-ca-file e --listen-client-urls.",
          "cat /etc/kubernetes/manifests/etcd.yaml",
        ],
        explain: [
          "trusted-ca-file → --cacert, cert-file → --cert, key-file → --key e listen-client-urls → --endpoints. Na prova, copie esses caminhos daqui em vez de decorar.",
          "Dica de prova: grep -E 'cert|key|listen-client' /etc/kubernetes/manifests/etcd.yaml mostra só o que importa em 1 segundo.",
        ],
        check: (sh) => sh.ran(/(cat|grep|less|vi|vim).*\/etc\/kubernetes\/manifests\/etcd\.yaml/),
      },
      {
        title: "Fazer o snapshot",
        body: ["Salve um snapshot do etcd em /opt/etcd-backup.db usando o endpoint local e os três certificados."],
        code: [ETCD_SAVE, "etcdctl snapshot status /opt/etcd-backup.db -w table"],
        hints: [
          "O subcomando é snapshot save <arquivo>. Sem os certificados, a conexão TLS falha com \"context deadline exceeded\".",
          "etcdctl snapshot save /opt/etcd-backup.db --endpoints=https://127.0.0.1:2379 --cacert=<ca> --cert=<server.crt> --key=<server.key>",
          ETCD_SAVE,
        ],
        explain: [
          "O snapshot é uma cópia consistente do banco (bbolt) do etcd: Deployments, Secrets, RBAC, tudo. Em versões antigas era preciso ETCDCTL_API=3; no etcdctl 3.5 a API v3 já é o padrão (mas colocar não faz mal).",
          "Em produção: automatize (CronJob/systemd timer), mande para armazenamento externo (S3 com versionamento) e TESTE o restore periodicamente — backup nunca testado não é backup.",
        ],
        diagnose: (sh) => {
          const last = [...sh.entries].reverse().find((e) => /etcdctl/.test(e.cmd));
          if (last && !/snapshot save/.test(last.cmd)) return "Use o subcomando snapshot save seguido do caminho /opt/etcd-backup.db.";
          if (last && !/\/opt\/etcd-backup\.db/.test(last.cmd)) return "O snapshot precisa ser salvo exatamente em /opt/etcd-backup.db (a prova corrige pelo caminho!).";
          return null;
        },
        check: (sh) => !!etcdState(sh).snapshots["/opt/etcd-backup.db"],
      },
      {
        title: "Simular o desastre",
        body: ["Um engenheiro apagou o Deployment payments por engano. Reproduza o incidente apagando-o você mesmo."],
        code: ["kubectl delete deployment payments"],
        hints: ["Apague o Deployment payments no namespace default.", "kubectl delete deployment <nome>", "kubectl delete deployment payments"],
        explain: [
          "O ReplicaSet e os Pods foram removidos em cascata (garbage collection pelos ownerReferences).",
          "Sem GitOps nem backup, esse é o pior cenário: o estado só existia no etcd. Com o snapshot em mãos, dá para voltar no tempo.",
        ],
        check: (sh) => !findDeployment(sh, "payments") && !!etcdState(sh).snapshots["/opt/etcd-backup.db"],
      },
      {
        title: "Restaurar o snapshot",
        body: ["Restaure /opt/etcd-backup.db para um diretório NOVO: /var/lib/etcd-from-backup."],
        code: ["etcdutl snapshot restore /opt/etcd-backup.db --data-dir /var/lib/etcd-from-backup"],
        hints: [
          "O restore é offline: ele cria um novo diretório de dados a partir do snapshot. Nunca restaure por cima do diretório em uso.",
          "etcdutl snapshot restore <arquivo> --data-dir <novo-diretório> (etcdctl snapshot restore também funciona, com aviso de depreciação)",
          "etcdutl snapshot restore /opt/etcd-backup.db --data-dir /var/lib/etcd-from-backup",
        ],
        explain: [
          "O restore gera um novo membro etcd (member/snap e member/wal) em /var/lib/etcd-from-backup. O etcd em execução ainda aponta para o diretório antigo — nada mudou no cluster ainda.",
          "Restore não precisa de certificados porque não conversa com o servidor: é uma operação de arquivo.",
        ],
        check: (sh) => !!etcdState(sh).restored["/var/lib/etcd-from-backup"],
      },
      {
        title: "Apontar o etcd para os dados restaurados",
        body: [
          "Edite /etc/kubernetes/manifests/etcd.yaml e troque o hostPath do volume etcd-data para /var/lib/etcd-from-backup. O kubelet recria o static pod sozinho.",
          "Depois confirme que o Deployment payments voltou.",
        ],
        code: ["vi /etc/kubernetes/manifests/etcd.yaml", "kubectl get deployments"],
        hints: [
          "O container do etcd lê /var/lib/etcd, que é montado a partir de um hostPath no nó. Basta mudar o caminho no HOST.",
          "No bloco volumes, no item name: etcd-data, altere hostPath.path de /var/lib/etcd para /var/lib/etcd-from-backup e salve (Ctrl+S).",
          "volumes:\n- hostPath:\n    path: /var/lib/etcd-from-backup\n    type: DirectoryOrCreate\n  name: etcd-data",
        ],
        explain: [
          "Ao salvar, o kubelet detectou a mudança no manifesto, recriou o static pod do etcd com o novo volume e o API server passou a ler o estado restaurado — payments voltou com as 3 réplicas.",
          "Na prova, o API server fica indisponível por ~1 minuto durante a troca; use watch crictl ps ou kubectl get pods -n kube-system até tudo voltar.",
        ],
        diagnose: (sh) => {
          const m = sh.readFile("/etc/kubernetes/manifests/etcd.yaml") ?? "";
          if (!m.includes("/var/lib/etcd-from-backup")) return "O manifesto ainda aponta o volume etcd-data para /var/lib/etcd. Edite o hostPath.path com vi e salve.";
          return null;
        },
        check: (sh) => etcdState(sh).dataDir === "/var/lib/etcd-from-backup" && !!findDeployment(sh, "payments"),
      },
    ],
    outro: "Backup e restore do etcd dominados. Lembre na prova: caminhos exatos, restore em diretório novo e hostPath no manifesto do static pod.",
  },

  // ------------------------------------------------------------------ upgrade
  {
    id: "cka-cluster-upgrade",
    track: "cka",
    kind: "challenge",
    title: "Upgrade do cluster com kubeadm (1.30 → 1.31)",
    summary: "kubeadm primeiro, drain, upgrade apply, kubelet/kubectl e uncordon — na ordem certa.",
    level: "Avançado",
    minutes: 15,
    skills: ["kubeadm upgrade", "kubectl drain", "version skew"],
    seed: { seedDeployments: [{ name: "api", image: "nginx:1.25", replicas: 3, ageSec: 7200 }] },
    intro: "O control-plane lab-control-plane está em v1.30.0. Atualize-o para v1.31.0 seguindo o procedimento oficial: a ordem importa, e pular etapas é o erro mais comum na prova.",
    steps: [
      {
        title: "Planejar o upgrade",
        body: ["Veja a versão atual do cluster e para qual versão dá para ir."],
        code: ["kubeadm upgrade plan"],
        hints: ["O kubeadm tem um modo que só verifica, sem alterar nada.", "kubeadm upgrade <ação> — a ação de simulação é plan.", "kubeadm upgrade plan"],
        explain: [
          "O plan mostra a versão do cluster (v1.30.0), do kubeadm instalado e o alvo (v1.31.0), além dos componentes que serão atualizados (API server, controller-manager, scheduler, kube-proxy, CoreDNS, etcd).",
          "Repare no aviso: o próprio kubeadm precisa ser atualizado ANTES. Upgrades são sempre de uma minor por vez (1.30 → 1.31 → 1.32).",
        ],
        check: (sh) => sh.ran(/^kubeadm upgrade plan/),
      },
      {
        title: "Atualizar o pacote kubeadm",
        body: ["Instale o kubeadm 1.31.0-1.1 no control-plane."],
        code: ["apt-get install -y kubeadm=1.31.0-1.1", "kubeadm version"],
        hints: [
          "O binário do kubeadm vem de um pacote apt. A versão do pacote segue o formato 1.31.0-1.1.",
          "apt-get install -y <pacote>=<versão> (na prova, antes rode apt-mark unhold kubeadm)",
          "apt-get install -y kubeadm=1.31.0-1.1",
        ],
        explain: [
          "Agora o kubeadm conhece os manifests e as imagens da 1.31. Os pacotes costumam estar marcados com apt-mark hold para não atualizarem sozinhos — por isso a doc oficial faz unhold → install → hold.",
          "Confira com kubeadm version antes de seguir: GitVersion deve ser v1.31.0.",
        ],
        check: (sh) => (sh.state.hosts[CP_NODE].packages.kubeadm ?? "").startsWith("1.31.0"),
      },
      {
        title: "Drenar o control-plane",
        body: ["Tire as cargas do nó antes de mexer nele. Pods de DaemonSet ficam."],
        code: ["kubectl drain lab-control-plane --ignore-daemonsets"],
        hints: [
          "Drain = cordon (bloqueia novos Pods) + eviction dos Pods existentes.",
          "kubectl drain <nó> — DaemonSets (kube-proxy, CNI) não podem ser despejados, então use a flag que os ignora.",
          "kubectl drain lab-control-plane --ignore-daemonsets",
        ],
        explain: [
          "O nó ficou SchedulingDisabled e os Pods do CoreDNS foram despejados e reagendados nos workers — o DNS do cluster não parou.",
          "Em produção, PodDisruptionBudgets controlam quantas réplicas podem cair ao mesmo tempo durante um drain.",
        ],
        check: (sh) => !sh.state.nodes.find((n) => n.name === CP_NODE)!.schedulable,
      },
      {
        title: "Aplicar o upgrade do control plane",
        body: ["Atualize os componentes do control plane para v1.31.0."],
        code: ["kubeadm upgrade apply v1.31.0"],
        hints: ["Agora sim: a ação que efetivamente atualiza.", "kubeadm upgrade apply <versão>", "kubeadm upgrade apply v1.31.0"],
        explain: [
          "O kubeadm reescreveu os manifests em /etc/kubernetes/manifests com as imagens v1.31.0 e o kubelet recriou os static pods, um por vez. Também atualizou kube-proxy e CoreDNS.",
          "Nos workers o comando é diferente: kubeadm upgrade node.",
        ],
        diagnose: (sh) =>
          !(sh.state.hosts[CP_NODE].packages.kubeadm ?? "").startsWith("1.31") ? "O kubeadm instalado ainda é 1.30 — volte ao passo 2." : null,
        check: (sh) => controlPlaneVersion(sh) === "v1.31.0",
      },
      {
        title: "Atualizar kubelet e kubectl",
        body: ["O nó ainda reporta v1.30.0 (quem reporta é o kubelet). Atualize kubelet e kubectl e reinicie o kubelet."],
        code: ["apt-get install -y kubelet=1.31.0-1.1 kubectl=1.31.0-1.1", "systemctl daemon-reload", "systemctl restart kubelet"],
        hints: [
          "A coluna VERSION de kubectl get nodes mostra a versão do kubelet, não do control plane.",
          "Instale os dois pacotes na versão 1.31.0-1.1, depois systemctl daemon-reload e systemctl restart kubelet.",
          "apt-get install -y kubelet=1.31.0-1.1 kubectl=1.31.0-1.1 && systemctl daemon-reload && systemctl restart kubelet",
        ],
        explain: [
          "Após o restart, o kubelet passou a reportar v1.31.0. O daemon-reload é necessário porque o pacote pode trazer mudanças no unit file do systemd.",
          "Version skew: o kubelet pode ficar até 3 minors atrás do API server, mas nunca à frente — por isso o control plane vem primeiro.",
        ],
        diagnose: (sh) => {
          const host = sh.state.hosts[CP_NODE];
          if (!(host.packages.kubelet ?? "").startsWith("1.31")) return "O pacote kubelet ainda está em 1.30. Instale kubelet=1.31.0-1.1.";
          return "O pacote foi atualizado, mas o kubelet em execução ainda é o antigo: rode systemctl daemon-reload e systemctl restart kubelet.";
        },
        check: (sh) => sh.state.nodes.find((n) => n.name === CP_NODE)!.version === "v1.31.0",
      },
      {
        title: "Liberar o nó",
        body: ["Volte a permitir agendamento no control-plane e confira as versões."],
        code: ["kubectl uncordon lab-control-plane", "kubectl get nodes"],
        hints: ["O oposto de cordon.", "kubectl uncordon <nó>", "kubectl uncordon lab-control-plane"],
        explain: [
          "lab-control-plane está Ready, agendável e em v1.31.0. Os workers seguem em v1.30.0 — o próximo passo seria repetir o processo em cada um (drain → kubeadm upgrade node → kubelet → uncordon).",
          "Checklist de prova: 1) kubeadm 2) drain 3) upgrade apply/node 4) kubelet+kubectl 5) daemon-reload+restart 6) uncordon.",
        ],
        check: (sh) => {
          const n = sh.state.nodes.find((x) => x.name === CP_NODE)!;
          return n.schedulable && n.version === "v1.31.0";
        },
      },
    ],
    outro: "Control plane atualizado sem downtime das aplicações. É exatamente o fluxo de um upgrade de EKS/self-managed em produção.",
  },

  // ------------------------------------------------------------------ RBAC
  {
    id: "cka-rbac",
    track: "cka",
    kind: "lab",
    title: "RBAC: acesso mínimo para pessoas e pipelines",
    summary: "Role, RoleBinding, ServiceAccount e kubectl auth can-i.",
    level: "Intermediário",
    minutes: 12,
    skills: ["Role", "RoleBinding", "auth can-i", "ServiceAccount"],
    seed: {
      setup: (sh) => {
        sh.state.namespaces.push({ name: "dev", createdAt: Date.now() - 86_400_000 });
        createDeployment(sh, { name: "api", image: "nginx:1.25", replicas: 2, namespace: "dev", createdAt: Date.now() - 3600_000 });
      },
    },
    intro: "A desenvolvedora jane precisa apenas LER Pods no namespace dev, e o pipeline de CD precisa fazer deploy no mesmo namespace. Princípio do menor privilégio: nada de cluster-admin.",
    steps: [
      {
        title: "Criar a Role somente leitura",
        body: ["Crie a Role pod-reader no namespace dev com os verbos get, list e watch em pods."],
        code: ["kubectl create role pod-reader --verb=get,list,watch --resource=pods -n dev"],
        hints: [
          "Role = conjunto de permissões (verbos × recursos) dentro de UM namespace.",
          "kubectl create role <nome> --verb=<v1,v2> --resource=<recurso> -n <ns>",
          "kubectl create role pod-reader --verb=get,list,watch --resource=pods -n dev",
        ],
        explain: [
          "A Role sozinha não dá acesso a ninguém: ela só descreve permissões. Quem recebe é definido pelo binding.",
          "Para permissões que valem no cluster todo (ou para recursos sem namespace, como nodes), use ClusterRole.",
        ],
        diagnose: (sh) => {
          if (findObj(sh, "Role", "pod-reader", "default")) return "Você criou a Role no namespace default. Ela precisa estar em dev (-n dev).";
          const r = findObj(sh, "Role", "pod-reader", "dev");
          if (r && (r.manifest.rules[0].verbs as string[]).some((v) => ["delete", "create", "*"].includes(v))) return "A Role tem verbos demais — somente get, list e watch.";
          return null;
        },
        check: (sh) => {
          const r = findObj(sh, "Role", "pod-reader", "dev");
          const rule = r?.manifest.rules?.[0];
          return !!rule && ["get", "list", "watch"].every((v) => rule.verbs.includes(v)) && rule.resources.includes("pods") && !rule.verbs.includes("delete");
        },
      },
      {
        title: "Vincular a Role à jane",
        body: ["Crie o RoleBinding jane-pod-reader ligando a Role pod-reader à usuária jane no namespace dev."],
        code: ["kubectl create rolebinding jane-pod-reader --role=pod-reader --user=jane -n dev"],
        hints: ["O binding liga uma Role a sujeitos (User, Group ou ServiceAccount).", "kubectl create rolebinding <nome> --role=<role> --user=<usuário> -n <ns>", "kubectl create rolebinding jane-pod-reader --role=pod-reader --user=jane -n dev"],
        explain: [
          "Agora jane pode get/list/watch pods em dev — e nada mais. Usuários não existem como objeto no Kubernetes: a identidade vem do certificado (CN) ou do provedor OIDC (ex.: IAM no EKS).",
          "No EKS, o mapeamento IAM → usuário/grupo Kubernetes é feito pelo aws-auth ConfigMap ou pelas Access Entries.",
        ],
        check: (sh) => {
          const b = findObj(sh, "RoleBinding", "jane-pod-reader", "dev");
          return !!b && b.manifest.roleRef.name === "pod-reader" && b.manifest.subjects.some((s: { kind: string; name: string }) => s.kind === "User" && s.name === "jane");
        },
      },
      {
        title: "Testar as permissões",
        body: ["Confirme que jane consegue listar pods em dev e NÃO consegue apagá-los."],
        code: ["kubectl auth can-i list pods -n dev --as jane", "kubectl auth can-i delete pods -n dev --as jane"],
        hints: ["Você pode se passar por outro usuário para testar RBAC sem ter as credenciais dele.", "kubectl auth can-i <verbo> <recurso> -n <ns> --as <usuário>", "kubectl auth can-i list pods -n dev --as jane"],
        explain: [
          "yes para list e no para delete: RBAC é aditivo e nega por padrão. Não existe regra de \"deny\" — o que não foi permitido está proibido.",
          "kubectl auth can-i --list --as jane -n dev mostra tudo o que ela pode fazer. Ótimo para auditorias.",
        ],
        check: (sh) => sh.ran(/auth can-i (list|get|watch) pods.*--as[= ]jane/) && sh.ran(/auth can-i (delete|create|update|patch) pods.*--as[= ]jane/),
        diagnose: (sh) => (sh.ran(/auth can-i (list|get|watch) pods.*--as[= ]jane/) ? "Falta o teste negativo: confirme que ela NÃO pode apagar pods (can-i delete)." : null),
      },
      {
        title: "Permissão para o pipeline (ServiceAccount)",
        body: [
          "Crie a ServiceAccount deployer em dev e dê a ela a ClusterRole padrão edit, mas só dentro de dev (use um RoleBinding).",
          "Valide que ela pode criar deployments em dev.",
        ],
        code: [
          "kubectl create serviceaccount deployer -n dev",
          "kubectl create rolebinding deployer-edit --clusterrole=edit --serviceaccount=dev:deployer -n dev",
          "kubectl auth can-i create deployments -n dev --as=system:serviceaccount:dev:deployer",
        ],
        hints: [
          "Um RoleBinding pode referenciar uma ClusterRole: as permissões dela passam a valer só naquele namespace.",
          "--serviceaccount=<namespace>:<nome>. Para testar, a identidade de uma SA é system:serviceaccount:<ns>:<nome>.",
          "kubectl create rolebinding deployer-edit --clusterrole=edit --serviceaccount=dev:deployer -n dev",
        ],
        explain: [
          "Reusar ClusterRoles padrão (view, edit, admin) com RoleBindings por namespace é o padrão mais limpo para times e pipelines.",
          "No GitHub Actions/ArgoCD, prefira identidades de curta duração (OIDC/IRSA) a tokens estáticos de ServiceAccount.",
        ],
        diagnose: (sh) => (!findObj(sh, "ServiceAccount", "deployer", "dev") ? "A ServiceAccount deployer ainda não existe em dev." : null),
        check: (sh) => !!findObj(sh, "ServiceAccount", "deployer", "dev") && can(sh, "system:serviceaccount:dev:deployer", "create", "deployments", "dev") && !can(sh, "system:serviceaccount:dev:deployer", "create", "deployments", "default"),
      },
    ],
    outro: "Menor privilégio aplicado para pessoas e máquinas. Esse é um dos temas que mais caem na CKA e na CKS.",
  },

  // ------------------------------------------------------------------ scheduler
  {
    id: "cka-troubleshoot-scheduler",
    track: "cka",
    kind: "challenge",
    title: "Troubleshooting: Pods presos em Pending",
    summary: "Nenhum evento, nenhum nó escolhido… o problema está no control plane.",
    level: "Avançado",
    minutes: 12,
    skills: ["control plane", "static pods", "kube-scheduler"],
    seed: {
      setup: (sh) => {
        sh.writeFile("/etc/kubernetes/manifests/kube-scheduler.yaml", staticPodYaml("kube-scheduler").replace("--kubeconfig=/etc/kubernetes/scheduler.conf", "--kubeconfig=/etc/kubernetes/scheduler.conff"));
        createDeployment(sh, { name: "frontend", image: "nginx:1.25", replicas: 2, createdAt: Date.now() - 180_000 });
      },
    },
    intro: "🚨 O time de produto aplicou o Deployment frontend há 3 minutos e nada subiu. Não há erro de imagem, nem falta de recurso. Investigue do sintoma até a causa raiz.",
    steps: [
      {
        title: "Observar o sintoma",
        body: ["Liste os Pods e veja em que estado estão."],
        code: ["kubectl get pods -o wide"],
        hints: ["Comece sempre pelo estado dos Pods.", "kubectl get pods (com -o wide você vê o NODE).", "kubectl get pods -o wide"],
        explain: [
          "STATUS Pending e NODE <none>: nenhum nó foi escolhido. Pending sem nó significa problema de agendamento — não é imagem nem aplicação.",
          "As causas mais comuns: falta de CPU/memória, taints, nodeSelector/afinidade, PVC não vinculado… ou o próprio scheduler fora do ar.",
        ],
        check: (sh) => sh.ran(/^(kubectl|k) get (pods?|po|all)\b/),
      },
      {
        title: "Procurar a razão nos eventos",
        body: ["Descreva um dos Pods do frontend e leia a seção Events."],
        code: ["kubectl describe pod <nome-do-pod>"],
        hints: ["Quando o scheduler recusa um Pod, ele registra um evento FailedScheduling dizendo por quê.", "kubectl describe pod frontend-… (Tab completa o nome)", "kubectl describe pod frontend-xxxxxxxxx-xxxxx (troque pelo nome real)"],
        explain: [
          "Events: <none>. Se o scheduler estivesse rodando e recusasse o Pod, haveria um FailedScheduling explicando o motivo. O silêncio é a pista: ninguém está avaliando esse Pod.",
          "Regra de troubleshooting: Pending + nenhum evento → verifique o kube-scheduler no namespace kube-system.",
        ],
        check: (sh) => sh.ran(/(kubectl|k) describe (pods?|po)[ /]frontend-/),
      },
      {
        title: "Checar o control plane",
        body: ["Liste os Pods do namespace kube-system."],
        code: ["kubectl get pods -n kube-system"],
        hints: ["Os componentes do control plane rodam como Pods no namespace do sistema.", "kubectl get pods -n <namespace-do-sistema>", "kubectl get pods -n kube-system"],
        explain: [
          "kube-scheduler-lab-control-plane está em CrashLoopBackOff. O control plane deste cluster (kubeadm) roda como static pods gerenciados diretamente pelo kubelet do nó.",
          "Por serem static pods, kubectl delete não resolve: o kubelet recria a partir do arquivo em /etc/kubernetes/manifests.",
        ],
        check: (sh) => sh.ran(/(kubectl|k) get (pods?|po|all).*(-n kube-system|--namespace[= ]kube-system|-A|--all-namespaces)/),
      },
      {
        title: "Ler os logs do scheduler",
        body: ["Veja os logs do Pod kube-scheduler-lab-control-plane para achar a causa."],
        code: ["kubectl logs kube-scheduler-lab-control-plane -n kube-system"],
        hints: ["O container sobe e morre: os logs dizem o porquê.", "kubectl logs <pod> -n kube-system", "kubectl logs kube-scheduler-lab-control-plane -n kube-system"],
        explain: [
          "stat /etc/kubernetes/scheduler.conff: no such file or directory — o flag --kubeconfig tem um typo (conff). Sem kubeconfig, o scheduler não consegue falar com o API server e encerra.",
          "Se o API server também estivesse fora, kubectl não funcionaria: aí você usaria crictl ps -a e crictl logs direto no nó.",
        ],
        check: (sh) => sh.ran(/(kubectl|k) logs .*kube-scheduler/),
      },
      {
        title: "Corrigir o manifesto",
        body: ["Corrija o caminho em /etc/kubernetes/manifests/kube-scheduler.yaml e confirme que o frontend sobe."],
        code: ["vi /etc/kubernetes/manifests/kube-scheduler.yaml", "kubectl get pods"],
        hints: [
          "O kubelet observa a pasta de manifests: basta salvar o arquivo corrigido.",
          "Procure a linha com --kubeconfig= e deixe exatamente /etc/kubernetes/scheduler.conf.",
          "- --kubeconfig=/etc/kubernetes/scheduler.conf",
        ],
        explain: [
          "O kubelet recriou o scheduler, que imediatamente agendou os Pods pendentes: frontend ficou Running nos workers.",
          "Esse tipo de quebra (typo em flag/caminho/imagem de static pod) é figurinha carimbada na CKA. Sempre compare com os outros manifests da pasta.",
        ],
        diagnose: (sh) => {
          const m = sh.readFile("/etc/kubernetes/manifests/kube-scheduler.yaml") ?? "";
          if (m.includes("scheduler.conff")) return "O manifesto ainda tem --kubeconfig=/etc/kubernetes/scheduler.conff (com dois f).";
          if (!schedulerHealthy(sh)) return "O scheduler ainda não está saudável — confira o YAML (indentação, comando kube-scheduler e imagem).";
          return "O scheduler voltou; aguarde alguns segundos os Pods ficarem Running e verifique de novo.";
        },
        check: (sh) => schedulerHealthy(sh) && sh.deploymentReady("frontend"),
      },
    ],
    outro: "Causa raiz: typo no kubeconfig do kube-scheduler. Método: sintoma → eventos → componentes → logs → correção → validação.",
  },

  // ------------------------------------------------------------------ node NotReady
  {
    id: "cka-node-notready",
    track: "cka",
    kind: "challenge",
    title: "Troubleshooting: nó NotReady",
    summary: "ssh no worker, systemd e kubelet.",
    level: "Intermediário",
    minutes: 10,
    skills: ["kubelet", "systemctl", "journalctl"],
    seed: {
      setup: (sh) => {
        const k = sh.state.hosts["lab-worker2"].services.kubelet;
        k.active = false;
        k.enabled = false;
        k.logs.push("systemd[1]: Stopped kubelet.service - kubelet: The Kubernetes Node Agent.", "systemd[1]: kubelet.service: Deactivated successfully.");
        createDeployment(sh, { name: "web", image: "nginx:1.25", replicas: 4, createdAt: Date.now() - 600_000 });
      },
    },
    intro: "🚨 O monitoramento acusou que lab-worker2 parou de receber Pods e toda a carga está concentrada em lab-worker. Descubra o que houve com o nó e traga-o de volta.",
    steps: [
      {
        title: "Ver o estado dos nós",
        body: ["Liste os nós do cluster."],
        code: ["kubectl get nodes"],
        hints: ["Qual nó não está Ready?", "kubectl get nodes", "kubectl get nodes"],
        explain: [
          "lab-worker2 está NotReady: o API server não recebe heartbeats dele. O scheduler deixa de enviar Pods para lá, e após ~5 min Pods existentes seriam despejados.",
          "Por isso todas as réplicas do web estão em lab-worker — um único ponto de falha.",
        ],
        check: (sh) => sh.ran(/^(kubectl|k) get (nodes?|no)\b/),
      },
      {
        title: "Entender o motivo",
        body: ["Descreva o nó lab-worker2 e leia as Conditions."],
        code: ["kubectl describe node lab-worker2"],
        hints: ["As Conditions do nó dizem o que o control plane sabe sobre ele.", "kubectl describe node <nome>", "kubectl describe node lab-worker2"],
        explain: [
          "\"Kubelet stopped posting node status\": o problema está NO nó, no agente kubelet — não na rede do cluster nem no control plane.",
          "Taints node.kubernetes.io/unreachable foram adicionados automaticamente para afastar novos Pods.",
        ],
        check: (sh) => sh.ran(/(kubectl|k) describe (nodes?|no)[ /]lab-worker2/),
      },
      {
        title: "Acessar o nó",
        body: ["Conecte-se via SSH ao lab-worker2."],
        code: ["ssh lab-worker2"],
        hints: ["O kubelet é um serviço do sistema operacional do nó; é preciso entrar nele.", "ssh <nome-do-nó>", "ssh lab-worker2"],
        explain: ["Repare que o prompt mudou para danylo@lab-worker2 — os próximos comandos rodam no worker.", "Na prova, cada questão diz em qual nó trabalhar; sempre confira o hostname antes de alterar algo."],
        check: (sh) => sh.ran(/^ssh .*lab-worker2/),
      },
      {
        title: "Diagnosticar o kubelet",
        body: ["Verifique o status do serviço kubelet (e, se quiser, os logs com journalctl)."],
        code: ["systemctl status kubelet", "journalctl -u kubelet -n 20"],
        hints: ["O kubelet é gerenciado pelo systemd.", "systemctl status <serviço>", "systemctl status kubelet"],
        explain: [
          "inactive (dead) e disabled: alguém parou o kubelet e desabilitou o start no boot (comum depois de manutenção esquecida).",
          "Se estivesse em loop de falha, journalctl -u kubelet mostraria o erro: certificado expirado, config inválida em /var/lib/kubelet/config.yaml, swap ligada, containerd parado…",
        ],
        check: (sh) => sh.ran(/^systemctl status kubelet/),
      },
      {
        title: "Recuperar o kubelet",
        body: ["Inicie o kubelet e deixe-o habilitado no boot."],
        code: ["systemctl enable --now kubelet"],
        hints: ["Duas coisas: subir agora e subir sempre que a máquina reiniciar.", "systemctl start kubelet e systemctl enable kubelet — ou os dois de uma vez com enable --now.", "systemctl enable --now kubelet"],
        explain: [
          "O kubelet voltou a reportar status ao API server e o nó ficou Ready em segundos.",
          "enable --now evita a pegadinha de consertar agora e o problema voltar no próximo reboot.",
        ],
        diagnose: (sh) => {
          if (sh.host !== "lab-worker2") return `Você está em ${sh.host}. O kubelet com problema é o do lab-worker2 — conecte com ssh lab-worker2.`;
          const k = sh.state.hosts["lab-worker2"].services.kubelet;
          if (k.active && !k.enabled) return "O kubelet está rodando, mas continua disabled: ele não voltaria após um reboot. Rode systemctl enable kubelet.";
          if (!k.active && k.enabled) return "Está enabled, mas ainda parado. Rode systemctl start kubelet.";
          return null;
        },
        check: (sh) => {
          const k = sh.state.hosts["lab-worker2"].services.kubelet;
          return k.active && k.enabled;
        },
      },
      {
        title: "Validar do control-plane",
        body: ["Saia do nó e confirme que lab-worker2 está Ready."],
        code: ["exit", "kubectl get nodes"],
        hints: ["Volte para a máquina de administração.", "exit e depois kubectl get nodes", "exit"],
        explain: [
          "lab-worker2 está Ready de novo. Pods já existentes não são rebalanceados automaticamente — para redistribuir o web, use kubectl rollout restart deployment web (ou o descheduler).",
          "Postmortem: alertar em kube_node_status_condition{condition=\"Ready\",status!=\"true\"} e documentar manutenções.",
        ],
        check: (sh) => sh.host === CP_NODE && nodeReady(sh, "lab-worker2") && sh.ran(/^exit/),
      },
    ],
    outro: "Nó recuperado. Fluxo mental: get nodes → describe node → ssh → systemctl/journalctl → correção → validação.",
  },

  // ------------------------------------------------------------------ NetworkPolicy
  {
    id: "cka-networkpolicy",
    track: "cka",
    kind: "lab",
    title: "NetworkPolicy: isolar o banco de dados",
    summary: "Default deny + allow list por label, testando com Pods temporários.",
    level: "Avançado",
    minutes: 15,
    skills: ["NetworkPolicy", "kubectl run --rm", "zero trust"],
    seed: {
      files: { "exemplos/netpol-exemplo.yaml": NETPOL_EXAMPLE },
      setup: (sh) => {
        const old = Date.now() - 1800_000;
        createDeployment(sh, { name: "api", image: "nginx:1.25", replicas: 1, createdAt: old });
        createDeployment(sh, { name: "frontend", image: "nginx:1.25", replicas: 1, createdAt: old });
        createDeployment(sh, {
          name: "db",
          replicas: 1,
          createdAt: old,
          template: { labels: { app: "db" }, spec: { containers: [{ name: "db", image: "hashicorp/http-echo", args: ["-text=db-ok"], ports: [{ containerPort: 5678 }] }] } },
        });
        createService(sh, { name: "db", port: 5678, selector: { app: "db" } });
      },
    },
    intro: "Por padrão, todo Pod fala com todo Pod. O banco (Service db:5678) deve aceitar conexões SOMENTE da api. Há um exemplo de NetworkPolicy em exemplos/netpol-exemplo.yaml.",
    steps: [
      {
        title: "Provar que hoje está tudo aberto",
        body: ["Suba um Pod temporário e tente acessar o banco."],
        code: ["kubectl run tmp --rm -it --image=busybox --restart=Never -- wget -qO- --timeout=2 db:5678"],
        hints: [
          "kubectl run com --rm cria um Pod descartável, executa o comando e apaga o Pod.",
          "kubectl run tmp --rm -it --image=busybox --restart=Never -- <comando>. O Service é resolvido pelo DNS interno (db).",
          "kubectl run tmp --rm -it --image=busybox --restart=Never -- wget -qO- --timeout=2 db:5678",
        ],
        explain: [
          "db-ok: qualquer Pod do cluster — inclusive um recém-criado por qualquer pessoa — acessa o banco. É o modelo \"flat network\" padrão do Kubernetes.",
          "NetworkPolicies só funcionam se o CNI der suporte (Calico, Cilium, o VPC CNI do EKS com network policy habilitado).",
        ],
        check: (sh) => sh.flags.has("reach:default/db"),
      },
      {
        title: "Default deny para o banco",
        body: ["Crie db-deny.yaml a partir do exemplo: selecione os Pods app=db, policyTypes Ingress e NENHUMA regra de ingress. Aplique."],
        code: ["cp exemplos/netpol-exemplo.yaml db-deny.yaml", "vi db-deny.yaml", "kubectl apply -f db-deny.yaml"],
        hints: [
          "Uma policy que seleciona um Pod e não lista nenhuma origem permitida bloqueia todo o tráfego de entrada dele.",
          "No YAML: metadata.name db-deny-all, spec.podSelector.matchLabels app: db, policyTypes [Ingress] e remova o bloco ingress inteiro.",
          DB_DENY,
        ],
        explain: [
          "Agora o db está isolado: nenhum Pod entra. Policies são aditivas — a partir daqui você só LIBERA o que precisa.",
          "Estratégia comum: um default-deny por namespace (podSelector: {}) + allows específicos por aplicação.",
        ],
        diagnose: (sh) => {
          const fe = podsOf(sh, "frontend-")[0];
          const db = podsOf(sh, "db-")[0];
          if (!sh.state.objects.some((o) => o.kind === "NetworkPolicy")) return "Nenhuma NetworkPolicy foi aplicada ainda. Salve o arquivo e rode kubectl apply -f db-deny.yaml.";
          if (fe && db && trafficAllowed(sh, fe, db, 5678)) return "Existe policy, mas o frontend ainda alcança o db. Confira o podSelector (app: db) e se o bloco ingress foi removido.";
          return null;
        },
        check: (sh) => {
          const fe = podsOf(sh, "frontend-")[0];
          const api = podsOf(sh, "api-")[0];
          const db = podsOf(sh, "db-")[0];
          return !!fe && !!db && !!api && !trafficAllowed(sh, fe, db, 5678) && !trafficAllowed(sh, api, db, 5678);
        },
      },
      {
        title: "Liberar apenas a api",
        body: ["Crie db-allow-api.yaml permitindo ingress nos Pods app=db somente vindo de Pods app=api, na porta TCP 5678. Aplique."],
        code: ["cp exemplos/netpol-exemplo.yaml db-allow-api.yaml", "vi db-allow-api.yaml", "kubectl apply -f db-allow-api.yaml"],
        hints: [
          "A regra de ingress tem duas partes: from (quem pode) e ports (em qual porta).",
          "podSelector app: db; ingress.from.podSelector.matchLabels app: api; ports: port 5678.",
          DB_ALLOW,
        ],
        explain: [
          "As duas policies somam: db-deny-all não libera nada, db-allow-api libera a api na 5678. Resultado: só a api entra.",
          "Cuidado com a pegadinha de YAML: from com podSelector e namespaceSelector no MESMO item é AND; em itens separados (dois hífens) é OR.",
        ],
        diagnose: (sh) => {
          const api = podsOf(sh, "api-")[0];
          const fe = podsOf(sh, "frontend-")[0];
          const db = podsOf(sh, "db-")[0];
          if (api && db && !trafficAllowed(sh, api, db, 5678)) return "A api ainda não alcança o db. Confira from.podSelector.matchLabels (app: api) e a porta 5678.";
          if (fe && db && trafficAllowed(sh, fe, db, 5678)) return "Liberou demais: o frontend também entra. O from deve selecionar só app: api.";
          return null;
        },
        check: (sh) => {
          const api = podsOf(sh, "api-")[0];
          const fe = podsOf(sh, "frontend-")[0];
          const db = podsOf(sh, "db-")[0];
          return !!api && !!fe && !!db && trafficAllowed(sh, api, db, 5678) && !trafficAllowed(sh, fe, db, 5678);
        },
      },
      {
        title: "Validar de dentro dos Pods",
        body: ["Teste a partir da api (deve funcionar) e do frontend (deve dar timeout)."],
        code: ["kubectl exec deploy/api -- wget -qO- --timeout=2 db:5678", "kubectl exec deploy/frontend -- wget -qO- --timeout=2 db:5678"],
        hints: ["kubectl exec aceita deploy/<nome> e escolhe um Pod do Deployment.", "kubectl exec deploy/<origem> -- wget -qO- --timeout=2 db:5678", "kubectl exec deploy/api -- wget -qO- --timeout=2 db:5678"],
        explain: [
          "api → db-ok; frontend → download timed out. Tráfego bloqueado por NetworkPolicy normalmente dá TIMEOUT (pacote descartado), não connection refused.",
          "Em produção, valide policies no CI (ex.: testes com netassert/cyclonus) — um typo em label abre ou fecha tudo sem erro nenhum.",
        ],
        diagnose: (sh) => {
          if (!hasFlag(sh, /^reach-from:api-.*:db$/)) return "Falta o teste positivo a partir da api.";
          if (!hasFlag(sh, /^blocked-from:frontend-.*:db$/)) return "Falta o teste negativo a partir do frontend (ele deve dar timeout).";
          return null;
        },
        check: (sh) => hasFlag(sh, /^reach-from:api-.*:db$/) && hasFlag(sh, /^blocked-from:frontend-.*:db$/),
      },
    ],
    outro: "Banco isolado com default-deny + allow list. É a base de zero trust dentro do cluster.",
  },

  // ------------------------------------------------------------------ storage
  {
    id: "cka-storage",
    track: "cka",
    kind: "lab",
    title: "PersistentVolume, PVC e persistência de dados",
    summary: "Provisionamento estático, binding e dados que sobrevivem ao Pod.",
    level: "Intermediário",
    minutes: 12,
    skills: ["PersistentVolume", "PersistentVolumeClaim", "volumeMounts"],
    intro: "Containers são efêmeros: o que é gravado no filesystem do container some quando o Pod morre. Você vai criar um PV manual, reivindicá-lo com um PVC e provar que os dados sobrevivem à recriação do Pod.",
    steps: [
      {
        title: "Criar o PersistentVolume",
        body: ["Crie pv.yaml com um PV task-pv de 1Gi, ReadWriteOnce, storageClassName manual e hostPath /mnt/data. Aplique."],
        code: ["vi pv.yaml", "kubectl apply -f pv.yaml", "kubectl get pv"],
        hints: ["O PV é o \"disco\" em si, criado pelo administrador (ou por um provisionador dinâmico).", "Campos: capacity.storage, accessModes, storageClassName e a origem (hostPath.path).", PV_YAML],
        explain: [
          "O PV ficou Available: existe, mas ninguém o reivindicou. PVs não têm namespace — são recursos do cluster.",
          "hostPath só serve para laboratório (fica preso a um nó). Em produção: EBS/EFS via CSI na AWS, com StorageClass e provisionamento dinâmico.",
        ],
        check: (sh) => {
          const pv = findObj(sh, "PersistentVolume", "task-pv");
          return !!pv && pv.manifest.spec?.capacity?.storage === "1Gi" && pv.manifest.spec?.storageClassName === "manual";
        },
      },
      {
        title: "Reivindicar com um PVC",
        body: ["Crie pvc.yaml com o PVC task-pvc pedindo 500Mi, ReadWriteOnce, storageClassName manual. Aplique e confira que ficou Bound."],
        code: ["vi pvc.yaml", "kubectl apply -f pvc.yaml", "kubectl get pvc"],
        hints: ["O PVC é o pedido: \"quero X de espaço com tal modo de acesso e classe\".", "Para dar match: mesma storageClassName, accessModes compatíveis e capacidade do PV ≥ pedido.", PVC_YAML],
        explain: [
          "task-pvc ficou Bound em task-pv. Repare que o PVC mostra CAPACITY 1Gi: ele recebe o PV inteiro, mesmo tendo pedido 500Mi.",
          "Se o PVC ficar Pending, compare storageClassName, accessModes e tamanho — é quase sempre um desses três.",
        ],
        diagnose: (sh) => {
          const st = pvcStatus(sh, "task-pvc");
          return st.status === "Pending" ? "O PVC está Pending: nenhum PV compatível. Confira storageClassName: manual, ReadWriteOnce e 500Mi." : null;
        },
        check: (sh) => pvcStatus(sh, "task-pvc").status === "Bound" && pvcStatus(sh, "task-pvc").volume === "task-pv",
      },
      {
        title: "Montar o volume em um Pod",
        body: ["Crie pod.yaml com o Pod web-pv (nginx:1.25) montando o claim task-pvc em /usr/share/nginx/html. Aplique."],
        code: ["vi pod.yaml", "kubectl apply -f pod.yaml", "kubectl get pod web-pv"],
        hints: ["O Pod referencia o PVC em spec.volumes e monta em spec.containers[].volumeMounts — os nomes precisam casar.", "volumes: - name: html, persistentVolumeClaim.claimName: task-pvc; volumeMounts: - name: html, mountPath: /usr/share/nginx/html", PV_POD_YAML],
        explain: ["O Pod subiu com o volume montado. O nginx agora serve arquivos do PV.", "Se o PVC não estivesse Bound, o Pod ficaria Pending com o evento \"pod has unbound immediate PersistentVolumeClaims\"."],
        check: (sh) => {
          const p = pod(sh, "web-pv");
          return !!p && sh.podReady(p) && !!p.spec.volumes?.some((v) => v.persistentVolumeClaim?.claimName === "task-pvc");
        },
      },
      {
        title: "Provar a persistência",
        body: [
          "Grave um index.html pelo Pod, apague o Pod, recrie-o e leia o arquivo de novo.",
        ],
        code: [
          "kubectl exec web-pv -- sh -c \"echo persistido > /usr/share/nginx/html/index.html\"",
          "kubectl delete pod web-pv",
          "kubectl apply -f pod.yaml",
          "kubectl exec web-pv -- cat /usr/share/nginx/html/index.html",
        ],
        hints: [
          "Escreva no caminho montado, destrua o Pod e crie de novo com o mesmo YAML.",
          "Use sh -c \"echo … > arquivo\" dentro do exec, depois delete pod + apply + cat.",
          "kubectl exec web-pv -- cat /usr/share/nginx/html/index.html",
        ],
        explain: [
          "O conteúdo \"persistido\" sobreviveu porque estava no PV, não na camada gravável do container. Se você gravasse em /tmp, teria perdido.",
          "reclaimPolicy define o destino do dado quando o PVC é apagado: Retain (padrão em PV manual) guarda, Delete apaga o disco.",
        ],
        diagnose: (sh) => {
          if (!sh.ran(/(kubectl|k) delete (pods?|po)[ /]web-pv/)) return "Falta apagar e recriar o Pod para provar que o dado sobrevive.";
          if (!sh.flags.has("pvc-read:task-pvc")) return "Leia o arquivo de novo com kubectl exec web-pv -- cat /usr/share/nginx/html/index.html depois de recriar o Pod.";
          return null;
        },
        check: (sh) => sh.ran(/(kubectl|k) delete (pods?|po)[ /]web-pv/) && sh.flags.has("pvc-read:task-pvc") && !!pod(sh, "web-pv"),
      },
    ],
    outro: "PV → PVC → Pod: o ciclo completo de storage estático. Na AWS, o mesmo modelo usa o EBS CSI driver com provisionamento dinâmico.",
  },

  // ------------------------------------------------------------------ scheduling
  {
    id: "cka-scheduling",
    track: "cka",
    kind: "lab",
    title: "Scheduling: labels, nodeSelector, taints e tolerations",
    summary: "Direcione cargas para nós específicos e reserve nós dedicados.",
    level: "Intermediário",
    minutes: 12,
    skills: ["nodeSelector", "taints", "tolerations"],
    intro: "O lab-worker2 tem discos NVMe e será dedicado ao banco. Você vai rotulá-lo, direcionar Pods para ele e reservá-lo com um taint.",
    steps: [
      {
        title: "Rotular o nó",
        body: ["Adicione o label disktype=ssd ao nó lab-worker2."],
        code: ["kubectl label node lab-worker2 disktype=ssd"],
        hints: ["Labels em nós servem para seleção pelo scheduler.", "kubectl label node <nó> <chave>=<valor>", "kubectl label node lab-worker2 disktype=ssd"],
        explain: ["O nó agora tem disktype=ssd (veja com kubectl get nodes --show-labels).", "Clusters gerenciados já trazem labels úteis: topology.kubernetes.io/zone, node.kubernetes.io/instance-type, eks.amazonaws.com/nodegroup…"],
        check: (sh) => sh.state.nodes.find((n) => n.name === "lab-worker2")?.labels.disktype === "ssd",
      },
      {
        title: "Direcionar um Pod com nodeSelector",
        body: [
          "Gere o YAML de um Pod fast-app (nginx:1.25) com --dry-run, adicione nodeSelector disktype: ssd e aplique. Ele deve cair no lab-worker2.",
        ],
        code: ["kubectl run fast-app --image=nginx:1.25 --dry-run=client -o yaml > fast-app.yaml", "vi fast-app.yaml", "kubectl apply -f fast-app.yaml", "kubectl get pod fast-app -o wide"],
        hints: [
          "Gerar YAML com --dry-run=client -o yaml e editar é MUITO mais rápido do que escrever do zero — use sempre na prova.",
          "Em spec (mesmo nível de containers) adicione nodeSelector com disktype: ssd.",
          "spec:\n  nodeSelector:\n    disktype: ssd\n  containers:\n  - name: fast-app\n    image: nginx:1.25",
        ],
        explain: [
          "fast-app foi para lab-worker2 porque é o único nó com disktype=ssd. nodeSelector é uma restrição dura: sem nó compatível, o Pod fica Pending.",
          "Para preferências (\"se possível\") ou regras mais ricas, use nodeAffinity (requiredDuringScheduling/preferredDuringScheduling).",
        ],
        diagnose: (sh) => {
          const p = pod(sh, "fast-app");
          if (!p) return "O Pod fast-app ainda não existe. Gere o YAML, edite e aplique.";
          if (!p.spec.nodeSelector) return "fast-app foi criado sem nodeSelector. Apague (kubectl delete pod fast-app), corrija o YAML e aplique de novo.";
          return null;
        },
        check: (sh) => pod(sh, "fast-app")?.node === "lab-worker2" && pod(sh, "fast-app")?.spec.nodeSelector?.disktype === "ssd",
      },
      {
        title: "Reservar o nó com um taint",
        body: ["Aplique o taint dedicated=db:NoSchedule no lab-worker2."],
        code: ["kubectl taint nodes lab-worker2 dedicated=db:NoSchedule"],
        hints: ["Taint repele Pods; toleration é a exceção que permite.", "kubectl taint nodes <nó> <chave>=<valor>:<efeito>", "kubectl taint nodes lab-worker2 dedicated=db:NoSchedule"],
        explain: [
          "NoSchedule impede NOVOS Pods sem toleration; o fast-app que já estava lá continua. NoExecute também expulsaria os existentes.",
          "Remover: kubectl taint nodes lab-worker2 dedicated=db:NoSchedule- (com hífen no final).",
        ],
        check: (sh) => !!sh.state.nodes.find((n) => n.name === "lab-worker2")?.taints.some((t) => t.key === "dedicated" && t.value === "db" && t.effect === "NoSchedule"),
      },
      {
        title: "Pod com toleration no nó dedicado",
        body: ["Crie o Pod db-app (redis:7) com toleration para dedicated=db:NoSchedule E nodeSelector disktype: ssd. Ele deve rodar no lab-worker2."],
        code: ["kubectl run db-app --image=redis:7 --dry-run=client -o yaml > db-app.yaml", "vi db-app.yaml", "kubectl apply -f db-app.yaml", "kubectl get pod db-app -o wide"],
        hints: [
          "Toleration sozinha só PERMITE ir para o nó tainted; para GARANTIR que vá, combine com nodeSelector/afinidade.",
          "spec.tolerations: key dedicated, operator Equal, value db, effect NoSchedule + spec.nodeSelector disktype: ssd.",
          "spec:\n  nodeSelector:\n    disktype: ssd\n  tolerations:\n  - key: dedicated\n    operator: Equal\n    value: db\n    effect: NoSchedule",
        ],
        explain: [
          "db-app rodou no lab-worker2: a toleration liberou o taint e o nodeSelector garantiu o destino. Esse é o padrão de nós dedicados (GPU, bancos, workloads sensíveis).",
          "Sem o nodeSelector, o Pod poderia cair em qualquer nó sem taint — toleration não é atração.",
        ],
        diagnose: (sh) => {
          const p = pod(sh, "db-app");
          if (!p) return "O Pod db-app ainda não existe.";
          if (!p.node) return "db-app está Pending: veja kubectl describe pod db-app. Provavelmente falta a toleration (ou o valor/efeito não bate com o taint).";
          if (p.node !== "lab-worker2") return `db-app caiu em ${p.node}. Adicione o nodeSelector disktype: ssd para forçar o lab-worker2.`;
          return null;
        },
        check: (sh) => {
          const p = pod(sh, "db-app");
          return !!p && p.node === "lab-worker2" && !!p.spec.tolerations?.some((t) => t.key === "dedicated") && podReady(sh, p);
        },
      },
    ],
    outro: "Você controlou onde as cargas rodam. Combine taints (repelir) + nodeSelector/afinidade (atrair) para nós dedicados.",
  },

  // ------------------------------------------------------------------ service endpoints
  {
    id: "cka-service-endpoints",
    track: "cka",
    kind: "challenge",
    title: "Troubleshooting: Service sem endpoints",
    summary: "O Deployment está saudável, mas ninguém consegue acessá-lo.",
    level: "Intermediário",
    minutes: 10,
    skills: ["Endpoints", "selectors", "kubectl edit"],
    seed: {
      setup: (sh) => {
        createDeployment(sh, { name: "checkout", image: "nginx:1.25", replicas: 2, createdAt: Date.now() - 900_000 });
        createService(sh, { name: "checkout", port: 80, selector: { app: "check-out" } });
      },
    },
    intro: "🚨 Os Pods do checkout estão todos Running e prontos, mas o frontend recebe connection refused ao chamar http://checkout. Encontre o elo quebrado.",
    steps: [
      {
        title: "Ver os endpoints",
        body: ["Verifique para onde o Service checkout está mandando o tráfego."],
        code: ["kubectl get endpoints checkout"],
        hints: ["Um Service só encaminha para os IPs listados nos Endpoints dele.", "kubectl get endpoints <service>", "kubectl get endpoints checkout"],
        explain: ["ENDPOINTS <none>: o Service não encontrou nenhum Pod. Com os Pods saudáveis, o suspeito número 1 é o selector.", "Endpoints são atualizados pelo endpoint controller sempre que Pods prontos casam com o selector."],
        check: (sh) => sh.ran(/(kubectl|k) get (endpoints|ep)\b/),
      },
      {
        title: "Comparar selector e labels",
        body: ["Compare o selector do Service com os labels dos Pods."],
        code: ["kubectl describe svc checkout", "kubectl get pods --show-labels"],
        hints: ["O selector precisa bater EXATAMENTE (chave e valor) com os labels dos Pods.", "kubectl describe svc checkout mostra o Selector; kubectl get pods --show-labels mostra os labels.", "kubectl get pods --show-labels"],
        explain: ["Selector app=check-out × label app=checkout: um hífen de diferença e nenhum Pod casa.", "Esse erro não gera evento nem alerta — o Service é criado normalmente, só fica vazio."],
        check: (sh) => sh.ran(/(kubectl|k) get (pods?|po).*--show-labels/) || sh.ran(/(kubectl|k) describe (svc|services?)[ /]checkout/),
      },
      {
        title: "Corrigir o selector",
        body: ["Edite o Service para usar o selector app: checkout."],
        code: ["kubectl edit svc checkout"],
        hints: ["kubectl edit abre o objeto no editor; ao salvar, aplica.", "Em spec.selector troque check-out por checkout e salve.", "spec:\n  selector:\n    app: checkout"],
        explain: ["Assim que o selector casou, o endpoint controller preencheu os IPs dos 2 Pods.", "Alternativa sem editor: kubectl patch svc checkout -p '{\"spec\":{\"selector\":{\"app\":\"checkout\"}}}'."],
        check: (sh) => {
          const s = findService(sh, "checkout");
          return !!s && endpoints(sh, s).length === 2;
        },
      },
      {
        title: "Testar como o frontend",
        body: ["Faça uma requisição ao Service de dentro do cluster."],
        code: ["kubectl run tmp --rm -it --image=busybox --restart=Never -- wget -qO- checkout"],
        hints: ["Teste pelo nome DNS do Service, como a aplicação faria.", "kubectl run tmp --rm -it --image=busybox --restart=Never -- wget -qO- <service>", "kubectl run tmp --rm -it --image=busybox --restart=Never -- wget -qO- checkout"],
        explain: ["Welcome to nginx! — tráfego fluindo. Fluxo DNS → ClusterIP → kube-proxy → Endpoints → Pod validado ponta a ponta.", "Guarde o checklist: Pods prontos? Endpoints preenchidos? targetPort certo? NetworkPolicy? DNS?"],
        check: (sh) => sh.flags.has("reach:default/checkout"),
      },
    ],
    outro: "Service consertado. Endpoints vazios quase sempre são selector errado ou Pods não-Ready.",
  },
];
