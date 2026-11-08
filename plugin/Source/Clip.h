// Turns the UI's clip (same JSON shape as ui/src/model.ts) into a sorted list
// of timed MIDI events: the same MPE stream the UI's .mid export writes.
// Built on the message thread; the audio thread only reads the result.
#pragma once
#include <juce_audio_basics/juce_audio_basics.h>
#include <vector>

namespace slide
{
/** One MIDI event at a clip position in beats. `order` sorts events that share a beat. */
struct MidiEv
{
    double beat = 0;
    int order = 0;
    juce::uint8 data[3] {};
    int size = 3;

    juce::MidiMessage toMessage() const { return juce::MidiMessage (data, size); }
};

/** A hosted-synth parameter value at a clip position (recorded knob lanes). */
struct ParamEv
{
    double beat = 0;
    int index = 0;
    float value = 0;
};

struct Compiled
{
    double length = 32;   // clip length in beats (whole bars)
    double lastNoteEnd = 0;
    int range = 48;       // per-note pitch-bend range in semitones
    std::vector<MidiEv> setup;   // MPE configuration + bend ranges, sent before playing
    std::vector<MidiEv> events;  // sorted by beat, then order
    std::vector<ParamEv> params; // sorted by beat
    std::vector<int> drivenParams; // hosted parameter indices that have a lane with points
};

constexpr int masterChannel = 0;      // MIDI channel 1
constexpr int firstClipChannel = 1;   // channels 2..13 play the clip
constexpr int lastClipChannel = 12;
constexpr int firstLiveChannel = 13;  // channels 14..16 play the keyboard and auditions
constexpr int lastLiveChannel = 15;
constexpr int masterBendRange = 2;

Compiled compileClip (const juce::var& clip);

/** Messages that set up a lower MPE zone (15 members) with the given bend range. */
std::vector<MidiEv> mpeSetup (int range);
}
