// Builds 3D printable STL files for a standing QR sign: a white plate, the black QR modules that sit on
// top of it with a line or two of raised text under the code, and a black stand with a slot the plate drops
// into. Plate and black parts share one coordinate frame, so a slicer can load them as one object with two
// parts (one filament each).
//
//   node scripts/qr-stl.mjs <guest link> [out dir] [--text "LINE ONE|line two"] [--font file.ttf]
//
// Text needs opentype.js and earcut (backend dev dependencies). The default font is Segoe UI Black.
//
// Uses the same vendored qrcode-generator as the host page, at error correction level Q so a few bad
// layers or a scuff still scan. Units are millimetres.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  if (i < 0) return fallback;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const TEXT = flag('--text', 'SHARE YOUR PHOTOS|Comparte tus fotos');
const FONT = flag('--font', 'C:/Windows/Fonts/seguibl.ttf');
const link = args[0];
const outDir = args[1] || join(ROOT, 'print');
if (!/^https:\/\/\S+$/.test(link || '')) {
  console.error('Usage: node scripts/qr-stl.mjs https://<site>/#e=<eventId> [out dir]');
  process.exit(1);
}

const PLATE_W = 140;
const QR_SIZE = 128; // width of the QR including its white quiet zone
const QUIET = 4; // modules of white border, as the QR spec asks
const TEXT_BAND = TEXT ? 30 : 0; // room for the text between the code and the stand
const BOTTOM = 20; // plain white strip at the bottom that goes into the stand
const PLATE_T = 3; // white plate thickness
const INK_T = 1; // height of the black modules on top of the plate
const SLOT_CLEARANCE = 0.5;
const STAND_W = 110;
const TILT_DEG = 12; // the plate leans back this much

// ---- QR matrix from the vendored library (it is a browser script, so run it in a sandbox) ----
const sandbox = { module: { exports: {} } };
sandbox.exports = sandbox.module.exports;
vm.runInNewContext(readFileSync(join(ROOT, 'frontend/vendor/qrcode.js'), 'utf8'), sandbox);
const qr = sandbox.module.exports(0, 'Q');
qr.addData(link);
qr.make();
const n = qr.getModuleCount();
const s = QR_SIZE / (n + 2 * QUIET);
const PLATE_H = QR_SIZE + TEXT_BAND + BOTTOM; // 178 mm with text, fits a 180 mm bed
const QR_X = (PLATE_W - QR_SIZE) / 2;

// ---- STL helpers ----
function stl(tris) {
  const buf = Buffer.alloc(84 + tris.length * 50);
  buf.write('memory book qr sign', 0);
  buf.writeUInt32LE(tris.length, 80);
  let o = 84;
  for (const [a, b, c] of tris) {
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const nx = u[1] * v[2] - u[2] * v[1];
    const ny = u[2] * v[0] - u[0] * v[2];
    const nz = u[0] * v[1] - u[1] * v[0];
    const len = Math.hypot(nx, ny, nz) || 1;
    for (const x of [nx / len, ny / len, nz / len, ...a, ...b, ...c]) {
      buf.writeFloatLE(x, o);
      o += 4;
    }
    o += 2;
  }
  return buf;
}

// Quad given counter clockwise as seen from outside.
const quad = (t, a, b, c, d) => t.push([a, b, c], [a, c, d]);

function box(t, x0, y0, z0, x1, y1, z1) {
  const p = (x, y, z) => [x, y, z];
  quad(t, p(x0, y0, z1), p(x1, y0, z1), p(x1, y1, z1), p(x0, y1, z1)); // top
  quad(t, p(x0, y0, z0), p(x0, y1, z0), p(x1, y1, z0), p(x1, y0, z0)); // bottom
  quad(t, p(x0, y0, z0), p(x1, y0, z0), p(x1, y0, z1), p(x0, y0, z1)); // front
  quad(t, p(x1, y1, z0), p(x0, y1, z0), p(x0, y1, z1), p(x1, y1, z1)); // back
  quad(t, p(x0, y1, z0), p(x0, y0, z0), p(x0, y0, z1), p(x0, y1, z1)); // left
  quad(t, p(x1, y0, z0), p(x1, y1, z0), p(x1, y1, z1), p(x1, y0, z1)); // right
}

// ---- White plate ----
const plate = [];
box(plate, 0, 0, 0, PLATE_W, PLATE_H, PLATE_T);

// ---- Black modules: one closed surface, side walls only where the neighbour is white ----
const dark = (r, c) => r >= 0 && c >= 0 && r < n && c < n && qr.isDark(r, c);
const ink = [];
const z0 = PLATE_T;
const z1 = PLATE_T + INK_T;
for (let r = 0; r < n; r++) {
  for (let c = 0; c < n; c++) {
    if (!dark(r, c)) continue;
    const x0 = QR_X + (c + QUIET) * s;
    const x1 = x0 + s;
    const y1 = PLATE_H - (r + QUIET) * s; // row 0 is the top of the sign
    const y0 = y1 - s;
    quad(ink, [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]);
    quad(ink, [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0]);
    if (!dark(r + 1, c)) quad(ink, [x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]);
    if (!dark(r - 1, c)) quad(ink, [x1, y1, z0], [x0, y1, z0], [x0, y1, z1], [x1, y1, z1]);
    if (!dark(r, c - 1)) quad(ink, [x0, y1, z0], [x0, y0, z0], [x0, y0, z1], [x0, y1, z1]);
    if (!dark(r, c + 1)) quad(ink, [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]);
  }
}

// ---- Raised text in the band under the code ----
function textSolid(t, font, str, capMm, baselineY, maxW) {
  const cap = (font.tables.os2 && font.tables.os2.sCapHeight) || font.unitsPerEm * 0.7;
  let size = (capMm * font.unitsPerEm) / cap;
  const width = font.getAdvanceWidth(str, size);
  if (width > maxW) size *= maxW / width;
  const x0 = (PLATE_W - font.getAdvanceWidth(str, size)) / 2;
  // Flatten the outline into closed rings (font y points down in getPath, so flip it).
  const rings = [];
  let ring = null;
  let last = null;
  const pt = (x, y) => [x0 + x, baselineY - y];
  for (const c of font.getPath(str, 0, 0, size).commands) {
    if (c.type === 'M') {
      ring = [pt(c.x, c.y)];
      rings.push(ring);
    } else if (c.type === 'L') ring.push(pt(c.x, c.y));
    else if (c.type === 'Q' || c.type === 'C') {
      for (let i = 1; i <= 8; i++) {
        const u = i / 8;
        const v = 1 - u;
        const x = c.type === 'Q' ? v * v * last.x + 2 * v * u * c.x1 + u * u * c.x : v * v * v * last.x + 3 * v * v * u * c.x1 + 3 * v * u * u * c.x2 + u * u * u * c.x;
        const y = c.type === 'Q' ? v * v * last.y + 2 * v * u * c.y1 + u * u * c.y : v * v * v * last.y + 3 * v * v * u * c.y1 + 3 * v * u * u * c.y2 + u * u * u * c.y;
        ring.push(pt(x, y));
      }
    }
    if (c.type !== 'Z') last = { x: c.x, y: c.y };
  }
  const clean = rings
    .map((r) => r.filter((p, i) => i === 0 || Math.hypot(p[0] - r[i - 1][0], p[1] - r[i - 1][1]) > 1e-4))
    .map((r) => (Math.hypot(r[0][0] - r[r.length - 1][0], r[0][1] - r[r.length - 1][1]) < 1e-4 ? r.slice(0, -1) : r))
    .filter((r) => r.length >= 3);
  const area = (r) => r.reduce((a, p, i) => a + p[0] * r[(i + 1) % r.length][1] - r[(i + 1) % r.length][0] * p[1], 0) / 2;
  const inside = (p, r) => {
    let hit = false;
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      if (r[i][1] > p[1] !== r[j][1] > p[1] && p[0] < ((r[j][0] - r[i][0]) * (p[1] - r[i][1])) / (r[j][1] - r[i][1]) + r[i][0]) hit = !hit;
    }
    return hit;
  };
  // Even nesting depth is solid, odd is a hole (the inside of an o or an e).
  const info = clean.map((r) => ({ r, depth: clean.filter((o) => o !== r && inside(r[0], o)).length, a: Math.abs(area(r)) }));
  for (const outer of info.filter((x) => x.depth % 2 === 0)) {
    const ccwOuter = area(outer.r) > 0 ? outer.r : outer.r.slice().reverse();
    const holes = info
      .filter((x) => x.depth === outer.depth + 1 && inside(x.r[0], outer.r))
      .map((x) => (area(x.r) < 0 ? x.r : x.r.slice().reverse()));
    const flat = [];
    const holeIdx = [];
    for (const p of ccwOuter) flat.push(p[0], p[1]);
    for (const h of holes) {
      holeIdx.push(flat.length / 2);
      for (const p of h) flat.push(p[0], p[1]);
    }
    const tris = earcut(flat, holeIdx);
    const P = (i, z) => [flat[2 * i], flat[2 * i + 1], z];
    for (let i = 0; i < tris.length; i += 3) {
      let [a, b, c] = [tris[i], tris[i + 1], tris[i + 2]];
      const sa = (flat[2 * b] - flat[2 * a]) * (flat[2 * c + 1] - flat[2 * a + 1]) - (flat[2 * c] - flat[2 * a]) * (flat[2 * b + 1] - flat[2 * a + 1]);
      if (sa < 0) [b, c] = [c, b];
      t.push([P(a, z1), P(b, z1), P(c, z1)], [P(a, z0), P(c, z0), P(b, z0)]);
    }
    for (const r of [ccwOuter, ...holes]) {
      for (let i = 0; i < r.length; i++) {
        const p = r[i];
        const q = r[(i + 1) % r.length];
        quad(t, [p[0], p[1], z0], [q[0], q[1], z0], [q[0], q[1], z1], [p[0], p[1], z1]);
      }
    }
  }
}

let earcut = null;
if (TEXT) {
  const req = createRequire(join(ROOT, 'backend/package.json'));
  const opentype = req('opentype.js');
  earcut = (await import(pathToFileURL(req.resolve('earcut')).href)).default;
  const font = opentype.loadSync(FONT);
  const [l1, l2] = TEXT.split('|');
  const top = BOTTOM + TEXT_BAND;
  if (l2) {
    textSolid(ink, font, l1, 8, top - 11, PLATE_W - 16);
    textSolid(ink, font, l2, 5.5, top - 23, PLATE_W - 24);
  } else {
    textSolid(ink, font, l1, 10, top - 18, PLATE_W - 16);
  }
}

// ---- Black stand: a side profile (y forward to back, z up) extruded along x ----
const t = (TILT_DEG * Math.PI) / 180;
const up = [Math.sin(t), Math.cos(t)]; // along the leaning slot
const across = [Math.cos(t), -Math.sin(t)]; // across the slot
const w = PLATE_T + SLOT_CLEARANCE;
const add = (p, d, k) => [p[0] + d[0] * k, p[1] + d[1] * k];
const A = [30, 4]; // bottom front corner of the slot
const B = add(A, across, w);
const Atop = add(A, up, 14);
const Btop = add(B, up, 22);
const profile = [[0, 0], [70, 0], [70, 6], [Btop[0] + 8, Btop[1]], Btop, B, A, Atop, [Atop[0] - 10, Atop[1]], [0, 6]];

function earClip(poly) {
  const idx = poly.map((_, i) => i);
  const area = poly.reduce((a, p, i) => {
    const q = poly[(i + 1) % poly.length];
    return a + p[0] * q[1] - q[0] * p[1];
  }, 0);
  if (area < 0) idx.reverse();
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const inside = (p, a, b, c) => cross(a, b, p) > 0 && cross(b, c, p) > 0 && cross(c, a, p) > 0;
  const out = [];
  while (idx.length > 3) {
    let cut = false;
    for (let i = 0; i < idx.length; i++) {
      const [ia, ib, ic] = [idx[(i + idx.length - 1) % idx.length], idx[i], idx[(i + 1) % idx.length]];
      const [a, b, c] = [poly[ia], poly[ib], poly[ic]];
      if (cross(a, b, c) <= 0) continue;
      if (idx.some((j) => j !== ia && j !== ib && j !== ic && inside(poly[j], a, b, c))) continue;
      out.push([ia, ib, ic]);
      idx.splice(i, 1);
      cut = true;
      break;
    }
    if (!cut) throw new Error('stand profile could not be triangulated');
  }
  out.push(idx);
  return out;
}

const stand = [];
const P = (x, p) => [x, p[0], p[1]];
// Ear clipped triangles are counter clockwise in (y, z), which faces +x, so the x = 0 cap is reversed.
for (const [a, b, c] of earClip(profile)) {
  stand.push([P(0, profile[a]), P(0, profile[c]), P(0, profile[b])]);
  stand.push([P(STAND_W, profile[a]), P(STAND_W, profile[b]), P(STAND_W, profile[c])]);
}
const ccw = profile.reduce((a, p, i) => {
  const q = profile[(i + 1) % profile.length];
  return a + p[0] * q[1] - q[0] * p[1];
}, 0) > 0;
for (let i = 0; i < profile.length; i++) {
  let p = profile[i];
  let q = profile[(i + 1) % profile.length];
  if (!ccw) [p, q] = [q, p];
  quad(stand, P(0, p), P(0, q), P(STAND_W, q), P(STAND_W, p));
}

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'qr-plate-white.stl'), stl(plate));
writeFileSync(join(outDir, 'qr-code-black.stl'), stl(ink));
writeFileSync(join(outDir, 'qr-stand-black.stl'), stl(stand));
console.log(`QR version ${(n - 17) / 4}, ${n} x ${n} modules, ${s.toFixed(2)} mm each, error correction Q`);
console.log(`Plate ${PLATE_W} x ${PLATE_H} x ${PLATE_T} mm, black modules ${INK_T} mm tall, stand ${STAND_W} x 70 mm`);
console.log(`Wrote ${outDir}`);
