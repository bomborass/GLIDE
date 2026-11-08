import { useSyncExternalStore } from 'react';
import { Clip, Note, newClip, makeNote, PathPoint, ensureLanes, connectNotes } from './model';
import { bridge, isPlugin } from './bridge';

/** What a drag edits: note bodies, pitch paths or pressure ribbons. */
export type Tool = 'notes' | 'pitch' | 'pressure';
/** How the pointer behaves on notes. */
export type EditTool = 'draw' | 'move' | 'select' | 'slice';
export type PopupKind = null | 'connect' | 'vibrato' | 'dynamics' | 'quantize';
export type ExportFormat = 'mpe' | 'ableton' | 'cubase' | 'mono';
export type SynthPreset = 'Glass Saw' | 'Soft Square' | 'Warm Pad' | 'Pure Sine';

/** What SLIDE plays: a built-in preview voice, or a hosted AU/VST3 synth. */
export type Instrument =
  | { kind: 'builtin'; name: SynthPreset }
  | { kind: 'plugin'; id: string; name: string; vendor: string; format: 'VST3' | 'AU' };

const INSTRUMENT = 'mpe4free.instrument.v1';
function loadInstrument(): Instrument | null {
  try { return JSON.parse(localStorage.getItem(INSTRUMENT) || 'null'); } catch { return null; }
}
export function chooseInstrument(inst: Instrument) {
  try { localStorage.setItem(INSTRUMENT, JSON.stringify(inst)); } catch { /* ignore */ }
  setState(inst.kind === 'builtin' ? { instrument: inst, synth: inst.name, chooser: false } : { instrument: inst, chooser: false });
  if (inst.kind === 'builtin') bridge.useBuiltin(inst.name);
}

export interface State {
  instrument: Instrument | null;
  chooser: boolean;        // the "choose a synth" overlay
  clip: Clip;
  tool: Tool;
  edit: EditTool;
  panelH: number;          // bottom panel height in px
  lane: string;            // bottom panel lane: a NoteProp or a channel lane id
  drawMode: boolean;
  snap: number;            // beats; follows the visible grid
  selection: string[];
  selRange: [number, number] | null;  // highlighted time range of a box selection (beats)
  preview: Note[] | null;  // live preview while a popup is open
  playing: boolean;
  recording: boolean;
  metronome: boolean;
  loopOn: boolean;
  follow: boolean;
  previewOn: boolean;
  synth: SynthPreset;
  exportFormat: ExportFormat;
  popup: PopupKind;
  glide: { glideMs: number; offsetMs: number; mode: 'time' | 'distance'; target: 'written' | 'nearest'; style: 'continuous' | 'keep' };
  hint: string | null;     // toast line in the footer
  canUndo: boolean;
  canRedo: boolean;
}

const STORAGE = 'mpe4free.clips.v1';
const CURRENT = 'mpe4free.current.v1';

export interface SavedClip { id: string; name: string; updated: number; clip: Clip }

function loadAll(): SavedClip[] {
  try { return JSON.parse(localStorage.getItem(STORAGE) || '[]'); } catch { return []; }
}
function saveAll(list: SavedClip[]) {
  try { localStorage.setItem(STORAGE, JSON.stringify(list.slice(0, 40))); } catch { /* storage unavailable */ }
}

// The World Is Yours (Nas, sampling Ahmad Jamal): Cm(add9) · Bm(maj7) · Bm6 · Cm9 · Dm9 · Fm9,
// with the voicings read from the lesson video. Every note glides into the
// nearest note of the next chord, which then strikes again ("Connect all notes").
const DEMO_FLAG = 'slide.demo.twiy.v1';
function demoClip(): Clip {
  const c = newClip('The World Is Yours');
  c.bpm = 84;
  const loop: [number, number[]][] = [
    [2, [48, 55, 62, 63, 67, 74]],          // Cm(add9)
    [1, [47, 54, 58, 62, 66, 70, 74]],      // Bm(maj7)
    [1, [47, 54, 56, 62, 66, 68, 74]],      // Bm6
    [1, [48, 55, 58, 63, 67, 74]],          // Cm9
    [1, [50, 57, 60, 65, 69, 76]],          // Dm9
    [2, [48, 51, 53, 56, 60, 72, 75, 77, 79]], // Fm9
  ];
  const notes: Note[] = [];
  let t = 0;
  for (let rep = 0; rep < 4; rep++) for (const [len, ch] of loop) {
    ch.forEach((p, i) => notes.push(makeNote(p, t, len, i === 0 ? 0.82 : 0.68)));
    t += len;
  }
  c.notes = connectNotes(notes, { glideMs: 325, offsetMs: -30, mode: 'time', target: 'nearest', style: 'keep' }, c.bpm);
  c.bars = Math.ceil(t / 4); c.loop = [0, t];
  return c;
}

function initialClip(): Clip {
  try {
    // show the demo once, also to people who already have clips saved
    if (!localStorage.getItem(DEMO_FLAG)) {
      localStorage.setItem(DEMO_FLAG, '1');
      const d = ensureLanes(demoClip());
      saveAll([{ id: d.id, name: d.name, updated: Date.now(), clip: d }, ...loadAll()]);
      localStorage.setItem(CURRENT, d.id);
      return d;
    }
    const cur = localStorage.getItem(CURRENT);
    const found = loadAll().find(s => s.id === cur);
    if (found) return ensureLanes(found.clip);
  } catch { /* ignore */ }
  return demoClip();
}

// in the plugin the project's saved state (sent by C++ on load) decides the instrument
const savedInstrument = isPlugin ? null : loadInstrument();
let state: State = {
  instrument: savedInstrument,
  chooser: !isPlugin && !savedInstrument,
  clip: fitBars(initialClip()),
  tool: 'notes',
  drawMode: false,
  snap: 0.25,
  selection: [],
  selRange: null,
  preview: null,
  playing: false,
  recording: false,
  metronome: false,
  loopOn: true,
  follow: false,
  previewOn: true,
  synth: savedInstrument?.kind === 'builtin' ? savedInstrument.name : 'Glass Saw',
  exportFormat: 'mpe',
  popup: null,
  edit: 'draw',
  panelH: 150,
  lane: 'velocity',
  glide: { glideMs: 325, offsetMs: -30, mode: 'time', target: 'nearest', style: 'continuous' },
  hint: null,
  canUndo: false,
  canRedo: false,
};

const listeners = new Set<() => void>();
export const getState = () => state;
export function setState(p: Partial<State> | ((s: State) => Partial<State>)) {
  const patch = typeof p === 'function' ? p(state) : p;
  state = { ...state, ...patch };
  listeners.forEach(l => l());
}
export function useStore<T>(sel: (s: State) => T): T {
  return useSyncExternalStore(cb => { listeners.add(cb); return () => listeners.delete(cb); }, () => sel(state));
}
export const subscribe = (cb: () => void) => { listeners.add(cb); return () => { listeners.delete(cb); }; };

// ---------------------------------------------------------------- undo

const undoStack: string[] = [];
const redoStack: string[] = [];

/** Snapshot the clip before an edit. Call once at the start of a drag. */
export function checkpoint() {
  undoStack.push(JSON.stringify(state.clip));
  if (undoStack.length > 200) undoStack.shift();
  redoStack.length = 0;
  setState({ canUndo: true, canRedo: false });
}
export function undo() {
  const prev = undoStack.pop(); if (!prev) return;
  redoStack.push(JSON.stringify(state.clip));
  setState({ clip: JSON.parse(prev), canUndo: undoStack.length > 0, canRedo: true, preview: null });
}
export function redo() {
  const nxt = redoStack.pop(); if (!nxt) return;
  undoStack.push(JSON.stringify(state.clip));
  setState({ clip: JSON.parse(nxt), canUndo: true, canRedo: redoStack.length > 0 });
}

/** Mutate the clip. Pass checkpoint=true for one-shot edits. */
export function editClip(fn: (c: Clip) => Clip, cp = false) {
  if (cp) checkpoint();
  setState({ clip: fn(state.clip) });
}
export function editNotes(fn: (notes: Note[]) => Note[], cp = false) {
  editClip(c => ({ ...c, notes: fn(c.notes) }), cp);
}
export function updateNote(id: string, fn: (n: Note) => Note) {
  editNotes(ns => ns.map(n => n.id === id ? fn(n) : n));
}
export function setBend(id: string, bend: PathPoint[]) { updateNote(id, n => ({ ...n, bend })); }
export function setPressure(id: string, pressure: PathPoint[]) { updateNote(id, n => ({ ...n, pressure })); }

export const selectedNotes = () => {
  const s = new Set(state.selection);
  return state.clip.notes.filter(n => s.has(n.id));
};
/** Notes as they should be drawn and played (popup preview wins). */
export const visibleNotes = () => state.preview ?? state.clip.notes;

export function flash(hint: string) {
  setState({ hint });
  clearTimeout((flash as any).t);
  (flash as any).t = setTimeout(() => setState({ hint: null }), 2200);
}

// ---------------------------------------------------------------- clips + autosave

export function listClips(): SavedClip[] {
  const list = loadAll().filter(c => c.id !== state.clip.id).sort((a, b) => b.updated - a.updated);
  // the open clip is always listed, even before its first auto-save
  return [{ id: state.clip.id, name: state.clip.name, updated: Date.now(), clip: state.clip }, ...list];
}

let saveTimer: any = null;
let lastClipRef: Clip | null = null;
const deleted = new Set<string>();
function persist(c: Clip) {
  if (deleted.has(c.id)) return;
  const list = loadAll().filter(s => s.id !== c.id);
  list.unshift({ id: c.id, name: c.name, updated: Date.now(), clip: c });
  saveAll(list);
}
/** Clip length follows the notes: whole bars, at least one. */
function fitBars(c: Clip): Clip {
  const end = c.notes.reduce((m, n) => Math.max(m, n.start + n.length), 0);
  const bars = Math.max(1, Math.ceil(end / 4 - 1e-6));
  if (bars === c.bars) return c;
  const len = bars * 4;
  return { ...c, bars, loop: [0, len] };
}

subscribe(() => {
  if (state.clip !== lastClipRef) {
    const fitted = fitBars(state.clip);
    if (fitted !== state.clip) { state = { ...state, clip: fitted }; }
  }
  if (state.clip === lastClipRef) return;
  const prev = lastClipRef;
  lastClipRef = state.clip;
  bridge.clipChanged(state.clip);
  // switching clips: save the one being left right away if it had unsaved edits
  if (prev && prev.id !== state.clip.id && saveTimer) persist(prev);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    persist(state.clip);
    try { localStorage.setItem(CURRENT, state.clip.id); } catch { /* ignore */ }
  }, 400);
});

export function openClip(id: string) {
  const found = loadAll().find(s => s.id === id);
  if (!found) return;
  undoStack.length = 0; redoStack.length = 0;
  setState({ clip: ensureLanes(found.clip), selection: [], popup: null, canUndo: false, canRedo: false });
}
export function createClip() {
  const n = loadAll().length + 1;
  undoStack.length = 0; redoStack.length = 0;
  const c = newClip(`Clip ${n}`);
  c.bpm = state.clip.bpm; c.range = state.clip.range;
  setState({ clip: c, selection: [], popup: null, canUndo: false, canRedo: false });
  flash(`New clip: ${c.name}`);
}
export function deleteClip() {
  const id = state.clip.id;
  deleted.add(id);
  saveAll(loadAll().filter(s => s.id !== id));
  const rest = loadAll().filter(s => s.id !== id).sort((a, b) => b.updated - a.updated);
  undoStack.length = 0; redoStack.length = 0;
  if (rest.length) setState({ clip: rest[0].clip, selection: [], canUndo: false, canRedo: false });
  else setState({ clip: newClip('Clip 1'), selection: [], canUndo: false, canRedo: false });
  flash('Clip deleted');
}

/** Open an imported clip as a new clip (the previous one stays in the clip list). */
export function importClip(c: Clip) {
  undoStack.length = 0; redoStack.length = 0;
  setState({ clip: ensureLanes(c), selection: [], popup: null, preview: null, canUndo: false, canRedo: false });
}

// Plugin build: restore the clip and instrument saved in the FL project.
if (isPlugin) {
  bridge.onInit(p => {
    if (p.clip && Array.isArray(p.clip.notes)) {
      undoStack.length = 0; redoStack.length = 0;
      setState({ clip: fitBars(ensureLanes(p.clip)), selection: [], canUndo: false, canRedo: false });
    }
    const inst = p.instrument as Instrument | null | undefined;
    if (inst) setState(inst.kind === 'builtin' ? { instrument: inst, synth: inst.name, chooser: false } : { instrument: inst, chooser: false });
    else setState({ chooser: true });
  });
  setTimeout(() => bridge.uiReady(), 0);
}
