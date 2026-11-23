/**
 * CellGrid = the LCD-portable render product: one ASCII code + one RGB565 color per cell.
 * No pixels, no canvas. On the MCU this is all you need to draw a frame (see lcd/export.ts).
 */
export const LCD_W = 480;
export const LCD_H = 320;
export const BAND_TOP = 24;    // character stage lives between the HUD bars
export const BAND_BOTTOM = 296;

export interface DensityPreset { name: string; cw: number; ch: number }
export const DENSITIES: DensityPreset[] = [
  { name: '60×32  (8×10 px)', cw: 8, ch: 10 },
  { name: '80×40  (6×8 px)', cw: 6, ch: 8 },
  { name: '96×64  (5×5 px)', cw: 5, ch: 5 },
  { name: '120×64 (4×5 px) · default', cw: 4, ch: 5 },
];

export class CellGrid {
  readonly cols: number;
  readonly rows: number;
  readonly oy: number;
  chr: Uint8Array;
  fg: Uint16Array;

  constructor(public cw: number, public ch: number) {
    this.cols = Math.floor(LCD_W / cw);
    const top = Math.ceil(BAND_TOP / ch) * ch;
    const bottom = Math.floor(BAND_BOTTOM / ch) * ch;
    this.oy = top;
    this.rows = Math.floor((bottom - top) / ch);
    this.chr = new Uint8Array(this.cols * this.rows);
    this.fg = new Uint16Array(this.cols * this.rows);
  }

  clear() { this.chr.fill(32); this.fg.fill(0); }
  get size() { return this.cols * this.rows; }
}

/** Dirty-cell detection: returns the number of changed cells and fills `out` with their indices. */
export function diffGrids(cur: CellGrid, prev: CellGrid, out: Int32Array): number {
  let n = 0;
  const N = cur.size;
  for (let i = 0; i < N; i++) {
    const a = cur.chr[i], b = prev.chr[i];
    // blank cells ignore color
    if (a !== b || (a !== 32 && cur.fg[i] !== prev.fg[i])) out[n++] = i;
  }
  return n;
}

export function copyGrid(src: CellGrid, dst: CellGrid) {
  dst.chr.set(src.chr);
  dst.fg.set(src.fg);
}
