import type { StateName } from '../core/pose';
import { ACT, ACTIONS, INPUTS, action, loadConfig, saveConfig, defaultConfig, type InputType, type KeymapConfig } from './config';
import { applyMsg, expressionFor, initialStatus, type CompanionMsg, type DeviceStatus } from './status';

/**
 * Device logic: screen routing, physical-input handling, key-mapping editor, macro dispatch.
 * No DOM and no drawing — this is the part that ports to firmware as a plain state machine.
 * Inputs: PA7, SW1–SW9 (down/up), encoder rotate / click / long-press. `now` is milliseconds.
 */
export type Screen = 'home' | 'keymap';
export type Stage = 'key' | 'input' | 'action' | 'confirm';
export type Tone = 'pink' | 'sky' | 'gray';

const HOLD_MS = 450;
const DOUBLE_MS = 260;
const TOAST_MS = 1800;
const LUNCH = ['Bibimbap', 'Kimchi Stew', 'Ramen', 'Sushi', 'Burger', 'Pho', 'Tonkatsu', 'Salad', 'Curry', 'Kimbap'];

export class Device {
  screen: Screen = 'home';
  status: DeviceStatus = initialStatus('mock');
  config: KeymapConfig = loadConfig();
  /** key-mapping editor cursor. `pick` indexes ACTIONS, `confirm` 0 = Save, 1 = Cancel */
  km = { stage: 'key' as Stage, key: 0, input: 0, pick: 0, confirm: 0 };
  toast: { text: string; tone: Tone; until: number } | null = null;

  onExpression?: (s: StateName) => void;
  onReact?: () => void;
  onLog?: (line: string) => void;
  onChange?: () => void;

  private gesture: { sw: number; downAt: number; upAt: number; waiting: boolean; held: boolean } | null = null;
  private expr: StateName = 'sleeping';

  get profile() { return this.config.profiles[this.config.active]; }
  get binding() { return this.profile.keys[this.km.key]; }
  get inputType(): InputType { return INPUTS[this.km.input]; }
  get expression() { return this.expr; }

  // ── companion data ────────────────────────────────────────────────────────
  receive(m: CompanionMsg) {
    applyMsg(this.status, m);
    const e = expressionFor(this.status.ai);
    if (e !== this.expr) { this.expr = e; this.onExpression?.(e); }
    this.onChange?.();
  }

  // ── physical inputs ───────────────────────────────────────────────────────
  pa7(now: number) {
    this.gesture = null;
    if (this.screen === 'home') this.openKeymap();
    else {
      if (this.km.stage === 'confirm') this.say('Change discarded', 'gray', now);
      this.screen = 'home';
    }
    this.onChange?.();
  }

  swDown(i: number, now: number) {
    if (this.screen === 'keymap') {
      // editing: switches only select — macros never run here
      if (this.km.stage === 'confirm') this.say('Change discarded', 'gray', now);
      this.km.key = i; this.km.stage = 'input'; this.km.input = 0;
      this.onChange?.();
      return;
    }
    const g = this.gesture;
    if (g?.waiting && g.sw === i) { this.gesture = null; this.fire(i, 'double', now); return; }
    if (g?.waiting) this.fire(g.sw, 'single', now);
    this.gesture = { sw: i, downAt: now, upAt: 0, waiting: false, held: false };
  }

  swUp(i: number, now: number) {
    const g = this.gesture;
    if (this.screen !== 'home' || !g || g.sw !== i || g.waiting) return;
    if (g.held) { this.gesture = null; return; }
    // only wait for a second tap when a double action exists — single stays instant otherwise
    if (this.profile.keys[i].double) { g.waiting = true; g.upAt = now; }
    else { this.gesture = null; this.fire(i, 'single', now); }
  }

  rotate(dir: 1 | -1) {
    if (this.screen !== 'keymap') return;
    const k = this.km, wrap = (v: number, n: number) => (v + dir + n) % n;
    if (k.stage === 'key') k.key = wrap(k.key, 9);
    else if (k.stage === 'input') k.input = wrap(k.input, INPUTS.length);
    else if (k.stage === 'action') k.pick = wrap(k.pick, ACTIONS.length);
    else k.confirm = wrap(k.confirm, 2);
    this.onChange?.();
  }

  click(now: number) {
    if (this.screen !== 'keymap') return;
    const k = this.km;
    if (k.stage === 'key') { k.stage = 'input'; k.input = 0; }
    else if (k.stage === 'input') {
      k.stage = 'action';
      k.pick = Math.max(0, ACTIONS.findIndex((a) => a.id === this.binding[this.inputType]));
    } else if (k.stage === 'action') {
      if (ACTIONS[k.pick].id === this.binding[this.inputType]) { k.stage = 'input'; this.say('No change', 'gray', now); }
      else { k.stage = 'confirm'; k.confirm = 0; }
    } else {
      if (k.confirm === 0) {
        this.binding[this.inputType] = ACTIONS[k.pick].id;
        saveConfig(this.config); // the only write in the edit flow
        this.say(`Saved  SW${k.key + 1} ${this.inputType} · ${ACTIONS[k.pick].name}`, 'pink', now);
        this.onLog?.(`saved SW${k.key + 1} ${this.inputType} = ${ACTIONS[k.pick].name}`);
      } else this.say('Cancelled', 'gray', now);
      k.stage = 'input';
    }
    this.onChange?.();
  }

  /** previous step / cancel */
  longPress(now: number) {
    if (this.screen !== 'keymap') return;
    const k = this.km;
    if (k.stage === 'key') this.screen = 'home';
    else if (k.stage === 'input') k.stage = 'key';
    else if (k.stage === 'action') { k.stage = 'input'; this.say('Cancelled', 'gray', now); }
    else k.stage = 'action';
    this.onChange?.();
  }

  /** call every frame / main-loop pass: resolves hold + double-tap timeouts and expires the toast */
  tick(now: number) {
    const g = this.gesture;
    if (g && !g.waiting && !g.held && now - g.downAt >= HOLD_MS && this.profile.keys[g.sw].hold) {
      g.held = true; this.fire(g.sw, 'hold', now);
    } else if (g?.waiting && now - g.upAt >= DOUBLE_MS) { this.gesture = null; this.fire(g.sw, 'single', now); }
    if (this.toast && now >= this.toast.until) { this.toast = null; this.onChange?.(); }
  }

  resetConfig(now: number) {
    this.config = defaultConfig();
    saveConfig(this.config);
    this.km.stage = 'key';
    this.say('Defaults restored', 'gray', now);
    this.onChange?.();
  }

  // ── internals ─────────────────────────────────────────────────────────────
  private openKeymap() { this.screen = 'keymap'; this.km.stage = 'key'; this.toast = null; }

  private say(text: string, tone: Tone, now: number) { this.toast = { text, tone, until: now + TOAST_MS }; }

  /** Home only. Real firmware sends HID / serial here; the prototype reports what would run. */
  private fire(sw: number, type: InputType, now: number) {
    const a = action(this.profile.keys[sw][type]);
    if (a.id === ACT.NONE) { this.say(`SW${sw + 1} unassigned`, 'gray', now); this.onChange?.(); return; }
    let label = a.name;
    if (a.id === ACT.NEXT_PROFILE) {
      this.config.active = (this.config.active + 1) % this.config.profiles.length;
      saveConfig(this.config);
      label = `Profile · ${this.profile.name}`;
    } else if (a.id === ACT.OPEN_KEYMAP) this.openKeymap();
    else if (a.id === ACT.USAGI_REACT) this.onReact?.();
    else if (a.id === ACT.LUNCH) label = `Lunch · ${LUNCH[Math.floor(Math.random() * LUNCH.length)]}`;
    if (this.screen === 'home') this.say(`SW${sw + 1} · ${label}`, a.cat === 'Fun' ? 'pink' : 'sky', now);
    this.onLog?.(`SW${sw + 1} ${type} → ${label}`);
    this.onChange?.();
  }
}
