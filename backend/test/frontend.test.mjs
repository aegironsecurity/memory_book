// Checks on the front end that need no browser: copy parity, CSP safety, wiring and style rules.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DICT, t, setLang, setVars, detectLang } from '../../frontend/js/i18n.js';
import { parseEventId, videoVerdict, videoTypeFor, fitWithin, pickRecorderMime, mmss, fmtBytes, baseType } from '../../frontend/js/policy.js';
import { createApi } from '../../frontend/js/api.js';
import { ApiError } from '../../frontend/js/errors.js';
import { newMemoryId, newGuestId } from '../../frontend/js/ids.js';
import { createCognito, AuthError } from '../../frontend/js/cognito.js';
import { guestUrl, qrSvg, extOf, exportJson } from '../../frontend/js/hostlib.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const placeholders = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');

test('English and Spanish have the same keys and the same placeholders', () => {
  const en = Object.keys(DICT.en).sort();
  const es = Object.keys(DICT.es).sort();
  assert.deepEqual(es, en);
  for (const k of en) assert.equal(placeholders(DICT.es[k]), placeholders(DICT.en[k]), `placeholders differ for ${k}`);
});

test('t() fills variables and falls back to English', () => {
  setLang('en');
  setVars({ who: 'Don Manuel' });
  assert.equal(t('gate.title'), "Don Manuel's 60th");
  assert.equal(t('tray.progress', { n: 2, m: 5 }), '2 of 5 sent');
  setLang('es');
  assert.equal(t('gate.title'), 'Los 60 de Don Manuel');
  assert.equal(t('nope.missing'), 'nope.missing');
  setLang('en');
  assert.equal(detectLang(null, 'es-MX'), 'es');
  assert.equal(detectLang(null, 'en-US'), 'en');
  assert.equal(detectLang('en', 'es-MX'), 'en');
});

test('every key used by the HTML and the scripts exists', () => {
  const html = read('frontend/index.html');
  const keys = new Set();
  for (const m of html.matchAll(/data-(?:i18n|i18n-ph|i18n-aria|start)="([^"]+)"/g)) keys.add(m[1]);
  const guest = read('frontend/js/guest.js');
  for (const m of guest.matchAll(/\bt\('([a-zA-Z0-9_.]+)'/g)) keys.add(m[1]);
  for (const m of guest.matchAll(/'((?:err|video|home|tray|done|fail|thanks|auth|photo|note|item|gate|link|closed|storage|unload)\.[A-Za-z0-9_]+)'/g)) keys.add(m[1]);
  for (const k of keys) assert.ok(k in DICT.en, `missing key ${k}`);
});

test('every element id the guest script looks up exists in index.html', () => {
  const html = read('frontend/index.html');
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  const js = read('frontend/js/guest.js');
  for (const m of js.matchAll(/\$\('#([A-Za-z0-9_-]+)'\)/g)) assert.ok(ids.has(m[1]), `no element #${m[1]}`);
});

test('pages are CSP safe: no inline script, no inline style, no inline handlers', () => {
  for (const f of ['frontend/index.html', 'frontend/host.html']) {
    if (!fs.existsSync(path.join(root, f))) continue;
    const html = read(f);
    assert.equal(/\sstyle\s*=/.test(html), false, `${f} has a style attribute`);
    assert.equal(/<style[\s>]/i.test(html), false, `${f} has a style block`);
    assert.equal(/\son[a-z]+\s*=/i.test(html), false, `${f} has an inline handler`);
    for (const m of html.matchAll(/<script\b([^>]*)>/gi)) assert.ok(/\ssrc=/.test(m[1]), `${f} has an inline script`);
  }
});

test('no em dashes or en dashes anywhere in the project text', () => {
  const DASHES = new RegExp(`[${String.fromCharCode(0x2013)}${String.fromCharCode(0x2014)}]`);
  const skip = new Set(['node_modules', 'dist', 'vendor', 'fonts', '.git']);
  const bad = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(js|mjs|html|css|md|yaml|yml|json|sh|svg|txt)$/.test(e.name) && !/package-lock/.test(e.name)) {
        const s = fs.readFileSync(p, 'utf8');
        if (DASHES.test(s)) bad.push(path.relative(root, p));
      }
    }
  })(root);
  assert.deepEqual(bad, []);
});

test('event id parsing accepts only the exact link format', () => {
  const id = 'ab'.repeat(16);
  assert.equal(parseEventId(`#e=${id}`), id);
  assert.equal(parseEventId(`#x=1&e=${id}`), id);
  assert.equal(parseEventId('#e=short'), null);
  assert.equal(parseEventId(`#e=${id}zz`), null);
  assert.equal(parseEventId(''), null);
  assert.equal(parseEventId(undefined), null);
});

test('library video rules', () => {
  const ok = { type: 'video/mp4', size: 20e6, duration: 42 };
  assert.equal(videoVerdict(ok), null);
  assert.equal(videoVerdict({ ...ok, duration: 60.4 }), null);
  assert.equal(videoVerdict({ ...ok, duration: 75 }), 'err.videoLong');
  assert.equal(videoVerdict({ ...ok, size: 101 * 1024 * 1024 }), 'err.videoBig');
  assert.equal(videoVerdict({ ...ok, duration: NaN }), 'err.videoUnreadable');
  assert.equal(videoVerdict({ ...ok, type: null }), 'err.videoType');
  assert.equal(videoTypeFor({ type: '', name: 'IMG_1.MOV' }), 'video/quicktime');
  assert.equal(videoTypeFor({ type: 'video/3gpp', name: 'a.3gp' }), null);
  assert.equal(videoTypeFor({ type: 'video/mp4;codecs=avc1', name: 'x' }), 'video/mp4');
});

test('photo sizing keeps the aspect ratio and never upscales', () => {
  assert.deepEqual(fitWithin(4032, 3024, 2048), { w: 2048, h: 1536 });
  assert.deepEqual(fitWithin(3024, 4032, 2048), { w: 1536, h: 2048 });
  assert.deepEqual(fitWithin(800, 600, 2048), { w: 800, h: 600 });
});

test('recorder format choice prefers mp4 on Safari and webm on Chrome', () => {
  const safari = { isTypeSupported: (m) => m.startsWith('video/mp4') };
  const chrome = { isTypeSupported: (m) => m.startsWith('video/webm') };
  assert.equal(baseType(pickRecorderMime(safari)), 'video/mp4');
  assert.equal(baseType(pickRecorderMime(chrome)), 'video/webm');
  assert.equal(pickRecorderMime({ isTypeSupported: () => false }), '');
  assert.equal(pickRecorderMime(undefined), null);
});

test('formatting helpers', () => {
  assert.equal(mmss(61), '1:01');
  assert.equal(mmss(0), '0:00');
  assert.equal(fmtBytes(1024), '< 50 KB');
  assert.equal(fmtBytes(3.4 * 1048576), '3.4 MB');
  assert.equal(fmtBytes(19.2 * 1048576), '19 MB');
});

test('generated ids match what the server accepts', () => {
  for (let i = 0; i < 50; i += 1) assert.match(newMemoryId(), /^[0-9a-z]{9}-[0-9a-f]{16}$/);
  assert.match(newGuestId(), /^[0-9a-f]{32}$/);
  assert.notEqual(newMemoryId(), newMemoryId());
});

test('api client maps every failure to an ApiError the engine understands', async () => {
  const mk = (impl) => createApi({ base: 'https://x.test/', getToken: () => 'tok', fetchImpl: impl });
  // no answer at all
  await assert.rejects(mk(async () => { throw new TypeError('Failed to fetch'); }).createMemory({}), (e) => e instanceof ApiError && e.status === 0);
  // a JSON error
  const err = mk(async () => ({ ok: false, status: 403, json: async () => ({ error: 'closed', message: 'Uploads are closed' }) }));
  await assert.rejects(err.createMemory({}), (e) => e.status === 403 && e.code === 'closed');
  // a gateway page that is not JSON
  const gw = mk(async () => ({ ok: false, status: 502, json: async () => { throw new Error('html'); } }));
  await assert.rejects(gw.parts('id', []), (e) => e.status === 502);
  // success sends the bearer token and a JSON body
  let seen;
  const good = mk(async (url, init) => {
    seen = { url, init };
    return { ok: true, status: 200, json: async () => ({ ok: 1 }) };
  });
  assert.deepEqual(await good.parts('abc', [1, 2]), { ok: 1 });
  assert.equal(seen.url, 'https://x.test/guest/memories/abc/parts');
  assert.equal(seen.init.headers.authorization, 'Bearer tok');
  assert.equal(JSON.parse(seen.init.body).partNumbers.length, 2);
  // start never sends a token
  await good.start('e', '1966', 'g');
  assert.equal(seen.init.headers.authorization, undefined);
});

test('cognito client: sign in, authenticator step, refresh, and error mapping', async () => {
  const calls = [];
  const reply = (status, body) => async (url, init) => {
    calls.push({ url, target: init.headers['x-amz-target'], body: JSON.parse(init.body) });
    return { ok: status < 300, status, json: async () => body };
  };
  const ok = { AuthenticationResult: { IdToken: 'id1', RefreshToken: 'rt1', ExpiresIn: 3600 } };
  let c = createCognito({ region: 'us-west-2', clientId: 'cid', fetchImpl: reply(200, ok) });
  const tok = await c.signIn('jon@example.com', 'pw');
  assert.equal(tok.idToken, 'id1');
  assert.equal(tok.refreshToken, 'rt1');
  assert.ok(tok.expiresAt > Date.now() + 3000000);
  assert.equal(calls[0].url, 'https://cognito-idp.us-west-2.amazonaws.com/');
  assert.equal(calls[0].target, 'AWSCognitoIdentityProviderService.InitiateAuth');
  assert.equal(calls[0].body.AuthFlow, 'USER_PASSWORD_AUTH');
  assert.equal(calls[0].body.ClientId, 'cid');
  // refresh keeps the old refresh token when Cognito does not send a new one
  c = createCognito({ region: 'us-west-2', clientId: 'cid', fetchImpl: reply(200, { AuthenticationResult: { IdToken: 'id2', ExpiresIn: 3600 } }) });
  const r = await c.refresh('rt-old');
  assert.equal(r.idToken, 'id2');
  assert.equal(r.refreshToken, 'rt-old');
  // authenticator code challenge
  c = createCognito({ region: 'us-west-2', clientId: 'cid', fetchImpl: reply(200, { ChallengeName: 'SOFTWARE_TOKEN_MFA', Session: 'sess' }) });
  const ch = await c.signIn('a@b.c', 'pw');
  assert.equal(ch.challenge, 'totp');
  assert.equal(ch.session, 'sess');
  c = createCognito({ region: 'us-west-2', clientId: 'cid', fetchImpl: reply(200, ok) });
  assert.equal((await c.answerTotp({ session: 'sess', username: 'a@b.c' }, '123456')).idToken, 'id1');
  assert.equal(calls.at(-1).body.ChallengeResponses.SOFTWARE_TOKEN_MFA_CODE, '123456');
  // errors
  c = createCognito({ region: 'us-west-2', clientId: 'cid', fetchImpl: reply(400, { __type: 'NotAuthorizedException', message: 'no' }) });
  await assert.rejects(c.signIn('a', 'b'), (e) => e instanceof AuthError && e.code === 'bad_login');
  c = createCognito({ region: 'us-west-2', clientId: 'cid', fetchImpl: reply(400, { __type: 'com.amazonaws#TooManyRequestsException' }) });
  await assert.rejects(c.signIn('a', 'b'), (e) => e.code === 'too_many');
  c = createCognito({ region: 'us-west-2', clientId: 'cid', fetchImpl: reply(200, { ChallengeName: 'NEW_PASSWORD_REQUIRED' }) });
  await assert.rejects(c.signIn('a', 'b'), (e) => e.code === 'unsupported_challenge');
  c = createCognito({ region: 'us-west-2', clientId: 'cid', fetchImpl: async () => { throw new TypeError('offline'); } });
  await assert.rejects(c.signIn('a', 'b'), (e) => e.code === 'network');
});

test('host helpers: guest link, QR svg, export', () => {
  const id = 'c'.repeat(32);
  assert.equal(guestUrl('https://main.d1.amplifyapp.com/', id), `https://main.d1.amplifyapp.com/#e=${id}`);
  const fakeQr = { getModuleCount: () => 2, isDark: (y, x) => y === x };
  const svg = qrSvg(fakeQr);
  assert.match(svg, /viewBox="0 0 10 10"/);
  assert.match(svg, /M4 4h1v1h-1zM5 5h1v1h-1z/);
  assert.equal(/\sstyle=/.test(svg), false);
  assert.equal(extOf('video/webm'), 'webm');
  const out = JSON.parse(exportJson({ event: { eventId: id }, memories: [{ id: 'm1', kind: 'video', name: 'A', contentType: 'video/mp4', status: 'complete', url: 'https://signed' }, { id: 'm2', kind: 'note', name: 'B', text: 'hi', status: 'complete' }] }));
  assert.equal(out.memories[0].file, `events/${id}/m1/original.mp4`);
  assert.equal(out.memories[1].file, undefined);
  assert.equal(JSON.stringify(out).includes('signed'), false, 'signed links are not exported');
});

test('production headers: strict CSP that still allows what the app needs', () => {
  const yml = read('customHttp.yml');
  const m = /Content-Security-Policy\s+value:\s+"([^"]+)"/.exec(yml);
  assert.ok(m, 'CSP header present');
  const csp = Object.fromEntries(m[1].split(';').map((d) => d.trim().split(/\s+/)).map(([k, ...v]) => [k, v]));
  assert.deepEqual(csp['default-src'], ["'none'"]);
  assert.deepEqual(csp['script-src'], ["'self'"]);
  assert.deepEqual(csp['style-src'], ["'self'"]);
  assert.equal(/unsafe-/.test(m[1]), false, 'no unsafe-inline or unsafe-eval');
  for (const origin of ['https://*.execute-api.us-west-2.amazonaws.com', 'https://*.s3.us-west-2.amazonaws.com', 'https://cognito-idp.us-west-2.amazonaws.com']) {
    assert.ok(csp['connect-src'].includes(origin), `connect-src allows ${origin}`);
  }
  assert.ok(csp['media-src'].includes('blob:') && csp['img-src'].includes('blob:'), 'blob previews allowed');
  assert.deepEqual(csp['frame-ancestors'], ["'none'"]);
  assert.match(yml, /Strict-Transport-Security/);
  assert.match(yml, /Referrer-Policy[\s\S]*no-referrer/);
  assert.match(yml, /camera=\(self\), microphone=\(self\)/);
  // amplify.yml serves the frontend folder
  assert.match(read('amplify.yml'), /baseDirectory: frontend/);
});

test('the service worker precaches only files that exist', () => {
  const sw = read('frontend/sw.js');
  const list = /const SHELL = \[([^\]]+)\]/.exec(sw)[1].split(',').map((x) => x.trim().replace(/'/g, ''));
  for (const f of list) {
    if (f === './') continue;
    assert.ok(fs.existsSync(path.join(root, 'frontend', f)), `missing ${f}`);
  }
});
