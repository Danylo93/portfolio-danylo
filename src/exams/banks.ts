import { aiQuestions } from "./ai";
import { cloudQuestions } from "./cloud";
import { devopsQuestions } from "./devops";
import type { Question } from "./questions";

export const QUESTION_BANKS: Record<string, Question[]> = {
  "cloud-practitioner": cloudQuestions,
  "ai-practitioner": aiQuestions,
  "devops-professional": devopsQuestions,
};
