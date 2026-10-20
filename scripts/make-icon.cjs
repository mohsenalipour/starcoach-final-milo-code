"use strict";
// Small code-native mark, rasterised without external image tooling.
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const b of bytes) {
    crc ^= b;
    for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const kind = Buffer.from(type),
    out = Buffer.alloc(data.length + 12);
  out.writeUInt32BE(data.length, 0);
  kind.copy(out, 4);
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([kind, data])), data.length + 8);
  return out;
}
function polygon(x, y, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i],
      [xj, yj] = points[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi)
      inside = !inside;
  }
  return inside;
}
function png(size) {
  const pixels = Buffer.alloc((size * 4 + 1) * size),
    points = [
      [26, 88],
      [26, 40],
      [39, 40],
      [64, 69],
      [89, 40],
      [102, 40],
      [102, 88],
      [87, 88],
      [87, 63],
      [64, 89],
      [41, 63],
      [41, 88],
    ];
  for (let y = 0; y < size; y++) {
    const offset = y * (size * 4 + 1);
    for (let x = 0; x < size; x++) {
      const px = ((x + 0.5) * 128) / size,
        py = ((y + 0.5) * 128) / size,
        cx = Math.max(34, Math.min(94, px)),
        cy = Math.max(34, Math.min(94, py));
      if ((px - cx) ** 2 + (py - cy) ** 2 > 34 ** 2) continue;
      let color = [184, 164, 252, 255];
      if (polygon(px, py, points)) color = [24, 19, 36, 255];
      if ((px - 99) ** 2 + (py - 29) ** 2 < 49) color = [244, 236, 222, 255];
      pixels.set(color, offset + 1 + x * 4);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", zlib.deflateSync(pixels)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
const sizes = [16, 32, 48, 64, 128, 256],
  images = sizes.map(png),
  header = Buffer.alloc(6 + 16 * sizes.length);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(sizes.length, 4);
let offset = header.length;
for (let i = 0; i < sizes.length; i++) {
  const p = 6 + i * 16;
  header[p] = sizes[i] === 256 ? 0 : sizes[i];
  header[p + 1] = header[p];
  header.writeUInt16LE(1, p + 4);
  header.writeUInt16LE(32, p + 6);
  header.writeUInt32LE(images[i].length, p + 8);
  header.writeUInt32LE(offset, p + 12);
  offset += images[i].length;
}
const root = path.join(__dirname, "../assets");
fs.mkdirSync(root, { recursive: true });
fs.writeFileSync(
  path.join(root, "milo.ico"),
  Buffer.concat([header, ...images]),
);
fs.writeFileSync(path.join(root, "milo.png"), images.at(-1));
console.log("Milo icon generated (16–256 px).");
