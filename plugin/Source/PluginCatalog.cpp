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
    // FL Studio's own plug-in versions only run inside FL's core ("Can't get core function pointer")
    static const char* names[] = { "fl studio", "flstudio", "fruity", "image-line", "imageline", "slide" };
    const auto n = juce::File::isAbsolutePath (nameOrPath) ? juce::File (nameOrPath).getFileNameWithoutExtension().toLowerCase()
                                                           : nameOrPath.toLowerCase();
    const auto v = vendor.toLowerCase();
    for (auto* b : names)
    {
        if (juce::String (b) == "slide" ? n == "slide" : n.contains (b)) return true;
        if (v.contains (b) && juce::String (b) != "slide") return true;
    }
    return false;
}

namespace
{
/** VST3 bundles since SDK 3.7.5 describe their classes in moduleinfo.json.
    Returns false only when that file exists and lists no instrument. */
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

juce::File cacheFile()   { return PluginCatalog::dataDir().getChildFile ("plugins-v2.xml"); }
juce::File pedalFile()   { return PluginCatalog::dataDir().getChildFile ("scan-in-progress.txt"); }
juce::File crashedFile() { return PluginCatalog::dataDir().getChildFile ("skipped-plugins.txt"); }
} // namespace

PluginCatalog::PluginCatalog()
{
#if JUCE_PLUGINHOST_VST3
    formats.addFormat (new juce::VST3PluginFormat());
#endif
#if JUCE_PLUGINHOST_AU && JUCE_MAC
    formats.addFormat (new juce::AudioUnitPluginFormat());
#endif
    crashed.addLines (crashedFile().loadFileAsString());
    crashed.removeEmptyStrings();

    // a plug-in that crashed the last scan: never open it again
    if (pedalFile().existsAsFile())
    {
        crashed.addIfNotAlreadyThere (pedalFile().loadFileAsString().trim());
        crashedFile().replaceWithText (crashed.joinIntoString ("\n"));
        pedalFile().deleteFile();
    }

    if (auto xml = juce::XmlDocument::parse (cacheFile()))
    {
        juce::KnownPluginList list;
        list.recreateFromXml (*xml);
        types = list.getTypes();
        cached = true;
    }
}

PluginCatalog::~PluginCatalog() { stopTimer(); }

void PluginCatalog::scan (bool force)
{
    if (scanning) return;
    if (cached && ! force) { sendChangeMessage(); return; }
    scanning = true;
    types.clear();

    // AU instruments: read from the system registry, nothing is opened
    juce::StringArray auNames;
    for (auto& d : listAudioUnitInstruments())
    {
        if (isBlocked (d.name, d.manufacturerName)) continue;
        types.add (d);
        auNames.add (d.name.toLowerCase());
    }

    // VST3: only bundles that may hold an instrument and have no AU version
    vst3Queue.clear();
    for (auto* f : formats.getFormats())
    {
        if (f->getName() != "VST3") continue;
        for (auto& path : f->searchPathsForPlugins (f->getDefaultLocationsToSearch(), true, false))
        {
            const juce::File bundle (path);
            const auto name = bundle.getFileNameWithoutExtension();
            if (isBlocked (path) || crashed.contains (path)) continue;
            if (auNames.contains (name.toLowerCase())) continue;
            if (! mightBeInstrument (bundle)) continue;
            vst3Queue.add (path);
        }
    }
    sendChangeMessage(); // the AU list is ready already
    startTimer (30);
}

void PluginCatalog::timerCallback()
{
    if (vst3Queue.isEmpty()) { finish(); return; }
    const auto path = vst3Queue[0];
    vst3Queue.remove (0);
    nowScanning = juce::File (path).getFileNameWithoutExtension();

    juce::AudioPluginFormat* vst3 = nullptr;
    for (auto* f : formats.getFormats()) if (f->getName() == "VST3") vst3 = f;
    if (vst3 == nullptr) return;

    pedalFile().replaceWithText (path);
    juce::OwnedArray<juce::PluginDescription> found;
    vst3->findAllTypesForFile (found, path);
    pedalFile().deleteFile();

    for (auto* d : found)
        if (d->isInstrument && ! isBlocked (d->name, d->manufacturerName))
            types.add (*d);
    sendChangeMessage();
}

void PluginCatalog::finish()
{
    stopTimer();
    scanning = false;
    cached = true;
    nowScanning = {};
    save();
    sendChangeMessage();
}

void PluginCatalog::save()
{
    juce::KnownPluginList list;
    for (auto& d : types) list.addType (d);
    if (auto xml = list.createXml())
        xml->writeTo (cacheFile());
}

juce::var PluginCatalog::toVar() const
{
    auto sorted = types;
    std::sort (sorted.begin(), sorted.end(), [] (const auto& a, const auto& b) { return a.name.compareIgnoreCase (b.name) < 0; });
    juce::Array<juce::var> out;
    for (const auto& d : sorted)
    {
        if (! d.isInstrument || isBlocked (d.name, d.manufacturerName)) continue;
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
