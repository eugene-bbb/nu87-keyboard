import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as api from './api';
import { ServicesPanel } from './Services';
import { BubblesPreview } from './Bubbles';
import { ApiError } from './api';
import {
  ActionInfo, CATEGORIES, COLORS, DeviceConfig, EFFECTS, INPUTS, KEY_DEFAULTS, KEY_POS, KEY_RGB, KNOB_DEFAULTS, KNOB_MODES, KNOB_SLOTS,
  PROFILES, RGB_DEFAULT, Status, baseColor, clone, css, hueToRgb,
} from './model';

type Tab = 'keys' | 'knob' | 'rgb' | 'services' | 'bubbles';
const strip = (c: DeviceConfig | null) => (c ? JSON.stringify({ ...c, rev: 0 }) : '');

export function App() {
  const [status, setStatus] = useState<Status | null>(null);
  const [bridgeUp, setBridgeUp] = useState(true);
  const [actions, setActions] = useState<ActionInfo[]>([]);
  const [device, setDevice] = useState<DeviceConfig | null>(null);
  const [draft, setDraft] = useState<DeviceConfig | null>(null);
  const [busy, setBusy] = useState<'' | 'loading' | 'saving'>('');
  const [note, setNote] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [conflict, setConflict] = useState<{ cfg: DeviceConfig; why: string } | null>(null);
  const [tab, setTab] = useState<Tab>('keys');
  const [profile, setProfile] = useState(0);
  const [sel, setSel] = useState(0);
  const [knobMode, setKnobMode] = useState(0);

  const A = useMemo(() => new Map(actions.map(a => [a.id, a])), [actions]);
  const dirty = !!draft && !!device && strip(draft) !== strip(device);
  const ref = useRef({ dirty, device, status, busy });
  ref.current = { dirty, device, status, busy };

  const load = useCallback(async (keepDraft = false) => {
    setBusy('loading');
    try {
      const c = await api.readConfig();
      setDevice(c); if (!keepDraft) { setDraft(clone(c)); setProfile(c.active); setKnobMode(c.knob.mode); }
      setNote(null); setConflict(null);
    } catch (e) { setNote({ kind: 'err', text: `Could not read NU87: ${(e as Error).message}` }); }
    setBusy('');
  }, []);
  const refreshActions = useCallback(() => api.getActions().then(setActions).catch(() => {}), []);

  // Status poll. Device changes never overwrite unsaved edits: they raise a banner instead.
  useEffect(() => {
    let last: Status | null = null, stop = false;
    const tick = async () => {
      try {
        const s = await api.getStatus(); if (stop) return;
        setBridgeUp(true); setStatus(s);
        if (s.connected && (!last || !last.connected || last.session !== s.session)) {
          refreshActions();
          if (ref.current.dirty && ref.current.device) setConflict({ cfg: ref.current.device, why: 'The NU87 reconnected. Its settings may differ from what you started from.' });
          else load();
        } else if (last && s.connected && s.changeSeq !== last.changeSeq && !ref.current.busy) {
          if (ref.current.dirty) setConflict({ cfg: ref.current.device!, why: 'Settings were changed on the NU87 itself.' }); else load();
        }
        last = s;
      } catch { if (!stop) { setBridgeUp(false); setStatus(null); last = null; } }
    };
    tick(); const t = setInterval(tick, 1000); return () => { stop = true; clearInterval(t); };
  }, [load, refreshActions]);

  const online = bridgeUp && !!status?.connected && !!device;
  const edit = (f: (c: DeviceConfig) => void) => setDraft(d => { if (!d) return d; const n = clone(d); f(n); return n; });

  async function save(overrideRev?: number) {
    if (!draft || !device) return;
    setBusy('saving'); setNote(null);
    try {
      const after = await api.saveConfig(draft, overrideRev ?? device.rev);
      setDevice(after); setDraft(clone(after)); setConflict(null);
      setNote({ kind: 'ok', text: 'Saved to the NU87 and verified by reading it back.' });
    } catch (e) {
      const er = e as ApiError;
      if (er.status === 409 && er.body?.config) setConflict({ cfg: er.body.config, why: 'The NU87 settings changed since you loaded them. Nothing was written.' });
      else setNote({ kind: 'err', text: `Not saved: ${er.message}. Your NU87 keeps its previous settings.` });
    }
    setBusy('');
  }
  const discard = () => { if (device) { setDraft(clone(device)); setNote(null); } };

  const stateText = !bridgeUp ? 'Companion not running' : !status?.connected ? 'NU87 not connected' : busy === 'loading' ? 'Reading from NU87…' : busy === 'saving' ? 'Saving to NU87…' : !device ? 'Not read from NU87' : dirty ? 'Unsaved changes' : 'In sync with NU87';

  return (
    <div className="app">
      <header className="top">
        <div className="brand"><b>NU87</b><span>Key Mapping</span></div>
        <div className="conn">
          <i className={`dot ${online ? 'on' : bridgeUp ? 'warn' : 'off'}`} />
          <span>{online ? `${status!.device || 'NU87'} · ${status!.deviceId}` : bridgeUp ? 'No device' : 'Offline'}</span>
        </div>
        <div className="seg" role="tablist" aria-label="Profile">
          {PROFILES.map((p, i) => <button key={p} className={profile === i ? 'on' : ''} onClick={() => setProfile(i)}>{p}{draft?.active === i ? ' ●' : ''}</button>)}
        </div>
        <div className="sync"><i className={`dot ${dirty ? 'warn' : online ? 'on' : 'off'}`} />{stateText}</div>
        <div className="grow" />
        <button className="ghost" disabled={!dirty || !!busy} onClick={discard}>Cancel</button>
        <button className="primary" disabled={!dirty || !online || !!busy} onClick={() => save()}>{busy === 'saving' ? 'Saving…' : 'Save to NU87'}</button>
      </header>

      {!bridgeUp && <div className="banner err">The editor needs NU87 Companion running on this Mac (it talks to the keyboard over Bluetooth). Open the app, then this page reconnects by itself.</div>}
      {bridgeUp && status && !status.connected && <div className="banner warn">NU87 is not connected. In NU87 Companion choose your board and press “Connect selected”. Settings are shown only after they are read from the device.</div>}
      {bridgeUp && status && !status.accessibility && <div className="banner warn">macOS Accessibility is off for NU87 Companion: shortcut, media and brightness actions will fail on the Mac.</div>}
      {conflict && (
        <div className="banner warn">
          <span>{conflict.why}</span>
          <button className="ghost sm" onClick={() => { setDevice(conflict.cfg); setDraft(clone(conflict.cfg)); setConflict(null); load(); }}>Use device settings</button>
          <button className="ghost sm" onClick={() => { const r = conflict.cfg.rev; setConflict(null); save(r); }}>Overwrite device with mine</button>
          <button className="ghost sm" onClick={() => setConflict(null)}>Keep editing</button>
        </div>)}
      {note && <div className={`banner ${note.kind}`}>{note.text}</div>}

      <main className={`main ${draft ? '' : 'idle'}`}>
        <Board draft={draft} profile={profile} sel={sel} tab={tab} A={A}
          onKey={k => { setSel(k); setTab('keys'); }} onKnob={() => setTab('knob')} />
        <section className="panel">
          <nav className="tabs">{(['keys', 'knob', 'rgb', 'services', 'bubbles'] as Tab[]).map(t => <button key={t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>{t === 'keys' ? 'Keys' : t === 'knob' ? 'Knob' : t === 'rgb' ? 'RGB' : t === 'services' ? 'Services' : 'Bubbles'}</button>)}</nav>
          {tab === 'bubbles' ? <BubblesPreview /> : tab === 'services' ? <ServicesPanel disabled={!status?.connected} /> : !draft ? <p className="muted pad">Waiting for the NU87. Nothing is shown from memory or defaults: this editor only displays settings read from the keyboard.</p> :
            tab === 'keys' ? <KeyPanel draft={draft} profile={profile} sel={sel} A={A} edit={edit} refreshActions={refreshActions} setActions={setActions} disabled={!online} /> :
            tab === 'knob' ? <KnobPanel draft={draft} mode={knobMode} setMode={setKnobMode} A={A} edit={edit} actions={actions} disabled={!online} /> :
            <RgbPanel draft={draft} edit={edit} disabled={!online} />}
        </section>
      </main>
    </div>
  );
}

// ───────────── physical layout ─────────────
function Board({ draft, profile, sel, tab, A, onKey, onKnob }: { draft: DeviceConfig | null; profile: number; sel: number; tab: Tab; A: Map<number, ActionInfo>; onKey: (k: number) => void; onKnob: () => void }) {
  const amb = draft ? ambient(draft) : null;
  return (
    <div className="board" aria-label="NU87 TinyDK layout">
      <div className="lcd"><span>LCD 480×320</span></div>
      <div className="mcu"><span>NU87-TinyDK</span><u title="PA7 screen button: cycles Home → Key Mapping → RGB on the device (fixed function, position schematic)">PA7 · screen</u><i className="led" style={amb ? amb.style : undefined} title="Ambient RGB LED (preview)" /></div>
      <button className={`knob ${tab === 'knob' ? 'sel' : ''}`} onClick={onKnob} aria-label="KY-040 encoder"><span className="cap" /><em>Knob</em></button>
      {KEY_POS.map((p, k) => {
        const b = draft?.keys[profile][k]; const s = b ? A.get(b[0]) : undefined;
        return (
          <button key={k} className={`key ${sel === k && tab === 'keys' ? 'sel' : ''}`} style={{ gridColumn: p.col, gridRow: p.row, ['--kc' as any]: css(KEY_RGB[k] as any) }} onClick={() => onKey(k)}>
            <small>SW{k + 1}</small>
            <b>{s ? (s.id === 0 ? '—' : s.name) : '…'}</b>
            <span className="marks">{INPUTS.slice(1).map((n, i) => <i key={n} className={b && b[i + 1] ? 'on' : ''} title={`${n}: ${b ? A.get(b[i + 1])?.name ?? '' : ''}`} />)}</span>
          </button>);
      })}
    </div>
  );
}
function ambient(c: DeviceConfig) {
  const r = c.rgb, col = baseColor(r), k = r.brightness / 100;
  if (r.effect === 0 || r.brightness === 0) return { style: { background: '#d8d8d8', boxShadow: 'none' } as React.CSSProperties };
  const dur = `${r.speed10 / 10}s`;
  const style: React.CSSProperties = { background: css(col as any), opacity: 0.25 + 0.75 * k, boxShadow: `0 0 ${6 + 14 * k}px ${css(col as any)}`,
    animation: r.effect === 2 ? `breathe ${dur} ease-in-out infinite` : r.effect === 3 ? `pastel ${dur} linear infinite` : 'none' };
  return { style };
}

// ───────────── keys ─────────────
function KeyPanel({ draft, profile, sel, A, edit, disabled, refreshActions, setActions }: { draft: DeviceConfig; profile: number; sel: number; A: Map<number, ActionInfo>; edit: (f: (c: DeviceConfig) => void) => void; disabled: boolean; refreshActions: () => void; setActions: (a: ActionInfo[]) => void }) {
  const [input, setInput] = useState(0);
  const b = draft.keys[profile][sel];
  const set = (id: number) => edit(c => { c.keys[profile][sel][input] = id; });
  return (
    <div className="pad">
      <div className="head"><div><h2>SW{sel + 1}</h2><p className="muted">Profile {PROFILES[profile]} · press colour <i className="sw" style={{ background: css(KEY_RGB[sel] as any) }} /> overrides the ambient light while held</p></div>
        <button className="ghost sm" disabled={disabled} onClick={() => edit(c => { c.keys[profile][sel] = [...KEY_DEFAULTS[profile][sel]]; })}>Reset key</button></div>
      <div className="slots">{INPUTS.map((n, i) => <button key={n} className={`slot ${input === i ? 'on' : ''}`} onClick={() => setInput(i)}><small>{n === 'Hold' ? 'Long press' : n === 'Double' ? 'Double click' : 'Single click'}</small><b>{A.get(b[i])?.name ?? `#${b[i]}`}</b><Where a={A.get(b[i])} /></button>)}</div>
      <ActionPicker value={b[input]} onChange={set} A={A} disabled={disabled} />
      <CustomEditor A={A} onChange={setActions} refresh={refreshActions} disabled={disabled} />
    </div>);
}
function Where({ a }: { a?: ActionInfo }) {
  if (!a || a.id === 0) return <em className="tag">Unassigned</em>;
  if (!a.supported) return <em className="tag bad">Unsupported</em>;
  return <em className={`tag ${a.runsOn}`}>{a.runsOn === 'device' ? 'On the NU87' : 'Runs on Mac'}</em>;
}
function ActionPicker({ value, onChange, A, disabled, rotation }: { value: number; onChange: (id: number) => void; A: Map<number, ActionInfo>; disabled: boolean; rotation?: boolean }) {
  const [q, setQ] = useState(''), [cat, setCat] = useState('All');
  const list = [...A.values()].filter(a => (cat === 'All' || a.category === cat) && (!q || `${a.name} ${a.detail}`.toLowerCase().includes(q.toLowerCase())));
  return (
    <div className="picker">
      <input className="search" placeholder="Search functions" value={q} onChange={e => setQ(e.target.value)} />
      <div className="chips">{['All', ...CATEGORIES].map(c => <button key={c} className={cat === c ? 'on' : ''} onClick={() => setCat(c)}>{c}</button>)}</div>
      <ul className="list">
        {list.map(a => {
          const blocked = !a.supported && a.id !== 0 && a.id !== value;
          return <li key={a.id}><button disabled={disabled || blocked} className={value === a.id ? 'on' : ''} onClick={() => onChange(a.id)}>
            <span><b>{a.name}</b><small>{a.detail}{rotation && a.runsOn === 'mac' && a.supported && !['Media', 'System', 'Shortcut'].includes(a.category) ? ' · runs once per detent' : ''}</small></span><Where a={a} /></button></li>;
        })}
        {list.length === 0 && <li className="muted pad">No matching function</li>}
      </ul>
    </div>);
}
function CustomEditor({ A, onChange, refresh, disabled }: { A: Map<number, ActionInfo>; onChange: (a: ActionInfo[]) => void; refresh: () => void; disabled: boolean }) {
  const [id, setId] = useState(70), [type, setType] = useState('app'), [value, setValue] = useState(''), [label, setLabel] = useState(''), [msg, setMsg] = useState('');
  useEffect(() => { const d = A.get(id)?.def; if (d) { setType(d.type === 'none' ? 'app' : d.type); setValue(d.value); setLabel(d.label.startsWith('Custom ') ? '' : d.label); } }, [id, A]);
  const apply = async (t = type) => { try { onChange(await api.setCustom(id, t, value, label)); setMsg(t === 'none' ? 'Cleared' : 'Saved on this Mac'); } catch (e) { setMsg((e as Error).message); } refresh(); };
  return (
    <details className="custom"><summary>Custom actions (apps · URLs · key combos)</summary>
      <p className="muted">Four slots, stored by the Companion on this Mac and shown on the NU87 as “Custom 1–4”. Assign a slot to any input above.</p>
      <div className="row">
        <select value={id} onChange={e => setId(+e.target.value)}>{[70, 71, 72, 73].map(i => <option key={i} value={i}>Custom {i - 69}{A.get(i)?.supported ? ` · ${A.get(i)!.name}` : ''}</option>)}</select>
        <select value={type} onChange={e => setType(e.target.value)}><option value="app">App</option><option value="url">URL</option><option value="keys">Key combo</option></select>
        <input placeholder={type === 'app' ? 'App name, e.g. Notes' : type === 'url' ? 'https://…' : 'cmd+shift+4'} value={value} onChange={e => setValue(e.target.value)} />
        <input placeholder="Label" maxLength={24} value={label} onChange={e => setLabel(e.target.value)} />
        <button className="ghost sm" disabled={disabled || !value} onClick={() => apply()}>Apply</button>
        <button className="ghost sm" disabled={disabled} onClick={() => apply('none')}>Clear</button>
      </div>{msg && <p className="muted">{msg}</p>}
    </details>);
}

// ───────────── knob ─────────────
function KnobPanel({ draft, mode, setMode, A, edit, actions, disabled }: { draft: DeviceConfig; mode: number; setMode: (m: number) => void; A: Map<number, ActionInfo>; edit: (f: (c: DeviceConfig) => void) => void; actions: ActionInfo[]; disabled: boolean }) {
  const [slot, setSlot] = useState(0); const m = draft.knob.map[mode];
  return (
    <div className="pad">
      <div className="head"><div><h2>KY-040 knob</h2><p className="muted">Active mode on the device: <b>{KNOB_MODES[draft.knob.mode]}</b>. Long press (default) switches to the next mode.</p></div>
        <button className="ghost sm" disabled={disabled} onClick={() => edit(c => { c.knob.map[mode] = [...KNOB_DEFAULTS[mode]]; })}>Reset mode</button></div>
      <div className="seg wide">{KNOB_MODES.map((n, i) => <button key={n} className={mode === i ? 'on' : ''} onClick={() => setMode(i)}>{n}{draft.knob.mode === i ? ' ●' : ''}</button>)}</div>
      <div className="row"><button className="ghost sm" disabled={disabled || draft.knob.mode === mode} onClick={() => edit(c => { c.knob.mode = mode; })}>Use {KNOB_MODES[mode]} mode now</button></div>
      <div className="slots four">{KNOB_SLOTS.map((n, i) => <button key={n} className={`slot ${slot === i ? 'on' : ''}`} onClick={() => setSlot(i)}><small>{i === 0 ? '↻ ' : i === 1 ? '↺ ' : ''}{n}</small><b>{A.get(m[i])?.name ?? `#${m[i]}`}</b><Where a={A.get(m[i])} /></button>)}</div>
      <ActionPicker value={m[slot]} onChange={id => edit(c => { c.knob.map[mode][slot] = id; })} A={new Map(actions.map(a => [a.id, a]))} disabled={disabled} rotation={slot < 2} />
      {mode === 3 && <p className="muted">Reasoning actions have no verified Mac interface, so they are marked Unsupported and do nothing (not simulated).</p>}
    </div>);
}

// ───────────── RGB ─────────────
function RgbPanel({ draft, edit, disabled }: { draft: DeviceConfig; edit: (f: (c: DeviceConfig) => void) => void; disabled: boolean }) {
  const r = draft.rgb; const amb = ambient(draft); const col = baseColor(r);
  const rainbow = `linear-gradient(90deg,${[0, 60, 120, 180, 240, 300, 358].map(h => css(hueToRgb(h))).join(',')})`;
  const sw: [string, number[]][] = [['Soft White', [255, 255, 255]], ['Pastel Pink', [255, 170, 205]], ['Pastel Sky', [155, 215, 255]]];
  return (
    <div className="pad">
      <div className="head"><div><h2>Ambient light</h2><p className="muted">Switch colours still win while a key is held.</p></div>
        <button className="ghost sm" disabled={disabled} onClick={() => edit(c => { c.rgb = { ...RGB_DEFAULT }; })}>Reset</button></div>
      <div className="preview"><i className="orb" style={amb.style} /><span>{r.effect === 0 ? 'Off' : `${EFFECTS[r.effect]} · ${r.color === 3 ? `Custom ${r.hue}°` : COLORS[r.color]} · ${r.brightness}%`}</span></div>
      <label className="field">Effect</label>
      <div className="seg wide">{EFFECTS.map((n, i) => <button key={n} disabled={disabled} className={r.effect === i ? 'on' : ''} onClick={() => edit(c => { c.rgb.effect = i; })}>{n}</button>)}</div>
      <label className="field">Colour</label>
      <div className="swatches">{[...sw, ['Custom', col as unknown as number[]]].map(([n, v], i) => (
        <button key={n as string} disabled={disabled} className={r.color === i ? 'on' : ''} onClick={() => edit(c => { c.rgb.color = i; })}><i style={{ background: css((i === 3 ? hueToRgb(r.hue) : v) as any) }} />{n as string}</button>))}</div>
      {r.color === 3 && <><label className="field">Custom hue <b>{r.hue}°</b></label><input type="range" className="hue" style={{ background: rainbow }} min={0} max={358} step={2} value={r.hue} disabled={disabled} onChange={e => edit(c => { c.rgb.hue = +e.target.value; })} /></>}
      <label className="field">Brightness <b>{r.brightness}%</b></label>
      <input type="range" min={0} max={100} value={r.brightness} disabled={disabled} onChange={e => edit(c => { c.rgb.brightness = +e.target.value; })} />
      <label className="field">Speed <b>{(r.speed10 / 10).toFixed(1)} s</b> <small className="muted">(Breathing / Cycle period)</small></label>
      <input type="range" min={5} max={50} value={r.speed10} disabled={disabled} onChange={e => edit(c => { c.rgb.speed10 = +e.target.value; })} />
    </div>);
}
