#pragma once
#include <Arduino.h>
#include <FS.h>
#include <freertos/FreeRTOS.h>
#include <freertos/semphr.h>
#include <vector>

// An append-only, ordered queue. The sender copies ONE head while holding the
// lock, releases it during HTTP, then advances a durable byte cursor after a
// successful response. New scans can append while a slow request is in flight.
// A truncated line, a bad cursor, or a failed write is retained, never skipped.
class OfflineQueue {
 public:
  struct Head { String line; size_t start = 0; size_t end = 0; };
  enum Peek { EMPTY, READY, BLOCKED };
  OfflineQueue(fs::FS &fs, SemaphoreHandle_t mutex) : fs_(fs), mutex_(mutex) {}

  bool append(const String &line) {
    Guard guard(mutex_);
    if (!guard.locked || line.length() == 0 || line.indexOf('\n') >= 0) return false;
    if (!fs_.exists(path_)) {
      // A crash after the previous empty queue was removed can leave its cursor.
      if (fs_.exists(cursor_) && !fs_.remove(cursor_)) return false;
    } else {
      File existing = fs_.open(path_, "r");
      if (!existing) return false;
      const size_t size = existing.size();
      if (size && (!existing.seek(size - 1) || existing.read() != '\n')) {
        existing.close();
        return false; // do not attach a new scan to a partially written line
      }
      existing.close();
    }
    File out = fs_.open(path_, "a");
    if (!out) return false;
    const String record = line + "\n";
    const size_t written = out.print(record);
    out.flush();
    out.close();
    return written == record.length();
  }

  // The first NTP anchor after scans without a clock is saved before any such
  // scan can be uploaded. It is keyed by boot, so a later reboot/retry keeps
  // the exact same estimated timestamp instead of inventing a new one.
  bool saveClockAnchor(const String &boot, unsigned long epoch, uint32_t uptime) {
    Guard guard(mutex_);
    if (!guard.locked || !validBoot(boot) || !epoch) return false;
    const String path = String("/anchor-") + boot;
    if (fs_.exists(path.c_str())) {
      unsigned long oldEpoch = 0;
      uint32_t oldUptime = 0;
      return readAnchorFile(path, oldEpoch, oldUptime);
    }
    File out = fs_.open("/anchor.tmp", "w");
    if (!out) return false;
    const String value = String(epoch) + "," + String((unsigned long)uptime) + "\n";
    const size_t written = out.print(value);
    out.flush();
    out.close();
    if (written != value.length() || !fs_.rename("/anchor.tmp", path.c_str())) {
      fs_.remove("/anchor.tmp");
      return false;
    }
    return true;
  }

  bool readClockAnchor(const String &boot, unsigned long &epoch, uint32_t &uptime) {
    Guard guard(mutex_);
    if (!guard.locked || !validBoot(boot)) return false;
    return readAnchorFile(String("/anchor-") + boot, epoch, uptime);
  }

  // Copy an irrecoverable no-clock record for manual reconciliation before
  // acknowledging it. A crash between copy and acknowledge can duplicate a
  // review line; its eventId lets the administrator recognize the duplicate.
  bool copyToReview(const Head &head, const char *reason) {
    Guard guard(mutex_);
    if (!guard.locked || !reason) return false;
    size_t cursor = 0;
    if (!readCursor(cursor) || cursor != head.start || !head.line.length()) return false;
    if (fs_.exists("/queue.review.jsonl")) {
      File check = fs_.open("/queue.review.jsonl", "r");
      if (!check) return false;
      const size_t size = check.size();
      if (size && (!check.seek(size - 1) || check.read() != '\n')) { check.close(); return false; }
      check.close();
    }
    File out = fs_.open("/queue.review.jsonl", "a");
    if (!out) return false;
    // Reason is one of the firmware's fixed literals; record is the original
    // JSON object, retained exactly for the administrator to reconcile.
    const String line = String("{\"reason\":\"") + reason + "\",\"record\":" + head.line + "}\n";
    const size_t written = out.print(line);
    out.flush();
    out.close();
    return written == line.length();
  }

  Peek peek(Head &head) {
    Guard guard(mutex_);
    if (!guard.locked) return BLOCKED;
    if (!fs_.exists(path_)) return EMPTY;
    size_t cursor = 0;
    if (!readCursor(cursor)) return BLOCKED;
    File in = fs_.open(path_, "r");
    if (!in) return BLOCKED;
    const size_t size = in.size();
    if (cursor > size) { in.close(); return BLOCKED; }
    if (cursor == size) {
      in.close();
      // Remove the exhausted log first. append() clears any stale cursor before
      // creating a new generation, including after power loss between removes.
      if (!fs_.remove(path_)) return BLOCKED;
      if (fs_.exists(cursor_)) fs_.remove(cursor_);
      return EMPTY;
    }
    if (!in.seek(cursor)) { in.close(); return BLOCKED; }
    String line = in.readStringUntil('\n');
    const size_t end = in.position();
    if (end <= cursor || !in.seek(end - 1) || in.read() != '\n') {
      in.close();
      return BLOCKED; // never send or skip a partially written record
    }
    in.close();
    line.trim();
    if (!line.length()) return BLOCKED;
    head.line = line;
    head.start = cursor;
    head.end = end;
    return READY;
  }

  bool acknowledge(const Head &head) {
    Guard guard(mutex_);
    if (!guard.locked) return false;
    size_t cursor = 0;
    if (!readCursor(cursor) || cursor != head.start) return false;
    File in = fs_.open(path_, "r");
    if (!in || head.end > in.size() || head.end <= head.start) { if (in) in.close(); return false; }
    const size_t size = in.size();
    in.close();
    File temp = fs_.open(temp_, "w");
    if (!temp) return false;
    const String value = String((unsigned long)head.end);
    const size_t written = temp.print(value);
    temp.flush();
    temp.close();
    if (written != value.length() || !fs_.rename(temp_, cursor_)) {
      fs_.remove(temp_);
      return false;
    }
    if (head.end == size && fs_.remove(path_)) fs_.remove(cursor_);
    return true;
  }

  bool hasPending() {
    Guard guard(mutex_);
    if (!guard.locked || !fs_.exists(path_)) return false;
    size_t cursor = 0;
    if (!readCursor(cursor)) return true;
    File in = fs_.open(path_, "r");
    if (!in) return false;
    const size_t size = in.size();
    in.close();
    return cursor < size;
  }

  Peek peekBatch(std::vector<Head> &items, size_t maxItems) {
    items.clear();
    if (maxItems == 0) return EMPTY;
    Guard guard(mutex_);
    if (!guard.locked) return BLOCKED;
    if (!fs_.exists(path_)) return EMPTY;
    size_t cursor = 0;
    if (!readCursor(cursor)) return BLOCKED;
    File in = fs_.open(path_, "r");
    if (!in) return BLOCKED;
    const size_t size = in.size();
    if (cursor > size) { in.close(); return BLOCKED; }
    if (cursor == size) {
      in.close();
      if (!fs_.remove(path_)) return BLOCKED;
      if (fs_.exists(cursor_)) fs_.remove(cursor_);
      return EMPTY;
    }
    size_t pos = cursor;
    while (pos < size && items.size() < maxItems) {
      if (!in.seek(pos)) {
        in.close();
        return items.empty() ? BLOCKED : READY;
      }
      String line = in.readStringUntil('\n');
      const size_t end = in.position();
      if (end <= pos || !in.seek(end - 1) || in.read() != '\n') {
        in.close();
        return items.empty() ? BLOCKED : READY;
      }
      line.trim();
      if (!line.length()) {
        in.close();
        return items.empty() ? BLOCKED : READY;
      }
      Head h;
      h.line = line;
      h.start = pos;
      h.end = end;
      items.push_back(h);
      pos = end;
    }
    in.close();
    return items.empty() ? BLOCKED : READY;
  }

  bool acknowledgeBatch(const Head &first, const Head &last) {
    Guard guard(mutex_);
    if (!guard.locked) return false;
    size_t cursor = 0;
    if (!readCursor(cursor) || cursor != first.start) return false;
    File in = fs_.open(path_, "r");
    if (!in || last.end > in.size() || last.end <= first.start) { if (in) in.close(); return false; }
    const size_t size = in.size();
    in.close();
    File temp = fs_.open(temp_, "w");
    if (!temp) return false;
    const String value = String((unsigned long)last.end);
    const size_t written = temp.print(value);
    temp.flush();
    temp.close();
    if (written != value.length() || !fs_.rename(temp_, cursor_)) {
      fs_.remove(temp_);
      return false;
    }
    if (last.end == size && fs_.remove(path_)) fs_.remove(cursor_);
    return true;
  }

 private:
  struct Guard {
    SemaphoreHandle_t mutex;
    bool locked;
    explicit Guard(SemaphoreHandle_t m) : mutex(m), locked(m && xSemaphoreTake(m, pdMS_TO_TICKS(2000)) == pdTRUE) {}
    ~Guard() { if (locked) xSemaphoreGive(mutex); }
  };
  bool validBoot(const String &boot) {
    if (boot.length() != 16) return false;
    for (size_t i = 0; i < boot.length(); ++i) {
      const char c = boot[i];
      if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return false;
    }
    return true;
  }
  bool parseNumber(const String &s, size_t from, size_t to, unsigned long &value) {
    if (from >= to) return false;
    value = 0;
    for (size_t i = from; i < to; ++i) {
      const char c = s[i];
      if (c < '0' || c > '9' || value > (0xFFFFFFFFUL - (unsigned long)(c - '0')) / 10UL) return false;
      value = value * 10UL + (unsigned long)(c - '0');
    }
    return true;
  }
  bool readAnchorFile(const String &path, unsigned long &epoch, uint32_t &uptime) {
    File in = fs_.open(path.c_str(), "r");
    if (!in) return false;
    const String value = in.readString();
    in.close();
    const int comma = value.indexOf(',');
    unsigned long seconds = 0;
    if (comma <= 0 || value.length() < 4 || value[value.length() - 1] != '\n' ||
        !parseNumber(value, 0, (size_t)comma, epoch) ||
        !parseNumber(value, (size_t)comma + 1, value.length() - 1, seconds) || !epoch) return false;
    uptime = (uint32_t)seconds;
    return true;
  }
  bool readCursor(size_t &out) {
    out = 0;
    if (!fs_.exists(cursor_)) return true;
    File file = fs_.open(cursor_, "r");
    if (!file) return false;
    String text = file.readString();
    file.close();
    if (!text.length()) return false;
    unsigned long value = 0;
    for (size_t i = 0; i < text.length(); ++i) {
      const char c = text[i];
      if (c < '0' || c > '9' || value > (0xFFFFFFFFUL - (unsigned long)(c - '0')) / 10UL) return false;
      value = value * 10UL + (unsigned long)(c - '0');
    }
    out = (size_t)value;
    return true;
  }
  fs::FS &fs_;
  SemaphoreHandle_t mutex_;
  const char *path_ = "/queue.json";
  const char *cursor_ = "/queue.cursor";
  const char *temp_ = "/queue.cursor.tmp";
};
