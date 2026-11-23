// Storage for the hosted web wallet's engine (src/web/web-worker.ts), in the shape the engine expects (KV):
//   idbKV  → IndexedDB, on disk, for what must survive: the sealed vault (Argon2id + AES-256-GCM) and settings.
//   memKV  → a Map in memory, for the unlocked key: never written anywhere, gone when the worker ends.
// Values go through JSON on the way in and out, as chrome.storage does, so the engine sees exactly what it would there.
import type { KV } from './engine'

const json = (v: unknown) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)))

export function idbKV(idb: IDBFactory = indexedDB, name = 'astrala-wallet', store = 'kv'): KV {
  let dbp: Promise<IDBDatabase> | null = null
  const db = () => (dbp ??= new Promise<IDBDatabase>((ok, no) => {
    const r = idb.open(name, 1)
    r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains(store)) r.result.createObjectStore(store) }
    r.onsuccess = () => ok(r.result)
    r.onerror = () => { dbp = null; no(r.error) }
  }))
  const tx = <T>(mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest<T>) => db().then((d) => new Promise<T>((ok, no) => {
    const t = d.transaction(store, mode), q = f(t.objectStore(store))
    t.oncomplete = () => ok(q.result); t.onerror = () => no(t.error); t.onabort = () => no(t.error)
  }))
  return {
    get: async (k) => { const v = await tx('readonly', (s) => s.get(k)); return typeof v === 'string' ? JSON.parse(v) : undefined },
    set: async (k, v) => { if (v === undefined) return void (await tx('readwrite', (s) => s.delete(k))); await tx('readwrite', (s) => s.put(JSON.stringify(v), k)) },
    remove: async (k) => { await tx('readwrite', (s) => s.delete(k)) }
  }
}

export function memKV(): KV {
  const m = new Map<string, unknown>()
  return { get: async (k) => json(m.get(k)), set: async (k, v) => { if (v === undefined) m.delete(k); else m.set(k, json(v)) }, remove: async (k) => { m.delete(k) } }
}

/** The worker's side of the page ⇄ worker protocol: {type:'engine', name, args, id} → {t:'reply', id, result | error}. */
export function serve(engine: { call(name: string, args?: unknown[]): Promise<unknown> }, post: (m: unknown) => void) {
  return (m: any) => {
    if (!m || m.type !== 'engine' || !Number.isSafeInteger(m.id)) return
    engine.call(String(m.name), Array.isArray(m.args) ? m.args : []).then(
      (result) => post({ t: 'reply', id: m.id, result }),
      (err) => post({ t: 'reply', id: m.id, error: String(err?.message ?? err).slice(0, 200) })
    )
  }
}
