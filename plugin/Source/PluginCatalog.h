// The list of AU/VST3 instruments installed on this computer. Shared by every
// SLIDE instance, cached on disk, and scanned one file per timer tick on the
// message thread so FL stays responsive while it runs.
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
    juce::String currentlyScanning() const { return nowScanning; }

    /** Instruments only, without SLIDE itself, as the UI's PluginInfo[]. */
    juce::var toVar() const;
    std::optional<juce::PluginDescription> find (const juce::String& id) const;
    bool hasCache() const { return cached; }

    static juce::File dataDir();

private:
    void timerCallback() override;
    void startFormat();
    void finish();
    void save();

    juce::KnownPluginList list;
    std::unique_ptr<juce::PluginDirectoryScanner> scanner;
    int formatIndex = 0;
    bool scanning = false, cached = false;
    juce::String nowScanning;
};
}
