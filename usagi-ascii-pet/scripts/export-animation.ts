import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { captureAnimationSequence } from '../src/lcd/sequence';
import { exportAnimationCHeader } from '../src/lcd/export';
import { makeTinyLcdFont } from '../src/lcd/font';

const raw = process.argv.includes('--raw');
const target = process.argv.find((v) => v.endsWith('.h'));
const out = resolve(target || '../NU87_Usagi_LCD_Integration/usagi_animation.h');
const sequence = captureAnimationSequence(8, 4, 5, { coherent: !raw });
const header = exportAnimationCHeader(sequence, makeTinyLcdFont());
writeFileSync(out, header);
const bytes = /USAGI_DATA_BYTES (\d+)/.exec(header)?.[1];
for (const c of sequence.clips) {
  const max = Math.max(...c.frames.map(f => f.dirty));
  const avg = c.frames.reduce((s, f) => s + f.dirty, 0) / c.frames.length;
  console.log(`${c.name}: ${c.frames.length} frames, dirty avg=${avg.toFixed(1)} max=${max}`);
}
console.log(`wrote ${out}; mode=${raw ? 'raw' : 'coherent'} compressed stream=${bytes} bytes`);
