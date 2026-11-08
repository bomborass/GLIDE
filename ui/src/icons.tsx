import React from 'react';

const S = (p: { children: React.ReactNode; size?: number; vb?: string; fill?: boolean }) => (
  <svg width={p.size ?? 16} height={p.size ?? 16} viewBox={p.vb ?? '0 0 16 16'} fill={p.fill ? 'currentColor' : 'none'} stroke={p.fill ? 'none' : 'currentColor'} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">{p.children}</svg>
);

export const IPlay = () => <S fill><path d="M4 2.8v10.4c0 .5.5.8.9.5l8.2-5.2c.4-.2.4-.8 0-1L4.9 2.3c-.4-.3-.9 0-.9.5z" /></S>;
export const IStop = () => <S fill><rect x="3.5" y="3.5" width="9" height="9" rx="1.5" /></S>;
export const IRec = () => <S fill><circle cx="8" cy="8" r="4" /></S>;
export const IMetro = () => <S><path d="M6 2h4l3 12H3z" /><path d="M8 10l4-6" /></S>;
export const ILoop = () => <S><path d="M12.5 8a4.5 4.5 0 1 1-1.3-3.2" /><path d="M12 2.5v2.6H9.4" /></S>;
export const IGrip = () => <S><path d="M14 6 6 14M14 10l-4 4M14 13.5l-.5.5" /></S>;
export const IWindow = () => <S><rect x="2" y="3" width="12" height="10" rx="1.5" /><path d="M2 6h12" /></S>;
export const ISpeaker = () => <S><path d="M2.5 6h2.5l3.5-3v10L5 10H2.5z" fill="currentColor" /><path d="M11 5.5a3.5 3.5 0 0 1 0 5M12.8 3.8a6 6 0 0 1 0 8.4" /></S>;
export const IMute = () => <S><path d="M2.5 6h2.5l3.5-3v10L5 10H2.5z" fill="currentColor" /><path d="M11 6l3.5 4M14.5 6L11 10" /></S>;
export const IUndo = () => <S><path d="M4 6.5h5.5a3.5 3.5 0 0 1 0 7H6" /><path d="M6.5 4L4 6.5 6.5 9" /></S>;
export const IRedo = () => <S><path d="M12 6.5H6.5a3.5 3.5 0 0 0 0 7H10" /><path d="M9.5 4L12 6.5 9.5 9" /></S>;
export const IFolder = () => <S><path d="M2 4.5c0-.6.4-1 1-1h3l1.5 1.5H13c.6 0 1 .4 1 1V12c0 .6-.4 1-1 1H3c-.6 0-1-.4-1-1z" /></S>;
export const IPlus = () => <S><path d="M8 3v10M3 8h10" /></S>;
export const ITrash = () => <S><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5" /></S>;
export const IHelp = () => <S><circle cx="8" cy="8" r="6" /><path d="M6.4 6.3a1.7 1.7 0 0 1 3.3.5c0 1.2-1.7 1.4-1.7 2.4" /><circle cx="8" cy="11.3" r=".4" fill="currentColor" /></S>;
export const IDownload = () => <S size={18}><path d="M8 2v8M4.8 7L8 10.2 11.2 7M3 13.5h10" strokeWidth={1.8} /></S>;
export const IChev = () => <svg className="chev" width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M2.5 3.8L5 6.3l2.5-2.5" /></svg>;
export const ITarget = () => <S size={12}><circle cx="8" cy="8" r="5" /><circle cx="8" cy="8" r="1.5" fill="currentColor" /></S>;
export const IDraw = () => <S><path d="M1.5 9.5c1.5-3 3-3 4 0s2.5 3 4 0 3-3 5 0" /></S>;

// curve shapes for "curve between selected points"
export const ICurve = ({ kind }: { kind: string }) => {
  const d: Record<string, string> = {
    smooth: 'M3 13C8 13 8 3 13 3',
    linear: 'M3 13L13 3',
    easeIn: 'M3 13C9 13 13 9 13 3',
    easeOut: 'M3 13C3 7 7 3 13 3',
    step: 'M3 13H8V3h5',
  };
  return <S><path d={d[kind]} /></S>;
};

/** Drag-out: an arrow pulling a file. */
export const IDragFile = () => (
  <svg width="22" height="22" viewBox="0 0 22 22" fill="none" aria-hidden="true">
    <path d="M3 2.5v11l2.9-2.6 2 4.3 1.9-.8-2-4.2h3.9z" fill="currentColor" />
    <path d="M10.5 10.5h5l3 3v6h-8z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    <path d="M15.5 10.5v3h3" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
  </svg>
);

// SLIDE tool icons
export const IPencil = () => <S><path d="M3 13l1-3.2 7-7a1.4 1.4 0 0 1 2 2l-7 7z" /><path d="M9.8 4.2l2 2" /></S>;
export const ISelectTool = () => <S><path d="M2.5 5V2.5H5M11 2.5h2.5V5M13.5 11v2.5H11M5 13.5H2.5V11" /></S>;
export const ISlice = () => <S><path d="M10.5 1.5L5.5 14.5" /><rect x="1.5" y="6" width="13" height="4.5" rx="1" strokeDasharray="2 1.6" /></S>;
export const IQuantize = () => <S><path d="M4 2.5v11M12 2.5v11" strokeDasharray="1.6 1.6" /><path d="M6.5 8h4M9 6l2 2-2 2" /></S>;
export const IHand = () => <S><path d="M5.5 8.5V4a1 1 0 0 1 2 0v3.5M7.5 7V3a1 1 0 0 1 2 0v4M9.5 7V3.8a1 1 0 0 1 2 0V8M11.5 6.5a1 1 0 0 1 2 0v3.2A4.8 4.8 0 0 1 8.7 14.5h-.4a4.4 4.4 0 0 1-3.4-1.6L2.6 10.1a1.1 1.1 0 0 1 1.6-1.5l1.3 1.3" /></S>;
