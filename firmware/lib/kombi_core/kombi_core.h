// kombi_core.h — Termostat + senaryo karar cekirdegi.
//
// Bu dosya BILINCLI olarak Arduino/ESP-IDF'den bagimsizdir: tek bir #include
// bile platforma bagli degil. Sebep: karar mantigi (histerezis, donma korumasi,
// sensor arizasi, saatli kurallar) karta flash'lanmadan, makinede `pio test -e native`
// ile olculebilsin. Donanim tarafi (GPIO, WiFi, NVS, HTTP) src/main.cpp'de.
//
// Plan: shared/memory/plan/kombi-kontrol.md §2 (karar cihazda), §5 (emniyet tablosu).
#pragma once

#include <stdint.h>
#include <stddef.h>

namespace kombi {

// Senaryo kurali ust siniri. 12 = gunde ~2 kural x 7 gun icin fazlasiyla yeterli,
// NVS blob'u kucuk tutar (12 * 8 bayt = 96 bayt).
static const uint8_t MAX_RULES = 12;

// --- Rolenin elektriksel yonu -------------------------------------------------
// Eldeki role modulu ACTIVE LOW: GPIO LOW = role ceker (kuru kontak kapanir).
// Bu iki sabit tek kaynaktir; main.cpp ve testler ayni sabiti kullanir ki
// "acilista role cekmez" iddiasi tek yerden olculebilsin.
static const int RELAY_LEVEL_ON = 0;   // LOW  -> role cekili (isi istegi VAR)
static const int RELAY_LEVEL_OFF = 1;  // HIGH -> role birakmis (isi istegi YOK)

// Isi istegi bool'unu pin seviyesine cevirir. Tek dogru yer burasi.
inline int relayLevelFor(bool heat_requested) {
  return heat_requested ? RELAY_LEVEL_ON : RELAY_LEVEL_OFF;
}

// --- Veri tipleri -------------------------------------------------------------

struct Reading {
  bool valid = false;      // false = okuma basarisiz (NaN, zaman asimi, saticma deger)
  float temp_c = 0.0f;
  float humidity = 0.0f;
};

struct Settings {
  float target_c;            // hedef oda sicakligi
  float hysteresis_c;        // TAM bant genisligi (bkz. defaultSettings yorumu)
  float freeze_guard_c;      // bu derecenin altinda hedeften bagimsiz ZORLA isit
  bool manual_mode;          // true = saatli kurallar tamamen durur
  uint16_t min_relay_hold_s; // role iki anahtarlama arasi asgari bekleme
  uint16_t sensor_timeout_s; // bu sure gecerli okuma gelmezse SENSOR ARIZASI
};

struct Rule {
  bool enabled;
  uint8_t days_mask;  // bit0=Pazar, bit1=Pazartesi ... bit6=Cumartesi
  uint8_t hour;       // 0-23
  uint8_t minute;     // 0-59
  float target_c;
};

struct RuleSet {
  Rule rules[MAX_RULES];
  uint8_t count = 0;
};

// NTP'den gelen duvar saati. valid=false => saat BILINMIYOR.
struct Clock {
  bool valid = false;
  uint8_t weekday = 0;  // 0=Pazar
  uint8_t hour = 0;
  uint8_t minute = 0;
};

enum class HeatReason : uint8_t {
  Boot = 0,        // henuz gecerli okuma yok -> guvenli taraf: kapali
  SensorFault = 1, // okuma yok/bozuk -> isi istegi KESILDI
  FreezeGuard = 2, // oda donma esiginin altinda -> ZORLA isit
  BelowBand = 3,   // hedef bandinin altinda -> isit
  AboveBand = 4,   // hedef bandinin ustunde -> kes
  InBand = 5,      // bant icinde -> mevcut durumu koru (salinim onleme)
  MinHold = 6,     // histerezis degisim istedi ama asgari bekleme dolmadi
};

const char* reasonName(HeatReason r);

// --- Varsayilanlar ve dogrulama ----------------------------------------------

// Varsayilan ayarlar. hysteresis_c = 3.0 secimi OLCULEBILIR bir gerekceye dayanir:
// elimizdeki DHT11'in cozunurlugu 1.0 °C (tam sayi adimlarla raporlar) ve
// mutlak hatasi ±2.0 °C. Bant genisligi quantization adiminin 2 katindan KUCUK
// olursa tek bir LSB sicramasi (21 -> 22 -> 21) roleyi surekli aciyor/kapatiyor;
// yani 1.0-1.5 °C'lik bant DHT11 ile olculemez, sahte salinim uretir.
// Bu yuzden tam bant 3.0 °C (hedef ±1.5 °C) — plan §3/G'nin "DHT11'de geniS bant
// ±1.5-2 °C" karari. Sensor DS18B20/SHT31'e gecince (plan §7) bant ~1.0 °C'ye
// (±0.5) daraltilacak; degeri degistirmek icin KOD degil ayar yeterli.
Settings defaultSettings();

// NVS'ten/buluttan gelen ayari guvenli araliga CEKER. Bozuk NVS ya da hatali
// bulut kaydi "hedef 1000 °C" gibi bir degerle roleyi surekli cekili tutmasin.
// Donus: deger degistirildiyse true (cagiran taraf loglayabilir).
bool clampSettings(Settings& s);

// Kural setini dogrular; gecersiz kurallari (saat>23, dakika>59, bos gun maskesi,
// aralik disi hedef) ATAR ve kalanlari basa sikistirir. Donus: atilan kural sayisi.
uint8_t sanitizeRules(RuleSet& rs);


// --- Kalici hafiza (NVS) icin paketleme ---------------------------------------
// Ayarlar + kurallar tek bir bayt blobuna yazilir: sihirli sayi + surum + CRC16.
// Amac: elektrik kesintisinden sonra hedefin geri gelmesi (plan §4 Faz 1 kabul)
// ve BOZUK/yarim yazilmis kaydin sessizce kabul edilmemesi. Paketleme cekirdekte
// durur ki NVS'e dokunmadan, makinede gidis-donus testi yazilabilsin.
static const uint16_t BLOB_MAGIC = 0x4B42;  // 'KB'
static const uint8_t BLOB_VERSION = 1;
static const size_t BLOB_MAX = 8 + 16 + 2 + MAX_RULES * 8 + 2;

// Donus: yazilan bayt sayisi, kapasite yetmezse 0.
size_t packState(const Settings& s, const RuleSet& rs, uint8_t* out, size_t out_cap);

// Donus: false => blob yok/kisa/sihirli sayi veya CRC uyusmuyor/surum bilinmiyor.
// false donerse cagiran taraf VARSAYILANLARA doner (sessizce bozuk deger kullanmaz).
bool unpackState(const uint8_t* in, size_t len, Settings& s, RuleSet& rs);

uint16_t crc16(const uint8_t* data, size_t len);

// --- Kontrolcu ---------------------------------------------------------------

class Controller {
 public:
  // now_ms: monotonik milisaniye (ESP32'de millis(), testte sahte saat).
  void begin(const Settings& s, uint32_t now_ms);

  void setSettings(const Settings& s);  // bulut/dashboard ayar degisikligi
  void setRules(const RuleSet& rs);

  // Her donguden cagrilir. Donus: isi istegi (true = role cekilsin).
  bool update(uint32_t now_ms, const Reading& r, const Clock& c);

  bool heatRequested() const { return heat_; }
  int relayLevel() const { return relayLevelFor(heat_); }
  HeatReason reason() const { return reason_; }
  const Settings& settings() const { return settings_; }
  float effectiveTarget() const { return settings_.target_c; }

  bool sensorFault() const { return sensor_fault_; }
  bool hasReading() const { return has_reading_; }
  float lastTempC() const { return last_temp_c_; }
  float lastHumidity() const { return last_humidity_; }

  // Saat bilinmiyorken kural VARSA kurallar askidadir (plan §3, bilincli sinir).
  bool rulesSuspended() const { return rules_suspended_; }

  // Bir senaryo kurali hedefi degistirdiyse true doner ve bayragi TEMIZLER.
  // main.cpp bunu gorunce yeni hedefi NVS'e yazar.
  bool consumeTargetChanged();

 private:
  bool decide(uint32_t now_ms);
  void applyRules(uint32_t now_ms, const Clock& c);

  Settings settings_ = defaultSettings();
  RuleSet rules_;

  bool heat_ = false;  // ACILIS DEGERI: isi istegi YOK (plan §5 "acilis ani")
  HeatReason reason_ = HeatReason::Boot;

  bool has_reading_ = false;
  bool sensor_fault_ = false;
  bool freeze_latched_ = false;
  bool rules_suspended_ = false;
  bool target_changed_ = false;
  bool has_switched_ = false;  // ilk anahtarlama asgari beklemeye takilmasin

  float last_temp_c_ = 0.0f;
  float last_humidity_ = 0.0f;

  uint32_t begin_ms_ = 0;
  uint32_t last_good_ms_ = 0;
  uint32_t last_switch_ms_ = 0;
  int32_t last_rule_key_ = -1;    // bu dakika icinde kural uygulandi mi
  int32_t last_seen_minute_ = -1; // gun*10000 + saat*100 + dakika; degisince kilit acilir
};

// Monotonik sayacin tasmasina (49.7 gun) dayanikli fark.
inline uint32_t elapsed(uint32_t now_ms, uint32_t since_ms) {
  return (uint32_t)(now_ms - since_ms);
}

}  // namespace kombi
