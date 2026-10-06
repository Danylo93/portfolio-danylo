import { readStored, writeStored } from "../lib/storage";
import type { Lesson } from "./types";

type SavedQuiz = { version: 1; lessonId: string; answers: Record<number, number> };
export const lessonStorageKey = (id: string) => `danylo-lesson-quiz-v1:${id}`;
export const loadLessonAnswers = (lesson: Lesson): Record<number, number> => {
  const saved = readStored(lessonStorageKey(lesson.id), (value): value is SavedQuiz => {
    if (!value || typeof value !== "object") return false;
    const s = value as SavedQuiz;
    return s.version === 1 && s.lessonId === lesson.id && !!s.answers && typeof s.answers === "object" && !Array.isArray(s.answers) &&
      Object.entries(s.answers).every(([key, answer]) => /^\d+$/.test(key) && Number(key) < lesson.quiz.length &&
        Number.isInteger(answer) && answer >= 0 && answer < lesson.quiz[Number(key)].options.length);
  });
  return saved?.answers ?? {};
};
export const saveLessonAnswers = (lesson: Lesson, answers: Record<number, number>) =>
  writeStored(lessonStorageKey(lesson.id), { version: 1, lessonId: lesson.id, answers });
