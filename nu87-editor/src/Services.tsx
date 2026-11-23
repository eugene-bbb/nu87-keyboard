import { useEffect, useState } from 'react';
import * as api from './api';

const CATS = ['한식', '중식', '일식', '양식', '분식', '아시아음식', '패스트푸드', '기타'];
type Msg = { ok: boolean; t: string } | null;

function Note({ m }: { m: Msg }) { return m ? <p className={`muted ${m.ok ? '' : 'errtxt'}`}>{m.t}</p> : null; }

export function ServicesPanel({ disabled }: { disabled: boolean }) {
  return <div className="pad services"><TimeWeather /><AiState /><Notifications disabled={disabled} /><Lunch /><Gpt /></div>;
}

const KIND_TXT: Record<string, string> = { auth: 'Sign-in problem: reconnect Gmail or re-enter the OAuth client', permission: 'Permission missing for this Gmail scope', network: 'Network error', api: 'Gmail API error', notfound: 'Not found', device: 'Keyboard did not confirm', notready: 'Waiting for Keychain' };
const ago = (iso: string) => { if (!iso) return 'never'; const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000); return s < 60 ? 'just now' : s < 3600 ? `${Math.floor(s / 60)} min ago` : s < 172800 ? `${Math.floor(s / 3600)} h ago` : `${Math.floor(s / 86400)} d ago`; };
/** What the Gmail poller really did: connection, last real Gmail API call and its result, detection and notification times. */
function GmailState({ g }: { g: any }) {
  const bad = g.lastOK === false;
  return (
    <div className="muted" style={{ marginTop: 8 }}>
      <div>Connection: <b>{!g.connected ? 'not connected' : bad && g.lastErrorKind === 'auth' ? 'connected, but Google refuses the sign-in' : 'connected'}</b>{g.email ? ` · ${g.email}` : ''}</div>
      <div>Last Gmail check: <b>{ago(g.lastCheck)}</b> · result: <b className={bad ? 'errtxt' : ''}>{g.lastOK == null ? '—' : g.lastOK ? 'success' : 'failed'}</b>{g.polling ? ' (checking…)' : ''}</div>
      {bad && <div className="errtxt">{KIND_TXT[g.lastErrorKind] ?? 'Error'}: {g.lastError}</div>}
      <div>New mail detected: <b>{g.lastNewAt ? `${ago(g.lastNewAt)} (${g.lastNewCount})` : 'none yet'}</b> · last notification sent to NU87: <b>{ago(g.lastSentAt)}</b>{g.queued ? ` · ${g.queued} waiting` : ''}</div>
      <div>Mailbox position saved: {g.baseline ? 'yes (only mail arriving from now on is announced)' : 'no'} · checked every {g.intervalSeconds}s</div>
    </div>);
}
function Notifications({ disabled }: { disabled: boolean }) {
  const [g, setG] = useState<any>(null), [msg, setMsg] = useState<Msg>(null), [id, setId] = useState(''), [sec, setSec] = useState('');
  const [title, setTitle] = useState('Claude 작업 완료!'), [body, setBody] = useState('테스트 알림');
  const load = () => api.gmailStatus().then(setG).catch(e => setMsg({ ok: false, t: e.message }));
  useEffect(() => { load(); const t = setInterval(load, 5000); return () => clearInterval(t); }, []);
  const run = (f: () => Promise<any>, ok: string) => f().then(r => { setMsg({ ok: true, t: ok }); if (r?.gmail) setG(r.gmail); else if (r?.enabled !== undefined) setG(r); }).catch(e => setMsg({ ok: false, t: e.message }));
  return (
    <section>
      <h2>Notifications</h2>
      <p className="muted">Shown by Usagi in a speech bubble on the NU87 Home screen.</p>
      <div className="row"><input placeholder="Title" value={title} onChange={e => setTitle(e.target.value)} /><input placeholder="Body" value={body} onChange={e => setBody(e.target.value)} />
        <button className="ghost sm" disabled={disabled || !title} onClick={() => run(() => api.sendTest(title, body), 'Test notification shown on the NU87 (labelled TEST).')}>Send test</button></div>
      <h2 className="sub">Gmail <span className="muted">· sender + subject only (gmail.metadata)</span></h2>
      {g && <p className="muted">{g.connected ? `Connected${g.email ? ` as ${g.email}` : ''}` : 'Not connected'} · checks every {g.intervalSeconds}s{g.lastCheck ? ` · last ${new Date(g.lastCheck).toLocaleTimeString()}` : ''}{g.lastError ? ` · ${g.lastError}` : ''}</p>}
      {g && !g.connected && (
        <details open={!g.hasClient}><summary>Google Cloud setup {g.hasClient ? '(client saved)' : ''}</summary>
          <ol className="muted"><li>Google Cloud Console → new project → enable <b>Gmail API</b>.</li><li>OAuth consent screen: External, add your Gmail as a test user, scope <b>gmail.metadata</b>.</li>
            <li>Credentials → OAuth client ID → type <b>Desktop app</b>. Paste the client ID and secret below (stored in the macOS Keychain, never in this page).</li>
            <li>Press Connect and approve in the browser. In “Testing” mode Google expires the login after 7 days: just connect again.</li></ol>
          <div className="row"><input placeholder="Client ID" value={id} onChange={e => setId(e.target.value)} /><input type="password" placeholder="Client secret" value={sec} onChange={e => setSec(e.target.value)} />
            <button className="ghost sm" disabled={!id || !sec} onClick={() => run(() => api.gmailClient(id, sec).then(x => { setSec(''); return { gmail: x }; }), 'Client saved in Keychain.')}>Save client</button></div>
        </details>)}
      <div className="row">
        {g && !g.connected && <button className="ghost sm" disabled={!g.hasClient} onClick={() => run(() => api.gmailConnect().then(() => ({})), 'Finish signing in in the browser window that opened.')}>Connect Gmail</button>}
        {g?.connected && <>
          <label className="chk"><input type="checkbox" checked={g.enabled} onChange={e => run(() => api.gmailSet(e.target.checked), e.target.checked ? 'Gmail notifications on.' : 'Gmail notifications off.')} /> Notify on new mail</label>
          <button className="ghost sm" onClick={() => run(() => api.gmailCheck().then(r => { setMsg({ ok: r.gmail?.lastOK !== false, t: `Check: ${r.result}` }); return { gmail: r.gmail }; }), '')}>Check Now</button>
          <button className="ghost sm" onClick={() => run(() => api.gmailDisconnect(), 'Disconnected; token removed from Keychain.')}>Disconnect</button></>}
      </div>
      {g && <GmailState g={g} />}
      <Note m={msg} />
    </section>);
}

function Lunch() {
  const [s, setS] = useState<any>(null), [msg, setMsg] = useState<Msg>(null), [key, setKey] = useState(''), [q, setQ] = useState(''), [pick, setPick] = useState('');
  const load = () => api.lunchStatus().then(setS).catch(e => setMsg({ ok: false, t: e.message }));
  useEffect(() => { load(); const t = setInterval(load, 4000); return () => clearInterval(t); }, []);   // radius / food changed on the keyboard show up here
  const set = (p: object) => api.lunchSet(p).then(setS).catch(e => setMsg({ ok: false, t: e.message }));
  if (!s) return <section><h2>Lunch</h2><Note m={msg} /></section>;
  const toggle = (c: string) => set({ categories: s.categories.includes(c) ? s.categories.filter((x: string) => x !== c) : [...s.categories, c] });
  return (
    <section>
      <h2>Lunch</h2>
      {!s.keychainReady && <p className="errtxt muted">Waiting for the macOS Keychain: if a dialog “NU87Companion wants to use … in your keychain” is open, choose “Always Allow”. Until then saved keys look missing.</p>}
      <p className="muted">Random pick from real Kakao Local search results (restaurants near the work location). It is a random nearby restaurant, not a quality ranking.</p>
      <div className="row"><input type="password" placeholder={s.hasKey ? 'Kakao REST API key saved in Keychain' : 'Kakao REST API key'} value={key} onChange={e => setKey(e.target.value)} />
        <button className="ghost sm" disabled={!key} onClick={() => api.lunchKey(key).then(x => { setS(x); setKey(''); setMsg({ ok: true, t: 'Key saved in Keychain.' }); })}>Save key</button></div>
      <div className="row"><input placeholder={s.workLabel || 'Work place or address (e.g. company name)'} value={q} onChange={e => setQ(e.target.value)} />
        <button className="ghost sm" disabled={!q || !s.hasKey} onClick={() => api.lunchWork(q).then(x => { setS(x); setQ(''); setMsg({ ok: true, t: 'Work location saved on this Mac.' }); }).catch(e => setMsg({ ok: false, t: e.message }))}>Set work location</button></div>
      {s.workLabel && <p className="muted">Work location: {s.workLabel}</p>}
      <label className="chk"><input type="checkbox" checked={s.useCurrentLocation} onChange={e => set({ useCurrentLocation: e.target.checked })} /> Use current location (macOS permission: {s.locationPermission}); falls back to the work location</label>
      <label className="field">Radius</label>
      <div className="seg wide">{[500, 1000, 2000, 3000].map(r => <button key={r} className={s.radius === r ? 'on' : ''} onClick={() => set({ radius: r })}>{r >= 1000 ? `${r / 1000} km` : `${r} m`}</button>)}</div>
      <label className="field">Food types <small className="muted">(none selected = all)</small></label>
      <div className="chips">{CATS.map(c => <button key={c} className={s.categories.includes(c) ? 'on' : ''} onClick={() => toggle(c)}>{c}</button>)}</div>
      <div className="row"><label className="chk">Skip last <input type="number" min={0} max={50} value={s.excludeRecent} onChange={e => set({ excludeRecent: +e.target.value })} style={{ width: 64 }} /> confirmed picks</label>
        <select value={s.mapProvider} onChange={e => set({ mapProvider: e.target.value })}><option value="kakao">Kakao Map link</option><option value="naver">Naver Map search link</option></select>
        <button className="ghost sm" disabled={!s.hasKey} onClick={() => { setPick('Searching…'); api.lunchRoll().then(r => setPick(`${r.place.name} · ${r.place.category} · ${r.place.distance} m · ${r.place.address}${r.sentToBoard ? ' — also sent to the NU87 (Lunch screen + bubble)' : ' — NU87 not connected, not sent'}`)).catch(e => setPick(`Error: ${e.message}`)); }}>Test search</button></div>
      {pick && <p className="muted">{pick}</p>}<Note m={msg} />
    </section>);
}

function Gpt() {
  const [g, setG] = useState<any>(null), [model, setModel] = useState(''), [eff, setEff] = useState(''), [msg, setMsg] = useState<Msg>(null), [kUp, setKUp] = useState(''), [kDn, setKDn] = useState('');
  const load = () => api.gptInfo().then(x => { setG(x); setModel(x.current.model); setEff(x.current.effort); setKUp(x.sessionKeys?.up ?? ''); setKDn(x.sessionKeys?.down ?? ''); }).catch(e => setMsg({ ok: false, t: e.message }));
  useEffect(() => { load(); }, []);
  if (!g) return <section><h2>GPT Mode</h2><Note m={msg} /></section>;
  const m = g.models.find((x: any) => x.slug === model);
  return (
    <section>
      <h2>GPT Mode</h2>
      <p className="muted"><b>Knob and LCD Save</b> change the reasoning of the conversation open in the front ChatGPT app (official “Increase/Decrease reasoning effort” commands). <b>This panel’s Apply</b> only sets the Codex CLI default for new sessions — separate.</p>
      {g.models.length === 0 ? <p className="muted">Manual / Unsupported: no Codex model list found on this Mac.</p> : <>
        <p className="muted">Writes model and reasoning effort to the Codex config; {g.applies}. Model list: {g.source}.</p>
        <div className="row"><select value={model} onChange={e => { setModel(e.target.value); const n = g.models.find((x: any) => x.slug === e.target.value); if (n && !n.efforts.includes(eff)) setEff(n.efforts.includes('medium') ? 'medium' : n.efforts[0]); }}>
          {!m && <option value={model}>{model || '(unknown)'}</option>}{g.models.map((x: any) => <option key={x.slug} value={x.slug}>{x.name}</option>)}</select>
          <select value={eff} onChange={e => setEff(e.target.value)}>{(m?.efforts ?? []).map((x: string) => <option key={x}>{x}</option>)}</select>
          <button className="primary sm" disabled={!m} onClick={() => api.gptApply(model, eff).then(x => { setG(x); setMsg({ ok: true, t: `Config now: ${x.current.model} / ${x.current.effort} (verified by re-reading the file).` }); }).catch(e => setMsg({ ok: false, t: e.message }))}>Apply</button></div>
        <p className="muted">Current config: {g.current.model || '-'} / {g.current.effort || '-'} <button className="ghost sm" onClick={load}>Reload</button></p></>}
      <details><summary>Open conversation: ChatGPT shortcuts (required for the knob)</summary>
        <p className="muted">The ChatGPT app has official commands “Increase / Decrease reasoning effort” without a default shortcut. Press <b>Set up</b> to add Ctrl+Alt+Cmd+↑/↓ (reasoning) and Ctrl+Alt+Cmd+M (open model picker, so the slider shows while the knob turns) to the app's own keymap (~/.codex/keybindings.json, backed up) and restart ChatGPT once; or assign any shortcut yourself in ChatGPT → Settings → Keyboard shortcuts and enter it below. The knob sends it only while ChatGPT is the front app. Not verified until you turn the knob and see the level change.</p>
        <div className="row"><button className="primary sm" onClick={() => api.gptSetup().then(() => { setMsg({ ok: true, t: 'Shortcuts written. Restart ChatGPT once.' }); load(); }).catch(e => setMsg({ ok: false, t: e.message }))}>Set up shortcuts</button></div>
        <div className="row"><input placeholder="Increase, e.g. ctrl+alt+up" value={kUp} onChange={e => setKUp(e.target.value)} /><input placeholder="Decrease, e.g. ctrl+alt+down" value={kDn} onChange={e => setKDn(e.target.value)} />
          <button className="ghost sm" onClick={() => api.gptKeys(kUp, kDn).then(() => setMsg({ ok: true, t: 'Shortcuts saved.' })).catch(e => setMsg({ ok: false, t: e.message }))}>Save shortcuts</button></div></details>
      <Note m={msg} />
    </section>);
}

const STATE_KO: Record<string, string> = { working: 'Working', approval: 'Approval', done: 'Done', error: 'Error', stale: 'Stale (no activity evidence)' };
const USE_STATUS: Record<number, string> = { 1: 'Waiting for data', 2: 'Sign-in problem', 3: 'Network / app-server error', 4: 'Not supported', 5: 'Setup needed', 6: 'Old value (refresh failed)' };
const fmtLeft = (sec: number) => { const m = Math.max(0, Math.floor(sec / 60)); return m >= 2880 ? `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h` : m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`; };
const fmtAgo = (sec: number) => sec < 60 ? 'just now' : sec < 3600 ? `${Math.floor(sec / 60)} min ago` : sec < 172800 ? `${Math.floor(sec / 3600)} h ago` : `${Math.floor(sec / 86400)} d ago`;
const winName = (m?: number | null, d?: string) => m === 300 ? '5h' : m === 10080 ? '7d' : m ? (m >= 1440 ? `${Math.round(m / 1440)}d` : `${Math.round(m / 60)}h`) : d;
/** Remaining-limit bar: full = everything left, shrinks as the limit is used. `left` null = unknown (never drawn as 0%). */
function Bar({ label, left, hint, reset, who, stale }: { label: string; left?: number | null; hint: string; reset?: number | null; who: 'claude' | 'codex'; stale?: boolean }) {
  const ok = typeof left === 'number';
  const secs = reset ? reset - Date.now() / 1000 : null;
  return (
    <div className={`ubar ${who}${stale ? ' stale' : ''}`}><div className="ubl"><b>{label}</b><small className="muted">{hint}</small></div>
      <div className="track"><i style={{ width: ok ? `${Math.max(2, Math.min(100, left!))}%` : 0 }} /></div>
      <span className="pct">{ok ? `${left}%` : '--'}</span>{ok && secs !== null ? <small className="muted"> {secs > 0 ? `resets in ${fmtLeft(secs)}` : 'resetting…'}</small> : null}</div>);
}
function UsageBlock({ who, u }: { who: 'claude' | 'codex'; u: any }) {
  const st = u?.status ?? 1, has = u && (st === 0 || st === 6), stale = st === 6;
  return (<>
    <h3>{who === 'claude' ? 'Claude Code' : 'Codex'} {u?.plan ? <small className="muted">({u.plan})</small> : null}</h3>
    {who === 'claude' && <Bar who={who} label="Context used" left={has && typeof u.context === 'number' ? u.context : null} hint="this conversation" />}
    <Bar who={who} label={`${winName(u?.window5hMins, '5h')} left`} left={has ? u.left5h : null} hint={who === 'claude' ? 'subscription' : 'account'} reset={has ? u.resets5h : null} stale={stale} />
    <Bar who={who} label={`${winName(u?.window7dMins, '7d')} left`} left={has ? u.left7d : null} hint={who === 'claude' ? 'subscription' : 'account'} reset={has ? u.resets7d : null} stale={stale} />
    <p className="muted">{st !== 0 ? `${USE_STATUS[st] ?? 'Unavailable'}${u?.message ? ` — ${u.message}` : ''}. ` : ''}{u?.updatedAt ? `Updated ${fmtAgo(u.ageSeconds ?? 0)}.` : 'No value received yet.'}</p>
  </>);
}
function AiState() {
  const [a, setA] = useState<any>(null), [msg, setMsg] = useState<Msg>(null);
  const load = () => api.aiStatus().then(setA).catch(e => setMsg({ ok: false, t: e.message }));
  useEffect(() => { load(); const t = setInterval(load, 2000); return () => clearInterval(t); }, []);
  const install = (p: string, ok: string) => api.aiSetup(p).then(() => { setMsg({ ok: true, t: ok }); load(); }).catch(e => setMsg({ ok: false, t: e.message }));
  const u = a?.usage ?? {}, tr = a?.codexHooksTrust ?? {};
  return (
    <section>
      <h2>AI work status</h2>
      <p className="muted">Usagi reacts to real work events from the official hooks of Claude Code and Codex. A hook only reports provider, event, session and turn id; the request / answer text is read only if you allow it below, masked and shortened here, and never logged.</p>
      <div className="row">
        <button className="ghost sm" onClick={() => install('claude', 'Claude Code hooks written. Start a new Claude Code session or review them in /hooks.')}>{a?.installed?.claude ? 'Reinstall' : 'Install'} Claude Code hooks</button>
        <button className="ghost sm" onClick={() => install('codex', 'Codex hooks written. They stay inactive until you trust them in the Codex app: Settings → Hooks.')}>{a?.installed?.codex ? 'Reinstall' : 'Install'} Codex hooks</button>
        <button className="ghost sm" disabled={a?.installed?.otherStatusline} onClick={() => install('claude-statusline', 'Claude statusline installed (usage numbers appear after the next Claude Code reply).')}>{a?.installed?.claudeStatusline ? 'Reinstall' : 'Install'} Claude usage statusline</button>
      </div>
      <p className="muted">Claude Code: {a?.installed?.claude ? 'hooks installed' : 'not installed'} · Codex: {a?.installed?.codex ? (tr.total ? `${tr.trusted}/${tr.total} hooks trusted` : 'hooks installed') : 'not installed'}{a?.installed?.otherStatusline ? ' · you already have a Claude statusline: left unchanged' : ''} · Claude / ChatGPT chat apps: no official way to read work status, so unsupported.</p>
      {a?.installed?.codex && tr.total > 0 && tr.trusted < tr.total && <p className="errtxt muted">Codex ignores hooks it does not trust. Open the Codex app → Settings → Hooks, review the NU87 hooks and trust them (then restart Codex once). <button className="ghost sm" onClick={() => api.aiRefresh().then(load)}>Re-check</button></p>}
      <label className="field">What the keyboard may show</label>
      <div className="seg wide">{[['off', 'State only'], ['title', 'Short task title'], ['full', 'Title + answer summary']].map(([m, t]) => <button key={m} className={a?.mode === m ? 'on' : ''} onClick={() => api.aiMode(m).then(x => setA(x.ai))}>{t}</button>)}</div>
      {a?.sessions?.length ? <ul className="muted">{a.sessions.map((s: any, i: number) => <li key={i}>{s.provider} · {s.session} · {STATE_KO[s.state] ?? s.state}{s.title ? ` · ${s.title}` : ''} · {s.ageSeconds}s ago</li>)}</ul> : <p className="muted">No active sessions reported yet.</p>}
      {['claude', 'codex'].map(p => a?.last?.[p] ? <p key={p} className="muted">Last {p} result: {a.last[p].line1 || '—'}{a.last[p].line2 ? ` · ${a.last[p].line2}` : ''} ({a.last[p].ageSeconds}s ago)</p> : null)}
      <h2 className="sub">Usage left</h2>
      <p className="muted">Bars show the <b>share of your subscription limit that is left</b> (100% = full, shrinking as you use it) and the time until it resets. These are percentages from the provider, not token counts. <b>Context used</b> is how full the current Claude Code conversation is and is a different measure. Missing or old numbers show “--”, never 0%.</p>
      <UsageBlock who="claude" u={u.claude} />
      <UsageBlock who="codex" u={u.codex} />
      <div className="row"><button className="ghost sm" onClick={() => api.aiRefresh().then(() => setTimeout(load, 1500))}>Refresh Codex now</button></div>
      <p className="muted">Claude: official statusline JSON (<code>rate_limits</code>, <code>context_window</code>), sent after each Claude Code reply. Codex: official app-server <code>account/rateLimits/read</code> (read every 10 min, on connect, after a finished turn and right after a window resets). Codex context usage of a conversation is not exposed to other programs.</p>
      <Note m={msg} />
    </section>);
}

function TimeWeather() {
  const [t, setT] = useState<any>(null), [w, setW] = useState<any>(null), [msg, setMsg] = useState<Msg>(null), [q, setQ] = useState(''), [res, setRes] = useState<any[]>([]), [busy, setBusy] = useState(false);
  const load = () => { api.timeStatus().then(setT).catch(() => {}); api.weatherStatus().then(setW).catch(e => setMsg({ ok: false, t: e.message })); };
  useEffect(() => { load(); const i = setInterval(load, 5000); return () => clearInterval(i); }, []);
  const c = w?.current;
  return (
    <section>
      <h2>Time &amp; weather</h2>
      <p className="muted">The Home clock follows this Mac (time zone and DST included; the board counts on its own between syncs). Weather is real data from Open-Meteo; nothing is shown from a default city.</p>
      {t && <p className="muted"><b>Time</b>: {t.boardConnected ? 'board connected' : 'board not connected'} · {t.timeZone} (UTC{t.offsetMinutes >= 0 ? '+' : ''}{t.offsetMinutes / 60}) · {t.hour12 ? '12-hour' : '24-hour'} · last sync {t.lastSync ? new Date(t.lastSync).toLocaleTimeString() : 'not yet'} <button className="ghost sm" onClick={() => api.timeSync().then(() => setTimeout(load, 1500))}>Sync now</button></p>}
      <label className="field">Weather location</label>
      <div className="seg wide">{[['auto', 'This Mac (current location)'], ['custom', 'A place I choose']].map(([m, n]) => <button key={m} className={w?.mode === m ? 'on' : ''} onClick={() => { setBusy(true); api.weatherMode(m).then(setW).catch(e => setMsg({ ok: false, t: e.message })).finally(() => setBusy(false)); }}>{n}</button>)}</div>
      {w?.mode === 'auto' && <p className="muted">macOS location permission: {w.locationPermission}. If it is not allowed, the saved place below is used; with none saved the board shows “위치 설정 필요”.</p>}
      <div className="row"><input placeholder="Search a place (e.g. 대치동, Busan)" value={q} onChange={e => setQ(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && q) api.weatherSearch(q).then(setRes).catch(er => setMsg({ ok: false, t: er.message })); }} />
        <button className="ghost sm" disabled={!q} onClick={() => api.weatherSearch(q).then(setRes).catch(e => setMsg({ ok: false, t: e.message }))}>Search</button></div>
      {res.length > 0 && <ul className="list">{res.map(r => <li key={r.id}><button onClick={() => { setBusy(true); api.weatherSelect(r.id).then(x => { setW(x); setRes([]); setMsg({ ok: true, t: `Weather place set to ${r.name}.` }); }).catch(e => setMsg({ ok: false, t: e.message })).finally(() => setBusy(false)); }}><span><b>{r.name}</b><small>{r.lat}, {r.lon}</small></span></button></li>)}</ul>}
      {w?.custom && <p className="muted">Saved place: {w.custom.name} ({w.custom.lat}, {w.custom.lon})</p>}
      {c ? <p className="muted"><b>{c.fresh ? 'Now' : 'Outdated'}</b>: {c.temp}°C · {c.condition} · {c.isDay ? 'day' : 'night'} · {c.place} ({c.lat}, {c.lon}) · observed {new Date(c.observed).toLocaleTimeString()} · fetched {Math.round(c.ageSeconds / 60)} min ago · source {w.source}{c.fresh ? '' : ' (the board shows --° until it is refreshed)'}</p> : <p className="muted">No weather data yet{w?.lastError ? `: ${w.lastError}` : ''}.</p>}
      {w?.lastError && c && <p className="errtxt muted">Last refresh failed: {w.lastError}. Showing the previous data above with its age.</p>}
      <div className="row"><button className="ghost sm" disabled={busy || w?.inFlight} onClick={() => { setBusy(true); api.weatherRefresh().then(x => { setW(x); setMsg(x.lastError ? { ok: false, t: x.lastError } : { ok: true, t: 'Weather refreshed from Open-Meteo.' }); }).catch(e => setMsg({ ok: false, t: e.message })).finally(() => setBusy(false)); }}>Refresh weather</button></div>
      <Note m={msg} />
    </section>);
}
