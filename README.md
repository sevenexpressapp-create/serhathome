# Kombi Uzaktan Kontrol

Demirdöküm Kalisto HK D224 kombiyi telefondan izlemek ve ayarlamak için ESP32
tabanlı termostat. **Karar cihazın üzerinde verilir**; bulut yalnız ayar, kayıt
ve arayüz katmanıdır — internet kesilse de ev ısınmaya devam eder.

Plan: `ai şirket/shared/memory/plan/kombi-kontrol.md` (sürüm 3).
Durum: **Faz 1 (masa üstü prototip) + denetim düzeltme turu tamamlandı.**
Kombiye hiçbir bağlantı yok. Son durum ve açık kalemler: `PROGRESS.md`.

## Dizinler

| Dizin | Ne var |
|---|---|
| `firmware/lib/kombi_core/` | Termostat + senaryo karar çekirdeği. Platformdan bağımsız; makinede birim testi var |
| `firmware/src/` | Donanım tarafı: pinler, DHT11, NVS, WiFi/NTP, bulut, bekçi köpeği, seri konsol |
| `firmware/test/test_core/` | `pio test -e native` ile koşan 21 birim testi |
| `firmware/tools/pin_scan/` | Tek kullanımlık pin tespit aracı (DHT11/röle pinlerini ölçerek bulur) |
| `firmware/tools/core_cli/` | Ölçüm aleti: karar çekirdeğini makinede sürer. `tests/sync_test.mjs` bununla GERÇEK HTTP'ye karşı kural motorunu ölçer |
| `supabase/migrations/` | Şema + RLS + çakışan kural tetikleyicisi |
| `supabase/functions/device-sync/` | Cihazın tek kapısı (Edge Function) |
| `dashboard/` | Statik panel (HTML/JS). Tarayıcıdan açılır, uygulama yok |
| `dashboard/vendor/` | Depoya alınan supabase-js (CDN'den çekilmiyor; SHA-256 `vendor/README.md`'de) |
| `tests/` | RLS, Edge Function, kimlik politikası, uçtan uca senkron, panel ölçümleri ve mutasyon koşumu |
| `docs/` | Donanım notları, Supabase kurulumu, Faz 1 test sonuçları |

## Hızlı başlangıç

```
# 1) Sırları doldur (ikisi de .gitignore'da)
cp firmware/include/config.example.h firmware/include/config.h
cp dashboard/config.example.js dashboard/config.js

# 2) Firmware
cd firmware && pio test -e native        # 21 karar mantığı ölçümü (karta gerek yok)
pio run -e esp32dev                      # GELİŞTİRME derlemesi (sim komutları açık)
pio run -e esp32dev_prod                 # KALICI MONTAJ derlemesi (sim komutları YOK)
pio run -e esp32dev -t upload --upload-port /dev/cu.wchusbserial140

# 3) Supabase (yerel)
npx supabase start && npx supabase db reset
KOMBI_MUTATE=1 node tests/rls_test.mjs   # RLS + mutasyon (yalnız YEREL)
node tests/auth_policy_test.mjs          # kayıt kapalı mı, parola politikası tutuyor mu
npx supabase functions serve --no-verify-jwt
node tests/device_sync_test.mjs          # cihaz kapısı

# 4) Kural motoru + bulut yolu BİRLİKTE (bağlantı AÇIK)
c++ -std=gnu++17 -O1 -I firmware/lib/kombi_core \
    firmware/lib/kombi_core/kombi_core.cpp firmware/tools/core_cli/main.cpp -o /tmp/core_cli
CORE_CLI=/tmp/core_cli node tests/sync_test.mjs

# 5) Negatif kontrol: düzeltmeleri geri alınca ölçümler kırmızı mı?
CORE_CLI=/tmp/core_cli python3 tests/negatif_kontrol.py

# 6) Panel
cd dashboard && python3 -m http.server 8788
node tests/seed_demo.mjs                 # tohum veri
CDP_PORT=9451 node tests/panel_test.mjs  # başsız Chrome gerekir
```

Bulut projesinin açılması: `docs/SUPABASE-KURULUM.md` (Serhat Bey'in yapması gereken adımlar).

## Seri konsol (kart USB'deyken, 115200)

`help` · `status` · `info` · `target <°C>` · `band <°C>` · `freeze <°C>` ·
`hold <sn>` · `timeout <sn>` · `manual on|off` · `rule list|clear` ·
`rule add <günmaskesi> <saat> <dakika> <hedef>` · `nvs` · `time`

Benzetim komutları (`KOMBI_ALLOW_SIM=1` iken): `sim temp <°C>` · `sim fault on|off` ·
`sim time <epoch>` · `wifi on|off` · `wdtest`.

**Benzetim kapısı (üç katman):** şablon varsayılanı `0` · `[env:esp32dev_prod]`
ortamı `-DKOMBI_ALLOW_SIM=0` veriyor · `KOMBI_ALLOW_SIM=1` yalnız
`KOMBI_DEV_BUILD` tanımlıyken derlenir, aksi halde `#error`. Flash'lanmış kartta
durum **ölçülebilir**: açılış satırı `GUVENLIK: SIM=0/1` ve `info` çıktısı.

`STATE` satırı: `target=` yürürlükteki hedef, `taban=` kullanıcının/bulutun
yazdığı taban hedef, `kural=` yürürlükteki kuralın saati (ya da `elle`),
`nvs=` açılıştan beri NVS yazma sayısı.

## Emniyet ilkeleri (koda gömülü)

- Açılışta/resette röle **çekmez**; röle hattı `pinMode(OUTPUT)`'tan önce OFF'a çakılır.
- Sensör arızasında ısı isteği **kesilir** (körlemesine ısıtmak yok).
- Oda donma eşiğinin altındaysa hedeften bağımsız **zorla ısıtır**.
- Saat doğrulanmamışsa saatli kurallar **askıya alınır**, termostat taban hedefle sürer.
- Bekçi köpeği 30 sn'de bir beslenmezse kartı sıfırlar; ayarlar NVS'ten geri gelir.
- Emniyet kararları (arıza kesme, donma ısıtma) röle asgari bekleme süresini **atlar**
  ama bekleme saatini **sıfırlamaz** ve dönüşü de bekletmez (arıza kalkınca ısıtma
  anında döner).
- Sensör arızasında son geçerli okuma **taze** (<30 dk) ve donma eşiğinin altındaysa
  donma koruması yine koşar; pencere dolunca ısı kesilir.
- Saatli kural **taban hedefi ezmez**: yürürlükteki hedef her döngüde
  "şu an geçerli olan kural"dan hesaplanır. Bu yüzden kaçırılan kural (elektrik
  kesintisi, dakika atlaması, NTP sıçraması) **telafi edilir** ve bulut turu
  hedefi geri almaz.

## Sırlar

`firmware/include/config.h` ve `dashboard/config.js` **depoya girmez** (.gitignore).
Şablonlar (`*.example.*`) commit'lenir. Panele yalnız herkese açık anon anahtar
girer; servis anahtarı hiçbir istemciye konmaz.

## Yapılmayanlar (ayrı onay gerektirir)

- Netlify yayını (plan Faz 2) · uzak depoya push · kombiye fiziksel bağlantı (Faz 3)
- Bulut Supabase projesine `link`/`db push`/`functions deploy`
  (`docs/SUPABASE-KURULUM.md`) — guard hook kayıtsız proje referansını engelliyor
- Faz 3 **blokajlı ön koşulu:** GPIO 23 – 3V3 arasına harici 10 kΩ pull-up
  (`docs/DONANIM.md`)
