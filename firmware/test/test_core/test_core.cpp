// Karar cekirdeginin birim testleri — `pio test -e native` ile MAKINEDE kosar,
// karta flash gerekmez. Her iddianin yaninda AYNI EKSENDE pozitif kontrol var:
// yani "yesil" cikan testin aletinin olu olmadigi, kasitli bir mutasyon/karsi
// senaryo ile ayrica gosteriliyor. (Sahte yesil kadar sahte kirmiziya da bakildi.)
#include <unity.h>

#include <string.h>

#include "kombi_core.h"

using namespace kombi;

static Reading good(float t, float h = 50.0f) {
  Reading r;
  r.valid = true;
  r.temp_c = t;
  r.humidity = h;
  return r;
}
static Reading bad() { return Reading(); }  // valid=false
static Clock noClock() { return Clock(); }  // valid=false

static Clock at(uint8_t weekday, uint8_t hour, uint8_t minute) {
  Clock c;
  c.valid = true;
  c.weekday = weekday;
  c.hour = hour;
  c.minute = minute;
  return c;
}

// ---------------------------------------------------------------------------
// 1) ACILIS EMNIYETI: cekirdek acilista isi istemez; pin seviyesi OFF=HIGH.
// ---------------------------------------------------------------------------
void test_acilista_isi_istegi_yok(void) {
  Settings s = defaultSettings();
  s.target_c = 24.0f;  // oda hedefin cok altinda olsa bile
  Controller c;
  c.begin(s, 0);

  TEST_ASSERT_FALSE(c.heatRequested());
  TEST_ASSERT_EQUAL_INT(RELAY_LEVEL_OFF, c.relayLevel());
  TEST_ASSERT_EQUAL_INT(1, c.relayLevel());  // ACTIVE LOW modulde HIGH = birakmis
  TEST_ASSERT_EQUAL_INT((int)HeatReason::Boot, (int)c.reason());

  // Gecersiz okumalarla 10 sn donsek de hala kapali (okuma yok = guvenli taraf).
  for (uint32_t t = 0; t <= 10000; t += 2000) {
    c.update(t, bad(), noClock());
    TEST_ASSERT_FALSE(c.heatRequested());
  }

  // POZITIF KONTROL (ayni eksen): seviye esleme sabit degil — istek gelince
  // pin LOW'a dusuyor, yani yukaridaki "HIGH" olcumu olu bir sabit degil.
  TEST_ASSERT_EQUAL_INT(0, relayLevelFor(true));
  c.update(12000, good(10.0f), noClock());
  TEST_ASSERT_TRUE(c.heatRequested());
  TEST_ASSERT_EQUAL_INT(RELAY_LEVEL_ON, c.relayLevel());
  TEST_ASSERT_EQUAL_INT(0, c.relayLevel());
}

// ---------------------------------------------------------------------------
// 2) HISTEREZIS ESIKLERI: hedef 21, bant 3.0 -> 19.5'te ac, 22.5'te kes.
// ---------------------------------------------------------------------------
void test_histerezis_esikleri(void) {
  Settings s = defaultSettings();
  s.target_c = 21.0f;
  s.hysteresis_c = 3.0f;
  s.min_relay_hold_s = 0;  // bu test esikleri olcuyor, beklemeyi degil
  Controller c;
  c.begin(s, 0);

  c.update(1000, good(19.4f), noClock());  // bandin altinda
  TEST_ASSERT_TRUE(c.heatRequested());
  TEST_ASSERT_EQUAL_INT((int)HeatReason::BelowBand, (int)c.reason());

  c.update(2000, good(21.0f), noClock());  // bant ICINDE -> durumu korur
  TEST_ASSERT_TRUE(c.heatRequested());
  TEST_ASSERT_EQUAL_INT((int)HeatReason::InBand, (int)c.reason());

  c.update(3000, good(22.6f), noClock());  // bandin ustunde -> keser
  TEST_ASSERT_FALSE(c.heatRequested());
  TEST_ASSERT_EQUAL_INT((int)HeatReason::AboveBand, (int)c.reason());

  c.update(4000, good(21.0f), noClock());  // bant icinde -> kapali kalir
  TEST_ASSERT_FALSE(c.heatRequested());

  c.update(5000, good(19.5f), noClock());  // tam esik (<=) -> acar
  TEST_ASSERT_TRUE(c.heatRequested());
}

// ---------------------------------------------------------------------------
// 3) SALINIM: DHT11 gibi 1 °C adimlarla zipllayan okumada role ac-kapa YAPMAZ.
//    Pozitif kontrol: AYNI bant (urun ayari 3.0) ve ayni olcum ekseni
//    (anahtarlama sayisi), tek degisiklik okumanin GENLIGI — bant gercekten
//    asilinca alet salinimi GORUYOR. Yani "0 anahtarlama" olu aletten gelmiyor.
//
//    Not: bandi 0.4'e daraltarak yapilan eski pozitif kontrol artik kurulamaz;
//    clampSettings alt siniri sensorden turetiyor (MIN_BAND_C = 2 x 1.0 °C),
//    yani 0.4 sessizce 2.0'a cekiliyor (O3). Alt sinirin kendisi ayrica
//    test_bant_alt_siniri_sensore_bagli ile olculuyor.
// ---------------------------------------------------------------------------
static int salinim_sayaci(float band, float lo, float hi) {
  Settings s = defaultSettings();
  // Hedef 21.5 secildi ki DHT11'in tam sayi adimlari (21 / 22) bandin IKI
  // yanina dussun. Hedef 21.0 olsa 21 okumasi dar bantta da "bant ici"ne
  // dusuyor ve kontrol senaryoyu hic kurmuyordu (ilk olcumde boyle patladi).
  s.target_c = 21.5f;
  s.hysteresis_c = band;
  s.min_relay_hold_s = 0;  // asgari bekleme KAPALI: salinimi bantin onledigini olc
  Controller c;
  c.begin(s, 0);
  TEST_ASSERT_EQUAL_FLOAT(band, c.settings().hysteresis_c);  // bant gercekten uygulandi

  c.update(0, good(18.0f), noClock());
  bool prev = c.heatRequested();
  int switches = 0;
  uint32_t t = 2000;
  for (int i = 0; i < 60; i++, t += 2000) {
    const float temp = (i % 2 == 0) ? lo : hi;
    bool now = c.update(t, good(temp), noClock());
    if (now != prev) switches++;
    prev = now;
  }
  return switches;
}

void test_salinim_yok_ve_alet_canli(void) {
  // Gercek urun ayari (3.0 °C bant): 21/22 zipllamasi roleyi hic anahtarlamaz.
  TEST_ASSERT_EQUAL_INT(0, salinim_sayaci(3.0f, 21.0f, 22.0f));

  // POZITIF KONTROL — ayni bant, ayni eksen: okuma bandi gercekten asinca
  // (20 <-> 23, bant 3.0 => esikler 20.0 / 23.0) alet her adimda anahtarlama
  // goruyor.
  TEST_ASSERT_GREATER_THAN_INT(10, salinim_sayaci(3.0f, 20.0f, 23.0f));
}

// ---------------------------------------------------------------------------
// 3b) O3 — BANT ALT SINIRI SENSORE BAGLI. DHT11'de 1.0-1.5 °C'lik bant
//     olculemez (cozunurluk 1.0 °C); alt sinir 2 x cozunurluk.
// ---------------------------------------------------------------------------
void test_bant_alt_siniri_sensore_bagli(void) {
  TEST_ASSERT_EQUAL_FLOAT(1.0f, SENSOR_RESOLUTION_C);
  TEST_ASSERT_EQUAL_FLOAT(2.0f, MIN_BAND_C);  // turetme: 2 x cozunurluk

  Settings s = defaultSettings();
  s.hysteresis_c = 0.5f;  // eski semanin alt siniri
  TEST_ASSERT_TRUE(clampSettings(s));
  TEST_ASSERT_EQUAL_FLOAT(MIN_BAND_C, s.hysteresis_c);

  Settings s2 = defaultSettings();
  s2.hysteresis_c = 1.5f;  // "DHT11'de olculemez" dedigimiz aralik
  TEST_ASSERT_TRUE(clampSettings(s2));
  TEST_ASSERT_EQUAL_FLOAT(MIN_BAND_C, s2.hysteresis_c);

  // POZITIF KONTROL: alt sinirin kendisi ve ustu HIC degistirilmiyor.
  Settings ok = defaultSettings();
  ok.hysteresis_c = MIN_BAND_C;
  TEST_ASSERT_FALSE(clampSettings(ok));
  TEST_ASSERT_EQUAL_FLOAT(MIN_BAND_C, ok.hysteresis_c);
}

// ---------------------------------------------------------------------------
// 4) SENSOR ARIZASI: okuma kesilince isi istegi KESILIR (zaman asimindan sonra).
//    Pozitif kontrol: okumalar gelmeye devam ederse ayni surede ariza YOK.
// ---------------------------------------------------------------------------
void test_sensor_arizasi_isitmayi_keser(void) {
  Settings s = defaultSettings();
  s.target_c = 24.0f;      // oda hedefin altinda -> isitma acik olmali
  s.min_relay_hold_s = 0;
  s.sensor_timeout_s = 120;
  Controller c;
  c.begin(s, 0);

  c.update(1000, good(20.0f), noClock());
  TEST_ASSERT_TRUE(c.heatRequested());
  TEST_ASSERT_FALSE(c.sensorFault());

  // Okuma kesildi; zaman asimi dolmadan ONCE: isitma SURUYOR (tek zaman asimi
  // ariza degil — DHT11'de bir okumanin kacmasi normal).
  c.update(100000, bad(), noClock());
  TEST_ASSERT_TRUE(c.heatRequested());
  TEST_ASSERT_FALSE(c.sensorFault());

  // Zaman asimi doldu -> ARIZA: isi istegi kesilir.
  c.update(130000, bad(), noClock());
  TEST_ASSERT_TRUE(c.sensorFault());
  TEST_ASSERT_FALSE(c.heatRequested());
  TEST_ASSERT_EQUAL_INT((int)HeatReason::SensorFault, (int)c.reason());
  TEST_ASSERT_EQUAL_INT(RELAY_LEVEL_OFF, c.relayLevel());

  // Okuma geri gelince normale doner.
  c.update(132000, good(20.0f), noClock());
  TEST_ASSERT_FALSE(c.sensorFault());
  TEST_ASSERT_TRUE(c.heatRequested());

  // POZITIF KONTROL: ayni 130 sn, ama okumalar gelmeye devam ediyor -> ariza yok.
  Controller c2;
  c2.begin(s, 0);
  for (uint32_t t = 0; t <= 130000; t += 2000) c2.update(t, good(20.0f), noClock());
  TEST_ASSERT_FALSE(c2.sensorFault());
  TEST_ASSERT_TRUE(c2.heatRequested());
}

// ---------------------------------------------------------------------------
// 4b) YUKSEK-3 — SENSOR ZAMAN ASIMI TABANI. DHT11 2 sn'de bir okunur ve
//     ARALIKLI kacirmasi normaldir: 10 sn'lik taban (eski sema varsayilani)
//     5 kacan okumayi "ariza" sayip isiyi keser VE donma korumasini devre
//     disi birakirdi. Taban artik >= 60 sn.
// ---------------------------------------------------------------------------
void test_sensor_zaman_asimi_tabani(void) {
  Settings s = defaultSettings();
  s.sensor_timeout_s = 10;  // uzaktan yazilabilen eski taban
  TEST_ASSERT_TRUE(clampSettings(s));
  TEST_ASSERT_EQUAL_UINT16(60, s.sensor_timeout_s);
  TEST_ASSERT_EQUAL_UINT16(120, defaultSettings().sensor_timeout_s);

  // Olcum: 10 sn istenmis olsa bile 5 kacan okuma (10 sn) ariza SAYILMIYOR.
  Controller c;
  c.begin(s, 0);
  c.update(0, good(20.0f), noClock());
  for (uint32_t t = 2000; t <= 10000; t += 2000) c.update(t, bad(), noClock());
  TEST_ASSERT_FALSE(c.sensorFault());

  // POZITIF KONTROL (ayni eksen): 61 sn sonra ariza GORULUYOR.
  c.update(61000, bad(), noClock());
  TEST_ASSERT_TRUE(c.sensorFault());

  // POZITIF KONTROL (ust sinir ezilmiyor): gecerli deger degistirilmez.
  Settings ok = defaultSettings();
  ok.sensor_timeout_s = 300;
  TEST_ASSERT_FALSE(clampSettings(ok));
  TEST_ASSERT_EQUAL_UINT16(300, ok.sensor_timeout_s);
}

// ---------------------------------------------------------------------------
// 4c) YUKSEK-3 (ikinci yarisi) — ARIZA SIRASINDA DONMA KORUMASI.
//     Son gecerli okuma TAZE (<30 dk) ve donma esiginin altindaysa, sensor
//     arizasi donma korumasini DEVRE DISI BIRAKMAZ. Pencere dolunca isi kesilir.
// ---------------------------------------------------------------------------
void test_ariza_sirasinda_donma_korumasi(void) {
  Settings s = defaultSettings();
  s.target_c = 21.0f;
  s.freeze_guard_c = 6.0f;
  s.sensor_timeout_s = 60;
  s.min_relay_hold_s = 300;
  Controller c;
  c.begin(s, 0);

  // Oda 3 °C: donma korumasi acik.
  c.update(1000, good(3.0f), noClock());
  TEST_ASSERT_TRUE(c.heatRequested());
  TEST_ASSERT_EQUAL_INT((int)HeatReason::FreezeGuard, (int)c.reason());

  // Sensor sustu. Ariza var AMA okuma taze -> donma korumasi SURUYOR.
  c.update(70000, bad(), noClock());
  TEST_ASSERT_TRUE(c.sensorFault());
  TEST_ASSERT_TRUE(c.heatRequested());
  TEST_ASSERT_EQUAL_INT((int)HeatReason::FreezeGuard, (int)c.reason());

  // 30 dk'lik pencere dolunca "korlemesine isitma" biter: isi KESILIR.
  c.update(1000 + FREEZE_STALE_GRACE_MS + 1000, bad(), noClock());
  TEST_ASSERT_FALSE(c.heatRequested());
  TEST_ASSERT_EQUAL_INT((int)HeatReason::SensorFault, (int)c.reason());

  // POZITIF/NEGATIF EKSEN: ayni ariza, ama son okuma donma esiginin USTUNDE
  // (18 °C) -> donma korumasi kosmaz, isi kesilir (yani yukaridaki "suruyor"
  // sonucu "ariza hep isitiyor" demek degil).
  Controller c2;
  c2.begin(s, 0);
  c2.update(1000, good(18.0f), noClock());
  TEST_ASSERT_TRUE(c2.heatRequested());  // 18 < 21-1.5 -> normal isitma
  c2.update(70000, bad(), noClock());
  TEST_ASSERT_TRUE(c2.sensorFault());
  TEST_ASSERT_FALSE(c2.heatRequested());
  TEST_ASSERT_EQUAL_INT((int)HeatReason::SensorFault, (int)c2.reason());
}

// ---------------------------------------------------------------------------
// 5) DONMA KORUMASI: esigin altinda hedeften bagimsiz ZORLA isitir, BIRAKMA
//    PAYI kadar isinmadan birakmaz. Pozitif kontrol: esigin ustunde ayni
//    ayarla isitma acilmiyor (yani "her zaman aciyor" degil).
// ---------------------------------------------------------------------------
void test_donma_korumasi(void) {
  Settings s = defaultSettings();
  s.target_c = 8.0f;
  s.hysteresis_c = 3.0f;
  s.freeze_guard_c = 6.0f;
  s.min_relay_hold_s = 300;  // asgari bekleme ACIK: emniyetin onu atladigini olc
  Controller c;
  c.begin(s, 0);
  TEST_ASSERT_EQUAL_FLOAT(6.0f, c.settings().freeze_guard_c);

  c.update(1000, good(5.5f), noClock());
  TEST_ASSERT_TRUE(c.heatRequested());
  TEST_ASSERT_EQUAL_INT((int)HeatReason::FreezeGuard, (int)c.reason());

  c.update(2000, good(6.5f), noClock());  // esigin ustu ama pay dolmadi -> mandal
  TEST_ASSERT_TRUE(c.heatRequested());
  TEST_ASSERT_EQUAL_INT((int)HeatReason::FreezeGuard, (int)c.reason());

  c.update(3000, good(7.1f), noClock());  // 6 + 1 = 7 -> mandal acilir
  TEST_ASSERT_NOT_EQUAL((int)HeatReason::FreezeGuard, (int)c.reason());

  // POZITIF KONTROL: ayni ayarla 10 °C'de isitma istenmiyor (hedef 8, bant ust
  // esigi 9.5) -> donma korumasi "her kosulda acik" bir sabit degil.
  Controller c2;
  c2.begin(s, 0);
  c2.update(1000, good(10.0f), noClock());
  TEST_ASSERT_FALSE(c2.heatRequested());
}

// ---------------------------------------------------------------------------
// 5b) Y2 — DONMA MANDALININ BIRAKMA PAYI KONFOR BANDINDAN BAGIMSIZ.
//     Denetcinin kanit dizisi: band=6 iken mandal 12 °C'de birakiyordu
//     (esik 6 + bant 6). Simdi pay sensorun cozunurlugu: 6 + 1 = 7 °C.
// ---------------------------------------------------------------------------
void test_donma_birakma_payi_banttan_bagimsiz(void) {
  Settings s = defaultSettings();
  s.target_c = 21.0f;
  s.hysteresis_c = 6.0f;  // EN GENIS bant
  s.freeze_guard_c = 6.0f;
  s.min_relay_hold_s = 300;
  Controller c;
  c.begin(s, 0);
  TEST_ASSERT_EQUAL_FLOAT(6.0f, c.settings().hysteresis_c);

  c.update(1000, good(5.0f), noClock());
  TEST_ASSERT_EQUAL_INT((int)HeatReason::FreezeGuard, (int)c.reason());

  // 6.9 -> hala mandal (pay 1.0 dolmadi)
  c.update(2000, good(6.9f), noClock());
  TEST_ASSERT_EQUAL_INT((int)HeatReason::FreezeGuard, (int)c.reason());

  // 7.0 -> MANDAL BIRAKIR. Eski kodda bu nokta 12.0 idi.
  c.update(3000, good(7.0f), noClock());
  TEST_ASSERT_NOT_EQUAL((int)HeatReason::FreezeGuard, (int)c.reason());

  // Y2(b) — donma esigi hedefin ALTINDA kalmak zorunda. Denetcinin orneginde
  // hedef 5 iken esik 12 yazilabiliyordu; artik kirpiliyor (semada da ayni kisit).
  Settings bad_combo = defaultSettings();
  bad_combo.target_c = 5.0f;
  bad_combo.freeze_guard_c = 12.0f;
  TEST_ASSERT_TRUE(clampSettings(bad_combo));
  TEST_ASSERT_EQUAL_FLOAT(4.5f, bad_combo.freeze_guard_c);  // 5.0 - 0.5
  TEST_ASSERT_TRUE(bad_combo.freeze_guard_c < bad_combo.target_c);

  // POZITIF KONTROL: makul kombinasyon HIC degistirilmiyor.
  Settings ok = defaultSettings();
  ok.target_c = 21.0f;
  ok.freeze_guard_c = 6.0f;
  TEST_ASSERT_FALSE(clampSettings(ok));
  TEST_ASSERT_EQUAL_FLOAT(6.0f, ok.freeze_guard_c);
}

// ---------------------------------------------------------------------------
// 6) ASGARI BEKLEME: histerezis degisim istese de role hemen anahtarlanmaz;
//    ama SENSOR ARIZASI ve DONMA KORUMASI bu beklemeyi atlar (emniyet).
// ---------------------------------------------------------------------------
void test_asgari_bekleme_ve_emniyet_atlamasi(void) {
  Settings s = defaultSettings();
  s.target_c = 21.0f;
  s.hysteresis_c = 3.0f;
  s.min_relay_hold_s = 300;  // 5 dk
  Controller c;
  c.begin(s, 0);

  c.update(1000, good(18.0f), noClock());  // ilk anahtarlama beklemeye TAKILMAZ
  TEST_ASSERT_TRUE(c.heatRequested());

  c.update(60000, good(25.0f), noClock());  // 59 sn sonra kesmek isterdi
  TEST_ASSERT_TRUE(c.heatRequested());
  TEST_ASSERT_EQUAL_INT((int)HeatReason::MinHold, (int)c.reason());

  c.update(305000, good(25.0f), noClock());  // 5 dk gecti -> keser
  TEST_ASSERT_FALSE(c.heatRequested());
  TEST_ASSERT_EQUAL_INT((int)HeatReason::AboveBand, (int)c.reason());

  // Emniyet atlamasi 1: role yeni anahtarlandi, hemen ardindan sensor arizasi.
  Controller c2;
  c2.begin(s, 0);
  c2.update(1000, good(18.0f), noClock());
  TEST_ASSERT_TRUE(c2.heatRequested());
  for (uint32_t t = 3000; t <= 123000; t += 2000) c2.update(t, bad(), noClock());
  TEST_ASSERT_FALSE(c2.heatRequested());  // 5 dk beklemeden kesildi
  TEST_ASSERT_EQUAL_INT((int)HeatReason::SensorFault, (int)c2.reason());

  // Emniyet atlamasi 2: isitma yeni kesildi, oda aniden donma esigine dustu.
  Controller c3;
  c3.begin(s, 0);
  c3.update(1000, good(25.0f), noClock());
  TEST_ASSERT_FALSE(c3.heatRequested());
  c3.update(2000, good(4.0f), noClock());
  TEST_ASSERT_TRUE(c3.heatRequested());  // bekleme atlandi
  TEST_ASSERT_EQUAL_INT((int)HeatReason::FreezeGuard, (int)c3.reason());
}

// ---------------------------------------------------------------------------
// 6b) Y3 — EMNIYET KESMESI TOPARLANMAYI CEZALANDIRMAZ. Ariza dali eskiden her
//     donguda `last_switch_ms_`i yeniliyordu: ariza kalkinca role URETIM
//     VARSAYILANIYLA (hold=300) 5 dk daha kilitli kaliyor, aralikli arizada ise
//     hic acilmiyordu. Olcum URETIM VARSAYILANLARIYLA yapiliyor.
// ---------------------------------------------------------------------------
void test_ariza_sonrasi_toparlanma_gecikmiyor(void) {
  Settings s = defaultSettings();  // hold=300, timeout=120 (uretim varsayilani)
  s.target_c = 21.0f;
  TEST_ASSERT_EQUAL_UINT16(300, s.min_relay_hold_s);
  TEST_ASSERT_EQUAL_UINT16(120, s.sensor_timeout_s);

  Controller c;
  c.begin(s, 0);
  c.update(1000, good(18.0f), noClock());  // KONFOR anahtarlamasi: isitma acildi
  TEST_ASSERT_TRUE(c.heatRequested());

  // Bekleme penceresi dolana kadar normal calis (son konfor anahtarlamasi t=1000).
  for (uint32_t t = 3000; t <= 400000; t += 2000) c.update(t, good(18.0f), noClock());
  TEST_ASSERT_TRUE(c.heatRequested());

  // Sensor sustu; zaman asimi dolunca EMNIYET KESMESI olur. Kesme aninin
  // zamanini bul: olcumun ekseni "kesmeden SONRAKI 300 sn icinde toparlanma".
  uint32_t cut_ms = 0;
  for (uint32_t t = 402000; t <= 600000; t += 2000) {
    const bool heat = c.update(t, bad(), noClock());
    if (!heat && cut_ms == 0) cut_ms = t;
  }
  TEST_ASSERT_TRUE(c.sensorFault());
  TEST_ASSERT_FALSE(c.heatRequested());
  TEST_ASSERT_TRUE(cut_ms > 0);

  // ARIZA KALKTI — kesmeden yalniz 8 sn sonra, yani asgari bekleme penceresinin
  // ICINDE. Emniyet kesmesi beklemeyi atlar AMA bekleme saatini SIFIRLAMAMALI;
  // son KONFOR anahtarlamasi (t=1000) uzerinden 300 sn cok once gecti.
  // Eski kodda ariza dali `last_switch_ms_`i yeniliyordu ve burada
  // `reason=min_hold` cikip role 5 dk daha kilitli kaliyordu.
  const uint32_t recover_ms = cut_ms + 8000;
  TEST_ASSERT_TRUE(elapsed(recover_ms, cut_ms) < 300000u);  // olcum gercekten pencere ICINDE
  c.update(recover_ms, good(18.0f), noClock());
  TEST_ASSERT_FALSE(c.sensorFault());
  TEST_ASSERT_EQUAL_INT((int)HeatReason::BelowBand, (int)c.reason());
  TEST_ASSERT_TRUE(c.heatRequested());

  // POZITIF KONTROL (ayni eksen): asgari bekleme HALA CALISIYOR — emniyet
  // yolundan gecmeyen normal bir degisim istegi beklemeye takiliyor.
  // (Yoksa yukaridaki "aninda acildi" sonucu "bekleme hic yok"tan da gelebilirdi.)
  c.update(recover_ms + 2000, good(25.0f), noClock());
  TEST_ASSERT_EQUAL_INT((int)HeatReason::MinHold, (int)c.reason());
  TEST_ASSERT_TRUE(c.heatRequested());

  // ARALIKLI ARIZA (denetcinin "ev hic isinmaz" senaryosu): ariza/toparlanma
  // dongusunde isitma ILK toparlanmada geri gelmeli, 5 dk beklememeli.
  Controller c2;
  c2.begin(s, 0);
  c2.update(1000, good(18.0f), noClock());
  for (uint32_t t = 3000; t <= 400000; t += 2000) c2.update(t, good(18.0f), noClock());
  uint32_t t2 = 402000;
  int blocked_recoveries = 0;
  for (int cycle = 0; cycle < 5; cycle++) {
    for (int i = 0; i < 65; i++, t2 += 2000) c2.update(t2, bad(), noClock());  // 130 sn ariza
    TEST_ASSERT_TRUE(c2.sensorFault());
    c2.update(t2, good(18.0f), noClock());  // ariza kalkti, ev soguk
    t2 += 2000;
    if (!c2.heatRequested() || c2.reason() == HeatReason::MinHold) blocked_recoveries++;
    for (int i = 0; i < 4; i++, t2 += 2000) c2.update(t2, good(18.0f), noClock());
  }
  TEST_ASSERT_EQUAL_INT(0, blocked_recoveries);
}

// ---------------------------------------------------------------------------
// 7) SAAT BILINMIYORSA SAATLI KURALLAR ASKIDA (plan §3 bilincli sinir),
//    termostat TABAN hedefle SURER. Pozitif kontrol: ayni kural, saat
//    gecerliyken yururluge giriyor.
// ---------------------------------------------------------------------------
void test_saat_yoksa_kurallar_askida(void) {
  Settings s = defaultSettings();
  s.target_c = 18.0f;
  s.min_relay_hold_s = 0;
  RuleSet rs;
  rs.count = 2;
  rs.rules[0] = {true, 0x7F, 7, 0, 20.0f};   // her gun 07:00 -> 20 °C
  rs.rules[1] = {true, 0x7F, 17, 0, 25.0f};  // her gun 17:00 -> 25 °C

  Controller c;
  c.begin(s, 0);
  c.setRules(rs);

  // Saat YOK: kural uygulanmaz, TABAN hedef (18) gecerli, termostat calisir.
  c.update(1000, good(16.0f), noClock());
  TEST_ASSERT_TRUE(c.rulesSuspended());
  TEST_ASSERT_EQUAL_FLOAT(18.0f, c.effectiveTarget());
  TEST_ASSERT_TRUE(c.heatRequested());  // 16 < 18 - 1.5 -> isitiyor
  c.update(3000, good(22.0f), noClock());
  TEST_ASSERT_FALSE(c.heatRequested());  // 22 > 18 + 1.5 -> kesiyor (termostat SURUYOR)

  // POZITIF KONTROL: saat gecerli -> 16:59'da 07:00 kurali (20), 17:00'de 25.
  Controller c2;
  c2.begin(s, 0);
  c2.setRules(rs);
  c2.update(1000, good(22.0f), at(3, 16, 59));
  TEST_ASSERT_FALSE(c2.rulesSuspended());
  TEST_ASSERT_EQUAL_FLOAT(20.0f, c2.effectiveTarget());
  TEST_ASSERT_TRUE(c2.ruleActive());
  c2.update(3000, good(22.0f), at(3, 17, 0));
  TEST_ASSERT_EQUAL_FLOAT(25.0f, c2.effectiveTarget());
  TEST_ASSERT_TRUE(c2.consumeEffectiveChanged());
  TEST_ASSERT_FALSE(c2.consumeEffectiveChanged());  // bayrak tek sefer tuketilir
  TEST_ASSERT_TRUE(c2.heatRequested());             // 22 < 25 - 1.5

  // TABAN hedef kural tarafindan EZILMEDI (§K1'in cekirdek tarafi):
  TEST_ASSERT_EQUAL_FLOAT(18.0f, c2.baseTarget());
  TEST_ASSERT_EQUAL_FLOAT(18.0f, c2.settings().target_c);
}

// ---------------------------------------------------------------------------
// 7b) K2 — KACIRILAN KURAL TELAFI EDILIYOR. Kenar tetikleme yerine "su an
//     yururlukte olan kural" hesabi. Denetcinin iki kanit senaryosu:
//     (1) 16:00 elektrik kesintisi -> 18:05 acilis (17:00 kurali varken)
//     (2) 16:59 -> 17:01 dakika atlamasi
// ---------------------------------------------------------------------------
void test_kacirilan_kural_telafi_ediliyor(void) {
  Settings s = defaultSettings();
  s.target_c = 18.0f;
  s.min_relay_hold_s = 0;
  RuleSet rs;
  rs.count = 1;
  rs.rules[0] = {true, 0x7F, 17, 0, 25.0f};

  // (1) ELEKTRIK KESINTISI: cihaz 18:05'te SIFIRDAN aciliyor (yeni Controller,
  //     NVS'ten taban hedef 18). 17:00 kurali uygulanmis olmali.
  Controller boot;
  boot.begin(s, 0);
  boot.setRules(rs);
  boot.update(1000, good(18.0f), at(3, 18, 5));
  TEST_ASSERT_EQUAL_FLOAT(25.0f, boot.effectiveTarget());
  TEST_ASSERT_TRUE(boot.ruleActive());
  TEST_ASSERT_EQUAL_UINT8(17, boot.activeRuleHour());
  TEST_ASSERT_FALSE(boot.rulesSuspended());
  TEST_ASSERT_TRUE(boot.heatRequested());  // 18 < 25 - 1.5

  // (2) DAKIKA ATLAMASI: 16:59 -> 17:01 (kural dakikasi hic gorulmedi).
  //     Iki kurallik gercekci program: 07:00 -> 20, 17:00 -> 25.
  RuleSet day;
  day.count = 2;
  day.rules[0] = {true, 0x7F, 7, 0, 20.0f};
  day.rules[1] = {true, 0x7F, 17, 0, 25.0f};
  Controller skip;
  skip.begin(s, 0);
  skip.setRules(day);
  skip.update(1000, good(18.0f), at(3, 16, 59));
  TEST_ASSERT_EQUAL_FLOAT(20.0f, skip.effectiveTarget());  // hala 07:00 kurali
  skip.update(3000, good(18.0f), at(3, 17, 1));
  TEST_ASSERT_EQUAL_FLOAT(25.0f, skip.effectiveTarget());  // 17:00 kacti ama uygulandi

  // (3) NTP SICRAMASI: saat gecersizken askida, gecerli olunca ANINDA yururlukte.
  Controller ntp;
  ntp.begin(s, 0);
  ntp.setRules(rs);
  ntp.update(1000, good(18.0f), noClock());
  TEST_ASSERT_TRUE(ntp.rulesSuspended());
  TEST_ASSERT_EQUAL_FLOAT(18.0f, ntp.effectiveTarget());
  ntp.update(3000, good(18.0f), at(3, 22, 30));  // 1970 -> 2026 sicramasi
  TEST_ASSERT_FALSE(ntp.rulesSuspended());
  TEST_ASSERT_EQUAL_FLOAT(25.0f, ntp.effectiveTarget());

  // (4) GUN DONUMU: gece 01:00'da DUNUN 23:00 kurali hala yururlukte
  //     (yoksa gece hedefi sessizce tabana donerdi).
  RuleSet night;
  night.count = 2;
  night.rules[0] = {true, 0x7F, 7, 0, 22.0f};
  night.rules[1] = {true, 0x7F, 23, 0, 17.0f};
  Controller n;
  n.begin(s, 0);
  n.setRules(night);
  n.update(1000, good(20.0f), at(3, 1, 0));
  TEST_ASSERT_EQUAL_FLOAT(17.0f, n.effectiveTarget());
  TEST_ASSERT_EQUAL_UINT8(23, n.activeRuleHour());

  // (5) NEGATIF EKSEN — hesap "EN SON gecmis tetiklenme" diyor, "herhangi bir
  //     kural" demiyor: daha ESKI tetiklenme kazanamaz ve GELECEKTEKI kural
  //     yururluge girmez.
  RuleSet mixed;
  mixed.count = 2;
  mixed.rules[0] = {true, 0x02, 17, 0, 24.0f};  // yalniz Pazartesi 17:00
  mixed.rules[1] = {true, 0x7F, 7, 0, 20.0f};   // her gun 07:00
  Controller f;
  f.begin(s, 0);
  f.setRules(mixed);
  f.update(1000, good(18.0f), at(3, 10, 0));  // Carsamba 10:00
  TEST_ASSERT_EQUAL_FLOAT(20.0f, f.effectiveTarget());  // bugunun 07:00'si, Pazartesi degil
  TEST_ASSERT_EQUAL_UINT8(7, f.activeRuleHour());
  f.update(3000, good(18.0f), at(3, 6, 30));  // 06:30: bugunun 07:00'si HENUZ gelmedi
  TEST_ASSERT_EQUAL_FLOAT(20.0f, f.effectiveTarget());  // dunun 07:00'si yururlukte
  TEST_ASSERT_EQUAL_UINT8(7, f.activeRuleHour());

  // Kapali kural hicbir zaman yururluge girmez (pozitif kontrol: acilinca girer).
  RuleSet off;
  off.count = 1;
  off.rules[0] = {false, 0x7F, 17, 0, 25.0f};
  Controller d;
  d.begin(s, 0);
  d.setRules(off);
  d.update(1000, good(18.0f), at(3, 18, 0));
  TEST_ASSERT_EQUAL_FLOAT(18.0f, d.effectiveTarget());
  TEST_ASSERT_FALSE(d.ruleActive());
  off.rules[0].enabled = true;
  d.setRules(off);
  d.update(3000, good(18.0f), at(3, 18, 0));
  TEST_ASSERT_EQUAL_FLOAT(25.0f, d.effectiveTarget());
}

// ---------------------------------------------------------------------------
// 8) KURAL AYRINTILARI: cakismada SON kural kazanir, gun maskesi, manuel mod,
//    ve kural penceresi icinde ELLE hedef degisikligi (override).
// ---------------------------------------------------------------------------
void test_kural_davranisi(void) {
  Settings s = defaultSettings();
  s.target_c = 18.0f;
  RuleSet rs;
  rs.count = 3;
  rs.rules[0] = {true, 0x7F, 17, 0, 25.0f};
  rs.rules[1] = {true, 0x7F, 17, 0, 22.0f};  // CAKISMA: ayni dakika, son kazanir
  rs.rules[2] = {false, 0x7F, 17, 0, 30.0f}; // kapali kural hic sayilmaz
  Controller c;
  c.begin(s, 0);
  c.setRules(rs);

  c.update(1000, good(20.0f), at(1, 17, 0));
  TEST_ASSERT_EQUAL_FLOAT(22.0f, c.effectiveTarget());  // son uyan kural

  // ELLE hedef degisikligi kural penceresi icinde de GECERLI olur...
  Settings manual = c.settings();
  manual.target_c = 19.0f;
  c.setSettings(manual);
  c.update(3000, good(20.0f), at(1, 17, 0));
  TEST_ASSERT_EQUAL_FLOAT(19.0f, c.effectiveTarget());
  TEST_ASSERT_TRUE(c.manualOverride());
  c.update(5000, good(20.0f), at(1, 18, 30));
  TEST_ASSERT_EQUAL_FLOAT(19.0f, c.effectiveTarget());  // ayni pencere suruyor

  // ...ama BIR SONRAKI kural tetiklendiginde duser.
  RuleSet two;
  two.count = 2;
  two.rules[0] = {true, 0x7F, 17, 0, 22.0f};
  two.rules[1] = {true, 0x7F, 23, 0, 17.0f};
  c.setRules(two);
  c.update(7000, good(20.0f), at(1, 23, 5));
  TEST_ASSERT_FALSE(c.manualOverride());
  TEST_ASSERT_EQUAL_FLOAT(17.0f, c.effectiveTarget());

  // Gun maskesi: hafta ici 08:30 -> 24 kurali, hafta sonu 09:00 -> 19 kurali.
  // Cumartesi 10:00'da hafta SONU kurali yururlukte; Pazartesi 10:00'da hafta
  // ICI kurali. (Maske "hangi gun tetiklenir"i belirler; tetiklenen hedef
  // bir sonraki tetiklenmeye kadar surer.)
  RuleSet masked;
  masked.count = 2;
  masked.rules[0] = {true, 0x3E, 8, 30, 24.0f};  // Pzt-Cum
  masked.rules[1] = {true, 0x41, 9, 0, 19.0f};   // Cmt+Paz
  Controller c2;
  c2.begin(s, 0);
  c2.setRules(masked);
  c2.update(1000, good(20.0f), at(6, 10, 0));  // Cumartesi
  TEST_ASSERT_EQUAL_FLOAT(19.0f, c2.effectiveTarget());
  c2.update(3000, good(20.0f), at(1, 10, 0));  // Pazartesi
  TEST_ASSERT_EQUAL_FLOAT(24.0f, c2.effectiveTarget());
  c2.update(5000, good(20.0f), at(1, 8, 0));  // Pazartesi 08:00: hafta sonu kurali surer
  TEST_ASSERT_EQUAL_FLOAT(19.0f, c2.effectiveTarget());

  // Manuel mod: kurallar tamamen durur (ve askiya alinmis da sayilmaz).
  Settings m = defaultSettings();
  m.target_c = 18.0f;
  m.manual_mode = true;
  Controller c3;
  c3.begin(m, 0);
  c3.setRules(rs);
  c3.update(1000, good(20.0f), at(1, 17, 0));
  TEST_ASSERT_EQUAL_FLOAT(18.0f, c3.effectiveTarget());
  TEST_ASSERT_FALSE(c3.rulesSuspended());
  TEST_ASSERT_FALSE(c3.ruleActive());
}

// ---------------------------------------------------------------------------
// 8b) K1 — BULUT YOLU KURALI GERI ALMIYOR. Cekirdek tarafi: bulut TABAN hedefi
//     (21) tekrar tekrar gonderse de kural hedefi (25) ayakta kalir ve NVS'e
//     YAZMA ISTEGI uretilmez. (Gercek HTTP ile ucu uca olcum:
//     tests/device_sync_test.mjs F9-F12 + firmware/tools/core_cli.)
// ---------------------------------------------------------------------------
void test_bulut_kurali_geri_almiyor(void) {
  Settings base = defaultSettings();
  base.target_c = 21.0f;
  base.min_relay_hold_s = 0;
  RuleSet rules;
  rules.count = 1;
  rules.rules[0] = {true, 0x7F, 17, 0, 25.0f};

  Controller c;
  c.begin(base, 0);
  c.setRules(rules);

  c.update(1000, good(20.0f), at(3, 17, 0));
  TEST_ASSERT_EQUAL_FLOAT(25.0f, c.effectiveTarget());

  // Bulut 12 tur boyunca AYNI veriyi gonderiyor (taban 21 + ayni kural).
  int persist_count = 0;
  uint32_t t = 3000;
  for (int i = 0; i < 12; i++, t += 30000) {
    Settings cloud = base;                       // bulutta taban hala 21
    RuleSet cloud_rules = rules;
    CloudApply a = applyCloudState(c, rules, &cloud, &cloud_rules);
    if (a.needs_persist) persist_count++;
    c.update(t, good(20.0f), at(3, 17, 30));
    // HER turda: yururlukteki hedef 25 KALIYOR, taban 21 kaliyor.
    TEST_ASSERT_EQUAL_FLOAT(25.0f, c.effectiveTarget());
    TEST_ASSERT_EQUAL_FLOAT(21.0f, c.baseTarget());
    TEST_ASSERT_TRUE(c.ruleActive());
  }
  TEST_ASSERT_EQUAL_INT(0, persist_count);  // Y1: hic NVS yazmasi istenmedi

  // POZITIF KONTROL (ayni eksen): bulut GERCEKTEN yeni bir taban gonderirse
  // uygulanir ve NVS yazmasi istenir.
  Settings changed = base;
  changed.target_c = 19.0f;
  RuleSet same_rules = rules;
  CloudApply a2 = applyCloudState(c, rules, &changed, &same_rules);
  TEST_ASSERT_TRUE(a2.settings_changed);
  TEST_ASSERT_TRUE(a2.needs_persist);
  TEST_ASSERT_EQUAL_FLOAT(19.0f, c.baseTarget());
}

// ---------------------------------------------------------------------------
// 8c) Y1 — BOS KURAL YUVALARI "degisti" DEMEZ. Belirsiz/cop baytli bir RuleSet
//     (count=0) mevcut bos kural listesine ESIT sayilmali; yoksa her bulut
//     turunda NVS yazilir (olculdu: ~5 sn'de bir, gunde ~17 bin yazma).
// ---------------------------------------------------------------------------
void test_bos_kural_yuvalari_nvs_yazdirmaz(void) {
  RuleSet garbage;
  memset(garbage.rules, 0xA5, sizeof(garbage.rules));  // dolu yuvalar cop
  garbage.count = 0;
  RuleSet empty;
  empty.count = 0;

  // Dogru eksen: DOLU yuvalar. (memcmp tum diziyi okur ve "farkli" der.)
  TEST_ASSERT_TRUE(rulesEqual(garbage, empty));
  TEST_ASSERT_NOT_EQUAL(0, memcmp(garbage.rules, empty.rules, sizeof(empty.rules)));

  Settings s = defaultSettings();
  Controller c;
  c.begin(s, 0);
  RuleSet live;
  live.count = 0;

  int persist_count = 0;
  for (int i = 0; i < 100; i++) {
    RuleSet incoming;
    memset(incoming.rules, (int)(0x11 + i), sizeof(incoming.rules));
    incoming.count = 0;  // bulut "kural yok" diyor
    Settings cloud = s;
    if (applyCloudState(c, live, &cloud, &incoming).needs_persist) persist_count++;
  }
  TEST_ASSERT_EQUAL_INT(0, persist_count);

  // POZITIF KONTROL: gercek bir kural gelince TEK yazma istenir, sonraki
  // ayni turlar yazdirmaz.
  RuleSet one;
  one.count = 1;
  one.rules[0] = {true, 0x7F, 7, 0, 22.0f};
  Settings cloud = s;
  TEST_ASSERT_TRUE(applyCloudState(c, live, &cloud, &one).needs_persist);
  TEST_ASSERT_FALSE(applyCloudState(c, live, &cloud, &one).needs_persist);
  TEST_ASSERT_EQUAL_UINT8(1, live.count);
}

// ---------------------------------------------------------------------------
// 8d) Y4 — BULUT YOKLAMA PERIYODU GERI CEKILMEDEN AYRI. Basarili turdan sonra
//     periyot 30 sn; hata halinde geri cekilme (backoff) kullanilir.
//     Olcum ekseni: 24 saatte cagri sayisi (Supabase ucretsiz tavan 500k/ay).
// ---------------------------------------------------------------------------
void test_bulut_yoklama_periyodu(void) {
  const uint32_t period = 30000;
  uint32_t last = 0;
  int calls = 0;
  bool first_done = false;
  for (uint32_t t = 0; t < 86400000u; t += 1000) {
    if (cloudDue(first_done, true, t, last, period, 5000)) {
      calls++;
      last = t;
      first_done = true;
    }
  }
  TEST_ASSERT_EQUAL_INT(2880, calls);  // 24 saat / 30 sn
  // Ayda 30 gun: 86.430 cagri -> 500.000 tavanin %18'i.
  TEST_ASSERT_LESS_THAN_INT(500000 / 30, calls);

  // POZITIF KONTROL (ayni eksen): periyot 5 sn olsa alet 17 binden fazla cagri
  // GORUYOR -> yukaridaki 2881 olu aletten gelmiyor.
  last = 0;
  calls = 0;
  first_done = false;
  for (uint32_t t = 0; t < 86400000u; t += 1000) {
    if (cloudDue(first_done, true, t, last, 5000, 5000)) {
      calls++;
      last = t;
      first_done = true;
    }
  }
  TEST_ASSERT_GREATER_THAN_INT(17000, calls);

  // Hata halinde GERI CEKILME kullanilir (periyot degil): 60 sn backoff ile
  // 30 sn'de hazir degil.
  TEST_ASSERT_FALSE(cloudDue(true, false, 30000, 0, period, 60000));
  TEST_ASSERT_TRUE(cloudDue(true, false, 61000, 0, period, 60000));
  // Acilista ilk cagri beklemez.
  TEST_ASSERT_TRUE(cloudDue(false, false, 0, 0, period, 60000));
}

// ---------------------------------------------------------------------------
// 9) BULUT/WIFI KOPUKKEN 1 SAAT: cekirdege hic ayar/kural gelmese de termostat
//    normal calisir (plan §4 Faz 1 "kopukluk testi"nin yazilim tarafi).
// ---------------------------------------------------------------------------
void test_bulut_kopukken_bir_saat(void) {
  Settings s = defaultSettings();
  s.target_c = 21.0f;
  s.hysteresis_c = 3.0f;
  s.min_relay_hold_s = 300;
  Controller c;
  c.begin(s, 0);

  // Odanin isinip sogumasini kabaca taklit et; 1 saat boyunca 2 sn'lik dongu.
  float temp = 17.0f;
  int on_ticks = 0, off_ticks = 0, switches = 0;
  bool prev = false;
  for (uint32_t t = 0; t < 3600000u; t += 2000) {
    bool heat = c.update(t, good(temp), noClock());  // DIKKAT: saat yok, bulut yok
    if (heat != prev) switches++;
    prev = heat;
    if (heat) { on_ticks++; temp += 0.01f; } else { off_ticks++; temp -= 0.008f; }
  }
  TEST_ASSERT_GREATER_THAN_INT(0, on_ticks);
  TEST_ASSERT_GREATER_THAN_INT(0, off_ticks);
  // 1 saatte makul sayida anahtarlama (sik ac-kapa yok): 5 dk bekleme ile ust
  // sinir teorik olarak 12; bant genisligi bunu daha da dusurur.
  TEST_ASSERT_LESS_OR_EQUAL_INT(12, switches);
  TEST_ASSERT_GREATER_THAN_INT(0, switches);
}

// ---------------------------------------------------------------------------
// 10) AYAR DOGRULAMA: bozuk degerler guvenli araliga cekilir.
//     Pozitif kontrol: gecerli ayar HIC degistirilmez (clamp "her seyi eziyor" degil).
// ---------------------------------------------------------------------------
void test_ayar_dogrulama(void) {
  Settings bad_s = defaultSettings();
  bad_s.target_c = 1000.0f;
  bad_s.hysteresis_c = 0.0f;
  bad_s.freeze_guard_c = 99.0f;
  bad_s.min_relay_hold_s = 60000;
  TEST_ASSERT_TRUE(clampSettings(bad_s));
  TEST_ASSERT_EQUAL_FLOAT(30.0f, bad_s.target_c);
  TEST_ASSERT_EQUAL_FLOAT(MIN_BAND_C, bad_s.hysteresis_c);
  TEST_ASSERT_EQUAL_FLOAT(12.0f, bad_s.freeze_guard_c);  // hedef 30 oldugu icin 12 serbest
  TEST_ASSERT_EQUAL_UINT16(1800, bad_s.min_relay_hold_s);

  Settings nan_s = defaultSettings();
  nan_s.target_c = 0.0f / 0.0f;  // NaN
  TEST_ASSERT_TRUE(clampSettings(nan_s));
  TEST_ASSERT_EQUAL_FLOAT(5.0f, nan_s.target_c);
  TEST_ASSERT_EQUAL_FLOAT(4.5f, nan_s.freeze_guard_c);  // hedef 5 -> esik kirpildi

  // POZITIF KONTROL
  Settings ok = defaultSettings();
  TEST_ASSERT_FALSE(clampSettings(ok));
  TEST_ASSERT_EQUAL_FLOAT(21.0f, ok.target_c);
  TEST_ASSERT_EQUAL_FLOAT(3.0f, ok.hysteresis_c);
  TEST_ASSERT_EQUAL_FLOAT(6.0f, ok.freeze_guard_c);
}

void test_kural_dogrulama(void) {
  RuleSet rs;
  rs.count = 5;
  rs.rules[0] = {true, 0x7F, 25, 0, 22.0f};   // saat gecersiz -> atilir
  rs.rules[1] = {true, 0x7F, 7, 70, 22.0f};   // dakika gecersiz -> atilir
  rs.rules[2] = {true, 0x00, 7, 0, 22.0f};    // bos gun maskesi -> atilir
  rs.rules[3] = {true, 0x7F, 7, 0, 99.0f};    // hedef aralik disi -> atilir
  rs.rules[4] = {true, 0x7F, 7, 0, 22.0f};    // GECERLI
  TEST_ASSERT_EQUAL_UINT8(4, sanitizeRules(rs));
  TEST_ASSERT_EQUAL_UINT8(1, rs.count);
  TEST_ASSERT_EQUAL_FLOAT(22.0f, rs.rules[0].target_c);  // basa sikistirildi
}

// ---------------------------------------------------------------------------
// 11) KALICI HAFIZA PAKETLEMESI: elektrik kesintisi sonrasi hedefin geri
//     gelmesinin yazilim tarafi. Gidis-donus + BOZUK kaydin reddi.
// ---------------------------------------------------------------------------
void test_kalici_hafiza_gidis_donus(void) {
  Settings s = defaultSettings();
  s.target_c = 23.5f;
  s.hysteresis_c = 2.5f;
  s.manual_mode = true;
  s.min_relay_hold_s = 240;
  RuleSet rs;
  rs.count = 2;
  rs.rules[0] = {true, 0x3E, 7, 30, 22.0f};
  rs.rules[1] = {true, 0x7F, 23, 0, 17.0f};

  uint8_t buf[BLOB_MAX];
  const size_t n = packState(s, rs, buf, sizeof(buf));
  TEST_ASSERT_GREATER_THAN_UINT32(0, (uint32_t)n);

  Settings out = defaultSettings();
  RuleSet out_rs;
  TEST_ASSERT_TRUE(unpackState(buf, n, out, out_rs));
  TEST_ASSERT_EQUAL_FLOAT(23.5f, out.target_c);
  TEST_ASSERT_EQUAL_FLOAT(2.5f, out.hysteresis_c);
  TEST_ASSERT_TRUE(out.manual_mode);
  TEST_ASSERT_EQUAL_UINT16(240, out.min_relay_hold_s);
  TEST_ASSERT_EQUAL_UINT8(2, out_rs.count);
  TEST_ASSERT_EQUAL_UINT8(0x3E, out_rs.rules[0].days_mask);
  TEST_ASSERT_EQUAL_FLOAT(17.0f, out_rs.rules[1].target_c);

  // MUTASYON (pozitif kontrol): tek bayt bozulursa kayit REDDEDILIR.
  // Bu olmasa "unpack her zaman true donuyor" olabilirdi.
  uint8_t corrupt[BLOB_MAX];
  for (size_t i = 0; i < n; i++) corrupt[i] = buf[i];
  corrupt[5] ^= 0xFF;
  Settings out2 = defaultSettings();
  RuleSet out_rs2;
  TEST_ASSERT_FALSE(unpackState(corrupt, n, out2, out_rs2));
  TEST_ASSERT_EQUAL_FLOAT(21.0f, out2.target_c);  // cagiran taraf varsayilanda kalir

  // Bos/kisa kayit da reddedilir (ilk acilis: NVS bos).
  TEST_ASSERT_FALSE(unpackState(buf, 4, out2, out_rs2));
  TEST_ASSERT_FALSE(unpackState(0, 0, out2, out_rs2));

  // Kaydedilmis hedefle devam: sanki elektrik kesildi, cihaz NVS'ten okudu.
  Controller c;
  c.begin(out, 0);
  c.setRules(out_rs);
  TEST_ASSERT_EQUAL_FLOAT(23.5f, c.baseTarget());
  TEST_ASSERT_EQUAL_FLOAT(23.5f, c.effectiveTarget());
  TEST_ASSERT_FALSE(c.heatRequested());  // acilista hala isi istegi YOK
}

int main(int, char**) {
  UNITY_BEGIN();
  RUN_TEST(test_acilista_isi_istegi_yok);
  RUN_TEST(test_histerezis_esikleri);
  RUN_TEST(test_salinim_yok_ve_alet_canli);
  RUN_TEST(test_bant_alt_siniri_sensore_bagli);
  RUN_TEST(test_sensor_arizasi_isitmayi_keser);
  RUN_TEST(test_sensor_zaman_asimi_tabani);
  RUN_TEST(test_ariza_sirasinda_donma_korumasi);
  RUN_TEST(test_donma_korumasi);
  RUN_TEST(test_donma_birakma_payi_banttan_bagimsiz);
  RUN_TEST(test_asgari_bekleme_ve_emniyet_atlamasi);
  RUN_TEST(test_ariza_sonrasi_toparlanma_gecikmiyor);
  RUN_TEST(test_saat_yoksa_kurallar_askida);
  RUN_TEST(test_kacirilan_kural_telafi_ediliyor);
  RUN_TEST(test_kural_davranisi);
  RUN_TEST(test_bulut_kurali_geri_almiyor);
  RUN_TEST(test_bos_kural_yuvalari_nvs_yazdirmaz);
  RUN_TEST(test_bulut_yoklama_periyodu);
  RUN_TEST(test_bulut_kopukken_bir_saat);
  RUN_TEST(test_ayar_dogrulama);
  RUN_TEST(test_kural_dogrulama);
  RUN_TEST(test_kalici_hafiza_gidis_donus);
  return UNITY_END();
}
