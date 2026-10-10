#pragma once
#include_next <time.h>
// Virtual wall clock for the tests: 0 means "NTP not synced yet".
extern long long g_epochAtZero;
time_t sim_time(time_t *);
#define time(x) sim_time(x)
inline void configTime(long, int, const char *, const char * = nullptr, const char * = nullptr) {}
