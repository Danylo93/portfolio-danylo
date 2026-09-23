import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowLeft, Bot, Check, ChevronLeft, ChevronRight, Copy, Lightbulb, ListChecks, RotateCcw, Timer, X } from "lucide-react";
import { LABS, markCompleted } from "@/labs/data";
import { Shell } from "@/labs/shell";
import Terminal, { type TerminalHandle } from "@/labs/Terminal";
import NotFound from "./NotFound";

const fmt = (s: number) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;

const LabRunner = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  const lab = LABS.find((l) => l.id === id);
  const [run, setRun] = useState(0);
  const shell = useMemo(() => (lab ? new Shell(lab.seed) : null), [lab, run]); // eslint-disable-line react-hooks/exhaustive-deps -- run forces a fresh environment
  const term = useRef<TerminalHandle>(null);

  // -1 = intro, steps.length = finished
  const [step, setStep] = useState(-1);
  const [passed, setPassed] = useState<number[]>([]);
  const [feedback, setFeedback] = useState<{ ok: boolean; msg: string } | null>(null);
  const [showHint, setShowHint] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    setStep(-1);
    setPassed([]);
    setFeedback(null);
    setElapsed(0);
  }, [id, run]);

  useEffect(() => {
    if (!lab || step >= lab.steps.length) return;
    const t = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(t);
  }, [lab, step]);

  useEffect(() => {
    setShowHint(false);
    setFeedback(null);
  }, [step]);

  if (!lab || !shell) return <NotFound />;

  const idx = LABS.indexOf(lab);
  const next = LABS[idx + 1];
  const finished = step >= lab.steps.length;
  const current = step >= 0 && !finished ? lab.steps[step] : null;
  const progress = finished ? 100 : (passed.length / lab.steps.length) * 100;

  const verify = () => {
    if (!current) return;
    if (current.check(shell)) {
      setFeedback({ ok: true, msg: "Verificação concluída com sucesso!" });
      const nextPassed = passed.includes(step) ? passed : [...passed, step];
      setPassed(nextPassed);
      setTimeout(() => {
        if (nextPassed.length === lab.steps.length) {
          markCompleted(lab.id);
          setStep(lab.steps.length);
        } else setStep((s) => s + 1);
      }, 700);
    } else {
      setFeedback({ ok: false, msg: current.fail ?? "Ainda não. Execute o comando indicado no terminal e tente novamente." });
    }
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
          <Terminal key={`${lab.id}-${run}`} ref={term} shell={shell} banner={banner} />
        </div>

        {/* Instructions */}
        <aside className="lg:w-[420px] shrink-0 flex flex-col min-h-0 rounded-lg border border-border bg-card/70 overflow-hidden">
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
                      <button
                        key={c}
                        onClick={() => pasteCode(c)}
                        className="group w-full text-left flex items-center gap-2 rounded-md border border-border bg-[#0b0f14] px-3 py-2 font-mono text-[12px] text-green-300 hover:border-primary/50 transition-colors"
                        title="Clique para colar no terminal"
                      >
                        <span className="text-muted-foreground select-none">$</span>
                        <span className="flex-1 break-all">{c}</span>
                        {copied === c ? <Check size={13} className="text-primary" /> : <Copy size={13} className="text-muted-foreground opacity-0 group-hover:opacity-100" />}
                      </button>
                    ))}
                    {current.hint && (
                      <div>
                        <button onClick={() => setShowHint((h) => !h)} className="flex items-center gap-1.5 text-xs font-mono text-yellow-400/80 hover:text-yellow-300">
                          <Lightbulb size={12} /> {showHint ? "ocultar dica" : "mostrar dica"}
                        </button>
                        {showHint && <p className="mt-2 text-xs text-yellow-200/80 border-l-2 border-yellow-500/50 pl-3">{current.hint}</p>}
                      </div>
                    )}
                    <AnimatePresence>
                      {feedback && (
                        <motion.div
                          initial={{ opacity: 0, y: 6 }}
                          animate={{ opacity: 1, y: 0 }}
                          exit={{ opacity: 0 }}
                          className={`flex items-start gap-2 text-xs rounded-md px-3 py-2 border ${
                            feedback.ok ? "border-green-500/40 bg-green-500/10 text-green-300" : "border-red-500/40 bg-red-500/10 text-red-300"
                          }`}
                        >
                          {feedback.ok ? <Check size={14} className="shrink-0 mt-px" /> : <X size={14} className="shrink-0 mt-px" />}
                          {feedback.msg}
                        </motion.div>
                      )}
                    </AnimatePresence>
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
                    <div className="rounded-lg border border-border bg-muted/30 p-4">
                      <div className="flex items-center gap-2 text-xs font-mono text-muted-foreground mb-2">
                        <Bot size={14} className="text-primary" /> Mentor
                      </div>
                      <p className="text-sm text-foreground">
                        Você completou este {lab.kind === "challenge" ? "challenge" : "lab"} em {fmt(elapsed)}. Gostaria de começar novamente ou passar para o próximo?
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
                            onClick={() => navigate(`/labs/${next.id}`)}
                            className="text-sm px-4 py-2 rounded-md bg-primary text-primary-foreground hover:opacity-90 transition-opacity"
                          >
                            Próximo Laboratório
                          </button>
                        ) : (
                          <Link to="/labs" className="text-sm px-4 py-2 rounded-md bg-primary text-primary-foreground hover:opacity-90">
                            Ver progresso
                          </Link>
                        )}
                      </div>
                      {next && <p className="mt-3 text-[11px] text-muted-foreground">Próximo lab sugerido: {next.title}</p>}
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
              ) : passed.includes(step) ? (
                <button
                  onClick={() => setStep((s) => s + 1)}
                  className="flex-1 text-sm py-2 rounded-md bg-primary text-primary-foreground font-medium flex items-center justify-center gap-1"
                >
                  Próximo <ChevronRight size={14} />
                </button>
              ) : (
                <button
                  onClick={verify}
                  className="flex-1 text-sm py-2 rounded-md bg-primary text-primary-foreground font-medium hover:opacity-90 transition-opacity"
                >
                  Verificar
                </button>
              )}
            </div>
          )}
        </aside>
      </div>
    </div>
  );
};

export default LabRunner;
