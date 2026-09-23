import type { Seed, Shell } from "./shell";

export type Step = {
  title: string;
  body: string[];
  code?: string[];
  hint?: string;
  check: (sh: Shell) => boolean;
  fail?: string;
};

export type Lab = {
  id: string;
  track: TrackId;
  kind: "lab" | "challenge";
  title: string;
  summary: string;
  level: "Iniciante" | "Intermediário" | "Avançado";
  minutes: number;
  skills: string[];
  seed?: Seed;
  intro: string;
  steps: Step[];
  outro: string;
};

export type TrackId = "kubernetes" | "docker" | "terraform";

export const TRACKS: { id: TrackId; title: string; desc: string; color: string; icon: string }[] = [
  {
    id: "kubernetes",
    title: "Kubernetes",
    desc: "Implemente, escale, exponha e solucione problemas de aplicações em um cluster Kubernetes real (simulado), cobrindo deploy, rollout e reversão de aplicações.",
    color: "#60a5fa",
    icon: "☸",
  },
  {
    id: "docker",
    title: "Docker",
    desc: "Imagens, containers e mapeamento de portas — a base de qualquer pipeline de entrega.",
    color: "#22d3ee",
    icon: "🐳",
  },
  {
    id: "terraform",
    title: "Terraform · AWS",
    desc: "Provisione um cluster EKS com Infrastructure as Code: init, plan, apply e state.",
    color: "#c084fc",
    icon: "🏗",
  },
];

const podOf = (sh: Shell, name: string) => sh.state.pods.find((p) => p.name === name);
const depOf = (sh: Shell, name: string) => sh.state.deployments.find((d) => d.name === name);

export const LABS: Lab[] = [
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
        check: (sh) => sh.ran(/^(kubectl|k) config current-context/),
        fail: "Execute kubectl config current-context no terminal.",
      },
      {
        title: "Informações do control plane",
        body: ["Confirme que o API server e o CoreDNS estão respondendo."],
        code: ["kubectl cluster-info"],
        check: (sh) => sh.ran(/^(kubectl|k) cluster-info/),
      },
      {
        title: "Listar namespaces",
        body: ["Namespaces isolam recursos lógicos. Liste os namespaces existentes no cluster."],
        code: ["kubectl get namespaces"],
        hint: "O atalho ns também funciona: kubectl get ns",
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
        hint: "Use -o wide para ver IPs internos e runtime do container.",
        check: (sh) => sh.ran(/^(kubectl|k) get (nodes?|no)\b/),
      },
      {
        title: "Inspecionar um worker",
        body: ["Descreva o nó lab-worker e verifique as Conditions: MemoryPressure, DiskPressure, PIDPressure devem ser False e Ready deve ser True."],
        code: ["kubectl describe node lab-worker"],
        check: (sh) => sh.ran(/^(kubectl|k) describe (nodes?|no)[ /]lab-worker2?\b/),
        fail: "Rode kubectl describe node lab-worker (ou lab-worker2).",
      },
      {
        title: "Comparar versões",
        body: ["Client e Server devem estar no máximo uma minor version de distância (version skew policy)."],
        code: ["kubectl version"],
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
        check: (sh) => !!podOf(sh, "nginx"),
        fail: "Nenhum Pod chamado nginx foi encontrado.",
      },
      {
        title: "Aguardar Running",
        body: ["Liste os Pods até que o STATUS seja Running e READY 1/1. Rode o comando novamente se ainda estiver em ContainerCreating."],
        code: ["kubectl get pods -o wide"],
        check: (sh) => {
          const p = podOf(sh, "nginx");
          return !!p && sh.podReady(p) && sh.ran(/^(kubectl|k) get (pods?|po)\b/);
        },
        fail: "O Pod ainda não está Running — liste os pods novamente.",
      },
      {
        title: "Ler os logs",
        body: ["Os logs mostram a saída padrão do container. Confirme que o nginx subiu com sucesso."],
        code: ["kubectl logs nginx"],
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
    intro: "Deployments gerenciam ReplicaSets que garantem o número desejado de Pods. Se um Pod morre, outro é criado automaticamente.",
    steps: [
      {
        title: "Criar o Deployment",
        body: ["Crie um Deployment chamado web com a imagem nginx:1.25."],
        code: ["kubectl create deployment web --image=nginx:1.25"],
        check: (sh) => !!depOf(sh, "web"),
        fail: "O Deployment web não existe.",
      },
      {
        title: "Escalar para 3 réplicas",
        body: ["Aumente o número de réplicas para 3 para distribuir a carga entre os workers."],
        code: ["kubectl scale deployment web --replicas=3"],
        check: (sh) => depOf(sh, "web")?.replicas === 3,
        fail: "O Deployment web ainda não tem 3 réplicas.",
      },
      {
        title: "Testar o self-healing",
        body: [
          "Apague um dos Pods do Deployment (copie um nome de kubectl get pods) e observe o ReplicaSet recriá-lo.",
          "Depois, confirme que o Deployment está 3/3 READY.",
        ],
        code: ["kubectl get pods -l app=web", "kubectl delete pod <nome-do-pod>", "kubectl get deployment web"],
        check: (sh) => sh.ran(/^(kubectl|k) delete (pods?|po)[ /]web-/) && sh.deploymentReady("web"),
        fail: "Apague um Pod web-* e aguarde o Deployment voltar para 3/3.",
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
        body: ["Exponha o Deployment web na porta 80 com tipo NodePort."],
        code: ["kubectl expose deployment web --port=80 --type=NodePort"],
        check: (sh) => sh.state.services.some((s) => s.name === "web" && s.type === "NodePort"),
        fail: "Não há um Service web do tipo NodePort.",
      },
      {
        title: "Descobrir a porta e os endpoints",
        body: ["Anote a NodePort (faixa 30000-32767) e verifique os Endpoints — devem apontar para os IPs dos Pods."],
        code: ["kubectl get svc web", "kubectl describe svc web"],
        check: (sh) => sh.ran(/^(kubectl|k) describe (svc|services?)[ /]web\b/),
      },
      {
        title: "Testar a aplicação",
        body: ["Faça uma requisição para localhost:<NodePort> e confirme a página Welcome to nginx!"],
        code: ["curl localhost:<NodePort>"],
        hint: "A NodePort aparece na coluna PORT(S) como 80:3XXXX/TCP.",
        check: (sh) => sh.flags.has("curl-svc:web"),
        fail: "Nenhuma requisição bem-sucedida ao Service web ainda.",
      },
    ],
    outro: "Aplicação acessível de fora do cluster. Em cloud, o próximo passo seria um LoadBalancer ou Ingress.",
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
    intro: "🚨 Alerta disparado: o Deployment nginx está com 0/2 réplicas disponíveis. Investigue como faria em um war room: observe, diagnostique, corrija e valide.",
    steps: [
      {
        title: "Observar o sintoma",
        body: ["Liste os Pods e identifique o STATUS de erro."],
        code: ["kubectl get pods"],
        check: (sh) => sh.ran(/^(kubectl|k) get (pods?|po|all)\b/),
      },
      {
        title: "Diagnosticar a causa raiz",
        body: ["Descreva um dos Pods com erro e leia a seção Events com atenção. O que o kubelet não conseguiu fazer?"],
        code: ["kubectl describe pod <nome-do-pod>"],
        hint: "Compare o nome da imagem com o nome real no Docker Hub… algo está digitado errado.",
        check: (sh) => sh.ran(/^(kubectl|k) (describe (pods?|po)[ /]nginx-|get (events|ev))/),
        fail: "Descreva um Pod nginx-* (ou veja kubectl get events).",
      },
      {
        title: "Corrigir a imagem",
        body: ["Atualize o container nginx do Deployment para a imagem correta, nginx:1.25."],
        code: ["kubectl set image deployment/nginx nginx=nginx:1.25"],
        check: (sh) => depOf(sh, "nginx")?.image.replace(/^docker\.io\/(library\/)?/, "") === "nginx:1.25",
        fail: "A imagem do Deployment ainda não é nginx:1.25.",
      },
      {
        title: "Validar o rollout",
        body: ["Confirme que o rollout terminou e que os 2 Pods estão Running."],
        code: ["kubectl rollout status deployment/nginx", "kubectl get pods"],
        check: (sh) => sh.deploymentReady("nginx") && sh.ran(/^(kubectl|k) rollout status/),
        fail: "O rollout ainda não está completo — aguarde alguns segundos e rode rollout status.",
      },
    ],
    outro: "Incidente resolvido. Post-mortem: adicionar validação de imagem no pipeline de CI (ex.: crane/skopeo) para detectar o typo antes do deploy.",
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
        check: (sh) => depOf(sh, "api")?.image === "nginx:1.25",
      },
      {
        title: "Inspecionar o histórico",
        body: ["Cada mudança no Pod template cria uma nova revisão."],
        code: ["kubectl rollout history deployment/api"],
        check: (sh) => sh.ran(/^(kubectl|k) rollout history/),
      },
      {
        title: "Rollback",
        body: ["Um alerta de latência disparou após o deploy. Reverta para a revisão anterior e confirme a imagem."],
        code: ["kubectl rollout undo deployment/api", "kubectl describe deployment api"],
        check: (sh) => {
          const d = depOf(sh, "api");
          return !!d && d.image === "nginx:1.24" && d.revision >= 3;
        },
        fail: "O Deployment api ainda não voltou para nginx:1.24.",
      },
    ],
    outro: "Rollback em segundos. Em produção, combine isso com canary + análise automática (Argo Rollouts).",
  },
  {
    id: "docker-basics",
    track: "docker",
    kind: "lab",
    title: "Executar seu primeiro container",
    summary: "Pull, run com port-mapping e teste via curl.",
    level: "Iniciante",
    minutes: 6,
    skills: ["docker pull", "docker run", "port mapping"],
    intro: "Containers empacotam a aplicação com suas dependências. Vamos subir um nginx:alpine e acessá-lo pela porta 8080.",
    steps: [
      {
        title: "Baixar a imagem",
        body: ["Faça pull da imagem nginx:alpine."],
        code: ["docker pull nginx:alpine"],
        check: (sh) => sh.state.images.includes("nginx:alpine"),
      },
      {
        title: "Subir o container",
        body: ["Rode o container em background (-d), mapeando a porta 8080 do host para a 80 do container, com o nome web."],
        code: ["docker run -d -p 8080:80 --name web nginx:alpine"],
        check: (sh) => sh.state.containers.some((c) => c.name === "web" && c.status === "running" && c.ports?.host === 8080),
        fail: "Não há container web rodando com a porta 8080 mapeada.",
      },
      {
        title: "Testar e listar",
        body: ["Acesse a aplicação e liste os containers ativos."],
        code: ["curl localhost:8080", "docker ps"],
        check: (sh) => sh.flags.has("curl-docker") && sh.ran(/^docker ps/),
      },
    ],
    outro: "Com essa imagem, o próximo passo é publicá-la no ECR e implantá-la no EKS.",
  },
  {
    id: "terraform-eks",
    track: "terraform",
    kind: "lab",
    title: "Provisionar um cluster EKS com Terraform",
    summary: "IaC na AWS: VPC, EKS e node group.",
    level: "Avançado",
    minutes: 12,
    skills: ["terraform init", "terraform plan", "terraform apply", "terraform state"],
    seed: {
      files: {
        "main.tf": `terraform {
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.0" }
  }
}

provider "aws" { region = "sa-east-1" }

resource "aws_vpc" "lab" { cidr_block = "10.0.0.0/16" }

resource "aws_eks_cluster" "lab" {
  name     = "danylo-lab"
  version  = "1.30"
  role_arn = var.cluster_role_arn
  vpc_config { subnet_ids = var.subnet_ids }
}

resource "aws_eks_node_group" "workers" {
  cluster_name   = aws_eks_cluster.lab.name
  instance_types = ["t3.medium"]
  scaling_config {
    desired_size = 2
    max_size     = 4
    min_size     = 1
  }
}

output "cluster_endpoint" { value = aws_eks_cluster.lab.endpoint }
output "cluster_name"     { value = aws_eks_cluster.lab.name }`,
      },
    },
    intro: "O arquivo main.tf descreve uma VPC, um cluster EKS e um node group. Siga o fluxo padrão de IaC.",
    steps: [
      {
        title: "Revisar e inicializar",
        body: ["Leia o main.tf e inicialize o diretório para baixar o provider AWS."],
        code: ["cat main.tf", "terraform init"],
        check: (sh) => sh.state.tf.initialized,
      },
      {
        title: "Gerar o plano",
        body: ["O plan mostra exatamente o que será criado — revise antes de aplicar (em CI, isso vira comentário no PR)."],
        code: ["terraform plan"],
        check: (sh) => sh.state.tf.planned,
      },
      {
        title: "Aplicar",
        body: ["Provisione os recursos."],
        code: ["terraform apply -auto-approve"],
        check: (sh) => sh.state.tf.applied,
      },
      {
        title: "Inspecionar o state",
        body: ["Liste os recursos gerenciados e leia os outputs."],
        code: ["terraform state list", "terraform output"],
        check: (sh) => sh.ran(/^(terraform|tf) state list/) && sh.state.tf.applied,
      },
    ],
    outro: "Infra provisionada como código. Em produção: backend remoto S3 + lock no DynamoDB e pipeline com plan/apply aprovados.",
  },
];

export const ALL_SKILLS = Array.from(new Set(LABS.flatMap((l) => l.skills)));

// ---------- progress persistence ----------
const KEY = "danylo-labs-progress";

export const loadProgress = (): string[] => {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "[]");
  } catch {
    return [];
  }
};

export const saveProgress = (ids: string[]) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(ids));
  } catch {
    /* storage unavailable */
  }
};

export const markCompleted = (id: string) => {
  const done = loadProgress();
  if (!done.includes(id)) saveProgress([...done, id]);
};
