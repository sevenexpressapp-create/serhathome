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

### Telemetri budama cron'u
`public.prune_telemetry(days)` fonksiyonu **hazır** ve yalnız service_role'e
açık. `pg_cron` zamanlaması henüz kurulmadı (bulut projesi açılmadı):

```sql
select cron.schedule('kombi-telemetri-buda', '17 3 * * *',
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
