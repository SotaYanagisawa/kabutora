import fs from "node:fs/promises";
import sharp from "sharp";

const [source, output, requestedSize] = process.argv.slice(2);

if (!source || !output) {
  throw new Error("Usage: render-icon.mjs <source.svg> <output.png> [size]");
}

const size = requestedSize ? Number(requestedSize) : 1024;
if (!Number.isInteger(size) || size < 32 || size > 2048) throw new Error("Icon size must be an integer from 32 to 2048");

const buffer = await fs.readFile(source);
const isSvg = source.toLowerCase().endsWith(".svg") || buffer.slice(0, 100).includes(Buffer.from("<svg"));
const pipeline = isSvg ? sharp(buffer, { density: 192 }) : sharp(buffer);

await pipeline
  .resize(size, size)
  .png()
  .toFile(output);
