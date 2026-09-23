import "../k8s/kubectl";
import type { Shell } from "../shell";
import type { Lab, Track } from "../types";

export const track: Track = {
  id: "kubernetes",
  title: "Kubernetes Fundamentos",
  desc: "Implemente, escale, exponha e solucione problemas de aplicações em um cluster Kubernetes real (simulado), cobrindo deploy, rollout e reversão de aplicações.",
  color: "#60a5fa",
  icon: "☸",
};

const podOf = (sh: Shell, name: string) => sh.state.pods.find((p) => p.name === name && p.namespace === "default");
const depOf = (sh: Shell, name: string) => sh.state.deployments.find((d) => d.name === name && d.namespace === "default");

export const labs: Lab[] = [
  {
    id: "k8s-cluster-explore",
    track: "kubernetes",
    kind: "lab",
    title: "Explorar o cluster Kubernetes",
    summary: "Conecte-se ao cluster, liste nós e namespaces.",
    level: "Iniciante",
    minutes: 5,
    skills: ["cluster-info", "get nodes", "namespaces"],
    intro: "Antes de implantar qualquer coisa, um bom engenheiro confirma para onde o kubectl está apontando e se o cluster está saudável.",
    steps: [
      {
        title: "Confirmar o contexto",
        body: ["Verifique qual cluster o kubectl está usando. Em produção, esse hábito evita aplicar mudanças no ambiente errado."],
        code: ["kubectl config current-context"],
        hints: [
          "O kubectl guarda os clusters que conhece no kubeconfig (~/.kube/config). Cada entrada é um \"context\" = cluster + usuário + namespace.",
          "O grupo de comandos é kubectl config, e a ação que mostra o contexto ativo é current-context.",
          "kubectl config current-context",
        ],
        explain: [
          "A saída kind-lab é o nome do contexto ativo — todo comando kubectl a partir de agora vai para esse cluster.",
          "Em empresas com dev, homologação e produção, conferir o contexto antes de um apply ou delete evita incidentes. Para ver todos: kubectl config get-contexts.",
        ],
        check: (sh) => sh.ran(/^(kubectl|k) config current-context/),
      },
      {
        title: "Informações do control plane",
        body: ["Confirme que o API server e o CoreDNS estão respondendo."],
        code: ["kubectl cluster-info"],
        hints: [
          "Você quer saber em que endereço o control plane (API server) responde.",
          "É um subcomando único, sem tipo de recurso: kubectl cluster-…",
          "kubectl cluster-info",
        ],
        explain: [
          "O API server responde em https://127.0.0.1:6443 — ele é a porta de entrada de todo comando kubectl, de controllers e do kubelet.",
          "O CoreDNS é o DNS interno: é ele que permite um Pod chamar outro pelo nome (ex.: web.default.svc.cluster.local). Se cluster-info falha, o problema é de conexão/kubeconfig — não das suas aplicações.",
        ],
        check: (sh) => sh.ran(/^(kubectl|k) cluster-info/),
      },
      {
        title: "Listar namespaces",
        body: ["Namespaces isolam recursos logicamente. Liste os namespaces existentes no cluster."],
        code: ["kubectl get namespaces"],
        hints: [
          "Namespaces são um tipo de recurso — use o verbo que lista recursos.",
          "kubectl get <tipo>. Aqui o tipo é namespaces (abreviação: ns).",
          "kubectl get namespaces",
        ],
        explain: [
          "default é onde seus recursos vão quando você não passa -n. kube-system guarda os componentes do cluster (CoreDNS, kube-proxy…). kube-node-lease recebe os heartbeats dos nós.",
          "Em produção, cada time/aplicação costuma ter o próprio namespace, com ResourceQuota, LimitRange e RBAC.",
        ],
        check: (sh) => sh.ran(/^(kubectl|k) get (ns|namespaces?)\b/),
      },
    ],
    outro: "Você sabe identificar o cluster e o contexto atual. Próximo passo: validar a saúde dos nós.",
  },
  {
    id: "k8s-check-status",
    track: "kubernetes",
    kind: "challenge",
    title: "Verificar o estado do Kubernetes",
    summary: "Valide API server, nós e versões antes de agir.",
    level: "Iniciante",
    minutes: 5,
    skills: ["get nodes", "describe node", "version"],
    intro: "Antes de solucionar qualquer problema, confirme a prontidão do nó. Esse hábito ajuda a distinguir um problema de configuração do cliente de uma falha real do cluster antes que você tente realizar reparos que possam causar interrupções.",
    steps: [
      {
        title: "Verificar os nós",
        body: ["Liste os nós do cluster e confirme que todos estão com STATUS Ready."],
        code: ["kubectl get nodes"],
        hints: [
          "Nós são as máquinas (VMs ou físicas) do cluster, e também são um tipo de recurso.",
          "kubectl get <recurso> — o recurso aqui é nodes (ou no). Adicione -o wide para ver os IPs.",
          "kubectl get nodes",
        ],
        explain: [
          "3 nós Ready: 1 control-plane (API server, etcd, scheduler, controller-manager) e 2 workers (onde seus Pods rodam).",
          "Ready significa que o kubelet do nó está reportando saúde ao API server. Se um nó ficar NotReady, os Pods dele são reagendados em outro nó após ~5 min.",
        ],
        check: (sh) => sh.ran(/^(kubectl|k) get (nodes?|no)\b/),
      },
      {
        title: "Inspecionar um worker",
        body: ["Descreva o nó lab-worker e verifique as Conditions: MemoryPressure, DiskPressure e PIDPressure devem ser False, e Ready deve ser True."],
        code: ["kubectl describe node lab-worker"],
        hints: [
          "get mostra um resumo. Para ver condições, capacidade e eventos, existe outro verbo.",
          "kubectl describe node <nome-do-nó> — os nomes estão na saída do passo anterior.",
          "kubectl describe node lab-worker",
        ],
        explain: [
          "Conditions é o checklist de saúde do nó: *Pressure = False quer dizer que há memória, disco e PIDs sobrando; Ready = True quer dizer kubelet saudável.",
          "Capacity mostra CPU, memória e o limite de 110 Pods por nó. É aqui que você olha quando Pods ficam Pending por falta de recurso.",
        ],
        diagnose: (sh) =>
          sh.ran(/^(kubectl|k) describe (nodes?|no)[ /]lab-control-plane/) && !sh.ran(/^(kubectl|k) describe (nodes?|no)[ /]lab-worker/)
            ? "Você descreveu o lab-control-plane. Ele é o nó de controle — o passo pede um worker: lab-worker ou lab-worker2."
            : null,
        check: (sh) => sh.ran(/^(kubectl|k) describe (nodes?|no)[ /]lab-worker2?\b/),
      },
      {
        title: "Comparar versões",
        body: ["Client e Server devem estar a no máximo uma minor version de distância (version skew policy)."],
        code: ["kubectl version"],
        hints: [
          "Existe um subcomando que mostra a versão do kubectl e do API server de uma vez.",
          "O verbo é o próprio nome: version.",
          "kubectl version",
        ],
        explain: [
          "Client v1.30.2 e Server v1.30.0 estão na mesma minor (1.30), então são compatíveis.",
          "A version skew policy permite o kubectl até ±1 minor do API server. Fora disso, flags e APIs depreciadas podem se comportar de forma inesperada — algo comum depois de upgrades de EKS.",
        ],
        check: (sh) => sh.ran(/^(kubectl|k) version/),
      },
    ],
    outro: "Cluster validado: 3 nós Ready, sem pressão de recursos e versões compatíveis.",
  },
  {
    id: "k8s-first-pod",
    track: "kubernetes",
    kind: "lab",
    title: "Lance seu primeiro Pod do Kubernetes",
    summary: "Crie um Pod nginx, acompanhe o ciclo de vida e leia os logs.",
    level: "Iniciante",
    minutes: 8,
    skills: ["kubectl run", "pod lifecycle", "kubectl logs"],
    intro: "O Pod é a menor unidade implantável do Kubernetes. Aqui você cria um Pod diretamente e acompanha sua transição de ContainerCreating para Running.",
    steps: [
      {
        title: "Criar o Pod",
        body: ["Crie um Pod chamado nginx usando a imagem nginx:1.25."],
        code: ["kubectl run nginx --image=nginx:1.25"],
        hints: [
          "Existe um verbo que cria um Pod avulso diretamente a partir de uma imagem.",
          "kubectl run <nome-do-pod> --image=<imagem>",
          "kubectl run nginx --image=nginx:1.25",
        ],
        explain: [
          "kubectl run criou um objeto Pod no API server. O scheduler escolheu um worker, e o kubelet daquele nó baixou a imagem e iniciou o container.",
          "O Pod recebeu o label run=nginx automaticamente. Labels são a \"cola\" do Kubernetes: é por eles que Services e Deployments encontram Pods.",
        ],
        diagnose: (sh) => {
          const other = sh.state.pods.find((p) => p.labels.run && p.name !== "nginx");
          return other ? `Você criou um Pod chamado "${other.name}", mas o passo pede o nome nginx. Apague com kubectl delete pod ${other.name} e crie de novo.` : null;
        },
        check: (sh) => !!podOf(sh, "nginx"),
      },
      {
        title: "Aguardar Running",
        body: ["Liste os Pods até que o STATUS seja Running e READY 1/1. Se ainda estiver em ContainerCreating, rode o comando novamente."],
        code: ["kubectl get pods -o wide"],
        hints: [
          "O Pod passa pelas fases Pending → ContainerCreating → Running.",
          "Liste os Pods com kubectl get pods. Se estiver ContainerCreating, espere uns segundos e rode de novo.",
          "kubectl get pods -o wide",
        ],
        explain: [
          "READY 1/1 = 1 container pronto de 1. STATUS Running = container em execução.",
          "Com -o wide você vê o IP do Pod (10.244.x.x, rede do CNI) e o nó onde ele caiu. Esse IP muda sempre que o Pod é recriado — por isso usamos Services.",
        ],
        diagnose: (sh) => {
          const p = podOf(sh, "nginx");
          if (!p) return "O Pod nginx não existe mais. Volte ao passo anterior e crie-o de novo.";
          if (!sh.podReady(p)) return `O Pod ainda está em ${sh.podStatus(p)} (baixando a imagem). Aguarde alguns segundos e liste de novo.`;
          return "O Pod já está Running, mas você ainda não conferiu. Rode kubectl get pods para ver com seus próprios olhos.";
        },
        check: (sh) => {
          const p = podOf(sh, "nginx");
          return !!p && sh.podReady(p) && sh.ran(/^(kubectl|k) get (pods?|po)\b/);
        },
      },
      {
        title: "Ler os logs",
        body: ["Os logs mostram a saída padrão do container. Confirme que o nginx subiu com sucesso."],
        code: ["kubectl logs nginx"],
        hints: [
          "Containers escrevem em stdout/stderr, e o Kubernetes guarda essa saída para você.",
          "kubectl logs <nome-do-pod>",
          "kubectl logs nginx",
        ],
        explain: [
          "Esses são os logs de inicialização do nginx: configuração carregada e worker processes iniciados.",
          "No troubleshooting, logs é o segundo comando depois do describe. Flags úteis: -f (acompanhar em tempo real), --previous (logs do container que crashou) e -c (escolher o container num Pod com vários).",
        ],
        check: (sh) => sh.ran(/^(kubectl|k) logs nginx\b/),
      },
    ],
    outro: "Pods criados diretamente não se recuperam sozinhos. No próximo lab você usa um Deployment para isso.",
  },
  {
    id: "k8s-deploy",
    track: "kubernetes",
    kind: "lab",
    title: "Implantar aplicações no Kubernetes",
    summary: "Deployment, ReplicaSet e escalonamento horizontal.",
    level: "Iniciante",
    minutes: 10,
    skills: ["create deployment", "kubectl scale", "self-healing"],
    intro: "Deployments gerenciam ReplicaSets, que garantem o número desejado de Pods. Se um Pod morre, outro é criado automaticamente.",
    steps: [
      {
        title: "Criar o Deployment",
        body: ["Crie um Deployment chamado web com a imagem nginx:1.25."],
        code: ["kubectl create deployment web --image=nginx:1.25"],
        hints: [
          "Deployments são criados com o verbo create seguido do tipo do recurso.",
          "kubectl create deployment <nome> --image=<imagem>",
          "kubectl create deployment web --image=nginx:1.25",
        ],
        explain: [
          "Você criou 3 objetos em cascata: Deployment web → ReplicaSet web-<hash> → Pod web-<hash>-<id>. Por isso o nome do Pod tem dois sufixos.",
          "O Deployment guarda a estratégia de atualização; o ReplicaSet garante o número de réplicas; o Pod roda o container.",
        ],
        diagnose: (sh) => {
          const other = sh.state.deployments.find((d) => d.namespace === "default" && d.name !== "web");
          return other ? `Você criou o Deployment "${other.name}", mas o passo pede o nome web. Apague com kubectl delete deployment ${other.name} e crie de novo.` : null;
        },
        check: (sh) => !!depOf(sh, "web"),
      },
      {
        title: "Escalar para 3 réplicas",
        body: ["Aumente o número de réplicas para 3 para distribuir a carga entre os workers."],
        code: ["kubectl scale deployment web --replicas=3"],
        hints: [
          "Escalar horizontalmente = mudar o número de réplicas (cópias) do Pod.",
          "kubectl scale deployment <nome> --replicas=<N>",
          "kubectl scale deployment web --replicas=3",
        ],
        explain: [
          "As réplicas desejadas foram de 1 para 3, e o ReplicaSet criou 2 Pods novos, distribuídos entre os workers.",
          "Em produção isso costuma ser automático com o HPA (HorizontalPodAutoscaler), baseado em CPU, memória ou métricas customizadas.",
        ],
        diagnose: (sh) => {
          const d = depOf(sh, "web");
          if (!d) return "O Deployment web não existe. Volte ao passo anterior.";
          return d.replicas !== 3 ? `O Deployment web está com ${d.replicas} réplica(s); o passo pede exatamente 3.` : null;
        },
        check: (sh) => depOf(sh, "web")?.replicas === 3,
      },
      {
        title: "Testar o self-healing",
        body: [
          "Apague um dos Pods do Deployment (copie um nome de kubectl get pods) e veja o ReplicaSet recriá-lo.",
          "Depois, confirme que o Deployment voltou a 3/3 READY.",
        ],
        code: ["kubectl get pods -l app=web", "kubectl delete pod <nome-do-pod>", "kubectl get deployment web"],
        hints: [
          "Apague um Pod que pertence ao Deployment — o nome começa com web-.",
          "Liste com kubectl get pods, copie um nome e rode kubectl delete pod <nome>. Digite web- e aperte Tab para autocompletar!",
          "kubectl delete pod web-xxxxxxxxx-xxxxx (troque pelo nome real) e depois kubectl get deployment web",
        ],
        explain: [
          "O ReplicaSet notou 2 Pods em vez de 3 e criou um novo na hora. Esse é o loop de reconciliação (estado desejado vs. estado atual) que torna o Kubernetes auto-curável.",
          "Um Pod criado com kubectl run não voltaria — por isso, em produção, sempre usamos um controller (Deployment, StatefulSet, DaemonSet).",
        ],
        diagnose: (sh) => {
          if (!sh.ran(/^(kubectl|k) delete (pods?|po)[ /]web-/)) return "Você ainda não apagou nenhum Pod web-*. Liste os Pods, copie um nome e rode kubectl delete pod <nome>.";
          if (!sh.deploymentReady("web")) return "O Pod substituto ainda está subindo (ContainerCreating). Aguarde uns segundos e rode kubectl get deployment web.";
          return null;
        },
        check: (sh) => sh.ran(/^(kubectl|k) delete (pods?|po)[ /]web-/) && sh.deploymentReady("web"),
      },
    ],
    outro: "Você viu na prática o loop de reconciliação: estado desejado vs. estado atual.",
  },
  {
    id: "k8s-expose",
    track: "kubernetes",
    kind: "lab",
    title: "Exponha aplicações Kubernetes",
    summary: "Services, NodePort e descoberta de endpoints.",
    level: "Intermediário",
    minutes: 10,
    skills: ["kubectl expose", "NodePort", "endpoints"],
    seed: { seedDeployments: [{ name: "web", image: "nginx:1.25", replicas: 2, ageSec: 900 }] },
    intro: "O Deployment web já está rodando com 2 réplicas. Pods têm IPs efêmeros — um Service fornece um endereço estável e balanceamento de carga.",
    steps: [
      {
        title: "Criar um Service NodePort",
        body: ["Exponha o Deployment web na porta 80 com o tipo NodePort."],
        code: ["kubectl expose deployment web --port=80 --type=NodePort"],
        hints: [
          "Um Service dá IP e porta estáveis na frente dos Pods. O verbo que cria um Service a partir de um Deployment é expose.",
          "kubectl expose deployment <nome> --port=<porta> --type=<tipo>",
          "kubectl expose deployment web --port=80 --type=NodePort",
        ],
        explain: [
          "O Service NodePort tem 3 camadas: ClusterIP (IP virtual interno), port 80 (porta do Service) e NodePort 3XXXX (porta aberta em TODOS os nós).",
          "O Service encontra os Pods pelo selector app=web — o mesmo label que o Deployment coloca nos Pods.",
        ],
        diagnose: (sh) => {
          const s = sh.state.services.find((x) => x.name === "web");
          return s && s.type !== "NodePort"
            ? `Você criou o Service como ${s.type}${s.type === "ClusterIP" ? " (o padrão), que só é acessível de dentro do cluster" : ""}. Apague com kubectl delete svc web e recrie com --type=NodePort.`
            : null;
        },
        check: (sh) => sh.state.services.some((s) => s.name === "web" && s.type === "NodePort"),
      },
      {
        title: "Descobrir a porta e os endpoints",
        body: ["Anote a NodePort (faixa 30000-32767) e verifique os Endpoints — eles devem apontar para os IPs dos Pods."],
        code: ["kubectl get svc web", "kubectl describe svc web"],
        hints: [
          "Para ver os Endpoints (IPs dos Pods por trás do Service), use o verbo que mostra detalhes.",
          "kubectl describe svc <nome>",
          "kubectl describe svc web",
        ],
        explain: [
          "Endpoints lista IP:porta de cada Pod pronto que casa com o selector. É a lista para onde o kube-proxy manda o tráfego.",
          "Se aparecer <none>, o selector não bate com os labels ou os Pods não estão Ready — é a causa nº 1 de \"meu Service não responde\".",
        ],
        check: (sh) => sh.ran(/^(kubectl|k) describe (svc|services?)[ /]web\b/),
      },
      {
        title: "Testar a aplicação",
        body: ["Faça uma requisição para localhost:<NodePort> e confirme a página Welcome to nginx!"],
        code: ["curl localhost:<NodePort>"],
        hints: [
          "Um NodePort fica acessível em <IP-de-qualquer-nó>:<NodePort>. Aqui, localhost funciona.",
          "Veja a porta em kubectl get svc web — na coluna PORT(S) aparece algo como 80:31234/TCP. O número depois dos dois-pontos é a NodePort.",
          "curl localhost:<o-número-depois-de-80:>  (ex.: curl localhost:31234)",
        ],
        explain: [
          "A requisição percorreu: localhost:NodePort → kube-proxy (regras iptables/IPVS) → ClusterIP → um dos Pods web.",
          "A cada requisição o kube-proxy pode escolher um Pod diferente — é o balanceamento L4 do Kubernetes. Em cloud, você usaria um Service LoadBalancer ou um Ingress na frente.",
        ],
        diagnose: (sh) => {
          const last = [...sh.entries].reverse().find((e) => e.cmd.startsWith("curl"));
          const svc = sh.state.services.find((s) => s.name === "web");
          if (last && /:80\b|localhost\/?$/.test(last.cmd) && svc?.nodePort)
            return `Você usou a porta 80 — essa é a porta do Service dentro do cluster. De fora, use a NodePort: curl localhost:${svc.nodePort}`;
          return null;
        },
        check: (sh) => sh.flags.has("curl-svc:web"),
      },
    ],
    outro: "Aplicação acessível de fora do cluster. Em cloud, o próximo passo seria um LoadBalancer ou um Ingress.",
  },
  {
    id: "k8s-troubleshoot-nginx",
    track: "kubernetes",
    kind: "challenge",
    title: "Solucionar problemas de uma implantação NGINX",
    summary: "Um deploy quebrou em produção. Encontre a causa e corrija.",
    level: "Intermediário",
    minutes: 12,
    skills: ["ImagePullBackOff", "kubectl describe", "kubectl set image"],
    seed: { seedDeployments: [{ name: "nginx", image: "ngnix:1.25", replicas: 2, ageSec: 300 }] },
    intro: "🚨 Alerta disparado: o Deployment nginx está com 0/2 réplicas disponíveis. Investigue como faria num war room: observe, diagnostique, corrija e valide.",
    steps: [
      {
        title: "Observar o sintoma",
        body: ["Liste os Pods e identifique o STATUS de erro."],
        code: ["kubectl get pods"],
        hints: [
          "Comece pelo sintoma: em que estado os Pods estão?",
          "Liste os Pods do namespace default.",
          "kubectl get pods",
        ],
        explain: [
          "STATUS ImagePullBackOff: o kubelet tentou baixar a imagem, falhou (ErrImagePull) e agora espera cada vez mais entre as tentativas (back-off exponencial até 5 min).",
          "READY 0/1 confirma que nenhum container subiu. O problema está na imagem — não no nó nem na rede.",
        ],
        check: (sh) => sh.ran(/^(kubectl|k) get (pods?|po|all)\b/),
      },
      {
        title: "Diagnosticar a causa raiz",
        body: ["Descreva um dos Pods com erro e leia a seção Events com atenção. O que o kubelet não conseguiu fazer?"],
        code: ["kubectl describe pod <nome-do-pod>"],
        hints: [
          "O STATUS diz O QUE aconteceu; a seção Events do describe diz POR QUÊ.",
          "kubectl describe pod <nome-de-um-pod-nginx>. Digite nginx- e aperte Tab para completar o nome.",
          "kubectl describe pod nginx-xxxxxxxxx-xxxxx (troque pelo nome real) — ou kubectl get events",
        ],
        explain: [
          "Os Events mostram: Failed to pull image \"ngnix:1.25\": not found. A causa raiz é um typo: ngnix em vez de nginx.",
          "Outras causas comuns de ImagePullBackOff: tag inexistente, registry privado sem imagePullSecret e rate limit do Docker Hub.",
        ],
        check: (sh) => sh.ran(/^(kubectl|k) (describe (pods?|po)[ /]nginx-|get (events|ev))/),
      },
      {
        title: "Corrigir a imagem",
        body: ["Atualize o container nginx do Deployment para a imagem correta, nginx:1.25."],
        code: ["kubectl set image deployment/nginx nginx=nginx:1.25"],
        hints: [
          "Não precisa recriar o Deployment: basta trocar a imagem do container.",
          "kubectl set image deployment/<deploy> <container>=<imagem>. O container também se chama nginx.",
          "kubectl set image deployment/nginx nginx=nginx:1.25",
        ],
        explain: [
          "set image alterou o Pod template, o que gerou uma nova revisão e um novo ReplicaSet. O Deployment fez rolling update: subiu Pods com a imagem certa e removeu os quebrados.",
          "Em GitOps (ArgoCD), a correção seria um commit no manifesto — mudar direto no cluster gera drift e seria revertido no próximo sync.",
        ],
        diagnose: (sh) => {
          const d = depOf(sh, "nginx");
          if (!d) return "O Deployment nginx sumiu! Reinicie o ambiente pelo botão ↺ no topo.";
          if (d.image.startsWith("ngnix")) return `A imagem ainda é ${d.image}. Repare na grafia: ngnix ≠ nginx.`;
          return `A imagem agora é ${d.image}, mas o passo pede exatamente nginx:1.25.`;
        },
        check: (sh) => depOf(sh, "nginx")?.image.replace(/^docker\.io\/(library\/)?/, "") === "nginx:1.25",
      },
      {
        title: "Validar o rollout",
        body: ["Confirme que o rollout terminou e que os 2 Pods estão Running."],
        code: ["kubectl rollout status deployment/nginx", "kubectl get pods"],
        hints: [
          "Não confie só no comando de update: confirme que o rollout terminou.",
          "kubectl rollout status deployment/<nome>",
          "kubectl rollout status deployment/nginx",
        ],
        explain: [
          "\"successfully rolled out\" = todas as réplicas novas estão disponíveis.",
          "Em pipelines de CD, rollout status com --timeout funciona como gate: se não completar, o pipeline falha e dispara rollback. Ciclo do incidente completo: detectar → diagnosticar → mitigar → validar ✓",
        ],
        diagnose: (sh) => {
          if (!sh.deploymentReady("nginx")) return "Os Pods novos ainda estão subindo. Aguarde alguns segundos e rode kubectl rollout status deployment/nginx de novo.";
          if (!sh.ran(/^(kubectl|k) rollout status/)) return "Os Pods já estão Running, mas falta a validação formal: rode kubectl rollout status deployment/nginx.";
          return null;
        },
        check: (sh) => sh.deploymentReady("nginx") && sh.ran(/^(kubectl|k) rollout status/),
      },
    ],
    outro: "Incidente resolvido. Post-mortem: adicionar validação de imagem no pipeline de CI (ex.: crane/skopeo) para pegar o typo antes do deploy.",
  },
  {
    id: "k8s-rollout",
    track: "kubernetes",
    kind: "lab",
    title: "Rolling update e reversão de aplicações",
    summary: "Atualize sem downtime e faça rollback com segurança.",
    level: "Intermediário",
    minutes: 10,
    skills: ["rolling update", "rollout history", "rollout undo"],
    seed: { seedDeployments: [{ name: "api", image: "nginx:1.24", replicas: 3, ageSec: 3600 }] },
    intro: "O Deployment api roda nginx:1.24. Você vai publicar a 1.25, inspecionar o histórico e simular um rollback.",
    steps: [
      {
        title: "Publicar a nova versão",
        body: ["Atualize a imagem do Deployment api para nginx:1.25."],
        code: ["kubectl set image deployment/api api=nginx:1.25"],
        hints: [
          "Atualizar a versão = trocar a imagem do container no Pod template.",
          "kubectl set image deployment/<deploy> <container>=<imagem>. O container se chama api.",
          "kubectl set image deployment/api api=nginx:1.25",
        ],
        explain: [
          "O Deployment criou um ReplicaSet novo (1.25) e foi transferindo réplicas do antigo (1.24) para ele, respeitando maxSurge e maxUnavailable (25% cada, por padrão).",
          "Resultado: zero downtime, porque sempre há Pods prontos atendendo durante a troca.",
        ],
        diagnose: (sh) => {
          const d = depOf(sh, "api");
          return d && d.image !== "nginx:1.25" ? `A imagem atual é ${d.image}; o passo pede nginx:1.25.` : null;
        },
        check: (sh) => depOf(sh, "api")?.image === "nginx:1.25",
      },
      {
        title: "Inspecionar o histórico",
        body: ["Cada mudança no Pod template cria uma nova revisão."],
        code: ["kubectl rollout history deployment/api"],
        hints: [
          "O subcomando rollout tem uma ação que lista as revisões.",
          "kubectl rollout history deployment/<nome>",
          "kubectl rollout history deployment/api",
        ],
        explain: [
          "Revisão 1 = nginx:1.24 e revisão 2 = nginx:1.25. O Kubernetes mantém os ReplicaSets antigos (com 0 réplicas) justamente para permitir rollback instantâneo.",
          "Quantas revisões ficam guardadas é definido por revisionHistoryLimit (padrão: 10).",
        ],
        check: (sh) => sh.ran(/^(kubectl|k) rollout history/),
      },
      {
        title: "Rollback",
        body: ["Um alerta de latência disparou após o deploy. Reverta para a revisão anterior e confirme a imagem."],
        code: ["kubectl rollout undo deployment/api", "kubectl describe deployment api"],
        hints: [
          "Rollback no Kubernetes é \"desfazer\" o último rollout.",
          "kubectl rollout undo deployment/<nome> (use --to-revision=N para escolher uma revisão específica)",
          "kubectl rollout undo deployment/api",
        ],
        explain: [
          "O undo reativou o ReplicaSet da 1.24 e escalou o da 1.25 para zero. Como a imagem já estava no nó, o rollback leva segundos.",
          "Repare que o rollback vira uma revisão nova (3). Em produção, combine isso com canary e análise automática de métricas (Argo Rollouts, Flagger).",
        ],
        diagnose: (sh) => {
          const d = depOf(sh, "api");
          return d && d.image !== "nginx:1.24" ? `O Deployment ainda está com ${d.image}. Rode kubectl rollout undo deployment/api.` : null;
        },
        check: (sh) => {
          const d = depOf(sh, "api");
          return !!d && d.image === "nginx:1.24" && d.revision >= 3;
        },
      },
    ],
    outro: "Rollback em segundos. Em produção, combine isso com canary + análise automática (Argo Rollouts).",
  },
];
