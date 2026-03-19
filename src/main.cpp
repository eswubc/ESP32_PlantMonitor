/**
 * Smart Plant Pro – Firebase RTDB Node
 * ESP32 plant monitor with auto-detected BME280/BMP280, soil sensor, LDR and
 * relay-controlled water pump. Three FreeRTOS tasks:
 *  - taskReadSensors  (Core 0, 2 s): update shared SensorState.
 *  - taskFirebaseSync (Core 1, 5 s): push SensorState + health to RTDB.
 *  - taskPumpControl  (Core 1): listen for pumpRequest and run pulse watering.
 */

#include <Arduino.h>
#include <WiFi.h>
#include <esp_wifi.h>
#include <Wire.h>
#include <WiFiManager.h>
#include <ArduinoOTA.h>
#include <Preferences.h>
#include <Adafruit_Sensor.h>
#include <Adafruit_BMP280.h>
#include <Adafruit_BME280.h>
#include <Adafruit_VEML7700.h>
#include <Firebase_ESP_Client.h>

// -----------------------------------------------------------------------------
// Hardware configuration — ESP32-S3 Zero (Waveshare) pinout
// -----------------------------------------------------------------------------
static constexpr uint8_t I2C_SDA_PIN      = 8;   // I2C data (shared: BME280 + VEML7700)
static constexpr uint8_t I2C_SCL_PIN      = 9;   // I2C clock (shared: BME280 + VEML7700)
// BME280/BMP280 address detected at runtime (0x76 or 0x77)
static constexpr uint8_t SOIL_SENSOR_PIN  = 11;  // ADC2
static constexpr uint8_t TANK_SENSOR_PIN  = 12;  // Float switch, INPUT_PULLUP, LOW = tank empty
static constexpr uint8_t RELAY_PIN        = 10;  // MOSFET gate: active-HIGH, HIGH = pump ON

// -----------------------------------------------------------------------------
// WiFi: from WiFiManager (first boot = AP "SmartPlantPro", then from flash).
// Firebase: from portal (NVS) if user filled the form at 192.168.4.1, else these defaults.
// Defaults come from firebase_defaults.h (empty) or optional secrets.h (gitignored).
// -----------------------------------------------------------------------------
#include "firebase_defaults.h"

#define API_KEY FIREBASE_API_KEY
#define DB_URL  FIREBASE_DB_URL

// -----------------------------------------------------------------------------
// Timing and defaults
// -----------------------------------------------------------------------------
static constexpr uint32_t SENSOR_READ_INTERVAL_MS   = 2000;   // 2 s
static constexpr uint32_t FIREBASE_SYNC_INTERVAL_MS = 3000;   // 3 s — faster screen updates
static constexpr uint32_t RESET_POLL_MS            = 1000;   // Check reset flag every 1 s for instant response
static constexpr TickType_t PUMP_PULSE_MS  = pdMS_TO_TICKS(1000);
static constexpr TickType_t PUMP_SOAK_MS   = pdMS_TO_TICKS(5000);
static constexpr TickType_t PUMP_IDLE_MS   = pdMS_TO_TICKS(500);

// -----------------------------------------------------------------------------
// WiFiManager (global so we can call resetSettings() when app requests re-provision)
// -----------------------------------------------------------------------------
WiFiManager wm;

// Firebase config from NVS (portal) or compile-time defaults; buffers must outlive setup()
static char nvs_fb_api_key[80];
static char nvs_fb_db_url[130];
static char nvs_fb_email[72];
static char nvs_fb_password[72];

static const char* NVS_NAMESPACE = "fb";
static const char* PREF_API = "apik";
static const char* PREF_URL = "url";
static const char* PREF_EM = "em";
static const char* PREF_PW = "pw";

// -----------------------------------------------------------------------------
// Firebase globals
// -----------------------------------------------------------------------------
FirebaseData fbClient;
FirebaseAuth fbAuth;
FirebaseConfig fbConfig;

String deviceId;  // WiFi.macAddress()

// -----------------------------------------------------------------------------
// Sensor state shared between tasks
// -----------------------------------------------------------------------------
struct SensorState {
  float    temperatureC;
  float    pressurePa;
  float    humidity;       // NAN when sensor is BMP280
  uint16_t soilRaw;
  float    lux;            // VEML7700 ambient light in lx (NAN if read fails)
  bool     tankEmpty;      // true = float switch LOW = tank needs refill
  bool     pumpRunning;
};

SensorState gState{};
SemaphoreHandle_t gStateMutex;
SemaphoreHandle_t gFirebaseMutex;
volatile bool gPumpRequest = false;
volatile int gPumpReason = 0;  // 0=manual, 1=schedule
volatile bool gSensorReady = false;

// -----------------------------------------------------------------------------
// Sensor detection and objects
// -----------------------------------------------------------------------------
enum SensorType { SENSOR_NONE, SENSOR_BMP280, SENSOR_BME280 };

SensorType gSensorType = SENSOR_NONE;
uint8_t    gSensorAddr = 0;
uint8_t    gChipId     = 0;

Adafruit_BMP280 bmp;
Adafruit_BME280 bme;
static Adafruit_VEML7700 veml;

// -----------------------------------------------------------------------------
// Forward declarations
// -----------------------------------------------------------------------------
void initializeHardware();
void printSensorDiagnostic();
void taskReadSensors(void *pv);
void taskFirebaseSync(void *pv);
void taskPumpControl(void *pv);
void updateRelay(bool on);
String readingsPath();
String healthStatus(const SensorState &s);
uint16_t fetchTargetSoil();
bool fetchResetProvisioning();
void taskScheduleCheck();
bool fetchPumpRequest();
void clearFirebaseNVS();
void loadFirebaseFromNVSAndApply();

// -----------------------------------------------------------------------------
// Block guest/captive-portal WiFi — these block NTP, Firebase, and break the device
// -----------------------------------------------------------------------------
static const char* const BLOCKED_SSIDS[] = {
  "ubcvisitor", "ubc visitor", "ubc-guest", "ubc secure", "ubcsecure",  // UBC captive
  "xfinitywifi", "xfinity",
  "attwifi", "att-wifi",
  "starbucks", "starbucks_guest", "starbucks-guest",
  "airport", "boingo", "gogoinflight",
  "wayport", "wifire", "tmobile", "t-mobile",
  "coxwifi", "comcast", "centurylink",
  nullptr
};

static bool isBlockedSSID(const char* ssid) {
  if (!ssid || strlen(ssid) == 0) return false;
  String s(ssid);
  s.toLowerCase();
  s.trim();
  for (int i = 0; BLOCKED_SSIDS[i] != nullptr; i++) {
    String b(BLOCKED_SSIDS[i]);
    b.toLowerCase();
    if (s.indexOf(b) >= 0) return true;  // SSID contains blocked pattern
  }
  return false;
}

static void clearBadWiFiAndRestart(const char* reason) {
  Serial.println(reason);
  Serial.println("Clearing WiFi config and restarting into setup mode...");
  WiFi.disconnect(true, true);
  if (WiFi.eraseAP()) {
    Serial.println("[WiFi] Stored credentials erased.");
  } else {
    wm.resetSettings();
  }
  delay(2000);
  ESP.restart();
}

// -----------------------------------------------------------------------------
// Setup
// -----------------------------------------------------------------------------
void setup() {
  Serial.begin(115200);
  delay(500);

  // Safety: pump OFF first (active-HIGH MOSFET: LOW = pump OFF)
  pinMode(RELAY_PIN, OUTPUT);
  digitalWrite(RELAY_PIN, LOW);

  Serial.println("\n========================================");
  Serial.println("Smart Plant Pro – Firebase RTDB (v2 WiFi-block)");
  Serial.println("========================================\n");

  initializeHardware();

  // WiFi + optional Firebase via WiFiManager portal (192.168.4.1)
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);

  // Device MAC for AP SSID and portal — available from boot
  String apMac = WiFi.macAddress();
  String macSuffix = apMac;
  macSuffix.replace(":", "");
  macSuffix = macSuffix.substring(6);  // Last 6 hex chars (e.g. BD36CC)
  String apSsid = "SmartPlantPro_" + macSuffix;
  Serial.printf("[AP] When in setup mode: SSID=%s  MAC=%s\n", apSsid.c_str(), apMac.c_str());

  // ── Portal branding: Smart Plant Pro theme (includes device MAC) ──
  String customHead = String(
    "<style>"
    // Background & typography
    "body{background:#f4f9f0 !important;font-family:'Segoe UI',system-ui,-apple-system,sans-serif !important;color:#1b3a2d}"
    ".wrap{max-width:420px;margin:0 auto;padding:18px}"
    // Title / header
    "h1{color:#1b3a2d;font-size:1.5rem;font-weight:700;letter-spacing:-.02em}"
    "h3{color:#1b3a2d;opacity:.6;font-size:.85rem;font-weight:400;margin-top:-8px}"
    // Buttons
    "button,input[type='button'],input[type='submit']{"
      "background:#3da56b !important;border-radius:12px !important;"
      "font-weight:600;font-size:1rem;line-height:2.8rem;"
      "box-shadow:0 2px 8px rgba(61,165,107,.25);transition:all .2s}"
    "button:hover,input[type='submit']:hover{background:#2e8a56 !important;box-shadow:0 4px 14px rgba(61,165,107,.35)}"
    "button.D{background:#d94f4f !important}"
    "button.D:hover{background:#c03535 !important}"
    // Inputs
    "input:not([type]),input[type='text'],input[type='password'],select{"
      "border:1.5px solid #c8ddc0 !important;border-radius:10px !important;"
      "padding:10px 12px !important;font-size:.95rem !important;"
      "background:#fff !important;transition:border .2s}"
    "input:focus,select:focus{border-color:#3da56b !important;outline:none !important;"
      "box-shadow:0 0 0 3px rgba(61,165,107,.15) !important}"
    // WiFi list
    "#wifi_list a,.q{color:#1b3a2d}"
    "a{color:#3da56b !important;font-weight:600}"
    "a:hover{color:#2e8a56 !important}"
    // Callout messages
    ".msg{border-radius:10px;border-left-width:4px;background:#fff;border-color:#c8ddc0}"
    ".msg.S{border-left-color:#3da56b}.msg.S h4{color:#3da56b}"
    ".msg.D{border-left-color:#d94f4f}.msg.D h4{color:#d94f4f}"
    ".msg.P{border-left-color:#3da56b}.msg.P h4{color:#3da56b}"
    // Param section labels
    "label{display:block;font-weight:600;font-size:.85rem;color:#1b3a2d;margin:12px 0 4px;opacity:.8}"
    // Footer area
    ".c{color:#1b3a2d;opacity:.5;font-size:.75rem}"
    // Spinner for connecting overlay
    "@keyframes sp{to{transform:rotate(360deg)}}"
    ".spp-spin{width:28px;height:28px;border:3px solid #c8ddc0;border-top-color:#3da56b;"
    "border-radius:50%;animation:sp .7s linear infinite;margin:14px auto 0}"
    "#spp-overlay{position:fixed;top:0;left:0;right:0;bottom:0;background:#f4f9f0;"
    "display:flex;align-items:center;justify-content:center;z-index:9999}"
    "</style>"
    // JS: hide blocked guest/captive networks from WiFi list; show connecting overlay on submit
    "<script>"
    "document.addEventListener('DOMContentLoaded',function(){"
      "var b=['ubcvisitor','ubc-guest','xfinitywifi','attwifi','starbucks','airport','boingo','coxwifi','comcast','wayport','gogoinflight'];"
      "var list=document.getElementById('wifi_list')||document.querySelector('.q')||document.body;"
      "var links=list.querySelectorAll ? list.querySelectorAll('a, li, div[class]') : [];"
      "for(var i=0;i<links.length;i++){"
        "var t=(links[i].textContent||links[i].innerText||'').toLowerCase().split(/[\\s(]/)[0]||'';"
        "for(var j=0;j<b.length;j++){ if(t.indexOf(b[j])>=0){links[i].style.display='none';break;} }"
      "}"
      "var f=document.querySelector('form[action=\"/wifisave\"]');"
      "if(f)f.addEventListener('submit',function(){"
        "var o=document.createElement('div');"
        "o.id='spp-overlay';"
        "o.innerHTML='"
          "<div style=\"text-align:center\">"
            "<div style=\"font-size:2rem\">&#127793;</div>"
            "<p style=\"font-weight:700;font-size:1.1rem;margin:10px 0 4px;color:#1b3a2d\">"
              "Connecting to WiFi…</p>"
            "<p style=\"font-size:.85rem;color:#1b3a2d;opacity:.6\">"
              "Checking credentials, please wait…</p>"
            "<div class=\"spp-spin\"></div>"
          "</div>';"
        "document.body.appendChild(o);"
      "})"
    "});"
    "</script>"
    // Brand bar
    "<div style='background:#3da56b;color:#fff;padding:14px 20px;border-radius:0 0 16px 16px;"
    "margin:-10px -10px 18px;text-align:center;box-shadow:0 2px 12px rgba(61,165,107,.3)'>"
    "<div style='font-size:1.5rem'>&#127793;</div>"
    "<div style='font-weight:700;font-size:1.1rem;letter-spacing:.02em'>Smart Plant Pro</div>"
    "<div style='font-size:.78rem;opacity:.85;margin-top:2px'>WiFi &amp; Device Setup</div>"
  );
  customHead += "<div style='font-size:.7rem;opacity:.75;margin-top:6px;font-family:monospace;letter-spacing:.05em'>Device: ";
  customHead += apMac;
  customHead += "</div></div>";
  wm.setCustomHeadElement(customHead.c_str());

  // Firebase parameters — hidden behind a 4-digit PIN so normal users only see WiFi fields.
  // The PIN gate is pure HTML/JS injected as a custom WiFiManager parameter.
  WiFiManagerParameter p_fb_gate(
    "<hr style='border:0;border-top:1.5px solid #c8ddc0;margin:18px 0'>"
    "<div id='fb-gate' style='text-align:center;padding:8px 0'>"
      "<p style='font-size:.8rem;color:#1b3a2d;opacity:.5;margin:0 0 6px'>Advanced settings</p>"
      "<div style='display:flex;gap:6px;justify-content:center;align-items:center'>"
        "<input id='fb-pin' type='password' maxlength='4' placeholder='PIN'"
        " style='width:80px;text-align:center;border:1.5px solid #c8ddc0;border-radius:10px;"
        "padding:8px;font-size:1rem;background:#fff;letter-spacing:4px'"
        " autocomplete='off'>"
        "<button type='button' onclick=\""
          "if(document.getElementById('fb-pin').value==='1234'){"
            "document.getElementById('fb-gate').style.display='none';"
            "document.getElementById('fb-fields').style.display='block';"
          "}else{"
            "document.getElementById('fb-pin').style.borderColor='#d94f4f';"
            "document.getElementById('fb-pin').value='';"
          "}\""
        " style='background:#3da56b !important;color:#fff;border:none;border-radius:10px;"
        "padding:8px 14px;font-size:.85rem;font-weight:600;cursor:pointer'>Unlock</button>"
      "</div>"
    "</div>"
    "<div id='fb-fields' style='display:none'>"
      "<p style='font-weight:700;font-size:.9rem;color:#1b3a2d;margin-bottom:2px'>"
        "&#128274; Firebase config</p>"
      "<p style='font-size:.78rem;color:#1b3a2d;opacity:.55;margin:0 0 8px'>"
        "Leave empty to use built-in defaults.</p>"
  );
  WiFiManagerParameter p_fb_api("fb_apikey", "Firebase API Key", API_KEY, 79);
  WiFiManagerParameter p_fb_url("fb_dburl", "Firebase DB URL", DB_URL, 129);
  WiFiManagerParameter p_fb_email("fb_email", "Firebase user email", FIREBASE_USER_EMAIL, 71);
  WiFiManagerParameter p_fb_pw("fb_password", "Firebase user password", FIREBASE_USER_PASSWORD, 71);
  WiFiManagerParameter p_fb_close("</div>");
  wm.addParameter(&p_fb_gate);
  wm.addParameter(&p_fb_api);
  wm.addParameter(&p_fb_url);
  wm.addParameter(&p_fb_email);
  wm.addParameter(&p_fb_pw);
  wm.addParameter(&p_fb_close);

  wm.setAPStaticIPConfig(IPAddress(192,168,4,1), IPAddress(192,168,4,1), IPAddress(255,255,255,0));
  wm.setWiFiAPChannel(1);
  wm.setConnectRetries(1);
  wm.setConnectTimeout(5);
  wm.setSaveConnectTimeout(6);  // Faster redirect after WiFi save
  wm.setConfigPortalTimeout(0);
  wm.setCaptivePortalEnable(true);
  wm.setMinimumSignalQuality(10);  // Accept weaker signals during scan for faster UI

  // Captive portal: redirect to /start (landing) for fast response, then user chooses Configure.
  String landingHtml = String(
    "<!DOCTYPE html><html><head><meta charset=utf-8><meta name=viewport content=\"width=device-width\">"
    "<title>Smart Plant Pro</title><style>"
    "body{margin:0;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;"
    "font-family:system-ui,sans-serif;background:linear-gradient(180deg,#f4f9f0 0%,#e8f5e3 100%);}"
    ".card{background:#fff;border-radius:20px;padding:32px;box-shadow:0 4px 20px rgba(0,0,0,.08);text-align:center;max-width:320px;}"
    "h1{font-size:1.5rem;color:#1b3a2d;margin:0 0 8px;} .sub{color:#5a7a6a;font-size:.9rem;margin-bottom:8px;}"
    ".mac{font-size:.75rem;font-family:monospace;color:#5a7a6a;margin-bottom:20px;}"
    "a{display:block;background:#3da56b;color:#fff!important;text-decoration:none;padding:14px 24px;border-radius:12px;"
    "font-weight:600;margin:8px 0;transition:background .2s;} a:hover{background:#2e8a56;}"
    "a.second{background:#e8f5e3;color:#2e6b4a!important;} a.second:hover{background:#d4edd8;}"
    "</style></head><body><div class=card>"
    "<div style=font-size:2.5rem>🌱</div><h1>Smart Plant Pro</h1><p class=sub>Device setup</p>"
    "<p class=mac>Device: ") + apMac + "</p>"
    "<a href=/wifi>Configure WiFi</a>"
    "<a href=/info class=second>Device info</a>"
    "<a href=/restart class=second>Reset &amp; reconnect</a>"
    "</div></body></html>";

  wm.setWebServerCallback([landingHtml]() {
    // Redirect connectivity checks → /start (small page, loads fast)
    auto redirectStart = []() {
      wm.server->sendHeader("Location", "http://192.168.4.1/start");
      wm.server->send(302, "text/plain", "");
    };
    wm.server->on("/start", HTTP_GET, [landingHtml]() {
      wm.server->sendHeader("Cache-Control", "no-cache");
      wm.server->send(200, "text/html", landingHtml.c_str());
    });
    wm.server->on("/generate_204", HTTP_GET, redirectStart);
    wm.server->on("/gen_204", HTTP_GET, redirectStart);
    wm.server->on("/connectivitycheck", HTTP_GET, redirectStart);
    wm.server->on("/hotspot-detect.html", HTTP_GET, redirectStart);
    wm.server->on("/hotspot-detect.html", HTTP_HEAD, redirectStart);
    wm.server->on("/library/test/success.html", HTTP_GET, redirectStart);
    wm.server->on("/ncsi.txt", HTTP_GET, redirectStart);
    wm.server->on("/connecttest.txt", HTTP_GET, redirectStart);
    wm.server->on("/redirect", HTTP_GET, redirectStart);
    wm.server->on("/success.txt", HTTP_GET, redirectStart);
    wm.server->on("/canonical.html", HTTP_GET, redirectStart);
    wm.server->on("/success", HTTP_GET, redirectStart);
    wm.server->on("/fwlink", HTTP_GET, redirectStart);
    wm.server->onNotFound(redirectStart);
  });

  // Clear any stale force_portal flag from previous firmware
  {
    Preferences p;
    if (p.begin(NVS_NAMESPACE, false)) { p.remove("force_portal"); p.end(); }
  }

  if (!wm.autoConnect(apSsid.c_str())) {
    Serial.println("WiFiManager failed to connect, restarting...");
    delay(3000);
    ESP.restart();
  }

  // Block guest/captive-portal WiFi — run immediately after connect
  {
    String ssidStr = WiFi.SSID();
    if (ssidStr.length() > 0) {
      ssidStr.trim();
      Serial.printf("[WiFi] Connected to: \"%s\"\n", ssidStr.c_str());
      if (isBlockedSSID(ssidStr.c_str())) {
        clearBadWiFiAndRestart("ERROR: Guest/captive network not supported. Use home/office WiFi.");
      }
    }
  }

  // Save Firebase fields from portal to NVS if user filled them (works for both autoConnect and startConfigPortal)
  const char* api = p_fb_api.getValue();
  const char* url = p_fb_url.getValue();
  const char* em = p_fb_email.getValue();
  const char* pw = p_fb_pw.getValue();
  if (api && url && em && pw && strlen(api) > 0 && strlen(url) > 0) {
    Preferences prefs;
    if (prefs.begin(NVS_NAMESPACE, false)) {
      prefs.putString(PREF_API, api);
      prefs.putString(PREF_URL, url);
      prefs.putString(PREF_EM, em);
      prefs.putString(PREF_PW, pw);
      prefs.end();
      Serial.println("Firebase config saved to NVS from portal.");
    }
  }

  Serial.print("WiFi connected, IP: ");
  Serial.println(WiFi.localIP());

  // Sync real-time clock via NTP so timestamps are Unix epoch, not uptime
  configTime(0, 0, "pool.ntp.org", "time.nist.gov");
  Serial.print("Waiting for NTP");
  time_t now = time(nullptr);
  int ntpRetries = 0;
  const int NTP_MAX_RETRIES = 50;  // ~10 sec — hotspots need more time to route traffic
  while (now < 1000000000L && ntpRetries < NTP_MAX_RETRIES) {
    delay(200);
    now = time(nullptr);
    ntpRetries++;
    Serial.print('.');
  }
  Serial.println();
  if (now >= 1000000000L) {
    Serial.printf("NTP synced: %ld\n", (long)now);
  } else {
    Serial.println("NTP failed — clearing WiFi and restarting.");
    clearBadWiFiAndRestart("ERROR: This network blocks internet access. Use a standard home/office WiFi.");
  }

  deviceId = WiFi.macAddress(); // e.g. "24:6F:28:AA:BB:CC"
  Serial.print("Device ID (MAC): ");
  Serial.println(deviceId);

  // OTA: upload firmware over WiFi (e.g. PlatformIO: upload_port = <device-IP>, upload_protocol = espota)
  ArduinoOTA.setHostname("SmartPlantPro");
  ArduinoOTA.begin();
  Serial.println("ArduinoOTA ready.");

  // Firebase init: use NVS if present, else compile-time defaults
  loadFirebaseFromNVSAndApply();
  Firebase.begin(&fbConfig, &fbAuth);
  Firebase.reconnectWiFi(true);

  // Wait for Firebase auth/token so the initial stream connection succeeds.
  Serial.print("Waiting for Firebase auth");
  unsigned long fbStart = millis();
  while (!Firebase.ready() && (millis() - fbStart) < 10000) {
    Serial.print('.');
    delay(200);
  }
  Serial.println();
  if (!Firebase.ready()) {
    Serial.println("Firebase not ready after 10s. Will keep retrying in background.");
    Serial.printf("  API key: %s\n", strlen(nvs_fb_api_key) > 0 ? "(set)" : "(EMPTY)");
    Serial.printf("  DB URL:  %s\n", strlen(nvs_fb_db_url) > 0 ? "(set)" : "(EMPTY)");
    Serial.printf("  Email:   %s\n", strlen(nvs_fb_email) > 0 ? "(set)" : "(EMPTY)");
  } else {
    Serial.println("Firebase is ready.");
  }

  // Shared state mutex
  gStateMutex = xSemaphoreCreateMutex();
  gFirebaseMutex = xSemaphoreCreateMutex();

  Serial.println("Firebase polling mode (no stream).");

  // Create tasks
  // Run networking/Firebase work on Core 1 so the Core 0 idle task
  // can still run and avoid watchdog resets even if SSL blocks.
  xTaskCreatePinnedToCore(taskReadSensors,  "taskReadSensors",  4096, nullptr, 1, nullptr, 0);
  xTaskCreatePinnedToCore(taskFirebaseSync, "taskFirebaseSync", 8192, nullptr, 1, nullptr, 1);
  xTaskCreatePinnedToCore(taskPumpControl,  "taskPumpControl",  4096, nullptr, 1, nullptr, 1);
}

void loop() {
  ArduinoOTA.handle();
  vTaskDelay(pdMS_TO_TICKS(100));
}

// -----------------------------------------------------------------------------
// Firebase NVS: load and apply to fbConfig/fbAuth; clear on re-provision
// -----------------------------------------------------------------------------
void loadFirebaseFromNVSAndApply() {
  Preferences prefs;
  bool haveNvs = false;
  if (prefs.begin(NVS_NAMESPACE, true)) {
    String apik = prefs.getString(PREF_API, "");
    String url = prefs.getString(PREF_URL, "");
    String em = prefs.getString(PREF_EM, "");
    String pw = prefs.getString(PREF_PW, "");
    prefs.end();
    if (apik.length() > 0 && url.length() > 0) {
      apik.toCharArray(nvs_fb_api_key, sizeof(nvs_fb_api_key));
      url.toCharArray(nvs_fb_db_url, sizeof(nvs_fb_db_url));
      em.toCharArray(nvs_fb_email, sizeof(nvs_fb_email));
      pw.toCharArray(nvs_fb_password, sizeof(nvs_fb_password));
      fbConfig.api_key = nvs_fb_api_key;
      fbConfig.database_url = nvs_fb_db_url;
      fbAuth.user.email = nvs_fb_email;
      fbAuth.user.password = nvs_fb_password;
      haveNvs = true;
      Serial.println("Using Firebase config from NVS.");
    }
  }
  if (!haveNvs) {
    strncpy(nvs_fb_api_key, API_KEY, sizeof(nvs_fb_api_key) - 1);
    nvs_fb_api_key[sizeof(nvs_fb_api_key) - 1] = '\0';
    strncpy(nvs_fb_db_url, DB_URL, sizeof(nvs_fb_db_url) - 1);
    nvs_fb_db_url[sizeof(nvs_fb_db_url) - 1] = '\0';
    strncpy(nvs_fb_email, FIREBASE_USER_EMAIL, sizeof(nvs_fb_email) - 1);
    nvs_fb_email[sizeof(nvs_fb_email) - 1] = '\0';
    strncpy(nvs_fb_password, FIREBASE_USER_PASSWORD, sizeof(nvs_fb_password) - 1);
    nvs_fb_password[sizeof(nvs_fb_password) - 1] = '\0';
    fbConfig.api_key = nvs_fb_api_key;
    fbConfig.database_url = nvs_fb_db_url;
    fbAuth.user.email = nvs_fb_email;
    fbAuth.user.password = nvs_fb_password;
    Serial.println("Using Firebase config from compile-time defaults.");
  }
}

void clearFirebaseNVS() {
  Preferences prefs;
  if (prefs.begin(NVS_NAMESPACE, false)) {
    prefs.clear();
    prefs.end();
  }
}

// -----------------------------------------------------------------------------
// Hardware init
// -----------------------------------------------------------------------------
void initializeHardware() {
  Wire.begin(I2C_SDA_PIN, I2C_SCL_PIN);
  Wire.setClock(100000);
  delay(200);

  // Scan I2C for a Bosch sensor at 0x76 or 0x77, read chip ID register 0xD0
  const uint8_t candidates[] = {0x76, 0x77};
  for (uint8_t addr : candidates) {
    Wire.beginTransmission(addr);
    if (Wire.endTransmission() != 0) continue;

    Wire.beginTransmission(addr);
    Wire.write(0xD0);
    Wire.endTransmission(false);
    Wire.requestFrom(addr, (uint8_t)1);

    if (!Wire.available()) continue;
    uint8_t chipId = Wire.read();
    gChipId = chipId;
    gSensorAddr = addr;

    if (chipId == 0x60) {
      gSensorType = SENSOR_BME280;
    } else if (chipId == 0x58) {
      gSensorType = SENSOR_BMP280;
    } else {
      Serial.printf("Unknown sensor at 0x%02X, chip ID 0x%02X\n", addr, chipId);
      continue;
    }
    break;
  }

  if (gSensorType == SENSOR_NONE) {
    Serial.println("Unknown sensor or I2C communication issue.");
  }

  // Initialize the matching Adafruit library
  bool libOk = false;
  if (gSensorType == SENSOR_BME280) {
    libOk = bme.begin(gSensorAddr, &Wire);
  } else if (gSensorType == SENSOR_BMP280) {
    libOk = bmp.begin(gSensorAddr);
  }
  if (!libOk && gSensorType != SENSOR_NONE) {
    Serial.println("Sensor detected via chip ID but library init failed. Check wiring/power.");
    gSensorType = SENSOR_NONE;
  }

  printSensorDiagnostic();

  // VEML7700 ambient light sensor (I2C addr 0x10, ADDR pin → GND)
  if (!veml.begin()) {
    Serial.println("[HW] VEML7700 not found — check wiring (SDA=8, SCL=9, addr=0x10)");
  } else {
    veml.setGain(VEML7700_GAIN_1);
    veml.setIntegrationTime(VEML7700_IT_100MS);
    Serial.println("[HW] VEML7700 ready.");
  }

  // Float switch — tank water level (INPUT_PULLUP: HIGH=water present, LOW=tank empty)
  pinMode(TANK_SENSOR_PIN, INPUT_PULLUP);
  pinMode(SOIL_SENSOR_PIN, INPUT);
  digitalWrite(RELAY_PIN, LOW);   // active-HIGH MOSFET: LOW = pump OFF
}

// -----------------------------------------------------------------------------
// Boot diagnostic report
// -----------------------------------------------------------------------------
void printSensorDiagnostic() {
  Serial.println("\n===== Smart Plant Sensor Check =====");

  if (gSensorType == SENSOR_NONE) {
    Serial.println("No supported sensor detected.");
    Serial.println("====================================\n");
    return;
  }

  Serial.printf("I2C Address: 0x%02X\n", gSensorAddr);
  Serial.printf("Chip ID:     0x%02X\n", gChipId);
  Serial.printf("Detected:    %s\n",
    gSensorType == SENSOR_BME280 ? "BME280" : "BMP280");

  float t = NAN, p = NAN, h = NAN;
  if (gSensorType == SENSOR_BME280) {
    t = bme.readTemperature();
    p = bme.readPressure();
    h = bme.readHumidity();
  } else {
    t = bmp.readTemperature();
    p = bmp.readPressure();
  }

  bool anyBad = false;
  bool tempOk = !isnan(t) && t >= -20.0f && t <= 60.0f;
  bool pressOk = !isnan(p) && p >= 80000.0f && p <= 110000.0f;

  Serial.printf("Temperature: %.1f C (%s)\n", t, tempOk ? "OK" : "BAD");
  Serial.printf("Pressure:    %.0f Pa (%s)\n", p, pressOk ? "OK" : "BAD");
  if (!tempOk || !pressOk) anyBad = true;

  if (gSensorType == SENSOR_BME280) {
    bool humOk = !isnan(h) && h > 0.0f && h <= 100.0f;
    Serial.printf("Humidity:    %.1f %% (%s)\n", h, humOk ? "OK" : "BAD");
    if (!humOk) anyBad = true;
  } else {
    Serial.println("Humidity:    N/A (BMP280)");
  }

  if (anyBad) {
    Serial.println("Sensor values invalid. Possible wiring, power, or fake sensor issue.");
  }

  Serial.println("====================================\n");
}

// -----------------------------------------------------------------------------
// Task: Read sensors (Core 1, 5 s)
// -----------------------------------------------------------------------------
void taskReadSensors(void *pv) {
  const TickType_t period = pdMS_TO_TICKS(SENSOR_READ_INTERVAL_MS);

  // Fake BME280 clone detection: first N readings with humidity always bad → downgrade
  static constexpr int HUM_CHECK_WINDOW = 5;
  int humCheckCount = 0;
  int humBadCount   = 0;

  while (true) {
    SensorState local{};
    local.humidity = NAN;
    local.pressurePa = NAN;

    if (gSensorType == SENSOR_BME280) {
      local.temperatureC = bme.readTemperature();
      local.pressurePa   = bme.readPressure();
      local.humidity      = bme.readHumidity();
    } else if (gSensorType == SENSOR_BMP280) {
      local.temperatureC = bmp.readTemperature();
      local.pressurePa   = bmp.readPressure();
    } else {
      local.temperatureC = NAN;
    }

    // Fake BME280 clone fallback: humidity stuck at 0, 100, or NaN
    if (gSensorType == SENSOR_BME280 && humCheckCount < HUM_CHECK_WINDOW) {
      humCheckCount++;
      if (isnan(local.humidity) || local.humidity <= 0.0f || local.humidity >= 100.0f) {
        humBadCount++;
      }
      if (humCheckCount >= HUM_CHECK_WINDOW && humBadCount >= HUM_CHECK_WINDOW) {
        Serial.println("WARNING: BME280 humidity always invalid — likely a BMP280 clone.");
        Serial.println("         Downgrading to BMP280 mode (humidity disabled).");
        gSensorType = SENSOR_BMP280;
        // Re-init with BMP280 library; BME280 lib reads are still valid for temp/pressure
        // but future reads will use the BMP280 object if we can init it.
        if (bmp.begin(gSensorAddr)) {
          Serial.println("         BMP280 library re-initialized OK.");
        }
        local.humidity = NAN;
      }
    }

    // Sanity validation
    bool tempBad  = isnan(local.temperatureC) || local.temperatureC < -20.0f || local.temperatureC > 60.0f;
    bool pressBad = isnan(local.pressurePa) || local.pressurePa < 80000.0f || local.pressurePa > 110000.0f;
    bool humBad   = (gSensorType == SENSOR_BME280) &&
                    (isnan(local.humidity) || local.humidity < 0.0f || local.humidity > 100.0f);

    if (gSensorType != SENSOR_NONE && (tempBad || pressBad || humBad)) {
      static unsigned long lastWarn = 0;
      if (millis() - lastWarn > 30000) {
        Serial.println("Sensor values invalid. Possible wiring, power, or fake sensor issue.");
        lastWarn = millis();
      }
    }

    local.soilRaw     = analogRead(SOIL_SENSOR_PIN);
    local.lux         = veml.readLux();                        // returns NAN on error
    local.tankEmpty   = (digitalRead(TANK_SENSOR_PIN) == LOW); // LOW = float down = empty
    local.pumpRunning = (digitalRead(RELAY_PIN) == HIGH);      // HIGH = pump ON for active-HIGH MOSFET

    if (xSemaphoreTake(gStateMutex, pdMS_TO_TICKS(50)) == pdTRUE) {
      gState = local;
      gSensorReady = true;
      xSemaphoreGive(gStateMutex);
    }

    vTaskDelay(period);
  }
}

// -----------------------------------------------------------------------------
// Task: Firebase sync (Core 0, 10 s)
// -----------------------------------------------------------------------------
String readingsPath() {
  return "devices/" + deviceId + "/readings";
}

String healthStatus(const SensorState &s) {
  if (s.pumpRunning && s.soilRaw > 3000) {
    return "Pump running, soil still dry";
  }
  if (!isnan(s.temperatureC) && s.temperatureC > 45.0f) {
    return "Overheat";
  }
  if (!isnan(s.humidity) && s.humidity > 95.0f) {
    return "High humidity";
  }
  return "OK";
}

// Threshold: after this many SSL/connection failures or "not ready" cycles, reset WiFi
static const int SSL_FAIL_THRESHOLD = 15;  // ~15–45 s of no success → clear WiFi and restart

void taskFirebaseSync(void *pv) {
  const TickType_t fastPeriod = pdMS_TO_TICKS(RESET_POLL_MS);  // 1 s — reset check + loop rate
  static int cycleCount = 0;
  static int sslFailStreak = 0;

  Serial.println("[Sync] Waiting for first sensor reading...");
  while (!gSensorReady) {
    vTaskDelay(pdMS_TO_TICKS(200));
  }
  Serial.println("[Sync] Sensor ready, starting sync loop.");

  static unsigned long syncCount = 0;
  static unsigned long syncFailCount = 0;

  bool firstPushDone = false;
  while (true) {
    cycleCount++;
    int syncMod = FIREBASE_SYNC_INTERVAL_MS / RESET_POLL_MS;  // 3
    bool doFullSync = !firstPushDone || (cycleCount % syncMod) == 0;

    SensorState s{};
    if (xSemaphoreTake(gStateMutex, pdMS_TO_TICKS(50)) == pdTRUE) {
      s = gState;
      xSemaphoreGive(gStateMutex);
    }

    bool fbReady = Firebase.ready();
    if (!fbReady) {
      if (doFullSync) {
        sslFailStreak++;
        if (sslFailStreak >= SSL_FAIL_THRESHOLD) {
          clearBadWiFiAndRestart("ERROR: Firebase/SSL failing (network blocks HTTPS). Resetting WiFi.");
        }
        Serial.println("[Sync] Firebase not ready, skipping this cycle.");
      }
      vTaskDelay(fastPeriod);
      continue;
    }

    if (doFullSync && xSemaphoreTake(gFirebaseMutex, pdMS_TO_TICKS(500)) == pdTRUE) {
      FirebaseJson json;
      if (!isnan(s.temperatureC)) {
        json.set("temperature", s.temperatureC);
      }
      if (!isnan(s.pressurePa)) {
        json.set("pressure", s.pressurePa);
      }
      if (!isnan(s.humidity)) {
        json.set("humidity", s.humidity);
      }
      json.set("soilRaw", s.soilRaw);
      json.set("lightBright", s.lightBright);
      json.set("pumpRunning", s.pumpRunning);
      json.set("health", healthStatus(s));
      json.set("timestamp", (int)time(nullptr));
      json.set("wifiSSID", WiFi.SSID());
      json.set("wifiRSSI", WiFi.RSSI());

      if (!Firebase.RTDB.updateNode(&fbClient, readingsPath().c_str(), &json)) {
        syncFailCount++;
        String err = fbClient.errorReason();
        Serial.print("[Sync] RTDB update FAILED: ");
        Serial.println(err);
        // SSL/connection errors → likely captive portal or blocked HTTPS
        if (err.indexOf("ssl") >= 0 || err.indexOf("SSL") >= 0 || err.indexOf("closed") >= 0 || err.indexOf("connection") >= 0) {
          sslFailStreak++;
          if (sslFailStreak >= SSL_FAIL_THRESHOLD) {
            clearBadWiFiAndRestart("ERROR: SSL/connection errors (network blocks HTTPS). Resetting WiFi.");
          }
        }
      } else {
        sslFailStreak = 0;  // Success → reset streak
        syncCount++;
        firstPushDone = true;
        if (syncCount <= 5 || syncCount % 20 == 0) {
          Serial.printf("[Sync] Push #%lu OK | temp=%.1f pres=%.0f hum=%.1f soil=%u light=%d ts=%d\n",
            syncCount, s.temperatureC, s.pressurePa, s.humidity,
            s.soilRaw, s.lightBright, (int)time(nullptr));
        }
      }
      // So the app can list "available" devices and show online status
      String deviceListPath = "deviceList/" + deviceId + "/lastSeen";
      if (!Firebase.RTDB.setInt(&fbClient, deviceListPath.c_str(), (int)time(nullptr))) {
        // non-fatal
      }
      // Alerts: when health is not OK, write lastAlert for dashboard / future FCM
      String h = healthStatus(s);
      if (h != "OK") {
        String alertPath = "devices/" + deviceId + "/alerts/lastAlert";
        FirebaseJson alertJson;
        alertJson.set("timestamp", (int)time(nullptr));
        alertJson.set("type", "health");
        alertJson.set("message", h);
        Firebase.RTDB.updateNode(&fbClient, alertPath.c_str(), &alertJson);
      }

      // Schedule check: every 12 cycles (~60 s) see if auto-water should trigger
      static int schedCycles = 0;
      if (++schedCycles >= 12) {
        schedCycles = 0;
        taskScheduleCheck();
      }

      // Diagnostics: uptime, lastSync, counts, WiFi (for dashboard diagnostics panel)
      String diagPath = "devices/" + deviceId + "/diagnostics";
      FirebaseJson diagJson;
      diagJson.set("uptimeSec", (int)(millis() / 1000));
      diagJson.set("lastSyncAt", (int)time(nullptr));
      diagJson.set("syncSuccessCount", (int)syncCount);
      diagJson.set("syncFailCount", (int)syncFailCount);
      diagJson.set("wifiRSSI", WiFi.RSSI());
      Firebase.RTDB.updateNode(&fbClient, diagPath.c_str(), &diagJson);

      // History: push a compact snapshot every ~5 min (60 cycles × 5 s)
      static int histCycles = 0;
      if (++histCycles >= 60) {
        histCycles = 0;
        String histPath = "devices/" + deviceId + "/history/" + String((int)time(nullptr));
        FirebaseJson hj;
        if (!isnan(s.temperatureC)) hj.set("t", s.temperatureC);
        if (!isnan(s.pressurePa))   hj.set("p", s.pressurePa);
        if (!isnan(s.humidity))     hj.set("h", s.humidity);
        hj.set("s", s.soilRaw);
        hj.set("l", s.lightBright ? 1 : 0);
        hj.set("pu", s.pumpRunning ? 1 : 0);
        Firebase.RTDB.setJSON(&fbClient, histPath.c_str(), &hj);
      }

      xSemaphoreGive(gFirebaseMutex);
    }

    // Re-provisioning: checked every 1 s so Reset button responds within ~1–2 s.
    // App set devices/<MAC>/control/resetProvisioning = true → clear WiFi, reboot.
    // CRITICAL: clear the flag in Firebase BEFORE resetting, otherwise the device
    // will find it still true on next boot and enter an infinite reset loop.
    // Grace period: ignore stale flags for 15 s after boot so a leftover flag
    // from a failed previous clear doesn't cause an instant reset loop.
    static bool resetGracePassed = false;
    static bool staleCleared = false;
    if (!resetGracePassed) {
      // During grace period, silently clear any leftover flag from a previous crash
      if (!staleCleared && Firebase.ready() && fetchResetProvisioning()) {
        String stalePath = "devices/" + deviceId + "/control/resetProvisioning";
        if (xSemaphoreTake(gFirebaseMutex, pdMS_TO_TICKS(1000)) == pdTRUE) {
          Firebase.RTDB.setBool(&fbClient, stalePath.c_str(), false);
          xSemaphoreGive(gFirebaseMutex);
        }
        staleCleared = true;
        Serial.println("[Reset] Cleared stale resetProvisioning flag from previous session.");
      }
      if (millis() > 15000) resetGracePassed = true;
    }
    if (resetGracePassed && Firebase.ready() && fetchResetProvisioning()) {
      String path = "devices/" + deviceId + "/control/resetProvisioning";
      bool cleared = false;
      for (int attempt = 1; attempt <= 5 && !cleared; attempt++) {
        if (xSemaphoreTake(gFirebaseMutex, pdMS_TO_TICKS(1000)) == pdTRUE) {
          cleared = Firebase.RTDB.setBool(&fbClient, path.c_str(), false);
          xSemaphoreGive(gFirebaseMutex);
        }
        if (!cleared) {
          Serial.printf("[Reset] Failed to clear resetProvisioning (attempt %d/5)\n", attempt);
          vTaskDelay(pdMS_TO_TICKS(500));
        }
      }
      if (!cleared) {
        Serial.println("[Reset] Could not clear flag in Firebase — skipping reset to avoid boot loop.");
      } else {
        Serial.println("[Reset] Flag cleared. Clearing WiFi only (Firebase config kept), restarting...");
        // Do NOT clear Firebase NVS — user keeps same project when changing WiFi.
        // Erase WiFi credentials from NVS — must do while WiFi/STA is still active.
        // WiFi.eraseAP() wraps esp_wifi_restore() and clears stored SSID/password.
        if (WiFi.eraseAP()) {
          Serial.println("[Reset] WiFi credentials erased.");
        } else {
          Serial.println("[Reset] WiFi.eraseAP failed, trying wm.resetSettings...");
          wm.resetSettings();
          WiFi.disconnect(true, true);
        }
        delay(1500);
        ESP.restart();
      }
    }

    // Poll pumpRequest every cycle (~1 s) instead of using Firebase stream
    // (streams caused FreeRTOS mutex crashes on ESP32)
    if (Firebase.ready()) {
      bool req = fetchPumpRequest();
      if (req && !gPumpRequest) {
        gPumpReason = 0;  // manual
        gPumpRequest = true;
        Serial.println("[Poll] pumpRequest=true (manual)");
      } else if (!req && gPumpRequest) {
        gPumpRequest = false;
      }
    }

    vTaskDelay(fastPeriod);
  }
}

bool fetchPumpRequest() {
  String path = "devices/" + deviceId + "/control/pumpRequest";
  if (xSemaphoreTake(gFirebaseMutex, pdMS_TO_TICKS(500)) != pdTRUE) return false;
  bool ok = Firebase.RTDB.getBool(&fbClient, path.c_str());
  bool val = ok && fbClient.boolData();
  xSemaphoreGive(gFirebaseMutex);
  return val;
}

// -----------------------------------------------------------------------------
// Task: Pump control (Core 0) – pulse watering on pumpRequest
// -----------------------------------------------------------------------------
void updateRelay(bool on) {
  digitalWrite(RELAY_PIN, on ? HIGH : LOW);  // active-HIGH MOSFET: HIGH = pump ON
}

uint16_t fetchTargetSoil() {
  String path = "devices/" + deviceId + "/control/targetSoil";
  if (xSemaphoreTake(gFirebaseMutex, pdMS_TO_TICKS(500)) == pdTRUE) {
    bool ok = Firebase.RTDB.getInt(&fbClient, path.c_str());
    int val = ok ? fbClient.intData() : -1;
    xSemaphoreGive(gFirebaseMutex);
    if (ok && val >= 0) {
      return static_cast<uint16_t>(val);
    }
  }
  // Default threshold if not set
  return 2800;
}

bool fetchResetProvisioning() {
  String path = "devices/" + deviceId + "/control/resetProvisioning";
  if (xSemaphoreTake(gFirebaseMutex, pdMS_TO_TICKS(500)) != pdTRUE) return false;
  bool ok = Firebase.RTDB.getBool(&fbClient, path.c_str());
  bool val = ok && fbClient.boolData();
  xSemaphoreGive(gFirebaseMutex);
  return val;
}

// Schedule config: devices/<MAC>/control/schedule/{enabled,hour,minute,hysteresis,maxSecondsPerDay,cooldownMinutes,day,todaySeconds,lastWateredAt}
void taskScheduleCheck() {
  if (!Firebase.ready() || xSemaphoreTake(gFirebaseMutex, pdMS_TO_TICKS(800)) != pdTRUE) return;

  String base = "devices/" + deviceId + "/control/schedule/";
  bool enabled = false;
  int hour = 8, minute = 0;
  int hysteresis = 200;
  int maxSecondsPerDay = 120;
  int cooldownMinutes = 30;
  int todaySeconds = 0;
  int lastWateredAt = 0;
  String dayStr;

  if (Firebase.RTDB.getBool(&fbClient, (base + "enabled").c_str())) {
    enabled = fbClient.boolData();
  }
  if (!enabled) {
    xSemaphoreGive(gFirebaseMutex);
    return;
  }

  if (Firebase.RTDB.getInt(&fbClient, (base + "hour").c_str())) hour = fbClient.intData();
  if (Firebase.RTDB.getInt(&fbClient, (base + "minute").c_str())) minute = fbClient.intData();
  if (Firebase.RTDB.getInt(&fbClient, (base + "hysteresis").c_str())) hysteresis = fbClient.intData();
  if (Firebase.RTDB.getInt(&fbClient, (base + "maxSecondsPerDay").c_str())) maxSecondsPerDay = fbClient.intData();
  if (Firebase.RTDB.getInt(&fbClient, (base + "cooldownMinutes").c_str())) cooldownMinutes = fbClient.intData();
  if (Firebase.RTDB.getInt(&fbClient, (base + "todaySeconds").c_str())) todaySeconds = fbClient.intData();
  if (Firebase.RTDB.getInt(&fbClient, (base + "lastWateredAt").c_str())) lastWateredAt = fbClient.intData();
  if (Firebase.RTDB.getString(&fbClient, (base + "day").c_str())) dayStr = fbClient.stringData();

  xSemaphoreGive(gFirebaseMutex);
  int target = fetchTargetSoil();  // acquires mutex internally

  SensorState s{};
  if (xSemaphoreTake(gStateMutex, pdMS_TO_TICKS(50)) != pdTRUE) return;
  s = gState;
  xSemaphoreGive(gStateMutex);

  time_t now = time(nullptr);
  if (now < 1000000000L) return;  // NTP not synced
  struct tm* lt = localtime(&now);
  int nowHour = lt->tm_hour;
  int nowMin = lt->tm_min;

  // Time window: allow watering within 5 min of scheduled time (check runs every 60s)
  int scheduledMin = hour * 60 + minute;
  int currentMin = nowHour * 60 + nowMin;
  bool timeOk = (currentMin >= scheduledMin && currentMin <= scheduledMin + 5);

  // Soil: water when soil > target (dry) - hysteresis lowers the threshold. Water when soilRaw > (target - hysteresis)?
  // Actually: lower soilRaw = wetter. targetSoil = desired level. We water when soil is DRY = soilRaw HIGH.
  // So we water when soilRaw > target. Hysteresis: don't water again until soil drops significantly. So we water when soilRaw > (target + hysteresis)?
  // Standard: hysteresis prevents flip-flopping. Water when dry (soilRaw > target). Stop when wet (soilRaw <= target). Hysteresis: water when soilRaw > (target + hyst), stop when soilRaw <= (target - hyst). So we use target + hysteresis as "start watering" threshold.
  int threshold = target + hysteresis;
  if (threshold > 4095) threshold = 4095;
  bool soilDry = (s.soilRaw > (uint16_t)threshold);

  // Cooldown
  bool cooldownOk = (lastWateredAt == 0) || ((int)now - lastWateredAt >= cooldownMinutes * 60);

  // Daily cap
  char todayBuf[16];
  snprintf(todayBuf, sizeof(todayBuf), "%04d-%02d-%02d", lt->tm_year + 1900, lt->tm_mon + 1, lt->tm_mday);
  bool sameDay = (dayStr.length() > 0 && dayStr == todayBuf);
  int cap = sameDay ? todaySeconds : 0;
  bool underCap = (cap < maxSecondsPerDay);

  if (timeOk && soilDry && cooldownOk && underCap && !gPumpRequest) {
    gPumpReason = 1;  // schedule
    gPumpRequest = true;
    Serial.println("[Schedule] Triggering auto water: soil dry, time OK");
  }
}

void updateScheduleAfterWater(int durationSec, uint16_t soilBefore, uint16_t soilAfter) {
  if (!Firebase.ready()) return;
  time_t now = time(nullptr);
  if (now < 1000000000L) return;

  struct tm* lt = localtime(&now);
  char todayBuf[16];
  snprintf(todayBuf, sizeof(todayBuf), "%04d-%02d-%02d", lt->tm_year + 1900, lt->tm_mon + 1, lt->tm_mday);

  String base = "devices/" + deviceId + "/control/schedule/";
  if (xSemaphoreTake(gFirebaseMutex, pdMS_TO_TICKS(500)) == pdTRUE) {
    Firebase.RTDB.setInt(&fbClient, (base + "lastWateredAt").c_str(), (int)now);
    Firebase.RTDB.setString(&fbClient, (base + "day").c_str(), todayBuf);
    // todaySeconds: we need to add durationSec. First fetch current.
    bool ok = Firebase.RTDB.getInt(&fbClient, (base + "todaySeconds").c_str());
    int cur = ok ? fbClient.intData() : 0;
    Firebase.RTDB.setInt(&fbClient, (base + "todaySeconds").c_str(), cur + durationSec);
    xSemaphoreGive(gFirebaseMutex);
  }
}

// Write a watering log entry (manual/schedule/auto)
void writeWaterLog(const char *reason, uint32_t durationMs, uint16_t soilBefore, uint16_t soilAfter) {
  if (!Firebase.ready()) return;
  String path = "devices/" + deviceId + "/waterLog/" + String((int)time(nullptr));
  FirebaseJson j;
  j.set("reason", reason);
  j.set("durationMs", (int)durationMs);
  j.set("soilBefore", (int)soilBefore);
  j.set("soilAfter", (int)soilAfter);
  if (xSemaphoreTake(gFirebaseMutex, pdMS_TO_TICKS(500)) == pdTRUE) {
    Firebase.RTDB.setJSON(&fbClient, path.c_str(), &j);
    xSemaphoreGive(gFirebaseMutex);
  }
}

void taskPumpControl(void *pv) {
  const uint32_t pulseMs = pdTICKS_TO_MS(PUMP_PULSE_MS);
  while (true) {
    if (!gPumpRequest) {
      updateRelay(false);
      vTaskDelay(PUMP_IDLE_MS);
      continue;
    }

    uint16_t target = fetchTargetSoil();

    SensorState s{};
    if (xSemaphoreTake(gStateMutex, pdMS_TO_TICKS(50)) == pdTRUE) {
      s = gState;
      xSemaphoreGive(gStateMutex);
    }

    if (s.soilRaw <= target) {
      // Target reached: clear request
      String reqPath = "devices/" + deviceId + "/control/pumpRequest";
      if (xSemaphoreTake(gFirebaseMutex, pdMS_TO_TICKS(500)) == pdTRUE) {
        Firebase.RTDB.setBool(&fbClient, reqPath.c_str(), false);
        xSemaphoreGive(gFirebaseMutex);
      }
      gPumpRequest = false;
      updateRelay(false);
      vTaskDelay(PUMP_IDLE_MS);
      continue;
    }

    uint16_t soilBefore = s.soilRaw;

    // Pulse: 1 s ON
    updateRelay(true);
    vTaskDelay(PUMP_PULSE_MS);

    // Soak: 5 s OFF
    updateRelay(false);
    vTaskDelay(PUMP_SOAK_MS);

    // soilAfter: read current state after soak
    if (xSemaphoreTake(gStateMutex, pdMS_TO_TICKS(50)) == pdTRUE) {
      s = gState;
      xSemaphoreGive(gStateMutex);
    }
    const char* reason = (gPumpReason == 1) ? "schedule" : "manual";
    writeWaterLog(reason, pulseMs, soilBefore, s.soilRaw);
    if (gPumpReason == 1) {
      updateScheduleAfterWater(pulseMs / 1000, soilBefore, s.soilRaw);
      gPumpReason = 0;
    }
  }
}

// (Stream callbacks removed — using polling to avoid FreeRTOS mutex crash)
