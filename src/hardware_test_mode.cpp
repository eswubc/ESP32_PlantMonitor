/**
 * Hardware Test Mode — validates BME280, soil, light, float switch, MAX98357, INMP441.
 * SAM text-to-speech: clap to hear sensor readings spoken aloud.
 *
 * Pinout — only GP 11, 12, 13 are free; soil/light/float use those:
 *
 *   BME280:    VCC→3.3V  GND→GND  SDA→8   SCL→9
 *   Soil:      VCC→3.3V  GND→GND  SIG→11  (analog, higher=drier)
 *   Light:     VCC→3.3V  GND→GND  OUT→12  (digital: LOW=bright, HIGH=dark)
 *   Float:     one wire→13  other→GND (closes to GND when triggered)
 *   INMP441:   VDD→3.3V  GND→GND  SD→5  SCK→6  WS→7  L/R→GND (left)
 *   MAX98357:  VIN→3.3V  GND→GND  DIN→1  BCLK→2  LRC→3  SD→3.3V
 *   LED:       onboard WS2812 on GPIO21
 *
 * (GP 1-10 assumed in use by speaker/mic/I2C/other)
 */
#ifdef HARDWARE_TEST_MODE

#include <Arduino.h>
#include <Wire.h>
#include <Adafruit_Sensor.h>
#include <Adafruit_BME280.h>
#include <Adafruit_NeoPixel.h>
#include <driver/i2s.h>
#include <cmath>
#include <ESP8266SAM.h>
#include <AudioOutput.h>

DevNullOut silencedLogger;
Print* audioLogger = &silencedLogger;

// =============================================================================
// Custom AudioOutput that bridges SAM to our legacy I2S driver on I2S_NUM_0
// =============================================================================
class AudioOutputLegacyI2S : public AudioOutput {
public:
  AudioOutputLegacyI2S(uint8_t bclk, uint8_t lrc, uint8_t dout)
    : _bclk(bclk), _lrc(lrc), _dout(dout), _installed(false) {}

  bool begin() override {
    if (_installed) {
      i2s_set_sample_rates(I2S_NUM_0, hertz ? hertz : 22050);
      return true;
    }
    i2s_config_t cfg = {};
    cfg.mode                 = (i2s_mode_t)(I2S_MODE_MASTER | I2S_MODE_TX);
    cfg.sample_rate          = hertz ? hertz : 22050;
    cfg.bits_per_sample      = I2S_BITS_PER_SAMPLE_16BIT;
    cfg.channel_format       = I2S_CHANNEL_FMT_RIGHT_LEFT;
    cfg.communication_format = I2S_COMM_FORMAT_STAND_I2S;
    cfg.intr_alloc_flags     = ESP_INTR_FLAG_LEVEL1;
    cfg.dma_buf_count        = 8;
    cfg.dma_buf_len          = 128;
    cfg.use_apll             = false;
    cfg.tx_desc_auto_clear   = true;

    if (i2s_driver_install(I2S_NUM_0, &cfg, 0, nullptr) != ESP_OK) return false;

    i2s_pin_config_t pin = {};
    pin.bck_io_num   = _bclk;
    pin.ws_io_num    = _lrc;
    pin.data_out_num = _dout;
    pin.data_in_num  = I2S_PIN_NO_CHANGE;
    pin.mck_io_num   = I2S_PIN_NO_CHANGE;
    i2s_set_pin(I2S_NUM_0, &pin);
    _installed = true;
    return true;
  }

  bool ConsumeSample(int16_t sample[2]) override {
    int16_t stereo[2];
    stereo[0] = Amplify(sample[AudioOutput::LEFTCHANNEL]);
    stereo[1] = Amplify(sample[AudioOutput::RIGHTCHANNEL]);
    size_t written = 0;
    i2s_write(I2S_NUM_0, stereo, sizeof(stereo), &written, pdMS_TO_TICKS(50));
    return written == sizeof(stereo);
  }

  bool SetRate(int hz) override {
    AudioOutput::SetRate(hz);
    if (_installed) i2s_set_sample_rates(I2S_NUM_0, hz);
    return true;
  }

  bool stop() override {
    return true;
  }

private:
  uint8_t _bclk, _lrc, _dout;
  bool _installed;
};

// =============================================================================
// Onboard WS2812 RGB LED (GPIO21)
// =============================================================================
static constexpr uint8_t LED_PIN   = 21;
static constexpr uint8_t LED_COUNT = 1;
static Adafruit_NeoPixel pixel(LED_COUNT, LED_PIN, NEO_GRB + NEO_KHZ800);
static unsigned long lastLedUpdate = 0;

static void setLedStatus(uint8_t r, uint8_t g, uint8_t b) {
  pixel.setPixelColor(0, pixel.Color(r, g, b));
  pixel.show();
}

static void updateLedHeartbeat() {
  unsigned long now = millis();
  if (now - lastLedUpdate < 500) return;
  lastLedUpdate = now;
  static bool bright = false;
  bright = !bright;
  setLedStatus(0, bright ? 80 : 10, 0);
}

// =============================================================================
// Pin definitions — Soil/Light/Float on free pins 11, 12, 13
// =============================================================================
static constexpr uint8_t I2C_SDA_PIN   = 8;
static constexpr uint8_t I2C_SCL_PIN   = 9;
static constexpr uint8_t SOIL_PIN      = 11;  // Analog (ADC2), higher = drier
static constexpr uint8_t LIGHT_PIN     = 12;  // Digital, LOW = bright
static constexpr uint8_t FLOAT_PIN     = 13;  // Digital, pullup
static constexpr uint8_t MIC_SD_PIN    = 5;
static constexpr uint8_t MIC_BCLK_PIN  = 6;
static constexpr uint8_t MIC_WS_PIN    = 7;
static constexpr uint8_t SPK_DIN_PIN   = 1;
static constexpr uint8_t SPK_BCLK_PIN  = 2;
static constexpr uint8_t SPK_LRC_PIN   = 3;

// =============================================================================
// Timing
// =============================================================================
static constexpr uint32_t BME_READ_INTERVAL_MS    = 2000;
static constexpr uint32_t FLOAT_DEBOUNCE_MS       = 50;
static constexpr uint32_t MIC_PRINT_INTERVAL_MS   = 1000;
static constexpr uint32_t DOUBLE_CLAP_WINDOW_MS   = 800;
static constexpr uint32_t CLAP_INTER_COOLDOWN_MS  = 300;
static constexpr int32_t  MIC_CLAP_THRESHOLD      = 30000;

// =============================================================================
// BME280
// =============================================================================
static Adafruit_BME280 bme;
static bool bmeOk = false;
static unsigned long lastBmeRead = 0;

static void initBme() {
  Wire.begin(I2C_SDA_PIN, I2C_SCL_PIN);
  Wire.setClock(100000);
  delay(200);
  for (uint8_t addr : {0x76, 0x77}) {
    if (bme.begin(addr, &Wire)) {
      bmeOk = true;
      Serial.printf("[BME280] Detected at 0x%02X\n", addr);
      return;
    }
  }
  Serial.println("[BME280] Not detected (check I2C wiring)");
}

static void pollBme() {
  if (!bmeOk) return;
  unsigned long now = millis();
  if (now - lastBmeRead < BME_READ_INTERVAL_MS) return;
  lastBmeRead = now;
  float t = bme.readTemperature();
  float p = bme.readPressure();
  float h = bme.readHumidity();
  Serial.printf("[BME280] temp=%.1fC pressure=%.0fPa humidity=%.1f%%\n", t, p, h);
}

// =============================================================================
// Soil moisture (analog) + Light (digital)
// =============================================================================
static uint16_t soilRaw = 0;
static bool lightBright = false;
static unsigned long lastSoilLightRead = 0;

static void initSoilLight() {
  pinMode(LIGHT_PIN, INPUT);
  analogReadResolution(12);  // 0-4095 on ESP32-S3
}

static void pollSoilLight() {
  unsigned long now = millis();
  if (now - lastSoilLightRead < BME_READ_INTERVAL_MS) return;
  lastSoilLightRead = now;
  soilRaw = analogRead(SOIL_PIN);
  lightBright = (digitalRead(LIGHT_PIN) == LOW);
  Serial.printf("[Soil] raw=%u (%s) [Light] %s\n",
    (unsigned)soilRaw, soilRaw > 2500 ? "dry" : (soilRaw < 1500 ? "wet" : "ok"),
    lightBright ? "bright" : "dark");
}

// =============================================================================
// Float switch
// =============================================================================
static int lastFloatState = -1;
static unsigned long lastFloatChange = 0;

static void initFloat() {
  pinMode(FLOAT_PIN, INPUT_PULLUP);
}

static void pollFloat() {
  int s = digitalRead(FLOAT_PIN);
  unsigned long now = millis();
  if (lastFloatState >= 0 && s != lastFloatState) {
    if (now - lastFloatChange < FLOAT_DEBOUNCE_MS) return;
    lastFloatChange = now;
  }
  if (s != lastFloatState) {
    lastFloatState = s;
    lastFloatChange = now;
    Serial.println(s == HIGH ? "[Float] OPEN" : "[Float] CLOSED");
  }
}

// =============================================================================
// SAM TTS + MAX98357 speaker
// =============================================================================
static AudioOutputLegacyI2S *audioOut = nullptr;
static ESP8266SAM *sam = nullptr;
static bool isSpeaking = false;

static void initSpeaker() {
  Serial.println("[Speaker] Init legacy I2S + SAM...");
  audioOut = new AudioOutputLegacyI2S(SPK_BCLK_PIN, SPK_LRC_PIN, SPK_DIN_PIN);
  audioOut->SetGain(1.5);
  audioOut->begin();

  sam = new ESP8266SAM;
  Serial.println("[Speaker] SAM TTS ready");
}

static void speak(const char* text) {
  isSpeaking = true;
  setLedStatus(0, 0, 120);
  Serial.printf("[SAM] \"%s\"\n", text);
  sam->Say(audioOut, text);
  setLedStatus(0, 50, 0);
  isSpeaking = false;
}

// =============================================================================
// Clap response handlers
// =============================================================================
static void onSingleClap() {
  char buf[128];
  if (bmeOk) {
    int t = (int)roundf(bme.readTemperature());
    int h = (int)roundf(bme.readHumidity());
    snprintf(buf, sizeof(buf), "%d degrees, %d percent humidity.", t, h);
  } else {
    snprintf(buf, sizeof(buf), "Sensor not found.");
  }
  speak(buf);
}

static void onDoubleClap() {
  char buf[320];
  if (bmeOk) {
    int t = (int)roundf(bme.readTemperature());
    int h = (int)roundf(bme.readHumidity());
    int p = (int)roundf(bme.readPressure() / 100.0f);
    const char* water = (lastFloatState == LOW) ? "Water level low." : "Water level normal.";
    const char* soilStr = soilRaw > 2500 ? "Soil dry." : (soilRaw < 1500 ? "Soil wet." : "Soil okay.");
    const char* lightStr = lightBright ? "Light bright." : "Light dark.";
    snprintf(buf, sizeof(buf),
      "Temperature %d degrees. Humidity %d percent. Pressure %d hectopascals. %s %s %s",
      t, h, p, soilStr, lightStr, water);
  } else {
    snprintf(buf, sizeof(buf), "Sensor error. Check wiring.");
  }
  speak(buf);
}

// =============================================================================
// INMP441 microphone (I2S_NUM_1 RX) + clap detection
// =============================================================================
static constexpr uint32_t MIC_SAMPLE_RATE = 16000;
static constexpr size_t MIC_BUF_SAMPLES  = 256;
static unsigned long lastMicPrint = 0;
static bool micClapCooldown = false;
static unsigned long micClapCooldownUntil = 0;

static int clapCount = 0;
static unsigned long firstClapTime = 0;

static void initMic() {
  Serial.println("[Mic] Init...");
  i2s_config_t cfg = {};
  cfg.mode                 = (i2s_mode_t)(I2S_MODE_MASTER | I2S_MODE_RX);
  cfg.sample_rate          = MIC_SAMPLE_RATE;
  cfg.bits_per_sample      = I2S_BITS_PER_SAMPLE_32BIT;
  cfg.channel_format       = I2S_CHANNEL_FMT_ONLY_LEFT;
  cfg.communication_format = I2S_COMM_FORMAT_STAND_MSB;
  cfg.intr_alloc_flags     = ESP_INTR_FLAG_LEVEL1;
  cfg.dma_buf_count        = 4;
  cfg.dma_buf_len          = 256;
  cfg.use_apll             = false;

  esp_err_t err = i2s_driver_install(I2S_NUM_1, &cfg, 0, nullptr);
  if (err != ESP_OK) {
    Serial.printf("[Mic] i2s_driver_install failed: %d\n", err);
    return;
  }
  i2s_pin_config_t pin = {};
  pin.bck_io_num   = MIC_BCLK_PIN;
  pin.ws_io_num    = MIC_WS_PIN;
  pin.data_out_num = I2S_PIN_NO_CHANGE;
  pin.data_in_num  = MIC_SD_PIN;
  pin.mck_io_num   = I2S_PIN_NO_CHANGE;
  i2s_set_pin(I2S_NUM_1, &pin);
  Serial.println("[Mic] Ready");
}

static void pollMic() {
  if (isSpeaking) return;

  int32_t buffer[MIC_BUF_SAMPLES];
  size_t bytesRead = 0;
  esp_err_t err = i2s_read(I2S_NUM_1, buffer, sizeof(buffer), &bytesRead, 0);
  if (err != ESP_OK || bytesRead == 0) return;

  int64_t sumSq = 0;
  int ns = bytesRead / sizeof(int32_t);
  for (int i = 0; i < ns; i++) {
    int32_t s = buffer[i] >> 14;
    sumSq += (int64_t)s * s;
  }
  int32_t rms = (ns > 0) ? (int32_t)sqrt((double)sumSq / ns) : 0;

  unsigned long now = millis();
  if (now - lastMicPrint >= MIC_PRINT_INTERVAL_MS) {
    lastMicPrint = now;
    Serial.printf("[Mic] level=%ld\n", (long)rms);
  }

  if (rms > MIC_CLAP_THRESHOLD) {
    if (!micClapCooldown || now > micClapCooldownUntil) {
      clapCount++;
      Serial.printf("[Mic] CLAP #%d (level=%ld)\n", clapCount, (long)rms);
      if (clapCount == 1) firstClapTime = now;
      micClapCooldown = true;
      micClapCooldownUntil = now + CLAP_INTER_COOLDOWN_MS;
    }
  }
  if (now > micClapCooldownUntil) micClapCooldown = false;
}

// =============================================================================
// Public API
// =============================================================================
void hardwareTestSetup() {
  pixel.begin();
  pixel.setBrightness(100);
  setLedStatus(0, 50, 0);

  Serial.println("=== HARDWARE TEST MODE (SAM TTS + sensors) ===");
  Serial.printf("Pinout: BME280 SDA=%d SCL=%d | Soil=%d(ADC) Light=%d | Float=%d | Mic SD=%d BCLK=%d WS=%d | Spk DIN=%d BCLK=%d LRC=%d\n",
    (int)I2C_SDA_PIN, (int)I2C_SCL_PIN, (int)SOIL_PIN, (int)LIGHT_PIN, (int)FLOAT_PIN,
    (int)MIC_SD_PIN, (int)MIC_BCLK_PIN, (int)MIC_WS_PIN,
    (int)SPK_DIN_PIN, (int)SPK_BCLK_PIN, (int)SPK_LRC_PIN);

  initBme();
  initSoilLight();
  initFloat();
  initSpeaker();
  initMic();

  Serial.println("[Boot] Speaking greeting...");
  speak("Plant monitor ready.");
  Serial.println("[Boot] Done. Single clap for quick status, double clap for full report.");
}

void hardwareTestLoop() {
  pollBme();
  pollSoilLight();
  pollFloat();
  pollMic();

  if (clapCount > 0 && !isSpeaking) {
    unsigned long elapsed = millis() - firstClapTime;
    if (elapsed > DOUBLE_CLAP_WINDOW_MS) {
      if (clapCount >= 2) {
        Serial.println("[Action] Double clap -> full report");
        onDoubleClap();
      } else {
        Serial.println("[Action] Single clap -> quick status");
        onSingleClap();
      }
      clapCount = 0;
      micClapCooldown = true;
      micClapCooldownUntil = millis() + 3000;
    }
  }

  updateLedHeartbeat();
  delay(10);
}

#endif  // HARDWARE_TEST_MODE
