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
  s.hysteresis_c = 3.0f;     // gerekce: kombi_core.h'deki MIN_BAND_C yorumu
  s.freeze_guard_c = 6.0f;   // plan §5: oda < 6 °C ise hedeften bagimsiz zorla isit
  s.manual_mode = false;
  s.min_relay_hold_s = 300;  // 5 dk: kombiyi sik ac-kapa yipratmasin
  // DHT11 2 sn'de bir okunur ve ARALIKLI kacirmasi normaldir. 10 sn (eski taban)
  // = 5 kacan okuma "ariza" sayilirdi; isi kesilir ve donma korumasi devre disi
  // kalirdi. 60 sn alt sinir = en az 30 ardisik basarisizlik.
  s.sensor_timeout_s = 120;
  return s;
}

bool clampSettings(Settings& s) {
  bool changed = false;
  // Araliklar ev termostadi icin makul sinirlar; ustten sinir "bozuk kayit roleyi
  // surekli cekili tutmasin" diye var (plan §5 "role istekte takildi" satirinin
  // yazilim tarafi).
  s.target_c = clampf(s.target_c, 5.0f, 30.0f, changed);
  s.hysteresis_c = clampf(s.hysteresis_c, MIN_BAND_C, MAX_BAND_C, changed);
  s.freeze_guard_c = clampf(s.freeze_guard_c, 4.0f, 12.0f, changed);
  // Donma esigi HEDEFIN ALTINDA kalmak zorunda (aksi halde zorla isitma
  // kullanici hedefini anlamsiz kilar). Ayni kisit semada da var:
  // device_settings.freeze_guard_c <= target_c - 0.5
  const float freeze_max = s.target_c - FREEZE_BELOW_TARGET_MIN_C;
  if (s.freeze_guard_c > freeze_max) { s.freeze_guard_c = freeze_max; changed = true; }
  s.min_relay_hold_s = clampu16(s.min_relay_hold_s, 0, 1800, changed);
  s.sensor_timeout_s = clampu16(s.sensor_timeout_s, 60, 3600, changed);
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

bool settingsEqual(const Settings& a, const Settings& b) {
  return a.target_c == b.target_c && a.hysteresis_c == b.hysteresis_c &&
         a.freeze_guard_c == b.freeze_guard_c && a.manual_mode == b.manual_mode &&
         a.min_relay_hold_s == b.min_relay_hold_s && a.sensor_timeout_s == b.sensor_timeout_s;
}

bool rulesEqual(const RuleSet& a, const RuleSet& b) {
  if (a.count != b.count) return false;
  // YALNIZ dolu yuvalar. `memcmp` tum diziyi okudugu icin bos yuvalardaki
  // belirsiz baytlar her turda "farkli" dedirtiyordu (olculdu: default-init
  // sonrasi 96/96 bayt sifir-olmayan) ve her turda NVS yaziliyordu.
  for (uint8_t i = 0; i < a.count; i++) {
    const Rule& x = a.rules[i];
    const Rule& y = b.rules[i];
    if (x.enabled != y.enabled || x.days_mask != y.days_mask || x.hour != y.hour ||
        x.minute != y.minute || x.target_c != y.target_c) {
      return false;
    }
  }
  return true;
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
  effective_changed_ = false;
  has_switched_ = false;
  safety_recovery_ = false;
  effective_target_c_ = settings_.target_c;
  rule_active_ = false;
  active_rule_hour_ = 0;
  active_rule_minute_ = 0;
  override_active_ = false;
  cur_rule_key_ = -1;
  cur_rule_age_ = -1;
  ovr_rule_key_ = -1;
  ovr_rule_age_ = -1;
  begin_ms_ = now_ms;
  last_good_ms_ = now_ms;
  last_switch_ms_ = now_ms;
}

void Controller::setSettings(const Settings& s) {
  const float old_target = settings_.target_c;
  settings_ = s;
  clampSettings(settings_);
  if (settings_.target_c != old_target) {
    // ELLE (panel/konsol/bulut) hedef degisikligi: yururlukteki kural
    // tetiklenmesini gecersiz kil. Bir sonraki kural tetiklendiginde (ya da
    // ayni kural yeniden tetiklendiginde) otomatik olarak duser.
    override_active_ = true;
    ovr_rule_key_ = cur_rule_key_;
    ovr_rule_age_ = cur_rule_age_;
  }
  // Taban hedef degisti; kural devrede degilse yururlukteki hedef de hemen
  // guncellenmeli (bir sonraki update() zaten yeniden hesaplar, ama panelden
  // gelen degisiklik aninda gorunsun).
  if (!rule_active_ || override_active_) effective_target_c_ = settings_.target_c;
}

void Controller::setRules(const RuleSet& rs) {
  rules_ = rs;
  sanitizeRules(rules_);
}

bool Controller::consumeEffectiveChanged() {
  bool v = effective_changed_;
  effective_changed_ = false;
  return v;
}

int Controller::findActiveRule(const Clock& c, int32_t* occ_minute) const {
  const int now_min = (int)c.hour * 60 + (int)c.minute;
  // Gun gun GERIYE git: bugunun gecmis kurallari, yoksa dunun, ... en cok 7 gun.
  // Ilk eslesen gun kazanir; o gun icinde EN SON saat, esitlikte listedeki
  // SON kural kazanir (plan §2 cakisma kurali).
  //
  // Neden geriye? "17:00 -> 25" kurali 17:00'de bir kez tetiklenip bitmez;
  // ERTESI kural gelene kadar YURURLUKTEDIR. Kenar tetikleme (hour==... &&
  // minute==...) elektrik kesintisinde, NTP sicramasinda ya da 60 sn'den uzun
  // bir dongu takilmasinda kurali tamamen DUSURUYORDU (§K2).
  for (int back = 0; back < 7; back++) {
    const int wd = ((int)c.weekday - back + 7) % 7;
    int best = -1;
    int best_min = -1;
    for (uint8_t i = 0; i < rules_.count; i++) {
      const Rule& r = rules_.rules[i];
      if (!r.enabled) continue;
      if (((r.days_mask >> wd) & 0x01) == 0) continue;
      const int rm = (int)r.hour * 60 + (int)r.minute;
      if (back == 0 && rm > now_min) continue;  // bugun henuz gelmedi
      if (rm >= best_min) { best_min = rm; best = (int)i; }
    }
    if (best >= 0) {
      if (occ_minute) *occ_minute = (int32_t)wd * 1440 + (int32_t)best_min;
      return best;
    }
  }
  if (occ_minute) *occ_minute = -1;
  return -1;
}

void Controller::applyRules(const Clock& c) {
  const float before = effective_target_c_;
  const bool rule_before = rule_active_;

  // Manuel mod: saatli kurallar TAMAMEN durur (plan §2 "kalici manuel mod").
  if (settings_.manual_mode || rules_.count == 0) {
    rules_suspended_ = false;
    rule_active_ = false;
    cur_rule_key_ = -1;
    cur_rule_age_ = -1;
    override_active_ = false;  // gecersiz kilinacak kural yok
    effective_target_c_ = settings_.target_c;
  } else if (!c.valid) {
    // Saat bilinmiyorsa kurallar ASKIDA — yanlis saatte kombi tetiklemektense hic
    // tetiklememek (plan §3, bilincli sinir). Termostat TABAN hedefle surer.
    rules_suspended_ = true;
    rule_active_ = false;
    effective_target_c_ = settings_.target_c;
  } else {
    rules_suspended_ = false;
    int32_t occ = -1;
    const int idx = findActiveRule(c, &occ);
    const int32_t now_abs = (int32_t)c.weekday * 1440 + (int32_t)c.hour * 60 + (int32_t)c.minute;
    const int32_t key = idx < 0 ? -1 : ((int32_t)idx * 10080 + occ);
    const int32_t age = idx < 0 ? -1 : ((now_abs - occ) + 10080) % 10080;

    // Elle gecersiz kilma yalniz O TETIKLENME icin gecerlidir.
    if (override_active_) {
      if (key != ovr_rule_key_) override_active_ = false;          // baska kural devrede
      else if (age >= 0 && ovr_rule_age_ >= 0 && age < ovr_rule_age_)
        override_active_ = false;                                   // ayni kural YENIDEN tetiklendi
    }
    cur_rule_key_ = key;
    cur_rule_age_ = age;

    if (idx < 0 || override_active_) {
      rule_active_ = false;
      effective_target_c_ = settings_.target_c;
    } else {
      rule_active_ = true;
      active_rule_hour_ = rules_.rules[idx].hour;
      active_rule_minute_ = rules_.rules[idx].minute;
      effective_target_c_ = rules_.rules[idx].target_c;
      // Kural hedefi de guvenli aralikta olmali (sanitizeRules zaten suzuyor,
      // bu ikinci kapi: kural listesi baska bir yoldan gelirse de tutar).
      if (effective_target_c_ < 5.0f) effective_target_c_ = 5.0f;
      if (effective_target_c_ > 30.0f) effective_target_c_ = 30.0f;
    }
  }

  if (effective_target_c_ != before || rule_active_ != rule_before) effective_changed_ = true;
}

void Controller::setHeat(bool on, uint32_t now_ms, bool arm_hold) {
  if (heat_ == on) return;
  heat_ = on;
  // arm_hold=false: EMNIYET yolu (sensor arizasi / donma korumasi). Bu yollar
  // asgari beklemeyi atlar AMA bekleme saatini de SIFIRLAMAZ. Eskiden ariza
  // dali her donguda `last_switch_ms_`i yeniliyordu; ariza kalkinca ev soguk
  // olsa bile role 5 dk daha kilitli kaliyordu (ve DHT11 aralikli ariza
  // verirse hic acilmiyordu). Emniyet geciktirilmez, toparlanma cezalandirilmaz.
  if (arm_hold) {
    has_switched_ = true;
    last_switch_ms_ = now_ms;
    safety_recovery_ = false;  // konfor anahtarlamasi: tek seferlik izin tukendi
  } else {
    safety_recovery_ = true;   // emniyet anahtarlamasi: donusu bekletme
  }
}

bool Controller::decide(uint32_t now_ms) {
  // 1) Henuz hic gecerli okuma yok: guvenli taraf kapali.
  if (!has_reading_) {
    reason_ = sensor_fault_ ? HeatReason::SensorFault : HeatReason::Boot;
    setHeat(false, now_ms, false);
    return heat_;
  }

  const bool freeze_demand =
      last_temp_c_ < settings_.freeze_guard_c ||
      (freeze_latched_ && last_temp_c_ < settings_.freeze_guard_c + FREEZE_RELEASE_MARGIN_C);

  // 2) Sensor arizasi: korlemesine isitmak riskli -> kural olarak ISI ISTEGI KESILIR.
  //    TEK ISTISNA: son gecerli okuma hala TAZE (<30 dk) ve o okuma donma
  //    esiginin altindaysa donma korumasi kosar. Tesisatin patlamasi, 30 dk'lik
  //    bir okumaya guvenmekten agir bir hasardir. Pencere dolunca isi kesilir.
  if (sensor_fault_) {
    const bool fresh = elapsed(now_ms, last_good_ms_) < FREEZE_STALE_GRACE_MS;
    if (fresh && freeze_demand) {
      freeze_latched_ = true;
      reason_ = HeatReason::FreezeGuard;
      setHeat(true, now_ms, false);
      return heat_;
    }
    reason_ = HeatReason::SensorFault;
    setHeat(false, now_ms, false);
    return heat_;
  }

  // 3) Donma korumasi: esigin altinda ZORLA isit, BIRAKMA PAYI kadar isinana dek
  //    birakma. Pay konfor bandindan DEGIL, sensorun cozunurlugunden gelir
  //    (FREEZE_RELEASE_MARGIN_C) — bant 6 iken mandalin 18 °C'de birakmasi
  //    (hedef 5 iken) bosa yakilan gazdi.
  if (last_temp_c_ < settings_.freeze_guard_c) {
    freeze_latched_ = true;
  } else if (freeze_latched_ &&
             last_temp_c_ >= settings_.freeze_guard_c + FREEZE_RELEASE_MARGIN_C) {
    freeze_latched_ = false;
  }
  if (freeze_latched_) {
    reason_ = HeatReason::FreezeGuard;
    setHeat(true, now_ms, false);  // emniyet: beklemeyi atlar, saati sifirlamaz
    return heat_;
  }

  // 4) Normal histerezis — YURURLUKTEKI hedefe gore (taban ya da kural).
  const float half = settings_.hysteresis_c * 0.5f;
  const float on_at = effective_target_c_ - half;
  const float off_at = effective_target_c_ + half;

  bool want = heat_;
  HeatReason r = HeatReason::InBand;
  if (last_temp_c_ <= on_at) { want = true; r = HeatReason::BelowBand; }
  else if (last_temp_c_ >= off_at) { want = false; r = HeatReason::AboveBand; }

  // 5) Asgari bekleme: histerezis degisim istiyor ama role yeni anahtarlandiysa bekle.
  //    TEK ISTISNA: son anahtarlama EMNIYET yolundan geldiyse (ariza kesmesi /
  //    donma korumasi) donus bekletilmez — yoksa aralikli sensor arizasinda ev
  //    hic isinmiyor (Y3). Bu izin tek seferliktir; ilk konfor anahtarlamasinda
  //    duser, yani asgari bekleme normal calismaya devam eder.
  if (want != heat_ && has_switched_ && !safety_recovery_ &&
      elapsed(now_ms, last_switch_ms_) < (uint32_t)settings_.min_relay_hold_s * 1000u) {
    reason_ = HeatReason::MinHold;
    return heat_;
  }

  setHeat(want, now_ms, true);
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

  applyRules(c);
  return decide(now_ms);
}

CloudApply applyCloudState(Controller& ctrl, RuleSet& rules, const Settings* new_settings,
                           const RuleSet* new_rules) {
  CloudApply out;
  if (new_settings) {
    Settings ns = *new_settings;
    clampSettings(ns);  // buluttan gelen degere GUVENILMEZ; once kirp, SONRA karsilastir
    if (!settingsEqual(ctrl.settings(), ns)) {
      ctrl.setSettings(ns);
      out.settings_changed = true;
    }
  }
  if (new_rules) {
    RuleSet nr = *new_rules;
    sanitizeRules(nr);
    if (!rulesEqual(nr, rules)) {
      rules = nr;
      ctrl.setRules(rules);
      out.rules_changed = true;
    }
  }
  out.needs_persist = out.settings_changed || out.rules_changed;
  return out;
}

}  // namespace kombi
