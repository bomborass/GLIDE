// Standard MIDI File import. Reads notes from every track and channel, the
// first tempo, and — for MPE files — each note's own pitch bend and channel
// pressure, so a clip exported from SLIDE (or recorded on an MPE
// controller) comes back with its glides.
import { Clip, Note, PathPoint, newClip, makeNote, simplify, BEATS_PER_BAR } from './model';

interface Ev { tick: number; kind: 'on' | 'off' | 'bend' | 'press' | 'cc'; ch: number; a: number; b: number; trk: number }

export function parseMidi(bytes: Uint8Array, name: string): Clip {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const str = (o: number) => String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]);
  if (bytes.length < 14 || str(0) !== 'MThd') throw new Error('This is not a MIDI file.');
  const ntrk = dv.getUint16(10);
  const div = dv.getUint16(12);
  if (div & 0x8000) throw new Error('SMPTE-timed MIDI files are not supported.');
  const ppq = div || 480;
  let pos = 8 + dv.getUint32(4);
  const evs: Ev[] = [];
  let tempo: number | null = null;

  for (let t = 0; t < ntrk && pos + 8 <= bytes.length; t++) {
    if (str(pos) !== 'MTrk') { pos += 8 + dv.getUint32(pos + 4); continue; }
    const end = Math.min(bytes.length, pos + 8 + dv.getUint32(pos + 4));
    let p = pos + 8, tick = 0, status = 0;
    const vlq = () => { let v = 0, c; do { c = bytes[p++]; v = (v << 7) | (c & 0x7f); } while (c & 0x80 && p < end); return v; };
    while (p < end) {
      tick += vlq();
      let st = bytes[p];
      if (st & 0x80) { p++; status = st; } else st = status; // running status
      if (st === 0xff) { const type = bytes[p++]; const len = vlq(); if (type === 0x51 && len === 3 && tempo === null) tempo = 60_000_000 / ((bytes[p] << 16) | (bytes[p + 1] << 8) | bytes[p + 2]); p += len; continue; }
      if (st === 0xf0 || st === 0xf7) { p += vlq(); continue; }
      const type = st & 0xf0, ch = st & 0x0f;
      const d1 = bytes[p++];
      const d2 = type === 0xc0 || type === 0xd0 ? 0 : bytes[p++];
      if (type === 0x90 && d2 > 0) evs.push({ tick, kind: 'on', ch, a: d1, b: d2, trk: t });
      else if (type === 0x80 || type === 0x90) evs.push({ tick, kind: 'off', ch, a: d1, b: type === 0x80 ? d2 : 0, trk: t });
      else if (type === 0xe0) evs.push({ tick, kind: 'bend', ch, a: ((d2 << 7) | d1) - 8192, b: 0, trk: t });
      else if (type === 0xd0) evs.push({ tick, kind: 'press', ch, a: d1, b: 0, trk: t });
      else if (type === 0xb0) evs.push({ tick, kind: 'cc', ch, a: d1, b: d2, trk: t });
    }
    pos = end;
  }
  evs.sort((x, y) => x.tick - y.tick || (x.kind === 'off' ? -1 : 0) - (y.kind === 'off' ? -1 : 0));

  // per-channel pitch-bend range (RPN 0), default 48 for MPE-looking files, else 2
  const looksMpe = new Set(evs.filter(e => e.kind === 'on').map(e => e.ch)).size > 2;
  const range = new Map<number, number>();
  const rpn = new Map<number, [number, number]>();
  for (const e of evs) if (e.kind === 'cc') {
    const cur = rpn.get(e.ch) ?? [127, 127];
    if (e.a === 101) rpn.set(e.ch, [e.b, cur[1]]);
    else if (e.a === 100) rpn.set(e.ch, [cur[0], e.b]);
    else if (e.a === 6 && cur[0] === 0 && cur[1] === 0) range.set(e.ch, e.b);
  }
  const bendRange = (ch: number) => range.get(ch) ?? (looksMpe ? 48 : 2);

  const curBend = new Map<number, number>(), curPress = new Map<number, number>();
  const curCC = new Map<string, number>(); // `${ch}:${cc}` -> value
  const lanePts = new Map<string, { cc: number; pitch?: boolean; pts: { beat: number; v: number }[] }>();
  const isMaster = (ch: number) => looksMpe && ch === 0;
  const RPN_CCS = new Set([6, 38, 98, 99, 100, 101]);
  interface Open { n: Note; ch: number; on: number; bend: { tick: number; v: number }[]; press: { tick: number; v: number }[] }
  const open = new Map<string, Open[]>();
  const out: Note[] = [];
  const finish = (o: Open, offTick: number) => {
    const len = Math.max(1, offTick - o.on);
    o.n.length = len / ppq;
    const toPts = (arr: { tick: number; v: number }[], eps: number): PathPoint[] => {
      if (arr.length < 2 && !(arr.length === 1 && Math.abs(arr[0].v) > 0.01)) return [];
      const pts = arr.map(x => ({ t: Math.min(1, Math.max(0, (x.tick - o.on) / len)), v: x.v }));
      if (pts[pts.length - 1].t < 1) pts.push({ t: 1, v: pts[pts.length - 1].v });
      return simplify(pts, eps);
    };
    const bend = toPts(o.bend, 0.02);
    o.n.bend = bend.some(p => Math.abs(p.v) > 0.02) ? bend : [];
    o.n.pressure = o.press.length ? toPts(o.press, 0.008) : [];
    out.push(o.n);
  };
  for (const e of evs) {
    const key = `${e.trk}:${e.ch}:${e.a}`;
    if (e.kind === 'cc') {
      curCC.set(`${e.ch}:${e.a}`, e.b / 127);
      // master-channel controllers (or any channel in a plain MIDI file) become channel lanes;
      // per-note CC10/71/74 on MPE member channels become note properties
      const perNote = looksMpe && !isMaster(e.ch) && [10, 71, 74].includes(e.a);
      if (!RPN_CCS.has(e.a) && !perNote && (isMaster(e.ch) || !looksMpe)) {
        const k = 'cc' + e.a;
        (lanePts.get(k) ?? lanePts.set(k, { cc: e.a, pts: [] }).get(k)!).pts.push({ beat: e.tick / ppq, v: e.b / 127 });
      }
      continue;
    }
    if (e.kind === 'bend' && isMaster(e.ch)) {
      const k = 'pitch';
      const st = e.a / 8192 * (range.get(0) ?? 2);
      (lanePts.get(k) ?? lanePts.set(k, { cc: 0, pitch: true, pts: [] }).get(k)!).pts.push({ beat: e.tick / ppq, v: Math.max(0, Math.min(1, 0.5 + st / (2 * 2))) });
      continue;
    }
    if (e.kind === 'bend') {
      const v = e.a / 8192 * bendRange(e.ch);
      curBend.set(e.ch, v);
      open.forEach(list => list.forEach(o => { if (o.ch === e.ch) o.bend.push({ tick: e.tick, v }); }));
    } else if (e.kind === 'press') {
      curPress.set(e.ch, e.a / 127);
      open.forEach(list => list.forEach(o => { if (o.ch === e.ch) o.press.push({ tick: e.tick, v: e.a / 127 }); }));
    } else if (e.kind === 'on') {
      const n = makeNote(e.a, e.tick / ppq, 0.25, e.b / 127);
      if (looksMpe && !isMaster(e.ch)) {
        const pan = curCC.get(`${e.ch}:10`), cut = curCC.get(`${e.ch}:74`), res = curCC.get(`${e.ch}:71`);
        if (pan !== undefined) n.pan = Math.abs(pan - 0.5) < 0.01 ? 0 : pan * 2 - 1;
        if (cut !== undefined) n.cutoff = cut;
        if (res !== undefined) n.resonance = res;
      }
      const o: Open = { n, ch: e.ch, on: e.tick, bend: [{ tick: e.tick, v: curBend.get(e.ch) ?? 0 }], press: curPress.has(e.ch) ? [{ tick: e.tick, v: curPress.get(e.ch)! }] : [] };
      (open.get(key) ?? open.set(key, []).get(key)!).push(o);
    } else if (e.kind === 'off') {
      const list = open.get(key);
      const o = list?.shift();
      if (o) { if (e.b > 0 && e.b !== 64) o.n.release = e.b / 127; finish(o, e.tick); }
    }
  }
  // notes never switched off end at the last event
  const lastTick = evs.length ? evs[evs.length - 1].tick : 0;
  open.forEach(list => list.forEach(o => finish(o, Math.max(lastTick, o.on + ppq / 4))));

  if (!out.length) throw new Error('No notes found in this MIDI file.');
  const clip = newClip(name.replace(/\.(mid|midi)$/i, '') || 'Imported');
  const minStart = Math.min(...out.map(n => n.start));
  // shift so the first bar with notes is bar 1
  const shift = Math.floor(minStart / BEATS_PER_BAR) * BEATS_PER_BAR;
  out.forEach(n => { n.start -= shift; });
  const endBeat = Math.max(...out.map(n => n.start + n.length));
  clip.bars = Math.max(1, Math.ceil(endBeat / BEATS_PER_BAR - 1e-6));
  clip.loop = [0, clip.bars * BEATS_PER_BAR];
  if (tempo) clip.bpm = Math.min(300, Math.max(30, Math.round(tempo)));
  clip.notes = out.sort((a, b) => a.start - b.start || b.pitch - a.pitch);
  // channel lanes, shifted like the notes and thinned to the changes
  lanePts.forEach(l => {
    const pts = l.pts.map(p => ({ beat: Math.max(0, p.beat - shift), v: p.v })).filter((p, i, a) => i === 0 || p.v !== a[i - 1].v || i === a.length - 1);
    if (pts.length < 2 && pts.every(p => Math.abs(p.v - (l.pitch ? 0.5 : -1)) < 1e-3)) return;
    const id = l.pitch ? 'pitch' : 'cc' + l.cc;
    const existing = clip.cc.find(c => (c.kind === 'pitch' ? 'pitch' : 'cc' + c.cc) === id);
    const points = pts.map(p => ({ beat: p.beat, v: p.v, c: 'linear' as const }));
    if (existing) existing.points = points; else clip.cc.push({ cc: l.cc, points });
  });
  return clip;
}
