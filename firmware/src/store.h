// store.h — Kalici hafiza (NVS). Elektrik kesintisinden sonra hedef ve kurallar
// geri gelsin (plan §4 Faz 1 kabul kriteri, §5 "ESP32'nin gucu kesildi" satiri).
//
// Tek bir blob yazilir: kombi_core'un packState/unpackState'i (sihirli sayi +
// surum + CRC16). Yarim yazilmis ya da bozuk kayit sessizce KABUL EDILMEZ;
// unpack false donerse varsayilanlara donulur.
#pragma once

#include <Preferences.h>

#include "kombi_core.h"

class Store {
 public:
  bool begin() {
    ok_ = prefs_.begin("kombi", false);
    return ok_;
  }

  // Donus: true = NVS'ten GECERLI kayit yuklendi. false = kayit yok/bozuk
  // (cagiran taraf varsayilanlarla devam eder).
  bool load(kombi::Settings& s, kombi::RuleSet& rs) {
    if (!ok_) return false;
    uint8_t buf[kombi::BLOB_MAX];
    const size_t n = prefs_.getBytes(kKey, buf, sizeof(buf));
    if (n == 0) return false;
    return kombi::unpackState(buf, n, s, rs);
  }

  bool save(const kombi::Settings& s, const kombi::RuleSet& rs) {
    if (!ok_) return false;
    uint8_t buf[kombi::BLOB_MAX];
    const size_t n = kombi::packState(s, rs, buf, sizeof(buf));
    if (n == 0) return false;
    return prefs_.putBytes(kKey, buf, n) == n;
  }

  size_t rawSize() {
    if (!ok_) return 0;
    return prefs_.getBytesLength(kKey);
  }

  // Yalniz tani amacli: kayitli blob'u onalti tabanda yazdirir.
  void dump(Print& out) {
    if (!ok_) { out.println("NVS acilamadi"); return; }
    uint8_t buf[kombi::BLOB_MAX];
    const size_t n = prefs_.getBytes(kKey, buf, sizeof(buf));
    out.printf("NVS blob: %u bayt\n", (unsigned)n);
    for (size_t i = 0; i < n; i++) out.printf("%02X", buf[i]);
    out.println();
    kombi::Settings s = kombi::defaultSettings();
    kombi::RuleSet rs;
    out.printf("CRC/surum dogrulamasi: %s\n",
               kombi::unpackState(buf, n, s, rs) ? "GECERLI" : "GECERSIZ");
    if (n) out.printf("  hedef=%.1f bant=%.1f kural=%u\n", s.target_c, s.hysteresis_c, rs.count);
  }

 private:
  static constexpr const char* kKey = "state";
  Preferences prefs_;
  bool ok_ = false;
};
