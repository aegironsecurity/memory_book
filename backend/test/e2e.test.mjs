// End to end: the real uploader engine (frontend/js/uploader.js) talking to the real Lambda handlers
// (with in-memory AWS fakes), under injected network failures.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createGuestHandler } from '../src/guest.mjs';
import { LIMITS } from '../src/common.mjs';
import { createUploader } from '../../frontend/js/uploader.js';
import { ApiError, PutError } from '../../frontend/js/errors.js';
import { makeFakeDeps, EVENT_ID, jpegBytes, mp4Bytes } from './fakes.mjs';

const GID = 'b'.repeat(32);
const MiB = 1024 * 1024;
const mid = (n) => `${String(n).padStart(9, '0')}-${'d'.repeat(16)}`;

function prng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function memStore() {
  const m = new Map();
  return {
    m,
    async list() {
      return [...m.values()];
    },
    async get(id) {
      return m.get(id);
    },
    async put(it) {
      m.set(it.id, { ...it });
    },
    async remove(id) {
      m.delete(id);
    },
  };
}

async function world({ failRate = 0, seed = 1, code = '1966' } = {}) {
  const f = makeFakeDeps({ code });
  const handler = createGuestHandler(f.deps);
  const rnd = prng(seed);
  const state = { token: null, calls: 0, injected: 0, putCalls: 0, partsPut: new Map() };

  async function raw(routeKey, body, id) {
    const res = await handler({
      routeKey,
      headers: state.token ? { authorization: `Bearer ${state.token}` } : {},
      body: body === undefined ? undefined : JSON.stringify(body),
      pathParameters: id ? { id } : undefined,
      requestContext: { http: { sourceIp: '1.2.3.4' } },
    });
    const parsed = JSON.parse(res.body);
    if (res.statusCode >= 400) throw new ApiError(res.statusCode, parsed.error, parsed.message, parsed);
    return parsed;
  }
  // Network flakiness: the request is lost before it reaches the server, or the answer is lost after.
  async function flaky(fn) {
    state.calls += 1;
    if (failRate && rnd() < failRate) {
      state.injected += 1;
      if (rnd() < 0.5) throw new ApiError(0, 'network', 'offline');
      await fn();
      throw new ApiError(0, 'network', 'timeout');
    }
    return fn();
  }
  const api = {
    createMemory: (p) => flaky(() => raw('POST /guest/memories', p)),
    parts: (id, nums) => flaky(() => raw('POST /guest/memories/{id}/parts', { partNumbers: nums }, id)),
    complete: (id) => flaky(() => raw('POST /guest/memories/{id}/complete', undefined, id)),
    abort: (id) => flaky(() => raw('DELETE /guest/memories/{id}', undefined, id)),
  };
  async function putPart(url, blob, { onProgress } = {}) {
    state.putCalls += 1;
    const buf = Buffer.from(await blob.arrayBuffer());
    if (failRate && rnd() < failRate) {
      state.injected += 1;
      const r = rnd();
      if (r < 0.4) throw new PutError(0, 'network');
      if (r < 0.7) {
        f.helpers.putViaUrl(url, buf); // stored, but the ack never came back
        throw new PutError(0, 'timeout');
      }
      throw new PutError(403, 'expired'); // pretend the signed URL went stale
    }
    onProgress?.(buf.length);
    const res = f.helpers.putViaUrl(url, buf);
    if (res.status !== 200) throw new PutError(res.status, 'put_failed');
    const n = Number(new URL(url).searchParams.get('n'));
    const key = `${url.split('u=')[1].split('&')[0]}:${n}`;
    state.partsPut.set(key, (state.partsPut.get(key) || 0) + 1);
  }
  // Sign in like the page does.
  const start = await raw('POST /guest/start', { eventId: EVENT_ID, code: '1966', guestId: GID });
  state.token = start.token;
  let idn = 1000;
  const mk = (store, extra = {}) =>
    createUploader({
      store,
      api,
      putPart,
      sleep: async () => {},
      random: rnd,
      newId: () => mid((idn += 1)),
      concurrency: 2,
      onAuthNeeded: async () => {
        const s = await raw('POST /guest/start', { eventId: EVENT_ID, code: extra.newCode || '1966', guestId: GID });
        state.token = s.token;
      },
    });
  return { f, state, api, mk, raw };
}

const settle = async (u) => {
  for (let i = 0; i < 200; i += 1) {
    await u.idle();
    if (!u.snapshot().some((x) => x.status === 'queued')) return;
    await new Promise((r) => setTimeout(r, 2));
  }
};

const noteItem = (n, text = 'Feliz cumpleaños Don Manuel') => ({ id: mid(n), kind: 'note', name: 'Ana', text });
const mediaItem = (n, kind, contentType, buf, extra = {}) => ({
  id: mid(n),
  kind,
  name: 'Ana',
  caption: 'hi',
  contentType,
  sizeBytes: buf.length,
  durationSec: kind === 'video' ? 12 : 0,
  thumbB64: jpegBytes(400).toString('base64'),
  blob: new Blob([buf]),
  ...extra,
});

for (const [label, failRate] of [['clean network', 0], ['25% failures', 0.25], ['45% failures', 0.45]]) {
  test(`everything arrives intact over a ${label}`, async () => {
    const w = await world({ failRate, seed: 42 });
    const store = memStore();
    const u = createUploader({ store, api: w.api, putPart: null }); // placeholder to prove factory shape
    assert.ok(u.enqueue);
    const up = w.mk(store);
    await up.init();
    const photo = jpegBytes(3 * MiB);
    const video = mp4Bytes(17 * MiB);
    const edge = mp4Bytes(2 * LIMITS.partSize); // exactly two parts
    const tiny = jpegBytes(900);
    await up.enqueue(noteItem(1));
    await up.enqueue(mediaItem(2, 'photo', 'image/jpeg', photo));
    await up.enqueue(mediaItem(3, 'video', 'video/mp4', video));
    await up.enqueue(mediaItem(4, 'video', 'video/mp4', edge));
    await up.enqueue(mediaItem(5, 'photo', 'image/jpeg', tiny));
    await settle(up);
    const snap = up.snapshot();
    assert.deepEqual(snap.map((x) => x.status), ['done', 'done', 'done', 'done', 'done']);
    const obj = (n, ext) => w.f.helpers.objects.get(`events/${EVENT_ID}/${mid(n)}/original.${ext}`);
    assert.deepEqual(obj(2, 'jpg'), photo);
    assert.deepEqual(obj(3, 'mp4'), video);
    assert.deepEqual(obj(4, 'mp4'), edge);
    assert.deepEqual(obj(5, 'jpg'), tiny);
    assert.equal(w.f.helpers.mem.size, 5);
    // finished items drop their blobs so the phone does not keep two copies
    for (const it of store.m.values()) assert.equal(it.blob, undefined);
    assert.equal(w.f.helpers.uploads.size, 0, 'no dangling multipart uploads');
    if (failRate) assert.ok(w.state.injected > 0, 'failures were really injected');
  });
}

test('after a part is stored on the server it is never sent twice (resume skips finished parts)', async () => {
  const w = await world({ failRate: 0, seed: 3 });
  const store = memStore();
  const video = mp4Bytes(17 * MiB);
  // First "tab": uploads two of four parts, then dies.
  let putCount = 0;
  const dying = createUploader({
    store,
    api: w.api,
    sleep: async () => {},
    concurrency: 1,
    putPart: async (url, blob) => {
      putCount += 1;
      if (putCount > 2) {
        // tab killed: this promise never settles
        return new Promise(() => {});
      }
      w.f.helpers.putViaUrl(url, Buffer.from(await blob.arrayBuffer()));
    },
  });
  await dying.init();
  await dying.enqueue(mediaItem(1, 'video', 'video/mp4', video));
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(putCount, 3);
  assert.equal([...w.f.helpers.uploads.values()][0].parts.size, 2);
  // Second "tab": same IndexedDB store, same server.
  const sent = [];
  const fresh = createUploader({
    store,
    api: w.api,
    sleep: async () => {},
    concurrency: 1,
    putPart: async (url, blob) => {
      sent.push(Number(new URL(url).searchParams.get('n')));
      w.f.helpers.putViaUrl(url, Buffer.from(await blob.arrayBuffer()));
    },
  });
  await fresh.init();
  assert.equal(fresh.snapshot()[0].status, 'queued');
  fresh.kick();
  await settle(fresh);
  assert.deepEqual(sent.sort(), [3, 4]);
  assert.equal(fresh.snapshot()[0].status, 'done');
  assert.deepEqual(w.f.helpers.objects.get(`events/${EVENT_ID}/${mid(1)}/original.mp4`), video);
});

test('permanent failures stop only that item', async () => {
  const w = await world();
  const store = memStore();
  const up = w.mk(store);
  await up.init();
  const fake = mp4Bytes(600); // video bytes declared as a jpeg
  await up.enqueue(mediaItem(1, 'photo', 'image/jpeg', fake));
  await up.enqueue(noteItem(2));
  await settle(up);
  const [a, b] = up.snapshot();
  assert.equal(a.status, 'failed');
  assert.equal(a.failReason, 'bad_file');
  assert.equal(b.status, 'done');
});

test('the 16th file is refused for good and does not spin forever', async () => {
  const w = await world();
  const store = memStore();
  const up = w.mk(store);
  await up.init();
  for (let n = 1; n <= LIMITS.maxFilesPerGuest + 1; n += 1) await up.enqueue(noteItem(n));
  await settle(up);
  const snap = up.snapshot();
  assert.equal(snap.filter((x) => x.status === 'done').length, LIMITS.maxFilesPerGuest);
  const last = snap[snap.length - 1];
  assert.equal(last.status, 'failed');
  assert.equal(last.failReason, 'limit_reached');
});

test('closed window fails the item cleanly', async () => {
  const w = await world();
  w.f.helpers.clock.t = Date.parse('2026-10-27T07:00:00Z'); // past the 6 hour grace
  const store = memStore();
  const up = w.mk(store);
  await up.init();
  await up.enqueue(noteItem(1));
  await settle(up);
  const s = up.snapshot()[0];
  assert.equal(s.status, 'failed');
  assert.ok(['closed', 'expired'].includes(s.failReason), s.failReason);
});

test('an expired multipart upload restarts under a new id and still arrives', async () => {
  const w = await world();
  const store = memStore();
  const video = mp4Bytes(7 * MiB);
  let killed = false;
  const up = createUploader({
    store,
    api: w.api,
    sleep: async () => {},
    concurrency: 1,
    newId: () => mid(555),
    putPart: async (url, blob) => {
      if (!killed) {
        killed = true;
        w.f.helpers.uploads.clear(); // S3 lifecycle aborted it behind our back
      }
      const r = w.f.helpers.putViaUrl(url, Buffer.from(await blob.arrayBuffer()));
      if (r.status !== 200) throw new PutError(r.status, 'put_failed');
    },
  });
  await up.init();
  await up.enqueue(mediaItem(1, 'video', 'video/mp4', video));
  await settle(up);
  const s = up.snapshot();
  assert.equal(s.length, 1);
  assert.equal(s[0].status, 'done');
  assert.equal(s[0].id, mid(555));
  assert.deepEqual(w.f.helpers.objects.get(`events/${EVENT_ID}/${mid(555)}/original.mp4`), video);
});

test('code rotation mid-session: the engine asks for auth, then continues', async () => {
  const w = await world();
  const store = memStore();
  // Rotate the code on the server, keeping the same hash scheme: bump version and set new code hash.
  const { codeHash } = await import('../src/common.mjs');
  const ev = w.f.helpers.events.get(EVENT_ID);
  ev.codeHash = codeHash(EVENT_ID, '2468');
  ev.codeVersion = 2;
  const up = w.mk(store, { newCode: '2468' });
  await up.init();
  await up.enqueue(noteItem(1));
  await settle(up);
  assert.equal(up.snapshot()[0].status, 'done');
});

test('a note is saved to the device before any network call', async () => {
  const w = await world();
  const store = memStore();
  const up = w.mk(store);
  await up.init();
  let sawBeforeNetwork = false;
  const orig = w.api.createMemory;
  w.api.createMemory = (p) => {
    sawBeforeNetwork = store.m.has(p.id);
    return orig(p);
  };
  await up.enqueue(noteItem(1));
  await settle(up);
  assert.equal(sawBeforeNetwork, true);
});
