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

PluginCatalog::PluginCatalog()
{
#if JUCE_PLUGINHOST_VST3
    formats.addFormat (new juce::VST3PluginFormat());
#endif
#if JUCE_PLUGINHOST_AU && JUCE_MAC
    formats.addFormat (new juce::AudioUnitPluginFormat());
#endif
    if (auto xml = juce::XmlDocument::parse (dataDir().getChildFile ("plugins.xml")))
    {
        list.recreateFromXml (*xml);
        cached = true;
    }
}

PluginCatalog::~PluginCatalog()
{
    stopTimer();
    scanner.reset();
}

void PluginCatalog::scan (bool force)
{
    if (scanning) return;
    if (cached && ! force) { sendChangeMessage(); return; }
    scanning = true;
    formatIndex = 0;
    startFormat();
    startTimer (5);
}

void PluginCatalog::startFormat()
{
    scanner.reset();
    if (formatIndex >= formats.getNumFormats()) { finish(); return; }
    auto* f = formats.getFormat (formatIndex);
    scanner = std::make_unique<juce::PluginDirectoryScanner> (list, *f, f->getDefaultLocationsToSearch(), true,
                                                               dataDir().getChildFile ("scan-in-progress.txt"), false);
}

void PluginCatalog::timerCallback()
{
    if (scanner == nullptr) { finish(); return; }
    // a plugin that crashed a previous scan is skipped (dead man's pedal file)
    if (! scanner->scanNextFile (true, nowScanning))
    {
        ++formatIndex;
        startFormat();
    }
}

void PluginCatalog::finish()
{
    stopTimer();
    scanner.reset();
    scanning = false;
    cached = true;
    nowScanning = {};
    save();
    sendChangeMessage();
}

void PluginCatalog::save()
{
    if (auto xml = list.createXml())
        xml->writeTo (dataDir().getChildFile ("plugins.xml"));
}

juce::var PluginCatalog::toVar() const
{
    auto types = list.getTypes();
    std::sort (types.begin(), types.end(), [] (const auto& a, const auto& b) { return a.name.compareIgnoreCase (b.name) < 0; });
    juce::Array<juce::var> out;
    for (const auto& d : types)
    {
        if (! d.isInstrument || d.name.equalsIgnoreCase ("SLIDE")) continue;
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
    for (const auto& d : list.getTypes())
        if (d.createIdentifierString() == id) return d;
    return std::nullopt;
}
}
