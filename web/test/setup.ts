/**
 * Vitest setup.
 *
 * The installed happy-dom build does not provide `localStorage` on the window,
 * so any code touching it sees `undefined` and silently takes its catch path.
 * The plugin runtime's `saveLocalStorage`/`loadLocalStorage` swallow storage
 * errors by design (quota / private mode are non-fatal), which made this look
 * like a product bug rather than a missing test global.
 *
 * Provide a minimal in-memory implementation with the real semantics: values
 * are coerced to strings, and a missing key returns `null` (not `undefined`).
 */
function createStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    key: (index: number) => Array.from(map.keys())[index] ?? null,
    getItem: (key: string) => (map.has(key) ? (map.get(key) as string) : null),
    setItem: (key: string, value: string) => void map.set(String(key), String(value)),
    removeItem: (key: string) => void map.delete(String(key)),
    clear: () => map.clear(),
  } as Storage;
}

for (const name of ['localStorage', 'sessionStorage'] as const) {
  if (!(name in globalThis) || !(globalThis as Record<string, unknown>)[name]) {
    Object.defineProperty(globalThis, name, {
      value: createStorage(),
      configurable: true,
      writable: true,
    });
  }
}
