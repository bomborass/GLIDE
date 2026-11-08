// SLIDE's engine: plays the clip as an MPE stream in time with the host, into
// the built-in synth or a hosted AU/VST3 synth, and renders it to .wav.
#pragma once
#include <juce_audio_processors/juce_audio_processors.h>
#include <juce_audio_formats/juce_audio_formats.h>
#include "Clip.h"
#include "BuiltinSynth.h"
#include "PluginCatalog.h"
#include <array>
#include <atomic>
#include <bitset>

namespace slide
{
class SlideProcessor final : public juce::AudioProcessor,
                             private juce::AudioProcessorParameter::Listener
{
public:
    SlideProcessor();
    ~SlideProcessor() override;

    // ------------------------------------------------------------------ AudioProcessor
    const juce::String getName() const override { return "SLIDE"; }
    bool acceptsMidi() const override { return true; }
    bool producesMidi() const override { return true; }
    bool isMidiEffect() const override { return false; }
    double getTailLengthSeconds() const override { return 1.0; }
    int getNumPrograms() override { return 1; }
    int getCurrentProgram() override { return 0; }
    void setCurrentProgram (int) override {}
    const juce::String getProgramName (int) override { return {}; }
    void changeProgramName (int, const juce::String&) override {}
    bool hasEditor() const override { return true; }
    juce::AudioProcessorEditor* createEditor() override;
    bool isBusesLayoutSupported (const BusesLayout&) const override;

    void prepareToPlay (double sampleRate, int blockSize) override;
    void releaseResources() override;
    void processBlock (juce::AudioBuffer<float>&, juce::MidiBuffer&) override;
    void getStateInformation (juce::MemoryBlock&) override;
    void setStateInformation (const void*, int) override;

    // ------------------------------------------------------------------ called by the editor (message thread)
    void setClip (const juce::var& clip);
    juce::var getClip() const;
    juce::var instrumentVar() const;

    void transport (const juce::String& cmd, double beat, const juce::var& loop);
    void keyDown (int pitch, float velocity);
    void keyUp (int pitch);
    void audition (int pitch, float velocity);

    void useBuiltin (const juce::String& name);
    void loadPlugin (const juce::String& id, std::function<void (bool, juce::String)> done);
    void openPluginWindow();

    /** Renders the clip with the current synth to a .wav in ~/Music/SLIDE (blocking). */
    juce::File renderWav (juce::String& error);
    /** The last render, if the clip and synth haven't changed since. */
    juce::File freshRender() const;

    struct Transport { bool playing; double beat; double bpm; };
    Transport getTransport() const;

    /** Hosted-synth knob moves since the last call: index -> value. */
    std::vector<std::pair<int, float>> takeParamChanges();
    juce::String paramName (int index) const;

    PluginCatalog& catalog() { return *catalogPtr; }

    int editorW = 1400, editorH = 820;

private:
    // ------------------------------------------------------------------ audio thread helpers
    struct Cmd { int type; double a; double b; double c; };
    enum CmdType { cmdPlay, cmdStop, cmdSeek, cmdKeyDown, cmdKeyUp, cmdAudition, cmdPanic };
    void push (Cmd c);
    void handleCommands (juce::MidiBuffer& out, int numSamples);
    void renderRange (const Compiled& c, double from, double to, double offsetSamples, double samplesPerBeat, int numSamples, juce::MidiBuffer& out);
    void clipNotesOff (juce::MidiBuffer& out, int sample);
    void addEvent (juce::MidiBuffer& out, const juce::uint8* data, int size, int sample);
    int liveNoteOn (juce::MidiBuffer& out, int pitch, float velocity, int sample);
    void liveNoteOff (juce::MidiBuffer& out, int pitch, int sample);

    void parameterValueChanged (int index, float value) override;
    void parameterGestureChanged (int, bool) override {}

    void installHosted (std::unique_ptr<juce::AudioPluginInstance> inst, const juce::PluginDescription& desc);
    std::optional<juce::PluginDescription> pendingDesc;
    void removeHosted();

    // ------------------------------------------------------------------ state
    juce::SharedResourcePointer<PluginCatalog> catalogPtr;
    juce::var clipVar;
    juce::String clipJson;
    std::shared_ptr<const Compiled> latest;            // message thread
    std::atomic<const Compiled*> live { nullptr };      // audio thread
    std::vector<std::shared_ptr<const Compiled>> keepAlive;

    BuiltinSynth builtin;
    juce::CriticalSection synthLock;
    std::unique_ptr<juce::AudioPluginInstance> hosted;
    std::optional<juce::PluginDescription> hostedDesc;
    juce::AudioBuffer<float> hostedBuffer;
    std::unique_ptr<juce::DocumentWindow> pluginWindow;
    juce::MemoryBlock pendingPluginState;
    bool hasInstrument = false;

    std::array<Cmd, 512> cmdBuf {};
    juce::AbstractFifo cmdFifo { 512 };
    juce::SpinLock pushLock;

    std::array<std::pair<int, float>, 1024> paramBuf {};
    juce::AbstractFifo paramFifo { 1024 };
    std::atomic<bool> applyingLanes { false };

    double sampleRate = 44100;
    int blockSize = 512;
    const Compiled* lastCompiled = nullptr;
    std::atomic<bool> needSetup { true };
    juce::MidiBuffer outBuf, synthBuf;
    std::array<ParamEv, 256> pendingParams {};
    int numPendingParams = 0;
    std::atomic<int> paramEpoch { 0 };
    std::array<std::bitset<128>, 16> active {};
    std::array<int, 128> liveChannel {};
    int liveRR = 0;
    struct AutoOff { int pitch; int samplesLeft; };
    std::array<AutoOff, 16> autoOffs {};

    bool wasHostPlaying = false;
    double expectedPpq = 0;
    bool internalPlaying = false;
    double internalBeat = 0;
    double loopA = 0, loopB = 0;
    bool loopSet = false;

    std::atomic<bool> playingFlag { false };
    std::atomic<double> beatNow { 0 };
    std::atomic<double> bpmNow { 120 };

    juce::File lastRender;
    juce::String lastRenderKey;
    juce::String renderKey() const;

    JUCE_DECLARE_WEAK_REFERENCEABLE (SlideProcessor)
    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (SlideProcessor)
};
}
