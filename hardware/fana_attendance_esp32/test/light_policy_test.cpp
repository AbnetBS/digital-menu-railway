// The runner inserts the production idle and post-capture light functions.
#include <cassert>
#include <cstdint>
#include <iostream>
#define READER_LAMP_IDLE_MS 700UL
#define READER_LAMP_BURST_MS 300UL
int requests = 0;
uint32_t gap = 0;
bool forced = false;
void keepReaderLampOn(uint32_t n, bool force = false) { ++requests; gap = n; forced = force; }
// -- INSERT REAL LIGHT POLICY --
int main() {
  maintainReaderLight();
  assert(requests == 1 && gap == READER_LAMP_IDLE_MS);
  reassertReaderLight();
  // A post-capture re-assert is FORCED: it must not be swallowed by the
  // miss-backoff, because that is the moment the reader's LED may go out.
  assert(requests == 2 && gap == READER_LAMP_BURST_MS && forced);
  maintainReaderLight();
  assert(requests == 3 && gap == READER_LAMP_IDLE_MS && !forced);
  std::cout << "Light policy tests passed: previous idle and capture refresh cadence\n";
}
