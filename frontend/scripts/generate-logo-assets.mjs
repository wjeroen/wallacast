// Regenerates every wallacast logo asset from the master SVG.
//
// For each existing PNG it: reads the canvas size, samples the corner pixel to
// learn the background (transparent or a solid color), measures the bounding
// box of the old artwork, then renders the recolored master SVG to fit that
// same box on the same background. So every file keeps its exact layout
// (favicon full-bleed, launcher safe-zones, splash margins) with the new mark.
//
// Usage (from frontend/): npm i --no-save sharp
//                          node scripts/generate-logo-assets.mjs scripts/wallacast-logo.svg public [--dry]
import fs from 'fs/promises';
import path from 'path';
import sharp from 'sharp';

// Manifest icons with purpose "maskable": launchers may crop them to a circle,
// so the mark is clamped to the safe zone (inscribed square of the 80% circle).
const MASKABLE = new Set([
  'AppIcons/android/android-launchericon-192-192.png',
  'AppIcons/android/android-launchericon-512-512.png',
]);

const BRAND = '#60a5fa'; // the app accent, same blue as the header wordmark

// Backgrounds snap to the app's real palette (from App.css theme vars) instead
// of trusting the old files' pixels, which could be off-shade like the old mark.
const PALETTE = [
  { hex: '#0f172a', rgb: [15, 23, 42] },   // --bg-app (dark)
  { hex: '#1e293b', rgb: [30, 41, 59] },   // --bg-surface (dark)
  { hex: '#ffffff', rgb: [255, 255, 255] }, // --bg-surface (light)
];
function snapToPalette(rgb) {
  let best = null, bestD = Infinity;
  for (const p of PALETTE) {
    const d = Math.abs(rgb[0] - p.rgb[0]) + Math.abs(rgb[1] - p.rgb[1]) + Math.abs(rgb[2] - p.rgb[2]);
    if (d < bestD) { bestD = d; best = p; }
  }
  // snap only when plausibly "the same" color; otherwise keep the sample
  return bestD <= 90 ? best : { hex: 'sampled', rgb };
}

const [, , masterPath, publicDir, flag] = process.argv;
const dry = flag === '--dry';
if (!masterPath || !publicDir) {
  console.error('usage: node generate-logo-assets.mjs <master.svg> <publicDir> [--dry]');
  process.exit(1);
}

const svgSource = (await fs.readFile(masterPath, 'utf-8'))
  .replaceAll('stroke:black', `stroke:${BRAND}`);
const svgBuf = Buffer.from(svgSource);
const svgMeta = await sharp(svgBuf).metadata();
const SVG_W = svgMeta.width || 2000;

// Collect every PNG we manage.
async function collect(dir) {
  const out = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await collect(p));
    else if (entry.name.toLowerCase().endsWith('.png')) out.push(p);
  }
  return out;
}
const candidates = (await collect(publicDir)).filter(p => {
  const rel = path.relative(publicDir, p).replaceAll('\\', '/');
  if (rel.startsWith('landing/')) return false; // screenshots, not logos
  return rel.startsWith('AppIcons/') || /^(logo-|favicon-|icon-)/.test(path.basename(rel));
});

// Render the recolored SVG at a given box (contain), returns {buf, w, h}.
async function renderLogo(maxW, maxH) {
  const scale = Math.min(maxW, maxH) / SVG_W;
  const density = Math.max(1, Math.ceil(72 * scale * 1.05));
  let img = sharp(svgBuf, { density });
  const buf = await img.resize(Math.max(1, Math.round(maxW)), Math.max(1, Math.round(maxH)), {
    fit: 'inside',
    withoutEnlargement: false,
  }).png().toBuffer();
  const meta = await sharp(buf).metadata();
  return { buf, w: meta.width, h: meta.height };
}

const report = [];
for (const file of candidates) {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: W, height: H, channels } = info;
  const px = (x, y) => {
    const i = (y * W + x) * channels;
    return [data[i], data[i + 1], data[i + 2], data[i + 3]];
  };
  const corner = px(0, 0);
  const transparentBg = corner[3] < 10;
  const isContent = (x, y) => {
    const [r, g, b, a] = px(x, y);
    if (transparentBg) return a > 20;
    return Math.abs(r - corner[0]) + Math.abs(g - corner[1]) + Math.abs(b - corner[2]) > 60 && a > 20;
  };
  // bounding box of the old artwork
  let minX = W, minY = H, maxX = -1, maxY = -1;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (isContent(x, y)) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) { report.push({ file, note: 'NO CONTENT FOUND, skipped' }); continue; }
  const boxW = maxX - minX + 1;
  const boxH = maxY - minY + 1;
  const cx = (minX + maxX + 1) / 2;
  const cy = (minY + maxY + 1) / 2;

  // The new mark is square-ish while the old one was wider than tall, so a
  // plain "contain" would undersize it. Match the old WIDTH presence, capped
  // so the height keeps a small margin, and clamp maskable icons to the safe
  // zone a circular crop leaves (0.8 / sqrt(2) of the canvas).
  const rel = path.relative(publicDir, file).replaceAll('\\', '/');
  let target = boxW;
  target = Math.min(target, Math.floor(H * 0.92), Math.floor(W * 0.94));
  if (MASKABLE.has(rel)) target = Math.min(target, Math.floor(Math.min(W, H) * 0.56));

  const logo = await renderLogo(target, target);
  const left = Math.round(cx - logo.w / 2);
  const top = Math.round(cy - logo.h / 2);

  const snapped = transparentBg ? null : snapToPalette([corner[0], corner[1], corner[2]]);
  const background = transparentBg
    ? { r: 0, g: 0, b: 0, alpha: 0 }
    : { r: snapped.rgb[0], g: snapped.rgb[1], b: snapped.rgb[2], alpha: 1 };

  report.push({
    file: path.relative(publicDir, file),
    size: `${W}x${H}`,
    bg: transparentBg ? 'transparent' : snapped.hex,
    oldBox: `${boxW}x${boxH} @ ${Math.round((boxW / W) * 100)}%`,
  });

  if (!dry) {
    await sharp({ create: { width: W, height: H, channels: 4, background } })
      .composite([{ input: logo.buf, left, top }])
      .png()
      .toFile(file + '.tmp');
    await fs.rename(file + '.tmp', file);
  }
}

console.table(report);
console.log(`${dry ? 'DRY RUN, ' : ''}${report.length} files processed`);
