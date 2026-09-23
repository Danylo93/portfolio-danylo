import { Fragment, useEffect, useState, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { motion } from "framer-motion";
import { AlertTriangle, ArrowLeft, ArrowRight, BookOpen, Check, CheckCircle2, Clock, Copy, GraduationCap, Lightbulb, X } from "lucide-react";
import { LESSONS, TRACKS, itemUrl, lessonKey, loadProgress, markCompleted, nextInPath } from "@/labs/data";
import type { LessonBlock } from "@/labs/types";
import NotFound from "./NotFound";

/** **bold** and `code` inline formatting. */
const inline = (text: string): ReactNode[] =>
  text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, i) =>
    part.startsWith("**") ? (
      <strong key={i} className="text-foreground font-semibold">{part.slice(2, -2)}</strong>
    ) : part.startsWith("`") ? (
      <code key={i} className="font-mono text-[0.85em] px-1.5 py-0.5 rounded bg-muted text-green-300">{part.slice(1, -1)}</code>
    ) : (
      <Fragment key={i}>{part}</Fragment>
    ),
  );

const CALLOUT = {
  tip: { Icon: Lightbulb, label: "Boa prática", cls: "border-sky-500/40 bg-sky-500/10", icon: "text-sky-400" },
  warn: { Icon: AlertTriangle, label: "Armadilha comum", cls: "border-amber-500/40 bg-amber-500/10", icon: "text-amber-400" },
  exam: { Icon: GraduationCap, label: "Dica de prova / entrevista", cls: "border-violet-500/40 bg-violet-500/10", icon: "text-violet-400" },
} as const;

const Block = ({ b, color }: { b: LessonBlock; color: string }) => {
  const [copied, setCopied] = useState(false);
  switch (b.type) {
    case "heading":
      return <h2 className="text-xl font-display font-bold text-foreground pt-4">{b.text}</h2>;
    case "text":
      return <p className="text-[15px] text-muted-foreground leading-relaxed">{inline(b.text)}</p>;
    case "list":
      return (
        <ul className="space-y-2">
          {b.items.map((it, i) => (
            <li key={i} className="flex gap-2.5 text-[15px] text-muted-foreground leading-relaxed">
              <span className="mt-2 w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: color }} />
              <span>{inline(it)}</span>
            </li>
          ))}
        </ul>
      );
    case "code":
      return (
        <figure>
          <div className="relative rounded-lg border border-border bg-[#0b0f14] overflow-hidden">
            <div className="flex items-center justify-between px-3 py-1.5 border-b border-border text-[10px] font-mono text-muted-foreground">
              <span>{b.lang ?? "shell"}</span>
              <button
                onClick={() => {
                  navigator.clipboard?.writeText(b.code).catch(() => undefined);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1200);
                }}
                className="flex items-center gap-1 hover:text-foreground"
              >
                {copied ? <Check size={11} /> : <Copy size={11} />} {copied ? "copiado" : "copiar"}
              </button>
            </div>
            <pre className="p-4 overflow-x-auto font-mono text-[12.5px] leading-relaxed text-slate-200">{b.code}</pre>
          </div>
          {b.caption && <figcaption className="mt-1.5 text-xs text-muted-foreground">{b.caption}</figcaption>}
        </figure>
      );
    case "callout": {
      const c = CALLOUT[b.tone];
      return (
        <div className={`flex gap-3 rounded-lg border p-4 ${c.cls}`}>
          <c.Icon size={18} className={`shrink-0 mt-0.5 ${c.icon}`} />
          <div>
            <div className={`text-[11px] font-mono uppercase tracking-wider mb-1 ${c.icon}`}>{c.label}</div>
            <p className="text-sm text-foreground/90 leading-relaxed">{inline(b.text)}</p>
          </div>
        </div>
      );
    }
    case "flow":
      return (
        <figure className="rounded-xl border border-border bg-card/40 p-4 sm:p-5">
          <div className="flex flex-col md:flex-row md:items-stretch gap-2">
            {b.steps.map((s, i) => (
              <Fragment key={i}>
                <motion.div
                  initial={{ opacity: 0, y: 10 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={{ once: true }}
                  transition={{ delay: i * 0.12 }}
                  className="flex-1 min-w-0 rounded-lg border p-3"
                  style={{ borderColor: `${color}40`, backgroundColor: `${color}0d` }}
                >
                  <div className="text-[10px] font-mono" style={{ color }}>{String(i + 1).padStart(2, "0")}</div>
                  <div className="text-sm font-semibold text-foreground mt-0.5">{s.label}</div>
                  {s.detail && <div className="text-xs text-muted-foreground mt-1 leading-snug">{inline(s.detail)}</div>}
                </motion.div>
                {i < b.steps.length - 1 && (
                  <div className="flex items-center justify-center shrink-0" aria-hidden>
                    <div className="rotate-90 md:rotate-0">
                      <motion.div animate={{ x: [0, 4, 0] }} transition={{ duration: 1.6, repeat: Infinity, delay: i * 0.2 }}>
                        <ArrowRight size={16} style={{ color }} />
                      </motion.div>
                    </div>
                  </div>
                )}
              </Fragment>
            ))}
          </div>
          {b.caption && <figcaption className="mt-3 text-xs text-muted-foreground">{inline(b.caption)}</figcaption>}
        </figure>
      );
    case "table":
      return (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-muted/40">
                {b.head.map((h) => (
                  <th key={h} className="text-left font-mono text-[11px] uppercase tracking-wider text-muted-foreground px-3 py-2">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {b.rows.map((r, i) => (
                <tr key={i} className="border-t border-border">
                  {r.map((c, j) => (
                    <td key={j} className={`px-3 py-2 align-top ${j === 0 ? "text-foreground font-medium" : "text-muted-foreground"}`}>{inline(c)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
  }
};

const LessonView = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  const lesson = LESSONS.find((l) => l.id === id);
  const [answers, setAnswers] = useState<Record<number, number>>({});
  const [done, setDone] = useState(false);

  useEffect(() => {
    setAnswers({});
    setDone(lesson ? loadProgress().includes(lessonKey(lesson.id)) : false);
    window.scrollTo({ top: 0 });
  }, [lesson]);

  if (!lesson) return <NotFound />;
  const track = TRACKS.find((t) => t.id === lesson.track)!;
  const next = nextInPath(lesson.id);
  const correct = lesson.quiz.filter((q, i) => answers[i] === q.answer).length;
  const allRight = correct === lesson.quiz.length;

  const finish = () => {
    markCompleted(lessonKey(lesson.id));
    setDone(true);
  };

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-40 border-b border-border bg-background/85 backdrop-blur-md">
        <div className="max-w-3xl mx-auto px-4 sm:px-6 h-14 flex items-center gap-3">
          <Link to="/labs" className="p-1.5 rounded hover:bg-muted text-muted-foreground hover:text-primary transition-colors" title="Voltar aos labs">
            <ArrowLeft size={16} />
          </Link>
          <span className="text-xs font-mono truncate" style={{ color: track.color }}>{track.icon} {track.title.split(" · ")[0]}</span>
          <span className="ml-auto flex items-center gap-1 text-xs font-mono text-muted-foreground"><Clock size={12} /> {lesson.minutes} min</span>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-4 sm:px-6 py-10">
        <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }}>
          <span className="flex items-center gap-1.5 text-[11px] font-mono uppercase tracking-wider" style={{ color: track.color }}>
            <BookOpen size={13} /> Lição
          </span>
          <h1 className="text-3xl md:text-4xl font-display font-bold mt-2 text-foreground">{lesson.title}</h1>
          <p className="text-muted-foreground mt-3">{lesson.summary}</p>
        </motion.div>

        <article className="mt-8 space-y-5">
          {lesson.blocks.map((b, i) => (
            <Block key={i} b={b} color={track.color} />
          ))}
        </article>

        {/* Quiz */}
        <section className="mt-12 rounded-xl border border-border bg-card/50 p-5 sm:p-6">
          <div className="flex items-center justify-between gap-3">
            <h2 className="font-display font-bold text-lg text-foreground">Verifique o que aprendeu</h2>
            <span className="text-xs font-mono text-muted-foreground">{correct}/{lesson.quiz.length} corretas</span>
          </div>
          <div className="mt-5 space-y-6">
            {lesson.quiz.map((q, qi) => {
              const picked = answers[qi];
              const answered = picked !== undefined;
              return (
                <div key={qi}>
                  <p className="text-sm font-medium text-foreground">{qi + 1}. {inline(q.q)}</p>
                  <div className="mt-2.5 grid gap-2">
                    {q.options.map((opt, oi) => {
                      const isPicked = picked === oi;
                      const isRight = oi === q.answer;
                      const state = !answered ? "idle" : isPicked && isRight ? "right" : isPicked ? "wrong" : "idle";
                      return (
                        <button
                          key={oi}
                          onClick={() => setAnswers((a) => ({ ...a, [qi]: oi }))}
                          className={`text-left text-sm rounded-md border px-3 py-2 transition-colors flex items-start gap-2 ${
                            state === "right" ? "border-green-500/60 bg-green-500/10 text-green-200" : state === "wrong" ? "border-red-500/60 bg-red-500/10 text-red-200" : "border-border hover:border-primary/50 text-muted-foreground hover:text-foreground"
                          }`}
                        >
                          <span className="font-mono text-xs mt-0.5 shrink-0">{String.fromCharCode(65 + oi)}</span>
                          <span className="flex-1">{inline(opt)}</span>
                          {state === "right" && <Check size={15} className="shrink-0 text-green-400" />}
                          {state === "wrong" && <X size={15} className="shrink-0 text-red-400" />}
                        </button>
                      );
                    })}
                  </div>
                  {answered && (
                    <motion.p
                      initial={{ opacity: 0, y: 4 }}
                      animate={{ opacity: 1, y: 0 }}
                      className={`mt-2 text-xs leading-relaxed rounded-md px-3 py-2 ${picked === q.answer ? "text-green-200 bg-green-500/10" : "text-amber-100 bg-amber-500/10"}`}
                    >
                      {picked === q.answer ? "Correto! " : "Ainda não — tente outra opção. "}
                      {picked === q.answer && inline(q.explain)}
                    </motion.p>
                  )}
                </div>
              );
            })}
          </div>

          <div className="mt-8 flex flex-wrap items-center gap-3">
            {done ? (
              <span className="flex items-center gap-1.5 text-sm text-green-400"><CheckCircle2 size={16} /> Lição concluída</span>
            ) : (
              <button
                onClick={finish}
                disabled={!allRight}
                className="text-sm px-4 py-2 rounded-md bg-primary text-primary-foreground font-medium disabled:opacity-40 disabled:cursor-not-allowed"
                title={allRight ? "" : "Acerte todas as questões para concluir"}
              >
                Concluir lição
              </button>
            )}
            {next && (
              <button
                onClick={() => navigate(itemUrl(next))}
                className="text-sm px-4 py-2 rounded-md border border-primary/50 text-primary hover:bg-primary/10 flex items-center gap-1.5"
              >
                {next.kind === "lab" ? "Praticar no lab" : "Próxima lição"}: {next.item.title} <ArrowRight size={14} />
              </button>
            )}
          </div>
        </section>
      </main>
    </div>
  );
};

export default LessonView;
