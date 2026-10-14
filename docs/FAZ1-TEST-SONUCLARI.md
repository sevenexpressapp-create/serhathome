# Faz 1 — kabul testleri (14.10.2026)

Hepsi koşuldu; aşağıdaki değerler çıktıdan alınmıştır. Her yasak/olumsuz iddianın
yanında **aynı eksende pozitif kontrol** var: ölçen aletin ölü olmadığı ayrıca
gösterildi.

## A. Karar çekirdeği — birim testleri (makinede, karta gerek yok)

`cd firmware && pio test -e native` → **12/12 geçti** (0,93 sn).

Kapsam: açılışta ısı isteği yok · histerezis eşikleri · salınım yok (pozitif
kontrol: dar bantta alet salınımı görüyor) · sensör arızası kesme · donma koruması
mandalı · asgari bekleme ve emniyetin onu atlaması · saat yokken kuralların
askıya alınması · kural çakışması/gün maskesi/manuel mod · bulut kopukken 1 saat
· ayar ve kural doğrulama · NVS paketleme gidiş-dönüş + bozuk kaydın reddi.

> İlk koşumda **salınım testinin pozitif kontrolü kaldı** (dar bantta 1 anahtarlama
> beklenirken >10 bekleniyordu). Sebep ürün değil kurulum: hedef 21,0 seçilince
> 21 okuması dar bantta da "bant içi"ne düşüyordu, yani kontrol senaryoyu hiç
> kurmuyordu. Hedef 21,5'e alındı; şimdi dar bant 7 anahtarlama veriyor.

## B. Donanım — karttaki ölçümler (seri port, 115200)

Taban ölçüm: eski firmware `Relay: ON` diyordu (alet "açık"ı gösterebiliyor).

| # | İddia | Ölçüm | Sonuç |
|---|---|---|---|
| H1a | Açılışta röle çekmez | `kod oncesi seviye=HIGH (OFF=HIGH), simdi=HIGH`, `heat=0 pad=HIGH` | GEÇTİ |
| H1b | *Pozitif kontrol:* alet LOW gösterebilir | `sim temp 10` → `heat=1 pad=LOW sw=1` | GEÇTİ |
| H1c | **Röle çekiliyken reset** → yine çekmez | reset sonrası `kod oncesi seviye=HIGH`, `heat=0 pad=HIGH` | GEÇTİ |
| H2 | Histerezis eşikleri (hedef 21, bant 3) | 19,4→`heat=1 below_band` · 21,0→`in_band` durumu korudu · 22,6→`heat=0 above_band` · 19,5→`heat=1` | GEÇTİ |
| H3 | DHT11'in 1 °C adımlarında salınım yok | hedef 21,5 bant 3,0; 21/22 altı kez değişti → **`sw` 3'te sabit (0 anahtarlama)** | GEÇTİ |
| H3b | *Pozitif kontrol:* dar bantta alet salınımı görür | bant 0,5 (0,4 girildi, şema sınırı 0,5'e çekti) → `sw` 3→10 (**7 anahtarlama**) | GEÇTİ |
| H5 | Sensör arızası ısıtmayı keser | `heat=1 pad=LOW` iken `sim fault on` → 10 sn boyunca sürdü (tek kaçan okuma arıza değil) → `heat=0 pad=HIGH reason=sensor_fault sensor=ARIZA` | GEÇTİ |
| H5b | *Pozitif kontrol:* arıza kalkınca ısıtma döner | `sim fault off` → `heat=1 sw=3` | GEÇTİ |
| H6 | Donma koruması zorla ısıtır ve mandallar | hedef 5 iken 4,0→`freeze_guard heat=1` (asgari beklemeyi atladı) · 7,0→hâlâ `freeze_guard` · 10,0→mandal açıldı | GEÇTİ |
| H4 | Asgari bekleme röleyi korur | `hold 300` iken histerezis kesmek istedi → `reason=min_hold`, durum değişmedi | GEÇTİ |
| H7 | **Elektrik/NVS:** hedef kalıcı | `target 26` → `NVS blob: 23 bayt, hedef=26.0` → reset → `[NVS] yuklendi: hedef=26.0` | GEÇTİ (kısmi, aşağıya bakın) |
| H8 | Saat yokken saatli kurallar askıda | kural eklendi, `saat gecerli=0 ... askida=1`, hedef değişmedi | GEÇTİ |
| H8b | *Pozitif kontrol:* saat gelince kural tetikler | saat 16:59:40 kuruldu → 17:00'de `[senaryo] hedef kuralla degisti -> 25.0`, `target=25.0 heat=1`, NVS 31 bayt | GEÇTİ |
| H9 | Bekçi köpeği kilitlenmeden kurtarır | `wdtest` → **29,97 sn** sonra `task_wdt triggered` → kart sıfırlandı, `acilis sebebi=6` (TASK_WDT), ayarlar NVS'ten döndü | GEÇTİ |
| H10 | WiFi yokken termostat sürer | Tüm B bölümü WiFi **bağlı değilken** koştu (`wifi=down`, var olmayan ağa geri çekilmeli yeniden deneme: 10→20→40 sn). Termostat kesintisiz çalıştı | GEÇTİ |

### H7 hakkında dürüst sınır
Güç kesintisi **USB fişi çekilerek** denenmedi — bende fiziksel erişim yok.
Ölçüm EN pini üzerinden donanım reset'iyle yapıldı (CPU sıfırlanır, RAM silinir,
açılış ROM'dan olur; NVS flash'tan okunur). Fişi çek-tak testi 5 saniyelik bir iş:
`target 26` yazıp fişi çekip takın, açılış satırında `hedef=26.0` görünmeli.

### H10 hakkında dürüst sınır
"WiFi kesilince sürer" ölçüldü; **"WiFi varken buluta yazar" ölçülmedi** — ev
WiFi şifresi bende yok. Bulut yolu ayrı olarak yerel Supabase'e karşı sınandı
(C bölümü), ama kartın kendi HTTPS istemcisi gerçek bir ağda denenmedi.
`docs/SUPABASE-KURULUM.md` §6 bunun nasıl ölçüleceğini yazıyor.

## C. Supabase — RLS ve cihaz kapısı (yerel yığın, bulut projelerine dokunulmadı)

`node tests/rls_test.mjs` → **24/24 geçti**

- Sahibi okuyor/yazıyor (P1–P4) — pozitif kontrol.
- Yabancı giriş yapmış kullanıcı: cihazı, durumu, telemetriyi **göremiyor**;
  hedefi **değiştiremiyor** (değerin kendisi de doğrulandı: 23,5 olarak kaldı);
  başkası adına cihaz kaydedemiyor (403/42501).
- Sahibi bile `device_state` yazamıyor — durumu yalnız cihaz yazar.
- Anonim: altı tabloda da **401/42501**.
- Çakışan kural tetikleyicisi: hafta içi 08:00 + hafta sonu 08:00 serbest,
  Pazartesi 08:00 **409 ile reddedildi**.
- **MUTASYON (aletin canlı olduğunun kanıtı):** `devices` tablosunda RLS
  kapatıldı → yabancı kullanıcı cihazı **gördü** (1 satır) → RLS geri açıldı →
  tekrar göremiyor. Yani "0 satır" sonucu RLS'ten geliyor.
- İkinci kapı: RLS kapalıyken bile `anon` okuyamadı (yetkiler geri alınmış).

`node tests/device_sync_test.mjs` → **12/12 geçti**

- Doğru sır → 200 + ayar/kural iniyor.
- Yanlış sır / başka cihazın sırrı / sırsız / bilinmeyen cihaz / başlıksız → **hepsi 401**
  ve **beş cevabın beşi de birebir aynı** (hangi cihaz kimliklerinin var olduğu sızmıyor).
- Gövdeye başka bir `device_id` konsa bile yok sayılıyor; ikinci cihazın satırı oluşmadı.
- Ardışık çağrılar telemetriyi şişirmiyor (sunucu tarafı aralıklama).
- GET → 405. Ayarı olmayan cihaza varsayılan üretiliyor.

## D. Panel — gerçek tarayıcıda (başsız Chrome 155, 390×844 mobil)

`node tests/panel_test.mjs` → **12/12 geçti**

- Girişsiz ziyaretçi: yalnız form, sayfada **hiç veri yok**.
- Giriş sonrası canlı değerler (20,4 °C / çevrimiçi / "Isitma acik" / "hedefin altinda").
- Grafik çizildi: 286 noktalı tek seri çizgi, 4 ısıtma şeridi, kesikli hedef çizgisi;
  tablo karşılığı 60 satır. Renkler `dataviz` doğrulayıcısından **her iki modda PASS**
  (aydınlık `#2a78d6`/`#eb6834`, karanlık `#3987e5`/`#d95926`).
- Karanlık mod kendi adımlarını kullanıyor (otomatik ters çevirme değil): ölçüldü.
- Mobil 390 px'te yatay kaydırma yok.
- Panelden hedef yazıldı ve **veritabanından doğrulandı** (+1,0 °C).
- Çakışan kural panelde reddediliyor ve kullanıcıya hata gösteriliyor (sessiz başarısızlık yok).
- Oturum kalıcı: yenilemede yeniden giriş istemiyor.
- Boş hesapta hiçbir yerde uydurma değer yok.

### Tarayıcı ölçümünün bulduğu iki gerçek kusur (düzeltildi)
1. **Şifre alanı `<form>` içinde değildi** — Chrome uyarıyordu, şifre yöneticileri
   alanı doğru tanımıyordu. `<form>` + submit akışına çevrildi.
2. **Hesaplar arası sızıntı:** çıkış/giriş sonrası hedef denetimi **önceki hesabın
   değerini** (25,5 °C) göstermeye devam ediyordu; verisi olmayan hesapta bu
   uydurma değerdi. Oturum değişiminde ekran durumu sıfırlanıyor artık.

## Koşulmayanlar (dürüstlük notu)

| Ne | Neden |
|---|---|
| USB fişi çek-tak ile gerçek güç kesintisi | Fiziksel erişim yok (H7) |
| Kartın gerçek WiFi + bulut yazması | Ev WiFi şifresi bende yok (H10) |
| Röle modülü LED'inin gözle doğrulanması | GPIO seviyesi ölçüldü; LED'i gören bir insan gerekiyor |
| Bulut Supabase projesinde RLS | Proje açılmadı; aynı test bulutta koşulabilir (kurulum belgesi §6) |
| Kombiye bağlı gerçek anahtarlama | Faz 3, ayrı onay |
