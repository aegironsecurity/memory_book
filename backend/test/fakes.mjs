// In-memory stand-ins for DynamoDB and S3 that follow the same interfaces as src/aws.mjs.
import { codeHash } from '../src/common.mjs';

export const EVENT_ID = 'a'.repeat(32);

export function makeFakeDeps({ clock = { t: Date.parse('2026-10-24T20:00:00Z') }, code = '1966' } = {}) {
  const events = new Map();
  const mem = new Map();
  const quota = new Map();
  const failures = new Map();
  const objects = new Map();
  const uploads = new Map();
  let seq = 0;
  const now = () => clock.t;

  events.set(EVENT_ID, {
    guestOfHonor: 'Don Manuel',
    codeHash: codeHash(EVENT_ID, code),
    codeVersion: 1,
    opensAt: '2026-10-01T00:00:00Z',
    closesAt: '2026-10-27T00:00:00Z',
  });

  const noSuchUpload = () => {
    const e = new Error('NoSuchUpload');
    e.name = 'NoSuchUpload';
    return e;
  };

  const db = {
    async getEvent(eid) {
      const e = events.get(eid);
      return e ? { ...e } : null;
    },
    async updateEvent(eid, patch) {
      const e = events.get(eid);
      if (!e) return null;
      Object.assign(e, patch);
      return { ...e };
    },
    async getMemory(eid, mid) {
      const it = mem.get(`${eid}|${mid}`);
      return it ? structuredClone(it) : null;
    },
    async putMemory(eid, item) {
      const k = `${eid}|${item.id}`;
      if (mem.has(k)) return false;
      mem.set(k, structuredClone(item));
      return true;
    },
    async updateMemory(eid, mid, patch, expected) {
      const it = mem.get(`${eid}|${mid}`);
      if (!it) return null;
      if (expected && it.status !== expected) return null;
      Object.assign(it, patch);
      return structuredClone(it);
    },
    async deleteMemory(eid, mid) {
      mem.delete(`${eid}|${mid}`);
    },
    async listMemories(eid) {
      return [...mem.entries()].filter(([k]) => k.startsWith(`${eid}|`)).map(([, v]) => structuredClone(v));
    },
    async reserveQuota(eid, gid, bytes, caps) {
      const k = `${eid}|${gid}`;
      const q = quota.get(k);
      if (bytes > caps.maxBytes) return false;
      if (q && !(q.fileCount < caps.maxFiles && q.bytesTotal <= caps.maxBytes - bytes)) return false;
      quota.set(k, { fileCount: (q?.fileCount || 0) + 1, bytesTotal: (q?.bytesTotal || 0) + bytes });
      return true;
    },
    async releaseQuota(eid, gid, bytes) {
      const k = `${eid}|${gid}`;
      const q = quota.get(k) || { fileCount: 0, bytesTotal: 0 };
      quota.set(k, { fileCount: q.fileCount - 1, bytesTotal: q.bytesTotal - bytes });
    },
    async getFailures(k) {
      return failures.get(k) || 0;
    },
    async bumpFailures(k) {
      failures.set(k, (failures.get(k) || 0) + 1);
    },
  };

  const s3 = {
    async createMultipart(key, contentType) {
      const id = `up${(seq += 1)}`;
      uploads.set(id, { key, contentType, parts: new Map() });
      return id;
    },
    async presignPart(key, uploadId, n, expiresIn) {
      return `fake://put?u=${uploadId}&n=${n}&exp=${now() + expiresIn * 1000}`;
    },
    async listParts(key, uploadId) {
      const u = uploads.get(uploadId);
      if (!u) throw noSuchUpload();
      return [...u.parts.entries()].map(([n, b]) => ({ partNumber: n, size: b.length, etag: `"e${n}"` }));
    },
    async complete(key, uploadId, parts) {
      const u = uploads.get(uploadId);
      if (!u) throw noSuchUpload();
      objects.set(key, Buffer.concat(parts.map((p) => u.parts.get(p.partNumber))));
      uploads.delete(uploadId);
    },
    async abort(key, uploadId) {
      uploads.delete(uploadId);
    },
    async head(key) {
      const o = objects.get(key);
      return o ? { size: o.length } : null;
    },
    async getRange(key, s, e) {
      return objects.get(key).subarray(s, e + 1);
    },
    async put(key, body) {
      objects.set(key, Buffer.from(body));
    },
    async del(key) {
      objects.delete(key);
    },
    async presignGet(key, opts = {}) {
      return `fake://get?k=${encodeURIComponent(key)}${opts.filename ? `&dl=${encodeURIComponent(opts.filename)}` : ''}`;
    },
  };

  // Simulates the browser PUT to a presigned URL.
  function putViaUrl(url, buf) {
    const q = new URL(url).searchParams;
    if (Number(q.get('exp')) < now()) return { status: 403 };
    const u = uploads.get(q.get('u'));
    if (!u) return { status: 404 };
    u.parts.set(Number(q.get('n')), Buffer.from(buf));
    return { status: 200 };
  }

  return {
    deps: { db, s3, now, random: () => '4321', secret: async () => Buffer.from('unit-test-secret-key'), env: { eventId: EVENT_ID } },
    helpers: { events, mem, quota, failures, objects, uploads, putViaUrl, clock },
  };
}

export function jpegBytes(size) {
  const b = Buffer.alloc(size, 7);
  b[0] = 0xff;
  b[1] = 0xd8;
  b[2] = 0xff;
  return b;
}

export function mp4Bytes(size) {
  const b = Buffer.alloc(size, 9);
  b.write('ftyp', 4, 'latin1');
  return b;
}
