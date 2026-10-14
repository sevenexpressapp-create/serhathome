# PROGRESS — Kombi uzaktan kontrol

Bu dosya projenin **süreklilik defteri**: bir sonraki iş kim tarafından yapılırsa
yapılsın bağlamı burada bulur. Yeni iş eklerken en üste yaz (tarih + değişiklik +
neden). Ayrıntılı ölçümler `docs/FAZ1-TEST-SONUCLARI.md`'de.

---

## 15.10.2026 (01:00) — 🔌 FAZ 3 BAŞLADI: üretim yazılımı kartta

Serhat Bey "fiziksel bağlantıya geçelim" dedi. Faz 3'ün **yazılım ayağı bitti**;
kalan iş fiziksel ve iki ön koşula bağlı.

**Yapılan ve ölçülen:** kart `esp32dev_prod` ile yeniden yüklendi.
`SIM=0`, `sim temp 35` cihazda reddediliyor ve sıcaklığı değiştirmiyor
(22.1 → 22.1), prod ikilisinde benzetim dizgeleri yok — **pozitif kontrol aynı
eksende:** aynı ağaçtan derlenen dev ikilisinde `sim temp`/`sim fault`/`wdtest`
dizgeleri **var** (2/2/1), prod'da **0**. Kurallar NVS'ten döndü (`rules=2`),
WiFi + bulut geri geldi, açılışta röle boşta (`acilis_pad=HIGH heat=0`).

**Ölçüm aletimde bir sapma:** `rules`/`wifi` alanlarını `info` çıktısında
aradım, oysa onlar `STATE` satırında. İki kapı bu yüzden yanlışlıkla kırmızı
yandı; doğru satırdan yeniden ölçünce 5/5 geçti. Kartta bir sorun yoktu.

**Kontrol listesi:** `docs/FAZ3-KONTROL-LISTESI.md` — kombi başında telefondan
takip edilecek adımlar, kabul ölçümleri ve geri dönüş yolu.

**Kalan tıkayıcılar:**
1. **10 kΩ pull-up** GPIO 23 – 3V3 arasına — **15.10 02:00'de tıkayıcılıktan
   çıkarıldı** (gerekçe: `docs/FAZ3-KONTROL-LISTESI.md` §B1 — modül ACTIVE LOW,
   boşta giriş röleyi süremez; röle yanlışlıkla çekili kalsa bile sonuç
   klemensin bugünkü köprülü hâliyle aynı). Önerilir, bağlantıyı geciktirmez.
   Kartta var mı belirsiz: üst yüzde DHT11'in yanında dik duran tek direnç var,
   konumu onun **sensör pull-up'ı** olduğunu düşündürüyor (GPIO 18), lehim
   yüzünde yalnız beyaz atlama telleri görünüyor. Belirsizliği kapatmanın ucuz
   yolu ölçmek değil **takmak**: ikinci bir 10 kΩ paralel gelirse 5 kΩ olur,
   pin LOW'da 0,66 mA çeker — zararsız.
2. **S2'nin gerilim ayağı** — klemens bulundu (aşağı bak), kalan tek şey
   DC volt ölçümü (~24 V beklenir).
3. **Kart/sensör nereye** — yeni çıkan kalem (aşağı bak).

**Klemens 01:40'ta bulundu (S2'nin yarısı kapandı).** Mavi 2×2 dört vidalı
klemens, kombinin kontrol kutusunun kenarında. Termostat girişi olduğu
**etiketle değil** Serhat Bey'in birinci elden bilgisiyle sabit ("eminim, daha
önce buraya bağladık"); okunabilir `RT`/`24V`/`GND` yazısı yok, yalnız kabartma
bir şema simgesi var. **Köprü VAR** — termostat söküldüğü için ön sıradaki iki
terminal telle köprülenmiş, kombi şu an sürekli ısı talebinde. Kablolar
kombinin **içine** gidiyor, duvara çıkan termostat kablosu yok.

**Bunun doğurduğu yeni kalem:** bağlantı noktası kombinin dibinde, ama DHT11
aynı perfboard'da ve kombinin dibindeki sıcaklık odanın sıcaklığı değil. Röle
kuru kontak olduğu için uzatılabilir: klemensten odaya 2×0,75 mm² kablo çekilip
kart odada durmalı. Yer ve kablo uzunluğu Serhat Bey'den bekleniyor (plandaki
S6 sorusu).

**Alınacaklar:** 10 kΩ direnç · havya + lehim · multimetre · 2×0,75 mm² kablo.

---

## 15.10.2026 (gece) — ☁️ BULUT KURULDU + 🌐 YAYINDA

Faz 1 bitti, Faz 2'nin yayın ayağı tamamlandı. **Panel internetten erişilebilir
ve telefondan çalıştığı ev ağı dışından doğrulandı.**

| | |
|---|---|
| Panel | https://serhathome.netlify.app |
| Depo | https://github.com/sevenexpressapp-create/serhathome (**public**) |
| Supabase | `Termostat` / `hrxsqb…` — şema, RLS, `device-sync` yayında |
| Kart | `kombi-fw 0.2.0-faz1` — o gece SIM=1 idi; **01:00'de prod yüklendi (SIM=0)** |

### Ne ölçüldü

- **Yetki politikası buluta karşı 5/5** (`tests/auth_policy_test.mjs`). Çıktının
  ilk satırı `(bulut)` diyor — eski sahte yeşil tuzağına düşülmedi. Testin
  yarattığı hesaplar sonradan silindi ve silindiği doğrulandı.
- **Panel → bulut → kart zinciri iki uçtan kanıtlandı.** Panelden girilen
  `17:00 → 25` ve `23:00 → 20` kuralları kartta `rule list` ile görüldü; karta
  kural girmenin tek diğer yolu (seri port) kullanılmadı.
- **Asgari röle tutma gerçek donanımda doğrulandı**: kural değişince hedef
  düştü ama röle 300 sn dolana kadar açık kaldı, `up=1878s`'de bıraktı.
- **Yayındaki yanıt dışarıdan ölçüldü, 13/13.** CSP gerçekten daraltılmış
  geliyor; derleme kütüğünün beyanıyla yetinilmedi.

### Bu turda kapatılan iki gerçek kusur

1. **Sır yedeği gönderilmek üzereydi.** `.gitignore` tam dosya adı yazıyordu;
   kurulum betiğinin bıraktığı `config.h.yedek-<tarih>` kuralı atlıyordu ve
   içinde WiFi SSID + `DEVICE_SECRET` vardı. Joker kurala çevrildi.
2. **CSP kapısı yorum yüzünden hep kırmızıydı.** Kapı jokeri dosyanın tamamında
   arıyordu, `_headers`'ın yorum bloğu ise jokeri açıklama amaçlı taşıyordu.
   Kapı yalnız yürürlükteki CSP satırına bakar hâle getirildi; mutasyon testiyle
   hâlâ kırmızı verebildiği doğrulandı.

### 🔴 Açık / bekleyen

- **Giriş ekranı korumasız.** Panel internette; girişi koruyan tek şey parola.
  Deneme sınırı yok, **captcha yok, MFA yok**. Sunucu tarafını giriş ekranı
  hazır olmadan sertleştirmek kilitlenme üretir — ikisi birlikte yapılmalı:
  hCaptcha bileşeni + `captchaToken`, TOTP alanı, sonra Supabase'de açma,
  sonra iki yönlü ölçüm. **Artık ertelenebilir bir süs değil.**
- **Hafta sonu ısınma davranışı**: `17:00 → 25` yalnız hafta içi seçili.
  Cumartesi/Pazar geriye bakınca Cuma gecesinin `20`'sini bulur, yani hafta
  sonu hiç 25'e çıkmaz. Kasıtlıysa sorun yok; değilse maske tüm günler olmalı.
- **`events` tablosunun üreticisi yok** — Faz 2 alarmlarının veri kaynağı yok.
- **Manuel kip yeniden başlatmada kayboluyor** (bilinçli ödünç, belgeli).
- **Faz 3 — kombiye fiziksel bağlantı: AYRI ONAY.** Tıkayıcı ön koşul: GPIO 23
  → 3V3 arasına harici 10 kΩ pull-up (kodun çalışmadığı ~200 ms açılış
  penceresini yalnız o kapatır). Ayrıca `pio run -e esp32dev_prod` ile yeniden
  yüklenmeli; kart şu an SIM=1 geliştirme derlemesinde.
  → **Bu kalemin yazılım ayağı 15.10 01:00'de kapandı** (prod yüklendi, SIM=0).
  Güncel durum ve kalan ön koşullar en üstteki Faz 3 bölümünde.

---

## 14.10.2026 (gece) — 2. tur denetimin üç düzeltmesi

Kapsam yalnız üç maddeydi; yeni özellik eklenmedi.

1. **`tests/auth_policy_test.mjs` ortam değişkenlerini yok sayıyordu** (en
   riskli bulgu). Dosyada `process.env` hiç geçmiyordu: `docs/SUPABASE-KURULUM.md`
   §7.5'teki **bulut** komutu kopyalanıp koşulsa bile hedef `supabase status`'tan
   geliyor, yani **yerel** yığın ölçülüyor ve "5/5 geçti" basılıyordu. Artık
   `SUPABASE_URL` / `ANON_KEY` / `SERVICE_KEY` hedefi eziyor (kardeş testlerle
   aynı kalıp), **hedef ilk satırda basılıyor** (`HEDEF: … (yerel|bulut)`) ve
   hedefe ulaşılamazsa koşum sessizce yerele dönmeyip kırmızı düşüyor.
2. **Panel, veritabanının kaydetmesi imkânsız bir hedef sunuyordu.** Hedef
   sayacının alt sınırı artık sabit 5 değil, yürürlükteki donma eşiğinden türüyor
   (`freeze + 0,5`); donma eşiği kaydedilince sınır güncelleniyor. `23514` kısıt
   hatası Türkçe ve eyleme dönük bir cümleye çevrildi (ham Postgres metni artık
   ekrana basılmıyor). "Donma eşiğini 5'e çek, hedefi 5,5 yap" yolu **ölçüldü:
   gerçekten kaydediliyor.**
3. **`tests/negatif_kontrol.py` yarıda kesilirse ürün kodunu bozuk bırakıyordu.**
   Mutant gövdesi `try/finally` içine alındı, SIGINT/SIGTERM yakalanıyor ve
   dosyalar geri yazılıp SHA-256 ile doğrulanıyor. Kalan sınır: **SIGKILL
   yakalanamaz** (ölçüldü, dosyada yazılı).

**Ölçümler:** `auth_policy` 5/5 (negatif kontrol: ulaşılamayan adres → 0/5),
`panel_test` **21/21** (4 yeni ölçüm; mutasyonla doğrulandı), `negatif_kontrol
--native` 8/8 kırmızı, `pio test -e native` 21/21, `rls_test` 28/28 (mutasyon
bayrağı verilmedi). Hepsi **yalnız yerel yığına** (54321) karşı koştu.

⚠️ **Bu tur sırasında `dashboard/config.js` ve `firmware/include/config.h`
bulut projesine çevrildi (Patron, 23:38; yanlarında tarihli yedekleri var) ve
`firmware/src/ca_cert.cpp` + `firmware/src/cloud.h` değişti.** Panel ölçümleri
bu yüzden depodaki `config.js` yerine karalama dizinindeki **yerel** bir
`config.js` ile koştu; bulut projesine tek istek gitmedi (CSP `connect-src`
yalnız 127.0.0.1'e izin veriyordu, ara denemede istek tarayıcıda bloklandı).
Bu dört dosya **commit edilmedi** — Patron'un süren işi.

⚠️ **Ölçüm tuzağı (yeni):** `negatif_kontrol.py` `pio` **derlerken** kesilirse
SCons imza veritabanını yazamıyor; kaynak geri yazılsa bile
`firmware/.pio/build/native` mutant ikiliyi tutuyor ve sonraki
`pio test -e native` **sahte kırmızı** veriyor (bir kez yaşandı: 2 test "kırmızı"
sandık, kaynak temizdi). Çözüm: `pio run -t clean -e native`.

---

## 14.10.2026 (akşam) — denetim düzeltme turu (2. tur denetime hazır)

**Bağlam:** Faz 1 masa üstü prototipi kod + güvenlik denetiminden **BLOK** aldı
(2 kritik, 7 yüksek kod bulgusu; 3 yüksek güvenlik bulgusu). Kök sebep bir
**ölçüm yöntemi kusuruydu:** birinci turun kabul testlerinin tamamı `wifi=down`
koştu, bu yüzden en kritik iki kusur kaçtı.

### Kapatılan bulgular

| Bulgu | Ne yapıldı |
|---|---|
| **K1** saatli senaryo bulut bağlıyken geri alınıyordu | Taban hedef ile yürürlükteki hedef **ayrıldı**. Kural `settings_.target_c`'yi artık ezmiyor; `Controller::effectiveTarget()` her döngüde hesaplanıyor. `device_state`'e `base_target_c`, `rule_active`, `active_rule_hour/minute` eklendi; panel "şu an neden 25 °C?" sorusunu cevaplıyor. Panelden hedef değiştirme kural penceresinde de çalışsın diye **tek tetiklenmeye bağlı elle geçersiz kılma** (override) eklendi |
| **K2** kaçırılan kural telafi edilmiyordu | Kenar tetikleme yerine "şu an yürürlükte olan kural" hesabı: geçmiş 7 güne bakıp en son tetiklenmeyi bulur. `last_rule_key_`/`last_seen_minute_` ikilisi kaldırıldı (O5) |
| **Y1** belirsiz değer karşılaştırması → NVS aşınması | `RuleSet nr{}` + `rulesEqual()`/`settingsEqual()` (yalnız dolu yuvalar). Bulut uygulama mantığı çekirdeğe taşındı (`applyCloudState`) ki cihaz ve ölçüm aleti aynı kodu kullansın |
| **Y2** donma payı konfor bandına bağlıydı | Pay artık `FREEZE_RELEASE_MARGIN_C` (= sensör çözünürlüğü, 1,0 °C). `freeze_guard < target - 0,5` kısıtı hem `clampSettings`'de hem şemada |
| **Y3** arıza asgari bekleme saatini sıfırlıyordu | Emniyet yolu saati sıfırlamıyor **ve** emniyet dönüşü için tek seferlik bekleme atlaması var (mutasyon koşumu ikinci mekanizmanın şart olduğunu gösterdi) |
| **Y4** bulut yoklaması 5 sn | Başarı periyodu geri çekilmeden ayrıldı: 30 sn → 2.880 çağrı/gün (tavanın %17'si) |
| **Y5** panel grafiği dinleyici biriktiriyordu | Dinleyiciler modül yüklenirken tek kez bağlanıyor; çizim yalnız `chartCtx`i güncelliyor |
| **Y6** panelde sorgu hataları okunmuyordu | Dört sorgunun `.error`'ı + `Promise.all` reddi yakalanıyor; ayrı "veri okunamadı" uyarısı |
| **Y7** okuma yokken 0,0 °C bildiriliyordu | `has_reading` false → `temp_c`/`humidity` NULL gidiyor; `freeze_risk` yanlış tetiklenmiyor |
| **YÜKSEK-1** `KOMBI_ALLOW_SIM` yalnız yorumla korunuyordu | Şablon varsayılanı 0 · `[env:esp32dev_prod]` · `#error` kapısı · açılış bannerı ve `info`'da `SIM=` satırı |
| **YÜKSEK-3** `sensor_timeout_s` tabanı 10 sn | Taban 60 sn (şema + cihaz); arıza sırasında son okuma taze (<30 dk) ve eşiğin altındaysa donma koruması koşuyor |
| **YÜKSEK-2** bulut kimlik yapılandırması | `config.toml`: kayıt kapalı, parola ≥12 + karmaşıklık, `secure_password_change`, giriş deneme sınırı 30→10. Captcha + MFA + gerçek `site_url` panelden yapılacak: `docs/SUPABASE-KURULUM.md` §7 (ekran ekran) |
| **ORTA-3** panel cihaz sırrını değiştirebiliyordu | `revoke all on devices from authenticated` + `grant update (name)` |
| **ORTA-4** hesaplar arası yarış hali | Oturum çağı sayacı + `AbortController` |
| **ORTA-1** CDN betiği SRI'siz, CSP yok | supabase-js depoya alındı (iki bağımsız CDN'den aynı SHA-256), `dashboard/_headers` + `netlify.toml`, satır-içi `onerror` kaldırıldı |
| **ORTA-5** belge canlıda RLS kapatmayı öneriyordu | Mutasyon `KOMBI_MUTATE=1` arkasında ve yalnız `127.0.0.1`'de; belge artık canlıda önermiyor |
| **O3/O6/O7** | Bant alt sınırı sensörden türüyor (2,0) · konsol girdi doğrulaması · `prune_telemetry()` + pg_cron önerisi |
| **O1/O2** | Harici 10 kΩ pull-up **Faz 3'ün blokajlı ön koşulu** · `events` üreticisizliği yazılı (`docs/FAZ2-GUVENLIK-KALEMLERI.md`) |

### Ölçüm (hepsi bu turda koştu)

| Ortam | Sonuç | Bağlantı |
|---|---|---|
| `pio test -e native` | **21/21** | — |
| `tests/negatif_kontrol.py` (mutasyon) | **10 mutasyon, 10'u kırmızı** | — |
| `tests/sync_test.mjs` (çekirdek + gerçek HTTP + Edge Function) | **10/10** | **AÇIK** |
| Gerçek ESP32 + ev WiFi'si | **12 ölçüm** (`wifi=192.168.1.105`, NTP geçerli) | **AÇIK** |
| `tests/rls_test.mjs` | **34/34** (5 ölçüm boşluğu kapatıldı) | — |
| `tests/device_sync_test.mjs` | **16/16** | — |
| `tests/auth_policy_test.mjs` | **5/5** | — |
| `tests/panel_test.mjs` (gerçek CSP başlıklarıyla) | **21/21** (14.10 gecesi 17→21) | — |

### 🔴 Açık / bekleyen

- **Bulut Supabase projesi** (`link` → `db push` → `functions deploy`) **yapılmadı.**
  Guard hook kayıtsız proje referansını engelliyor (doğru davranış) ve deploy
  zaten Serhat Bey onayı gerektiriyor. Anahtarlar geldi ama **hiçbir dosyaya
  yazılmadı**; `firmware/include/config.h`'da `SUPABASE_FUNCTION_URL` **boş**.
- **Kartın gerçek buluta yazması ölçülemedi** (K1'in kart+bulut kolu). Cihaz
  yalnız HTTPS konuşuyor, yerel yığın düz HTTP; bulut fonksiyonu yayınlanmadan
  kart konuşamıyor.
- **Captcha + panel kullanıcısı MFA + gerçek `site_url`**: panelden yapılacak (§7).
  MFA zorunlu kılınırsa panel giriş ekranına TOTP alanı eklenmeli (Faz 2, tek ekran).
- **USB fişi çek-tak** ve **röle LED'i gözlemi**: Serhat Bey'in iki dakikalık işi.
- Netlify yayını, uzak depoya push, kombiye bağlantı: ayrı onay.
- Faz 2 güvenlik kalemleri: `docs/FAZ2-GUVENLIK-KALEMLERI.md`.

### Kartın şu anki hali
`kombi-fw 0.2.0-faz1`, geliştirme derlemesi (**SIM=1**), ev WiFi'sine bağlı,
bulut ayarsız. Röle **bırakmış** (`pad=HIGH`), hedef 21,0, kural yok, NVS geçerli
(23 bayt). Kalıcı montaj öncesi `pio run -e esp32dev_prod` ile yeniden yüklenmeli.

---

## 14.10.2026 (gündüz) — Faz 1 masa üstü prototip

Firmware (karar çekirdeği + donanım katmanı), Supabase şeması + RLS + `device-sync`
Edge Function, statik panel ve ölçüm takımı yazıldı. Pinler ölçülerek bulundu
(DHT11 → GPIO 18, röle → GPIO 23, ACTIVE LOW), orijinal firmware yedeklendi.
Ayrıntı: `docs/DONANIM.md`, `docs/FAZ1-TEST-SONUCLARI.md`. Commit: `b1eb572`.
