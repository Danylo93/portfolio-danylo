export type Question = {
  id: string; domain: number; prompt: string; options: string[]; correct: number[];
  explanation: string; type: "choice" | "order" | "match"; prompts?: string[];
};

type Draft = Omit<Question, "id">;
export const q = (domain: number, prompt: string, options: string[], explanation: string, correct = [0]): Draft =>
  ({ domain, prompt, options, explanation, correct, type: "choice" });
export const order = (domain: number, prompt: string, options: string[], correct: number[], explanation: string): Draft =>
  ({ domain, prompt, options, correct, explanation, type: "order" });
export const match = (domain: number, prompt: string, prompts: string[], options: string[], correct: number[], explanation: string): Draft =>
  ({ domain, prompt, prompts, options, correct, explanation, type: "match" });

// Distribute answer positions without altering the mapping of ordering/matching questions.
export const bank = (prefix: string, drafts: Draft[]): Question[] => drafts.map((draft, i) => {
  if (draft.type !== "choice") return { ...draft, id: `${prefix}-${i + 1}` };
  const offset = i % draft.options.length;
  const options = draft.options.map((_, j) => draft.options[(j + offset) % draft.options.length]);
  return { ...draft, id: `${prefix}-${i + 1}`, options,
    correct: draft.correct.map((answer) => (answer - offset + options.length) % options.length) };
});
