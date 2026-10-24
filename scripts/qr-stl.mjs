// Builds 3D printable STL files for a standing QR sign: a white plate, the black QR modules that sit on
// top of it, and a black stand with a slot the plate drops into. Plate and modules share one coordinate
// frame, so a slicer can load them as one object with two parts (one filament each).
//
//   node scripts/qr-stl.mjs <guest link> [out dir]
//
// Uses the same vendored qrcode-generator as the host page, at error correction level Q so a few bad
// layers or a scuff still scan. Units are millimetres.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const link = process.argv[2];
const outDir = process.argv[3] || join(ROOT, 'print');
if (!/^https:\/\/\S+$/.test(link || '')) {
  console.error('Usage: node scripts/qr-stl.mjs https://<site>/#e=<eventId> [out dir]');
  process.exit(1);
}

const QR_SIZE = 140; // width of the QR including its white quiet zone
const QUIET = 4; // modules of white border, as the QR spec asks
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
const PLATE_H = QR_SIZE + BOTTOM;

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
box(plate, 0, 0, 0, QR_SIZE, PLATE_H, PLATE_T);

// ---- Black modules: one closed surface, side walls only where the neighbour is white ----
const dark = (r, c) => r >= 0 && c >= 0 && r < n && c < n && qr.isDark(r, c);
const ink = [];
const z0 = PLATE_T;
const z1 = PLATE_T + INK_T;
for (let r = 0; r < n; r++) {
  for (let c = 0; c < n; c++) {
    if (!dark(r, c)) continue;
    const x0 = (c + QUIET) * s;
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
console.log(`Plate ${QR_SIZE} x ${PLATE_H} x ${PLATE_T} mm, black modules ${INK_T} mm tall, stand ${STAND_W} x 70 mm`);
console.log(`Wrote ${outDir}`);
