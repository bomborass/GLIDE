import React, { useEffect, useRef, useState } from 'react';
import { Roll, fmtPos } from './Roll';
import {
  useStore, getState, setState, undo, redo, editNotes, editClip, checkpoint, selectedNotes, flash,
  listClips, openClip, createClip, deleteClip, importClip, Tool, EditTool, ExportFormat,
} from './store';
import {
  Curve, Note, PathPoint, clamp, connectNotes, presetScoop, presetFall, presetRise, presetHumanize,
  tuneToNearest, applyVibrato, pressurePreset, applyDynamics, PressureShape, evalPath, quantize, PRESSURE_AS } from './model';
import { togglePlay, playheadBeat, retime } from './audio';
import { downloadMidi, exportMidi } from './midi';
import { armRecording } from './record';
import { Dropdown, MenuItem, SliderRow } from './ui';
import * as I from './icons';
import { isPlugin, bridge, toBase64, pressTile } from './bridge';
import { Chooser } from './Chooser';
import { ModeChooser, PlayHud, PlayPanel } from './PlayMode';
import { parseMidi } from './midiImport';
import { dragWav, pointerDownWav, saveWav, hoverWav } from './wavExport';

const QGRIDS: [string, number][] = [['1/4', 1], ['1/8', 0.5], ['1/16', 0.25], ['1/32', 0.125], ['1/8T', 1 / 3], ['1/16T', 1 / 6]];
const RANGES = [2, 12, 24, 48, 96];
const FORMATS: [ExportFormat, string, string][] = [
  ['mpe', 'MPE (standard)', 'Logic, Bitwig, Reaper, Studio One'],
  ['ableton', 'Ableton Live', 'MPE clip with ±48 bend'],
  ['cubase', 'Cubase', 'For Note Expression import'],
  ['mono', 'Mono (one channel)', 'Non-MPE synths'],
];

// ==================================================================== MIDI import

async function importMidiFile(file: File) {
  importMidiBytes(new Uint8Array(await file.arrayBuffer()), file.name);
}

function importMidiBytes(bytes: Uint8Array, name: string) {
  // judge by content, not the name: drags from other apps often have odd names
  if (bytes.length < 14 || String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) !== 'MThd') {
    flash(`${name || 'That file'} isn't a MIDI file`); return;
  }
  try {
    const clip = parseMidi(bytes, name || 'Imported.mid');
    importClip(clip);
    const glides = clip.notes.filter(n => n.bend.length).length;
    flash(`Imported ${clip.notes.length} notes${glides ? ` (${glides} with glides)` : ''} · press Connect all notes or Continuous Glide`);
  } catch (e: any) { flash(e?.message || 'Could not read that MIDI file'); }
}

if (isPlugin) bridge.onFileData(f => {
  if (f.error || !f.base64) { flash(f.error || 'Could not read the dropped file'); return; }
  const bin = atob(f.base64); const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  importMidiBytes(bytes, f.name);
});

function openMidiFile() {
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = '.mid,.midi,audio/midi';
  inp.onchange = () => { const f = inp.files?.[0]; if (f) importMidiFile(f); };
  inp.click();
}

/** Drop a .mid anywhere on the window to open it (files, or file URLs from other apps). */
function useMidiDrop() {
  const [over, setOver] = useState(false);
  const depth = useRef(0);
  const carries = (e: React.DragEvent) => {
    const t = Array.from(e.dataTransfer.types);
    return t.includes('Files') || t.includes('text/uri-list') || t.some(x => x.includes('file-url'));
  };
  useEffect(() => {
    // the overlay never sticks: any drag ending anywhere clears it
    const clear = () => { depth.current = 0; setOver(false); };
    window.addEventListener('dragend', clear); window.addEventListener('drop', clear);
    // stop the web view from opening a file dropped outside the drop handler
    const block = (e: DragEvent) => e.preventDefault();
    window.addEventListener('dragover', block); window.addEventListener('drop', block);
    return () => { window.removeEventListener('dragend', clear); window.removeEventListener('drop', clear); window.removeEventListener('dragover', block); window.removeEventListener('drop', block); };
  }, []);
  return {
    over,
    handlers: {
      onDragEnter: (e: React.DragEvent) => { if (!carries(e)) return; e.preventDefault(); depth.current++; setOver(true); },
      onDragOver: (e: React.DragEvent) => { if (!carries(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; },
      onDragLeave: (e: React.DragEvent) => { if (!carries(e)) return; depth.current = Math.max(0, depth.current - 1); if (!depth.current) setOver(false); },
      onDrop: (e: React.DragEvent) => {
        e.preventDefault(); depth.current = 0; setOver(false);
        const f = e.dataTransfer.files[0];
        if (f && f.size > 0) { importMidiFile(f); return; }
        const url = (e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain') || '').split(/\r?\n/).find(l => l.startsWith('file:'));
        if (url && isPlugin) { bridge.readFile(url); return; }
        flash('Drop a .mid file here');
      },
    },
  };
}

// ==================================================================== App

export function App() {
  const popup = useStore(s => s.popup);
  const [help, setHelp] = useState(false);
  const drop = useMidiDrop();
  const [inspW, setInspW] = useState(INSP_W);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
      const mod = e.metaKey || e.ctrlKey;
      const s = getState();
      if (s.chooser) return;
      if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
      if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
      if (mod || e.altKey) return;
      if (e.code === 'Space') { e.preventDefault(); togglePlay(); return; }
      const tools: Record<string, Tool> = { '1': 'notes', '2': 'pitch', '3': 'pressure' };
      if (tools[e.key]) { setState({ tool: tools[e.key], drawMode: false }); return; }
      const edits: Record<string, EditTool> = { p: 'draw', h: 'move', e: 'select', c: 'slice' };
      if (edits[e.key.toLowerCase()]) { setState({ edit: edits[e.key.toLowerCase()] }); return; }
      if (e.key.toLowerCase() === 'b') { setState({ tool: s.tool === 'notes' ? 'pitch' : 'notes', drawMode: false }); return; }
      if (e.key.toLowerCase() === 'd') {
        const tool = s.tool === 'pressure' ? 'pressure' : 'pitch';
        setState({ tool, drawMode: !(s.drawMode && s.tool === tool) });
        flash(!s.drawMode ? 'Pencil · free-draw pitch and vibrato' : 'Pencil off');
        return;
      }
      if (e.key === '?') setHelp(h => !h);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="app" {...drop.handlers}>
      <TopBar onHelp={() => setHelp(true)} />
      <div className="main" style={{ ['--insp-w' as any]: `${inspW}px` }}>
        <Roll />
        <PlayHud />
        <Inspector onWidth={setInspW} />
        {popup === 'connect' && <ConnectPopup />}
        {popup === 'vibrato' && <VibratoPopup />}
        {popup === 'dynamics' && <DynamicsPopup />}
        {popup === 'quantize' && <QuantizePopup />}
      </div>
      <Footer />
      {help && <Help onClose={() => setHelp(false)} />}
      <Chooser />
      <ModeChooser />
      {drop.over && <div className="drop-zone"><div><b>Drop a MIDI file to open it</b><span>Notes, tempo and any MPE glides come in as a new clip.</span></div></div>}
    </div>
  );
}

// ==================================================================== Top bar

function TopBar({ onHelp }: { onHelp: () => void }) {
  // subscribe field by field so note edits don't re-render the whole bar
  const s = {
    playing: useStore(st => st.playing), recording: useStore(st => st.recording), loopOn: useStore(st => st.loopOn),
    metronome: useStore(st => st.metronome), edit: useStore(st => st.edit), tool: useStore(st => st.tool),
    popup: useStore(st => st.popup), canUndo: useStore(st => st.canUndo), canRedo: useStore(st => st.canRedo),
    exportFormat: useStore(st => st.exportFormat),
    get clip() { return getState().clip; },
  };
  const setTool = (tool: Tool) => setState({ tool, drawMode: false });
  const tools: [EditTool, string, React.ReactNode, string][] = [
    ['draw', 'Draw (P)', <I.IPencil />, 'Click to place a note, drag to move it'],
    ['move', 'Hand (H)', <I.IHand />, 'Drag notes to move them; double-click a note to snap it to the grid'],
    ['select', 'Select (E)', <I.ISelectTool />, 'Drag to select notes'],
    ['slice', 'Slice (C)', <I.ISlice />, 'Drag a line across notes to cut them'],
  ];
  return (
    <div className="topbar">
      <div className="logo">SLIDE</div>
      <ModeSwitch />
      <TitleMenu />
      <div className="tb-scroll">
      <div className="tb-group">
        <button className={'tb-btn' + (s.playing ? ' lit' : '')} title="Play / stop (Space)" aria-label={s.playing ? 'Stop' : 'Play'} onClick={togglePlay}>{s.playing ? <I.IStop /> : <I.IPlay />}</button>
        <button className={'tb-btn' + (s.recording ? ' rec' : '')} title="Record notes and knob moves (they appear as lanes in the bottom panel)" aria-label="Record" onClick={() => armRecording(!s.recording)}><I.IRec /></button>
        <button className={'tb-btn' + (s.loopOn ? ' lit' : '')} title="Loop" aria-label="Loop" onClick={() => { setState({ loopOn: !s.loopOn }); retime(); }}><I.ILoop /></button>
        <button className={'tb-btn' + (s.metronome ? ' lit' : '')} title="Metronome" aria-label="Metronome" onClick={() => setState({ metronome: !s.metronome })}><I.IMetro /></button>
        {!isPlugin && <Bpm />}
        <Position />
      </div>
      <div className="tb-group" role="radiogroup" aria-label="Tool">
        {tools.map(([k, label, icon, tip]) => (
          <button key={k} role="radio" aria-checked={s.edit === k} aria-label={label} className={'tb-btn' + (s.edit === k ? ' sel' : '')} title={`${label} · ${tip}`} onClick={() => setState({ edit: k })}>{icon}</button>
        ))}
      </div>
      <div className="tb-group" role="radiogroup" aria-label="Edit layer">
        {(['notes', 'pitch', 'pressure'] as Tool[]).map((t, i) => (
          <button key={t} role="radio" aria-checked={s.tool === t} className={'tb-text' + (s.tool === t ? ' sel' : '')} onClick={() => setTool(t)} title={`${t[0].toUpperCase() + t.slice(1)} (${i + 1})`}>
            {t[0].toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>
      <div className="tb-group">
        <button className={'tb-text icon' + (s.popup === 'quantize' ? ' sel' : '')} onClick={() => setState({ popup: s.popup === 'quantize' ? null : 'quantize', preview: null })} title="Quantize with a strength percentage"><I.IQuantize /> Quantize</button>
      </div>
      <div className="tb-group">
        <button className="tb-btn" disabled={!s.canUndo} onClick={undo} title="Undo (⌘Z)" aria-label="Undo"><I.IUndo /></button>
        <button className="tb-btn" disabled={!s.canRedo} onClick={redo} title="Redo (⇧⌘Z)" aria-label="Redo"><I.IRedo /></button>
        <ClipsMenu />
        <button className="tb-btn" onClick={createClip} title="New clip" aria-label="New clip"><I.IPlus /></button>
        <DeleteClip />
        <button className="tb-btn" onClick={onHelp} title="Shortcuts (?)" aria-label="Shortcuts"><I.IHelp /></button>
      </div>
      </div>
      <div className="out-tiles">
        <button className="drag-audio" draggable onDragStart={dragWav} onPointerDown={pointerDownWav} onPointerEnter={hoverWav}
          onClick={() => { if (isPlugin) return; flash('Rendering audio…'); saveWav().then(flash); }} title="Drag the audio (.wav) into your DAW, or click to save it">
          <I.IDragFile /><small>WAV</small>
        </button>
        <button className="export" draggable={!isPlugin} onDragStart={e => dragExport(e)} onPointerDown={e => {
          if (!isPlugin) return;
          const file = () => { const st = getState(); return [`${st.clip.name.replace(/[^\w\- ]+/g, '') || 'clip'}.mid`, toBase64(exportMidi(st.clip, st.exportFormat))] as const; };
          pressTile(e, () => bridge.dragFile(...file()), () => bridge.saveFile(...file()));
        }} onClick={() => { if (isPlugin) return; downloadMidi(s.clip, s.exportFormat).then(flash); }} title="Drag the MIDI into your DAW, or click to save it">
          <I.IDownload /><small>MIDI</small>
        </button>
      </div>
    </div>
  );
}

/** "Piano roll – <synth>": the synth, its bend range and export settings. */
function TitleMenu() {
  const s = {
    previewOn: useStore(st => st.previewOn), instrument: useStore(st => st.instrument),
    exportFormat: useStore(st => st.exportFormat), clip: { range: useStore(st => st.clip.range), pressureAs: useStore(st => st.clip.pressureAs) },
  };
  const name = s.instrument?.name ?? 'No synth';
  return (
    <div className="tb-title">
      <button className={'tb-btn' + (s.previewOn ? '' : ' muted')} title={s.previewOn ? 'Sound on' : 'Sound muted'} aria-label={s.previewOn ? 'Mute sound' : 'Unmute sound'} onClick={() => setState({ previewOn: !s.previewOn })}>{s.previewOn ? <I.ISpeaker /> : <I.IMute />}</button>
      {isPlugin && s.instrument?.kind === 'plugin' && (
        <button className="tb-btn" title={`Show ${name}'s window`} aria-label="Show synth window" onClick={() => bridge.openPluginEditor()}><I.IWindow /></button>
      )}
      <Dropdown className="tb-title-btn" chevron={false} label={<><span className="tt-main">{name}</span><span className="tri" aria-hidden="true">▸</span></>} title="Synth, pitch-bend range and export settings">
        {close => <>
          <div className="mlabel">Playing</div>
          <MenuItem selected onClick={close}><span>{name}{s.instrument?.kind === 'plugin' && <><br /><span style={{ fontSize: 11, color: 'var(--muted)' }}>{s.instrument.vendor} · {s.instrument.format}</span></>}</span></MenuItem>
          {s.instrument?.kind === 'plugin' && <MenuItem onClick={() => { bridge.openPluginEditor(); close(); }}>Open synth window</MenuItem>}
          <MenuItem onClick={() => { setState({ chooser: true }); close(); }}>Choose another synth…</MenuItem>
          <div className="sep" />
          <div className="mlabel">MPE pitch-bend range</div>
          <div className="chips">
            {RANGES.map(r => <button key={r} className={'chip' + (r === s.clip.range ? ' sel' : '')} onClick={() => { editClip(c => ({ ...c, range: r }), true); flash(`Range ±${r} · set your synth's bend range to match`); }}>±{r}</button>)}
          </div>
          <div className="mlabel">Pressure sends as</div>
          <div className="chips">
            {PRESSURE_AS.map(([k, l, d]) => <button key={k} title={d} className={'chip' + (k === (s.clip.pressureAs ?? 'pressure') ? ' sel' : '')} onClick={() => { editClip(c => ({ ...c, pressureAs: k }), true); flash(`Pressure sends as ${d} · map it in your synth if it doesn't respond`); }}>{l}</button>)}
          </div>
          <div className="sep" />
          <div className="mlabel">MIDI export format</div>
          {FORMATS.map(([k, l, d]) => (
            <MenuItem key={k} selected={k === s.exportFormat} onClick={() => setState({ exportFormat: k })}>
              <span>{l}<br /><span style={{ fontSize: 11, color: 'var(--muted)' }}>{d}</span></span>
            </MenuItem>
          ))}
        </>}
      </Dropdown>
    </div>
  );
}

function dragExport(e: React.DragEvent) {
  const s = getState();
  const bytes = exportMidi(s.clip, s.exportFormat);
  let bin = ''; bytes.forEach(b => { bin += String.fromCharCode(b); });
  const name = `${s.clip.name || 'clip'}.mid`;
  // Chrome supports dragging a file out of the page; the plugin build does a native file drag instead.
  e.dataTransfer.setData('DownloadURL', `audio/midi:${name}:data:audio/midi;base64,${btoa(bin)}`);
  e.dataTransfer.effectAllowed = 'copy';
}

function DeleteClip() {
  const [armed, setArmed] = useState(false);
  const name = useStore(s => s.clip.name);
  useEffect(() => { if (!armed) return; const t = setTimeout(() => setArmed(false), 2500); return () => clearTimeout(t); }, [armed]);
  return (
    <button className={'tb-btn' + (armed ? ' rec' : '')} aria-label="Delete clip" title={armed ? 'Click again to delete' : 'Delete clip'}
      onClick={() => { if (armed) { setArmed(false); deleteClip(); } else { setArmed(true); flash(`Click the bin again to delete “${name}”`); } }}><I.ITrash /></button>
  );
}

function Bpm() {
  const bpm = useStore(s => s.clip.bpm);
  const ref = useRef<{ y: number; b: number } | null>(null);
  return (
    <div className="bpm" title="Drag up/down or scroll to change tempo"
      onPointerDown={e => { (e.target as Element).setPointerCapture(e.pointerId); ref.current = { y: e.clientY, b: bpm }; checkpoint(); }}
      onPointerMove={e => { if (!ref.current) return; const nb = clamp(Math.round(ref.current.b + (ref.current.y - e.clientY) / 2), 30, 300); if (nb !== getState().clip.bpm) editClip(c => ({ ...c, bpm: nb })); }}
      onPointerUp={() => { ref.current = null; retime(); }}
      onWheel={e => { editClip(c => ({ ...c, bpm: clamp(c.bpm - Math.sign(e.deltaY), 30, 300) })); }}
>
      <b>{bpm}</b><small>{isPlugin ? 'HOST' : 'BPM'}</small>
    </div>
  );
}

function Position() {
  // written straight to the DOM each frame; no React render per frame
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    let raf = 0, last = '';
    const f = () => { const t = fmtPos(playheadBeat()); if (t !== last && ref.current) { ref.current.textContent = t; last = t; } raf = requestAnimationFrame(f); };
    raf = requestAnimationFrame(f);
    return () => cancelAnimationFrame(raf);
  }, []);
  return <span className="pos" ref={ref}>1.1</span>;
}

function ClipsMenu() {
  const clipId = useStore(s => s.clip.id);
  const ago = (t: number) => { const m = Math.round((Date.now() - t) / 60000); return m < 1 ? 'now' : m < 60 ? `${m}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`; };
  return (
    <div className="dd">
      <Dropdown className="tb-btn" chevron={false} label={<I.IFolder />} title="Recent clips">
        {close => {
          const list = listClips();
          return <>
            <div className="mlabel">Recent clips</div>
            {list.length === 0 && <div className="item" style={{ color: 'var(--muted)' }}>Nothing saved yet</div>}
            {list.map(c => <MenuItem key={c.id} selected={c.id === clipId} onClick={() => { openClip(c.id); close(); }}><span>{c.name}</span><span style={{ color: 'var(--muted)', fontSize: 11 }}>{ago(c.updated)}</span></MenuItem>)}
            <div className="sep" />
            <MenuItem onClick={() => { close(); openMidiFile(); }}>Import MIDI file…</MenuItem>
          </>;
        }}
      </Dropdown>
    </div>
  );
}

// ==================================================================== Inspector

const INSP_W = 260, INSP_BAR = 14;
const INSP_KEY = 'slide.inspector.open';

/**
 * Retractable side panel. Drag its left edge: let go past halfway and it snaps
 * shut to a thin bar; otherwise it springs back open. Click or drag the bar to
 * bring it back.
 */
function Inspector({ onWidth }: { onWidth: (w: number) => void }) {
  const [open, setOpen] = useState(() => { try { return localStorage.getItem(INSP_KEY) !== '0'; } catch { return true; } });
  const [dragW, setDragW] = useState<number | null>(null);
  const drag = useRef<{ x0: number; w0: number; moved: boolean } | null>(null);
  const width = dragW ?? (open ? INSP_W : INSP_BAR);
  useEffect(() => { onWidth(width); }, [width]);
  const save = (o: boolean) => { setOpen(o); try { localStorage.setItem(INSP_KEY, o ? '1' : '0'); } catch { /* ignore */ } };
  const down = (e: React.PointerEvent) => {
    (e.target as Element).setPointerCapture(e.pointerId);
    drag.current = { x0: e.clientX, w0: open ? INSP_W : INSP_BAR, moved: false };
  };
  const move = (e: React.PointerEvent) => {
    const d = drag.current; if (!d) return;
    if (Math.abs(e.clientX - d.x0) > 3) d.moved = true;
    if (d.moved) setDragW(clamp(d.w0 - (e.clientX - d.x0), INSP_BAR, INSP_W));
  };
  const up = () => {
    const d = drag.current; drag.current = null;
    if (!d) return;
    if (!d.moved) { save(!open); setDragW(null); return; } // a click toggles
    save((dragW ?? d.w0) >= INSP_W / 2);                   // past halfway snaps shut
    setDragW(null);
  };
  const tool = useStore(s => s.tool);
  const selection = useStore(s => s.selection);
  const notes = useStore(s => s.clip.notes);
  const sel = notes.filter(n => selection.includes(n.id));
  const mode = useStore(s => s.mode);
  const body = mode === 'play' ? <PlayPanel /> : !sel.length ? <EmptyInspector /> : tool === 'pressure' ? <PressureInspector sel={sel} /> : <PitchInspector sel={sel} />;
  return (
    <aside className={'insp-wrap' + (dragW === null ? ' anim' : '') + (open || dragW !== null ? '' : ' closed')} style={{ width }}>
      <div className="insp-handle" role="separator" aria-orientation="vertical" aria-label={open ? 'Drag right to hide the panel' : 'Show the panel'}
        title={open ? 'Drag right to hide · click to hide' : 'Click or drag to show the panel'}
        onPointerDown={down} onPointerMove={move} onPointerUp={up}>
        <span className="grip" />{!open && dragW === null && <span className="insp-chev" aria-hidden="true">‹</span>}
      </div>
      <div className="inspector" style={{ width: INSP_W }} aria-hidden={!open && dragW === null}>{body}</div>
    </aside>
  );
}

const mapSel = (fn: (n: Note) => Note, cp = true) => {
  const ids = new Set(getState().selection);
  editNotes(ns => ns.map(n => ids.has(n.id) ? fn(n) : n), cp);
};

function Head({ title, sel }: { title: string; sel: Note[] }) {
  const allMuted = sel.every(n => n.muted);
  return (
    <div className="insp-head">
      <h3>{title} <span>{sel.length} note{sel.length === 1 ? '' : 's'}</span></h3>
      <button className={'btn' + (allMuted ? ' active' : '')} onClick={() => mapSel(n => ({ ...n, muted: !allMuted }))}>Mute</button>
    </div>
  );
}

function VelocityRow({ sel }: { sel: Note[] }) {
  const avg = sel.reduce((a, n) => a + n.velocity, 0) / sel.length;
  return (
    <div className="section">
      <div className="label">Velocity <em>{Math.round(avg * 127)}</em></div>
      <SliderRow value={avg} display="" onStart={checkpoint} onChange={v => mapSel(n => ({ ...n, velocity: clamp(v, 0.01, 1) }), false)} />
    </div>
  );
}

function CurveRow({ lane }: { lane: 'bend' | 'pressure' }) {
  const kinds: Curve[] = ['smooth', 'linear', 'easeOut', 'easeIn', 'step'];
  return (
    <div className="section">
      <div className="label">Curve between selected points</div>
      <div className="curves">
        {kinds.map(k => <button key={k} title={k} onClick={() => { mapSel(n => ({ ...n, [lane]: (n[lane] as PathPoint[]).map(p => ({ ...p, c: k })) })); }}><I.ICurve kind={k} /></button>)}
      </div>
    </div>
  );
}

function PitchInspector({ sel }: { sel: Note[] }) {
  const drawMode = useStore(s => s.drawMode);
  const tune = useRef<{ orig: Map<string, PathPoint[]> } | null>(null);
  const [tuneAmt, setTuneAmt] = useState(0);
  useEffect(() => { setTuneAmt(0); tune.current = null; }, [sel.map(n => n.id).join()]);
  const apply = (f: (n: Note) => PathPoint[]) => mapSel(n => ({ ...n, bend: f(n) }));
  return <>
    <Head title="" sel={sel} />
    <VelocityRow sel={sel} />
    <div className="section">
      <div className="label">Pitch path</div>
      <div className="grid2">
        <button className="btn" onClick={() => apply(presetScoop)}>Scoop</button>
        <button className="btn" onClick={() => apply(presetFall)}>Fall</button>
        <button className="btn" onClick={() => apply(presetRise)}>Rise</button>
        <button className="btn" onClick={() => setState({ popup: 'vibrato' })}>Vibrato</button>
        <button className="btn" onClick={() => apply(n => presetHumanize(n))}>Humanize</button>
        <button className={'btn' + (drawMode ? ' active' : '')} onClick={() => setState({ tool: 'pitch', drawMode: !drawMode })}><I.IDraw /> Draw</button>
      </div>
    </div>
    <CurveRow lane="bend" />
    <div className="section">
      <div className="label">Tune to the nearest note</div>
      <SliderRow value={tuneAmt} display={`${Math.round(tuneAmt * 100)} %`}
        onStart={() => { checkpoint(); tune.current = { orig: new Map(sel.map(n => [n.id, n.bend])) }; }}
        onChange={v => {
          setTuneAmt(v);
          const o = tune.current?.orig; if (!o) return;
          mapSel(n => o.has(n.id) ? { ...n, bend: tuneToNearest({ ...n, bend: o.get(n.id)! }, v) } : n, false);
        }} />
    </div>
    <div className="section stack">
      <button className="btn block" onClick={() => apply(() => [])}>Clear pitch path</button>
      <button className="btn block" disabled={sel.length < 2} onClick={() => setState({ popup: 'connect' })}>Connect notes</button>
    </div>
    <WholeClip />
  </>;
}

function PressureInspector({ sel }: { sel: Note[] }) {
  const drawMode = useStore(s => s.drawMode);
  const bpm = useStore(s => s.clip.bpm);
  const [rate, setRate] = useState(6);
  const [depth, setDepth] = useState(0.6);
  const last = useRef<PressureShape | null>(null);
  const apply = (kind: PressureShape, r = rate, d = depth, cp = true) => {
    last.current = kind;
    mapSel(n => ({ ...n, pressure: pressurePreset(kind, { rate: r, depth: d, bpm, length: n.length }) }), cp);
  };
  return <>
    <Head title="Pressure" sel={sel} />
    <div className="section">
      <div className="label">Pressure shape</div>
      <div className="grid2">
        <button className="btn" onClick={() => apply('swell')}>Swell</button>
        <button className="btn" onClick={() => apply('build')}>Build</button>
        <button className="btn" onClick={() => apply('fade')}>Fade</button>
        <button className="btn" onClick={() => apply('tremolo')}>Tremolo</button>
        <button className="btn" onClick={() => apply('hold')}>Hold level</button>
        <button className={'btn' + (drawMode ? ' active' : '')} onClick={() => setState({ tool: 'pressure', drawMode: !drawMode })}><I.IDraw /> Draw</button>
      </div>
      <div style={{ marginTop: 8 }}><button className="btn block" onClick={() => setState({ popup: 'dynamics' })}>Dynamics…</button></div>
    </div>
    <CurveRow lane="pressure" />
    <div className="section">
      <div className="label">Tremolo rate <em>{rate.toFixed(1)} Hz</em></div>
      <SliderRow value={rate} min={1} max={16} display="" onStart={() => last.current === 'tremolo' && checkpoint()} onChange={v => { setRate(v); if (last.current === 'tremolo') apply('tremolo', v, depth, false); }} />
      <div className="label" style={{ marginTop: 14 }}>Tremolo depth <em>{depth.toFixed(2)}</em></div>
      <SliderRow value={depth} display="" onStart={() => last.current === 'tremolo' && checkpoint()} onChange={v => { setDepth(v); if (last.current === 'tremolo') apply('tremolo', rate, v, false); }} />
    </div>
    <div className="section">
      <button className="btn block" onClick={() => mapSel(n => ({ ...n, pressure: [] }))}>Clear pressure</button>
    </div>
  </>;
}

function EmptyInspector() {
  const name = useStore(s => s.clip.name);
  const range = useStore(s => s.clip.range);
  const tool = useStore(s => s.tool);
  return <>
    <div className="insp-head"><h3>Clip</h3></div>
    <div className="section">
      <div className="label">Name</div>
      <input className="clip-name" value={name} onChange={e => editClip(c => ({ ...c, name: e.target.value }))} />
    </div>
    <div className="section">
      <p className="empty-note">
        {tool === 'notes' && <>With the pencil, click to place a note. Drag edges to stretch, <kbd>⌥</kbd>-drag to duplicate, right-drag to erase, <kbd>⌘</kbd>-drag to select notes, <kbd>⌘⌥</kbd>-drag to draw a note freehand. Use <b>Control ▸</b> in the bottom panel for velocity, pan and more.</>}
        {tool === 'pitch' && <>Draw across a note to bend it. Dots snap to semitones; hold <kbd>⇧</kbd> for fine slides. Double-click a dot to remove it.</>}
        {tool === 'pressure' && <>Drag up or down from a note's centre to shape its pressure ribbon. Scroll a dot to widen it.</>}
      </p>
    </div>
    <div className="section">
      <div className="label">Range <em>±{range}</em></div>
      <p className="empty-note">Set your receiving synth's MPE pitch-bend range to ±{range}. Mismatch it and every glide plays at the wrong distance.</p>
    </div>
    <WholeClip />
  </>;
}

// ==================================================================== Popups

function usePreview(compute: () => Note[] | null, deps: unknown[]) {
  useEffect(() => {
    setState({ preview: compute() });
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => setState({ preview: null }), []);
}

function replaceSelected(withNotes: Note[]) {
  const ids = new Set(getState().selection);
  return [...getState().clip.notes.filter(n => !ids.has(n.id)), ...withNotes];
}

function ConnectPopup() {
  const g = useStore(s => s.glide);
  const set = (p: Partial<typeof g>) => setState(s => ({ glide: { ...s.glide, ...p } }));
  const bpm = useStore(s => s.clip.bpm);
  const sel = selectedNotes();
  const all = sel.length === getState().clip.notes.length;
  const playing = useStore(s => s.playing);
  const result = () => connectNotes(sel, g, bpm);
  usePreview(() => sel.length >= 2 ? replaceSelected(result()) : null, [g.glideMs, g.offsetMs, g.mode, g.target, g.style]);
  const commit = () => {
    const r = result();
    checkpoint();
    editNotes(() => replaceSelected(r));
    setState({ popup: null, preview: null, selection: r.map(n => n.id) });
    flash(g.style === 'keep' ? `Added glides between ${r.length} notes` : `Connected into ${r.length} gliding line${r.length === 1 ? '' : 's'}`);
  };
  return (
    <div className="popup">
      <h4>{g.style === 'keep' ? 'Connect notes' : 'Continuous Glide'} <small>{all ? 'all ' : ''}{sel.length} notes</small></h4>
      <div className="label">Style · switch to compare, nothing changes until you press Apply</div>
      <div className="seg">
        <button className={'btn' + (g.style === 'keep' ? ' active' : '')} onClick={() => set({ style: 'keep' })} title="Keep every note; glide into the next one, which plays again">Connect notes</button>
        <button className={'btn' + (g.style === 'continuous' ? ' active' : '')} onClick={() => set({ style: 'continuous' })} title="Merge each line into one gliding note">Continuous</button>
      </div>
      <button className={'btn block listen' + (playing ? ' active' : '')} onClick={() => togglePlay()} title="Play the clip with this glide (space)">
        {playing ? '■ Stop' : '▶ Listen'}
      </button>
      <div className="field">
        <div className="label">Glide length</div>
        <SliderRow value={g.glideMs} min={0} max={1000} onChange={v => set({ glideMs: Math.round(v) })} display={`${g.glideMs} ms`} />
      </div>
      <div className="field">
        <div className="label">Offset</div>
        <SliderRow value={g.offsetMs} min={-250} max={250} onChange={v => set({ offsetMs: Math.round(v) })} display={`${g.offsetMs > 0 ? '+' : g.offsetMs < 0 ? '−' : ''}${Math.abs(g.offsetMs)} ms`} />
      </div>
      <div className="label">Mode</div>
      <div className="seg">
        <button className={'btn' + (g.mode === 'time' ? ' active' : '')} onClick={() => set({ mode: 'time' })}>Time</button>
        <button className={'btn' + (g.mode === 'distance' ? ' active' : '')} onClick={() => set({ mode: 'distance' })}>Distance</button>
      </div>
      <div className="label">Glide to</div>
      <div className="seg">
        <button className={'btn' + (g.target === 'nearest' ? ' active' : '')} onClick={() => set({ target: 'nearest' })} title="Each line moves to the closest note of the next chord; lines never cross and each note is used once">Nearest note</button>
        <button className={'btn' + (g.target === 'written' ? ' active' : '')} onClick={() => set({ target: 'written' })} title="Top note to top note, second to second, and so on">By order</button>
      </div>
      <div className="actions">
        <button className="btn" onClick={() => setState({ popup: null, preview: null })}>Cancel</button>
        <button className="btn primary" onClick={commit}>Apply</button>
      </div>
    </div>
  );
}

/** Open the Connect popup on the whole clip. */
function glideAll(style: 'keep' | 'continuous') {
  const s = getState();
  if (s.clip.notes.length < 2) { flash('Add or import at least two notes first'); return; }
  setState(st => ({ selection: st.clip.notes.map(n => n.id), glide: { ...st.glide, style }, popup: 'connect' }));
}

function WholeClip() {
  return (
    <div className="section stack">
      <div className="label" style={{ marginBottom: 0 }}>Whole clip</div>
      <button className="btn block" onClick={() => glideAll('keep')} title="Keep every note and chord; each note glides into the next one, which plays again">Connect all notes</button>
      <button className="btn block" onClick={() => glideAll('continuous')} title="Merge every line into one continuous gliding note">Continuous Glide</button>
      <button className="btn block" onClick={openMidiFile}>Import MIDI…</button>
    </div>
  );
}

function QuantizePopup() {
  const snap = useStore(s => s.snap);
  const [grid, setGrid] = useState(() => QGRIDS.find(g => Math.abs(g[1] - snap) < 1e-6)?.[1] ?? 0.25);
  const [strength, setStrength] = useState(1);
  const [ends, setEnds] = useState(false);
  const sel = selectedNotes();
  const target = sel.length ? sel : getState().clip.notes;
  const ids = new Set(target.map(n => n.id));
  const result = () => {
    const q = new Map(quantize(target, grid, strength, ends).map(n => [n.id, n]));
    return getState().clip.notes.map(n => q.get(n.id) ?? n);
  };
  usePreview(() => target.length ? result() : null, [grid, strength, ends]);
  return (
    <div className="popup">
      <h4>Quantize <small>{sel.length ? `${sel.length} selected` : `all ${ids.size}`} notes</small></h4>
      <div className="label">Grid</div>
      <div className="chips wide">
        {QGRIDS.map(([l, b]) => <button key={l} className={'chip' + (Math.abs(b - grid) < 1e-6 ? ' sel' : '')} onClick={() => setGrid(b)}>{l}</button>)}
      </div>
      <div className="field" style={{ marginTop: 14 }}>
        <div className="label">Strength</div>
        <SliderRow value={strength} onChange={v => setStrength(Math.round(v * 100) / 100)} display={`${Math.round(strength * 100)} %`} />
      </div>
      <div className="seg">
        <button className={'btn' + (!ends ? ' active' : '')} onClick={() => setEnds(false)}>Starts</button>
        <button className={'btn' + (ends ? ' active' : '')} onClick={() => setEnds(true)}>Starts and ends</button>
      </div>
      <div className="actions">
        <button className="btn" onClick={() => setState({ popup: null, preview: null })}>Cancel</button>
        <button className="btn primary" onClick={() => { const r = result(); checkpoint(); editNotes(() => r); setState({ popup: null, preview: null }); flash(`Quantized ${ids.size} notes to ${QGRIDS.find(g => g[1] === grid)?.[0]} at ${Math.round(strength * 100)}%`); }}>Apply</button>
      </div>
    </div>
  );
}

function CurveEditor({ pts, onChange, color = '#e8552f' }: { pts: PathPoint[]; onChange: (p: PathPoint[]) => void; color?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const dragI = useRef(-1);
  useEffect(() => {
    const c = ref.current!; const r = c.getBoundingClientRect(); const dpr = devicePixelRatio || 1;
    c.width = r.width * dpr; c.height = r.height * dpr;
    const g = c.getContext('2d')!; g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const W = r.width, H = r.height, pad = 8;
    const X = (t: number) => pad + t * (W - 2 * pad), Y = (v: number) => H - pad - v * (H - 2 * pad);
    g.clearRect(0, 0, W, H);
    g.beginPath(); for (let i = 0; i <= 100; i++) { const t = i / 100; const y = Y(evalPath(pts, t, 0)); i ? g.lineTo(X(t), y) : g.moveTo(X(t), y); }
    g.strokeStyle = color; g.lineWidth = 2; g.stroke();
    g.lineTo(X(1), H - pad); g.lineTo(X(0), H - pad); g.closePath(); g.fillStyle = 'rgba(232,85,47,0.12)'; g.fill();
    pts.forEach(p => { g.beginPath(); g.arc(X(p.t), Y(p.v), 4, 0, 7); g.fillStyle = '#fff'; g.fill(); g.strokeStyle = color; g.lineWidth = 1.6; g.stroke(); });
  });
  const pos = (e: React.PointerEvent | React.MouseEvent) => {
    const r = ref.current!.getBoundingClientRect(); const pad = 8;
    return { t: clamp((e.clientX - r.left - pad) / (r.width - 2 * pad), 0, 1), v: clamp(1 - (e.clientY - r.top - pad) / (r.height - 2 * pad), 0, 1), r };
  };
  const find = (e: React.PointerEvent | React.MouseEvent) => {
    const { r } = pos(e); const pad = 8;
    return pts.findIndex(p => Math.hypot(pad + p.t * (r.width - 2 * pad) - (e.clientX - r.left), r.height - pad - p.v * (r.height - 2 * pad) - (e.clientY - r.top)) < 8);
  };
  return (
    <div className="curve-ed">
      <canvas ref={ref}
        onPointerDown={e => {
          (e.target as Element).setPointerCapture(e.pointerId);
          const i = find(e);
          if (i >= 0) { dragI.current = i; return; }
          const { t, v } = pos(e);
          const np = [...pts, { t, v, c: 'smooth' as Curve }].sort((a, b) => a.t - b.t);
          dragI.current = np.findIndex(p => p.t === t);
          onChange(np);
        }}
        onPointerMove={e => {
          if (dragI.current < 0) return;
          const { t, v } = pos(e); const i = dragI.current;
          const np = [...pts];
          const lo = i === 0 ? 0 : np[i - 1].t + 0.01, hi = i === np.length - 1 ? 1 : np[i + 1].t - 0.01;
          np[i] = { ...np[i], t: (i === 0 || i === np.length - 1) ? np[i].t : clamp(t, lo, hi), v };
          onChange(np);
        }}
        onPointerUp={() => { dragI.current = -1; }}
        onDoubleClick={e => { const i = find(e); if (i > 0 && i < pts.length - 1) onChange(pts.filter((_, k) => k !== i)); }}
        onContextMenu={e => { e.preventDefault(); const i = find(e); if (i >= 0) { const np = [...pts]; np[i] = { ...np[i], v: 0.5 }; onChange(np); } }}
      />
    </div>
  );
}

function VibratoPopup() {
  const [rate, setRate] = useState<PathPoint[]>([{ t: 0, v: 0.12, c: 'smooth' }, { t: 0.55, v: 0.22, c: 'smooth' }, { t: 1, v: 0.12 }]);
  const [depth, setDepth] = useState<PathPoint[]>([{ t: 0, v: 0, c: 'smooth' }, { t: 0.7, v: 0.55, c: 'smooth' }, { t: 1, v: 0.35 }]);
  const bpm = useStore(s => s.clip.bpm);
  const sel = selectedNotes();
  const result = () => sel.map(n => ({ ...n, bend: applyVibrato(n, rate, depth, bpm) }));
  usePreview(() => replaceSelected(result()), [rate, depth]);
  const maxRate = 3 + 21 * Math.max(...rate.map(p => p.v));
  const maxDepth = Math.max(...depth.map(p => p.v));
  return (
    <div className="popup">
      <h4>Vibrato <small>{sel.length} note{sel.length === 1 ? '' : 's'}</small></h4>
      <div className="field">
        <div className="label">Rate <em>3 to 24 Hz · peak {maxRate.toFixed(1)}</em></div>
        <CurveEditor pts={rate} onChange={setRate} />
      </div>
      <div className="field">
        <div className="label">Depth <em>up to 1.00 st · peak {maxDepth.toFixed(2)}</em></div>
        <CurveEditor pts={depth} onChange={setDepth} />
      </div>
      <p className="hint">Click to add, drag to move, double-click removes, right-click resets a point.</p>
      <div className="actions">
        <button className="btn" onClick={() => setState({ popup: null, preview: null })}>Cancel</button>
        <button className="btn primary" onClick={() => { const r = result(); checkpoint(); editNotes(() => replaceSelected(r)); setState({ popup: null, preview: null }); }}>Apply</button>
      </div>
    </div>
  );
}

function DynamicsPopup() {
  const [peak, setPeak] = useState(0.85);
  const [bottom, setBottom] = useState(0.3);
  const [unison, setUnison] = useState(1);
  const [swell, setSwell] = useState(4);
  const sel = selectedNotes().sort((a, b) => b.pitch - a.pitch);
  const result = () => applyDynamics(sel, { peak, bottom, unison, swellBeats: swell });
  usePreview(() => replaceSelected(result()), [peak, bottom, unison, swell]);
  return (
    <div className="popup">
      <h4>Dynamics <small>{sel.length} note{sel.length === 1 ? '' : 's'}</small></h4>
      <div className="field"><div className="label">Peak</div><SliderRow value={peak} onChange={setPeak} display={`${Math.round(peak * 100)} %`} /></div>
      <div className="field"><div className="label">Bottom</div><SliderRow value={bottom} onChange={setBottom} display={`${Math.round(bottom * 100)} %`} /></div>
      <div className="field"><div className="label">Unison</div><SliderRow value={unison} onChange={setUnison} display={`${Math.round(unison * 100)} %`} /></div>
      <div className="field"><div className="label">Swell length</div><SliderRow value={swell} min={0.5} max={16} onChange={v => setSwell(Math.round(v * 2) / 2)} display={`${swell.toFixed(1)} beats`} /></div>
      <div className="actions">
        <button className="btn" onClick={() => setState({ popup: null, preview: null })}>Cancel</button>
        <button className="btn primary" onClick={() => { const r = result(); checkpoint(); editNotes(() => replaceSelected(r)); setState({ popup: null, preview: null }); }}>Apply</button>
      </div>
    </div>
  );
}

// ==================================================================== Footer + help

function ModeSwitch() {
  const mode = useStore(s => s.mode);
  return (
    <div className="mode-switch" role="tablist" aria-label="Mode">
      <button role="tab" aria-selected={mode === 'play'} className={mode === 'play' ? 'on play' : ''} onClick={() => setState({ mode: 'play', popup: null, preview: null })} title="Playing Mode: hold chords and glide between them">Play</button>
      <button role="tab" aria-selected={mode === 'edit'} className={mode === 'edit' ? 'on' : ''} onClick={() => setState({ mode: 'edit' })} title="Editing Mode: the piano roll">Edit</button>
    </div>
  );
}

/** Bottom-right corner: drag to make the plug-in window bigger or smaller. */
function ResizeGrip() {
  const onDown = (e: React.PointerEvent) => {
    e.preventDefault();
    const sx = e.screenX, sy = e.screenY, w0 = window.innerWidth, h0 = window.innerHeight;
    let raf = 0, last = { w: w0, h: h0 };
    const move = (m: PointerEvent) => {
      last = { w: Math.round(w0 + m.screenX - sx), h: Math.round(h0 + m.screenY - sy) };
      if (!raf) raf = requestAnimationFrame(() => { raf = 0; bridge.resizeWindow(last.w, last.h); });
    };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); bridge.resizeWindow(last.w, last.h); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  return <div className="resize-grip" onPointerDown={onDown} title="Drag to resize" aria-label="Resize window"><I.IGrip /></div>;
}

function Footer() {
  const tool = useStore(s => s.tool);
  const hint = useStore(s => s.hint);
  const drawMode = useStore(s => s.drawMode);
  const edit = useStore(s => s.edit);
  const tips: Record<Tool, string> = {
    notes: edit === 'draw' ? 'Click to place a note  ·  drag to move  ·  ⌥-drag duplicates  ·  right-drag erases  ·  double-click a note to bend it'
      : edit === 'move' ? 'Hand  ·  drag notes to move them  ·  drag empty space to scroll  ·  double-click a note to snap it to the grid'
      : edit === 'select' ? 'Drag to select  ·  drag notes to move  ·  double-click adds a note'
      : 'Drag a line across notes to slice them at the grid',
    pitch: drawMode ? 'Pencil  ·  draw freely across a note  ·  every wobble is kept' : 'Draw across a note to bend it  ·  dots snap to semitones  ·  ⇧ for fine  ·  double-click a dot removes it',
    pressure: 'Drag from a note’s centre to shape pressure  ·  scroll a dot to widen  ·  double-click removes',
  };
  return (
    <div className="footer">
      <span className={hint ? 'flash' : ''}>{hint ?? tips[tool]}</span>
      <span>{isPlugin ? 'SLIDE' : 'SLIDE · preview build'}</span>
      {isPlugin && <ResizeGrip />}
    </div>
  );
}

function Help({ onClose }: { onClose: () => void }) {
  const rows: [string, string][] = [
    ['P  H  E  C', 'Draw, Hand, Select and Slice tools'], ['Double-click (Hand)', 'Snap the note to the grid'], ['Click (Draw)', 'Add a note'], ['Double-click', 'Add a note (any tool)'], ['⌘ + drag', 'Select notes with a box (any tool)'], ['⌘⌥ + drag', 'Draw a note freehand'], ['Drag edges', 'Move / stretch (⌘ = no snap)'],
    ['⌥ + drag', 'Duplicate the selection'], ['Right-drag', 'Erase notes'], ['Double-click a note', 'Edit its pitch path'],
    ['Drag a dot', 'Refine, snaps to semitones (⇧ = fine)'], ['Connect', 'Merge 2+ notes into one glide'], ['⌥ + scroll', 'Velocity on a note'],
    ['⌘ + scroll', 'Zoom (or pinch); the grid and snap follow the zoom'], ['Ruler drag', 'Set the loop region'], ['Space', 'Play / stop'],
    ['1  2  3', 'Notes / Pitch / Pressure'], ['Drag the panel edge', 'Resize the bottom panel'], ['Control ▸', 'Pick velocity, pan, release… or a channel lane'], ['B', 'Toggle Notes and Pitch'], ['D', 'Free-draw pitch & vibrato'],
    ['Arrows', 'Transpose; ⇧ + arrows nudge'], ['⌘ Z / D / C / V', 'Undo, duplicate, copy, paste'],
  ];
  return (
    <div className="help-back" onClick={onClose}>
      <div className="help" onClick={e => e.stopPropagation()}>
        <h2>Shortcuts</h2>
        <table><tbody>{rows.map(([k, d]) => <tr key={k}><td><kbd>{k}</kbd></td><td>{d}</td></tr>)}</tbody></table>
      </div>
    </div>
  );
}
