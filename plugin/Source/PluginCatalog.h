// The list of AU/VST3 instruments installed on this computer. Shared by every
// SLIDE instance and cached on disk.
//
// SLIDE runs inside FL Studio, so the scan must not load other plug-ins into
// FL's process more than it has to:
//  - AU instruments are listed straight from macOS (AudioComponentFindNext),
//    without opening a single one, and effects are never touched.
//  - VST3 bundles that are only effects (per their moduleinfo.json), that have
//    an AU twin already listed, or that belong to FL Studio itself are skipped.
//  - The remaining VST3s are opened one per timer tick; one that crashes the
//    scan is remembered and skipped next time.
#pragma once
#include <juce_audio_processors/juce_audio_processors.h>
#include <optional>

namespace slide
{
class PluginCatalog final : public juce::ChangeBroadcaster, private juce::Timer
{
public:
    PluginCatalog();
    ~PluginCatalog() override;

    juce::AudioPluginFormatManager formats;

    /** Starts a scan unless one is running. Without force, a cached list is used as is. */
    void scan (bool force);
    bool isScanning() const { return scanning; }
    /** Name of the plug-in being checked right now, for the UI. */
    juce::String currentlyScanning() const { return nowScanning; }

    /** Instruments only, without SLIDE itself, as the UI's PluginInfo[]. */
    juce::var toVar() const;
    std::optional<juce::PluginDescription> find (const juce::String& id) const;
    bool hasCache() const { return cached; }

    static juce::File dataDir();
    /** Plug-ins SLIDE never loads (FL Studio's own, SLIDE itself). */
    static bool isBlocked (const juce::String& nameOrPath, const juce::String& vendor = {});

private:
    void timerCallback() override;
    void finish();
    void save();

    juce::Array<juce::PluginDescription> types;
    juce::StringArray vst3Queue;
    juce::StringArray crashed; // files that crashed an earlier scan
    bool scanning = false, cached = false;
    juce::String nowScanning;
};

/** AU instruments installed on this Mac, read without opening them (empty elsewhere). */
juce::Array<juce::PluginDescription> listAudioUnitInstruments();
}
