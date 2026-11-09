// MPE Standard MIDI File export.
// Lower zone: channel 1 is the master channel, channels 2–16 are member
// channels, one per sounding note. Every member channel gets an RPN 0
// pitch-bend sensitivity message matching RANGE, and the master gets the
// MPE Configuration Message (RPN 6). Each note carries its own dense
// pitch-bend and channel-pressure stream.
import { Clip, Note, bendAt, pressureAt, evalCC, clamp, MASTER_BEND_RANGE, PressureAs } from './model';
import type { ExportFormat } from './store';
import { bridge, isPlugin, toBase64 } from './bridge';

const PPQ = 480;
const STEP = 10; // ticks between expression samples (~10 ms at 120 bpm)

interface Ev { tick: number; order: number; bytes: number[] }

function vlq(n: number): number[] {
  const out = [n & 0x7f];
  while ((n >>= 7)) out.unshift((n & 0x7f) | 0x80);
  return out;
}
const str = (s: string) => Array.from(s).map(c => c.charCodeAt(0));
const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const u16 = (n: number) => [(n >>> 8) & 255, n & 255];

function track(events: Ev[]): number[] {
  events.sort((a, b) => a.tick - b.tick || a.order - b.order);
  const data: number[] = [];
  let last = 0;
  for (const e of events) { data.push(...vlq(Math.max(0, e.tick - last)), ...e.bytes); last = e.tick; }
  data.push(0, 0xff, 0x2f, 0);
  return [...str('MTrk'), ...u32(data.length), ...data];
}

const bendValue = (st: number, range: number) => clamp(Math.round(8192 + (st / range) * 8192), 0, 16383);

export function exportMidi(clip: Clip, format: ExportFormat): Uint8Array {
  const range = format === 'ableton' ? 48 : clip.range;
  const meta: Ev[] = [];
  const usPerBeat = Math.round(60_000_000 / clip.bpm);
  meta.push({ tick: 0, order: 0, bytes: [0xff, 0x51, 3, (usPerBeat >> 16) & 255, (usPerBeat >> 8) & 255, usPerBeat & 255] });
  meta.push({ tick: 0, order: 0, bytes: [0xff, 0x58, 4, 4, 2, 24, 8] });
  meta.push({ tick: 0, order: 0, bytes: [0xff, 0x03, ...vlq(clip.name.length), ...str(clip.name)] });

  const ev: Ev[] = [];
  const cc = (ch: number, n: number, v: number, tick = 0, order = 0) => ev.push({ tick, order, bytes: [0xb0 | ch, n, v] });
  const mono = format === 'mono';
  const memberChannels = mono ? [0] : Array.from({ length: 15 }, (_, i) => i + 1);

  if (!mono) {
    // MPE Configuration Message on master channel: 15 member channels
    cc(0, 101, 0); cc(0, 100, 6); cc(0, 6, 15); cc(0, 101, 127); cc(0, 100, 127);
    // master channel bend range for the channel pitch lane
    cc(0, 101, 0); cc(0, 100, 0); cc(0, 6, MASTER_BEND_RANGE); cc(0, 101, 127); cc(0, 100, 127);
  }
  for (const ch of memberChannels) {
    cc(ch, 101, 0); cc(ch, 100, 0); cc(ch, 6, Math.min(127, range)); cc(ch, 101, 127); cc(ch, 100, 127);
  }

  // channel allocation: round-robin over free member channels
  const notes = clip.notes.filter(n => !n.muted).sort((a, b) => a.start - b.start);
  const busyUntil = new Map<number, number>();
  let rr = 0;
  const toTick = (b: number) => Math.round(b * PPQ);
  for (const n of notes) {
    let ch = memberChannels[0];
    if (!mono) {
      for (let k = 0; k < memberChannels.length; k++) {
        const c = memberChannels[(rr + k) % memberChannels.length];
        if ((busyUntil.get(c) ?? -1) <= n.start + 1e-6) { ch = c; rr = (rr + k + 1) % memberChannels.length; break; }
        if (k === memberChannels.length - 1) { ch = memberChannels[rr]; rr = (rr + 1) % memberChannels.length; }
      }
      busyUntil.set(ch, n.start + n.length);
    }
    writeNote(ev, n, ch, range, toTick, clip.pressureAs);
  }

  // clip-wide channel lanes on the master channel (synth-parameter lanes stay in the plugin)
  for (const lane of clip.cc) {
    if (!lane.points.length || lane.kind === 'param') continue;
    if (lane.kind === 'pitch' && mono) continue;
    const endTick = toTick(clip.bars * 4);
    let prev = -1;
    for (let t = 0; t <= endTick; t += STEP * 2) {
      const v = evalCC(lane.points, t / PPQ);
      if (v === null) continue;
      if (lane.kind === 'pitch') {
        const b = bendValue((v - 0.5) * 2 * MASTER_BEND_RANGE, MASTER_BEND_RANGE);
        if (b !== prev) { ev.push({ tick: t, order: 1, bytes: [0xe0, b & 0x7f, b >> 7] }); prev = b; }
        continue;
      }
      const val = clamp(Math.round(v * 127), 0, 127);
      if (val !== prev) { cc(0, lane.cc, val, t, 1); prev = val; }
    }
  }

  const header = [...str('MThd'), ...u32(6), ...u16(1), ...u16(2), ...u16(PPQ)];
  return new Uint8Array([...header, ...track(meta), ...track(ev)]);
}

function writeNote(ev: Ev[], n: Note, ch: number, range: number, toTick: (b: number) => number, pressureAs: PressureAs = 'pressure') {
  const on = toTick(n.start), off = toTick(n.start + n.length);
  const vel = clamp(Math.round(n.velocity * 127), 1, 127);
  const relVel = clamp(Math.round((n.release ?? 0.5) * 127), 0, 127);
  const fine = n.fine ?? 0;
  const bendSt = (x: number) => bendAt(n, x) + fine;
  const pb = (tick: number, st: number, order: number) => { const v = bendValue(st, range); ev.push({ tick, order, bytes: [0xe0 | ch, v & 0x7f, v >> 7] }); };
  const cp = (tick: number, p: number, order: number) => {
    const v = clamp(Math.round(p * 127), 0, 127);
    const cc = { cc74: 74, cc11: 11, cc1: 1 } as Record<string, number>;
    ev.push({ tick, order, bytes: pressureAs === 'polyAT' ? [0xa0 | ch, n.pitch, v] : cc[pressureAs] ? [0xb0 | ch, cc[pressureAs], v] : [0xd0 | ch, v] });
  };
  const ccv = (num: number, v: number) => ev.push({ tick: on, order: 2, bytes: [0xb0 | ch, num, clamp(Math.round(v * 127), 0, 127)] });
  // per-note controllers and initial expression go before the note-on
  if (n.pan !== undefined) ccv(10, (n.pan + 1) / 2);
  if (n.cutoff !== undefined) ccv(74, n.cutoff);
  if (n.resonance !== undefined) ccv(71, n.resonance);
  pb(on, bendSt(0), 2);
  cp(on, pressureAt(n, 0), 2);
  // note repeat: re-strike the note `reps` times inside its length
  const reps = Math.max(1, n.repeat ?? 1);
  for (let r = 0; r < reps; r++) {
    const a = on + Math.round((off - on) * r / reps), b = on + Math.round((off - on) * (r + 1) / reps);
    ev.push({ tick: a, order: 3, bytes: [0x90 | ch, n.pitch, vel] });
    ev.push({ tick: b, order: 1, bytes: [0x80 | ch, n.pitch, relVel] }); // note-offs sort before new note-ons
  }
  let lastB = bendValue(bendSt(0), range), lastP = Math.round(pressureAt(n, 0) * 127);
  for (let t = on + STEP; t < off; t += STEP) {
    const x = (t - on) / Math.max(1, off - on);
    const b = bendValue(bendSt(x), range);
    if (b !== lastB) { pb(t, bendSt(x), 4); lastB = b; }
    const p = Math.round(pressureAt(n, x) * 127);
    if (p !== lastP) { cp(t, pressureAt(n, x), 4); lastP = p; }
  }
}

// CRC32 + a store-only zip, used where the viewer only accepts certain file types.
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(b: Uint8Array) { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
export function zipOne(name: string, data: Uint8Array): Uint8Array {
  const nm = new TextEncoder().encode(name);
  const crc = crc32(data);
  const le16 = (n: number) => [n & 255, (n >> 8) & 255];
  const le32 = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
  const local = [...le32(0x04034b50), ...le16(20), ...le16(0), ...le16(0), ...le16(0), ...le16(0x21), ...le32(crc), ...le32(data.length), ...le32(data.length), ...le16(nm.length), ...le16(0), ...nm];
  const central = [...le32(0x02014b50), ...le16(20), ...le16(20), ...le16(0), ...le16(0), ...le16(0), ...le16(0x21), ...le32(crc), ...le32(data.length), ...le32(data.length), ...le16(nm.length), ...le16(0), ...le16(0), ...le16(0), ...le16(0), ...le32(0), ...le32(0), ...nm];
  const off = local.length + data.length;
  const end = [...le32(0x06054b50), ...le16(0), ...le16(0), ...le16(1), ...le16(1), ...le32(central.length), ...le32(off), ...le16(0)];
  const out = new Uint8Array(off + central.length + end.length);
  out.set(local, 0); out.set(data, local.length); out.set(central, off); out.set(end, off + central.length);
  return out;
}

/** Save the clip as .mid. Returns a short status line for the footer. */
export async function downloadMidi(clip: Clip, format: ExportFormat): Promise<string> {
  const bytes = exportMidi(clip, format);
  const base = clip.name.replace(/[^\w\- ]+/g, '') || 'clip';
  if (isPlugin) { bridge.saveFile(`${base}.mid`, toBase64(bytes)); return 'Choose where to save the MIDI file'; }
  const host = (window as any).claude;
  if (host?.use) {
    // Hosted page: files go through the viewer's save prompt, which takes .zip but not .mid.
    const dl = await host.use('downloads');
    if (!dl) return 'Saving files is not available in this view';
    try { await dl.save({ filename: `${base} MIDI.zip`, data: zipOne(`${base}.mid`, bytes) }); return `Saved ${base}.mid (zipped)`; }
    catch (e: any) { return e?.code === 'declined' ? 'Export cancelled' : 'Could not save the file here'; }
  }
  const blob = new Blob([bytes], { type: 'audio/midi' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `${base}.mid`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  return `Exported ${base}.mid`;
}
