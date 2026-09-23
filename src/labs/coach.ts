// Mentor: explains commands, diagnoses mistakes and reacts to terminal output.
import type { Entry, Shell } from "./shell";
import type { Step } from "./types";
import { getTool } from "./registry";
import { closest } from "./util";
import { RESOURCE_WORDS } from "./k8s/kubectl";

export type Tone = "success" | "error" | "info" | "tip";
export type CoachMsg = { tone: Tone; text: string };

// ---------- command explainer ----------
const TOKEN_DESC: Record<string, string> = {
  nodes: "tipo de recurso: as máquinas do cluster", node: "tipo de recurso: um nó do cluster", no: "abreviação de nodes",
  pods: "tipo de recurso: a menor unidade que roda containers", pod: "tipo de recurso: Pod", po: "abreviação de pods",
  deployment: "tipo de recurso: Deployment (gerencia ReplicaSets e rolling updates)", deployments: "tipo de recurso: Deployments", deploy: "abreviação de deployment",
  svc: "abreviação de service — IP/porta estáveis na frente dos Pods", service: "tipo de recurso: Service", services: "tipo de recurso: Services",
  namespaces: "tipo de recurso: divisões lógicas do cluster", ns: "abreviação de namespaces", namespace: "tipo de recurso: Namespace",
  configmap: "tipo de recurso: configuração não sensível (chave/valor)", cm: "abreviação de configmap",
  secret: "tipo de recurso: dados sensíveis (base64)", generic: "tipo de Secret genérico (Opaque)",
  job: "tipo de recurso: tarefa que roda até completar", cronjob: "tipo de recurso: Job agendado (cron)",
  role: "tipo de recurso: permissões RBAC dentro de um namespace", rolebinding: "liga uma Role a usuários/ServiceAccounts",
  serviceaccount: "identidade usada por Pods", sa: "abreviação de serviceaccount",
  networkpolicy: "regras de firewall entre Pods", netpol: "abreviação de networkpolicy",
  pvc: "PersistentVolumeClaim — pedido de armazenamento", pv: "PersistentVolume — o disco em si",
  events: "eventos recentes do cluster (agendamento, pull de imagem, erros)",
  "current-context": "mostra qual cluster/contexto o kubectl está usando agora",
  "can-i": "pergunta ao API server se a ação é permitida",
  image: "sub-ação: trocar a imagem de um container", resources: "sub-ação: requests/limits de CPU e memória", env: "sub-ação: variáveis de ambiente",
  status: "acompanha até terminar (ou falhar)", history: "lista as revisões anteriores", undo: "volta para a revisão anterior (rollback)",
  snapshot: "operações de snapshot (backup) do etcd", save: "salva o snapshot no arquivo indicado", restore: "restaura um snapshot para um diretório de dados",
  upgrade: "atualiza componentes do cluster", plan: "mostra o que será feito — sem aplicar nada", apply: "aplica as mudanças", list: "lista itens",
  pull: "baixa uma imagem do registry", ps: "lista containers em execução", images: "lista imagens baixadas localmente",
  init: "prepara o diretório de trabalho", state: "subcomandos que leem o state", output: "mostra os outputs", destroy: "remove a infraestrutura gerenciada",
  kubelet: "agente do Kubernetes que roda em cada nó", containerd: "runtime de containers usado pelo kubelet",
};

const BUILTIN_DESC: Record<string, string> = {
  cat: "imprime o conteúdo de um arquivo", ls: "lista arquivos", cd: "muda de diretório", vi: "abre o editor de texto", vim: "abre o editor de texto", nano: "abre o editor de texto",
  curl: "faz uma requisição HTTP e imprime a resposta", wget: "faz uma requisição HTTP", ssh: "abre uma sessão em outra máquina", exit: "encerra a sessão ssh atual",
  systemctl: "controla serviços do systemd (start, stop, enable, status)", journalctl: "lê os logs do systemd", "apt-get": "gerenciador de pacotes do Ubuntu/Debian",
  grep: "filtra linhas que contêm o padrão", echo: "imprime o texto", export: "define uma variável de ambiente", base64: "codifica/decodifica base64", sed: "edita texto (substituições)",
  mkdir: "cria diretórios", rm: "remove arquivos", head: "primeiras linhas", tail: "últimas linhas",
};

const SYSTEMCTL_ACTIONS: Record<string, string> = { start: "inicia o serviço agora", stop: "para o serviço", restart: "reinicia o serviço", enable: "faz o serviço subir no boot", status: "mostra se o serviço está rodando e os últimos logs", "daemon-reload": "recarrega arquivos de unidade após mudanças" };

export const explainCommand = (cmd: string): { part: string; desc: string }[] => {
  const tokens = cmd.split(/\s+/).filter(Boolean);
  const tool = getTool(tokens[0] ?? "");
  const out: { part: string; desc: string }[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    let desc: string | undefined;
    const flagKey = t.split("=")[0];
    const val = t.includes("=") ? t.slice(t.indexOf("=") + 1) : undefined;
    if (i === 0) desc = tool?.summary ?? BUILTIN_DESC[t];
    else if (/^<.*>$/.test(t)) desc = "placeholder — substitua pelo valor real (use Tab para autocompletar nomes)";
    else if (t.startsWith("-")) {
      desc = tool?.flags?.[flagKey];
      if (desc && val) desc += `: ${val}`;
      if (flagKey === "--type" && val === "NodePort") desc = "tipo do Service: NodePort abre uma porta 30000-32767 em todos os nós";
      const takesValue = !t.includes("=") && tool?.valueFlags?.includes(t) && tokens[i + 1] && !tokens[i + 1].startsWith("-");
      if (takesValue) {
        const v = tokens[++i];
        out.push({ part: `${t} ${v}`, desc: `${desc ?? "opção"}${t === "-o" && v === "wide" ? ": wide mostra colunas extras (IP, nó…)" : `: ${v}`}` });
        continue;
      }
    } else if (i === 1 && tool?.subcommands?.[t]) desc = tool.subcommands[t];
    else if (i === 1 && tokens[0] === "systemctl") desc = SYSTEMCTL_ACTIONS[t];
    else if (t.includes("/") && !t.startsWith("http") && !t.startsWith("/") && !t.startsWith(".")) desc = `recurso no formato tipo/nome → ${t.split("/")[0]} chamado "${t.split("/")[1]}"`;
    else if (t.startsWith("/") || t.startsWith("./") || /\.(ya?ml|tf|json|db|sh|cfg|ini|txt|conf)$/.test(t)) desc = "caminho de arquivo";
    else if (/^\w[\w-]*=[\w.:/-]+$/.test(t) && tokens.includes("image")) desc = `container=nova-imagem → container "${t.split("=")[0]}" passa a usar ${t.split("=")[1]}`;
    else if (/^localhost:|^\d+\.\d+/.test(t)) desc = "endereço:porta de destino";
    else desc = TOKEN_DESC[t] ?? (tool ? "nome/argumento" : undefined);
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

  const tool = getTool(tokens[0] ?? "");
  const specific = tool?.explainError?.(cmd, output, sh);
  if (specific) return specific;

  let m = /^bash: (\S+): command not found/.exec(output);
  if (m) {
    const sug = closest(m[1], sh.commandNames());
    return sug
      ? `"${m[1]}" não existe — parece erro de digitação de "${sug}". Tente: ${[sug, ...tokens.slice(1)].join(" ")}`
      : `O comando "${m[1]}" não existe neste ambiente. Digite help para ver os comandos disponíveis.`;
  }

  m = /unknown command "([^"]*)" for "([\w-]+)/.exec(output);
  if (m) {
    const subs = Object.keys(getTool(m[2])?.subcommands ?? {});
    const sug = m[1] ? closest(m[1], subs) : undefined;
    return `"${m[1]}" não é um subcomando do ${m[2]}.${sug ? ` Você quis dizer "${sug}"?` : ""}${m[2] === "kubectl" ? " A estrutura é sempre: kubectl <verbo> <recurso> <nome> [flags]." : subs.length ? ` Opções: ${subs.slice(0, 8).join(", ")}.` : ""}`;
  }

  m = /doesn't have a resource type "([^"]+)"/.exec(output);
  if (m) {
    const sug = closest(m[1], RESOURCE_WORDS);
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
    const subDesc = getTool(c1)?.subcommands?.[s1];
    if (s1 !== s2) return `Quase: você usou "${c2} ${s2 ?? ""}", mas aqui o verbo certo é "${s1}". ${subDesc ? `(${s1} ${subDesc}.)` : ""} Esperado: ${exp}`;
    if (r1 && r2 && r1 !== r2 && !r1.startsWith("<")) return `O verbo está certo, mas o alvo não: você usou "${r2}" e o passo pede "${r1}". Esperado: ${exp}`;
  }
  return step.fail ?? `Ainda não. Revise o objetivo do passo e tente: ${exp ?? "o comando indicado"}`;
};
