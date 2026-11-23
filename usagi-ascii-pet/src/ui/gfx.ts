import { from565To32, to565 } from '../core/palette';
import type { Lcd } from '../lcd/screen';

/**
 * LCD UI drawing kit. Everything here maps 1:1 to MCU primitives:
 *  - colors are RGB565-quantised,
 *  - fonts are fixed-cell 4-bpp coverage tables (16-entry fg/bg LUT per text run, no per-pixel math),
 *  - Regions = cached widgets; a widget is cleared + repainted only when its key changes (dirty rectangle).
 */
export type Rgb = readonly [number, number, number];
export type Rect = readonly [number, number, number, number]; // x0, y0, x1, y1

export const UI = {
  BG: [0x0c, 0x0e, 0x12],
  SURFACE: [0x15, 0x18, 0x1e],
  WHITE: [0xf5, 0xf5, 0xf5],
  GRAY: [0x8e, 0x94, 0x9e],
  DIM: [0x50, 0x56, 0x60],
  PINK: [0xf2, 0xb5, 0xcc],
  SKY: [0xa8, 0xd8, 0xf0],
} as const satisfies Record<string, Rgb>;

export const c32 = (c: Rgb) => from565To32(to565(c[0], c[1], c[2]));

export interface UiFont { cw: number; ch: number; /** 0..15 coverage, glyph-major */ a: Uint8Array }

const EXTRA = '°·→'; // non-ASCII glyphs appended after 32..126
const FAMILY = 'ui-monospace, "SF Mono", Menlo, Monaco, Consolas, monospace';

export function makeUiFont(px: number, cw: number, ch: number, weight = 500): UiFont {
  const n = 95 + EXTRA.length;
  const cv = document.createElement('canvas');
  cv.width = cw; cv.height = ch;
  const g = cv.getContext('2d', { willReadFrequently: true })!;
  g.font = `${weight} ${px}px ${FAMILY}`;
  g.textAlign = 'center';
  g.textBaseline = 'alphabetic';
  g.fillStyle = '#fff';
  const a = new Uint8Array(n * cw * ch);
  for (let k = 0; k < n; k++) {
    g.clearRect(0, 0, cw, ch);
    g.fillText(k < 95 ? String.fromCharCode(32 + k) : EXTRA[k - 95], cw / 2, Math.round(ch * 0.78));
    const d = g.getImageData(0, 0, cw, ch).data;
    for (let i = 0; i < cw * ch; i++) a[k * cw * ch + i] = d[i * 4 + 3] >> 4;
  }
  return { cw, ch, a };
}

export interface UiFonts { sm: UiFont; md: UiFont; lg: UiFont; xl: UiFont }
export const makeUiFonts = (): UiFonts => ({
  sm: makeUiFont(10, 6, 11),
  md: makeUiFont(11.5, 7, 13),
  lg: makeUiFont(15, 9, 16),
  xl: makeUiFont(25, 15, 26, 400),
});

const luts = new Map<number, Uint32Array>();
function lut(fg: Rgb, bg: Rgb) {
  const key = to565(fg[0], fg[1], fg[2]) * 65536 + to565(bg[0], bg[1], bg[2]);
  let l = luts.get(key);
  if (!l) {
    l = new Uint32Array(16);
    for (let i = 0; i < 16; i++) {
      const t = i / 15;
      l[i] = c32([bg[0] + (fg[0] - bg[0]) * t, bg[1] + (fg[1] - bg[1]) * t, bg[2] + (fg[2] - bg[2]) * t]);
    }
    luts.set(key, l);
  }
  return l;
}

const glyph = (s: string, i: number) => {
  const c = s.charCodeAt(i);
  if (c >= 32 && c <= 126) return c - 32;
  const e = EXTRA.indexOf(s[i]);
  return e >= 0 ? 95 + e : 31; // '?'
};

export function text(lcd: Lcd, f: UiFont, x: number, y: number, s: string, fg: Rgb, bg: Rgb = UI.BG) {
  const l = lut(fg, bg), n = f.cw * f.ch;
  for (let i = 0; i < s.length; i++) {
    const base = glyph(s, i) * n;
    for (let j = 0; j < f.ch; j++) {
      const row = (y + j) * 480 + x + i * f.cw;
      for (let k = 0; k < f.cw; k++) lcd.fb[row + k] = l[f.a[base + j * f.cw + k]];
    }
  }
  return x + s.length * f.cw;
}
/** right-aligned: text ends at x */
export const textR = (lcd: Lcd, f: UiFont, x: number, y: number, s: string, fg: Rgb, bg: Rgb = UI.BG) =>
  text(lcd, f, x - s.length * f.cw, y, s, fg, bg);

export function fill(lcd: Lcd, x: number, y: number, w: number, h: number, c: Rgb) { lcd.fillRect(x, y, w, h, c32(c)); }

export function outline(lcd: Lcd, x: number, y: number, w: number, h: number, c: Rgb) {
  fill(lcd, x, y, w, 1, c); fill(lcd, x, y + h - 1, w, 1, c);
  fill(lcd, x, y, 1, h, c); fill(lcd, x + w - 1, y, 1, h, c);
}

/** 1-bpp bitmap ('#' = on) */
export function bitmap(lcd: Lcd, x: number, y: number, rows: readonly string[], c: Rgb) {
  const v = c32(c);
  rows.forEach((r, j) => { for (let i = 0; i < r.length; i++) if (r[i] === '#') lcd.fb[(y + j) * 480 + x + i] = v; });
}

export class Regions {
  /** x, y, w, h of every rectangle pushed this frame */
  rects: number[] = [];
  private keys = new Map<string, string>();
  constructor(private lcd: Lcd) {}

  begin() { this.rects.length = 0; }
  /** forget cached widgets (after the area they live in was cleared) */
  invalidate(prefix = '') { for (const k of [...this.keys.keys()]) if (k.startsWith(prefix)) this.keys.delete(k); }

  draw(id: string, key: string, x: number, y: number, w: number, h: number, paint: () => void) {
    if (this.keys.get(id) === key) return;
    this.keys.set(id, key);
    this.lcd.fillRect(x, y, w, h, this.lcd.bg);
    paint();
    this.rects.push(x, y, w, h);
  }
}
