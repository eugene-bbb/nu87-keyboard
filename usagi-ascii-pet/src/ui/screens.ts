import type { Lcd } from '../lcd/screen';
import { UI, Regions, text, textR, fill, outline, bitmap, type Rect, type Rgb, type UiFonts } from './gfx';
import { ACTIONS, CATEGORIES, INPUTS, action } from './config';
import type { Device, Tone } from './device';
import type { AiState, WeatherKind } from './status';

/**
 * Both LCD screens as lists of cached regions. Static regions paint once per screen entry;
 * dynamic ones (time, weather, AI line, selected key, cursor rows) repaint only when their key changes.
 */

/** Home: stage corners owned by the HUD. Usagi cells inside these rects are never pushed. */
export const HOME_RESERVED: Rect[] = [[0, 25, 128, 54], [352, 25, 480, 54], [0, 274, 128, 295], [352, 274, 480, 295]];

const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const TONE: Record<Tone, Rgb> = { pink: UI.PINK, sky: UI.SKY, gray: UI.GRAY };
const p2 = (n: number) => String(n).padStart(2, '0');

const CLOUD = [
  '......####.....',
  '....########...',
  '..###########..',
  '.#############.',
  '###############',
  '###############',
  '.#############.',
];
const WX: Record<WeatherKind, string[]> = {
  clear: [
    '.......#.......', '..#....#....#..', '...#.......#...', '.....#####.....', '....#######....', '....#######....',
    '###.#######.###', '....#######....', '....#######....', '.....#####.....', '...#.......#...', '..#....#....#..', '.......#.......',
  ],
  clouds: ['', '', '', ...CLOUD],
  rain: ['', ...CLOUD, '', '...#...#...#...', '..#...#...#....', '.#...#...#.....'],
  snow: ['', ...CLOUD, '', '..#....#....#..', '', '.....#....#....'],
};

const AI_LABEL: Record<AiState, string> = { disconnected: 'Disconnected', idle: 'Idle', thinking: 'Thinking', done: 'Done', error: 'Error' };
const AI_COLOR: Record<AiState, Rgb> = { disconnected: UI.DIM, idle: UI.GRAY, thinking: UI.SKY, done: UI.PINK, error: UI.PINK };

function dot(lcd: Lcd, x: number, y: number, c: Rgb, hollow: boolean) {
  fill(lcd, x + 1, y, 3, 5, c); fill(lcd, x, y + 1, 5, 3, c);
  if (hollow) fill(lcd, x + 1, y + 1, 3, 3, UI.BG);
}

export function drawHome(R: Regions, lcd: Lcd, F: UiFonts, d: Device) {
  const s = d.status;

  // top-left: time + date
  const t = s.time;
  R.draw('h.time', t ? `${t.h}:${t.m}` : '-', 12, 8, 75, 26, () =>
    text(lcd, F.xl, 12, 8, t ? `${p2(t.h)}:${p2(t.m)}` : '--:--', UI.WHITE));
  R.draw('h.date', t ? `${t.weekday}${t.day}${t.month}` : '-', 12, 39, 110, 11, () => {
    if (t) text(lcd, F.sm, 13, 39, `${WEEKDAY[t.weekday]} ${t.day} ${MONTH[t.month]}`, UI.GRAY);
  });

  // top-right: weather
  const w = s.weather;
  R.draw('h.wx', w ? `${w.kind}${w.tempC}` : '-', 380, 8, 88, 26, () => {
    if (!w) { textR(lcd, F.lg, 468, 14, '--', UI.DIM); return; }
    const temp = `${Math.round(w.tempC)}°`;
    textR(lcd, F.lg, 468 + 3, 14, temp, UI.WHITE); // ° glyph has empty right half: optical alignment
    bitmap(lcd, 468 + 3 - temp.length * F.lg.cw - 7 - 15, 15, WX[w.kind], UI.WHITE);
  });
  R.draw('h.city', w?.city ?? '-', 358, 39, 110, 11, () => { if (w) textR(lcd, F.sm, 467, 39, w.city.slice(0, 18), UI.GRAY); });

  // test data marker (disappears with real serial data)
  R.draw('h.src', s.source, 210, 9, 60, 11, () => { if (s.source === 'mock') text(lcd, F.sm, 213, 9, 'MOCK DATA', UI.DIM); });

  // bottom-left: profile · bottom-right: PA7 hint
  R.draw('h.profile', d.profile.name, 12, 280, 96, 34, () => {
    text(lcd, F.sm, 13, 281, 'PROFILE', UI.DIM);
    text(lcd, F.md, 12, 298, d.profile.name.slice(0, 12), UI.WHITE);
  });
  R.draw('h.pa7', '', 380, 280, 88, 34, () => {
    textR(lcd, F.sm, 467, 281, 'PA7', UI.DIM);
    textR(lcd, F.md, 468, 298, 'Key Mapping', UI.GRAY);
  });

  // bottom-centre: AI services, or the last key action
  const toast = d.toast;
  R.draw('h.ai', toast ? `t${toast.text}` : s.ai.map((a) => a.state).join(), 110, 298, 260, 13, () => {
    if (toast) { const tx = toast.text.slice(0, 30); text(lcd, F.md, 240 - Math.round(tx.length * 3.5), 298, tx, TONE[toast.tone]); return; }
    const widths = s.ai.map((a) => 10 + (a.name.length + 1 + AI_LABEL[a.state].length) * 6);
    let x = 240 - Math.round((widths.reduce((p, c) => p + c, 0) + 14 * (s.ai.length - 1)) / 2);
    s.ai.forEach((a, i) => {
      const off = a.state === 'disconnected';
      dot(lcd, x, 302, AI_COLOR[a.state], off);
      const nx = text(lcd, F.sm, x + 10, 299, a.name, off ? UI.GRAY : UI.WHITE);
      text(lcd, F.sm, nx + 6, 299, AI_LABEL[a.state], AI_COLOR[a.state]);
      x += widths[i] + 14;
    });
  });
}

// ── Key Mapping ─────────────────────────────────────────────────────────────
const GX = 12, GY = 38, CW = 70, CH = 74, GAP = 5; // 3×3 grid: 220 × 232
const PX = 252, PW = 216;                          // detail panel
const TABS = [...CATEGORIES, 'None'];
const HINT = {
  key: 'TURN key · PRESS edit · HOLD home',
  input: 'TURN input · PRESS choose · HOLD back',
  action: 'TURN function · PRESS pick · HOLD back',
  confirm: 'TURN option · PRESS confirm · HOLD back',
};
const cap = (s: string) => s[0].toUpperCase() + s.slice(1);

/** cursor row: 2px sky bar in the gutter left of the panel */
function row(R: Regions, lcd: Lcd, id: string, key: string, y: number, h: number, on: boolean, paint: () => void) {
  R.draw(id, `${key}|${on}`, PX - 10, y, PW + 10, h, () => { if (on) fill(lcd, PX - 10, y + 2, 2, h - 4, UI.SKY); paint(); });
}

export function drawKeymap(R: Regions, lcd: Lcd, F: UiFonts, d: Device) {
  const k = d.km, b = d.binding;

  R.draw('k.title', d.profile.name, 12, 10, 456, 13, () => {
    text(lcd, F.md, 12, 10, 'Key Mapping', UI.WHITE);
    const x = textR(lcd, F.md, 468, 10, d.profile.name.slice(0, 12), UI.GRAY) - d.profile.name.slice(0, 12).length * 7;
    textR(lcd, F.sm, x - 8, 11, 'PROFILE', UI.DIM);
  });

  // left: the nine switches, laid out as on the board
  d.profile.keys.forEach((kb, i) => {
    const x = GX + (i % 3) * (CW + GAP), y = GY + Math.floor(i / 3) * (CH + GAP), sel = i === k.key;
    R.draw(`k.sw${i}`, `${kb.single}|${kb.double}|${kb.hold}|${sel}`, x, y, CW, CH, () => {
      fill(lcd, x, y, CW, CH, UI.SURFACE);
      if (sel) outline(lcd, x, y, CW, CH, UI.SKY);
      text(lcd, F.sm, x + 8, y + 9, `SW${i + 1}`, sel ? UI.SKY : UI.DIM, UI.SURFACE);
      const a = action(kb.single);
      text(lcd, F.md, x + 7, y + 30, a.short, a.id ? UI.WHITE : UI.DIM, UI.SURFACE);
      let ix = x + 8;
      if (kb.double) ix = text(lcd, F.sm, ix, y + 54, '2x', UI.GRAY, UI.SURFACE) + 8;
      if (kb.hold) text(lcd, F.sm, ix, y + 54, 'hold', UI.GRAY, UI.SURFACE);
    });
  });

  // right: detail / picker / confirm. A layout switch clears the panel once.
  const layout = k.stage === 'action' ? 'pick' : k.stage === 'confirm' ? 'confirm' : 'detail';
  R.draw('k.panel', layout, PX - 10, GY, PW + 10, 250, () => R.invalidate('k.p.'));

  const head = layout === 'detail' ? '' : ` · ${cap(d.inputType)}`;
  R.draw('k.p.head', `${k.key}${head}${k.stage}`, PX, GY, PW, 13, () => {
    const x = text(lcd, F.md, PX, GY, `SW${k.key + 1}`, UI.SKY);
    text(lcd, F.md, x, GY, head, UI.GRAY);
    if (layout === 'detail') textR(lcd, F.sm, PX + PW, GY + 1, k.stage === 'key' ? 'PRESS TO EDIT' : 'INPUT TYPE', UI.DIM);
  });

  if (layout === 'detail') {
    INPUTS.forEach((inp, i) => {
      const a = action(b[inp]), on = k.stage === 'input' && k.input === i;
      row(R, lcd, `k.p.in${i}`, `${a.id}`, GY + 28 + i * 40, 34, on, () => {
        const y = GY + 28 + i * 40;
        text(lcd, F.sm, PX, y + 3, inp.toUpperCase(), on ? UI.SKY : UI.DIM);
        text(lcd, F.md, PX, y + 18, a.name, a.id ? UI.WHITE : UI.DIM);
        if (a.cat) textR(lcd, F.sm, PX + PW, y + 19, a.cat, UI.DIM);
      });
    });
  } else if (layout === 'pick') {
    const cur = ACTIONS[k.pick], tab = cur.cat ?? 'None';
    R.draw('k.p.tabs', tab, PX, GY + 26, PW, 11, () => {
      let x = PX;
      for (const t of TABS) x = text(lcd, F.sm, x, GY + 26, t, t === tab ? UI.SKY : UI.DIM) + 6;
    });
    const list = ACTIONS.filter((a) => a.cat === cur.cat);
    for (let i = 0; i < 4; i++) {
      const a = list[i], y = GY + 50 + i * 26;
      row(R, lcd, `k.p.it${i}`, `${a?.id}|${a?.id === b[d.inputType]}`, y, 22, a === cur, () => {
        if (!a) return;
        text(lcd, F.md, PX, y + 5, a.name, a === cur ? UI.WHITE : UI.GRAY);
        if (a.id === b[d.inputType]) textR(lcd, F.sm, PX + PW, y + 6, 'CURRENT', UI.DIM);
      });
    }
  } else {
    R.draw('k.p.diff', `${k.pick}`, PX, GY + 26, PW, 50, () => {
      text(lcd, F.sm, PX, GY + 27, 'SAVE CHANGE?', UI.DIM);
      text(lcd, F.md, PX, GY + 44, action(b[d.inputType]).name, UI.GRAY);
      text(lcd, F.md, PX, GY + 62, `→ ${ACTIONS[k.pick].name}`, UI.WHITE);
    });
    ['Save', 'Cancel'].forEach((label, i) => {
      const y = GY + 94 + i * 26;
      row(R, lcd, `k.p.opt${i}`, '', y, 22, k.confirm === i, () => text(lcd, F.md, PX, y + 5, label, k.confirm === i ? UI.WHITE : UI.GRAY));
    });
  }

  // bottom: what the encoder does right now, or feedback from the last step
  const toast = d.toast;
  R.draw('k.hint', toast ? `t${toast.text}` : k.stage, 12, 299, 380, 13, () => {
    if (toast) text(lcd, F.md, 12, 299, toast.text.slice(0, 52), TONE[toast.tone]);
    else text(lcd, F.sm, 13, 300, HINT[k.stage], UI.GRAY);
  });
  R.draw('k.pa7', '', 400, 299, 68, 13, () => {
    const x = textR(lcd, F.sm, 467, 300, 'Home', UI.GRAY) - 4 * 6;
    textR(lcd, F.sm, x - 6, 300, 'PA7', UI.DIM);
  });
}
