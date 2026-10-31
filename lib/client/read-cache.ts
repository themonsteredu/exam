import { postJson } from "./api";
import type { Usage } from "@/lib/ai/claude";

// Changing OCR instructions or the result format must change this revision.
export const READ_CACHE_REVISION = "native-text-all-figures-v1";
const DB_NAME = "exam-reading-cache";
const MAX_AGE = 30 * 24 * 60 * 60 * 1000;
type Entry = { key: string; at: number; value: any };
const memory = new Map<string, Entry>();
const running = new Map<string, Promise<any>>();
let database: Promise<IDBDatabase | null> | undefined;

function db(): Promise<IDBDatabase | null> {
  if (!database) database = new Promise(resolve => {
    if (typeof indexedDB === "undefined") return resolve(null);
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore("readings", { keyPath: "key" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
  return database;
}
async function get(key: string): Promise<Entry | undefined> {
  const local = memory.get(key);
  if (local && Date.now() - local.at < MAX_AGE) return local;
  const database = await db();
  if (!database) return;
  return new Promise(resolve => {
    try {
      const req = database.transaction("readings").objectStore("readings").get(key);
      req.onsuccess = () => resolve(req.result && Date.now() - req.result.at < MAX_AGE ? req.result : undefined);
      req.onerror = () => resolve(undefined);
    } catch { resolve(undefined); }
  });
}
async function put(entry: Entry): Promise<void> {
  memory.set(entry.key, entry);
  if (memory.size > 100) memory.delete(memory.keys().next().value!);
  const database = await db();
  if (!database) return;
  await new Promise<void>(resolve => {
    try {
      const tx = database.transaction("readings", "readwrite");
      const store = tx.objectStore("readings");
      store.put(entry);
      const request = store.openCursor();
      let count = 0;
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        if (Date.now() - cursor.value.at > MAX_AGE || ++count > 1500) cursor.delete();
        cursor.continue();
      };
      tx.oncomplete = () => resolve();
      tx.onerror = tx.onabort = () => resolve();
    } catch { resolve(); }
  });
}
export async function readingCacheKey(kind: string, body: Record<string, unknown>, scope: string): Promise<string> {
  const { docId: _doc, ...input } = body;
  const bytes = new TextEncoder().encode(JSON.stringify([READ_CACHE_REVISION, scope, kind, input]));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, "0")).join("");
}
function reusable(kind: string, value: any): boolean {
  return kind === "page" ? Array.isArray(value?.reading?.sections)
    : !!(value?.figure?.commands || value?.figure?.graphic) && !value.figure.errors?.length;
}
function reused<T>(value: T): T & { cached: boolean } {
  const copy = structuredClone(value) as any;
  const old = copy.usage as Usage;
  copy.usage = { model: old.model, input: 0, output: 0, cacheWrite: 0, cacheRead: 0, usd: 0 };
  return { ...copy, cached: true };
}
/** Successful individual reads survive refreshes and re-uploading the same source.
 * Keys include the API-key tag, selected model, exact image, context and prompt revision.
 * Failed or invalid figure results are never cached; output generation never calls AI.
 */
export async function readCached<T>(kind: "page" | "figure", body: Record<string, unknown>, scope: string, signal: AbortSignal): Promise<T & { cached?: boolean }> {
  signal.throwIfAborted();
  if (!scope) return postJson("/api/read/" + kind, body, signal);
  const key = await readingCacheKey(kind, body, scope);
  const hit = await get(key);
  signal.throwIfAborted();
  if (hit) return reused<T>(hit.value);
  const pending = running.get(key);
  if (pending) {
    const value = await pending;
    signal.throwIfAborted();
    return reused<T>(value);
  }
  const task = (async () => {
    const value = await postJson<T>("/api/read/" + kind, body, signal);
    if (reusable(kind, value)) await put({ key, at: Date.now(), value: structuredClone(value) });
    return value;
  })();
  running.set(key, task);
  try { return await task; }
  finally { running.delete(key); }
}
