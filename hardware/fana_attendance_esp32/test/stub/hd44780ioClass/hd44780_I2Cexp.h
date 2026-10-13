// Host stub for hd44780ioClass/hd44780_I2Cexp.h of the real hd44780 library.
#ifndef HD44780_I2CEXP_H_STUB
#define HD44780_I2CEXP_H_STUB
#include <hd44780.h>

class hd44780_I2Cexp : public hd44780 {
public:
  // The real enum, same order (only Prop_addr is used by the sketch).
  enum I2CexpProp {
    Prop_addr, Prop_expType, Prop_rs, Prop_rw, Prop_en,
    Prop_d4, Prop_d5, Prop_d6, Prop_d7, Prop_bl, Prop_blLevel,
  };

  hd44780_I2Cexp() {}                    // auto-locate, like "hd44780_I2Cexp lcd;"
  hd44780_I2Cexp(uint8_t addr) { lcdAddress = addr; } // pinned address

  int getProp(I2CexpProp propID) { return propID == Prop_addr ? lcdAddress : -1; }
};

#endif
