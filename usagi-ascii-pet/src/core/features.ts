import { clamp, smoothstep } from './math';
import { depthAt } from './model';
import { to565 } from './palette';
import type { Pose } from './pose';
import type { CellGrid } from './grid';

/**
 * Eyes + mouth as Facial Feature Masks (measured from the reference art), converted to ASCII.
 * Each ASCII cell that overlaps a feature samples the mask on a 4×4 sub-sample grid (screen →
 * face (u,v) through the local surface affine, so features stay glued to the face), counts how
 * much of it is dark pupil / upper glint / lower glint / mouth stroke, and picks a glyph + color
 * with the same cell size and glyph renderer as the body. No vector/pixel overlay exists.
 */
export const EYE_X = 0.285, EYE_Y = 0.34;
export const MOUTH_X = 0.0, MOUTH_Y = 0.09;

// neutral charcoal / grey-white: same hue family as the forehead arcs & sad brows
const BROWN = [58, 56, 64], BROWN_IN = [46, 44, 52], HI_UP = [238, 238, 244], HI_LOW = [250, 250, 252], TONGUE_C = [238, 146, 172];
const CH = (s: string) => s.charCodeAt(0);

type Pt = [number, number];
const ARM_L: Pt[] = [[-0.132, 0.042], [-0.12, 0.022], [-0.1, 0.004], [-0.07, -0.012], [-0.04, -0.014], [-0.012, -0.004]];
const ARM_R: Pt[] = [[0.012, -0.004], [0.04, -0.016], [0.07, -0.016], [0.098, -0.004], [0.116, 0.016], [0.122, 0.036]];
const STEM: Pt[] = [[0, 0.07], [0, 0.045], [-0.004, 0.015], [-0.012, -0.008], [-0.034, -0.034], [-0.05, -0.062], [-0.046, -0.092], [-0.026, -0.112], [0.004, -0.116], [0.026, -0.108]];
const HALF_T = 0.0095;

const K_NONE = 0, K_DARK = 1, K_HIUP = 2, K_HILOW = 3, K_STROKE = 4, K_MIN = 5, K_TONGUE = 6;
const SUB = 4;

export type Proj = (x: number, y: number, z: number, out: number[]) => void;
type Aff = { ox: number; oy: number; ex: number; exy: number; ey: number; eyy: number; det: number };

export class FaceFeatures {
  private p0 = [0, 0]; private p1 = [0, 0]; private p2 = [0, 0];
  /** cells written by the last apply() (lets the browser glow pass keep them crisp) */
  touched: number[] = [];
  private cnt = new Int32Array(8);
  private dirC = 0; private dirS = 0;
  private dirU = 0; private dirV = 0; // tangent of the last stroke hit (face coords)

  private affine(proj: Proj, fx: number, fy: number): Aff {
    const e = 0.05;
    proj(fx, fy, depthAt(fx, fy), this.p0);
    proj(fx + e, fy, depthAt(fx + e, fy), this.p1);
    proj(fx, fy + e, depthAt(fx, fy + e), this.p2);
    const ex = (this.p1[0] - this.p0[0]) / e, exy = (this.p1[1] - this.p0[1]) / e;
    const ey = (this.p2[0] - this.p0[0]) / e, eyy = (this.p2[1] - this.p0[1]) / e;
    return { ox: this.p0[0], oy: this.p0[1], ex, exy, ey, eyy, det: ex * eyy - exy * ey };
  }

  /** visit every cell touching the feature's bounding box and classify its sub-samples */
  private cells(
    g: CellGrid, A: Aff, hw: number, hh: number,
    classify: (u: number, v: number) => number,
    emit: (ci: number, c: number, r: number, cnt: Int32Array, angle: number) => void,
  ) {
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    for (const [cu, cv] of [[-hw, -hh], [hw, -hh], [-hw, hh], [hw, hh]]) {
      const sx = A.ox + cu * A.ex + cv * A.ey, sy = A.oy + cu * A.exy + cv * A.eyy;
      x0 = Math.min(x0, sx); x1 = Math.max(x1, sx); y0 = Math.min(y0, sy); y1 = Math.max(y1, sy);
    }
    const c0 = Math.max(0, Math.floor(x0 / g.cw)), c1 = Math.min(g.cols - 1, Math.floor(x1 / g.cw));
    const r0 = Math.max(0, Math.floor((y0 - g.oy) / g.ch)), r1 = Math.min(g.rows - 1, Math.floor((y1 - g.oy) / g.ch));
    for (let r = r0; r <= r1; r++)
      for (let c = c0; c <= c1; c++) {
        this.cnt.fill(0); this.dirC = 0; this.dirS = 0;
        for (let j = 0; j < SUB; j++)
          for (let i = 0; i < SUB; i++) {
            const sx = (c + (i + 0.5) / SUB) * g.cw, sy = g.oy + (r + (j + 0.5) / SUB) * g.ch;
            const dx = sx - A.ox, dy = sy - A.oy;
            const u = (dx * A.eyy - dy * A.ey) / A.det, v = (A.ex * dy - A.exy * dx) / A.det;
            this.dirU = 0; this.dirV = 0;
            const k = classify(u, v);
            this.cnt[k]++;
            if (k === K_STROKE && (this.dirU !== 0 || this.dirV !== 0)) {
              const tx = this.dirU * A.ex + this.dirV * A.ey, ty = this.dirU * A.exy + this.dirV * A.eyy;
              const a = Math.atan2(ty, tx);
              this.dirC += Math.cos(2 * a); this.dirS += Math.sin(2 * a);
            }
          }
        emit(r * g.cols + c, c, r, this.cnt, 0.5 * Math.atan2(this.dirS, this.dirC));
      }
  }

  /** write one cell: glyph + color (blended with the body color already in the cell) */
  private put(g: CellGrid, ci: number, code: number, col: number[], w: number, lit: number, hash: number) {
    const v = g.fg[ci];
    const br = (v >> 8) & 0xf8, bgc = (v >> 3) & 0xfc, bb = (v << 3) & 0xf8;
    const body = (br * 0.299 + bgc * 0.587 + bb * 0.114) / 255; // surface light under the feature
    const f = (lit + (1 - lit) * body) * (0.92 + 0.16 * hash);
    this.touched.push(ci);
    g.chr[ci] = code;
    g.fg[ci] = to565(
      clamp(br + (col[0] * f - br) * w, 0, 255), clamp(bgc + (col[1] * f - bgc) * w, 0, 255), clamp(bb + (col[2] * f - bb) * w, 0, 255));
  }

  apply(g: CellGrid, proj: Proj, p: Pose, fade: number) {
    this.touched.length = 0;
    if (fade < 0.45) return;
    const hs = Math.max(p.eyeHappy, p.eyeSleep);
    const open = clamp(p.eyeOpen);
    const sad = p.eyeSad;
    const dim = 1 - 0.14 * sad;

    // ── eyes ────────────────────────────────────────────────────────────────
    for (let s = -1; s <= 1; s += 2) {
      const cx = s * EYE_X + p.lookX, cy = EYE_Y + p.lookY - 0.012 * sad;
      const A = this.affine(proj, cx, cy);
      const rx = 0.098 * (1 + 0.45 * p.eyeBig), ry = 0.102 * Math.max(open, 0.1) * (1 + 0.35 * p.eyeBig) * (1 - 0.8 * hs);
      const rot = -s * sad * 0.2, cr = Math.cos(rot), sr = Math.sin(rot);
      const ho = smoothstep(0.55, 0.85, open) > 0.5;
      const arcSign = p.eyeHappy >= p.eyeSleep ? 0.05 : -0.042;
      const ecx = Math.round(A.ox / g.cw), ecy = Math.round((A.oy - g.oy) / g.ch);
      this.cells(g, A, 0.16, 0.16,
        (u0, v0) => {
          const u = u0 * cr - v0 * sr, v = u0 * sr + v0 * cr;
          if (hs > 0.5) {
            if (Math.abs(u) >= 0.105) return K_NONE;
            const a = 1 - (u / 0.105) ** 2;
            if (Math.abs(v - arcSign * a) < 0.02) { this.dirU = 1; this.dirV = 0; return K_STROKE; }
            return K_NONE;
          }
          if ((u / rx) ** 2 + (v / ry) ** 2 > 1) return K_NONE;
          if (ho) {
            if (Math.hypot(u + 0.012, v - 0.03 * (ry / 0.102)) < 0.04) return K_HIUP;
            if (Math.abs(u) < 0.05 && Math.abs(v - (-0.06 * (ry / 0.102) + 12.5 * u * u)) < 0.011) return K_HILOW;
          }
          return K_DARK;
        },
        (ci, c, r, n, ang) => {
          // stable per-cell hash, anchored to the eye so the pattern moves with it
          const h = (((c - ecx) * 73856093) ^ ((r - ecy) * 19349663)) >>> 0;
          const hash = (h % 97) / 97;
          const dark = n[K_DARK], up = n[K_HIUP], low = n[K_HILOW], st = n[K_STROKE];
          if (up >= 3) {
            const code = up >= 9 ? CH('@') : up >= 6 ? (hash < 0.5 ? CH('%') : CH('#')) : CH('*');
            this.put(g, ci, code, HI_UP.map((x) => x * dim), 1, 0.8, hash);
          } else if (low >= 2) {
            this.put(g, ci, low >= 5 ? CH('=') : CH('-'), HI_LOW.map((x) => x * dim), 1, 0.8, hash);
          } else if (st >= 2) {
            const code = st >= 6 ? CH('=') : st >= 4 ? CH('-') : CH(':');
            this.put(g, ci, code, BROWN, Math.min(1, st / 4), 0.78, hash);
          } else if (dark + up + low >= 3) {
            const tot = dark + up + low;
            if (tot >= 10) this.put(g, ci, hash < 0.45 ? CH('@') : hash < 0.8 ? CH('#') : CH('%'), BROWN, 1, 0.8, hash);
            else if (tot >= 6) this.put(g, ci, hash < 0.5 ? CH('%') : CH('#'), BROWN, 0.9, 0.8, hash);
            else this.put(g, ci, hash < 0.5 ? CH('+') : CH(':'), BROWN, tot / 9, 0.8, hash);
          }
          void ang;
        });
    }

    // ── mouth ───────────────────────────────────────────────────────────────
    const sz = p.mouthSize, op = p.mouthOpen;
    const sh = clamp(p.mouthShape);                       // 1 = Excited three-bump open mouth
    const wOpen = smoothstep(0.06, 0.25, op) * (1 - sh);
    const A = this.affine(proj, MOUTH_X, MOUTH_Y);
    const lift = (p.mouthSmile - 0.7) * 0.07;
    const tx = (pts: Pt[], w: (i: number) => number): Pt[] => pts.map(([u, v], i) => [u * sz, (v + lift * w(i)) * sz]);
    const L = tx(ARM_L, (i) => (5 - i) / 5), R = tx(ARM_R, (i) => i / 5), ST = tx(STEM, () => 0);
    const useStem = 1 - smoothstep(0.3, 0.7, wOpen) > 0.5 && sh < 0.3;
    const ryO = (0.02 + 0.085 * op) * sz, rxO = 0.085 * sz, ocy = -0.012 * sz - ryO;
    const lines = sh > 0.5 ? [] : useStem ? [L, R, ST] : [L, R];
    const th = HALF_T * Math.max(sz, 0.75);
    const mcx = Math.round(A.ox / g.cw), mcy = Math.round((A.oy - g.oy) / g.ch);
    const E = sh * 1.4;                                  // Excited mouth scale (grows from 0 → 1)
    this.cells(g, A, 0.17 * Math.max(sz, 0.6) + 0.02 + 0.1 * sh, 0.14 * Math.max(sz, 0.6) + 0.02 + ryO + 0.1 * sh,
      (u, v) => {
        if (E > 0.12) {
          // Excited: ONE connected silhouette — three rounded bumps on top, short round sides,
          // body narrowing toward the bottom; a small pink tongue inside (round top, hangs down)
          const a = u / E, w = v / E;
          const t = (w + 0.035) / 0.085;
          let inside = false;
          if (t > -1 && t < 0.35) inside = Math.abs(a) < 0.128 * (1 + 0.2 * t) * (t < 0 ? Math.sqrt(1 - t * t) : 1);
          inside = inside || Math.hypot(a, w - 0.026) < 0.05 || Math.hypot(a + 0.09, w - 0.006) < 0.04 || Math.hypot(a - 0.09, w - 0.006) < 0.04;
          if (!inside) return K_NONE;
          return Math.hypot((a - 0.004) / 0.05, (w + 0.095) / 0.04) < 1 && w < -0.06 ? K_TONGUE : K_MIN;
        }
        let d = 9, du = 0, dv = 0;
        for (const pl of lines)
          for (let i = 0; i < pl.length - 1; i++) {
            const ax = pl[i][0], ay = pl[i][1], bx = pl[i + 1][0], by = pl[i + 1][1];
            const dx = bx - ax, dy = by - ay;
            const t = clamp(((u - ax) * dx + (v - ay) * dy) / (dx * dx + dy * dy + 1e-9));
            const dd = Math.hypot(u - ax - dx * t, v - ay - dy * t);
            if (dd < d) { d = dd; du = dx; dv = dy; }
          }
        if (useStem) { const dt = Math.hypot(u, v - ST[0][1]) - 0.008 * sz; if (dt < d) { d = dt; du = 1; dv = 0; } }
        if (d < th) { this.dirU = du; this.dirV = dv; return K_STROKE; }
        if (wOpen > 0.12 && v < -0.004 * sz && Math.hypot(u / rxO, (v - ocy) / ryO) < 1) return K_MIN;
        return K_NONE;
      },
      (ci, c, r, n, ang) => {
        const h = (((c - mcx) * 83492791) ^ ((r - mcy) * 2654435)) >>> 0;
        const hash = (h % 97) / 97;
        const st = n[K_STROKE], inn = n[K_MIN], tg = n[K_TONGUE];
        if (tg >= 4) { this.put(g, ci, tg >= 9 ? CH('%') : hash < 0.5 ? CH('*') : CH('+'), TONGUE_C, 1, 0.85, hash); return; }
        // connected silhouette: low threshold + dense glyphs so no gaps open between cells
        if (inn + tg >= 8) { this.put(g, ci, hash < 0.5 ? CH('@') : CH('#'), BROWN_IN, 1, 0.8, hash); return; }
        if (inn + tg >= 3 && sh > 0.3) { this.put(g, ci, hash < 0.5 ? CH('#') : CH('%'), BROWN_IN, 0.9, 0.8, hash); return; }
        if (inn >= 5 && st < 6) { this.put(g, ci, hash < 0.5 ? CH('@') : CH('#'), BROWN_IN, 1, 0.8, hash); return; }
        if (st >= 3) {
          const a = Math.abs(ang);                       // 0 = horizontal on screen
          const horiz = a < 0.4 || a > Math.PI - 0.4, vert = Math.abs(a - Math.PI / 2) < 0.4;
          const code = horiz ? (st >= 6 ? CH('=') : CH('-'))
            : vert ? (st >= 6 ? CH(';') : CH(':'))
            : (st >= 6 ? CH('*') : CH('+'));
          this.put(g, ci, code, BROWN, Math.min(0.95, 0.3 + st / 8), 0.8, hash);
        } else if (inn >= 3) this.put(g, ci, CH('%'), BROWN_IN, 0.9, 0.8, hash);
      });
  }
}
