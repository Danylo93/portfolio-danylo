import type { ExamInfo } from "./catalog";
import type { Question } from "./questions";

export type Attempt = {
  version: 1; examId: string; order: string[]; answers: Record<string, number[]>;
  flagged: string[]; index: number; startedAt: number; deadline: number; finishedAt: number | null;
};
export const attemptKey = (id: string) => `danylo-exam-v1:${id}`;

export const createAttempt = (exam: ExamInfo, questions: Question[], now = Date.now()): Attempt => {
  const order = questions.map((q) => q.id);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return { version: 1, examId: exam.id, order, answers: {}, flagged: [], index: 0,
    startedAt: now, deadline: now + exam.minutes * 60_000, finishedAt: null };
};

export const isAnswered = (question: Question, answer: number[] = []) =>
  answer.length === question.correct.length && answer.every((n) => Number.isInteger(n) && n >= 0 && n < question.options.length) &&
  new Set(answer).size === answer.length;

export const isCorrect = (question: Question, answer: number[] = []) => {
  if (!isAnswered(question, answer)) return false;
  return question.type === "choice"
    ? question.correct.every((n) => answer.includes(n))
    : question.correct.every((n, i) => answer[i] === n);
};

export const grade = (questions: Question[], answers: Attempt["answers"]) => {
  const correct = questions.filter((q) => isCorrect(q, answers[q.id])).length;
  return { correct, total: questions.length, percent: Math.round(correct / questions.length * 100),
    unanswered: questions.filter((q) => !isAnswered(q, answers[q.id])).length };
};

export const finishAttempt = (attempt: Attempt, now = Date.now()): Attempt =>
  attempt.finishedAt === null ? { ...attempt, finishedAt: Math.min(now, attempt.deadline) } : attempt;

// Validate storage before trusting indices, question IDs or timestamps from previous sessions.
export const parseAttempt = (raw: string | null, exam: ExamInfo, questions: Question[], now = Date.now()): Attempt | null => {
  if (!raw) return null;
  try {
    const a: Attempt = JSON.parse(raw);
    const ids = new Map(questions.map((q) => [q.id, q]));
    if (!a || a.version !== 1 || a.examId !== exam.id || !Array.isArray(a.order) ||
      a.order.length !== ids.size || new Set(a.order).size !== ids.size || !a.order.every((id) => ids.has(id)) ||
      !Number.isInteger(a.index) || a.index < 0 || a.index >= ids.size ||
      !Number.isFinite(a.startedAt) || a.startedAt > now || a.startedAt < 0 ||
      a.deadline !== a.startedAt + exam.minutes * 60_000 ||
      !(a.finishedAt === null || (Number.isFinite(a.finishedAt) && a.finishedAt >= a.startedAt && a.finishedAt <= Math.min(now, a.deadline))) ||
      !Array.isArray(a.flagged) || !a.flagged.every((id) => ids.has(id)) ||
      !a.answers || typeof a.answers !== "object" || Array.isArray(a.answers)) return null;
    for (const [id, values] of Object.entries(a.answers)) {
      const q = ids.get(id);
      if (!q || !Array.isArray(values) || values.length > q.correct.length ||
        !values.every((n) => Number.isInteger(n) && n >= -1 && n < q.options.length) ||
        (q.type === "choice" && (values.includes(-1) || new Set(values).size !== values.length))) return null;
    }
    return a.finishedAt === null && now >= a.deadline ? finishAttempt(a, now) : a;
  } catch { return null; }
};

export const loadAttempt = (exam: ExamInfo, questions: Question[]) => {
  try { return parseAttempt(localStorage.getItem(attemptKey(exam.id)), exam, questions); }
  catch { return null; }
};
export const saveAttempt = (attempt: Attempt): boolean => {
  try { localStorage.setItem(attemptKey(attempt.examId), JSON.stringify(attempt)); return true; }
  catch { return false; }
};

export const formatTime = (seconds: number) => `${Math.floor(seconds / 60).toString().padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`;
