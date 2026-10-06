import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { Lab } from "../types";
import type { CommandResult, RealLabId, RealSession } from "./catalog";
import { realRequest, type ClusterStatus } from "./client";
import { clearRealAttempt, loadRealAttempt, saveRealAttempt } from "./storage";

const HELP = `Terminal conectado ao Kubernetes real. Comandos disponíveis:
kubectl config current-context | cluster-info | version
kubectl get/describe pods, deployments, services, endpoints, events, nodes, namespaces
kubectl run <nome> --image=<imagem>
kubectl create deployment <nome> --image=<imagem>
kubectl scale deployment <nome> --replicas=<1-5>
kubectl expose deployment <nome> --port=80 --type=NodePort
kubectl set image deployment/<nome> <container>=<imagem>
kubectl rollout status/history/undo deployment/<nome>
kubectl logs <pod> | kubectl delete pod/deployment/service <nome>
clear limpa a tela; ↑/↓ percorrem o histórico.
O contexto e o namespace são fixos. Comandos interativos, arquivos locais e operadores de shell não estão disponíveis aqui. Use o terminal WSL para K9s e operações avançadas.`;

export default function RealLabRunner({ lab }: { lab: Lab }) {
  const [saved] = useState(() => loadRealAttempt(lab.id as RealLabId));
  const [cluster, setCluster] = useState<ClusterStatus | null>(null);
  const [session, setSession] = useState<RealSession | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [storageWarning, setStorageWarning] = useState(false);
  const [resumePending, setResumePending] = useState(!!saved);
  const [lines, setLines] = useState<string[]>(saved?.lines ?? []);
  const [input, setInput] = useState(saved?.input ?? "");
  const [history, setHistory] = useState<string[]>(saved?.history ?? []);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [hint, setHint] = useState(saved?.hint ?? false);
  const inputRef = useRef<HTMLInputElement>(null);
  const outputRef = useRef<HTMLPreElement>(null);
  const lock = useRef(false);
  const step = session?.passed.length ?? 0;
  const finished = !!session && step >= lab.steps.length;
  const original = lab.steps[step];
  const node = cluster?.nodes[0] ?? "danylo-lab-control-plane";
  const adapt = (text: string) => text.replace(/lab-worker/g, node).replace(/namespace default/g, "namespace desta tentativa");
  let title = original?.title;
  let body = original?.body.map(adapt) ?? [];
  let commands = original?.code?.map(adapt) ?? [];
  if (lab.id === "k8s-check-status" && step === 1) title = "Inspecionar o nó real";
  if (lab.id === "k8s-expose" && step === 2) {
    title = "Testar HTTP dentro do cluster";
    body = ["Crie um Pod temporário que faz uma requisição HTTP ao Service web. Depois leia seus logs e confirme a página Welcome to nginx!", "No Kind, a NodePort não é automaticamente publicada no localhost do WSL. Este teste usa a rede e o DNS reais do cluster. Se precisar repetir, apague o Pod probe antes de recriá-lo."];
    commands = ["kubectl run probe --image=busybox:1.37 --restart=Never -- wget -qO- http://web", "kubectl logs probe"];
  }

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const status = await realRequest<ClusterStatus>("status");
        if (!active) return;
        setCluster(status);
        if (saved) {
          try {
            const resumed = await realRequest<RealSession>("resume", status.token, { sessionId: saved.sessionId });
            if (resumed.labId !== lab.id) throw new Error("A tentativa salva pertence a outro lab.");
            if (active) { setSession(resumed); setResumePending(false); setLines((l) => [...l, `Tentativa retomada: ${resumed.namespace}. Recursos e passos preservados.`]); }
          } catch (e) {
            if (/Tentativa não encontrada|pertence a outro lab/.test(String(e))) {
              clearRealAttempt(lab.id);
              if (active) { setResumePending(false); setInput(""); setHistory([]); setLines([]); setHint(false); setMessage("O servidor anterior foi encerrado. Inicie uma nova tentativa. Recursos antigos podem ser consultados pelo K9s."); }
            } else if (active) setError(`Não foi possível retomar agora. Sua referência foi preservada; tente reconectar. ${e instanceof Error ? e.message : String(e)}`);
          }
        }
      } catch (e) { if (active) setError(String(e instanceof Error ? e.message : e)); }
      finally { if (active) setLoading(false); }
    })();
    return () => { active = false; };
  }, [lab.id, saved]);

  useEffect(() => {
    if (session) setStorageWarning(!saveRealAttempt({ version: 1, labId: lab.id, sessionId: session.id,
      lines: lines.slice(-150), history: history.slice(-500), input, hint }));
  }, [session, lab.id, lines, history, input, hint]);

  useEffect(() => { outputRef.current?.scrollTo({ top: outputRef.current.scrollHeight }); }, [lines]);

  const action = async (fn: () => Promise<void>) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true); setError(""); setMessage("");
    try { await fn(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { lock.current = false; setBusy(false); inputRef.current?.focus(); }
  };
  const start = () => action(async () => {
    const created = await realRequest<RealSession>("start", cluster?.token, { labId: lab.id });
    setSession(created); setHint(false);
    setInput(""); setHistory([]); setHistoryIndex(-1);
    setLines([`Kubernetes real · ${cluster?.context}\nNamespace: ${created.namespace}\n\nOs comandos alteram recursos reais desta tentativa. Digite help para ajuda.\n`]);
  });
  const stop = () => {
    if (!session || !window.confirm(`Encerrar esta tentativa e apagar seus recursos no namespace ${session.namespace}?`)) return;
    void action(async () => {
      await realRequest("stop", cluster?.token, { sessionId: session.id });
      setSession(null); setLines([]); setHint(false);
      setInput(""); setHistory([]); setStorageWarning(!clearRealAttempt(lab.id));
      setMessage("Tentativa encerrada. A remoção do namespace foi solicitada ao Kubernetes.");
    });
  };
  const run = () => {
    const command = input.trim();
    if (!session || !command || busy) return;
    setInput(""); setHistoryIndex(-1); setHistory((h) => [...h, command]);
    if (command === "clear") { setLines([]); return; }
    setLines((l) => [...l, `$ ${command}`]);
    if (command === "help") { setLines((l) => [...l, HELP]); return; }
    void action(async () => {
      const result = await realRequest<CommandResult>("command", cluster?.token, { sessionId: session.id, command });
      setLines((l) => [...l.slice(-150), result.output || "(sem saída)"]);
      if (!result.ok) setError("O comando retornou erro. Veja a saída do kubectl no terminal.");
    });
  };
  const verify = () => action(async () => {
    const result = await realRequest<{ passed: boolean; message: string; session: RealSession }>("verify", cluster?.token, { sessionId: session?.id, step });
    setSession(result.session);
    if (result.passed) { setMessage(result.message); setHint(false); }
    else setError(result.message);
  });

  return <main className="min-h-dvh bg-background p-3 sm:p-6">
    <header className="flex flex-wrap items-center gap-3 mb-4">
      <Link to="/labs" className="text-primary text-sm">← Labs</Link>
      <h1 className="text-lg font-semibold">{lab.title}</h1>
      <span className="rounded border border-green-500/50 bg-green-500/10 px-2 py-1 text-xs text-green-300">Kubernetes real</span>
      {session && <button onClick={stop} disabled={busy} className="ml-auto rounded border border-border px-3 py-2 text-sm disabled:opacity-50">Encerrar e limpar</button>}
    </header>
    <p className="text-sm text-muted-foreground mb-4">Contexto: {cluster?.context ?? "conectando…"} · {cluster?.nodes.length ?? 0} nó(s){session ? ` · Namespace: ${session.namespace}` : ""}</p>
    {error && <div role="alert" className="mb-4 rounded border border-red-500/50 bg-red-500/10 p-3 text-sm whitespace-pre-wrap">{error}</div>}
    {storageWarning && <p role="alert" className="mb-4 text-sm text-amber-300">Não foi possível salvar a referência ou o histórico desta tentativa no navegador.</p>}
    {message && <p role="status" className="mb-4 text-sm text-green-300">{message}</p>}
    {!session ? <section className="max-w-2xl rounded-lg border border-border bg-card p-6 space-y-4">
      <h2 className="text-xl font-semibold">Pratique no seu cluster local</h2>
      <p className="text-muted-foreground">Esta tentativa cria um namespace próprio no Kind e prepara os recursos do exercício. O botão Verificar consulta a API real do Kubernetes.</p>
      <p className="text-sm text-muted-foreground">Os recursos permanecem ao sair da página. Use Encerrar e limpar ao terminar. O progresso desta tentativa é separado do simulador.</p>
      <p className="text-sm text-muted-foreground">A referência e o histórico ficam no localStorage. A retomada depende do servidor local e do cluster; o navegador não armazena os recursos Kubernetes.</p>
      {cluster && !cluster.connected && <p role="alert" className="text-red-300 whitespace-pre-wrap">Cluster indisponível. No WSL, execute bash scripts/lab-cluster.sh create e recarregue a página. {cluster.error}</p>}
      {resumePending && !loading ? <button onClick={() => window.location.reload()} className="rounded bg-primary px-4 py-2 text-primary-foreground">Tentar reconectar</button> : <button onClick={start} disabled={loading || busy || !cluster?.connected} className="rounded bg-primary px-4 py-2 text-primary-foreground disabled:opacity-50">{loading ? "Conectando…" : busy ? "Preparando recursos…" : "Iniciar lab real"}</button>}
    </section> : <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_400px]">
      <section aria-label="Terminal Kubernetes real" className="flex min-w-0 flex-col rounded-lg border border-border bg-[#0b0f14] h-[55dvh] lg:h-[75dvh]">
        <div className="border-b border-border px-3 py-2 text-xs font-mono text-green-300">kubectl · {session.namespace} {busy ? "· executando…" : ""}</div>
        <pre ref={outputRef} aria-label="Saída do terminal" aria-live="polite" className="flex-1 overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-xs text-slate-200">{lines.join("\n\n")}</pre>
        <form onSubmit={(event) => { event.preventDefault(); run(); }} className="flex gap-2 border-t border-border p-3">
          <span className="text-green-400">$</span>
          <input ref={inputRef} aria-label="Entrada do terminal real" value={input} onChange={(e) => setInput(e.target.value)} disabled={busy} autoComplete="off" spellCheck={false} className="min-w-0 flex-1 bg-transparent font-mono text-sm outline-none" onKeyDown={(e) => {
            if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
            e.preventDefault();
            const index = e.key === "ArrowUp" ? Math.max(0, (historyIndex < 0 ? history.length : historyIndex) - 1) : historyIndex < 0 ? history.length : Math.min(history.length, historyIndex + 1);
            setHistoryIndex(index); setInput(history[index] ?? "");
          }} />
          <button disabled={busy || !input.trim()} className="text-primary text-xs disabled:opacity-50">Executar</button>
        </form>
      </section>
      <aside className="rounded-lg border border-border bg-card p-5 space-y-4">
        <p className="text-xs text-primary">{session.passed.length}/{lab.steps.length} passos validados no cluster</p>
        {finished ? <><h2 className="text-xl font-semibold">Lab real concluído!</h2><p>Todos os passos foram validados. Você pode explorar os recursos pelo terminal ou pelo K9s antes de encerrar a tentativa.</p></> : <>
          <h2 className="text-xl font-semibold">{title}</h2>
          {body.map((p) => <p key={p} className="text-sm text-muted-foreground">{p}</p>)}
          {commands.map((command) => <button key={command} onClick={() => { setInput(command); inputRef.current?.focus(); }} className="block w-full rounded border border-border bg-background p-3 text-left font-mono text-xs text-green-300 break-all">{command}</button>)}
          <div className="flex gap-2"><button onClick={() => setHint((h) => !h)} className="rounded border border-border px-3 py-2 text-sm">Dica</button><button onClick={verify} disabled={busy} className="flex-1 rounded bg-primary px-3 py-2 text-primary-foreground disabled:opacity-50">Verificar no cluster</button></div>
          {hint && <p className="text-sm text-yellow-200">{lab.id === "k8s-expose" && step === 2 ? "Aguarde o Pod probe concluir e rode kubectl logs probe. O Service deve ter endpoints prontos." : adapt(original.hints.at(-1) ?? "Confira os recursos com kubectl get pods.")}</p>}
        </>}
        <div className="border-t border-border pt-4 text-xs text-muted-foreground space-y-2"><p>Para acompanhar esta tentativa no terminal WSL:</p><code className="block break-all text-primary">k9s --context kind-danylo-lab -n {session.namespace}</code><p>Este terminal aceita os comandos kubectl destes exercícios. Digite help para ver a lista.</p></div>
      </aside>
    </div>}
  </main>;
}
