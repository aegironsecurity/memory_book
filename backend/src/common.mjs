// Shared helpers for the guest and host Lambdas. No AWS imports here so tests can run anywhere.
import crypto from 'node:crypto';

export const LIMITS = {
  partSize: 5 * 1024 * 1024, // S3 minimum part size, except for the last part
  maxFilesPerGuest: 15,
  maxBytesPerGuest: 400 * 1024 * 1024,
  maxPhotoBytes: 12 * 1024 * 1024,
  maxVideoBytes: 120 * 1024 * 1024,
  maxThumbBytes: 60 * 1024,
  maxVideoSeconds: 62, // 60 second cap plus a little slack for recorder timing
  maxTextChars: 600,
  maxNameChars: 60,
  maxCaptionChars: 90,
  maxBodyBytes: 120 * 1024, // JSON body, thumbnail travels as base64 inside it
  tokenTtlMs: 48 * 3600 * 1000,
  graceAfterCloseMs: 6 * 3600 * 1000,
  failuresPerIp: 20, // wrong codes per 10 minute window per IP (carrier NAT shares IPs)
  failuresPerEvent: 300,
  windowMs: 10 * 60 * 1000,
  partUrlTtlSec: 900,
  hostUrlTtlSec: 900,
  maxPartsPerCall: 8,
};

export const MEDIA_TYPES = {
  'image/jpeg': { ext: 'jpg', kind: 'photo' },
  'image/png': { ext: 'png', kind: 'photo' },
  'image/webp': { ext: 'webp', kind: 'photo' },
  'video/mp4': { ext: 'mp4', kind: 'video' },
  'video/webm': { ext: 'webm', kind: 'video' },
  'video/quicktime': { ext: 'mov', kind: 'video' },
};

export class HttpError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}

export function json(status, body) {
  return {
    statusCode: status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    body: JSON.stringify(body),
  };
}

export function parseBody(event) {
  let raw = event.body || '';
  if (event.isBase64Encoded) raw = Buffer.from(raw, 'base64').toString('utf8');
  if (Buffer.byteLength(raw) > LIMITS.maxBodyBytes) throw new HttpError(413, 'too_large', 'Request body too large');
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object');
    return v;
  } catch {
    throw new HttpError(400, 'bad_json', 'Body must be a JSON object');
  }
}

// ---- validators -----------------------------------------------------------

export const RE_EVENT = /^[0-9a-f]{32}$/;
export const RE_GUEST = /^[0-9a-f]{32}$/;
export const RE_MEMORY = /^[0-9a-z]{9}-[0-9a-f]{16}$/;
export const RE_CODE = /^[0-9]{4}$/;

// Strip control characters, collapse whitespace, cap length. Text is escaped again on render.
export function cleanText(v, max, { multiline = false } = {}) {
  if (typeof v !== 'string') return '';
  let s = v.normalize('NFC');
  s = s.replace(multiline ? /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g : /[\u0000-\u001F\u007F]/g, ' ');
  s = multiline ? s.replace(/[ \t]+/g, ' ') : s.replace(/\s+/g, ' ');
  return s.trim().slice(0, max);
}

export function posInt(v, max) {
  if (typeof v !== 'number' || !Number.isFinite(v) || !Number.isInteger(v) || v < 1 || v > max) return null;
  return v;
}

// ---- crypto ---------------------------------------------------------------

export function sha256Hex(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

// The 4 digit code is only a second factor. The 128 bit event id in the link is the real secret.
export function codeHash(eventId, code) {
  return sha256Hex(`${eventId}:${code}`);
}

export function safeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

const b64u = (buf) => Buffer.from(buf).toString('base64url');

export function signToken(secret, payload) {
  const body = b64u(JSON.stringify(payload));
  const sig = b64u(crypto.createHmac('sha256', secret).update(`v1.${body}`).digest());
  return `v1.${body}.${sig}`;
}

export function verifyToken(secret, token, nowMs) {
  if (typeof token !== 'string') throw new HttpError(401, 'no_token', 'Missing token');
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') throw new HttpError(401, 'bad_token', 'Bad token');
  const expect = b64u(crypto.createHmac('sha256', secret).update(`v1.${parts[1]}`).digest());
  if (!safeEqualHex(Buffer.from(expect).toString('hex'), Buffer.from(parts[2]).toString('hex'))) {
    throw new HttpError(401, 'bad_token', 'Bad token');
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    throw new HttpError(401, 'bad_token', 'Bad token');
  }
  if (!payload || typeof payload.exp !== 'number' || payload.exp < nowMs) throw new HttpError(401, 'expired', 'Token expired');
  return payload;
}

export function bearer(event) {
  const h = event.headers || {};
  const raw = h.authorization || h.Authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(raw);
  return m ? m[1].trim() : '';
}

// ---- file sniffing --------------------------------------------------------

// Confirms the first bytes of an uploaded object match the declared content type.
export function sniffMatches(contentType, bytes) {
  const b = Buffer.from(bytes);
  if (b.length < 12) return false;
  switch (contentType) {
    case 'image/jpeg':
      return b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
    case 'image/png':
      return b[0] === 0x89 && b.toString('latin1', 1, 4) === 'PNG';
    case 'image/webp':
      return b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP';
    case 'video/mp4':
    case 'video/quicktime':
      return b.toString('latin1', 4, 8) === 'ftyp';
    case 'video/webm':
      return b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3;
    default:
      return false;
  }
}

export function isJpeg(bytes) {
  const b = Buffer.from(bytes);
  return b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
}

export function windowOf(now) {
  return Math.floor(now / LIMITS.windowMs);
}

export function ipKey(event) {
  const ip = event.requestContext?.http?.sourceIp || 'unknown';
  return sha256Hex(ip).slice(0, 16);
}

export function log(level, msg, extra = {}) {
  // One JSON line per event keeps CloudWatch queries simple. Never log tokens, codes, or guest text.
  console.log(JSON.stringify({ level, msg, ...extra }));
}
