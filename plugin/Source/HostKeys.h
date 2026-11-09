// FL Studio (like most hosts) handles ⌘-key shortcuts and ⌘-scroll itself
// before a plug-in's web view ever sees them. While SLIDE has keyboard focus,
// this catches them first (an NSEvent local monitor on macOS) and hands them
// to SLIDE instead. Elsewhere it does nothing.
#pragma once
#include <juce_gui_basics/juce_gui_basics.h>
#include <functional>

namespace slide
{
class HostKeys
{
public:
    struct Handlers
    {
        /** ⌘ + key (lower-case character). Return true to keep it from the host. */
        std::function<bool (const juce::String& key, bool shift, bool alt)> shortcut;
        /** ⌘ or ctrl + scroll over SLIDE, in SLIDE's coordinates. */
        std::function<void (juce::Point<int> pos, float dx, float dy, bool shift)> zoomScroll;
        /** Trackpad pinch over SLIDE. */
        std::function<void (juce::Point<int> pos, float delta)> pinch;
    };

    HostKeys (juce::Component& owner, Handlers handlers);
    ~HostKeys();

private:
    juce::Component& owner;
    Handlers handlers;
    void* monitor = nullptr;

    JUCE_DECLARE_NON_COPYABLE (HostKeys)
};
}
