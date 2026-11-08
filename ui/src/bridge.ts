// Bridge between the UI and the JUCE engine.
//
// In the plugin/standalone build this page runs inside juce::WebBrowserComponent
// (JUCE 8, withNativeIntegrationEnabled). JUCE injects window.__JUCE__ and we
// talk to the C++ side through events:
//   UI  -> C++ : "clipChanged"  {clip JSON}   engine rebuilds its MPE event list
//                "transport"    {play|stop|seek, beat}
//                "audition"     {pitch, velocity}
//                "scanPlugins"  {}             rescan installed AU/VST3 instruments
//                "loadPlugin"   {id}           host that instrument inside SLIDE
//                "openPluginEditor" {}         show the hosted synth's own window
//                "startAudioDrag" {}           WAV tile dragged: native drag of the rendered .wav
//                "saveAudio"    {}             render clip to .wav, show a save dialog
//                "uiReady"      {}             page loaded; C++ answers with "init"
//                "useBuiltin"   {name}         play the built-in synth voice
//                "keyDown"/"keyUp" {pitch, velocity}  on-screen keyboard
//                "saveFile"     {name, base64} save dialog for an exported file
//                "dragFile"     {name, base64} MIDI tile dragged: native drag of the file
//                (a click without moving sends saveAudio / saveFile instead)
//                "prepareAudio" {}             render the clip to .wav ahead of a drag
//   C++ -> UI  : "init"         {clip?, instrument?}  saved state from the project
//                "hostTransport" {playing, beat, bpm}  when following the host
//                "pluginList"   PluginInfo[]   result of a scan (also sent on load and while scanning)
//                "scanStatus"   {scanning, name}  plug-in being checked right now
//                "pluginLoaded" {id, name, ok, error?}
//                "paramChanged" {id, name, value 0..1}  hosted synth knob moved
//
// In a plain browser there is no __JUCE__, so the UI drives its own WebAudio
// preview synth and transport instead.
import type { Clip } from './model';

type Listener = (payload: any) => void;

/** An installed instrument plugin, as reported by the C++ scanner. */
export interface PluginInfo { id: string; name: string; vendor: string; format: 'VST3' | 'AU'; mpe?: boolean }

interface JuceBackend {
  emitEvent(name: string, payload: unknown): void;
  addEventListener(name: string, fn: Listener): unknown;
}

const juce: { backend?: JuceBackend } | undefined = (window as any).__JUCE__;

export const isPlugin = !!juce?.backend;

export const bridge = {
  clipChanged(clip: Clip) { juce?.backend?.emitEvent('clipChanged', clip); },
  transport(cmd: 'play' | 'stop' | 'seek', beat: number, loop: [number, number] | null = null) { juce?.backend?.emitEvent('transport', { cmd, beat, loop }); },
  audition(pitch: number, velocity: number) { juce?.backend?.emitEvent('audition', { pitch, velocity }); },
  onHostTransport(fn: Listener) { juce?.backend?.addEventListener('hostTransport', fn); },
  scanPlugins(force = false) { juce?.backend?.emitEvent('scanPlugins', { force }); },
  loadPlugin(id: string) { juce?.backend?.emitEvent('loadPlugin', { id }); },
  openPluginEditor() { juce?.backend?.emitEvent('openPluginEditor', {}); },
  startAudioDrag() { juce?.backend?.emitEvent('startAudioDrag', {}); },
  saveAudio() { juce?.backend?.emitEvent('saveAudio', {}); },
  uiReady() { juce?.backend?.emitEvent('uiReady', {}); },
  useBuiltin(name: string) { juce?.backend?.emitEvent('useBuiltin', { name }); },
  keyDown(pitch: number, velocity: number) { juce?.backend?.emitEvent('keyDown', { pitch, velocity }); },
  keyUp(pitch: number) { juce?.backend?.emitEvent('keyUp', { pitch }); },
  saveFile(name: string, base64: string) { juce?.backend?.emitEvent('saveFile', { name, base64 }); },
  dragFile(name: string, base64: string) { juce?.backend?.emitEvent('dragFile', { name, base64 }); },
  prepareAudio() { juce?.backend?.emitEvent('prepareAudio', {}); },
  onInit(fn: (p: { clip?: Clip; instrument?: any }) => void) { juce?.backend?.addEventListener('init', fn); },
  onParamChanged(fn: (p: { id: string; name: string; value: number }) => void) { juce?.backend?.addEventListener('paramChanged', fn); },
  onPluginList(fn: (list: PluginInfo[]) => void) { juce?.backend?.addEventListener('pluginList', fn); },
  onScanStatus(fn: (s: { scanning: boolean; name: string }) => void) { juce?.backend?.addEventListener('scanStatus', fn); },
  onPluginLoaded(fn: (r: { id: string; name: string; ok: boolean; error?: string }) => void) { juce?.backend?.addEventListener('pluginLoaded', fn); },
};

/**
 * Press on an export tile in the plugin: moving the mouse a few pixels with
 * the button down starts a native file drag (so FL gets a real file), letting
 * go without moving counts as a click.
 */
export function pressTile(e: { button: number; clientX: number; clientY: number }, onDrag: () => void, onClick: () => void) {
  if (e.button !== 0) return;
  const x0 = e.clientX, y0 = e.clientY;
  let done = false;
  const cleanup = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
  const move = (m: PointerEvent) => { if (!done && Math.hypot(m.clientX - x0, m.clientY - y0) > 4) { done = true; cleanup(); onDrag(); } };
  const up = () => { if (!done) { done = true; cleanup(); onClick(); } };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

/** Base64 of a byte array (for handing exported files to the C++ side). */
export function toBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
