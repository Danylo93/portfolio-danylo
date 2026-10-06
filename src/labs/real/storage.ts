import { z } from "zod";
import { readStored, removeStored, writeStored } from "../../lib/storage";
import type { RealLabId } from "./catalog";

const schema = z.object({ version: z.literal(1), labId: z.string(), sessionId: z.string().regex(/^[a-f0-9]{24}$/),
  lines: z.array(z.string()), history: z.array(z.string()), input: z.string(), hint: z.boolean() });
export type SavedRealAttempt = z.infer<typeof schema>;
export const realStorageKey = (labId: string) => `danylo-real-attempt-v1:${labId}`;
export const loadRealAttempt = (labId: RealLabId): SavedRealAttempt | null => {
  const saved = readStored(realStorageKey(labId), (value): value is SavedRealAttempt => schema.safeParse(value).success && (value as SavedRealAttempt).labId === labId);
  if (saved) return saved;
  // Preserve attempts created before localStorage support.
  try {
    const sessionId = sessionStorage.getItem(`danylo-real-session:${labId}`);
    return sessionId && /^[a-f0-9]{24}$/.test(sessionId) ? { version: 1, labId, sessionId, lines: [], history: [], input: "", hint: false } : null;
  } catch { return null; }
};
export const saveRealAttempt = (saved: SavedRealAttempt) => writeStored(realStorageKey(saved.labId), saved);
export const clearRealAttempt = (labId: string) => {
  const removed = removeStored(realStorageKey(labId));
  try { sessionStorage.removeItem(`danylo-real-session:${labId}`); } catch { /* Legacy storage may be unavailable. */ }
  return removed;
};
