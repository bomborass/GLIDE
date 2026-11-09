// Playing Mode: chords you play keep sounding after you let go ("hold for
// glide"). The next chord you play (strummed is fine: notes arriving within the
// strum window count as one chord) doesn't restart the sound: every sounding
// voice glides to the closest note of the new chord, lines never cross and each
// note is used once. Voices left over fade out, extra notes start fresh. After
// a few seconds without new notes everything is let go.
//
// Runs on the audio thread and writes the MPE stream itself (one voice per
// member channel), so glides are smooth and immediate. What happens is also
// reported as events, for the UI's display and to write the phrase into the clip.
#pragma once
#include <juce_audio_basics/juce_audio_basics.h>
#include <array>
#include <atomic>

namespace slide
{
class PlayEngine
{
public:
    struct Event
    {
        enum Type { start, glide, end, phraseOn, phraseOff };
        int type = start;
        int id = 0;
        float pitch = 0, to = 0, ms = 0, vel = 0;
        double at = 0; // seconds since the phrase began
    };

    // settings (set from the message thread)
    std::atomic<float> glideMs { 325 }, holdSecs { 8 }, strumMs { 70 };
    std::atomic<bool> distance { false };

    void prepare (double sampleRate);
    /** Call first in every audio block. */
    void beginBlock (int numSamples) { blockLen = juce::jmax (1, numSamples); }
    void noteOn (int pitch, float velocity, int offset, int range, juce::MidiBuffer& out);
    void pressure (float value, int offset, juce::MidiBuffer& out);
    /** Let every voice go now (e.g. leaving Playing Mode). */
    void releaseAll (int offset, juce::MidiBuffer& out);
    /** Glides, chord resolution and the idle timeout for one block, then the clock moves on. */
    void process (int numSamples, int range, juce::MidiBuffer& out);

    bool isActive() const { return phrase; }
    /** Message thread: the next event, if any. */
    bool popEvent (Event& e);

private:
    struct Voice
    {
        bool on = false;
        int ch = 0, base = 0, id = 0, lastBend = -1;
        double from = 0, to = 0;
        juce::int64 t0 = 0, dur = 0;
        float vel = 0.8f;
        juce::int64 started = 0;
        double pitchAt (juce::int64 t) const;
    };

    void startVoice (int pitch, float vel, juce::int64 at, int offset, juce::MidiBuffer& out);
    void endVoice (Voice& v, juce::int64 at, int offset, juce::MidiBuffer& out);
    void resolveChord (juce::int64 at, int offset, int range, juce::MidiBuffer& out);
    void sendBend (Voice& v, double pitch, int range, int offset, juce::MidiBuffer& out);
    void push (Event e);
    double secs (juce::int64 t) const { return (double) (t - phraseStart) / sr; }

    double sr = 44100;
    juce::int64 clock = 0, phraseStart = 0, lastOn = 0, firstChordUntil = 0, pendFirst = 0, pendDeadline = 0;
    bool phrase = false, glided = false;
    int nextId = 1, rr = 0;
    std::array<Voice, 12> voices {};
    std::array<std::pair<int, float>, 24> pend {};
    int numPend = 0;
    int pressureValue = 90;
    int blockLen = 512;

    std::array<Event, 2048> events {};
    juce::AbstractFifo fifo { 2048 };
};
}
