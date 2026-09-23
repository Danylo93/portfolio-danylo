// Aggregates all tracks and labs. Importing a track registers the CLI tools it needs.
import type { Lab, Lesson, Step, Track } from "./types";
import * as kubernetes from "./tracks/kubernetes";
import * as cka from "./tracks/cka";
import * as ckad from "./tracks/ckad";
import * as docker from "./tracks/docker";
import * as terraform from "./tracks/terraform";
import * as cicd from "./tracks/cicd";

export type { Lab, Lesson, Step, Track };

const MODULES: { track: Track; labs: Lab[]; lessons?: Lesson[] }[] = [kubernetes, cka, ckad, docker, terraform, cicd];

export const TRACKS: Track[] = MODULES.map((m) => m.track);
export const LABS: Lab[] = MODULES.flatMap((m) => m.labs);
export const LESSONS: Lesson[] = MODULES.flatMap((m) => m.lessons ?? []);

/** Learning path of a track: each lesson right before the lab it prepares for, leftovers at the start. */
export const pathOf = (trackId: string): ({ kind: "lesson"; item: Lesson } | { kind: "lab"; item: Lab })[] => {
  const labs = LABS.filter((l) => l.track === trackId);
  const lessons = LESSONS.filter((l) => l.track === trackId);
  const out: ({ kind: "lesson"; item: Lesson } | { kind: "lab"; item: Lab })[] = lessons
    .filter((l) => !l.before || !labs.some((x) => x.id === l.before))
    .map((item) => ({ kind: "lesson" as const, item }));
  for (const lab of labs) {
    for (const item of lessons.filter((l) => l.before === lab.id)) out.push({ kind: "lesson", item });
    out.push({ kind: "lab", item: lab });
  }
  return out;
};

export const ALL_SKILLS = Array.from(new Set(LABS.flatMap((l) => l.skills)));

// ---------- progress persistence ----------
const KEY = "danylo-labs-progress";

export const loadProgress = (): string[] => {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "[]");
  } catch {
    return [];
  }
};

export const saveProgress = (ids: string[]) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(ids));
  } catch {
    /* storage unavailable */
  }
};

export const markCompleted = (id: string) => {
  const done = loadProgress();
  if (!done.includes(id)) saveProgress([...done, id]);
};

// ---------- navigation ----------
export const itemUrl = (x: { kind: "lesson" | "lab"; item: { id: string } }) => (x.kind === "lesson" ? `/labs/learn/${x.item.id}` : `/labs/${x.item.id}`);

/** The item after `id` in its track's learning path (then the next track). */
export const nextInPath = (id: string) => {
  const all = TRACKS.flatMap((t) => pathOf(t.id));
  const i = all.findIndex((x) => x.item.id === id);
  return i >= 0 ? all[i + 1] : undefined;
};

export const lessonKey = (id: string) => `lesson:${id}`;
