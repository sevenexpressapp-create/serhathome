#include "kombi_core.h"

#include <string.h>  // memcpy — standart C, platforma bagli degil

namespace kombi {

// NaN kontrolu icin <cmath> yerine standart ozdeslik hilesi: NaN kendine esit degil.
// Boylece cekirdek hicbir platform basligina bagli kalmiyor.
static inline bool isNan(float v) { return !(v == v); }

static inline float clampf(float v, float lo, float hi, bool& changed) {
  if (isNan(v)) { changed = true; return lo; }
  if (v < lo) { changed = true; return lo; }
  if (v > hi) { changed = true; return hi; }
  return v;
}

static inline uint16_t clampu16(uint16_t v, uint16_t lo, uint16_t hi, bool& changed) {
  if (v < lo) { changed = true; return lo; }
  if (v > hi) { changed = true; return hi; }
  return v;
}

const char* reasonName(HeatReason r) {
  switch (r) {
    case HeatReason::Boot: return "boot";
    case HeatReason::SensorFault: return "sensor_fault";
    case HeatReason::FreezeGuard: return "freeze_guard";
    case HeatReason::BelowBand: return "below_band";
    case HeatReason::AboveBand: return "above_band";
    case HeatReason::InBand: return "in_band";
    case HeatReason::MinHold: return "min_hold";
  }
  return "unknown";
}

Settings defaultSettings() {
  Settings s;
  s.target_c = 21.0f;
  s.hysteresis_c = 3.0f;     // gerekce: kombi_core.h'deki yorum (DHT11 1 °C cozunurluk)
  s.freeze_guard_c = 6.0f;   // plan §5: oda < 6 °C ise hedeften bagimsiz zorla isit
  s.manual_mode = false;
  s.min_relay_hold_s = 300;  // 5 dk: kombiyi sik ac-kapa yipratmasin
  s.sensor_timeout_s = 120;  // DHT11 2 sn'de bir okunur -> 60 ardisik basarisizlik
  return s;
}

bool clampSettings(Settings& s) {
  bool changed = false;
  // Araliklar ev termostadi icin makul sinirlar; ustten sinir "bozuk kayit roleyi
  // surekli cekili tutmasin" diye var (plan §5 "role istekte takildi" satirinin
  // yazilim tarafi).
  s.target_c = clampf(s.target_c, 5.0f, 30.0f, changed);
  s.hysteresis_c = clampf(s.hysteresis_c, 0.5f, 6.0f, changed);
  s.freeze_guard_c = clampf(s.freeze_guard_c, 4.0f, 12.0f, changed);
  s.min_relay_hold_s = clampu16(s.min_relay_hold_s, 0, 1800, changed);
  s.sensor_timeout_s = clampu16(s.sensor_timeout_s, 10, 3600, changed);
  return changed;
}

uint8_t sanitizeRules(RuleSet& rs) {
  uint8_t dropped = 0;
  uint8_t out = 0;
  if (rs.count > MAX_RULES) { dropped = (uint8_t)(rs.count - MAX_RULES); rs.count = MAX_RULES; }
  for (uint8_t i = 0; i < rs.count; i++) {
    const Rule& r = rs.rules[i];
    bool ok = r.hour <= 23 && r.minute <= 59 && (r.days_mask & 0x7F) != 0 &&
              !isNan(r.target_c) && r.target_c >= 5.0f && r.target_c <= 30.0f;
    if (!ok) { dropped++; continue; }
    rs.rules[out] = r;
    rs.rules[out].days_mask &= 0x7F;
    out++;
  }
  rs.count = out;
  return dropped;
}


// --- Kalici hafiza paketlemesi -----------------------------------------------

uint16_t crc16(const uint8_t* data, size_t len) {
  // CRC-16/CCITT-FALSE. Amac kriptografik degil: yarim/bozuk NVS kaydini yakalamak.
  uint16_t crc = 0xFFFF;
  for (size_t i = 0; i < len; i++) {
    crc ^= (uint16_t)data[i] << 8;
    for (int b = 0; b < 8; b++) {
      crc = (crc & 0x8000) ? (uint16_t)((crc << 1) ^ 0x1021) : (uint16_t)(crc << 1);
    }
  }
  return crc;
}

static void putF(uint8_t*& p, float v) { memcpy(p, &v, 4); p += 4; }
static void putU16(uint8_t*& p, uint16_t v) { p[0] = (uint8_t)(v & 0xFF); p[1] = (uint8_t)(v >> 8); p += 2; }
static void putU8(uint8_t*& p, uint8_t v) { *p++ = v; }
static float getF(const uint8_t*& p) { float v; memcpy(&v, p, 4); p += 4; return v; }
static uint16_t getU16(const uint8_t*& p) { uint16_t v = (uint16_t)p[0] | (uint16_t)((uint16_t)p[1] << 8); p += 2; return v; }
static uint8_t getU8(const uint8_t*& p) { return *p++; }

size_t packState(const Settings& s, const RuleSet& rs, uint8_t* out, size_t out_cap) {
  const size_t need = 3 + 3 * 4 + 1 + 2 + 2 + 1 + (size_t)rs.count * 8 + 2;
  if (out_cap < need) return 0;
  uint8_t* p = out;
  putU16(p, BLOB_MAGIC);
  putU8(p, BLOB_VERSION);
  putF(p, s.target_c);
  putF(p, s.hysteresis_c);
  putF(p, s.freeze_guard_c);
  putU8(p, s.manual_mode ? 1 : 0);
  putU16(p, s.min_relay_hold_s);
  putU16(p, s.sensor_timeout_s);
  putU8(p, rs.count);
  for (uint8_t i = 0; i < rs.count; i++) {
    putU8(p, rs.rules[i].enabled ? 1 : 0);
    putU8(p, rs.rules[i].days_mask);
    putU8(p, rs.rules[i].hour);
    putU8(p, rs.rules[i].minute);
    putF(p, rs.rules[i].target_c);
  }
  const size_t body = (size_t)(p - out);
  putU16(p, crc16(out, body));
  return body + 2;
}

bool unpackState(const uint8_t* in, size_t len, Settings& s, RuleSet& rs) {
  if (in == 0 || len < 3 + 3 * 4 + 1 + 2 + 2 + 1 + 2) return false;
  const uint8_t* p = in;
  if (getU16(p) != BLOB_MAGIC) return false;
  if (getU8(p) != BLOB_VERSION) return false;

  Settings t = defaultSettings();
  t.target_c = getF(p);
  t.hysteresis_c = getF(p);
  t.freeze_guard_c = getF(p);
  t.manual_mode = getU8(p) != 0;
  t.min_relay_hold_s = getU16(p);
  t.sensor_timeout_s = getU16(p);
  const uint8_t count = getU8(p);
  if (count > MAX_RULES) return false;

  const size_t need = (size_t)(p - in) + (size_t)count * 8 + 2;
  if (len < need) return false;

  RuleSet tr;
  tr.count = count;
  for (uint8_t i = 0; i < count; i++) {
    tr.rules[i].enabled = getU8(p) != 0;
    tr.rules[i].days_mask = getU8(p);
    tr.rules[i].hour = getU8(p);
    tr.rules[i].minute = getU8(p);
    tr.rules[i].target_c = getF(p);
  }
  const size_t body = (size_t)(p - in);
  const uint16_t stored = getU16(p);
  if (stored != crc16(in, body)) return false;

  clampSettings(t);
  sanitizeRules(tr);
  s = t;
  rs = tr;
  return true;
}

void Controller::begin(const Settings& s, uint32_t now_ms) {
  settings_ = s;
  clampSettings(settings_);
  // ACILIS DURUMU — plan §5 "acilis ani (elektrik gelince) role istemsiz cekmez":
  // cekirdek her zaman "isi istegi YOK" ile baslar. Role pininin fiziksel
  // seviyesi de main.cpp'de pinMode'dan ONCE OFF'a cakilir.
  heat_ = false;
  reason_ = HeatReason::Boot;
  has_reading_ = false;
  sensor_fault_ = false;
  freeze_latched_ = false;
  rules_suspended_ = false;
  target_changed_ = false;
  has_switched_ = false;
  begin_ms_ = now_ms;
  last_good_ms_ = now_ms;
  last_switch_ms_ = now_ms;
  last_rule_key_ = -1;
  last_seen_minute_ = -1;
}

void Controller::setSettings(const Settings& s) {
  settings_ = s;
  clampSettings(settings_);
}

void Controller::setRules(const RuleSet& rs) {
  rules_ = rs;
  sanitizeRules(rules_);
}

bool Controller::consumeTargetChanged() {
  bool v = target_changed_;
  target_changed_ = false;
  return v;
}

void Controller::applyRules(uint32_t /*now_ms*/, const Clock& c) {
  // Manuel mod: saatli kurallar TAMAMEN durur (plan §2 "kalici manuel mod").
  if (settings_.manual_mode || rules_.count == 0) {
    rules_suspended_ = false;
    return;
  }
  // Saat bilinmiyorsa kurallar ASKIDA — yanlis saatte kombi tetiklemektense hic
  // tetiklememek (plan §3, bilincli sinir). Termostat son hedefle surer.
  if (!c.valid) {
    rules_suspended_ = true;
    return;
  }
  rules_suspended_ = false;

  const int32_t minute_key = (int32_t)c.weekday * 10000 + (int32_t)c.hour * 100 + (int32_t)c.minute;
  if (minute_key != last_seen_minute_) {
    last_seen_minute_ = minute_key;
    last_rule_key_ = -1;  // yeni dakika -> tetikleme kilidi acilir
  }
  if (last_rule_key_ == minute_key) return;  // bu dakika zaten uygulandi

  // Cakisma kurali (plan §2): listedeki SON uyan kural kazanir.
  int match = -1;
  for (uint8_t i = 0; i < rules_.count; i++) {
    const Rule& r = rules_.rules[i];
    if (!r.enabled) continue;
    if (((r.days_mask >> c.weekday) & 0x01) == 0) continue;
    if (r.hour != c.hour || r.minute != c.minute) continue;
    match = i;
  }
  if (match < 0) return;

  last_rule_key_ = minute_key;
  if (settings_.target_c != rules_.rules[match].target_c) {
    settings_.target_c = rules_.rules[match].target_c;
    clampSettings(settings_);
    target_changed_ = true;  // main.cpp bunu gorup NVS'e yazar
  }
}

bool Controller::decide(uint32_t now_ms) {
  // 1) Henuz hic gecerli okuma yok: guvenli taraf kapali.
  if (!has_reading_) {
    reason_ = sensor_fault_ ? HeatReason::SensorFault : HeatReason::Boot;
    if (heat_) { heat_ = false; has_switched_ = true; last_switch_ms_ = now_ms; }
    return heat_;
  }

  // 2) Sensor arizasi: korlemesine isitmak da riskli -> ISI ISTEGI KESILIR.
  //    Asgari bekleme suresini BILINCLI olarak atlar; emniyet geciktirilmez.
  if (sensor_fault_) {
    reason_ = HeatReason::SensorFault;
    if (heat_) { heat_ = false; has_switched_ = true; last_switch_ms_ = now_ms; }
    return heat_;
  }

  // 3) Donma korumasi: esigin altinda ZORLA isit, bant kadar isinana dek birakma.
  //    Mandal (latch) salinimi engeller; bu da asgari beklemeyi atlar (emniyet).
  if (last_temp_c_ < settings_.freeze_guard_c) {
    freeze_latched_ = true;
  } else if (freeze_latched_ && last_temp_c_ >= settings_.freeze_guard_c + settings_.hysteresis_c) {
    freeze_latched_ = false;
  }
  if (freeze_latched_) {
    reason_ = HeatReason::FreezeGuard;
    if (!heat_) { heat_ = true; has_switched_ = true; last_switch_ms_ = now_ms; }
    return heat_;
  }

  // 4) Normal histerezis.
  const float half = settings_.hysteresis_c * 0.5f;
  const float on_at = settings_.target_c - half;
  const float off_at = settings_.target_c + half;

  bool want = heat_;
  HeatReason r = HeatReason::InBand;
  if (last_temp_c_ <= on_at) { want = true; r = HeatReason::BelowBand; }
  else if (last_temp_c_ >= off_at) { want = false; r = HeatReason::AboveBand; }

  // 5) Asgari bekleme: histerezis degisim istiyor ama role yeni anahtarlandiysa bekle.
  if (want != heat_ && has_switched_ &&
      elapsed(now_ms, last_switch_ms_) < (uint32_t)settings_.min_relay_hold_s * 1000u) {
    reason_ = HeatReason::MinHold;
    return heat_;
  }

  if (want != heat_) {
    heat_ = want;
    has_switched_ = true;
    last_switch_ms_ = now_ms;
  }
  reason_ = r;
  return heat_;
}

bool Controller::update(uint32_t now_ms, const Reading& r, const Clock& c) {
  // Sensor izleme. Gecersiz okuma tek basina ariza degildir; ariza "sensor_timeout_s
  // boyunca HIC gecerli okuma gelmemesi"dir (tek bir DHT11 zaman asimi normaldir).
  if (r.valid && !isNan(r.temp_c)) {
    has_reading_ = true;
    last_good_ms_ = now_ms;
    last_temp_c_ = r.temp_c;
    last_humidity_ = r.humidity;
  }
  const uint32_t age = has_reading_ ? elapsed(now_ms, last_good_ms_) : elapsed(now_ms, begin_ms_);
  sensor_fault_ = age > (uint32_t)settings_.sensor_timeout_s * 1000u;

  applyRules(now_ms, c);
  return decide(now_ms);
}

}  // namespace kombi
