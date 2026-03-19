#ifndef _AUDIOSTATUS_H
#define _AUDIOSTATUS_H
#include <Arduino.h>
#include "AudioLogger.h"
class AudioStatus {
public:
  AudioStatus() { mdFn = NULL; stFn = NULL; }
  virtual ~AudioStatus() {}
  typedef void (*metadataCBFn)(void *cbData, const char *type, bool isUnicode, const char *str);
  bool RegisterMetadataCB(metadataCBFn f, void *cbData) { mdFn = f; mdData = cbData; return true; }
  typedef void (*statusCBFn)(void *cbData, int code, const char *string);
  bool RegisterStatusCB(statusCBFn f, void *cbData) { stFn = f; stData = cbData; return true; }
  inline void md(const char *type, bool isUnicode, const char *string) { if (mdFn) mdFn(mdData, type, isUnicode, string); }
  inline void st(int code, const char *string) { if (stFn) stFn(stData, code, string); }
private:
  metadataCBFn mdFn; void *mdData;
  statusCBFn stFn; void *stData;
};
#endif
