// Host page: sign in with Cognito, moderate memories, change the code and window, print table cards.
import { CONFIG } from './config.js';
import { createCognito, AuthError } from './cognito.js';
import { h } from './dom.js';
import { guestUrl, qrSvg, fmtWhen, exportJson, optInsCsv } from './hostlib.js';
import { mmss, fmtBytes } from './policy.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

const ss = {
  get(k) {
    try {
      return sessionStorage.getItem(k);
    } catch (e) {
      return null;
    }
  },
  set(k, v) {
    try {
      sessionStorage.setItem(k, v);
    } catch (e) {
      /* ignore */
    }
  },
  del(k) {
    try {
      sessionStorage.removeItem(k);
    } catch (e) {
      /* ignore */
    }
  },
};
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
      /* ignore */
    }
  },
};

const cognito = createCognito({ region: CONFIG.region, clientId: CONFIG.userPoolClientId });
const S = { tokens: null, data: null, pendingMfa: null, closeArmed: false, busy: false };

/* ---------- auth ---------- */

function loadTokens() {
  try {
    const t = JSON.parse(ss.get('mbh.t') || 'null');
    if (t && t.idToken && t.refreshToken) return t;
  } catch (e) {
    /* ignore */
  }
  return null;
}
function saveTokens(t) {
  S.tokens = t;
  ss.set('mbh.t', JSON.stringify(t));
}

async function freshToken() {
  if (!S.tokens) throw new AuthError('signed_out');
  if (S.tokens.expiresAt - 60000 > Date.now()) return S.tokens.idToken;
  const t = await cognito.refresh(S.tokens.refreshToken);
  saveTokens(t);
  return t.idToken;
}

class HostApiError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}

async function hostApi(method, path, body, retried = false) {
  let token;
  try {
    token = await freshToken();
  } catch (e) {
    signOut();
    throw new HostApiError(401, 'signed_out', 'Sign in again');
  }
  let res;
  try {
    res = await fetch(`${CONFIG.apiUrl.replace(/\/+$/, '')}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
      credentials: 'omit',
    });
  } catch (e) {
    throw new HostApiError(0, 'network', 'Cannot reach the server');
  }
  let data = {};
  try {
    data = await res.json();
  } catch (e) {
    data = {};
  }
  if (res.status === 401 && !retried && S.tokens) {
    S.tokens.expiresAt = 0; // force a refresh and try once more
    return hostApi(method, path, body, true);
  }
  if (!res.ok) {
    if (res.status === 401) signOut();
    throw new HostApiError(res.status, data.error || `http_${res.status}`, data.message);
  }
  return data;
}

function signOut() {
  S.tokens = null;
  S.data = null;
  ss.del('mbh.t');
  $('#signin').hidden = false;
  $('#dash').hidden = true;
  $('#signOut').hidden = true;
}

const LOGIN_ERRORS = {
  bad_login: 'Email or password is not right.',
  reset_required: 'This account needs a password reset. Run scripts/create-host-user.sh again.',
  too_many: 'Too many tries. Wait a few minutes.',
  bad_mfa: 'That authenticator code is not right.',
  network: 'Cannot reach the sign-in service. Check your connection.',
  unsupported_challenge: 'This account has no permanent password yet. Run scripts/create-host-user.sh.',
};

async function onSignIn(ev) {
  ev.preventDefault();
  if (S.busy) return;
  const err = $('#signinErr');
  err.hidden = true;
  if (!CONFIG.apiUrl || !CONFIG.userPoolClientId) {
    err.textContent = 'This site is not configured yet (js/config.js is empty). Run scripts/deploy.sh.';
    err.hidden = false;
    return;
  }
  S.busy = true;
  $('#signinGo').disabled = true;
  try {
    let result;
    if (S.pendingMfa) result = await cognito.answerTotp(S.pendingMfa, $('#totp').value.trim());
    else result = await cognito.signIn($('#email').value.trim(), $('#password').value);
    if (result.challenge === 'totp') {
      S.pendingMfa = result;
      $('#totpRow').hidden = false;
      $('#totp').focus();
      return;
    }
    S.pendingMfa = null;
    $('#password').value = '';
    $('#totp').value = '';
    $('#totpRow').hidden = true;
    saveTokens(result);
    await showDash();
  } catch (e) {
    err.textContent = LOGIN_ERRORS[e.code] || 'Sign in failed. Try again.';
    err.hidden = false;
  } finally {
    S.busy = false;
    $('#signinGo').disabled = false;
  }
}

/* ---------- dashboard ---------- */

function setHostError(msg) {
  const el = $('#hostErr');
  el.hidden = !msg;
  el.textContent = msg || '';
}
const explain = (e) => (e.code === 'network' ? 'Cannot reach the server. Check your connection.' : e.message || 'Something went wrong.');

async function showDash() {
  $('#signin').hidden = true;
  $('#dash').hidden = false;
  $('#signOut').hidden = false;
  await load();
}

async function load() {
  try {
    S.data = await hostApi('GET', '/host/memories');
    setHostError('');
    render();
  } catch (e) {
    if (e.code !== 'signed_out') setHostError(explain(e));
  }
}

function windowText(ev) {
  const closes = Date.parse(ev.closesAt);
  if (!Number.isFinite(closes)) return '';
  return closes > Date.now() ? `Open until ${fmtWhen(ev.closesAt)}` : `Closed since ${fmtWhen(ev.closesAt)}`;
}

function renderStats() {
  const { counts, event } = S.data;
  $('#hTitle').textContent = `${event.guestOfHonor}'s memories`;
  const parts = [`${counts.complete - counts.hidden} in the book`];
  if (counts.hidden) parts.push(`${counts.hidden} hidden`);
  if (counts.pending) parts.push(`${counts.pending} still sending`);
  $('#hStats').textContent = parts.join(', ');
  $('#hWindow').textContent = windowText(event);
  $('#closeNow').textContent = S.closeArmed ? 'Tap again to close' : 'Close now';
}

function thumbEl(m) {
  if (m.thumbUrl) return h('img', { src: m.thumbUrl, alt: '', loading: 'lazy' });
  return h('span', null, m.kind === 'note' ? 'Aa' : m.kind === 'photo' ? 'Img' : 'Vid');
}

function rowEl(m) {
  const tags = [];
  if (m.hidden) tags.push(h('span', { class: 'tag' }, 'Hidden'));
  if (m.status !== 'complete') tags.push(h('span', { class: 'tag sending' }, 'Sending'));
  const detail = [];
  if (m.kind === 'note') detail.push(h('div', { class: 'full' }, m.text || ''));
  if (m.kind === 'photo') detail.push(h('div', { class: 'txt' }, `${m.caption || 'Photo'} (${fmtBytes(m.sizeBytes || 0)})`));
  if (m.kind === 'video') {
    detail.push(h('div', { class: 'txt' }, `Video, ${mmss(m.durationSec || 0)} (${fmtBytes(m.sizeBytes || 0)})`));
    if (m.url) detail.push(h('video', { controls: true, preload: 'none', poster: m.thumbUrl || '', src: m.url, playsInline: true }));
  }
  const actions = [];
  if (m.url && m.kind !== 'note') {
    actions.push(h('a', { class: 'mini', href: m.url, target: '_blank', rel: 'noopener noreferrer' }, 'Open'));
    actions.push(h('a', { class: 'mini', href: m.downloadUrl || m.url, rel: 'noopener noreferrer' }, 'Download'));
  }
  actions.push(h('button', { class: 'mini', type: 'button', 'data-hide': m.id, 'aria-pressed': String(m.hidden) }, m.hidden ? 'Show' : 'Hide'));
  return h(
    'li',
    { class: `row${m.hidden ? ' off' : ''}`, 'data-id': m.id },
    h('div', { class: 'th' }, thumbEl(m)),
    h('div', { class: 'body' }, h('div', { class: 'who' }, m.name, tags), detail, h('div', { class: 'row-actions' }, actions)),
  );
}

function renderOptIns() {
  const list = S.data.optIns || [];
  $('#optStats').textContent = list.length === 1 ? '1 guest wants the book' : `${list.length} guests want the book`;
  $('#exportCsv').disabled = list.length === 0;
  $('#optins').replaceChildren(...list.map((o) => h('li', null, h('b', null, o.name), ' ', h('span', { class: 'mail' }, o.email))));
}

function render() {
  renderStats();
  // Rebuild the list without losing playing videos: skip rebuild while one is playing.
  const playing = $$('#rows video').some((v) => !v.paused && !v.ended);
  if (!playing) $('#rows').replaceChildren(...S.data.memories.slice().reverse().map(rowEl));
  renderOptIns();
  renderCard();
}

async function toggleHidden(id) {
  const m = S.data.memories.find((x) => x.id === id);
  if (!m) return;
  try {
    await hostApi('POST', `/host/memories/${encodeURIComponent(id)}/${m.hidden ? 'show' : 'hide'}`);
    m.hidden = !m.hidden;
    S.data.counts.hidden += m.hidden ? 1 : -1;
    setHostError('');
    render();
    const again = $(`[data-hide="${CSS.escape(id)}"]`);
    if (again) again.focus();
  } catch (e) {
    setHostError(explain(e));
  }
}

async function rotate() {
  const raw = $('#newCode').value.trim();
  if (raw && !/^\d{4}$/.test(raw)) {
    $('#rotateMsg').hidden = false;
    $('#rotateMsg').textContent = 'The code must be exactly 4 digits.';
    return;
  }
  try {
    const r = await hostApi('POST', '/host/code/rotate', raw ? { code: raw } : {});
    $('#newCode').value = '';
    $('#cardCode').value = r.code;
    ls.set('mbh.code', r.code);
    $('#rotateMsg').hidden = false;
    $('#rotateMsg').textContent = `New code: ${r.code}. Guests' phones will ask for it before sending. Reprint the cards.`;
    setHostError('');
    renderCard();
  } catch (e) {
    setHostError(explain(e));
  }
}

async function changeWindow(body) {
  try {
    const r = await hostApi('POST', '/host/window', body);
    S.data.event = r.event;
    S.closeArmed = false;
    setHostError('');
    renderStats();
  } catch (e) {
    setHostError(explain(e));
  }
}

/* ---------- table cards ---------- */

function buildCard(url, code) {
  const qr = globalThis.qrcode(0, 'M');
  qr.addData(url);
  qr.make();
  const qrBox = h('div');
  qrBox.innerHTML = qrSvg(qr, { label: 'QR code to open the memory book' });
  return h(
    'div',
    { class: 'card' },
    h('div', { class: 'c-sixty' }, '60'),
    h('h4', null, `${S.data.event.guestOfHonor}'s 60th`),
    h('div', { class: 'c-line' }, 'Scan to leave a memory'),
    h('div', { class: 'c-es' }, 'Escanea para dejar un recuerdo'),
    qrBox,
    h('div', { class: 'c-code-label' }, 'Code / Código'),
    h('div', { class: 'c-code' }, code || '----'),
    h('div', { class: 'c-url' }, url),
  );
}

function renderCard() {
  if (!S.data || typeof globalThis.qrcode !== 'function') return;
  const url = guestUrl(location.origin, S.data.event.eventId);
  const code = /^\d{4}$/.test($('#cardCode').value) ? $('#cardCode').value : '';
  $('#cardPreview').replaceChildren(buildCard(url, code));
}

function printCards() {
  const url = guestUrl(location.origin, S.data.event.eventId);
  const code = /^\d{4}$/.test($('#cardCode').value) ? $('#cardCode').value : '';
  $('#sheet').replaceChildren(...Array.from({ length: 6 }, () => buildCard(url, code)));
  window.print();
}

function downloadJson() {
  saveFile(exportJson(S.data), 'application/json', 'memory-book-list.json');
}

function downloadCsv() {
  saveFile(optInsCsv(S.data.optIns), 'text/csv', 'memory-book-emails.csv');
}

function saveFile(text, type, filename) {
  const blob = new Blob([text], { type });
  const a = h('a', { href: URL.createObjectURL(blob), download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

/* ---------- boot ---------- */

function boot() {
  $('#signinForm').addEventListener('submit', onSignIn);
  $('#signOut').addEventListener('click', signOut);
  $('#refresh').addEventListener('click', load);
  $('#rotate').addEventListener('click', rotate);
  $('#printCards').addEventListener('click', printCards);
  $('#exportJson').addEventListener('click', downloadJson);
  $('#exportCsv').addEventListener('click', downloadCsv);
  $('#cardCode').addEventListener('input', () => {
    $('#cardCode').value = $('#cardCode').value.replace(/\D/g, '').slice(0, 4);
    ls.set('mbh.code', $('#cardCode').value);
    renderCard();
  });
  $('#newCode').addEventListener('input', () => {
    $('#newCode').value = $('#newCode').value.replace(/\D/g, '').slice(0, 4);
  });
  $$('[data-extend]').forEach((b) => b.addEventListener('click', () => changeWindow({ extendHours: Number(b.getAttribute('data-extend')) })));
  $('#closeNow').addEventListener('click', () => {
    if (!S.closeArmed) {
      S.closeArmed = true;
      renderStats();
      setTimeout(() => {
        S.closeArmed = false;
        if (S.data) renderStats();
      }, 5000);
      return;
    }
    changeWindow({ closeNow: true });
  });
  $('#rows').addEventListener('click', (e) => {
    const b = e.target.closest('[data-hide]');
    if (b) toggleHidden(b.getAttribute('data-hide'));
  });
  $('#cardCode').value = ls.get('mbh.code') || '';

  S.tokens = loadTokens();
  if (S.tokens) showDash();
  setInterval(() => {
    if (S.tokens && document.visibilityState === 'visible') load();
  }, 30000);
}

boot();
