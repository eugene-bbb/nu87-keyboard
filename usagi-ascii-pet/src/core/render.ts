import { C, to565 } from './palette';
import { clamp, lerp, smoothstep, easeOutCubic, rotX, rotY, rotZ, mul3 } from './math';
import { EAR, ARM, FOOT, PART, type UsagiModel } from './model';
import type { Pose } from './pose';
import type { CellGrid } from './grid';
import { evalFace } from './face';
import type { FxDraw } from './fx';
import type { Background } from './background';
import { FaceFeatures } from './features';

export const RAMP = ' .,:;-=+*#%@';
/** body shading uses the ramp's particle-like glyphs (no '-' '=' bars, which read as scanlines) */
const BODY_RAMP = '.:;+*#%@';
/** equal-brightness glyph families, picked per cell from the stable particle seeds → organic texture */
const DENSE: Array<string | undefined> = [undefined, undefined, undefined, '+*', '*#+', '#*%', '%#@*', '@%#'];
const CH = (s: string) => s.charCodeAt(0);
const LIGHT = (() => { const l = Math.hypot(-0.38, 0.5, 0.78); return [-0.38 / l, 0.5 / l, 0.78 / l]; })();
const HALF = (() => { const x = LIGHT[0], y = LIGHT[1], z = LIGHT[2] + 1; const l = Math.hypot(x, y, z); return [x / l, y / l, z / l]; })();
const POP = [0, 1, 1, 2, 1, 2, 2, 3, 1, 2, 2, 3, 2, 3, 3, 4];
const K = 24; // ear centerline samples

export interface RenderOpts {
  persp: boolean; camPitch: number; scale: number; cx: number; cy: number;
  time: number; introT: number | null; yawOffset: number; fx: FxDraw[]; dim: number;
}

/**
 * Pose the particle model, project to the cell grid with a z-buffer, light it, and pick
 * one ASCII glyph + RGB565 color per cell. Only typed arrays; nothing allocated per frame.
 */
export class AsciiRenderer {
  private n: number;
  private wx: Float32Array; private wy: Float32Array; private wz: Float32Array;
  private wnx: Float32Array; private wny: Float32Array; private wnz: Float32Array;
  private cellOf: Int32Array; private bit: Uint8Array; private zq: Float32Array;
  private bq: Float32Array; private rq: Float32Array; private gq: Float32Array; private lq: Float32Array;
  private eq: Float32Array; private spq: Float32Array;
  private faceCol: Float32Array; private faceEmis: Float32Array;
  private earTbl = [new Float32Array(K * 12), new Float32Array(K * 12)];
  // per cell
  private zmin = new Float32Array(0); private cnt = new Float32Array(0);
  private sB = new Float32Array(0); private sR = new Float32Array(0); private sG = new Float32Array(0);
  private sL = new Float32Array(0); private sE = new Float32Array(0); private sJ = new Float32Array(0);
  private sS = new Float32Array(0); private mask = new Uint8Array(0); private has = new Uint8Array(0);
  private fxW = new Float32Array(0); private fxR = new Float32Array(0); private fxG = new Float32Array(0);
  private fxB = new Float32Array(0); private fxC = new Uint8Array(0);
  private dark = new Uint8Array(0);
  features = new FaceFeatures();
  private xf = { M: [1, 0, 0, 0, 1, 0, 0, 0, 1] as number[], Tx: 0, Ty: 0, Tz: 0, sx: 1, sy: 1, sz: 1, persp: true, S: 84, cx: 240, cy: 194 };
  /** per-cell nearest view-space depth (used by fx occlusion) */
  stats = { particles: 0, cells: 0 };

  constructor(private m: UsagiModel) {
    const n = (this.n = m.n);
    const f = () => new Float32Array(n);
    this.wx = f(); this.wy = f(); this.wz = f(); this.wnx = f(); this.wny = f(); this.wnz = f();
    this.cellOf = new Int32Array(n); this.bit = new Uint8Array(n); this.zq = f();
    this.bq = f(); this.rq = f(); this.gq = f(); this.lq = f(); this.eq = f(); this.spq = f();
    this.faceCol = new Float32Array(m.faceIdx.length * 3);
    this.faceEmis = new Float32Array(m.faceIdx.length);
  }

  private alloc(size: number) {
    if (this.zmin.length === size) return;
    const f = () => new Float32Array(size);
    this.zmin = f(); this.cnt = f(); this.sB = f(); this.sR = f(); this.sG = f(); this.sL = f();
    this.sE = f(); this.sJ = f(); this.sS = f(); this.mask = new Uint8Array(size); this.has = new Uint8Array(size);
    this.fxW = f(); this.fxR = f(); this.fxG = f(); this.fxB = f(); this.fxC = new Uint8Array(size); this.dark = new Uint8Array(size);
  }

  private earTable(s: number, splay: number, out: number, fwd: number, sway: number, tbl: Float32Array) {
    let px = 0, py = 0, pz = 0;
    const step = EAR.L / (K - 1);
    for (let k = 0; k < K; k++) {
      const uu = Math.pow(k / (K - 1), 1.3);
      const F = mul3(rotZ(-s * (splay + sway + out * uu)), rotX(fwd * uu));
      const o = k * 12;
      tbl[o] = px; tbl[o + 1] = py; tbl[o + 2] = pz;
      for (let j = 0; j < 9; j++) tbl[o + 3 + j] = F[j];
      px += F[1] * step; py += F[4] * step; pz += F[7] * step;
    }
  }

  /** Part-local rest pose → torso space (ears bend, arms swing). */
  private buildTorsoSpace(p: Pose) {
    const m = this.m;
    const { wx, wy, wz, wnx, wny, wnz } = this;
    const [t0, t1] = m.range[PART.TORSO];
    for (let i = t0; i < t1; i++) {
      wx[i] = m.rx[i]; wy[i] = m.ry[i]; wz[i] = m.rz[i];
      wnx[i] = m.nx[i]; wny[i] = m.ny[i]; wnz[i] = m.nz[i];
    }
    for (let e = 0; e < 2; e++) {
      const s = e === 0 ? -1 : 1;
      const tbl = this.earTbl[e];
      this.earTable(s, (e === 0 ? p.earSplayL : p.earSplayR) + EAR.LEAN[e], e === 0 ? p.earOutL : p.earOutR,
        e === 0 ? p.earFwdL : p.earFwdR, e === 0 ? p.earSwayL : p.earSwayR, tbl);
      const [a, b] = m.range[e === 0 ? PART.EAR_L : PART.EAR_R];
      for (let i = a; i < b; i++) {
        const kf = m.u[i] * (K - 1);
        const k0 = Math.min(K - 2, Math.floor(kf)), f = kf - k0;
        const o0 = k0 * 12, o1 = o0 + 12;
        const L = (j: number) => tbl[o0 + j] + (tbl[o1 + j] - tbl[o0 + j]) * f;
        const lx = m.rx[i], lz = m.rz[i];
        wx[i] = EAR.BX[e] + L(0) + lx * L(3) + lz * L(5);
        wy[i] = EAR.BY + L(1) + lx * L(6) + lz * L(8);
        wz[i] = EAR.BZ + L(2) + lx * L(9) + lz * L(11);
        const nx = m.nx[i], ny = m.ny[i], nz = m.nz[i];
        wnx[i] = nx * L(3) + ny * L(4) + nz * L(5);
        wny[i] = nx * L(6) + ny * L(7) + nz * L(8);
        wnz[i] = nx * L(9) + ny * L(10) + nz * L(11);
      }
    }
    for (let a = 0; a < 2; a++) {
      const s = a === 0 ? -1 : 1;
      const F = mul3(rotZ(s * (ARM.BASE + (a === 0 ? p.armRaiseL : p.armRaiseR))), rotX(-0.3));
      const [i0, i1] = m.range[a === 0 ? PART.ARM_L : PART.ARM_R];
      for (let i = i0; i < i1; i++) {
        const x = m.rx[i], y = m.ry[i], z = m.rz[i];
        wx[i] = s * ARM.SX + F[0] * x + F[1] * y + F[2] * z;
        wy[i] = ARM.SY + F[3] * x + F[4] * y + F[5] * z;
        wz[i] = ARM.SZ + F[6] * x + F[7] * y + F[8] * z;
        const nx = m.nx[i], ny = m.ny[i], nz = m.nz[i];
        wnx[i] = F[0] * nx + F[1] * ny + F[2] * nz;
        wny[i] = F[3] * nx + F[4] * ny + F[5] * nz;
        wnz[i] = F[6] * nx + F[7] * ny + F[8] * nz;
      }
    }
    for (let a = 0; a < 2; a++) {
      const s = a === 0 ? -1 : 1;
      const [i0, i1] = m.range[a === 0 ? PART.FOOT_L : PART.FOOT_R];
      for (let i = i0; i < i1; i++) {
        wx[i] = s * FOOT.X + m.rx[i]; wy[i] = FOOT.Y + m.ry[i]; wz[i] = FOOT.Z + m.rz[i];
        wnx[i] = m.nx[i]; wny[i] = m.ny[i]; wnz[i] = m.nz[i];
      }
    }
  }

  render(grid: CellGrid, pose: Pose, o: RenderOpts, bg: Background) {
    const m = this.m, n = this.n;
    const { cols, rows, cw, ch, oy } = grid;
    const size = cols * rows;
    this.alloc(size);
    grid.clear();
    this.zmin.fill(-1e9); this.cnt.fill(0); this.sB.fill(0); this.sR.fill(0); this.sG.fill(0);
    this.sL.fill(0); this.sE.fill(0); this.sJ.fill(0); this.sS.fill(0); this.mask.fill(0); this.has.fill(0); this.dark.fill(0);

    const introT = o.introT;
    const faceFade = introT === null ? 1 : smoothstep(3.0, 4.0, introT);
    evalFace(m, pose, faceFade, this.faceCol, this.faceEmis);
    this.buildTorsoSpace(pose);

    // body transform: squash about the feet, head tilt, yaw, camera above the pet
    const Rb = mul3(rotZ(pose.roll), mul3(rotX(pose.pitch), rotY(pose.yaw + o.yawOffset)));
    const Rc = rotX(o.camPitch);
    const M = mul3(Rc, Rb);
    const PX = 0, PY = -0.25, PZ = 0; // pivot
    const rx_ = pose.rootX, ry_ = pose.rootY;
    const wx0 = PX + rx_, wy0 = PY + ry_, wz0 = PZ;
    const Tx = Rc[0] * wx0 + Rc[1] * wy0 + Rc[2] * wz0;
    const Ty = Rc[3] * wx0 + Rc[4] * wy0 + Rc[5] * wz0;
    const Tz = Rc[6] * wx0 + Rc[7] * wy0 + Rc[8] * wz0;
    const { sx, sy, sz } = pose;
    const isx = 1 / sx, isy = 1 / sy, isz = 1 / sz;
    const D = 7;
    const S = o.scale;
    this.xf = { M, Tx, Ty, Tz, sx, sy, sz, persp: o.persp, S, cx: o.cx, cy: o.cy };
    const t = o.time;

    // ── pass 1: transform, project, light ───────────────────────────────────
    const { wx, wy, wz, wnx, wny, wnz, cellOf, bit, zq, bq, rq, gq, lq, eq, spq } = this;
    const zmin = this.zmin;
    let drawn = 0;
    for (let i = 0; i < n; i++) {
      cellOf[i] = -1;
      let X = wx[i], Y = wy[i], Z = wz[i];
      let flash = 0, dimK = 1;

      if (introT !== null) {
        const tA = 0.8 + m.buildKey[i] * 2.2 + m.seed[i] * 0.35;
        const k = clamp((introT - (tA - 1.0)) / 1.0);
        const dust = m.seed2[i] < 0.04;
        if (k < 1) {
          const j = i * 3;
          let SX = m.scatter[j] + Math.sin(introT * 0.9 + m.seed[i] * 6.28) * 0.06;
          let SY = m.scatter[j + 1] + Math.cos(introT * 0.7 + m.seed2[i] * 6.28) * 0.06;
          let SZ = m.scatter[j + 2];
          if (k <= 0) {
            if (!dust || introT < (m.seed2[i] / 0.04) * 0.8) continue;
            X = SX; Y = SY; Z = SZ; dimK = 0.4;
          } else {
            if (!dust && k < 0.35) continue;
            const e = easeOutCubic(k);
            const sw = Math.sin(k * Math.PI) * (1 - e) * 0.5;
            X = lerp(SX, X, e) + sw * Math.cos(m.seed[i] * 6.28);
            Y = lerp(SY, Y, e);
            Z = lerp(SZ, Z, e) + sw * Math.sin(m.seed[i] * 6.28);
            dimK = 0.35 + 0.65 * e;
          }
        } else {
          flash = Math.exp(-(introT - tA) * 4.5) * 0.85;
        }
      }

      // normal (inverse-transpose of the squash), then rotate
      let nx = wnx[i] * isx, ny = wny[i] * isy, nz = wnz[i] * isz;
      const nl = 1 / (Math.hypot(nx, ny, nz) || 1);
      nx *= nl; ny *= nl; nz *= nl;
      const vnx = M[0] * nx + M[1] * ny + M[2] * nz;
      const vny = M[3] * nx + M[4] * ny + M[5] * nz;
      const vnz = M[6] * nx + M[7] * ny + M[8] * nz;
      if (vnz < -0.25 && flash === 0 && dimK === 1) continue;

      // position
      const qx = X * sx - PX, qy = (Y + 1) * sy - 1 - PY, qz = Z * sz - PZ;
      const px = M[0] * qx + M[1] * qy + M[2] * qz + Tx;
      const py = M[3] * qx + M[4] * qy + M[5] * qz + Ty;
      const pz = M[6] * qx + M[7] * qy + M[8] * qz + Tz;
      const f = o.persp ? D / (D - pz) : 1;
      const scx = o.cx + px * f * S;
      const scy = o.cy - py * f * S;
      const fc = scx / cw, fr = (scy - oy) / ch;
      const c = Math.floor(fc), r = Math.floor(fr);
      if (c < 0 || c >= cols || r < 0 || r >= rows) continue;
      const ci = r * cols + c;
      cellOf[i] = ci;
      bit[i] = ((fc - c) >= 0.5 ? 1 : 0) | ((fr - r) >= 0.5 ? 2 : 0);
      zq[i] = pz;
      if (pz > zmin[ci]) zmin[ci] = pz;
      drawn++;

      // lighting: half-lambert diffuse + ambient + weak specular + rim
      const dif = clamp((vnx * LIGHT[0] + vny * LIGHT[1] + vnz * LIGHT[2]) * 0.75 + 0.25);
      const nh = vnx * HALF[0] + vny * HALF[1] + vnz * HALF[2];
      const spec = nh > 0 ? Math.pow(nh, 30) * 0.14 : 0;
      const rim = Math.pow(1 - clamp(vnz), 2.6) * 0.2;
      let b = (0.2 + 0.72 * Math.pow(dif, 1.5) + spec + rim) * m.ao[i];
      if (m.part[i] >= PART.ARM_L) b *= 0.55 + 0.45 * clamp(vnz * 1.2); // dark contour separates limbs from the body

      let r_ = m.cr[i], g_ = m.cg[i], l_ = m.cb[i], em = 0;
      const fs = m.faceSlot[i];
      if (fs >= 0) {
        r_ = this.faceCol[fs * 3]; g_ = this.faceCol[fs * 3 + 1]; l_ = this.faceCol[fs * 3 + 2];
        em = this.faceEmis[fs];
        b = lerp(b, 0.8, 0.6); // keep the face calm & readable
      }

      // glitter: a few surface particles twinkle
      let sp = 0;
      if (m.glitter[i]) {
        const per = 4 + m.seed[i] * 5;
        const ph = (t / per + m.seed2[i]) % 1;
        if (ph < 0.09) sp = Math.sin((Math.PI * ph) / 0.09);
      }

      bq[i] = b * dimK; rq[i] = r_; gq[i] = g_; lq[i] = l_; eq[i] = em + flash; spq[i] = sp;
    }
    this.stats.particles = drawn;

    // ── pass 2: accumulate every particle that sits on the visible surface ──────────
    const { cnt, sB, sR, sG, sL, sE, sJ, sS, mask } = this;
    for (let i = 0; i < n; i++) {
      const ci = cellOf[i];
      if (ci < 0 || zq[i] < zmin[ci] - 0.13) continue;
      mask[ci] |= 1 << bit[i];
      cnt[ci] += 1; sB[ci] += bq[i]; sR[ci] += rq[i]; sG[ci] += gq[i]; sL[ci] += lq[i];
      sE[ci] += eq[i]; sJ[ci] += m.seed[i]; if (spq[i] > sS[ci]) sS[ci] = spq[i];
    }
    // coverage also counts hidden-but-present sub-cells so silhouettes stay round
    for (let i = 0; i < n; i++) {
      const ci = cellOf[i];
      if (ci >= 0) mask[ci] |= 1 << bit[i];
    }

    // ── finalize: glyph + color per cell ───────────────────────────────────────
    const has = this.has;
    for (let c = 0; c < size; c++) {
      const cn = cnt[c];
      if (cn === 0) continue;
      const inv = 1 / cn;
      const b = sB[c] * inv;
      let r = sR[c] * inv, g = sG[c] * inv, l = sL[c] * inv;
      const em = sE[c] * inv, spk = sS[c], jit = sJ[c] * inv;
      const cov = POP[mask[c]] / 4;
      const lum = (0.299 * r + 0.587 * g + 0.114 * l) / 255;
      const dark = lum < 0.5;
      const k = clamp(b, 0, 1.1);

      this.dark[c] = dark ? 1 : 0;
      let code: number;
      if (dark) {
        code = lum < 0.3 ? CH('@') : cov > 0.5 ? CH('%') : CH(':');
        r *= 0.4; g *= 0.4; l *= 0.45;
      } else {
        const kk = 0.42 + 0.58 * Math.min(1, k);
        r *= kk; g *= kk; l *= kk;
        const sh = (1 - smoothstep(0.1, 0.75, k)) * 0.45;
        const sK = 0.55 + 0.45 * Math.min(1, k);
        r = lerp(r, C.SHADOW[0] * sK, sh); g = lerp(g, C.SHADOW[1] * sK, sh); l = lerp(l, C.SHADOW[2] * sK, sh);
        // partially dark cells (mouth, nose, eye rims): dim + thin out so features read
        const part = clamp((0.84 - lum) / 0.3);
        if (part > 0) { const d = 1 - 0.6 * part; r *= d; g *= d; l *= d; }
        let fi = 1.5 + 5.6 * Math.pow(clamp(k), 0.85) + (jit - 0.5) * 1.5 + em * 1.4 - 3.2 * part;
        if (cov < 1) fi *= 0.45 + 0.55 * cov;
        const bi = Math.round(clamp(fi, 0, 7));
        const alt = DENSE[bi];
        code = alt ? alt.charCodeAt(Math.floor(jit * 997) % alt.length) : BODY_RAMP.charCodeAt(bi);
      }
      // glow / emission add (cheeks, intro flash)
      r += em * 230; g += em * 190; l += em * 200;
      if (pose.desat > 0) {
        const gr = (r + g + l) / 3;
        r = lerp(r, gr * 0.98, pose.desat * 0.5); g = lerp(g, gr, pose.desat * 0.5); l = lerp(l, gr * 1.08, pose.desat * 0.5);
      }
      if (spk > 0.25) {
        code = spk > 0.7 ? CH('*') : CH('+');
        r = lerp(r, 255, spk); g = lerp(g, 255, spk); l = lerp(l, 255, spk);
      }
      grid.chr[c] = code;
      grid.fg[c] = to565(clamp(r, 0, 255), clamp(g, 0, 255), clamp(l, 0, 255));
      has[c] = 1;
    }

    // silhouette: keep edge cells from fading away into the dark
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        if (!has[i] || cnt[i] < 2) continue;
        const edge = (c > 0 && !has[i - 1]) || (c < cols - 1 && !has[i + 1]) || (r > 0 && !has[i - cols]) || (r < rows - 1 && !has[i + cols]);
        if (!edge || POP[mask[i]] < 3) continue;
        const idx = BODY_RAMP.indexOf(String.fromCharCode(grid.chr[i]));
        if (idx >= 0 && idx < 5) grid.chr[i] = BODY_RAMP.charCodeAt(5);
        // bright contour: lift dim edge colors toward the body color
        const v = grid.fg[i];
        const lr = Math.max((v >> 8) & 0xf8, 214), lg = Math.max((v >> 3) & 0xfc, 206), lb = Math.max((v << 3) & 0xf8, 186);
        if (!this.dark[i]) grid.fg[i] = to565(lr, lg, lb);
      }

    // ── background: ground shadow + stars (only in empty cells) ────────────────────
    const h = clamp(ry_ / 0.4);
    const sc = introT === null ? 1 : smoothstep(1.2, 2.5, introT);
    bg.draw(grid, t, o.dim, introT, {
      cx: o.cx + rx_ * S, cy: o.cy + 0.98 * S + 1, rx: 0.95 * S * (1 - 0.25 * h), ry: 0.15 * S * (1 - 0.2 * h),
      k: 0.62 * sc * (1 - 0.5 * h),
    });

    // ── fx: additive glow particles, z-tested against the character ──────────────
    const { fxW, fxR, fxG, fxB, fxC } = this;
    fxW.fill(0); fxR.fill(0); fxG.fill(0); fxB.fill(0); fxC.fill(0);
    const cp = Math.cos(o.camPitch), sp_ = Math.sin(o.camPitch);
    for (const p of o.fx) {
      const py = p.y * cp - p.z * sp_, pz = p.y * sp_ + p.z * cp;
      const f = o.persp ? D / (D - pz) : 1;
      const c = Math.floor((o.cx + p.x * f * S) / cw), r = Math.floor((o.cy - py * f * S - oy) / ch);
      if (c < 0 || c >= cols || r < 0 || r >= rows) continue;
      const ci = r * cols + c;
      if (has[ci] && pz < zmin[ci] - 0.02) continue; // hidden behind Usagi
      fxW[ci] += p.w; fxR[ci] += p.r * p.w; fxG[ci] += p.g * p.w; fxB[ci] += p.b * p.w;
      if (p.w > (fxC[ci] ? 0 : 0) && (fxC[ci] === 0 || p.w > 0.5)) fxC[ci] = p.ch;
    }
    for (let c = 0; c < size; c++) {
      const w = fxW[c];
      if (w < 0.06) continue;
      const k = 1 / w;
      let r = fxR[c] * k, g = fxG[c] * k, b = fxB[c] * k;
      const a = Math.min(1.25, w);
      if (has[c]) {
        r = Math.min(255, (grid.fg[c] >> 8 & 0xf8) + r * a * 0.55);
        g = Math.min(255, (grid.fg[c] >> 3 & 0xfc) + g * a * 0.55);
        b = Math.min(255, (grid.fg[c] << 3 & 0xf8) + b * a * 0.55);
        if (w > 0.55) grid.chr[c] = fxC[c];
      } else {
        const a2 = Math.min(1, a);
        r *= a2; g *= a2; b *= a2;
        grid.chr[c] = w > 1.4 ? CH('*') : fxC[c];
      }
      grid.fg[c] = to565(r, g, b);
    }
    this.stats.cells = size;
    this.features.apply(grid, this.proj, pose, faceFade); // last: nothing paints over eyes/mouth
  }

  /** model (torso-space) point → screen pixels; same transform as the particle pass */
  proj = (X: number, Y: number, Z: number, out: number[]) => {
    const { M, Tx, Ty, Tz, sx, sy, sz, persp, S, cx, cy } = this.xf;
    const qx = X * sx, qy = (Y + 1) * sy - 1 + 0.25, qz = Z * sz;
    const px = M[0] * qx + M[1] * qy + M[2] * qz + Tx;
    const py = M[3] * qx + M[4] * qy + M[5] * qz + Ty;
    const pz = M[6] * qx + M[7] * qy + M[8] * qz + Tz;
    const f = persp ? 7 / (7 - pz) : 1;
    out[0] = cx + px * f * S; out[1] = cy - py * f * S;
  };
}
