# Supabase bulut projesi — Serhat Bey'in yapması gerekenler

Faz 1'in tamamı **yerel** Supabase yığınında kuruldu ve ölçüldü. Bulut projesi
**açılmadı**: bu oturumdaki Supabase araçları mevcut canlı projelere (apartman,
seven-express, soru) bağlı; onlara dokunmamak için yeni proje açılmadı.
Şema, Edge Function ve testler hazır — aşağıdaki adımlar yaklaşık 10 dakika.

> ⚠️ Mevcut projelerden hiçbiri kullanılmamalı. Kombi **ayrı** bir projede durur.

## 1. Yeni proje

1. https://supabase.com/dashboard → **New project**
2. Ad: `kombi` · Bölge: Frankfurt (eu-central-1) · Katman: **Free**
3. Veritabanı parolasını parola yöneticisine kaydedin (bir daha gösterilmez).
4. Proje açılınca **Project Settings → General**'dan `Project ref` değerini alın.
5. Hesapta iki adımlı doğrulama (MFA) açık olsun — bu proje evin ısıtmasını kontrol ediyor.

## 2. Şemayı uygulama

Makinede, depo kökünde:

```
npx supabase link --project-ref <PROJE_REF>
npx supabase db push
```

`db push` yalnız `supabase/migrations/` altındaki tek dosyayı uygular:
tablolar, RLS politikaları, çakışan kural tetikleyicisi, `device_health` görünümü
ve `anon` yetkisinin geri alınması.

## 3. Edge Function

```
npx supabase functions deploy device-sync --no-verify-jwt
```

`--no-verify-jwt` gerekli: cihazda kullanıcı oturumu yok, kimlik doğrulaması
cihaz sırrıyla yapılıyor (fonksiyonun kendi içinde).

## 4. Kullanıcı ve cihaz kaydı

1. **Authentication → Users → Add user**: kendi e-postanız + güçlü parola,
   "Auto confirm" açık. Çıkan `user id`'yi kopyalayın.
2. Cihaz sırrını üretin (terminalde):

   ```
   openssl rand -hex 32
   ```

   Çıkan değeri `firmware/include/config.h` içindeki `DEVICE_SECRET`'a yazın.
   SHA-256 özetini alın:

   ```
   printf '%s' '<SIR>' | shasum -a 256
   ```

3. **SQL Editor**'de (sırrın kendisi değil, yalnız özeti veritabanına girer):

   ```sql
   insert into public.devices (id, owner_id, name, secret_sha256)
   values ('kombi-salon', '<USER_ID>', 'Salon kombisi', '<SHA256_OZETI>');
   insert into public.device_settings (device_id) values ('kombi-salon');
   ```

## 5. Firmware ve panel yapılandırması

`firmware/include/config.h`:

```c
#define WIFI_SSID  "<ev wifi adı>"
#define WIFI_PASS  "<wifi şifresi>"
#define SUPABASE_FUNCTION_URL "https://<PROJE_REF>.supabase.co/functions/v1/device-sync"
#define SUPABASE_ANON_KEY ""           // zorunlu değil
#define DEVICE_ID "kombi-salon"
#define DEVICE_SECRET "<4. adımdaki sır>"
```

`dashboard/config.js`:

```js
window.KOMBI_CONFIG = {
  SUPABASE_URL: "https://<PROJE_REF>.supabase.co",
  SUPABASE_ANON_KEY: "<anon public anahtar>",
  HISTORY_HOURS: 24,
  POLL_SECONDS: 15,
};
```

İkisi de `.gitignore`'da; depoya girmez.

## 6. Doğrulama (beyan değil ölçüm)

```
cd firmware && pio run -e esp32dev -t upload --upload-port /dev/cu.wchusbserial140
```

Seri portta (115200) şu satırlar görülmeli:
`[WiFi] baglaniyor: ...` → `cloud=ok` içeren bir `STATE` satırı.

Sonra panelde: **Table Editor → device_state** satırı dolmalı, `last_seen_at`
güncellenmeli. Panel tarayıcıdan açıldığında anlık sıcaklık görünmeli.

Bulut tarafının RLS'ini aynı testle sınamak için (yerelde 24/24 geçti):

```
SUPABASE_URL=https://<REF>.supabase.co ANON_KEY=<anon> SERVICE_KEY=<service> \
DB_URL=<Project Settings > Database > Connection string> node tests/rls_test.mjs
```

> Bu test iki geçici kullanıcı oluşturur ve mutasyon adımında `devices` tablosunun
> RLS'ini bir an kapatıp geri açar. **Canlıda kullanmadan önce okuyun**; isterseniz
> mutasyon bölümünü atlayın (o zaman "alet canlı mı" kanıtı da düşer).

## 7. Faz 2'ye bırakılanlar

- Netlify yayını (ayrı onay)
- `pg_cron` ile "cihaz sustu / donma riski" kontrolü ve Telegram alarmı
  (veri kaynağı hazır: `public.device_health` görünümü)
