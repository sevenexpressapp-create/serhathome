# Faz 2 güvenlik ve dayanıklılık kalemleri (açık, bilinçli ertelendi)

14.10.2026 güvenlik + kod denetiminde çıkan ama **bu turda bilerek yapılmayan**
maddeler. Hepsi yazılı; hiçbiri "unutulmuş" değil. Faz 2 açılınca bu dosya
baştan okunur.

## Veri kaynağı eksikleri

### O2 — `events` tablosunun üreticisi yok
`public.events` tablosu, indeksi ve RLS politikası var; **yazan yok.** Cihaz
yazılımı `event` alanı göndermiyor, `device-sync` yalnız gelirse yazıyor.
Sonuç: Faz 2'nin "sensör arızası / bekçi sıfırlaması / açılış" alarmları şu an
**veri kaynaksız.**
Faz 2'de yapılacak: cihazda küçük bir olay kuyruğu (açılış sebebi, arıza
başladı/bitti, bekçi sıfırlaması, NVS yazma hatası) ve bunu `device-sync`
gövdesine ekleyen bir alan. Alarm tarafı `device_health` görünümünden
beslenebilir ama "ne oldu" bilgisi `events` olmadan gelmiyor.

### Telemetri budama cron'u — **11.11.2026 durumu**
`public.prune_telemetry(days)` fonksiyonu **hazır.**

> ⚠️ **DÜZELTME (11.11.2026) — "yalnız service_role'e açık" ifadesi YANLIŞTI.**
> Ölçüldü (canlı proje **ve** yerel yığın, aynı sonuç):
> `proacl = {postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}`,
> `has_function_privilege('authenticated', …, 'EXECUTE') = true` —
> yani **panel kullanıcısı silme fonksiyonunu çağırabiliyordu** (`anon` kapalıydı).
> Sebep: `kombi_init.sql:165`'teki `revoke … from public` yalnız `PUBLIC`
> sözde-rolünü alıyor; Supabase'in varsayılan yetkileri ACL'e **adlandırılmış**
> bir `authenticated=X/postgres` girdisi yazıyor ve o revoke ona dokunmuyor.
> `anon`'un kapalı olması ayrı bir satırın eseri (`kombi_init.sql:273`
> `revoke all on all functions in schema public from anon;`) — simetrik
> `authenticated` satırı hiç yazılmamış.
> **Düzeltme göçü:** `supabase/migrations/20261111211500_prune_telemetry_yetki_duzeltme.sql`
> — ✅ **11.11.2026'da canlıya UYGULANDI.** Uygulama sonrası canlıdan ölçüldü:
> `proacl = {postgres=X/postgres,service_role=X/postgres}`;
> `authenticated` → **false**, `anon` → **false**, `service_role`/`postgres` →
> **true**. Cron işi `active` kaldı (`postgres` olarak koşuyor, EXECUTE
> sahiplikten geliyor).
> **Gerilemeyi ölçen sınav:** `tests/auth_policy_test.mjs` S6 (+ S7 pozitif
> kontrol). Yerelde ölçüldü: göç uygulanmadan **6/7 (S6 kaldı, çıkış kodu 1)**,
> uygulandıktan sonra **7/7 (çıkış kodu 0)**.

**Zamanlama — ✅ KURULDU (11.11.2026).** Göç dosyası
`supabase/migrations/20261111180000_telemetri_budama_cron.sql` Supabase SQL
editöründen uygulandı (`docs/SUPABASE-KURULUM.md` §8.1 bloğu; defter satırı
blokla birlikte eklendi). **Canlıdan ölçüldü:** `cron.job` tek satır —
`jobid=1`, `kombi-telemetri-buda`, `17 0 * * *`, `username=postgres`,
`active=true`; `pg_cron 1.6.4`; `cron.timezone = GMT` olduğu için bu **03:17
TRT**.
⚠️ İlk koşum henüz olmadı (`cron.job_run_details` boş). İlk koşum **0 satır**
silecek: telemetride 31.947 satır var ama 30 günden eskisi yok (en eski kayıt
14.10). İlk gerçek silme ~13.11. **İzleme yok** — `cron.job_run_details`
sessizce kırmızıya düşerse kimse haber almaz (açık kalem).

```sql
-- göçteki GÜNCEL hâli. ⚠️ Dizge DEĞİŞTİ: `cron.timezone` = GMT olduğu için
-- '17 3 * * *' canlıda 06:17 TRT'ye (ısınma penceresinin içine) kayıyordu;
-- kombi_init.sql:144-146'daki yazılı niyet GECE 03:17'ydi. Niyet geri getirildi.
select cron.schedule('kombi-telemetri-buda', '17 0 * * *',   -- 00:17 UTC = 03:17 TRT
                     $$select public.prune_telemetry(30)$$);
```

## Edge Function / API

### ORTA-2 — `device-sync` hız sınırı yok
Cihaz sırrı sızarsa saldırgan fonksiyonu sınırsız çağırabilir (telemetri
şişirme, ücretsiz katman tavanını tüketme). Sunucu tarafı aralıklama telemetri
satırı yazmayı engelliyor ama **çağrı sayısını** engellemiyor.
Yapılacak: cihaz başına basit bir pencere sayacı (örn. `device_state`'e
`last_call_at` + sayaç, ya da Supabase'in kendi rate limit'i) ve aşımda 429.

### Edge Function JWT beyanı
Fonksiyon `--no-verify-jwt` ile yayınlanıyor (cihazda kullanıcı oturumu yok).
`supabase/config.toml` içinde `[functions.device-sync] verify_jwt = false`
satırı **yazılı değil**; yani niyet yalnız komut satırında duruyor. Yapılacak:
config'e açıkça yazmak ki yanlışlıkla JWT doğrulamalı yayınlanmasın (o zaman
cihaz kalıcı 401 alır ve sebebi geç anlaşılır).

### Sayısal aralık kırpması — YAPILDI (kapsam dışıydı ama zorunlu çıktı)
Denetim "bu turda yapma" demişti; ancak `device_state`'e eklenen
`active_rule_hour/minute` sütunlarının `check` kısıtları var ve kırpma olmadan
bozuk bir gövde fonksiyonu 500'e düşürüyordu. `num()`/`numRange()`/`intRange()`
eklendi, `tests/device_sync_test.mjs` F11 ile ölçülüyor.

## Veritabanı hijyeni

### `owns_device` PUBLIC EXECUTE
`public.owns_device(text)` fonksiyonu `security definer` ve çalıştırma yetkisi
`public` rolünde. Sömürülebilir bir yol bulunamadı (fonksiyon yalnız
`auth.uid()` ile kıyas yapıyor, veri döndürmüyor) ama hijyen gereği:

```sql
revoke all on function public.owns_device(text) from public, anon;
grant execute on function public.owns_device(text) to authenticated;
```

### Cihaz kimliğinin tahmin edilebilirliği
`DEVICE_ID` varsayılanı `kombi-salon`. Kimlik tek başına yetkisiz (sır gerekli)
ve 401 cevapları ayırt edilemez — ama tahmin edilemez bir kimlik, hedefli
deneme yapan birinin işini zorlaştırır. `docs/SUPABASE-KURULUM.md` §4 artık
rastgele kimlik öneriyor; **mevcut kurulumda değiştirilmedi** (değiştirmek
`config.h` + veritabanı satırı + panel eşleşmesi demek).

## Cihaz yazılımı

### NTP sıçrama sınırı
Saat geçersizken kurallar askıda, geçerli olunca "şu an yürürlükte olan kural"
hesaplanıyor — yani sıçrama artık kural düşürmüyor (K2). Ama NTP **yanlış** bir
saat verirse (ya da çok ileri/geri sıçrarsa) cihaz onu sorgusuz kabul ediyor.
Yapılacak: ardışık iki NTP okuması arasında makul olmayan fark (örn. > 1 gün)
görülürse olay yazmak ve son geçerli saati bir süre korumak.

### Azami kesintisiz yanma sınırı
Röle saatlerce kesintisiz çekili kalabilir (hedef yüksek + oda soğuk + kombi
yetersiz). Emniyet açısından "N saatten uzun kesintisiz ısı isteği" bir üst
sınıra bağlanmalı ve olay yazılmalı. Faz 3'te kombi gerçekten bağlanınca bu
madde **blokajlı** hale gelir.

### TLS istemcisinin yeniden kullanımı
Her senkron turunda yeni `WiFiClientSecure` kuruluyor = tam TLS el sıkışması.
Periyot 5 sn'den 30 sn'ye çıkarıldığı için maliyet 6 kat düştü, ama bağlantının
canlı tutulması (keep-alive) hem akım hem gecikme kazandırır. Faz 2'de ölçülecek:
el sıkışma başına süre + akım.
