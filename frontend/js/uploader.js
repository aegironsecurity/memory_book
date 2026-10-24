// Upload engine. Pure logic with every outside dependency injected, so it runs in Node tests too.
//
// Guarantees:
//  - A contribution is persisted (including its Blob) before any network call.
//  - The server is the source of truth for which parts arrived, so a restart resumes from the
//    last finished part and never re-sends one.
//  - Transient failures (offline, timeouts, 5xx, expired URLs) retry forever with backoff.
//  - Permanent failures (closed window, caps, bad file) stop that item and let the others continue.
import { ApiError, PutError } from './errors.js';

export function classify(e) {
  if (e instanceof PutError) {
    if (e.status === 403 || e.status === 400) return 'refresh'; // expired or invalid signed URL
    if (e.status === 404) return 'gone';
    return 'transient';
  }
  if (e instanceof ApiError) {
    if (e.status === 0 || e.status >= 500 || e.status === 408 || e.status === 429) return 'transient';
    if (e.status === 401) return 'auth';
    if (e.status === 410) return 'gone';
    if (e.status === 409 && e.code === 'incomplete') return 'incomplete';
    return 'fatal';
  }
  return 'unknown';
}

const range = (a, b) => Array.from({ length: Math.max(0, b - a + 1) }, (_, i) => a + i);

export function createUploader({
  store, // { list, get, put, remove } all async
  api, // { createMemory, parts, complete, abort }
  putPart, // async (url, blob, { onProgress }) => void, throws PutError
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  random = Math.random,
  now = Date.now,
  newId, // () => string, used only when an upload has to be restarted
  onChange = () => {},
  onAuthNeeded = async () => {},
  concurrency = 1,
}) {
  const items = new Map();
  const runtime = new Map(); // id -> { phase, note, sentBytes, partsDone, partsTotal }
  const wakers = [];
  let running = false;
  let again = false;
  let notifyTimer = null;

  const rt = (id) => {
    if (!runtime.has(id)) runtime.set(id, { phase: null, note: null, sentBytes: 0, partsDone: 0, partsTotal: 0 });
    return runtime.get(id);
  };

  function snapshot() {
    return [...items.values()]
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((it) => ({
        id: it.id,
        kind: it.kind,
        name: it.name,
        status: it.status,
        failReason: it.failReason || null,
        sizeBytes: it.sizeBytes || 0,
        createdAt: it.createdAt,
        ...rt(it.id),
      }));
  }

  function emit() {
    if (notifyTimer) return;
    notifyTimer = setTimeout(() => {
      notifyTimer = null;
      onChange(snapshot());
    }, 0);
  }

  function wakePromise() {
    return new Promise((res) => wakers.push(res));
  }

  function wake() {
    wakers.splice(0).forEach((r) => r());
  }

  async function backoff(attempt, slow) {
    const base = Math.min(30000, 1000 * 2 ** Math.min(attempt - 1, 5));
    const delay = Math.round((slow ? Math.max(base, 5000) : base) * (0.5 + random() * 0.5));
    await Promise.race([sleep(delay), wakePromise()]);
  }

  // Runs fn until it succeeds. Only permanent errors (and the special kinds the caller handles) escape.
  async function retry(item, fn, { passThrough = [] } = {}) {
    const r = rt(item.id);
    let attempt = 0;
    let unknown = 0;
    for (;;) {
      try {
        const out = await fn();
        r.note = null;
        return out;
      } catch (e) {
        const kind = classify(e);
        if (passThrough.includes(kind)) throw e;
        if (kind === 'fatal' || kind === 'gone') throw e;
        if (kind === 'auth') {
          r.phase = 'auth';
          emit();
          await onAuthNeeded();
          attempt = 0;
          continue;
        }
        if (kind === 'unknown') {
          unknown += 1;
          if (unknown > 8) throw e;
        }
        attempt += 1;
        r.phase = 'waiting';
        r.note = e.code || e.message || 'retrying';
        emit();
        await backoff(attempt, e instanceof ApiError && e.status === 429);
      }
    }
  }

  function createPayload(item) {
    const p = { id: item.id, kind: item.kind, name: item.name };
    if (item.kind === 'note') {
      p.text = item.text;
    } else {
      Object.assign(p, {
        caption: item.caption || '',
        contentType: item.contentType,
        sizeBytes: item.sizeBytes,
        durationSec: item.durationSec || 0,
        thumbB64: item.thumbB64 || '',
      });
    }
    return p;
  }

  const partBounds = (item, partSize, n) => {
    const start = (n - 1) * partSize;
    return { start, end: Math.min(item.sizeBytes, n * partSize) };
  };

  async function uploadMedia(item, info) {
    const r = rt(item.id);
    const total = info.totalParts;
    const partSize = info.partSize;
    r.partsTotal = total;
    const have = new Map();
    const expected = (n) => {
      const b = partBounds(item, partSize, n);
      return b.end - b.start;
    };

    async function probe() {
      const res = await retry(item, () => api.parts(item.id, []));
      if (res.status === 'complete') return true;
      have.clear();
      for (const p of res.uploaded || []) if (p.size === expected(p.partNumber)) have.set(p.partNumber, p.size);
      return false;
    }
    const refreshProgress = () => {
      r.partsDone = have.size;
      let b = 0;
      for (const n of have.keys()) b += expected(n);
      r.sentBytes = b;
    };

    if (await probe()) return;
    refreshProgress();
    const inflight = new Map(); // part -> bytes so far

    async function putOne(n, url) {
      const { start, end } = partBounds(item, partSize, n);
      const blob = item.blob.slice(start, end);
      let refreshes = 0;
      for (let attempt = 1; ; attempt += 1) {
        try {
          await putPart(url, blob, {
            onProgress: (loaded) => {
              inflight.set(n, loaded);
              r.sentBytes = [...have.keys()].reduce((s, k) => s + expected(k), 0) + [...inflight.values()].reduce((s, v) => s + v, 0);
              emit();
            },
          });
          inflight.delete(n);
          have.set(n, end - start);
          refreshProgress();
          emit();
          return;
        } catch (e) {
          inflight.delete(n);
          const kind = classify(e);
          if (kind === 'gone') throw e;
          r.phase = 'waiting';
          r.note = e.code || 'retrying';
          emit();
          if (kind === 'refresh' && refreshes < 6) {
            refreshes += 1;
            const fresh = await retry(item, () => api.parts(item.id, [n]));
            const u = (fresh.urls || []).find((x) => x.partNumber === n);
            if (u) url = u.url;
            continue;
          }
          if (kind === 'unknown' && attempt > 8) throw e;
          await backoff(attempt, false);
        }
      }
    }

    for (;;) {
      const missing = range(1, total).filter((n) => !have.has(n));
      if (missing.length === 0) {
        try {
          await retry(item, () => api.complete(item.id), { passThrough: ['incomplete'] });
          return;
        } catch (e) {
          if (classify(e) !== 'incomplete') throw e;
          if (await probe()) return; // another path finished it
          continue;
        }
      }
      r.phase = 'uploading';
      emit();
      const batch = missing.slice(0, Math.max(1, concurrency));
      const signed = await retry(item, () => api.parts(item.id, batch));
      if (signed.status === 'complete') return;
      await Promise.all(
        batch.map((n) => {
          const u = (signed.urls || []).find((x) => x.partNumber === n);
          return putOne(n, u ? u.url : '');
        }),
      );
    }
  }

  async function runItem(item, depth = 0) {
    const r = rt(item.id);
    r.phase = 'creating';
    r.note = null;
    emit();
    if (item.kind !== 'note' && !(item.blob && item.blob.size === item.sizeBytes)) {
      const e = new ApiError(0, 'lost_file', 'The saved file is missing');
      e.fatal = true;
      throw e;
    }
    const info = await retry(item, () => api.createMemory(createPayload(item)));
    if (info.status === 'complete') return;
    try {
      await uploadMedia(item, info);
    } catch (e) {
      if (classify(e) === 'gone' && depth < 2 && newId) {
        // The multipart upload vanished (expired). Discard it and start over under a new id.
        await api.abort(item.id).catch(() => {});
        await store.remove(item.id);
        items.delete(item.id);
        runtime.delete(item.id);
        item.id = newId();
        items.set(item.id, item);
        await store.put(item);
        return runItem(item, depth + 1);
      }
      throw e;
    }
  }

  async function processItem(item) {
    const r = rt(item.id);
    try {
      await runItem(item);
      const done = { ...item, status: 'done', doneAt: now() };
      delete done.blob;
      delete done.thumbB64;
      items.set(done.id, done);
      rt(done.id).phase = 'done';
      rt(done.id).sentBytes = done.sizeBytes || 0;
      await store.put(done).catch(() => {}); // the upload already succeeded, a storage hiccup must not undo that
    } catch (e) {
      item.status = 'failed';
      item.failReason = e.code || e.message || 'failed';
      r.phase = 'failed';
      r.note = null;
      await store.put(item).catch(() => {});
    }
    emit();
  }

  async function loop() {
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      do {
        again = false;
        for (;;) {
          const next = [...items.values()]
            .filter((i) => i.status === 'queued')
            .sort((a, b) => a.createdAt - b.createdAt)[0];
          if (!next) break;
          await processItem(next);
        }
      } while (again);
    } finally {
      running = false;
      emit();
    }
  }

  return {
    async init() {
      const saved = await store.list();
      const cutoff = now() - 24 * 3600 * 1000;
      for (const it of saved) {
        if (it.status === 'done' && (it.doneAt || 0) < cutoff) {
          await store.remove(it.id);
          continue;
        }
        items.set(it.id, it);
      }
      emit();
    },
    async enqueue(item) {
      const rec = { ...item, status: 'queued', createdAt: item.createdAt || now() };
      items.set(rec.id, rec); // persisted before anything touches the network
      await store.put(rec);
      emit();
      loop();
      return rec.id;
    },
    kick() {
      loop();
    },
    wake,
    snapshot,
    async retryFailed(id) {
      const it = items.get(id);
      if (!it || it.status !== 'failed') return;
      it.status = 'queued';
      it.failReason = null;
      await store.put(it);
      loop();
    },
    async discard(id) {
      const it = items.get(id);
      if (!it) return;
      items.delete(id);
      runtime.delete(id);
      await store.remove(id);
      if (it.status !== 'done') api.abort(id).catch(() => {});
      emit();
    },
    pendingCount() {
      return [...items.values()].filter((i) => i.status === 'queued').length;
    },
    // Test hook: resolves when the loop is idle.
    async idle() {
      while (running) await new Promise((r) => setTimeout(r, 1));
    },
  };
}
