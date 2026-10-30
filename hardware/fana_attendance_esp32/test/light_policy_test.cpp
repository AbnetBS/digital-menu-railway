// The runner inserts the production idle and post-capture light functions.
#include <cassert>
#include <cstdint>
#include <iostream>
#define READER_LAMP_IDLE_MS 700UL
#define READER_LAMP_BURST_MS 300UL
struct Reader { bool flashing = false; bool lightFlashes() { return flashing; } } finger;
bool readerLightNeedsRefresh = false;
int requests = 0;
uint32_t gap = 0;
void keepReaderLampOn(uint32_t n) { ++requests; gap = n; }
// -- INSERT REAL LIGHT POLICY --
int main() {
  finger.flashing = true;
  for (int i = 0; i < 100; ++i) { maintainReaderLight(); reassertReaderLight(); }
  assert(requests == 0); // do not restart the autonomous animation while idle
  readerLightNeedsRefresh = true;
  reassertReaderLight();
  assert(requests == 1 && gap == 0 && !readerLightNeedsRefresh);
  maintainReaderLight();
  assert(requests == 1);
  readerLightNeedsRefresh = true;
  maintainReaderLight(); // successful match returns before the next loop
  assert(requests == 2 && gap == 0 && !readerLightNeedsRefresh);
  finger.flashing = false;
  maintainReaderLight();
  assert(requests == 3 && gap == READER_LAMP_IDLE_MS);
  reassertReaderLight();
  assert(requests == 4 && gap == READER_LAMP_BURST_MS);
  std::cout << "Light policy tests passed: autonomous flashing and fallback refresh\n";
}
