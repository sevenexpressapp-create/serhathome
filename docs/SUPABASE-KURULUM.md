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
   ⚠️ Parola politikası (§7.2) gereği parola **en az 12 karakter** ve
   büyük/küçük harf + rakam + sembol içermeli; yoksa Supabase 422
   `weak_password` döner.

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
   values ('<CIHAZ_KIMLIGI>', '<USER_ID>', 'Salon kombisi', '<SHA256_OZETI>');
   insert into public.device_settings (device_id) values ('<CIHAZ_KIMLIGI>');
   ```

   > **Cihaz kimliği tahmin edilebilir olmasın** (güvenlik denetimi, düşük
   > öncelik ama ücretsiz): `kombi-salon` yerine örneğin
   > `kombi-$(openssl rand -hex 4)` kullanın. Kimlik tek başına yetki vermez
   > (sır gerekli) ve 401 cevapları ayırt edilemez; ama hedefli deneme yapan
   > birinin işini zorlaştırır. Aynı değer `config.h`'daki `DEVICE_ID` olmalı.

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

Bulut tarafının RLS'ini aynı testle sınamak için (yerelde 34/34 geçti):

```
SUPABASE_URL=https://<REF>.supabase.co ANON_KEY=<anon> SERVICE_KEY=<service> \
node tests/rls_test.mjs
```

> ⚠️ **Mutasyon adımını canlıda KOŞMAYIN** (güvenlik denetimi ORTA-5). O adım
> `alter table ... disable row level security` çalıştırıyor; `finally` geri açıyor
> ama koşum SIGKILL alırsa ya da makine çökerse **tablo RLS'siz kalır.** Bu yüzden
> adım artık `KOMBI_MUTATE=1` bayrağı arkasında ve yalnız `127.0.0.1` hedefinde
> çalışıyor. Yukarıdaki komutta bayrak YOK: bulut koşumunda mutasyon atlanır,
> testin kalan 28 ölçümü koşar. "Alet canlı mı" kanıtı yerelde alınır
> (`KOMBI_MUTATE=1 node tests/rls_test.mjs`) — aynı şema, aynı politika dosyası.

Ayrıca bulut projesinde koşulacaklar:

```
SUPABASE_URL=https://<REF>.supabase.co SERVICE_KEY=<service> node tests/device_sync_test.mjs
SUPABASE_URL=https://<REF>.supabase.co SERVICE_KEY=<service> node tests/auth_policy_test.mjs
```

`auth_policy_test.mjs` §7'deki kimlik ayarlarının gerçekten uygulandığını ölçer
(kayıt kapalı mı, parola politikası tutuyor mu, meşru kullanıcı girebiliyor mu).

## 7. 🔴 KİMLİK GÜVENLİĞİ — Serhat Bey'in panelden yapacakları

Güvenlik denetimi bunu **"internetten kombiye uzanan en gerçekçi tek zincir"**
diye işaretledi (YÜKSEK-2). Sebep: panel Netlify'da herkese açık olacak ve proje
adresi + anon anahtar tarayıcıya gidiyor — yani **proje adresi herkese açıktır.**
Kayıt açık + 6 karakterlik parola + captcha yok = parola püskürtmesi. Hesap ele
geçerse saldırgan hedefi 30 °C'de tutabilir, kuralları yeniden yazabilir, donma
korumasını sabote edebilir.

`supabase/config.toml` içindeki ayarlar düzeltildi ve **yerel yığında ölçüldü**
(`node tests/auth_policy_test.mjs` → 5/5). CLI ile bulut projesine basmak için:

```
npx supabase link --project-ref <PROJE_REF>
npx supabase config push          # config.toml'daki auth ayarlarini projeye yazar
```

`config push` desteklenmiyorsa ya da bir kısmı geçmezse **panelden** yapılacaklar:

### 7.1 Site adresi ve yönlendirme (Authentication → URL Configuration)
| Alan | Değer |
|---|---|
| **Site URL** | `https://<KOMBI-PANEL-ADRESI>.netlify.app` (localhost BIRAKILMAZ) |
| **Redirect URLs** | aynı adres (ve geliştirme için `http://127.0.0.1:8788`) |

Neden: parola sıfırlama / e-posta doğrulama bağlantıları bu adresi kullanır;
localhost kalırsa bağlantılar Serhat Bey'in makinesine işaret eder.

### 7.2 Kayıt ve parola (Authentication → Sign In / Providers → Email)
| Ayar | Değer | Ölçüm |
|---|---|---|
| **Allow new users to sign up** | **KAPALI** | anonim kayıt → 422 `signup_disabled` |
| Minimum password length | **12** | 9 karakterlik parola → 422 `weak_password` |
| Password requirements | **Lower, upper, digits, symbols** | yalnız küçük harf → 422 |
| Secure password change | **AÇIK** | parola değiştirmek için yeniden kimlik ister |

> ⚠️ **"Email provider"ı kapatmayın.** `[auth.email] enable_signup = false`
> yazmak e-posta/parola ile **girişi de** kapatıyor (ölçüldü: 422
> `email_provider_disabled`, panel hiç açılmıyor). Kayıt kapatmayı yapan tek
> doğru yer genel `enable_signup` ayarıdır.

### 7.3 Captcha (Authentication → Attack Protection)

> 🔴 **ŞİMDİ AÇMAYIN — kendinizi panelden kilitlersiniz.** Ölçüldü 15.10.2026:
> `dashboard/app.js` ve `index.html` içinde captcha ile ilgili **hiç kod yok**;
> giriş `signInWithPassword({ email, password })` ile yapılıyor ve
> `captchaToken` göndermiyor (`app.js:80-83`). Supabase tarafında captcha
> açılırsa her giriş isteği reddedilir ve panele girilemez.
> MFA'daki (§7.4) tuzağın aynısı: **sunucu tarafını, arayüz tarafı hazır
> olmadan sertleştirmeyin.**

Doğru sıra (ikisi aynı turda, Faz 2'de yayınla birlikte):
1. hcaptcha.com'da ücretsiz hesap + site tanımı. İki anahtar verir:
   **sitekey** (herkese açık, giriş sayfasına gömülür) ve
   **secret** (gizli, yalnız Supabase paneline girilir, **depoya YAZILMAZ**).
2. Giriş ekranına hCaptcha bileşenini ekleyin ve jetonu
   `signInWithPassword({ email, password, options: { captchaToken } })`
   ile gönderin.
3. Ancak ondan sonra Supabase'de **Enable Captcha protection** → hCaptcha,
   secret'ı girin.
4. Ölçün: captcha'sız bir giriş denemesi reddedilmeli (negatif kontrol),
   arayüzden normal giriş geçmeli (pozitif kontrol). İkisi de ölçülmeden
   "captcha çalışıyor" denmez.

Aciliyet düşük: captcha'nın işi, panel **internete açıldıktan sonra** giriş
ekranına yapılan otomatik deneme saldırılarını kesmek. Panel yayınlanmadan
önce açılmasının güvenlik kazancı yok, kilitlenme riski var.

Yerelde **bilerek kapalı**: captcha açıkken her giriş bir captcha jetonu ister ve
kabul testleri (`tests/panel_test.mjs`, `tests/rls_test.mjs`) koşulamaz hale gelir.
`config.toml` içinde hazır blok yorumda duruyor.

### 7.4 MFA — **panel kullanıcısı için** (Authentication → Multi-Factor)
Bu, Supabase *hesabınızın* MFA'sı değil; **panelde oturum açan kullanıcının**
ikinci adımı. Ev ısıtmasını kontrol eden bir hesap için:
- MFA'yı etkinleştirin (TOTP), ardından panelden giriş yapıp kendi
  kullanıcınız için bir doğrulayıcı kaydedin.
- Not: mevcut panel arayüzü MFA adımını **henüz göstermiyor**; MFA zorunlu
  yapılırsa panel giriş akışına TOTP alanı eklenmelidir (Faz 2 işi, tek ekran).
  Bu yüzden şimdilik "etkinleştir + kaydet" önerilir, "zorunlu kıl" önerilmez.

### 7.5 Doğrulama (beyan değil ölçüm)
```
SUPABASE_URL=https://<REF>.supabase.co ANON_KEY=<anon> SERVICE_KEY=<service> \
node tests/auth_policy_test.mjs
```
Beş ölçümün beşi de geçmeli. S5 ("geçerli kullanıcı giriş yapabiliyor")
geçmiyorsa 7.2'deki uyarıya dönün: e-posta sağlayıcısı kapanmış olabilir.

## 8. Faz 2'ye bırakılanlar

- Netlify yayını (ayrı onay). Yayın kökü `dashboard/`, güvenlik başlıkları
  `dashboard/_headers` dosyasında — **`connect-src`'deki `*.supabase.co`
  jokerini gerçek proje adresiyle değiştirin.**
- `pg_cron` ile "cihaz sustu / donma riski" kontrolü ve Telegram alarmı
  (veri kaynağı hazır: `public.device_health` görünümü). ⚠️ `events` tablosunun
  üreticisi yok — `docs/FAZ2-GUVENLIK-KALEMLERI.md` O2.
- `pg_cron` ile telemetri budama: `select public.prune_telemetry(30)`
- Kalan güvenlik kalemleri: `docs/FAZ2-GUVENLIK-KALEMLERI.md`
