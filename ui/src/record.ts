// Record from a connected MIDI controller (Web MIDI in the browser build; the
// plugin build records from the host's MIDI input on the C++ side).
// Captures notes plus per-channel pitch bend and pressure, so recording from
// an MPE controller keeps its expression.
import { Note, PathPoint, makeNote, simplify } from './model';
import { getState, editNotes, editClip, checkpoint, flash, setState } from './store';
import { bridge, isPlugin } from './bridge';
import { laneId, laneName, CCLane } from './model';
import { playheadBeat } from './audio';

interface Held { note: Note; bend: { beat: number; v: number }[]; pres: { beat: number; v: number }[]; ch: number }

let access: any = null;
const held = new Map<string, Held>();
const chanBend = new Map<number, number>();
const chanPres = new Map<number, number>();
let checkpointed = false;

export async function armRecording(on: boolean) {
  if (!on) { setState({ recording: false }); return; }
  if (isPlugin) {
    // in the plugin, knob moves on the loaded synth are recorded into lanes
    checkpointed = false; recPass.clear();
    setState({ recording: true });
    flash('Recording synth knob moves · press play in FL and turn knobs on your synth');
    return;
  }
  if (!access) {
    if (!(navigator as any).requestMIDIAccess) { flash('No MIDI input available in this browser'); return; }
    try { access = await (navigator as any).requestMIDIAccess(); } catch { flash('MIDI access was not granted'); return; }
    const hook = () => access.inputs.forEach((inp: any) => { inp.onmidimessage = onMsg; });
    hook(); access.onstatechange = hook;
  }
  checkpointed = false;
  recPass.clear();
  setState({ recording: true });
  flash(access.inputs.size ? 'Recording armed · press play and perform' : 'Recording armed · connect a MIDI controller');
}

function onMsg(e: { data: Uint8Array }) {
  const s = getState();
  if (!s.recording || !s.playing) return;
  const [st, d1, d2] = e.data;
  const type = st & 0xf0, ch = st & 0x0f;
  const beat = playheadBeat();
  const range = s.clip.range;
  if (type === 0x90 && d2 > 0) {
    const n = makeNote(d1, beat, 0.01, d2 / 127);
    held.set(`${ch}:${d1}`, { note: n, ch, bend: [{ beat, v: chanBend.get(ch) ?? 0 }], pres: [{ beat, v: chanPres.get(ch) ?? d2 / 127 }] });
  } else if (type === 0x80 || (type === 0x90 && d2 === 0)) {
    const h = held.get(`${ch}:${d1}`); if (!h) return;
    held.delete(`${ch}:${d1}`);
    const len = Math.max(0.05, beat - h.note.start);
    const toPts = (arr: { beat: number; v: number }[], eps: number): PathPoint[] =>
      arr.length > 1 ? simplify(arr.map(p => ({ t: Math.min(1, (p.beat - h.note.start) / len), v: p.v })), eps) : [];
    const bend = toPts(h.bend, 0.03);
    const note: Note = { ...h.note, length: len, bend: bend.some(p => Math.abs(p.v) > 0.02) ? bend : [], pressure: toPts(h.pres, 0.01) };
    if (!checkpointed) { checkpoint(); checkpointed = true; }
    editNotes(ns => [...ns, note]);
  } else if (type === 0xe0) {
    const v = (((d2 << 7) | d1) - 8192) / 8192 * range;
    chanBend.set(ch, v);
    held.forEach(h => { if (h.ch === ch) h.bend.push({ beat, v }); });
  } else if (type === 0xb0 && ![6, 38, 98, 99, 100, 101].includes(d1)) {
    recordLane({ cc: d1, points: [] }, beat, d2 / 127);
  } else if (type === 0xd0) {
    chanPres.set(ch, d1 / 127);
    held.forEach(h => { if (h.ch === ch) h.pres.push({ beat, v: d1 / 127 }); });
  }
}

/**
 * Knob moves while recording land in a channel lane. A controller (or, in the
 * plugin, a hosted synth parameter) that has no lane yet gets one, which then
 * shows up under Control ▸ Channel controls.
 */
function recordLane(template: CCLane, beat: number, v: number) {
  if (!checkpointed) { checkpoint(); checkpointed = true; }
  const id = laneId(template);
  const last = recPass.get(id);
  if (last !== undefined && beat < last) recPass.delete(id); // loop wrapped: new pass
  const exists = getState().clip.cc.some(l => laneId(l) === id);
  editClip(c => {
    const lanes = exists ? c.cc : [...c.cc, template];
    return {
      ...c, cc: lanes.map(l => {
        if (laneId(l) !== id) return l;
        // replace points this pass overwrites, keep the rest
        const pts = l.points.filter(p => Math.abs(p.beat - beat) > 1 / 64 && !(recPass.get(id) !== undefined && p.beat > recPass.get(id)! && p.beat < beat));
        pts.push({ beat, v, c: 'linear' });
        recPass.set(id, beat);
        return { ...l, points: pts.sort((a, b) => a.beat - b.beat) };
      }),
    };
  });
  if (!exists) flash(`Recording ${laneName(template)} · find it under Control ▸ Channel controls`);
}
const recPass = new Map<string, number>();

// plugin build: the engine reports hosted-synth knob moves while recording
bridge.onParamChanged(p => {
  const s = getState();
  if (!s.recording || !s.playing) return;
  recordLane({ cc: -1, kind: 'param', param: p.id, name: p.name, points: [] }, playheadBeat(), p.value);
});
