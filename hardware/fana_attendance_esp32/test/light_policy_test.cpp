// The runner inserts the production idle and post-capture light functions.
#include <cassert>
#include <cstdint>
#include <iostream>
#define READER_LAMP_IDLE_MS 700UL
#define READER_LAMP_BURST_MS 300UL
int requests = 0;
uint32_t gap = 0;
void keepReaderLampOn(uint32_t n) { ++requests; gap = n; }
// -- INSERT REAL LIGHT POLICY --
int main() {
  maintainReaderLight();
  assert(requests == 1 && gap == READER_LAMP_IDLE_MS);
  reassertReaderLight();
  assert(requests == 2 && gap == READER_LAMP_BURST_MS);
  maintainReaderLight();
  assert(requests == 3 && gap == READER_LAMP_IDLE_MS);
  std::cout << "Light policy tests passed: previous idle and capture refresh cadence\n";
}
