import { C, RGB } from './palette';
import { TAU, clamp, mulberry32, smoothstep } from './math';
import type { Animator, StateName } from './pose';

/** A glowing 3D particle drawn through the same z-buffer as Usagi (world units). */
export interface FxDraw { x: number; y: number; z: number; ch: number; r: number; g: number; b: number; w: number }

interface P {
  x: number; y: number; z: number; vx: number; vy: number; vz: number;
  age: number; max: number; ch: number; col: RGB; gy: number; kind: number; ph: number;
}

const CH = (s: string) => s.charCodeAt(0);
const PINK: RGB = C.CHEEK, SKY: RGB = C.SKY;
const MIXC: RGB[] = [C.CHEEK, C.BODY, C.SKY, C.EAR, C.WHITE];

export class Fx {
  list: FxDraw[] = [];
  private pool: P[] = [];
  private rnd = mulberry32(99);
  private orbitW = 0;
  private zIn = 0.8;
  private tearIn = 1.5;
  private emitAcc = 0;
  private amb: Array<{ a: number; R: number; h: number; sp: number; ph: number; pink: boolean; ch: number }> = [];

  constructor() {
    const r = this.rnd;
    for (let i = 0; i < 18; i++)
      this.amb.push({ a: r() * TAU, R: 1.5 + r() * 0.9, h: -0.7 + r() * 2.5, sp: (r() < 0.5 ? -1 : 1) * (0.12 + r() * 0.2),
        ph: r() * TAU, pink: r() < 0.5, ch: [CH('.'), CH('+'), CH('.'), CH('*')][Math.floor(r() * 4)] });
  }

  reset() { this.pool.length = 0; this.orbitW = 0; }

  burst(x: number, y: number, count: number, speed: number, palette: 'pink' | 'mix' | 'sky') {
    const r = this.rnd;
    for (let i = 0; i < count && this.pool.length < 300; i++) {
      const a = -Math.PI / 2 + (r() - 0.5) * 3.0 + (r() < 0.5 ? 0 : Math.PI * 0) ; // fan upward
      const v = speed * (0.5 + r() * 0.9);
      const col = palette === 'pink' ? (r() < 0.75 ? PINK : C.EAR) : palette === 'sky' ? SKY : MIXC[Math.floor(r() * MIXC.length)];
      this.pool.push({
        x: x + (r() - 0.5) * 0.9, y, z: 0.2 + r() * 0.7,
        vx: Math.sin(a) * v * 1.2, vy: -Math.cos(a) * v * 1.2 + 0.6, vz: (r() - 0.3) * 0.8,
        age: 0, max: 0.6 + r() * 0.7, ch: [CH('*'), CH('+'), CH('o'), CH('*'), CH('.')][Math.floor(r() * 5)],
        col, gy: -3.2, kind: 0, ph: r() * TAU,
      });
    }
  }

  update(dt: number, anim: Animator, introT: number | null, t: number) {
    const st: StateName = anim.state;
    const pose = anim.pose;
    for (const e of anim.events) this.burst(pose.rootX + e.x, pose.rootY + e.y, e.count, e.speed, e.palette);

    // continuous emitters
    if (st === 'excited') {
      this.emitAcc += dt * 46;
      while (this.emitAcc >= 1) {
        this.emitAcc -= 1;
        this.burst(pose.rootX, pose.rootY + this.rnd() * 1.2 - 0.3, 1, 1.5, 'mix');
      }
    }
    if (st === 'sleeping') {
      this.zIn -= dt;
      if (this.zIn <= 0 && this.pool.length < 300) {
        this.zIn = 1.7;
        this.pool.push({ x: 0.9, y: 0.85, z: 0.5, vx: 0.16, vy: 0.3, vz: 0, age: 0, max: 3.6, ch: this.rnd() < 0.5 ? CH('z') : CH('Z'),
          col: [168, 196, 214], gy: 0, kind: 1, ph: this.rnd() * TAU });
      }
    }
    if (st === 'error') {
      this.tearIn -= dt;
      if (this.tearIn <= 0 && this.pool.length < 300) {
        this.tearIn = 2.6;
        this.pool.push({ x: 0.3 + pose.rootX, y: 0.26 + pose.rootY, z: 0.55, vx: 0, vy: -0.05, vz: 0, age: 0, max: 1.8, ch: CH('.'),
          col: SKY, gy: -0.45, kind: 2, ph: 0 });
      }
    }
    this.orbitW += ((st === 'thinking' ? 1 : 0) - this.orbitW) * (1 - Math.exp(-dt * 3));

    for (let i = this.pool.length - 1; i >= 0; i--) {
      const p = this.pool[i];
      p.age += dt;
      if (p.age >= p.max) { this.pool.splice(i, 1); continue; }
      p.vy += p.gy * dt;
      if (p.kind === 0) { p.vx *= 1 - dt * 0.8; p.vz *= 1 - dt * 0.8; }
      p.x += p.vx * dt + (p.kind === 1 ? Math.sin(p.age * 2 + p.ph) * 0.004 : 0);
      p.y += p.vy * dt; p.z += p.vz * dt;
    }

    this.collect(t, introT, st);
  }

  private push(x: number, y: number, z: number, ch: number, col: ArrayLike<number>, w: number) {
    this.list.push({ x, y, z, ch, r: col[0], g: col[1], b: col[2], w });
  }

  private collect(t: number, introT: number | null, st: StateName) {
    this.list.length = 0;
    const calm = introT !== null ? smoothstep(3, 4.2, introT) : 1;

    // sparse pink / sky dust that only lives around Usagi
    for (const a of this.amb) {
      const ang = a.a + t * a.sp;
      const w = (0.35 + 0.35 * Math.sin(t * 0.9 + a.ph)) * calm * (st === 'sleeping' ? 0.7 : 1);
      if (w > 0.05) this.push(Math.cos(ang) * a.R, a.h + Math.sin(t * 0.3 + a.ph) * 0.15, Math.sin(ang) * a.R * 0.6,
        a.ch, a.pink ? PINK : SKY, w);
    }

    // thinking: sky-blue particles orbit the head (pass behind it → z-buffer hides them)
    if (this.orbitW > 0.02) {
      for (let i = 0; i < 16; i++) {
        const a = t * 1.7 + (i / 16) * TAU;
        const trail = (i % 4) / 4;
        const R = 1.38;
        this.push(Math.cos(a) * R, 0.5 + Math.sin(a * 2 + 1) * 0.08 + 0.15 * Math.sin(a), Math.sin(a) * R * 0.75,
          i % 4 === 0 ? CH('o') : i % 2 ? CH('+') : CH('.'), SKY, this.orbitW * (0.95 - trail * 0.5));
      }
    }

    // pool
    for (const p of this.pool) {
      const k = p.age / p.max;
      const fade = p.kind === 1 ? Math.sin(Math.PI * clamp(k)) : Math.pow(1 - k, 0.8);
      const ch = p.kind === 0 ? (k < 0.33 ? CH('*') : k < 0.66 ? p.ch : CH('.')) : p.ch;
      this.push(p.x, p.y, p.z, ch, p.col, fade);
    }
  }
}
