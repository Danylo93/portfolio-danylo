import { beforeEach, describe, expect, it, vi } from "vitest";
import { exportProgress, importProgress, loadProgress, markCompleted, PROGRESS_KEY, saveProgress } from "./progress";
import { LABS, LESSONS, lessonKey, nextUnfinished, pathOf, TRACKS } from "./data";

beforeEach(() => { localStorage.clear(); vi.restoreAllMocks(); });

describe("learner progress", () => {
  it.each(["null", "{}", '"text"', "1", "{broken"])("recovers from malformed storage: %s", (raw) => {
    localStorage.setItem(PROGRESS_KEY, raw);
    expect(loadProgress()).toEqual([]);
    expect(markCompleted("lab-a")).toBe(true);
    expect(loadProgress()).toEqual(["lab-a"]);
  });
  it("preserves existing array-format progress and removes invalid duplicates", () => {
    localStorage.setItem(PROGRESS_KEY, '["lab-a",null,5,"lab-a","lesson:b",""]');
    expect(loadProgress()).toEqual(["lab-a", "lesson:b"]);
  });
  it("merges an older backup without removing current progress or importing unknown IDs", () => {
    saveProgress(["lab-a"]);
    expect(importProgress('{"version":1,"completed":["lab-b","lab-b","unknown"]}', new Set(["lab-a", "lab-b"]))).toBe(true);
    expect(loadProgress()).toEqual(["lab-a", "lab-b"]);
    const backup = exportProgress();
    localStorage.clear();
    importProgress(backup, new Set(["lab-a", "lab-b"]));
    expect(loadProgress()).toEqual(["lab-a", "lab-b"]);
  });
  it.each(['{}', '{"version":2,"completed":[]}', '{"version":1,"completed":[4]}', 'null'])("rejects invalid backup without replacing progress: %s", (raw) => {
    saveProgress(["lab-a"]);
    expect(() => importProgress(raw, new Set())).toThrow();
    expect(loadProgress()).toEqual(["lab-a"]);
  });
  it("reports storage errors instead of crashing or pretending to persist", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("quota"); });
    expect(saveProgress(["lab-a"])).toBe(false);
    expect(markCompleted("lab-a")).toBe(false);
  });
  it("continues through lessons and labs in learning-path order", () => {
    const path = TRACKS.flatMap((t) => pathOf(t.id));
    expect(nextUnfinished([])).toEqual(path[0]);
    const done = path.slice(0, 3).map((x) => x.kind === "lesson" ? lessonKey(x.item.id) : x.item.id);
    expect(nextUnfinished(done)).toEqual(path[3]);
    expect(nextUnfinished([...LABS.map((l) => l.id), ...LESSONS.map((l) => lessonKey(l.id))])).toBeUndefined();
  });
});
