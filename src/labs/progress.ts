// Keep the original key and array format so existing learners retain their progress.
export const PROGRESS_KEY = "danylo-labs-progress";
export const PROGRESS_EVENT = "danylo-labs-progress-change";

const normalize = (value: unknown): string[] => Array.isArray(value)
  ? [...new Set(value.filter((id): id is string => typeof id === "string" && id.length > 0))]
  : [];

export const loadProgress = (): string[] => {
  try {
    return normalize(JSON.parse(localStorage.getItem(PROGRESS_KEY) ?? "[]"));
  } catch {
    return [];
  }
};

export const saveProgress = (ids: string[]): boolean => {
  try {
    localStorage.setItem(PROGRESS_KEY, JSON.stringify(normalize(ids)));
    window.dispatchEvent(new Event(PROGRESS_EVENT));
    return true;
  } catch {
    return false;
  }
};

export const markCompleted = (id: string): boolean => {
  const done = loadProgress();
  return done.includes(id) || saveProgress([...done, id]);
};

export const exportProgress = () => JSON.stringify({
  version: 1,
  completed: loadProgress(),
}, null, 2);

/** Imports are merged so restoring an older backup never removes newer achievements. */
export const importProgress = (text: string, validIds: ReadonlySet<string>): boolean => {
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== "object" || !("version" in value) || value.version !== 1 ||
      !("completed" in value) || !Array.isArray(value.completed) ||
      !value.completed.every((id) => typeof id === "string")) {
    throw new Error("Arquivo de progresso inválido. Use um backup exportado pelos labs.");
  }
  return saveProgress([...loadProgress(), ...value.completed.filter((id) => validIds.has(id))]);
};
