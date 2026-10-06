import sharp from "sharp";

const [referencePath, implementationPath, outputPath] = process.argv.slice(2);
if (!referencePath || !implementationPath || !outputPath) {
  throw new Error(
    "Usage: node scripts/compare-shorts-design.mjs reference screenshot output",
  );
}

const reference = sharp(referencePath);
const implementation = sharp(implementationPath);
const [referenceSize, implementationSize] = await Promise.all([
  reference.metadata(),
  implementation.metadata(),
]);
if (
  referenceSize.width !== implementationSize.width ||
  referenceSize.height !== implementationSize.height
) {
  throw new Error(
    "Compare the same viewport and state; screenshots must have identical dimensions.",
  );
}
const width = referenceSize.width;
const height = referenceSize.height;
const gap = 24;
const headingHeight = 48;
const labels = Buffer.from(
  `<svg width="${width * 2 + gap}" height="${headingHeight}" xmlns="http://www.w3.org/2000/svg"><g font-family="Arial,sans-serif" font-size="22" fill="#f5f7ff"><text x="20" y="31">Canva : direction validée</text><text x="${width + gap + 20}" y="31">ClipsFlow : interface locale, données de démonstration</text></g></svg>`,
);
await sharp({
  create: {
    width: width * 2 + gap,
    height: height + headingHeight,
    channels: 3,
    background: "#061120",
  },
})
  .composite([
    { input: labels, left: 0, top: 0 },
    { input: await reference.png().toBuffer(), left: 0, top: headingHeight },
    {
      input: await implementation.png().toBuffer(),
      left: width + gap,
      top: headingHeight,
    },
  ])
  .png()
  .toFile(outputPath);
console.log(`Same-state comparison saved: ${width} × ${height} per panel.`);
