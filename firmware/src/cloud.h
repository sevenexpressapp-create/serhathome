// cloud.h — Supabase ile tek kapidan haberlesme.
//
// Tasarim kurallari (plan §2, §5, §6):
//  · Cihaz tablolara DOGRUDAN erismez; yalniz `device-sync` Edge Function'a
//    POST atar. Kapiyi cihaz sirri acar.
//  · Bulut KESILSE DE termostat calisir: bu sinifin basarisizligi karar
//    dongusunu HIC etkilemez, yalniz izleme/ayar durur.
//  · NORMAL PERIYOT ile GERI CEKILME AYRIDIR (Y4):
//      - basarili turdan sonra 30 sn'de bir konusulur (plan §2'deki deger),
//      - hata halinde geri cekilme: 5 sn -> 10 -> 20 ... en cok 5 dk.
//    Eskiden `due()` geri cekilme suresini normal periyot olarak kullaniyordu;
//    basarida 5 sn'ye donuyordu = 17.280 cagri/gun ≈ 518.000/ay. Supabase
//    ucretsiz tavani 500.000 -> plandaki "aylik 0 TL" sarti tutmuyordu.
//    Simdi 2.880 cagri/gun ≈ 86.400/ay (tavanin %17'si).
//  · TLS: sunucu sertifikasi ISRG Root X1'e karsi dogrulanir (supabase.co
//    zinciri 14.10.2026'da olculdu: supabase.co <- Let's Encrypt YR1 <-
//    ISRG Root YR <- ISRG Root X1).
#pragma once

#include <ArduinoJson.h>
#include <HTTPClient.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>

#include "config.h"
#include "kombi_core.h"

// Guven capasi: iki kok sertifika (GTS Root R4 + GlobalSign). Olcum ve
// gerekce ca_cert.cpp basinda; kok, baglanilacak ana makineye olculur.
extern const char* SUPABASE_CA_BUNDLE_PEM;

struct DeviceReport {
  bool has_reading;   // false => temp/humidity NULL gider (uydurma 0.0 yok)
  float temp_c;
  float humidity;
  bool relay_on;
  bool sensor_ok;
  bool time_valid;
  bool rules_suspended;
  float target_c;        // YURURLUKTEKI hedef
  float base_target_c;   // kullanici/bulut tabani
  bool rule_active;
  int active_rule_hour;    // kural devrede degilse -1
  int active_rule_minute;  // kural devrede degilse -1
  const char* reason;
  uint32_t uptime_s;
  int wifi_rssi;
  const char* fw_version;
};

class Cloud {
 public:
  bool configured() const {
    return strlen(SUPABASE_FUNCTION_URL) > 0 && strlen(DEVICE_SECRET) > 0;
  }

  bool lastOk() const { return last_ok_; }
  uint32_t failures() const { return failures_; }
  uint32_t nextAttemptInMs(uint32_t now_ms) const {
    const uint32_t due = last_attempt_ms_ + backoff_ms_;
    return (int32_t)(due - now_ms) > 0 ? (due - now_ms) : 0;
  }
  const String& lastError() const { return last_error_; }

  uint32_t periodMs() const { return kSyncPeriodMs; }

  bool due(uint32_t now_ms) const {
    if (!configured()) return false;
    // Karar cekirdekte (platformdan bagimsiz) ki birim testi olsun.
    return kombi::cloudDue(first_done_, last_ok_, now_ms, last_attempt_ms_, kSyncPeriodMs,
                           backoff_ms_);
  }

  // Durumu gonderir, ayar+kurallari geri okur. Donus: basarili mi.
  // `out_*` yalniz true donuste anlamlidir.
  bool sync(uint32_t now_ms, const DeviceReport& rep, kombi::Settings& out_settings,
            kombi::RuleSet& out_rules, bool& out_has_settings) {
    out_has_settings = false;
    last_attempt_ms_ = now_ms;
    first_done_ = true;

    if (WiFi.status() != WL_CONNECTED) {
      fail("wifi yok");
      return false;
    }

    JsonDocument body;
    body["device_id"] = DEVICE_ID;
    if (rep.has_reading) {
      body["temp_c"] = rep.temp_c;
      body["humidity"] = rep.humidity;
    } else {
      // Y7: gecerli okuma yok -> NULL. 0.0 gondermek panelde "DONMA RISKI"
      // uretiyordu ve Faz 2 alarmini yanlis sebeple calistiracakti.
      body["temp_c"] = nullptr;
      body["humidity"] = nullptr;
    }
    body["relay_on"] = rep.relay_on;
    body["sensor_ok"] = rep.sensor_ok;
    body["time_valid"] = rep.time_valid;
    body["rules_suspended"] = rep.rules_suspended;
    body["target_c"] = rep.target_c;
    body["base_target_c"] = rep.base_target_c;
    body["rule_active"] = rep.rule_active;
    if (rep.active_rule_hour >= 0) {
      body["active_rule_hour"] = rep.active_rule_hour;
      body["active_rule_minute"] = rep.active_rule_minute;
    } else {
      body["active_rule_hour"] = nullptr;
      body["active_rule_minute"] = nullptr;
    }
    body["reason"] = rep.reason;
    body["uptime_s"] = rep.uptime_s;
    body["wifi_rssi"] = rep.wifi_rssi;
    body["fw_version"] = rep.fw_version;
    String payload;
    serializeJson(body, payload);

    WiFiClientSecure client;
#if ALLOW_INSECURE_TLS
    client.setInsecure();  // yalniz hata ayiklama; uretimde 0 olmali
#else
    client.setCACert(SUPABASE_CA_BUNDLE_PEM);
#endif
    client.setTimeout(10);

    HTTPClient http;
    if (!http.begin(client, SUPABASE_FUNCTION_URL)) {
      fail("http.begin basarisiz");
      return false;
    }
    http.setTimeout(10000);
    http.addHeader("Content-Type", "application/json");
    http.addHeader("x-device-id", DEVICE_ID);
    http.addHeader("x-device-secret", DEVICE_SECRET);
    if (strlen(SUPABASE_ANON_KEY) > 0) {
      http.addHeader("apikey", SUPABASE_ANON_KEY);
    }

    const int code = http.POST((uint8_t*)payload.c_str(), payload.length());
    if (code != 200) {
      // DIKKAT: hata metninde sir YOKTUR; yalniz HTTP kodu loglanir.
      fail(String("HTTP ") + code);
      http.end();
      return false;
    }
    String resp = http.getString();
    http.end();

    JsonDocument doc;
    if (deserializeJson(doc, resp)) {
      fail("gecersiz JSON");
      return false;
    }

    if (doc["settings"].is<JsonObject>()) {
      JsonObject s = doc["settings"];
      kombi::Settings ns = kombi::defaultSettings();
      ns.target_c = s["target_c"] | ns.target_c;
      ns.hysteresis_c = s["hysteresis_c"] | ns.hysteresis_c;
      ns.freeze_guard_c = s["freeze_guard_c"] | ns.freeze_guard_c;
      ns.manual_mode = s["manual_mode"] | ns.manual_mode;
      ns.min_relay_hold_s = s["min_relay_hold_s"] | ns.min_relay_hold_s;
      ns.sensor_timeout_s = s["sensor_timeout_s"] | ns.sensor_timeout_s;
      kombi::clampSettings(ns);  // buluttan gelen degere de GUVENILMEZ
      out_settings = ns;
      out_has_settings = true;
    }

    out_rules.count = 0;
    if (doc["rules"].is<JsonArray>()) {
      for (JsonObject r : doc["rules"].as<JsonArray>()) {
        if (out_rules.count >= kombi::MAX_RULES) break;
        kombi::Rule& rule = out_rules.rules[out_rules.count];
        rule.enabled = r["enabled"] | true;
        rule.days_mask = (uint8_t)(r["days_mask"] | 0);
        rule.hour = (uint8_t)(r["hour"] | 0);
        rule.minute = (uint8_t)(r["minute"] | 0);
        rule.target_c = r["target_c"] | 21.0f;
        out_rules.count++;
      }
      kombi::sanitizeRules(out_rules);
    }

    last_ok_ = true;
    failures_ = 0;
    backoff_ms_ = kBaseBackoffMs;
    last_error_ = "";
    return true;
  }

 private:
  // Basari periyodu (plan §2: ~30 sn) — geri cekilmeden AYRI tutulur.
  static const uint32_t kSyncPeriodMs = 30000;
  static const uint32_t kBaseBackoffMs = 5000;
  static const uint32_t kMaxBackoffMs = 300000;

  void fail(const String& why) {
    last_ok_ = false;
    failures_++;
    last_error_ = why;
    backoff_ms_ = backoff_ms_ >= kMaxBackoffMs ? kMaxBackoffMs : backoff_ms_ * 2;
    if (backoff_ms_ > kMaxBackoffMs) backoff_ms_ = kMaxBackoffMs;
  }

  bool last_ok_ = false;
  bool first_done_ = false;
  uint32_t failures_ = 0;
  uint32_t last_attempt_ms_ = 0;
  uint32_t backoff_ms_ = kBaseBackoffMs;
  String last_error_;
};
