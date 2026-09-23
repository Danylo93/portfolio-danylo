// Mentor: explains commands, diagnoses mistakes and reacts to terminal output.
import { COMMANDS, KUBECTL_SUBS, type Entry, type Shell } from "./shell";
import type { Step } from "./data";

export type Tone = "success" | "error" | "info" | "tip";
export type CoachMsg = { tone: Tone; text: string };

// ---------- fuzzy matching ----------
const lev = (a: string, b: string) => {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
};

const closest = (word: string, options: string[]) => {
  let best: string | undefined;
  let score = Infinity;
  for (const o of options) {
    const s = lev(word.toLowerCase(), o);
    if (s < score) { score = s; best = o; }
  }
  return score <= Math.max(2, Math.floor(word.length / 3)) ? best : undefined;
};

const RESOURCES = ["nodes", "pods", "deployments", "services", "svc", "namespaces", "ns", "events", "replicasets", "all"];

// ---------- command explainer ----------
const SUB_DESC: Record<string, string> = {
  get: "lista recursos em formato de tabela (visão resumida)",
  describe: "mostra todos os detalhes do recurso, incluindo a seção Events — o melhor amigo do troubleshooting",
  run: "cria um Pod avulso a partir de uma imagem (sem Deployment por trás)",
  create: "cria um recurso de forma imperativa",
  scale: "altera o número de réplicas desejadas",
  expose: "cria um Service apontando para os Pods do recurso",
  set: "altera um campo de um recurso existente",
  rollout: "gerencia o ciclo de vida de atualizações de um Deployment",
  delete: "remove um recurso do cluster",
  logs: "mostra o stdout/stderr do container",
  apply: "aplica um manifesto YAML de forma declarativa (cria ou atualiza)",
  top: "mostra consumo de CPU/memória (requer metrics-server)",
  version: "mostra a versão do cliente kubectl e do API server",
  "cluster-info": "mostra os endereços do control plane e dos serviços do sistema",
  config: "lê/altera o kubeconfig (~/.kube/config)",
};

const TOKEN_DESC: Record<string, string> = {
  nodes: "tipo de recurso: as máquinas do cluster", node: "tipo de recurso: um nó do cluster", no: "abreviação de nodes",
  pods: "tipo de recurso: a menor unidade que roda containers", pod: "tipo de recurso: Pod", po: "abreviação de pods",
  deployment: "tipo de recurso: Deployment (gerencia ReplicaSets e rolling updates)", deployments: "tipo de recurso: Deployments", deploy: "abreviação de deployment",
  svc: "abreviação de service — IP/porta estáveis na frente dos Pods", service: "tipo de recurso: Service", services: "tipo de recurso: Services",
  namespaces: "tipo de recurso: divisões lógicas do cluster", ns: "abreviação de namespaces",
  events: "eventos recentes do cluster (agendamento, pull de imagem, erros)",
  "current-context": "mostra qual cluster/contexto o kubectl está usando agora",
  image: "sub-ação: trocar a imagem de um container",
  status: "acompanha o rollout até terminar (ou falhar)",
  history: "lista as revisões anteriores do Deployment",
  undo: "volta para a revisão anterior (rollback)",
  pull: "baixa uma imagem do registry",
  ps: "lista containers em execução",
  images: "lista imagens baixadas localmente",
  init: "baixa providers/módulos e prepara o backend de state",
  plan: "mostra o que será criado/alterado/destruído — sem aplicar nada",
  "state": "subcomandos que leem o arquivo de state",
  list: "lista os recursos gerenciados pelo state",
  output: "mostra os outputs definidos no código",
  destroy: "remove toda a infraestrutura gerenciada",
};

const CMD_DESC: Record<string, string> = {
  kubectl: "CLI do Kubernetes — envia requisições para o API server",
  k: "alias comum para kubectl",
  docker: "CLI do Docker — conversa com o Docker daemon",
  terraform: "CLI do Terraform — Infrastructure as Code",
  curl: "faz uma requisição HTTP e imprime a resposta",
  cat: "imprime o conteúdo de um arquivo",
};

const flagDesc = (t: string): string | undefined => {
  const [k, v] = t.split("=");
  switch (k) {
    case "-o": case "--output": return "formato de saída";
    case "--image": return `imagem do container${v ? `: ${v}` : ""}`;
    case "--replicas": return `quantidade de Pods desejada${v ? `: ${v}` : ""}`;
    case "--port": return `porta do Service${v ? `: ${v}` : ""}`;
    case "--target-port": return "porta do container para onde o tráfego vai";
    case "--type": return `tipo do Service${v === "NodePort" ? ": NodePort abre uma porta 30000-32767 em todos os nós" : v ? `: ${v}` : ""}`;
    case "-l": case "--selector": return "filtra por label (ex.: app=web)";
    case "-n": case "--namespace": return "namespace alvo";
    case "-A": case "--all-namespaces": return "todos os namespaces";
    case "-f": return "arquivo de manifesto";
    case "-d": return "detached — roda em background";
    case "-p": return "mapeia porta host:container";
    case "--name": return "nome do container";
    case "-a": return "inclui containers parados";
    case "-auto-approve": return "aplica sem pedir confirmação (comum em pipelines)";
    case "--client": return "apenas a versão do cliente";
    default: return undefined;
  }
};

export const explainCommand = (cmd: string): { part: string; desc: string }[] => {
  const tokens = cmd.split(/\s+/).filter(Boolean);
  const out: { part: string; desc: string }[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    let desc: string | undefined;
    if (i === 0) desc = CMD_DESC[t];
    else if (/^<.*>$/.test(t)) desc = "placeholder — substitua pelo valor real (use Tab para autocompletar nomes)";
    else if (t.startsWith("-")) {
      desc = flagDesc(t);
      if ((t === "-o" || t === "-p" || t === "-l" || t === "-n" || t === "-f") && tokens[i + 1]) {
        const val = tokens[++i];
        out.push({ part: `${t} ${val}`, desc: `${desc}${t === "-o" && val === "wide" ? ": wide mostra colunas extras (IP, nó…)" : `: ${val}`}` });
        continue;
      }
    } else if (i === 1 && (tokens[0] === "kubectl" || tokens[0] === "k")) desc = SUB_DESC[t];
    else if (t.includes("/") && !t.startsWith("http")) desc = `recurso no formato tipo/nome → ${t.split("/")[0]} chamado "${t.split("/")[1]}"`;
    else if (/^\w[\w-]*=[\w.:/-]+$/.test(t) && tokens.includes("image")) desc = `container=nova-imagem → container "${t.split("=")[0]}" passa a usar ${t.split("=")[1]}`;
    else if (/^localhost:|^\d+\.\d+/.test(t)) desc = "endereço:porta de destino";
    else desc = TOKEN_DESC[t] ?? (tokens[0] === "kubectl" || tokens[0] === "docker" ? "nome do recurso" : undefined);
    if (tokens[0] === "kubectl" && i === 2 && tokens[1] === "create" && t === "deployment") desc = "tipo de recurso a criar: Deployment";
    out.push({ part: t, desc: desc ?? "argumento" });
  }
  return out;
};

// ---------- error explainer ----------
export const explainError = (e: Entry, sh: Shell): string | null => {
  const { cmd, output } = e;
  const tokens = cmd.split(/\s+/);

  if (/<[^>]+>/.test(cmd))
    return `Você executou o comando com o placeholder ${cmd.match(/<[^>]+>/)![0]}. Ele é só um marcador: troque pelo nome real (liste os recursos com kubectl get e use Tab para autocompletar).`;

  let m = /^bash: (\S+): command not found/.exec(output);
  if (m) {
    const sug = closest(m[1], COMMANDS);
    return sug
      ? `"${m[1]}" não existe — parece erro de digitação de "${sug}". Tente: ${[sug, ...tokens.slice(1)].join(" ")}`
      : `O comando "${m[1]}" não existe neste ambiente. Digite help para ver os comandos disponíveis.`;
  }

  m = /unknown command "([^"]+)" for "kubectl"/.exec(output);
  if (m) {
    const sug = closest(m[1], KUBECTL_SUBS);
    return `"${m[1]}" não é um subcomando do kubectl.${sug ? ` Você quis dizer "${sug}"?` : ""} A estrutura é sempre: kubectl <verbo> <recurso> <nome> [flags].`;
  }

  m = /doesn't have a resource type "([^"]+)"/.exec(output);
  if (m) {
    const sug = closest(m[1], RESOURCES);
    return `O tipo de recurso "${m[1]}" não existe.${sug ? ` Você quis dizer "${sug}"?` : ""} Tipos comuns: pods (po), deployments (deploy), services (svc), nodes (no), namespaces (ns).`;
  }

  m = /\(NotFound\): ([\w.]+) "([^"]+)" not found|error: pods "([^"]+)" not found/.exec(output);
  if (m) {
    const kind = (m[1] ?? "pods").split(".")[0];
    const name = m[2] ?? m[3];
    const pool =
      kind.startsWith("pod") ? sh.state.pods.map((p) => p.name)
      : kind.startsWith("deploy") ? sh.state.deployments.map((d) => d.name)
      : kind.startsWith("service") ? sh.state.services.map((s) => s.name)
      : ["lab-control-plane", "lab-worker", "lab-worker2"];
    const sug = closest(name, pool);
    return `Não existe ${kind} chamado "${name}".${sug ? ` O mais parecido é "${sug}".` : pool.length ? ` Existentes: ${pool.slice(0, 4).join(", ")}.` : " Ainda não há nenhum criado."} Dica: liste com kubectl get ${kind} e use Tab para completar o nome.`;
  }

  if (/AlreadyExists|already exists|already in use/.test(output))
    return "Esse recurso já existe — não precisa criar de novo. Se quiser recriar, apague antes com delete. Caso contrário, siga para o próximo comando.";
  if (/required flag\(s\) "image"/.test(output))
    return "Faltou informar a imagem. Use a flag --image=<imagem>, por exemplo --image=nginx:1.25.";
  if (/couldn't find port/.test(output))
    return "O expose precisa saber em qual porta o Service vai escutar. Adicione --port=80.";
  if (/--replicas=COUNT/.test(output))
    return "Informe quantas réplicas você quer com --replicas=<número>.";
  if (/expected CONTAINER=IMAGE/.test(output))
    return "A sintaxe do set image é: kubectl set image deployment/<deploy> <container>=<imagem>. O container costuma ter o mesmo nome do Deployment.";
  if (/unable to find container named/.test(output))
    return `O nome antes do "=" é o nome do CONTAINER, não da imagem. Neste lab o container tem o mesmo nome do Deployment (ex.: nginx=nginx:1.25).`;
  if (/You must specify the type of resource/.test(output))
    return "Faltou dizer o que listar. Exemplo: kubectl get pods, kubectl get nodes, kubectl get svc.";
  if (/Backend initialization required/.test(output))
    return "O Terraform ainda não foi inicializado neste diretório. Rode terraform init primeiro — ele baixa o provider AWS.";
  if (/pull access denied|repository does not exist/.test(output))
    return "Essa imagem não existe no registry. Confira o nome (erros comuns: ngnix, nignx) e a tag.";
  if (/port is already allocated/.test(output))
    return "Essa porta do host já está sendo usada por outro container. Use outra porta ou pare o container anterior (docker stop <nome>).";
  if (/Connection refused/.test(output)) {
    const svc = sh.state.services.find((s) => s.nodePort);
    return `Nada está escutando nessa porta.${svc ? ` A NodePort do Service ${svc.name} é ${svc.nodePort} (veja em kubectl get svc).` : " Confira a porta mapeada."}`;
  }
  if (/is waiting to start/.test(output))
    return "O container ainda não iniciou, então não há logs. Veja o motivo com kubectl describe pod <nome> ou aguarde alguns segundos.";
  if (/exceeded its progress deadline/.test(output))
    return "O rollout não consegue terminar porque os Pods novos não ficam prontos. Investigue com kubectl describe pod (seção Events).";
  if (/No such file/.test(output)) return "Esse arquivo não existe. Use ls para ver os arquivos do diretório.";
  if (/requires (exactly|at least) 1 argument/.test(output)) return "Faltou o argumento principal (a imagem). Ex.: docker pull nginx:alpine.";
  if (/No such container/.test(output)) return "Não há container com esse nome. Veja os nomes com docker ps -a.";
  if (/^(error|Error)/.test(output)) return "O comando retornou erro. Leia a mensagem do terminal com calma — ela quase sempre diz exatamente o que falta.";
  return null;
};

// ---------- output observations ----------
const observe = (e: Entry): string | null => {
  const { output, cmd } = e;
  if (/ImagePullBackOff|ErrImagePull/.test(output) && /get (po|pod|pods|all)\b/.test(cmd))
    return "Repare no STATUS ImagePullBackOff/ErrImagePull: o kubelet não conseguiu baixar a imagem do container. O motivo exato aparece nos Events do describe.";
  if (/ContainerCreating/.test(output))
    return "ContainerCreating = o Pod já foi agendado num nó e a imagem está sendo baixada. Espere alguns segundos e liste de novo.";
  if (/Failed to pull image "([^"]+)"/.test(output) && /describe/.test(cmd))
    return `Achou! Os Events mostram "Failed to pull image". Olhe o nome da imagem com atenção: ${/Failed to pull image "([^"]+)"/.exec(output)![1]}.`;
  if (/Waiting for deployment/.test(output) && /successfully rolled out/.test(output))
    return "O rollout esperou as réplicas novas ficarem prontas e terminou com sucesso.";
  if (/Endpoints:\s+<none>/.test(output))
    return "Endpoints <none>: nenhum Pod pronto casa com o selector do Service — o tráfego não teria para onde ir.";
  return null;
};

// ---------- reactions & diagnosis ----------
const expectedHead = (step: Step) =>
  (step.code ?? []).map((c) => c.split(/\s+/).slice(0, 2).join(" "));

/** Live reaction after each command, shown in the mentor feed. */
export const react = (e: Entry, step: Step | null, sh: Shell): CoachMsg | null => {
  if (!e.ok) {
    const why = explainError(e, sh);
    return why ? { tone: "error", text: why } : null;
  }
  if (step?.check(sh)) return { tone: "success", text: "Isso cumpre o passo! Clique em Verificar para confirmar e ver a explicação." };
  const obs = observe(e);
  if (obs) return { tone: "info", text: obs };
  if (step && e.cmd !== "clear" && e.cmd !== "help") {
    const head = e.cmd.split(/\s+/).slice(0, 2).join(" ");
    const exp = expectedHead(step);
    if (exp.length && !exp.includes(head) && !exp.some((x) => x.startsWith(head)))
      return { tone: "tip", text: `Comando executado, mas ele não avança este passo. O objetivo agora é: ${step.title.toLowerCase()}.` };
  }
  return null;
};

/** Explains why Verificar failed, from most to least specific. */
export const diagnose = (step: Step, sh: Shell, since: number): string => {
  const custom = step.diagnose?.(sh);
  if (custom) return custom;

  const recent = sh.entries.slice(since).filter((x) => x.cmd !== "clear");
  if (!recent.length)
    return `Você ainda não executou nenhum comando neste passo. Comece por: ${step.code?.[0] ?? "o comando indicado acima"}`;

  const last = recent[recent.length - 1];
  if (!last.ok) {
    const why = explainError(last, sh);
    if (why) return `Seu último comando falhou. ${why}`;
  }

  const exp = step.code?.[0];
  if (exp) {
    const [c1, s1, r1] = exp.split(/\s+/);
    const [c2, s2, r2] = last.cmd.split(/\s+/);
    if (c1 !== c2) return `Você rodou "${last.cmd}", mas este passo usa o ${c1}. Esperado algo como: ${exp}`;
    if (s1 !== s2) return `Quase: você usou "${c2} ${s2 ?? ""}", mas aqui o verbo certo é "${s1}". ${SUB_DESC[s1] ? `(${s1} ${SUB_DESC[s1]}.)` : ""} Esperado: ${exp}`;
    if (r1 && r2 && r1 !== r2 && !r1.startsWith("<")) return `O verbo está certo, mas o alvo não: você usou "${r2}" e o passo pede "${r1}". Esperado: ${exp}`;
  }
  return step.fail ?? `Ainda não. Revise o objetivo do passo e tente: ${exp ?? "o comando indicado"}`;
};
