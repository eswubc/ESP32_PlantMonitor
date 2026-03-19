#ifndef _AUDIOOUTPUT_H
#define _AUDIOOUTPUT_H
#include <Arduino.h>
#include "AudioStatus.h"

class AudioOutput {
public:
  AudioOutput() : hertz(0), channels(1), gainF2P6(64) {}
  virtual ~AudioOutput() {}
  virtual bool SetRate(int hz) { hertz = hz; return true; }
  virtual bool SetChannels(int chan) { channels = chan; return true; }
  virtual bool SetGain(float f) {
    if (f > 4.0f) f = 4.0f;
    if (f < 0.0f) f = 0.0f;
    gainF2P6 = (uint8_t)(f * (1 << 6));
    return true;
  }
  virtual bool begin() { return true; }
  typedef enum { LEFTCHANNEL = 0, RIGHTCHANNEL = 1 } SampleIndex;
  virtual bool ConsumeSample(int16_t sample[2]) { (void)sample; return false; }
  virtual uint16_t ConsumeSamples(int16_t *samples, uint16_t count) {
    for (uint16_t i = 0; i < count; i++) {
      if (!ConsumeSample(samples)) return i;
      samples += 2;
    }
    return count;
  }
  virtual bool stop() { return false; }
  virtual void flush() {}
  virtual bool loop() { return true; }
  virtual bool RegisterMetadataCB(AudioStatus::metadataCBFn fn, void *data) { return cb.RegisterMetadataCB(fn, data); }
  virtual bool RegisterStatusCB(AudioStatus::statusCBFn fn, void *data) { return cb.RegisterStatusCB(fn, data); }
protected:
  inline int16_t Amplify(int16_t s) {
    int32_t v = (s * gainF2P6) >> 6;
    if (v < -32767) return -32767;
    if (v > 32767) return 32767;
    return (int16_t)(v & 0xffff);
  }
  uint16_t hertz;
  uint8_t channels;
  uint8_t gainF2P6;
  AudioStatus cb;
};
#endif
