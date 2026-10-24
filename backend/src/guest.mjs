// Guest API: entry gate, memory creation, resumable multipart uploads.
// Every rule that matters (window, caps, types, sizes) is enforced here, never only in the browser.
import {
  LIMITS,
  MEDIA_TYPES,
  HttpError,
  json,
  parseBody,
  RE_EVENT,
  RE_GUEST,
  RE_MEMORY,
  RE_CODE,
  cleanText,
  posInt,
  codeHash,
  safeEqualHex,
  signToken,
  verifyToken,
  bearer,
  sniffMatches,
  isJpeg,
  windowOf,
  ipKey,
  log,
} from './common.mjs';

export function createGuestHandler(deps) {
  const { db, s3 } = deps;

  async function loadEvent(eid) {
    if (typeof eid !== 'string' || !RE_EVENT.test(eid)) throw new HttpError(404, 'bad_link', 'This link is not valid');
    const ev = await db.getEvent(eid);
    if (!ev) throw new HttpError(404, 'bad_link', 'This link is not valid');
    return ev;
  }

  function checkOpen(ev, now, { grace = false } = {}) {
    const opens = Date.parse(ev.opensAt);
    const closes = Date.parse(ev.closesAt) + (grace ? LIMITS.graceAfterCloseMs : 0);
    if (Number.isFinite(opens) && now < opens) throw new HttpError(403, 'not_open', 'Uploads have not opened yet');
    if (Number.isFinite(closes) && now > closes) throw new HttpError(403, 'closed', 'Uploads are closed');
  }

  async function auth(event, now) {
    const secret = await deps.secret();
    const payload = verifyToken(secret, bearer(event), now);
    const ev = await loadEvent(payload.eid);
    if (payload.cv !== ev.codeVersion) throw new HttpError(401, 'code_changed', 'The party code changed. Enter it again.');
    return { gid: payload.gid, eid: payload.eid, ev };
  }

  function describe(item) {
    if (item.status !== 'pending') return { id: item.id, kind: item.kind, status: item.status };
    return { id: item.id, kind: item.kind, status: 'pending', uploadId: item.uploadId, partSize: item.partSize, totalParts: item.totalParts };
  }

  async function findOwned(event, a) {
    const id = event.pathParameters?.id;
    if (typeof id !== 'string' || !RE_MEMORY.test(id)) throw new HttpError(400, 'bad_request', 'Bad memory id');
    const item = await db.getMemory(a.eid, id);
    if (!item || item.guestId !== a.gid) throw new HttpError(404, 'not_found', 'Memory not found');
    return item;
  }

  // ---- POST /guest/start ---------------------------------------------------
  async function start(event, now) {
    const b = parseBody(event);
    const { eventId: eid, code, guestId: gid } = b;
    if (typeof eid !== 'string' || !RE_EVENT.test(eid) || typeof gid !== 'string' || !RE_GUEST.test(gid) || typeof code !== 'string') {
      throw new HttpError(400, 'bad_request', 'Missing fields');
    }
    // Only wrong codes count, so a hundred guests sharing one carrier IP are never locked out.
    const win = windowOf(now);
    const ipk = `RATE#IP#${ipKey(event)}#${win}`;
    const evk = `RATE#EVT#${eid}#${win}`;
    const [ipFails, evFails] = await Promise.all([db.getFailures(ipk), db.getFailures(evk)]);
    if (ipFails >= LIMITS.failuresPerIp || evFails >= LIMITS.failuresPerEvent) {
      throw new HttpError(429, 'too_many', 'Too many tries. Wait a few minutes.');
    }

    const ev = await db.getEvent(eid);
    const ok = !!ev && RE_CODE.test(code) && safeEqualHex(codeHash(eid, code), ev.codeHash);
    if (!ok) {
      const ttl = Math.floor(now / 1000) + 2 * (LIMITS.windowMs / 1000);
      await Promise.all([db.bumpFailures(ipk, ttl), ev ? db.bumpFailures(evk, ttl) : null]);
      log('warn', 'gate_failed', { reason: ev ? 'bad_code' : 'bad_link' });
      throw ev ? new HttpError(401, 'bad_code', 'That code is not right') : new HttpError(404, 'bad_link', 'This link is not valid');
    }
    checkOpen(ev, now);

    const exp = Math.min(now + LIMITS.tokenTtlMs, Date.parse(ev.closesAt) + LIMITS.graceAfterCloseMs);
    const token = signToken(await deps.secret(), { eid, gid, cv: ev.codeVersion, exp });
    return json(200, {
      token,
      exp,
      guestOfHonor: ev.guestOfHonor,
      closesAt: ev.closesAt,
      limits: {
        maxFiles: LIMITS.maxFilesPerGuest,
        maxVideoSeconds: 60,
        maxVideoBytes: LIMITS.maxVideoBytes,
        partSize: LIMITS.partSize,
      },
    });
  }

  // ---- POST /guest/memories ------------------------------------------------
  async function createMemory(event, now) {
    const a = await auth(event, now);
    checkOpen(a.ev, now);
    const b = parseBody(event);
    const id = b.id;
    if (typeof id !== 'string' || !RE_MEMORY.test(id)) throw new HttpError(400, 'bad_request', 'Bad memory id');
    const name = cleanText(b.name, LIMITS.maxNameChars);
    if (!name) throw new HttpError(400, 'name_required', 'Add your name');

    const existing = await db.getMemory(a.eid, id);
    if (existing) {
      if (existing.guestId !== a.gid) throw new HttpError(403, 'forbidden', 'Not your memory');
      return json(200, describe(existing));
    }

    const caps = { maxFiles: LIMITS.maxFilesPerGuest, maxBytes: LIMITS.maxBytesPerGuest };
    const base = {
      id,
      status: 'complete',
      hidden: false,
      guestId: a.gid,
      name,
      createdAt: new Date(now).toISOString(),
    };

    if (b.kind === 'note') {
      const text = cleanText(b.text, LIMITS.maxTextChars, { multiline: true });
      if (text.length < 2) throw new HttpError(400, 'text_required', 'Write a few words');
      const bytes = Buffer.byteLength(text);
      if (!(await db.reserveQuota(a.eid, a.gid, bytes, caps))) throw new HttpError(403, 'limit_reached', 'You have reached the limit');
      const item = { ...base, kind: 'note', text, sizeBytes: bytes, completedAt: base.createdAt };
      try {
        if (!(await db.putMemory(a.eid, item))) {
          await db.releaseQuota(a.eid, a.gid, bytes);
          return json(200, describe(await db.getMemory(a.eid, id)));
        }
      } catch (e) {
        await db.releaseQuota(a.eid, a.gid, bytes).catch(() => {});
        throw e;
      }
      return json(200, describe(item));
    }

    if (b.kind !== 'photo' && b.kind !== 'video') throw new HttpError(400, 'bad_request', 'Unknown kind');
    const spec = MEDIA_TYPES[b.contentType];
    if (!spec || spec.kind !== b.kind) throw new HttpError(400, 'bad_type', 'That file type is not allowed');
    const maxBytes = b.kind === 'photo' ? LIMITS.maxPhotoBytes : LIMITS.maxVideoBytes;
    const sizeBytes = posInt(b.sizeBytes, maxBytes);
    if (!sizeBytes) throw new HttpError(413, 'bad_size', 'That file is too large');
    let durationSec = 0;
    if (b.kind === 'video') {
      durationSec = Number(b.durationSec);
      if (!(durationSec > 0 && durationSec <= LIMITS.maxVideoSeconds)) throw new HttpError(400, 'too_long', 'Videos can be up to 60 seconds');
    }
    const caption = cleanText(b.caption, LIMITS.maxCaptionChars);

    let thumb = null;
    if (b.thumbB64 !== undefined && b.thumbB64 !== null && b.thumbB64 !== '') {
      if (typeof b.thumbB64 !== 'string' || b.thumbB64.length > Math.ceil((LIMITS.maxThumbBytes * 4) / 3) + 8) {
        throw new HttpError(400, 'bad_thumb', 'Thumbnail too large');
      }
      thumb = Buffer.from(b.thumbB64, 'base64');
      if (!thumb.length || thumb.length > LIMITS.maxThumbBytes || !isJpeg(thumb)) throw new HttpError(400, 'bad_thumb', 'Bad thumbnail');
    }

    if (!(await db.reserveQuota(a.eid, a.gid, sizeBytes, caps))) throw new HttpError(403, 'limit_reached', 'You have reached the limit');
    const key = `events/${a.eid}/${id}/original.${spec.ext}`;
    const thumbKey = thumb ? `events/${a.eid}/${id}/thumb.jpg` : undefined;
    let uploadId;
    try {
      if (thumb) await s3.put(thumbKey, thumb, 'image/jpeg');
      uploadId = await s3.createMultipart(key, b.contentType);
      const item = {
        ...base,
        status: 'pending',
        kind: b.kind,
        caption,
        contentType: b.contentType,
        sizeBytes,
        durationSec,
        key,
        thumbKey,
        uploadId,
        partSize: LIMITS.partSize,
        totalParts: Math.ceil(sizeBytes / LIMITS.partSize),
      };
      if (!(await db.putMemory(a.eid, item))) {
        await s3.abort(key, uploadId);
        await db.releaseQuota(a.eid, a.gid, sizeBytes);
        return json(200, describe(await db.getMemory(a.eid, id)));
      }
      return json(200, describe(item));
    } catch (e) {
      await db.releaseQuota(a.eid, a.gid, sizeBytes).catch(() => {});
      if (uploadId) await s3.abort(key, uploadId).catch(() => {});
      throw e;
    }
  }

  // ---- POST /guest/memories/{id}/parts -------------------------------------
  async function parts(event, now) {
    const a = await auth(event, now);
    checkOpen(a.ev, now, { grace: true });
    const item = await findOwned(event, a);
    if (item.status === 'complete') return json(200, { status: 'complete', uploaded: [], urls: [] });
    if (item.status !== 'pending') throw new HttpError(409, 'rejected', 'This upload was rejected');

    const b = parseBody(event);
    const want = Array.isArray(b.partNumbers) ? b.partNumbers : [];
    if (want.length > LIMITS.maxPartsPerCall) throw new HttpError(400, 'bad_request', 'Too many parts requested');
    const nums = want.map((n) => posInt(n, item.totalParts));
    if (nums.some((n) => n === null)) throw new HttpError(400, 'bad_request', 'Bad part number');

    let uploaded;
    try {
      uploaded = await s3.listParts(item.key, item.uploadId);
    } catch (e) {
      if (e.name === 'NoSuchUpload') throw new HttpError(410, 'upload_gone', 'This upload expired. Start it again.');
      throw e;
    }
    const urls = await Promise.all(
      [...new Set(nums)].map(async (n) => ({ partNumber: n, url: await s3.presignPart(item.key, item.uploadId, n, LIMITS.partUrlTtlSec) })),
    );
    return json(200, {
      status: 'pending',
      partSize: item.partSize,
      totalParts: item.totalParts,
      uploaded: uploaded.map((p) => ({ partNumber: p.partNumber, size: p.size })),
      urls,
    });
  }

  // ---- POST /guest/memories/{id}/complete ----------------------------------
  async function complete(event, now) {
    const a = await auth(event, now);
    checkOpen(a.ev, now, { grace: true });
    const item = await findOwned(event, a);
    if (item.status === 'complete') return json(200, { id: item.id, status: 'complete' });
    if (item.status !== 'pending') throw new HttpError(409, 'rejected', 'This upload was rejected');

    const n = item.totalParts;
    let listed = null;
    try {
      listed = await s3.listParts(item.key, item.uploadId);
    } catch (e) {
      if (e.name !== 'NoSuchUpload') throw e;
    }

    if (listed) {
      const bySize = new Map(listed.map((p) => [p.partNumber, p]));
      const missing = [];
      const wrongSize = [];
      for (let i = 1; i <= n; i += 1) {
        const p = bySize.get(i);
        const expect = i < n ? item.partSize : item.sizeBytes - (n - 1) * item.partSize;
        if (!p) missing.push(i);
        else if (p.size !== expect) wrongSize.push(i);
      }
      if (missing.length || wrongSize.length) {
        return json(409, { error: 'incomplete', message: 'Some parts are missing', missing, wrongSize });
      }
      const ordered = [...bySize.values()].filter((p) => p.partNumber <= n).sort((x, y) => x.partNumber - y.partNumber);
      await s3.complete(item.key, item.uploadId, ordered);
    }

    // Either we just completed it, or an earlier attempt did and the item update was lost.
    const head = await s3.head(item.key);
    if (!head) throw new HttpError(410, 'upload_gone', 'This upload expired. Start it again.');
    if (head.size !== item.sizeBytes) {
      await s3.del(item.key).catch(() => {});
      await db.updateMemory(a.eid, item.id, { status: 'rejected', rejectedReason: 'size_mismatch' });
      await db.releaseQuota(a.eid, a.gid, item.sizeBytes).catch(() => {});
      throw new HttpError(422, 'size_mismatch', 'The file did not arrive intact');
    }
    const first = await s3.getRange(item.key, 0, 31);
    if (!sniffMatches(item.contentType, first)) {
      await s3.del(item.key).catch(() => {});
      await db.updateMemory(a.eid, item.id, { status: 'rejected', rejectedReason: 'bad_file' });
      await db.releaseQuota(a.eid, a.gid, item.sizeBytes).catch(() => {});
      throw new HttpError(422, 'bad_file', 'That file does not look like a photo or video');
    }
    const updated = await db.updateMemory(a.eid, item.id, { status: 'complete', completedAt: new Date(now).toISOString() }, 'pending');
    if (!updated) {
      const again = await db.getMemory(a.eid, item.id);
      if (again && again.status === 'complete') return json(200, { id: item.id, status: 'complete' });
      throw new HttpError(409, 'conflict', 'Try again');
    }
    return json(200, { id: item.id, status: 'complete' });
  }

  // ---- DELETE /guest/memories/{id} -----------------------------------------
  async function remove(event, now) {
    const a = await auth(event, now);
    const item = await findOwned(event, a);
    if (item.status === 'complete') throw new HttpError(409, 'already_complete', 'Already sent');
    if (item.status === 'pending') {
      await s3.abort(item.key, item.uploadId).catch(() => {});
      if (item.thumbKey) await s3.del(item.thumbKey).catch(() => {});
      await db.deleteMemory(a.eid, item.id);
      await db.releaseQuota(a.eid, a.gid, item.sizeBytes).catch(() => {});
    }
    return json(200, { ok: true });
  }

  const routes = {
    'POST /guest/start': start,
    'POST /guest/memories': createMemory,
    'POST /guest/memories/{id}/parts': parts,
    'POST /guest/memories/{id}/complete': complete,
    'DELETE /guest/memories/{id}': remove,
  };

  return async function handler(event) {
    try {
      const fn = routes[event.routeKey];
      if (!fn) throw new HttpError(404, 'not_found', 'Unknown route');
      return await fn(event, deps.now());
    } catch (e) {
      if (e instanceof HttpError) return json(e.status, { error: e.code, message: e.message });
      log('error', 'unhandled', { route: event.routeKey, name: e.name, message: e.message });
      return json(500, { error: 'server_error', message: 'Something went wrong. Try again.' });
    }
  };
}
