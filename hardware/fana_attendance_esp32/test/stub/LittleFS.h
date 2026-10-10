#ifndef LITTLEFS_H_STUB
#define LITTLEFS_H_STUB
#include <Arduino.h>
#include <map>
extern std::map<std::string, std::string> littleFsFiles;
class File : public Stream {
public:
  std::string path, content;
  size_t pos = 0;
  bool isOpen = false;
  operator bool() const { return isOpen; }
  int available() override { return (int)(content.size() - pos); }
  int read() override { return pos < content.size() ? (unsigned char)content[pos++] : -1; }
  size_t write(const uint8_t *b, size_t n) override { content.append((const char *)b, n); return n; }
  void print(const String &s) { content += s.c_str(); }
  String readString() { std::string r = content.substr(pos); pos = content.size(); return String(r); }
  String readStringUntil(char sep) {
    size_t e = content.find(sep, pos);
    if (e == std::string::npos) e = content.size();
    std::string r = content.substr(pos, e - pos);
    pos = (e < content.size()) ? e + 1 : content.size();
    return String(r);
  }
  void close() { if (isOpen) { littleFsFiles[path] = content; isOpen = false; } }
};
class LittleFSClass {
public:
  bool begin(bool = false) { return true; }
  File open(const char *p, const char *mode = "r") {
    File f;
    f.path = p;
    if (mode[0] == 'w') { f.isOpen = true; f.content = ""; }
    else if (littleFsFiles.count(p)) { f.isOpen = true; f.content = littleFsFiles[p]; }
    return f;
  }
  bool exists(const char *p) { return littleFsFiles.count(p) > 0; }
  void remove(const char *p) { littleFsFiles.erase(p); }
};
extern LittleFSClass LittleFS;
#endif
