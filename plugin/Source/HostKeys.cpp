#include "HostKeys.h"

#if ! JUCE_MAC
namespace slide
{
HostKeys::HostKeys (juce::Component& o, Handlers h) : owner (o), handlers (std::move (h)) {}
HostKeys::~HostKeys() = default;
}
#endif
