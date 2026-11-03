// Draws the app icon from the logo mark (assets/readme, packages/vscode/media/
// icon.svg): three round-capped strokes converging on a teal dot, on a dark
// rounded tile. Kept as a script, with no image dependency, so the files in
// build/ can be redrawn rather than edited by hand:
//
//   node packages/desktop/scripts/app-icon.mjs
//
// Writes build/icon.png (1024), build/icons/<n>x<n>.png (Linux), build/icon.icns
// (macOS) and build/icon.ico (Windows), the paths electron-builder.yml names.
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';

// The mark's own geometry, in icon.svg's coordinates (a 400x280 view box whose
// strokes are 26 wide). Copied, not parsed, so this file needs no SVG reader.
const STROKE = 26;
const CURVES = [
  [[72, 142], [190, 142], [232, 256], [336, 256]],
  [[72, 256], [72 + 88, 256], [72 + 176, 256], [336, 256]],
  [[72, 370], [190, 370], [232, 256], [336, 256]],
];
const DOT = { x: 392, y: 256, r: 40 };
// The mark's centre and extent, so it can be centred on the tile.
const MARK = { cx: (72 - STROKE / 2 + DOT.x + DOT.r) / 2, cy: 256, width: DOT.x + DOT.r - (72 - STROKE / 2) };

const COLORS = {
  tile: [22, 23, 26],
  stroke: [230, 232, 236],
  dot: [8, 145, 178],
};

// macOS's icon grid: the tile is 824 of 1024, centred, with a 22.4% corner.
const MASTER = 1024;
const TILE = 824;
const TILE_RADIUS = 185;
// How much of the tile's width the mark spans.
const MARK_SPAN = 0.62;
const SUPERSAMPLE = 3;

function bezier([p0, p1, p2, p3], steps) {
  const points = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const u = 1 - t;
    points.push([
      u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
      u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1],
    ]);
  }
  return points;
}

/** Each stroke as straight segments in master pixels, with a bounding box for cheap rejection. */
function strokeSegments() {
  const scale = (TILE * MARK_SPAN) / MARK.width;
  const place = ([x, y]) => [MASTER / 2 + (x - MARK.cx) * scale, MASTER / 2 + (y - MARK.cy) * scale];
  const half = (STROKE * scale) / 2;
  const segments = [];
  for (const curve of CURVES) {
    const points = bezier(curve, 64).map(place);
    for (let i = 1; i < points.length; i++) {
      const [ax, ay] = points[i - 1];
      const [bx, by] = points[i];
      segments.push({ ax, ay, bx, by, minX: Math.min(ax, bx) - half, maxX: Math.max(ax, bx) + half, minY: Math.min(ay, by) - half, maxY: Math.max(ay, by) + half });
    }
  }
  const [dx, dy] = place([DOT.x, DOT.y]);
  return { segments, half, dot: { x: dx, y: dy, r: DOT.r * scale } };
}

function distanceToSegment(px, py, s) {
  const vx = s.bx - s.ax;
  const vy = s.by - s.ay;
  const len = vx * vx + vy * vy;
  const t = len === 0 ? 0 : Math.max(0, Math.min(1, ((px - s.ax) * vx + (py - s.ay) * vy) / len));
  return Math.hypot(px - (s.ax + t * vx), py - (s.ay + t * vy));
}

/** The master icon as premultiplied float RGBA, MASTER x MASTER, anti-aliased by supersampling. */
function renderMaster() {
  const { segments, half, dot } = strokeSegments();
  const out = new Float32Array(MASTER * MASTER * 4);
  const inset = (MASTER - TILE) / 2;
  const insideTile = (x, y) => {
    // Distance to the rounded rectangle: clamp into the inner rectangle the
    // corner circles' centres span, and compare with the radius.
    const qx = Math.max(inset + TILE_RADIUS, Math.min(MASTER - inset - TILE_RADIUS, x));
    const qy = Math.max(inset + TILE_RADIUS, Math.min(MASTER - inset - TILE_RADIUS, y));
    return x >= inset && x <= MASTER - inset && y >= inset && y <= MASTER - inset && Math.hypot(x - qx, y - qy) <= TILE_RADIUS;
  };
  const near = segments;
  const samples = SUPERSAMPLE * SUPERSAMPLE;
  for (let y = 0; y < MASTER; y++) {
    for (let x = 0; x < MASTER; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SUPERSAMPLE; sy++) {
        for (let sx = 0; sx < SUPERSAMPLE; sx++) {
          const px = x + (sx + 0.5) / SUPERSAMPLE;
          const py = y + (sy + 0.5) / SUPERSAMPLE;
          if (!insideTile(px, py)) continue;
          let color = COLORS.tile;
          if (Math.hypot(px - dot.x, py - dot.y) <= dot.r) {
            color = COLORS.dot;
          } else {
            for (const s of near) {
              if (px < s.minX || px > s.maxX || py < s.minY || py > s.maxY) continue;
              if (distanceToSegment(px, py, s) <= half) {
                color = COLORS.stroke;
                break;
              }
            }
          }
          r += color[0];
          g += color[1];
          b += color[2];
          a += 1;
        }
      }
      const i = (y * MASTER + x) * 4;
      // Premultiplied: colour summed over the covered samples, alpha their share.
      out[i] = r / samples;
      out[i + 1] = g / samples;
      out[i + 2] = b / samples;
      out[i + 3] = (a / samples) * 255;
    }
  }
  return out;
}

/** Box-filter `master` down to `size`; each output pixel averages the pixels it covers. */
function downscale(master, size) {
  if (size === MASTER) return master;
  const factor = MASTER / size;
  const out = new Float32Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const acc = [0, 0, 0, 0];
      for (let sy = 0; sy < factor; sy++) {
        for (let sx = 0; sx < factor; sx++) {
          const i = ((y * factor + sy) * MASTER + x * factor + sx) * 4;
          for (let c = 0; c < 4; c++) acc[c] += master[i + c];
        }
      }
      const o = (y * size + x) * 4;
      for (let c = 0; c < 4; c++) out[o + c] = acc[c] / (factor * factor);
    }
  }
  return out;
}

const CRC = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
const crc32 = (buf) => {
  let c = -1;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

/** A straight (not premultiplied) 8-bit RGBA PNG of the premultiplied float pixels. */
export function encodePng(pixels, size) {
  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 4);
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const alpha = pixels[i + 3];
      // The colour channels hold the colour times coverage, so dividing by
      // coverage gives the colour the covered part of the pixel has.
      const unit = alpha > 0 ? 255 / alpha : 0;
      row[1 + x * 4] = Math.round(Math.min(255, pixels[i] * unit));
      row[2 + x * 4] = Math.round(Math.min(255, pixels[i + 1] * unit));
      row[3 + x * 4] = Math.round(Math.min(255, pixels[i + 2] * unit));
      row[4 + x * 4] = Math.round(alpha);
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(rows), { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * An ICNS container. Every entry is a PNG, which macOS 10.7 and later read, so
 * no `iconutil` is needed and the file can be made on any OS. The type codes
 * name the pixel size and whether the entry is the @2x of a smaller point size.
 */
export const ICNS_TYPES = [
  ['icp4', 16], ['icp5', 32], ['icp6', 64], ['ic07', 128], ['ic08', 256], ['ic09', 512], ['ic10', 1024],
  ['ic11', 32], ['ic12', 64], ['ic13', 256], ['ic14', 512],
];
export function encodeIcns(pngBySize) {
  const entries = ICNS_TYPES.map(([type, size]) => {
    const png = pngBySize.get(size);
    const head = Buffer.alloc(8);
    head.write(type, 0, 'ascii');
    head.writeUInt32BE(png.length + 8, 4);
    return Buffer.concat([head, png]);
  });
  const total = 8 + entries.reduce((sum, e) => sum + e.length, 0);
  const head = Buffer.alloc(8);
  head.write('icns', 0, 'ascii');
  head.writeUInt32BE(total, 4);
  return Buffer.concat([head, ...entries]);
}

/** An ICO whose entries are PNGs (Windows Vista and later); 256 is stored as 0 in the directory. */
export const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
export function encodeIco(pngBySize) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(ICO_SIZES.length, 4);
  const directory = [];
  const images = [];
  let offset = 6 + 16 * ICO_SIZES.length;
  for (const size of ICO_SIZES) {
    const png = pngBySize.get(size);
    const entry = Buffer.alloc(16);
    entry[0] = size === 256 ? 0 : size;
    entry[1] = size === 256 ? 0 : size;
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += png.length;
    directory.push(entry);
    images.push(png);
  }
  return Buffer.concat([header, ...directory, ...images]);
}

/** Linux's set: one PNG per size in build/icons, named by electron-builder's NxN convention. */
export const LINUX_SIZES = [16, 24, 32, 48, 64, 128, 256, 512, 1024];

/** Every file this script writes, relative to the build directory, as Buffers. */
export function renderIconFiles() {
  const master = renderMaster();
  const sizes = [...new Set([...ICNS_TYPES.map(([, s]) => s), ...ICO_SIZES, ...LINUX_SIZES])];
  const pngBySize = new Map(sizes.map((size) => [size, encodePng(downscale(master, size), size)]));
  const files = new Map([
    ['icon.png', pngBySize.get(1024)],
    ['icon.icns', encodeIcns(pngBySize)],
    ['icon.ico', encodeIco(pngBySize)],
  ]);
  for (const size of LINUX_SIZES) files.set(`icons/${size}x${size}.png`, pngBySize.get(size));
  return files;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const out = fileURLToPath(new URL('../build/', import.meta.url));
  mkdirSync(`${out}icons`, { recursive: true });
  for (const [name, data] of renderIconFiles()) {
    writeFileSync(`${out}${name}`, data);
    console.log(`wrote build/${name} (${data.length} bytes)`);
  }
}
