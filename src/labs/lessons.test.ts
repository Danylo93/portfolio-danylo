import { describe, expect, it } from "vitest";
import { LABS, LESSONS, pathOf, TRACKS } from "./data";
import { expectLessonWellFormed } from "./test-utils";

describe("lessons", () => {
  it.each(LESSONS.map((l) => [l.id, l] as const))("%s is well formed", (_, lesson) => {
    expectLessonWellFormed(lesson);
    if (lesson.before) expect(LABS.some((l) => l.id === lesson.before), `${lesson.id} before ${lesson.before}`).toBe(true);
  });

  it("ids are unique", () => {
    const ids = [...LESSONS.map((l) => l.id), ...LABS.map((l) => l.id)];
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every lesson appears in its track path, before its lab", () => {
    for (const t of TRACKS) {
      const path = pathOf(t.id).map((x) => x.item.id);
      for (const l of LESSONS.filter((x) => x.track === t.id)) {
        expect(path).toContain(l.id);
        if (l.before) expect(path.indexOf(l.id)).toBeLessThan(path.indexOf(l.before));
      }
    }
  });
});
