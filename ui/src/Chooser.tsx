// First-run (and on-demand) synth picker. Blurs the whole window and asks which
// instrument SLIDE should play. In the plugin build the list comes from the
// C++ plugin scanner; in the browser only the built-in voices exist.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useStore, setState, chooseInstrument, getState, SynthPreset } from './store';
import { bridge, isPlugin, PluginInfo } from './bridge';
import { audition } from './audio';

const BUILTIN: { name: SynthPreset; desc: string }[] = [
  { name: 'Glass Saw', desc: 'Bright detuned saw' },
  { name: 'Soft Square', desc: 'Hollow, woody' },
  { name: 'Warm Pad', desc: 'Slow and wide' },
  { name: 'Pure Sine', desc: 'Clean reference tone' },
];

export function Chooser() {
  const open = useStore(s => s.chooser);
  const current = useStore(s => s.instrument);
  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  const [scanning, setScanning] = useState(false);
  const [q, setQ] = useState('');
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const search = useRef<HTMLInputElement>(null);

  useEffect(() => {
    bridge.onPluginList(list => { setPlugins(list); setScanning(false); });
    bridge.onPluginLoaded(r => {
      setLoading(null);
      if (r.ok) {
        const p = getPluginInfo(r.id);
        chooseInstrument({ kind: 'plugin', id: r.id, name: r.name, vendor: p?.vendor ?? '', format: p?.format ?? 'VST3' });
      } else setError(r.error || `${r.name} could not be loaded.`);
    });
  }, []);
  const listRef = useRef(plugins); listRef.current = plugins;
  const getPluginInfo = (id: string) => listRef.current.find(p => p.id === id);

  useEffect(() => {
    if (!open) return;
    setError(null); setQ('');
    if (isPlugin) { setScanning(plugins.length === 0); bridge.scanPlugins(); }
    setTimeout(() => search.current?.focus(), 50);
  }, [open]);

  const filtered = useMemo(() => {
    const t = q.trim().toLowerCase();
    const match = (s: string) => !t || s.toLowerCase().includes(t);
    return {
      mpe: plugins.filter(p => p.mpe && (match(p.name) || match(p.vendor))),
      other: plugins.filter(p => !p.mpe && (match(p.name) || match(p.vendor))),
      builtin: BUILTIN.filter(b => match(b.name) || match('built-in')),
    };
  }, [q, plugins]);

  if (!open) return null;
  const canClose = !!current;
  const close = () => { if (canClose) setState({ chooser: false }); };

  const pickPlugin = (p: PluginInfo) => { setError(null); setLoading(p.id); bridge.loadPlugin(p.id); };
  const pickBuiltin = (name: SynthPreset) => { chooseInstrument({ kind: 'builtin', name }); audition(60, 0.8, 0.6); };
  const isCurrent = (id: string) => current?.kind === 'plugin' ? current.id === id : current?.name === id;

  return (
    <div className="chooser-back" onPointerDown={e => { if (e.target === e.currentTarget) close(); }}
      onKeyDown={e => { if (e.key === 'Escape') close(); e.stopPropagation(); }}>
      <div className="chooser" role="dialog" aria-labelledby="chooser-title">
        <div className="chooser-head">
          <h2 id="chooser-title">Choose a synth to play</h2>
          <p>SLIDE plays it note by note, with every glide and pressure ribbon. You can change it any time from the title in the top bar.</p>
        </div>
        <input id="synth-search" ref={search} className="chooser-search" placeholder={isPlugin ? 'Search your synths' : 'Search'} value={q} onChange={e => setQ(e.target.value)} />
        <div className="chooser-list">
          {isPlugin && <>
            {scanning && <div className="chooser-empty">Looking for AU and VST3 instruments…</div>}
            {!scanning && plugins.length === 0 && <div className="chooser-empty">No instrument plugins found. Install a synth, then press Rescan.</div>}
            {filtered.mpe.length > 0 && <Group label="MPE synths">{filtered.mpe.map(p => <PluginRow key={p.id} p={p} current={isCurrent(p.id)} loading={loading === p.id} onPick={() => pickPlugin(p)} />)}</Group>}
            {filtered.other.length > 0 && <Group label={filtered.mpe.length ? 'Other instruments' : 'Your instruments'}>{filtered.other.map(p => <PluginRow key={p.id} p={p} current={isCurrent(p.id)} loading={loading === p.id} onPick={() => pickPlugin(p)} />)}</Group>}
          </>}
          {!isPlugin && (
            <Group label="Your synths">
              <div className="chooser-empty">Your installed VST3 and AU synths are listed here in the plugin and standalone app.</div>
            </Group>
          )}
          {filtered.builtin.length > 0 && (
            <Group label="Built-in">
              {filtered.builtin.map(b => (
                <button key={b.name} className={'chooser-row' + (isCurrent(b.name) ? ' current' : '')} onClick={() => pickBuiltin(b.name)}>
                  <span className="cr-name">{b.name}</span><span className="cr-meta">{b.desc}</span>
                  <span className="cr-tag">Preview</span>
                </button>
              ))}
            </Group>
          )}
        </div>
        {error && <div className="chooser-error">{error}</div>}
        <div className="chooser-foot">
          <span>If a synth doesn't glide, turn on MPE in its settings and set its pitch-bend range to ±{getState().clip.range}.</span>
          <div className="row">
            {isPlugin && <button className="btn" onClick={() => { setScanning(true); bridge.scanPlugins(true); }}>Rescan</button>}
            {canClose && <button className="btn" onClick={close}>Close</button>}
          </div>
        </div>
      </div>
    </div>
  );
}

function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="chooser-group"><div className="label">{label}</div>{children}</div>;
}

function PluginRow({ p, current, loading, onPick }: { p: PluginInfo; current: boolean; loading: boolean; onPick: () => void }) {
  return (
    <button className={'chooser-row' + (current ? ' current' : '')} onClick={onPick} disabled={loading}>
      <span className="cr-name">{p.name}</span><span className="cr-meta">{p.vendor}</span>
      <span className="cr-tag">{loading ? 'Loading…' : p.format}</span>
    </button>
  );
}
