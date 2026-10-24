// Guest page: gate, memory forms, the upload tray and the wiring to the upload engine.
import { CONFIG } from './config.js';
import { createUploader } from './uploader.js';
import { createApi } from './api.js';
import { createStore } from './idb.js';
import { putPart } from './net.js';
import { newMemoryId, newGuestId } from './ids.js';
import { t, setLang, getLang, setVars, detectLang, applyDom } from './i18n.js';
import { LIMITS, fmtBytes, mmss, videoTypeFor, videoVerdict, parseEventId, cleanName } from './policy.js';
import { preparePhoto, probeVideo, canRecord, createRecorder } from './media.js';
import { h } from './dom.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

const ls = {
  get(k) {
    try {
      return localStorage.getItem(k);
    } catch (e) {
      return null;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, v);
    } catch (e) {
      /* private mode: carry on without it */
    }
  },
};

const ICONS = {
  pen: '<path d="M4 20h4L18.5 9.5a2.1 2.1 0 0 0-3-3L5 17v3z"/><path d="M13.5 8.5l3 3"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="M3 17l5-5 4 4 3-3 6 6"/>',
  video: '<rect x="3" y="6" width="13" height="12" rx="2"/><path d="M16 10l5-3v10l-5-3"/>',
  arrow: '<path d="M9 6l6 6-6 6"/>',
  back: '<path d="M15 6l-6 6 6 6"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5" stroke-width="2.6"/>',
};
function renderIcons(root) {
  $$('[data-icon]', root).forEach((el) => {
    const size = el.classList.contains('seal') ? 46 : 24;
    el.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[el.getAttribute('data-icon')]}</svg>`;
  });
}

const S = {
  eventId: null,
  guestId: null,
  session: null,
  screen: null,
  name: '',
  pend: null,
  lastAt: 0,
  trayOpen: false,
  online: typeof navigator.onLine === 'boolean' ? navigator.onLine : true,
  snap: [],
  authPromise: null,
  authDone: null,
  recorder: null,
  facing: 'user',
  busy: false,
};

const store = createStore();
const api = createApi({ base: CONFIG.apiUrl, getToken: () => (S.session ? S.session.token : null) });

/* ---------- session and gate ---------- */

function loadSession() {
  try {
    const s = JSON.parse(ls.get('mb.s') || 'null');
    if (s && typeof s.token === 'string' && s.exp > Date.now() + 60000) return s;
  } catch (e) {
    /* ignore */
  }
  return null;
}

async function submitCode(code) {
  const r = await api.start(S.eventId, code, S.guestId);
  S.session = { token: r.token, exp: r.exp };
  ls.set('mb.s', JSON.stringify(S.session));
  if (r.guestOfHonor) {
    ls.set('mb.h', r.guestOfHonor);
    setVars({ who: r.guestOfHonor });
    applyAll();
  }
  return r;
}

function codeErrorKey(e) {
  switch (e.code) {
    case 'bad_code':
      return 'err.badCode';
    case 'too_many':
      return 'err.tooMany';
    case 'closed':
      return 'err.closed';
    case 'not_open':
      return 'err.notOpen';
    default:
      return e.status === 0 ? 'err.network' : 'err.generic';
  }
}

function showErr(el, key) {
  el.textContent = t(key);
  el.setAttribute('data-key', key);
  el.hidden = false;
}
function hideErr(el) {
  el.hidden = true;
  el.removeAttribute('data-key');
}

function wireCodeInput(input) {
  input.addEventListener('input', () => {
    const v = input.value.replace(/\D/g, '').slice(0, 4);
    if (v !== input.value) input.value = v;
  });
}

async function onGateSubmit(ev) {
  ev.preventDefault();
  const input = $('#gateCode');
  const err = $('#gateErr');
  if (S.busy) return;
  if (!/^\d{4}$/.test(input.value)) {
    showErr(err, 'err.codeShort');
    return;
  }
  S.busy = true;
  hideErr(err);
  $('#gateGo').disabled = true;
  $('#gateGo').textContent = t('gate.checking');
  try {
    await submitCode(input.value);
    input.value = '';
    go('home');
    uploader.kick();
  } catch (e) {
    if (e.code === 'bad_link') go('badlink');
    else if (e.code === 'closed') go('closed');
    else showErr(err, codeErrorKey(e));
  } finally {
    S.busy = false;
    $('#gateGo').disabled = false;
    $('#gateGo').textContent = t('gate.go');
  }
}

// The upload engine calls this when the server says the code changed or the session ran out.
function askCode() {
  if (S.authPromise) return S.authPromise;
  const p = new Promise((resolve, reject) => {
    S.authDone = { resolve, reject };
  });
  const finish = () => {
    S.authPromise = null;
    S.authDone = null;
    $('#auth').hidden = true;
  };
  p.then(finish, finish);
  S.authPromise = p;
  $('#authCode').value = '';
  hideErr($('#authErr'));
  $('#auth').hidden = false;
  $('#authCode').focus();
  return p;
}

async function onAuthSubmit(ev) {
  ev.preventDefault();
  const input = $('#authCode');
  const err = $('#authErr');
  if (S.busy || !S.authDone) return;
  if (!/^\d{4}$/.test(input.value)) {
    showErr(err, 'err.codeShort');
    return;
  }
  S.busy = true;
  hideErr(err);
  try {
    await submitCode(input.value);
    S.authDone.resolve();
  } catch (e) {
    if (e.code === 'closed' || e.code === 'bad_link') S.authDone.reject(e);
    else showErr(err, codeErrorKey(e));
  } finally {
    S.busy = false;
  }
}

/* ---------- navigation ---------- */

function go(name) {
  S.screen = name;
  $$('[data-screen]').forEach((el) => {
    el.hidden = el.getAttribute('data-screen') !== name;
  });
  if (name === 'home') {
    resetForms();
    $('#who').value = S.name;
  }
  window.scrollTo(0, 0);
  const head = $(`[data-screen="${name}"] h1, [data-screen="${name}"] h2`);
  if (head) head.focus({ preventScroll: true });
  renderAll();
}

function needName() {
  const v = cleanName($('#who').value);
  if (!v) {
    $('#nameErr').hidden = false;
    $('#who').focus();
    return false;
  }
  S.name = v;
  ls.set('mb.n', v);
  $('#nameErr').hidden = true;
  return true;
}

/* ---------- rendering ---------- */

function applyAll() {
  applyDom();
  document.title = t('gate.title');
  $$('[data-key]').forEach((el) => {
    el.textContent = t(el.getAttribute('data-key'));
  });
}

let renderTimer = null;
function scheduleRender() {
  if (renderTimer) return;
  renderTimer = setTimeout(() => {
    renderTimer = null;
    renderAll();
  }, 150);
}

function renderAll() {
  renderHomeCount();
  renderTray();
  renderDone();
  renderPhotoInfo();
  renderVideoInfo();
  syncWakeLock();
}

const kindLabel = (k) => t(`item.${k}`);
const isActive = (it) => it.status === 'queued';
const isWaiting = (it) => isActive(it) && (it.phase === 'waiting' || !S.online);

function pctOf(it) {
  if (it.status === 'done') return 100;
  if (it.kind === 'note') return it.phase === 'creating' ? 40 : 6;
  if (!it.sizeBytes) return 0;
  return Math.min(99, Math.round((it.sentBytes / it.sizeBytes) * 100));
}

function detailOf(it) {
  if (it.status === 'done') return { text: t('item.done', { size: it.kind === 'note' ? '' : fmtBytes(it.sizeBytes) }).trim(), bad: false };
  if (it.status === 'failed') {
    const key = `fail.${it.failReason}`;
    const known = ['closed', 'limit_reached', 'bad_file', 'lost_file'].includes(it.failReason);
    return { text: known ? t(key) : t('fail.other'), bad: true };
  }
  if (it.phase === 'auth') return { text: t('item.auth'), bad: false };
  if (isWaiting(it)) return { text: t('item.waiting'), bad: false };
  if (it.phase === 'creating') return { text: t('item.creating'), bad: false };
  if (it.phase === 'uploading' && it.partsTotal) {
    const a = Math.min(it.partsTotal, it.partsDone + 1);
    return { text: t('item.uploading', { a, b: it.partsTotal, sent: fmtBytes(it.sentBytes), total: fmtBytes(it.sizeBytes) }), bad: false };
  }
  return { text: t('item.saved'), bad: false };
}

function stateWord(it) {
  if (it.status === 'done') return t('item.sent');
  if (it.status === 'failed') return '!';
  if (isWaiting(it)) return '...';
  return `${pctOf(it)}%`;
}

function cardEl(it, withActions) {
  const d = detailOf(it);
  const fill = h('i');
  fill.style.width = `${pctOf(it)}%`;
  const kids = [
    h('div', { class: 'q-top' }, h('span', null, t('item.from', { kind: kindLabel(it.kind), name: it.name })), h('span', null, stateWord(it))),
    h('div', { class: `meter${it.status === 'done' ? ' ok' : ''}` }, fill),
    h('div', { class: `q-detail${d.bad ? ' bad' : ''}` }, d.text),
  ];
  if (withActions && it.status === 'failed') {
    const retryable = it.failReason !== 'closed' && it.failReason !== 'limit_reached' && it.failReason !== 'bad_file' && it.failReason !== 'lost_file';
    kids.push(
      h(
        'div',
        { class: 'q-actions' },
        retryable ? h('button', { class: 'mini', type: 'button', 'data-act': 'retry', 'data-id': it.id }, t('item.retry')) : null,
        h('button', { class: 'mini', type: 'button', 'data-act': 'discard', 'data-id': it.id }, t('item.discard')),
      ),
    );
  }
  return kids;
}

function renderHomeCount() {
  const n = S.snap.filter((x) => x.status !== 'failed').length;
  const el = $('#addedCount');
  el.hidden = n === 0;
  if (n) el.textContent = t('home.added', { n });
}

function renderTray() {
  const mine = S.snap;
  const tray = $('#tray');
  const hideTray = mine.length === 0 || S.screen === 'gate' || S.screen === 'badlink' || !S.screen;
  tray.hidden = hideTray;
  if (hideTray) {
    syncPad();
    return;
  }
  const done = mine.filter((x) => x.status === 'done').length;
  const failed = mine.filter((x) => x.status === 'failed').length;
  const active = mine.filter(isActive).length;
  const waiting = mine.some(isWaiting);
  let sum;
  if (active === 0 && failed === 0) sum = t('tray.all');
  else if (active === 0) sum = t('tray.failed', { n: failed });
  else if (waiting) sum = t('tray.waiting');
  else sum = t('tray.progress', { n: done, m: mine.length - failed });
  $('#traySum').textContent = sum;
  const avg = mine.reduce((a, x) => a + pctOf(x), 0) / mine.length;
  $('#trayFill').style.width = `${Math.round(avg)}%`;
  $('#trayMeter').className = `meter${active === 0 && failed === 0 ? ' ok' : ''}`;
  $('#trayNote').textContent = active > 0 ? t('tray.keepOpen') : '';
  const pill = $('#trayPill');
  if (!S.online) {
    pill.textContent = t('tray.offline');
    pill.setAttribute('data-s', 'off');
  } else if (waiting) {
    pill.textContent = t('tray.weak');
    pill.setAttribute('data-s', 'weak');
  } else {
    pill.textContent = t('tray.online');
    pill.setAttribute('data-s', 'good');
  }
  if (S.trayOpen) {
    const list = $('#trayList');
    list.replaceChildren(...mine.slice().reverse().map((it) => h('li', { class: 'qcard' }, cardEl(it, true))));
  }
  syncPad();
}

// Keeps the bottom of the page reachable, whatever height the tray has.
function syncPad() {
  requestAnimationFrame(() => {
    const tray = $('#tray');
    $('.wrap').style.paddingBottom = `${tray.hidden ? 24 : tray.offsetHeight + 24}px`;
  });
}

function renderDone() {
  if (S.screen === 'done') {
    const it = S.snap.find((x) => x.createdAt === S.lastAt);
    if (it) {
      $('#doneCard').replaceChildren(...cardEl(it, true));
      if (it.status === 'done') {
        $('#doneTitle').textContent = t('done.titleSent');
        $('#doneSub').textContent = t('done.subSent');
      } else if (it.status === 'failed') {
        $('#doneTitle').textContent = t('fail.other');
        $('#doneSub').textContent = '';
      } else {
        $('#doneTitle').textContent = t('done.titleSaved');
        $('#doneSub').textContent = isWaiting(it) ? t('done.subOffline') : t('done.subSaved');
      }
    }
  }
  if (S.screen === 'thanks') {
    const left = S.snap.filter(isActive).length;
    $('#thanksTitle').textContent = S.name ? t('thanks.title', { name: S.name }) : t('thanks.titleAnon');
    $('#thanksSub').textContent = left ? t('thanks.left', { n: left }) : t('thanks.all');
  }
}

/* ---------- forms ---------- */

function revoke(p) {
  if (p && p.url) {
    try {
      URL.revokeObjectURL(p.url);
    } catch (e) {
      /* ignore */
    }
  }
}

function resetForms() {
  if (S.recorder) {
    S.recorder.cancel();
    S.recorder = null;
  }
  revoke(S.pend);
  S.pend = null;
  $('#note').value = '';
  $('#noteCount').textContent = `0 / ${LIMITS.maxNoteChars}`;
  $('#noteErr').hidden = true;
  $('#photoIn').value = '';
  $('#videoIn').value = '';
  $('#photoCap').value = '';
  $('#photoDrop').classList.remove('has');
  $('#photoEmpty').hidden = false;
  $('#photoFull').hidden = true;
  $('#photoPrev').removeAttribute('src');
  hideErr($('#photoErr'));
  $('#photoInfo').hidden = true;
  $('#photoWorking').hidden = true;
  $('#savePhoto').disabled = true;
  hideErr($('#videoErr'));
  $('#videoWorking').hidden = true;
  $('#vidReview').removeAttribute('src');
  showVideoPane('choose');
}

async function addMemory(item) {
  const createdAt = Date.now();
  S.lastAt = createdAt;
  try {
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
  } catch (e) {
    /* ignore */
  }
  await uploader.enqueue({ ...item, id: newMemoryId(), name: S.name, createdAt });
  S.snap = uploader.snapshot(); // show the new item in the tray right away, not after the next throttled render
  // The blob now lives in IndexedDB. Release the preview URL held by the form.
  revoke(S.pend);
  S.pend = null;
  go('done');
}

/* notes */
function wireNote() {
  const ta = $('#note');
  ta.addEventListener('input', () => {
    $('#noteCount').textContent = `${ta.value.length} / ${LIMITS.maxNoteChars}`;
    if (ta.value.trim().length > 1) $('#noteErr').hidden = true;
  });
  $$('[data-start]').forEach((chip) => {
    chip.addEventListener('click', () => {
      const start = t(chip.getAttribute('data-start'));
      ta.value = ta.value ? `${ta.value}\n${start}` : start;
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
      $('#noteCount').textContent = `${ta.value.length} / ${LIMITS.maxNoteChars}`;
    });
  });
  $('#saveNote').addEventListener('click', () => {
    const text = ta.value.trim();
    if (text.length < 2) {
      $('#noteErr').hidden = false;
      return;
    }
    addMemory({ kind: 'note', text: text.slice(0, LIMITS.maxNoteChars) });
  });
}

/* photos */
function renderPhotoInfo() {
  const p = S.pend;
  if (!p || p.kind !== 'photo') return;
  const i = $('#photoInfo');
  i.hidden = false;
  i.textContent = t('photo.info', { orig: fmtBytes(p.origSize), sent: fmtBytes(p.blob.size) });
}

function wirePhoto() {
  $('#photoIn').addEventListener('change', async (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    hideErr($('#photoErr'));
    if (f.type && f.type.indexOf('image/') !== 0) {
      showErr($('#photoErr'), 'err.photoType');
      return;
    }
    $('#photoWorking').hidden = false;
    $('#savePhoto').disabled = true;
    try {
      const p = await preparePhoto(f);
      revoke(S.pend);
      S.pend = { kind: 'photo', blob: p.blob, thumbB64: p.thumbB64, origSize: f.size, url: URL.createObjectURL(p.blob) };
      $('#photoPrev').src = S.pend.url;
      $('#photoDrop').classList.add('has');
      $('#photoEmpty').hidden = true;
      $('#photoFull').hidden = false;
      renderPhotoInfo();
      $('#savePhoto').disabled = false;
    } catch (err) {
      showErr($('#photoErr'), 'err.photoDecode');
    } finally {
      $('#photoWorking').hidden = true;
    }
  });
  $('#savePhoto').addEventListener('click', () => {
    const p = S.pend;
    if (!p || p.kind !== 'photo') return;
    $('#savePhoto').disabled = true;
    addMemory({
      kind: 'photo',
      caption: $('#photoCap').value.trim().slice(0, LIMITS.maxCaptionChars),
      contentType: 'image/jpeg',
      sizeBytes: p.blob.size,
      durationSec: 0,
      thumbB64: p.thumbB64,
      blob: p.blob,
    });
  });
}

/* videos */
function showVideoPane(name) {
  $('#vChoose').hidden = name !== 'choose';
  $('#vLive').hidden = name !== 'live';
  $('#vReview').hidden = name !== 'review';
  $('#vSaveRow').hidden = name !== 'review';
  if (name === 'live') {
    $('#recStart').hidden = false;
    $('#recFlip').hidden = false;
    $('#recCancel').hidden = false;
    $('#recStop').hidden = true;
    $('#recBadge').hidden = true;
    $('#recTime').textContent = t('video.timer', { t: '0:00' });
  }
}

function renderVideoInfo() {
  const p = S.pend;
  if (!p || p.kind !== 'video') return;
  $('#videoInfo').textContent = t('video.info', { dur: mmss(p.durationSec), size: fmtBytes(p.blob.size) });
}

function reviewVideo(p) {
  revoke(S.pend);
  S.pend = { kind: 'video', ...p, url: URL.createObjectURL(p.blob) };
  $('#vidReview').src = S.pend.url;
  renderVideoInfo();
  showVideoPane('review');
}

async function openCamera() {
  try {
    await S.recorder.openCamera(S.facing);
    return true;
  } catch (e) {
    const denied = e && (e.name === 'NotAllowedError' || e.name === 'SecurityError');
    showErr($('#videoErr'), denied ? 'video.camDenied' : 'video.camMissing');
    S.recorder.cancel();
    S.recorder = null;
    showVideoPane('choose');
    return false;
  }
}

function newRecorder() {
  return createRecorder({
    previewEl: $('#vidLive'),
    onTick: (s) => {
      $('#recTime').textContent = t('video.timer', { t: mmss(s) });
    },
    onAutoStop: () => stopRecording(),
  });
}

async function stopRecording() {
  if (!S.recorder) return;
  const rec = S.recorder;
  S.recorder = null;
  $('#videoWorking').hidden = false;
  try {
    const r = await rec.finish();
    reviewVideo({ blob: r.blob, contentType: r.contentType, durationSec: r.durationSec, thumbB64: r.thumbB64 });
  } catch (e) {
    showErr($('#videoErr'), 'err.generic');
    showVideoPane('choose');
  } finally {
    $('#videoWorking').hidden = true;
  }
}

function wireVideo() {
  $('#videoBack').addEventListener('click', () => go('home'));
  $('#vRecord').addEventListener('click', async () => {
    hideErr($('#videoErr'));
    if (!canRecord()) {
      showErr($('#videoErr'), 'video.camMissing');
      return;
    }
    S.facing = 'user';
    S.recorder = newRecorder();
    showVideoPane('live');
    await openCamera();
  });
  $('#recFlip').addEventListener('click', async () => {
    if (!S.recorder) return;
    S.facing = S.facing === 'user' ? 'environment' : 'user';
    await openCamera();
  });
  $('#recStart').addEventListener('click', () => {
    if (!S.recorder) return;
    try {
      S.recorder.begin();
    } catch (e) {
      showErr($('#videoErr'), 'video.camMissing');
      return;
    }
    $('#recStart').hidden = true;
    $('#recFlip').hidden = true;
    $('#recCancel').hidden = true;
    $('#recStop').hidden = false;
    $('#recBadge').hidden = false;
  });
  $('#recStop').addEventListener('click', stopRecording);
  $('#recCancel').addEventListener('click', () => {
    if (S.recorder) S.recorder.cancel();
    S.recorder = null;
    showVideoPane('choose');
  });
  $('#vAgain').addEventListener('click', async () => {
    revoke(S.pend);
    S.pend = null;
    $('#vidReview').removeAttribute('src');
    if (!canRecord()) {
      showVideoPane('choose');
      return;
    }
    S.recorder = newRecorder();
    showVideoPane('live');
    await openCamera();
  });
  $('#videoIn').addEventListener('change', async (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!f) return;
    hideErr($('#videoErr'));
    const type = videoTypeFor(f);
    if (f.size > LIMITS.maxLibraryVideoBytes) {
      showErr($('#videoErr'), 'err.videoBig');
      return;
    }
    $('#videoWorking').hidden = false;
    try {
      const probe = await probeVideo(f);
      const bad = videoVerdict({ type, size: f.size, duration: probe.duration });
      if (bad) {
        showErr($('#videoErr'), bad);
        return;
      }
      reviewVideo({ blob: f, contentType: type, durationSec: Math.min(LIMITS.maxVideoSeconds, Math.max(1, Math.round(probe.duration))), thumbB64: probe.thumbB64 });
    } finally {
      $('#videoWorking').hidden = true;
    }
  });
  $('#saveVideo').addEventListener('click', () => {
    const p = S.pend;
    if (!p || p.kind !== 'video') return;
    $('#saveVideo').disabled = true;
    addMemory({
      kind: 'video',
      caption: '',
      contentType: p.contentType,
      sizeBytes: p.blob.size,
      durationSec: p.durationSec,
      thumbB64: p.thumbB64 || '',
      blob: p.blob,
    }).finally(() => {
      $('#saveVideo').disabled = false;
    });
  });
}

/* ---------- keeping uploads alive ---------- */

let wakeLock = null;
async function syncWakeLock() {
  const active = S.snap.some(isActive);
  if (active && !wakeLock && 'wakeLock' in navigator && document.visibilityState === 'visible') {
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => {
        wakeLock = null;
      });
    } catch (e) {
      wakeLock = null;
    }
  } else if (!active && wakeLock) {
    try {
      await wakeLock.release();
    } catch (e) {
      /* ignore */
    }
    wakeLock = null;
  }
}

function poke() {
  uploader.wake();
  uploader.kick();
}

/* ---------- boot ---------- */

const uploader = createUploader({
  store,
  api,
  putPart,
  newId: newMemoryId,
  concurrency: 2,
  onAuthNeeded: askCode,
  onChange: (snap) => {
    S.snap = snap;
    scheduleRender();
  },
});

function registerWorker() {
  if (!('serviceWorker' in navigator)) return;
  if (location.search.indexOf('nosw=1') >= 0) {
    navigator.serviceWorker.getRegistrations().then((rs) => rs.forEach((r) => r.unregister()));
    if (window.caches) caches.keys().then((ks) => ks.forEach((k) => caches.delete(k)));
    return;
  }
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

async function boot() {
  setLang(detectLang(ls.get('mb.lang'), navigator.language));
  setVars({ who: ls.get('mb.h') || CONFIG.honoree });
  renderIcons();
  applyAll();

  // Wire everything first so the page is never dead.
  $('#langBtn').addEventListener('click', () => {
    const next = getLang() === 'en' ? 'es' : 'en';
    setLang(next);
    ls.set('mb.lang', next);
    applyAll();
    renderAll();
  });
  $$('[data-go]').forEach((b) =>
    b.addEventListener('click', () => {
      const target = b.getAttribute('data-go');
      if ((target === 'note' || target === 'photo' || target === 'video') && !needName()) return;
      go(target);
    }),
  );
  $('#who').addEventListener('input', () => {
    if ($('#who').value.trim()) $('#nameErr').hidden = true;
  });
  wireCodeInput($('#gateCode'));
  wireCodeInput($('#authCode'));
  $('#gateCode').addEventListener('input', () => {
    hideErr($('#gateErr'));
    if ($('#gateCode').value.length === 4) $('#gateForm').requestSubmit();
  });
  $('#authCode').addEventListener('input', () => {
    if ($('#authCode').value.length === 4) $('#authForm').requestSubmit();
  });
  $('#gateForm').addEventListener('submit', onGateSubmit);
  $('#authForm').addEventListener('submit', onAuthSubmit);
  wireNote();
  wirePhoto();
  wireVideo();
  $('#trayBtn').addEventListener('click', () => {
    S.trayOpen = !S.trayOpen;
    $('#trayBtn').setAttribute('aria-expanded', String(S.trayOpen));
    $('#trayList').hidden = !S.trayOpen;
    renderTray();
  });
  $('#trayList').addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const id = b.getAttribute('data-id');
    if (b.getAttribute('data-act') === 'retry') uploader.retryFailed(id);
    else uploader.discard(id);
  });
  $('#doneCard').addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const id = b.getAttribute('data-id');
    if (b.getAttribute('data-act') === 'retry') uploader.retryFailed(id);
    else uploader.discard(id);
  });

  window.addEventListener('online', () => {
    S.online = true;
    poke();
    scheduleRender();
  });
  window.addEventListener('offline', () => {
    S.online = false;
    scheduleRender();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      poke();
      syncWakeLock();
    }
  });
  window.addEventListener('pageshow', poke);
  window.addEventListener('beforeunload', (e) => {
    if (S.snap.some(isActive)) {
      e.preventDefault();
      e.returnValue = t('unload.warn');
      return e.returnValue;
    }
    return undefined;
  });
  setInterval(() => {
    if (S.session && S.snap.some(isActive)) uploader.kick();
  }, 15000);

  // Which party is this? The link carries the event id in the fragment, so it never reaches a server.
  const fromHash = parseEventId(location.hash);
  if (fromHash) {
    ls.set('mb.e', fromHash);
    try {
      history.replaceState(null, '', location.pathname + location.search);
    } catch (e) {
      /* ignore */
    }
  }
  S.eventId = fromHash || ls.get('mb.e');
  let gid = ls.get('mb.g');
  if (!/^[0-9a-f]{32}$/.test(gid || '')) {
    gid = newGuestId();
    ls.set('mb.g', gid);
  }
  S.guestId = gid;
  S.name = cleanName(ls.get('mb.n'));

  await uploader.init();
  S.snap = uploader.snapshot();
  store.ready().then((durable) => {
    if (!durable) $('#storageWarn').hidden = false;
  });

  if (!S.eventId) {
    go('badlink');
    return;
  }
  S.session = loadSession();
  if (S.session) {
    go('home');
    uploader.kick();
  } else {
    go('gate');
  }
  registerWorker();
}

boot();
