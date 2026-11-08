// Lists AU instruments from the system's component registry without opening
// any of them. The descriptions match what JUCE's AudioUnitPluginFormat writes,
// so createPluginInstance finds the component from fileOrIdentifier.
#include "PluginCatalog.h"
#include <AudioToolbox/AudioToolbox.h>

namespace slide
{
static juce::String fourCC (OSType t)
{
    const juce::juce_wchar s[4] = { (juce::juce_wchar) ((t >> 24) & 0xff), (juce::juce_wchar) ((t >> 16) & 0xff),
                              (juce::juce_wchar) ((t >> 8) & 0xff), (juce::juce_wchar) (t & 0xff) };
    return juce::String (s, 4);
}

juce::Array<juce::PluginDescription> listAudioUnitInstruments()
{
    juce::Array<juce::PluginDescription> out;
    AudioComponentDescription want {};
    want.componentType = kAudioUnitType_MusicDevice;

    for (AudioComponent comp = AudioComponentFindNext (nullptr, &want); comp != nullptr; comp = AudioComponentFindNext (comp, &want))
    {
        AudioComponentDescription d {};
        if (AudioComponentGetDescription (comp, &d) != noErr) continue;

        juce::String full;
        CFStringRef cfName = nullptr;
        if (AudioComponentCopyName (comp, &cfName) == noErr && cfName != nullptr)
        {
            full = juce::String::fromCFString (cfName);
            CFRelease (cfName);
        }
        juce::String vendor, name = full;
        if (full.contains (":"))
        {
            vendor = full.upToFirstOccurrenceOf (":", false, false).trim();
            name = full.fromFirstOccurrenceOf (":", false, false).trim();
        }
        if (name.isEmpty()) continue;

        UInt32 version = 0;
        AudioComponentGetVersion (comp, &version);

        juce::PluginDescription p;
        p.name = name;
        p.descriptiveName = name;
        p.manufacturerName = vendor;
        p.pluginFormatName = "AudioUnit";
        p.category = "Synth";
        p.fileOrIdentifier = "AudioUnit:Synths/" + fourCC (d.componentType) + "," + fourCC (d.componentSubType) + "," + fourCC (d.componentManufacturer);
        p.uniqueId = p.deprecatedUid = ((int) d.componentType) ^ ((int) d.componentSubType) ^ ((int) d.componentManufacturer);
        p.version = juce::String ((version >> 16) & 0xffff) + "." + juce::String ((version >> 8) & 0xff) + "." + juce::String (version & 0xff);
        p.isInstrument = true;
        p.numInputChannels = 0;
        p.numOutputChannels = 2;
        p.lastInfoUpdateTime = juce::Time::getCurrentTime();
        out.add (p);
    }
    return out;
}
}
