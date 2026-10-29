#pragma once
// Minimal flat-JSON double for compiling the real queue sender on a host.
// Production uses ArduinoJson; this intentionally handles only this test's
// primitive request/response fields and is not a general JSON parser.
#include "Arduino.h"
#include <cstdint>
#include <cstdlib>
#include <map>
#include <regex>
#include <sstream>
#include <string>

struct TestJsonValue {
  TestJsonValue(const std::string &value = "", bool isQuoted = false) : text(value), quoted(isQuoted) {}
  std::string text;
  bool quoted;
};
class DynamicJsonDocument;
class TestJsonRef {
 public:
  TestJsonRef(DynamicJsonDocument &doc, const std::string &key) : doc_(doc), key_(key) {}
  TestJsonRef &operator=(const String &v);
  TestJsonRef &operator=(const char *v);
  TestJsonRef &operator=(int v);
  TestJsonRef &operator=(unsigned int v);
  TestJsonRef &operator=(unsigned long v);
  TestJsonRef &operator=(bool v);
  const char *operator|(const char *fallback) const;
  int operator|(int fallback) const;
  unsigned long operator|(unsigned long fallback) const;
  bool operator|(bool fallback) const;
  template <typename T> bool is() const;
  template <typename T> T as() const;
 private:
  DynamicJsonDocument &doc_;
  std::string key_;
};
class DynamicJsonDocument {
 public:
  explicit DynamicJsonDocument(size_t) {}
  TestJsonRef operator[](const char *key) { return TestJsonRef(*this, key); }
  bool overflowed() const { return false; }
  std::map<std::string, TestJsonValue> fields;
};
inline TestJsonRef &TestJsonRef::operator=(const String &v) { doc_.fields[key_] = {v.c_str(), true}; return *this; }
inline TestJsonRef &TestJsonRef::operator=(const char *v) { doc_.fields[key_] = {v ? v : "", true}; return *this; }
inline TestJsonRef &TestJsonRef::operator=(int v) { doc_.fields[key_] = {std::to_string(v), false}; return *this; }
inline TestJsonRef &TestJsonRef::operator=(unsigned int v) { doc_.fields[key_] = {std::to_string(v), false}; return *this; }
inline TestJsonRef &TestJsonRef::operator=(unsigned long v) { doc_.fields[key_] = {std::to_string(v), false}; return *this; }
inline TestJsonRef &TestJsonRef::operator=(bool v) { doc_.fields[key_] = {v ? "true" : "false", false}; return *this; }
inline const char *TestJsonRef::operator|(const char *fallback) const {
  const auto it = doc_.fields.find(key_); return it != doc_.fields.end() && it->second.quoted ? it->second.text.c_str() : fallback;
}
inline int TestJsonRef::operator|(int fallback) const {
  const auto it = doc_.fields.find(key_); return it != doc_.fields.end() && !it->second.quoted ? std::atoi(it->second.text.c_str()) : fallback;
}
inline unsigned long TestJsonRef::operator|(unsigned long fallback) const {
  const auto it = doc_.fields.find(key_); return it != doc_.fields.end() && !it->second.quoted ? std::strtoul(it->second.text.c_str(), nullptr, 10) : fallback;
}
inline bool TestJsonRef::operator|(bool fallback) const {
  const auto it = doc_.fields.find(key_); return it == doc_.fields.end() ? fallback : it->second.text == "true";
}
template <> inline bool TestJsonRef::is<const char *>() const { return doc_.fields.count(key_) && doc_.fields.at(key_).quoted; }
template <> inline bool TestJsonRef::is<uint32_t>() const { return doc_.fields.count(key_) && !doc_.fields.at(key_).quoted; }
template <> inline String TestJsonRef::as<String>() const { return String(doc_.fields.at(key_).text); }
template <> inline uint32_t TestJsonRef::as<uint32_t>() const { return static_cast<uint32_t>(std::strtoul(doc_.fields.at(key_).text.c_str(), nullptr, 10)); }
struct DeserializationError { bool failed; operator bool() const { return failed; } };
inline DeserializationError deserializeJson(DynamicJsonDocument &doc, const String &input) {
  const std::string text(input.c_str());
  if (text.empty() || text[0] != '{' || text.back() != '}') return {true};
  static const std::regex pair("\\\"([^\\\"]+)\\\"\\s*:\\s*(\\\"([^\\\"]*)\\\"|-?[0-9]+|true|false|null)");
  for (auto it = std::sregex_iterator(text.begin(), text.end(), pair); it != std::sregex_iterator(); ++it) {
    const auto &m = *it;
    const bool quoted = m[2].str()[0] == '"';
    doc.fields[m[1].str()] = {quoted ? m[3].str() : m[2].str(), quoted};
  }
  return {false};
}
inline size_t serializeJson(DynamicJsonDocument &doc, String &out) {
  std::ostringstream stream;
  stream << '{';
  bool first = true;
  for (const auto &item : doc.fields) {
    if (!first) stream << ',';
    first = false;
    stream << '"' << item.first << "\":";
    if (item.second.quoted) stream << '"';
    stream << item.second.text;
    if (item.second.quoted) stream << '"';
  }
  stream << '}';
  out = String(stream.str());
  return out.length();
}
