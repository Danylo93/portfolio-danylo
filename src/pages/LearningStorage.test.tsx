import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import LessonView from "./LessonView";
import Labs from "./Labs";
import { LESSONS } from "@/labs/data";
import { loadLessonAnswers } from "@/labs/lesson-storage";

beforeEach(() => {
  localStorage.clear(); vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  vi.stubGlobal("IntersectionObserver", class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("mantém as respostas de uma lição ao fechar e reabrir", () => {
  const lesson = LESSONS[0];
  const show = () => render(<MemoryRouter initialEntries={[`/labs/learn/${lesson.id}`]}><Routes>
    <Route path="/labs/learn/:id" element={<LessonView />} />
  </Routes></MemoryRouter>);
  const view = show();
  fireEvent.click(screen.getByRole("button", { name: `${String.fromCharCode(65 + lesson.quiz[0].answer)} ${lesson.quiz[0].options[lesson.quiz[0].answer]}` }));
  expect(loadLessonAnswers(lesson)[0]).toBe(lesson.quiz[0].answer);
  view.unmount(); show();
  expect(screen.getByText(/^Correto!/)).toBeInTheDocument();
});

it("mantém a busca do catálogo ao voltar para os labs", () => {
  const show = () => render(<MemoryRouter><Labs /></MemoryRouter>);
  const view = show();
  fireEvent.change(screen.getByRole("textbox", { name: "Buscar labs" }), { target: { value: "Lambda" } });
  view.unmount(); show();
  expect(screen.getByRole("textbox", { name: "Buscar labs" })).toHaveValue("Lambda");
  expect(screen.getByText("AWS Lambda: configurar e invocar uma função")).toBeInTheDocument();
});
