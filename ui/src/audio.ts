// Preview synth + transport for the browser build. It renders exactly the
// per-note pitch path and pressure that the MPE export writes, so what you hear
// is what the receiving synth gets. In the plugin build the C++ engine does
// this and the UI only mirrors the playhead.
import { BEATS_PER_BAR, Note, bendAt, pressureAt, evalCC, laneDefault, MASTER_BEND_RANGE, CCLane } from './model';
import { getState, setState, visibleNotes, editClip } from './store';
import { bridge, isPlugin } from './bridge';

let ctx: AudioContext | null = null;
let master: GainNode | null = null;

function audio() {
  if (!ctx) {
    ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14; comp.ratio.value = 4;
    master = ctx.createGain(); master.gain.value = 0.8;
    master.connect(comp); comp.connect(ctx.destination);
  }
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

const SYNTHS: Record<string, { a: OscillatorType; b: OscillatorType; detune: number; cutoff: number; q: number; gain: number }> = {
  'Glass Saw': { a: 'sawtooth', b: 'sawtooth', detune: 7, cutoff: 900, q: 2, gain: 0.16 },
  'Soft Square': { a: 'square', b: 'triangle', detune: 4, cutoff: 700, q: 1, gain: 0.14 },
  'Warm Pad': { a: 'sawtooth', b: 'triangle', detune: 12, cutoff: 500, q: 0.7, gain: 0.2 },
  'Pure Sine': { a: 'sine', b: 'sine', detune: 0, cutoff: 6000, q: 0.5, gain: 0.3 },
};

const hz = (p: number) => 440 * Math.pow(2, (p - 69) / 12);
const live = new Set<{ stop: (t: number) => void }>();

/** Play one note with its full pitch path and pressure ribbon. */
function voice(n: Note, when: number, durBeats: number, bpm: number, ccBeat0: number, out?: { ac: BaseAudioContext; dest: AudioNode }) {
  const ac: BaseAudioContext = out ? out.ac : audio();
  const dest = out ? out.dest : master!;
  const s = getState();
  const cfg = SYNTHS[s.synth] ?? SYNTHS['Glass Saw'];
  const secs = durBeats * 60 / bpm;
  const o1 = ac.createOscillator(), o2 = ac.createOscillator();
  o1.type = cfg.a; o2.type = cfg.b; o2.detune.value = cfg.detune;
  const f = ac.createBiquadFilter(); f.type = 'lowpass';
  // per-note resonance (CC71) and cutoff (CC74) offsets, centred at 0.5
  f.Q.value = cfg.q * Math.pow(2, ((n.resonance ?? 0.5) - 0.5) * 4);
  const cutMul = Math.pow(2, ((n.cutoff ?? 0.5) - 0.5) * 4);
  const g = ac.createGain(); g.gain.value = 0;
  const pan = ac.createStereoPanner();
  o1.connect(f); o2.connect(f); f.connect(g); g.connect(pan); pan.connect(dest);

  const lanes = s.clip.cc;
  const cc = (num: number) => lanes.find(l => l.kind !== 'pitch' && l.kind !== 'param' && l.cc === num);
  const val = (l: CCLane | undefined, beat: number) => l ? (evalCC(l.points, beat) ?? laneDefault(l)) : null;
  const bright = cc(74), expr = cc(11), vol = cc(7), cpan = cc(10);
  const cpitch = lanes.find(l => l.kind === 'pitch');
  const step = 0.01;
  const steps = Math.max(2, Math.ceil(secs / step));
  const amp = cfg.gain * (0.35 + 0.65 * n.velocity);
  const fine = n.fine ?? 0;
  const reps = Math.max(1, n.repeat ?? 1);
  let lastGain = 0;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const at = when + t * secs;
    const beat = ccBeat0 + t * durBeats;
    const cp = val(cpitch, beat);
    const p = n.pitch + bendAt(n, t * durBeats / n.length) + fine + (cp === null ? 0 : (cp - 0.5) * 2 * MASTER_BEND_RANGE);
    const pr = pressureAt(n, t * durBeats / n.length);
    const b74 = bright?.points.length ? val(bright, beat) : null;
    const e11 = expr?.points.length ? val(expr, beat) : null;
    const v7 = val(vol, beat), p10 = val(cpan, beat);
    const freq = hz(p);
    const cut = Math.min(16000, cfg.cutoff * cutMul * (0.6 + pr * 3.5) * (b74 === null ? 1 : 0.4 + b74 * 2) + freq);
    // note repeat: re-strike the envelope `reps` times across the note
    const ph = (t * reps) % 1;
    const gate = reps > 1 ? (ph < 0.03 ? ph / 0.03 : ph > 0.8 ? Math.max(0, (1 - ph) / 0.2) : 1) : 1;
    const gain = amp * (0.2 + 0.8 * pr) * (e11 === null ? 1 : e11) * (v7 === null ? 1 : v7 / (100 / 127)) * gate;
    const panV = Math.max(-1, Math.min(1, (n.pan ?? 0) + (p10 === null ? 0 : (p10 - 0.5) * 2)));
    lastGain = gain;
    if (i === 0) {
      o1.frequency.setValueAtTime(freq, at); o2.frequency.setValueAtTime(freq, at);
      f.frequency.setValueAtTime(cut, at); pan.pan.setValueAtTime(panV, at);
      g.gain.setValueAtTime(0, at); g.gain.linearRampToValueAtTime(gain, at + 0.008);
    } else {
      o1.frequency.linearRampToValueAtTime(freq, at); o2.frequency.linearRampToValueAtTime(freq, at);
      f.frequency.linearRampToValueAtTime(cut, at); pan.pan.linearRampToValueAtTime(panV, at);
      if (at > when + 0.01) g.gain.linearRampToValueAtTime(gain, at);
    }
  }
  const end = when + secs;
  // higher release velocity = quicker release, as most synths read it
  const rel = 0.03 + (1 - (n.release ?? 0.5)) * 0.25;
  g.gain.setValueAtTime(lastGain, end);
  g.gain.linearRampToValueAtTime(0, end + rel);
  o1.start(when); o2.start(when); o1.stop(end + rel + 0.03); o2.stop(end + rel + 0.03);
  if (out) return;
  const handle = {
    stop(t: number) {
      try { g.gain.cancelScheduledValues(t); g.gain.setValueAtTime(g.gain.value, t); g.gain.linearRampToValueAtTime(0, t + 0.03); o1.stop(t + 0.05); o2.stop(t + 0.05); } catch { /* already stopped */ }
    },
  };
  live.add(handle);
  o1.onended = () => live.delete(handle);
  return handle;
}

function click(when: number, accent: boolean) {
  const ac = audio();
  const o = ac.createOscillator(); const g = ac.createGain();
  o.frequency.value = accent ? 1500 : 1000;
  g.gain.setValueAtTime(0.25, when); g.gain.exponentialRampToValueAtTime(0.001, when + 0.04);
  o.connect(g); g.connect(master!); o.start(when); o.stop(when + 0.05);
}

// ---------------------------------------------------------------- transport

const LOOKAHEAD = 0.12;
let t0 = 0;           // audio time at which songBeat == startBeat
let startBeat = 0;    // clip beat where playback started
let scheduledTo = 0;  // song beat scheduled up to
let timer: any = null;
let stoppedBeat = 0;

function loopRange(): [number, number] {
  const s = getState();
  const end = s.clip.bars * BEATS_PER_BAR;
  // a selected time range is what plays (and loops), as in most piano rolls
  if (s.selRange) return [Math.max(0, s.selRange[0]), Math.max(s.selRange[0] + 0.25, s.selRange[1])];
  if (!s.loopOn) return [0, end];
  return [Math.max(0, s.clip.loop[0]), Math.min(end, s.clip.loop[1])];
}

/** Map a song beat (monotonic since play) to a clip beat. */
function wrap(song: number): number {
  const [a, b] = loopRange();
  const len = b - a;
  const st = getState();
  if ((!st.loopOn && !(st.selRange)) || len <= 0) return song;
  if (song < b) return song;
  return a + ((song - a) % len);
}

// Plugin build: tempo and position always come from the host project.
let hostBeat = 0;
const wrapPlugin = (b: number) => b; // the engine already reports the clip position
bridge.onHostTransport((t: { playing: boolean; beat: number; bpm: number }) => {
  hostBeat = wrapPlugin(t.beat);
  if (t.bpm && Math.abs(t.bpm - getState().clip.bpm) > 1e-3) editClip(c => ({ ...c, bpm: t.bpm }));
  if (t.playing !== getState().playing) setState({ playing: t.playing });
});

export function playheadBeat(): number {
  if (isPlugin) return hostBeat;
  if (!getState().playing || !ctx) return stoppedBeat;
  const bpm = getState().clip.bpm;
  const song = startBeat + Math.max(0, ctx.currentTime - t0) * bpm / 60;
  return wrap(song);
}

function tick() {
  const s = getState();
  if (!s.playing || !ctx) return;
  const bpm = s.clip.bpm;
  const nowSong = startBeat + (ctx.currentTime - t0) * bpm / 60;
  const horizon = nowSong + LOOKAHEAD * bpm / 60;
  const [la, lb] = loopRange();
  const len = lb - la;
  while (scheduledTo < horizon) {
    // split the window at loop boundaries
    const clipA = wrap(scheduledTo);
    const looping = s.loopOn || !!(s.selRange);
    const toBoundary = looping && len > 0 ? lb - clipA : Infinity;
    const segLen = Math.min(horizon - scheduledTo, toBoundary);
    if (segLen <= 1e-9) { scheduledTo += 1e-6; continue; }
    const clipB = clipA + segLen;
    const songOffset = scheduledTo - clipA;
    const timeOf = (clipBeat: number) => t0 + (clipBeat + songOffset - startBeat) * 60 / bpm;
    if (s.previewOn) {
      for (const n of visibleNotes()) {
        if (n.muted) continue;
        if (n.start >= clipA - 1e-9 && n.start < clipB - 1e-9) {
          const dur = looping ? Math.min(n.length, lb - n.start) : n.length;
          if (dur > 0) voice(n, Math.max(ctx.currentTime, timeOf(n.start)), dur, bpm, n.start);
        }
      }
    }
    if (s.metronome) {
      for (let b = Math.ceil(clipA - 1e-9); b < clipB - 1e-9; b++) click(timeOf(b), b % BEATS_PER_BAR === 0);
    }
    scheduledTo += segLen;
  }
  if (!s.loopOn && !(s.selRange) && nowSong >= s.clip.bars * BEATS_PER_BAR) { stop(0); }
}

export function play(fromBeat?: number) {
  const s = getState();
  if (isPlugin) {
    // the C++ engine plays; the host transport wins whenever the host is playing
    const [la, lb] = loopRange();
    let b = fromBeat ?? stoppedBeat;
    if ((s.loopOn || s.selRange) && (b < la || b >= lb)) b = la;
    bridge.transport('play', b, (s.loopOn || s.selRange) ? [la, lb] : null); setState({ playing: true });
    return;
  }
  const ac = audio();
  const [la, lb] = loopRange();
  let b = fromBeat ?? stoppedBeat;
  if ((s.loopOn || (s.selRange)) && (b < la || b >= lb)) b = la;
  startBeat = b; scheduledTo = b; t0 = ac.currentTime + 0.05;
  setState({ playing: true });
  bridge.transport('play', b);
  clearInterval(timer);
  timer = setInterval(tick, 25);
  tick();
}

export function stop(rewindTo?: number) {
  if (isPlugin) {
    const s = getState();
    stoppedBeat = rewindTo ?? (s.selRange ? s.selRange[0] : 0);
    bridge.transport('stop', stoppedBeat); setState({ playing: false });
    return;
  }
  const ac = ctx;
  if (ac) live.forEach(v => v.stop(ac.currentTime));
  live.clear();
  clearInterval(timer);
  const s = getState();
  stoppedBeat = rewindTo ?? (s.selRange ? s.selRange[0] : s.loopOn ? s.clip.loop[0] : 0);
  setState({ playing: false });
  bridge.transport('stop', stoppedBeat);
}

export function togglePlay() { getState().playing ? stop() : play(); }
export function seek(beat: number) {
  stoppedBeat = Math.max(0, beat);
  if (getState().playing) { stop(stoppedBeat); play(stoppedBeat); }
  bridge.transport('seek', beat);
}
/** Restart scheduling after the clip or tempo changed mid-play. */
export function retime() { if (getState().playing) { const b = playheadBeat(); stop(b); play(b); } }

export function audition(pitch: number, velocity = 0.8, beats = 0.5) {
  if (!getState().previewOn) return;
  if (isPlugin) { bridge.audition(pitch, velocity); return; }
  const ac = audio();
  const n: Note = { id: 'aud', pitch, start: 0, length: beats, velocity, bend: [], pressure: [] };
  voice(n, ac.currentTime + 0.01, beats, getState().clip.bpm, -1e9);
}

// ---------------------------------------------------------------- offline render

/**
 * Render the whole clip (bar 1 to its last bar, plus a short release tail) to
 * stereo audio with the built-in synth. The plugin build renders the hosted
 * synth on the C++ side instead.
 */
export async function renderClip(sampleRate = 44100): Promise<AudioBuffer> {
  const s = getState();
  const clip = s.clip;
  const bpm = clip.bpm;
  const clipBeats = clip.bars * BEATS_PER_BAR;
  const lastEnd = Math.max(0, ...clip.notes.filter(n => !n.muted).map(n => n.start + n.length));
  const secs = Math.max(clipBeats, lastEnd) * 60 / bpm + 1.0;
  const ac = new OfflineAudioContext(2, Math.ceil(secs * sampleRate), sampleRate);
  const comp = ac.createDynamicsCompressor(); comp.threshold.value = -14; comp.ratio.value = 4;
  const bus = ac.createGain(); bus.gain.value = 0.8;
  bus.connect(comp); comp.connect(ac.destination);
  for (const n of clip.notes) {
    if (n.muted) continue;
    voice(n, n.start * 60 / bpm, n.length, bpm, n.start, { ac, dest: bus });
  }
  return ac.startRendering();
}

/** 16-bit PCM WAV. */
export function encodeWav(buf: AudioBuffer): Uint8Array {
  const ch = buf.numberOfChannels, len = buf.length, rate = buf.sampleRate;
  const data = new DataView(new ArrayBuffer(44 + len * ch * 2));
  const w = (o: number, str: string) => { for (let i = 0; i < str.length; i++) data.setUint8(o + i, str.charCodeAt(i)); };
  w(0, 'RIFF'); data.setUint32(4, 36 + len * ch * 2, true); w(8, 'WAVE');
  w(12, 'fmt '); data.setUint32(16, 16, true); data.setUint16(20, 1, true); data.setUint16(22, ch, true);
  data.setUint32(24, rate, true); data.setUint32(28, rate * ch * 2, true); data.setUint16(32, ch * 2, true); data.setUint16(34, 16, true);
  w(36, 'data'); data.setUint32(40, len * ch * 2, true);
  const chans = Array.from({ length: ch }, (_, c) => buf.getChannelData(c));
  let o = 44;
  for (let i = 0; i < len; i++) for (let c = 0; c < ch; c++) {
    const v = Math.max(-1, Math.min(1, chans[c][i]));
    data.setInt16(o, v < 0 ? v * 0x8000 : v * 0x7fff, true); o += 2;
  }
  return new Uint8Array(data.buffer);
}

// Keyboard: a key sounds for as long as it is held.
let held: { stop: (t: number) => void } | undefined;
let heldPitch: number | null = null;
export function holdKey(pitch: number, velocity = 0.8) {
  releaseKey();
  if (!getState().previewOn) return;
  if (isPlugin) { bridge.keyDown(pitch, velocity); heldPitch = pitch; return; }
  const ac = audio();
  const n: Note = { id: 'key', pitch, start: 0, length: 64, velocity, bend: [], pressure: [] };
  held = voice(n, ac.currentTime + 0.005, 64, getState().clip.bpm, -1e9);
}
// a key never keeps sounding once the mouse is up, even if the release lands outside the roll
window.addEventListener('pointerup', () => { if (heldPitch !== null || held) releaseKey(); });
window.addEventListener('blur', () => { releaseKey(); if (isPlugin) bridge.keyUp(-1); });
export function releaseKey() {
  if (heldPitch !== null) { bridge.keyUp(heldPitch); heldPitch = null; }
  if (held && ctx) held.stop(ctx.currentTime + 0.05);
  held = undefined;
}
