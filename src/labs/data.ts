// Aggregates all tracks and labs. Importing a track registers the CLI tools it needs.
import type { Lab, Step, Track } from "./types";
import * as kubernetes from "./tracks/kubernetes";
import * as docker from "./tracks/docker";
import * as terraform from "./tracks/terraform";

export type { Lab, Step, Track };

const MODULES: { track: Track; labs: Lab[] }[] = [kubernetes, docker, terraform];

export const TRACKS: Track[] = MODULES.map((m) => m.track);
export const LABS: Lab[] = MODULES.flatMap((m) => m.labs);

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
