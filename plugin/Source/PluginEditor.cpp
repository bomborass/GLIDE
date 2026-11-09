#include "PluginEditor.h"
#include "BinaryData.h"

namespace slide
{
namespace
{
juce::var obj (std::initializer_list<std::pair<const char*, juce::var>> props)
{
    auto* o = new juce::DynamicObject();
    for (auto& [k, v] : props) o->setProperty (k, v);
    return juce::var (o);
}

std::optional<juce::WebBrowserComponent::Resource> serveUi (const juce::String& url)
{
    if (url == "/" || url == "/index.html" || url.isEmpty())
    {
        std::vector<std::byte> bytes ((size_t) BinaryData::index_htmlSize);
        std::memcpy (bytes.data(), BinaryData::index_html, bytes.size());
        return juce::WebBrowserComponent::Resource { std::move (bytes), "text/html" };
    }
    return std::nullopt;
}
} // namespace

SlideEditor::SlideEditor (SlideProcessor& p)
    : AudioProcessorEditor (p), proc (p), browser (makeOptions())
{
    addAndMakeVisible (browser);
    // resizable by the host's window edges and by the grip in the UI's bottom-right corner
    setResizable (true, false);
    setResizeLimits (720, 480, 4000, 3000);
    setSize (juce::jlimit (720, 4000, proc.editorW), juce::jlimit (480, 3000, proc.editorH));
    proc.catalog().addChangeListener (this);
    browser.goToURL (juce::WebBrowserComponent::getResourceProviderRoot());

    // the host restored a project or preset while SLIDE is open: show it
    juce::WeakReference<SlideEditor> weak (this);
    proc.onStateRestored = [weak] { if (auto* self = weak.get()) self->sendInit(); };

    // ⌘-shortcuts, ⌘-scroll and pinch the host would otherwise take
    HostKeys::Handlers h;
    h.shortcut = [weak] (const juce::String& key, bool shift, bool alt)
    {
        static const juce::StringArray ours { "z", "y", "c", "x", "v", "b", "d", "a" };
        auto* self = weak.get();
        if (self == nullptr || ! ours.contains (key)) return false;
        self->emit ("shortcut", obj ({ { "key", key }, { "shift", shift }, { "alt", alt } }));
        return true;
    };
    h.zoomScroll = [weak] (juce::Point<int> p, float dx, float dy, bool shift)
    {
        if (auto* self = weak.get())
            self->emit ("wheelZoom", obj ({ { "x", p.x }, { "y", p.y }, { "dx", dx }, { "dy", dy }, { "shift", shift } }));
    };
    h.pinch = [weak] (juce::Point<int> p, float delta)
    {
        if (auto* self = weak.get())
            self->emit ("pinch", obj ({ { "x", p.x }, { "y", p.y }, { "delta", delta } }));
    };
    hostKeys = std::make_unique<HostKeys> (*this, std::move (h));
    startTimerHz (60);
}

SlideEditor::~SlideEditor()
{
    hostKeys.reset();
    proc.onStateRestored = nullptr;
    proc.catalog().removeChangeListener (this);
}

void SlideEditor::paint (juce::Graphics& g) { g.fillAll (juce::Colour (0xff29363d)); }

void SlideEditor::resized()
{
    browser.setBounds (getLocalBounds());
    proc.editorW = getWidth();
    proc.editorH = getHeight();
}

void SlideEditor::emit (const char* event, const juce::var& payload)
{
    browser.emitEventIfBrowserIsVisible (event, payload);
}

juce::WebBrowserComponent::Options SlideEditor::makeOptions()
{
    using Opts = juce::WebBrowserComponent::Options;
    auto o = Opts{}
        .withNativeIntegrationEnabled()
        .withKeepPageLoadedWhenBrowserIsHidden()
        .withResourceProvider ([] (const juce::String& url) { return serveUi (url); });

    // the browser is a member of this editor, so its listeners never outlive it.
    // (No WeakReference here: this runs while the browser member is being constructed.)
    auto on = [&o] (const char* name, std::function<void (const juce::var&)> fn)
    {
        o = o.withEventListener (name, [fn] (juce::var payload) { fn (payload); });
    };

    on ("uiReady", [this] (const juce::var&) { sendInit(); });
    on ("clipChanged", [this] (const juce::var& clip) { proc.setClip (clip); });
    on ("transport", [this] (const juce::var& t)
    {
        proc.transport (t.getProperty ("cmd", "").toString(), (double) t.getProperty ("beat", 0.0), t.getProperty ("loop", {}));
    });
    on ("audition", [this] (const juce::var& v) { proc.audition ((int) v.getProperty ("pitch", 60), (float) (double) v.getProperty ("velocity", 0.8)); });
    on ("keyDown", [this] (const juce::var& v) { proc.keyDown ((int) v.getProperty ("pitch", 60), (float) (double) v.getProperty ("velocity", 0.8)); });
    on ("keyUp", [this] (const juce::var& v) { proc.keyUp ((int) v.getProperty ("pitch", 60)); });
    on ("scanPlugins", [this] (const juce::var&) { proc.catalog().refresh(); });
    on ("loadPlugin", [this] (const juce::var& v)
    {
        const auto id = v.getProperty ("id", "").toString();
        juce::WeakReference<SlideEditor> weak (this);
        proc.loadPlugin (id, [weak, id] (bool ok, juce::String error)
        {
            if (auto* self = weak.get())
            {
                const auto inst = self->proc.instrumentVar();
                self->emit ("pluginLoaded", obj ({ { "id", id }, { "name", inst.getProperty ("name", "") }, { "ok", ok }, { "error", error } }));
                if (ok) self->proc.openPluginWindow(); // show the synth right away so its sound can be picked
            }
        });
    });
    on ("openPluginEditor", [this] (const juce::var&) { proc.openPluginWindow(); });
    on ("playMode", [this] (const juce::var& v)
    {
        proc.setPlayMode ((bool) v.getProperty ("on", false), (float) (double) v.getProperty ("glideMs", 325.0),
                          (bool) v.getProperty ("distance", false), (float) (double) v.getProperty ("holdSecs", 8.0),
                          (float) (double) v.getProperty ("strumMs", 70.0));
    });
    on ("letGo", [this] (const juce::var&) { proc.letGo(); });
    on ("readFile", [this] (const juce::var& v)
    {
        // a MIDI file dropped as a file:// URL (e.g. dragged from FL's browser)
        const juce::URL url (v.getProperty ("url", "").toString());
        const auto f = url.isLocalFile() ? url.getLocalFile() : juce::File();
        juce::MemoryBlock mb;
        if (f.existsAsFile() && f.getSize() < 32 * 1024 * 1024 && f.loadFileAsData (mb))
            emit ("fileData", obj ({ { "name", f.getFileName() }, { "base64", juce::Base64::toBase64 (mb.getData(), mb.getSize()) } }));
        else
            emit ("fileData", obj ({ { "name", f.getFileName() }, { "base64", "" }, { "error", "Could not read the dropped file" } }));
    });
    on ("resizeWindow", [this] (const juce::var& v)
    {
        setSize (juce::jlimit (720, 4000, (int) v.getProperty ("width", getWidth())),
                 juce::jlimit (480, 3000, (int) v.getProperty ("height", getHeight())));
    });
    on ("useBuiltin", [this] (const juce::var& v) { proc.useBuiltin (v.getProperty ("name", "Glass Saw").toString()); });
    on ("saveFile", [this] (const juce::var& v)
    {
        // the UI sends standard base64 (MemoryBlock's own base64 format is different)
        juce::MemoryOutputStream mo;
        juce::Base64::convertFromBase64 (mo, v.getProperty ("base64", "").toString());
        const auto mb = mo.getMemoryBlock();
        saveBytes (v.getProperty ("name", "clip.mid").toString(), mb);
    });
    on ("dragFile", [this] (const juce::var& v)
    {
        const auto f = writeExport (v.getProperty ("name", "clip.mid").toString(), v.getProperty ("base64", "").toString());
        if (f.existsAsFile()) dragFile (f);
    });
    on ("prepareAudio", [this] (const juce::var&)
    {
        if (proc.freshRender().existsAsFile()) return;
        juce::WeakReference<SlideEditor> weak (this);
        juce::MessageManager::callAsync ([weak] { if (auto* self = weak.get()) { juce::String e; self->proc.renderWav (e); } });
    });
    on ("startAudioDrag", [this] (const juce::var&)
    {
        juce::String error;
        const auto f = proc.renderWav (error);
        if (f.existsAsFile()) dragFile (f); else flashError (error);
    });
    on ("saveAudio", [this] (const juce::var&)
    {
        juce::String error;
        const auto f = proc.renderWav (error);
        if (f.existsAsFile()) saveCopyOf (f); else flashError (error);
    });
    return o;
}

void SlideEditor::sendInit()
{
    emit ("init", obj ({ { "clip", proc.getClip() }, { "instrument", proc.instrumentVar() } }));
    if (proc.catalog().hasCache()) sendPluginList();
    lastBeat = -1; // resend the transport
}

void SlideEditor::sendPluginList()
{
    auto& cat = proc.catalog();
    emit ("scanStatus", obj ({ { "scanning", cat.isScanning() }, { "name", cat.currentlyScanning() } }));
    emit ("pluginList", cat.toVar());
}

void SlideEditor::changeListenerCallback (juce::ChangeBroadcaster*) { sendPluginList(); }

void SlideEditor::timerCallback()
{
    const auto t = proc.getTransport();
    const bool changed = t.playing != lastPlaying || std::abs (t.beat - lastBeat) > 1e-4 || std::abs (t.bpm - lastBpm) > 1e-3;
    if (changed || ++idleTicks > 60)
    {
        emit ("hostTransport", obj ({ { "playing", t.playing }, { "beat", t.beat }, { "bpm", t.bpm } }));
        lastPlaying = t.playing; lastBeat = t.beat; lastBpm = t.bpm;
        idleTicks = 0;
    }
    // Playing Mode: what the play engine did since the last tick
    {
        juce::Array<juce::var> evs;
        PlayEngine::Event e;
        static const char* names[] = { "start", "glide", "end", "phraseOn", "phraseOff" };
        while (proc.play.popEvent (e))
            evs.add (obj ({ { "type", names[juce::jlimit (0, 4, e.type)] }, { "id", e.id }, { "pitch", e.pitch }, { "to", e.to },
                            { "ms", e.ms }, { "vel", e.vel }, { "at", e.at } }));
        if (! evs.isEmpty()) emit ("live", obj ({ { "events", evs } }));
    }
    for (const auto& [index, value] : proc.takeParamChanges())
        emit ("paramChanged", obj ({ { "id", juce::String (index) }, { "name", proc.paramName (index) }, { "value", value } }));
}

juce::File SlideEditor::writeExport (const juce::String& name, const juce::String& base64)
{
    juce::MemoryOutputStream mo;
    juce::Base64::convertFromBase64 (mo, base64);
    const auto mb = mo.getMemoryBlock();
    auto dir = juce::File::getSpecialLocation (juce::File::userMusicDirectory).getChildFile ("SLIDE");
    dir.createDirectory();
    auto f = dir.getChildFile (juce::File::createLegalFileName (name));
    if (! f.replaceWithData (mb.getData(), mb.getSize())) return {};
    return f;
}

void SlideEditor::dragFile (const juce::File& file)
{
    // called while the mouse is being dragged over the export tile, so the OS drag starts right there
    juce::DragAndDropContainer::performExternalDragDropOfFiles ({ file.getFullPathName() }, false, this);
}

void SlideEditor::saveBytes (const juce::String& name, const juce::MemoryBlock& data)
{
    auto start = juce::File::getSpecialLocation (juce::File::userMusicDirectory).getChildFile (juce::File::createLegalFileName (name));
    chooser = std::make_unique<juce::FileChooser> ("Save " + name, start, "*" + start.getFileExtension());
    juce::WeakReference<SlideEditor> weak (this);
    chooser->launchAsync (juce::FileBrowserComponent::saveMode | juce::FileBrowserComponent::canSelectFiles | juce::FileBrowserComponent::warnAboutOverwriting,
        [weak, data] (const juce::FileChooser& fc)
        {
            const auto f = fc.getResult();
            if (f == juce::File()) return;
            if (! f.replaceWithData (data.getData(), data.getSize()))
                if (auto* self = weak.get()) self->flashError ("Could not save " + f.getFileName());
        });
}

void SlideEditor::saveCopyOf (const juce::File& file)
{
    juce::MemoryBlock mb;
    file.loadFileAsData (mb);
    auto name = file.getFileName();
    saveBytes (name, mb);
}

void SlideEditor::flashError (const juce::String& message)
{
    // shown in the UI's footer through the same channel as a failed synth load
    if (message.isNotEmpty())
        juce::AlertWindow::showMessageBoxAsync (juce::MessageBoxIconType::WarningIcon, "SLIDE", message);
}
} // namespace slide
