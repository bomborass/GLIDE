// Core data model for SLIDE. Pure functions only: this file is mirrored by
// the C++ engine later (same JSON shape), so keep it serialisable.

export type Curve = 'smooth' | 'linear' | 'easeIn' | 'easeOut' | 'step';

/** A point on a per-note lane. t is 0..1 across the note's length. */
export interface PathPoint { t: number; v: number; c?: Curve }

export interface Note {
  id: string;
  pitch: number;      // MIDI note number
  start: number;      // beats
  length: number;     // beats
  velocity: number;   // 0..1
  muted?: boolean;
  bend: PathPoint[];      // v = semitone offset from pitch
  pressure: PathPoint[];  // v = 0..1 channel pressure
  // per-note properties (bottom panel); absent = default
  pan?: number;        // -1 left .. 1 right
  release?: number;    // note-off velocity 0..1
  cutoff?: number;     // MPE timbre (CC74 on the note's channel) 0..1
  resonance?: number;  // CC71 on the note's channel 0..1
  fine?: number;       // fine pitch, -1..1 semitone
  repeat?: number;     // re-strikes per note (1 = off)
}

export interface CCPoint { beat: number; v: number; c?: Curve }
/**
 * A clip-wide channel lane on the MPE master channel. 'cc' lanes send a
 * controller, 'pitch' sends master-channel pitch bend, 'param' lanes are a
 * hosted synth's own knob, recorded in the plugin build.
 */
export interface CCLane { cc: number; points: CCPoint[]; kind?: 'cc' | 'pitch' | 'param'; name?: string; param?: string }

export interface Clip {
  id: string;
  name: string;
  bars: number;
  bpm: number;
  range: number;           // MPE pitch-bend range in semitones
  loop: [number, number];  // beats
  notes: Note[];
  cc: CCLane[];
}

export const BEATS_PER_BAR = 4;
export const DEFAULT_PRESSURE = 0.55;

let idCounter = 0;
export const uid = () => Date.now().toString(36) + (idCounter++).toString(36) + Math.random().toString(36).slice(2, 6);

const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const noteName = (p: number) => NAMES[((Math.round(p) % 12) + 12) % 12] + (Math.floor(Math.round(p) / 12) - 2);
export const isBlack = (p: number) => [1, 3, 6, 8, 10].includes(((p % 12) + 12) % 12);
export const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));

export function newClip(name = 'Untitled'): Clip {
  return ensureLanes({ id: uid(), name, bars: 8, bpm: 120, range: 48, loop: [0, 8 * BEATS_PER_BAR], notes: [], cc: [] });
}

// ---------------------------------------------------------------- lanes

export const laneId = (l: CCLane) => l.kind === 'pitch' ? 'pitch' : l.kind === 'param' ? 'p:' + l.param : 'cc' + l.cc;
const CC_NAMES: Record<number, string> = { 1: 'Modulation', 2: 'Breath', 7: 'Volume', 10: 'Panning', 11: 'Expression', 64: 'Sustain', 71: 'Resonance', 74: 'Brightness' };
export const laneName = (l: CCLane) => l.name ?? (l.kind === 'pitch' ? 'Channel pitch' : l.cc === 10 ? 'Channel panning' : l.cc === 7 ? 'Channel volume' : `${CC_NAMES[l.cc] ?? 'Controller'} (CC${l.cc})`);
/** Lanes drawn around a centre line. */
export const laneBipolar = (l: CCLane) => l.kind === 'pitch' || (l.kind !== 'param' && l.cc === 10);
/** Value used where a lane has no points. */
export const laneDefault = (l: CCLane) => l.kind === 'pitch' || l.cc === 10 ? 0.5 : l.cc === 7 ? 100 / 127 : 0;
export const MASTER_BEND_RANGE = 2; // semitones, master-channel pitch bend

/** Make sure the standard channel lanes exist (older clips predate some). */
export function ensureLanes(c: Clip): Clip {
  const want: CCLane[] = [{ cc: 10, points: [] }, { cc: 7, points: [] }, { cc: 0, points: [], kind: 'pitch' }, { cc: 74, points: [] }, { cc: 1, points: [] }, { cc: 11, points: [] }];
  const have = new Map(c.cc.map(l => [laneId(l), l]));
  const lanes = want.map(w => have.get(laneId(w)) ?? w);
  const ids = new Set(lanes.map(laneId));
  for (const l of c.cc) if (!ids.has(laneId(l))) lanes.push(l);
  return { ...c, cc: lanes };
}

/** Per-note properties shown in the bottom panel. Values are normalised 0..1 for drawing. */
export type NoteProp = 'velocity' | 'pan' | 'release' | 'cutoff' | 'resonance' | 'fine' | 'repeat';
export const REPEATS = [1, 2, 3, 4, 6, 8, 12, 16];
export const NOTE_PROPS: { key: NoteProp; label: string; bipolar: boolean }[] = [
  { key: 'pan', label: 'Note pan', bipolar: true },
  { key: 'velocity', label: 'Note velocity', bipolar: false },
  { key: 'release', label: 'Note release', bipolar: false },
  { key: 'cutoff', label: 'Note filter cutoff frequency', bipolar: false },
  { key: 'resonance', label: 'Note filter resonance (Q)', bipolar: false },
  { key: 'fine', label: 'Note fine pitch', bipolar: true },
  { key: 'repeat', label: 'Note repeat', bipolar: false },
];
export function getProp(n: Note, k: NoteProp): number {
  switch (k) {
    case 'velocity': return n.velocity;
    case 'pan': return ((n.pan ?? 0) + 1) / 2;
    case 'fine': return ((n.fine ?? 0) + 1) / 2;
    case 'repeat': return Math.max(0, REPEATS.indexOf(n.repeat ?? 1)) / (REPEATS.length - 1);
    default: return n[k] ?? 0.5;
  }
}
export function setProp(n: Note, k: NoteProp, v: number): Note {
  v = clamp(v, 0, 1);
  switch (k) {
    case 'velocity': return { ...n, velocity: Math.max(0.01, v) };
    case 'pan': return { ...n, pan: Math.abs(v - 0.5) < 0.02 ? 0 : v * 2 - 1 };
    case 'fine': return { ...n, fine: Math.abs(v - 0.5) < 0.02 ? 0 : v * 2 - 1 };
    case 'repeat': return { ...n, repeat: REPEATS[Math.round(v * (REPEATS.length - 1))] };
    default: return { ...n, [k]: v };
  }
}
export function propText(n: Note, k: NoteProp): string {
  switch (k) {
    case 'velocity': return `Velocity ${Math.round(n.velocity * 127)}`;
    case 'pan': { const p = Math.round((n.pan ?? 0) * 100); return p === 0 ? 'Pan centre' : p < 0 ? `Pan ${-p}% left` : `Pan ${p}% right`; }
    case 'fine': { const c = Math.round((n.fine ?? 0) * 100); return `Fine ${c > 0 ? '+' : ''}${c} cents`; }
    case 'repeat': return (n.repeat ?? 1) <= 1 ? 'Repeat off' : `Repeat ×${n.repeat}`;
    case 'release': return `Release ${Math.round((n.release ?? 0.5) * 127)}`;
    case 'cutoff': return `Cutoff ${Math.round((n.cutoff ?? 0.5) * 127)}`;
    case 'resonance': return `Resonance ${Math.round((n.resonance ?? 0.5) * 127)}`;
  }
}

// ---------------------------------------------------------------- grid, quantize, slice

/** The grid the roll draws at a zoom level; snapping always uses it. */
export function gridStep(pxPerBeat: number): number {
  for (const s of [0.015625, 0.03125, 0.0625, 0.125, 0.25, 0.5, 1, 2, 4]) if (s * pxPerBeat >= 14) return s;
  return 8;
}
export function gridLabel(step: number): string {
  if (step >= 4) return `${step / 4} bar${step > 4 ? 's' : ''}`;
  if (step === 2) return '1/2';
  if (Math.abs(step - 1 / 3) < 1e-6) return '1/8T';
  if (Math.abs(step - 1 / 6) < 1e-6) return '1/16T';
  return `1/${Math.round(4 / step)}`;
}

/** Pull note starts (and optionally ends) towards the grid by `strength` (0..1). */
export function quantize(notes: Note[], grid: number, strength: number, ends: boolean): Note[] {
  return notes.map(n => {
    const s0 = n.start, e0 = n.start + n.length;
    const qs = Math.round(s0 / grid) * grid;
    const start = s0 + (qs - s0) * strength;
    let end = e0 + (start - s0);
    if (ends) { const qe = Math.max(qs + grid, Math.round(e0 / grid) * grid); end = e0 + (qe - e0) * strength; }
    return { ...n, start: Math.max(0, start), length: Math.max(grid / 4, end - start) };
  });
}

function splitPath(pts: PathPoint[], cut: number, fallback: number): [PathPoint[], PathPoint[]] {
  if (!pts.length) return [[], []];
  const at = evalPath(pts, cut, fallback);
  const left = pts.filter(p => p.t < cut).map(p => ({ ...p, t: p.t / cut }));
  left.push({ t: 1, v: at });
  const right = [{ t: 0, v: at, c: 'smooth' as Curve }, ...pts.filter(p => p.t > cut).map(p => ({ ...p, t: (p.t - cut) / (1 - cut) }))];
  return [left, right];
}

/** Cut every note that crosses `beat` into two (pitch path and pressure split with it). */
export function sliceAt(notes: Note[], beat: number, onlyIds?: Set<string>): { notes: Note[]; cut: number } {
  let cut = 0;
  const out: Note[] = [];
  for (const n of notes) {
    const end = n.start + n.length;
    if ((onlyIds && !onlyIds.has(n.id)) || beat <= n.start + 1e-4 || beat >= end - 1e-4) { out.push(n); continue; }
    const t = (beat - n.start) / n.length;
    const [b1, b2] = splitPath(n.bend, t, 0);
    const [p1, p2] = splitPath(n.pressure, t, DEFAULT_PRESSURE);
    out.push({ ...n, length: beat - n.start, bend: b1, pressure: p1 });
    out.push({ ...n, id: uid(), start: beat, length: end - beat, bend: b2, pressure: p2 });
    cut++;
  }
  return { notes: out, cut };
}

export function makeNote(pitch: number, start: number, length: number, velocity = 0.8): Note {
  return { id: uid(), pitch, start, length, velocity, bend: [], pressure: [] };
}

function shape(c: Curve | undefined, x: number) {
  switch (c) {
    case 'linear': return x;
    case 'easeIn': return x * x;
    case 'easeOut': return 1 - (1 - x) * (1 - x);
    case 'step': return x < 1 ? 0 : 1;
    default: return x * x * (3 - 2 * x); // smooth
  }
}

/** Evaluate a lane at position t (0..1). Returns fallback when empty. */
export function evalPath(pts: PathPoint[], t: number, fallback = 0): number {
  if (pts.length === 0) return fallback;
  if (t <= pts[0].t) return pts[0].v;
  const last = pts[pts.length - 1];
  if (t >= last.t) return last.v;
  // binary search
  let lo = 0, hi = pts.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (pts[m].t <= t) lo = m; else hi = m; }
  const a = pts[lo], b = pts[hi];
  const span = b.t - a.t;
  if (span <= 1e-9) return b.v;
  return a.v + (b.v - a.v) * shape(a.c, (t - a.t) / span);
}

export function evalCC(pts: CCPoint[], beat: number): number | null {
  if (pts.length === 0) return null;
  const mapped = pts.map(p => ({ t: p.beat, v: p.v, c: p.c }));
  return evalPath(mapped, beat, 0);
}

export const bendAt = (n: Note, t: number) => evalPath(n.bend, t, 0);
export const pressureAt = (n: Note, t: number) => evalPath(n.pressure, t, DEFAULT_PRESSURE);

export const sortPts = <T extends { t: number }>(p: T[]) => p.sort((a, b) => a.t - b.t);

/** Resample a lane densely so a generated shape can be layered on top. */
function sample(pts: PathPoint[], n: number, fallback: number) {
  const out: number[] = [];
  for (let i = 0; i <= n; i++) out.push(evalPath(pts, i / n, fallback));
  return out;
}

/** Reduce point count while keeping shape (Ramer–Douglas–Peucker). */
export function simplify(pts: PathPoint[], eps: number): PathPoint[] {
  if (pts.length < 3) return pts;
  const keep = new Array(pts.length).fill(false);
  keep[0] = keep[pts.length - 1] = true;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop()!;
    let maxD = 0, idx = -1;
    for (let i = s + 1; i < e; i++) {
      const a = pts[s], b = pts[e], p = pts[i];
      const u = (p.t - a.t) / Math.max(1e-9, b.t - a.t);
      const d = Math.abs(p.v - (a.v + (b.v - a.v) * u));
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > eps && idx > 0) { keep[idx] = true; stack.push([s, idx], [idx, e]); }
  }
  return pts.filter((_, i) => keep[i]).map(p => ({ ...p, c: 'linear' as Curve }));
}

// ---------------------------------------------------------------- presets

export function presetScoop(n: Note): PathPoint[] {
  const rest = n.bend.filter(p => p.t > 0.2);
  return sortPts([{ t: 0, v: -2, c: 'easeOut' }, { t: 0.14, v: 0, c: 'smooth' }, ...rest]);
}
export function presetFall(n: Note): PathPoint[] {
  const keep = n.bend.filter(p => p.t < 0.7);
  const base = evalPath(n.bend, 0.72, 0);
  return sortPts([...keep, { t: 0.72, v: base, c: 'easeIn' }, { t: 1, v: base - 5 }]);
}
export function presetRise(n: Note): PathPoint[] {
  const keep = n.bend.filter(p => p.t < 0.7);
  const base = evalPath(n.bend, 0.72, 0);
  return sortPts([...keep, { t: 0.72, v: base, c: 'easeIn' }, { t: 1, v: base + 2 }]);
}
export function presetHumanize(n: Note, amount = 0.12): PathPoint[] {
  const N = 64, s = sample(n.bend, N, 0);
  let drift = 0;
  const pts: PathPoint[] = s.map((v, i) => {
    drift = drift * 0.85 + (Math.random() - 0.5) * amount;
    return { t: i / N, v: v + drift, c: 'smooth' };
  });
  return simplify(pts, 0.01).map(p => ({ ...p, c: 'smooth' }));
}
export function tuneToNearest(n: Note, amount: number): PathPoint[] {
  return n.bend.map(p => ({ ...p, v: p.v + (Math.round(p.v) - p.v) * amount }));
}

/**
 * Vibrato with rate and depth envelopes (each a 0..1 lane across the note).
 * rate maps to 3..24 Hz, depth to 0..1 semitone.
 */
export function applyVibrato(n: Note, rate: PathPoint[], depth: PathPoint[], bpm: number): PathPoint[] {
  const secs = n.length * 60 / bpm;
  const steps = Math.max(64, Math.ceil(secs * 24 * 10));
  const base = sample(n.bend, steps, 0);
  let phase = 0;
  const pts: PathPoint[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const hz = 3 + 21 * evalPath(rate, t, 0.2);
    const d = evalPath(depth, t, 0.3);
    if (i > 0) phase += 2 * Math.PI * hz * (secs / steps);
    pts.push({ t, v: base[i] + Math.sin(phase) * d, c: 'linear' });
  }
  return pts;
}

// ---------------------------------------------------------------- pressure

export type PressureShape = 'swell' | 'build' | 'fade' | 'tremolo' | 'hold';
export function pressurePreset(kind: PressureShape, opts: { rate: number; depth: number; bpm: number; length: number }): PathPoint[] {
  switch (kind) {
    case 'swell': return [{ t: 0, v: 0.2, c: 'smooth' }, { t: 0.5, v: 0.9, c: 'smooth' }, { t: 1, v: 0.25 }];
    case 'build': return [{ t: 0, v: 0.15, c: 'easeIn' }, { t: 1, v: 0.95 }];
    case 'fade': return [{ t: 0, v: 0.9, c: 'easeOut' }, { t: 1, v: 0.1 }];
    case 'hold': return [{ t: 0, v: 0.7 }, { t: 1, v: 0.7 }];
    case 'tremolo': {
      const secs = opts.length * 60 / opts.bpm;
      const cycles = Math.max(1, Math.round(secs * opts.rate));
      const pts: PathPoint[] = [];
      for (let i = 0; i <= cycles * 2; i++) pts.push({ t: i / (cycles * 2), v: i % 2 ? 0.6 - opts.depth * 0.4 : 0.6 + opts.depth * 0.35, c: 'smooth' });
      return pts.map(p => ({ ...p, v: clamp(p.v, 0, 1) }));
    }
  }
}

/** Breathing swells over a passage; unison 1 = all lines breathe together. */
export function applyDynamics(notes: Note[], o: { peak: number; bottom: number; unison: number; swellBeats: number }): Note[] {
  return notes.map((n, idx) => {
    const phaseOff = (1 - o.unison) * idx * 0.5 * o.swellBeats;
    const cycles = n.length / o.swellBeats;
    const steps = Math.max(2, Math.round(cycles * 4));
    const pts: PathPoint[] = [];
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const beat = n.start + t * n.length + phaseOff;
      const w = 0.5 - 0.5 * Math.cos((beat / o.swellBeats) * 2 * Math.PI);
      pts.push({ t, v: o.bottom + (o.peak - o.bottom) * w, c: 'smooth' });
    }
    return { ...n, pressure: pts };
  });
}

// ---------------------------------------------------------------- connect

/**
 * Split a selection into voices. Notes that overlap in time form chords; each
 * chord is ranked by pitch so the top line stays on top. Legato overlaps in a
 * single line (a note starting before the previous ends) stay one voice.
 */
export function splitVoices(sel: Note[]): Note[][] {
  const notes = [...sel].sort((a, b) => a.start - b.start || b.pitch - a.pitch);
  // group onsets that start together (within a 1/32)
  const groups: Note[][] = [];
  for (const n of notes) {
    const g = groups[groups.length - 1];
    if (g && Math.abs(g[0].start - n.start) < 0.125) g.push(n); else groups.push([n]);
  }
  const voiceCount = Math.max(...groups.map(g => g.length));
  const voices: Note[][] = Array.from({ length: voiceCount }, () => []);
  for (const g of groups) {
    g.sort((a, b) => b.pitch - a.pitch);
    if (g.length === voiceCount) g.forEach((n, i) => voices[i].push(n));
    else {
      // fewer notes than voices: give each note to the voice whose last pitch is closest
      const free = voices.map((_, i) => i);
      for (const n of g) {
        let best = free[0], bd = Infinity;
        for (const vi of free) {
          const last = voices[vi][voices[vi].length - 1];
          const d = last ? Math.abs(last.pitch - n.pitch) : 0;
          if (d < bd) { bd = d; best = vi; }
        }
        voices[best].push(n);
        free.splice(free.indexOf(best), 1);
      }
    }
  }
  return voices.filter(v => v.length > 0);
}

export interface ConnectOpts {
  glideMs: number; offsetMs: number; mode: 'time' | 'distance';
  /** 'nearest': each line glides to whichever note of the next chord is closest, shifting octaves up or down. */
  target?: 'written' | 'nearest';
  /** 'continuous': merge each line into one gliding note. 'keep': keep every note, glide into the next one, which then plays again. */
  style?: 'continuous' | 'keep';
}

/**
 * Voice-lead a passage by nearest motion. Each running line moves to the note
 * of the next onset that is closest to it (any octave, so at most a tritone up
 * or down); notes no line claims start new lines.
 */
export function nearestVoices(sel: Note[], fold = true): Note[][] {
  const notes = [...sel].sort((a, b) => a.start - b.start || b.pitch - a.pitch);
  const groups: Note[][] = [];
  for (const n of notes) {
    const g = groups[groups.length - 1];
    if (g && Math.abs(g[0].start - n.start) < 0.125) g.push(n); else groups.push([n]);
  }
  const near = (pitch: number, from: number) => {
    if (!fold) return pitch;
    let p = pitch + 12 * Math.round((from - pitch) / 12);
    if (p - from > 6) p -= 12; else if (from - p > 6) p += 12;
    return clamp(p, 0, 127);
  };
  const voices: Note[][] = [];
  for (const g of groups) {
    g.sort((a, b) => b.pitch - a.pitch);
    const open = voices.map((v, i) => i);
    const cost = (vi: number, n: Note) => { const last = voices[vi][voices[vi].length - 1]; return Math.abs(near(n.pitch, last.pitch) - last.pitch); };
    // best assignment of chord notes to running lines (exhaustive for small chords)
    let best: (number | -1)[] = g.map(() => -1), bestCost = Infinity;
    const k = Math.min(g.length, open.length);
    if (open.length && g.length <= 6 && open.length <= 6) {
      const pick = (i: number, used: Set<number>, acc: (number | -1)[], c: number, matched: number) => {
        if (c >= bestCost) return;
        if (i === g.length) { if (matched === k) { bestCost = c; best = [...acc]; } return; }
        for (const vi of open) if (!used.has(vi)) { used.add(vi); acc.push(vi); pick(i + 1, used, acc, c + cost(vi, g[i]), matched + 1); acc.pop(); used.delete(vi); }
        if (g.length - i > k - matched) { acc.push(-1); pick(i + 1, used, acc, c, matched); acc.pop(); }
      };
      pick(0, new Set(), [], 0, 0);
    } else if (open.length) {
      const used = new Set<number>();
      best = g.map(n => {
        let bv = -1, bc = Infinity;
        for (const vi of open) if (!used.has(vi)) { const c = cost(vi, n); if (c < bc) { bc = c; bv = vi; } }
        if (bv >= 0) used.add(bv);
        return bv;
      });
    }
    g.forEach((n, i) => {
      const vi = best[i];
      if (vi >= 0) {
        const last = voices[vi][voices[vi].length - 1];
        voices[vi].push({ ...n, pitch: near(n.pitch, last.pitch) });
      } else voices.push([n]);
    });
  }
  return voices;
}

export function connectNotes(sel: Note[], o: ConnectOpts, bpm: number): Note[] {
  const out: Note[] = [];
  const msToBeats = (ms: number) => ms / 1000 * bpm / 60;
  if (o.style === 'keep') return glideInto(sel, o, bpm);
  const voices = o.target === 'nearest' ? nearestVoices(sel) : splitVoices(sel);
  for (const voice of voices) {
    if (voice.length === 1) { out.push(voice[0]); continue; }
    const first = voice[0];
    const start = first.start;
    const end = Math.max(...voice.map(n => n.start + n.length));
    const len = end - start;
    const bend: PathPoint[] = [];
    const pressure: PathPoint[] = [];
    const toT = (beat: number) => clamp((beat - start) / len, 0, 1);
    let skipUntil = -Infinity;
    voice.forEach((n, i) => {
      const off = n.pitch - first.pitch;
      const nStart = i === 0 ? start : n.start;
      const nEnd = i < voice.length - 1 ? voice[i + 1].start : n.start + n.length;
      // carry this note's own bend shape across its segment
      const segPts = n.bend.length ? n.bend : [{ t: 0, v: 0 }];
      for (const p of segPts) {
        const beat = n.start + p.t * n.length;
        if (beat >= Math.max(nStart, skipUntil) - 1e-6 && beat <= nEnd + 1e-6) bend.push({ t: toT(beat), v: off + p.v, c: p.c ?? 'smooth' });
      }
      const pr = n.pressure.length ? n.pressure : [{ t: 0, v: DEFAULT_PRESSURE }, { t: 1, v: DEFAULT_PRESSURE }];
      for (const p of pr) {
        const beat = n.start + p.t * n.length;
        if (beat >= nStart - 1e-6 && beat <= nEnd + 1e-6) pressure.push({ t: toT(beat), v: p.v, c: p.c ?? 'smooth' });
      }
      if (i < voice.length - 1) {
        const next = voice[i + 1];
        const interval = Math.abs(next.pitch - n.pitch);
        let g = msToBeats(o.glideMs);
        if (o.mode === 'distance') g *= clamp(interval / 5, 0.25, 3);
        const center = next.start + msToBeats(o.offsetMs);
        const a = Math.max(nStart, center - g / 2), b = Math.min(next.start + next.length, center + g / 2);
        const fromV = evalPath(n.bend, clamp((a - n.start) / n.length, 0, 1), 0) + off;
        // drop any carried points inside the glide window
        for (let k = bend.length - 1; k >= 0; k--) if (bend[k].t > toT(a) - 1e-6) bend.splice(k, 1);
        bend.push({ t: toT(a), v: fromV, c: 'smooth' });
        bend.push({ t: toT(b), v: next.pitch - first.pitch, c: 'smooth' });
        skipUntil = b + 1e-4;
      }
    });
    // dedupe and sort
    const clean = sortPts(bend).filter((p, i, arr) => i === 0 || p.t - arr[i - 1].t > 1e-5 || p.v !== arr[i - 1].v);
    const cleanP = sortPts(pressure).filter((p, i, arr) => i === 0 || p.t - arr[i - 1].t > 1e-5);
    out.push({ ...first, id: uid(), start, length: len, bend: clean, pressure: cleanP, velocity: first.velocity });
  }
  return out;
}

/**
 * Keep every note as written and add a glide at the end of each note towards
 * the next note in its line; the next note then starts again (re-attack).
 * Chords stay chords: each voice glides to the nearest note of the next chord
 * (target 'nearest') or to the same-ranked voice (target 'written').
 */
function glideInto(sel: Note[], o: ConnectOpts, bpm: number): Note[] {
  const beats = (ms: number) => ms / 1000 * bpm / 60;
  // pair each note with the pitch it glides to
  const pairs: { n: Note; next: Note }[] = [];
  const lone: Note[] = [];
  if (o.target === 'nearest') {
    // every note glides to whichever note of the next chord/onset is closest to it
    const notes = [...sel].sort((a, b) => a.start - b.start || b.pitch - a.pitch);
    const groups: Note[][] = [];
    for (const n of notes) {
      const g = groups[groups.length - 1];
      if (g && Math.abs(g[0].start - n.start) < 0.125) g.push(n); else groups.push([n]);
    }
    groups.forEach((g, gi) => g.forEach(n => {
      const nextG = groups[gi + 1];
      if (!nextG) { lone.push(n); return; }
      let best = nextG[0];
      for (const m of nextG) if (Math.abs(m.pitch - n.pitch) < Math.abs(best.pitch - n.pitch)) best = m;
      pairs.push({ n, next: best });
    }));
  } else {
    for (const voice of splitVoices(sel)) voice.forEach((n, i) => voice[i + 1] ? pairs.push({ n, next: voice[i + 1] }) : lone.push(n));
  }
  const out: Note[] = [...lone];
  for (const { n, next } of pairs) {
    if (next.pitch === n.pitch) { out.push(n); continue; }
    const nEnd = n.start + n.length;
    const interval = next.pitch - n.pitch;
    let g = beats(o.glideMs);
    if (o.mode === 'distance') g *= clamp(Math.abs(interval) / 5, 0.25, 3);
    // land on the next note's pitch as it starts (offset leans it early or late)
    const land = clamp(Math.min(nEnd, next.start) + beats(o.offsetMs), n.start + 0.01, nEnd);
    const from = Math.max(n.start, land - g);
    const tA = (from - n.start) / n.length, tB = (land - n.start) / n.length;
    const base = evalPath(n.bend, tA, 0);
    const kept = n.bend.filter(p => p.t < tA - 1e-4);
    const bend: PathPoint[] = [...kept];
    if (!kept.length || kept[0].t > 0) bend.unshift({ t: 0, v: kept.length ? kept[0].v : base, c: 'smooth' });
    bend.push({ t: tA, v: base, c: 'smooth' }, { t: tB, v: base + interval, c: 'smooth' });
    if (tB < 1) bend.push({ t: 1, v: base + interval });
    out.push({ ...n, bend: sortPts(bend).filter((p, k, arr) => k === 0 || p.t - arr[k - 1].t > 1e-5) });
  }
  return out;
}

/** Pitch range covered by a note's path (for culling and fills). */
export function bendExtent(n: Note): [number, number] {
  let lo = 0, hi = 0;
  for (const p of n.bend) { lo = Math.min(lo, p.v); hi = Math.max(hi, p.v); }
  return [n.pitch + lo, n.pitch + hi];
}

// ---------------------------------------------------------------- legato merge

/**
 * When a note's pitch path glides onto a note it overlaps, fold the two into
 * one note: the first note's path is kept exactly as drawn, the second note
 * stops being a separate attack, and anything the second note did after the
 * first one ends (its length, bend, pressure) carries on in the merged note.
 * `ids` limits the check to pairs where at least one note was just edited.
 */
export function mergeGlides(input: Note[], ids: string[]): { notes: Note[]; merged: number; into: Map<string, string> } {
  let notes = [...input];
  const touched = new Set(ids);
  const into = new Map<string, string>();
  let merged = 0;
  for (let guard = 0; guard < 64; guard++) {
    const pair = findPair(notes, touched);
    if (!pair) break;
    const [a, b] = pair;
    const m = mergePair(a, b);
    notes = notes.filter(n => n.id !== b.id).map(n => n.id === a.id ? m : n);
    into.set(b.id, a.id);
    into.forEach((v, k) => { if (v === b.id) into.set(k, a.id); });
    touched.add(a.id);
    merged++;
  }
  return { notes, merged, into };
}

function findPair(notes: Note[], touched: Set<string>): [Note, Note] | null {
  for (const a of notes) {
    if (a.muted || a.bend.length === 0) continue;
    const aEnd = a.start + a.length;
    for (const b of notes) {
      if (b === a || b.muted) continue;
      if (!touched.has(a.id) && !touched.has(b.id)) continue;
      if (b.start <= a.start + 1e-6 || b.start >= aEnd - 1e-6) continue; // b must start inside a
      // does a's path reach b's pitch anywhere while they overlap?
      const overlapEnd = Math.min(aEnd, b.start + b.length);
      const steps = 24;
      for (let i = 0; i <= steps; i++) {
        const beat = b.start + (overlapEnd - b.start) * (i / steps);
        const p = a.pitch + bendAt(a, (beat - a.start) / a.length);
        if (Math.abs(p - b.pitch) <= 0.5) return [a, b];
      }
    }
  }
  return null;
}

function mergePair(a: Note, b: Note): Note {
  const aEnd = a.start + a.length, bEnd = b.start + b.length;
  const end = Math.max(aEnd, bEnd);
  const len = end - a.start;
  const toT = (beat: number) => clamp((beat - a.start) / len, 0, 1);
  const off = b.pitch - a.pitch;

  // pitch: a's path verbatim, then b's own path for the part after a ends
  const bend: PathPoint[] = a.bend.map(p => ({ ...p, t: toT(a.start + p.t * a.length) }));
  const lastA = evalPath(a.bend, 1, 0);
  if (bEnd > aEnd + 1e-6) {
    bend.push({ t: toT(aEnd), v: lastA, c: 'smooth' });
    const tail = b.bend.filter(p => b.start + p.t * b.length > aEnd + 1e-6);
    if (tail.length) tail.forEach(p => bend.push({ ...p, t: toT(b.start + p.t * b.length), v: p.v + off }));
    else {
      // settle on b's pitch (a's glide already landed within half a semitone)
      const settle = Math.min(bEnd, aEnd + Math.min(0.25, (bEnd - aEnd) / 2));
      bend.push({ t: toT(settle), v: off + evalPath(b.bend, (settle - b.start) / b.length, 0), c: 'smooth' });
      bend.push({ t: 1, v: off + evalPath(b.bend, 1, 0) });
    }
  }

  // pressure: a's ribbon, then b's for the remainder
  const aP = a.pressure.length ? a.pressure : [{ t: 0, v: DEFAULT_PRESSURE }, { t: 1, v: DEFAULT_PRESSURE }];
  const pressure: PathPoint[] = aP.map(p => ({ ...p, t: toT(a.start + p.t * a.length) }));
  if (bEnd > aEnd + 1e-6) {
    const bP = b.pressure.length ? b.pressure : [{ t: 0, v: DEFAULT_PRESSURE }, { t: 1, v: DEFAULT_PRESSURE }];
    pressure.push({ t: toT(aEnd), v: evalPath(aP, 1, DEFAULT_PRESSURE), c: 'smooth' });
    bP.filter(p => b.start + p.t * b.length > aEnd + 1e-6).forEach(p => pressure.push({ ...p, t: toT(b.start + p.t * b.length) }));
    if (pressure[pressure.length - 1].t < 1) pressure.push({ t: 1, v: evalPath(bP, 1, DEFAULT_PRESSURE) });
  }

  const dedupe = (pts: PathPoint[]) => sortPts(pts).filter((p, i, arr) => i === 0 || p.t - arr[i - 1].t > 1e-5);
  return { ...a, length: len, bend: dedupe(bend), pressure: a.pressure.length || b.pressure.length ? dedupe(pressure) : [] };
}
