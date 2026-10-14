// config.example.h — SABLON. Kopyalayin:
//     cp include/config.example.h include/config.h
// ve `config.h` icindeki degerleri doldurun.
//
// ⚠️ `include/config.h` .gitignore'da; ASLA depoya girmez. Sirlar (WiFi sifresi,
// cihaz sirri, Supabase anahtari) yalniz orada durur. Bu sablonda gercek deger
// YOKTUR — plan §6 "Sirlar" maddesi.
#pragma once

// --- WiFi --------------------------------------------------------------------
// Bos birakilirsa cihaz WiFi'ye HIC baglanmaz ve tamamen yerel termostat olarak
// calisir (plan §5: bulut kalici kesildiginde beklenen davranis). Faz 1'de
// masa ustu testi bu sekilde de yapilabilir.
#define WIFI_SSID ""
#define WIFI_PASS ""

// --- Supabase ----------------------------------------------------------------
// Cihaz tablolara DOGRUDAN erismez; tek kapisi `device-sync` Edge Function'dir
// (plan §6 "Cihaz kimligi"). Asagidaki adres o fonksiyonun tam URL'si olmali.
// Ornek bicim: https://<proje-ref>.supabase.co/functions/v1/device-sync
#define SUPABASE_FUNCTION_URL ""
// Fonksiyon `verify_jwt = false` ile yayinlanir; anon anahtar zorunlu degildir.
// Doldurulursa `apikey` basligi olarak gonderilir.
#define SUPABASE_ANON_KEY ""

// Cihaz kimligi + sirri. Sir en az 32 karakter rastgele olsun:
//     openssl rand -hex 32
// Ayni sirrin SHA-256 ozeti Supabase'deki `devices.secret_sha256` alanina girer;
// sirrin kendisi veritabaninda DURMAZ.
#define DEVICE_ID "kombi-salon"
#define DEVICE_SECRET ""

// --- Pinler ------------------------------------------------------------------
// ÖLÇÜLDÜ 14.10.2026 (firmware/tools/pin_scan ile, varsayim degil):
//   DHT11 veri hatti  -> GPIO 18  (DHT11 protokolu bu pinde gecerli veri dondu)
//   Role modulu IN    -> GPIO 23  (disaridan yukari cekilmis tek diger pin;
//                                  kalan 17 aday pin pulldown'da LOW okudu)
#define PIN_DHT 18
#define PIN_RELAY 23

// --- Saat --------------------------------------------------------------------
// Turkiye sabit UTC+3, yaz saati uygulamasi yok (plan §2).
#define NTP_SERVER_1 "tr.pool.ntp.org"
#define NTP_SERVER_2 "pool.ntp.org"
#define TZ_OFFSET_SEC 10800

// --- Seri konsol benzetim komutlari -----------------------------------------
// 0 = KAPALI (varsayilan, guvenli). 1 = `sim`/`wifi`/`wdtest` komutlari acik.
//
// ⚠️ Bu bayrak USB'si elinde olan birine roleyi surdurur (`sim temp 10` ->
// isitma acilir). Bu yuzden:
//   · sablon varsayilani 0'dir — `cp config.example.h config.h` diyen kimse
//     sim'i acik bir kart elde etmez,
//   · 1 yapilsa bile YALNIZ gelistirme ortaminda derlenir: `pio run -e esp32dev`
//     (-DKOMBI_DEV_BUILD=1). Kalici montaj `pio run -e esp32dev_prod` ile
//     derlenir ve o ortam bayragi zorla 0'a ceker.
//   · Acilis bannerinda ve `info` ciktisinda `SIM=0/1` yaziyor: flash'lanmis
//     kartta durum GOZLE olculebilir.
// Derleme bayragi verilmisse (prod ortami) buradaki deger ezilmesin:
#ifndef KOMBI_ALLOW_SIM
#define KOMBI_ALLOW_SIM 0
#endif

// --- TLS ---------------------------------------------------------------------
// 0 = sunucu sertifikasi ASIL koke karsi dogrulanir (asagidaki ISRG Root X1).
// 1 = dogrulama kapanir (ortadaki-adam riski). Sadece hata ayiklamak icin.
#define ALLOW_INSECURE_TLS 0
