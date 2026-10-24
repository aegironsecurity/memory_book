// Sweeps many random failure patterns through the real engine and real handlers. Any seed that loses
// or duplicates a memory fails the test and prints the seed so it can be replayed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createGuestHandler } from '../src/guest.mjs';
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

async function runSeed(seed, failRate) {
  const f = makeFakeDeps();
  const handler = createGuestHandler(f.deps);
  const rnd = prng(seed);
  let token = null;
  async function raw(routeKey, body, id) {
    const res = await handler({ routeKey, headers: token ? { authorization: `Bearer ${token}` } : {}, body: body === undefined ? undefined : JSON.stringify(body), pathParameters: id ? { id } : undefined, requestContext: { http: { sourceIp: '1.2.3.4' } } });
    const parsed = JSON.parse(res.body);
    if (res.statusCode >= 400) throw new ApiError(res.statusCode, parsed.error, parsed.message, parsed);
    return parsed;
  }
  async function flaky(fn) {
    if (rnd() < failRate) {
      const r = rnd();
      if (r < 0.4) throw new ApiError(0, 'network', 'offline');
      if (r < 0.7) throw new ApiError(503, 'chaos', 'bad gateway');
      await fn(); // the server did the work but the answer was lost
      throw new ApiError(0, 'network', 'timeout');
    }
    return fn();
  }
  const api = {
    createMemory: (p) => flaky(() => raw('POST /guest/memories', p)),
    parts: (id, n) => flaky(() => raw('POST /guest/memories/{id}/parts', { partNumbers: n }, id)),
    complete: (id) => flaky(() => raw('POST /guest/memories/{id}/complete', undefined, id)),
    abort: (id) => flaky(() => raw('DELETE /guest/memories/{id}', undefined, id)),
  };
  async function putPart(url, blob) {
    const buf = Buffer.from(await blob.arrayBuffer());
    if (rnd() < failRate) {
      const r = rnd();
      if (r < 0.35) throw new PutError(0, 'network');
      if (r < 0.6) {
        f.helpers.putViaUrl(url, buf);
        throw new PutError(0, 'timeout');
      }
      if (r < 0.8) throw new PutError(500, 'put_failed');
      throw new PutError(403, 'expired');
    }
    const res = f.helpers.putViaUrl(url, buf);
    if (res.status !== 200) throw new PutError(res.status, 'put_failed');
  }
  token = (await raw('POST /guest/start', { eventId: EVENT_ID, code: '1966', guestId: GID })).token;
  const items = new Map();
  const store = {
    async list() {
      return [...items.values()];
    },
    async put(it) {
      items.set(it.id, { ...it });
    },
    async remove(id) {
      items.delete(id);
    },
  };
  const mk = () => createUploader({ store, api, putPart, sleep: async () => {}, random: rnd, newId: () => mid(9000 + Math.floor(rnd() * 1e6)), concurrency: 2, onAuthNeeded: async () => {} });
  let up = mk();
  await up.init();
  const bufs = { 2: jpegBytes(1.2 * MiB), 3: mp4Bytes(11 * MiB), 4: mp4Bytes(5 * MiB), 5: jpegBytes(700) };
  const thumb = jpegBytes(300).toString('base64');
  await up.enqueue({ id: mid(1), kind: 'note', name: 'A', text: 'hola hola' });
  await up.enqueue({ id: mid(2), kind: 'photo', name: 'A', contentType: 'image/jpeg', sizeBytes: bufs[2].length, durationSec: 0, thumbB64: thumb, blob: new Blob([bufs[2]]) });
  await up.enqueue({ id: mid(3), kind: 'video', name: 'A', contentType: 'video/mp4', sizeBytes: bufs[3].length, durationSec: 30, thumbB64: thumb, blob: new Blob([bufs[3]]) });
  await up.enqueue({ id: mid(4), kind: 'video', name: 'A', contentType: 'video/mp4', sizeBytes: bufs[4].length, durationSec: 10, blob: new Blob([bufs[4]]) });
  await up.enqueue({ id: mid(5), kind: 'photo', name: 'A', contentType: 'image/jpeg', sizeBytes: bufs[5].length, durationSec: 0, thumbB64: thumb, blob: new Blob([bufs[5]]) });
  // A "tab death" in the middle: a second engine takes over the same store.
  await new Promise((r) => setTimeout(r, Math.floor(rnd() * 8)));
  up = mk();
  await up.init();
  up.kick();
  for (let i = 0; i < 400; i += 1) {
    await up.idle();
    if (![...items.values()].some((x) => x.status === 'queued')) break;
    await new Promise((r) => setTimeout(r, 2));
  }
  return { f, items, bufs };
}

test('60 random failure patterns: nothing lost, nothing duplicated, bytes intact', async () => {
  for (let seed = 1; seed <= 60; seed += 1) {
    const { f, items, bufs } = await runSeed(seed, 0.4);
    const statuses = [...items.values()].map((x) => `${x.kind}:${x.status}${x.failReason ? `(${x.failReason})` : ''}`);
    assert.equal([...items.values()].every((x) => x.status === 'done'), true, `seed ${seed}: ${statuses.join(' ')}`);
    assert.equal(f.helpers.mem.size, 5, `seed ${seed}: expected 5 memories, got ${f.helpers.mem.size}`);
    const complete = [...f.helpers.mem.values()].filter((m) => m.status === 'complete').length;
    assert.equal(complete, 5, `seed ${seed}: ${complete} complete`);
    for (const m of f.helpers.mem.values()) {
      if (m.kind === 'note') continue;
      const n = m.kind === 'photo' ? (m.sizeBytes === bufs[2].length ? 2 : 5) : m.sizeBytes === bufs[3].length ? 3 : 4;
      const ext = m.kind === 'photo' ? 'jpg' : 'mp4';
      const got = f.helpers.objects.get(`events/${EVENT_ID}/${m.id}/original.${ext}`);
      assert.ok(got && got.equals(bufs[n]), `seed ${seed}: bytes of ${m.kind} ${n} differ`);
    }
    assert.equal(f.helpers.uploads.size, 0, `seed ${seed}: dangling multipart uploads`);
  }
});
