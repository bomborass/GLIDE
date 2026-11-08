// Audio export: render the clip to .wav and hand it over by drag or save.
// Browser build: rendered here with the built-in synth (OfflineAudioContext).
// Plugin build: the C++ engine renders the hosted synth and starts a native
// file drag (juce::DragAndDropContainer::performExternalDragDropOfFiles), so
// FL Studio receives a real .wav file.
import { getState, flash } from './store';
import { renderClip, encodeWav } from './audio';
import { zipOne } from './midi';
import { bridge, isPlugin, pressTile } from './bridge';
import type { Clip } from './model';

let cache: { clip: Clip; synth: string; wav: Uint8Array; dataUrl: string } | null = null;
let pending: Promise<void> | null = null;

const fresh = () => !!cache && cache.clip === getState().clip && cache.synth === getState().synth;
export const fileBase = () => getState().clip.name.replace(/[^\w\- ]+/g, '') || 'clip';

function toDataUrl(bytes: Uint8Array) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return 'data:audio/wav;base64,' + btoa(bin);
}

/** Render if the clip changed since the last render. */
export function prepareWav(): Promise<void> {
  if (isPlugin || fresh()) return Promise.resolve();
  if (pending) return pending;
  const clip = getState().clip, synth = getState().synth;
  pending = renderClip().then(buf => {
    const wav = encodeWav(buf);
    cache = { clip, synth, wav, dataUrl: toDataUrl(wav) };
  }).finally(() => { pending = null; });
  return pending;
}

export const wavReady = () => isPlugin || fresh();

/** dragstart handler: needs the file synchronously, so it must already be rendered. */
export function dragWav(e: React.DragEvent) {
  if (isPlugin) { e.preventDefault(); return; } // native drag started on pointerdown
  if (!fresh()) {
    e.preventDefault();
    flash('Rendering audio · drag again in a moment');
    prepareWav();
    return;
  }
  e.dataTransfer.setData('DownloadURL', `audio/wav:${fileBase()}.wav:${cache!.dataUrl}`);
  e.dataTransfer.effectAllowed = 'copy';
}

export function pointerDownWav(e: React.PointerEvent) {
  if (isPlugin) pressTile(e, () => bridge.startAudioDrag(), () => { flash('Rendering your synth to .wav…'); bridge.saveAudio(); });
  else prepareWav();
}

/** Plugin: render with the loaded synth ahead of a drag (on hover). */
export function hoverWav() { if (isPlugin) bridge.prepareAudio(); else prepareWav(); }

/** Click: save the .wav. */
export async function saveWav(): Promise<string> {
  if (isPlugin) { bridge.saveAudio(); return 'Rendering your synth to .wav…'; }
  await prepareWav();
  const wav = cache!.wav;
  const base = fileBase();
  const host = (window as any).claude;
  if (host?.use) {
    // Hosted page: the viewer's save prompt takes .zip but not .wav.
    const dl = await host.use('downloads');
    if (!dl) return 'Saving files is not available in this view';
    try { await dl.save({ filename: `${base} audio.zip`, data: zipOne(`${base}.wav`, wav) }); return `Saved ${base}.wav (zipped)`; }
    catch (err: any) { return err?.code === 'declined' ? 'Export cancelled' : 'Could not save the file here'; }
  }
  const url = URL.createObjectURL(new Blob([wav], { type: 'audio/wav' }));
  const a = document.createElement('a'); a.href = url; a.download = `${base}.wav`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  return `Exported ${base}.wav`;
}
