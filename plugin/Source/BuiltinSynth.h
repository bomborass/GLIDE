// The four built-in voices (Glass Saw, Soft Square, Warm Pad, Pure Sine), as an
// MPE synth: every note follows its own pitch bend, pressure and timbre, so the
// glides sound right without any setup. Mirrors the browser preview in audio.ts.
#pragma once
#include <juce_audio_basics/juce_audio_basics.h>
#include <atomic>
#include <cmath>

namespace slide
{
enum class Wave { saw, square, triangle, sine };

struct Preset
{
    const char* name;
    Wave a, b;
    float detuneCents, cutoff, q, gain;
};

inline const Preset presets[] = {
    { "Glass Saw",   Wave::saw,    Wave::saw,      7.0f, 900.0f, 2.0f, 0.16f },
    { "Soft Square", Wave::square, Wave::triangle, 4.0f, 700.0f, 1.0f, 0.14f },
    { "Warm Pad",    Wave::saw,    Wave::triangle, 12.0f, 500.0f, 0.7f, 0.20f },
    { "Pure Sine",   Wave::sine,   Wave::sine,     0.0f, 6000.0f, 0.5f, 0.30f },
};

inline int presetIndex (const juce::String& name)
{
    for (int i = 0; i < (int) std::size (presets); ++i)
        if (name == presets[i].name) return i;
    return 0;
}

class SlideVoice final : public juce::MPESynthesiserVoice
{
public:
    explicit SlideVoice (const std::atomic<int>& presetRef) : preset (presetRef) {}

    void noteStarted() override
    {
        cfg = presets[juce::jlimit (0, (int) std::size (presets) - 1, preset.load())];
        velocity = currentlyPlayingNote.noteOnVelocity.asUnsignedFloat();
        env = 0;
        releasing = false;
        phaseA = phaseB = 0;
        ic1 = ic2 = 0;
        cut = 0;
        readNote();
        freq = targetFreq;
        gainNow = 0;
    }

    void noteStopped (bool allowTailOff) override
    {
        if (! allowTailOff) { clearCurrentNote(); return; }
        // higher release velocity = quicker release, as most synths read it
        const float off = currentlyPlayingNote.noteOffVelocity.asUnsignedFloat();
        releaseSecs = 0.03f + (1.0f - off) * 0.25f;
        releasing = true;
    }

    void notePressureChanged() override  { readNote(); }
    void notePitchbendChanged() override { readNote(); }
    void noteTimbreChanged() override    { readNote(); }
    void noteKeyStateChanged() override {}

    void renderNextBlock (juce::AudioBuffer<float>& out, int start, int num) override
    {
        if (! isActive()) return;
        const float sr = (float) getSampleRate();
        const float attackStep = 1.0f / (0.008f * sr);
        const float detune = std::pow (2.0f, cfg.detuneCents / 1200.0f);
        auto* L = out.getWritePointer (0);
        auto* R = out.getNumChannels() > 1 ? out.getWritePointer (1) : nullptr;

        for (int i = start; i < start + num; ++i)
        {
            // smooth parameter changes (the events arrive about every 10 ms)
            freq += (targetFreq - freq) * 0.004f;
            gainNow += (targetGain - gainNow) * 0.004f;
            cut += (targetCut - cut) * 0.004f;

            if (releasing)
            {
                env -= 1.0f / (releaseSecs * sr);
                if (env <= 0) { clearCurrentNote(); return; }
            }
            else if (env < 1.0f) env = juce::jmin (1.0f, env + attackStep);

            const float dtA = juce::jlimit (0.0f, 0.45f, freq / sr), dtB = juce::jlimit (0.0f, 0.45f, freq * detune / sr);
            float s = osc (cfg.a, phaseA, dtA) + osc (cfg.b, phaseB, dtB);
            phaseA += dtA; if (phaseA >= 1) phaseA -= 1;
            phaseB += dtB; if (phaseB >= 1) phaseB -= 1;

            s = lowpass (s, juce::jmin (cut, sr * 0.45f), sr);
            const float v = s * gainNow * env;
            L[i] += v;
            if (R != nullptr) R[i] += v;
        }
    }

private:
    void readNote()
    {
        const auto& n = currentlyPlayingNote;
        targetFreq = juce::jlimit (8.0f, 20000.0f, (float) n.getFrequencyInHertz());
        const float pr = n.pressure.asUnsignedFloat();
        const float timbre = n.timbre.asUnsignedFloat(); // CC74, centred at 0.5
        targetGain = cfg.gain * (0.35f + 0.65f * velocity) * (0.2f + 0.8f * pr);
        targetCut = juce::jmin (16000.0f, cfg.cutoff * std::pow (2.0f, (timbre - 0.5f) * 4.0f) * (0.6f + pr * 3.5f) + targetFreq);
        if (cut <= 0) cut = targetCut;
    }

    static float polyBlep (float t, float dt)
    {
        if (t < dt) { t /= dt; return t + t - t * t - 1.0f; }
        if (t > 1.0f - dt) { t = (t - 1.0f) / dt; return t * t + t + t + 1.0f; }
        return 0.0f;
    }

    static float osc (Wave w, float ph, float dt)
    {
        switch (w)
        {
            case Wave::saw:      return (2.0f * ph - 1.0f) - polyBlep (ph, dt);
            case Wave::square:
            {
                float v = ph < 0.5f ? 1.0f : -1.0f;
                v += polyBlep (ph, dt);
                float p2 = ph + 0.5f; if (p2 >= 1) p2 -= 1;
                return v - polyBlep (p2, dt);
            }
            case Wave::triangle: return 1.0f - 4.0f * std::abs (ph - 0.5f);
            case Wave::sine:
            default:             return std::sin (ph * juce::MathConstants<float>::twoPi);
        }
    }

    // Simper's state-variable lowpass
    float lowpass (float x, float fc, float sr)
    {
        const float g = std::tan (juce::MathConstants<float>::pi * fc / sr);
        const float k = 1.0f / juce::jmax (0.3f, cfg.q);
        const float a1 = 1.0f / (1.0f + g * (g + k)), a2 = g * a1, a3 = g * a2;
        const float v3 = x - ic2, v1 = a1 * ic1 + a2 * v3, v2 = ic2 + a2 * ic1 + a3 * v3;
        ic1 = 2 * v1 - ic1; ic2 = 2 * v2 - ic2;
        return v2;
    }

    const std::atomic<int>& preset;
    Preset cfg = presets[0];
    float velocity = 0.8f, env = 0, releaseSecs = 0.1f;
    bool releasing = false;
    float phaseA = 0, phaseB = 0, ic1 = 0, ic2 = 0;
    float freq = 440, targetFreq = 440, gainNow = 0, targetGain = 0, cut = 0, targetCut = 1000;
};

class BuiltinSynth
{
public:
    BuiltinSynth()
    {
        for (int i = 0; i < 16; ++i) synth.addVoice (new SlideVoice (preset));
        synth.setVoiceStealingEnabled (true);
        juce::MPEZoneLayout layout;
        layout.setLowerZone (15, 48, 2);
        synth.setZoneLayout (layout);
    }

    void setPreset (const juce::String& name) { preset = presetIndex (name); }
    juce::String presetName() const { return presets[juce::jlimit (0, (int) std::size (presets) - 1, preset.load())].name; }

    void prepare (double sampleRate) { synth.setCurrentPlaybackSampleRate (sampleRate); }

    void render (juce::AudioBuffer<float>& buffer, const juce::MidiBuffer& midi, int numSamples)
    {
        // master-channel volume (CC7) and expression (CC11) lanes
        for (const auto m : midi)
        {
            const auto msg = m.getMessage();
            if (msg.isController() && msg.getChannel() == 1)
            {
                if (msg.getControllerNumber() == 7) volume = msg.getControllerValue() / 100.0f;
                if (msg.getControllerNumber() == 11) expression = msg.getControllerValue() / 127.0f;
            }
        }
        synth.renderNextBlock (buffer, midi, 0, numSamples);
        const float g = 0.5f * volume * expression; // headroom for big chords before the soft clip
        for (int ch = 0; ch < buffer.getNumChannels(); ++ch)
        {
            auto* d = buffer.getWritePointer (ch);
            for (int i = 0; i < numSamples; ++i) d[i] = std::tanh (d[i] * g);
        }
    }

    void allNotesOff() { synth.turnOffAllVoices (false); }

private:
    std::atomic<int> preset { 0 };
    juce::MPESynthesiser synth;
    float volume = 1.0f, expression = 1.0f;
};
} // namespace slide
