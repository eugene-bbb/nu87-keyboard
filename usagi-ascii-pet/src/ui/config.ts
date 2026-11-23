/**
 * Key-mapping settings. The same structure is meant for NU87 non-volatile storage and web sync:
 *   [magic u8][version u8][active u8][profileCount u8] + per profile: name[8] + 9 × (single, double, hold) u8 action ids.
 * Action ids are stable u8 values — never renumber, only append.
 */
export type Category = 'AI' | 'Shortcut' | 'Media' | 'Device' | 'Fun';
export const CATEGORIES: Category[] = ['AI', 'Shortcut', 'Media', 'Device', 'Fun'];

export interface Action { id: number; cat: Category | null; name: string; /** ≤ 8 chars, shown on the 3×3 grid */ short: string }

export const ACT = { NONE: 0, NEXT_PROFILE: 30, OPEN_KEYMAP: 31, USAGI_REACT: 40, LUNCH: 41 } as const;

/** Picker order: categories in CATEGORIES order, "None" last. */
export const ACTIONS: Action[] = [
  { id: 1, cat: 'AI', name: 'Claude', short: 'Claude' },
  { id: 2, cat: 'AI', name: 'Codex', short: 'Codex' },
  { id: 3, cat: 'AI', name: 'AI Accept', short: 'Accept' },
  { id: 4, cat: 'AI', name: 'AI Stop', short: 'Stop' },
  { id: 10, cat: 'Shortcut', name: 'Copy', short: 'Copy' },
  { id: 11, cat: 'Shortcut', name: 'Paste', short: 'Paste' },
  { id: 12, cat: 'Shortcut', name: 'Undo', short: 'Undo' },
  { id: 13, cat: 'Shortcut', name: 'Screenshot', short: 'Capture' },
  { id: 20, cat: 'Media', name: 'Play / Pause', short: 'Play' },
  { id: 21, cat: 'Media', name: 'Next Track', short: 'Next' },
  { id: 22, cat: 'Media', name: 'Previous Track', short: 'Prev' },
  { id: 23, cat: 'Media', name: 'Mute', short: 'Mute' },
  { id: ACT.NEXT_PROFILE, cat: 'Device', name: 'Next Profile', short: 'Profile' },
  { id: ACT.OPEN_KEYMAP, cat: 'Device', name: 'Key Mapping', short: 'Keymap' },
  { id: ACT.USAGI_REACT, cat: 'Fun', name: 'Usagi React', short: 'Usagi' },
  { id: ACT.LUNCH, cat: 'Fun', name: 'Lunch Roulette', short: 'Lunch' },
  { id: ACT.NONE, cat: null, name: 'None', short: '-' },
];
const BY_ID = new Map(ACTIONS.map((a) => [a.id, a]));
export const action = (id: number) => BY_ID.get(id) ?? BY_ID.get(ACT.NONE)!;

export const INPUTS = ['single', 'double', 'hold'] as const;
export type InputType = (typeof INPUTS)[number];
export type KeyBinding = Record<InputType, number>;
export interface Profile { name: string; keys: KeyBinding[] }
export interface KeymapConfig { version: 1; active: number; profiles: Profile[] }

const k = (single: number, double = 0, hold = 0): KeyBinding => ({ single, double, hold });

export const defaultConfig = (): KeymapConfig => ({
  version: 1,
  active: 0,
  profiles: [
    { name: 'Dev', keys: [k(1), k(2), k(3, 0, 4), k(10), k(11), k(12), k(13), k(40, 41), k(20, 0, 30)] },
    { name: 'Media', keys: [k(22), k(20), k(21), k(23), k(10), k(11), k(1), k(41, 40), k(31, 0, 30)] },
  ],
});

const STORE_KEY = 'nu87.keymap.v1';

function valid(c: unknown): c is KeymapConfig {
  const v = c as KeymapConfig;
  return !!v && v.version === 1 && Array.isArray(v.profiles) && v.profiles.length > 0 &&
    Number.isInteger(v.active) && v.active >= 0 && v.active < v.profiles.length &&
    v.profiles.every((p) => typeof p.name === 'string' && Array.isArray(p.keys) && p.keys.length === 9 &&
      p.keys.every((b) => b && INPUTS.every((i) => BY_ID.has(b[i]))));
}

export function loadConfig(): KeymapConfig {
  try {
    const c = JSON.parse(localStorage.getItem(STORE_KEY) ?? 'null');
    if (valid(c)) return c;
  } catch { /* fall through to defaults */ }
  return defaultConfig();
}

/** Called only on confirmed changes — never per encoder step (NVM wear). */
export function saveConfig(c: KeymapConfig) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(c)); } catch { /* storage unavailable: keep in-memory */ }
}
