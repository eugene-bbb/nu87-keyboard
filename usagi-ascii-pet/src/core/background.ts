import { mulberry32, clamp } from './math';
import type { CellGrid } from './grid';
import { to565 } from './palette';

const CH = (s: string) => s.charCodeAt(0);

/** Faint stars (60-100) + a very soft ground shadow. Always dimmer than Usagi. */
export class Background {
  private stars: Array<{ nx: number; ny: number; ch: number; base: number; sp: number; ph: number; tint: number; born: number }> = [];

  constructor(count = 84) {
    const r = mulberry32(5150);
    for (let i = 0; i < count; i++)
      this.stars.push({
        nx: r(), ny: r(), ch: [CH('.'), CH('.'), CH('.'), CH('+'), CH('*'), CH("'"), CH('`')][Math.floor(r() * 7)],
        base: 0.3 + r() * 0.7, sp: 0.35 + r() * 1.7, ph: r() * 6.28, tint: r(), born: 0.2 + r() * 1.6,
      });
  }

  draw(g: CellGrid, t: number, dim: number, introT: number | null,
       shadow: { cx: number; cy: number; rx: number; ry: number; k: number }) {
    const { cols, rows, cw, ch, oy } = g;

    // ground shadow (ellipse of ':' '.' dither)
    if (shadow.k > 0.01) {
      const c0 = Math.max(0, Math.floor((shadow.cx - shadow.rx) / cw));
      const c1 = Math.min(cols - 1, Math.ceil((shadow.cx + shadow.rx) / cw));
      const r0 = Math.max(0, Math.floor((shadow.cy - shadow.ry - oy) / ch));
      const r1 = Math.min(rows - 1, Math.ceil((shadow.cy + shadow.ry - oy) / ch));
      for (let r = r0; r <= r1; r++)
        for (let c = c0; c <= c1; c++) {
          const i = r * cols + c;
          if (g.chr[i] !== 32) continue;
          const dx = ((c + 0.5) * cw - shadow.cx) / shadow.rx, dy = ((r + 0.5) * ch + oy - shadow.cy) / shadow.ry;
          const d = dx * dx + dy * dy;
          if (d >= 1) continue;
          const w = Math.pow(1 - d, 1.1) * shadow.k;
          const hash = ((c * 73856093) ^ (r * 19349663)) >>> 0;
          const jitter = (hash % 100) / 100 * 0.25;
          const v = w + jitter * 0.4 * w;
          g.chr[i] = v > 0.52 ? CH(';') : v > 0.3 ? CH(':') : v > 0.12 ? CH('.') : 32;
          if (g.chr[i] !== 32) { const l = 22 + 30 * v; g.fg[i] = to565(l, l + 2, l + 6); }
        }
    }

    // stars
    for (const s of this.stars) {
      if (introT !== null && introT < s.born) continue;
      const c = Math.min(cols - 1, Math.floor(s.nx * cols)), r = Math.min(rows - 1, Math.floor(s.ny * rows));
      const i = r * cols + c;
      if (g.chr[i] !== 32 && g.chr[i] !== CH('.') && g.chr[i] !== CH(':') && g.chr[i] !== CH(';')) continue;
      const tw = 0.5 + 0.5 * Math.sin(t * s.sp + s.ph);
      const b = clamp(s.base * (0.25 + 0.75 * tw) * dim);
      if (b < 0.12) continue;
      const lvl = 34 + 74 * b; // ≤ ~108, never brighter than the character
      let r_ = lvl * 0.95, g_ = lvl, b_ = lvl * 1.06;
      if (s.tint > 0.86) { r_ = lvl; g_ = lvl * 0.78; b_ = lvl * 0.9; }
      else if (s.tint < 0.12) { r_ = lvl * 0.82; g_ = lvl * 0.96; b_ = lvl * 1.1; }
      g.chr[i] = b > 0.8 && s.ch === CH('.') ? CH('+') : s.ch;
      g.fg[i] = to565(r_, g_, Math.min(255, b_));
    }
  }
}
