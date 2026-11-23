import { TAU, clamp, smoothstep, damp, mulberry32 } from './math';

export type StateName = 'idle' | 'happy' | 'thinking' | 'sleeping' | 'error' | 'excited';
export const STATE_LIST: StateName[] = ['idle', 'happy', 'thinking', 'sleeping', 'error', 'excited'];
export const EXCITED_DURATION = 1.9;
export const INTRO_DURATION = 5.0;

/** Everything the renderer needs to deform + dress the model for one frame. Pure numbers. */
export interface Pose {
  rootX: number; rootY: number; sx: number; sy: number; sz: number;
  roll: number; pitch: number; yaw: number;
  eyeOpen: number; eyeHappy: number; eyeSleep: number; eyeSad: number; eyeBig: number;
  lookX: number; lookY: number;
  mouthOpen: number; mouthSmile: number; mouthSize: number; mouthShape: number;
  cheekGlow: number; desat: number;
  earSplayL: number; earSplayR: number;
  earOutL: number; earOutR: number; earFwdL: number; earFwdR: number;
  earSwayL: number; earSwayR: number;
  armRaiseL: number; armRaiseR: number;
}

export const makePose = (): Pose => ({
  rootX: 0, rootY: 0, sx: 1, sy: 1, sz: 1, roll: 0, pitch: 0, yaw: 0,
  eyeOpen: 1, eyeHappy: 0, eyeSleep: 0, eyeSad: 0, eyeBig: 0, lookX: 0, lookY: 0,
  mouthOpen: 0, mouthSmile: 0.6, mouthSize: 1, mouthShape: 0, cheekGlow: 0.2, desat: 0,
  earSplayL: 0.1, earSplayR: 0.1, earOutL: 0.1, earOutR: 0.1, earFwdL: 0.1, earFwdR: 0.1,
  earSwayL: 0, earSwayR: 0, armRaiseL: 0, armRaiseR: 0,
});

export interface FxEvent {
  x: number; y: number; count: number; speed: number;
  palette: 'pink' | 'mix' | 'sky';
}

type Tgt = Partial<Pose>;

class Spring {
  x = 0; v = 0;
  constructor(public k: number, public c: number) {}
  step(target: number, dt: number, drive = 0) {
    const n = Math.max(1, Math.ceil(dt / 0.008));
    const h = dt / n;
    for (let i = 0; i < n; i++) {
      this.v += (-this.k * (this.x - target) - this.c * this.v + drive) * h;
      this.x += this.v * h;
    }
  }
}

/** One hop: anticipation squash → stretch in the air → landing squash with overshoot. */
function jumpCurve(p: number, H: number) {
  if (p < 0.2) return { y: 0, sy: 1 - 0.14 * Math.sin((p / 0.2) * Math.PI * 0.5) };
  if (p < 0.75) {
    const q = (p - 0.2) / 0.55;
    return { y: H * 4 * q * (1 - q), sy: 1 + 0.1 * Math.pow(Math.abs(2 * q - 1), 1.5) };
  }
  const r = (p - 0.75) / 0.25;
  return { y: 0, sy: 1 - 0.16 * Math.exp(-2.8 * r) * Math.cos(r * Math.PI * 1.2) };
}

const DIRECT = new Set(['rootX', 'rootY', 'sx', 'sy', 'sz']);
const SPRING_KEYS = ['earOutL', 'earOutR', 'earFwdL', 'earFwdR', 'earSwayL', 'earSwayR', 'armRaiseL', 'armRaiseR'];

export class Animator {
  pose = makePose();
  state: StateName = 'idle';
  stateT = 0;
  events: FxEvent[] = [];
  onAutoReturn?: () => void;

  private rng = mulberry32(11);
  private blinkIn = 2.4;
  private blinkT = -1;
  private gazeIn = 3;
  private gx = 0;
  private gy = 0;
  private twitchIn = 5;
  private prevStage = -1;
  private prevY = 0;
  private prevX = 0;
  private vy = 0;
  private vx = 0;
  private sp: Record<string, Spring> = {};

  constructor() {
    for (const k of SPRING_KEYS) {
      const arm = k.startsWith('arm');
      const sway = k.includes('Sway');
      this.sp[k] = new Spring(arm ? 70 : sway ? 46 : 55, arm ? 7 : sway ? 3.2 : 6);
    }
    this.sp.earOutL.x = this.sp.earOutR.x = 0.1;
    this.sp.earFwdL.x = this.sp.earFwdR.x = 0.1;
  }

  setState(s: StateName) {
    if (s === this.state) { this.stateT = 0; return; }
    this.state = s;
    this.stateT = 0;
    this.prevStage = -1;
    this.blinkIn = 1 + this.rng() * 2;
  }

  forceBlink() { if (this.blinkT < 0) this.blinkT = 0; }

  private idle(t: number): Tgt {
    const br = Math.sin((t * TAU) / 3.8);
    return {
      rootX: 0, rootY: 0,
      sy: 1 + 0.02 * br, sx: 1 - 0.01 * br, sz: 1 - 0.01 * br,
      roll: 0.11 * Math.sin((t * TAU) / 7.3),
      yaw: 0.09 * Math.sin((t * TAU) / 9.1 + 0.7),
      pitch: 0.02 * Math.sin((t * TAU) / 5.2),
      eyeOpen: 1, eyeHappy: 0, eyeSleep: 0, eyeSad: 0, eyeBig: 0, lookX: this.gx, lookY: this.gy,
      mouthOpen: 0, mouthSmile: 0.7, mouthSize: 1, mouthShape: 0, cheekGlow: 0.25, desat: 0,
      earSplayL: 0, earSplayR: 0,
      earOutL: 0.05, earOutR: 0.05, earFwdL: 0.04, earFwdR: 0.04,
      earSwayL: 0.1 * Math.sin((t * TAU) / 4.1 + 0.3),
      earSwayR: 0.09 * Math.sin((t * TAU) / 3.3 + 1.6),
      armRaiseL: 0.03 * br, armRaiseR: 0.03 * br,
    };
  }

  private targets(t: number, introT: number | null): Tgt {
    const base = this.idle(t);
    const T = this.time(t);

    if (introT !== null && this.state === 'idle') {
      if (introT < 4) return base;
      const g = introT - 4;
      const env = smoothstep(0, 0.15, g) * (1 - smoothstep(0.8, 1, g));
      const wave = Math.sin(g * TAU * 3.2);
      const jp = (g - 0.4) / 0.55;
      const j = jp >= 0 && jp <= 1 ? jumpCurve(jp, 0.2) : { y: 0, sy: 1 };
      if (g > 0.05 && g < 0.1) this.forceBlink();
      return {
        ...base, rootY: j.y, sy: j.sy, sx: 1 / Math.sqrt(j.sy), sz: 1 / Math.sqrt(j.sy),
        armRaiseR: (1.55 + 0.4 * wave) * env, mouthOpen: 0.35 * env, mouthSmile: 1, cheekGlow: 0.7,
        eyeHappy: smoothstep(0.35, 0.45, g) * (1 - smoothstep(0.75, 0.9, g)),
        earSwayL: 0.5 * Math.sin(g * TAU * 2.5) * env, earSwayR: -0.5 * Math.sin(g * TAU * 2.5 + 0.8) * env,
        roll: 0.1 * Math.sin(g * TAU * 1.5),
      };
    }

    switch (this.state) {
      case 'happy': {
        const cyc = 2.6, Tj = 0.62, c = t % cyc;
        let jp = -1, idx = 0;
        if (c < Tj) jp = c / Tj;
        else if (c < 2 * Tj) { jp = (c - Tj) / Tj; idx = 1; }
        let y = 0, sy = 1 + 0.03 * Math.sin(t * TAU * 1.4);
        if (jp >= 0) {
          const j = jumpCurve(jp, 0.32);
          y = j.y; sy = j.sy;
          const stage = idx * 3 + (jp < 0.2 ? 0 : jp < 0.75 ? 1 : 2);
          if (stage !== this.prevStage) {
            if (stage % 3 === 1) this.events.push({ x: 0, y: -0.95, count: 10, speed: 1.4, palette: 'pink' });
            if (stage % 3 === 2) this.events.push({ x: 0, y: -0.95, count: 26, speed: 2.2, palette: 'pink' });
            this.prevStage = stage;
          }
        } else this.prevStage = -1;
        return {
          ...base, rootY: y, sy, sx: 1 / Math.sqrt(sy), sz: 1 / Math.sqrt(sy),
          eyeHappy: 1, mouthOpen: 0.5, mouthSmile: 1, mouthSize: 1.1, cheekGlow: 1,
          roll: 0.07 * Math.sin((t * TAU) / 1.3), yaw: 0.05 * Math.sin((t * TAU) / 2.1),
          armRaiseL: 0.85, armRaiseR: 0.85, earSplayL: 0.2, earSplayR: 0.2,
        };
      }
      case 'thinking':
        return {
          ...base,
          roll: 0.2 + 0.03 * Math.sin((t * TAU) / 3), yaw: -0.14, pitch: 0.05,
          lookX: 0.07, lookY: 0.08, eyeBig: 0.05,
          mouthOpen: 0.18, mouthSize: 0.45, mouthSmile: 0, cheekGlow: 0.2,
          earSwayL: 0.32 * Math.sin((t * TAU) / 2.4), earFwdL: 0.3 + 0.2 * Math.sin((t * TAU) / 2.4 + 1),
          earOutL: 0.15, earSplayL: 0.05, earSwayR: 0.03, armRaiseR: 0.5,
        };
      case 'sleeping': {
        const br = Math.sin((t * TAU) / 5);
        return {
          ...base,
          sy: 0.9 + 0.035 * br, sx: 1.04 - 0.015 * br, sz: 1.03,
          roll: 0.05 * Math.sin((t * TAU) / 9), yaw: 0, pitch: 0.24 + 0.01 * br,
          eyeSleep: 1, mouthOpen: 0, mouthSmile: 0.3, mouthSize: 0.8, cheekGlow: 0.35,
          earSplayL: 0.55, earSplayR: 0.55, earOutL: 1.3, earOutR: 1.3, earFwdL: 0.2, earFwdR: 0.2,
          earSwayL: 0.03 * br, earSwayR: -0.03 * br, armRaiseL: -0.1, armRaiseR: -0.1,
          lookX: 0, lookY: 0,
        };
      }
      case 'error': {
        const br = Math.sin((t * TAU) / 5.5);
        return {
          ...base,
          sy: 1 + 0.008 * br, sx: 1 - 0.004 * br, sz: 1 - 0.004 * br,
          pitch: 0.14, roll: -0.05, yaw: 0.04 * Math.sin((t * TAU) / 7),
          eyeSad: 1, eyeBig: 0.14, lookX: 0, lookY: -0.03,
          mouthSmile: -0.85, mouthSize: 0.75, cheekGlow: 0, desat: 0.3,
          earSplayL: 0.4, earSplayR: 0.4, earOutL: 0.95, earOutR: 0.95, earFwdL: 0.2, earFwdR: 0.2,
          earSwayL: 0.02 * br, earSwayR: -0.02 * br, armRaiseL: -0.12, armRaiseR: -0.12,
        };
      }
      case 'excited': {
        const env = smoothstep(0, 0.15, T) * (1 - smoothstep(1.5, EXCITED_DURATION, T));
        const hopT = 0.46;
        const p = (T % hopT) / hopT;
        const j = jumpCurve(p, 0.3);
        const stage = Math.floor(T / hopT) * 3 + (p < 0.2 ? 0 : p < 0.75 ? 1 : 2);
        if (stage !== this.prevStage) {
          if (stage % 3 === 1) this.events.push({ x: 0, y: -0.9, count: 8, speed: 1.6, palette: 'mix' });
          if (stage % 3 === 2) this.events.push({ x: 0, y: -0.9, count: 16, speed: 2.4, palette: 'mix' });
          this.prevStage = stage;
        }
        const sy = 1 + (j.sy - 1) * env;
        const fl = Math.sin(T * TAU * 3);
        return {
          ...base, rootY: j.y * env, rootX: 0.55 * env * Math.sin((T * TAU) / 0.92),
          sy, sx: 1 / Math.sqrt(sy), sz: 1 / Math.sqrt(sy),
          roll: 0.2 * env * Math.sin(T * TAU * 4.5), yaw: 0.12 * env * Math.sin(T * TAU * 2.2),
          eyeBig: 0.28, mouthOpen: 1, mouthSmile: 0.8, mouthSize: 1.25, mouthShape: 1, cheekGlow: 1,
          earSwayL: 0.9 * env * fl, earSwayR: -0.9 * env * fl,
          earFwdL: 0.2 + 0.3 * env, earFwdR: 0.2 + 0.3 * env, earSplayL: 0.25, earSplayR: 0.25,
          armRaiseL: 1.2 + 0.7 * env * Math.sin(T * TAU * 4), armRaiseR: 1.2 - 0.7 * env * Math.sin(T * TAU * 4),
        };
      }
      default:
        return base;
    }
  }

  private time(t: number) { return t; }

  update(dt: number, introT: number | null) {
    this.events.length = 0;
    this.stateT += dt;
    const P = this.pose as unknown as Record<string, number>;
    const s = this.state;
    const slow = s === 'sleeping' ? 1.7 : s === 'error' ? 1.4 : 1;

    // gaze + ear twitch (idle only)
    this.gazeIn -= dt;
    if (this.gazeIn <= 0) {
      const opts: Array<[number, number]> = [[0, 0], [0.06, 0.01], [-0.06, 0], [0.04, 0.045], [0, -0.02], [-0.05, 0.03]];
      const o = opts[Math.floor(this.rng() * opts.length)];
      this.gx = o[0]; this.gy = o[1];
      this.gazeIn = 2.5 + this.rng() * 3.5;
    }
    this.twitchIn -= dt;
    if (this.twitchIn <= 0) {
      const k = this.rng() < 0.5 ? 'earSwayL' : 'earSwayR';
      this.sp[k].v += (this.rng() < 0.5 ? -1 : 1) * 1.8;
      this.twitchIn = 5 + this.rng() * 4;
    }

    const tg = this.targets(this.stateT, introT) as Record<string, number>;
    for (const k in tg) {
      if (SPRING_KEYS.includes(k)) continue;
      P[k] = damp(P[k], tg[k], DIRECT.has(k) ? 0.025 : 0.14 * slow, dt);
    }

    // secondary motion: ears & arms lag behind the body
    const vyN = (P.rootY - this.prevY) / Math.max(dt, 1e-3);
    const vxN = (P.rootX - this.prevX) / Math.max(dt, 1e-3);
    const ay = clamp((vyN - this.vy) / Math.max(dt, 1e-3), -90, 90);
    const ax = clamp((vxN - this.vx) / Math.max(dt, 1e-3), -90, 90);
    this.vy = vyN; this.vx = vxN; this.prevY = P.rootY; this.prevX = P.rootX;
    for (const k of SPRING_KEYS) {
      let drive = 0;
      if (k.startsWith('earOut')) drive = ay * 0.5;
      else if (k.startsWith('earSway')) drive = (k.endsWith('L') ? 1 : -1) * ax * 0.35;
      else if (k.startsWith('armRaise')) drive = -ay * 0.7;
      this.sp[k].step(tg[k] ?? 0, dt, drive);
      P[k] = this.sp[k].x;
    }

    // blink (not while eyes are drawn as arcs)
    this.blinkIn -= dt;
    if (this.blinkIn <= 0 && this.blinkT < 0 && (s === 'idle' || s === 'thinking' || s === 'error')) {
      this.blinkT = 0;
      this.blinkIn = 3 + this.rng() * 2;
    }
    let mul = 1;
    if (this.blinkT >= 0) {
      this.blinkT += dt;
      mul = 1 - Math.sin(clamp(this.blinkT / 0.16) * Math.PI);
      if (this.blinkT >= 0.16) this.blinkT = -1;
    }
    this.pose.eyeOpen = (tg.eyeOpen ?? 1) * mul;

    if (s === 'excited' && this.stateT >= EXCITED_DURATION) {
      this.setState('idle');
      this.onAutoReturn?.();
    }
  }
}
