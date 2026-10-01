#!/usr/bin/env node
/**
 * Generate FocusBro's native icons + splash from the brand mark.
 *
 * The brand mark is the site's `.logo-icon` (public/index.html): the 🧠 emoji on
 * a 135° gradient from --primary (#0ea5e9) to --teal (#14b8a6), on the app's
 * --bg (#0a0e27). The emoji artwork is Noto Emoji's U+1F9E0 (assets/noto-brain.svg,
 * Apache-2.0, github.com/googlefonts/noto-emoji) — a fixed vector, so the icon
 * does not change with whatever emoji font the build host happens to have.
 *
 * Outputs (Android):
 *   - Adaptive icon (API 26+): gradient background layer (vector drawable,
 *     written by hand in res/drawable/ic_launcher_background.xml), the brain on
 *     a transparent 108dp foreground canvas inside the 66dp safe zone, and a
 *     monochrome layer for Android 13 themed icons.
 *   - Legacy square + round launcher PNGs for API 24–25.
 *   - Notification small icon `ic_stat_focusbro` (white silhouette — Android
 *     tints it; a colour icon renders as a white square).
 *   - Splash PNGs (pre-Android-12 path) on #0a0e27.
 * Outputs (iOS): the 1024px AppIcon and the splash imageset.
 *
 * Never ship Capacitor's default assets — on SELF:PRIME the vendor's blue-X
 * splash reached a real device before anyone noticed.
 *
 * Usage (from mobile/): npm run icons
 */
import sharp from 'sharp';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MOBILE = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BRAIN_SVG = readFileSync(resolve(MOBILE, 'assets/noto-brain.svg'));
const RES = resolve(MOBILE, 'android/app/src/main/res');
const IOS_ASSETS = resolve(MOBILE, 'ios/App/App/Assets.xcassets');

const PRIMARY = '#0ea5e9';
const TEAL = '#14b8a6';
const BG = { r: 10, g: 14, b: 39, alpha: 1 }; // #0a0e27
const CLEAR = { r: 0, g: 0, b: 0, alpha: 0 };

const brain = (size) => sharp(BRAIN_SVG, { density: 600 }).resize(size, size, { fit: 'contain', background: CLEAR }).png().toBuffer();

/**
 * White silhouette of the brain — for the monochrome and notification icons.
 * The darker fold lines are cut out (alpha 0) so the shape still reads as a
 * brain at 24dp instead of a white blob.
 */
async function silhouette(size) {
  const { data, info } = await sharp(await brain(size)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let i = 0; i < data.length; i += 4) {
    const fold = data[i + 1] < 135; // light pink lobes have G≈170; the folds are much darker
    data[i] = 255; data[i + 1] = 255; data[i + 2] = 255;
    if (fold) data[i + 3] = 0;
  }
  return sharp(data, { raw: info }).png().toBuffer();
}

/** The full mark: gradient tile + brain. `shape` = 'square' (rounded) | 'circle' | 'full'. */
async function mark(size, shape = 'square') {
  const r = shape === 'circle' ? size / 2 : shape === 'square' ? Math.round(size * 0.22) : 0;
  const tile = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
       <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
         <stop offset="0" stop-color="${PRIMARY}"/><stop offset="1" stop-color="${TEAL}"/>
       </linearGradient></defs>
       <rect width="${size}" height="${size}" rx="${r}" ry="${r}" fill="url(#g)"/>
     </svg>`,
  );
  const inner = Math.round(size * 0.58);
  return sharp(tile).composite([{ input: await brain(inner), gravity: 'center' }]).png().toBuffer();
}

const write = (dir, name, buf) => {
  const out = resolve(RES, dir);
  mkdirSync(out, { recursive: true });
  writeFileSync(resolve(out, name), buf);
};

// ── Launcher icons ───────────────────────────────────────────────────────────
// [density dir, legacy launcher px (48dp), adaptive layer px (108dp), notification px (24dp)]
const DENSITIES = [
  ['mdpi', 48, 108, 24], ['hdpi', 72, 162, 36], ['xhdpi', 96, 216, 48],
  ['xxhdpi', 144, 324, 72], ['xxxhdpi', 192, 432, 96],
];

for (const [d, legacy, layer, notif] of DENSITIES) {
  write(`mipmap-${d}`, 'ic_launcher.png', await mark(legacy, 'square'));
  write(`mipmap-${d}`, 'ic_launcher_round.png', await mark(legacy, 'circle'));
  // Adaptive foreground: 108dp canvas, the visible mask is the inner 72dp and the
  // guaranteed-safe zone is the inner 66dp circle. The brain sits at 56dp.
  const fg = Math.round(layer * (56 / 108));
  const canvas = { create: { width: layer, height: layer, channels: 4, background: CLEAR } };
  write(`mipmap-${d}`, 'ic_launcher_foreground.png',
    await sharp(canvas).composite([{ input: await brain(fg), gravity: 'center' }]).png().toBuffer());
  write(`mipmap-${d}`, 'ic_launcher_monochrome.png',
    await sharp(canvas).composite([{ input: await silhouette(fg), gravity: 'center' }]).png().toBuffer());
  // Notification small icon: 24dp with ~2dp padding.
  const nCanvas = { create: { width: notif, height: notif, channels: 4, background: CLEAR } };
  write(`drawable-${d}`, 'ic_stat_focusbro.png',
    await sharp(nCanvas).composite([{ input: await silhouette(Math.round(notif * 0.84)), gravity: 'center' }]).png().toBuffer());
  console.log(`icons ${d}`);
}

// ── Splash screens (pre-Android-12; 12+ uses the adaptive icon on windowSplashScreenBackground) ──
const SPLASHES = [
  ['drawable', 480, 320], ['drawable-land-mdpi', 480, 320], ['drawable-land-hdpi', 800, 480],
  ['drawable-land-xhdpi', 1280, 720], ['drawable-land-xxhdpi', 1600, 960], ['drawable-land-xxxhdpi', 1920, 1280],
  ['drawable-port-mdpi', 320, 480], ['drawable-port-hdpi', 480, 800],
  ['drawable-port-xhdpi', 720, 1280], ['drawable-port-xxhdpi', 960, 1600], ['drawable-port-xxxhdpi', 1280, 1920],
];
for (const [dir, w, h] of SPLASHES) {
  const m = await mark(Math.round(Math.min(w, h) * 0.3), 'square');
  write(dir, 'splash.png',
    await sharp({ create: { width: w, height: h, channels: 4, background: BG } }).composite([{ input: m, gravity: 'center' }]).png().toBuffer());
}
console.log('splash android');

// ── Play Store icon (512, full-bleed; Play applies its own mask) ─────────────
mkdirSync(resolve(MOBILE, 'store'), { recursive: true });
writeFileSync(resolve(MOBILE, 'store/icon-512.png'), await mark(512, 'full'));

// ── iOS ──────────────────────────────────────────────────────────────────────
// AppIcon: one 1024px, no alpha (App Store rejects transparency), full-bleed —
// iOS applies its own corner mask.
const iosIcon = await sharp(await mark(1024, 'full')).flatten({ background: BG }).png().toBuffer();
writeFileSync(resolve(IOS_ASSETS, 'AppIcon.appiconset/AppIcon-512@2x.png'), iosIcon);
for (const name of ['splash-2732x2732.png', 'splash-2732x2732-1.png', 'splash-2732x2732-2.png']) {
  const m = await mark(820, 'square');
  writeFileSync(resolve(IOS_ASSETS, 'Splash.imageset', name),
    await sharp({ create: { width: 2732, height: 2732, channels: 4, background: BG } }).composite([{ input: m, gravity: 'center' }]).flatten({ background: BG }).png().toBuffer());
}
console.log('ios icon + splash');
