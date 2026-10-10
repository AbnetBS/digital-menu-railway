// Small ArduinoJson-compatible stub: enough for the payloads this sketch reads
// and writes, and correct enough (write-through references) to run them.
#ifndef ARDUINOJSON_H_STUB
#define ARDUINOJSON_H_STUB
#include <Arduino.h>
#include <map>
#include <vector>
#include <memory>
#include <type_traits>

class JsonVariant {
public:
  enum Kind { NIL, NUM, STR, OBJ, ARR } kind = NIL;
  double num = 0;
  std::string str;
  std::shared_ptr<std::map<std::string, JsonVariant>> obj;
  std::shared_ptr<std::vector<JsonVariant>> arr;

  JsonVariant() {}
  JsonVariant(double v) : kind(NUM), num(v) {}
  JsonVariant(int v) : kind(NUM), num(v) {}
  JsonVariant(const char *v) : kind(STR), str(v ? v : "") {}
  JsonVariant(const std::string &v) : kind(STR), str(v) {}
  JsonVariant(const String &v) : kind(STR), str(v.c_str()) {}

  template <typename T> T as() const;
  int operator|(int fallback) const { return kind == NUM ? (int)num : fallback; }
  const char *operator|(const char *fallback) const { return kind == STR ? str.c_str() : fallback; }

  void set(int v) { kind = NUM; num = v; }
  void set(unsigned int v) { kind = NUM; num = v; }
  void set(long v) { kind = NUM; num = (double)v; }
  void set(unsigned long v) { kind = NUM; num = (double)v; }
  void set(double v) { kind = NUM; num = v; }
  void set(const char *v) { kind = STR; str = v ? v : ""; }
  void set(const std::string &v) { kind = STR; str = v; }
  void set(const String &v) { kind = STR; str = v.c_str(); }
  void set(const JsonVariant &v) { *this = v; }

  template <typename T> void operator=(const T &v) { set(v); }

  bool isNull() const { return kind == NIL; }
  const char *c_str() const { return str.c_str(); }

  JsonVariant &operator[](const char *k) {
    if (kind == NIL) { kind = OBJ; obj = std::make_shared<std::map<std::string, JsonVariant>>(); }
    static JsonVariant scratch;
    if (kind != OBJ || !obj) return scratch;
    return (*obj)[k];
  }
  JsonVariant operator[](const char *k) const {
    if (kind == OBJ && obj && obj->count(k)) return obj->at(k);
    return JsonVariant();
  }
  JsonVariant operator[](int i) const {
    if (kind == ARR && arr && i >= 0 && i < (int)arr->size()) return (*arr)[i];
    return JsonVariant();
  }

  struct Iter;
  Iter begin();
  Iter end();
};
using JsonObject = JsonVariant;

struct JsonPairT {
  std::string k;
  JsonVariant v;
  const std::string &key() const { return k; }
  JsonVariant value() const { return v; }
};
struct JsonVariant::Iter {
  std::map<std::string, JsonVariant>::iterator it;
  JsonPairT operator*() { return JsonPairT{it->first, it->second}; }
  Iter &operator++() { ++it; return *this; }
  bool operator!=(const Iter &o) const { return it != o.it; }
};
inline JsonVariant::Iter JsonVariant::begin() {
  static std::map<std::string, JsonVariant> empty;
  return Iter{obj ? obj->begin() : empty.begin()};
}
inline JsonVariant::Iter JsonVariant::end() {
  static std::map<std::string, JsonVariant> empty;
  return Iter{obj ? obj->end() : empty.end()};
}
using JsonPair = JsonPairT;

template <> inline int JsonVariant::as<int>() const { return (int)num; }
template <> inline unsigned int JsonVariant::as<unsigned int>() const { return (unsigned int)num; }
template <> inline long JsonVariant::as<long>() const { return (long)num; }
template <> inline double JsonVariant::as<double>() const { return num; }
template <> inline bool JsonVariant::as<bool>() const { return num != 0; }
template <> inline const char *JsonVariant::as<const char *>() const { return str.c_str(); }
template <> inline String JsonVariant::as<String>() const {
  return kind == NUM ? String((int)num) : String(str);
}
template <> inline std::string JsonVariant::as<std::string>() const {
  return kind == NUM ? std::to_string((int)num) : str;
}
template <> inline JsonObject JsonVariant::as<JsonObject>() const { return *this; }

class DynamicJsonDocument : public JsonVariant {
public:
  DynamicJsonDocument(size_t = 0) { kind = OBJ; obj = std::make_shared<std::map<std::string, JsonVariant>>(); }
};

/* ── tiny JSON reader (flat objects, nested objects, arrays of objects) ──── */
namespace jsonstub {
struct Parser {
  const std::string &s;
  size_t i = 0;
  explicit Parser(const std::string &t) : s(t) {}
  void ws() { while (i < s.size() && isspace((unsigned char)s[i])) i++; }
  bool lit(const char *w) {
    size_t n = strlen(w);
    if (s.compare(i, n, w) == 0) { i += n; return true; }
    return false;
  }
  std::string readString() {
    if (i >= s.size() || s[i] != '"') return "";
    i++;
    std::string r;
    while (i < s.size() && s[i] != '"') {
      if (s[i] == '\\' && i + 1 < s.size()) { r += s[i + 1]; i += 2; }
      else r += s[i++];
    }
    if (i < s.size()) i++;
    return r;
  }
  JsonVariant value();
  JsonVariant object() {
    JsonVariant v;
    v.kind = JsonVariant::OBJ;
    v.obj = std::make_shared<std::map<std::string, JsonVariant>>();
    i++; // {
    for (;;) {
      ws();
      if (i >= s.size() || s[i] == '}') { i++; break; }
      std::string k = readString();
      ws();
      if (i < s.size() && s[i] == ':') i++;
      (*v.obj)[k] = value();
      ws();
      if (i < s.size() && s[i] == ',') { i++; continue; }
    }
    return v;
  }
  JsonVariant array() {
    JsonVariant v;
    v.kind = JsonVariant::ARR;
    v.arr = std::make_shared<std::vector<JsonVariant>>();
    i++; // [
    for (;;) {
      ws();
      if (i >= s.size() || s[i] == ']') { i++; break; }
      v.arr->push_back(value());
      ws();
      if (i < s.size() && s[i] == ',') { i++; continue; }
    }
    return v;
  }
};
inline JsonVariant Parser::value() {
  ws();
  if (i >= s.size()) return JsonVariant();
  if (s[i] == '{') return object();
  if (s[i] == '[') return array();
  if (s[i] == '"') return JsonVariant(readString());
  if (lit("true")) return JsonVariant(1);
  if (lit("false")) return JsonVariant(0);
  if (lit("null")) return JsonVariant();
  size_t start = i;
  while (i < s.size() && s[i] != ',' && s[i] != '}' && s[i] != ']') i++;
  std::string tok = s.substr(start, i - start);
  while (!tok.empty() && isspace((unsigned char)tok.back())) tok.pop_back();
  return JsonVariant(atof(tok.c_str()));
}
} // namespace jsonstub

inline int deserializeJson(DynamicJsonDocument &doc, const String &text) {
  std::string s = text.c_str();
  jsonstub::Parser p(s);
  p.ws();
  if (p.i >= s.size() || s[p.i] != '{') return 1;
  JsonVariant v = p.object();
  if (v.obj) *doc.obj = *v.obj;
  return 0;
}

inline void jsonWrite(const JsonVariant &v, std::string &out) {
  switch (v.kind) {
    case JsonVariant::NUM: {
      char b[32];
      snprintf(b, sizeof(b), "%g", v.num);
      out += b;
      break;
    }
    case JsonVariant::STR: out += "\"" + v.str + "\""; break;
    case JsonVariant::OBJ: {
      out += "{";
      bool first = true;
      if (v.obj) for (auto &kv : *v.obj) {
        if (!first) out += ",";
        first = false;
        out += "\"" + kv.first + "\":";
        jsonWrite(kv.second, out);
      }
      out += "}";
      break;
    }
    case JsonVariant::ARR: {
      out += "[";
      bool first = true;
      if (v.arr) for (auto &e : *v.arr) {
        if (!first) out += ",";
        first = false;
        jsonWrite(e, out);
      }
      out += "]";
      break;
    }
    default: out += "null";
  }
}

inline size_t serializeJson(const DynamicJsonDocument &doc, String &out) {
  std::string s;
  jsonWrite(doc, s);
  out = String(s);
  return s.size();
}
#endif
