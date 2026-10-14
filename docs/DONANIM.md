# Donanım — ölçülen gerçekler (14.10.2026)

Bu dosyadaki her satır ölçümdür; varsayım yoktur. Ölçmeden değiştirmeyin.

## Kart

| Ne | Değer | Nasıl ölçüldü |
|---|---|---|
| Yonga | ESP32-D0WD-V3, rev 3.1, çift çekirdek 240 MHz | `esptool` kimlik okuması |
| Flash | 4 MB, mod DIO, 3.3 V | ROM açılış satırı + `esptool` |
| MAC | `68:09:47:52:F3:08` | `esptool` / `WiFi.macAddress()` |
| USB köprüsü | CH340 (`0x1A86/0x7523`), port `/dev/cu.wchusbserial140` | sistem |
| Baud | **115200 çalışır. 460800 bozuk paket verir** | denendi, düştü |
| PlatformIO kartı | `esp32dev`, `board_build.flash_mode = dio` | derleme + flash başarılı |

**Orijinal firmware yedeği:** `~/Desktop/Projeler/kombi-orijinal-firmware-yedek/esp32-orijinal-4MB-20261014.bin`
(4.194.304 bayt, `esptool verify-flash` ile karta karşı doğrulandı). Depo dışında
durur, git'e girmez. Geri yükleme gerekirse Patron'a söyleyin.

## Pinler — ölçülerek bulundu (eski firmware kaynağı yoktu)

`firmware/tools/pin_scan` ile:

| Pin | Rol | Kanıt |
|---|---|---|
| **GPIO 18** | DHT11 veri | DHT11 protokolü bu pinde geçerli veri döndürdü (23.5 °C / 55 %) |
| **GPIO 23** | Röle modülü IN | Dışarıdan yukarı çekilmiş tek diğer pin. Negatif kontrol: kalan 17 aday pin dahili pulldown'da LOW okudu |

GPIO 0 da dışarıdan HIGH okur — kartın kendi strapping pull-up'ı, beklenen.

Röle **ACTIVE LOW**: GPIO LOW = röle çeker. `kombi_core.h` içindeki
`RELAY_LEVEL_ON = 0` / `RELAY_LEVEL_OFF = 1` tek kaynaktır.

## Açılış emniyeti — ve kalan tek açık

Firmware sırası (bkz. `relaySafeBoot()`): pini oku → dahili pull-up → çıkış
kaydına OFF yaz → `pinMode(OUTPUT)`. Ölçüm: her açılışta seri porta
`ACILIS: role pini GPIO 23, kod oncesi seviye=HIGH` satırı düşüyor; röle
çekiliyken reset atıldığında bile çekmiyor (bkz. `docs/FAZ1-TEST-SONUCLARI.md` H1).

**Kalan açık:** reset ile kodumuzun arasındaki ~200 ms'de pini tutan tek şey röle
modülünün kendi giriş katmanıdır. Ölçüm bu pencerede hattın HIGH olduğunu
gösteriyor, ama garanti eden bir harici direnç yok.

### 🟡 HARİCİ 10 kΩ PULL-UP — ÖNERİLİR (15.10: tıkayıcılıktan çıkarıldı)

GPIO 23 ile 3V3 arasına **10 kΩ**. 14.10'da "blokajlı ön koşul" yazılmıştı
(kod denetimi O1); **15.10.2026 02:00'de bu etiket geri alındı.** Gerekçe ve
dürüst sınırı `docs/FAZ3-KONTROL-LISTESI.md` §B1'de: modül ACTIVE LOW olduğu
için boşta kalan giriş röleyi süremez, ve röle yanlışlıkla çekili kalsa bile
ortaya çıkan durum klemensin bugünkü **köprülü** hâlinin aynısıdır. Direnç
hâlâ önerilir — ölçemediğimiz açılış penceresini fiziğe bağlar — ama bağlantıyı
geciktirmesi gerekmez.

- **Neden:** kombi bağlandıktan sonra o ~200 ms'lik pencerede röle çekerse kombi
  istemsiz yanar. Elektrik kesintisi sonrası her açılışta tekrarlanan bir risktir.
- **Ölçümün kapsamadığı yer (dürüst sınır):** `docs/FAZ1-TEST-SONUCLARI.md`
  H1a satırı yalnız **kodumuz çalıştıktan sonrasını** ölçer
  (`boot_pad_level`, seri porta basılan ilk satır). Reset ile kodun arasındaki
  ilk milisaniyeleri ölçen bir aletimiz **yok**; o pencere için kanıtımız
  `tools/pin_scan` ölçümüdür (pulldown açıkken hat HIGH okudu = modülün giriş
  katmanı hattı yukarı çekiyor), ki bu **dolaylı** bir kanıttır.
- **Kabul ölçümü (Faz 3'te):** direnç takıldıktan sonra kart ENERJİSİZ iken
  GPIO 23 – 3V3 arası direnç ~10 kΩ okunmalı, ve röle çekiliyken reset atıldığında
  `pad=HIGH` satırı yine görülmeli.

## TLS kök sertifikası

`firmware/src/ca_cert.cpp` içinde **ISRG Root X1** gömülü.
Ölçüm (`openssl s_client -connect supabase.co:443`, 14.10.2026):
`supabase.co ← Let's Encrypt YR1 ← ISRG Root YR ← ISRG Root X1`.
Sertifika **04.06.2035**'te doluyor; o tarihten önce yenilenmeli.
`ALLOW_INSECURE_TLS` yalnız hata ayıklama içindir, 0 kalmalı.

## Kombi (Faz 3 için, Faz 1'i etkilemez)

Demirdöküm **Kalisto HK D224**, hermetik, 9–24 kW, G20 doğalgaz, 230V/50Hz 164W,
IPX4D, min. çalışma sıcaklığı 5 °C, seri 9100154211006110313482.
Termostat girişi **kuru kontak**, klemensler RT / 24V / GND, 24 V DC / 1 A.
Bağlantı düzeni ve köprü çıkarma adımları planın §Faz 3 bölümünde.
