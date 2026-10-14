// core_cli — karar cekirdegini MAKINEDE surulebilir hale getiren olcum aleti.
//
// Neden var: "saatli kural bulut bagliyken geri alinmiyor" (§K1) iddiasi ancak
// kural motoru ile bulut yolu AYNI ANDA kosarken olculebilir. Kart + ev WiFi'si
// her zaman elde olmayabilir; bu alet, GERCEK cekirdek koduyla (lib/kombi_core)
// GERCEK HTTP'yi (tests/sync_test.mjs -> yerel Supabase Edge Function)
// birlestirmeyi mumkun kiliyor:
//
//   Node testi  --stdin-->  core_cli (gercek karar mantigi)
//   Node testi  --HTTP--->  device-sync (gercek Edge Function + gercek Postgres)
//
// ONEMLI: buradaki "bulut durumunu uygula" mantigi main.cpp ile AYNI koddur
// (kombi::applyCloudState). Yani alet, cihazda kosan seyden farkli bir sey
// olcmuyor. Cihaza ozgu olan (GPIO/NVS/HTTP) burada yok; NVS yazmasi sayilir.
//
// Derleme (depo kokunden):
//   c++ -std=gnu++17 -O1 -Wall -I firmware/lib/kombi_core \
//       firmware/lib/kombi_core/kombi_core.cpp firmware/tools/core_cli/main.cpp \
//       -o <scratch>/core_cli
//
// Komutlar (her satir bir komut, cevap tek satir):
//   boot <hedef> <bant> <donma> <manuel01> <bekleme_sn> <zaman_asimi_sn>
//   rule-clear
//   rule <maske> <saat> <dakika> <hedef>
//   rules-apply
//   tick <ms> <sicaklik|nan> <saat_gecerli01> <gun> <saat> <dakika>
//   cloud <ayar_var01> <hedef> <bant> <donma> <manuel01> <bekleme> <zaman_asimi> <kural_sayisi> [<maske> <sa> <dk> <hedef>]...
//   state
//   quit
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "kombi_core.h"

static kombi::Controller ctrl;
static kombi::RuleSet rules;       // cihazda NVS'e yazilan kural listesi
static kombi::RuleSet pending;     // "rule" komutlariyla kurulan liste
static kombi::Settings settings;
static unsigned long nvs_writes = 0;

static void printState() {
  printf("STATE heat=%d reason=%s eff=%.2f base=%.2f rule=%d rh=%d rm=%d ovr=%d susp=%d fault=%d "
         "has=%d nvs=%lu rules=%u\n",
         ctrl.heatRequested() ? 1 : 0, kombi::reasonName(ctrl.reason()), ctrl.effectiveTarget(),
         ctrl.baseTarget(), ctrl.ruleActive() ? 1 : 0, (int)ctrl.activeRuleHour(),
         (int)ctrl.activeRuleMinute(), ctrl.manualOverride() ? 1 : 0,
         ctrl.rulesSuspended() ? 1 : 0, ctrl.sensorFault() ? 1 : 0, ctrl.hasReading() ? 1 : 0,
         nvs_writes, (unsigned)rules.count);
  fflush(stdout);
}

int main(void) {
  settings = kombi::defaultSettings();
  ctrl.begin(settings, 0);
  char line[1024];
  while (fgets(line, sizeof(line), stdin)) {
    char* nl = strchr(line, '\n');
    if (nl) *nl = '\0';
    if (line[0] == '\0') continue;

    if (strncmp(line, "boot ", 5) == 0) {
      // Elektrik kesintisi / acilis: cekirdek SIFIRDAN baslar, ayarlar NVS'ten gelir.
      float tgt = 21, band = 3, fz = 6;
      int man = 0;
      unsigned hold = 300, to = 120;
      if (sscanf(line + 5, "%f %f %f %d %u %u", &tgt, &band, &fz, &man, &hold, &to) != 6) {
        printf("ERR boot\n");
        fflush(stdout);
        continue;
      }
      settings = kombi::defaultSettings();
      settings.target_c = tgt;
      settings.hysteresis_c = band;
      settings.freeze_guard_c = fz;
      settings.manual_mode = man != 0;
      settings.min_relay_hold_s = (uint16_t)hold;
      settings.sensor_timeout_s = (uint16_t)to;
      ctrl.begin(settings, 0);
      ctrl.setRules(rules);
      printf("OK boot\n");
      fflush(stdout);
      continue;
    }
    if (strcmp(line, "rule-clear") == 0) {
      pending.count = 0;
      printf("OK rule-clear\n");
      fflush(stdout);
      continue;
    }
    if (strncmp(line, "rule ", 5) == 0) {
      int mask = 0, hh = 0, mm = 0;
      float tgt = 0;
      if (sscanf(line + 5, "%d %d %d %f", &mask, &hh, &mm, &tgt) != 4 ||
          pending.count >= kombi::MAX_RULES) {
        printf("ERR rule\n");
        fflush(stdout);
        continue;
      }
      pending.rules[pending.count] = {true, (uint8_t)mask, (uint8_t)hh, (uint8_t)mm, tgt};
      pending.count++;
      printf("OK rule\n");
      fflush(stdout);
      continue;
    }
    if (strcmp(line, "rules-apply") == 0) {
      rules = pending;
      ctrl.setRules(rules);
      printf("OK rules-apply rules=%u\n", (unsigned)rules.count);
      fflush(stdout);
      continue;
    }
    if (strncmp(line, "tick ", 5) == 0) {
      unsigned long ms = 0;
      char temp[32] = "nan";
      int cv = 0, wd = 0, hh = 0, mm = 0;
      if (sscanf(line + 5, "%lu %31s %d %d %d %d", &ms, temp, &cv, &wd, &hh, &mm) != 6) {
        printf("ERR tick\n");
        fflush(stdout);
        continue;
      }
      kombi::Reading r;
      if (strcmp(temp, "nan") != 0) {
        r.valid = true;
        r.temp_c = (float)atof(temp);
        r.humidity = 50.0f;
      }
      kombi::Clock c;
      c.valid = cv != 0;
      c.weekday = (uint8_t)wd;
      c.hour = (uint8_t)hh;
      c.minute = (uint8_t)mm;
      ctrl.update((uint32_t)ms, r, c);
      printState();
      continue;
    }
    if (strncmp(line, "cloud ", 6) == 0) {
      // Buluttan inen ayar+kural: main.cpp'nin serviceCloud()'u ile AYNI cagri.
      int has = 0, man = 0, n = 0;
      float tgt = 21, band = 3, fz = 6;
      unsigned hold = 300, to = 120;
      int consumed = 0;
      if (sscanf(line + 6, "%d %f %f %f %d %u %u %d%n", &has, &tgt, &band, &fz, &man, &hold, &to,
                 &n, &consumed) < 8) {
        printf("ERR cloud\n");
        fflush(stdout);
        continue;
      }
      kombi::Settings ns = kombi::defaultSettings();
      ns.target_c = tgt;
      ns.hysteresis_c = band;
      ns.freeze_guard_c = fz;
      ns.manual_mode = man != 0;
      ns.min_relay_hold_s = (uint16_t)hold;
      ns.sensor_timeout_s = (uint16_t)to;

      kombi::RuleSet nr{};  // Y1: ILKLENDIRILMIS (main.cpp ile ayni)
      const char* p = line + 6 + consumed;
      for (int i = 0; i < n && i < (int)kombi::MAX_RULES; i++) {
        int mask = 0, hh = 0, mm = 0, c2 = 0;
        float rt = 0;
        if (sscanf(p, " %d %d %d %f%n", &mask, &hh, &mm, &rt, &c2) < 4) break;
        p += c2;
        nr.rules[nr.count] = {true, (uint8_t)mask, (uint8_t)hh, (uint8_t)mm, rt};
        nr.count++;
      }
      const kombi::CloudApply a =
          kombi::applyCloudState(ctrl, rules, has ? &ns : nullptr, &nr);
      if (a.needs_persist) nvs_writes++;  // cihazda persist() burada cagrilir
      printf("CLOUD persist=%d settings=%d rules=%d nvs=%lu\n", a.needs_persist ? 1 : 0,
             a.settings_changed ? 1 : 0, a.rules_changed ? 1 : 0, nvs_writes);
      fflush(stdout);
      continue;
    }
    if (strcmp(line, "state") == 0) {
      printState();
      continue;
    }
    if (strcmp(line, "quit") == 0) break;

    printf("ERR bilinmeyen komut\n");
    fflush(stdout);
  }
  return 0;
}
