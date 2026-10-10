#pragma once
#include <Arduino.h>
extern std::map<std::string, std::string> g_files;
class File : public Stream {
 public:
  std::string path;
  size_t pos = 0;
  bool ok = false;
  bool writing = false;
  File() {}
  File(const std::string &p, const char *mode) : path(p), ok(true) {
    if (mode[0] == 'w') { g_files[p] = ""; writing = true; }
    else if (mode[0] == 'a') { g_files[p]; writing = true; }
    else if (!g_files.count(p)) ok = false;
  }
  explicit operator bool() const { return ok; }
  int available() override { return ok ? (int)(g_files[path].size() - pos) : 0; }
  int read() override { return available() > 0 ? (unsigned char)g_files[path][pos++] : -1; }
  size_t write(uint8_t b) override { if (ok && writing) g_files[path] += (char)b; return 1; }
  void close() { ok = false; }
};
class LittleFSClass {
 public:
  bool begin(bool) { return true; }
  bool exists(const char *p) { return g_files.count(p) > 0; }
  File open(const char *p, const char *mode) { return File(p, mode); }
  bool remove(const char *p) { return g_files.erase(p) > 0; }
  bool rename(const char *a, const char *b) {
    if (!g_files.count(a)) return false;
    g_files[b] = g_files[a];
    g_files.erase(a);
    return true;
  }
};
extern LittleFSClass LittleFS;
