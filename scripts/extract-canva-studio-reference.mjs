// Reuse the approved, user-supplied Canva reference. No image generation.
// Photos are isolated demo/QA material; the real studio uses the user's media.
import path from "node:path";
import fs from "node:fs/promises";
import sharp from "sharp";

const source = process.argv[2];
if (!source) throw new Error("Pass the approved 1487 × 1058 Canva PNG path.");
const metadata = await sharp(source).metadata();
if (metadata.width !== 1487 || metadata.height !== 1058)
  throw new Error("Unexpected reference dimensions.");
const assets = [
  [
    "images/brand/clipsflow-canva-mark.png",
    { left: 28, top: 12, width: 36, height: 38 },
  ],
  [
    "images/shorts-reference/source.webp",
    { left: 24, top: 83, width: 197, height: 111 },
  ],
  // Original mockup thumbnails (their score/time overlays are kept as raster
  // content in the explicitly read-only demo, not duplicated as HTML).
  [
    "images/shorts-reference/moment-1.webp",
    { left: 273, top: 267, width: 294, height: 148 },
  ],
  [
    "images/shorts-reference/moment-2.webp",
    { left: 593, top: 267, width: 246, height: 148 },
  ],
  [
    "images/shorts-reference/moment-3.webp",
    { left: 865, top: 267, width: 230, height: 148 },
  ],
  // Captions belong to this original reference raster; never duplicate them.
  [
    "images/shorts-reference/portrait.webp",
    { left: 1153, top: 127, width: 295, height: 420 },
  ],
  [
    "images/shorts-reference/waveform.webp",
    { left: 274, top: 854, width: 810, height: 86 },
  ],
];
for (const [relative, crop] of assets) {
  const target = path.resolve("public", relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const pipeline = sharp(source).extract(crop);
  await (
    relative.endsWith(".png") ? pipeline.png() : pipeline.webp({ quality: 95 })
  ).toFile(target);
  console.log(relative);
}
