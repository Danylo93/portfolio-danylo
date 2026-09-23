import "../tools/docker";
import type { Lab, Track } from "../types";

export const track: Track = {
  id: "docker",
  title: "Docker",
  desc: "Imagens, containers, redes, volumes e Dockerfile — a base de qualquer pipeline de entrega.",
  color: "#22d3ee",
  icon: "🐳",
};


export const labs: Lab[] = [
  {
    id: "docker-basics",
    track: "docker",
    kind: "lab",
    title: "Executar seu primeiro container",
    summary: "Pull, run com mapeamento de porta e teste via curl.",
    level: "Iniciante",
    minutes: 6,
    skills: ["docker pull", "docker run", "port mapping"],
    intro: "Containers empacotam a aplicação com suas dependências. Vamos subir um nginx:alpine e acessá-lo pela porta 8080.",
    steps: [
      {
        title: "Baixar a imagem",
        body: ["Faça pull da imagem nginx:alpine."],
        code: ["docker pull nginx:alpine"],
        hints: [
          "Imagens ficam num registry (Docker Hub). O verbo que baixa uma imagem é pull.",
          "docker pull <imagem>:<tag>",
          "docker pull nginx:alpine",
        ],
        explain: [
          "O Docker baixou as camadas (layers) da imagem. Cada layer é reaproveitada entre imagens — por isso pulls seguintes costumam ser mais rápidos.",
          "A tag alpine indica uma base Alpine Linux: imagem bem menor (~48 MB contra ~188 MB), o que reduz tempo de deploy e superfície de ataque.",
        ],
        diagnose: (sh) =>
          sh.state.images.some((i) => i.startsWith("nginx:")) ? "Você baixou o nginx, mas com outra tag. O passo pede a tag alpine: docker pull nginx:alpine." : null,
        check: (sh) => sh.state.images.includes("nginx:alpine"),
      },
      {
        title: "Subir o container",
        body: ["Rode o container em background (-d), mapeando a porta 8080 do host para a 80 do container, com o nome web."],
        code: ["docker run -d -p 8080:80 --name web nginx:alpine"],
        hints: [
          "O container escuta na porta 80 dentro dele. Para acessar de fora, é preciso mapear uma porta do host.",
          "docker run -d -p <porta-host>:<porta-container> --name <nome> <imagem>",
          "docker run -d -p 8080:80 --name web nginx:alpine",
        ],
        explain: [
          "-d roda em background, -p 8080:80 cria uma regra de NAT (host:8080 → container:80) e --name dá um nome fixo, fácil de referenciar.",
          "O ID longo que apareceu é o identificador do container. Sem --name, o Docker inventaria um nome aleatório como brave_turing.",
        ],
        diagnose: (sh) => {
          const c = sh.state.containers.find((x) => x.name === "web");
          if (c && !c.ports) return "O container web está rodando, mas sem mapeamento de porta (-p). Remova com docker rm -f web e rode de novo com -p 8080:80.";
          if (c && c.ports?.host !== 8080) return `O container web mapeou a porta ${c.ports?.host}; o passo pede 8080. Remova com docker rm -f web e recrie.`;
          const anon = sh.state.containers.find((x) => x.name !== "web" && x.status === "running");
          if (anon) return `Você subiu o container com o nome "${anon.name}". Use --name web. Remova o anterior com docker rm -f ${anon.name}.`;
          return null;
        },
        check: (sh) => sh.state.containers.some((c) => c.name === "web" && c.status === "running" && c.ports?.host === 8080),
      },
      {
        title: "Testar e listar",
        body: ["Acesse a aplicação e liste os containers ativos."],
        code: ["curl localhost:8080", "docker ps"],
        hints: [
          "O container responde na porta do host que você mapeou.",
          "Use curl localhost:8080 e depois docker ps.",
          "curl localhost:8080 && docker ps",
        ],
        explain: [
          "Na coluna PORTS do docker ps você vê 0.0.0.0:8080->80/tcp: o mapeamento que fez o curl chegar ao nginx.",
          "Próximo passo natural: docker build da sua app, push para o ECR e deploy no EKS.",
        ],
        diagnose: (sh) => {
          if (!sh.flags.has("curl-docker")) return "Falta testar a aplicação: curl localhost:8080.";
          if (!sh.ran(/^docker ps/)) return "O curl funcionou! Agora liste os containers com docker ps.";
          return null;
        },
        check: (sh) => sh.flags.has("curl-docker") && sh.ran(/^docker ps/),
      },
    ],
    outro: "Com essa imagem, o próximo passo é publicá-la no ECR e implantá-la no EKS.",
  },
];
