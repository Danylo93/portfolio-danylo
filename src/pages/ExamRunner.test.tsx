import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import ExamRunner from "./ExamRunner";
import { EXAMS } from "@/exams/catalog";
import { aiQuestions } from "@/exams/ai";
import { cloudQuestions } from "@/exams/cloud";
import { attemptKey, createAttempt, type Attempt } from "@/exams/attempt";

const show = (id = "cloud-practitioner") => render(<MemoryRouter initialEntries={[`/labs/exams/${id}`]}><Routes>
  <Route path="/labs/exams/:id" element={<ExamRunner />} />
</Routes></MemoryRouter>);

beforeEach(() => { localStorage.clear(); vi.useFakeTimers(); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

it("abre DevOps com 75 questões, 180 minutos e retoma sua própria tentativa", () => {
  const view = show("devops-professional");
  expect(screen.getByText(/75 questões autorais/)).toBeInTheDocument();
  expect(screen.getByRole("timer")).toHaveTextContent("180:00");
  fireEvent.click(screen.getByRole("button", { name: "Iniciar prova" }));
  expect(screen.getByText("Questão 1 de 75")).toBeInTheDocument();
  fireEvent.click(screen.queryAllByRole("radio")[0] ?? screen.getAllByRole("checkbox")[0]);
  fireEvent.click(screen.getByRole("button", { name: "Marcar para revisão" }));
  act(() => vi.advanceTimersByTime(1000));
  view.unmount(); show("devops-professional");
  expect(screen.getByRole("timer")).toHaveTextContent("179:59");
  expect(screen.getByRole("button", { name: "Desmarcar revisão" })).toHaveAttribute("aria-pressed", "true");
  expect(localStorage.getItem(attemptKey("cloud-practitioner"))).toBeNull();
});

it("inicia o cronômetro somente ao começar e preserva respostas e marcações ao recarregar", () => {
  const view = show();
  act(() => vi.advanceTimersByTime(3000));
  expect(screen.getByRole("timer")).toHaveTextContent("90:00");
  fireEvent.click(screen.getByRole("button", { name: "Iniciar prova" }));
  fireEvent.click(screen.queryAllByRole("radio")[0] ?? screen.getAllByRole("checkbox")[0]);
  fireEvent.click(screen.getByRole("button", { name: "Marcar para revisão" }));
  act(() => vi.advanceTimersByTime(1000));
  expect(screen.getByRole("timer")).toHaveTextContent("89:59");
  const saved: Attempt = JSON.parse(localStorage.getItem(attemptKey(EXAMS[0].id))!);
  view.unmount(); show();
  expect(screen.getByRole("button", { name: "Desmarcar revisão" })).toHaveAttribute("aria-pressed", "true");
  const question = cloudQuestions.find((q) => q.id === saved.order[0])!;
  expect(screen.getAllByRole(question.correct.length > 1 ? "checkbox" : "radio")[0]).toBeChecked();
  expect(screen.queryByText(question.explanation)).not.toBeInTheDocument();
});

it("permite revisar e cancelar a entrega sem revelar gabarito", () => {
  show(); fireEvent.click(screen.getByRole("button", { name: "Iniciar prova" }));
  fireEvent.click(screen.getByRole("button", { name: "Próxima" }));
  expect(screen.getByText("Questão 2 de 65")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Anterior" }));
  fireEvent.click(screen.getByRole("button", { name: "Entregar prova" }));
  fireEvent.click(screen.getByRole("button", { name: "Continuar respondendo" }));
  expect(screen.queryByRole("region", { name: "Resultado da prova" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Entregar prova" }));
  fireEvent.click(screen.getByRole("button", { name: "Confirmar entrega" }));
  expect(screen.getByText("Resultado: 0% de acertos")).toBeInTheDocument();
  expect(screen.getByText(/65 sem resposta completa/)).toBeInTheDocument();
  expect(screen.queryByRole("radio")).not.toBeInTheDocument();
});

it("entrega automaticamente e não aceita respostas depois de 90 minutos", () => {
  show(); fireEvent.click(screen.getByRole("button", { name: "Iniciar prova" }));
  act(() => vi.advanceTimersByTime(90 * 60_000));
  expect(screen.getByText("Resultado: 0% de acertos")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Entregar prova" })).not.toBeInTheDocument();
  expect(screen.queryByRole("radio")).not.toBeInTheDocument();
  expect(screen.getByText(/Tempo encerrado/)).toBeInTheDocument();
});

it("recarregar após o prazo mostra o resultado da tentativa salva", () => {
  const a = createAttempt(EXAMS[0], cloudQuestions, Date.now() - 91 * 60_000);
  localStorage.setItem(attemptKey(EXAMS[0].id), JSON.stringify(a));
  show();
  expect(screen.getByRole("timer")).toHaveTextContent("Finalizado");
  expect(screen.getByText("Resultado: 0% de acertos")).toBeInTheDocument();
});

it("permite concluir todas as questões de AI, incluindo associação e ordenação", () => {
  show("ai-practitioner");
  fireEvent.click(screen.getByRole("button", { name: "Iniciar prova" }));
  const saved: Attempt = JSON.parse(localStorage.getItem(attemptKey(EXAMS[1].id))!);
  saved.order.forEach((id, i) => {
    const q = aiQuestions.find((q) => q.id === id)!;
    if (q.type === "choice") {
      const inputs = screen.getAllByRole(q.correct.length > 1 ? "checkbox" : "radio");
      q.correct.forEach((answer) => fireEvent.click(inputs[answer]));
    } else {
      const inputs = screen.getAllByRole("combobox");
      q.correct.forEach((answer, j) => fireEvent.change(inputs[j], { target: { value: String(answer) } }));
    }
    if (i < 64) fireEvent.click(screen.getByRole("button", { name: "Próxima" }));
  });
  fireEvent.click(screen.getByRole("button", { name: "Entregar prova" }));
  fireEvent.click(screen.getByRole("button", { name: "Confirmar entrega" }));
  expect(screen.getByText("Resultado: 100% de acertos")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Nova tentativa" }));
  expect(screen.getByRole("timer")).toHaveTextContent("90:00");
  expect(screen.getByText("0/65 respondidas · 0 marcadas")).toBeInTheDocument();
}, 15_000);

it("informa falha de armazenamento sem impedir a prova", () => {
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
  show(); fireEvent.click(screen.getByRole("button", { name: "Iniciar prova" }));
  expect(screen.getByRole("alert")).toHaveTextContent("Não foi possível salvar");
  expect(screen.getByRole("button", { name: "Entregar prova" })).toBeInTheDocument();
});
