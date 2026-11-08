# SLIDE

An MPE piano roll plug-in (VST3, AU and standalone) built around glides: every
note can bend into the next, with its own pressure, pan and timbre. It plays
the built-in synth or any AU/VST3 synth you own, follows your DAW's tempo and
transport, and drags out as .wav or MPE .mid.

## Download (Mac)

Every push to `main` builds a universal Mac version (Apple Silicon and Intel,
macOS 11 or later). Get **SLIDE-mac.zip** from the
[mac-latest release](../../releases/tag/mac-latest) and follow `INSTALL.txt`
inside it.

## Layout

- `ui/`: the interface (React + TypeScript, canvas piano roll). `npm run build`
  makes one self-contained `ui/dist/index.html`, which also runs in a browser
  with a preview synth.
- `plugin/`: the JUCE 8 plug-in. It embeds that page in a WebView and talks to
  it through events (see `ui/src/bridge.ts`). `Clip.cpp` turns the clip into
  the MPE stream, `PluginProcessor.cpp` plays it in time with the host into
  the built-in synth (`BuiltinSynth.h`) or a hosted synth, and renders .wav.
- `.github/workflows/build-mac.yml`: the Mac build.

## Building yourself

```
cd ui && npm ci && npm run build && cd ..
cmake -S plugin -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build --config Release
```

Add `-DSLIDE_TESTS=ON` and run `SlideTest plugin/test/demo.json` for the
headless engine check.
