// The synths you can pick in SLIDE. Nothing is scanned or opened to build
// this list: AU instruments come from macOS's component registry and VST3s
// are listed by their bundle names. A plug-in is only opened when you pick it,
// so one that misbehaves can never disturb FL until you choose it yourself.
#pragma once
#include <juce_audio_processors/juce_audio_processors.h>
#include <optional>

namespace slide
{
class PluginCatalog final : public juce::ChangeBroadcaster
{
public:
    PluginCatalog();

    juce::AudioPluginFormatManager formats;

    /** Rebuilds the list (fast: reads names only). */
    void refresh();
    bool isScanning() const { return false; }
    juce::String currentlyScanning() const { return {}; }

    /** Instruments, without SLIDE itself, as the UI's PluginInfo[]. */
    juce::var toVar() const;
    std::optional<juce::PluginDescription> find (const juce::String& id) const;
    bool hasCache() const { return built; }

    /** A VST3 listed by name only: open its bundle and find the instrument inside. */
    std::optional<juce::PluginDescription> resolve (const juce::PluginDescription& listed, juce::String& error);

    static juce::File dataDir();
    /** Plug-ins SLIDE never lists (FL Studio's own, SLIDE itself). */
    static bool isBlocked (const juce::String& nameOrPath, const juce::String& vendor = {});

private:
    juce::Array<juce::PluginDescription> types;
    bool built = false;
};

/** AU instruments installed on this Mac, read without opening them (empty elsewhere). */
juce::Array<juce::PluginDescription> listAudioUnitInstruments();
}
