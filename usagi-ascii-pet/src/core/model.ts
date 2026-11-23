import { C, RGB } from './palette';
import { TAU, clamp, smoothstep, mulberry32 } from './math';

/**
 * Usagi — stylized 2.5D model.
 * Silhouette and landmarks are measured from the reference art (units: body half-width = 1.0,
 * y up, +z toward the viewer). Head + body are ONE shallow "pillow" height-field whose outline is
 * the original 2D contour; ears / arms / feet are small separate pieces.
 */
export const PART = { TORSO: 0, EAR_L: 1, EAR_R: 2, ARM_L: 3, ARM_R: 4, FOOT_L: 5, FOOT_R: 6 } as const;

// ear: wide, long, round-tipped, glued together; left leans in, right leans out (as in the art)
export const EAR = { L: 1.0, W: 0.26, TZ: 0.4, BX: [-0.17, 0.27], BY: 0.8, BZ: 0.2, LEAN: [-0.13, 0.2] };
export const ARM = { SX: 0.84, SY: -0.32, SZ: 0.2, RX: 0.11, RY: 0.2, RZ: 0.1, CY: -0.16, BASE: 0.12 };
export const FOOT = { X: 0.16, Y: -1.0, Z: 0.2, RX: 0.12, RY: 0.11, RZ: 0.13 };
export const DEPTH = 0.9;

const YB = -0.99, YT = 0.99, S0 = 0.63;

/** Half-width of the body outline at height y (pear: dome-topped, widest at cheek level, rounded base). */
export function halfWidth(y: number) {
  const s = (y - YB) / (YT - YB);
  if (s <= 0 || s >= 1) return 0;
  if (s >= S0) { const u = (s - S0) / (1 - S0); return Math.pow(1 - Math.pow(u, 2.6), 1 / 2.6); }
  const u = (S0 - s) / S0;
  return Math.pow(1 - Math.pow(u, 2.5), 1 / 2.5);
}

/** Shallow depth: soft puffy cushion, falling to 0 at the outline. */
export function depthAt(x: number, y: number) {
  const w = halfWidth(y);
  if (w <= 0) return 0;
  const q = 1 - (x / w) * (x / w);
  return q > 0 ? DEPTH * Math.pow(q, 0.55) : 0;
}

export function earR(u: number) {
  const cap = 0.55;
  if (u < cap) return EAR.W * (0.84 + 0.16 * (u / cap));
  const q = (u - cap) / (1 - cap);
  return EAR.W * Math.sqrt(Math.max(0, 1 - q * q));
}

export interface UsagiModel {
  n: number;
  part: Uint8Array;
  rx: Float32Array; ry: Float32Array; rz: Float32Array;
  nx: Float32Array; ny: Float32Array; nz: Float32Array;
  cr: Float32Array; cg: Float32Array; cb: Float32Array;
  ao: Float32Array;
  seed: Float32Array; seed2: Float32Array;
  u: Float32Array;
  glitter: Uint8Array;
  buildKey: Float32Array;
  scatter: Float32Array;
  faceIdx: Int32Array;
  faceSlot: Int32Array;
  range: Array<[number, number]>;
}

export function buildUsagi(): UsagiModel {
  const rnd = mulberry32(870);
  const A: number[][] = [[], [], [], [], [], [], [], [], [], [], [], [], [], [], [], []];
  const [RX, RY, RZ, NX, NY, NZ, CR, CG, CB, AO, SEED, SEED2, U, GL, KEY, PARTS] = A;
  const range: Array<[number, number]> = [];

  const add = (
    part: number, x: number, y: number, z: number, nx: number, ny: number, nz: number,
    col: RGB, ao: number, u: number, key: number,
  ) => {
    const l = Math.hypot(nx, ny, nz) || 1;
    const v = 1 + (rnd() - 0.5) * 0.05;
    RX.push(x); RY.push(y); RZ.push(z); NX.push(nx / l); NY.push(ny / l); NZ.push(nz / l);
    CR.push(col[0] * v); CG.push(col[1] * v); CB.push(col[2] * v);
    AO.push(ao); SEED.push(rnd()); SEED2.push(rnd()); U.push(u);
    GL.push(rnd() < 0.012 ? 1 : 0); KEY.push(key); PARTS.push(part);
  };

  
  // ── torso: front cushion sampled uniformly over the silhouette + a thin back rim ──
  {
    const start = RX.length;
    const NF = 26000, e = 0.004;
    let got = 0;
    for (let i = 0; got < NF && i < NF * 3; i++) {
      const x = rnd() * 2.04 - 1.02;
      const y = YB + rnd() * (YT - YB);
      const w = halfWidth(y);
      if (Math.abs(x) >= w * 0.9995) continue;
      const z = depthAt(x, y);
      const dzdx = (depthAt(x + e, y) - depthAt(x - e, y)) / (2 * e);
      const dzdy = (depthAt(x, y + e) - depthAt(x, y - e)) / (2 * e);
      const key = clamp((y - YB) / (YT - YB));
      add(PART.TORSO, x, y, z, -dzdx, -dzdy, 1, C.BODY, 1, 0, key);
      got++;
      if (Math.abs(x) / w > 0.86) add(PART.TORSO, x, y, -z * 0.8, -dzdx, -dzdy, -1, C.BODY, 0.8, 0, key);
    }
    range[PART.TORSO] = [start, RX.length];
  }

  // ── ears: flattened tubes with rounded tips; pink strip sits toward the outer edge ──
  for (const part of [PART.EAR_L, PART.EAR_R]) {
    const s = part === PART.EAR_L ? -1 : 1;
    const start = RX.length;
    const N = 3600;
    for (let i = 0; i < N; i++) {
      const u = rnd();
      const phi = rnd() * TAU;
      const r = earR(u);
      const dr = clamp((earR(Math.min(1, u + 0.01)) - earR(Math.max(0, u - 0.01))) / 0.02, -7, 3);
      const cp = Math.cos(phi), sp = Math.sin(phi);
      const inner =
        smoothstep(0.05, 0.3, sp) *
        (1 - smoothstep(0.4, 0.62, Math.abs(cp - s * 0.32))) *
        smoothstep(0.1, 0.2, u) *
        (1 - smoothstep(0.8, 0.93, u));
      const col: RGB = [
        C.BODY[0] + (C.EAR[0] - C.BODY[0]) * inner,
        C.BODY[1] + (C.EAR[1] - C.BODY[1]) * inner,
        C.BODY[2] + (C.EAR[2] - C.BODY[2]) * inner,
      ];
      add(part, r * cp, u, EAR.TZ * r * sp, EAR.TZ * cp, (-dr / EAR.L) * 0.9, sp, col,
        0.74 + 0.26 * smoothstep(0, 0.3, u), u, 0.6 + 0.4 * u);
    }
    range[part] = [start, RX.length];
  }

  // ── arms & feet: tiny nubs ───────────────────────────────────────────────
  const ellipsoid = (part: number, N: number, rx: number, ry: number, rz: number, cy: number, ao: number, key: number) => {
    const start = RX.length;
    for (let i = 0; i < N; i++) {
      const ct = 1 - 2 * rnd();
      const st = Math.sqrt(1 - ct * ct);
      const ph = rnd() * TAU;
      const x = rx * st * Math.cos(ph), y = ry * ct, z = rz * st * Math.sin(ph);
      add(part, x, y + cy, z, x / (rx * rx), y / (ry * ry), z / (rz * rz), C.BODY, ao, 0, key);
    }
    range[part] = [start, RX.length];
  };
  ellipsoid(PART.ARM_L, 700, ARM.RX, ARM.RY, ARM.RZ, ARM.CY, 0.93, 0.5);
  ellipsoid(PART.ARM_R, 700, ARM.RX, ARM.RY, ARM.RZ, ARM.CY, 0.93, 0.5);
  ellipsoid(PART.FOOT_L, 600, FOOT.RX, FOOT.RY, FOOT.RZ, 0, 0.9, 0.05);
  ellipsoid(PART.FOOT_R, 600, FOOT.RX, FOOT.RY, FOOT.RZ, 0, 0.9, 0.05);

  const n = RX.length;
  const f32 = (arr: number[]) => Float32Array.from(arr);
  const scatter = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    scatter[i * 3] = (rnd() * 2 - 1) * 2.5;
    scatter[i * 3 + 1] = -1.15 + rnd() * 1.7;
    scatter[i * 3 + 2] = (rnd() * 2 - 1) * 1.1;
  }

  // face decal particles: front of the cushion from the chin line up to the forehead arcs
  const faceList: number[] = [];
  const faceSlot = new Int32Array(n).fill(-1);
  for (let i = range[PART.TORSO][0]; i < range[PART.TORSO][1]; i++) {
    if (RZ[i] > 0.05 && Math.abs(RX[i]) < 0.97 && RY[i] > -0.25 && RY[i] < 0.92) {
      faceSlot[i] = faceList.length;
      faceList.push(i);
    }
  }

  return {
    n, part: Uint8Array.from(PARTS),
    rx: f32(RX), ry: f32(RY), rz: f32(RZ), nx: f32(NX), ny: f32(NY), nz: f32(NZ),
    cr: f32(CR), cg: f32(CG), cb: f32(CB), ao: f32(AO),
    seed: f32(SEED), seed2: f32(SEED2), u: f32(U), glitter: Uint8Array.from(GL),
    buildKey: f32(KEY), scatter, faceIdx: Int32Array.from(faceList), faceSlot, range,
  };
}
