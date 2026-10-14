# Faz 1 — kabul testleri ve denetim düzeltmeleri (14.10.2026)

Aşağıdaki her satır ölçümdür. Her yasak/olumsuz iddianın yanında **aynı eksende
pozitif kontrol** var; ayrıca bu turda **mutasyon (negatif kontrol) kolu** eklendi:
her düzeltme için karar çekirdeğine kasıtlı hata geri konup ilgili ölçümün
kırmızıya döndüğü gösterildi (`tests/negatif_kontrol.py`).

## 0. Önceki turun ölçüm kusuru ve bu turda ne değişti

Birinci turda **kabul testlerinin tamamı `wifi=down` koştu.** En kritik iki kusur
(saatli senaryonun bulut bağlıyken geri alınması; kaçırılan kuralın hiç
uygulanmaması) tam bu yüzden kaçtı: ölçüm kendi varsayımını doğruladı.

Bu turda kural motoru ve bulut yolu **birlikte ve bağlantı AÇIKKEN** ölçüldü:

| Ortam | Ne koştu | Bağlantı |
|---|---|---|
| Makine (`pio test -e native`) | 21 birim ölçümü | — |
| Makine + yerel Supabase (`tests/sync_test.mjs`) | 10 uçtan uca ölçüm: **gerçek karar çekirdeği** (`firmware/tools/core_cli`) + **gerçek HTTP** + **gerçek Edge Function** + **gerçek Postgres** | **AÇIK** |
| Gerçek ESP32 + ev WiFi'si | 9 donanım ölçümü | **AÇIK** (`wifi=192.168.1.105`, NTP saati geçerli) |
| Başsız Chrome 155 (390×844) | 17 panel ölçümü, **gerçek CSP başlıklarıyla** | AÇIK |
| Yerel Supabase | 34 RLS + 16 cihaz kapısı + 5 kimlik politikası ölçümü | AÇIK |

**Bulut Supabase projesinde hiçbir ölçüm koşulmadı** — proje `link`/`db push`/
`functions deploy` adımları Serhat Bey'in onayını bekliyor (ayrıca guard hook
kayıtsız proje referansını engelliyor). Kartın **gerçek buluta** yazması da bu
yüzden ölçülemedi; aşağıda "Serhat Bey'i bekliyor" bölümünde.

## A. Karar çekirdeği — birim ölçümleri (makinede)

`cd firmware && pio test -e native` → **21/21 geçti** (1,44 sn)

Yeni/değişen ölçümler:

| Ölçüm | İddia |
|---|---|
| `test_bulut_kurali_geri_almiyor` | Bulut 12 tur aynı tabanı (21) gönderse de yürürlükteki hedef 25 kalır, taban ezilmez, **0 NVS yazma isteği** |
| `test_kacirilan_kural_telafi_ediliyor` | Elektrik kesintisi (18:05 açılış), dakika atlaması (16:59→17:01), NTP sıçraması, gün dönümü (01:00'da dünün 23:00 kuralı), ve negatif eksen (en son geçmiş tetiklenme kazanır, kapalı kural hiç girmez) |
| `test_bos_kural_yuvalari_nvs_yazdirmaz` | Çöp baytlı `RuleSet` boş listeye eşit sayılır; 100 bulut turunda 0 yazma. Pozitif kontrol: gerçek kural gelince **tek** yazma |
| `test_donma_birakma_payi_banttan_bagimsiz` | band=6 iken mandal **7,0 °C**'de bırakır (eski kod: 12,0). Ayrıca `freeze_guard < target` kırpması (hedef 5 → eşik 4,5) |
| `test_ariza_sonrasi_toparlanma_gecikmiyor` | Üretim varsayılanı `hold=300` ile: emniyet kesmesinden **8 sn** sonra arıza kalkınca ısıtma **anında** döner (`below_band`, min_hold değil). Pozitif kontrol: normal değişim isteği hâlâ `min_hold`'a takılıyor. Aralıklı arızada 5 döngünün **5'inde de** toparlanma engellenmedi |
| `test_ariza_sirasinda_donma_korumasi` | Sensör arızasında son geçerli okuma taze (<30 dk) ve eşiğin altındaysa donma koruması koşar; pencere dolunca ısı kesilir. Negatif eksen: okuma 18 °C ise arıza ısıyı keser |
| `test_sensor_zaman_asimi_tabani` | `timeout=10` isteği 60'a çekilir; 10 sn kaçan okuma arıza sayılmaz, 61 sn sayılır |
| `test_bant_alt_siniri_sensore_bagli` | Bant alt sınırı `2 × SENSOR_RESOLUTION_C`; 0,5 ve 1,5 istekleri 2,0'a çekilir |
| `test_bulut_yoklama_periyodu` | 24 saatte **2.880** çağrı (eski kod 17.280). Pozitif kontrol: periyot 5 sn yapılınca alet 17 binden fazla çağrı görüyor |

Salınım testinin pozitif kontrolü **değişti**: bant 0,4 artık şema/çekirdek
sınırına (2,0) çekildiği için eski kontrol kurulamıyor. Yeni kontrol aynı bantta
(3,0) okuma genliğini büyütüyor (20↔23) ve alet salınımı görüyor.

## B. Negatif kontrol / mutasyon — "alet ölü mü?"

`CORE_CLI=... python3 tests/negatif_kontrol.py` → **10 mutasyon, 10'u kırmızı yaptı**

| Mutasyon | Bulgu | Sonuç |
|---|---|---|
| Kural taban hedefi yine ezsin | K1 | KIRMIZI (birim + **gerçek HTTP**) |
| Kenar tetikleme geri gelsin | K2 | KIRMIZI (birim + **gerçek HTTP**) |
| Kural karşılaştırması `memcmp` olsun | Y1 | KIRMIZI (birim) |
| Donma payı yine banttan gelsin | Y2 | KIRMIZI |
| Donma eşiği hedefin üstüne çıkabilsin | Y2b | KIRMIZI |
| Emniyet dönüşü yine beklemeye takılsın | Y3 | KIRMIZI |
| Sensör zaman aşımı tabanı yine 10 sn | YÜKSEK-3 | KIRMIZI |
| Bant alt sınırı sensörden türemesin | O3 | KIRMIZI |

**Bu kol iki ölü alet yakaladı** (ilk koşumda yeşil kaldılar, ölçüm düzeltildi):

1. **Y3'ün ilk testi mutasyonu görmüyordu.** Senaryo, emniyet kesmesinden
   *sonra* 480 sn bekliyordu; bekleme penceresi (300 sn) zaten dolduğu için
   mutant da yeşil kalıyordu. Ölçüm "kesmeden 8 sn sonra toparlanma"ya çevrildi.
   Bu sırada ürün tarafında **gerçek bir eksik** çıktı: yalnız "emniyet saati
   sıfırlamasın" demek yetmiyor, aralıklı arızada ev yine ısınmıyordu; emniyet
   dönüşü için **tek seferlik bekleme atlaması** eklendi.
2. **Y1'in HTTP kolu ölçemiyor.** Kusur sınıfı "ilklendirilmemiş yığın baytları";
   ölçüm aletinin (`core_cli`) ve cihazın değişkenleri artık sıfırlanmış olduğu
   için mutant ile orijinal aynı sonucu veriyor. Bu sınıfı ayırt eden alet birim
   ölçümü (çöp baytlı `RuleSet`) — M3 orada kırmızı. HTTP kolundan **çıkarıldı**
   ve sebebi dosyaya yazıldı.

## C. Uçtan uca: kural motoru + bulut yolu AÇIK bağlantıyla

`CORE_CLI=... node tests/sync_test.mjs` → **10/10 geçti**

| # | İddia | Ölçüm |
|---|---|---|
| C1 | Kural yürürlüğe giriyor | `eff=25 base=21 rule=1` |
| C2 | **K1:** 6 senkron turunda hedef geri alınmıyor | en küçük `eff=25`, son `eff=25` |
| C3 | **Y1:** aynı veri gelen 6 turda NVS yazması istenmedi | `persist=0` |
| C4 | Buluttaki taban hedef hâlâ 21 | `device_settings.target_c=21` |
| C5 | Panel "neden 25?" sorusunu cevaplayabiliyor | `device_state`: `target_c=25, base_target_c=21, rule_active=true, 17:00` |
| C6 | Panelden yazılan hedef kural penceresinde de uygulanıyor | `eff=23 base=23 ovr=1`, tek NVS yazması |
| C7 | Sonraki kural (23:00→18) elle hedefi devralıyor | `eff=18 rule=1 ovr=0` |
| C8 | **K2:** 16:00 kesinti → 18:05 açılış, bulut turundan sonra da kural yürürlükte | açılışta `eff=25 rh=17`, tur sonrası `eff=25 persist=0` |
| C9 | **Y7:** okuma yokken `temp_c` NULL, donma riski yanlış çalışmıyor | `temp_c=null, humidity=null, freeze_risk=false` |
| C10 | Pozitif kontrol: gerçek 3 °C → `freeze_risk=true` | `temp_c=3, freeze_risk=true` |

## D. Donanım — gerçek ESP32, **ev WiFi'si BAĞLI**, NTP saati geçerli

Kart: `wifi=192.168.1.105`, `clock=22:34/gun3`, `cloud=ayarsiz` (bulut URL'si
henüz yok). Firmware `kombi-fw 0.2.0-faz1`, `pio run -e esp32dev` ile yüklendi.

| # | İddia | Ölçüm | Sonuç |
|---|---|---|---|
| H1a | Açılışta röle çekmez | `kod oncesi seviye=HIGH (OFF=HIGH), simdi=HIGH`, `heat=0 pad=HIGH` | GEÇTİ |
| H1b | *Pozitif kontrol:* alet LOW gösterebilir | `sim temp 5` → `heat=1 pad=LOW` | GEÇTİ |
| H12 | **YÜKSEK-1:** benzetim durumu flash'lanmış kartta görünüyor | açılışta `GUVENLIK: SIM=1 (benzetim komutlari ACIK - yalniz gelistirme), TLS_DOGRULAMA=1` ve `info` → `SIM=1` | GEÇTİ |
| H13 | **K2:** kaçırılan kural telafi ediliyor | 22:27'de `rule add 127 17 0 25` → **anında** `target=25.0 taban=21.0 kural=17:00` (kural saati 5,5 saat önce geçmişti) | GEÇTİ |
| H14 | **K2 + NVS:** reset (güç kesintisi eşdeğeri) sonrası | açılış: `[NVS] yuklendi: hedef=21.0 ... kural=1`, saat yokken `susp=1 target=21.0`; NTP gelince `target=25.0 kural=17:00`, **`nvs=0`** | GEÇTİ |
| H15 | **K1:** taban ve yürürlükteki hedef ayrı | her `STATE` satırında `target=25.0 taban=21.0` | GEÇTİ |
| H16 | **Y2:** donma mandalı bantla değil sensör payıyla bırakıyor | `freeze=6 band=6`: `t=5.0 → freeze_guard`, `t=7.0 → below_band` (eski kod 12,0'da bırakırdı) | GEÇTİ |
| H17 | **Y2b/O3:** şema sınırları cihazda da uygulanıyor | `band 0.5` → `bant=2.0`; `freeze 25` → `donma esigi=12.0` | GEÇTİ |
| H18 | **Y3:** emniyet kesmesinden sonra toparlanma gecikmiyor | `hold=300`: `up=230s` arıza → `heat=0 reason=sensor_fault sw=2`; `up=250s` arıza kalktı → `heat=1 reason=below_band sw=3` (**20 sn**, min_hold yok) | GEÇTİ |
| H19 | **YÜKSEK-3:** arıza donma korumasını devre dışı bırakmıyor | `t=3.0` + `sensor=ARIZA` → `reason=freeze_guard heat=1 pad=LOW`; negatif eksen: `t=18.0` + arıza → `sensor_fault heat=0` | GEÇTİ |
| H20 | **O6:** konsol girdi doğrulaması | `target abc` → `HATA: sayi bekleniyor`, hedef değişmedi | GEÇTİ |
| H21 | **Y1:** NVS yazma sayacı | açılıştan sonra 70 sn boyunca `nvs=0`; yalnız **açık komutlarda** artıyor | GEÇTİ |

### Donanım ölçümünün dürüst sınırları
- **H16'nın 6,9 °C adımı kartta yakalanmadı:** DHT11 2 sn'de bir okunduğu için
  `sim temp 6.9` ile `sim temp 7.0` arasındaki örnek düştü. 6,9/7,0 ayrımı birim
  ölçümünde var ve mutasyonla doğrulandı.
- **H1a'nın kapsamadığı pencere:** ölçüm yalnız *kodumuz çalıştıktan sonrasını*
  görür. Reset ile kodun arasındaki ~200 ms'yi ölçen bir alet yok; o pencereyi
  kapatan tek şey harici pull-up direnci (`docs/DONANIM.md`).
- **Güç kesintisi** USB fişi çekilerek denenmedi; reset `esptool --after
  hard_reset` ile yapıldı (CPU sıfırlanır, RAM silinir, NVS flash'tan okunur).
- **Röle LED'i gözle görülmedi**; GPIO seviyesi (`pad=`) ölçüldü.

## E. Supabase — RLS, cihaz kapısı, kimlik politikası (yerel yığın)

`KOMBI_MUTATE=1 node tests/rls_test.mjs` → **34/34 geçti**

Denetçinin işaretlediği **beş ölçüm boşluğu kapatıldı**:

| Boşluk | Yeni ölçüm |
|---|---|
| `telemetry` için sahip tarafında pozitif kontrol yok | **P5**: sahip telemetriyi okuyor (`temp_c=22.5`) |
| `events` için sahip tarafı okuma testi yok | **P6**: sahip olayları okuyor; **N7**: yabancı göremiyor |
| `device_health` için olumsuz eksen yok | **N8**: yabancı görüntüde 0 satır |
| Yabancı `scenario_rules`'a başkasının `device_id`'siyle INSERT edemiyor mu | **N9**: 403/42501, sahip görünümünde satır yok |
| Mutasyon yalnız `devices`'a uygulanmış | **M4-M6**: `telemetry` RLS'i kapatılınca yabancı satırı **görüyor** (1 satır), geri açılınca göremiyor, sahip hâlâ görüyor |

Ek olarak **ORTA-3**: `N10` sahibi bile `secret_sha256`'yı değiştiremiyor
(403/42501, özet değişmedi) · `N10b` pozitif kontrol: cihaz **adını**
değiştirebiliyor (yani yasak, sütun bazlı yetkiden geliyor, "panel hiç yazamıyor"
değil).

> **ORTA-5:** mutasyon adımı artık `KOMBI_MUTATE=1` bayrağı arkasında ve yalnız
> `127.0.0.1` hedefinde koşuyor. Bulut koşumunda **devre dışı**; kurulum belgesi
> de artık canlıya karşı mutasyon önermiyor.

`node tests/device_sync_test.mjs` → **16/16 geçti** (önceki 12 + 4 yeni)
- **F9/F9b (Y7):** `temp_c: null` NULL olarak yazılıyor, 0.0'a çevrilmiyor;
  pozitif kontrol: gerçek okuma yazılmaya devam ediyor.
- **F10 (K1):** `target_c=25 / base_target_c=21 / rule_active / 17:00` yazılıyor.
- **F11:** aralık dışı/bozuk alanlar (`active_rule_hour=99`, `wifi_rssi="abc"`)
  NULL'a çevriliyor ve fonksiyon 200 dönüyor (yeni sütunların `check` kısıtları
  500 üretmiyor).

`node tests/auth_policy_test.mjs` → **5/5 geçti** (YÜKSEK-2)
- **S1:** anonim kayıt **kapalı** (422 `signup_disabled`)
- **S2:** pozitif kontrol: yönetici (service_role) kullanıcı ekleyebiliyor
- **S3:** 9 karakterlik parola reddediliyor (asgari 12)
- **S4:** yalnız küçük harf reddediliyor (karmaşıklık kuralı)
- **S5:** geçerli kullanıcı giriş yapabiliyor — politika meşru kullanıcıyı kilitlemedi

> **Ölçümün yakaladığı tuzak:** `[auth.email] enable_signup = false` yazmak
> e-posta/parola ile **girişi de** kapatıyor (422 `email_provider_disabled`,
> "Email logins are disabled"). Kayıt kapatmayı yapan tek doğru yer genel
> `[auth] enable_signup = false`. İlk denemede panel hiç açılmıyordu; satır geri
> alındı ve `config.toml`'a bu uyarı yazıldı.

## F. Panel — gerçek tarayıcı, **gerçek CSP başlıklarıyla**

`CDP_PORT=... PANEL_URL=http://127.0.0.1:8789/index.html node tests/panel_test.mjs`
→ **17/17 geçti** (8789 portu `dashboard/_headers` dosyasındaki başlıkları
gerçekten uygulayan sunucu; `connect-src`'de yalnız yerel arka uç adresi ikame
edildi).

Yeni ölçümler:

| # | İddia | Ölçüm |
|---|---|---|
| D12 | **K1:** "şu an neden 25 °C?" panelde yazıyor | `25.0 °C` + `07:00 senaryosu (taban 21.5 °C)` |
| D13 | **Y5:** grafik dinleyicileri birikmiyor | 10 yeniden çizimde SVG'ye **0** yeni dinleyici. Pozitif kontrol: sayaç elle eklenen 1 dinleyiciyi görüyor |
| D14 | **Y6:** sorgu hatası kullanıcıya gösteriliyor | 4 REST isteği ağ seviyesinde kesildi → "Veri okunamadi — gosterilen bilgi guncel OLMAYABILIR…" göründü, "henüz hiç bağlanmadı" boş durumu **görünmedi**, önceki sıcaklık korundu |
| D15 | Hata geçince uyarı kalkıyor | `load-err` gizli, `temp=20.4` |
| D16 | **ORTA-4:** uçuştaki istek oturum değişince ekrana yazılmıyor | A'nın `device_state` isteği CDP ile duraklatıldı, B girdikten sonra salındı → B'nin ekranı `—`, cihaz adı `Yeni kombi` |

**CSP gerçekten uygulanıyor (pozitif kontrol):** sayfaya CDN betiği ve satır-içi
betik enjekte edildi; ikisi de **engellendi** (2 CSP ihlal kaydı,
`window.__csp_delik === false`) ve panel yine 17/17 geçti.

### Panel ölçümünün yakaladığı iki ölü alet
1. **`window.fetch` yamalamak işe yaramıyor:** supabase-js istemciyi kurarken
   `fetch` referansını bir kez yakalıyor. İlk koşumda Y6/ORTA-4 ölçümleri
   "kesilen=0" verip **hiçbir şey ölçmedi**. Ölçüm CDP `Fetch.failRequest` /
   `Fetch.continueRequest` ile ağ seviyesine taşındı.
2. **`Log.enable` önceki koşumun konsol kayıtlarını geri oynatıyor** (aynı
   tarayıcı örneği yeniden kullanılınca). D11, bir önceki koşumda bilerek
   üretilmiş 4 ağ hatasını "beklenmeyen hata" sandı. Artık `Log.clear` ile
   sıfırlanıyor ve bilerek enjekte edilen hatalar indeks damgasıyla ayrılıyor.
3. Yeni ölçümler ilk konumlarında **boş hesap oturumunda** koşuyordu (grafik yok,
   cihaz yok) — yani senaryoyu hiç kurmuyorlardı. Dolu hesap aşamasına taşındı.

## G. Kapanmayanlar — Serhat Bey'i bekliyor

| Ne | Neden | Gereken |
|---|---|---|
| Bulut Supabase projesinde şema + fonksiyon + RLS ölçümü | Proje `link`/`db push`/`functions deploy` yapılmadı; guard hook kayıtsız proje referansını engelliyor (doğru davranış) | Serhat Bey onayı + `guard.py` PROJELER kaydına yeni ref'in eklenmesi |
| **Kartın gerçek buluta yazması** (K1'in kart+bulut kolu) | Cihaz yazılımı yalnız HTTPS konuşuyor; yerel yığın düz HTTP. Bulut fonksiyonu yayınlanmadan kart konuşamıyor | Yukarıdaki onaydan sonra `config.h`'a fonksiyon URL'si + 5 dakikalık seri port ölçümü |
| Captcha (YÜKSEK-2'nin son parçası) | Yerelde açılırsa tüm giriş testleri koşulamaz hale gelir | Supabase panelinden açılacak: `docs/SUPABASE-KURULUM.md` §7.3 |
| Panel kullanıcısı için MFA | Panelden yapılır | `docs/SUPABASE-KURULUM.md` §7.2 |
| USB fişi çek-tak ile gerçek güç kesintisi | Fiziksel erişim yok | Serhat Bey: `target 26` → fiş çek-tak → açılışta `hedef=26.0` |
| Röle modülü LED'inin gözle doğrulanması | GPIO seviyesi ölçüldü, LED'i gören insan gerekiyor | Serhat Bey: `sim temp 5` → LED yanmalı, `sim off` → sönmeli |
| Netlify yayını | Ayrı onay | `netlify.toml` + `dashboard/_headers` hazır |
| Kombiye bağlı gerçek anahtarlama | Faz 3, ayrı onay | Harici 10 kΩ pull-up (Faz 3 ön koşulu) |
