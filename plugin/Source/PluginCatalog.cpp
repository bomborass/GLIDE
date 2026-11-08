#include "PluginCatalog.h"

namespace slide
{
juce::File PluginCatalog::dataDir()
{
    auto d = juce::File::getSpecialLocation (juce::File::userApplicationDataDirectory)
#if JUCE_MAC
                 .getChildFile ("Application Support")
#endif
                 .getChildFile ("SLIDE");
    d.createDirectory();
    return d;
}

bool PluginCatalog::isBlocked (const juce::String& nameOrPath, const juce::String& vendor)
{
    // FL Studio's own plug-in versions only run inside FL's core
    static const char* blocked[] = { "fl studio", "flstudio", "fruity", "image-line", "imageline" };
    const auto n = juce::File::isAbsolutePath (nameOrPath) ? juce::File (nameOrPath).getFileNameWithoutExtension().toLowerCase()
                                                           : nameOrPath.toLowerCase();
    if (n == "slide") return true;
    const auto v = vendor.toLowerCase();
    for (auto* b : blocked)
        if (n.contains (b) || v.contains (b)) return true;
    return false;
}

namespace
{
/** VST3 bundles since SDK 3.7.5 describe their classes in moduleinfo.json (read
    as a plain file). Returns false only when that file says there's no instrument. */
bool mightBeInstrument (const juce::File& bundle)
{
    const auto info = bundle.getChildFile ("Contents/Resources/moduleinfo.json");
    if (! info.existsAsFile()) return true;
    juce::var v;
    if (! juce::JSON::parse (info.loadFileAsString(), v).wasOk()) return true;
    auto* classes = v.getProperty ("Classes", {}).getArray();
    if (classes == nullptr) return true;
    for (auto& c : *classes)
    {
        if (c.getProperty ("Category", "").toString() != "Audio Module Class") continue;
        if (auto* subs = c.getProperty ("Sub Categories", {}).getArray())
            for (auto& s : *subs)
                if (s.toString().containsIgnoreCase ("Instrument") || s.toString().containsIgnoreCase ("Synth")) return true;
    }
    return false;
}

juce::String vendorFromModuleInfo (const juce::File& bundle)
{
    juce::var v;
    const auto info = bundle.getChildFile ("Contents/Resources/moduleinfo.json");
    if (info.existsAsFile() && juce::JSON::parse (info.loadFileAsString(), v).wasOk())
        return v.getProperty ("Factory Info", {}).getProperty ("Vendor", "").toString();
    return {};
}

juce::AudioPluginFormat* formatNamed (juce::AudioPluginFormatManager& m, const juce::String& name)
{
    for (auto* f : m.getFormats())
        if (f->getName() == name) return f;
    return nullptr;
}
} // namespace

PluginCatalog::PluginCatalog()
{
#if JUCE_PLUGINHOST_VST3
    formats.addFormat (new juce::VST3PluginFormat());
#endif
#if JUCE_PLUGINHOST_AU && JUCE_MAC
    formats.addFormat (new juce::AudioUnitPluginFormat());
#endif
}

void PluginCatalog::refresh()
{
    types.clear();

    juce::StringArray auNames;
    for (auto& d : listAudioUnitInstruments())
    {
        if (isBlocked (d.name, d.manufacturerName)) continue;
        types.add (d);
        auNames.add (d.name.toLowerCase());
    }

    // VST3s by bundle name. One that also exists as an AU is listed once (the AU).
    if (auto* vst3 = formatNamed (formats, "VST3"))
        for (auto& path : vst3->searchPathsForPlugins (vst3->getDefaultLocationsToSearch(), true, false))
        {
            const juce::File bundle (path);
            const auto name = bundle.getFileNameWithoutExtension();
            if (isBlocked (path) || auNames.contains (name.toLowerCase()) || ! mightBeInstrument (bundle)) continue;
            juce::PluginDescription d;
            d.name = d.descriptiveName = name;
            d.manufacturerName = vendorFromModuleInfo (bundle);
            d.pluginFormatName = "VST3";
            d.fileOrIdentifier = path;
            d.isInstrument = true;
            d.uniqueId = d.deprecatedUid = 0; // not opened yet
            types.add (d);
        }

    built = true;
    sendChangeMessage();
}

std::optional<juce::PluginDescription> PluginCatalog::resolve (const juce::PluginDescription& listed, juce::String& error)
{
    if (listed.pluginFormatName != "VST3" || listed.uniqueId != 0 || listed.deprecatedUid != 0) return listed;
    auto* vst3 = formatNamed (formats, "VST3");
    if (vst3 == nullptr) { error = "VST3 isn't available."; return std::nullopt; }

    juce::OwnedArray<juce::PluginDescription> found;
    vst3->findAllTypesForFile (found, listed.fileOrIdentifier);
    if (found.isEmpty()) { error = listed.name + " could not be opened."; return std::nullopt; }
    for (auto* d : found)
        if (d->isInstrument) return *d;
    error = listed.name + " is an effect, not an instrument.";
    return std::nullopt;
}

juce::var PluginCatalog::toVar() const
{
    auto sorted = types;
    std::sort (sorted.begin(), sorted.end(), [] (const auto& a, const auto& b) { return a.name.compareIgnoreCase (b.name) < 0; });
    juce::Array<juce::var> out;
    for (const auto& d : sorted)
    {
        auto* o = new juce::DynamicObject();
        o->setProperty ("id", d.createIdentifierString());
        o->setProperty ("name", d.name);
        o->setProperty ("vendor", d.manufacturerName);
        o->setProperty ("format", d.pluginFormatName == "VST3" ? "VST3" : "AU");
        out.add (juce::var (o));
    }
    return out;
}

std::optional<juce::PluginDescription> PluginCatalog::find (const juce::String& id) const
{
    for (const auto& d : types)
        if (d.createIdentifierString() == id) return d;
    return std::nullopt;
}

#if ! JUCE_MAC
juce::Array<juce::PluginDescription> listAudioUnitInstruments() { return {}; }
#endif
}
