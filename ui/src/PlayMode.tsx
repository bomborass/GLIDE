// Playing Mode: the start screen choice, the live overlay on the roll (neon
// note display, "hold for glide", the let-go countdown, tips) and the settings
// panel shown in place of the note inspector.
import { useEffect, useRef, useState } from 'react';
import { getState, setState, useStore } from './store';
import { useLive, getLive, soundingPitches, chordName, noteLabel, phraseTime, letGo } from './live';
import { SliderRow } from './ui';
import { isPlugin } from './bridge';

// ==================================================================== start screen

export function ModeChooser() {
  const show = useStore(s => s.modeChooser && !s.chooser);
  const mode = useStore(s => s.mode);
  const pick = (m: 'play' | 'edit') => setState({ mode: m, modeChooser: false, ...(m === 'play' ? { popup: null, preview: null } : {}) });
  useEffect(() => {
    if (!show) return;
    const k = (e: KeyboardEvent) => {
      if (e.key === '1' || e.key.toLowerCase() === 'p') pick('play');
      else if (e.key === '2' || e.key.toLowerCase() === 'e') pick('edit');
      else if (e.key === 'Enter') pick(getState().mode);
      else return;
      e.preventDefault(); e.stopImmediatePropagation();
    };
    window.addEventListener('keydown', k, true);
    return () => window.removeEventListener('keydown', k, true);
  }, [show]);
  if (!show) return null;
  return (
    <div className="chooser-back mode-back" role="dialog" aria-modal="true" aria-label="Choose a mode">
      <div className="mode-pick">
        <h2>How do you want to start?</h2>
        <div className="mode-cards">
          <button className={'mode-card play' + (mode === 'play' ? ' last' : '')} onClick={() => pick('play')} autoFocus={mode === 'play'}>
            <PlayArt />
            <span className="mc-title">Playing Mode</span>
            <span className="mc-text">Play a chord and let go: it keeps ringing. Play the next one and every note glides into it.</span>
            <span className="mc-key">1</span>
          </button>
          <button className={'mode-card edit' + (mode === 'edit' ? ' last' : '')} onClick={() => pick('edit')} autoFocus={mode === 'edit'}>
            <EditArt />
            <span className="mc-title">Editing Mode</span>
            <span className="mc-text">Draw and shape glides, pressure and timing in the piano roll, note by note.</span>
            <span className="mc-key">2</span>
          </button>
        </div>
        <p className="mode-foot">Switch any time with the Play / Edit buttons next to the logo.</p>
      </div>
    </div>
  );
}

/** Three voices gliding from one chord into the next, drawn live. */
function PlayArt() {
  return (
    <svg className="mc-art" viewBox="0 0 240 110" aria-hidden="true">
      {[[22, 64], [44, 34], [66, 80]].map(([a, b], i) => (
        <g key={i}>
          <path className="mc-line" style={{ animationDelay: `${i * 0.18}s` }} d={`M14 ${a} H96 C128 ${a} 128 ${b} 160 ${b} H226`} />
          <rect className="mc-note a" x="14" y={a - 5} width="82" height="10" rx="2" />
          <rect className="mc-note b" style={{ animationDelay: `${0.6 + i * 0.18}s` }} x="160" y={b - 5} width="66" height="10" rx="2" />
        </g>
      ))}
    </svg>
  );
}

function EditArt() {
  return (
    <svg className="mc-art" viewBox="0 0 240 110" aria-hidden="true">
      {Array.from({ length: 9 }, (_, i) => <rect key={i} x="0" y={i * 12} width="240" height="11" className={i % 3 === 1 ? 'mc-row dark' : 'mc-row'} />)}
      <rect className="mc-enote" x="20" y="25" width="60" height="10" rx="1.5" />
      <rect className="mc-enote" x="96" y="49" width="44" height="10" rx="1.5" />
      <rect className="mc-enote sel" x="150" y="13" width="70" height="10" rx="1.5" />
      <path className="mc-bend" d="M120 54 C132 54 134 18 150 18" />
      <circle className="mc-dot" cx="150" cy="18" r="3.5" />
    </svg>
  );
}

// ==================================================================== live overlay

const TIPS = [
  'Strum it: notes that arrive close together count as one chord',
  'Move just one finger: only that voice glides',
  'Play fewer notes: the extra voices fade out',
  'Jump an octave: Distance mode makes big moves slower',
  'Hold the same chord again to keep it ringing longer',
  'Wiggle between two chords for a wobble',
];

export function PlayHud() {
  const mode = useStore(s => s.mode);
  const blocked = useStore(s => s.chooser || s.modeChooser);
  const hold = useStore(s => s.play.holdSecs);
  const active = useLive(l => l.active);
  const chords = useLive(l => l.chords);
  const [, tick] = useState(0);
  const [tip, setTip] = useState(0);
  const raf = useRef(0);
  // redraw at screen rate while a phrase plays (display, glide flash, countdown)
  useEffect(() => {
    if (!active) return;
    const f = () => { tick(t => t + 1); raf.current = requestAnimationFrame(f); };
    raf.current = requestAnimationFrame(f);
    return () => cancelAnimationFrame(raf.current);
  }, [active]);
  useEffect(() => { const id = setInterval(() => setTip(t => (t + 1) % TIPS.length), 6000); return () => clearInterval(id); }, []);
  if (mode !== 'play' || blocked) return null;

  const l = getLive();
  const t = phraseTime();
  const pitches = active ? soundingPitches(true) : [];
  const now = active ? soundingPitches(false) : [];
  const gliding = active && t - l.gliding < 0.6;
  const left = active ? Math.max(0, hold - (t - l.lastOnAt)) : hold;
  const name = chordName(pitches);
  const sorted = [...pitches].sort((a, b) => a - b);
  const moving = now.some((p, i) => Math.abs(p - Math.round(p)) > 0.02 || Math.round(p) !== Math.round(pitches[i] ?? p));

  return (
    <div className="play-hud" aria-live="polite">
      <div className={'neon' + (active ? ' on' : '') + (moving ? ' moving' : '')}>
        <Seg text={active ? (name || (sorted.length === 1 ? noteLabel(sorted[0]) : '- -')) : 'SLIDE'} big />
        <div className="neon-notes">
          {active && sorted.length > 1
            ? sorted.slice(0, 6).map((p, i) => <Seg key={i} text={noteLabel(p)} />)
            : <Seg text={active ? 'PLAYING' : 'READY'} />}
        </div>
      </div>
      {active ? (
        <div className={'hold-pill' + (gliding ? ' gliding' : '')}>
          <Ring frac={left / hold} />
          <span className="hp-text">{gliding ? 'gliding…' : 'hold for glide'}</span>
          <span className="hp-sub">{chords > 1 ? `${chords} chords` : 'play the next chord'}</span>
          <button className="hp-go" onClick={letGo} title="Let go of everything now (Esc)">let go</button>
        </div>
      ) : (
        <div className="hold-pill idle">
          <span className="hp-text">play a chord</span>
          <span className="hp-sub">{isPlugin ? 'from your MIDI keyboard' : 'MIDI keyboard, or keys A–K on your computer (Z/X octave)'}</span>
        </div>
      )}
      <div className="play-tip" key={tip}>{TIPS[tip]}</div>
    </div>
  );
}

/** 14-segment display text with the unlit segments faintly visible behind it. */
function Seg({ text, big }: { text: string; big?: boolean }) {
  return (
    <span className={'seg' + (big ? ' big' : '')}>
      <span className="seg-ghost" aria-hidden="true">{'~'.repeat(Math.max(1, text.replace(/[.:]/g, '').length))}</span>
      <span className="seg-lit">{text}</span>
    </span>
  );
}

/** How long until the notes are let go. */
function Ring({ frac }: { frac: number }) {
  const r = 9, c = 2 * Math.PI * r;
  return (
    <svg className="hp-ring" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r={r} className="track" />
      <circle cx="12" cy="12" r={r} className="left" strokeDasharray={c} strokeDashoffset={c * (1 - Math.max(0, Math.min(1, frac)))} transform="rotate(-90 12 12)" />
    </svg>
  );
}

// ==================================================================== settings panel

export function PlayPanel() {
  const g = useStore(s => s.glide);
  const p = useStore(s => s.play);
  const active = useLive(l => l.active);
  const setG = (x: Partial<typeof g>) => setState(s => ({ glide: { ...s.glide, ...x } }));
  const setP = (x: Partial<typeof p>) => setState(s => ({ play: { ...s.play, ...x } }));
  return (
    <div>
      <div className="insp-head"><h3>Playing Mode</h3></div>
      <div className="section">
        <div className="label">Glide time</div>
        <SliderRow value={g.glideMs} min={20} max={1500} onChange={v => setG({ glideMs: Math.round(v) })} display={`${g.glideMs} ms`} />
      </div>
      <div className="section">
        <div className="label">Glide by</div>
        <div className="grid2">
          <button className={'btn' + (g.mode === 'time' ? ' active' : '')} onClick={() => setG({ mode: 'time' })} title="Every glide takes the same time">Time</button>
          <button className={'btn' + (g.mode === 'distance' ? ' active' : '')} onClick={() => setG({ mode: 'distance' })} title="Bigger jumps take longer">Distance</button>
        </div>
      </div>
      <div className="section">
        <div className="label">Strum window</div>
        <SliderRow value={p.strumMs} min={20} max={250} onChange={v => setP({ strumMs: Math.round(v) })} display={`${p.strumMs} ms`} />
        <p className="empty-note">Notes this close together count as one chord.</p>
      </div>
      <div className="section">
        <div className="label">Let go after</div>
        <SliderRow value={p.holdSecs} min={2} max={30} onChange={v => setP({ holdSecs: Math.round(v) })} display={`${p.holdSecs} s`} />
        <p className="empty-note">Seconds without a new chord before everything is released.</p>
      </div>
      <div className="section stack">
        <button className={'btn block' + (p.capture ? ' active' : '')} onClick={() => setP({ capture: !p.capture })} title="Write each phrase into the clip when it ends">
          {p.capture ? '● Capturing into the clip' : '○ Not capturing'}
        </button>
        <button className="btn block" onClick={letGo} disabled={!active}>Let go now <span className="dim">Esc</span></button>
        <button className="btn block" onClick={() => setState({ mode: 'edit' })}>Edit what you played →</button>
      </div>
    </div>
  );
}
