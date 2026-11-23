import type { ActionInfo, DeviceConfig, Status } from './model';

// Companion bridge (127.0.0.1 only). When this page is served by the bridge itself the origin is the same.
const BASE = location.port === '17871' ? '' : 'http://127.0.0.1:17871';
export class ApiError extends Error { constructor(public status: number, message: string, public body?: any) { super(message); } }

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  let r: Response;
  try {
    r = await fetch(BASE + path, { method, headers: { 'X-NU87': '1', ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  } catch { throw new ApiError(0, 'NU87 Companion is not running'); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new ApiError(r.status, j.error ?? `HTTP ${r.status}`, j);
  return j as T;
}
export const getStatus = () => call<Status>('GET', '/api/status');
export const getActions = () => call<{ actions: ActionInfo[] }>('GET', '/api/actions').then(r => r.actions);
export const readConfig = () => call<{ config: DeviceConfig; rev: number }>('GET', '/api/config').then(r => r.config);
export const saveConfig = (config: DeviceConfig, baseRev: number) => call<{ config: DeviceConfig }>('POST', '/api/config', { baseRev, config }).then(r => r.config);
export const setCustom = (id: number, type: string, value: string, label: string) => call<{ actions: ActionInfo[] }>('PUT', `/api/custom/${id}`, { type, value, label }).then(r => r.actions);

// ── services (notifications, Gmail, lunch, GPT mode) ──
const get = <T,>(p: string) => call<T>('GET', p);
export const sendTest = (title: string, body: string) => call<{ shown: boolean }>('POST', '/api/notify', { title, body });
export const gmailStatus = () => get<{ gmail: any }>('/api/gmail').then(r => r.gmail);
export const gmailSet = (enabled: boolean) => call<{ gmail: any }>('PUT', '/api/gmail', { enabled }).then(r => r.gmail);
export const gmailClient = (clientId: string, clientSecret: string) => call<{ gmail: any }>('POST', '/api/gmail/client', { clientId, clientSecret }).then(r => r.gmail);
export const gmailConnect = () => call<{ url: string }>('POST', '/api/gmail/connect');
export const gmailDisconnect = () => call<{ gmail: any }>('POST', '/api/gmail/disconnect').then(r => r.gmail);
export const gmailCheck = () => call<{ result: string; gmail: any }>('POST', '/api/gmail/check');
export const lunchStatus = () => get<{ lunch: any }>('/api/lunch').then(r => r.lunch);
export const lunchSet = (p: object) => call<{ lunch: any }>('PUT', '/api/lunch', p).then(r => r.lunch);
export const lunchKey = (key: string) => call<{ lunch: any }>('POST', '/api/lunch/key', { key }).then(r => r.lunch);
export const lunchWork = (query: string) => call<{ lunch: any }>('POST', '/api/lunch/workplace', { query }).then(r => r.lunch);
export const lunchRoll = () => call<{ place: { name: string; category: string; distance: number; address: string }; sentToBoard: boolean }>('POST', '/api/lunch/roll');
export const gptInfo = () => get<{ gpt: any }>('/api/gpt').then(r => r.gpt);
export const gptApply = (model: string, effort: string) => call<{ gpt: any }>('POST', '/api/gpt/apply', { model, effort }).then(r => r.gpt);
export const gptKeys = (up: string, down: string) => call<{ gpt: any }>('PUT', '/api/gpt/keys', { up, down }).then(r => r.gpt);
export const gptSetup = () => call<{ file: string }>('POST', '/api/gpt/setup-shortcuts');
export const aiStatus = () => call<{ ai: any }>('GET', '/api/ai').then(r => r.ai);
export const aiSetup = (provider: string) => call<{ file: string }>('POST', '/api/ai/setup', { provider });
export const aiMode = (mode: string) => call<{ ai: any }>('PUT', '/api/ai/mode', { mode });
export const aiRefresh = () => call<object>('POST', '/api/ai/refresh');
export const timeStatus = () => call<{ time: any }>('GET', '/api/time').then(r => r.time);
export const timeSync = () => call<object>('POST', '/api/time/sync');
export const weatherStatus = () => call<{ weather: any }>('GET', '/api/weather').then(r => r.weather);
export const weatherMode = (mode: string) => call<{ weather: any }>('PUT', '/api/weather', { mode }).then(r => r.weather);
export const weatherSearch = (query: string) => call<{ results: any[] }>('POST', '/api/weather/search', { query }).then(r => r.results);
export const weatherSelect = (id: number) => call<{ weather: any }>('POST', '/api/weather/select', { id }).then(r => r.weather);
export const weatherRefresh = () => call<{ weather: any }>('POST', '/api/weather/refresh').then(r => r.weather);
