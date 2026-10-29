#pragma once
#include <cstddef>
#include <cstdint>
#include <cctype>
#include <string>

class String {
 public:
  String() = default;
  String(const char *s) : text_(s ? s : "") {}
  String(const std::string &s) : text_(s) {}
  String(unsigned long n) : text_(std::to_string(n)) {}
  size_t length() const { return text_.length(); }
  String substring(size_t from, size_t to) const { return String(text_.substr(from, to - from)); }
  const char *c_str() const { return text_.c_str(); }
  char operator[](size_t i) const { return text_[i]; }
  int indexOf(char c) const {
    const size_t pos = text_.find(c);
    return pos == std::string::npos ? -1 : static_cast<int>(pos);
  }
  void trim() {
    size_t a = 0, b = text_.length();
    while (a < b && std::isspace(static_cast<unsigned char>(text_[a]))) ++a;
    while (b > a && std::isspace(static_cast<unsigned char>(text_[b - 1]))) --b;
    text_ = text_.substr(a, b - a);
  }
  friend String operator+(const String &a, const String &b) { return String(a.text_ + b.text_); }
  friend bool operator==(const String &a, const String &b) { return a.text_ == b.text_; }
 private:
  std::string text_;
};
