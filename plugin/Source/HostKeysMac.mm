#include "HostKeys.h"
#import <AppKit/AppKit.h>

namespace slide
{
HostKeys::HostKeys (juce::Component& o, Handlers h) : owner (o), handlers (std::move (h))
{
    const NSEventMask mask = NSEventMaskKeyDown | NSEventMaskScrollWheel | NSEventMaskMagnify;
    id m = [NSEvent addLocalMonitorForEventsMatchingMask: mask handler: ^NSEvent* (NSEvent* ev)
    {
        NSView* view = (NSView*) owner.getWindowHandle();
        if (view == nil || [ev window] != [view window] || ! owner.isShowing())
            return ev;

        // where the pointer is, in SLIDE's own coordinates
        const auto mouse = juce::Desktop::getInstance().getMainMouseSource().getScreenPosition().roundToInt();
        const auto local = owner.getLocalPoint (nullptr, mouse);
        const bool over = owner.getLocalBounds().contains (local);
        const NSEventModifierFlags f = [ev modifierFlags];

        if ([ev type] == NSEventTypeKeyDown)
        {
            if ((f & NSEventModifierFlagCommand) == 0 || (f & NSEventModifierFlagControl) != 0) return ev;
            // only while SLIDE has keyboard focus (its web view or anything inside it)
            NSResponder* fr = [[view window] firstResponder];
            if (! [fr isKindOfClass: [NSView class]] || ! [(NSView*) fr isDescendantOf: view]) return ev;
            NSString* chars = [[ev charactersIgnoringModifiers] lowercaseString];
            if ([chars length] != 1) return ev;
            const auto key = juce::String::fromUTF8 ([chars UTF8String]);
            if (handlers.shortcut && handlers.shortcut (key, (f & NSEventModifierFlagShift) != 0, (f & NSEventModifierFlagOption) != 0))
                return nil;
            return ev;
        }

        if (! over) return ev;

        if ([ev type] == NSEventTypeScrollWheel)
        {
            if ((f & (NSEventModifierFlagCommand | NSEventModifierFlagControl)) == 0) return ev;
            float dx = (float) [ev scrollingDeltaX], dy = (float) [ev scrollingDeltaY];
            if (! [ev hasPreciseScrollingDeltas]) { dx *= 40.0f; dy *= 40.0f; }
            // DOM wheel deltas point the other way
            if (handlers.zoomScroll) handlers.zoomScroll (local, -dx, -dy, (f & NSEventModifierFlagShift) != 0);
            return nil;
        }

        if ([ev type] == NSEventTypeMagnify)
        {
            if (handlers.pinch) handlers.pinch (local, (float) [ev magnification]);
            return nil;
        }
        return ev;
    }];
    monitor = (void*) [m retain];
}

HostKeys::~HostKeys()
{
    if (monitor != nullptr)
    {
        [NSEvent removeMonitor: (id) monitor];
        [(id) monitor release];
    }
}
}
