import { useState } from "react";
import { Link } from "react-router-dom";
import { motion } from "framer-motion";
import { ArrowLeft, CheckCircle2, ChevronUp, Circle, Clock, FlaskConical, Lock, Puzzle, RotateCcw, Terminal } from "lucide-react";
import { ALL_SKILLS, LABS, TRACKS, loadProgress, saveProgress } from "@/labs/data";

const LEVEL_COLOR: Record<string, string> = { Iniciante: "#4ade80", Intermediário: "#fbbf24", Avançado: "#f87171" };

const Labs = () => {
  const [done, setDone] = useState<string[]>(loadProgress);
  const [open, setOpen] = useState<Record<string, boolean>>({ kubernetes: true, docker: true, terraform: true });

  const earned = new Set(LABS.filter((l) => done.includes(l.id)).flatMap((l) => l.skills));
  const pct = Math.round((earned.size / ALL_SKILLS.length) * 100);
  const nextLab = LABS.find((l) => !done.includes(l.id)) ?? LABS[0];

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-40 border-b border-border bg-background/85 backdrop-blur-md">
        <div className="container px-4 sm:px-6 h-14 flex items-center justify-between gap-4">
          <Link to="/" className="flex items-center gap-2 text-xs font-mono text-muted-foreground hover:text-primary transition-colors">
            <ArrowLeft size={14} /> portfólio
          </Link>
          <div className="flex items-center gap-2 font-mono text-primary font-bold text-sm">
            <FlaskConical size={16} /> <span>danylo<span className="text-foreground">_labs</span></span>
          </div>
          <Link
            to={`/labs/${nextLab.id}`}
            className="text-xs font-mono px-3 py-1.5 rounded-md bg-primary text-primary-foreground hover:opacity-90 transition-opacity"
          >
            Continuar
          </Link>
        </div>
      </header>

      <main className="container px-4 sm:px-6 py-10">
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="mb-10 max-w-3xl">
          <span className="font-mono text-primary text-sm">// aprender fazendo</span>
          <h1 className="text-3xl md:text-4xl font-display font-bold mt-2">
            Labs <span className="gradient-text">Interativos</span>
          </h1>
          <p className="text-muted-foreground mt-3 text-sm leading-relaxed">
            Ambientes práticos com terminal real no navegador: um cluster Kubernetes de 3 nós, Docker engine e Terraform
            com provider AWS — todos simulados. Siga os passos, rode os comandos e clique em <span className="text-primary font-mono">Verificar</span>.
          </p>
        </motion.div>

        <div className="grid lg:grid-cols-[1fr_360px] gap-8 items-start">
          {/* Tracks */}
          <div className="space-y-6 min-w-0">
            {TRACKS.map((t, ti) => {
              const labs = LABS.filter((l) => l.track === t.id);
              const count = labs.filter((l) => done.includes(l.id)).length;
              return (
                <motion.section
                  key={t.id}
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: ti * 0.08 }}
                  className="rounded-xl border bg-card/50 overflow-hidden"
                  style={{ borderColor: `${t.color}30` }}
                >
                  <div className="p-5 border-b border-border">
                    <div className="flex items-center gap-2">
                      <span className="text-xl">{t.icon}</span>
                      <h2 className="font-display font-bold text-lg" style={{ color: t.color }}>{t.title}</h2>
                    </div>
                    <p className="text-xs text-muted-foreground mt-2">{t.desc}</p>
                    <div className="mt-4 h-1.5 rounded-full bg-muted overflow-hidden">
                      <motion.div
                        className="h-full rounded-full"
                        style={{ backgroundColor: t.color }}
                        initial={{ width: 0 }}
                        animate={{ width: `${(count / labs.length) * 100}%` }}
                        transition={{ duration: 0.8 }}
                      />
                    </div>
                  </div>

                  <button
                    onClick={() => setOpen((o) => ({ ...o, [t.id]: !o[t.id] }))}
                    className="w-full flex items-center justify-between px-5 py-3 text-sm text-foreground hover:bg-muted/40 transition-colors"
                  >
                    <span>Concluído {count} de {labs.length} Labs</span>
                    <ChevronUp size={16} className={`transition-transform ${open[t.id] ? "" : "rotate-180"}`} />
                  </button>

                  {open[t.id] && (
                    <ul>
                      {labs.map((lab) => {
                        const isDone = done.includes(lab.id);
                        const Icon = lab.kind === "challenge" ? Puzzle : FlaskConical;
                        return (
                          <li key={lab.id} className="group border-t border-border">
                            <Link
                              to={`/labs/${lab.id}`}
                              className="flex items-center gap-3 px-5 py-3.5 hover:bg-muted/40 transition-colors"
                            >
                              <Icon size={16} className="shrink-0 text-muted-foreground" />
                              <div className="flex-1 min-w-0">
                                <div className="text-sm text-foreground truncate">{lab.title}</div>
                                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1 text-[10px] font-mono text-muted-foreground">
                                  <span style={{ color: LEVEL_COLOR[lab.level] }}>{lab.level}</span>
                                  <span className="flex items-center gap-1"><Clock size={10} /> {lab.minutes} min</span>
                                  <span className="uppercase">{lab.kind === "challenge" ? "desafio" : "lab"}</span>
                                </div>
                              </div>
                              <span className="hidden sm:group-hover:inline-flex text-xs font-mono px-3 py-1.5 rounded-md border border-primary/50 text-primary whitespace-nowrap">
                                {isDone ? "Refazer" : "Iniciar Laboratório"}
                              </span>
                              {isDone ? (
                                <CheckCircle2 size={18} className="shrink-0 text-green-400" />
                              ) : (
                                <Circle size={18} className="shrink-0 text-muted-foreground/60" />
                              )}
                            </Link>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </motion.section>
              );
            })}
          </div>

          {/* Skill tree */}
          <aside className="lg:sticky lg:top-20 rounded-xl border border-border bg-card/50 p-5">
            <h3 className="font-display font-semibold text-foreground">
              Progresso: {earned.size} de {ALL_SKILLS.length} Habilidades Adquiridas
            </h3>
            <div className="mt-4 h-2 rounded-full bg-muted overflow-hidden">
              <motion.div
                className="h-full rounded-full bg-primary"
                initial={{ width: 0 }}
                animate={{ width: `${pct}%` }}
                transition={{ duration: 0.8 }}
              />
            </div>
            <div className="grid grid-cols-7 gap-2 mt-5">
              {ALL_SKILLS.map((s, i) => {
                const ok = earned.has(s);
                return (
                  <motion.div
                    key={s}
                    title={s}
                    initial={{ scale: 0 }}
                    animate={{ scale: 1 }}
                    transition={{ delay: 0.2 + i * 0.02 }}
                    className={`aspect-square rounded-full flex items-center justify-center border ${
                      ok ? "bg-green-500 border-green-400 text-background" : "bg-muted/40 border-border text-muted-foreground/60"
                    }`}
                  >
                    {ok ? <CheckCircle2 size={14} /> : <Lock size={11} />}
                  </motion.div>
                );
              })}
            </div>
            <div className="flex items-center gap-4 mt-5 text-xs text-muted-foreground">
              <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-full bg-green-500" /> Concluído {earned.size}</span>
              <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-full bg-muted border border-border" /> Bloqueado {ALL_SKILLS.length - earned.size}</span>
            </div>

            {earned.size > 0 && (
              <div className="mt-5 flex flex-wrap gap-1.5">
                {[...earned].map((s) => (
                  <span key={s} className="text-[10px] font-mono px-2 py-0.5 rounded border border-green-500/30 text-green-400 bg-green-500/10">{s}</span>
                ))}
              </div>
            )}

            <div className="mt-6 pt-4 border-t border-border flex items-center justify-between">
              <Link to={`/labs/${nextLab.id}`} className="flex items-center gap-1.5 text-xs font-mono text-primary hover:underline">
                <Terminal size={12} /> próximo: {nextLab.title}
              </Link>
              {done.length > 0 && (
                <button
                  onClick={() => { saveProgress([]); setDone([]); }}
                  className="flex items-center gap-1 text-[10px] font-mono text-muted-foreground hover:text-destructive transition-colors"
                  title="Zerar progresso"
                >
                  <RotateCcw size={11} /> zerar
                </button>
              )}
            </div>
          </aside>
        </div>
      </main>
    </div>
  );
};

export default Labs;
