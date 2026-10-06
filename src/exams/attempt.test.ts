import { afterEach, describe, expect, it, vi } from "vitest";
import { EXAMS } from "./catalog";
import { aiQuestions } from "./ai";
import { cloudQuestions } from "./cloud";
import { createAttempt, finishAttempt, grade, isAnswered, isCorrect, loadAttempt, parseAttempt, saveAttempt } from "./attempt";

afterEach(() => vi.restoreAllMocks());

describe("bancos de certificação", () => {
  it.each([[EXAMS[0], cloudQuestions, [16, 19, 22, 8]], [EXAMS[1], aiQuestions, [13, 16, 18, 9, 9]]] as const)("%s cobre os domínios e tipos de resposta", (exam, questions, counts) => {
    expect(questions).toHaveLength(65);
    expect(new Set(questions.map((q) => q.id)).size).toBe(65);
    expect(new Set(questions.map((q) => q.prompt)).size).toBe(65);
    expect(exam.domains.map((_, i) => questions.filter((q) => q.domain === i).length)).toEqual(counts);
    expect(questions.some((q) => q.type === "choice" && q.correct.length > 1)).toBe(true);
    for (const q of questions) {
      expect(q.explanation.length).toBeGreaterThan(30);
      expect(new Set(q.options).size).toBe(q.options.length);
      expect(isCorrect(q, q.correct)).toBe(true);
      expect(isCorrect(q, [])).toBe(false);
      if (q.type === "choice") expect(q.options.length).toBeGreaterThanOrEqual(q.correct.length > 1 ? 5 : 4);
      if (q.type === "match") expect(q.prompts).toHaveLength(q.correct.length);
    }
  });
  it("oferece ordenação e associação no simulado AIF-C01", () => {
    expect(aiQuestions.filter((q) => q.type === "order")).toHaveLength(2);
    expect(aiQuestions.filter((q) => q.type === "match")).toHaveLength(2);
  });
});

describe("correção e persistência", () => {
  it("não dá pontuação parcial em múltiplas respostas", () => {
    const q = cloudQuestions.find((q) => q.correct.length > 1)!;
    expect(isCorrect(q, [q.correct[0]])).toBe(false);
    expect(isCorrect(q, [...q.correct].reverse())).toBe(true);
    expect(isCorrect(q, [...q.correct, q.options.findIndex((_, i) => !q.correct.includes(i))])).toBe(false);
    expect(isCorrect(q, [q.correct[0], q.correct[0]])).toBe(false);
  });
  it("exige a sequência e a associação completas", () => {
    for (const q of aiQuestions.filter((q) => q.type !== "choice")) {
      expect(isCorrect(q, [...q.correct].reverse())).toBe(false);
      expect(isAnswered(q, q.correct.map(() => -1))).toBe(false);
    }
  });
  it("pontua acertos e respostas em branco sem usar a escala oficial", () => {
    expect(grade(cloudQuestions, {})).toEqual({ correct: 0, total: 65, percent: 0, unanswered: 65 });
    expect(grade(cloudQuestions, Object.fromEntries(cloudQuestions.map((q) => [q.id, q.correct])))).toEqual({ correct: 65, total: 65, percent: 100, unanswered: 0 });
  });
  it("preserva uma tentativa e entrega ao atingir o prazo, inclusive ao recarregar", () => {
    const a = createAttempt(EXAMS[0], cloudQuestions, 1000);
    a.answers[cloudQuestions[0].id] = cloudQuestions[0].correct;
    a.flagged = [cloudQuestions[0].id];
    a.index = 3;
    expect(parseAttempt(JSON.stringify(a), EXAMS[0], cloudQuestions, a.deadline - 1)).toEqual(a);
    const expired = parseAttempt(JSON.stringify(a), EXAMS[0], cloudQuestions, a.deadline + 60_000)!;
    expect(expired.finishedAt).toBe(a.deadline);
    expect(expired.answers).toEqual(a.answers);
    expect(finishAttempt(expired, a.deadline + 5000)).toBe(expired);
  });
  it("rejeita dados corrompidos ou de outra prova", () => {
    const a = createAttempt(EXAMS[0], cloudQuestions, 1000);
    expect(parseAttempt("{broken", EXAMS[0], cloudQuestions, 1000)).toBeNull();
    expect(parseAttempt(JSON.stringify(a), EXAMS[1], aiQuestions, 1000)).toBeNull();
    expect(parseAttempt(JSON.stringify({ ...a, index: 99 }), EXAMS[0], cloudQuestions, 1000)).toBeNull();
    expect(parseAttempt(JSON.stringify({ ...a, deadline: a.deadline + 1000 }), EXAMS[0], cloudQuestions, 1000)).toBeNull();
    expect(parseAttempt(JSON.stringify({ ...a, answers: { [cloudQuestions[0].id]: [900] } }), EXAMS[0], cloudQuestions, 1000)).toBeNull();
    expect(parseAttempt(JSON.stringify({ ...a, order: a.order.map(() => a.order[0]) }), EXAMS[0], cloudQuestions, 1000)).toBeNull();
  });
  it("funciona com armazenamento indisponível", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    expect(loadAttempt(EXAMS[0], cloudQuestions)).toBeNull();
    expect(saveAttempt(createAttempt(EXAMS[0], cloudQuestions))).toBe(false);
  });
});
