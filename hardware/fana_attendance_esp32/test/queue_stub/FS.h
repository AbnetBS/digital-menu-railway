#pragma once
#include "Arduino.h"
#include <algorithm>
#include <limits>
#include <map>
#include <memory>
#include <string>

namespace fs { class FS; }
class File {
 public:
  File() = default;
  File(fs::FS *fs, std::shared_ptr<std::string> data, size_t pos, bool writable)
      : fs_(fs), data_(data), pos_(pos), writable_(writable) {}
  explicit operator bool() const { return static_cast<bool>(data_); }
  size_t size() const { return data_ ? data_->size() : 0; }
  size_t position() const { return pos_; }
  bool seek(size_t n) { if (!data_ || n > data_->size()) return false; pos_ = n; return true; }
  int read() { return data_ && pos_ < data_->size() ? static_cast<unsigned char>((*data_)[pos_++]) : -1; }
  String readStringUntil(char c) {
    std::string out;
    while (data_ && pos_ < data_->size()) { char b = (*data_)[pos_++]; if (b == c) break; out += b; }
    return String(out);
  }
  String readString() {
    if (!data_) return String();
    const std::string result = data_->substr(pos_);
    pos_ = data_->size();
    return String(result);
  }
  size_t print(const String &s);
  void flush() {}
  void close() { data_.reset(); }
 private:
  fs::FS *fs_ = nullptr;
  std::shared_ptr<std::string> data_;
  size_t pos_ = 0;
  bool writable_ = false;
};
namespace fs {
class FS {
 public:
  std::map<std::string, std::shared_ptr<std::string>> files;
  size_t writeLimit = std::numeric_limits<size_t>::max();
  bool failRename = false;
  bool failRemove = false;
  bool failWriteOpen = false;
  bool exists(const char *path) const { return files.count(path) != 0; }
  bool remove(const char *path) { return !failRemove && files.erase(path) != 0; }
  bool rename(const char *from, const char *to) {
    if (failRename || !exists(from)) return false;
    files[to] = files[from]; files.erase(from); return true;
  }
  File open(const char *path, const char *mode) {
    const bool writable = mode[0] != 'r';
    if (writable && failWriteOpen) return File();
    if (!exists(path)) {
      if (!writable) return File();
      files[path] = std::make_shared<std::string>();
    }
    auto value = files[path];
    if (mode[0] == 'w') value->clear();
    return File(this, value, mode[0] == 'a' ? value->size() : 0, writable);
  }
  void put(const char *path, const std::string &value) { files[path] = std::make_shared<std::string>(value); }
  std::string get(const char *path) const { return files.at(path) ? *files.at(path) : ""; }
};
}
inline size_t File::print(const String &s) {
  if (!writable_ || !data_ || !fs_) return 0;
  const size_t count = std::min(s.length(), fs_->writeLimit);
  if (pos_ > data_->size()) return 0;
  data_->replace(pos_, count, s.c_str(), count);
  pos_ += count;
  return count;
}
