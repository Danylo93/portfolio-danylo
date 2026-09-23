import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { motion } from "framer-motion";
import { ArrowLeft, Award, CheckCircle2, ChevronUp, Circle, Clock, FlaskConical, Lock, Puzzle, RotateCcw, Search, Terminal } from "lucide-react";
import { ALL_SKILLS, LABS, TRACKS, loadProgress, saveProgress } from "@/labs/data";

const LEVEL_COLOR: Record<string, string> = { Iniciante: "#4ade80", Intermediário: "#fbbf24", Avançado: "#f87171" };

const Labs = () => {
  const [done, setDone] = useState<string[]>(loadProgress);
  const [filter, setFilter] = useState<string>("all");
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<Record<string, boolean>>(() => Object.fromEntries(TRACKS.map((t, i) => [t.id, i < 3])));

  const earned = new Set(LABS.filter((l) => done.includes(l.id)).flatMap((l) => l.skills));
  const pct = Math.round((earned.size / ALL_SKILLS.length) * 100);
  const nextLab = LABS.find((l) => !done.includes(l.id)) ?? LABS[0];
  const totalMinutes = LABS.reduce((a, l) => a + l.minutes, 0);
  const challenges = LABS.filter((l) => l.kind === "challenge").length;

  const q = query.trim().toLowerCase();
  const visible = useMemo(
    () =>
      TRACKS.filter((t) => filter === "all" || t.id === filter).map((t) => ({
        track: t,
        labs: LABS.filter((l) => l.track === t.id && (!q || l.title.toLowerCase().includes(q) || l.summary.toLowerCase().includes(q) || l.skills.some((s) => s.toLowerCase().includes(q)))),
      })).filter((x) => x.labs.length),
    [filter, q],
  );

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
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="mb-8 max-w-3xl">
          <span className="font-mono text-primary text-sm">// aprender fazendo</span>
          <h1 className="text-3xl md:text-4xl font-display font-bold mt-2">
            Labs <span className="gradient-text">Interativos</span>
          </h1>
          <p className="text-muted-foreground mt-3 text-sm leading-relaxed">
            Terminal no navegador com cluster Kubernetes de 3 nós, Docker, Terraform/AWS, Ansible, pipelines CI/CD e ferramentas de segurança —
            tudo simulado. Siga os passos, rode os comandos e clique em <span className="text-primary font-mono">Verificar</span>. O Mentor explica cada acerto e cada erro.
          </p>
          <div className="flex flex-wrap gap-2 mt-5">
            {[
              { v: LABS.length, k: "labs" },
              { v: TRACKS.length, k: "trilhas" },
              { v: challenges, k: "desafios" },
              { v: ALL_SKILLS.length, k: "habilidades" },
              { v: `${Math.round(totalMinutes / 60)}h`, k: "de prática" },
            ].map((s) => (
              <div key={s.k} className="px-3 py-1.5 rounded-lg border border-border bg-card/50 font-mono text-xs">
                <span className="text-primary font-bold">{s.v}</span> <span className="text-muted-foreground">{s.k}</span>
              </div>
            ))}
          </div>
        </motion.div>

        {/* Filters */}
        <div className="flex flex-col md:flex-row gap-3 md:items-center mb-6">
          <div className="flex gap-1.5 overflow-x-auto pb-1 -mx-1 px-1 flex-1">
            <button
              onClick={() => setFilter("all")}
              className={`shrink-0 text-xs font-mono px-3 py-1.5 rounded-full border transition-colors ${filter === "all" ? "border-primary text-primary bg-primary/10" : "border-border text-muted-foreground hover:text-foreground"}`}
            >
              Todas
            </button>
            {TRACKS.map((t) => (
              <button
                key={t.id}
                onClick={() => setFilter(t.id)}
                className="shrink-0 text-xs font-mono px-3 py-1.5 rounded-full border transition-colors whitespace-nowrap"
                style={filter === t.id ? { borderColor: t.color, color: t.color, backgroundColor: `${t.color}18` } : undefined}
              >
                <span className={filter === t.id ? "" : "text-muted-foreground"}>
                  {t.icon} {t.title.split(" · ")[0]}
                </span>
              </button>
            ))}
          </div>
          <label className="relative md:w-64">
            <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="buscar lab ou habilidade…"
              aria-label="Buscar labs"
              className="w-full pl-8 pr-3 py-1.5 text-xs font-mono rounded-md border border-border bg-card/50 outline-none focus:border-primary/60"
            />
          </label>
        </div>

        <div className="grid lg:grid-cols-[1fr_360px] gap-8 items-start">
          {/* Tracks */}
          <div className="space-y-5 min-w-0">
            {!visible.length && <p className="text-sm text-muted-foreground">Nenhum lab encontrado para "{query}".</p>}
            {visible.map(({ track: t, labs }, ti) => {
              const all = LABS.filter((l) => l.track === t.id);
              const count = all.filter((l) => done.includes(l.id)).length;
              const isOpen = open[t.id] || filter !== "all" || !!q;
              return (
                <motion.section
                  key={t.id}
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: Math.min(ti, 5) * 0.05 }}
                  className="rounded-xl border bg-card/50 overflow-hidden"
                  style={{ borderColor: `${t.color}30` }}
                >
                  <div className="p-5 border-b border-border">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-xl">{t.icon}</span>
                      <h2 className="font-display font-bold text-lg" style={{ color: t.color }}>{t.title}</h2>
                      {t.badge && (
                        <span className="flex items-center gap-1 text-[10px] font-mono px-2 py-0.5 rounded-full border" style={{ color: t.color, borderColor: `${t.color}50`, backgroundColor: `${t.color}12` }}>
                          <Award size={10} /> {t.badge}
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground mt-2">{t.desc}</p>
                    <div className="mt-4 h-1.5 rounded-full bg-muted overflow-hidden">
                      <motion.div
                        className="h-full rounded-full"
                        style={{ backgroundColor: t.color }}
                        initial={{ width: 0 }}
                        animate={{ width: `${(count / all.length) * 100}%` }}
                        transition={{ duration: 0.8 }}
                      />
                    </div>
                  </div>

                  <button
                    onClick={() => setOpen((o) => ({ ...o, [t.id]: !isOpen }))}
                    className="w-full flex items-center justify-between px-5 py-3 text-sm text-foreground hover:bg-muted/40 transition-colors"
                    aria-expanded={isOpen}
                  >
                    <span>Concluído {count} de {all.length} Labs</span>
                    <ChevronUp size={16} className={`transition-transform ${isOpen ? "" : "rotate-180"}`} />
                  </button>

                  {isOpen && (
                    <ul>
                      {labs.map((lab) => {
                        const isDone = done.includes(lab.id);
                        const Icon = lab.kind === "challenge" ? Puzzle : FlaskConical;
                        return (
                          <li key={lab.id} className="group border-t border-border">
                            <Link to={`/labs/${lab.id}`} className="flex items-center gap-3 px-5 py-3.5 hover:bg-muted/40 transition-colors">
                              <Icon size={16} className="shrink-0 text-muted-foreground" />
                              <div className="flex-1 min-w-0">
                                <div className="text-sm text-foreground truncate">{lab.title}</div>
                                <div className="text-[11px] text-muted-foreground truncate mt-0.5">{lab.summary}</div>
                                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1 text-[10px] font-mono text-muted-foreground">
                                  <span style={{ color: LEVEL_COLOR[lab.level] }}>{lab.level}</span>
                                  <span className="flex items-center gap-1"><Clock size={10} /> {lab.minutes} min</span>
                                  <span className="uppercase">{lab.kind === "challenge" ? "desafio" : "lab"}</span>
                                  <span>{lab.steps.length} passos</span>
                                </div>
                              </div>
                              <span className="hidden sm:group-hover:inline-flex text-xs font-mono px-3 py-1.5 rounded-md border border-primary/50 text-primary whitespace-nowrap">
                                {isDone ? "Refazer" : "Iniciar Laboratório"}
                              </span>
                              {isDone ? <CheckCircle2 size={18} className="shrink-0 text-green-400" /> : <Circle size={18} className="shrink-0 text-muted-foreground/60" />}
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

          {/* Progress */}
          <aside className="lg:sticky lg:top-20 rounded-xl border border-border bg-card/50 p-5">
            <h3 className="font-display font-semibold text-foreground">
              Progresso: {earned.size} de {ALL_SKILLS.length} Habilidades Adquiridas
            </h3>
            <div className="mt-4 h-2 rounded-full bg-muted overflow-hidden">
              <motion.div className="h-full rounded-full bg-primary" initial={{ width: 0 }} animate={{ width: `${pct}%` }} transition={{ duration: 0.8 }} />
            </div>
            <div className="grid grid-cols-10 gap-1.5 mt-5">
              {ALL_SKILLS.map((s, i) => {
                const ok = earned.has(s);
                return (
                  <motion.div
                    key={s}
                    title={s}
                    initial={{ scale: 0 }}
                    animate={{ scale: 1 }}
                    transition={{ delay: 0.15 + Math.min(i, 60) * 0.008 }}
                    className={`aspect-square rounded-full flex items-center justify-center border ${ok ? "bg-green-500 border-green-400 text-background" : "bg-muted/40 border-border text-muted-foreground/50"}`}
                  >
                    {ok ? <CheckCircle2 size={10} /> : <Lock size={8} />}
                  </motion.div>
                );
              })}
            </div>
            <div className="flex items-center gap-4 mt-4 text-xs text-muted-foreground">
              <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-full bg-green-500" /> Concluído {earned.size}</span>
              <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-full bg-muted border border-border" /> Bloqueado {ALL_SKILLS.length - earned.size}</span>
            </div>

            <div className="mt-6 space-y-2.5">
              <div className="text-xs font-mono text-muted-foreground">Por trilha</div>
              {TRACKS.map((t) => {
                const all = LABS.filter((l) => l.track === t.id);
                const c = all.filter((l) => done.includes(l.id)).length;
                return (
                  <button key={t.id} onClick={() => setFilter(t.id)} className="w-full text-left group" title={`Filtrar ${t.title}`}>
                    <div className="flex items-center justify-between text-[11px] font-mono">
                      <span className="text-muted-foreground group-hover:text-foreground truncate">{t.icon} {t.title.split(" · ")[0]}</span>
                      <span style={{ color: t.color }}>{c}/{all.length}</span>
                    </div>
                    <div className="mt-1 h-1 rounded-full bg-muted overflow-hidden">
                      <div className="h-full rounded-full transition-all" style={{ width: `${(c / all.length) * 100}%`, backgroundColor: t.color }} />
                    </div>
                  </button>
                );
              })}
            </div>

            <div className="mt-6 pt-4 border-t border-border flex items-center justify-between gap-3">
              <Link to={`/labs/${nextLab.id}`} className="flex items-center gap-1.5 text-xs font-mono text-primary hover:underline min-w-0">
                <Terminal size={12} className="shrink-0" /> <span className="truncate">próximo: {nextLab.title}</span>
              </Link>
              {done.length > 0 && (
                <button
                  onClick={() => {
                    saveProgress([]);
                    setDone([]);
                  }}
                  className="shrink-0 flex items-center gap-1 text-[10px] font-mono text-muted-foreground hover:text-destructive transition-colors"
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
