// Playing Mode, UI side.
//
// The sound is made by the play engine: C++ in the plug-in (PlayEngine.cpp),
// or the browser version below for the web preview. Both work the same way and
// report the same events: a voice starts, glides from one pitch to another, or
// ends; a phrase begins or is let go. This module turns those events into what
// you see (glowing live notes, the neon note display, the "hold for glide"
// message) and, when the phrase ends, writes it into the clip as real notes
// with their glides, ready to edit.
import { useSyncExternalStore } from 'react';
import { Note, PathPoint, makeNote, uid, BEATS_PER_BAR, clamp } from './model';
import { getState, setState, subscribe, editNotes, checkpoint, flash } from './store';
import { bridge, isPlugin } from './bridge';
import { playheadBeat, liveVoice, LiveVoiceHandle, setPlayKeyHook } from './audio';

export interface LiveEvent { type: 'start' | 'glide' | 'end' | 'phraseOn' | 'phraseOff'; id: number; pitch: number; to: number; ms: number; vel: number; at: number }

interface Glide { at: number; from: number; to: number; dur: number }
interface LiveLine { id: number; base: number; vel: number; startAt: number; endAt: number | null; glides: Glide[] }

interface LiveState {
  active: boolean;
  t0: number;            // local clock (s) when the phrase began
  startBeat: number;     // where in the clip the phrase is written
  lastOnAt: number;      // phrase time (s) of the last chord
  lines: LiveLine[];
  chords: number;        // chords played in this phrase
  gliding: number;       // phrase time when the last glide began (for the flash)
}

let live: LiveState = { active: false, t0: 0, startBeat: 0, lastOnAt: 0, lines: [], chords: 0, gliding: -10 };
let version = 0;
const listeners = new Set<() => void>();
const changed = () => { version++; listeners.forEach(l => l()); };
export const useLive = <T,>(sel: (l: LiveState) => T) => useSyncExternalStore(cb => { listeners.add(cb); return () => listeners.delete(cb); }, () => sel(live));
export const getLive = () => live;
export const liveVersion = () => version;

const nowS = () => performance.now() / 1000;
/** Phrase time now (s). */
export const phraseTime = () => live.active ? nowS() - live.t0 : 0;

function pitchAt(l: LiveLine, at: number): number {
  let p = l.base;
  for (const g of l.glides) {
    if (at <= g.at) break;
    const x = g.dur > 0 ? clamp((at - g.at) / g.dur, 0, 1) : 1;
    p = g.from + (g.to - g.from) * x * x * (3 - 2 * x);
  }
  return p;
}
/** Where each sounding voice is (or is heading). */
export function soundingPitches(target = true): number[] {
  const at = phraseTime();
  return live.lines.filter(l => l.endAt === null).map(l => target && l.glides.length ? l.glides[l.glides.length - 1].to : pitchAt(l, at));
}

function nextFreeBeat(): number {
  const s = getState();
  if (s.playing) return Math.max(0, playheadBeat());
  const end = s.clip.notes.reduce((m, n) => Math.max(m, n.start + n.length), 0);
  return end <= 0 ? 0 : Math.ceil(end / BEATS_PER_BAR - 1e-6) * BEATS_PER_BAR;
}

/** Apply one event from the play engine. */
export function applyLive(e: LiveEvent) {
  switch (e.type) {
    case 'phraseOn':
      live = { active: true, t0: nowS() - e.at, startBeat: nextFreeBeat(), lastOnAt: e.at, lines: [], chords: 1, gliding: -10 };
      break;
    case 'start': {
      if (!live.active) applyLive({ ...e, type: 'phraseOn', at: 0 });
      if (e.at - live.lastOnAt > 0.25 && !live.lines.some(l => Math.abs(l.startAt - e.at) < 0.05)) live.chords++;
      live.lastOnAt = Math.max(live.lastOnAt, e.at);
      live.lines = [...live.lines, { id: e.id, base: Math.round(e.pitch), vel: e.vel, startAt: e.at, endAt: null, glides: [] }];
      break;
    }
    case 'glide': {
      live.lines = live.lines.map(l => l.id === e.id ? { ...l, glides: [...l.glides, { at: e.at, from: e.pitch, to: e.to, dur: e.ms / 1000 }] } : l);
      if (e.at - live.gliding > 0.05) live.chords++;
      live.gliding = e.at; live.lastOnAt = Math.max(live.lastOnAt, e.at);
      break;
    }
    case 'end':
      live.lines = live.lines.map(l => l.id === e.id ? { ...l, endAt: e.at } : l);
      break;
    case 'phraseOff':
      live.lines = live.lines.map(l => l.endAt === null ? { ...l, endAt: e.at } : l);
      commitPhrase();
      // the captured notes are now real notes in the clip; the glowing copy goes
      live = { ...live, active: false, lines: s_capture() ? [] : live.lines };
      if (!s_capture()) setTimeout(() => { if (!live.active) { live = { ...live, lines: [] }; changed(); } }, 1200);
      break;
  }
  live = { ...live };
  changed();
}

/** The phrase so far as notes (still-sounding ones run up to now). */
export function liveNotes(): Note[] {
  if (!live.lines.length) return [];
  const bpm = getState().clip.bpm;
  const b = (s: number) => live.startBeat + s * bpm / 60;
  const now = phraseTime();
  return live.lines.map(l => lineToNote(l, l.endAt ?? now, b));
}

function lineToNote(l: LiveLine, endAt: number, b: (s: number) => number): Note {
  const start = b(l.startAt), end = Math.max(start + 0.01, b(endAt));
  const len = end - start;
  const tOf = (s: number) => clamp((b(s) - start) / len, 0, 1);
  const bend: PathPoint[] = [];
  let cur = 0;
  for (const g of l.glides) {
    if (g.at >= endAt) break;
    const a = tOf(g.at), z = tOf(Math.min(endAt, g.at + g.dur));
    const from = g.from - l.base, to = g.to - l.base;
    bend.push({ t: a, v: from, c: 'smooth' });
    const done = g.dur > 0 ? clamp((endAt - g.at) / g.dur, 0, 1) : 1;
    const reached = from + (to - from) * done * done * (3 - 2 * done);
    bend.push({ t: z, v: done >= 1 ? to : reached, c: 'smooth' });
    cur = to;
  }
  if (bend.length) { if (bend[0].t > 0) bend.unshift({ t: 0, v: 0, c: 'smooth' }); if (bend[bend.length - 1].t < 1) bend.push({ t: 1, v: bend[bend.length - 1].v }); }
  void cur;
  const n = makeNote(l.base, start, len, l.vel || 0.8);
  return { ...n, id: `live-${l.id}`, bend };
}

const s_capture = () => getState().play.capture;

function commitPhrase() {
  const s = getState();
  if (!s.play.capture || !live.lines.length) return;
  const notes = liveNotes().map(n => ({ ...n, id: uid() }));
  checkpoint();
  editNotes(ns => [...ns, ...notes]);
  checkpoint();
  flash(`Captured ${live.chords} chord${live.chords === 1 ? '' : 's'} into the clip · switch to Editing to shape it`);
}

// ---------------------------------------------------------------- input

/** A key went down in Playing Mode (MIDI keyboard, computer keys or the on-screen piano). */
export function playNoteOn(pitch: number, velocity = 0.8) {
  if (isPlugin) bridge.keyDown(pitch, velocity);
  else jsPlay.noteOn(pitch, velocity);
}
export function letGo() {
  if (isPlugin) bridge.letGo(); else jsPlay.releaseAll();
}

// computer keys as a piano (Ableton layout): A W S E D F T G Y H U J K O L P ; and Z / X for octaves
const KEYMAP = 'awsedftgyhujkolp;';
let octave = 0;
if (typeof window !== 'undefined') window.addEventListener('keydown', e => {
  const s = getState();
  if (s.mode !== 'play' || s.chooser || s.modeChooser || e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
  const t = e.target as HTMLElement;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
  const k = e.key.toLowerCase();
  if (k === 'z' || k === 'x') { octave = clamp(octave + (k === 'z' ? -1 : 1), -3, 3); flash(`Computer keys: octave ${octave >= 0 ? '+' : ''}${octave}`); e.preventDefault(); return; }
  if (k === 'escape') { letGo(); return; }
  const i = KEYMAP.indexOf(k);
  if (i >= 0) { e.preventDefault(); e.stopImmediatePropagation(); playNoteOn(60 + 12 * octave + i, 0.8); }
}, true);

// Web MIDI keyboards (browser build; in the plug-in the host sends MIDI to the engine)
let midiHooked = false;
async function hookMidi() {
  if (isPlugin || midiHooked || !(navigator as any).requestMIDIAccess) return;
  midiHooked = true;
  try {
    const access = await (navigator as any).requestMIDIAccess();
    const onMsg = (m: any) => {
      if (getState().mode !== 'play') return;
      const [st, d1, d2] = m.data;
      if ((st & 0xf0) === 0x90 && d2 > 0) jsPlay.noteOn(d1, d2 / 127);
      if ((st & 0xf0) === 0xd0) jsPlay.pressure(d1 / 127);
    };
    const hook = () => access.inputs.forEach((inp: any) => inp.addEventListener('midimessage', onMsg));
    hook(); access.onstatechange = hook;
  } catch { /* no MIDI here */ }
}

// ---------------------------------------------------------------- settings to the engine

let lastKey = '';
subscribe(() => {
  const s = getState();
  const on = s.mode === 'play' && !s.chooser && !s.modeChooser;
  const key = JSON.stringify([on, s.glide.glideMs, s.glide.mode, s.play.holdSecs, s.play.strumMs]);
  if (key === lastKey) return;
  const wasOn = lastKey ? JSON.parse(lastKey)[0] : false;
  lastKey = key;
  if (isPlugin) bridge.playMode({ on, glideMs: s.glide.glideMs, distance: s.glide.mode === 'distance', holdSecs: s.play.holdSecs, strumMs: s.play.strumMs });
  if (on) hookMidi();
  if (wasOn && !on) letGo();
});

if (isPlugin) bridge.onLive(p => { for (const e of p.events) applyLive(e); });
setPlayKeyHook((p, v) => jsPlay.noteOn(p, v));

// ---------------------------------------------------------------- browser play engine (mirror of PlayEngine.cpp)

const jsPlay = (() => {
  interface V { id: number; base: number; from: number; to: number; t0: number; dur: number; started: number; h: LiveVoiceHandle }
  let voices: V[] = [];
  let phrase = false, glided = false;
  let phraseStart = 0, lastOn = 0, firstChordUntil = 0;
  let pend: [number, number][] = [];
  let pendFirst = 0, pendTimer: any = null, idleTimer: any = null, nextId = 1;
  const t = () => nowS();
  const at = (x: number) => x - phraseStart;
  const settings = () => getState();
  const pitchNow = (v: V, x: number) => {
    if (v.dur <= 0 || x >= v.t0 + v.dur) return v.to;
    if (x <= v.t0) return v.from;
    const k = (x - v.t0) / v.dur; return v.from + (v.to - v.from) * k * k * (3 - 2 * k);
  };
  const emit = (e: Partial<LiveEvent> & { type: LiveEvent['type'] }) => applyLive({ id: 0, pitch: 0, to: 0, ms: 0, vel: 0, at: 0, ...e });

  function start(pitch: number, vel: number, x: number) {
    if (voices.length >= 12) { const old = voices.reduce((a, b) => a.started < b.started ? a : b); end(old, x); }
    const v: V = { id: nextId++, base: pitch, from: pitch, to: pitch, t0: x, dur: 0, started: x, h: liveVoice(pitch, vel) };
    voices.push(v);
    emit({ type: 'start', id: v.id, pitch, to: pitch, vel, at: at(x) });
  }
  function end(v: V, x: number) {
    v.h.stop(); voices = voices.filter(o => o !== v);
    emit({ type: 'end', id: v.id, pitch: pitchNow(v, x), at: at(x) });
  }
  function releaseAll() {
    const x = t();
    [...voices].forEach(v => end(v, x));
    pend = []; clearTimeout(pendTimer); clearInterval(idleTimer);
    if (phrase) { phrase = false; emit({ type: 'phraseOff', at: at(x) }); }
  }
  function resolve() {
    const x = t();
    const chord = [...pend].sort((a, b) => b[0] - a[0]); pend = [];
    const cur = [...voices].sort((a, b) => b.to - a.to);
    const swap = cur.length > chord.length;
    const S = swap ? chord.map(c => c[0]) : cur.map(v => v.to), L = swap ? cur.map(v => v.to) : chord.map(c => c[0]);
    const m = S.length, n = L.length;
    const dp = Array.from({ length: m + 1 }, () => Array(n + 1).fill(Infinity));
    for (let j = 0; j <= n; j++) dp[0][j] = 0;
    for (let i = 1; i <= m; i++) for (let j = i; j <= n; j++) dp[i][j] = Math.min(dp[i][j - 1], dp[i - 1][j - 1] + Math.abs(S[i - 1] - L[j - 1]));
    const target = new Map<V, number>();
    for (let i = m, j = n; i > 0;) {
      if (j > i && dp[i][j] === dp[i][j - 1]) { j--; continue; }
      if (swap) target.set(cur[j - 1], i - 1); else target.set(cur[i - 1], j - 1);
      i--; j--;
    }
    const used = new Set<number>();
    const s = settings();
    for (const v of cur) {
      const ti = target.get(v);
      if (ti === undefined) { end(v, x); continue; }
      used.add(ti);
      const to = chord[ti][0];
      if (Math.abs(to - v.base) > 48) { end(v, x); start(to, chord[ti][1], x); continue; }
      const from = pitchNow(v, x);
      let ms = s.glide.glideMs;
      if (s.glide.mode === 'distance') ms *= clamp(Math.abs(to - from) / 5, 0.25, 3);
      Object.assign(v, { from, to, t0: x, dur: ms / 1000 });
      v.h.glide(from, to, ms / 1000);
      emit({ type: 'glide', id: v.id, pitch: from, to, ms, at: at(x) });
    }
    chord.forEach((c, i) => { if (!used.has(i)) start(c[0], c[1], x); });
    glided = true;
  }
  function noteOn(pitch: number, vel: number) {
    const x = t(), s = settings();
    const strum = s.play.strumMs / 1000;
    lastOn = x;
    if (!phrase) {
      phrase = true; glided = false; phraseStart = x; firstChordUntil = x + strum;
      emit({ type: 'phraseOn', at: 0 });
      start(pitch, vel, x);
      clearInterval(idleTimer);
      idleTimer = setInterval(() => { if (!pend.length && t() - lastOn > getState().play.holdSecs) releaseAll(); }, 100);
      return;
    }
    if (!glided && x <= firstChordUntil) {
      if (voices.some(v => v.base === pitch)) return;
      start(pitch, vel, x);
      firstChordUntil = Math.min(x + strum, phraseStart + 0.4);
      return;
    }
    if (pend.some(p => p[0] === pitch)) return;
    pend.push([pitch, vel]);
    if (pend.length === 1) pendFirst = x;
    clearTimeout(pendTimer);
    pendTimer = setTimeout(resolve, Math.max(0, Math.min(x + strum, pendFirst + 0.4) - x) * 1000);
  }
  function pressure(v: number) { voices.forEach(o => o.h.pressure(v)); }
  return { noteOn, releaseAll, pressure };
})();

// ---------------------------------------------------------------- chord names for the display

const NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
export const noteLabel = (p: number) => NAMES[((Math.round(p) % 12) + 12) % 12] + (Math.floor(Math.round(p) / 12) - 1);

const QUALITIES: [number[], string][] = [
  [[0, 4, 7, 11, 2], 'maj9'], [[0, 3, 7, 10, 2], 'm9'], [[0, 4, 7, 10, 2], '9'], [[0, 3, 7, 11], 'm(maj7)'],
  [[0, 4, 7, 11], 'maj7'], [[0, 3, 7, 10], 'm7'], [[0, 4, 7, 10], '7'], [[0, 3, 6, 10], 'm7b5'], [[0, 3, 6, 9], 'dim7'],
  [[0, 4, 7, 9], '6'], [[0, 3, 7, 9], 'm6'], [[0, 3, 7, 2], 'm(add9)'], [[0, 4, 7, 2], 'add9'],
  [[0, 4, 7], ''], [[0, 3, 7], 'm'], [[0, 3, 6], 'dim'], [[0, 4, 8], 'aug'], [[0, 5, 7], 'sus4'], [[0, 2, 7], 'sus2'], [[0, 7], '5'],
];
/** A name for the notes sounding now ("Cm9", "Ebmaj7/G"), or '' when it's not a chord we know. */
export function chordName(pitches: number[]): string {
  const pcs = [...new Set(pitches.map(p => ((Math.round(p) % 12) + 12) % 12))];
  if (pcs.length < 2) return '';
  const bass = ((Math.round(Math.min(...pitches)) % 12) + 12) % 12;
  let best = '', bestScore = -1;
  for (const root of pcs) {
    const iv = new Set(pcs.map(pc => (pc - root + 12) % 12));
    for (const [q, name] of QUALITIES) {
      const qs = q.map(x => x % 12);
      if (!qs.every(x => iv.has(x))) continue;
      const extra = iv.size - qs.length;
      const score = qs.length * 10 - extra * 6 + (root === bass ? 3 : 0);
      // minor reads "mi" so it can't be mistaken for major on the segment display
      if (score > bestScore) { bestScore = score; best = NAMES[root] + name.replace(/^m(?!aj)/, 'mi') + (root !== bass ? '/' + NAMES[bass] : ''); }
    }
  }
  return best;
}
