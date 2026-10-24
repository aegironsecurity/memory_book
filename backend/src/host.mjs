// Host API: moderation, code rotation, upload window. Routes sit behind a Cognito JWT authorizer.
import { LIMITS, HttpError, json, parseBody, RE_CODE, RE_MEMORY, codeHash, log } from './common.mjs';

export function createHostHandler(deps) {
  const { db, s3 } = deps;

  function requireHost(event) {
    // API Gateway already validated the JWT. This is a second check that claims were attached.
    const claims = event.requestContext?.authorizer?.jwt?.claims;
    if (!claims || !claims.sub) throw new HttpError(401, 'unauthorized', 'Sign in again');
  }

  async function loadEvent() {
    const eid = deps.env.eventId;
    const ev = eid ? await db.getEvent(eid) : null;
    if (!ev) throw new HttpError(500, 'no_event', 'Event is not set up. Run the seed script.');
    return { eid, ev };
  }

  function summary(eid, ev) {
    return {
      eventId: eid,
      guestOfHonor: ev.guestOfHonor,
      opensAt: ev.opensAt,
      closesAt: ev.closesAt,
      codeVersion: ev.codeVersion,
    };
  }

  const safeName = (s) => String(s || 'guest').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'guest';

  async function list() {
    const { eid, ev } = await loadEvent();
    const items = await db.listMemories(eid);
    items.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const ttl = LIMITS.hostUrlTtlSec;
    const memories = await Promise.all(
      items.map(async (it) => {
        const out = {
          id: it.id,
          kind: it.kind,
          name: it.name,
          text: it.text,
          caption: it.caption,
          status: it.status,
          hidden: !!it.hidden,
          sizeBytes: it.sizeBytes,
          durationSec: it.durationSec,
          contentType: it.contentType,
          createdAt: it.createdAt,
          completedAt: it.completedAt,
        };
        if (it.status === 'complete' && it.key) {
          const ext = it.key.split('.').pop();
          out.url = await s3.presignGet(it.key, { expiresIn: ttl });
          out.downloadUrl = await s3.presignGet(it.key, { expiresIn: ttl, filename: `${safeName(it.name)}-${it.id}.${ext}` });
          if (it.thumbKey) out.thumbUrl = await s3.presignGet(it.thumbKey, { expiresIn: ttl });
        }
        return out;
      }),
    );
    const counts = {
      total: memories.length,
      complete: memories.filter((m) => m.status === 'complete').length,
      pending: memories.filter((m) => m.status === 'pending').length,
      hidden: memories.filter((m) => m.hidden).length,
    };
    return json(200, { event: summary(eid, ev), counts, memories });
  }

  async function setHidden(event, hidden) {
    const { eid } = await loadEvent();
    const id = event.pathParameters?.id;
    if (typeof id !== 'string' || !RE_MEMORY.test(id)) throw new HttpError(400, 'bad_request', 'Bad memory id');
    const updated = await db.updateMemory(eid, id, { hidden });
    if (!updated) throw new HttpError(404, 'not_found', 'Memory not found');
    return json(200, { id, hidden });
  }

  async function rotate(event) {
    const { eid, ev } = await loadEvent();
    const b = parseBody(event);
    const code = b.code === undefined || b.code === '' ? deps.random() : String(b.code);
    if (!RE_CODE.test(code)) throw new HttpError(400, 'bad_code', 'The code must be 4 digits');
    const codeVersion = (ev.codeVersion || 1) + 1;
    await db.updateEvent(eid, { codeHash: codeHash(eid, code), codeVersion });
    log('info', 'code_rotated', { codeVersion });
    return json(200, { code, codeVersion });
  }

  async function windowRoute(event, now) {
    const { eid, ev } = await loadEvent();
    const b = parseBody(event);
    let closesAt;
    if (b.closeNow === true) {
      closesAt = new Date(now).toISOString();
    } else if (typeof b.extendHours === 'number' && b.extendHours >= 1 && b.extendHours <= 168) {
      const base = Math.max(Date.parse(ev.closesAt) || 0, now);
      closesAt = new Date(base + Math.round(b.extendHours) * 3600 * 1000).toISOString();
    } else if (typeof b.closesAt === 'string' && Number.isFinite(Date.parse(b.closesAt))) {
      closesAt = new Date(Date.parse(b.closesAt)).toISOString();
    } else {
      throw new HttpError(400, 'bad_request', 'Send closeNow, extendHours, or closesAt');
    }
    const updated = await db.updateEvent(eid, { closesAt });
    log('info', 'window_changed', { closesAt });
    return json(200, { event: summary(eid, updated) });
  }

  const routes = {
    'GET /host/memories': () => list(),
    'POST /host/memories/{id}/hide': (e) => setHidden(e, true),
    'POST /host/memories/{id}/show': (e) => setHidden(e, false),
    'POST /host/code/rotate': (e) => rotate(e),
    'POST /host/window': (e, now) => windowRoute(e, now),
  };

  return async function handler(event) {
    try {
      requireHost(event);
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
