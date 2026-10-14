// Karar cekirdeginin birim testleri — `pio test -e native` ile MAKINEDE kosar,
// karta flash gerekmez. Her iddianin yaninda AYNI EKSENDE pozitif kontrol var:
// yani "yesil" cikan testin aletinin olu olmadigi, kasitli bir mutasyon/karsi
// senaryo ile ayrica gosteriliyor. (Sahte yesil kadar sahte kirmiziya da bakildi.)
#include <unity.h>

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
//    Pozitif kontrol: ayni dizi, bant 0.4 °C'ye daraltilinca ALET SALINIMI GORUR.
//    (Bu kontrol olmasa "0 anahtarlama" sonucu testin olu olmasindan da gelebilirdi.)
// ---------------------------------------------------------------------------
static int salinim_sayaci(float band) {
  Settings s = defaultSettings();
  // Hedef 21.5 secildi ki DHT11'in tam sayi adimlari (21 / 22) bandin IKI
  // yanina dussun. Hedef 21.0 olsa 21 okumasi dar bantta da "bant ici"ne
  // dusuyor ve dar bant SALINMIYOR gorunuyordu (ilk olcumde pozitif kontrol
  // boyle patladi: 1 anahtarlama). Ders: kontrolun senaryoyu gercekten
  // kurdugunu once olc.
  s.target_c = 21.5f;
  s.hysteresis_c = band;
  s.min_relay_hold_s = 0;  // asgari bekleme KAPALI: salinimi bantin onledigini olc
  Controller c;
  c.begin(s, 0);

  // Isitma zaten acik bir noktadan baslat (18 °C), sonra DHT11'in tam sayi
  // adimlariyla hedef civarinda zipla: 21,22,21,22,...
  c.update(0, good(18.0f), noClock());
  bool prev = c.heatRequested();
  int switches = 0;
  uint32_t t = 2000;
  for (int i = 0; i < 60; i++, t += 2000) {
    const float temp = (i % 2 == 0) ? 21.0f : 22.0f;
    bool now = c.update(t, good(temp), noClock());
    if (now != prev) switches++;
    prev = now;
  }
  return switches;
}

void test_salinim_yok_ve_alet_canli(void) {
  // Gercek urun ayari (3.0 °C bant): 21/22 zipllamasi roleyi hic anahtarlamaz.
  TEST_ASSERT_EQUAL_INT(0, salinim_sayaci(3.0f));

  // POZITIF KONTROL — ayni eksen (anahtarlama sayisi), tek degisiklik bant:
  // bant 0.4 °C olunca 21 <-> 22 zipllamasi her adimda anahtarliyor.
  // Alet salinimi GORUYOR; yukaridaki 0 bu yuzden anlamli.
  TEST_ASSERT_GREATER_THAN_INT(10, salinim_sayaci(0.4f));
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
// 5) DONMA KORUMASI: 6 °C altinda hedeften bagimsiz ZORLA isitir, bant kadar
//    isinmadan birakmaz. Pozitif kontrol: esigin ustunde ayni dusuk hedefle
//    isitma acilmiyor (yani "her zaman aciyor" degil).
// ---------------------------------------------------------------------------
void test_donma_korumasi(void) {
  Settings s = defaultSettings();
  s.target_c = 5.0f;   // kullanici hedefi en dipte: donma korumasi devrede olmali
  s.hysteresis_c = 3.0f;
  s.freeze_guard_c = 6.0f;
  s.min_relay_hold_s = 300;  // asgari bekleme ACIK: emniyetin onu atladigini olc
  Controller c;
  c.begin(s, 0);

  c.update(1000, good(5.5f), noClock());
  TEST_ASSERT_TRUE(c.heatRequested());
  TEST_ASSERT_EQUAL_INT((int)HeatReason::FreezeGuard, (int)c.reason());

  c.update(2000, good(6.5f), noClock());  // esigin ustu ama bant dolmadi -> mandal
  TEST_ASSERT_TRUE(c.heatRequested());
  TEST_ASSERT_EQUAL_INT((int)HeatReason::FreezeGuard, (int)c.reason());

  c.update(3000, good(9.1f), noClock());  // 6 + 3 = 9 -> mandal acilir
  TEST_ASSERT_NOT_EQUAL((int)HeatReason::FreezeGuard, (int)c.reason());

  // POZITIF KONTROL: ayni ayarla 10 °C'de isitma istenmiyor (hedef 5, bant ust
  // esigi 6.5) -> donma korumasi "her kosulda acik" bir sabit degil.
  Controller c2;
  c2.begin(s, 0);
  c2.update(1000, good(10.0f), noClock());
  TEST_ASSERT_FALSE(c2.heatRequested());
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
// 7) SAAT BILINMIYORSA SAATLI KURALLAR ASKIDA (plan §3 bilincli sinir),
//    termostat son hedefle SURER. Pozitif kontrol: ayni kural, saat gecerliyken
//    tetikleniyor -> askiya alma "kural hic calismiyor" demek degil.
// ---------------------------------------------------------------------------
void test_saat_yoksa_kurallar_askida(void) {
  Settings s = defaultSettings();
  s.target_c = 18.0f;
  s.min_relay_hold_s = 0;
  RuleSet rs;
  rs.count = 1;
  rs.rules[0] = {true, 0x7F, 17, 0, 25.0f};  // her gun 17:00 -> 25 °C

  Controller c;
  c.begin(s, 0);
  c.setRules(rs);

  // Saat YOK: kural uygulanmaz, hedef 18 kalir, ama termostat calisir.
  c.update(1000, good(16.0f), noClock());
  TEST_ASSERT_TRUE(c.rulesSuspended());
  TEST_ASSERT_EQUAL_FLOAT(18.0f, c.effectiveTarget());
  TEST_ASSERT_TRUE(c.heatRequested());  // 16 < 18 - 1.5 -> isitiyor
  c.update(3000, good(22.0f), noClock());
  TEST_ASSERT_FALSE(c.heatRequested());  // 22 > 18 + 1.5 -> kesiyor (termostat SURUYOR)

  // POZITIF KONTROL: saat gecerli ve 17:00 -> ayni kural hedefi 25'e cekiyor.
  Controller c2;
  c2.begin(s, 0);
  c2.setRules(rs);
  c2.update(1000, good(22.0f), at(3, 16, 59));
  TEST_ASSERT_FALSE(c2.rulesSuspended());
  TEST_ASSERT_EQUAL_FLOAT(18.0f, c2.effectiveTarget());
  c2.update(3000, good(22.0f), at(3, 17, 0));
  TEST_ASSERT_EQUAL_FLOAT(25.0f, c2.effectiveTarget());
  TEST_ASSERT_TRUE(c2.consumeTargetChanged());
  TEST_ASSERT_FALSE(c2.consumeTargetChanged());  // bayrak tek sefer tuketilir
  TEST_ASSERT_TRUE(c2.heatRequested());          // 22 < 25 - 1.5
}

// ---------------------------------------------------------------------------
// 8) KURAL AYRINTILARI: ayni dakikada tekrar tetiklemez, sonraki haftada tekrar
//    tetikler, cakismada SON kural kazanir, manuel mod kurallari durdurur.
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

  // Ayni dakika icinde kullanici hedefi elle degistirirse kural tekrar basmaz.
  Settings manual = c.settings();
  manual.target_c = 19.0f;
  c.setSettings(manual);
  c.update(3000, good(20.0f), at(1, 17, 0));
  TEST_ASSERT_EQUAL_FLOAT(19.0f, c.effectiveTarget());

  // Dakika gecti -> kilit acilir; gelecek hafta ayni gun/saat TEKRAR tetikler.
  c.update(5000, good(20.0f), at(1, 17, 1));
  TEST_ASSERT_EQUAL_FLOAT(19.0f, c.effectiveTarget());
  c.update(7000, good(20.0f), at(1, 17, 0));
  TEST_ASSERT_EQUAL_FLOAT(22.0f, c.effectiveTarget());

  // Gun maskesi: yalniz Pazartesi (bit1) kurali Carsambada tetiklenmez.
  RuleSet only_mon;
  only_mon.count = 1;
  only_mon.rules[0] = {true, 0x02, 8, 30, 24.0f};
  Controller c2;
  c2.begin(s, 0);
  c2.setRules(only_mon);
  c2.update(1000, good(20.0f), at(3, 8, 30));
  TEST_ASSERT_EQUAL_FLOAT(18.0f, c2.effectiveTarget());
  c2.update(3000, good(20.0f), at(1, 8, 30));  // Pazartesi
  TEST_ASSERT_EQUAL_FLOAT(24.0f, c2.effectiveTarget());

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
  TEST_ASSERT_EQUAL_FLOAT(0.5f, bad_s.hysteresis_c);
  TEST_ASSERT_EQUAL_FLOAT(12.0f, bad_s.freeze_guard_c);
  TEST_ASSERT_EQUAL_UINT16(1800, bad_s.min_relay_hold_s);

  Settings nan_s = defaultSettings();
  nan_s.target_c = 0.0f / 0.0f;  // NaN
  TEST_ASSERT_TRUE(clampSettings(nan_s));
  TEST_ASSERT_EQUAL_FLOAT(5.0f, nan_s.target_c);

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
  TEST_ASSERT_EQUAL_FLOAT(23.5f, c.effectiveTarget());
  TEST_ASSERT_FALSE(c.heatRequested());  // acilista hala isi istegi YOK
}

int main(int, char**) {
  UNITY_BEGIN();
  RUN_TEST(test_acilista_isi_istegi_yok);
  RUN_TEST(test_histerezis_esikleri);
  RUN_TEST(test_salinim_yok_ve_alet_canli);
  RUN_TEST(test_sensor_arizasi_isitmayi_keser);
  RUN_TEST(test_donma_korumasi);
  RUN_TEST(test_asgari_bekleme_ve_emniyet_atlamasi);
  RUN_TEST(test_saat_yoksa_kurallar_askida);
  RUN_TEST(test_kural_davranisi);
  RUN_TEST(test_bulut_kopukken_bir_saat);
  RUN_TEST(test_ayar_dogrulama);
  RUN_TEST(test_kural_dogrulama);
  RUN_TEST(test_kalici_hafiza_gidis_donus);
  return UNITY_END();
}
