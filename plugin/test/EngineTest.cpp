// Headless engine check: compiles a clip, plays it through SlideProcessor with a
// fake host transport, and renders it to .wav with the built-in synth.
#include "../Source/PluginProcessor.h"
#include <iostream>

using namespace slide;

struct FakeHead final : juce::AudioPlayHead
{
    double ppq = 0, bpm = 84;
    bool playing = true;
    juce::Optional<PositionInfo> getPosition() const override
    {
        PositionInfo p;
        p.setBpm (bpm);
        p.setPpqPosition (ppq);
        p.setIsPlaying (playing);
        return p;
    }
};

static int fails = 0;
static void check (bool ok, const juce::String& what)
{
    std::cout << (ok ? "  ok   " : "  FAIL ") << what << "\n";
    if (! ok) ++fails;
}

int main (int argc, char** argv)
{
    juce::ScopedJuceInitialiser_GUI gui;
    if (argc < 2) { std::cout << "usage: SlideTest clip.json\n"; return 2; }
    juce::var clip;
    if (! juce::JSON::parse (juce::File (argv[1]).loadFileAsString(), clip).wasOk()) { std::cout << "bad json\n"; return 2; }

    const auto c = compileClip (clip);
    std::cout << "compiled: " << c.events.size() << " events, length " << c.length << " beats\n";
    int ons = 0, offs = 0;
    for (auto& e : c.events) { const int st = e.data[0] & 0xf0; if (st == 0x90) ++ons; if (st == 0x80) ++offs; }
    check (ons > 0 && ons == offs, "note-ons match note-offs (" + juce::String (ons) + ")");
    check (std::is_sorted (c.events.begin(), c.events.end(), [] (auto& a, auto& b) { return a.beat < b.beat; }), "events sorted");

    // pitch: a note bent +5 semitones through the MPE stream must sound 5 semitones up
    {
        BuiltinSynth s; s.setPreset ("Pure Sine"); s.prepare (48000);
        juce::AudioBuffer<float> b (2, 48000); juce::MidiBuffer m;
        for (auto& e : mpeSetup (48)) m.addEvent (e.data, e.size, 0);
        const int v = (int) std::lround (8192 + 5.0 / 48 * 8192);
        const juce::uint8 pb[3] = { 0xe1, (juce::uint8) (v & 127), (juce::uint8) (v >> 7) }, on[3] = { 0x91, 57, 100 };
        m.addEvent (pb, 3, 0); m.addEvent (on, 3, 0);
        b.clear(); s.render (b, m, 48000);
        int zc = 0; auto* d = b.getReadPointer (0);
        for (int i = 24000; i < 47999; ++i) if (d[i] < 0 && d[i + 1] >= 0) ++zc;
        check (std::abs (zc * 2 - 293.7) < 6, "bent note sounds at the right pitch (" + juce::String (zc * 2) + " Hz, want 294)");
    }

    // pressure: a soft and a hard note through the built-in synth, and the "sends as" options
    {
        auto render = [] (double pr)
        {
            juce::var c = juce::JSON::parse (R"({"bars":1,"range":48,"notes":[{"pitch":60,"start":0,"length":4,"velocity":0.8,"bend":[],"pressure":[{"t":0,"v":)" + juce::String (pr) + R"(},{"t":1,"v":)" + juce::String (pr) + R"(}]}],"cc":[]})");
            const auto comp = compileClip (c);
            BuiltinSynth s; s.prepare (48000);
            juce::AudioBuffer<float> b (2, 24000); juce::MidiBuffer m;
            for (auto& e : comp.setup) m.addEvent (e.data, e.size, 0);
            for (auto& e : comp.events) if (e.beat < 1) m.addEvent (e.data, e.size, (int) (e.beat * 24000));
            b.clear(); s.render (b, m, 24000);
            return b.getRMSLevel (0, 12000, 12000);
        };
        const float soft = render (0.1), hard = render (1.0);
        check (hard > soft * 2, "pressure changes the built-in synth (rms " + juce::String (soft, 4) + " -> " + juce::String (hard, 4) + ")");
        auto firstStatus = [] (const char* as)
        {
            const auto comp = compileClip (juce::JSON::parse (juce::String (R"({"bars":1,"range":48,"pressureAs":")") + as + R"(","notes":[{"pitch":60,"start":0,"length":4,"velocity":0.8,"bend":[],"pressure":[]}],"cc":[]})"));
            for (auto& e : comp.events) { const int st = e.data[0] & 0xf0; if (st == 0xd0 || st == 0xa0 || (st == 0xb0 && e.data[1] != 10)) return st == 0xb0 ? 0xb000 + e.data[1] : st; }
            return 0;
        };
        check (firstStatus ("pressure") == 0xd0 && firstStatus ("polyAT") == 0xa0 && firstStatus ("cc74") == 0xb000 + 74 && firstStatus ("cc11") == 0xb000 + 11,
               "pressure can go out as channel pressure, poly aftertouch or a CC");
    }

    SlideProcessor proc;
    proc.setClip (clip);
    proc.useBuiltin ("Glass Saw");
    FakeHead head;
    proc.setPlayHead (&head);
    const double sr = 48000; const int bs = 480;
    proc.setPlayConfigDetails (0, 2, sr, bs);
    proc.prepareToPlay (sr, bs);

    juce::AudioBuffer<float> buf (2, bs);
    juce::MidiBuffer midi;
    float peak = 0; int midiOut = 0, notesOnOut = 0, notesOffOut = 0;
    const int blocks = (int) (c.length * 60.0 / head.bpm * sr / bs) + 50; // one full loop and a bit
    for (int i = 0; i < blocks; ++i)
    {
        midi.clear();
        proc.processBlock (buf, midi);
        peak = juce::jmax (peak, buf.getMagnitude (0, bs));
        for (const auto m : midi) { ++midiOut; auto msg = m.getMessage(); if (msg.isNoteOn()) ++notesOnOut; if (msg.isNoteOff()) ++notesOffOut; }
        head.ppq += bs / (sr * 60.0 / head.bpm);
    }
    std::cout << "played " << blocks << " blocks: peak " << peak << ", midi out " << midiOut << " (on " << notesOnOut << ", off " << notesOffOut << ")\n";
    check (peak > 0.01f && peak <= 1.0f, "host playback makes sound within range");
    check (notesOnOut >= ons, "every note played at least once while looping");

    // stopping the host releases everything
    head.playing = false;
    for (int i = 0; i < 200; ++i) { midi.clear(); proc.processBlock (buf, midi); }
    check (buf.getMagnitude (0, bs) < 1e-4f, "silent after the host stops");

    // SLIDE's own play button with a loop range
    proc.transport ("play", 4, juce::JSON::parse ("[4, 8]"));
    float peak2 = 0;
    for (int i = 0; i < 400; ++i) { midi.clear(); proc.processBlock (buf, midi); peak2 = juce::jmax (peak2, buf.getMagnitude (0, bs)); }
    const auto t = proc.getTransport();
    std::cout << "internal play: beat " << t.beat << " peak " << peak2 << "\n";
    check (t.playing && t.beat >= 4 && t.beat < 8, "internal transport loops inside the range");
    proc.transport ("stop", 0, {});
    for (int i = 0; i < 5; ++i) { midi.clear(); proc.processBlock (buf, midi); }
    check (! proc.getTransport().playing, "internal transport stops");

    // keyboard
    proc.keyDown (60, 0.8f);
    midi.clear(); proc.processBlock (buf, midi);
    bool sawKey = false;
    for (const auto m : midi) if (m.getMessage().isNoteOn() && m.getMessage().getNoteNumber() == 60) sawKey = true;
    check (sawKey, "on-screen key sends a note");
    proc.keyUp (60);
    for (int i = 0; i < 100; ++i) { midi.clear(); proc.processBlock (buf, midi); }
    check (buf.getMagnitude (0, bs) < 1e-4f, "key released: silent again");
    proc.audition (64, 0.8f);
    for (int i = 0; i < 100; ++i) { midi.clear(); proc.processBlock (buf, midi); }
    check (buf.getMagnitude (0, bs) < 1e-4f, "clicked note stops by itself");

    // Playing Mode: a held chord glides into the next one, then lets go after the hold time
    {
        proc.setPlayMode (true, 300, false, 2.0f, 70);
        auto runBlocks = [&] (int count, juce::MidiBuffer input, int& ons, int& offs, int& bends)
        {
            for (int i = 0; i < count; ++i)
            {
                midi.clear();
                if (i == 0) midi.addEvents (input, 0, -1, 0);
                proc.processBlock (buf, midi);
                for (const auto m : midi)
                {
                    const auto msg = m.getMessage();
                    if (msg.isNoteOn()) ++ons; else if (msg.isNoteOff()) ++offs; else if (msg.isPitchWheel() && msg.getPitchWheelValue() != 8192) ++bends;
                }
            }
        };
        head.playing = false;
        juce::MidiBuffer chord1, release1, chord2;
        for (int p : { 60, 64, 67 }) { chord1.addEvent (juce::MidiMessage::noteOn (1, p, 0.8f), 0); release1.addEvent (juce::MidiMessage::noteOff (1, p), 0); }
        // a strummed chord: notes 15 ms apart
        int k = 0; for (int p : { 62, 65, 69 }) chord2.addEvent (juce::MidiMessage::noteOn (1, p, 0.8f), juce::jmin (bs - 1, 720 * k++ / 2));
        int ons = 0, offs = 0, bends = 0;
        runBlocks (5, {}, ons, offs, bends); // mode switch
        ons = offs = bends = 0;
        runBlocks (20, chord1, ons, offs, bends);
        check (ons == 3, "Playing Mode: first chord sounds right away (" + juce::String (ons) + " notes)");
        ons = offs = bends = 0;
        runBlocks (50, release1, ons, offs, bends);
        check (offs == 0 && buf.getMagnitude (0, bs) > 0.01f, "letting go of the keys keeps the chord sounding");
        ons = offs = bends = 0;
        runBlocks (60, chord2, ons, offs, bends);
        check (ons == 0 && offs == 0 && bends > 10, "the next (strummed) chord glides in without new attacks (" + juce::String (bends) + " bend steps)");
        ons = offs = bends = 0;
        runBlocks (250, {}, ons, offs, bends);
        check (offs == 3, "after the hold time everything is let go (" + juce::String (offs) + " notes off)");
        juce::StringArray seen;
        PlayEngine::Event e;
        static const char* names[] = { "start", "glide", "end", "phraseOn", "phraseOff" };
        while (proc.play.popEvent (e)) seen.add (names[e.type]);
        std::cout << "  events: " << seen.joinIntoString (" ") << "\n";
        check (seen.joinIntoString (" ") == "phraseOn start start start glide glide glide end end end phraseOff", "the UI is told what happened");
        proc.setPlayMode (false, 300, false, 8, 70);
        for (int i = 0; i < 5; ++i) { midi.clear(); proc.processBlock (buf, midi); }
        head.playing = true;
    }

    // state round trip
    juce::MemoryBlock state;
    proc.getStateInformation (state);
    SlideProcessor proc2;
    proc2.setStateInformation (state.getData(), (int) state.getSize());
    check (juce::JSON::toString (proc2.getClip(), true) == juce::JSON::toString (proc.getClip(), true), "clip survives save and load");
    check (proc2.instrumentVar().getProperty ("name", "").toString() == "Glass Saw", "built-in synth choice survives save and load");

    // wav render
    juce::String err;
    const auto f = proc.renderWav (err);
    check (f.existsAsFile() && f.getSize() > 100000, "wav render: " + (f.existsAsFile() ? f.getFullPathName() : err));
    if (f.existsAsFile())
    {
        juce::WavAudioFormat wav;
        std::unique_ptr<juce::AudioFormatReader> r (wav.createReaderFor (new juce::FileInputStream (f), true));
        juce::Range<float> lv[2];
        r->readMaxLevels (0, r->lengthInSamples, lv, 2);
        const float pk = juce::jmax (lv[0].getEnd(), -lv[0].getStart());
        std::cout << "  wav " << r->lengthInSamples / r->sampleRate << " s, peak " << pk << "\n";
        check (pk > 0.01f, "wav has sound");
    }
    proc.releaseResources();

   #if JUCE_MAC
    // AU instruments listed without opening them must still open by that description
    {
        const auto aus = listAudioUnitInstruments();
        std::cout << "AU instruments: " << aus.size() << "\n";
        for (auto& d : aus) std::cout << "    " << d.manufacturerName << " / " << d.name << "  " << d.fileOrIdentifier << "\n";
        check (aus.size() > 0, "AU instruments listed");
        PluginCatalog cat;
        cat.refresh();
        const auto listed = cat.toVar();
        std::cout << "synth list: " << juce::JSON::toString (listed, true).substring (0, 400) << "\n";
        check (listed.size() >= (int) aus.size(), "synth list built without opening anything");
        for (auto& d : aus)
            if (d.manufacturerName.containsIgnoreCase ("Apple"))
            {
                juce::String e;
                auto inst = cat.formats.createPluginInstance (d, 44100, 512, e);
                check (inst != nullptr, "opens " + d.name + (e.isNotEmpty() ? " (" + e + ")" : juce::String()));
                break;
            }
    }
   #endif
    std::cout << (fails ? "FAILED " : "ALL OK ") << fails << "\n";
    return fails ? 1 : 0;
}
