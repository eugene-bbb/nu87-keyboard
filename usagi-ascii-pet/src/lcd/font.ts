/**
 * Bitmap font, 1 bit per pixel, ASCII 32..126 — the same layout an MCU font table uses (see export.ts).
 * - Text glyphs come from a system monospace font, thresholded.
 * - The shading ramp + sparkle glyphs are hand-drawn 6×8 designs (so density steps look right on a
 *   tiny LCD) and are area-resampled for the other cell sizes.
 */
export interface Font {
  cw: number; ch: number;
  /** 1 byte per pixel (0/1), 95 glyphs, glyph-major */
  bits: Uint8Array;
}

const FIRST = 32, COUNT = 95;
const FAMILY = '"SF Mono", Menlo, Monaco, Consolas, "DejaVu Sans Mono", "Courier New", monospace';

const DESIGN: Record<string, string[]> = {
  '.': ['......', '......', '......', '......', '......', '..##..', '..##..', '......'],
  ',': ['......', '......', '......', '......', '..##..', '..##..', '..#...', '.#....'],
  ':': ['......', '..##..', '..##..', '......', '......', '..##..', '..##..', '......'],
  ';': ['......', '..##..', '..##..', '......', '..##..', '..##..', '..#...', '.#....'],
  '-': ['......', '......', '......', '.####.', '.####.', '......', '......', '......'],
  '=': ['......', '.####.', '.####.', '......', '.####.', '.####.', '......', '......'],
  '+': ['......', '..##..', '..##..', '.####.', '.####.', '..##..', '..##..', '......'],
  '*': ['......', '#.##.#', '.####.', '######', '.####.', '#.##.#', '......', '......'],
  '#': ['.#..#.', '.#..#.', '######', '.#..#.', '.#..#.', '######', '.#..#.', '.#..#.'],
  '%': ['###..#', '###.##', '#..##.', '..##..', '.##..#', '##.###', '#..###', '......'],
  '@': ['.####.', '######', '##..##', '##.###', '######', '##....', '######', '.####.'],
  o: ['......', '.####.', '##..##', '##..##', '##..##', '.####.', '......', '......'],
  "'": ['..##..', '..##..', '..#...', '......', '......', '......', '......', '......'],
  '`': ['.##...', '..##..', '......', '......', '......', '......', '......', '......'],
  z: ['......', '......', '.####.', '...##.', '..##..', '.##...', '.####.', '......'],
  Z: ['.#####', '....##', '...##.', '..##..', '.##...', '##....', '######', '......'],
};

function resample(rows: string[], cw: number, ch: number): number[] {
  const out: number[] = [];
  for (let y = 0; y < ch; y++)
    for (let x = 0; x < cw; x++) {
      const x0 = (x * 6) / cw, x1 = ((x + 1) * 6) / cw, y0 = (y * 8) / ch, y1 = ((y + 1) * 8) / ch;
      let a = 0, area = 0;
      for (let sy = Math.floor(y0); sy < Math.ceil(y1); sy++)
        for (let sx = Math.floor(x0); sx < Math.ceil(x1); sx++) {
          const w = (Math.min(x1, sx + 1) - Math.max(x0, sx)) * (Math.min(y1, sy + 1) - Math.max(y0, sy));
          area += w;
          if (rows[sy]?.[sx] === '#') a += w;
        }
      out.push(a / area > 0.34 ? 1 : 0);
    }
  return out;
}

/** hand-made 4×5 ramp for the densest preset (resampling the 6×8 art would produce bar-like glyphs) */
const TINY: Record<string, string[]> = {
  '.': ['....', '....', '....', '.#..', '....'],
  ':': ['....', '.#..', '....', '.#..', '....'],
  ';': ['....', '.#..', '....', '.#..', '#...'],
  ',': ['....', '....', '.#..', '.#..', '#...'],
  '-': ['....', '....', '###.', '....', '....'],
  '=': ['....', '###.', '....', '###.', '....'],
  '+': ['....', '.#..', '###.', '.#..', '....'],
  '*': ['#.#.', '.#..', '#.#.', '.#..', '....'],
  '#': ['#.#.', '###.', '#.#.', '###.', '#.#.'],
  '%': ['###.', '#.##', '.##.', '##.#', '.###'],
  '@': ['####', '#.##', '#.##', '#...', '####'],
  o: ['....', '.##.', '#..#', '.##.', '....'],
  "'": ['.#..', '.#..', '....', '....', '....'],
  '`': ['#...', '.#..', '....', '....', '....'],
  z: ['....', '###.', '.#..', '###.', '....'],
  Z: ['###.', '..#.', '.#..', '#...', '###.'],
};

/** DOM-free 4x5 font used by the command-line animation exporter. */
export function makeTinyLcdFont(): Font {
  const cw = 4, ch = 5;
  const bits = new Uint8Array(COUNT * cw * ch);
  for (const [chr, rows] of Object.entries(TINY)) {
    const k = chr.charCodeAt(0) - FIRST;
    rows.forEach((row, y) => {
      for (let x = 0; x < cw; x++) bits[(k * ch + y) * cw + x] = row[x] === '#' ? 1 : 0;
    });
  }
  return { cw, ch, bits };
}

export function makeFont(cw: number, ch: number): Font {
  const SS = 6; // supersample then threshold
  const cv = document.createElement('canvas');
  cv.width = cw * SS; cv.height = ch * SS;
  const g = cv.getContext('2d', { willReadFrequently: true })!;
  const size = Math.min(cw / 0.6, ch * 1.02) * SS;
  const bits = new Uint8Array(COUNT * cw * ch);
  for (let k = 0; k < COUNT; k++) {
    const chr = String.fromCharCode(FIRST + k);
    if (cw === 4 && ch === 5 && TINY[chr]) {
      TINY[chr].forEach((row, y) => { for (let x = 0; x < 4; x++) bits[(k * ch + y) * cw + x] = row[x] === '#' ? 1 : 0; });
      continue;
    }
    const d = DESIGN[chr];
    if (d) { bits.set(resample(d, cw, ch), k * cw * ch); continue; }
    g.clearRect(0, 0, cv.width, cv.height);
    g.fillStyle = '#fff';
    g.font = `600 ${size}px ${FAMILY}`;
    g.textAlign = 'center';
    g.textBaseline = 'alphabetic';
    g.fillText(chr, cv.width / 2, ch * SS * 0.84);
    const px = g.getImageData(0, 0, cv.width, cv.height).data;
    for (let y = 0; y < ch; y++)
      for (let x = 0; x < cw; x++) {
        let a = 0;
        for (let sy = 0; sy < SS; sy++)
          for (let sx = 0; sx < SS; sx++) a += px[(((y * SS + sy) * cv.width) + x * SS + sx) * 4 + 3];
        bits[(k * ch + y) * cw + x] = a / (SS * SS * 255) > 0.34 ? 1 : 0;
      }
  }
  return { cw, ch, bits };
}
