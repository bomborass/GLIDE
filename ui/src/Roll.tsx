// The piano roll: one canvas for keyboard, ruler, grid, notes, pitch paths,
// pressure ribbons and the bottom event panel (note properties and channel
// lanes). React only owns the small overlays.
import React, { useEffect, useRef, useState } from 'react';
import {
  BEATS_PER_BAR, Note, PathPoint, mergeGlides, bendAt, pressureAt, clamp, isBlack, noteName, makeNote, sortPts, simplify, evalCC, CCPoint, uid,
  gridStep, gridLabel, sliceAt, NOTE_PROPS, NoteProp, getProp, setProp, propText, laneId, laneName, laneBipolar, laneDefault, CCLane,
} from './model';
import {
  getState, setState, subscribe, editNotes, editClip, checkpoint, visibleNotes, flash, useStore,
} from './store';
import { playheadBeat, seek, audition, retime, holdKey, releaseKey } from './audio';
import { ITarget } from './icons';
import { liveNotes, getLive, phraseTime, soundingPitches } from './live';

export const KEY_W = 74;
export const RULER_H = 44;
let ROW_H = 16;            // note row height; changes with vertical zoom
let DPR = 1, PX = 1;       // device pixel ratio and one device pixel in CSS units
const snapPx = (v: number) => Math.round(v * DPR) / DPR;
export const PANEL_HEAD = 10;   // the thin divider band above the bottom panel
const LABEL_ROW = 26;           // "Control ▸  Lane" row at the top of the panel
const EDGE = 6;
const DOT_R = 4;

// SLIDE palette, measured pixel by pixel from the reference screenshot.
const C = {
  bg: '#29363d', rowBlack: '#233037', rowWhite: '#29363d', rowC: '#384147', rowLine: '#1f2c33', octave: '#1d2a31',
  sub: '#1f2c33', beat: '#17242b', bar: '#051219', dim: 'rgba(4,10,13,0.32)',
  // notes: border, body gradient, edge highlights, velocity bar
  note: '#a7d7af', noteBorder: '#6e9373', noteBodyTop: '#addeb5', noteBodyBot: '#a1d0a9', noteHiTop: '#c1f4c8', noteHiSide: '#b6e9bd',
  noteHiBot: '#9ccfa3', noteShadow: '#1b262c', velOn: '#5d8e65', velOff: '#91c199', label: '#40633d',
  noteSel: '#e58f8f', noteMuted: '#7a8589', noteMutedBorder: '#555f63',
  // selected notes: the same block in red
  sBorder: '#9d5959', sBodyTop: '#e58f8f', sBodyBot: '#db8485', sHiTop: '#fc9c9c', sHiSide: '#f09190', sHiBot: '#de7e7e',
  sVelOn: '#994243', sVelOff: '#cd7677', sShadow: '#272a31', sLabel: '#fcf2f2',
  // selected time range: lighter grey grid and a red ruler bar
  rgWhite: '#373b42', rgC: '#44484f', rgBlack: '#31353c', rgLine: '#2d3138', rgSub: '#272b32', rgBeat: '#1f232a', rgBar: '#191d24',
  rbTop: '#c27a7c', rbA: '#9f5759', rbB: '#954e4f', rbLow: '#b36b6d', rbEdge: '#412c2f',
  accent: '#ff7043', accentFill: 'rgba(255,112,67,0.15)', accentFillSel: 'rgba(255,112,67,0.24)',
  blue: '#58c7e3', lane: '#a9bcff', laneFill: 'rgba(169,188,255,0.12)',
  ruler: '#131c20', rulerText: '#889195', tick: '#2f3a40', keyLine: '#a6a9af', keyOct: '#8b8e94', keyWhite: '#bec2c9', keyC: '#9fa3aa', keyText: '#2e3239',
  keyBlackA: '#292a2c', keyBlackB: '#4f5052', edge: '#10171a',
  pressed: '#e59450', highlight: 'rgba(229,148,80,0.55)', dotFill: '#f4efe6',
  panel: '#32393c', panelRow: '#29363d', panelLine: '#10171a', stem: '#a7d7af',
};

type Drag =
  | { kind: 'move'; x0: number; y0: number; orig: Note[]; moved: boolean; dup: boolean; range0?: [number, number] | null }
  | { kind: 'resizeL' | 'resizeR'; x0: number; orig: Note[] }
  | { kind: 'marquee'; x0: number; y0: number; x1: number; y1: number; base: string[] }
  | { kind: 'erase' }
  | { kind: 'drawNote'; id: string; start: number; samples: { beat: number; st: number }[] }
  | { kind: 'bendDot'; id: string; index: number }
  | { kind: 'bendDraw'; id: string; samples: PathPoint[] }
  | { kind: 'pressDot'; id: string; index: number }
  | { kind: 'pressDraw'; id: string; samples: PathPoint[] }
  | { kind: 'ccDot'; lane: string; index: number }
  | { kind: 'paint'; prop: NoteProp; lastX: number }
  | { kind: 'slice'; x0: number; y0: number; x1: number; y1: number }
  | { kind: 'panel'; y0: number; h0: number }
  | { kind: 'keys' }
  | { kind: 'loop'; a: number; moved: boolean; x0: number }
  | { kind: 'rangeEnd' }
  | { kind: 'pan'; x0: number; y0: number; sx: number; sy: number };

let clipboard: Note[] = [];

export function Roll() {
  const wrap = useRef<HTMLDivElement>(null);
  const cv = useRef<HTMLCanvasElement>(null);
  const view = useRef({ ppb: 30, sx: 0, sy: 0, w: 800, h: 600, init: false });
  // smooth zoom/scroll: the wheel moves a target and each frame eases towards it
  const target = useRef<{ ppb: number; sx: number; sy: number; row: number; ax: { x: number; beat: number } | null; ay: { y: number; pitch: number } | null } | null>(null);
  const drag = useRef<Drag | null>(null);
  const hover = useRef<{ x: number; y: number; id: string | null }>({ x: -1, y: -1, id: null });
  const dirty = useRef(true);
  const lastLen = useRef(1);
  const pressed = useRef<number | null>(null);
  const created = useRef<{ id: string; at: number } | null>(null);
  const [tip, setTip] = useState<{ x: number; y: number; text: string } | null>(null);
  const follow = useStore(s => s.follow);
  const panelHState = useStore(s => s.panelH);
  const laneKey = useStore(s => s.lane);
  const lanes = useStore(s => s.clip.cc);
  const snap = useStore(s => s.snap);
  const [height, setHeight] = useState(600);
  const [laneMenu, setLaneMenu] = useState(false);

  // ---------------------------------------------------------------- geometry
  const v = view.current;
  const panelH = () => clamp(getState().panelH, PANEL_HEAD + LABEL_ROW, Math.max(PANEL_HEAD + LABEL_ROW, v.h - RULER_H - 80));
  const gridBottom = () => v.h - panelH();
  const laneTop = () => gridBottom() + PANEL_HEAD + LABEL_ROW;
  const laneBot = () => v.h - 8;
  const laneY = (val: number) => laneTop() + (1 - val) * (laneBot() - laneTop());
  const laneVal = (y: number) => clamp(1 - (y - laneTop()) / Math.max(1, laneBot() - laneTop()), 0, 1);
  const curLane = (): { prop?: NoteProp; lane?: CCLane } => {
    const s = getState();
    const prop = NOTE_PROPS.find(p => p.key === s.lane)?.key;
    if (prop) return { prop };
    const lane = s.clip.cc.find(l => laneId(l) === s.lane);
    return lane ? { lane } : { prop: 'velocity' };
  };
  const bx = (b: number) => KEY_W + (b - v.sx) * v.ppb;
  const xb = (x: number) => (x - KEY_W) / v.ppb + v.sx;
  // whole-pixel row edges so notes and rows stay crisp at any zoom
  const rowTop = (p: number) => snapPx(RULER_H + (127 - p) * ROW_H - v.sy);
  const rowHt = (p: number) => rowTop(p - 1) - rowTop(p);
  const cy = (p: number) => rowTop(p) + ROW_H / 2;
  const yPitch = (y: number) => 127 - Math.floor((y - RULER_H + v.sy) / ROW_H);
  const yPitchF = (y: number) => 127 - ((y - RULER_H + v.sy) / ROW_H - 0.5);
  // the grid follows the zoom level and snapping always uses the grid you see
  const step = () => gridStep(v.ppb);
  const syncGrid = () => { const g = step(); if (getState().snap !== g) setState({ snap: g }); };
  const snapB = (b: number, ev?: { metaKey: boolean; ctrlKey: boolean }) => {
    if (ev && (ev.metaKey || ev.ctrlKey)) return b;
    const g = step();
    return Math.round(b / g) * g;
  };
  const floorB = (b: number) => { const g = step(); return Math.floor(b / g + 1e-6) * g; };
  const ribbonScale = () => (getState().tool === 'pressure' ? ROW_H * 0.9 : ROW_H * 0.36);
  const ribbonH = (p: number) => 1.5 + p * ribbonScale();
  const clampScroll = () => {
    const maxY = 128 * ROW_H - (gridBottom() - RULER_H);
    v.sy = clamp(v.sy, 0, Math.max(0, maxY));
    v.sx = Math.max(0, v.sx);
    // direct moves (drag-pan, follow, resize) cancel any easing in flight
    target.current = null;
  };
  const tgt = () => target.current ?? (target.current = { ppb: v.ppb, sx: v.sx, sy: v.sy, row: ROW_H, ax: null, ay: null });
  /** One animation step towards the wheel target. Returns true while moving. */
  const ease = () => {
    const t = target.current; if (!t) return false;
    const k = 0.32;
    let moving = false;
    const lp = (a: number, b: number, eps: number) => { if (Math.abs(b - a) < eps) return b; moving = true; return a + (b - a) * k; };
    v.ppb = Math.exp(lp(Math.log(v.ppb), Math.log(t.ppb), 1e-4));
    ROW_H = Math.exp(lp(Math.log(ROW_H), Math.log(t.row), 1e-4));
    if (t.ax) v.sx = t.ax.beat - (t.ax.x - KEY_W) / v.ppb; else v.sx = lp(v.sx, t.sx, 1e-4);
    if (t.ay) v.sy = (127 - t.ay.pitch) * ROW_H - (t.ay.y - RULER_H); else v.sy = lp(v.sy, t.sy, 0.05);
    const maxY = 128 * ROW_H - (gridBottom() - RULER_H);
    v.sy = clamp(v.sy, 0, Math.max(0, maxY)); v.sx = Math.max(0, v.sx);
    if (!moving) { if (t.ax) t.sx = v.sx; if (t.ay) t.sy = v.sy; target.current = null; }
    return moving;
  };

  // ---------------------------------------------------------------- hit tests
  function noteAt(x: number, y: number): { n: Note; part: 'body' | 'l' | 'r' } | null {
    const notes = visibleNotes();
    const sel = new Set(getState().selection);
    // selected notes first so they win when overlapping
    const ordered = [...notes].sort((a, b) => Number(sel.has(b.id)) - Number(sel.has(a.id)));
    for (const n of ordered) {
      const x0 = bx(n.start), x1 = bx(n.start + n.length), t = rowTop(n.pitch);
      if (x >= x0 - 2 && x <= x1 + 2 && y >= t && y <= t + ROW_H) {
        if (x1 - x0 > EDGE * 3) {
          if (x < x0 + EDGE) return { n, part: 'l' };
          if (x > x1 - EDGE) return { n, part: 'r' };
        }
        return { n, part: 'body' };
      }
    }
    return null;
  }
  /** Note whose pitch path passes near (x,y), or whose body is under it. */
  function pathNoteAt(x: number, y: number): Note | null {
    const notes = visibleNotes();
    const sel = new Set(getState().selection);
    let best: Note | null = null, bd = 10;
    for (const n of notes) {
      const x0 = bx(n.start), x1 = bx(n.start + n.length);
      if (x < x0 - 3 || x > x1 + 3) continue;
      const t = clamp((x - x0) / (x1 - x0), 0, 1);
      const py = cy(n.pitch) - bendAt(n, t) * ROW_H;
      const d = Math.min(Math.abs(py - y), Math.abs(cy(n.pitch) - y)) - (sel.has(n.id) ? 2 : 0);
      if (d < bd) { bd = d; best = n; }
    }
    return best;
  }
  function bendDotAt(x: number, y: number): { n: Note; i: number } | null {
    const sel = new Set(getState().selection);
    for (const n of visibleNotes()) {
      if (!sel.has(n.id) && hover.current.id !== n.id) continue;
      for (let i = 0; i < n.bend.length; i++) {
        const p = n.bend[i];
        const dx = bx(n.start + p.t * n.length) - x, dy = cy(n.pitch) - p.v * ROW_H - y;
        if (dx * dx + dy * dy < 49) return { n, i };
      }
    }
    return null;
  }
  function pressDotAt(x: number, y: number): { n: Note; i: number } | null {
    for (const n of visibleNotes()) {
      for (let i = 0; i < n.pressure.length; i++) {
        const p = n.pressure[i];
        const dx = bx(n.start + p.t * n.length) - x, dy = cy(n.pitch) - ribbonH(p.v) - y;
        if (dx * dx + dy * dy < 49) return { n, i };
      }
    }
    return null;
  }
  function ccDotAt(x: number, y: number): number {
    const lane = curLane().lane; if (!lane) return -1;
    for (let i = 0; i < lane.points.length; i++) {
      const p = lane.points[i];
      const dx = bx(p.beat) - x, dy = laneY(p.v) - y;
      if (dx * dx + dy * dy < 49) return i;
    }
    return -1;
  }

  // ---------------------------------------------------------------- drawing
  function draw() {
    const canvas = cv.current; if (!canvas) return;
    const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true }) as CanvasRenderingContext2D;
    const dpr = window.devicePixelRatio || 1;
    DPR = dpr; PX = 1 / dpr;
    const { w, h } = v;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const s = getState();
    const clip = s.clip;
    const tool = s.tool;
    const gb = gridBottom();
    const clipEnd = clip.bars * BEATS_PER_BAR;
    const sel = new Set(s.selection);
    const notes = visibleNotes();
    if (s.preview) {
      // notes created by a popup preview (e.g. Connect) render as selected
      const real = new Set(clip.notes.map(n => n.id));
      for (const n of s.preview) if (!real.has(n.id)) sel.add(n.id);
    }

    ctx.fillStyle = C.bg; ctx.fillRect(0, 0, w, h);

    // ---- grid area
    ctx.save();
    ctx.beginPath(); ctx.rect(KEY_W, RULER_H, w - KEY_W, gb - RULER_H); ctx.clip();
    const pTop = clamp(yPitch(RULER_H), 0, 127), pBot = clamp(yPitch(gb), 0, 127);
    for (let p = pBot; p <= pTop; p++) {
      const t = rowTop(p);
      const rh = rowHt(p);
      ctx.fillStyle = p % 12 === 0 ? C.rowC : isBlack(p) ? C.rowBlack : C.rowWhite;
      ctx.fillRect(KEY_W, t, w - KEY_W, rh);
      ctx.fillStyle = (p % 12 === 0) ? C.octave : C.rowLine;
      ctx.fillRect(KEY_W, t + rh - PX, w - KEY_W, PX);
    }
    // vertical lines
    drawVLines(ctx, RULER_H, gb);
    // selected time range: same grid, lighter grey
    const range = s.selRange;
    if (range) {
      const ra = Math.max(KEY_W, snapPx(bx(range[0]))), rb = Math.min(w, snapPx(bx(range[1])));
      if (rb > ra) {
        ctx.save(); ctx.beginPath(); ctx.rect(ra, RULER_H, rb - ra, gb - RULER_H); ctx.clip();
        for (let p = pBot; p <= pTop; p++) {
          const t = rowTop(p), rh = rowHt(p);
          ctx.fillStyle = p % 12 === 0 ? C.rgC : isBlack(p) ? C.rgBlack : C.rgWhite; ctx.fillRect(ra, t, rb - ra, rh);
          ctx.fillStyle = C.rgLine; ctx.fillRect(ra, t + rh - PX, rb - ra, PX);
        }
        drawVLines(ctx, RULER_H, gb, { sub: C.rgSub, beat: C.rgBeat, bar: C.rgBar });
        ctx.restore();
      }
    }
    // beyond clip end
    if (bx(clipEnd) < w) { ctx.fillStyle = C.dim; ctx.fillRect(Math.max(KEY_W, bx(clipEnd)), RULER_H, w, gb - RULER_H); }

    // ---- notes: fills under pitch paths first, then bodies, then paths
    const visible = notes.filter(n => bx(n.start + n.length) >= KEY_W - 4 && bx(n.start) <= w + 4);
    const showFill = (n: Note) => n.bend.length > 0 && (sel.has(n.id) || tool === 'pitch');
    for (const n of visible) {
      if (!showFill(n)) continue;
      const x0 = bx(n.start), x1 = bx(n.start + n.length), yc = cy(n.pitch);
      ctx.beginPath(); ctx.moveTo(x0, yc);
      for (let x = x0; x <= x1; x += 1.5) ctx.lineTo(x, yc - bendAt(n, (x - x0) / (x1 - x0)) * ROW_H);
      ctx.lineTo(x1, yc - bendAt(n, 1) * ROW_H); ctx.lineTo(x1, yc); ctx.closePath();
      ctx.fillStyle = sel.has(n.id) ? C.accentFillSel : C.accentFill; ctx.fill();
    }
    for (const n of visible) drawBody(ctx, n, sel.has(n.id), tool);
    for (const n of visible) {
      if (!n.bend.length) continue;
      const x0 = bx(n.start), x1 = bx(n.start + n.length), yc = cy(n.pitch);
      ctx.beginPath();
      for (let x = x0; x <= x1; x += 1) {
        const y = yc - bendAt(n, (x - x0) / (x1 - x0)) * ROW_H;
        x === x0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.lineTo(x1, yc - bendAt(n, 1) * ROW_H);
      ctx.strokeStyle = C.accent; ctx.lineWidth = sel.has(n.id) || tool === 'pitch' ? 2 : 1.25; ctx.lineJoin = 'round'; ctx.stroke();
    }
    // dots
    if (tool === 'pitch') {
      for (const n of visible) {
        if (!sel.has(n.id) && hover.current.id !== n.id) continue;
        const dense = n.bend.length > 40;
        n.bend.forEach((p, i) => {
          if (dense && i % Math.ceil(n.bend.length / 40) !== 0) return;
          dot(ctx, bx(n.start + p.t * n.length), cy(n.pitch) - p.v * ROW_H, C.accent);
        });
      }
    }
    if (tool === 'pressure') {
      for (const n of visible) n.pressure.forEach(p => dot(ctx, bx(n.start + p.t * n.length), cy(n.pitch) - ribbonH(p.v), C.blue));
    }

    // ---- Playing Mode: the phrase being played, glowing, with a "now" line
    if (s.mode === 'play') {
      const ln = liveNotes();
      if (ln.length) {
        const lv = getLive();
        const nowB = lv.startBeat + phraseTime() * clip.bpm / 60;
        ctx.save();
        ctx.shadowColor = 'rgba(167, 255, 190, 0.85)'; ctx.shadowBlur = 14;
        for (const n of ln) drawBody(ctx, n, false, 'notes');
        ctx.shadowBlur = 10;
        for (const n of ln) {
          if (!n.bend.length) continue;
          const x0 = bx(n.start), x1 = bx(n.start + n.length), yc = cy(n.pitch);
          ctx.beginPath();
          for (let x = x0; x <= x1; x += 1) { const y = yc - bendAt(n, (x - x0) / Math.max(1, x1 - x0)) * ROW_H; x === x0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); }
          ctx.strokeStyle = '#c9ffd4'; ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.stroke();
        }
        if (lv.active) {
          const x = Math.round(bx(nowB));
          ctx.shadowColor = 'rgba(167, 255, 190, 0.9)'; ctx.shadowBlur = 12;
          ctx.fillStyle = 'rgba(201, 255, 212, 0.85)'; ctx.fillRect(x - 0.5, RULER_H, 1.5, gb - RULER_H);
        }
        ctx.restore();
      }
    }

    // marquee
    const d = drag.current;
    if (d && d.kind === 'slice') {
      const b = snapB(xb(d.x1)), sx = Math.round(bx(b)) + 0.5;
      ctx.strokeStyle = C.accent; ctx.lineWidth = 1.5; ctx.setLineDash([5, 3]);
      ctx.beginPath(); ctx.moveTo(sx, Math.min(d.y0, d.y1) - 8); ctx.lineTo(sx, Math.max(d.y0, d.y1) + 8); ctx.stroke(); ctx.setLineDash([]);
    }
    if (d && d.kind === 'marquee') {
      const x = Math.min(d.x0, d.x1), y = Math.min(d.y0, d.y1);
      ctx.fillStyle = 'rgba(255,112,67,0.08)'; ctx.fillRect(x, y, Math.abs(d.x1 - d.x0), Math.abs(d.y1 - d.y0));
      ctx.strokeStyle = C.accent; ctx.lineWidth = 1; ctx.setLineDash([4, 3]);
      ctx.strokeRect(x + 0.5, y + 0.5, Math.abs(d.x1 - d.x0), Math.abs(d.y1 - d.y0)); ctx.setLineDash([]);
    }
    ctx.restore();

    // ---- bottom panel
    drawPanel(ctx, notes, sel);

    drawRuler(ctx);
    drawKeys(ctx, notes, sel);
    // ---- playhead
    const ph = playheadBeat();
    const px = bx(ph);
    if (px >= KEY_W && px <= w) {
      // a barely-there glow around the playhead
      ctx.save();
      ctx.shadowColor = 'rgba(255,112,67,0.35)'; ctx.shadowBlur = 6;
      ctx.fillStyle = C.accent; ctx.fillRect(Math.round(px) - 0.5, RULER_H - 8, 1.5, gb - RULER_H + 8);
      ctx.fillRect(Math.round(px) - 0.5, gb + PANEL_HEAD, 1.5, h - gb - PANEL_HEAD);
      ctx.beginPath(); ctx.moveTo(px - 4.5, RULER_H - 10); ctx.lineTo(px + 5, RULER_H - 10); ctx.lineTo(px + 0.25, RULER_H - 4); ctx.closePath(); ctx.fill();
      ctx.restore();
    }

  }

  function dot(ctx: CanvasRenderingContext2D, x: number, y: number, color: string) {
    ctx.beginPath(); ctx.arc(x, y, DOT_R, 0, Math.PI * 2);
    ctx.fillStyle = C.dotFill; ctx.fill(); ctx.strokeStyle = color; ctx.lineWidth = 1.6; ctx.stroke();
  }

  /** Grid lines at the automatic step, with beats and bars stronger. */
  function drawVLines(ctx: CanvasRenderingContext2D, top: number, bottom: number, pal: { sub: string; beat: string; bar: string } = C) {
    const g = step();
    const b0 = Math.max(0, Math.floor(xb(KEY_W) / g) * g), b1 = xb(v.w);
    for (let b = b0; b <= b1 + 1e-6; b += g) {
      const isBar = Math.abs(b / BEATS_PER_BAR - Math.round(b / BEATS_PER_BAR)) < 1e-6;
      const isBeat = Math.abs(b - Math.round(b)) < 1e-6;
      ctx.fillStyle = isBar ? pal.bar : isBeat ? pal.beat : pal.sub;
      ctx.fillRect(snapPx(bx(b)) - PX, top, 2 * PX, bottom - top);
    }
  }

  function drawBody(ctx: CanvasRenderingContext2D, n: Note, selected: boolean, tool: string) {
    const x0 = bx(n.start), x1 = bx(n.start + n.length), yc = cy(n.pitch);
    const wdt = Math.max(2, x1 - x0);
    const color = n.muted ? C.noteMuted : selected ? C.noteSel : C.note;
    const ribbon = n.pressure.length > 0 || tool === 'pressure';
    if (!ribbon) {
      // note block, drawn exactly like the reference: 1px border, light top and side
      // edges, a soft top-to-bottom body and the velocity bar along the bottom
      const t = rowTop(n.pitch), rh = rowHt(n.pitch);
      const L = snapPx(x0), R = Math.max(L + 3 * PX, snapPx(x1));
      const W = R - L, H = rh - PX, p1 = PX, p2 = 2 * PX;
      ctx.fillStyle = C.noteShadow; ctx.fillRect(L, t + H, W, p1);
      if (n.muted) {
        ctx.fillStyle = C.noteMutedBorder; ctx.fillRect(L, t, W, H);
        ctx.fillStyle = C.noteMuted; ctx.fillRect(L + p1, t + p1, W - p2, H - p2);
      } else {
        const P = selected
          ? { border: C.sBorder, top: C.sBodyTop, bot: C.sBodyBot, hiT: C.sHiTop, hiS: C.sHiSide, hiB: C.sHiBot, on: C.sVelOn, off: C.sVelOff }
          : { border: C.noteBorder, top: C.noteBodyTop, bot: C.noteBodyBot, hiT: C.noteHiTop, hiS: C.noteHiSide, hiB: C.noteHiBot, on: C.velOn, off: C.velOff };
        if (selected) { ctx.fillStyle = C.sShadow; ctx.fillRect(L, t + H, W, p1); }
        ctx.fillStyle = P.border; ctx.fillRect(L, t, W, H);
        if (W > p2 && H > p2) {
          // the body darkens down to the top of the velocity bar, as in the reference
          const gEnd = H >= 13 && W > 6 ? t + H - p2 - snapPx(Math.max(2, rh * 0.24)) : t + H - p1;
          const g = ctx.createLinearGradient(0, t + p1, 0, gEnd);
          g.addColorStop(0, P.top); g.addColorStop(1, P.bot);
          ctx.fillStyle = g; ctx.fillRect(L + p1, t + p1, W - p2, H - p2);
          ctx.fillStyle = P.hiT; ctx.fillRect(L + p1, t + p1, W - p2, p1);
          if (W > 2 * p2) { ctx.fillStyle = P.hiS; ctx.fillRect(L + p1, t + p2, p1, H - 3 * p1); ctx.fillRect(R - p2, t + p2, p1, H - 3 * p1); }
          if (H >= 13 && W > 6) {
            const vb = snapPx(Math.max(2, rh * 0.24));
            const vy = t + H - p2 - vb;
            ctx.fillStyle = P.off; ctx.fillRect(L + p2, vy, W - 2 * p2, vb);
            ctx.fillStyle = P.on; ctx.fillRect(L + p2, vy, Math.max(p1, snapPx((W - 2 * p2) * n.velocity)), vb);
            ctx.fillStyle = P.hiB; ctx.fillRect(L + p2, t + H - p2, W - 2 * p2, p1);
          }
        }
      }
    } else {
      ctx.globalAlpha = n.muted ? 1 : 0.55 + 0.45 * n.velocity;
      ctx.beginPath();
      const step = Math.max(1, wdt / 160);
      ctx.moveTo(x0, yc - ribbonH(pressureAt(n, 0)));
      for (let x = x0; x <= x1; x += step) ctx.lineTo(x, yc - ribbonH(pressureAt(n, (x - x0) / wdt)));
      ctx.lineTo(x1, yc - ribbonH(pressureAt(n, 1)));
      ctx.lineTo(x1, yc + ribbonH(pressureAt(n, 1)));
      for (let x = x1; x >= x0; x -= step) ctx.lineTo(x, yc + ribbonH(pressureAt(n, (x - x0) / wdt)));
      ctx.lineTo(x0, yc + ribbonH(pressureAt(n, 0)));
      ctx.closePath();
      ctx.fillStyle = color; ctx.fill();
      ctx.globalAlpha = 1;
    }
    if (tool === 'pressure' && ribbon) { ctx.strokeStyle = C.blue; ctx.lineWidth = 1.5; ctx.stroke(); }
    if (selected) {
      ctx.save();
      ctx.strokeStyle = C.accent; ctx.lineWidth = 1;
      if (ribbon) ctx.stroke(); // ribbon: outline the ribbon shape itself
      ctx.restore();
    }
    if (wdt > 18 && !ribbon && ROW_H >= 9) {
      // name sits in the top of the green body, above the velocity bar
      const t = rowTop(n.pitch), rh = rowHt(n.pitch), H = rh - PX;
      const bar = H >= 13 ? snapPx(Math.max(2, rh * 0.24)) + 2 * PX : 0;
      const room = H - bar - 2 * PX;
      const fs = Math.min(16, Math.max(7, room * 0.95));
      ctx.fillStyle = selected ? C.sLabel : C.label; ctx.font = `500 ${fs}px "Arial Narrow", "Roboto Condensed", Inter, -apple-system, sans-serif`;
      ctx.textBaseline = 'top';
      ctx.save(); ctx.beginPath(); ctx.rect(x0, t, wdt - 2, rh); ctx.clip();
      ctx.fillText(noteName(n.pitch), Math.round(x0) + 3, t + 2 * PX + Math.max(0, (room - fs) / 2) - fs * 0.06);
      ctx.restore();
    }
  }

  function drawPanel(ctx: CanvasRenderingContext2D, notes: Note[], sel: Set<string>) {
    const top = gridBottom();
    const { prop, lane } = curLane();
    ctx.fillStyle = C.panel; ctx.fillRect(0, top, v.w, v.h - top);
    ctx.fillStyle = C.edge; ctx.fillRect(0, top, v.w, 1);
    ctx.fillStyle = C.edge; ctx.fillRect(0, top + PANEL_HEAD - 1, v.w, 1);
    // grip dots in the middle of the divider
    ctx.fillStyle = '#5a6267';
    for (let i = -2; i <= 2; i++) ctx.fillRect(Math.round(v.w - 150 + i * 4), top + 4, 2, 2);
    if (v.h - top <= PANEL_HEAD + 2) return;
    const lt = laneTop(), lb = laneBot();
    ctx.save(); ctx.beginPath(); ctx.rect(KEY_W, top + PANEL_HEAD, v.w - KEY_W, v.h - top - PANEL_HEAD); ctx.clip();
    ctx.fillStyle = C.panelRow; ctx.fillRect(KEY_W, top + PANEL_HEAD, v.w - KEY_W, v.h - top - PANEL_HEAD);
    drawVLines(ctx, top + PANEL_HEAD, v.h);
    const bipolar = prop ? NOTE_PROPS.find(p => p.key === prop)!.bipolar : laneBipolar(lane!);
    // value guides
    [0.25, 0.5, 0.75].forEach(f => { ctx.fillStyle = f === 0.5 && bipolar ? '#435158' : 'rgba(255,255,255,0.035)'; ctx.fillRect(KEY_W, Math.round(laneY(f)), v.w, 1); });
    if (prop) {
      const anySel = sel.size > 0;
      const base = bipolar ? laneY(0.5) : lb;
      for (const n of notes) {
        const x = Math.round(bx(n.start)) + 1;
        if (x < KEY_W - 6 || x > v.w + 6) continue;
        const val = getProp(n, prop);
        const y = laneY(val);
        const on = !anySel || sel.has(n.id);
        const col = n.muted ? C.noteMuted : sel.has(n.id) ? C.accent : C.stem;
        ctx.globalAlpha = on ? 1 : 0.35;
        ctx.fillStyle = col; ctx.fillRect(x - 1.5, Math.min(y, base), 3, Math.abs(base - y) || 1);
        ctx.fillRect(x, y - 0.5, 10, 1);
        ctx.beginPath(); ctx.arc(x, y, 4.5, 0, Math.PI * 2); ctx.fillStyle = C.panel; ctx.fill(); ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.stroke();
        ctx.globalAlpha = 1;
      }
    } else if (lane) {
      const def = laneDefault(lane);
      if (lane.points.length) {
        ctx.beginPath();
        for (let x = KEY_W; x <= v.w; x += 2) { const val = evalCC(lane.points, xb(x))!; x === KEY_W ? ctx.moveTo(x, laneY(val)) : ctx.lineTo(x, laneY(val)); }
        ctx.strokeStyle = C.lane; ctx.lineWidth = 2; ctx.stroke();
        const base = bipolar ? laneY(0.5) : lb;
        ctx.lineTo(v.w, base); ctx.lineTo(KEY_W, base); ctx.closePath(); ctx.fillStyle = C.laneFill; ctx.fill();
        lane.points.forEach(p => dot(ctx, bx(p.beat), laneY(p.v), C.lane));
      } else {
        ctx.setLineDash([3, 4]); ctx.strokeStyle = '#4a5560'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(KEY_W, laneY(def) + 0.5); ctx.lineTo(v.w, laneY(def) + 0.5); ctx.stroke(); ctx.setLineDash([]);
        ctx.fillStyle = C.rulerText; ctx.font = '12px Inter, -apple-system, sans-serif'; ctx.textBaseline = 'middle';
        ctx.fillText(lane.kind === 'param' ? 'Recorded synth control · click to add points' : 'Click to add points · drag to move · double-click removes', KEY_W + 14, (lt + lb) / 2 - (Math.abs(laneY(def) - (lt + lb) / 2) < 14 ? 16 : 0));
      }
    }
    ctx.restore();
    // left column: lane scale
    ctx.fillStyle = C.panel; ctx.fillRect(0, top + PANEL_HEAD, KEY_W, v.h - top - PANEL_HEAD);
    ctx.fillStyle = C.edge; ctx.fillRect(KEY_W - 2, top + PANEL_HEAD, 2, v.h - top - PANEL_HEAD);
    ctx.fillStyle = C.rulerText; ctx.font = '600 8px Inter, -apple-system, sans-serif'; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    const labels = prop === 'pan' || (lane && lane.cc === 10 && lane.kind !== 'pitch') ? ['R', 'L'] : bipolar ? ['+', '−'] : ['MAX', 'MIN'];
    ctx.fillText(labels[0], KEY_W - 8, lt + 4); ctx.fillText(labels[1], KEY_W - 8, lb - 4);
    ctx.textAlign = 'left';
  }

  function drawRuler(ctx: CanvasRenderingContext2D) {
    const s = getState(); const clip = s.clip;
    ctx.fillStyle = C.ruler; ctx.fillRect(KEY_W, 0, v.w - KEY_W, RULER_H);
    ctx.fillStyle = C.edge; ctx.fillRect(KEY_W, RULER_H - 1, v.w - KEY_W, 1);
    ctx.save(); ctx.beginPath(); ctx.rect(KEY_W, 0, v.w - KEY_W, RULER_H); ctx.clip();
    const range = s.selRange;
    if (range) {
      const ra = snapPx(bx(range[0])), rb = snapPx(bx(range[1]));
      const g = ctx.createLinearGradient(0, 0, 0, RULER_H);
      g.addColorStop(0, C.rbA); g.addColorStop(1, C.rbB);
      ctx.fillStyle = g; ctx.fillRect(ra, 0, rb - ra, RULER_H - 1);
      ctx.fillStyle = C.rbTop; ctx.fillRect(ra, 0, rb - ra, PX * 2);
      ctx.fillStyle = C.rbLow; ctx.fillRect(ra, RULER_H - 1 - PX * 3, rb - ra, PX * 2);
    }
    const b0 = Math.max(0, Math.floor(xb(KEY_W))), b1 = Math.ceil(xb(v.w));
    ctx.font = '500 9px Inter, -apple-system, sans-serif'; ctx.textBaseline = 'top';
    const showSixteenths = v.ppb >= 24;
    for (let b = b0; b <= b1; b++) {
      const x = Math.round(bx(b));
      const isBar = b % 4 === 0;
      if (isBar) {
        ctx.fillStyle = C.tick; ctx.fillRect(x, RULER_H - 16, 1, 16);
        const barN = b / 4 + 1;
        const every = v.ppb * 4 < 30 ? 4 : v.ppb * 4 < 60 ? 2 : 1;
        if ((barN - 1) % every === 0) {
          // every fourth bar (1, 5, 9, 13 …) is larger, to mark 4-bar phrases
          const major = (barN - 1) % 4 === 0;
          ctx.fillStyle = C.rulerText;
          ctx.font = major ? '600 12.5px Inter, -apple-system, sans-serif' : '500 10px Inter, -apple-system, sans-serif';
          ctx.textBaseline = 'alphabetic';
          ctx.fillText(String(barN), x + 4, RULER_H - 19);
        }
      } else if (v.ppb >= 8) { ctx.fillStyle = C.tick; ctx.fillRect(x, RULER_H - 9, 1, 9); }
      if (showSixteenths) for (let k = 1; k < 4; k++) { ctx.fillStyle = '#46525a'; ctx.fillRect(Math.round(bx(b + k / 4)), RULER_H - 5, 1, 5); }
    }
    ctx.restore();
  }

  function drawKeys(ctx: CanvasRenderingContext2D, notes: Note[], sel: Set<string>) {
    const gb = gridBottom();
    ctx.save(); ctx.beginPath(); ctx.rect(0, RULER_H, KEY_W, gb - RULER_H); ctx.clip();
    ctx.fillStyle = C.keyWhite; ctx.fillRect(0, RULER_H, KEY_W, gb - RULER_H);
    const lit = new Set<number>();
    for (const n of notes) if (sel.has(n.id)) lit.add(n.pitch);
    const ph = playheadBeat();
    const playingKeys = new Set<number>();
    if (getState().mode === 'play' && getLive().active) for (const p of soundingPitches(false)) playingKeys.add(Math.round(p));
    if (getState().playing) for (const n of notes) if (ph >= n.start && ph < n.start + n.length && !n.muted) playingKeys.add(Math.round(n.pitch + bendAt(n, (ph - n.start) / n.length)));
    const pTop = clamp(yPitch(RULER_H), 0, 127), pBot = clamp(yPitch(gb), 0, 127);
    for (let p = pBot; p <= pTop; p++) {
      const t = rowTop(p);
      const m = p % 12;
      // the C key carries a darker band and its octave label
      if (m === 0) { ctx.fillStyle = C.keyC; ctx.fillRect(0, t - ROW_H * 0.5, KEY_W, ROW_H * 1.5); }
      if (pressed.current === p || playingKeys.has(p)) { ctx.fillStyle = C.pressed; ctx.fillRect(0, t, KEY_W, ROW_H); }
      else if (lit.has(p)) { ctx.fillStyle = C.highlight; ctx.fillRect(0, t, KEY_W, ROW_H); }
      if (m === 0) { ctx.fillStyle = C.keyOct; ctx.fillRect(0, t + rowHt(p) - PX, KEY_W, PX); }
      if (m === 5) { ctx.fillStyle = C.keyLine; ctx.fillRect(0, t + rowHt(p) - PX, KEY_W, PX); }
      if (m === 0) {
        ctx.fillStyle = C.keyText; ctx.font = '600 8px Inter, -apple-system, sans-serif'; ctx.textBaseline = 'middle'; ctx.textAlign = 'right';
        ctx.fillText(noteName(p), KEY_W - 5, t + ROW_H / 2 + 0.5); ctx.textAlign = 'left';
      }
    }
    const bw = KEY_W * 0.62;
    const grad = ctx.createLinearGradient(0, 0, bw, 0);
    grad.addColorStop(0, C.keyBlackA); grad.addColorStop(1, C.keyBlackB);
    for (let p = pBot; p <= pTop; p++) {
      if (!isBlack(p)) continue;
      const t = rowTop(p);
      ctx.fillStyle = pressed.current === p || playingKeys.has(p) ? C.pressed : lit.has(p) ? '#7a5038' : grad;
      ctx.fillRect(0, t, Math.round(bw), rowHt(p));
    }
    ctx.restore();
    ctx.fillStyle = C.edge; ctx.fillRect(KEY_W - 2, RULER_H, 2, gb - RULER_H);
  }

  // ---------------------------------------------------------------- render loop + sizing
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      const s = getState();
      if (s.playing) {
        dirty.current = true;
        if (s.follow) {
          const ph = playheadBeat();
          const span = (v.w - KEY_W) / v.ppb;
          v.sx = Math.max(0, ph - span / 2);
        }
      }
      // Playing Mode: keep the phrase in view while it grows
      if (s.mode === 'play' && getLive().active) {
        dirty.current = true;
        const lv = getLive();
        const nowB = lv.startBeat + phraseTime() * s.clip.bpm / 60;
        const span = (v.w - KEY_W) / v.ppb;
        if (nowB > v.sx + span * 0.8) v.sx += (nowB - span * 0.6 - v.sx) * 0.08;
        else if (nowB < v.sx) v.sx = Math.max(0, nowB - span * 0.2);
        const ps = soundingPitches(false);
        if (ps.length) {
          const top = Math.max(...ps) + 3, bot = Math.min(...ps) - 3;
          const yTop = (127 - top) * ROW_H, yBot = (127 - bot) * ROW_H, gh = gridBottom() - RULER_H;
          if (yTop < v.sy) v.sy += (yTop - v.sy) * 0.1;
          else if (yBot > v.sy + gh) v.sy += (yBot - gh - v.sy) * 0.1;
        }
      }
      if (ease()) dirty.current = true;
      if (dirty.current) { dirty.current = false; syncGrid(); draw(); }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    const unsub = subscribe(() => { dirty.current = true; });
    const ro = new ResizeObserver(() => {
      const r = wrap.current!.getBoundingClientRect();
      v.w = r.width; v.h = r.height; setHeight(r.height);
      if (!v.init && r.width > 0) {
        v.init = true;
        const c = getState().clip;
        v.ppb = clamp((v.w - KEY_W - 10) / (c.bars * BEATS_PER_BAR + 4), 8, 120);
        const ps = c.notes.map(n => n.pitch);
        const mid = ps.length ? (Math.min(...ps) + Math.max(...ps)) / 2 : 60;
        v.sy = (127 - mid) * ROW_H - (v.h - RULER_H) / 2;
      }
      clampScroll();
      dirty.current = true;
    });
    ro.observe(wrap.current!);
    return () => { cancelAnimationFrame(raf); unsub(); ro.disconnect(); };
  }, []);

  // ---------------------------------------------------------------- pointer
  const local = (e: { clientX: number; clientY: number }) => {
    const r = cv.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  function onPointerDown(e: React.PointerEvent) {
    const { x, y } = local(e);
    const s = getState();
    cv.current!.setPointerCapture(e.pointerId);
    if (s.popup && s.popup !== 'connect' && s.popup !== 'vibrato' && s.popup !== 'dynamics') setState({ popup: null });

    if (e.button === 1) { drag.current = { kind: 'pan', x0: x, y0: y, sx: v.sx, sy: v.sy }; return; }

    // ruler: loop region / seek
    if (y < RULER_H) {
      if (x < KEY_W) return;
      if (e.button === 2) {
        // right-click / right-drag: keep where the range starts, move only its end
        drag.current = { kind: 'rangeEnd' };
        setRangeEnd(x, e);
        return;
      }
      drag.current = { kind: 'loop', a: Math.max(0, floorB(xb(x))), moved: false, x0: x };
      return;
    }
    // keyboard: play the key; it lights up while held, drag to slide across keys
    if (x < KEY_W) {
      if (y < gridBottom()) { const p = clamp(yPitch(y), 0, 127); pressed.current = p; dirty.current = true; holdKey(p); drag.current = { kind: 'keys' }; }
      return;
    }
    // bottom panel: divider resize, then lane editing
    if (y >= gridBottom()) {
      if (y < gridBottom() + PANEL_HEAD + 2) { drag.current = { kind: 'panel', y0: y, h0: panelH() }; return; }
      if (x < KEY_W) return;
      checkpoint();
      const { prop, lane } = curLane();
      if (prop) { drag.current = { kind: 'paint', prop, lastX: x }; paintAt(prop, x, x, y, true); return; }
      if (lane) {
        const i = ccDotAt(x, y);
        if (i >= 0) { drag.current = { kind: 'ccDot', lane: laneId(lane), index: i }; return; }
        const beat = Math.max(0, xb(x));
        const pts = sortPts([...lane.points.map(p => ({ ...p, t: p.beat })), { beat, v: laneVal(y), t: beat }]).map(({ t, ...p }) => p as CCPoint);
        setLane(laneId(lane), pts);
        drag.current = { kind: 'ccDot', lane: laneId(lane), index: pts.findIndex(p => p.beat === beat) };
      }
      return;
    }

    // ⌘ + drag (Ctrl on Windows): a selection box in any tool; notes inside get selected
    if ((e.metaKey || e.ctrlKey) && !e.altKey && e.button === 0) {
      drag.current = { kind: 'marquee', x0: x, y0: y, x1: x, y1: y, base: e.shiftKey ? s.selection : [] };
      if (!e.shiftKey) setState({ selection: [] });
      return;
    }

    // slice tool: drag a line, notes it crosses are cut there
    if (s.edit === 'slice' && e.button === 0) { drag.current = { kind: 'slice', x0: x, y0: y, x1: x, y1: y }; return; }

    // hand tool: drag a note to move it (whole note, never resize); drag empty space to scroll the view
    if (s.edit === 'move' && e.button === 0) {
      const hit = noteAt(x, y);
      if (!hit) { if (s.selection.length) setState({ selection: [] }); drag.current = { kind: 'pan', x0: x, y0: y, sx: v.sx, sy: v.sy }; cv.current!.style.cursor = 'grabbing'; return; }
      let selection = s.selection;
      if (e.shiftKey) selection = selection.includes(hit.n.id) ? selection.filter(i => i !== hit.n.id) : [...selection, hit.n.id];
      else if (!selection.includes(hit.n.id)) selection = [hit.n.id];
      setState({ selection });
      checkpoint();
      drag.current = { kind: 'move', x0: x, y0: y, orig: s.clip.notes.filter(n => selection.includes(n.id)), moved: false, dup: e.altKey };
      cv.current!.style.cursor = 'grabbing';
      return;
    }

    // right-drag erases
    if (e.button === 2) {
      checkpoint();
      drag.current = { kind: 'erase' };
      eraseAt(x, y);
      return;
    }

    if (s.tool === 'pitch') return pitchDown(e, x, y);
    if (s.tool === 'pressure') return pressureDown(e, x, y);

    // ---- notes layer
    const hit = noteAt(x, y);
    if (!hit && (e.metaKey || e.ctrlKey) && e.altKey) {
      // ⌘⌥ + drag: draw a note freehand
      // freehand note: start a note and record the pitch the pointer draws
      checkpoint();
      const start = snapB(xb(x));
      const n = makeNote(yPitch(y), start, Math.max(step(), 0.25));
      editNotes(ns => [...ns, n]);
      setState({ selection: [n.id] });
      drag.current = { kind: 'drawNote', id: n.id, start, samples: [{ beat: start, st: 0 }] };
      return;
    }
    if (!hit && !e.shiftKey && s.selection.length && s.edit === 'draw') {
      setState({ selection: [] });
      return;
    }
    if (!hit && s.edit === 'draw' && !e.shiftKey) {
      // pencil: one click places a note (last used length) and lets you drag it into place
      checkpoint();
      const n = makeNote(clamp(yPitch(y), 0, 127), Math.max(0, floorB(xb(x))), lastLen.current);
      editNotes(ns => [...ns, n]);
      setState({ selection: [n.id] });
      created.current = { id: n.id, at: performance.now() };
      audition(n.pitch, n.velocity, 0.3);
      drag.current = { kind: 'move', x0: x, y0: y, orig: [n], moved: false, dup: false };
      return;
    }
    if (hit) {
      let selection = s.selection;
      if (e.shiftKey) selection = selection.includes(hit.n.id) ? selection.filter(i => i !== hit.n.id) : [...selection, hit.n.id];
      else if (!selection.includes(hit.n.id)) selection = [hit.n.id];
      setState({ selection });
      checkpoint();
      lastLen.current = hit.n.length;
      const orig = s.clip.notes.filter(n => selection.includes(n.id));
      if (hit.part === 'l') drag.current = { kind: 'resizeL', x0: x, orig };
      else if (hit.part === 'r') drag.current = { kind: 'resizeR', x0: x, orig };
      else {
        drag.current = { kind: 'move', x0: x, y0: y, orig, moved: false, dup: e.altKey };
        if (!e.shiftKey) audition(hit.n.pitch, hit.n.velocity, 0.3);
      }
      return;
    }
    drag.current = { kind: 'marquee', x0: x, y0: y, x1: x, y1: y, base: e.shiftKey ? s.selection : [] };
    if (!e.shiftKey) setState({ selection: [] });
  }

  function setRangeEnd(x: number, e: { metaKey: boolean; ctrlKey: boolean }) {
    const start = getState().selRange?.[0] ?? 0;
    const end = Math.max(start + step(), snapB(xb(x), e));
    setState({ selRange: [start, end] });
    setTip({ x: x + 12, y: RULER_H + 6, text: `Range ${fmtPos(start)} – ${fmtPos(end)}` });
  }

  /** Bottom panel: set a note property for notes whose start the pointer passes over. */
  function paintAt(prop: NoteProp, xa: number, xb2: number, y: number, first: boolean) {
    const s = getState();
    const sel = new Set(s.selection);
    const lo = Math.min(xa, xb2) - 5, hi = Math.max(xa, xb2) + 5;
    let targets = visibleNotes().filter(n => (!sel.size || sel.has(n.id)) && bx(n.start) >= lo && bx(n.start) <= hi);
    if (!targets.length && first) {
      // nothing exactly under the pointer: take the nearest note start
      let best: Note | null = null, bd = 14;
      for (const n of visibleNotes()) { if (sel.size && !sel.has(n.id)) continue; const d = Math.abs(bx(n.start) - xb2); if (d < bd) { bd = d; best = n; } }
      if (best) targets = [best];
    }
    if (!targets.length) return;
    const ids = new Set(targets.map(n => n.id));
    const val = laneVal(y);
    editNotes(ns => ns.map(n => ids.has(n.id) ? setProp(n, prop, val) : n));
    const shown = getState().clip.notes.find(n => n.id === targets[0].id);
    if (shown) setTip({ x: xb2 + 16, y: y - 34, text: propText(shown, prop) });
  }

  function pitchDown(e: React.PointerEvent, x: number, y: number) {
    const s = getState();
    const dh = bendDotAt(x, y);
    if (dh) {
      checkpoint();
      if (!s.selection.includes(dh.n.id)) setState({ selection: e.shiftKey ? [...s.selection, dh.n.id] : [dh.n.id] });
      drag.current = { kind: 'bendDot', id: dh.n.id, index: dh.i };
      showBendTip(dh.n, dh.n.bend[dh.i], x, y);
      return;
    }
    const n = pathNoteAt(x, y);
    if (!n) {
      drag.current = { kind: 'marquee', x0: x, y0: y, x1: x, y1: y, base: e.shiftKey ? s.selection : [] };
      if (!e.shiftKey) setState({ selection: [] });
      return;
    }
    checkpoint();
    if (!s.selection.includes(n.id)) setState({ selection: [n.id] });
    const t = clamp((xb(x) - n.start) / n.length, 0, 1);
    if (s.drawMode) {
      drag.current = { kind: 'bendDraw', id: n.id, samples: [{ t, v: (cy(n.pitch) - y) / ROW_H }] };
      return;
    }
    let st = (cy(n.pitch) - y) / ROW_H;
    st = e.shiftKey ? Math.round(st * 10) / 10 : Math.round(st);
    const pts = [...n.bend];
    if (pts.length === 0) pts.push({ t: 0, v: 0, c: 'smooth' });
    const np: PathPoint = { t, v: st, c: 'smooth' };
    pts.push(np);
    sortPts(pts);
    editNotes(ns => ns.map(m => m.id === n.id ? { ...m, bend: pts } : m));
    drag.current = { kind: 'bendDot', id: n.id, index: pts.indexOf(np) };
  }

  function pressureDown(e: React.PointerEvent, x: number, y: number) {
    const s = getState();
    const dh = pressDotAt(x, y);
    checkpoint();
    if (dh) {
      if (!s.selection.includes(dh.n.id)) setState({ selection: [dh.n.id] });
      drag.current = { kind: 'pressDot', id: dh.n.id, index: dh.i };
      return;
    }
    const hit = noteAt(x, y) ?? (() => {
      // allow grabbing the ribbon above/below the row
      for (const n of visibleNotes()) {
        const x0 = bx(n.start), x1 = bx(n.start + n.length);
        if (x < x0 || x > x1) continue;
        const pr = pressureAt(n, (x - x0) / (x1 - x0));
        if (Math.abs(y - cy(n.pitch)) <= ribbonH(pr) + 3) return { n, part: 'body' as const };
      }
      return null;
    })();
    if (!hit) {
      drag.current = { kind: 'marquee', x0: x, y0: y, x1: x, y1: y, base: e.shiftKey ? s.selection : [] };
      if (!e.shiftKey) setState({ selection: [] });
      return;
    }
    const n = hit.n;
    if (!s.selection.includes(n.id)) setState({ selection: [n.id] });
    const t = clamp((xb(x) - n.start) / n.length, 0, 1);
    const val = clamp((Math.abs(cy(n.pitch) - y) - 1.5) / ribbonScale(), 0, 1);
    if (s.drawMode) { drag.current = { kind: 'pressDraw', id: n.id, samples: [{ t, v: val }] }; return; }
    const pts = n.pressure.length ? [...n.pressure] : [{ t: 0, v: 0.55, c: 'smooth' as const }, { t: 1, v: 0.55, c: 'smooth' as const }];
    const np: PathPoint = { t, v: val, c: 'smooth' };
    pts.push(np); sortPts(pts);
    editNotes(ns => ns.map(m => m.id === n.id ? { ...m, pressure: pts } : m));
    drag.current = { kind: 'pressDot', id: n.id, index: pts.indexOf(np) };
  }

  function showBendTip(n: Note, p: PathPoint, x: number, y: number) {
    const sign = p.v >= 0 ? '+' : '−';
    setTip({ x: x + 16, y: y - 34, text: `${sign}${Math.abs(p.v).toFixed(1)} st  ·  ${noteName(n.pitch + p.v)}` });
  }

  function setLane(id: string, points: CCPoint[]) {
    editClip(c => ({ ...c, cc: c.cc.map(l => laneId(l) === id ? { ...l, points } : l) }));
  }

  function eraseAt(x: number, y: number) {
    const hit = noteAt(x, y);
    if (hit) {
      editNotes(ns => ns.filter(n => n.id !== hit.n.id));
      setState(s => ({ selection: s.selection.filter(i => i !== hit.n.id) }));
    }
  }

  function onPointerMove(e: React.PointerEvent) {
    const { x, y } = local(e);
    const d = drag.current;
    const s = getState();
    if (!d) { updateHover(x, y, e); return; }
    dirty.current = true;
    switch (d.kind) {
      case 'pan': v.sx = d.sx - (x - d.x0) / v.ppb; v.sy = d.sy - (y - d.y0); clampScroll(); break;
      case 'panel': setState({ panelH: clamp(d.h0 + (d.y0 - y), PANEL_HEAD + LABEL_ROW, v.h - RULER_H - 80) }); clampScroll(); break;
      case 'paint': paintAt(d.prop, d.lastX, x, y, false); d.lastX = x; break;
      case 'slice': d.x1 = x; d.y1 = y; break;
      case 'rangeEnd': setRangeEnd(x, e); break;
      case 'keys': { const p = clamp(yPitch(Math.min(y, gridBottom() - 1)), 0, 127); if (p !== pressed.current) { pressed.current = p; holdKey(p); } break; }
      case 'loop': {
        // drag along the ruler: select that stretch of time and every note that starts in it
        if (!d.moved && Math.abs(x - d.x0) < 3) break;
        d.moved = true;
        const b = Math.max(0, snapB(xb(x), e));
        const a = Math.min(d.a, b), bb = Math.max(d.a + (b >= d.a ? step() : 0), b);
        const lo = Math.min(a, bb), hi = Math.max(a, bb);
        const ids = visibleNotes().filter(n => n.start < hi && n.start + n.length > lo).map(n => n.id); // any overlap counts
        setState({ selRange: [lo, hi], selection: ids });
        break;
      }
      case 'marquee': {
        d.x1 = x; d.y1 = y;
        const b0 = xb(Math.min(d.x0, x)), b1 = xb(Math.max(d.x0, x));
        const yTop = Math.min(d.y0, y), yBot = Math.max(d.y0, y);
        // any note the box touches, even a small part of it, is selected
        const ids = visibleNotes().filter(n => n.start < b1 && n.start + n.length > b0 && rowTop(n.pitch) + rowHt(n.pitch) > yTop && rowTop(n.pitch) < yBot).map(n => n.id);
        setState({ selection: Array.from(new Set([...d.base, ...ids])) }); // selecting never moves the loop range
        break;
      }
      case 'erase': eraseAt(x, y); break;
      case 'move': {
        const db = snapB(xb(x) - xb(d.x0), e);
        const dp = Math.round((d.y0 - y) / ROW_H);
        if (!d.moved && Math.abs(x - d.x0) < 3 && Math.abs(y - d.y0) < 3) break;
        if (!d.moved && d.dup) {
          // alt-drag: leave the originals, drag fresh copies
          const copies = d.orig.map(n => ({ ...n, id: uid() }));
          editNotes(ns => [...ns, ...copies]);
          setState({ selection: copies.map(c => c.id) });
          d.orig = copies;
        }
        if (!d.moved && dp !== 0) audition(d.orig[0].pitch + dp, 0.7, 0.2);
        d.moved = true;
        const map = new Map(d.orig.map(n => [n.id, n]));
        const minStart = Math.min(...d.orig.map(n => n.start));
        const dbc = Math.max(db, -minStart);
        editNotes(ns => ns.map(n => {
          const o = map.get(n.id); if (!o) return n;
          return { ...n, start: o.start + dbc, pitch: clamp(o.pitch + dp, 0, 127) };
        }));
        setTip({ x: x + 14, y: y - 30, text: `${noteName(d.orig[0].pitch + dp)}  ·  ${fmtPos(d.orig[0].start + dbc)}` });
        break;
      }
      case 'resizeL': case 'resizeR': {
        const db = snapB(xb(x) - xb(d.x0), e);
        const min = Math.min(step(), 0.0625 * 4) / 4;
        const map = new Map(d.orig.map(n => [n.id, n]));
        editNotes(ns => ns.map(n => {
          const o = map.get(n.id); if (!o) return n;
          if (d.kind === 'resizeR') return { ...n, length: Math.max(min, o.length + db) };
          const ns2 = clamp(o.start + db, 0, o.start + o.length - min);
          return { ...n, start: ns2, length: o.start + o.length - ns2 };
        }));
        break;
      }
      case 'drawNote': {
        const beat = Math.max(d.start, xb(x));
        const st = yPitchF(y) - getState().clip.notes.find(n => n.id === d.id)!.pitch;
        const last = d.samples[d.samples.length - 1];
        if (beat > last.beat) d.samples.push({ beat, st });
        const end = Math.max(d.start + step(), snapB(beat) || beat);
        const len = end - d.start;
        const pts = d.samples.map(p => ({ t: clamp((p.beat - d.start) / len, 0, 1), v: p.st, c: 'linear' as const }));
        editNotes(ns => ns.map(n => n.id === d.id ? { ...n, length: len, bend: pts.length > 1 ? pts : [] } : n));
        break;
      }
      case 'bendDot': {
        const n = s.clip.notes.find(m => m.id === d.id); if (!n) break;
        const pts = [...n.bend];
        const prev = pts[d.index - 1], next = pts[d.index + 1];
        let t = clamp((xb(x) - n.start) / n.length, prev ? prev.t + 0.001 : 0, next ? next.t - 0.001 : 1);
        let st = (cy(n.pitch) - y) / ROW_H;
        st = e.shiftKey ? Math.round(st * 10) / 10 : Math.round(st);
        st = clamp(st, -s.clip.range, s.clip.range);
        pts[d.index] = { ...pts[d.index], t, v: st };
        editNotes(ns => ns.map(m => m.id === n.id ? { ...m, bend: pts } : m));
        showBendTip(n, pts[d.index], x, y);
        break;
      }
      case 'bendDraw': case 'pressDraw': {
        const n = s.clip.notes.find(m => m.id === d.id); if (!n) break;
        const t = clamp((xb(x) - n.start) / n.length, 0, 1);
        const val = d.kind === 'bendDraw'
          ? clamp((cy(n.pitch) - y) / ROW_H, -s.clip.range, s.clip.range)
          : clamp((Math.abs(cy(n.pitch) - y) - 1.5) / ribbonScale(), 0, 1);
        d.samples.push({ t, v: val, c: 'linear' });
        const ts = d.samples.map(p => p.t);
        const lo = Math.min(...ts), hi = Math.max(...ts);
        const key = d.kind === 'bendDraw' ? 'bend' : 'pressure';
        const existing = (n as any)[key] as PathPoint[];
        const outside = existing.filter(p => p.t < lo - 1e-4 || p.t > hi + 1e-4);
        // keep stroke ordered by t (pointer may wobble backwards)
        const stroke = [...d.samples].sort((a, b) => a.t - b.t);
        editNotes(ns => ns.map(m => m.id === n.id ? { ...m, [key]: sortPts([...outside, ...stroke]) } : m));
        if (d.kind === 'bendDraw') { const sign = val >= 0 ? '+' : '−'; setTip({ x: x + 16, y: y - 34, text: `${sign}${Math.abs(val).toFixed(2)} st  ·  ${noteName(n.pitch + val)}` }); }
        break;
      }
      case 'pressDot': {
        const n = s.clip.notes.find(m => m.id === d.id); if (!n) break;
        const pts = [...n.pressure];
        const prev = pts[d.index - 1], next = pts[d.index + 1];
        const t = clamp((xb(x) - n.start) / n.length, prev ? prev.t + 0.001 : 0, next ? next.t - 0.001 : 1);
        const val = clamp((Math.abs(cy(n.pitch) - y) - 1.5) / ribbonScale(), 0, 1);
        pts[d.index] = { ...pts[d.index], t, v: val };
        editNotes(ns => ns.map(m => m.id === n.id ? { ...m, pressure: pts } : m));
        setTip({ x: x + 16, y: y - 34, text: `Pressure ${Math.round(val * 127)}` });
        break;
      }
      case 'ccDot': {
        const lane = s.clip.cc.find(l => laneId(l) === d.lane); if (!lane) break;
        const pts = [...lane.points];
        const prev = pts[d.index - 1], next = pts[d.index + 1];
        const beat = clamp(xb(x), prev ? prev.beat + 0.01 : 0, next ? next.beat - 0.01 : 1e9);
        const val = laneVal(y);
        pts[d.index] = { ...pts[d.index], beat, v: val };
        setLane(d.lane, pts);
        setTip({ x: x + 16, y: y - 34, text: `${laneName(lane)}  ${laneBipolar(lane) ? Math.round((val - 0.5) * 200) + '%' : Math.round(val * 127)}` });
        break;
      }
    }
  }

  function onPointerUp(e: React.PointerEvent) {
    const d = drag.current;
    drag.current = null;
    if (pressed.current !== null) { pressed.current = null; releaseKey(); }
    setTip(null);
    dirty.current = true;
    if (!d) return;
    const s = getState();
    if (d.kind === 'loop' && !d.moved) { seek(Math.max(0, xb(local(e).x))); }
    if (d.kind === 'rangeEnd') retime();
    if (d.kind === 'loop' && d.moved) { const n = getState().selection.length; flash(n ? `Selected ${n} note${n === 1 ? '' : 's'} · playback loops this range` : 'No notes in this range'); }
    if (d.kind === 'slice') {
      const beat = snapB(xb(d.x1));
      const yTop = Math.min(d.y0, d.y1), yBot = Math.max(d.y0, d.y1);
      // notes on the rows the line covers (a click cuts the note under it)
      const ids = new Set(visibleNotes().filter(n => rowTop(n.pitch) + ROW_H >= yTop && rowTop(n.pitch) <= yBot).map(n => n.id));
      const r = sliceAt(s.clip.notes, beat, ids);
      if (r.cut) { checkpoint(); editNotes(() => r.notes); flash(`Sliced ${r.cut} note${r.cut === 1 ? '' : 's'}`); }
    }
    if (d.kind === 'resizeL' || d.kind === 'resizeR') { const n = s.clip.notes.find(m => m.id === d.orig[0]?.id); if (n) lastLen.current = n.length; }
    if (d.kind === 'drawNote') {
      const n = s.clip.notes.find(m => m.id === d.id);
      if (n && n.bend.length > 1) editNotes(ns => ns.map(m => m.id === n.id ? { ...m, bend: simplify(m.bend, 0.04).map(p => ({ ...p, c: 'smooth' as const })) } : m));
      else if (n) editNotes(ns => ns.map(m => m.id === n.id ? { ...m, bend: [] } : m));
    }
    if (d.kind === 'bendDraw' || d.kind === 'pressDraw') {
      const key = d.kind === 'bendDraw' ? 'bend' : 'pressure';
      editNotes(ns => ns.map(m => m.id === d.id ? { ...m, [key]: simplify((m as any)[key], key === 'bend' ? 0.03 : 0.01) } : m));
    }
    // A glide that lands on a note it overlaps becomes one note (no re-attack).
    const edited = d.kind === 'move' ? (d.moved ? getState().selection : [])
      : (d.kind === 'resizeL' || d.kind === 'resizeR') ? getState().selection
      : (d.kind === 'bendDot' || d.kind === 'bendDraw' || d.kind === 'drawNote') ? [d.id] : [];
    if (edited.length) {
      const r = mergeGlides(getState().clip.notes, edited);
      if (r.merged > 0) {
        editNotes(() => r.notes);
        const ids = new Set(r.notes.map(n => n.id));
        setState(st => ({ selection: Array.from(new Set(st.selection.map(id => r.into.get(id) ?? id))).filter(id => ids.has(id)) }));
        flash(r.merged === 1 ? 'Merged into one gliding note' : `Merged ${r.merged} notes into gliding lines`);
      }
    }
    if (s.playing) retime();
  }

  function updateHover(x: number, y: number, e: React.PointerEvent) {
    const s = getState();
    const canvas = cv.current!;
    let cursor = 'default';
    let id: string | null = null;
    if (y < RULER_H) cursor = x > KEY_W ? 'col-resize' : 'default';
    else if (y >= gridBottom() - 3) cursor = y < gridBottom() + PANEL_HEAD + 2 ? 'ns-resize' : x < KEY_W ? 'default' : curLane().lane && ccDotAt(x, y) >= 0 ? 'pointer' : 'crosshair';
    else if (x < KEY_W) cursor = 'pointer';
    else if (s.edit === 'slice') cursor = 'text';
    else if (s.edit === 'move') cursor = noteAt(x, y) ? 'grab' : 'move';
    else if (s.tool === 'notes') {
      const h = noteAt(x, y);
      if (h) cursor = h.part === 'body' ? (e.altKey ? 'copy' : 'grab') : 'ew-resize';
      else cursor = e.metaKey || e.ctrlKey || s.edit === 'draw' ? 'crosshair' : 'default';
    } else if (s.tool === 'pitch') {
      const dh = bendDotAt(x, y);
      const n = dh ? dh.n : pathNoteAt(x, y);
      id = n?.id ?? null;
      cursor = dh ? 'pointer' : n ? 'crosshair' : 'default';
    } else if (s.tool === 'pressure') {
      cursor = pressDotAt(x, y) ? 'ns-resize' : noteAt(x, y) ? 'crosshair' : 'default';
    }
    canvas.style.cursor = cursor;
    if (hover.current.id !== id) dirty.current = true;
    hover.current = { x, y, id };
  }

  function onDoubleClick(e: React.MouseEvent) {
    const { x, y } = local(e);
    const s = getState();
    if (y < RULER_H && x >= KEY_W) { if (s.selRange) { setState({ selRange: null }); flash('Range cleared'); } return; }
    if (y < RULER_H || x < KEY_W) return;
    if (y >= gridBottom()) {
      const lane = curLane().lane;
      if (lane) { const i = ccDotAt(x, y); if (i >= 0) { checkpoint(); setLane(laneId(lane), lane.points.filter((_, k) => k !== i)); } }
      return;
    }
    if (s.edit === 'slice') return;
    if (s.edit === 'move') {
      // hand tool: double-click a note to snap it to the grid you can see
      const hit = noteAt(x, y); if (!hit) return;
      const ids = s.selection.includes(hit.n.id) ? new Set(s.selection) : new Set([hit.n.id]);
      const g = step();
      checkpoint();
      editNotes(ns => ns.map(n => ids.has(n.id) ? { ...n, start: Math.max(0, Math.round(n.start / g) * g) } : n));
      flash(`Snapped ${ids.size} note${ids.size === 1 ? '' : 's'} to ${gridLabel(g)}`);
      return;
    }
    if (s.tool === 'pitch') {
      const dh = bendDotAt(x, y);
      if (dh) {
        checkpoint();
        const pts = dh.n.bend.filter((_, k) => k !== dh.i);
        editNotes(ns => ns.map(m => m.id === dh.n.id ? { ...m, bend: pts.length === 1 && pts[0].v === 0 ? [] : pts } : m));
        return;
      }
      if (pathNoteAt(x, y)) return;
    }
    if (s.tool === 'pressure') {
      const dh = pressDotAt(x, y);
      if (dh) { checkpoint(); editNotes(ns => ns.map(m => m.id === dh.n.id ? { ...m, pressure: m.pressure.filter((_, k) => k !== dh.i) } : m)); return; }
      if (noteAt(x, y)) return;
    }
    const hit = noteAt(x, y);
    // the pencil already placed a note on the first click
    if (hit && created.current && created.current.id === hit.n.id && performance.now() - created.current.at < 600) return;
    if (hit && s.tool === 'notes') {
      // double-click a note: edit its pitch path
      setState({ tool: 'pitch', selection: [hit.n.id] });
      flash('Pitch tool · draw across the note to bend it');
      return;
    }
    if (!hit) {
      checkpoint();
      const n = makeNote(clamp(yPitch(y), 0, 127), Math.max(0, floorB(xb(x))), lastLen.current);
      editNotes(ns => [...ns, n]);
      setState({ selection: [n.id] });
      audition(n.pitch, n.velocity, 0.3);
    }
  }

  function onWheel(e: WheelEvent) {
    e.preventDefault();
    const { x, y } = local(e);
    const s = getState();
    dirty.current = true;
    if (e.ctrlKey || e.metaKey) {
      const t = tgt();
      const d = e.deltaY || e.deltaX;
      if (e.shiftKey) {
        // ⌘⇧ + scroll: taller or shorter note rows, anchored at the pointer
        const pitch = 127 - ((y - RULER_H + v.sy) / ROW_H);
        t.row = clamp(t.row * Math.exp(-d * 0.006), 7, 64);
        t.ay = { y, pitch };
      } else {
        // ⌘ + scroll or pinch: horizontal zoom, anchored at the pointer
        const beat = xb(x);
        t.ppb = clamp(t.ppb * Math.exp(-d * 0.008), 4, 4000);
        t.ax = { x, beat };
      }
      return;
    }
    if (e.altKey) {
      const hit = noteAt(x, y);
      if (hit) {
        const ids = s.selection.includes(hit.n.id) ? s.selection : [hit.n.id];
        const delta = -Math.sign(e.deltaY || e.deltaX) * 0.03;
        editNotes(ns => ns.map(n => ids.includes(n.id) ? { ...n, velocity: clamp(n.velocity + delta, 0.01, 1) } : n));
        const nv = getState().clip.notes.find(n => n.id === hit.n.id)!;
        setTip({ x: x + 16, y: y - 34, text: `Velocity ${Math.round(nv.velocity * 127)}` });
        clearTimeout((onWheel as any).t); (onWheel as any).t = setTimeout(() => setTip(null), 700);
      }
      return;
    }
    if (s.tool === 'pressure') {
      const dh = pressDotAt(x, y);
      if (dh) {
        const pts = dh.n.pressure.map((p, i) => i === dh.i ? { ...p, v: clamp(p.v - e.deltaY * 0.002, 0, 1) } : p);
        editNotes(ns => ns.map(m => m.id === dh.n.id ? { ...m, pressure: pts } : m));
        return;
      }
    }
    const t = tgt();
    // a zoom still easing: settle its final scroll position before scrolling on from it
    if (t.ax) { t.sx = t.ax.beat - (t.ax.x - KEY_W) / t.ppb; t.ax = null; }
    if (t.ay) { t.sy = (127 - t.ay.pitch) * t.row - (t.ay.y - RULER_H); t.ay = null; }
    if (e.shiftKey && Math.abs(e.deltaX) < 1) t.sx += e.deltaY / v.ppb;
    else { t.sx += e.deltaX / v.ppb; t.sy += e.deltaY; }
    const maxY = 128 * t.row - (gridBottom() - RULER_H);
    t.sy = clamp(t.sy, 0, Math.max(0, maxY)); t.sx = Math.max(0, t.sx);
  }

  useEffect(() => {
    const c = cv.current!;
    const h = (e: WheelEvent) => onWheel(e);
    c.addEventListener('wheel', h, { passive: false });
    // trackpad pinch (Safari/WKWebView sends gesture events, not ctrl+wheel)
    let lastScale = 1;
    const gs = (e: any) => { e.preventDefault(); lastScale = 1; };
    const gc = (e: any) => {
      e.preventDefault();
      const d = Math.log(e.scale / lastScale) * -120; lastScale = e.scale;
      onWheel({ deltaY: d, deltaX: 0, ctrlKey: true, metaKey: false, shiftKey: false, altKey: false, clientX: e.clientX, clientY: e.clientY, preventDefault() {} } as any);
    };
    c.addEventListener('gesturestart', gs as any);
    c.addEventListener('gesturechange', gc as any);
    return () => { c.removeEventListener('wheel', h); c.removeEventListener('gesturestart', gs as any); c.removeEventListener('gesturechange', gc as any); };
  }, []);

  // ---------------------------------------------------------------- keyboard
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
      const s = getState();
      if (s.chooser) return;
      const mod = e.metaKey || e.ctrlKey;
      const selIds = new Set(s.selection);
      dirty.current = true;
      if (mod && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        const ns = s.clip.notes;
        setState({ selection: ns.map(n => n.id) });
        return;
      }
      if (mod && e.key.toLowerCase() === 'c') { clipboard = s.clip.notes.filter(n => selIds.has(n.id)).map(n => ({ ...n })); flash(`Copied ${clipboard.length} note${clipboard.length === 1 ? '' : 's'}`); return; }
      if (mod && e.key.toLowerCase() === 'x') {
        clipboard = s.clip.notes.filter(n => selIds.has(n.id)).map(n => ({ ...n }));
        editNotes(ns => ns.filter(n => !selIds.has(n.id)), true); setState({ selection: [] }); return;
      }
      if (mod && e.key.toLowerCase() === 'v') {
        e.preventDefault();
        if (!clipboard.length) return;
        const minS = Math.min(...clipboard.map(n => n.start));
        const at = s.playing ? playheadBeat() : Math.max(0, snapB(playheadBeat()));
        const target = s.selection.length ? Math.max(...s.clip.notes.filter(n => selIds.has(n.id)).map(n => n.start + n.length)) : at;
        const copies = clipboard.map(n => ({ ...n, id: uid(), start: n.start - minS + target }));
        editNotes(ns => [...ns, ...copies], true);
        setState({ selection: copies.map(c => c.id) });
        return;
      }
      if (mod && e.key.toLowerCase() === 'b') {
        // ⌘B: repeat the red range (or the selection) right after itself, as in FL
        e.preventDefault();
        const r = s.selRange;
        let src = s.clip.notes.filter(n => selIds.has(n.id));
        let span: number, from: number;
        if (r) {
          from = r[0]; span = r[1] - r[0];
          if (!src.length) src = s.clip.notes.filter(n => n.start >= r[0] - 1e-6 && n.start < r[1] - 1e-6);
        } else {
          if (!src.length) { flash('Select notes or drag a range on the ruler first'); return; }
          from = Math.min(...src.map(n => n.start));
          span = Math.max(...src.map(n => n.start + n.length)) - from;
          span = Math.ceil(span / step() - 1e-6) * step() || span;
        }
        if (!src.length || span <= 0) return;
        const copies = src.map(n => ({ ...n, id: uid(), start: n.start + span }));
        checkpoint();
        editNotes(ns => [...ns, ...copies]);
        setState({ selection: copies.map(c => c.id), ...(r ? { selRange: [r[1], r[1] + span] as [number, number] } : {}) });
        flash(`Repeated ${copies.length} note${copies.length === 1 ? '' : 's'}`);
        return;
      }
      if (mod && e.key.toLowerCase() === 'd') {
        e.preventDefault();
        const sel = s.clip.notes.filter(n => selIds.has(n.id)); if (!sel.length) return;
        const span = Math.max(...sel.map(n => n.start + n.length)) - Math.min(...sel.map(n => n.start));
        const copies = sel.map(n => ({ ...n, id: uid(), start: n.start + span }));
        editNotes(ns => [...ns, ...copies], true);
        setState({ selection: copies.map(c => c.id) });
        return;
      }
      if (mod) return;
      if ((e.key === 'Delete' || e.key === 'Backspace') && s.selection.length) {
        e.preventDefault();
        editNotes(ns => ns.filter(n => !selIds.has(n.id)), true); setState({ selection: [] }); return;
      }
      if (e.key === 'Escape') {
        if (s.popup) setState({ popup: null, preview: null });
        else if (s.selection.length) setState({ selection: [] });
        else setState({ selRange: null });
        return;
      }
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        if (!s.selection.length) return;
        e.preventDefault();
        const dp = (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 12 : 1);
        editNotes(ns => ns.map(n => selIds.has(n.id) ? { ...n, pitch: clamp(n.pitch + dp, 0, 127) } : n), true);
        const first = getState().clip.notes.find(n => selIds.has(n.id));
        if (first) audition(first.pitch, first.velocity, 0.2);
        return;
      }
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        if (!s.selection.length) return;
        e.preventDefault();
        const g = gridStep(v.ppb);
        const db = (e.key === 'ArrowRight' ? 1 : -1) * (e.shiftKey ? g / 4 : g);
        editNotes(ns => ns.map(n => selIds.has(n.id) ? { ...n, start: Math.max(0, n.start + db) } : n), true);
        return;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="roll-wrap" ref={wrap}>
      <canvas ref={cv}
        onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp} onLostPointerCapture={onPointerUp}
        onPointerLeave={() => { if (!drag.current && hover.current.id) { hover.current.id = null; dirty.current = true; } }}
        onDoubleClick={onDoubleClick} onContextMenu={e => e.preventDefault()} />
      <div className="roll-corner" aria-hidden="true" />
      <button className={'follow' + (follow ? ' on' : '')} title="Keep the playhead centred while playing" onClick={() => setState({ follow: !follow })}><ITarget /></button>
      <div className="panel-head" style={{ top: height - clamp(panelHState, PANEL_HEAD + LABEL_ROW, Math.max(PANEL_HEAD + LABEL_ROW, height - RULER_H - 80)) + PANEL_HEAD }}>
        <button className="lane-btn" onPointerDown={e => e.stopPropagation()} onClick={() => setLaneMenu(o => !o)} aria-haspopup="menu" aria-expanded={laneMenu}>
          Control <span className="tri" aria-hidden="true">▸</span>
        </button>
        <span className="lane-name">{NOTE_PROPS.find(p => p.key === laneKey)?.label.replace(/^Note /, '').replace(/^./, c => c.toUpperCase()) ?? (() => { const l = lanes.find(l => laneId(l) === laneKey); return l ? laneName(l) : 'Velocity'; })()}</span>
        <span className="grid-label">Grid {gridLabel(snap)}</span>
      </div>
      {laneMenu && <LaneMenu onClose={() => setLaneMenu(false)} bottom={clamp(panelHState, PANEL_HEAD + LABEL_ROW, Math.max(PANEL_HEAD + LABEL_ROW, height - RULER_H - 80)) - 2} />}
      {tip && <div className="tip" style={{ left: tip.x, top: tip.y }}>{tip.text}</div>}
    </div>
  );
}

/** Two-column lane picker: per-note properties and channel controls. */
function LaneMenu({ onClose, bottom }: { onClose: () => void; bottom: number }) {
  const lane = useStore(s => s.lane);
  const lanes = useStore(s => s.clip.cc);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const h = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) onClose(); };
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    setTimeout(() => window.addEventListener('pointerdown', h), 0);
    window.addEventListener('keydown', k);
    return () => { window.removeEventListener('pointerdown', h); window.removeEventListener('keydown', k); };
  }, []);
  const pick = (key: string) => {
    setState(s => ({ lane: key, panelH: s.panelH < 90 ? 160 : s.panelH }));
    onClose();
  };
  const recorded = lanes.filter(l => l.kind === 'param' || ![10, 7, 74, 1, 11].includes(l.cc) && l.kind !== 'pitch');
  const standard = lanes.filter(l => !recorded.includes(l));
  return (
    <div className="lane-menu" ref={ref} role="menu" style={{ bottom }}>
      <div className="lm-col">
        <div className="lm-head">Note properties</div>
        {NOTE_PROPS.map(p => <button key={p.key} role="menuitemradio" aria-checked={lane === p.key} className={'lm-item' + (lane === p.key ? ' sel' : '')} onClick={() => pick(p.key)}>{p.label}</button>)}
      </div>
      <div className="lm-col">
        <div className="lm-head">Channel controls</div>
        {standard.map(l => <button key={laneId(l)} role="menuitemradio" aria-checked={lane === laneId(l)} className={'lm-item' + (lane === laneId(l) ? ' sel' : '')} onClick={() => pick(laneId(l))}>{laneName(l)}{l.points.length ? <span className="lm-dot" aria-label="has points" /> : null}</button>)}
        {recorded.length > 0 && <div className="lm-head sub">Recorded</div>}
        {recorded.map(l => <button key={laneId(l)} role="menuitemradio" aria-checked={lane === laneId(l)} className={'lm-item' + (lane === laneId(l) ? ' sel' : '')} onClick={() => pick(laneId(l))}>{laneName(l)}<span className="lm-dot" /></button>)}
        <div className="lm-note">Knobs you turn while recording show up here.</div>
      </div>
    </div>
  );
}


export function fmtPos(beat: number) {
  const bar = Math.floor(beat / BEATS_PER_BAR) + 1;
  const b = Math.floor(beat % BEATS_PER_BAR) + 1;
  return `${bar}.${b}`;
}
