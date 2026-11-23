// Mirrors the firmware (firmware_impl.h) and the Companion bridge JSON (DeviceSync.swift). IDs are the firmware's Action IDs.
export interface Knob { mode: number; map: number[][] }                         // map[6][CW, CCW, CLICK, HOLD]
export interface Rgb { effect: number; color: number; brightness: number; speed10: number; hue: number }
export interface DeviceConfig { active: number; keys: number[][][]; knob: Knob; rgb: Rgb; rev: number }
export interface ActionInfo { id: number; name: string; category: string; runsOn: 'mac' | 'device'; supported: boolean; custom: boolean; detail: string; def?: { type: string; value: string; label: string } }
export interface Status { ok: boolean; connected: boolean; confirmed: boolean; device: string; deviceId: string; accessibility: boolean; changeSeq: number; session: number; busy: boolean }

export const PROFILES = ['Dev', 'Media'];
export const INPUTS = ['Single', 'Double', 'Hold'] as const;
export const CATEGORIES = ['AI', 'Apps', 'Shortcut', 'Media', 'System', 'Device', 'Custom', 'None'];
export const KNOB_MODES = ['Volume', 'Media', 'Brightness', 'Reasoning', 'Scroll', 'Custom'];
export const KNOB_SLOTS = ['Clockwise', 'Counter-clockwise', 'Short click', 'Long press'];
export const EFFECTS = ['Off', 'Static', 'Breathing', 'Pastel Cycle'];
export const COLORS = ['Soft White', 'Pastel Pink', 'Pastel Sky', 'Custom'];

// Firmware defaults (DEFAULTS / KNOB_DEFAULTS / rgbConfig) used by "Reset".
export const KEY_DEFAULTS: number[][][] = [
  [[1, 0, 0], [2, 0, 0], [3, 0, 4], [10, 0, 0], [11, 0, 0], [12, 0, 0], [13, 0, 0], [40, 41, 0], [20, 0, 30]],
  [[22, 0, 0], [20, 0, 0], [21, 0, 0], [23, 0, 0], [10, 0, 0], [11, 0, 0], [1, 0, 0], [41, 40, 0], [31, 0, 30]]];
export const KNOB_DEFAULTS = [[50, 51, 23, 60], [21, 22, 20, 60], [52, 53, 0, 60], [54, 55, 56, 60], [57, 58, 0, 60], [0, 0, 0, 60]];
export const RGB_DEFAULT: Rgb = { effect: 2, color: 1, brightness: 35, speed10: 20, hue: 200 };

// Colour the key LED shows while that switch is held (KEY_RGB[]): overrides the ambient setting.
export const KEY_RGB: [number, number, number][] = [[255, 0, 0], [255, 64, 0], [255, 255, 0], [0, 255, 0], [0, 0, 255], [20, 0, 74], [0, 255, 255], [255, 0, 80], [255, 255, 255]];

// Physical layout (photo): SW1-3 bottom row, SW4/5, SW6/7, SW8/9 in two columns on the right. Same as the LCD Key Mapping screen.
export const KEY_POS: { col: number; row: number }[] = [
  { col: 2, row: 4 }, { col: 3, row: 4 }, { col: 4, row: 4 },
  { col: 5, row: 1 }, { col: 6, row: 1 }, { col: 5, row: 2 }, { col: 6, row: 2 }, { col: 5, row: 3 }, { col: 6, row: 3 }];

export function hueToRgb(deg: number): [number, number, number] {   // same maths as firmware hueToRgb (S = 150/255)
  deg = ((deg % 360) + 360) % 360; const sec = Math.floor(deg / 60), f = ((deg % 60) * 255) / 60, s = 150;
  const p = 255 - s, q = 255 - (s * f) / 255, t = 255 - (s * (255 - f)) / 255;
  return ([[255, t, p], [q, 255, p], [p, 255, t], [p, q, 255], [t, p, 255], [255, p, q]][sec] as [number, number, number]).map(Math.round) as [number, number, number];
}
export function baseColor(r: Rgb): [number, number, number] {
  return r.color === 1 ? [255, 170, 205] : r.color === 2 ? [155, 215, 255] : r.color === 3 ? hueToRgb(r.hue) : [255, 255, 255];
}
export const css = (c: [number, number, number]) => `rgb(${c[0]},${c[1]},${c[2]})`;
export const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));
