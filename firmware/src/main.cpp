// main.cpp — Kombi uzaktan kontrol, cihaz yazilimi (Faz 1).
//
// Donanim tarafi burada; KARAR mantigi lib/kombi_core icinde ve platformdan
// bagimsiz (makinede birim testi var). Bu dosyanin isi: pinler, sensor, NVS,
// WiFi/NTP, bulut, bekci kopek ve seri konsol.
//
// Olculmus donanim (14.10.2026): ESP32-D0WD-V3 rev 3.1, 4 MB flash, CH340 koprusu
// (115200; 460800 bozuk paket veriyor), DHT11 -> GPIO 18, role modulu -> GPIO 23,
// role ACTIVE LOW.
#include <Arduino.h>
#include <esp_task_wdt.h>
#include <sys/time.h>
#include <time.h>

#include "cloud.h"
#include "config.h"
#include "kombi_core.h"
#include "sensor.h"
#include "store.h"

// --- BENZETIM KOMUTU KAPISI (YUKSEK-1) --------------------------------------
// `sim temp/fault/time`, `wifi on|off` ve `wdtest` komutlari USB'si eline gecen
// birine roleyi surdurur. Bu yuzden benzetim YALNIZ gelistirme ortaminda
// derlenebilir: `platformio.ini`'deki [env:esp32dev] -DKOMBI_DEV_BUILD=1 verir,
// [env:esp32dev_prod] ise -DKOMBI_ALLOW_SIM=0. Sablon varsayilani da 0.
#ifndef KOMBI_ALLOW_SIM
#define KOMBI_ALLOW_SIM 0
#endif
#if KOMBI_ALLOW_SIM && !defined(KOMBI_DEV_BUILD)
#error "KOMBI_ALLOW_SIM=1 yalniz gelistirme derlemesinde (KOMBI_DEV_BUILD) kullanilabilir. Kalici montaj icin: pio run -e esp32dev_prod"
#endif

static const char* FW_VERSION = "kombi-fw 0.2.0-faz1";
static const uint32_t WDT_TIMEOUT_S = 30;
static const uint32_t STATUS_PERIOD_MS = 5000;
static const uint32_t WIFI_RETRY_BASE_MS = 10000;
static const uint32_t WIFI_RETRY_MAX_MS = 300000;

static Store store;
static Cloud cloud;
static Dht11Sensor dht_sensor(PIN_DHT);
static SimWrapper sensor(&dht_sensor);
static kombi::Controller ctrl;
static kombi::Settings settings;
static kombi::RuleSet rules;

static int boot_pad_level = -1;      // kod calismadan ONCE role hattinin seviyesi
static bool nvs_loaded = false;
static bool wifi_enabled = true;
static uint32_t wifi_retry_ms = WIFI_RETRY_BASE_MS;
static uint32_t last_wifi_try_ms = 0;
static uint32_t last_sensor_ms = 0;
static uint32_t last_status_ms = 0;
static uint32_t sensor_reads_ok = 0;
static uint32_t sensor_reads_fail = 0;
static uint32_t relay_switches = 0;
static uint32_t nvs_writes = 0;   // Y1: her turda NVS yazilmadigi OLCULEBILSIN
static bool relay_prev = false;
static String line_buf;

// ---------------------------------------------------------------------------
// ACILIS EMNIYETI — plan §5 "acilis ani (elektrik gelince) role istemsiz cekmez"
//
// Role modulu ACTIVE LOW: GPIO LOW = role ceker. Tuzak su: reset ile bizim
// kodumuzun arasinda (~200 ms) ESP32 pinleri surulmez; hat bosta kalirsa
// seviyesi belirsizdir ve LOW okunursa role CEKER. Bu yuzden sira sudur:
//   1) pini GIRIS olarak oku  -> kod oncesi seviyeyi OLC (kanit icin)
//   2) dahili pull-up ac       -> hat yukarida tutulur (role birakmis)
//   3) cikis kaydina OFF yaz   -> surucu acilmadan once deger dogru olsun
//   4) pinMode(OUTPUT)         -> surucu acildiginda hat zaten OFF
// Not: 1-2. adimlar yalniz bizim kodumuz calistiktan sonra etkili. Reset'in ilk
// milisaniyelerini KAPATAN tek sey harici bir pull-up direncidir (10k, IN -> VCC).
// Olcum (tools/pin_scan, 14.10.2026): GPIO 23 pulldown aciliken HIGH okudu, yani
// role modulunun kendi giris katmani hatti yukari cekiyor — acilis penceresi de
// pratikte OFF tarafinda. Harici direnc yine ONERILIR (docs/DONANIM.md).
static void relaySafeBoot() {
  pinMode(PIN_RELAY, INPUT);
  boot_pad_level = digitalRead(PIN_RELAY);
  pinMode(PIN_RELAY, INPUT_PULLUP);
  digitalWrite(PIN_RELAY, kombi::RELAY_LEVEL_OFF);
  pinMode(PIN_RELAY, OUTPUT);
  digitalWrite(PIN_RELAY, kombi::RELAY_LEVEL_OFF);
}

static void applyRelay(bool heat) {
  digitalWrite(PIN_RELAY, kombi::relayLevelFor(heat));
  if (heat != relay_prev) {
    relay_switches++;
    relay_prev = heat;
  }
}

static kombi::Clock readClock() {
  kombi::Clock c;
  const time_t now = time(nullptr);
  // 1735689600 = 01.01.2025. Bundan kucuk deger "NTP hic calismadi" demektir.
  // Saat dogrulanmadan saatli kural KOSULMAZ (plan §3, bilincli sinir).
  if (now < 1735689600) return c;
  struct tm tm_now;
  localtime_r(&now, &tm_now);
  c.valid = true;
  c.weekday = (uint8_t)tm_now.tm_wday;  // 0 = Pazar
  c.hour = (uint8_t)tm_now.tm_hour;
  c.minute = (uint8_t)tm_now.tm_min;
  return c;
}

static void persist() {
  settings = ctrl.settings();
  nvs_writes++;
  if (!store.save(settings, rules)) Serial.println(F("[NVS] YAZMA BASARISIZ"));
}

static void printStatus() {
  const kombi::Clock c = readClock();
  char tbuf[20] = "yok";
  if (c.valid) snprintf(tbuf, sizeof(tbuf), "%02u:%02u/gun%u", c.hour, c.minute, c.weekday);
  char okuma[12] = "yok";
  if (ctrl.hasReading()) snprintf(okuma, sizeof(okuma), "%.1f", ctrl.lastTempC());
  char kural[24] = "-";
  if (ctrl.ruleActive())
    snprintf(kural, sizeof(kural), "%02u:%02u", ctrl.activeRuleHour(), ctrl.activeRuleMinute());
  else if (ctrl.manualOverride() && rules.count > 0)
    snprintf(kural, sizeof(kural), "elle");
  Serial.printf(
      "STATE t=%s h=%.1f target=%.1f taban=%.1f kural=%s band=%.1f heat=%d pad=%s reason=%s sensor=%s "
      "clock=%s susp=%d rules=%u wifi=%s cloud=%s up=%lus sw=%lu nvs=%lu ok=%lu fail=%lu\n",
      okuma, ctrl.lastHumidity(), ctrl.effectiveTarget(), ctrl.baseTarget(), kural,
      ctrl.settings().hysteresis_c,
      ctrl.heatRequested() ? 1 : 0, digitalRead(PIN_RELAY) ? "HIGH" : "LOW",
      kombi::reasonName(ctrl.reason()), ctrl.sensorFault() ? "ARIZA" : "ok", tbuf,
      ctrl.rulesSuspended() ? 1 : 0, (unsigned)rules.count,
      WiFi.status() == WL_CONNECTED ? WiFi.localIP().toString().c_str()
                                    : (wifi_enabled ? "down" : "kapali"),
      cloud.configured() ? (cloud.lastOk() ? "ok" : "hata") : "ayarsiz",
      (unsigned long)(millis() / 1000), (unsigned long)relay_switches, (unsigned long)nvs_writes,
      (unsigned long)sensor_reads_ok, (unsigned long)sensor_reads_fail);
}

static void startWifi() {
  if (strlen(WIFI_SSID) == 0) {
    Serial.println(F("[WiFi] SSID bos — cihaz YALNIZ YEREL termostat olarak calisiyor"));
    wifi_enabled = false;
    return;
  }
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  Serial.printf("[WiFi] baglaniyor: %s\n", WIFI_SSID);
}

static void serviceWifi(uint32_t now) {
  if (!wifi_enabled || strlen(WIFI_SSID) == 0) return;
  if (WiFi.status() == WL_CONNECTED) {
    wifi_retry_ms = WIFI_RETRY_BASE_MS;
    return;
  }
  // GERI CEKILMELI yeniden deneme: WiFi yokken surekli bosa baglanma denemesi
  // yapmaz (plan: "yeniden baglanma geri cekilmeli").
  if ((uint32_t)(now - last_wifi_try_ms) < wifi_retry_ms) return;
  last_wifi_try_ms = now;
  Serial.printf("[WiFi] yeniden deneme (%lu sn sonra tekrar)\n", (unsigned long)(wifi_retry_ms / 1000));
  WiFi.disconnect();
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  wifi_retry_ms = wifi_retry_ms * 2 > WIFI_RETRY_MAX_MS ? WIFI_RETRY_MAX_MS : wifi_retry_ms * 2;
}

static void serviceCloud(uint32_t now) {
  if (!cloud.due(now)) return;
  DeviceReport rep;
  // Y7 — GECERLI OKUMA YOKKEN UYDURMA DEGER GONDERILMEZ. Eskiden 0.0 gidiyordu;
  // bulutta `temp_c=0`, panelde "DONMA RISKI" ve Faz 2 alarmi yanlis sebeple
  // calisiyordu. Okuma yoksa alan NULL gider.
  rep.has_reading = ctrl.hasReading();
  rep.temp_c = ctrl.lastTempC();
  rep.humidity = ctrl.lastHumidity();
  rep.relay_on = ctrl.heatRequested();
  rep.sensor_ok = !ctrl.sensorFault();
  rep.time_valid = readClock().valid;
  rep.rules_suspended = ctrl.rulesSuspended();
  rep.target_c = ctrl.effectiveTarget();   // YURURLUKTEKI hedef
  rep.base_target_c = ctrl.baseTarget();   // kullanicinin/bulutun yazdigi taban
  rep.rule_active = ctrl.ruleActive();
  rep.active_rule_hour = ctrl.ruleActive() ? (int)ctrl.activeRuleHour() : -1;
  rep.active_rule_minute = ctrl.ruleActive() ? (int)ctrl.activeRuleMinute() : -1;
  rep.reason = kombi::reasonName(ctrl.reason());
  rep.uptime_s = millis() / 1000;
  rep.wifi_rssi = WiFi.RSSI();
  rep.fw_version = FW_VERSION;

  kombi::Settings ns;
  kombi::RuleSet nr{};  // Y1: ILKLENDIR. Ilklendirilmemis dizi memcmp'te her
                        // turda "degisti" dedirtiyordu (belirsiz deger okuma).
  bool has_settings = false;
  if (!cloud.sync(now, rep, ns, nr, has_settings)) {
    Serial.printf("[bulut] basarisiz (%s), hata sayisi=%lu\n", cloud.lastError().c_str(),
                  (unsigned long)cloud.failures());
    return;
  }
  // Uygulama mantigi CEKIRDEKTE (kombi_core): birim testi ve olcum kosumu
  // (tools/core_cli) ayni kodu kullansin. Yalniz GERCEKTEN degisen deger
  // NVS'e yazilir.
  const kombi::CloudApply a =
      kombi::applyCloudState(ctrl, rules, has_settings ? &ns : nullptr, &nr);
  if (a.needs_persist) {
    Serial.printf("[bulut] %s%sguncellendi -> NVS\n", a.settings_changed ? "ayar " : "",
                  a.rules_changed ? "kural " : "");
    persist();
  }
}

// ---------------------------------------------------------------------------
// Seri konsol. Faz 1 kabul testleri bunun uzerinden OLCULUYOR.
// O6 — KONSOL GIRDI DOGRULAMASI. `cmd.substring(..).toFloat()` gecersiz metni
// sessizce 0'a ceviriyor, clampSettings de onu 5.0'a kirpiyordu: `target abc`
// hedefi sessizce 5 °C yapardi. Artik sayi olmayan girdi REDDEDILIR.
static bool parseFloatArg(const String& cmd, int from, float& out) {
  String arg = cmd.substring(from);
  arg.trim();
  if (arg.length() == 0) return false;
  char* end = nullptr;
  const float v = strtof(arg.c_str(), &end);
  if (end == arg.c_str() || *end != '\0') return false;
  if (v != v) return false;  // NaN
  out = v;
  return true;
}

static bool parseIntArg(const String& cmd, int from, long& out) {
  String arg = cmd.substring(from);
  arg.trim();
  if (arg.length() == 0) return false;
  char* end = nullptr;
  const long v = strtol(arg.c_str(), &end, 10);
  if (end == arg.c_str() || *end != '\0') return false;
  out = v;
  return true;
}

static void handleCommand(String cmd) {
  cmd.trim();
  if (cmd.length() == 0) return;

  if (cmd == "help") {
    Serial.println(F("komutlar: status | target <c> | band <c> | freeze <c> | hold <sn> |"));
    Serial.println(F("          manual on|off | rule list|clear | rule add <maske> <sa> <dk> <hedef> |"));
    Serial.println(F("          timeout <sn> | nvs | time | info"));
#if KOMBI_ALLOW_SIM
    Serial.println(F("  benzetim: sim temp <c> | sim off | sim fault on|off | sim time <epoch> |"));
    Serial.println(F("            wifi on|off | wdtest"));
#endif
    return;
  }
  if (cmd == "status") { printStatus(); return; }
  if (cmd == "info") {
    Serial.printf("fw=%s sensor=%s pin_dht=%d pin_role=%d acilis_pad=%s nvs=%s mac=%s\n",
                  FW_VERSION, sensor.name(), PIN_DHT, PIN_RELAY,
                  boot_pad_level ? "HIGH" : "LOW", nvs_loaded ? "yuklendi" : "varsayilan",
                  WiFi.macAddress().c_str());
    Serial.printf("acilis_sebebi=%d role_seviyeleri: ON=%d OFF=%d SIM=%d TLS_DOGRULAMA=%d\n",
                  (int)esp_reset_reason(), kombi::RELAY_LEVEL_ON, kombi::RELAY_LEVEL_OFF,
                  KOMBI_ALLOW_SIM, ALLOW_INSECURE_TLS ? 0 : 1);
    return;
  }
  if (cmd == "nvs") { store.dump(Serial); return; }
  if (cmd == "time") {
    const kombi::Clock c = readClock();
    Serial.printf("saat gecerli=%d %02u:%02u gun=%u askida=%d\n", c.valid ? 1 : 0, c.hour, c.minute,
                  c.weekday, ctrl.rulesSuspended() ? 1 : 0);
    return;
  }
  if (cmd.startsWith("target ")) {
    float v = 0;
    if (!parseFloatArg(cmd, 7, v)) { Serial.println(F("HATA: sayi bekleniyor")); return; }
    kombi::Settings s = ctrl.settings();
    s.target_c = v;
    ctrl.setSettings(s);
    persist();
    Serial.printf("hedef=%.1f (NVS'e yazildi)\n", ctrl.effectiveTarget());
    return;
  }
  if (cmd.startsWith("band ")) {
    float v = 0;
    if (!parseFloatArg(cmd, 5, v)) { Serial.println(F("HATA: sayi bekleniyor")); return; }
    kombi::Settings s = ctrl.settings();
    s.hysteresis_c = v;
    ctrl.setSettings(s);
    persist();
    Serial.printf("bant=%.1f\n", ctrl.settings().hysteresis_c);
    return;
  }
  if (cmd.startsWith("freeze ")) {
    float v = 0;
    if (!parseFloatArg(cmd, 7, v)) { Serial.println(F("HATA: sayi bekleniyor")); return; }
    kombi::Settings s = ctrl.settings();
    s.freeze_guard_c = v;
    ctrl.setSettings(s);
    persist();
    Serial.printf("donma esigi=%.1f\n", ctrl.settings().freeze_guard_c);
    return;
  }
  if (cmd.startsWith("hold ")) {
    long v = 0;
    if (!parseIntArg(cmd, 5, v) || v < 0 || v > 65535) { Serial.println(F("HATA: 0-65535 sn bekleniyor")); return; }
    kombi::Settings s = ctrl.settings();
    s.min_relay_hold_s = (uint16_t)v;
    ctrl.setSettings(s);
    persist();
    Serial.printf("asgari bekleme=%u sn\n", ctrl.settings().min_relay_hold_s);
    return;
  }
  if (cmd.startsWith("timeout ")) {
    long v = 0;
    if (!parseIntArg(cmd, 8, v) || v < 0 || v > 65535) { Serial.println(F("HATA: 0-65535 sn bekleniyor")); return; }
    kombi::Settings s = ctrl.settings();
    s.sensor_timeout_s = (uint16_t)v;
    ctrl.setSettings(s);
    persist();
    Serial.printf("sensor zaman asimi=%u sn\n", ctrl.settings().sensor_timeout_s);
    return;
  }
  if (cmd.startsWith("manual ")) {
    if (!cmd.endsWith("on") && !cmd.endsWith("off")) { Serial.println(F("kullanim: manual on|off")); return; }
    kombi::Settings s = ctrl.settings();
    s.manual_mode = cmd.endsWith("on");
    ctrl.setSettings(s);
    persist();
    Serial.printf("manuel mod=%d\n", s.manual_mode ? 1 : 0);
    return;
  }
  if (cmd == "rule list") {
    Serial.printf("kural sayisi=%u\n", rules.count);
    for (uint8_t i = 0; i < rules.count; i++) {
      Serial.printf("  [%u] acik=%d maske=0x%02X %02u:%02u -> %.1f\n", i, rules.rules[i].enabled,
                    rules.rules[i].days_mask, rules.rules[i].hour, rules.rules[i].minute,
                    rules.rules[i].target_c);
    }
    return;
  }
  if (cmd == "rule clear") {
    rules.count = 0;
    ctrl.setRules(rules);
    persist();
    Serial.println(F("kurallar silindi"));
    return;
  }
  if (cmd.startsWith("rule add ")) {
    // rule add <maske> <saat> <dakika> <hedef>   ornek: rule add 127 17 0 25
    int mask = 0, hh = 0, mm = 0;
    float tgt = 0;
    if (sscanf(cmd.c_str() + 9, "%d %d %d %f", &mask, &hh, &mm, &tgt) != 4) {
      Serial.println(F("kullanim: rule add <maske 1-127> <saat> <dakika> <hedef>"));
      return;
    }
    if (mask < 1 || mask > 127 || hh < 0 || hh > 23 || mm < 0 || mm > 59 || tgt < 5.0f ||
        tgt > 30.0f) {
      Serial.println(F("HATA: maske 1-127, saat 0-23, dakika 0-59, hedef 5-30"));
      return;
    }
    if (rules.count >= kombi::MAX_RULES) { Serial.println(F("kural listesi dolu")); return; }
    rules.rules[rules.count] = {true, (uint8_t)mask, (uint8_t)hh, (uint8_t)mm, tgt};
    rules.count++;
    const uint8_t dropped = kombi::sanitizeRules(rules);
    ctrl.setRules(rules);
    persist();
    Serial.printf("kural eklendi (atilan=%u, toplam=%u)\n", dropped, rules.count);
    return;
  }
#if KOMBI_ALLOW_SIM
  if (cmd.startsWith("sim temp ")) {
    sensor.setTemp(cmd.substring(9).toFloat());
    Serial.printf("[sim] sahte sicaklik=%.1f\n", sensor.forcedTemp());
    return;
  }
  if (cmd == "sim off") {
    sensor.clearTemp();
    sensor.setFault(false);
    Serial.println(F("[sim] benzetim kapandi, gercek sensor"));
    return;
  }
  if (cmd.startsWith("sim fault ")) {
    sensor.setFault(cmd.endsWith("on"));
    Serial.printf("[sim] sensor arizasi=%d\n", sensor.faulting() ? 1 : 0);
    return;
  }
  if (cmd.startsWith("sim time ")) {
    // Saati elle kur: NTP'siz masada saatli kural kosumunu OLCMEK icin.
    // (Gercek kullanimda saat yalniz NTP'den gelir.)
    struct timeval tv;
    tv.tv_sec = (time_t)strtol(cmd.c_str() + 9, nullptr, 10);
    tv.tv_usec = 0;
    settimeofday(&tv, nullptr);
    const kombi::Clock c = readClock();
    Serial.printf("[sim] saat kuruldu: gecerli=%d %02u:%02u gun=%u\n", c.valid ? 1 : 0, c.hour,
                  c.minute, c.weekday);
    return;
  }
  if (cmd == "wifi off") {
    wifi_enabled = false;
    WiFi.disconnect(true);
    WiFi.mode(WIFI_OFF);
    Serial.println(F("[sim] WiFi KAPATILDI — termostat calismaya devam etmeli"));
    return;
  }
  if (cmd == "wifi on") {
    wifi_enabled = true;
    wifi_retry_ms = WIFI_RETRY_BASE_MS;
    startWifi();
    return;
  }
  if (cmd == "wdtest") {
    // Bekci kopegi OLCMEK icin kasitli kilitlenme: dongu bir daha beslemez,
    // bekci ~30 sn icinde karti sifirlamali (acilis bannerini tekrar gormeliyiz).
    Serial.println(F("[sim] KASITLI KILITLENME — bekci kopegi karti sifirlamali"));
    while (true) { delay(1000); }
  }
#endif
  Serial.printf("bilinmeyen komut: %s (help yazin)\n", cmd.c_str());
}

static void serviceConsole() {
  while (Serial.available()) {
    const char ch = (char)Serial.read();
    if (ch == '\n' || ch == '\r') {
      if (line_buf.length()) {
        handleCommand(line_buf);
        line_buf = "";
      }
    } else if (line_buf.length() < 120) {
      line_buf += ch;
    }
  }
}

// ---------------------------------------------------------------------------
void setup() {
  // ILK IS: role hattini guvenli tarafa cakila. Seri porttan once gelir.
  relaySafeBoot();

  Serial.begin(115200);
  delay(300);
  Serial.println();
  Serial.printf("### %s ###\n", FW_VERSION);
  Serial.printf("acilis sebebi=%d\n", (int)esp_reset_reason());
  // KANIT SATIRI: kod calismadan once role hattinin seviyesi. ACTIVE LOW modulde
  // HIGH = role BIRAKMIS. Kabul testi bu satiri ve pad= alanini olcuyor.
  Serial.printf("ACILIS: role pini GPIO %d, kod oncesi seviye=%s (OFF=%s), simdi=%s\n", PIN_RELAY,
                boot_pad_level ? "HIGH" : "LOW", kombi::RELAY_LEVEL_OFF ? "HIGH" : "LOW",
                digitalRead(PIN_RELAY) ? "HIGH" : "LOW");

  // YUKSEK-1 kanit satiri: flash'lanmis kartta benzetim komutlarinin acik olup
  // olmadigi GOZLE gorulebilsin. SIM=1 ise USB'si eline gecen biri roleyi surebilir.
  Serial.printf("GUVENLIK: SIM=%d (benzetim komutlari %s), TLS_DOGRULAMA=%d\n", KOMBI_ALLOW_SIM,
                KOMBI_ALLOW_SIM ? "ACIK - yalniz gelistirme" : "KAPALI",
                ALLOW_INSECURE_TLS ? 0 : 1);

  settings = kombi::defaultSettings();
  if (store.begin()) {
    nvs_loaded = store.load(settings, rules);
    if (!nvs_loaded) {
      Serial.println(F("[NVS] gecerli kayit yok -> VARSAYILANLAR yazildi"));
      store.save(settings, rules);
    } else {
      Serial.printf("[NVS] yuklendi: hedef=%.1f bant=%.1f donma=%.1f manuel=%d kural=%u\n",
                    settings.target_c, settings.hysteresis_c, settings.freeze_guard_c,
                    settings.manual_mode ? 1 : 0, rules.count);
    }
  } else {
    Serial.println(F("[NVS] acilamadi — ayarlar kalici OLMAYACAK"));
  }

  ctrl.begin(settings, millis());
  ctrl.setRules(rules);
  applyRelay(false);  // cekirdek acilista isi istemez; hat zaten OFF
  relay_prev = false;

  sensor.begin();
  startWifi();
  if (wifi_enabled) {
    configTime(TZ_OFFSET_SEC, 0, NTP_SERVER_1, NTP_SERVER_2);
  }

  // Bekci kopegi: dongu 30 sn beslemezse kart sifirlanir (plan §5).
  esp_task_wdt_init(WDT_TIMEOUT_S, true);
  esp_task_wdt_add(NULL);

  Serial.printf("sensor=%s (GPIO %d), role GPIO %d, bulut=%s\n", sensor.name(), PIN_DHT, PIN_RELAY,
                cloud.configured() ? "ayarli" : "AYARSIZ (yalniz yerel)");
  Serial.println(F("hazir. 'help' yazin."));
}

void loop() {
  esp_task_wdt_reset();
  const uint32_t now = millis();

  if ((uint32_t)(now - last_sensor_ms) >= sensor.minIntervalMs()) {
    last_sensor_ms = now;
    const kombi::Reading r = sensor.read();
    if (r.valid) sensor_reads_ok++; else sensor_reads_fail++;
    const bool heat = ctrl.update(now, r, readClock());
    applyRelay(heat);
    if (ctrl.consumeEffectiveChanged()) {
      // DIKKAT: NVS'e YAZILMAZ. Kural TABAN hedefi degistirmiyor; yururlukteki
      // hedef her acilista kural listesinden yeniden hesaplanir (§K1/§K2).
      Serial.printf("[senaryo] yururlukteki hedef -> %.1f (taban %.1f, kaynak %s)\n",
                    ctrl.effectiveTarget(), ctrl.baseTarget(),
                    ctrl.ruleActive() ? "kural" : (ctrl.manualOverride() ? "elle" : "taban"));
    }
  }

  serviceWifi(now);
  serviceCloud(now);
  serviceConsole();

  if ((uint32_t)(now - last_status_ms) >= STATUS_PERIOD_MS) {
    last_status_ms = now;
    printStatus();
  }
  delay(20);
}
