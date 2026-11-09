#include "PlayEngine.h"
#include <algorithm>
#include <cmath>
#include <vector>

namespace slide
{
namespace
{
constexpr int firstChannel = 1;   // MIDI channels 2..13
constexpr double maxChordSpread = 0.4; // seconds: a strum longer than this still resolves

double smooth (double x) { x = juce::jlimit (0.0, 1.0, x); return x * x * (3 - 2 * x); }
} // namespace

double PlayEngine::Voice::pitchAt (juce::int64 t) const
{
    if (dur <= 0 || t >= t0 + dur) return to;
    if (t <= t0) return from;
    return from + (to - from) * smooth ((double) (t - t0) / (double) dur);
}

void PlayEngine::prepare (double sampleRate) { sr = sampleRate > 0 ? sampleRate : 44100; }

void PlayEngine::push (Event e)
{
    const auto scope = fifo.write (1);
    if (scope.blockSize1 > 0) events[(size_t) scope.startIndex1] = e;
}

bool PlayEngine::popEvent (Event& e)
{
    const auto scope = fifo.read (1);
    if (scope.blockSize1 == 0) return false;
    e = events[(size_t) scope.startIndex1];
    return true;
}

void PlayEngine::sendBend (Voice& v, double pitch, int range, int offset, juce::MidiBuffer& out)
{
    const int value = juce::jlimit (0, 16383, (int) std::lround (8192.0 + (pitch - v.base) / range * 8192.0));
    if (value == v.lastBend) return;
    v.lastBend = value;
    const juce::uint8 d[3] = { (juce::uint8) (0xe0 | v.ch), (juce::uint8) (value & 0x7f), (juce::uint8) (value >> 7) };
    out.addEvent (d, 3, offset);
}

void PlayEngine::startVoice (int pitch, float vel, juce::int64 at, int offset, juce::MidiBuffer& out)
{
    // a free member channel, or the voice that has sounded longest
    Voice* v = nullptr;
    for (size_t k = 0; k < voices.size() && v == nullptr; ++k)
    {
        auto& c = voices[(size_t) ((rr + (int) k) % (int) voices.size())];
        if (! c.on) v = &c;
    }
    if (v == nullptr)
    {
        v = &voices[0];
        for (auto& c : voices) if (c.started < v->started) v = &c;
        endVoice (*v, at, offset, out);
    }
    rr = (int) ((v - voices.data()) + 1) % (int) voices.size();

    v->on = true;
    v->ch = firstChannel + (int) (v - voices.data());
    v->base = juce::jlimit (0, 127, pitch);
    v->from = v->to = pitch;
    v->t0 = at; v->dur = 0;
    v->vel = vel;
    v->id = nextId++;
    v->started = at;
    v->lastBend = 8192;

    const juce::uint8 bend[3] = { (juce::uint8) (0xe0 | v->ch), 0, 64 };
    const juce::uint8 pres[2] = { (juce::uint8) (0xd0 | v->ch), (juce::uint8) pressureValue };
    const juce::uint8 timbre[3] = { (juce::uint8) (0xb0 | v->ch), 74, 64 };
    const juce::uint8 on[3] = { (juce::uint8) (0x90 | v->ch), (juce::uint8) v->base, (juce::uint8) juce::jlimit (1, 127, (int) std::lround (vel * 127)) };
    out.addEvent (bend, 3, offset);
    out.addEvent (pres, 2, offset);
    out.addEvent (timbre, 3, offset);
    out.addEvent (on, 3, juce::jmin (offset + 1, blockLen - 1)); // just after its bend

    Event e; e.type = Event::start; e.id = v->id; e.pitch = (float) pitch; e.to = (float) pitch; e.vel = vel; e.at = secs (at);
    push (e);
}

void PlayEngine::endVoice (Voice& v, juce::int64 at, int offset, juce::MidiBuffer& out)
{
    if (! v.on) return;
    const juce::uint8 off[3] = { (juce::uint8) (0x80 | v.ch), (juce::uint8) v.base, 64 };
    out.addEvent (off, 3, offset);
    v.on = false;
    Event e; e.type = Event::end; e.id = v.id; e.pitch = (float) v.pitchAt (at); e.at = secs (at);
    push (e);
}

void PlayEngine::noteOn (int pitch, float vel, int offset, int range, juce::MidiBuffer& out)
{
    const juce::int64 now = clock + offset;
    const auto strum = (juce::int64) (strumMs.load() / 1000.0 * sr);
    lastOn = now;

    if (! phrase)
    {
        // the first chord plays straight away
        phrase = true; glided = false;
        phraseStart = now;
        firstChordUntil = now + strum;
        Event e; e.type = Event::phraseOn; e.at = 0; push (e);
        startVoice (pitch, vel, now, offset, out);
        return;
    }
    if (! glided && now <= firstChordUntil)
    {
        for (auto& v : voices) if (v.on && v.base == pitch) return;
        startVoice (pitch, vel, now, offset, out);
        firstChordUntil = juce::jmin (now + strum, phraseStart + (juce::int64) (maxChordSpread * sr));
        return;
    }

    // a new chord: gather it (strums arrive over a few milliseconds), then glide
    for (int i = 0; i < numPend; ++i) if (pend[(size_t) i].first == pitch) return;
    if (numPend < (int) pend.size()) pend[(size_t) numPend++] = { pitch, vel };
    if (numPend == 1) pendFirst = now;
    pendDeadline = juce::jmin (now + strum, pendFirst + (juce::int64) (maxChordSpread * sr));
    juce::ignoreUnused (range);
}

void PlayEngine::pressure (float value, int offset, juce::MidiBuffer& out)
{
    pressureValue = juce::jlimit (0, 127, (int) std::lround (value * 127));
    for (auto& v : voices)
        if (v.on)
        {
            const juce::uint8 d[2] = { (juce::uint8) (0xd0 | v.ch), (juce::uint8) pressureValue };
            out.addEvent (d, 2, offset);
        }
}

void PlayEngine::releaseAll (int offset, juce::MidiBuffer& out)
{
    const juce::int64 now = clock + offset;
    for (auto& v : voices) endVoice (v, now, offset, out);
    numPend = 0;
    if (phrase)
    {
        phrase = false;
        Event e; e.type = Event::phraseOff; e.at = secs (now); push (e);
    }
}

void PlayEngine::resolveChord (juce::int64 at, int offset, int range, juce::MidiBuffer& out)
{
    // new chord, high to low
    std::vector<std::pair<int, float>> chord (pend.begin(), pend.begin() + numPend);
    numPend = 0;
    std::sort (chord.begin(), chord.end(), [] (auto& a, auto& b) { return a.first > b.first; });

    // sounding voices, high to low by where they're heading
    std::vector<Voice*> cur;
    for (auto& v : voices) if (v.on) cur.push_back (&v);
    std::sort (cur.begin(), cur.end(), [] (Voice* a, Voice* b) { return a->to > b->to; });

    // order-preserving matching of the shorter list into the longer one, least total movement
    const bool swap = cur.size() > chord.size();
    const int m = (int) (swap ? chord.size() : cur.size()), n = (int) (swap ? cur.size() : chord.size());
    auto cost = [&] (int i, int j)
    {
        const double a = swap ? chord[(size_t) i].first : cur[(size_t) i]->to;
        const double b = swap ? cur[(size_t) j]->to : chord[(size_t) j].first;
        return std::abs (a - b);
    };
    std::vector<std::vector<double>> dp ((size_t) m + 1, std::vector<double> ((size_t) n + 1, 1e18));
    for (int j = 0; j <= n; ++j) dp[0][(size_t) j] = 0;
    for (int i = 1; i <= m; ++i)
        for (int j = i; j <= n; ++j)
            dp[(size_t) i][(size_t) j] = std::min (dp[(size_t) i][(size_t) j - 1], dp[(size_t) i - 1][(size_t) j - 1] + cost (i - 1, j - 1));

    std::vector<int> voiceTarget (cur.size(), -1);
    for (int i = m, j = n; i > 0;)
    {
        if (j > i && dp[(size_t) i][(size_t) j] == dp[(size_t) i][(size_t) j - 1]) { --j; continue; }
        if (swap) voiceTarget[(size_t) j - 1] = i - 1; else voiceTarget[(size_t) i - 1] = j - 1;
        --i; --j;
    }

    std::vector<bool> used (chord.size(), false);
    const double ms = glideMs.load();
    for (size_t k = 0; k < cur.size(); ++k)
    {
        auto& v = *cur[k];
        const int t = voiceTarget[k];
        if (t < 0) { endVoice (v, at, offset, out); continue; }
        used[(size_t) t] = true;
        const int target = chord[(size_t) t].first;
        if (std::abs (target - v.base) > range)
        {
            // too far for the bend range: let this voice go and strike the note fresh
            endVoice (v, at, offset, out);
            startVoice (target, chord[(size_t) t].second, at, offset, out);
            continue;
        }
        const double now = v.pitchAt (at);
        double g = ms;
        if (distance.load()) g *= juce::jlimit (0.25, 3.0, std::abs (target - now) / 5.0);
        v.from = now; v.to = target; v.t0 = at;
        v.dur = juce::jmax ((juce::int64) 1, (juce::int64) (g / 1000.0 * sr));
        Event e; e.type = Event::glide; e.id = v.id; e.pitch = (float) now; e.to = (float) target; e.ms = (float) g; e.at = secs (at);
        push (e);
    }
    for (size_t t = 0; t < chord.size(); ++t)
        if (! used[t]) startVoice (chord[t].first, chord[t].second, at, offset, out);
    glided = true;
}

void PlayEngine::process (int numSamples, int range, juce::MidiBuffer& out)
{
    const juce::int64 end = clock + numSamples;
    if (numPend > 0 && pendDeadline < end)
        resolveChord (juce::jmax (clock, pendDeadline), (int) juce::jmax ((juce::int64) 0, pendDeadline - clock), range, out);

    // glides: a bend value every 64 samples while moving
    for (auto& v : voices)
    {
        if (! v.on || v.dur <= 0 || v.t0 + v.dur < clock - 64) continue;
        for (int s = 0; s < numSamples; s += 64)
            sendBend (v, v.pitchAt (clock + s), range, s, out);
        sendBend (v, v.pitchAt (end), range, numSamples - 1, out);
    }

    if (phrase && numPend == 0 && end - lastOn > (juce::int64) (holdSecs.load() * sr))
        releaseAll (numSamples - 1, out);
    clock = end;
}
}
