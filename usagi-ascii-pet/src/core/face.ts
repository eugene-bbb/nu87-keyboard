import { C } from './palette';
import { clamp, smoothstep } from './math';
import type { UsagiModel } from './model';
import type { Pose } from './pose';

/**
 * Face landmarks measured from the reference art (body half-width = 1). They are decals on the
 * surface (rest-pose x,y), so they never drift with lighting and stay put on the face.
 */
const EYE_X = 0.285, EYE_Y = 0.34;
const CHEEK_X = 0.535, CHEEK_Y = 0.165;
const MOUTH_Y = EYE_Y - 0.25, NOSE_Y = EYE_Y - 0.19;
const EYE_COL = [22, 22, 30], MOUTH_COL = [48, 36, 46], MOUTH_IN = [70, 32, 50], TONGUE = [226, 116, 146];
const NOSE_COL = [120, 80, 92], STRIPE = [214, 120, 150], ARC_COL = [40, 38, 46];

// forehead contour lines (left short arc, right long arc) from the art
const ARC_L: Array<[number, number]> = [[-0.61, 0.47], [-0.59, 0.62], [-0.5, 0.75], [-0.3, 0.83]];
const ARC_R: Array<[number, number]> = [[0.23, 0.8], [0.45, 0.76], [0.6, 0.62], [0.69, 0.36]];

const mask = (d: number) => 1 - smoothstep(0.55, 1.0, d);
const mix = (o: number[], c: ArrayLike<number>, w: number) => {
  o[0] += (c[0] - o[0]) * w; o[1] += (c[1] - o[1]) * w; o[2] += (c[2] - o[2]) * w;
};
const segDist = (px: number, py: number, ax: number, ay: number, bx: number, by: number) => {
  const dx = bx - ax, dy = by - ay;
  const t = clamp(((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy));
  return Math.hypot(px - ax - dx * t, py - ay - dy * t);
};

/** smooth polyline through control points (Catmull-Rom, sampled once) */
function sampleArc(pts: Array<[number, number]>, n = 18) {
  const out: Array<[number, number]> = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(pts.length - 1, i + 2)];
    for (let k = 0; k < n / (pts.length - 1) + 1; k++) {
      const t = k / (n / (pts.length - 1) + 1), t2 = t * t, t3 = t2 * t;
      const f = (a: number, b: number, c: number, d: number) =>
        0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      out.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])]);
    }
  }
  out.push(pts[pts.length - 1]);
  return out;
}
const POLY = [sampleArc(ARC_L), sampleArc(ARC_R)];
const BB = POLY.map((pl) => {
  const xs = pl.map((q) => q[0]), ys = pl.map((q) => q[1]);
  return [Math.min(...xs) - 0.04, Math.max(...xs) + 0.04, Math.min(...ys) - 0.04, Math.max(...ys) + 0.04];
});
const arcDist = (x: number, y: number, poly: Array<[number, number]>) => {
  let d = 9;
  for (let i = 0; i < poly.length - 1; i++) d = Math.min(d, segDist(x, y, poly[i][0], poly[i][1], poly[i + 1][0], poly[i + 1][1]));
  return d;
};

const tmp = [0, 0, 0];

export function evalFace(m: UsagiModel, p: Pose, fade: number, outCol: Float32Array, outEmis: Float32Array) {
  const hs = Math.max(p.eyeHappy, p.eyeSleep);
  const bigX = 1 + p.eyeBig, bigY = 1 + p.eyeBig * 0.8;
  const ryE = Math.max(0.02, 0.098 * p.eyeOpen * bigY);
  const rxE = 0.088 * bigX;
  const sz = p.mouthSize, open = p.mouthOpen;
  const wOpenM = smoothstep(0.06, 0.25, open);
  const mw = 0.13 * sz;
  const ryM = 0.02 + 0.1 * open;
  const rxM = 0.075 * sz;
  const mcy = MOUTH_Y - 0.01 - ryM * 0.2;

  for (let k = 0; k < m.faceIdx.length; k++) {
    const i = m.faceIdx[k];
    const x = m.rx[i], y = m.ry[i];
    tmp[0] = m.cr[i]; tmp[1] = m.cg[i]; tmp[2] = m.cb[i];
    let emis = 0;

    // forehead contour lines (the signature dark arcs)
    const bb = x < 0 ? BB[0] : BB[1];
    if (x > bb[0] && x < bb[1] && y > bb[2] && y < bb[3]) {
      const d = arcDist(x, y, x < 0 ? POLY[0] : POLY[1]);
      const w = (1 - smoothstep(0.016, 0.034, d)) * fade;
      if (w > 0.01) mix(tmp, ARC_COL, w);
    }

    // cheeks with hatch stripes
    for (let s = -1; s <= 1; s += 2) {
      const dx = (x - s * CHEEK_X) / 0.2, dy = (y - CHEEK_Y) / 0.14;
      const w = mask(dx * dx + dy * dy) * fade;
      if (w > 0.002) {
        mix(tmp, C.CHEEK, w * 0.92);
        const ph = (x * 1.0 + y * 0.9) * s * 34;
        const st = smoothstep(0.55, 0.85, Math.sin(ph)) * smoothstep(0.4, 0.9, w) * 0.5 * (Math.abs(dx) < 0.75 ? 1 : 0);
        if (st > 0.01) mix(tmp, STRIPE, st);
        emis += w * p.cheekGlow * 0.4;
      }
    }

    // sad brows (eyes themselves live in features.ts)
    if (p.eyeSad > 0.02) {
      for (let s = -1; s <= 1; s += 2) {
        const ey = EYE_Y + p.lookY;
        const d = segDist(x, y, s * 0.16 + s * 0.12, ey + 0.17, s * 0.42 + s * 0.12, ey + 0.1);
        const bw = (1 - smoothstep(0.012, 0.026, d)) * p.eyeSad * fade;
        if (bw > 0.01) mix(tmp, ARC_COL, bw);
      }
    }

    const o = k * 3;
    outCol[o] = tmp[0]; outCol[o + 1] = tmp[1]; outCol[o + 2] = tmp[2];
    outEmis[k] = emis;
  }
}
