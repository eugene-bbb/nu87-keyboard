import { buildUsagi } from '../core/model';
import { Animator, STATE_LIST, INTRO_DURATION, type StateName } from '../core/pose';
import { AsciiRenderer } from '../core/render';
import { Fx } from '../core/fx';
import { Background } from '../core/background';
import { CellGrid, DENSITIES, LCD_W, LCD_H, diffGrids, copyGrid } from '../core/grid';
import { makeFont, type Font } from '../lcd/font';
import { Lcd } from '../lcd/screen';
import { exportCHeader } from '../lcd/export';
import { Regions, makeUiFonts, type UiFonts } from '../ui/gfx';
import { drawHome, drawKeymap, HOME_RESERVED } from '../ui/screens';
import type { Device, Screen } from '../ui/device';

export interface Settings {
  speed: number; density: number; yaw: number; persp: boolean;
  glow: boolean; showDirty: boolean; autoCycle: boolean;
}
export interface Stats { fps: number; ms: number; dirty: number; cells: number; uiPx: number; spiBytes: number; particles: number; introT: number | null; state: StateName }

const STAGE_CX = LCD_W / 2;
const STAGE_CY = 194;
const SCALE = 84;

export class Engine {
  settings: Settings = {
    speed: 1, density: 3, yaw: 0, persp: true, glow: true, showDirty: false, autoCycle: false,
  };
  onState?: (s: StateName) => void;
  onStats?: (s: Stats) => void;

  private model = buildUsagi();
  private anim = new Animator();
  private fx = new Fx();
  private bg = new Background();
  private renderer = new AsciiRenderer(this.model);
  private lcd = new Lcd();
  private regions = new Regions(this.lcd);
  private uiFonts: UiFonts;
  private mask!: Uint8Array;
  private screen: Screen | null = null;
  private glowCv = document.createElement('canvas');
  private glowCtx!: CanvasRenderingContext2D;
  private cellFont!: Font;
  private grid!: CellGrid;
  private prev!: CellGrid;
  private dirty = new Int32Array(20000);
  private dirtyN = 0;
  private densityApplied = -1;
  private introT: number | null = 0;
  private time = 0;
  private raf = 0;
  private last = 0;
  private fpsAcc = 0; private fpsN = 0; private msAcc = 0; private statT = 0; private uiPxAcc = 0; private spiAcc = 0;
  private cycleT = 0;
  private ctx: CanvasRenderingContext2D;
  private off: HTMLCanvasElement;
  private offCtx: CanvasRenderingContext2D;
  private img: ImageData;
  private featCv = document.createElement('canvas');
  private featCtx!: CanvasRenderingContext2D;
  private featImg!: ImageData;

  constructor(canvas: HTMLCanvasElement, private ui: Device) {
    canvas.width = LCD_W; canvas.height = LCD_H;
    this.ctx = canvas.getContext('2d')!;
    this.off = document.createElement('canvas');
    this.off.width = LCD_W; this.off.height = LCD_H;
    this.offCtx = this.off.getContext('2d')!;
    this.img = this.offCtx.createImageData(LCD_W, LCD_H);
    this.featCv.width = LCD_W; this.featCv.height = LCD_H;
    this.featCtx = this.featCv.getContext('2d')!;
    this.featImg = this.featCtx.createImageData(LCD_W, LCD_H);
    this.uiFonts = makeUiFonts();
    // AI status drives the expression; one-shot reactions fall back to it
    ui.onExpression = (s) => this.setState(s);
    ui.onReact = () => this.setState('excited');
    this.anim.onAutoReturn = () => this.setState(ui.expression);
    this.glowCv.width = LCD_W; this.glowCv.height = LCD_H;
    this.glowCtx = this.glowCv.getContext('2d')!;
    this.applyDensity();
  }

  get state() { return this.anim.state; }

  setState(s: StateName) { this.anim.setState(s); this.onState?.(s); }

  replayIntro() {
    this.introT = 0; this.time = 0; this.fx.reset();
    this.setState(this.ui.expression);
    this.grid.clear(); this.screen = null;
  }

  exportC() { return exportCHeader(this.grid, this.cellFont); }

  start() {
    const loop = (ts: number) => {
      this.raf = requestAnimationFrame(loop);
      this.frame(ts);
    };
    this.raf = requestAnimationFrame(loop);
  }
  stop() { cancelAnimationFrame(this.raf); }

  private applyDensity() {
    const d = DENSITIES[this.settings.density];
    this.cellFont = makeFont(d.cw, d.ch);
    this.grid = new CellGrid(d.cw, d.ch);
    this.prev = new CellGrid(d.cw, d.ch);
    this.grid.clear();
    // cells under the Home HUD corners are never pushed (the HUD owns those pixels)
    const g = this.grid;
    this.mask = new Uint8Array(g.size);
    for (let i = 0; i < g.size; i++) {
      const r = (i / g.cols) | 0, x = (i - r * g.cols) * g.cw, y = g.oy + r * g.ch;
      if (HOME_RESERVED.some(([x0, y0, x1, y1]) => x < x1 && x + g.cw > x0 && y < y1 && y + g.ch > y0)) this.mask[i] = 1;
    }
    this.screen = null;
    this.densityApplied = this.settings.density;
  }

  private frame(ts: number) {
    const real = this.last ? Math.min(0.1, (ts - this.last) / 1000) : 1 / 60;
    this.last = ts;
    const S = this.settings;
    if (S.density !== this.densityApplied) this.applyDensity();
    const t0 = performance.now();
    const dt = Math.min(0.05, real) * S.speed;

    this.time += dt;
    if (this.introT !== null) {
      this.introT += dt;
      if (this.introT >= INTRO_DURATION) this.introT = null;
    }
    if (S.autoCycle && this.introT === null) {
      this.cycleT += dt;
      if (this.cycleT > 6.5) {
        this.cycleT = 0;
        const i = STATE_LIST.indexOf(this.anim.state);
        this.setState(STATE_LIST[(i + 1) % STATE_LIST.length]);
      }
    }

    this.anim.update(dt, this.introT);
    this.fx.update(dt, this.anim, this.introT, this.time);
    const st = this.anim.state;
    const ui = this.ui;
    ui.tick(ts);

    // screen change: the one full clear. Everything after is partial.
    if (ui.screen !== this.screen) {
      this.screen = ui.screen;
      this.lcd.clear(); this.regions.invalidate(); this.prev.clear();
    }
    this.regions.begin();
    this.dirtyN = 0;
    if (this.screen === 'home') {
      this.renderer.render(this.grid, this.anim.pose, {
        persp: S.persp, camPitch: 0.06, scale: SCALE, cx: STAGE_CX, cy: STAGE_CY, time: this.time,
        introT: this.introT, yawOffset: (S.yaw * Math.PI) / 180, fx: this.fx.list,
        dim: st === 'sleeping' ? 0.75 : 1,
      }, this.bg);
      // dirty-cell update: only changed cells are re-blitted to the framebuffer
      const n = diffGrids(this.grid, this.prev, this.dirty);
      for (let k = 0; k < n; k++) if (!this.mask[this.dirty[k]]) this.dirty[this.dirtyN++] = this.dirty[k];
      this.lcd.blitGrid(this.grid, this.cellFont, this.dirty, this.dirtyN);
      copyGrid(this.grid, this.prev);
      drawHome(this.regions, this.lcd, this.uiFonts, ui);
    } else {
      // Key Mapping is static between inputs: no Usagi render, no SPI traffic while idle
      drawKeymap(this.regions, this.lcd, this.uiFonts, ui);
    }

    this.present();
    const ms = performance.now() - t0;

    let uiPx = 0;
    const rc = this.regions.rects;
    for (let i = 0; i < rc.length; i += 4) uiPx += rc[i + 2] * rc[i + 3];
    this.uiPxAcc += uiPx;
    this.spiAcc += (this.dirtyN * this.grid.cw * this.grid.ch + uiPx) * 2;
    this.fpsAcc += real; this.fpsN++; this.msAcc += ms; this.statT += real;
    if (this.statT >= 0.4) {
      this.onStats?.({
        fps: this.fpsN / this.fpsAcc, ms: this.msAcc / this.fpsN, dirty: this.dirtyN, cells: this.grid.size,
        uiPx: this.uiPxAcc, spiBytes: Math.round(this.spiAcc / this.fpsN),
        particles: this.renderer.stats.particles, introT: this.introT, state: st,
      });
      this.fpsAcc = 0; this.fpsN = 0; this.msAcc = 0; this.statT = 0; this.uiPxAcc = 0; this.spiAcc = 0;
    }
  }

  /** BROWSER_ONLY: the glow pass is a canvas filter — it is not part of the LCD pipeline. */
  private present() {
    new Uint32Array(this.img.data.buffer).set(this.lcd.fb);
    this.offCtx.putImageData(this.img, 0, 0);
    const c = this.ctx;
    c.globalCompositeOperation = 'source-over';
    c.globalAlpha = 1;
    c.filter = 'none';
    c.drawImage(this.off, 0, 0);
    if (this.settings.glow && this.screen === 'home') {
      // glow source = lit stage glyphs only: the background stays exactly #0C0E12 and HUD text stays crisp
      const fbuf = this.lcd.fb, bgc = this.lcd.bg, gp = new Uint32Array(this.featImg.data.buffer);
      gp.fill(0);
      for (let q = 25 * LCD_W; q < 295 * LCD_W; q++) if (fbuf[q] !== bgc) gp[q] = fbuf[q];
      for (const [x0, y0, x1, y1] of HOME_RESERVED) for (let y = y0; y < y1; y++) gp.fill(0, y * LCD_W + x0, y * LCD_W + x1);
      this.glowCtx.putImageData(this.featImg, 0, 0);
      c.save();
      c.globalCompositeOperation = 'lighter';
      c.filter = 'blur(2.5px)'; c.globalAlpha = 0.55; c.drawImage(this.glowCv, 0, 0);
      c.filter = 'blur(9px)'; c.globalAlpha = 0.45; c.drawImage(this.glowCv, 0, 0);
      c.restore();
      // BROWSER_ONLY: glyph pixels of eye/mouth cells are re-laid over the glow so the glow cannot wash out the dark pupils
      const g = this.grid, W = LCD_W, fb = this.lcd.fb;
      const px = new Uint32Array(this.featImg.data.buffer);
      px.fill(0);
      for (const i of this.renderer.features.touched) {
        const r = (i / g.cols) | 0, x0 = (i - r * g.cols) * g.cw, y0 = g.oy + r * g.ch;
        for (let j = 0; j < g.ch; j++) for (let k = 0; k < g.cw; k++) { const q = (y0 + j) * W + x0 + k; px[q] = fb[q]; }
      }
      this.featCtx.putImageData(this.featImg, 0, 0);
      c.drawImage(this.featCv, 0, 0);
    }
    if (this.settings.showDirty) {
      const g = this.grid;
      c.fillStyle = 'rgba(90,160,255,0.35)';
      for (let k = 0; k < this.dirtyN; k++) {
        const i = this.dirty[k];
        const r = (i / g.cols) | 0;
        c.fillRect((i - r * g.cols) * g.cw, g.oy + r * g.ch, g.cw, g.ch);
      }
      c.fillStyle = 'rgba(242,181,204,0.4)';
      const rc = this.regions.rects;
      for (let i = 0; i < rc.length; i += 4) c.fillRect(rc[i], rc[i + 1], rc[i + 2], rc[i + 3]);
    }
  }
}
