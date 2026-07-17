import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const [iconsetDirectory, outputFile] = process.argv.slice(2);
if (!iconsetDirectory || !outputFile) {
  throw new Error("Usage: node make-icns.mjs <iconset-directory> <output.icns>");
}

const entries = [
  ["icp4", "icon_16x16.png"],
  ["icp5", "icon_32x32.png"],
  ["icp6", "icon_32x32@2x.png"],
  ["ic07", "icon_128x128.png"],
  ["ic08", "icon_256x256.png"],
  ["ic09", "icon_512x512.png"],
  ["ic10", "icon_512x512@2x.png"],
].map(([type, filename]) => {
  const image = readFileSync(path.join(iconsetDirectory, filename));
  const entry = Buffer.alloc(8 + image.length);
  entry.write(type, 0, 4, "ascii");
  entry.writeUInt32BE(entry.length, 4);
  image.copy(entry, 8);
  return entry;
});

const totalLength = 8 + entries.reduce((sum, entry) => sum + entry.length, 0);
const header = Buffer.alloc(8);
header.write("icns", 0, 4, "ascii");
header.writeUInt32BE(totalLength, 4);
writeFileSync(outputFile, Buffer.concat([header, ...entries], totalLength));
