#pragma once
#include <chrono>
#include <mutex>
using SemaphoreHandle_t = std::timed_mutex *;
inline int xSemaphoreTake(SemaphoreHandle_t m, int timeout) {
  return m->try_lock_for(std::chrono::milliseconds(timeout)) ? 1 : 0;
}
inline void xSemaphoreGive(SemaphoreHandle_t m) { m->unlock(); }
