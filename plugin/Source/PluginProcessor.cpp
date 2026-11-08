#include "PluginProcessor.h"
#include "PluginEditor.h"
#include <cmath>

namespace slide
{
namespace
{
juce::var parseJson (const juce::String& s)
{
    juce::var v;
    return juce::JSON::parse (s, v).wasOk() ? v : juce::var();
}

class PluginWindow final : public juce::DocumentWindow
{
public:
    PluginWindow (const juce::String& name, std::function<void()> onClose)
        : DocumentWindow (name, juce::Colour (0xff32393c), DocumentWindow::closeButton), closed (std::move (onClose))
    {
        setUsingNativeTitleBar (true);
    }
    void closeButtonPressed() override { juce::MessageManager::callAsync (closed); }

private:
    std::function<void()> closed;
};
} // namespace

SlideProcessor::SlideProcessor()
    : AudioProcessor (BusesProperties().withOutput ("Output", juce::AudioChannelSet::stereo(), true))
{
    liveChannel.fill (0);
    for (auto& a : autoOffs) a = { -1, 0 };
    setClip (juce::var());
}

SlideProcessor::~SlideProcessor()
{
    removeHosted();
}

bool SlideProcessor::isBusesLayoutSupported (const BusesLayout& layouts) const
{
    const auto out = layouts.getMainOutputChannelSet();
    return out == juce::AudioChannelSet::stereo() || out == juce::AudioChannelSet::mono();
}

juce::AudioProcessorEditor* SlideProcessor::createEditor() { return new SlideEditor (*this); }

// ====================================================================== clip

void SlideProcessor::setClip (const juce::var& clip)
{
    clipVar = clip;
    clipJson = clip.isObject() ? juce::JSON::toString (clip, true) : juce::String();
    auto compiled = std::make_shared<const Compiled> (compileClip (clip));
    latest = compiled;
    keepAlive.push_back (compiled);
    live.store (compiled.get());
    // the audio thread may still hold an older pointer for one block, so keep a few around
    while (keepAlive.size() > 16) keepAlive.erase (keepAlive.begin());
}

juce::var SlideProcessor::getClip() const { return clipVar; }

juce::var SlideProcessor::instrumentVar() const
{
    const auto& d = hostedDesc ? hostedDesc : pendingDesc;
    auto* o = new juce::DynamicObject();
    if (d)
    {
        o->setProperty ("kind", "plugin");
        o->setProperty ("id", d->createIdentifierString());
        o->setProperty ("name", d->name);
        o->setProperty ("vendor", d->manufacturerName);
        o->setProperty ("format", d->pluginFormatName == "VST3" ? "VST3" : "AU");
        return juce::var (o);
    }
    if (! hasInstrument) { delete o; return {}; }
    o->setProperty ("kind", "builtin");
    o->setProperty ("name", builtin.presetName());
    return juce::var (o);
}

// ====================================================================== commands from the UI

void SlideProcessor::push (Cmd c)
{
    const juce::SpinLock::ScopedLockType sl (pushLock);
    const auto scope = cmdFifo.write (1);
    if (scope.blockSize1 > 0) cmdBuf[(size_t) scope.startIndex1] = c;
}

void SlideProcessor::transport (const juce::String& cmd, double beat, const juce::var& loop)
{
    double a = 0, b = 0;
    if (auto* arr = loop.getArray(); arr != nullptr && arr->size() == 2)
    {
        a = (double) (*arr)[0];
        b = (double) (*arr)[1];
    }
    if (cmd == "play") push ({ cmdPlay, beat, a, b });
    else if (cmd == "stop") push ({ cmdStop, beat, 0, 0 });
    else if (cmd == "seek") push ({ cmdSeek, beat, 0, 0 });
}

void SlideProcessor::keyDown (int pitch, float velocity)  { push ({ cmdKeyDown, (double) pitch, velocity, 0 }); }
void SlideProcessor::keyUp (int pitch)                    { push ({ cmdKeyUp, (double) pitch, 0, 0 }); }
void SlideProcessor::audition (int pitch, float velocity) { push ({ cmdAudition, (double) pitch, velocity, 0 }); }

// ====================================================================== audio

void SlideProcessor::prepareToPlay (double sr, int bs)
{
    sampleRate = sr;
    blockSize = bs;
    builtin.prepare (sr);
    outBuf.ensureSize (8192);
    synthBuf.ensureSize (8192);
    const juce::ScopedLock sl (synthLock);
    if (hosted != nullptr)
    {
        hosted->prepareToPlay (sr, bs);
        hostedBuffer.setSize (juce::jmax (2, hosted->getTotalNumInputChannels(), hosted->getTotalNumOutputChannels()), juce::jmax (bs, 512) * 2);
    }
    needSetup = true;
}

void SlideProcessor::releaseResources()
{
    const juce::ScopedLock sl (synthLock);
    if (hosted != nullptr) hosted->releaseResources();
}

void SlideProcessor::addEvent (juce::MidiBuffer& out, const juce::uint8* data, int size, int sample)
{
    out.addEvent (data, size, sample);
    const int status = data[0] & 0xf0, ch = data[0] & 0x0f;
    if (ch < firstClipChannel || ch > lastClipChannel || size < 3) return;
    if (status == 0x90 && data[2] > 0) active[(size_t) ch].set (data[1]);
    else if (status == 0x80 || status == 0x90) active[(size_t) ch].reset (data[1]);
}

void SlideProcessor::clipNotesOff (juce::MidiBuffer& out, int sample)
{
    for (int ch = firstClipChannel; ch <= lastClipChannel; ++ch)
    {
        auto& bits = active[(size_t) ch];
        if (bits.none()) continue;
        for (int p = 0; p < 128; ++p)
            if (bits.test ((size_t) p))
            {
                const juce::uint8 d[3] = { (juce::uint8) (0x80 | ch), (juce::uint8) p, 0 };
                out.addEvent (d, 3, sample);
            }
        bits.reset();
    }
}

int SlideProcessor::liveNoteOn (juce::MidiBuffer& out, int pitch, float velocity, int sample)
{
    pitch = juce::jlimit (0, 127, pitch);
    liveNoteOff (out, pitch, sample);
    const int ch = firstLiveChannel + (liveRR++ % (lastLiveChannel - firstLiveChannel + 1));
    const juce::uint8 bend[3] = { (juce::uint8) (0xe0 | ch), 0, 64 };
    const juce::uint8 pres[2] = { (juce::uint8) (0xd0 | ch), 90 };
    const juce::uint8 timbre[3] = { (juce::uint8) (0xb0 | ch), 74, 64 };
    const juce::uint8 on[3] = { (juce::uint8) (0x90 | ch), (juce::uint8) pitch, (juce::uint8) juce::jlimit (1, 127, (int) std::lround (velocity * 127)) };
    out.addEvent (bend, 3, sample);
    out.addEvent (pres, 2, sample);
    out.addEvent (timbre, 3, sample);
    out.addEvent (on, 3, sample);
    liveChannel[(size_t) pitch] = ch + 1;
    return ch;
}

void SlideProcessor::liveNoteOff (juce::MidiBuffer& out, int pitch, int sample)
{
    pitch = juce::jlimit (0, 127, pitch);
    if (const int ch = liveChannel[(size_t) pitch] - 1; ch >= 0)
    {
        const juce::uint8 off[3] = { (juce::uint8) (0x80 | ch), (juce::uint8) pitch, 64 };
        out.addEvent (off, 3, sample);
        liveChannel[(size_t) pitch] = 0;
    }
}

void SlideProcessor::handleCommands (juce::MidiBuffer& out, int)
{
    const auto scope = cmdFifo.read (cmdFifo.getNumReady());
    auto run = [&] (int start, int count)
    {
        for (int i = start; i < start + count; ++i)
        {
            const auto& c = cmdBuf[(size_t) i];
            switch (c.type)
            {
                case cmdPlay:
                    internalPlaying = true;
                    internalBeat = juce::jmax (0.0, c.a);
                    loopSet = c.c > c.b;
                    loopA = c.b; loopB = c.c;
                    clipNotesOff (out, 0);
                    needSetup = true;
                    break;
                case cmdStop:
                    internalPlaying = false;
                    internalBeat = juce::jmax (0.0, c.a);
                    beatNow = internalBeat;
                    clipNotesOff (out, 0);
                    break;
                case cmdSeek:
                    internalBeat = juce::jmax (0.0, c.a);
                    if (! internalPlaying) beatNow = internalBeat;
                    clipNotesOff (out, 0);
                    break;
                case cmdKeyDown: liveNoteOn (out, (int) c.a, (float) c.b, 0); break;
                case cmdKeyUp:   liveNoteOff (out, (int) c.a, 0); break;
                case cmdAudition:
                {
                    const int p = juce::jlimit (0, 127, (int) c.a);
                    liveNoteOn (out, p, (float) c.b, 0);
                    for (auto& a : autoOffs)
                        if (a.pitch < 0 || a.pitch == p) { a = { p, (int) (0.35 * sampleRate) }; break; }
                    break;
                }
                case cmdPanic:
                default:
                    clipNotesOff (out, 0);
                    for (int p = 0; p < 128; ++p) liveNoteOff (out, p, 0);
                    break;
            }
        }
    };
    run (scope.startIndex1, scope.blockSize1);
    run (scope.startIndex2, scope.blockSize2);
}

void SlideProcessor::renderRange (const Compiled& c, double from, double to, double offset, double spb, int n, juce::MidiBuffer& out)
{
    auto it = std::lower_bound (c.events.begin(), c.events.end(), from, [] (const MidiEv& e, double b) { return e.beat < b; });
    for (; it != c.events.end() && it->beat < to; ++it)
        addEvent (out, it->data, it->size, juce::jlimit (0, n - 1, (int) (offset + (it->beat - from) * spb)));

    // recorded knob lanes: the value in force at the end of this range
    auto pit = std::lower_bound (c.params.begin(), c.params.end(), from, [] (const ParamEv& e, double b) { return e.beat < b; });
    for (; pit != c.params.end() && pit->beat < to; ++pit)
    {
        bool replaced = false;
        for (int i = 0; i < numPendingParams; ++i)
            if (pendingParams[(size_t) i].index == pit->index) { pendingParams[(size_t) i] = *pit; replaced = true; break; }
        if (! replaced && numPendingParams < (int) pendingParams.size()) pendingParams[(size_t) numPendingParams++] = *pit;
    }
}

void SlideProcessor::processBlock (juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midi)
{
    juce::ScopedNoDenormals noDenormals;
    const int n = buffer.getNumSamples();
    buffer.clear();
    if (n == 0) return;
    auto& out = outBuf;
    out.clear();
    numPendingParams = 0;

    // MIDI from the host: notes on channel 1 (FL's keyboard) play on SLIDE's live channels,
    // anything else (an MPE controller, CCs) passes straight through
    for (const auto m : midi)
    {
        const auto msg = m.getMessage();
        if (msg.getChannel() == 1 && msg.isNoteOn()) liveNoteOn (out, msg.getNoteNumber(), msg.getFloatVelocity(), m.samplePosition);
        else if (msg.getChannel() == 1 && msg.isNoteOff()) liveNoteOff (out, msg.getNoteNumber(), m.samplePosition);
        else out.addEvent (msg, m.samplePosition);
    }

    handleCommands (out, n);

    const Compiled* c = live.load();
    if (c != lastCompiled)
    {
        clipNotesOff (out, 0); // the clip changed under us: don't leave notes hanging
        lastCompiled = c;
        needSetup = true;
    }
    if (c != nullptr && needSetup.exchange (false))
        for (const auto& e : c->setup) out.addEvent (e.data, e.size, 0);

    double bpm = 120, ppq = 0;
    bool hostPlaying = false;
    if (auto* ph = getPlayHead())
        if (auto pos = ph->getPosition())
        {
            if (auto b = pos->getBpm()) bpm = *b;
            if (auto p = pos->getPpqPosition()) ppq = *p;
            hostPlaying = pos->getIsPlaying();
        }
    bpm = juce::jlimit (10.0, 999.0, bpm);
    bpmNow = bpm;
    const double spb = sampleRate * 60.0 / bpm;
    const double blockBeats = n / spb;

    if (c != nullptr)
    {
        const double L = c->length;
        if (hostPlaying)
        {
            // FL is playing: the clip loops along with the song position
            internalPlaying = false;
            if (! wasHostPlaying || std::abs (ppq - expectedPpq) > 1e-3) clipNotesOff (out, 0);
            double song = ppq;
            const double end = ppq + blockBeats;
            double offset = 0;
            while (song < end - 1e-12)
            {
                const double k = std::floor (song / L);
                const double barEnd = (k + 1) * L;
                const double segEnd = juce::jmin (end, barEnd);
                const double clipStart = song - k * L;
                renderRange (*c, clipStart, clipStart + (segEnd - song), offset, spb, n, out);
                offset += (segEnd - song) * spb;
                if (segEnd >= barEnd - 1e-12) clipNotesOff (out, juce::jlimit (0, n - 1, (int) offset));
                song = segEnd;
            }
            expectedPpq = end;
            const double pos = std::fmod (ppq, L);
            beatNow = pos < 0 ? pos + L : pos;
        }
        else
        {
            if (wasHostPlaying) clipNotesOff (out, 0);
            if (internalPlaying)
            {
                // SLIDE's own play button while FL is stopped: loop the selected range or the clip
                double a = loopSet ? loopA : 0, b = loopSet ? juce::jmin (loopB, L) : L;
                if (b - a < 0.0625) { a = 0; b = L; }
                if (internalBeat < a || internalBeat >= b) internalBeat = a;
                double remaining = blockBeats, offset = 0;
                while (remaining > 1e-12)
                {
                    const double seg = juce::jmin (remaining, b - internalBeat);
                    renderRange (*c, internalBeat, internalBeat + seg, offset, spb, n, out);
                    offset += seg * spb;
                    internalBeat += seg;
                    remaining -= seg;
                    if (internalBeat >= b - 1e-12)
                    {
                        clipNotesOff (out, juce::jlimit (0, n - 1, (int) offset));
                        internalBeat = a;
                    }
                }
                beatNow = internalBeat;
            }
        }
    }
    wasHostPlaying = hostPlaying;
    playingFlag = hostPlaying || internalPlaying;

    for (auto& a : autoOffs)
        if (a.pitch >= 0 && (a.samplesLeft -= n) <= 0) { liveNoteOff (out, a.pitch, n - 1); a.pitch = -1; }

    // the synth plays a copy: hosted plugins may write their own MIDI into the buffer
    synthBuf.clear();
    synthBuf.addEvents (out, 0, -1, 0);
    {
        const juce::ScopedTryLock sl (synthLock);
        if (sl.isLocked())
        {
            if (hosted != nullptr)
            {
                if (numPendingParams > 0)
                {
                    const auto& params = hosted->getParameters();
                    applyingLanes = true;
                    for (int i = 0; i < numPendingParams; ++i)
                        if (auto* p = params[pendingParams[(size_t) i].index]) p->setValue (pendingParams[(size_t) i].value);
                    applyingLanes = false;
                }
                const int chans = juce::jmax (2, hosted->getTotalNumInputChannels(), hosted->getTotalNumOutputChannels());
                if (hostedBuffer.getNumChannels() < chans || hostedBuffer.getNumSamples() < n)
                    hostedBuffer.setSize (chans, n, false, false, true);
                juce::AudioBuffer<float> view (hostedBuffer.getArrayOfWritePointers(), chans, n);
                view.clear();
                hosted->processBlock (view, synthBuf);
                const int outs = juce::jmax (1, hosted->getTotalNumOutputChannels());
                for (int ch = 0; ch < buffer.getNumChannels(); ++ch)
                    buffer.copyFrom (ch, 0, view, juce::jmin (ch, outs - 1), 0, n);
            }
            else
            {
                builtin.render (buffer, synthBuf, n);
            }
        }
    }

    midi.swapWith (out); // the same MPE stream goes to SLIDE's MIDI output
}

// ====================================================================== instruments

void SlideProcessor::useBuiltin (const juce::String& name)
{
    builtin.setPreset (name);
    hasInstrument = true;
    pendingDesc.reset();
    removeHosted();
    needSetup = true;
}

void SlideProcessor::removeHosted()
{
    pluginWindow.reset();
    std::unique_ptr<juce::AudioPluginInstance> old;
    {
        const juce::ScopedLock sl (synthLock);
        old = std::move (hosted);
        hostedDesc.reset();
    }
    if (old != nullptr)
    {
        for (auto* p : old->getParameters()) p->removeListener (this);
        old->releaseResources();
    }
}

void SlideProcessor::installHosted (std::unique_ptr<juce::AudioPluginInstance> inst, const juce::PluginDescription& desc)
{
    removeHosted();
    inst->enableAllBuses();
    inst->prepareToPlay (sampleRate, blockSize);
    for (auto* p : inst->getParameters()) p->addListener (this);
    {
        const juce::ScopedLock sl (synthLock);
        hostedBuffer.setSize (juce::jmax (2, inst->getTotalNumInputChannels(), inst->getTotalNumOutputChannels()), juce::jmax (blockSize, 512) * 2);
        hosted = std::move (inst);
        hostedDesc = desc;
    }
    hasInstrument = true;
    needSetup = true;
    builtin.allNotesOff();
}

void SlideProcessor::loadPlugin (const juce::String& id, std::function<void (bool, juce::String)> done)
{
    auto desc = catalog().find (id);
    if (! desc && pendingDesc && pendingDesc->createIdentifierString() == id) desc = pendingDesc;
    if (! desc) { done (false, "This synth is no longer installed. Press Refresh."); return; }

    // a VST3 listed by name is opened here for the first time, and only because it was picked
    juce::String resolveError;
    const auto resolved = catalog().resolve (*desc, resolveError);
    if (! resolved) { done (false, resolveError); return; }

    juce::WeakReference<SlideProcessor> weak (this);
    const auto d = *resolved;
    catalog().formats.createPluginInstanceAsync (d, sampleRate, blockSize,
        [weak, d, done] (std::unique_ptr<juce::AudioPluginInstance> inst, const juce::String& error)
        {
            auto* self = weak.get();
            if (self == nullptr) return;
            if (inst == nullptr)
            {
                done (false, d.name + " could not be loaded" + (error.isNotEmpty() ? ": " + error : juce::String (".")));
                return;
            }
            if (self->pendingDesc && self->pendingDesc->createIdentifierString() == d.createIdentifierString() && self->pendingPluginState.getSize() > 0)
                inst->setStateInformation (self->pendingPluginState.getData(), (int) self->pendingPluginState.getSize());
            self->pendingPluginState.reset();
            self->pendingDesc.reset();
            self->installHosted (std::move (inst), d);
            done (true, {});
        });
}

void SlideProcessor::openPluginWindow()
{
    if (hosted == nullptr) return;
    if (pluginWindow != nullptr) { pluginWindow->setVisible (true); pluginWindow->toFront (true); return; }
    juce::AudioProcessorEditor* ed = hosted->createEditorIfNeeded();
    if (ed == nullptr) ed = new juce::GenericAudioProcessorEditor (*hosted);
    juce::WeakReference<SlideProcessor> weak (this);
    auto w = std::make_unique<PluginWindow> (hosted->getName(), [weak] { if (auto* s = weak.get()) s->pluginWindow.reset(); });
    w->setContentOwned (ed, true);
    w->setAlwaysOnTop (true);
    w->centreWithSize (w->getWidth(), w->getHeight());
    w->setVisible (true);
    pluginWindow = std::move (w);
}

void SlideProcessor::parameterValueChanged (int index, float value)
{
    ++paramEpoch;
    if (applyingLanes) return;
    const auto scope = paramFifo.write (1);
    if (scope.blockSize1 > 0) paramBuf[(size_t) scope.startIndex1] = { index, value };
}

std::vector<std::pair<int, float>> SlideProcessor::takeParamChanges()
{
    std::vector<std::pair<int, float>> out;
    const auto scope = paramFifo.read (paramFifo.getNumReady());
    auto take = [&] (int start, int count)
    {
        for (int i = start; i < start + count; ++i)
        {
            const auto& pv = paramBuf[(size_t) i];
            auto it = std::find_if (out.begin(), out.end(), [&] (auto& x) { return x.first == pv.first; });
            if (it != out.end()) it->second = pv.second; else out.push_back (pv);
        }
    };
    take (scope.startIndex1, scope.blockSize1);
    take (scope.startIndex2, scope.blockSize2);
    // knobs a lane is already driving are played back, not recorded again
    if (latest)
        out.erase (std::remove_if (out.begin(), out.end(), [&] (auto& x) {
            return std::find (latest->drivenParams.begin(), latest->drivenParams.end(), x.first) != latest->drivenParams.end(); }), out.end());
    return out;
}

juce::String SlideProcessor::paramName (int index) const
{
    if (hosted != nullptr)
        if (auto* p = hosted->getParameters()[index]) return p->getName (64);
    return "Parameter " + juce::String (index + 1);
}

SlideProcessor::Transport SlideProcessor::getTransport() const
{
    return { playingFlag.load(), beatNow.load(), bpmNow.load() };
}

// ====================================================================== offline render

juce::String SlideProcessor::renderKey() const
{
    return juce::String (clipJson.hashCode64()) + "|" + juce::JSON::toString (instrumentVar(), true)
         + "|" + juce::String (bpmNow.load(), 3) + "|" + juce::String (paramEpoch.load());
}

juce::File SlideProcessor::freshRender() const
{
    return (lastRender.existsAsFile() && lastRenderKey == renderKey()) ? lastRender : juce::File();
}

juce::File SlideProcessor::renderWav (juce::String& error)
{
    if (auto f = freshRender(); f.existsAsFile()) return f;
    auto c = latest;
    if (c == nullptr || c->events.empty()) { error = "There are no notes to render yet."; return {}; }
    const auto key = renderKey();

    const double sr = sampleRate > 0 ? sampleRate : 44100;
    const int bs = 512;
    const double bpm = bpmNow.load();

    std::unique_ptr<juce::AudioPluginInstance> inst;
    std::unique_ptr<BuiltinSynth> synth;
    if (hostedDesc)
    {
        // a second copy of the hosted synth, with the same sound, renders offline
        juce::String err;
        inst = catalog().formats.createPluginInstance (*hostedDesc, sr, bs, err);
        if (inst == nullptr) { error = hostedDesc->name + " could not render: " + err; return {}; }
        juce::MemoryBlock state;
        {
            const juce::ScopedLock sl (synthLock);
            if (hosted != nullptr) hosted->getStateInformation (state);
        }
        if (state.getSize() > 0) inst->setStateInformation (state.getData(), (int) state.getSize());
        inst->enableAllBuses();
        inst->setNonRealtime (true);
        inst->prepareToPlay (sr, bs);
    }
    else
    {
        synth = std::make_unique<BuiltinSynth>();
        synth->setPreset (builtin.presetName());
        synth->prepare (sr);
    }

    const double spb = sr * 60.0 / bpm;
    const double beats = juce::jmax (c->length, c->lastNoteEnd);
    const int total = (int) (beats * spb + 1.5 * sr);
    juce::AudioBuffer<float> result (2, total);
    result.clear();
    const int chans = inst ? juce::jmax (2, inst->getTotalNumInputChannels(), inst->getTotalNumOutputChannels()) : 2;
    juce::AudioBuffer<float> blk (chans, bs);
    juce::MidiBuffer mb;
    size_t ei = 0, pi = 0;

    for (int pos = 0; pos < total; pos += bs)
    {
        const int n = juce::jmin (bs, total - pos);
        mb.clear();
        if (pos == 0) for (const auto& e : c->setup) mb.addEvent (e.data, e.size, 0);
        const double b1 = (pos + n) / spb;
        for (; ei < c->events.size() && c->events[ei].beat < b1; ++ei)
        {
            const auto& e = c->events[ei];
            mb.addEvent (e.data, e.size, juce::jlimit (0, n - 1, (int) (e.beat * spb) - pos));
        }
        for (; pi < c->params.size() && c->params[pi].beat < b1; ++pi)
            if (inst)
                if (auto* p = inst->getParameters()[c->params[pi].index]) p->setValue (c->params[pi].value);

        juce::AudioBuffer<float> view (blk.getArrayOfWritePointers(), chans, n);
        view.clear();
        if (inst) inst->processBlock (view, mb);
        else synth->render (view, mb, n);
        const int outs = inst ? juce::jmax (1, inst->getTotalNumOutputChannels()) : 2;
        for (int ch = 0; ch < 2; ++ch) result.copyFrom (ch, pos, view, juce::jmin (ch, outs - 1), 0, n);
    }
    if (inst) inst->releaseResources();
    inst.reset();

    auto dir = juce::File::getSpecialLocation (juce::File::userMusicDirectory).getChildFile ("SLIDE");
    dir.createDirectory();
    auto base = juce::File::createLegalFileName (clipVar.getProperty ("name", "SLIDE").toString().trim());
    if (base.isEmpty()) base = "SLIDE";
    auto file = dir.getChildFile (base + " " + juce::Time::getCurrentTime().formatted ("%Y-%m-%d %H%M%S") + ".wav");

    juce::WavAudioFormat wav;
    std::unique_ptr<juce::AudioFormatWriter> writer (wav.createWriterFor (new juce::FileOutputStream (file), sr, 2, 24, {}, 0));
    if (writer == nullptr) { error = "Could not write " + file.getFullPathName(); return {}; }
    writer->writeFromAudioSampleBuffer (result, 0, total);
    writer.reset();

    lastRender = file;
    lastRenderKey = key;
    return file;
}

// ====================================================================== state

void SlideProcessor::getStateInformation (juce::MemoryBlock& dest)
{
    juce::ValueTree st ("SLIDE");
    st.setProperty ("version", 1, nullptr);
    st.setProperty ("clip", clipJson, nullptr);
    st.setProperty ("editorW", editorW, nullptr);
    st.setProperty ("editorH", editorH, nullptr);
    const auto& d = hostedDesc ? hostedDesc : pendingDesc;
    if (d)
    {
        if (auto xml = d->createXml()) st.setProperty ("plugin", xml->toString(), nullptr);
        juce::MemoryBlock mb;
        {
            const juce::ScopedLock sl (synthLock);
            if (hosted != nullptr) hosted->getStateInformation (mb);
        }
        if (mb.getSize() == 0) mb = pendingPluginState;
        st.setProperty ("pluginState", mb.toBase64Encoding(), nullptr);
    }
    else if (hasInstrument)
        st.setProperty ("builtin", builtin.presetName(), nullptr);

    if (auto xml = st.createXml()) copyXmlToBinary (*xml, dest);
}

void SlideProcessor::setStateInformation (const void* data, int size)
{
    auto xml = getXmlFromBinary (data, size);
    if (xml == nullptr) return;
    const auto st = juce::ValueTree::fromXml (*xml);
    if (! st.hasType ("SLIDE")) return;

    editorW = st.getProperty ("editorW", editorW);
    editorH = st.getProperty ("editorH", editorH);
    if (const auto json = st.getProperty ("clip").toString(); json.isNotEmpty()) setClip (parseJson (json));

    if (const auto plug = st.getProperty ("plugin").toString(); plug.isNotEmpty())
    {
        if (auto dx = juce::parseXML (plug))
        {
            juce::PluginDescription d;
            if (d.loadFromXml (*dx))
            {
                pendingDesc = d;
                pendingPluginState.reset();
                pendingPluginState.fromBase64Encoding (st.getProperty ("pluginState").toString());
                hasInstrument = true;
                juce::WeakReference<SlideProcessor> weak (this);
                juce::MessageManager::callAsync ([weak, id = d.createIdentifierString()]
                {
                    if (auto* self = weak.get())
                        self->loadPlugin (id, [] (bool, juce::String) {});
                });
            }
        }
    }
    else if (const auto name = st.getProperty ("builtin").toString(); name.isNotEmpty())
        useBuiltin (name);
}
} // namespace slide

juce::AudioProcessor* JUCE_CALLTYPE createPluginFilter() { return new slide::SlideProcessor(); }
