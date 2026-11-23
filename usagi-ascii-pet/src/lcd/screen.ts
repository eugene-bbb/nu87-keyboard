import { LCD_W, LCD_H, type CellGrid } from '../core/grid';
import { from565To32, to565 } from '../core/palette';
import type { Font } from './font';

/**
 * 480×320 framebuffer (browser: 32-bit; the MCU would push RGB565 rectangles instead).
 * Cells are blitted individually, so only dirty cells ever touch the "display".
 */
export class Lcd {
  fb = new Uint32Array(LCD_W * LCD_H);
  /** UI background #0C0E12, as the panel shows it (RGB565) */
  bg = from565To32(to565(0x0c, 0x0e, 0x12)) >>> 0;

  constructor() { this.fb.fill(this.bg); }

  fillRect(x: number, y: number, w: number, h: number, c: number) {
    for (let j = y; j < y + h; j++) this.fb.fill(c, j * LCD_W + x, j * LCD_W + x + w);
  }

  blitCell(font: Font, code: number, x: number, y: number, fg: number) {
    const { cw, ch, bits } = font;
    const base = (Math.min(126, Math.max(32, code)) - 32) * cw * ch;
    for (let j = 0; j < ch; j++) {
      const row = (y + j) * LCD_W + x;
      for (let i = 0; i < cw; i++) this.fb[row + i] = bits[base + j * cw + i] ? fg : this.bg;
    }
  }

  blitGrid(grid: CellGrid, font: Font, cells: Int32Array, n: number) {
    for (let k = 0; k < n; k++) {
      const i = cells[k];
      const r = (i / grid.cols) | 0, c = i - r * grid.cols;
      this.blitCell(font, grid.chr[i], c * grid.cw, grid.oy + r * grid.ch, from565To32(grid.fg[i]));
    }
  }

  text(font: Font, x: number, y: number, s: string, fg: number) {
    for (let i = 0; i < s.length; i++) this.blitCell(font, s.charCodeAt(i), x + i * font.cw, y, fg);
  }

  clear() { this.fb.fill(this.bg); }
}
