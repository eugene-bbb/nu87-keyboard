import type { StateName } from '../core/pose';

/**
 * Live data the LCD shows but does not own. It arrives as CompanionMsg records — later from the
 * Mac/PC companion over USB serial, today from MockCompanion. The UI only ever reads DeviceStatus.
 */
export type AiState = 'disconnected' | 'idle' | 'thinking' | 'done' | 'error';
export const AI_STATES: AiState[] = ['disconnected', 'idle', 'thinking', 'done', 'error'];
export type AiId = 'claude' | 'codex';
export interface AiService { id: AiId; name: string; state: AiState }

export type WeatherKind = 'clear' | 'clouds' | 'rain' | 'snow';
export const WEATHER_KINDS: WeatherKind[] = ['clear', 'clouds', 'rain', 'snow'];

export interface DeviceStatus {
  /** 'mock' is flagged on the LCD so test data is never mistaken for live data */
  source: 'mock' | 'serial';
  time: { h: number; m: number; weekday: number; day: number; month: number } | null;
  weather: { kind: WeatherKind; tempC: number; city: string } | null;
  ai: AiService[];
}

export type CompanionMsg =
  | { t: 'time'; h: number; m: number; weekday: number; day: number; month: number } // every minute
  | { t: 'weather'; kind: WeatherKind; tempC: number; city: string }                  // every 15–30 min
  | { t: 'ai'; id: AiId; state: AiState };                                            // on change

export const initialStatus = (source: DeviceStatus['source']): DeviceStatus => ({
  source, time: null, weather: null,
  ai: [{ id: 'claude', name: 'Claude', state: 'disconnected' }, { id: 'codex', name: 'Codex', state: 'disconnected' }],
});

export function applyMsg(s: DeviceStatus, m: CompanionMsg) {
  if (m.t === 'time') s.time = { h: m.h, m: m.m, weekday: m.weekday, day: m.day, month: m.month };
  else if (m.t === 'weather') s.weather = { kind: m.kind, tempC: m.tempC, city: m.city };
  else { const a = s.ai.find((x) => x.id === m.id); if (a) a.state = m.state; }
}

/** AI status → Usagi expression. The one place that couples the two. */
export function expressionFor(ai: AiService[]): StateName {
  const has = (st: AiState) => ai.some((a) => a.state === st);
  if (has('error')) return 'error';
  if (has('thinking')) return 'thinking';
  if (has('done')) return 'happy';
  if (ai.every((a) => a.state === 'disconnected')) return 'sleeping';
  return 'idle';
}

/** TEST DATA ONLY — stands in for the USB-serial companion. Same messages, same cadence. */
export class MockCompanion {
  weather: { kind: WeatherKind; tempC: number; city: string } = { kind: 'clear', tempC: 18, city: 'Seoul' };
  private timers: number[] = [];
  private lastMin = -1;
  private doneTimer: Partial<Record<AiId, number>> = {};

  constructor(private send: (m: CompanionMsg) => void) {}

  start() {
    this.pushTime();
    this.send({ t: 'weather', ...this.weather });
    this.send({ t: 'ai', id: 'claude', state: 'idle' });
    this.timers.push(window.setInterval(() => this.pushTime(), 1000));
    this.timers.push(window.setInterval(() => this.send({ t: 'weather', ...this.weather }), 20 * 60 * 1000));
  }
  stop() { this.timers.forEach(clearInterval); Object.values(this.doneTimer).forEach(clearTimeout); this.timers = []; }

  setWeather(w: Partial<MockCompanion['weather']>) { Object.assign(this.weather, w); this.send({ t: 'weather', ...this.weather }); }

  setAi(id: AiId, state: AiState) {
    clearTimeout(this.doneTimer[id]);
    this.send({ t: 'ai', id, state });
    // a finished task settles back to idle, as a real agent session would
    if (state === 'done') this.doneTimer[id] = window.setTimeout(() => this.send({ t: 'ai', id, state: 'idle' }), 4000);
  }

  private pushTime() {
    const d = new Date();
    if (d.getMinutes() === this.lastMin) return;
    this.lastMin = d.getMinutes();
    this.send({ t: 'time', h: d.getHours(), m: d.getMinutes(), weekday: d.getDay(), day: d.getDate(), month: d.getMonth() });
  }
}
