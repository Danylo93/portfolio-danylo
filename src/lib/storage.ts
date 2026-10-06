/** Browser persistence, including Sets/Maps used by the simulated tools. */
const replacer = (_key: string, value: unknown): unknown => {
  if (value instanceof Set) return { $danyloStorage: "Set", values: [...value] };
  if (value instanceof Map) return { $danyloStorage: "Map", values: [...value] };
  return value;
};
const reviver = (_key: string, value: unknown): unknown => {
  if (value && typeof value === "object" && "$danyloStorage" in value) {
    const tagged = value as { $danyloStorage: unknown; values: unknown };
    if (!Array.isArray(tagged.values)) throw new Error("Invalid stored collection");
    if (tagged.$danyloStorage === "Set") return new Set(tagged.values);
    if (tagged.$danyloStorage === "Map" && tagged.values.every((entry) => Array.isArray(entry) && entry.length === 2)) return new Map(tagged.values as [unknown, unknown][]);
    throw new Error("Invalid stored collection");
  }
  return value;
};

export function readStored<T>(key: string, valid: (value: unknown) => value is T): T | null {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return null;
    const value: unknown = JSON.parse(raw, reviver);
    return valid(value) ? value : null;
  } catch { return null; }
}
export function writeStored(key: string, value: unknown): boolean {
  try { localStorage.setItem(key, JSON.stringify(value, replacer)); return true; }
  catch { return false; }
}
export function removeStored(key: string): boolean {
  try { localStorage.removeItem(key); return true; }
  catch { return false; }
}
