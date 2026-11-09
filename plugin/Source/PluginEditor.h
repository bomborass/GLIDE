// The editor is the web UI (ui/dist/index.html, compiled into the plugin) in a
// juce::WebBrowserComponent, plus the event bridge described in ui/src/bridge.ts.
#pragma once
#include <juce_gui_extra/juce_gui_extra.h>
#include "PluginProcessor.h"
#include "HostKeys.h"

namespace slide
{
class SlideEditor final : public juce::AudioProcessorEditor,
                          private juce::Timer,
                          private juce::ChangeListener
{
public:
    explicit SlideEditor (SlideProcessor&);
    ~SlideEditor() override;

    void paint (juce::Graphics&) override;
    void resized() override;

private:
    juce::WebBrowserComponent::Options makeOptions();
    void emit (const char* event, const juce::var& payload);
    void timerCallback() override;
    void changeListenerCallback (juce::ChangeBroadcaster*) override;

    void sendInit();
    void sendPluginList();
    void saveBytes (const juce::String& name, const juce::MemoryBlock& data);
    void saveCopyOf (const juce::File& file);
    void dragFile (const juce::File& file);
    juce::File writeExport (const juce::String& name, const juce::String& base64);
    void flashError (const juce::String& message);

    SlideProcessor& proc;
    juce::WebBrowserComponent browser;
    std::unique_ptr<juce::FileChooser> chooser;
    std::unique_ptr<HostKeys> hostKeys;
    bool lastPlaying = false;
    double lastBeat = -1, lastBpm = -1;
    int idleTicks = 0;

    JUCE_DECLARE_WEAK_REFERENCEABLE (SlideEditor)
    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (SlideEditor)
};
}
