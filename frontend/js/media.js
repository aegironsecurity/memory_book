// Browser media handling: photo shrinking, thumbnails, video probing and in-page recording.
import { LIMITS, fitWithin, pickRecorderMime, baseType } from './policy.js';

const canvasToBlob = (canvas, type, q) =>
  new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('encode failed'))), type, q);
  });

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

// Decodes a photo with EXIF rotation applied. HEIC works on iOS Safari because the system decodes it.
async function decodeImage(file) {
  if (typeof createImageBitmap === 'function') {
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
      return { source: bmp, width: bmp.width, height: bmp.height, close: () => bmp.close && bmp.close() };
    } catch (e) {
      /* fall back to an <img> element */
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    return { source: img, width: img.naturalWidth, height: img.naturalHeight, close: () => {} };
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
}

function drawScaled(source, sw, sh, edge) {
  const { w, h } = fitWithin(sw, sh, edge);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff'; // flatten transparency so JPEG does not turn it black
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(source, 0, 0, w, h);
  return canvas;
}

// Returns a base64 JPEG no larger than thumbMaxBytes, tuning quality and then size.
async function thumbFromCanvasSource(source, sw, sh) {
  let edge = LIMITS.thumbEdge;
  for (let round = 0; round < 4; round += 1) {
    const canvas = drawScaled(source, sw, sh, edge);
    for (const q of [0.72, 0.6, 0.48, 0.36]) {
      const blob = await canvasToBlob(canvas, 'image/jpeg', q);
      if (blob.size <= LIMITS.thumbMaxBytes) return blobToBase64(blob);
    }
    edge = Math.round(edge * 0.75);
  }
  return '';
}

export async function preparePhoto(file) {
  const img = await decodeImage(file);
  try {
    const canvas = drawScaled(img.source, img.width, img.height, LIMITS.photoEdge);
    const blob = await canvasToBlob(canvas, 'image/jpeg', LIMITS.photoQuality);
    const thumbB64 = await thumbFromCanvasSource(img.source, img.width, img.height);
    return { blob, thumbB64, width: canvas.width, height: canvas.height, contentType: 'image/jpeg' };
  } finally {
    img.close();
  }
}

function loadVideoEl(src, { timeoutMs = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    const v = document.createElement('video');
    v.muted = true;
    v.playsInline = true;
    v.preload = 'metadata';
    const timer = setTimeout(() => reject(new Error('video timeout')), timeoutMs);
    v.onloadedmetadata = () => {
      clearTimeout(timer);
      resolve(v);
    };
    v.onerror = () => {
      clearTimeout(timer);
      reject(new Error('video error'));
    };
    v.src = src;
    v.load();
  });
}

function seekTo(v, t, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    v.onseeked = () => {
      clearTimeout(timer);
      resolve();
    };
    try {
      v.currentTime = t;
    } catch (e) {
      clearTimeout(timer);
      resolve();
    }
  });
}

// Reads duration and a thumbnail from a video file. Duration is NaN if the browser cannot read it.
export async function probeVideo(file) {
  const url = URL.createObjectURL(file);
  try {
    const v = await loadVideoEl(url);
    let duration = v.duration;
    if (!Number.isFinite(duration)) duration = NaN;
    let thumbB64 = '';
    try {
      await seekTo(v, Math.min(1, (duration || 2) / 2));
      if (v.videoWidth && v.videoHeight) thumbB64 = await thumbFromCanvasSource(v, v.videoWidth, v.videoHeight);
    } catch (e) {
      thumbB64 = '';
    }
    return { duration, thumbB64 };
  } catch (e) {
    return { duration: NaN, thumbB64: '' };
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function frameFromVideoEl(v) {
  if (!v.videoWidth || !v.videoHeight) return '';
  return thumbFromCanvasSource(v, v.videoWidth, v.videoHeight);
}

export const canRecord = () =>
  !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && typeof MediaRecorder !== 'undefined' && pickRecorderMime(MediaRecorder) !== null);

// In-page recorder. start() resolves once the camera is live and the preview element is playing.
export function createRecorder({ previewEl, onTick, onAutoStop }) {
  let stream = null;
  let rec = null;
  let chunks = [];
  let startedAt = 0;
  let timer = null;
  let thumbB64 = '';
  let mime = '';
  let stopping = null;

  const stopTracks = () => {
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = null;
    if (previewEl) previewEl.srcObject = null;
  };

  async function openCamera(facing = 'user') {
    stopTracks();
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: facing, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } },
      audio: { echoCancellation: true, noiseSuppression: true },
    });
    previewEl.srcObject = stream;
    previewEl.muted = true;
    previewEl.playsInline = true;
    await previewEl.play().catch(() => {});
  }

  function begin() {
    mime = pickRecorderMime(MediaRecorder);
    const opts = { videoBitsPerSecond: 2500000, audioBitsPerSecond: 96000 };
    if (mime) opts.mimeType = mime;
    rec = new MediaRecorder(stream, opts);
    chunks = [];
    rec.ondataavailable = (e) => {
      if (e.data && e.data.size) chunks.push(e.data);
    };
    startedAt = performance.now();
    rec.start(1000);
    timer = setInterval(async () => {
      const s = (performance.now() - startedAt) / 1000;
      if (!thumbB64 && s >= 1) {
        thumbB64 = '-';
        frameFromVideoEl(previewEl).then((b) => {
          thumbB64 = b;
        });
      }
      if (onTick) onTick(Math.min(s, LIMITS.maxVideoSeconds));
      if (s >= LIMITS.maxVideoSeconds) {
        clearInterval(timer);
        if (onAutoStop) onAutoStop();
      }
    }, 250);
  }

  function finish() {
    if (stopping) return stopping;
    stopping = new Promise((resolve, reject) => {
      clearInterval(timer);
      const seconds = Math.min((performance.now() - startedAt) / 1000, LIMITS.maxVideoSeconds);
      if (!rec || rec.state === 'inactive') {
        stopTracks();
        return reject(new Error('not recording'));
      }
      rec.onstop = async () => {
        const type = baseType(rec.mimeType || mime);
        const blob = new Blob(chunks, { type });
        if (!thumbB64 || thumbB64 === '-') {
          // Very short clip: try the preview frame once more before the stream goes away.
          try {
            thumbB64 = await frameFromVideoEl(previewEl);
          } catch (e) {
            thumbB64 = '';
          }
        }
        stopTracks();
        resolve({ blob, durationSec: Math.max(1, Math.round(seconds)), contentType: type, thumbB64: thumbB64 === '-' ? '' : thumbB64 });
      };
      rec.onerror = () => {
        stopTracks();
        reject(new Error('recorder error'));
      };
      rec.stop();
    });
    return stopping;
  }

  return {
    openCamera,
    begin,
    finish,
    cancel() {
      clearInterval(timer);
      try {
        if (rec && rec.state !== 'inactive') {
          rec.onstop = null;
          rec.stop();
        }
      } catch (e) {
        /* ignore */
      }
      stopTracks();
    },
    get active() {
      return !!rec && rec.state === 'recording';
    },
  };
}
