import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { IChev } from './icons';

export function Slider({ value, min = 0, max = 1, onChange, onStart, onEnd }: {
  value: number; min?: number; max?: number;
  onChange: (v: number) => void; onStart?: () => void; onEnd?: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const frac = Math.max(0, Math.min(1, (value - min) / (max - min)));
  const set = (clientX: number) => {
    const r = ref.current!.getBoundingClientRect();
    const f = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
    onChange(min + f * (max - min));
  };
  return (
    <div className="slider" ref={ref}
      onPointerDown={e => { (e.target as Element).setPointerCapture(e.pointerId); onStart?.(); set(e.clientX); }}
      onPointerMove={e => { if (e.buttons) set(e.clientX); }}
      onPointerUp={() => onEnd?.()}>
      <div className="track" />
      <div className="fill" style={{ width: `${frac * 100}%` }} />
      <div className="thumb" style={{ left: `${frac * 100}%` }} />
    </div>
  );
}

export function SliderRow(p: { value: number; min?: number; max?: number; onChange: (v: number) => void; display: string; onStart?: () => void; onEnd?: () => void }) {
  return (
    <div className="slider-row">
      <Slider {...p} />
      <div className="val">{p.display}</div>
    </div>
  );
}

/**
 * A button that opens a small menu underneath it. The menu is drawn in a
 * portal at the top of the page so the top bar (which scrolls sideways on
 * narrow windows) never clips it and it always sits above the piano roll.
 */
export function Dropdown({ label, children, width, title, className = 'btn', chevron = true }: { label: React.ReactNode; children: (close: () => void) => React.ReactNode; width?: number; title?: string; className?: string; chevron?: boolean }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const place = () => {
    const b = ref.current?.getBoundingClientRect(); if (!b) return;
    const mw = menu.current?.offsetWidth ?? 200;
    setPos({ left: Math.max(8, Math.min(b.left, window.innerWidth - mw - 8)), top: b.bottom + 6 });
  };
  useLayoutEffect(() => { if (open) place(); }, [open]);
  useEffect(() => {
    if (!open) return;
    const h = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!ref.current?.contains(t) && !menu.current?.contains(t)) setOpen(false);
    };
    const shut = () => setOpen(false);
    window.addEventListener('pointerdown', h);
    window.addEventListener('resize', shut);
    const bar = ref.current?.closest('.topbar');
    bar?.addEventListener('scroll', shut);
    return () => { window.removeEventListener('pointerdown', h); window.removeEventListener('resize', shut); bar?.removeEventListener('scroll', shut); };
  }, [open]);
  return (
    <div className="dd" ref={ref}>
      <button className={className + (open ? ' open' : '')} title={title} aria-haspopup="menu" aria-expanded={open} style={width ? { width } : undefined} onClick={() => setOpen(o => !o)}>{label}{chevron && <IChev />}</button>
      {open && createPortal(
        <div className="menu" ref={menu} style={{ position: 'fixed', left: pos?.left ?? -9999, top: pos?.top ?? -9999 }}>{children(() => setOpen(false))}</div>,
        document.body)}
    </div>
  );
}

export function MenuItem({ selected, onClick, children }: { selected?: boolean; onClick: () => void; children: React.ReactNode }) {
  return <div className={'item' + (selected ? ' sel' : '')} onClick={onClick}>{children}</div>;
}
