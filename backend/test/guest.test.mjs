import test from 'node:test';
import assert from 'node:assert/strict';
import { createGuestHandler } from '../src/guest.mjs';
import { createHostHandler } from '../src/host.mjs';
import { LIMITS, signToken, verifyToken, sniffMatches, cleanText, codeHash } from '../src/common.mjs';
import { makeFakeDeps, EVENT_ID, jpegBytes, mp4Bytes } from './fakes.mjs';

const GID = 'b'.repeat(32);
const GID2 = 'c'.repeat(32);
const mid = (n) => `${String(n).padStart(9, '0')}-${'d'.repeat(16)}`;

function setup(opts) {
  const f = makeFakeDeps(opts);
  const guest = createGuestHandler(f.deps);
  const host = createHostHandler(f.deps);
  const call = async (routeKey, { body, token, id, ip = '9.9.9.9', handler = guest, claims } = {}) => {
    const res = await handler({
      routeKey,
      headers: token ? { authorization: `Bearer ${token}` } : {},
      body: body === undefined ? undefined : JSON.stringify(body),
      pathParameters: id ? { id } : undefined,
      requestContext: { http: { sourceIp: ip }, authorizer: claims ? { jwt: { claims } } : undefined },
    });
    return { status: res.statusCode, body: JSON.parse(res.body) };
  };
  const start = async (code = '1966', gid = GID, ip) => call('POST /guest/start', { body: { eventId: EVENT_ID, code, guestId: gid }, ip });
  const hostCall = (routeKey, o = {}) => call(routeKey, { ...o, handler: host, claims: { sub: 'host-user' } });
  return { ...f, call, start, hostCall, guest, host };
}

test('gate: right code works, wrong code does not, unknown link is 404', async () => {
  const s = setup();
  assert.equal((await s.start('0000')).status, 401);
  assert.equal((await s.start('0000')).body.error, 'bad_code');
  const ok = await s.start();
  assert.equal(ok.status, 200);
  assert.equal(ok.body.guestOfHonor, 'Don Manuel');
  const bad = await s.call('POST /guest/start', { body: { eventId: 'f'.repeat(32), code: '1966', guestId: GID } });
  assert.equal(bad.status, 404);
});

test('gate: wrong codes are limited per IP, but 100 right codes from one IP are never blocked', async () => {
  const s = setup();
  for (let i = 0; i < 100; i += 1) assert.equal((await s.start('1966', `${String(i).padStart(32, 'e')}`.slice(-32), '5.5.5.5')).status, 200);
  for (let i = 0; i < LIMITS.failuresPerIp; i += 1) assert.equal((await s.start('1111', GID, '6.6.6.6')).status, 401);
  assert.equal((await s.start('1111', GID, '6.6.6.6')).status, 429);
  // a different IP is unaffected
  assert.equal((await s.start('1966', GID, '7.7.7.7')).status, 200);
});

test('window: closed after the close time plus grace, not open before opening', async () => {
  const s = setup();
  s.helpers.clock.t = Date.parse('2026-10-26T23:00:00Z'); // one hour before close
  const { token } = (await s.start()).body;
  s.helpers.clock.t = Date.parse('2026-10-27T01:00:00Z'); // 1 hour after close, inside grace
  assert.equal((await s.call('POST /guest/memories', { token, body: { id: mid(1), kind: 'note', name: 'Ana', text: 'hello there' } })).body.error, 'closed');
  assert.equal((await s.start()).body.error, 'closed');
  s.helpers.clock.t = Date.parse('2026-09-01T00:00:00Z');
  assert.equal((await s.start()).body.error, 'not_open');
});

test('token: tampering and expiry are rejected, code rotation revokes old tokens', async () => {
  const s = setup();
  const { token } = (await s.start()).body;
  const bad = `${token.slice(0, -2)}xx`;
  assert.equal((await s.call('POST /guest/memories', { token: bad, body: {} })).body.error, 'bad_token');
  assert.equal((await s.call('POST /guest/memories', { body: {} })).status, 401);
  const rot = await s.hostCall('POST /host/code/rotate', { body: { code: '2468' } });
  assert.equal(rot.status, 200);
  assert.equal((await s.call('POST /guest/memories', { token, body: { id: mid(1), kind: 'note', name: 'A', text: 'hi there' } })).body.error, 'code_changed');
  assert.equal((await s.start('1966')).status, 401);
  assert.equal((await s.start('2468')).status, 200);
  const secret = Buffer.from('k');
  assert.throws(() => verifyToken(secret, signToken(secret, { exp: 5 }), 10), /expired/i);
});

test('notes: validated, cleaned, idempotent, capped', async () => {
  const s = setup();
  const { token } = (await s.start()).body;
  const mk = (n, extra = {}) => s.call('POST /guest/memories', { token, body: { id: mid(n), kind: 'note', name: ' Ana  Lopez ', text: 'Feliz cumpleaños, Don Manuel', ...extra } });
  assert.equal((await mk(1, { text: 'x' })).body.error, 'text_required');
  assert.equal((await mk(1, { name: '' })).body.error, 'name_required');
  assert.equal((await mk(1)).status, 200);
  assert.equal((await mk(1)).status, 200); // retry of a lost response
  const list = await s.hostCall('GET /host/memories');
  assert.equal(list.body.memories.length, 1);
  assert.equal(list.body.memories[0].name, 'Ana Lopez');
  for (let n = 2; n <= LIMITS.maxFilesPerGuest; n += 1) assert.equal((await mk(n)).status, 200);
  assert.equal((await mk(99)).body.error, 'limit_reached');
  // another guest still gets in
  const t2 = (await s.start('1966', GID2)).body.token;
  assert.equal((await s.call('POST /guest/memories', { token: t2, body: { id: mid(200), kind: 'note', name: 'B', text: 'hola hola' } })).status, 200);
});

test('media: type, size, duration and thumbnail checks', async () => {
  const s = setup();
  const { token } = (await s.start()).body;
  const mk = (extra) => s.call('POST /guest/memories', { token, body: { id: mid(1), kind: 'video', name: 'A', contentType: 'video/mp4', sizeBytes: 1000, durationSec: 20, ...extra } });
  assert.equal((await mk({ contentType: 'application/pdf' })).body.error, 'bad_type');
  assert.equal((await mk({ kind: 'photo' })).body.error, 'bad_type'); // mp4 declared as a photo
  assert.equal((await mk({ sizeBytes: LIMITS.maxVideoBytes + 1 })).body.error, 'bad_size');
  assert.equal((await mk({ durationSec: 90 })).body.error, 'too_long');
  assert.equal((await mk({ thumbB64: Buffer.from('not a jpeg at all').toString('base64') })).body.error, 'bad_thumb');
  assert.equal((await mk({ thumbB64: jpegBytes(LIMITS.maxThumbBytes + 10).toString('base64') })).body.error, 'bad_thumb');
  const ok = await mk({ thumbB64: jpegBytes(500).toString('base64') });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.status, 'pending');
  assert.equal(ok.body.totalParts, 1);
  assert.ok(ok.body.uploadId);
  assert.ok(s.helpers.objects.has(`events/${EVENT_ID}/${mid(1)}/thumb.jpg`));
});

async function pending(s, token, n, size, contentType = 'video/mp4') {
  const r = await s.call('POST /guest/memories', { token, body: { id: mid(n), kind: contentType.startsWith('video') ? 'video' : 'photo', name: 'A', contentType, sizeBytes: size, durationSec: 10 } });
  assert.equal(r.status, 200);
  return r.body;
}

test('complete: reports missing and wrong-size parts, then succeeds and verifies content', async () => {
  const s = setup();
  const { token } = (await s.start()).body;
  const size = 2 * LIMITS.partSize + 1234;
  const info = await pending(s, token, 1, size);
  assert.equal(info.totalParts, 3);
  const full = mp4Bytes(size);
  const put = async (n, buf) => {
    const r = await s.call('POST /guest/memories/{id}/parts', { token, id: mid(1), body: { partNumbers: [n] } });
    assert.equal(s.helpers.putViaUrl(r.body.urls[0].url, buf).status, 200);
    return r.body;
  };
  await put(1, full.subarray(0, LIMITS.partSize));
  let c = await s.call('POST /guest/memories/{id}/complete', { token, id: mid(1) });
  assert.equal(c.status, 409);
  assert.deepEqual(c.body.missing, [2, 3]);
  await put(2, full.subarray(0, 100)); // truncated part
  await put(3, full.subarray(2 * LIMITS.partSize));
  c = await s.call('POST /guest/memories/{id}/complete', { token, id: mid(1) });
  assert.deepEqual(c.body.wrongSize, [2]);
  const p = await put(2, full.subarray(LIMITS.partSize, 2 * LIMITS.partSize));
  assert.equal(p.uploaded.length, 3);
  c = await s.call('POST /guest/memories/{id}/complete', { token, id: mid(1) });
  assert.equal(c.status, 200);
  assert.deepEqual(s.helpers.objects.get(`events/${EVENT_ID}/${mid(1)}/original.mp4`), full);
  // completing again is harmless
  assert.equal((await s.call('POST /guest/memories/{id}/complete', { token, id: mid(1) })).status, 200);
});

test('complete: a file whose bytes do not match its type is rejected and removed', async () => {
  const s = setup();
  const { token } = (await s.start()).body;
  await pending(s, token, 1, 600, 'image/jpeg');
  const r = await s.call('POST /guest/memories/{id}/parts', { token, id: mid(1), body: { partNumbers: [1] } });
  s.helpers.putViaUrl(r.body.urls[0].url, mp4Bytes(600)); // video bytes sent as a jpeg
  const c = await s.call('POST /guest/memories/{id}/complete', { token, id: mid(1) });
  assert.equal(c.body.error, 'bad_file');
  assert.equal(s.helpers.objects.has(`events/${EVENT_ID}/${mid(1)}/original.jpg`), false);
  assert.equal((await s.call('POST /guest/memories/{id}/parts', { token, id: mid(1), body: { partNumbers: [1] } })).body.error, 'rejected');
});

test('ownership and cleanup: other guests cannot touch a memory, delete aborts and frees quota', async () => {
  const s = setup();
  const { token } = (await s.start()).body;
  const t2 = (await s.start('1966', GID2)).body.token;
  const info = await pending(s, token, 1, 5000, 'image/jpeg');
  assert.equal((await s.call('POST /guest/memories/{id}/parts', { token: t2, id: mid(1), body: { partNumbers: [1] } })).status, 404);
  assert.equal((await s.call('DELETE /guest/memories/{id}', { token: t2, id: mid(1) })).status, 404);
  assert.equal((await s.call('POST /guest/memories/{id}/parts', { token, id: mid(1), body: { partNumbers: [2] } })).body.error, 'bad_request');
  assert.equal((await s.call('DELETE /guest/memories/{id}', { token, id: mid(1) })).status, 200);
  assert.equal(s.helpers.uploads.has(info.uploadId), false);
  assert.equal(s.helpers.quota.get(`${EVENT_ID}|${GID}`).fileCount, 0);
});

test('host: needs claims, lists with links, hides and shows, changes the window', async () => {
  const s = setup();
  const { token } = (await s.start()).body;
  await s.call('POST /guest/memories', { token, body: { id: mid(1), kind: 'note', name: 'Ana', text: 'una nota' } });
  const noAuth = await s.call('GET /host/memories', { handler: s.host });
  assert.equal(noAuth.status, 401);
  assert.equal((await s.hostCall('POST /host/memories/{id}/hide', { id: mid(1) })).status, 200);
  let list = await s.hostCall('GET /host/memories');
  assert.equal(list.body.counts.hidden, 1);
  await s.hostCall('POST /host/memories/{id}/show', { id: mid(1) });
  list = await s.hostCall('GET /host/memories');
  assert.equal(list.body.counts.hidden, 0);
  assert.equal((await s.hostCall('POST /host/memories/{id}/hide', { id: mid(77) })).status, 404);
  assert.equal((await s.hostCall('POST /host/code/rotate', { body: { code: 'abcd' } })).body.error, 'bad_code');
  const rnd = await s.hostCall('POST /host/code/rotate', { body: {} });
  assert.equal(rnd.body.code, '4321');
  const closed = await s.hostCall('POST /host/window', { body: { closeNow: true } });
  assert.equal(closed.body.event.closesAt, new Date(s.helpers.clock.t).toISOString());
  const ext = await s.hostCall('POST /host/window', { body: { extendHours: 24 } });
  assert.equal(Date.parse(ext.body.event.closesAt), s.helpers.clock.t + 24 * 3600 * 1000);
});

test('book sign-up: needs a token, checks the email, one row per guest, can be withdrawn', async () => {
  const s = setup();
  assert.equal((await s.call('POST /guest/optin', { body: { name: 'Ana', email: 'ana@example.com' } })).status, 401);
  const { token } = (await s.start()).body;
  const t2 = (await s.start('1966', GID2)).body.token;
  assert.equal((await s.call('POST /guest/optin', { token, body: { name: 'Ana', email: 'not-an-email' } })).body.error, 'bad_email');
  assert.equal((await s.call('POST /guest/optin', { token, body: { name: '', email: 'ana@example.com' } })).body.error, 'name_required');
  assert.equal((await s.call('POST /guest/optin', { token, body: { name: 'Ana', email: 'a@b.c<script>' } })).body.error, 'bad_email');
  assert.equal((await s.call('POST /guest/optin', { token, body: { name: 'Ana', email: 'ana s@example.com' } })).body.error, 'bad_email');
  assert.equal((await s.call('POST /guest/optin', { token, body: { name: 'Ana', email: 'ana@examplecom' } })).body.error, 'bad_email');
  assert.equal((await s.call('POST /guest/optin', { token, body: { name: 'Sus', email: 'susanaso@sss.es' } })).status, 200);
  const ok = await s.call('POST /guest/optin', { token, body: { name: ' Ana ', email: ' Ana@Example.COM ' } });
  assert.deepEqual(ok.body, { optIn: true, name: 'Ana', email: 'ana@example.com' });
  await s.call('POST /guest/optin', { token, body: { name: 'Ana Maria', email: 'ana@example.com' } });
  await s.call('POST /guest/optin', { token: t2, body: { name: 'Beto', email: 'beto@example.com' } });
  let list = (await s.hostCall('GET /host/memories')).body;
  assert.deepEqual(list.optIns.map((o) => [o.name, o.email]), [['Ana Maria', 'ana@example.com'], ['Beto', 'beto@example.com']]);
  assert.equal((await s.call('POST /guest/optin', { token: t2, body: { optIn: false } })).body.optIn, false);
  list = (await s.hostCall('GET /host/memories')).body;
  assert.equal(list.optIns.length, 1);
  assert.equal(list.counts.total, 0, 'sign-ups are not memories');
});

test('helpers: sniffing, text cleaning, code hash', () => {
  assert.equal(sniffMatches('image/jpeg', jpegBytes(20)), true);
  assert.equal(sniffMatches('image/jpeg', mp4Bytes(20)), false);
  assert.equal(sniffMatches('video/mp4', mp4Bytes(20)), true);
  assert.equal(sniffMatches('video/webm', Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4, 5, 6, 7, 8])), true);
  assert.equal(cleanText('  a\u0000b\n\nc  ', 10), 'a b c');
  assert.equal(cleanText('línea 1\nlínea 2', 40, { multiline: true }), 'línea 1\nlínea 2');
  assert.notEqual(codeHash(EVENT_ID, '1966'), codeHash(EVENT_ID, '1967'));
});
