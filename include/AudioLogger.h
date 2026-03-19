#ifndef _AUDIOLOGGER_H
#define _AUDIOLOGGER_H
#include <Arduino.h>
class DevNullOut : public Print {
public:
  virtual size_t write(uint8_t) { return 1; }
};
extern DevNullOut silencedLogger;
extern Print* audioLogger;
#endif
