import { useEffect, useMemo, useRef, useState } from 'react';
import { Engine, type Stats } from './engine';
import { STATE_LIST, type StateName } from '../core/pose';
import { DENSITIES } from '../core/grid';
import { Device } from '../ui/device';
import { action } from '../ui/config';
import { AI_STATES, MockCompanion, WEATHER_KINDS, type AiState, type WeatherKind } from '../ui/status';

const LABEL: Record<StateName, string> = {
  idle: 'Idle', happy: 'Happy', thinking: 'Thinking', sleeping: 'Sleeping', error: 'Error', excited: 'Excited',
};
const AI_LABEL: Record<AiState, string> = { disconnected: 'Off', idle: 'Idle', thinking: 'Thinking', done: 'Done', error: 'Error' };
const LONG_MS = 500;
const now = () => performance.now();

export function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<Engine | null>(null);
  const device = useMemo(() => new Device(), []);
  const mock = useMemo(() => new MockCompanion((m) => device.receive(m)), [device]);
  const [, bump] = useState(0);
  const [log, setLog] = useState<string[]>([]);
  const [state, setState] = useState<StateName>('idle');
  const [scale, setScale] = useState(2);
  const [speed, setSpeed] = useState(1);
  const [density, setDensity] = useState(3);
  const [yaw, setYaw] = useState(0);
  const [persp, setPersp] = useState(true);
  const [glow, setGlow] = useState(true);
  const [dirtyOv, setDirtyOv] = useState(false);
  const [auto, setAuto] = useState(false);
  const [stats, setStats] = useState<Stats | null>(null);
  const [copied, setCopied] = useState(false);
  const [down, setDown] = useState<Record<string, boolean>>({});
  const press = useRef<{ timer: number; long: boolean } | null>(null);

  useEffect(() => {
    device.onChange = () => bump((n) => n + 1);
    device.onLog = (line) => setLog((l) => [line, ...l].slice(0, 6));
    const e = new Engine(canvasRef.current!, device);
    e.onState = setState;
    e.onStats = setStats;
    engineRef.current = e;
    Object.assign(window, { usagi: e, nu87: device });
    e.start();
    mock.start();
    return () => { e.stop(); mock.stop(); };
  }, [device, mock]);

  useEffect(() => {
    const e = engineRef.current;
    if (!e) return;
    Object.assign(e.settings, { speed, density, yaw, persp, glow, showDirty: dirtyOv, autoCycle: auto });
  }, [speed, density, yaw, persp, glow, dirtyOv, auto]);

  // encoder button: short = click, held ≥ LONG_MS = long-press (fires while still held, like firmware)
  const encDown = () => {
    if (press.current) return;
    const p = { long: false, timer: window.setTimeout(() => { p.long = true; device.longPress(now()); }, LONG_MS) };
    press.current = p;
    setDown((d) => ({ ...d, enc: true }));
  };
  const encUp = () => {
    const p = press.current;
    if (!p) return;
    clearTimeout(p.timer);
    press.current = null;
    setDown((d) => ({ ...d, enc: false }));
    if (!p.long) device.click(now());
  };
  const sw = (i: number, isDown: boolean) => {
    setDown((d) => ({ ...d, [i]: isDown }));
    if (isDown) device.swDown(i, now()); else device.swUp(i, now());
  };

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      const tag = (ev.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || ev.metaKey || ev.ctrlKey || ev.altKey) return;
      const isDown = ev.type === 'keydown';
      const n = Number(ev.key);
      if (n >= 1 && n <= 9) { if (!ev.repeat) sw(n - 1, isDown); return; }
      if (ev.key === 'Enter') { ev.preventDefault(); if (isDown) { if (!ev.repeat) encDown(); } else encUp(); return; }
      if (!isDown) return;
      if (ev.key === 'ArrowRight' || ev.key === 'ArrowDown') { ev.preventDefault(); device.rotate(1); }
      else if (ev.key === 'ArrowLeft' || ev.key === 'ArrowUp') { ev.preventDefault(); device.rotate(-1); }
      else if (ev.key === 'Escape' || ev.key === 'Backspace') device.longPress(now());
      else if (ev.key === 'p' || ev.key === 'P') device.pa7(now());
      else if (ev.key === 'r') engineRef.current?.replayIntro();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKey);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('keyup', onKey); };
  }, [device]);

  const wheel = useRef(0);
  const onWheel = (e: React.WheelEvent) => {
    wheel.current += e.deltaY;
    while (Math.abs(wheel.current) >= 40) { device.rotate(wheel.current > 0 ? 1 : -1); wheel.current -= Math.sign(wheel.current) * 40; }
  };

  const exportC = async () => {
    const txt = engineRef.current?.exportC() ?? '';
    try { await navigator.clipboard.writeText(txt); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* ignore */ }
    const url = URL.createObjectURL(new Blob([txt], { type: 'text/plain' }));
    const a = document.createElement('a'); a.href = url; a.download = 'usagi_frame.h'; a.click();
    URL.revokeObjectURL(url);
  };

  const editing = device.screen === 'keymap';

  return (
    <div className="page">
      <header>
        <h1>NU87 Desk <span>Home + Key Mapping</span></h1>
        <p>NU87 TinyDK · ST7796S 480×320 · browser prototype</p>
      </header>

      <main>
        <section className="stage">
          <div className="bezel" style={{ width: 480 * scale + 24 }}>
            <canvas ref={canvasRef} style={{ width: 480 * scale, height: 320 * scale }} />
          </div>
          <div className="stats">
            {stats ? (
              <>
                <b>{stats.fps.toFixed(0)}</b> FPS · <b>{stats.ms.toFixed(1)}</b> ms render ·
                dirty <b>{stats.dirty}</b>/{stats.cells} cells · UI <b>{stats.uiPx}</b> px ·
                ~<b>{(stats.spiBytes / 1024).toFixed(1)}</b> KB SPI/frame
                {stats.introT !== null && <> · intro {stats.introT.toFixed(1)}s</>}
              </>
            ) : '…'}
          </div>

          <div className="hw">
            <div className="hwcol">
              <h2>PA7 <small>P</small></h2>
              <button className="pa7" onClick={() => device.pa7(now())}>{editing ? 'Home' : 'Key Mapping'}</button>
              <p className="note">Virtual input only — PA7 shares boot / UART duties on the board.</p>
            </div>
            <div className="hwcol">
              <h2>Switches <small>keys 1–9 · {editing ? 'select only while editing' : `profile ${device.profile.name}`}</small></h2>
              <div className="keys">
                {device.profile.keys.map((k, i) => (
                  <button key={i} className={`${down[i] ? 'down' : ''} ${editing && device.km.key === i ? 'sel' : ''}`}
                    onPointerDown={() => sw(i, true)} onPointerUp={() => down[i] && sw(i, false)} onPointerLeave={() => down[i] && sw(i, false)}>
                    <i>SW{i + 1}</i>{action(k.single).short}
                  </button>
                ))}
              </div>
            </div>
            <div className="hwcol">
              <h2>Encoder <small>← → · Enter · Esc</small></h2>
              <div className="enc" onWheel={onWheel}>
                <button onClick={() => device.rotate(-1)} aria-label="Rotate left">◀</button>
                <button className={`knob ${down.enc ? 'down' : ''}`} onPointerDown={encDown} onPointerUp={encUp} onPointerLeave={encUp}>
                  click<small>hold = back</small>
                </button>
                <button onClick={() => device.rotate(1)} aria-label="Rotate right">▶</button>
              </div>
            </div>
            <div className="hwcol log">
              <h2>Event log <small>simulated — nothing is sent</small></h2>
              {log.length ? log.map((l, i) => <div key={i}>{l}</div>) : <div className="note">Press a switch on Home.</div>}
            </div>
          </div>
        </section>

        <aside>
          <h2>Mock companion <em className="tag">test data</em></h2>
          {device.status.ai.map((a) => (
            <label key={a.id}>{a.name}
              <div className="seg tight">
                {AI_STATES.map((s) => (
                  <button key={s} className={a.state === s ? 'on' : ''} onClick={() => mock.setAi(a.id, s)}>{AI_LABEL[s]}</button>
                ))}
              </div>
            </label>
          ))}
          <label>City
            <input type="text" defaultValue={mock.weather.city} maxLength={18} onChange={(e) => mock.setWeather({ city: e.target.value })} />
          </label>
          <div className="pair">
            <label>Weather
              <select defaultValue={mock.weather.kind} onChange={(e) => mock.setWeather({ kind: e.target.value as WeatherKind })}>
                {WEATHER_KINDS.map((w) => <option key={w}>{w}</option>)}
              </select>
            </label>
            <label>Temp °C
              <input type="number" defaultValue={mock.weather.tempC} min={-30} max={45} onChange={(e) => mock.setWeather({ tempC: +e.target.value })} />
            </label>
          </div>
          <p className="note">Time comes from this browser's clock, pushed once a minute. Weather re-sends every 20 min.</p>

          <h2>Expression override <small>design review</small></h2>
          <div className="btns">
            {STATE_LIST.map((s) => (
              <button key={s} className={state === s ? 'on' : ''} onClick={() => engineRef.current?.setState(s)}>{LABEL[s]}</button>
            ))}
          </div>
          <button className="wide" onClick={() => engineRef.current?.replayIntro()}>↻ Replay intro <i>R</i></button>

          <h2>Preview</h2>
          <div className="seg">
            {[1, 2, 3].map((s) => (
              <button key={s} className={scale === s ? 'on' : ''} onClick={() => setScale(s)}>{s}×</button>
            ))}
          </div>
          <label>Animation speed <b>{speed.toFixed(2)}×</b>
            <input type="range" min={0.25} max={2} step={0.05} value={speed} onChange={(e) => setSpeed(+e.target.value)} />
          </label>
          <label>Rotation <b>{yaw > 0 ? '+' : ''}{yaw}°</b>
            <input type="range" min={-15} max={15} step={1} value={yaw} onChange={(e) => setYaw(+e.target.value)} />
          </label>
          <label>ASCII density
            <select value={density} onChange={(e) => setDensity(+e.target.value)}>
              {DENSITIES.map((d, i) => <option key={i} value={i}>{d.name}</option>)}
            </select>
          </label>
          <div className="checks">
            <label><input type="checkbox" checked={persp} onChange={(e) => setPersp(e.target.checked)} /> Perspective projection</label>
            <label><input type="checkbox" checked={glow} onChange={(e) => setGlow(e.target.checked)} /> Glow <em>browser only</em></label>
            <label><input type="checkbox" checked={dirtyOv} onChange={(e) => setDirtyOv(e.target.checked)} /> Show dirty cells / rects</label>
            <label><input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} /> Auto-cycle states</label>
          </div>

          <button className="wide" onClick={exportC}>{copied ? 'Copied ✓' : 'Export frame + font (C header)'}</button>
          <button className="wide" onClick={() => device.resetConfig(now())}>Reset key mapping to defaults</button>
        </aside>
      </main>
    </div>
  );
}
