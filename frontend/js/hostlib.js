// Pure helpers for the host page.

export const guestUrl = (origin, eventId) => `${String(origin).replace(/\/+$/, '')}/#e=${eventId}`;

// Turns a qrcode-generator instance into one SVG path. Quiet zone of 4 modules, white background.
export function qrSvg(qr, { label = 'QR code' } = {}) {
  const n = qr.getModuleCount();
  let d = '';
  for (let y = 0; y < n; y += 1) {
    for (let x = 0; x < n; x += 1) {
      if (qr.isDark(y, x)) d += `M${x + 4} ${y + 4}h1v1h-1z`;
    }
  }
  const size = n + 8;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" role="img" aria-label="${label}" shape-rendering="crispEdges"><rect width="${size}" height="${size}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}

export function fmtWhen(iso, tz = 'America/Los_Angeles') {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(new Date(t));
}

// Metadata export for the book (no signed links, they expire).
export function exportJson(data) {
  const rows = data.memories.map((m) => ({
    id: m.id,
    kind: m.kind,
    name: m.name,
    text: m.text || undefined,
    caption: m.caption || undefined,
    status: m.status,
    hidden: m.hidden,
    contentType: m.contentType || undefined,
    sizeBytes: m.sizeBytes,
    durationSec: m.durationSec || undefined,
    createdAt: m.createdAt,
    completedAt: m.completedAt,
    file: m.kind === 'note' ? undefined : `events/${data.event.eventId}/${m.id}/original.${extOf(m.contentType)}`,
  }));
  return JSON.stringify({ exportedAt: new Date().toISOString(), event: data.event, memories: rows }, null, 2);
}

export function extOf(contentType) {
  return { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov' }[contentType] || 'bin';
}
