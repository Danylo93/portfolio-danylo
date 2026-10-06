import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ArrowLeft, Clock, Flag } from "lucide-react";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { EXAMS, type ExamInfo } from "@/exams/catalog";
import { aiQuestions } from "@/exams/ai";
import { cloudQuestions } from "@/exams/cloud";
import type { Question } from "@/exams/questions";
import { createAttempt, finishAttempt, formatTime, grade, isAnswered, isCorrect, loadAttempt, saveAttempt, type Attempt } from "@/exams/attempt";
import NotFound from "./NotFound";

const button = "rounded-md border border-border px-4 py-2 text-sm hover:bg-muted disabled:opacity-40 disabled:cursor-not-allowed";

function AnswerInputs({ question, answer, onChange }: { question: Question; answer: number[]; onChange: (values: number[]) => void }) {
  if (question.type !== "choice") {
    const labels = question.type === "match" ? question.prompts! : question.options.map((_, i) => `${i + 1}ª etapa`);
    return <div className="space-y-3 mt-5">{labels.map((label, i) => <label key={i} className="block text-sm">
      <span>{label}</span>
      <select value={answer[i] ?? -1} onChange={(e) => {
        const next = Array.from({ length: question.correct.length }, (_, j) => answer[j] ?? -1);
        next[i] = Number(e.target.value); onChange(next);
      }} className="block w-full mt-2 rounded border border-border bg-background px-3 py-2">
        <option value={-1}>Selecione uma opção</option>
        {question.options.map((option, j) => <option key={j} value={j} disabled={answer.some((v, k) => k !== i && v === j)}>{option}</option>)}
      </select>
    </label>)}</div>;
  }
  const multiple = question.correct.length > 1;
  return <fieldset className="mt-5 space-y-3">
    <legend className="text-xs text-muted-foreground mb-3">{multiple ? `Selecione ${question.correct.length} respostas. Todas devem estar corretas; sem pontuação parcial.` : "Selecione uma resposta."}</legend>
    {question.options.map((option, i) => <label key={i} className={`flex items-start gap-3 rounded-lg border p-4 cursor-pointer text-sm ${answer.includes(i) ? "border-primary bg-primary/10" : "border-border hover:bg-muted/40"}`}>
      <input type={multiple ? "checkbox" : "radio"} name={question.id} checked={answer.includes(i)}
        disabled={multiple && !answer.includes(i) && answer.length >= question.correct.length}
        onChange={() => onChange(multiple ? answer.includes(i) ? answer.filter((n) => n !== i) : [...answer, i] : [i])}
        className="mt-0.5 accent-primary" />
      <span><span className="font-mono text-muted-foreground mr-2">{String.fromCharCode(65 + i)}.</span>{option}</span>
    </label>)}
  </fieldset>;
}

function ExamSession({ exam, questions }: { exam: ExamInfo; questions: Question[] }) {
  const [attempt, setAttempt] = useState<Attempt | null>(() => loadAttempt(exam, questions));
  const [now, setNow] = useState(Date.now);
  const [warning, setWarning] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const active = attempt !== null && attempt.finishedAt === null;

  useEffect(() => {
    if (attempt) setWarning(!saveAttempt(attempt));
  }, [attempt]);
  useEffect(() => {
    if (!active) return;
    const tick = () => {
      const time = Date.now(); setNow(time);
      setAttempt((a) => a && a.finishedAt === null && time >= a.deadline ? finishAttempt(a, time) : a);
    };
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [active]);

  const start = () => { setNow(Date.now()); setAttempt(createAttempt(exam, questions)); setConfirm(false); };
  const changeAnswer = (values: number[]) => setAttempt((a) => {
    if (!a || a.finishedAt !== null) return a;
    if (Date.now() >= a.deadline) return finishAttempt(a);
    return { ...a, answers: { ...a.answers, [a.order[a.index]]: values } };
  });
  const finish = () => { setAttempt((a) => a ? finishAttempt(a) : a); setConfirm(false); };
  const completed = attempt !== null && attempt.finishedAt !== null;
  const question = attempt ? questions.find((q) => q.id === attempt.order[attempt.index])! : null;
  const answered = attempt ? questions.filter((q) => isAnswered(q, attempt.answers[q.id])).length : 0;
  const score = attempt ? grade(questions, attempt.answers) : null;
  const remaining = attempt ? Math.max(0, Math.ceil((attempt.deadline - now) / 1000)) : exam.minutes * 60;

  return <div className="min-h-screen bg-background text-foreground">
    <header className="sticky top-0 z-30 border-b border-border bg-background/95">
      <div className="container max-w-6xl px-4 py-4 flex items-center justify-between gap-3">
        <Link to="/labs/exams" className="inline-flex items-center gap-2 text-sm text-primary"><ArrowLeft size={15} /> Simulados</Link>
        <span className="font-mono text-xs sm:text-sm">{exam.code}</span>
        <span role="timer" aria-label="Tempo restante" className={`inline-flex gap-2 items-center font-mono text-sm ${active && remaining < 300 ? "text-red-400" : "text-primary"}`}><Clock size={15} />{completed ? "Finalizado" : formatTime(remaining)}</span>
      </div>
    </header>
    <main className="container max-w-6xl px-4 py-8">
      <h1 className="font-display text-2xl sm:text-3xl font-bold">{exam.title}</h1>
      {warning && <p role="alert" className="text-amber-300 mt-4">Não foi possível salvar a tentativa. Continue nesta página para preservar suas respostas.</p>}
      {!attempt ? <section className="mt-6 max-w-3xl rounded-xl border border-border bg-card/50 p-6">
        <h2 className="text-lg font-semibold">Prepare-se para começar</h2>
        <ul className="mt-4 space-y-3 text-sm text-muted-foreground list-disc pl-5">
          <li>65 questões autorais em português, com {exam.minutes} minutos.</li>
          <li>{exam.id === "ai-practitioner" ? "Escolha única, múltiplas respostas, ordenação e associação." : "Escolha única e múltiplas respostas."}</li>
          <li>Você pode navegar, alterar respostas e marcar questões para revisão.</li>
          <li>O gabarito aparece apenas após a entrega. Questões em branco contam como incorretas.</li>
          <li>Ao acabar o tempo, a prova é entregue automaticamente. O cronômetro continua ao sair; atualizar a página retoma a tentativa salva.</li>
        </ul>
        <p className="mt-5 text-xs text-muted-foreground">Meta de treino: 70% de acertos. Não representa a nota escalonada da AWS nem uma aprovação oficial. Todas as questões contam para o resultado deste simulado.</p>
        <a className="block mt-4 text-sm text-primary" href={exam.guide} target="_blank" rel="noreferrer">Consultar o guia oficial ↗</a>
        <button className="mt-6 rounded-md bg-primary px-5 py-3 text-primary-foreground text-sm font-semibold" onClick={start}>Iniciar prova</button>
      </section> : <>
        {completed && <section aria-label="Resultado da prova" className="rounded-xl border border-primary/30 bg-card/50 p-5 sm:p-6 mt-6">
          <h2 className="font-display text-2xl font-bold">Resultado: {score!.percent}% de acertos</h2>
          <p className="mt-2 text-sm">{score!.correct} de {score!.total} corretas · {score!.unanswered} sem resposta completa · {score!.correct / score!.total >= 0.7 ? "Meta de treino atingida" : "Revise os temas e tente novamente"}</p>
          <p className="mt-2 text-xs text-muted-foreground">{attempt.finishedAt === attempt.deadline ? "Tempo encerrado. " : "Prova entregue. "}Duração: {formatTime(Math.ceil((attempt.finishedAt! - attempt.startedAt) / 1000))}. Meta didática de 70%; a nota oficial utiliza outra escala.</p>
          <div className="overflow-x-auto mt-5"><table className="w-full text-sm text-left">
            <caption className="text-left font-semibold mb-2">Desempenho por domínio</caption>
            <thead><tr className="border-b border-border"><th className="py-2 pr-3">Domínio</th><th className="py-2 pr-3">Acertos</th><th className="py-2">Percentual</th></tr></thead>
            <tbody>{exam.domains.map((domain, i) => {
              const subset = questions.filter((q) => q.domain === i); const result = grade(subset, attempt.answers);
              return <tr key={domain.name} className="border-b border-border"><th className="font-normal py-2 pr-3">{domain.name}</th><td>{result.correct}/{result.total}</td><td>{result.percent}%</td></tr>;
            })}</tbody>
          </table></div>
          <button className={`${button} mt-5`} onClick={start}>Nova tentativa</button>
          <p className="text-xs text-muted-foreground mt-2">Uma nova tentativa substitui o resultado salvo e embaralha a ordem das questões.</p>
        </section>}
        <div className="grid lg:grid-cols-[1fr_280px] gap-6 mt-6 items-start">
          <section aria-label={completed ? "Revisão das respostas" : "Questão atual"} className="rounded-xl border border-border bg-card/50 p-5 sm:p-6">
            <div className="flex justify-between gap-3 items-center text-xs text-muted-foreground mb-4">
              <span>Questão {attempt.index + 1} de {questions.length}</span>
              {active && <button onClick={() => setAttempt((a) => a ? { ...a, flagged: a.flagged.includes(question!.id) ? a.flagged.filter((id) => id !== question!.id) : [...a.flagged, question!.id] } : a)}
                aria-pressed={attempt.flagged.includes(question!.id)} className="inline-flex gap-1 items-center text-primary"><Flag size={14} />{attempt.flagged.includes(question!.id) ? "Desmarcar revisão" : "Marcar para revisão"}</button>}
            </div>
            <h2 className="text-lg font-semibold leading-relaxed">{question!.prompt}</h2>
            {completed ? <div className="mt-5 space-y-4">
              <p className={isCorrect(question!, attempt.answers[question!.id]) ? "text-green-400" : "text-amber-300"}>{isCorrect(question!, attempt.answers[question!.id]) ? "Resposta correta" : isAnswered(question!, attempt.answers[question!.id]) ? "Resposta incorreta" : "Resposta incompleta ou em branco"}</p>
              {question!.type === "choice" ? <>
                <p className="text-sm"><strong>Sua resposta: </strong>{attempt.answers[question!.id]?.map((i) => question!.options[i]).join("; ") || "Não respondida"}</p>
                <p className="text-sm"><strong>Gabarito: </strong>{question!.correct.map((i) => question!.options[i]).join("; ")}</p>
              </> : <ol className="text-sm space-y-3">{question!.correct.map((answer, i) => <li key={i}>
                <strong>{question!.type === "match" ? question!.prompts![i] : `${i + 1}ª etapa`}</strong>
                <p className="text-muted-foreground">Sua resposta: {question!.options[attempt.answers[question!.id]?.[i]] ?? "Não respondida"}</p>
                <p>Gabarito: {question!.options[answer]}</p>
              </li>)}</ol>}
              <p className="rounded-md bg-primary/10 p-4 text-sm leading-relaxed">{question!.explanation}</p>
              <p className="text-xs text-muted-foreground">Domínio: {exam.domains[question!.domain].name}</p>
            </div> : <>
              <AnswerInputs key={question!.id} question={question!} answer={attempt.answers[question!.id] ?? []} onChange={changeAnswer} />
              <button className="mt-4 text-xs text-muted-foreground underline" onClick={() => changeAnswer([])}>Limpar resposta</button>
            </>}
            <div className="flex justify-between gap-3 mt-6">
              <button className={button} disabled={attempt.index === 0} onClick={() => setAttempt((a) => a ? { ...a, index: a.index - 1 } : a)}>Anterior</button>
              <button className={button} disabled={attempt.index === questions.length - 1} onClick={() => setAttempt((a) => a ? { ...a, index: a.index + 1 } : a)}>Próxima</button>
            </div>
          </section>
          <aside className="rounded-xl border border-border bg-card/50 p-4">
            <h2 className="text-sm font-semibold">{completed ? "Revisar questões" : "Navegação da prova"}</h2>
            <p className="text-xs text-muted-foreground mt-2">{answered}/{questions.length} respondidas · {attempt.flagged.length} marcadas</p>
            <nav aria-label="Questões da prova" className="grid grid-cols-5 gap-2 mt-4">
              {attempt.order.map((id, i) => {
                const q = questions.find((q) => q.id === id)!;
                const status = completed ? isCorrect(q, attempt.answers[id]) ? "border-green-500 text-green-400" : "border-amber-500 text-amber-300" : isAnswered(q, attempt.answers[id]) ? "border-primary bg-primary/15 text-primary" : "border-border text-muted-foreground";
                return <button key={id} aria-label={`Ir para questão ${i + 1}${attempt.flagged.includes(id) ? ", marcada para revisão" : ""}${isAnswered(q, attempt.answers[id]) ? ", respondida" : ", não respondida"}`}
                  aria-current={i === attempt.index ? "step" : undefined} onClick={() => setAttempt((a) => a ? { ...a, index: i } : a)}
                  className={`relative rounded border h-9 text-xs font-mono ${status} ${i === attempt.index ? "ring-2 ring-primary ring-offset-2 ring-offset-background" : ""}`}>
                  {i + 1}{attempt.flagged.includes(id) && <span aria-hidden className="absolute -top-1 -right-1 text-amber-300">●</span>}
                </button>;
              })}
            </nav>
            <p className="text-xs text-muted-foreground mt-4">{completed ? "Verde: correta. Amarelo: incorreta ou incompleta." : "Destacada: respondida. Ponto amarelo: marcada para revisão."}</p>
            {active && <button className="w-full rounded-md bg-primary text-primary-foreground px-4 py-3 text-sm font-semibold mt-5" onClick={() => setConfirm(true)}>Entregar prova</button>}
          </aside>
        </div>
      </>}
    </main>
    <AlertDialog open={confirm && active} onOpenChange={setConfirm}>
      <AlertDialogContent>
        <AlertDialogHeader><AlertDialogTitle>Entregar a prova?</AlertDialogTitle><AlertDialogDescription>Você respondeu {answered} de {questions.length} questões e marcou {attempt?.flagged.length ?? 0} para revisão. As {questions.length - answered} questões sem resposta completa contarão como incorretas. Após entregar, você poderá consultar o gabarito.</AlertDialogDescription></AlertDialogHeader>
        <AlertDialogFooter><AlertDialogCancel>Continuar respondendo</AlertDialogCancel><AlertDialogAction onClick={finish}>Confirmar entrega</AlertDialogAction></AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </div>;
}

export default function ExamRunner() {
  const { id } = useParams(); const exam = EXAMS.find((exam) => exam.id === id);
  if (!exam) return <NotFound />;
  return <ExamSession key={exam.id} exam={exam} questions={exam.id === "cloud-practitioner" ? cloudQuestions : aiQuestions} />;
}
