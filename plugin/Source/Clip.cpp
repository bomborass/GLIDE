#include "Clip.h"
#include <algorithm>
#include <cmath>
#include <map>

namespace slide
{
namespace
{
enum Curve { smooth, linear, easeIn, easeOut, step };

struct Pt
{
    double t = 0;
    double v = 0;
    Curve c = smooth;
};

Curve parseCurve (const juce::var& c)
{
    const auto s = c.toString();
    if (s == "linear")  return linear;
    if (s == "easeIn")  return easeIn;
    if (s == "easeOut") return easeOut;
    if (s == "step")    return step;
    return smooth;
}

double shape (Curve c, double x)
{
    switch (c)
    {
        case linear:  return x;
        case easeIn:  return x * x;
        case easeOut: return 1 - (1 - x) * (1 - x);
        case step:    return x < 1 ? 0 : 1;
        case smooth:
        default:      return x * x * (3 - 2 * x);
    }
}

/** Same as evalPath in model.ts. */
double evalPath (const std::vector<Pt>& pts, double t, double fallback)
{
    if (pts.empty()) return fallback;
    if (t <= pts.front().t) return pts.front().v;
    if (t >= pts.back().t) return pts.back().v;
    size_t lo = 0, hi = pts.size() - 1;
    while (hi - lo > 1)
    {
        const auto m = (lo + hi) / 2;
        if (pts[m].t <= t) lo = m; else hi = m;
    }
    const auto& a = pts[lo];
    const auto& b = pts[hi];
    const auto span = b.t - a.t;
    if (span <= 1e-9) return b.v;
    return a.v + (b.v - a.v) * shape (a.c, (t - a.t) / span);
}

std::vector<Pt> readPath (const juce::var& arr, const char* timeKey)
{
    std::vector<Pt> out;
    if (auto* a = arr.getArray())
        for (auto& p : *a)
            out.push_back ({ (double) p.getProperty (timeKey, 0.0), (double) p.getProperty ("v", 0.0), parseCurve (p.getProperty ("c", {})) });
    std::stable_sort (out.begin(), out.end(), [] (const Pt& x, const Pt& y) { return x.t < y.t; });
    return out;
}

double num (const juce::var& o, const char* key, double fallback)
{
    const auto v = o.getProperty (key, {});
    return v.isVoid() || v.isUndefined() ? fallback : (double) v;
}

bool has (const juce::var& o, const char* key)
{
    const auto v = o.getProperty (key, {});
    return ! (v.isVoid() || v.isUndefined());
}

int clampInt (double v, int lo, int hi) { return juce::jlimit (lo, hi, (int) std::lround (v)); }

int bendValue (double semis, double range)
{
    return clampInt (8192.0 + semis / range * 8192.0, 0, 16383);
}

MidiEv ev (double beat, int order, int b0, int b1, int b2, int size = 3)
{
    MidiEv e;
    e.beat = beat;
    e.order = order;
    e.data[0] = (juce::uint8) b0;
    e.data[1] = (juce::uint8) b1;
    e.data[2] = (juce::uint8) b2;
    e.size = size;
    return e;
}

constexpr double noteOnDelay = 0.004;      // beats (about 2 ms)
constexpr double sampleStep = 10.0 / 480.0; // beats between expression samples (as the .mid export)
constexpr double defaultPressure = 0.55;
} // namespace

std::vector<MidiEv> mpeSetup (int range)
{
    std::vector<MidiEv> s;
    auto cc = [&] (int ch, int n, int v) { s.push_back (ev (0, 0, 0xb0 | ch, n, v)); };
    // MPE Configuration Message: lower zone with 15 member channels
    cc (0, 101, 0); cc (0, 100, 6); cc (0, 6, 15); cc (0, 101, 127); cc (0, 100, 127);
    // master channel bend range for the channel pitch lane
    cc (0, 101, 0); cc (0, 100, 0); cc (0, 6, masterBendRange); cc (0, 101, 127); cc (0, 100, 127);
    for (int ch = 1; ch <= 15; ++ch)
    {
        cc (ch, 101, 0); cc (ch, 100, 0); cc (ch, 6, juce::jmin (127, range)); cc (ch, 101, 127); cc (ch, 100, 127);
        s.push_back (ev (0, 0, 0xe0 | ch, 0, 64)); // centre bend
    }
    return s;
}

Compiled compileClip (const juce::var& clip)
{
    Compiled out;
    out.range = juce::jlimit (1, 96, (int) num (clip, "range", 48));
    out.length = juce::jmax (4.0, num (clip, "bars", 8) * 4.0);
    out.setup = mpeSetup (out.range);
    const double range = out.range;
    auto& E = out.events;

    // ---------------------------------------------------------------- notes
    struct N { juce::var v; double start, length; int pitch; };
    std::vector<N> notes;
    if (auto* arr = clip.getProperty ("notes", {}).getArray())
        for (auto& n : *arr)
        {
            if ((bool) n.getProperty ("muted", false)) continue;
            const auto start = num (n, "start", 0), length = num (n, "length", 0);
            if (length <= 0 || start >= out.length) continue;
            notes.push_back ({ n, start, juce::jmin (length, out.length - start), clampInt (num (n, "pitch", 60), 0, 127) });
        }
    std::stable_sort (notes.begin(), notes.end(), [] (const N& a, const N& b) { return a.start < b.start; });

    // channel allocation: round-robin over free member channels (as the export)
    constexpr int numCh = lastClipChannel - firstClipChannel + 1;
    double busyUntil[numCh];
    std::fill (std::begin (busyUntil), std::end (busyUntil), -1.0);
    int rr = 0;

    for (auto& note : notes)
    {
        int idx = rr;
        for (int k = 0; k < numCh; ++k)
        {
            const int c = (rr + k) % numCh;
            if (busyUntil[c] <= note.start + 1e-6) { idx = c; rr = (rr + k + 1) % numCh; break; }
            if (k == numCh - 1) { idx = rr; rr = (rr + 1) % numCh; }
        }
        busyUntil[idx] = note.start + note.length;
        const int ch = firstClipChannel + idx;

        const auto& n = note.v;
        const auto bend = readPath (n.getProperty ("bend", {}), "t");
        const auto pres = readPath (n.getProperty ("pressure", {}), "t");
        const double fine = num (n, "fine", 0);
        const int vel = clampInt (num (n, "velocity", 0.8) * 127, 1, 127);
        const int rel = clampInt (num (n, "release", 0.5) * 127, 0, 127);
        const double on = note.start, off = note.start + note.length;
        out.lastNoteEnd = juce::jmax (out.lastNoteEnd, off);

        auto bendAt = [&] (double x) { return evalPath (bend, x, 0) + fine; };
        auto presAt = [&] (double x) { return evalPath (pres, x, defaultPressure); };
        auto pb = [&] (double beat, double st, int order) { const int v = bendValue (st, range); E.push_back (ev (beat, order, 0xe0 | ch, v & 0x7f, v >> 7)); };
        auto cp = [&] (double beat, double p, int order) { E.push_back (ev (beat, order, 0xd0 | ch, clampInt (p * 127, 0, 127), 0, 2)); };
        auto ccv = [&] (int cc, double v) { E.push_back (ev (on, 2, 0xb0 | ch, cc, clampInt (v * 127, 0, 127))); };

        // per-note controllers and initial expression go before the note-on
        ccv (10, has (n, "pan") ? (num (n, "pan", 0) + 1) / 2 : 0.5);
        if (has (n, "cutoff")) ccv (74, num (n, "cutoff", 0.5));
        if (has (n, "resonance")) ccv (71, num (n, "resonance", 0.5));
        pb (on, bendAt (0), 2);
        cp (on, presAt (0), 2);

        const int reps = juce::jmax (1, (int) num (n, "repeat", 1));
        for (int r = 0; r < reps; ++r)
        {
            const double a = on + (off - on) * r / reps, b = on + (off - on) * (r + 1) / reps;
            // the first strike lands a hair after its bend/pressure/CCs, so hosts that turn
            // those into parameter changes (VST3) still apply them before the note starts
            E.push_back (ev (r == 0 ? a + noteOnDelay : a, 3, 0x90 | ch, note.pitch, vel));
            E.push_back (ev (b, 1, 0x80 | ch, note.pitch, rel)); // note-offs sort before new note-ons
        }

        int lastB = bendValue (bendAt (0), range), lastP = clampInt (presAt (0) * 127, 0, 127);
        for (double t = on + sampleStep; t < off - 1e-9; t += sampleStep)
        {
            const double x = (t - on) / (off - on);
            const int b = bendValue (bendAt (x), range);
            if (b != lastB) { pb (t, bendAt (x), 4); lastB = b; }
            const int p = clampInt (presAt (x) * 127, 0, 127);
            if (p != lastP) { cp (t, presAt (x), 4); lastP = p; }
        }
    }

    // ---------------------------------------------------------------- channel lanes
    if (auto* lanes = clip.getProperty ("cc", {}).getArray())
        for (auto& lane : *lanes)
        {
            const auto pts = readPath (lane.getProperty ("points", {}), "beat");
            if (pts.empty()) continue;
            const auto kind = lane.getProperty ("kind", "cc").toString();
            if (kind == "param")
            {
                const int index = lane.getProperty ("param", "-1").toString().getIntValue();
                if (index < 0) continue;
                out.drivenParams.push_back (index);
                double last = -1;
                for (double t = 0; t <= out.length; t += 1.0 / 32.0)
                {
                    const double v = juce::jlimit (0.0, 1.0, evalPath (pts, t, 0));
                    if (std::abs (v - last) > 1e-4) { out.params.push_back ({ t, index, (float) v }); last = v; }
                }
                continue;
            }
            int prev = -1;
            const int cc = (int) num (lane, "cc", 0);
            for (double t = 0; t <= out.length; t += sampleStep * 2)
            {
                const double v = evalPath (pts, t, 0);
                if (kind == "pitch")
                {
                    const int b = bendValue ((v - 0.5) * 2 * masterBendRange, masterBendRange);
                    if (b != prev) { E.push_back (ev (t, 1, 0xe0 | masterChannel, b & 0x7f, b >> 7)); prev = b; }
                    continue;
                }
                const int val = clampInt (v * 127, 0, 127);
                if (val != prev) { E.push_back (ev (t, 1, 0xb0 | masterChannel, juce::jlimit (0, 127, cc), val)); prev = val; }
            }
        }

    std::stable_sort (E.begin(), E.end(), [] (const MidiEv& a, const MidiEv& b) { return a.beat < b.beat || (a.beat == b.beat && a.order < b.order); });
    std::stable_sort (out.params.begin(), out.params.end(), [] (const ParamEv& a, const ParamEv& b) { return a.beat < b.beat; });
    return out;
}
} // namespace slide
