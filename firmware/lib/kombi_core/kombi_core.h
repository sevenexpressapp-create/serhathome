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

// --- Sensorun olculmus sinirlari ----------------------------------------------
// Eldeki DHT11: cozunurluk 1.0 °C (tam sayi adim), mutlak hata ±2.0 °C.
// Salinim bandi quantization adiminin 2 katindan KUCUK olursa tek bir LSB
// sicramasi (21 -> 22 -> 21) roleyi surekli aciyor/kapatiyor. Yani alt sinir
// sensorun kendisinden tureme zorunda: 2 x 1.0 = 2.0 °C.
// Sensor DS18B20/SHT31'e gecince (cozunurluk 0.1-0.25 °C) yalniz bu iki sabit
// degisir; baska hicbir yerde bant siniri yazili DEGILDIR.
static const float SENSOR_RESOLUTION_C = 1.0f;                  // DHT11
static const float MIN_BAND_C = 2.0f * SENSOR_RESOLUTION_C;     // = 2.0
static const float MAX_BAND_C = 6.0f;

// Donma korumasi mandalinin BIRAKMA payi. BILINCLI olarak konfor bandindan
// (hysteresis_c) bagimsizdir: ikisi ilgisiz parametrelerdir. Eskiden bant
// kullaniliyordu ve bant 6 iken mandal hedefin cok uzerinde (18 °C'de)
// birakiyordu — bosa yakilan gaz. 1.0 °C = sensorun bir cozunurluk adimi,
// yani mandalin salinmayacagi EN KUCUK pay.
static const float FREEZE_RELEASE_MARGIN_C = SENSOR_RESOLUTION_C;

// Donma esigi hedefin altinda kalmak ZORUNDA; yoksa "donma korumasi" surekli
// devrede olur ve kullanici hedefini anlamsiz kilar (kullanici hedefi 5 iken
// donma esigi 12 olabiliyordu).
static const float FREEZE_BELOW_TARGET_MIN_C = 0.5f;

// Sensor arizasi sirasinda donma korumasinin kosmasina izin verilen pencere.
// Bu pencere icinde SON GECERLI okuma hala anlamli sayilir: tesisatin patlamasi
// "korlemesine isitma" riskinden agirdir. Pencere dolunca isi istegi kesilir.
static const uint32_t FREEZE_STALE_GRACE_MS = 30u * 60u * 1000u;  // 30 dk

// --- Veri tipleri -------------------------------------------------------------

struct Reading {
  bool valid = false;      // false = okuma basarisiz (NaN, zaman asimi, saticma deger)
  float temp_c = 0.0f;
  float humidity = 0.0f;
};

struct Settings {
  // DIKKAT: bu TABAN hedeftir (kullanici/panel/bulut/NVS ne dediyse o).
  // Saatli kural bu alani ASLA degistirmez; yururlukteki hedef
  // Controller::effectiveTarget() ile ayrica hesaplanir (bkz. §K1 notu).
  float target_c;
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
// DHT11'in cozunurlugu 1.0 °C ve mutlak hatasi ±2.0 °C (bkz. MIN_BAND_C).
// Tam bant 3.0 °C (hedef ±1.5 °C) — plan §3/G'nin "DHT11'de genis bant" karari.
Settings defaultSettings();

// NVS'ten/buluttan gelen ayari guvenli araliga CEKER. Bozuk NVS ya da hatali
// bulut kaydi "hedef 1000 °C" gibi bir degerle roleyi surekli cekili tutmasin.
// Donus: deger degistirildiyse true (cagiran taraf loglayabilir).
bool clampSettings(Settings& s);

// Kural setini dogrular; gecersiz kurallari (saat>23, dakika>59, bos gun maskesi,
// aralik disi hedef) ATAR ve kalanlari basa sikistirir. Donus: atilan kural sayisi.
uint8_t sanitizeRules(RuleSet& rs);

// --- Esitlik (bulut karsilastirmasi) -----------------------------------------
// Buluttan her turda ayni veri gelir; "degisti" sanilirsa her turda NVS yazilir
// (gunde ~17 bin yazma = flash asinmasi). Karsilastirma DOLU yuvalarla sinirli
// olmak zorunda: `memcmp(rules, ..., sizeof(rules))` bos yuvalarin cop baytlarini
// da okur ve her turda "farkli" der.
bool settingsEqual(const Settings& a, const Settings& b);
bool rulesEqual(const RuleSet& a, const RuleSet& b);

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

  // TABAN hedef: kullanicinin/bulutun yazdigi deger. NVS'e yazilan budur.
  float baseTarget() const { return settings_.target_c; }

  // YURURLUKTEKI hedef: saatli kural devredeyse onun hedefi, degilse taban.
  // §K1: kural artik taban hedefi EZMEZ. Eskiden kural `settings_.target_c`'yi
  // degistiriyordu; bulut bir sonraki turda "hedef degismis" diyip eski degeri
  // geri yaziyordu ve saatli senaryo YALNIZ internet kopukken calisiyordu.
  float effectiveTarget() const { return effective_target_c_; }

  // Yururlukteki hedef bir kuraldan mi geliyor? (panelde "su an neden 25?")
  bool ruleActive() const { return rule_active_; }
  uint8_t activeRuleHour() const { return active_rule_hour_; }
  uint8_t activeRuleMinute() const { return active_rule_minute_; }

  // Kural penceresi icindeyken kullanici/panel hedefi ELLE degistirdiyse taban
  // hedef kazanir ve BIR SONRAKI kural tetiklenene kadar yururlukte kalir.
  // (Bu olmasa "su an 17:00 kurali devrede" diye panelden hedef degistirmek
  // hicbir sey yapmiyor gorunurdu.)
  bool manualOverride() const { return override_active_; }

  bool sensorFault() const { return sensor_fault_; }
  bool hasReading() const { return has_reading_; }
  float lastTempC() const { return last_temp_c_; }
  float lastHumidity() const { return last_humidity_; }

  // Saat bilinmiyorken kural VARSA kurallar askidadir (plan §3, bilincli sinir).
  bool rulesSuspended() const { return rules_suspended_; }

  // Yururlukteki hedef degistiyse true doner ve bayragi TEMIZLER. YALNIZ
  // gunluge yazmak icindir — NVS yazmayi TETIKLEMEZ (taban hedef degismedi).
  bool consumeEffectiveChanged();

 private:
  bool decide(uint32_t now_ms);
  void applyRules(const Clock& c);
  // Saat gecerliyken "SU AN yururlukte olan" kurali bulur: bugunun (ve gerekirse
  // onceki gunlerin) uyan kurallari arasindan simdiye en yakin GECMIS olani.
  // Kenar tetikleme DEGIL — bu yuzden kacirilan dakika (elektrik kesintisi,
  // NTP sicramasi, 60 sn'den uzun dongu takilmasi) kurali dusurmez (§K2).
  // occ_minute: bulunan kural TETIKLENMESININ hafta-ici dakika damgasi
  // (weekday*1440 + saat*60 + dakika). Ayni tetiklenme yururlukte kaldigi
  // surece sabittir; elle gecersiz kilma (override) bununla takip edilir.
  int findActiveRule(const Clock& c, int32_t* occ_minute) const;
  void setHeat(bool on, uint32_t now_ms, bool arm_hold);

  Settings settings_ = defaultSettings();
  RuleSet rules_;

  bool heat_ = false;  // ACILIS DEGERI: isi istegi YOK (plan §5 "acilis ani")
  HeatReason reason_ = HeatReason::Boot;

  bool has_reading_ = false;
  bool sensor_fault_ = false;
  bool freeze_latched_ = false;
  bool rules_suspended_ = false;
  bool effective_changed_ = false;
  bool has_switched_ = false;  // ilk anahtarlama asgari beklemeye takilmasin
  // EMNIYET YOLUNDAN SONRA TEK SEFERLIK bekleme atlamasi. Emniyet kesmesi
  // (sensor arizasi / donma korumasi) bir KONFOR karari degildir; ariza
  // kalkinca ev soguksa isitmanin 5 dk daha beklemesi "emniyeti geciktirme"
  // degil "toparlanmayi cezalandirma"dir. Aralikli DHT11 arizasinda ev hic
  // isinmiyordu (kod denetimi Y3). Bayrak ilk konfor anahtarlamasinda duser.
  bool safety_recovery_ = false;

  float effective_target_c_ = 21.0f;
  bool rule_active_ = false;
  uint8_t active_rule_hour_ = 0;
  uint8_t active_rule_minute_ = 0;

  // Elle gecersiz kilma takibi (bkz. manualOverride()).
  bool override_active_ = false;
  int32_t cur_rule_key_ = -1;  // yururlukteki tetiklenmenin kimligi
  int32_t cur_rule_age_ = -1;  // o tetiklenmenin yasi, dakika
  int32_t ovr_rule_key_ = -1;
  int32_t ovr_rule_age_ = -1;

  float last_temp_c_ = 0.0f;
  float last_humidity_ = 0.0f;

  uint32_t begin_ms_ = 0;
  uint32_t last_good_ms_ = 0;
  uint32_t last_switch_ms_ = 0;
};

// --- Buluttan gelen durumun uygulanmasi --------------------------------------
// main.cpp ile olcum kosumu (tools/core_cli) AYNI mantigi kullansin diye
// cekirdekte: gelen ayar/kural KIRPILIR, sonra mevcutla karsilastirilir ve
// yalniz GERCEKTEN degistiyse uygulanir. `needs_persist` true ise NVS yazilir.
struct CloudApply {
  bool settings_changed = false;
  bool rules_changed = false;
  bool needs_persist = false;
};
CloudApply applyCloudState(Controller& ctrl, RuleSet& rules, const Settings* new_settings,
                           const RuleSet* new_rules);

// --- Bulut yoklama takvimi ---------------------------------------------------
// Basari periyodu ile geri cekilme (backoff) AYRI tutulur. Eskiden `due()`
// backoff'u normal periyot olarak kullaniyordu: basarida 5 sn'ye donuyor,
// yani 17.280 cagri/gun ≈ 518.000/ay — Supabase ucretsiz tavani 500.000.
inline uint32_t elapsed(uint32_t now_ms, uint32_t since_ms) {
  return (uint32_t)(now_ms - since_ms);
}

inline bool cloudDue(bool first_done, bool last_ok, uint32_t now_ms, uint32_t last_attempt_ms,
                     uint32_t period_ms, uint32_t backoff_ms) {
  if (!first_done) return true;
  return elapsed(now_ms, last_attempt_ms) >= (last_ok ? period_ms : backoff_ms);
}

}  // namespace kombi
