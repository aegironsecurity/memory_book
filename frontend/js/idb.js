// Durable queue storage in IndexedDB, with an in-memory fallback if the browser refuses it
// (some private modes). The fallback keeps working for as long as the page stays open.
const DB_NAME = 'memorybook-v1';
const STORE = 'items';

function openDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') return reject(new Error('no indexedDB'));
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('blocked'));
  });
}

function tx(db, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const out = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(out && 'result' in out ? out.result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('aborted'));
  });
}

export function createStore() {
  const mem = new Map();
  let dbPromise = openDb().catch(() => null);
  const status = { durable: null };

  return {
    status,
    async ready() {
      const db = await dbPromise;
      status.durable = !!db;
      return status.durable;
    },
    async list() {
      const db = await dbPromise;
      if (db) {
        try {
          const rows = await tx(db, 'readonly', (s) => s.getAll());
          rows.forEach((r) => mem.set(r.id, r));
          return rows;
        } catch (e) {
          /* fall through to memory */
        }
      }
      return [...mem.values()];
    },
    async get(id) {
      if (mem.has(id)) return mem.get(id);
      const db = await dbPromise;
      if (!db) return undefined;
      try {
        return await tx(db, 'readonly', (s) => s.get(id));
      } catch (e) {
        return undefined;
      }
    },
    async put(item) {
      mem.set(item.id, item);
      const db = await dbPromise;
      if (!db) return;
      try {
        await tx(db, 'readwrite', (s) => s.put(item));
      } catch (e) {
        status.durable = false; // quota or a browser bug: the copy in memory still works
      }
    },
    async remove(id) {
      mem.delete(id);
      const db = await dbPromise;
      if (!db) return;
      try {
        await tx(db, 'readwrite', (s) => s.delete(id));
      } catch (e) {
        /* ignore */
      }
    },
  };
}
