// Real browser test. Chromium (with a fake camera) loads the real guest page, served under the production
// CSP, talking to the real Lambda handlers backed by in-memory AWS fakes. Run: npm run e2e
// Needs Playwright and Chromium (pre-installed in the Claude Code container).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createGuestHandler } from '../../src/guest.mjs';
import { createHostHandler } from '../../src/host.mjs';
import { codeHash } from '../../src/common.mjs';
import { makeFakeDeps, EVENT_ID } from '../fakes.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const here = path.dirname(fileURLToPath(import.meta.url));
const FRONT = path.resolve(here, '../../../frontend');
const MEDIA = process.env.E2E_MEDIA || path.join(here, 'media'); // make them with ./make-media.sh
const SHOTS = process.env.E2E_SHOTS || path.join(here, 'out');
if (!fs.existsSync(path.join(MEDIA, 'clip20.mp4'))) {
  console.error(`Sample media not found in ${MEDIA}. Run backend/test/browser/make-media.sh first.`);
  process.exit(2);
}
fs.mkdirSync(SHOTS, { recursive: true });

// ---------- server: static files + API + fake S3 ----------
const clock = {
  get t() {
    return Date.now();
  },
};
const f = makeFakeDeps({ clock });
f.helpers.events.get(EVENT_ID).closesAt = new Date(Date.now() + 2 * 86400000).toISOString();
f.helpers.events.get(EVENT_ID).opensAt = new Date(Date.now() - 86400000).toISOString();
const handler = createGuestHandler(f.deps);
const hostHandler = createHostHandler(f.deps);
const chaos = { putFail: 0, apiFailRate: 0, putCalls: 0, apiCalls: 0, down: false, hang: false };
const reqLog = [];
const logReq = (method, p, status) => {
  reqLog.push(`${new Date().toISOString().slice(14, 23)} ${method} ${p} -> ${status}`);
  if (reqLog.length > 60) reqLog.shift();
};
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; font-src 'self'; connect-src 'self' https://cognito-idp.us-west-2.amazonaws.com; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
let PORT = 0;

const ROUTES = [
  ['POST', /^\/api\/guest\/start$/, 'POST /guest/start'],
  ['POST', /^\/api\/guest\/memories$/, 'POST /guest/memories'],
  ['POST', /^\/api\/guest\/optin$/, 'POST /guest/optin'],
  ['POST', /^\/api\/guest\/memories\/([^/]+)\/parts$/, 'POST /guest/memories/{id}/parts'],
  ['POST', /^\/api\/guest\/memories\/([^/]+)\/complete$/, 'POST /guest/memories/{id}/complete'],
  ['DELETE', /^\/api\/guest\/memories\/([^/]+)$/, 'DELETE /guest/memories/{id}'],
];

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks);
  if (chaos.down) {
    req.socket.destroy(); // the network is gone
    return;
  }
  if (chaos.hang) {
    setTimeout(() => req.socket.destroy(), 20000); // a dead cell connection: no answer, no error
    return;
  }

  if (url.pathname === '/s3put' && req.method === 'PUT') {
    chaos.putCalls += 1;
    if (chaos.putFail > 0) {
      chaos.putFail -= 1;
      res.writeHead(500).end();
      return;
    }
    const r = f.helpers.putViaUrl(`fake://put${url.search}`, body);
    res.writeHead(r.status).end();
    return;
  }
  if (url.pathname === '/s3get' && req.method === 'GET') {
    const obj = f.helpers.objects.get(url.searchParams.get('k'));
    if (!obj) {
      res.writeHead(404).end();
      return;
    }
    const k = url.searchParams.get('k');
    const type = k.endsWith('.jpg') ? 'image/jpeg' : k.endsWith('.mp4') ? 'video/mp4' : k.endsWith('.webm') ? 'video/webm' : 'application/octet-stream';
    res.writeHead(200, { 'content-type': type, 'content-length': obj.length }).end(obj);
    return;
  }
  if (url.pathname.startsWith('/api/host/')) {
    const claims = req.headers.authorization === 'Bearer fake-id-token' ? { sub: 'host-user' } : null;
    const HOST = [
      ['GET', /^\/api\/host\/memories$/, () => 'GET /host/memories'],
      ['POST', /^\/api\/host\/memories\/([^/]+)\/(hide|show)$/, (m) => `POST /host/memories/{id}/${m[2]}`],
      ['POST', /^\/api\/host\/code\/rotate$/, () => 'POST /host/code/rotate'],
      ['POST', /^\/api\/host\/window$/, () => 'POST /host/window'],
    ];
    for (const [method, re, key] of HOST) {
      const m = re.exec(url.pathname);
      if (req.method === method && m) {
        const out = await hostHandler({
          routeKey: key(m),
          headers: req.headers,
          body: body.length ? body.toString('utf8') : undefined,
          pathParameters: m[1] ? { id: decodeURIComponent(m[1]) } : undefined,
          requestContext: { http: { sourceIp: '127.0.0.1' }, authorizer: claims ? { jwt: { claims } } : undefined },
        });
        res.writeHead(out.statusCode, { 'content-type': 'application/json' }).end(out.body.replaceAll('fake://get?', `http://127.0.0.1:${PORT}/s3get?`));
        return;
      }
    }
    res.writeHead(404).end('{}');
    return;
  }
  if (url.pathname.startsWith('/api/')) {
    chaos.apiCalls += 1;
    if (chaos.apiFailRate && Math.random() < chaos.apiFailRate) {
      logReq(req.method, url.pathname.replace('/api/guest/', ''), '503 chaos');
      res.writeHead(503, { 'content-type': 'application/json' }).end('{"error":"chaos"}');
      return;
    }
    for (const [method, re, routeKey] of ROUTES) {
      const m = re.exec(url.pathname);
      if (req.method === method && m) {
        const out = await handler({
          routeKey,
          headers: req.headers,
          body: body.length ? body.toString('utf8') : undefined,
          pathParameters: m[1] ? { id: decodeURIComponent(m[1]) } : undefined,
          requestContext: { http: { sourceIp: '127.0.0.1' } },
        });
        logReq(req.method, url.pathname.replace('/api/guest/', ''), out.statusCode);
        const text = out.body.replaceAll('fake://put?', `http://127.0.0.1:${PORT}/s3put?`);
        res.writeHead(out.statusCode, { 'content-type': 'application/json' }).end(text);
        return;
      }
    }
    res.writeHead(404).end('{}');
    return;
  }
  if (url.pathname === '/js/config.js') {
    res.writeHead(200, { 'content-type': 'text/javascript', 'content-security-policy': CSP });
    res.end(`export const CONFIG = { apiUrl: 'http://127.0.0.1:${PORT}/api', region: 'us-west-2', userPoolClientId: 'testclient', honoree: 'Don Manuel' };`);
    return;
  }
  let rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  const file = path.resolve(FRONT, rel);
  if (!file.startsWith(FRONT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404).end('not found');
    return;
  }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'content-security-policy': CSP, 'cache-control': 'no-store' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
PORT = server.address().port;
const BASE = `http://127.0.0.1:${PORT}`;
const LINK = `${BASE}/#e=${EVENT_ID}`;

// ---------- test plumbing ----------
let failures = 0;
const consoleProblems = [];
async function step(name, fn) {
  if (process.env.E2E_ONLY && !name.includes(process.env.E2E_ONLY)) return;
  const t0 = Date.now();
  try {
    await fn();
    console.log(`ok   ${name} (${Date.now() - t0} ms)`);
  } catch (e) {
    failures += 1;
    console.log(`FAIL ${name}\n     ${String(e.message || e).split('\n').slice(0, 6).join('\n     ')}`);
    if (process.env.E2E_DEBUG) {
      console.log('     memories:', mems().map((m) => `${m.kind}:${m.status}:${m.id.slice(0, 9)}`).join(' '));
      console.log('     last requests:\n       ' + reqLog.slice(-25).join('\n       '));
    }
  }
}
const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};
const eq = (a, b, msg) => assert(a === b, `${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);

const browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
async function newGuest({ link = LINK } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, permissions: ['camera', 'microphone'], serviceWorkers: 'allow' });
  const page = await ctx.newPage();
  watch(page);
  if (link) await page.goto(link);
  return { ctx, page };
}
function watch(page) {
  page.on('console', (m) => {
    const txt = m.text();
    if (process.env.E2E_DEBUG && process.env.E2E_ONLY) console.log(`     [console.${m.type()}] ${txt.slice(0, 200)}`);
    if (m.type() === 'error' && !/Failed to load resource/.test(txt)) consoleProblems.push(txt);
    if (/Content Security Policy|Refused to/i.test(txt)) consoleProblems.push(`CSP: ${txt}`);
  });
  page.on('pageerror', (e) => consoleProblems.push(`pageerror: ${e.message}`));
}
// Offline is simulated twice: Chromium's emulation (which can leak when a service worker is involved)
// and a server that drops every connection, so the result is deterministic.
async function goOffline(ctx, page) {
  chaos.down = true;
  await ctx.setOffline(true);
  if (page) await page.evaluate(() => window.dispatchEvent(new Event('offline')));
}
async function goOnline(ctx, page) {
  chaos.down = false;
  await ctx.setOffline(false);
  if (page) await page.evaluate(() => window.dispatchEvent(new Event('online')));
}
const visible = (page, sel) => page.locator(sel).first().isVisible();
async function screenIs(page, name) {
  await page.waitForSelector(`[data-screen="${name}"]:not([hidden])`, { timeout: 8000 });
}
async function until(pred, timeout, what) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
}
// Waits until the server really holds n complete memories, then for the tray to agree.
async function arrived(page, n, timeout = 30000) {
  await until(() => mems().filter((m) => m.status === 'complete').length >= n, timeout, `${n} complete memories on the server (have ${mems().filter((m) => m.status === 'complete').length})`);
  await allSent(page, timeout);
}
async function allSent(page, timeout = 30000) {
  await page.waitForFunction(() => document.querySelector('#traySum') && document.querySelector('#tray') && !document.querySelector('#tray').hidden && document.querySelector('#traySum').textContent === 'All sent', null, { timeout });
}
async function unlock(page, code = '1966') {
  await screenIs(page, 'gate');
  await page.fill('#gateCode', code);
  // 4 digits auto-submit
}
async function toHome(page, name = 'Ana Lopez') {
  await unlock(page);
  await screenIs(page, 'home');
  await page.fill('#who', name);
}
const mems = () => [...f.helpers.mem.values()];
const keyOf = (m, file) => `events/${EVENT_ID}/${m.id}/${file}`;
function jpegSize(buf) {
  let i = 2;
  while (i < buf.length) {
    if (buf[i] !== 0xff) return null;
    const mk = buf[i + 1];
    const len = buf.readUInt16BE(i + 2);
    if (mk === 0xc0 || mk === 0xc2) return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
    i += 2 + len;
  }
  return null;
}
async function note(page, text) {
  await page.click('[data-screen="home"] [data-go="note"]');
  await screenIs(page, 'note');
  await page.fill('#note', text);
  await page.click('#saveNote');
  await screenIs(page, 'done');
}
const media = (n) => path.join(MEDIA, n);

// ---------- scenarios ----------
let main;

await step('link without an event id shows the incomplete link page', async () => {
  const g = await newGuest({ link: BASE + '/' });
  await screenIs(g.page, 'badlink');
  await g.ctx.close();
});

await step('wrong code is refused, right code opens the book (and the page is Spanish capable)', async () => {
  main = await newGuest();
  const p = main.page;
  await screenIs(p, 'gate');
  await p.screenshot({ path: path.join(SHOTS, '01-gate.png') });
  await p.fill('#gateCode', '0000');
  await p.waitForSelector('#gateErr:not([hidden])');
  assert((await p.textContent('#gateErr')).includes('not right'), 'error text');
  await p.fill('#gateCode', '1966');
  await screenIs(p, 'home');
  eq(await p.evaluate(() => location.hash), '', 'fragment is cleared from the address bar');
  await p.fill('#who', 'Ana Lopez');
  await p.screenshot({ path: path.join(SHOTS, '02-home.png') });
  await p.click('#langBtn');
  assert((await p.textContent('[data-screen="home"] h1')).includes('Los 60 de Don Manuel'), 'spanish title');
  await p.screenshot({ path: path.join(SHOTS, '03-home-es.png') });
  await p.click('#langBtn');
});

await step('name is required before any memory screen', async () => {
  const p = main.page;
  await p.fill('#who', '');
  await p.click('[data-screen="home"] [data-go="note"]');
  await p.waitForSelector('#nameErr:not([hidden])');
  await p.fill('#who', 'Ana Lopez');
});

await step('note: saved, sent, stored on the server', async () => {
  const p = main.page;
  await note(p, 'Feliz cumpleaños Don Manuel, gracias por todo.');
  await arrived(p, 1);
  const m = mems().find((x) => x.kind === 'note');
  assert(m, 'note on server');
  eq(m.name, 'Ana Lopez', 'name');
  assert(m.text.includes('gracias por todo'), 'text');
  eq(m.status, 'complete', 'status');
  await p.screenshot({ path: path.join(SHOTS, '04-done.png') });
});

await step('photo: rotated 12 MP original is shrunk to 2048 px, upright, EXIF removed', async () => {
  const p = main.page;
  await p.click('[data-screen="done"] [data-go="home"]');
  await screenIs(p, 'home');
  await p.fill('#who', 'Ana Lopez');
  await p.click('[data-screen="home"] [data-go="photo"]');
  await screenIs(p, 'photo');
  await p.setInputFiles('#photoIn', media('photo-rotated.jpg'));
  await p.waitForSelector('#savePhoto:not([disabled])', { timeout: 15000 });
  await p.fill('#photoCap', 'En el lago');
  await p.screenshot({ path: path.join(SHOTS, '05-photo.png') });
  await p.click('#savePhoto');
  await screenIs(p, 'done');
  await arrived(p, 2);
  const m = mems().find((x) => x.kind === 'photo');
  assert(m, 'photo on server');
  eq(m.caption, 'En el lago', 'caption');
  const buf = f.helpers.objects.get(keyOf(m, 'original.jpg'));
  assert(buf && buf[0] === 0xff && buf[1] === 0xd8, 'is a jpeg');
  const dim = jpegSize(buf);
  assert(dim && dim.w === 1536 && dim.h === 2048, `dimensions ${JSON.stringify(dim)} should be 1536x2048 (upright)`);
  assert(buf.length < 1.6 * 1048576, `size ${buf.length}`);
  assert(!buf.includes(Buffer.from('Exif')), 'EXIF stripped');
  const th = f.helpers.objects.get(keyOf(m, 'thumb.jpg'));
  assert(th && th.length > 500 && th.length <= 60000, 'thumbnail stored');
});

await step('library video 20 s: first two S3 PUTs fail with 500, the engine retries and it arrives intact', async () => {
  const p = main.page;
  await p.click('[data-screen="done"] [data-go="home"]');
  await p.fill('#who', 'Ana Lopez');
  await p.click('[data-screen="home"] [data-go="video"]');
  await screenIs(p, 'video');
  await p.setInputFiles('#videoIn', media('clip20.mp4'));
  await p.waitForSelector('#vReview:not([hidden])', { timeout: 15000 });
  const info = await p.textContent('#videoInfo');
  assert(/0:20/.test(info), `info shows duration: ${info}`);
  await p.screenshot({ path: path.join(SHOTS, '06-video-review.png') });
  chaos.putFail = 2;
  await p.click('#saveVideo');
  await screenIs(p, 'done');
  await arrived(p, 3, 60000);
  const m = mems().find((x) => x.kind === 'video' && x.contentType === 'video/mp4');
  assert(m, 'video on server');
  const buf = f.helpers.objects.get(keyOf(m, 'original.mp4'));
  eq(buf.length, fs.statSync(media('clip20.mp4')).size, 'size');
  assert(buf.equals(fs.readFileSync(media('clip20.mp4'))), 'bytes identical to the original');
  eq(m.durationSec, 20, 'duration');
  assert(chaos.putCalls >= 3, 'retries happened');
});

await step('library video refusals: too long, not a real video', async () => {
  const p = main.page;
  await p.click('[data-screen="done"] [data-go="home"]');
  await p.fill('#who', 'Ana Lopez');
  await p.click('[data-screen="home"] [data-go="video"]');
  await screenIs(p, 'video');
  await p.setInputFiles('#videoIn', media('long75.mp4'));
  await p.waitForSelector('#videoErr:not([hidden])', { timeout: 15000 });
  assert((await p.textContent('#videoErr')).includes('60 seconds'), 'long message');
  await p.setInputFiles('#videoIn', media('notvideo.mp4'));
  await p.waitForFunction(() => /could not be read/.test(document.querySelector('#videoErr').textContent), null, { timeout: 15000 });
  assert(!(await visible(p, '#vReview')), 'no review pane for a bad file');
});

await step('record in the page (fake camera): record 3 s, review, send', async () => {
  const p = main.page;
  await p.click('[data-screen="video"] #videoBack');
  await screenIs(p, 'home');
  await p.fill('#who', 'Ana Lopez');
  await p.click('[data-screen="home"] [data-go="video"]');
  await screenIs(p, 'video');
  await p.click('#vRecord');
  await p.waitForSelector('#vLive:not([hidden])');
  await p.waitForFunction(() => document.querySelector('#vidLive').videoWidth > 0, null, { timeout: 10000 });
  await p.screenshot({ path: path.join(SHOTS, '07-live.png') });
  await p.click('#recStart');
  await p.waitForSelector('#recStop:not([hidden])');
  await p.waitForTimeout(3500);
  const t = await p.textContent('#recTime');
  assert(/0:0[2-4] of 1:00/.test(t), `timer text ${t}`);
  await p.click('#recStop');
  await p.waitForSelector('#vReview:not([hidden])', { timeout: 15000 });
  await p.click('#saveVideo');
  await screenIs(p, 'done');
  await arrived(p, 4, 60000);
  const m = mems().find((x) => x.kind === 'video' && /webm|mp4/.test(x.contentType) && x.durationSec >= 3 && x.durationSec <= 5);
  assert(m, `recorded video on server: ${JSON.stringify(mems().map((x) => [x.kind, x.contentType, x.durationSec]))}`);
  const ext = m.contentType === 'video/webm' ? 'webm' : 'mp4';
  const buf = f.helpers.objects.get(keyOf(m, `original.${ext}`));
  assert(buf && buf.length > 5000, 'recorded bytes arrived');
  if (ext === 'webm') assert(buf.readUInt32BE(0) === 0x1a45dfa3, 'webm header');
  fs.writeFileSync(path.join(SHOTS, `recorded.${ext}`), buf);
});

await step('offline: note and photo wait safely, then send when the signal returns', async () => {
  const p = main.page;
  const before = mems().length;
  await p.click('[data-screen="done"] [data-go="home"]');
  await p.fill('#who', 'Ana Lopez');
  await goOffline(main.ctx, p);
  await note(p, 'Escrito sin señal.');
  await p.waitForFunction(() => /Waiting for signal/.test(document.querySelector('#traySum').textContent), null, { timeout: 15000 });
  eq(await p.textContent('#trayPill'), 'Offline', 'pill');
  await p.screenshot({ path: path.join(SHOTS, '08-offline.png') });
  eq(mems().length, before, 'nothing reached the server while offline');
  await goOnline(main.ctx, p);
  await arrived(p, 5, 45000);
  eq(mems().length, before + 1, 'arrived after reconnect');
});

await step('flaky API (35% of calls fail): a photo and a note still arrive exactly once', async () => {
  const p = main.page;
  const before = mems().length;
  chaos.apiFailRate = 0.35;
  await p.click('[data-screen="done"] [data-go="home"]');
  await p.fill('#who', 'Ana Lopez');
  await p.click('[data-screen="home"] [data-go="photo"]');
  await screenIs(p, 'photo');
  await p.setInputFiles('#photoIn', media('photo-rotated.jpg'));
  await p.waitForSelector('#savePhoto:not([disabled])', { timeout: 15000 });
  await p.click('#savePhoto');
  await screenIs(p, 'done');
  await p.click('[data-screen="done"] [data-go="home"]');
  await p.fill('#who', 'Ana Lopez');
  await note(p, 'Con señal mala.');
  await arrived(p, 7, 90000);
  chaos.apiFailRate = 0;
  eq(mems().length, before + 2, 'exactly two new memories, no duplicates');
  assert(mems().every((m) => m.status === 'complete'), 'all complete');
});

await step('reload while offline: the queue survives in IndexedDB and finishes later', async () => {
  const before = mems().length;
  const p = main.page;
  await goOffline(main.ctx, p);
  await p.click('[data-screen="done"] [data-go="home"]');
  await p.fill('#who', 'Ana Lopez');
  await p.click('[data-screen="home"] [data-go="photo"]');
  await screenIs(p, 'photo');
  await p.setInputFiles('#photoIn', media('photo-rotated.jpg'));
  await p.waitForSelector('#savePhoto:not([disabled])', { timeout: 15000 });
  await p.click('#savePhoto');
  await screenIs(p, 'done');
  await p.close(); // the guest closes the tab
  eq(mems().length, before, 'not sent yet');
  const p2 = await main.ctx.newPage();
  watch(p2);
  await goOnline(main.ctx, null);
  await p2.goto(BASE + '/'); // reopened with no fragment: link and session come from the phone
  await screenIs(p2, 'home');
  await arrived(p2, 8, 45000);
  eq(mems().length, before + 1, 'queued photo sent after reopening');
  main.page = p2;
});

await step('the party code changes mid-party: the page asks again and keeps going', async () => {
  const p = main.page;
  const ev = f.helpers.events.get(EVENT_ID);
  ev.codeHash = codeHash(EVENT_ID, '2468');
  ev.codeVersion = 2;
  const before = mems().length;
  await p.fill('#who', 'Ana Lopez');
  await note(p, 'Después de cambiar el código.');
  await p.waitForSelector('#auth:not([hidden])', { timeout: 15000 });
  await p.screenshot({ path: path.join(SHOTS, '09-auth.png') });
  await p.fill('#authCode', '1111');
  await p.waitForSelector('#authErr:not([hidden])');
  await p.fill('#authCode', '2468');
  await arrived(p, 9, 30000);
  eq(mems().length, before + 1, 'note arrived with the new code');
  assert(!(await visible(p, '#auth')), 'overlay closed');
});

await step('tray shows every item and the thanks page says all sent', async () => {
  const p = main.page;
  await p.click('#trayBtn');
  const n = await p.locator('#trayList li').count();
  assert(n >= 8, `tray has ${n} items`);
  await p.screenshot({ path: path.join(SHOTS, '10-tray.png') });
  // With the tray open the page must still scroll far enough to reach the buttons under it.
  await p.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  assert(await p.locator('[data-screen="done"] [data-go="thanks"]').isVisible(), 'button visible');
  const box = await p.locator('[data-screen="done"] [data-go="thanks"]').boundingBox();
  const trayTop = (await p.locator('#tray .tray-in').boundingBox()).y;
  assert(box.y + box.height <= trayTop + 1, `button (${box.y + box.height}) is covered by the tray (top ${trayTop})`);
  await p.click('[data-screen="done"] [data-go="thanks"]');
  await screenIs(p, 'thanks');
  assert((await p.textContent('#thanksTitle')).includes('Ana Lopez'), 'thanks name');
  assert((await p.textContent('#thanksSub')).includes('in the book'), 'thanks text');
});

await step('book sign-up: checks name, email and consent, saves once, survives a reload, can be removed', async () => {
  const p = main.page;
  await p.click('#thanksBook');
  await screenIs(p, 'book');
  eq(await p.inputValue('#bookName'), 'Ana Lopez', 'name carried over');
  await p.fill('#bookEmail', 'ana@example');
  await p.click('#bookGo');
  eq(await p.getAttribute('#bookErr', 'data-key'), 'book.errEmail', 'bad email caught');
  await p.fill('#bookEmail', 'Ana.Lopez@Example.com');
  await p.click('#bookGo');
  eq(await p.getAttribute('#bookErr', 'data-key'), 'book.errConsent', 'consent required');
  await p.check('#bookOk');
  await p.click('#bookGo');
  await p.waitForSelector('#bookDone:not([hidden])');
  assert((await p.textContent('#bookDoneMsg')).includes('ana.lopez@example.com'), 'confirmation shows the email');
  eq(f.helpers.optIns.size, 1, 'one sign-up on the server');
  await p.screenshot({ path: path.join(SHOTS, '10b-book.png') });
  await p.reload();
  await screenIs(p, 'home');
  await p.click('[data-screen="home"] [data-go="book"]');
  await p.waitForSelector('#bookDone:not([hidden])');
  await p.click('#bookRemove');
  await p.waitForSelector('#bookForm:not([hidden])');
  eq(f.helpers.optIns.size, 0, 'removed on the server');
  await p.fill('#bookEmail', 'ana.lopez@example.com');
  await p.check('#bookOk');
  await p.click('#bookGo');
  await p.waitForSelector('#bookDone:not([hidden])');
  eq(f.helpers.optIns.size, 1, 'signed up again');
  await p.click('#langBtn');
  assert((await p.textContent('#bookDoneMsg')).includes('Ya estás en la lista'), 'Spanish confirmation');
  await p.click('#langBtn');
});

await step('page opens with no signal at all (service worker serves the cached shell)', async () => {
  chaos.down = false;
  const ev = f.helpers.events.get(EVENT_ID);
  ev.codeHash = codeHash(EVENT_ID, '1966'); // earlier steps changed the party code
  ev.codeVersion = 3;
  const g = await newGuest({ link: null });
  const p = g.page;
  await p.goto(LINK);
  await unlock(p);
  await screenIs(p, 'home');
  // wait for the worker to install, precache and take control
  await p.evaluate(async () => { await navigator.serviceWorker.ready; });
  await p.reload();
  await p.waitForFunction(() => navigator.serviceWorker.controller !== null, null, { timeout: 8000 });
  await until(async () => (await p.evaluate(async () => (await caches.keys()).length)) > 0, 8000, 'cache created');
  await goOffline(g.ctx, p);
  const tReload = Date.now();
  await p.reload({ waitUntil: 'domcontentloaded' });
  if (process.env.E2E_DEBUG && false) {
    await p.waitForTimeout(2500);
    console.log('     debug:', JSON.stringify(await p.evaluate(() => ({ title: document.title, screens: [...document.querySelectorAll('[data-screen]:not([hidden])')].map((e) => e.dataset.screen), body: document.body.innerText.slice(0, 120), ctl: !!navigator.serviceWorker.controller }))));
  }
  await screenIs(p, 'home'); // link and session come from the phone, the shell from the cache
  const offlineLoadMs = Date.now() - tReload;
  console.log(`     offline reload to home screen: ${offlineLoadMs} ms`);
  assert(offlineLoadMs < 3000, `page took ${offlineLoadMs} ms to open with no signal`);
  assert((await p.textContent('[data-screen="home"] h1')).includes("Don Manuel's 60th"), 'title rendered offline');
  // A connection that hangs (the usual weak signal failure) must not make the page slow either.
  await goOnline(g.ctx, p);
  chaos.hang = true;
  let hangMs;
  try {
    const tHang = Date.now();
    await p.reload({ waitUntil: 'domcontentloaded' });
    await screenIs(p, 'home');
    hangMs = Date.now() - tHang;
  } finally {
    chaos.hang = false;
  }
  console.log(`     reload with a hanging connection: ${hangMs} ms`);
  assert(hangMs < 5000, `page took ${hangMs} ms to open on a hanging connection`);
  await goOffline(g.ctx, p);
  await p.fill('#who', 'Ana Lopez');
  await note(p, 'Escrita con el avión encendido.');
  await p.waitForFunction(() => /Waiting for signal/.test(document.querySelector('#traySum').textContent), null, { timeout: 15000 });
  await goOnline(g.ctx, p);
  await p.waitForFunction(() => document.querySelector('#traySum').textContent === 'All sent', null, { timeout: 30000 });
  await g.ctx.close();
});

const cognitoCalls = { signIn: 0, refresh: 0 };
// OpenCV when python3 has it (the Claude Code container), otherwise jsQR with sharp (Windows).
async function decodeQr(file) {
  try {
    return execFileSync('python3', ['-I', '-c', 'import cv2,sys\nimg=cv2.imread(sys.argv[1])\nval,pts,_=cv2.QRCodeDetector().detectAndDecode(img)\nprint(val)', file], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch (e) {
    const sharp = require('sharp');
    const jsQR = require('jsqr');
    const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const r = jsQR(new Uint8ClampedArray(data), info.width, info.height);
    return r ? r.data : '';
  }
}

async function cognitoMock(ctx) {
  await ctx.route('https://cognito-idp.us-west-2.amazonaws.com/', async (route) => {
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST, OPTIONS' };
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const body = JSON.parse(req.postData() || '{}');
    if (body.AuthFlow === 'REFRESH_TOKEN_AUTH') {
      cognitoCalls.refresh += 1;
      return route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/x-amz-json-1.1' }, body: JSON.stringify({ AuthenticationResult: { IdToken: 'fake-id-token', ExpiresIn: 3600 } }) });
    }
    cognitoCalls.signIn += 1;
    if (body.AuthParameters && body.AuthParameters.PASSWORD === 'correct horse battery staple') {
      return route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/x-amz-json-1.1' }, body: JSON.stringify({ AuthenticationResult: { IdToken: 'fake-id-token', RefreshToken: 'fake-refresh', ExpiresIn: 3600 } }) });
    }
    return route.fulfill({ status: 400, headers: { ...cors, 'content-type': 'application/x-amz-json-1.1' }, body: JSON.stringify({ __type: 'NotAuthorizedException', message: 'Incorrect username or password.' }) });
  });
}

await step('host: sign in, list with thumbnails, hide and show, refresh token, change code, extend window', async () => {
  const ctx = await browser.newContext({ viewport: { width: 700, height: 1100 }, deviceScaleFactor: 1, acceptDownloads: true });
  await cognitoMock(ctx);
  const page = await ctx.newPage();
  watch(page);
  await page.goto(`${BASE}/host.html`);
  await page.fill('#email', 'jon@aegironsecurity.com');
  await page.fill('#password', 'wrong');
  await page.click('#signinGo');
  await page.waitForSelector('#signinErr:not([hidden])');
  assert((await page.textContent('#signinErr')).includes('not right'), 'bad login text');
  await page.fill('#password', 'correct horse battery staple');
  await page.click('#signinGo');
  await page.waitForSelector('#dash:not([hidden])');
  const total = mems().length;
  await page.waitForFunction((n) => document.querySelectorAll('#rows li').length === n, total, { timeout: 8000 });
  assert((await page.textContent('#hStats')).startsWith(`${total} in the book`), `stats: ${await page.textContent('#hStats')}`);
  assert((await page.textContent('#hWindow')).startsWith('Open until'), 'window text');
  await page.waitForFunction(() => { const im = [...document.querySelectorAll('#rows img')]; return im.length > 0 && im.every((i) => i.complete && i.naturalWidth > 0); }, null, { timeout: 8000 });
  await page.screenshot({ path: path.join(SHOTS, '11-host.png'), fullPage: false });

  // hide then show the newest row
  const firstId = await page.locator('#rows li').first().getAttribute('data-id');
  await page.click(`[data-hide="${firstId}"]`);
  await until(() => f.helpers.mem.get(`${EVENT_ID}|${firstId}`).hidden === true, 5000, 'hidden on server');
  await page.waitForFunction(() => /1 hidden/.test(document.querySelector('#hStats').textContent));
  await page.click(`[data-hide="${firstId}"]`);
  await until(() => f.helpers.mem.get(`${EVENT_ID}|${firstId}`).hidden === false, 5000, 'shown on server');

  // a stale token is refreshed on reload
  await page.evaluate(() => { const t = JSON.parse(sessionStorage.getItem('mbh.t')); t.expiresAt = 1; sessionStorage.setItem('mbh.t', JSON.stringify(t)); });
  await page.reload();
  await page.waitForFunction((n) => document.querySelectorAll('#rows li').length === n, total, { timeout: 8000 });
  assert(cognitoCalls.refresh >= 1, 'token refreshed');

  // code
  const v0 = f.helpers.events.get(EVENT_ID).codeVersion;
  await page.fill('#newCode', '5555');
  await page.click('#rotate');
  await page.waitForFunction(() => /5555/.test(document.querySelector('#rotateMsg').textContent));
  eq(f.helpers.events.get(EVENT_ID).codeVersion, v0 + 1, 'code version');
  eq(await page.inputValue('#cardCode'), '5555', 'card code field');
  eq((await page.textContent('#cardPreview .c-code')).trim(), '5555', 'card shows the code');

  // window
  const c0 = Date.parse(f.helpers.events.get(EVENT_ID).closesAt);
  await page.click('[data-extend="24"]');
  await until(() => Date.parse(f.helpers.events.get(EVENT_ID).closesAt) > c0, 5000, 'window extended');
  await page.click('#closeNow');
  assert((await page.textContent('#closeNow')).includes('again'), 'close needs a second tap');

  // the printed QR code really decodes to the guest link
  await page.locator('#cardPreview .card').screenshot({ path: path.join(SHOTS, '12-card.png') });
  const decoded = await decodeQr(path.join(SHOTS, '12-card.png'));
  eq(decoded, `${BASE}/#e=${EVENT_ID}`, 'QR decodes to the guest link');

  // print sheet has six cards
  await page.evaluate(() => { window.print = () => { window.__printed = true; }; });
  await page.click('#printCards');
  eq(await page.locator('#sheet .card').count(), 6, 'six cards');
  assert(await page.evaluate(() => window.__printed === true), 'print called');

  // book sign-ups
  await page.click('#refresh');
  await page.waitForFunction(() => document.querySelectorAll('#optins li').length === 1, null, { timeout: 8000 });
  eq((await page.textContent('#optStats')).trim(), '1 guest wants the book', 'sign-up count');
  const [csvDl] = await Promise.all([page.waitForEvent('download'), page.click('#exportCsv')]);
  const stamp = [...f.helpers.optIns.values()][0].updatedAt;
  eq(fs.readFileSync(await csvDl.path(), 'utf8'), '"name","email","signed_up"\r\n"Ana Lopez","ana.lopez@example.com","' + stamp + '"\r\n', 'CSV export');

  // JSON export
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#exportJson')]);
  const json = JSON.parse(fs.readFileSync(await dl.path(), 'utf8'));
  eq(json.memories.length, total, 'exported rows');
  eq(json.optIns.length, 1, 'exported sign-ups');
  assert(json.memories.every((m) => m.kind === 'note' || /^events\//.test(m.file)), 'file keys present');

  await page.click('#signOut');
  await page.waitForSelector('#signin:not([hidden])');
  eq(await page.evaluate(() => sessionStorage.getItem('mbh.t')), null, 'tokens cleared');
  await ctx.close();
});

await step('host API refuses a call without a token', async () => {
  const r = await fetch(`${BASE}/api/host/memories`);
  eq(r.status, 401, 'status');
});

await step('after closing time a new guest sees the closed page and cannot start', async () => {
  const ev = f.helpers.events.get(EVENT_ID);
  ev.codeHash = codeHash(EVENT_ID, '1966');
  ev.codeVersion = 3;
  ev.closesAt = new Date(Date.now() - 10 * 3600 * 1000).toISOString(); // past close and past the 6 hour grace
  const g = await newGuest();
  await screenIs(g.page, 'gate');
  await g.page.fill('#gateCode', '1966');
  await screenIs(g.page, 'closed');
  await g.ctx.close();
});

await step('no console errors, no CSP violations anywhere', async () => {
  assert(consoleProblems.length === 0, consoleProblems.slice(0, 5).join('\n'));
});

await browser.close();
server.close();
console.log(failures ? `\n${failures} step(s) failed` : '\nAll browser steps passed');
console.log(`screenshots in ${SHOTS}`);
process.exit(failures ? 1 : 0);
