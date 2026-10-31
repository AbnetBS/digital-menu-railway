#pragma once
// Minimal JSON double for compiling the real queue sender on a host.
// Production uses ArduinoJson; this handles primitive request/response fields
// and one-level arrays of flat objects used by batch offline sync.
#include "Arduino.h"
#include <cstdint>
#include <cstdlib>
#include <map>
#include <regex>
#include <sstream>
#include <string>
#include <vector>

struct TestJsonValue {
  TestJsonValue(const std::string &value = "", bool isQuoted = false) : text(value), quoted(isQuoted) {}
  std::string text;
  bool quoted;
};

using TestJsonFields = std::map<std::string, TestJsonValue>;

class JsonObject;
class JsonArray;
class DynamicJsonDocument;

class TestJsonRef {
 public:
  TestJsonRef(TestJsonFields &fields, std::map<std::string, std::vector<TestJsonFields>> *arrays, const std::string &key)
      : fields_(fields), arrays_(arrays), key_(key) {}
  TestJsonRef &operator=(const String &v) { fields_[key_] = {v.c_str(), true}; return *this; }
  TestJsonRef &operator=(const char *v) { fields_[key_] = {v ? v : "", true}; return *this; }
  TestJsonRef &operator=(int v) { fields_[key_] = {std::to_string(v), false}; return *this; }
  TestJsonRef &operator=(unsigned int v) { fields_[key_] = {std::to_string(v), false}; return *this; }
  TestJsonRef &operator=(unsigned long v) { fields_[key_] = {std::to_string(v), false}; return *this; }
  TestJsonRef &operator=(bool v) { fields_[key_] = {v ? "true" : "false", false}; return *this; }
  const char *operator|(const char *fallback) const {
    const auto it = fields_.find(key_);
    return it != fields_.end() && it->second.quoted ? it->second.text.c_str() : fallback;
  }
  int operator|(int fallback) const {
    const auto it = fields_.find(key_);
    return it != fields_.end() && !it->second.quoted ? std::atoi(it->second.text.c_str()) : fallback;
  }
  unsigned long operator|(unsigned long fallback) const {
    const auto it = fields_.find(key_);
    return it != fields_.end() && !it->second.quoted ? std::strtoul(it->second.text.c_str(), nullptr, 10) : fallback;
  }
  bool operator|(bool fallback) const {
    const auto it = fields_.find(key_);
    return it == fields_.end() ? fallback : it->second.text == "true";
  }
  TestJsonRef operator[](int idx) {
    static TestJsonFields empty;
    if (!arrays_ || idx < 0) return TestJsonRef(empty, nullptr, "");
    const size_t i = static_cast<size_t>(idx);
    auto &vec = (*arrays_)[key_];
    if (vec.size() <= i) vec.resize(i + 1);
    return TestJsonRef(vec[i], nullptr, "");
  }
  TestJsonRef operator[](const char *subKey) {
    return TestJsonRef(fields_, nullptr, subKey);
  }
  template <typename T> bool is() const;
  template <typename T> T as() const;
 private:
  TestJsonFields &fields_;
  std::map<std::string, std::vector<TestJsonFields>> *arrays_;
  std::string key_;
};

class JsonObject {
 public:
  explicit JsonObject(TestJsonFields *fields = nullptr) : fields_(fields) {}
  bool isNull() const { return fields_ == nullptr; }
  TestJsonRef operator[](const char *key) const {
    static TestJsonFields empty;
    return TestJsonRef(fields_ ? *fields_ : empty, nullptr, key);
  }
  template <typename T> T as() const;
 private:
  TestJsonFields *fields_;
};

template <> inline JsonObject JsonObject::as<JsonObject>() const { return *this; }

class JsonArray {
 public:
  struct Iterator {
    std::vector<TestJsonFields> *vec;
    size_t idx;
    bool operator!=(const Iterator &other) const { return idx != other.idx; }
    Iterator &operator++() { ++idx; return *this; }
    JsonObject operator*() const { return JsonObject(&(*vec)[idx]); }
  };
  explicit JsonArray(std::vector<TestJsonFields> *items = nullptr) : items_(items) {}
  JsonObject createNestedObject() {
    items_->push_back(TestJsonFields{});
    return JsonObject(&items_->back());
  }
  size_t size() const { return items_ ? items_->size() : 0; }
  JsonObject operator[](size_t i) const {
    return (items_ && i < items_->size()) ? JsonObject(&(*items_)[i]) : JsonObject(nullptr);
  }
  Iterator begin() const { return Iterator{items_, 0}; }
  Iterator end() const { return Iterator{items_, items_ ? items_->size() : 0}; }
 private:
  std::vector<TestJsonFields> *items_;
};

class DynamicJsonDocument {
 public:
  explicit DynamicJsonDocument(size_t) {}
  TestJsonRef operator[](const char *key) { return TestJsonRef(fields, &arrays, key); }
  JsonArray createNestedArray(const char *key) { return JsonArray(&arrays[key]); }
  bool overflowed() const { return false; }
  TestJsonFields fields;
  std::map<std::string, std::vector<TestJsonFields>> arrays;
};

template <> inline bool TestJsonRef::is<const char *>() const { return fields_.count(key_) && fields_.at(key_).quoted; }
template <> inline bool TestJsonRef::is<uint32_t>() const { return fields_.count(key_) && !fields_.at(key_).quoted; }
template <> inline bool TestJsonRef::is<JsonArray>() const { return arrays_ && arrays_->count(key_) > 0; }
template <> inline String TestJsonRef::as<String>() const { return String(fields_.at(key_).text); }
template <> inline uint32_t TestJsonRef::as<uint32_t>() const { return static_cast<uint32_t>(std::strtoul(fields_.at(key_).text.c_str(), nullptr, 10)); }
template <> inline JsonArray TestJsonRef::as<JsonArray>() const {
  return arrays_ && arrays_->count(key_) ? JsonArray(&(*arrays_)[key_]) : JsonArray(nullptr);
}

struct DeserializationError { bool failed; operator bool() const { return failed; } };

inline void parseFlatObjectFields(const std::string &text, TestJsonFields &out) {
  static const std::regex pair("\\\"([^\\\"]+)\\\"\\s*:\\s*(\\\"([^\\\"]*)\\\"|-?[0-9]+|true|false|null)");
  for (auto it = std::sregex_iterator(text.begin(), text.end(), pair); it != std::sregex_iterator(); ++it) {
    const auto &m = *it;
    const bool quoted = m[2].str()[0] == '"';
    out[m[1].str()] = {quoted ? m[3].str() : m[2].str(), quoted};
  }
}

inline DeserializationError deserializeJson(DynamicJsonDocument &doc, const String &input) {
  const std::string text(input.c_str());
  if (text.empty() || text[0] != '{' || text.back() != '}') return {true};
  doc.fields.clear();
  doc.arrays.clear();

  std::string topLevel = text;
  static const std::regex arrRe("\\\"([^\\\"]+)\\\"\\s*:\\s*\\[([^\\]]*)\\]");
  for (auto it = std::sregex_iterator(text.begin(), text.end(), arrRe); it != std::sregex_iterator(); ++it) {
    const std::string arrKey = (*it)[1].str();
    const std::string arrBody = (*it)[2].str();
    auto &vec = doc.arrays[arrKey];
    static const std::regex objRe("\\{([^\\}]*)\\}");
    for (auto oit = std::sregex_iterator(arrBody.begin(), arrBody.end(), objRe); oit != std::sregex_iterator(); ++oit) {
      TestJsonFields itemFields;
      parseFlatObjectFields((*oit)[0].str(), itemFields);
      vec.push_back(itemFields);
    }
  }
  topLevel = std::regex_replace(text, arrRe, "");
  parseFlatObjectFields(topLevel, doc.fields);
  return {false};
}

template <size_t N>
class StaticJsonDocument : public DynamicJsonDocument {
 public:
  StaticJsonDocument() : DynamicJsonDocument(N) {}
};

namespace DeserializationOption {
struct Filter {
  explicit Filter(const DynamicJsonDocument &) {}
};
}

inline DeserializationError deserializeJson(DynamicJsonDocument &doc, const String &input, DeserializationOption::Filter) {
  return deserializeJson(doc, input);
}

inline void serializeFieldsToStream(const TestJsonFields &fields, std::ostringstream &stream, bool &first) {
  for (const auto &item : fields) {
    if (!first) stream << ',';
    first = false;
    stream << '"' << item.first << "\":";
    if (item.second.quoted) stream << '"';
    stream << item.second.text;
    if (item.second.quoted) stream << '"';
  }
}

inline size_t serializeJson(DynamicJsonDocument &doc, String &out) {
  std::ostringstream stream;
  stream << '{';
  bool first = true;
  serializeFieldsToStream(doc.fields, stream, first);
  for (const auto &arr : doc.arrays) {
    if (!first) stream << ',';
    first = false;
    stream << '"' << arr.first << "\":[";
    for (size_t i = 0; i < arr.second.size(); ++i) {
      if (i) stream << ',';
      stream << '{';
      bool innerFirst = true;
      serializeFieldsToStream(arr.second[i], stream, innerFirst);
      stream << '}';
    }
    stream << ']';
  }
  stream << '}';
  out = String(stream.str());
  return out.length();
}
