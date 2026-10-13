// Host stub for the real "hd44780" library (Bill Perry) - just enough of it
// to type-check the sketch and to let the tests read the simulated glass.
//
// It mirrors the two behaviours that shape the sketch:
//   - print() writes at the cursor and WRAPS to the next row when the row is
//     full (the real library wraps unless lineWrap() is turned off), and
//   - println() does NOT exist (the real library makes it a compile error),
//     so a sketch that used it would not build here either.
#ifndef HD44780_H_STUB
#define HD44780_H_STUB
#include <Arduino.h>

#define HD44780_5x8DOTS  0
#define HD44780_5x10DOTS 1

// A simulated 20x4 character display - what startLcd() asks for. Rows longer
// than LCD_STUB_COLS are detected by the test, see lcdWrapHits.
#define LCD_STUB_COLS 20
#define LCD_STUB_ROWS 4

/* Everything below is defined once, in test/globals.cpp, and inspected by the
 * tests. */
extern char lcdGrid[LCD_STUB_ROWS][LCD_STUB_COLS + 1]; // the glass, row by row
extern int  lcdClearCalls;      // how often the screen was cleared (flicker)
extern int  lcdWrapHits;        // writes that ran past column 19
extern int  lcdWriteCalls;      // every character written (flicker check)
extern int  lcdShortRowWrites;  // a row write that stopped before column 19
extern int  lcdCursorRow;       // where the cursor is (for the tests)
extern bool lcdBacklightOn;     // did the sketch turn the backlight on?
extern int  lcdBeginStatus;     // 0 = backpack found, nonzero = not found
extern int  lcdAddress;         // the address the stub reports via getProp()

class hd44780 {
public:
  hd44780() : _col(0), _row(0) {}

  // The real one returns 0 on success and a negative rv code on failure.
  int begin(uint8_t cols, uint8_t rows, uint8_t dotsize = HD44780_5x8DOTS) {
    (void)dotsize;
    _cols = cols;
    _rows = rows;
    _col = 0;
    _row = 0;
    return lcdBeginStatus;
  }

  int clear() {
    lcdClearCalls++;
    for (int r = 0; r < LCD_STUB_ROWS; r++) {
      for (int c = 0; c < LCD_STUB_COLS; c++) lcdGrid[r][c] = ' ';
      lcdGrid[r][LCD_STUB_COLS] = '\0';
    }
    _col = 0;
    _row = 0;
    _rowChars = 0;
    lcdCursorRow = 0;
    return 0;
  }

  int setCursor(uint8_t col, uint8_t row) {
    // Starting a fresh row: did the previous row get all 20 characters? A
    // shorter write would leave leftovers from whatever was there before.
    if (col == 0 && _rowChars > 0 && _rowChars < LCD_STUB_COLS) lcdShortRowWrites++;
    if (col == 0) _rowChars = 0;
    _col = col;
    _row = row % LCD_STUB_ROWS;
    lcdCursorRow = _row;
    return 0;
  }

  int backlight() { lcdBacklightOn = true; return 0; }
  int noBacklight() { lcdBacklightOn = false; return 0; }
  int home() { _col = 0; _row = 0; return 0; }
  int status() const { return 0; }

  size_t write(uint8_t value) {
    // The real controller wraps to the start of the next row when the cursor
    // runs past the last column; a character written that way is an overflow.
    if (_col >= LCD_STUB_COLS) {
      lcdWrapHits++;
      _col = 0;
      _row = (_row + 1) % LCD_STUB_ROWS;
      _rowChars = 0;
    }
    lcdGrid[_row][_col] = (char)value;
    lcdWriteCalls++;
    _rowChars++;
    _col++;
    lcdCursorRow = _row;
    return 1;
  }

  size_t print(const String &s) {
    for (unsigned int i = 0; i < s.length(); i++) write((uint8_t)s[i]);
    if (screenHook) screenHook(s.c_str());   // the harness watches what is drawn
    return s.length();
  }
  size_t print(const char *s) { return print(String(s ? s : "")); }
  size_t print(int v, int base) { char b[24]; snprintf(b, sizeof(b), base == 16 ? "%X" : "%d", v); return print(String(b)); }

  // println() deliberately missing: the real library forbids it, so the host
  // test refuses it too.

private:
  uint8_t _col, _row;
  uint8_t _rowChars = 0;
  uint8_t _cols = LCD_STUB_COLS, _rows = LCD_STUB_ROWS;
};

#endif
