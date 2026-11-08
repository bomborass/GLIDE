// Plays a held note with a per-note MPE bend into a real synth and measures the
// pitch that comes out. Usage: SynthCheck <name part> (finds AU and VST3 versions).
#include "../Source/PluginCatalog.h"
#include "../Source/Clip.h"
#include <iostream>

using namespace slide;

static double pitchOf (const float* x, int n, double sr)
{
    // normalised autocorrelation; first strong peak between 60 Hz and 1.2 kHz
    int bestLag = 0; double best = 0;
    const int minLag = (int) (sr / 1200), maxLag = (int) (sr / 60);
    std::vector<double> r ((size_t) maxLag + 1);
    double e0 = 0; for (int i = 0; i < n - maxLag; ++i) e0 += x[i] * x[i];
    if (e0 <= 1e-9) return 0;
    for (int lag = minLag; lag <= maxLag; ++lag)
    {
        double s = 0; for (int i = 0; i < n - maxLag; ++i) s += x[i] * x[i + lag];
        r[(size_t) lag] = s / e0;
    }
    double peak = 0; for (int lag = minLag; lag <= maxLag; ++lag) peak = std::max (peak, r[(size_t) lag]);
    for (int lag = minLag + 1; lag < maxLag; ++lag)
        if (r[(size_t) lag] > 0.8 * peak && r[(size_t) lag] >= r[(size_t) lag - 1] && r[(size_t) lag] >= r[(size_t) lag + 1]) { bestLag = lag; best = r[(size_t) lag]; break; }
    return bestLag ? sr / bestLag : 0;
}

static double playBent (juce::AudioPluginInstance& p, double semis, int range, bool vst3)
{
    const auto setup = mpeSetup (range);
    const int noteBlock = vst3 ? (int) setup.size() + 4 : 4;
    const double sr = 48000; const int bs = 512;
    p.enableAllBuses();
    p.prepareToPlay (sr, bs);
    const int ch = juce::jmax (2, p.getTotalNumInputChannels(), p.getTotalNumOutputChannels());
    juce::AudioBuffer<float> blk (ch, bs), out (1, (int) sr + noteBlock * bs);
    juce::MidiBuffer m;
    const int total = (int) sr + noteBlock * bs;
    for (int pos = 0; pos < total; pos += bs)
    {
        m.clear();
        if (vst3) { if (pos / bs < (int) setup.size()) m.addEvent (setup[(size_t) (pos / bs)].data, setup[(size_t) (pos / bs)].size, 0); }
        else if (pos == 0) for (auto& e : setup) m.addEvent (e.data, e.size, 0);
        if (pos == noteBlock * bs)
        {
            const int v = juce::jlimit (0, 16383, (int) std::lround (8192 + semis / range * 8192));
            const juce::uint8 pb[3] = { 0xe1, (juce::uint8) (v & 127), (juce::uint8) (v >> 7) };
            const juce::uint8 on[3] = { 0x91, 57, 100 };
            m.addEvent (pb, 3, 0);
            m.addEvent (on, 3, 64);
        }
        blk.clear();
        p.processBlock (blk, m);
        out.copyFrom (0, pos, blk, 0, 0, juce::jmin (bs, total - pos));
    }
    const juce::uint8 off[3] = { 0x81, 57, 64 };
    m.clear(); m.addEvent (off, 3, 0); blk.clear(); p.processBlock (blk, m);
    p.releaseResources();
    return pitchOf (out.getReadPointer (0, total - (int) sr / 2), (int) sr / 2, sr);
}

int main (int argc, char** argv)
{
    juce::ScopedJuceInitialiser_GUI gui;
    const juce::String want = argc > 1 ? argv[1] : "Surge XT";
    PluginCatalog cat;
    juce::Array<juce::PluginDescription> found;
    for (auto& d : listAudioUnitInstruments()) if (d.name.containsIgnoreCase (want)) found.add (d);
    for (auto* f : cat.formats.getFormats())
        if (f->getName() == "VST3")
            for (auto& path : f->searchPathsForPlugins (f->getDefaultLocationsToSearch(), true, false))
                if (path.containsIgnoreCase (want))
                {
                    juce::OwnedArray<juce::PluginDescription> ds; f->findAllTypesForFile (ds, path);
                    for (auto* d : ds) if (d->isInstrument) found.add (*d);
                }
    if (found.isEmpty()) { std::cout << "no plug-in matching " << want << "\n"; return 1; }

    for (auto& d : found)
    {
        juce::String err;
        auto p = cat.formats.createPluginInstance (d, 48000, 512, err);
        if (! p) { std::cout << d.pluginFormatName << " " << d.name << ": could not open: " << err << "\n"; continue; }
        std::cout << d.pluginFormatName << " " << d.name << " (supportsMPE " << (p->supportsMPE() ? "yes" : "no") << ")\n";
        for (double semis : { 0.0, 5.0, 12.0 })
        {
            const double want = 220.0 * std::pow (2.0, semis / 12.0);
            const double got = playBent (*p, semis, 48, d.pluginFormatName == "VST3");
            std::cout << "   bend +" << semis << " st: " << got << " Hz (want " << want << ")  "
                      << (std::abs (12 * std::log2 (juce::jmax (1.0, got) / want)) < 0.3 ? "OK" : "WRONG") << "\n";
        }
    }
    return 0;
}
