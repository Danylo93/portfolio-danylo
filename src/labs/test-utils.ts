// Shared helpers for lab tests. Only imported by *.test.ts files.
import { expect, vi } from "vitest";
import { Shell } from "./shell";
import type { Lab } from "./types";

/**
 * One entry per step. Each action returns a command to run in the terminal, or performs a direct
 * action (e.g. `sh.saveEdit(path, content)` to simulate the editor) and returns nothing.
 */
export type Solution = ((sh: Shell) => string | void)[][];

/** Runs a lab end to end: every step must fail before its actions and pass after them. */
export const expectSolvable = (lab: Lab, solution: Solution) => {
  const sh = new Shell(lab.seed);
  expect(solution, `solution for ${lab.id}`).toHaveLength(lab.steps.length);
  lab.steps.forEach((step, i) => {
    expect(step.check(sh), `${lab.id} step ${i + 1} ("${step.title}") passes before running anything`).toBe(false);
    for (const action of solution[i]) {
      const cmd = action(sh);
      if (typeof cmd === "string") {
        const res = sh.exec(cmd);
        if (res.edit) throw new Error(`"${cmd}" opened the editor; use sh.saveEdit in the solution instead`);
      }
      vi.advanceTimersByTime(5000);
    }
    const last = sh.entries[sh.entries.length - 1];
    expect(step.check(sh), `${lab.id} step ${i + 1} ("${step.title}") — last output:\n${last?.output}`).toBe(true);
  });
  return sh;
};

/** Every step needs hints (ending in a solution) and an explanation. */
export const expectWellFormed = (lab: Lab) => {
  expect(lab.steps.length, lab.id).toBeGreaterThan(0);
  for (const s of lab.steps) {
    expect(s.hints.length, `${lab.id}/${s.title} hints`).toBeGreaterThanOrEqual(2);
    expect(s.explain.length, `${lab.id}/${s.title} explain`).toBeGreaterThan(0);
    expect(s.body.length, `${lab.id}/${s.title} body`).toBeGreaterThan(0);
  }
};

/** Name of the first pod in the namespace whose name starts with prefix. */
export const podName = (sh: Shell, prefix: string, ns = "default") =>
  sh.state.pods.find((p) => p.namespace === ns && p.name.startsWith(prefix))?.name ?? `${prefix}-missing`;

/** Lessons need content, a diagram or table, a callout and a 3+ question quiz with valid answers. */
export const expectLessonWellFormed = (lesson: import("./types").Lesson) => {
  expect(lesson.blocks.length, `${lesson.id} blocks`).toBeGreaterThanOrEqual(4);
  expect(lesson.blocks.some((b) => b.type === "flow" || b.type === "table"), `${lesson.id} needs a flow or table`).toBe(true);
  expect(lesson.blocks.some((b) => b.type === "callout"), `${lesson.id} needs a callout`).toBe(true);
  expect(lesson.quiz.length, `${lesson.id} quiz`).toBeGreaterThanOrEqual(3);
  for (const q of lesson.quiz) {
    expect(q.options.length, `${lesson.id}: ${q.q}`).toBeGreaterThanOrEqual(3);
    expect(q.answer >= 0 && q.answer < q.options.length, `${lesson.id}: answer index`).toBe(true);
  }
};
