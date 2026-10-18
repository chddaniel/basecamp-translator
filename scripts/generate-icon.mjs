// Reproducible, dependency-free directory icon. No external images or fonts.
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
const size = 256;
const pixels = Buffer.alloc(size * size * 4);
function pixel(x, y, color) { if (x >= 0 && x < size && y >= 0 && y < size) pixels.set([...color, 255], (y * size + x) * 4); }
function rounded(x, y, w, height, r, color) {
  for (let yy = y; yy < y + height; yy++) for (let xx = x; xx < x + w; xx++) {
    const dx = Math.max(x + r - xx, 0, xx - (x + w - r - 1));
    const dy = Math.max(y + r - yy, 0, yy - (y + height - r - 1));
    if (dx * dx + dy * dy <= r * r) pixel(xx, yy, color);
  }
}
const glyphs = { A: ['01110','10001','10001','11111','10001','10001','10001'], 文: ['00100','11111','01010','01010','00100','01010','10001'] };
function label(text, x, y) {
  [...text].forEach((char, index) => glyphs[char].forEach((row, yy) => [...row].forEach((bit, xx) => {
    if (bit === '1') rounded(x + index * 36 + xx * 6, y + yy * 6, 6, 6, 0, [23, 99, 79]);
  })));
}
rounded(0, 0, 256, 256, 0, [244, 247, 246]);
rounded(8, 8, 240, 240, 48, [23, 99, 79]);
rounded(30, 42, 112, 68, 13, [255, 255, 255]); label('A', 71, 55);
rounded(114, 146, 112, 68, 13, [255, 255, 255]); label('文', 155, 159);
// Two simple turn arrows between the language bubbles.
rounded(170, 63, 12, 53, 4, [171, 225, 191]);
rounded(162, 106, 28, 10, 3, [171, 225, 191]);
rounded(74, 140, 12, 53, 4, [171, 225, 191]);
rounded(66, 140, 28, 10, 3, [171, 225, 191]);
function crc32(buffer) {
  let crc = -1;
  for (const byte of buffer) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  return (crc ^ -1) >>> 0;
}
function chunk(name, data) {
  const type = Buffer.from(name); const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4); checksum.writeUInt32BE(crc32(Buffer.concat([type, data])));
  return Buffer.concat([length, type, data, checksum]);
}
const header = Buffer.alloc(13); header.writeUInt32BE(size); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
const rows = Buffer.concat(Array.from({ length: size }, (_, y) => Buffer.concat([Buffer.from([0]), pixels.subarray(y * size * 4, (y + 1) * size * 4)])));
writeFileSync(new URL('../docs/icon.png', import.meta.url), Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]));
