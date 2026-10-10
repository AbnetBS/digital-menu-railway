#ifndef SSD1306_H_STUB
#define SSD1306_H_STUB
#include <Adafruit_GFX.h>
class Adafruit_SSD1306 : public Adafruit_GFX {
public:
  Adafruit_SSD1306(int, int, TwoWire *, int) {}
  bool begin(int, int) { return true; }
};
#endif
