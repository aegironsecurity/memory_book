// Pure helpers and the client side copies of the server limits. The server enforces them again.
export const LIMITS = {
  photoEdge: 2048,
  photoQuality: 0.82,
  thumbEdge: 320,
  thumbMaxBytes: 58000,
  maxVideoSeconds: 60,
  videoSecondsSlack: 1.5, // library clips often report 60.04 and similar
  maxLibraryVideoBytes: 100 * 1024 * 1024,
  maxNoteChars: 600,
  maxNameChars: 60,
  maxCaptionChars: 90,
};

export const mmss = (d) => {
  const s = Math.max(0, Math.round(d));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

export const fmtBytes = (n) => {
  if (n < 50 * 1024) return '< 50 KB';
  const mb = n / 1048576;
  return `${mb >= 10 ? mb.toFixed(0) : mb.toFixed(1)} MB`;
};

// The server allows exactly these types. Phones sometimes give an empty type for library files.
export function videoTypeFor(file) {
  const t = (file.type || '').toLowerCase().split(';')[0];
  if (t === 'video/mp4' || t === 'video/webm' || t === 'video/quicktime') return t;
  const n = (file.name || '').toLowerCase();
  if (n.endsWith('.mp4') || n.endsWith('.m4v')) return 'video/mp4';
  if (n.endsWith('.mov')) return 'video/quicktime';
  if (n.endsWith('.webm')) return 'video/webm';
  return null;
}

// Returns null when the clip is fine, otherwise a message key for i18n.
export function videoVerdict({ type, size, duration }) {
  if (!type) return 'err.videoType';
  if (size > LIMITS.maxLibraryVideoBytes) return 'err.videoBig';
  if (!(duration > 0)) return 'err.videoUnreadable';
  if (duration > LIMITS.maxVideoSeconds + LIMITS.videoSecondsSlack) return 'err.videoLong';
  return null;
}

// Link format: https://host/#e=<32 hex>. Returns the event id or null.
export function parseEventId(hash) {
  const m = /(?:^#|&)e=([0-9a-f]{32})(?:&|$)/.exec(hash || '');
  return m ? m[1] : null;
}

export const cleanName = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, LIMITS.maxNameChars);

export function fitWithin(w, h, edge) {
  const long = Math.max(w, h);
  if (long <= edge) return { w, h };
  const k = edge / long;
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
}

const MIME_CHOICES = [
  'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
  'video/mp4',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
];

// Picks the best recording format this browser supports. Safari gives mp4, Chrome gives webm.
export function pickRecorderMime(MR) {
  if (!MR || typeof MR.isTypeSupported !== 'function') return null;
  for (const m of MIME_CHOICES) if (MR.isTypeSupported(m)) return m;
  return '';
}

export const baseType = (mime) => (mime || '').split(';')[0] || 'video/mp4';
