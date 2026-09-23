import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";
import {
  ArrowLeft, Bot, Brain, Check, ChevronLeft, ChevronRight, Copy, HelpCircle, Info, Lightbulb, ListChecks, RotateCcw, Timer, X,
} from "lucide-react";
import { LABS, itemUrl, markCompleted, nextInPath } from "@/labs/data";
import { Shell } from "@/labs/shell";
import { diagnose, explainCommand, react, type CoachMsg } from "@/labs/coach";
import Terminal, { type TerminalHandle } from "@/labs/Terminal";
import NotFound from "./NotFound";

const fmt = (s: number) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;

const TONE = {
  success: { Icon: Check, cls: "border-green-500/40 bg-green-500/10 text-green-200", icon: "text-green-400" },
  error: { Icon: X, cls: "border-red-500/40 bg-red-500/10 text-red-200", icon: "text-red-400" },
  info: { Icon: Info, cls: "border-sky-500/40 bg-sky-500/10 text-sky-200", icon: "text-sky-400" },
  tip: { Icon: Lightbulb, cls: "border-yellow-500/40 bg-yellow-500/10 text-yellow-100", icon: "text-yellow-400" },
} as const;

const IDLE_NUDGE_SEC = 45;

const LabRunner = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  const lab = LABS.find((l) => l.id === id);
  const [run, setRun] = useState(0);
  const shell = useMemo(() => (lab ? new Shell(lab.seed) : null), [lab, run]); // eslint-disable-line react-hooks/exhaustive-deps -- run forces a fresh environment
  const term = useRef<TerminalHandle>(null);
  const feedEnd = useRef<HTMLDivElement>(null);

  // -1 = intro, steps.length = finished
  const [step, setStep] = useState(-1);
  const [passed, setPassed] = useState<number[]>([]);
  const [solved, setSolved] = useState(false);
  const [failMsg, setFailMsg] = useState<string | null>(null);
  const [hintLevel, setHintLevel] = useState(0);
  const [feed, setFeed] = useState<CoachMsg[]>([]);
  const [explainOpen, setExplainOpen] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [copied, setCopied] = useState<string | null>(null);
  const [stats, setStats] = useState({ hints: 0, misses: 0 });
  const stepStart = useRef(0);
  const idle = useRef(0);
  const announced = useRef(false);

  useEffect(() => {
    setStep(-1);
    setPassed([]);
    setElapsed(0);
    setStats({ hints: 0, misses: 0 });
  }, [id, run]);

  useEffect(() => {
    if (!lab || step >= lab.steps.length) return;
    const t = setInterval(() => {
      setElapsed((e) => e + 1);
      idle.current += 1;
      if (idle.current === IDLE_NUDGE_SEC && step >= 0) {
        setFeed((f) => [...f, { tone: "tip", text: "Travou? Sem problema — clique em \"Dica\" para receber uma pista. A primeira dica explica o conceito, sem entregar a resposta." }]);
      }
    }, 1000);
    return () => clearInterval(t);
  }, [lab, step]);

  useEffect(() => {
    setSolved(false);
    setFailMsg(null);
    setHintLevel(0);
    setFeed([]);
    setExplainOpen(null);
    idle.current = 0;
    announced.current = false;
    stepStart.current = shell?.entries.length ?? 0;
  }, [step, shell]);

  useEffect(() => {
    feedEnd.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [feed, solved, failMsg, hintLevel]);

  if (!lab || !shell) return <NotFound />;

  const next = nextInPath(lab.id);
  const finished = step >= lab.steps.length;
  const current = step >= 0 && !finished ? lab.steps[step] : null;
  const progress = finished ? 100 : (passed.length / lab.steps.length) * 100;
  const isLast = step === lab.steps.length - 1;

  const onCommand = () => {
    idle.current = 0;
    const entry = shell.entries[shell.entries.length - 1];
    if (!entry || solved) return;
    const msg = react(entry, current, shell, announced.current);
    if (msg?.tone === "success") announced.current = true;
    if (msg) setFeed((f) => [...f.slice(-5), msg]);
  };

  const verify = () => {
    if (!current) return;
    if (current.check(shell)) {
      setFailMsg(null);
      setSolved(true);
      setPassed((p) => (p.includes(step) ? p : [...p, step]));
      if (isLast) markCompleted(lab.id);
    } else {
      setStats((s) => ({ ...s, misses: s.misses + 1 }));
      setFailMsg(diagnose(current, shell, stepStart.current));
    }
  };

  const advance = () => setStep((s) => s + 1);

  const showHint = () => {
    if (!current || hintLevel >= current.hints.length) return;
    setHintLevel((h) => h + 1);
    setStats((s) => ({ ...s, hints: s.hints + 1 }));
  };

  const pasteCode = (c: string) => {
    term.current?.insert(c);
    navigator.clipboard?.writeText(c).catch(() => undefined);
    setCopied(c);
    setTimeout(() => setCopied(null), 1200);
  };

  const banner = `Welcome to Ubuntu 24.04 LTS (GNU/Linux 6.8.0-45-generic x86_64)\n\n  Lab: ${lab.title}\n  Cluster: kind-lab · 3 nodes · Kubernetes v1.30\n\nDigite 'help' para ver os comandos disponíveis.\n`;

  return (
    <div className="h-screen flex flex-col bg-background">
      {/* Top bar */}
      <header className="h-12 shrink-0 border-b border-border bg-[#0f141b] flex items-center gap-3 px-3 sm:px-4">
        <Link to="/labs" className="p-1.5 rounded hover:bg-muted text-muted-foreground hover:text-primary transition-colors" title="Voltar aos labs">
          <ArrowLeft size={16} />
        </Link>
        <div className="flex items-center gap-2 min-w-0">
          <ListChecks size={14} className="text-primary shrink-0" />
          <span className="text-sm text-foreground truncate">{lab.title}</span>
        </div>
        <div className="ml-auto flex items-center gap-3">
          <div className="hidden sm:flex items-center gap-2">
            <div className="w-28 h-1.5 rounded-full bg-muted overflow-hidden">
              <motion.div className="h-full bg-primary" animate={{ width: `${progress}%` }} />
            </div>
            <span className="w-6 h-6 rounded-full border border-primary/50 text-[11px] font-mono flex items-center justify-center text-primary">
              {passed.length}
            </span>
          </div>
          <span className="flex items-center gap-1 text-xs font-mono text-muted-foreground">
            <Timer size={12} /> {fmt(elapsed)}
          </span>
          <button
            onClick={() => setRun((r) => r + 1)}
            className="p-1.5 rounded hover:bg-muted text-muted-foreground hover:text-primary transition-colors"
            title="Reiniciar ambiente"
          >
            <RotateCcw size={14} />
          </button>
        </div>
      </header>

      <div className="flex-1 min-h-0 flex flex-col lg:flex-row gap-3 p-3">
        {/* Terminal */}
        <div className="flex-1 min-h-[45vh] lg:min-h-0 min-w-0">
          <Terminal key={`${lab.id}-${run}`} ref={term} shell={shell} banner={banner} onCommand={onCommand} />
        </div>

        {/* Instructions */}
        <aside className="lg:w-[440px] shrink-0 flex flex-col min-h-0 rounded-lg border border-border bg-card/70 overflow-hidden">
          {/* step pips */}
          <div className="flex gap-1.5 px-4 pt-3 shrink-0">
            {lab.steps.map((_, i) => (
              <button
                key={i}
                onClick={() => (passed.includes(i) || i <= Math.max(-1, ...passed) + 1) && setStep(i)}
                className={`h-1.5 flex-1 rounded-full transition-colors ${
                  passed.includes(i) ? "bg-primary" : i === step ? "bg-primary/50" : "bg-muted"
                }`}
                aria-label={`Passo ${i + 1}`}
              />
            ))}
          </div>

          <div className="flex-1 overflow-auto p-4">
            <AnimatePresence mode="wait">
              <motion.div
                key={step}
                initial={{ opacity: 0, x: 12 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -12 }}
                transition={{ duration: 0.2 }}
              >
                {step === -1 && (
                  <div className="space-y-4">
                    <span className="text-[10px] font-mono uppercase tracking-wider text-primary">
                      {lab.kind === "challenge" ? "desafio" : "laboratório"} · {lab.level} · {lab.minutes} min
                    </span>
                    <h2 className="text-xl font-display font-bold text-foreground">{lab.title}</h2>
                    <p className="text-sm text-muted-foreground leading-relaxed">{lab.intro}</p>
                    <div>
                      <div className="text-xs font-mono text-muted-foreground mb-2">Habilidades deste lab</div>
                      <div className="flex flex-wrap gap-1.5">
                        {lab.skills.map((s) => (
                          <span key={s} className="text-[11px] font-mono px-2 py-0.5 rounded border border-primary/30 text-primary bg-primary/10">{s}</span>
                        ))}
                      </div>
                    </div>
                    <ol className="space-y-1.5 text-sm text-muted-foreground">
                      {lab.steps.map((s, i) => (
                        <li key={i} className="flex gap-2"><span className="font-mono text-primary">{i + 1}.</span>{s.title}</li>
                      ))}
                    </ol>
                    <div className="rounded-lg border border-border bg-muted/30 p-3 text-xs text-muted-foreground space-y-1.5">
                      <div className="flex items-center gap-1.5 text-foreground font-mono"><Bot size={13} className="text-primary" /> Como funciona</div>
                      <p>• Rode os comandos no terminal e clique em <span className="text-primary">Verificar</span>.</p>
                      <p>• O Mentor comenta cada comando: explica erros, sugere correções e avisa quando o passo está pronto.</p>
                      <p>• Travou? <span className="text-yellow-300">Dica</span> revela pistas aos poucos — conceito, sintaxe e, por último, a solução.</p>
                      <p>• Clique em <HelpCircle size={11} className="inline" /> ao lado de um comando para entender cada parte dele.</p>
                    </div>
                  </div>
                )}

                {current && (
                  <div className="space-y-4">
                    <span className="text-[10px] font-mono uppercase tracking-wider text-primary">
                      Passo {step + 1} de {lab.steps.length}
                    </span>
                    <h2 className="text-lg font-display font-bold text-foreground">{current.title}</h2>
                    {current.body.map((p, i) => (
                      <p key={i} className="text-sm text-muted-foreground leading-relaxed">{p}</p>
                    ))}

                    {current.code?.map((c) => (
                      <div key={c}>
                        <div className="flex items-stretch gap-1.5">
                          <button
                            onClick={() => pasteCode(c)}
                            className="group flex-1 min-w-0 text-left flex items-center gap-2 rounded-md border border-border bg-[#0b0f14] px-3 py-2 font-mono text-[12px] text-green-300 hover:border-primary/50 transition-colors"
                            title="Clique para colar no terminal"
                          >
                            <span className="text-muted-foreground select-none">$</span>
                            <span className="flex-1 break-all">{c}</span>
                            {copied === c ? <Check size={13} className="text-primary" /> : <Copy size={13} className="text-muted-foreground opacity-0 group-hover:opacity-100" />}
                          </button>
                          <button
                            onClick={() => setExplainOpen((o) => (o === c ? null : c))}
                            className={`px-2 rounded-md border transition-colors ${explainOpen === c ? "border-primary/60 text-primary" : "border-border text-muted-foreground hover:text-primary"}`}
                            title="Entender este comando"
                            aria-label="Entender este comando"
                          >
                            <HelpCircle size={14} />
                          </button>
                        </div>
                        <AnimatePresence>
                          {explainOpen === c && (
                            <motion.ul
                              initial={{ opacity: 0, height: 0 }}
                              animate={{ opacity: 1, height: "auto" }}
                              exit={{ opacity: 0, height: 0 }}
                              className="mt-1.5 rounded-md border border-border bg-muted/30 p-2.5 space-y-1 overflow-hidden"
                            >
                              {explainCommand(c).map((p, i) => (
                                <li key={i} className="text-[11.5px] leading-snug flex gap-2">
                                  <code className="font-mono text-green-300 shrink-0">{p.part}</code>
                                  <span className="text-muted-foreground">→ {p.desc}</span>
                                </li>
                              ))}
                            </motion.ul>
                          )}
                        </AnimatePresence>
                      </div>
                    ))}

                    {/* Progressive hints */}
                    {hintLevel > 0 && (
                      <div className="space-y-2">
                        {current.hints.slice(0, hintLevel).map((h, i) => {
                          const isSolution = i === current.hints.length - 1;
                          return (
                            <motion.div
                              key={i}
                              initial={{ opacity: 0, y: 6 }}
                              animate={{ opacity: 1, y: 0 }}
                              className={`rounded-md border px-3 py-2 text-xs ${isSolution ? "border-primary/40 bg-primary/10" : "border-yellow-500/40 bg-yellow-500/10"}`}
                            >
                              <div className={`font-mono text-[10px] uppercase tracking-wider mb-1 ${isSolution ? "text-primary" : "text-yellow-400"}`}>
                                {isSolution ? `Solução · dica ${i + 1} de ${current.hints.length}` : `Dica ${i + 1} de ${current.hints.length}`}
                              </div>
                              {isSolution && !/[(<—&\n]|troque|depois/.test(h) ? (
                                <button onClick={() => pasteCode(h)} className="font-mono text-green-300 text-left break-all hover:underline" title="Clique para colar no terminal">
                                  $ {h}
                                </button>
                              ) : isSolution ? (
                                <p className="font-mono text-green-300 break-all whitespace-pre-wrap">{h.includes("\n") ? h : `$ ${h}`}</p>
                              ) : (
                                <p className="text-yellow-100/90 leading-relaxed whitespace-pre-wrap">{h}</p>
                              )}
                            </motion.div>
                          );
                        })}
                      </div>
                    )}

                    {/* Mentor feed */}
                    {feed.length > 0 && !solved && (
                      <div className="space-y-2">
                        <div className="flex items-center gap-1.5 text-[11px] font-mono text-muted-foreground">
                          <Bot size={13} className="text-primary" /> Mentor
                        </div>
                        {feed.map((m, i) => {
                          const t = TONE[m.tone];
                          return (
                            <motion.div
                              key={i}
                              initial={{ opacity: 0, x: -8 }}
                              animate={{ opacity: 1, x: 0 }}
                              className={`flex gap-2 rounded-md border px-3 py-2 text-xs leading-relaxed ${t.cls}`}
                            >
                              <t.Icon size={14} className={`shrink-0 mt-px ${t.icon}`} />
                              <span>{m.text}</span>
                            </motion.div>
                          );
                        })}
                      </div>
                    )}

                    {/* Failed verification */}
                    <AnimatePresence>
                      {failMsg && !solved && (
                        <motion.div
                          initial={{ opacity: 0, y: 6 }}
                          animate={{ opacity: 1, y: 0 }}
                          exit={{ opacity: 0 }}
                          className="rounded-lg border border-red-500/40 bg-red-500/10 p-3"
                        >
                          <div className="flex items-center gap-1.5 text-sm font-medium text-red-300">
                            <X size={15} /> Ainda não passou
                          </div>
                          <p className="mt-1.5 text-xs text-red-100/90 leading-relaxed">
                            <span className="font-semibold">Por quê: </span>{failMsg}
                          </p>
                          {hintLevel < current.hints.length && (
                            <button onClick={showHint} className="mt-2 text-[11px] font-mono text-yellow-300 hover:underline flex items-center gap-1">
                              <Lightbulb size={11} /> {hintLevel === 0 ? "ver uma dica" : "ver próxima dica"}
                            </button>
                          )}
                        </motion.div>
                      )}
                    </AnimatePresence>

                    {/* Success + explanation */}
                    <AnimatePresence>
                      {solved && (
                        <motion.div
                          initial={{ opacity: 0, y: 10, scale: 0.98 }}
                          animate={{ opacity: 1, y: 0, scale: 1 }}
                          className="rounded-lg border border-green-500/40 bg-green-500/10 p-3.5 space-y-2.5"
                        >
                          <div className="flex items-center gap-2 text-sm font-medium text-green-300">
                            <motion.span
                              initial={{ scale: 0 }}
                              animate={{ scale: 1 }}
                              transition={{ type: "spring", stiffness: 300, damping: 14 }}
                              className="w-5 h-5 rounded-full bg-green-500 flex items-center justify-center"
                            >
                              <Check size={12} className="text-background" />
                            </motion.span>
                            Correto! Passo concluído
                          </div>
                          <div className="flex items-center gap-1.5 text-[11px] font-mono text-green-200/80">
                            <Brain size={12} /> O que aconteceu
                          </div>
                          {current.explain.map((p, i) => (
                            <p key={i} className="text-xs text-green-50/90 leading-relaxed">{p}</p>
                          ))}
                        </motion.div>
                      )}
                    </AnimatePresence>
                    <div ref={feedEnd} />
                  </div>
                )}

                {finished && (
                  <div className="space-y-4">
                    <motion.div
                      initial={{ scale: 0 }}
                      animate={{ scale: 1 }}
                      transition={{ type: "spring", stiffness: 260, damping: 16 }}
                      className="w-14 h-14 rounded-full bg-green-500 flex items-center justify-center"
                    >
                      <Check size={28} className="text-background" />
                    </motion.div>
                    <p className="text-sm text-muted-foreground leading-relaxed">{lab.outro}</p>

                    <div className="grid grid-cols-3 gap-2 text-center">
                      {[
                        { k: "tempo", v: fmt(elapsed) },
                        { k: "dicas usadas", v: String(stats.hints) },
                        { k: "tentativas erradas", v: String(stats.misses) },
                      ].map((s) => (
                        <div key={s.k} className="rounded-md border border-border bg-muted/30 py-2">
                          <div className="font-mono text-primary text-sm">{s.v}</div>
                          <div className="text-[10px] text-muted-foreground">{s.k}</div>
                        </div>
                      ))}
                    </div>

                    <div>
                      <div className="flex items-center gap-1.5 text-xs font-mono text-muted-foreground mb-2">
                        <Brain size={13} className="text-primary" /> O que você aprendeu
                      </div>
                      <ul className="space-y-1.5">
                        {lab.steps.map((s, i) => (
                          <li key={i} className="text-xs text-muted-foreground flex gap-2">
                            <Check size={12} className="text-green-400 shrink-0 mt-0.5" />
                            <span><span className="text-foreground">{s.title}:</span> {s.explain[0]}</span>
                          </li>
                        ))}
                      </ul>
                    </div>

                    <div className="rounded-lg border border-border bg-muted/30 p-4">
                      <div className="flex items-center gap-2 text-xs font-mono text-muted-foreground mb-2">
                        <Bot size={14} className="text-primary" /> Mentor
                      </div>
                      <p className="text-sm text-foreground">
                        Você completou este {lab.kind === "challenge" ? "challenge" : "lab"}
                        {stats.hints === 0 ? " sem usar nenhuma dica 🔥" : ""}. Gostaria de começar novamente ou passar para o próximo?
                      </p>
                      <div className="flex flex-wrap gap-2 mt-4">
                        <button
                          onClick={() => setRun((r) => r + 1)}
                          className="text-sm px-4 py-2 rounded-md border border-primary/50 text-primary hover:bg-primary/10 transition-colors"
                        >
                          Começar Novamente
                        </button>
                        {next ? (
                          <button
                            onClick={() => navigate(itemUrl(next))}
                            className="text-sm px-4 py-2 rounded-md bg-primary text-primary-foreground hover:opacity-90 transition-opacity"
                          >
                            {next.kind === "lesson" ? "Próxima Lição" : "Próximo Laboratório"}
                          </button>
                        ) : (
                          <Link to="/labs" className="text-sm px-4 py-2 rounded-md bg-primary text-primary-foreground hover:opacity-90">
                            Ver progresso
                          </Link>
                        )}
                      </div>
                      {next && <p className="mt-3 text-[11px] text-muted-foreground">Próximo sugerido: {next.item.title}</p>}
                    </div>
                  </div>
                )}
              </motion.div>
            </AnimatePresence>
          </div>

          {/* footer actions */}
          {!finished && (
            <div className="shrink-0 border-t border-border p-3 flex items-center gap-2">
              <button
                onClick={() => setStep((s) => Math.max(-1, s - 1))}
                disabled={step === -1}
                className="p-2 rounded-md border border-border text-muted-foreground hover:text-foreground disabled:opacity-30"
                aria-label="Passo anterior"
              >
                <ChevronLeft size={16} />
              </button>
              {step === -1 ? (
                <button
                  onClick={() => { setStep(0); term.current?.focus(); }}
                  className="flex-1 text-sm py-2 rounded-md bg-primary text-primary-foreground font-medium hover:opacity-90 transition-opacity"
                >
                  Iniciar
                </button>
              ) : solved || passed.includes(step) ? (
                <button
                  onClick={advance}
                  className="flex-1 text-sm py-2 rounded-md bg-primary text-primary-foreground font-medium flex items-center justify-center gap-1"
                >
                  {isLast ? "Concluir lab" : "Próximo passo"} <ChevronRight size={14} />
                </button>
              ) : (
                <>
                  <button
                    onClick={showHint}
                    disabled={!current || hintLevel >= current.hints.length}
                    className="px-3 py-2 rounded-md border border-yellow-500/40 text-yellow-300 text-sm flex items-center gap-1.5 hover:bg-yellow-500/10 disabled:opacity-30"
                    title="Revela uma dica por vez"
                  >
                    <Lightbulb size={14} />
                    Dica{current && hintLevel > 0 ? ` ${Math.min(hintLevel, current.hints.length)}/${current.hints.length}` : ""}
                  </button>
                  <button
                    onClick={verify}
                    className="flex-1 text-sm py-2 rounded-md bg-primary text-primary-foreground font-medium hover:opacity-90 transition-opacity"
                  >
                    Verificar
                  </button>
                </>
              )}
            </div>
          )}
        </aside>
      </div>
    </div>
  );
};

export default LabRunner;
