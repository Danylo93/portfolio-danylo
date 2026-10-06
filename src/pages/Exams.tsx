import { Link } from "react-router-dom";
import { ArrowLeft, Clock, GraduationCap } from "lucide-react";
import { EXAMS } from "@/exams/catalog";

export default function Exams() {
  return <div className="min-h-screen bg-background text-foreground">
    <main className="container max-w-5xl px-4 py-10">
      <Link to="/labs" className="inline-flex gap-2 items-center text-sm text-primary"><ArrowLeft size={16} /> Voltar aos labs</Link>
      <div className="mt-8 mb-8">
        <GraduationCap className="text-primary" size={30} />
        <h1 className="font-display text-3xl sm:text-4xl font-bold mt-3">Simulados de certificação AWS</h1>
        <p className="text-muted-foreground mt-3 max-w-3xl">Treine em formato de prova: cronômetro, questões autorais, revisão e resultado por domínio. A tentativa é salva neste navegador; o tempo continua ao sair ou atualizar a página.</p>
      </div>
      <div className="grid md:grid-cols-2 gap-5">
        {EXAMS.map((exam) => <article key={exam.id} className="rounded-xl border border-border bg-card/50 p-6">
          <span className="font-mono text-xs text-primary">{exam.code}</span>
          <h2 className="font-display text-xl font-bold mt-2">{exam.title}</h2>
          <p className="text-muted-foreground text-sm mt-3">{exam.description}</p>
          <p className="flex items-center gap-2 mt-4 text-sm"><Clock size={15} /> 65 questões · {exam.minutes} minutos</p>
          <ul className="mt-4 space-y-2 text-xs text-muted-foreground">
            {exam.domains.map((d) => <li key={d.name} className="flex justify-between gap-3"><span>{d.name}</span><span>{d.weight}%</span></li>)}
          </ul>
          <Link to={`/labs/exams/${exam.id}`} className="inline-block rounded-md bg-primary px-4 py-2 text-primary-foreground text-sm mt-6">Abrir simulado</Link>
          <a href={exam.guide} target="_blank" rel="noreferrer" className="block text-xs text-primary mt-4">Guia oficial da AWS ↗</a>
        </article>)}
      </div>
      <p className="text-xs text-muted-foreground leading-relaxed mt-6">Simulados independentes, sem vínculo com a AWS e sem emissão de certificação. Todas as 65 questões contam neste treino. Meta didática: 70% de acertos; essa porcentagem não equivale à nota escalonada oficial. Os pesos acima são os do guia oficial; a distribuição do banco é aproximada. Conteúdo revisado em 06/10/2026.</p>
    </main>
  </div>;
}
