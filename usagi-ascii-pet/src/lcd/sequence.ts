import { buildUsagi } from '../core/model';
import { Animator, INTRO_DURATION, type StateName } from '../core/pose';
import { AsciiRenderer } from '../core/render';
import { Fx } from '../core/fx';
import { Background } from '../core/background';
import { CellGrid } from '../core/grid';

export const ANIMATION_STATES = ['intro', 'idle', 'thinking', 'happy', 'sleeping', 'error', 'excited'] as const;
export type AnimationState = (typeof ANIMATION_STATES)[number];

export interface CapturedFrame {
  chr: Uint8Array;
  fg: Uint16Array;
  dirty: number;
}

export interface CapturedClip {
  name: AnimationState;
  fps: number;
  loop: boolean;
  frames: CapturedFrame[];
}

export interface CapturedSequence {
  cols: number; rows: number; cw: number; ch: number; oy: number;
  clips: CapturedClip[];
}

export interface CaptureOptions {
  /** false preserves the original per-frame 3D output for A/B transfer tests. */
  coherent?: boolean;
}

const DURATIONS: Record<AnimationState, number> = {
  intro: INTRO_DURATION,
  idle: 4,
  thinking: 3,
  happy: 2.75,
  sleeping: 5,
  error: 4,
  excited: 1.875,
};

type Rect = readonly [number, number, number, number];

// Feature-sized masks, deliberately not a whole head rectangle: copying a face-sized
// patch would re-introduce the renderer's body-lighting noise on hundreds of cells.
const FACE: Rect[] = [[204, 148, 232, 177], [248, 148, 276, 177], [224, 178, 256, 198]];
const EARS: Rect[] = [[152, 25, 228, 132], [252, 25, 328, 132]];
const HEAD_FX: Rect[] = [[138, 40, 342, 130]];
const SLEEP_FX: Rect[] = [[276, 48, 362, 116]];

function inRects(c: number, r: number, g: CellGrid, rects: Rect[]) {
  const x = c * g.cw + g.cw / 2, y = g.oy + r * g.ch + g.ch / 2;
  return rects.some(([x0, y0, x1, y1]) => x >= x0 && x < x1 && y >= y0 && y < y1);
}

function bright565(v: number) {
  const r = (v >> 11) & 31, g = (v >> 5) & 63, b = v & 31;
  return r * 5 + g * 3 + b * 2 > 520; // body / ear / face, never the dim star field
}

function edgeBright(i: number, cells: number, cols: number, values: Uint16Array) {
  if (!bright565(values[i])) return false;
  const c = i % cols;
  return c === 0 || c === cols - 1 || i < cols || i >= cells - cols ||
    !bright565(values[i - 1]) || !bright565(values[i + 1]) ||
    !bright565(values[i - cols]) || !bright565(values[i + cols]);
}

/**
 * Converts the full renderer output to an LCD-temporally-coherent sequence. The first
 * frame is the exact renderer output. Later frames keep its silhouette/body texture
 * fixed and only admit face, ear and state-FX cells. This deliberately removes the
 * sub-cell 3D-lighting shimmer which is invisible as motion on ST7796S but costly.
 */
function makeCoherentClip(name: AnimationState, raw: CapturedFrame[], g: CellGrid) {
  if (name === 'intro') return raw; // one-time reveal is allowed to be large.
  const base = raw[0];
  const out: CapturedFrame[] = [];
  let prev = { chr: base.chr.slice(), fg: base.fg.slice() };
  for (let f = 0; f < raw.length; f++) {
    const src = raw[f];
    const chr = base.chr.slice(), fg = base.fg.slice();
    const regions = name === 'thinking' ? [...FACE, ...EARS, ...HEAD_FX]
      : name === 'sleeping' ? [...FACE, ...EARS, ...SLEEP_FX]
      : name === 'happy' || name === 'excited' ? [...FACE, ...EARS, ...HEAD_FX]
      : [...FACE, ...EARS];
    for (let i = 0; i < chr.length; i++) {
      const r = (i / g.cols) | 0, c = i - r * g.cols;
      if (!inRects(c, r, g, regions)) continue;
      const face = inRects(c, r, g, FACE);
      const ear = inRects(c, r, g, EARS);
      const fx = !face && !ear;
      // Ear interiors retain the keyframe texture; only their silhouette moves. This
      // is the temporal-coherence win: the 3D light no longer repaints the whole ear.
      const active = face || (ear && (edgeBright(i, chr.length, g.cols, src.fg) ||
        edgeBright(i, chr.length, g.cols, base.fg) || edgeBright(i, chr.length, g.cols, prev.fg))) ||
        (fx && !bright565(src.fg[i]) && !bright565(base.fg[i]) && (src.chr[i] !== 32 || base.chr[i] !== 32));
      if (!active) continue;
      chr[i] = src.chr[i]; fg[i] = src.chr[i] === 32 ? 0 : src.fg[i];
      // Suppress lighting-only RGB565 flutter. A glyph change always remains visible.
      if (chr[i] === prev.chr[i] && Math.abs(fg[i] - prev.fg[i]) < 0x0821) fg[i] = prev.fg[i];
    }
    // Idle / sleeping ear motion is sampled at 2 FPS; all face frames remain at 8 FPS.
    if ((name === 'idle' || name === 'sleeping') && f % 4 !== 0) {
      for (let i = 0; i < chr.length; i++) {
        const r = (i / g.cols) | 0, c = i - r * g.cols;
        if (inRects(c, r, g, EARS)) { chr[i] = prev.chr[i]; fg[i] = prev.fg[i]; }
      }
    }
    let dirty = 0;
    for (let i = 0; i < chr.length; i++) if (f === 0 || chr[i] !== prev.chr[i] || (chr[i] !== 32 && fg[i] !== prev.fg[i])) dirty++;
    out.push({ chr, fg, dirty });
    prev = { chr, fg };
  }
  return out;
}

/** Deterministically runs the original model/pose/lighting/FX renderer off-screen. */
export function captureAnimationSequence(fps = 8, cw = 4, ch = 5, options: CaptureOptions = {}): CapturedSequence {
  const clips: CapturedClip[] = [];
  for (const name of ANIMATION_STATES) {
    // Intro is the sole intentionally large-area effect. At 2 FPS it remains a
    // short reveal instead of monopolising the software-SPI bus for dozens of frames.
    const clipFps = name === 'intro' ? 2 : fps;
    const model = buildUsagi();
    const anim = new Animator();
    const fx = new Fx();
    const bg = new Background();
    const renderer = new AsciiRenderer(model);
    const grid = new CellGrid(cw, ch);
    const prev = new CellGrid(cw, ch);
    const frames: CapturedFrame[] = [];
    let time = 0;
    let introT: number | null = name === 'intro' ? 0 : null;
    if (name !== 'intro') anim.setState(name as StateName);
    const count = Math.max(2, Math.ceil(DURATIONS[name] * clipFps));
    for (let f = 0; f < count; f++) {
      const dt = f === 0 ? 1 / 60 : 1 / clipFps;
      time += dt;
      if (introT !== null) introT = Math.min(INTRO_DURATION, introT + dt);
      anim.update(dt, introT);
      fx.update(dt, anim, introT, time);
      renderer.render(grid, anim.pose, {
        persp: true, camPitch: 0.06, scale: 84, cx: 240, cy: 194, time,
        introT, yawOffset: 0, fx: fx.list, dim: anim.state === 'sleeping' ? 0.75 : 1,
      }, bg);
      let dirty = 0;
      for (let i = 0; i < grid.size; i++)
        if (f === 0 || grid.chr[i] !== prev.chr[i] || (grid.chr[i] !== 32 && grid.fg[i] !== prev.fg[i])) dirty++;
      frames.push({ chr: grid.chr.slice(), fg: grid.fg.slice(), dirty });
      prev.chr.set(grid.chr); prev.fg.set(grid.fg);
    }
    clips.push({ name, fps: clipFps, loop: name !== 'intro' && name !== 'excited', frames });
  }
  const g = new CellGrid(cw, ch);
  if (options.coherent !== false)
    for (const clip of clips) clip.frames = makeCoherentClip(clip.name, clip.frames, g);
  return { cols: g.cols, rows: g.rows, cw, ch, oy: g.oy, clips };
}

