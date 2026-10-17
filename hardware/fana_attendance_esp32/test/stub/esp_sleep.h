// The ESP32 deep-sleep API, stubbed for the host build (see the rest-window
// section of enroll_host_test.cpp). A test cannot put the process to sleep, so
// the sketch's DECISION is recorded: how long it wanted to sleep for, and how
// many times it decided to.
#ifndef ESP_SLEEP_H_STUB
#define ESP_SLEEP_H_STUB
#include <cstdint>

extern uint64_t stubSleepUs;
extern int stubDeepSleepCalls;

inline int esp_sleep_enable_timer_wakeup(uint64_t microseconds) {
  stubSleepUs = microseconds;
  return 0;
}

inline void esp_deep_sleep_start() { stubDeepSleepCalls++; }

#endif
