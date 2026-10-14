# Kombi Uzaktan Kontrol

Demirdöküm Kalisto HK D224 kombiyi telefondan izlemek ve ayarlamak için ESP32
tabanlı termostat. **Karar cihazın üzerinde verilir**; bulut yalnız ayar, kayıt
ve arayüz katmanıdır — internet kesilse de ev ısınmaya devam eder.

Plan: `ai şirket/shared/memory/plan/kombi-kontrol.md` (sürüm 3).
Durum: **Faz 1 (masa üstü prototip) tamamlandı.** Kombiye hiçbir bağlantı yok.

## Dizinler

| Dizin | Ne var |
|---|---|
| `firmware/lib/kombi_core/` | Termostat + senaryo karar çekirdeği. Platformdan bağımsız; makinede birim testi var |
| `firmware/src/` | Donanım tarafı: pinler, DHT11, NVS, WiFi/NTP, bulut, bekçi köpeği, seri konsol |
| `firmware/test/test_core/` | `pio test -e native` ile koşan 12 birim testi |
| `firmware/tools/pin_scan/` | Tek kullanımlık pin tespit aracı (DHT11/röle pinlerini ölçerek bulur) |
| `supabase/migrations/` | Şema + RLS + çakışan kural tetikleyicisi |
| `supabase/functions/device-sync/` | Cihazın tek kapısı (Edge Function) |
| `dashboard/` | Statik panel (HTML/JS). Tarayıcıdan açılır, uygulama yok |
| `tests/` | RLS, Edge Function ve panel ölçümleri |
| `docs/` | Donanım notları, Supabase kurulumu, Faz 1 test sonuçları |

## Hızlı başlangıç

```
# 1) Sırları doldur (ikisi de .gitignore'da)
cp firmware/include/config.example.h firmware/include/config.h
cp dashboard/config.example.js dashboard/config.js

# 2) Firmware
cd firmware && pio test -e native        # karar mantığı testleri (karta gerek yok)
pio run -e esp32dev                      # derle
pio run -e esp32dev -t upload --upload-port /dev/cu.wchusbserial140

# 3) Supabase (yerel)
npx supabase start && npx supabase db reset
node tests/rls_test.mjs                  # RLS gerçekten engelliyor mu
npx supabase functions serve --no-verify-jwt
node tests/device_sync_test.mjs          # cihaz kapısı

# 4) Panel
cd dashboard && python3 -m http.server 8788
```

Bulut projesinin açılması: `docs/SUPABASE-KURULUM.md` (Serhat Bey'in yapması gereken adımlar).

## Seri konsol (kart USB'deyken, 115200)

`help` · `status` · `info` · `target <°C>` · `band <°C>` · `freeze <°C>` ·
`hold <sn>` · `timeout <sn>` · `manual on|off` · `rule list|clear` ·
`rule add <günmaskesi> <saat> <dakika> <hedef>` · `nvs` · `time`

Benzetim komutları (`KOMBI_ALLOW_SIM=1` iken): `sim temp <°C>` · `sim fault on|off` ·
`sim time <epoch>` · `wifi on|off` · `wdtest`.
**Kalıcı montajda `KOMBI_ALLOW_SIM` 0 yapılmalı** — USB'si eline geçen biri sahte
sıcaklık basıp röleyi sürebilir.

## Emniyet ilkeleri (koda gömülü)

- Açılışta/resette röle **çekmez**; röle hattı `pinMode(OUTPUT)`'tan önce OFF'a çakılır.
- Sensör arızasında ısı isteği **kesilir** (körlemesine ısıtmak yok).
- Oda donma eşiğinin altındaysa hedeften bağımsız **zorla ısıtır**.
- Saat doğrulanmamışsa saatli kurallar **askıya alınır**, termostat son hedefle sürer.
- Bekçi köpeği 30 sn'de bir beslenmezse kartı sıfırlar; ayarlar NVS'ten geri gelir.
- Emniyet kararları (arıza kesme, donma ısıtma) röle asgari bekleme süresini **atlar**.

## Sırlar

`firmware/include/config.h` ve `dashboard/config.js` **depoya girmez** (.gitignore).
Şablonlar (`*.example.*`) commit'lenir. Panele yalnız herkese açık anon anahtar
girer; servis anahtarı hiçbir istemciye konmaz.

## Yapılmayanlar (ayrı onay gerektirir)

- Netlify yayını (plan Faz 2) · uzak depoya push · kombiye fiziksel bağlantı (Faz 3)
- Bulut Supabase projesinin açılması (`docs/SUPABASE-KURULUM.md`)
