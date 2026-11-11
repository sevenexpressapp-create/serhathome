# PROGRESS — Kombi uzaktan kontrol

Bu dosya projenin **süreklilik defteri**: bir sonraki iş kim tarafından yapılırsa
yapılsın bağlamı burada bulur. Yeni iş eklerken en üste yaz (tarih + değişiklik +
neden). Ayrıntılı ölçümler `docs/FAZ1-TEST-SONUCLARI.md`'de.

---

## 11.11.2026 (3. tur) — İKİ GÖÇ DE CANLIDA ✅

Serhat Bey iki bloğu da Supabase SQL editöründen koştu (`docs/SUPABASE-KURULUM.md`
§8.1). Aşağıdaki "uygulanmadı / kurulmadı" kayıtları **bu satırdan eskidir.**
MCP bağlantısı hâlâ `--read-only`; ölçümler okuma sorgularıyla yapıldı.

**Budama cron'u — `cron.job` tek satır:** `jobid=1`, `kombi-telemetri-buda`,
`17 0 * * *`, `username=postgres`, `active=true`,
`command = select public.prune_telemetry(30)`. `pg_cron 1.6.4` kurulu,
`cron.timezone = GMT` → **03:17 TRT**.
⚠️ `cron.job_run_details` **boş** — iş henüz koşmadı. İlk koşum **0 satır**
silecek: 31.947 satır var, 30 günden eskisi **yok** (en eski 14.10). İlk gerçek
silme ~13.11. **Yarın `status = succeeded` doğrulanmalı.**

**KRİTİK-1 yetki düzeltmesi — kapandı.** Uygulama sonrası canlıdan ölçüldü:
`proacl = {postgres=X/postgres,service_role=X/postgres}` (önce
`authenticated=X/postgres` de vardı); `has_function_privilege`:
`authenticated` **false**, `anon` **false**, `service_role` **true**,
`postgres` **true**. Cron kırılmadı — `active` kaldı, EXECUTE sahiplikten
geliyor.

**Göç defteri:** `supabase_migrations.schema_migrations` **3 satır**
(`20261014090000_kombi_init`, `20261111180000_telemetri_budama_cron`,
`20261111211500_prune_telemetry_yetki_duzeltme`). Depo ile canlı hizalı; bir
sonraki `db push` init'i ikinci kez uygulamaya çalışmaz.

**Max rows 1000 → 2000 YAPILDI** (11.11.2026, Serhat Bey Supabase panelinden
bildirdi). ⚠️ Bu ayar ne MCP'den ne REST'ten okunabiliyor (veritabanında
durmuyor), yani **bizim ölçümümüz değil** — kaynağı Serhat Bey'in beyanı. Etkisi
yalnız grafiğin 24 saati tam çizmesi; kart sayıları zaten tavandan bağımsız.
Kadans 60 sn → 24 saat = 1.440 satır, yeni tavanın altında.

**Hâlâ açık:** `cron.job_run_details` için **izleme yok** (sessiz kırılma
riski) · girişte rate limit / captcha / MFA yok · S2 klemens gerilimi
ölçülmedi.

---

## 11.11.2026 (2. tur) — Kod denetiminin kapanış BLOK'u kapatıldı (4 YÜKSEK + 1 KRİTİK)

SQL'in kendisi ONAY almıştı; denetçi işin **kapanışını** bloke etti. Bu turda o
kalemler kapandı. (Bu turun sonunda commit/push yoktu ve canlıya hiçbir şey
uygulanmamıştı; **ikisi de 3. turda yapıldı** — yukarıdaki kayıt.)

**KRİTİK-1 — `prune_telemetry` yetkisi → AYRI göç yazıldı.**
`supabase/migrations/20261111211500_prune_telemetry_yetki_duzeltme.sql`:
`revoke all on function public.prune_telemetry(integer) from authenticated, anon, public;`
Kök sebep ölçüldü: `kombi_init.sql:165`'teki `revoke … from public` yalnız
`PUBLIC` sözde-rolünü alıyor; Supabase'in `alter default privileges` ayarı ACL'e
**adlandırılmış** `authenticated=X/postgres` girdisi yazıyor ve revoke ona
dokunmuyor. `anon`'un kapalı olması ayrı bir satırın eseri (`kombi_init.sql:273`,
fonksiyonlardan SONRA koşuyor); simetrik `authenticated` satırı hiç yazılmamış.
`kombi_init.sql:166`'daki "panel kullanıcısı veri SİLEMEZ" yorumu **yanlıştı** —
o satır **değiştirilmedi** (uygulanmış göç), yanlışlığı yeni göçün başlığında
yazılı. Cron kırılmaz: iş `postgres` olarak koşar ve `postgres` fonksiyonun
sahibi (EXECUTE sahiplikten gelir). Çağıran istemci yok (dashboard/firmware/
tests/functions/tools/snippets taramasında **0 eşleşme**). ✅ **Canlıya
11.11.2026'da uygulandı** — ölçüm 3. tur kaydında.

**YÜKSEK-2 — gerilemeyi ölçen sınav eklendi.** `tests/auth_policy_test.mjs`
artık **7 ölçüm** (S1-S5 kimlik + yeni S6 fonksiyon yetkisi + S7 pozitif
kontrol). Ölçüm (yerel yığın, `authenticated=X` canlıyla **birebir aynı**):
- Göç uygulanmadan: **6/7, S6 KALDI, çıkış kodu 1** (durum=200 → çağrı geçti).
- Göç yerelde uygulandıktan sonra: **7/7, çıkış kodu 0**, S6 `durum=403 kod=42501`.
- Yetkiyi elle geri verip gerileme taklit edildi → yine **6/7, çıkış kodu 1**
  (yani kapı gerçekten kapı; sessiz geçmiyor).
- `telemetry` satır sayısı üç koşumun hepsinde **3647 → 3647** (hiç silme yok).
⚠️ **Tasarım kararı:** denetçi `p_keep_days: 1` önermişti — yetki açık kalırsa o
çağrı gerçekten siler. Sınav **36500 gün** (100 yıl) kullanıyor: yetki açıkken
çağrı geçse bile `ts < now()-36500g` hiçbir satır tutmaz, silme 0. Ölçüt **hata
kodu** (42501), satır sayısı değil. Dosyada `KEEP_DAYS < 3650` olursa sınav
çıkış kodu 2 ile DURUR (gelecekteki bir düzenleme bunu veri silen araca
çevirmesin).
⚠️ **Yerel-yığın kapısı BİLEREK eklenmedi** (kardeş testlerin aksine) — gerekçe
aşağıda "Patron'a açık kalem".

**YÜKSEK-1 + ORTA-7 — eskimiş metinler düzeltildi.**
- `docs/FAZ2-GUVENLIK-KALEMLERI.md`: "yalnız service_role'e açık" ⚠️ ile
  düzeltildi (ölçüm + yeni göçe atıf); "pg_cron kurulmadı (bulut projesi
  açılmadı)" notu 11.11.2026 durumuna çevrildi; örnek SQL `'17 0 * * *'` oldu.
- `docs/SUPABASE-KURULUM.md`: "`db push` tek dosyayı uygular" → **üç dosya**
  tablosu; §7.5 "beş ölçüm" → **yedi**; yeni **§8.1** uygulama bloğu.
- `dashboard/app.js`: yalnız **yorum** güncellendi (918-920 civarı). **Ekran
  metnine dokunulmadı** — "30 günden eskisi bu ekranda gösterilmiyor" doğru.

**YÜKSEK-4 — ev verisi depoya girmesin.** Kökteki `panel-1-giris.png`,
`panel-2-mobil.png`, `panel-3-bos-durum.png` **silinmedi/taşınmadı**;
`.gitignore`'a `/panel-*.png` kök kuralı gerekçesiyle eklendi. Ölçüm:
`git check-ignore -v` üçünü de `.gitignore:52` ile eşledi, `git status --short`
artık üçünü **göstermiyor**, `docs/mockup/*` **etkilenmedi**, `git log --all
--diff-filter=A` taramasında geçmişte hiç commit edilmemiş (0 eşleşme).

**YÜKSEK-3 — göç defteri.** SQL editöründen koşan ifade
`supabase_migrations.schema_migrations`'a satır yazmıyor → depo/canlı ayrışır.
§8.1'deki bloğa defter satırı eklendi. Kolonlar ölçüldü (canlı + yerel):
`version`, `statements`, `name` (**`inserted_at` yok**); `version` birincil
anahtar (`schema_migrations_pkey PRIMARY KEY (version)`, yerelde ölçüldü);
`statements` NULL olabilir. Yine de `on conflict` yerine **`where not exists`**
kullanıldı (kısıt adı/sürümü ne olursa olsun çalışır). Blok yerelde
`begin … rollback` içinde sınandı: 1. insert 1 satır, 2. insert **0 satır**
(idempotent), defter sonrasında eski hâline döndü. ℹ️ `name` kolonu iki ortamda
farklı dolmuş (canlı `20261014090000_kombi_init`, yerel `kombi_init` — CLI
sürüm farkı); blok canlının biçimini izliyor, eşleştirme `version` ile.

**K1/K2/K3 (Patron'un kararları) uygulandı — göç yorumu yeniden yazıldı:**
- **K1:** zamanlama `'17 3 * * *'` → **`'17 0 * * *'`** (00:17 UTC = **03:17
  TRT**). Yorumda "dizge aynen korundu" iddiası kaldırıldı; yerine "dizge
  DEĞİŞTİ, niyet (gece 03:17) korundu" yazıldı. Ölçüm: göç yerelde **2 ardışık
  koşum, ikisi de çıkış kodu 0**; `cron.job` tek satır, `jobid=1` değişmedi,
  `schedule='17 0 * * *'`, `username=postgres`, `active=t`.
- **K2:** saklama **30 gün KALDI**. Gerekçe düzeltildi: bağlayıcı pencere
  panelin **30 günlük sayım** penceresi (`dashboard/app.js:725` `iso30`,
  sayımlar `app.js:753-754`, kaydın başlangıcı `app.js:759`) — 24 saatlik grafik
  bunun alt kümesi. "Panelin sayım penceresi değişirse BU GÖÇ de değişmeli;
  şu an tam tümleyen, PAY YOK" kaydı göçe yazıldı.
- **K3:** idempotentlik `(jobname, username)` çiftine bağlı — yorum "aynı ROL
  (postgres) ile çağrıldığında" diye nitelendi, başka rolle ikinci iş oluşacağı
  yazıldı. Geri alma satırı güvenli biçime çevrildi:
  `select cron.unschedule(jobid) from cron.job where jobname = 'kombi-telemetri-buda';`

**🔴 Patron'a / Serhat Bey'e açık kalem (karar gerekiyor):** denetçi
`tests/auth_policy_test.mjs`'e "hedef yerel değilse çıkış kodu 2" kapısı
istemişti. **Eklenmedi** — ölçüm: bu dosyada öyle bir kapı hiç yoktu ve bu
**bilinçli**: 14.10 denetiminin 2. turunda "sahte yeşil" dersiyle dosya BULUTA
karşı koşacak biçimde düzeltilmişti (ortam değişkenleri hedefi eziyor) ve bulut
koşumu üç yerde yazılı (`README.md:43`, `docs/SUPABASE-KURULUM.md` §6 ve §7.5).
Üstelik S6'nın ölçtüğü **açık yetki canlı projede duruyor** — yerele kilitlemek,
ölçülmesi gereken yeri ölçümsüz bırakırdı. Güvenlik bunun yerine çağrıyı
zararsız kılarak sağlandı (36500 gün + `KEEP_DAYS` kapısı). Serhat Bey yine de
sert kapı isterse eklenir, ama o zaman bulut doğrulaması kaybedilir.

**Yerel yığının durumu (bilinsin):** iki göç de yerelde **uygulandı** (cron işi
kurulu, `authenticated` yetkisi kapalı) ama **göç defterine yazılmadı** (kasten,
rollback'li sınama). İkisi de idempotent olduğu için sonraki `db push` sorunsuz
yeniden uygular.

---

## 11.11.2026 — Telemetri budama cron'u (O7): göç dosyası yazıldı (canlıya 3. turda uygulandı)

Serhat Bey onayladı. **Yeni göç:** `supabase/migrations/20261111180000_telemetri_budama_cron.sql`
(uygulanmış `20261014090000_kombi_init.sql` **ellenmedi** — git temiz; içindeki
yorumlu öneri olduğu gibi bırakıldı, yeni dosya yazıldı).

İçeriği iki satır: `create extension if not exists pg_cron with schema pg_catalog;`
+ `cron.schedule('kombi-telemetri-buda','17 3 * * *', select public.prune_telemetry(30))`.
> ⚠️ **Bu dizge 2. turda DEĞİŞTİ** (yukarıdaki 11.11 2. tur kaydı): güncel hâli
> `'17 0 * * *'` = 00:17 UTC = 03:17 TRT. Aşağıdaki "TR 06:17" ve `'17 3 * * *'`
> ifadeleri **1. turun tarihsel kaydıdır**, uygulamaya esas değildir.
Fonksiyon yeniden tanımlanmadı — canlıdaki gövde depodakiyle BİREBİR aynı
(`pg_get_functiondef` md5 `a97bbf31…` yerelde ve canlıda eşit).

**✅ Göç CANLIYA UYGULANDI (11.11.2026, aynı gün 3. tur).** MCP bağlantısı
`--read-only` olduğu için uygulamayı Serhat Bey Supabase SQL editöründen yaptı;
sonucun ölçümü en üstteki 3. tur kaydında.

**Ölçüldü (yerel yığın, PG 17.11 + pg_cron 1.6.4 — canlının aynısı):**
- Temiz başlangıçtan (uzantı düşürülüp) **3 ardışık koşum, üçü de çıkış kodu 0**;
  `cron.job`'da tek satır, zamanlama ve komut doğru.
- `prune_telemetry(30)`: kasten eskitilmiş 12 satır (40 ve 31 günlük) **silindi**,
  29 günlük 3 satır ve yeni 2 satır **bırakıldı**; ikinci çağrı 0 sildi;
  `prune_telemetry(0)` → `p_keep_days >= 1 olmali` hatası atıyor.
- Uçtan uca: dakikalık sınav işi kurulup beklendi → `cron.job_run_details`
  `status=succeeded`, `username=postgres`, 7 ms. Sınav işi kaldırıldı.
- `cron.timezone` = **GMT** → `17 3 * * *` UTC'dir, TR 06:17.

**İki tuzak (ikisi de ölçümle bulundu, ayrıntı developer derslerinde):**
1. **Supabase belgesindeki elle `grant` satırlarını göçe YAZMAYIN.**
   `create extension pg_cron` Supabase'in `issue_pg_cron_access` olay tetiğini
   ateşliyor, tetik yetkileri kendi kuruyor. Elle grant yazılınca 2. koşum
   `ERROR: dependent privileges exist` ile düşüyor. Grant'ler çıkarıldı.
2. **🔴 AÇIK BULGU → 2. TURDA KAPATILDI** (göç `20261111211500_…`, yukarıdaki
   2. tur kaydı; canlıya 3. turda uygulandı): `kombi_init.sql:166`
   yorumu "panel kullanıcısı veri SİLEMEZ" diyor, **doğru değil.** Canlıda
   ölçüldü: `prune_telemetry` ACL'i `authenticated=X/postgres` taşıyor,
   `has_function_privilege('authenticated', …, 'EXECUTE')` = **true**. Giriş
   yapmış panel kullanıcısı `prune_telemetry(1)` çağırıp geçmişi silebilir.
   `revoke all … from public` PUBLIC payını alır, rolün kendi bağışını almaz.
   Düzeltme ayrı bir göç + Serhat Bey onayı ister.

**Canlı durum (11.11, ölçüm):** `telemetry` 31.874 satır / 5.688 kB, en eski
`2026-10-14 20:46` (28 gün) → **30 günden eski satır sayısı 0**, yani ilk koşum
hiçbir şey silmeyecek. İlk gerçek silme ~13.11'de başlar.

**Yan not:** yerel dev yığınında temizlik sorgum `temp_c in (19.7,19.8)` ile
yazıldığı için kendi sınav satırlarımın yanında **16 tohum satırını da sildi**
(3663 → 3647). Canlıya dokunmadı; yerel tohum `node tests/seed_demo.mjs` ile
yeniden üretilebilir.

---

## 10.11.2026 (3. tur) — Kod denetiminin BLOK'u kapatıldı; kartın kendi testleri yazıldı

Tasarım 2. turda ONAY verdi; kod denetimi BLOK verdi. Hepsi bu turda kapandı,
**commit/push yine yok.** `node tests/panel_test.mjs` **24/24** (21 → 24).

**A1 — kart ve grafik aynı kuralı çağırıyordu ama aynı DİZİYİ paylaşmıyordu.**
Kart `lastRows`in tamamından, grafik `temp_c` dolu satırlardan hesaplıyordu;
DHT11'in iki okumayı kaçırdığı yerde kart "tek yanma 19 dk" derken grafik aynı
yanmayı **ikiye bölüyor** ve o aralığa "kayıt yok" işareti koyuyordu — oysa
kayıt vardı, yalnız sıcaklık okunamamıştı. Artık yanma dizileri, boşluk kararı
ve kadans **tek kaynaktan** (`yanmaDurumu()` → `lastRows`) geliyor; grafik
onları çiziyor. İki olgu **ayrı işaretle** anlatılıyor: *kayıt yok* = dolgu +
düz `--axis` kenar; *sıcaklık okunamadı* = dolgusuz, **kesikli** kenar. İkisinin
de göstergede adı var.

**A2 — gece yarısından sonra "Bugün" dünün toplamıydı** (5 dk'ya kadar).
Sayıma `geceMs` yazılıyor; gece yarısı değişmişse "Bugün" **—** oluyor ve
tazeleme hemen tetikleniyor.

**A3 — aynı yanma sürerken 20 dk, bitince 19 dk görünüyordu.** Tek ölçü:
**satır sayısı** (kutucuklar zaten sunucunun satır sayımı). Görünen aralık da
son örneğin kapsadığı kadansın sonunda bitiyor, böylece "01:41–03:22 · 1 sa
41 dk" kendi içinde tutarlı.

**A4 — kartın hiç testi yoktu ve depo tohumu 5 dakikalıktı** (kart gerçeğin
1/5'ini gösteriyordu). `tests/seed_demo.mjs` artık üretimin ritminde:
**60 sn × 24 saat**, içinde **90 dakikalık kayıt boşluğu** ve yanan bir dizinin
ortasında **iki satırlık `temp_c = null`**. Panel testine kart için üç kapı
eklendi (D21 kart/grafik aynı dizi + boşluk davranışı · D22 toplamlar sunucunun
bağımsız sayımıyla birebir · D23 sayım gelmeden "—"). Üçü de **sabotajla
sınandı**: ilgili düzeltme geri alındığında kırmızıya dönüyorlar.

**A5 — "1 satır = 1 dakika" iki yerde gömülüydü.** Kadans artık tek adlandırılmış
sabit (`TELEMETRI_KADANS_TABANI_MS`, yorumunda kaynağı `device-sync`
`TELEMETRY_MIN_GAP_MS` yazılı) ve **önce veriden ölçülüyor** (medyan aralık);
kapsam beklentisi de ondan türüyor.

**Orta kalemler:** O1 artan geri çekilme (30 sn → 1 dk → 5 dk, ölçüldü:
29/59/299 sn) · O2 `burnCountsBusy` artık `resetView`de sıfırlanıyor + isteğe
20 sn zaman aşımı · O3 testteki ">200" sabitleri çizim genişliğine bağlıydı,
beklenti artık sayfanın verisinden türüyor · O4 "Kayıtlar 30 gün tutulur" sözü
(budama cron'u kurulmadı) → **"30 günden eskisi bu ekranda gösterilmiyor."** ·
O5 değişken gölgelemesi · O6 ölü alan + bayat yorum · O7 `yanmaDurumu()`
önbelleğe alındı + `resize` `requestAnimationFrame` ile frenlendi · O8 cihaz
okunamazken ayar/kural düğmeleri sessizce patlıyordu (artık Türkçe hata) ve
`loadDevice` hatası paneli kalıcı ölü bırakıyordu — her yoklamada yeniden
deneniyor.

**Tasarımın üç kalemi:** T1 panelin tamamı artık **virgül** (durum kartı ve
sayaç da) — görünür metinde noktalı ondalık **0**; T2 kayıt boşluğuna `--axis`
kenar + göstergede "Kayıt yok" ve "Sıcaklık okunamadı"; T3 kırpılma cümlesi
artık **görünür** `.explain` satırında. Nit'ler: kısa yanmada `rx` genişliğin
yarısını geçmiyor, cihazın sustuğu süre 24 saati aşınca gün olarak yazılıyor.

### 4. tur (kapanış) — emniyet kapısı + beş küçük kalem

- **🔴 En önemlisi: `tests/panel_test.mjs`in yerel-yığın kapısı yoktu.** Takım
  YAZAN ölçümler içeriyor (D17/D19 `device_settings`e gerçekten yazıyor) ve
  hedefini `dashboard/config.js`ten alıyor — o dosya yayında **bulut**
  projesini gösteriyor. Yanlış yöne koşulsa evin hedefini 5,5 °C'ye çekerdi.
  Artık iki kapı var: (1) tarayıcı **açılmadan** önce panelin `config.js`i
  okunuyor, hedef `127.0.0.1`/`localhost` değilse takım koşmadan çıkıyor
  (çıkış kodu 2); (2) giriş/yazma adımından önce tarayıcının gerçekten
  yüklediği `KOMBI_CONFIG.SUPABASE_URL` aynı ölçütle doğrulanıyor.
  Üslup `seed_demo.mjs` / `rls_test.mjs` / `auth_policy_test.mjs` ile aynı.
- Kadans artık **kapıya bağlı** (D21: `kadansSn === 60`) — yanlışlarsa kart ve
  beklenti birlikte kaydığı için eskiden kapı yeşil kalıyordu.
- D22'nin gece yarısı kör noktası: `"—"` artık 0'dan ayrı (`null`) ve "Bugün"
  bacağına da `> 0` tabanı kondu.
- Grafik işaretleri çizim alanına **kırpılıyor** (serinin ucundaki uzun sensör
  arızasında işaret Y etiketlerinin üstüne taşıyordu); yeni kapı **D24**.
- Olumsuz iddiaların (`!sayfadaSicaklikVar`, `sahteSayiVar === false`) içine
  **kalibrasyon** satırı kondu: desen bir ters-bölü kaybederse kapı sessizce
  yeşil kalırdı.
- `renderChart` artık parametresiz; seri tek kaynaktan (`lastRows`/`settings`).

**🔴 Açık kalemler (bilinçli olarak ertelendi, Patron kararı):**
1. `dashboard/app.js` 1.300 satıra, `renderChart` ~250 satıra çıktı. Dosyayı
   bölmek üç denetim turunun hemen ardından gereksiz risk; ayrıca CSP
   (`script-src 'self'`) yüzünden ek dosya bedava değil.
2. Kenar payı (14 px) testte tekrar ediliyor; tek kaynaktan türemiyor.
3. Tohumun idempotentliği 26 saatle sınırlı (daha eski ölçüm satırları kalır).
4. Tohumun bastığı bağımsız sayımlar (`satir/yanan/bugunYanan`) panel testinde
   tüketilmiyor; D22 sayımı sunucudan kendisi çekiyor.
5. Canlı Supabase'in Max rows ayarı: **2000 yapıldı** (3. tur) — kart zaten buna
   söz vermiyordu. `prune_telemetry` cron'u **artık kuruldu** (3. tur); ekrandaki
   "30 günden eskisi bu ekranda gösterilmiyor" cümlesi yine de doğru ve fazla
   söz vermiyor, **değiştirilmedi.**

---

## 10.11.2026 (2. tur) — Tasarım denetiminin BLOK'u kapatıldı + panel tam Türkçe

Denetim raporu ve 21 kanıt görüntüsü `docs/denetim-2026-11-10/` (depoya
**girmiyor**, `.gitignore`'a `docs/denetim-*/` eklendi; spec ve `docs/mockup/`
takipte kalır). Yine **commit/push yok.**

**BLOK — kayıt boşluğu "yanma" diye çiziliyordu.** Grafiğin yanma şeridi iki
satır arasındaki zamana bakmıyordu; kartın aynı işi yapan döngüsü bakıyordu.
3 saatlik kayıt deliğinin iki yanındaki 20+20 dk yanma grafikte **tek 219
dakikalık blok** olarak çiziliyor, sıcaklık yolu da deliğin üzerinden düz bir
çapraz çizip **ölçülmemiş bir ısınma** gösteriyordu. Çözüm: boşluk kuralı tek
fonksiyonda (`yanmaDizileri`) toplandı, kart ve grafik aynı fonksiyonu çağırıyor;
sıcaklık yolu ve zarfı boşlukta **kırılıyor**; boşluğun kendisi `--grid` ile
işaretleniyor. Eşik sabit değil, serinin **kendi medyan aralığının iki katı**
(60 sn'lik seride 2 dk; 5 dakikalık seyrek seride 10 dk — sabit 2 dk yazsaydık
seyrek seride çizgi parça parça dağılırdı).

**Satır tavanı (bulgu bendendi, çözümü Patron karara bağladı).** Sunucu bir
sorguda en çok 1.000 satır döndürüyor (`supabase/config.toml:18`; bulut
varsayılanı da 1.000) ama 60 sn'de bir yazan cihaz 24 saatte 1.439 satır
üretiyor. İki önlem: (1) telemetri sorgusu **en yeniden geriye** sıralanıp JS'te
çevriliyor → tavan ısırsa bile grafiğin sağ ucu her zaman şu an, kaybedilen
kısım geçmişin eskisi; (2) **bugün ve 24 saat yanma süreleri de sunucuda
sayılıyor** → indirilen pencere kırpılsa bile kart sayıları doğru. Grafiğin
`<title>`'ı da kırpılmışsa artık "son 24 saat" demiyor, çizilen aralığı yazıyor.

**Üç küçük düzeltme:** (F2) süren yanma varken "son yanma" satırı sessizce boş
kalıyordu — koşul "tamamlanmış yanma yok" oldu, ayrıca sorgu süren yanmanın
başlangıcından **öncesine** bakıyor (yoksa kart süren yanmayı "son yanma" diye
yazıyordu). (F3) sayım gelmeden "henüz veri yok" deniyordu; artık o cümle
telemetri okundu **ve** 30 günlük sayım gerçekten 0 ise çıkıyor, bilinmiyorken
"—" yazıyor; grafiğin boş uyarısı da aynı kurala bağlandı. (F4) yorumdaki ham
renk kodu kaldırıldı (ham renk sayımı 33 → 31).

**Test kapısı (F5).** `kesikliHedef === beklenenParca` koşulu, `target_c`'nin
tamamı boş olan kayıtta doğru çizimi kırmızı yapardı (çizim 1, beklenti 0).
Beklenti artık o dalı da kapsıyor.

**Panel tam Türkçe.** `index.html` + `app.js`'te 53 kullanıcı dizgesi
(+ testte 5 iddia) düzeltildi; Serhat Bey'in kararıyla rozet `Isitma acik/kapali`
yerine **`Kombi yanıyor` / `Kombi kapalı`** — panel aynı olguya tek ad veriyor.

**Ölçümler (hepsi bu turda koştu).** `node tests/panel_test.mjs` **21/21**
(temiz tohumla). Fiziksel tutarlı 1.261 satırlık seri + 3 saatlik delikle:
deliğe binen şerit **0**, boşluk dikdörtgeni **180 dk**, sıcaklık yolu **2
parça**, indirilen satır **1.000** (tavan ısırdı) ama kartın "Bugün 1 sa 41 dk"
ve "24 saat 8 sa 26 dk" değerleri tohumun bağımsız sayımıyla **birebir** aynı;
grafiğin sağ ucu şimdiden **1 dk** önce. F3 üç dalda ölçüldü (telemetri
okunmadı / sayım beklenirken / gerçekten kayıt yok) — boş cümle yalnız sonuncuda.
Aydınlık + karanlık ekran görüntüleri alındı ve bakıldı.

---

## 10.11.2026 — Grafik düzeltildi + "Kombi ne kadar yandı" kartı eklendi

Uygulanan belge: **`docs/TASARIM-grafik-ve-yanma-suresi.md`** (tasarımcı, onaylı).
Değişen üç dosya: `dashboard/app.js`, `dashboard/index.html`,
`tests/panel_test.mjs`. **Commit atılmadı, push edilmedi** — Netlify GitHub'a
bağlı olduğu için yayın kararı Serhat Bey'in.

**Grafik (`app.js` `renderChart`).** Eksen etiketi artık çizgisinin **tam**
değerini gösteriyor: alan 0,5'e dışa yuvarlanıyor, yürürlükteki yakma/söndürme
eşiklerini içeriyor, etiket tek ondalık + virgül (`20,0`), adım {0,5/1/2}
içinden etiket arası ≥ 40 px olanı. Eski kusur 0,3–0,5 °C'lik sessiz bir
yalandı (ızgara 19,7'de, etiket "20"). 1.439 ham nokta doğrudan basılmıyor:
1 px'lik sütunlarda **ortalama + en düşük/en yüksek zarfı** (seyreltme değil —
seyreltme tek noktalık tepeyi siler). X ekseni yuvarlak saatlere oturdu, gece
yarısı tikinin altında gün yazıyor. Hedef artık **basamaklı** ve her basamağın
**karar aralığı** (yakma–söndürme şeridi) görünüyor.

**Veri yolu değişikliği (bunu atlayan basamaklı hedefi kuramaz):** telemetri
sorgusu artık `target_c`'yi de çekiyor (`app.js:153` civarı). Hedef çizgisi
`device_settings`'ten değil **telemetri satırlarının kendi `target_c`'sinden**
türüyor; çünkü iki senaryo kuralı hedefi gün içinde değiştiriyor
(02:00 → 22 °C, 06:00 → 21 °C — **bu kurallar bilinçli, değiştirilmedi**).

**Kart.** "Anlık durum"un altında: canlı süre / bugün, son yanma, 4 kutucuk
(bugün · 24 saat · 7 gün · 30 gün). Yanma süresi = `relay_on = true` satır
sayısı × 1 dk. Bugün/24 saat/canlı süre **zaten çekilen** 24 saatlik
pencereden (0 ek istek); 7/30 gün + kapsam + eski "son yanma" sunucuda
sayılıyor (`count: exact, head: true`, göç gerekmedi) ve **15 sn'lik yoklamaya
bağlı değil** — en çok 5 dakikada bir. Ölçüldü: 45 saniyede (3 yoklama)
ağda yalnız var olan 4 sorgu × 3 göründü, sayım isteği **sıfır**; `burnCountsAt`
geri alınınca sayımlar gerçekten koşuyor (pozitif kontrol).
**Gaz/₺ tüketimi kapsam dışı** (Serhat Bey 09.11: "tüketimi boşver") — alan,
yer tutucu, "ileride eklenir" notu yok.

**Kontrast.** Aydınlık moddaki `--muted` #898781 → **#726f6a** (3,50:1 → 4,87:1).
Karanlık moddaki değişmedi. Grafik eksen etiketleri `--text-2`'ye taşındı.
Panelin tüm küçük gri metni bir tık koyulaştı — beklenen sonuç.

**Bir sapma var (karar Serhat Bey'in):** panelin eski metinleri Türkçe
karakter**siz** yazılmış ("Anlik durum", "Sicaklik gecmisi"); spec'in metinleri
ise tam Türkçe ("Kombi ne kadar yandı"). Onaylı metne uydum, dolayısıyla panel
şu an **karışık** görünüyor. Eski metinleri de düzeltmek ayrı, küçük bir iş.

**Ölçümler.** `tests/panel_test.mjs` **21/21** (yerel Supabase yığını + gerçek
CSP başlıkları + başsız Chrome). D3 artık `data-role` seçicilerine bağlı ve
beklenen hedef parçası sayısını **sayfanın kendi verisinden** türetiyor —
eskiden `line[stroke-dasharray] === 1` koşulu tohumun sabit hedefi sayesinde
tutuyordu, canlı şekilli veride doğru çizim kapıyı kırmızı yapardı. Eksen:
etiket–çizgi sapması **0 px**, etiketlerden türetilen ölçekle son okumanın
çizildiği nokta sapması **0 px**. Basamaklı hedef canlı şekilli veriyle
ölçüldü: çizilen basamaklar [22, 21, 22] = verideki ayrık hedefler, bant
kenarları [19,5 20,5 22,5 23,5] = beklenen eşikler. 360/500/1000 px'te yatay
kaydırma yok, konsol temiz; aydınlık ve karanlık ekran görüntüleri alındı.

---

## 15.10.2026 (03:00) — ⏸️ TUR KAPANDI: ikinci test doğruladı, buradan devam

Serhat Bey bağlantıdan sonra **ikinci bir test** yaptı. Faz 3'ün D1–D3
ölçümleri **bağımsız bir koşumda tekrarlandı** — yani ilk sonuç tesadüf değil.

| Saat (veritabanı) | Olan |
|---|---|
| 22:47:24 | Hedef 25 yazıldı → röle **çekti** (oda 23,1; yakma eşiği `25 − 1,5` = 23,5) |
| 22:47:40 | Hedef 20'ye geri alındı |
| 22:48 – 22:51 | Röle çekili kaldı — `reason=min_hold` |
| **22:52:25** | Röle **bıraktı**, `reason=above_band` |

Çekişten bırakışa **301 saniye**; `min_relay_hold_s = 300`. İlk testte de
~300 s ölçülmüştü. **İki bağımsız koşumda aynı sonuç → gecikme tasarlandığı
gibi çalışıyor, ölçüm tekrarlanabilir.**

Kart bu süre boyunca **hiç yeniden başlamadı** (`uptime_s = 700`), yani
kombiye bağlı hâlde WiFi + bulut döngüsü stabil.

**Kullanıcı tarafındaki tek kural:** hedefi düşürdüğün andan itibaren kombinin
sönmesi **5 dakika** sürer. Kısaltılabilir ama kısaltılmamalı — brülörü sık
aç-kapadan koruyan şey bu.

### 🔍 Açıklanmamış gözlem: `rule_active` döndü

İki okuma arasında `rule_active` **True (kural 23) → False (kural None)**
oldu. **Davranışa etkisi yok:** taban hedef 20, `23:00 → 20` kuralı da 20
veriyor; yürürlükteki hedef iki hâlde de 20. Ama *neden* döndüğünü
**bilmiyoruz** — bunu bir sonraki tura açık kalem olarak bırakıyorum,
çözülmüş gibi yazmıyorum. Bakılacak yer: `kombi_core` kural seçimi + NTP
saatinin gün/saat penceresine düşme anı.

### ▶️ Bir sonraki tur buradan başlasın

1. **Üç commit yerelde** — `8a5a9c5`, `ab819ef`, `79969b6` gönderilmedi.
   Serhat Bey kendi çalıştırır: `git push origin main`
2. **Giriş ekranı captcha + MFA** (en üstteki iş). Sıra önemli: önce
   `dashboard/app.js` girişine (≈80-83. satır) hCaptcha bileşeni +
   `options: { captchaToken }` ve TOTP alanı → *sonra* Supabase'de sunucu
   tarafı açılır → *sonra* iki yönlü ölçüm. Ters sırada kendini kilitlersin.
3. **S2 gerilim ölçümü** — multimetre alınınca; dokunma emniyeti kaydı açık.
4. **Köprü teli** — söküldü mü, saklandı mı? Geri dönüş yolu bu. **Hâlâ
   cevapsız.**
5. **Sensör sapması** — birkaç gün izle (aşağıdaki 02:45 bölümü).
6. Kural boşlukları: hafta sonu ısınma yok, sabah kuralı yok.
7. `rule_active` dönüşü (yukarıda).

---

## 15.10.2026 (02:45) — 🔥 FAZ 3 BİTTİ: KOMBİ BAĞLANDI VE ÇALIŞIYOR

Serhat Bey kartı kombiye bağladı. **Kabul ölçümlerinin beşi de geçti.**
Sistem artık gerçek: panelden verilen hedef kombiyi yakıyor ve söndürüyor.

| # | Ölçüm | Sonuç |
|---|---|---|
| D1 | Panelden hedef 25 → kombi yandı | ✅ röle 22:34'te çekti |
| D2 | Asgari bekleme (300 s) | ✅ `reason=min_hold`, 22:38:55'te bıraktı — ~300 s, tam zamanında |
| D3 | Hedef 20 → kombi söndü | ✅ `reason` → `above_band` |
| D4 | ESP32'nin fişi çekildi | ✅ röle bıraktı, kombi ısı talebi görmedi (Serhat Bey, kombi başında) |
| D5 | Fiş geri takıldı | ✅ `uptime_s=40`, `relay_on=False`, `rule_active=True` (23:00), `time_valid=True` |

D1–D3 **buluttan bağımsız olarak** ölçüldü (`device_state` + `telemetry`),
D4'ün aleti Serhat Bey'in kombi başındaki gözlemi — kart o sırada kapalı
olduğu için bulut tarafı zaten kördür.

**Yerleşim:** kart mutfakta, kombiden 1 m. Gerekçe ve bilinçli ödünç
`docs/FAZ3-KONTROL-LISTESI.md` §B3'te.

### ⚠️ Kapanmadan bırakılan: S2'nin gerilim ayağı

**Bağlantı multimetre ölçümü YAPILMADAN kuruldu.** Bunu açıkça yazıyorum ki
ileride "ölçtük" sanılmasın. Klemensin termostat girişi olduğu Serhat Bey'in
birinci elden bilgisiyle sabitti; **ne gerilim taşıdığı ölçülmedi.**

Sistemin çalışıyor olması bunu kapatmaz — röle kuru kontak, 24 V de 230 V da
anahtarlar. Açık kalan şey **dokunma emniyeti**:

> 🔴 **Kombi enerjiliyken rölenin vidalı klemensine ve ona giden iki damarlı
> kabloya dokunulmaz.** Multimetre alınınca ölçülüp bu kayıt kapatılmalı.

### 👀 İzlenecek: sensör mutfakta ne kadar sapıyor

Kombi ~5 dakika çalıştı, mutfak **22,5 → 23,5 °C** çıktı (telemetri, monoton
artış). Yani sensör ısı kaynağına yakın olduğu için hızlı doyuyor. Beklenen
etki, karar verilmişti — ama birkaç gün izlenmeli: panel 23 derken ev soğuk
geliyorsa sorun kombide değil **kartın durduğu yerdedir**, kart odaya taşınır.
Röle kuru kontak olduğu için taşıma 10 dakikalık iş.

### Kalan açıklar (sıralı)

1. **Giriş ekranı korumasız** — panel internette, tek koruma parola.
   Captcha + MFA yok. En üstteki iş.
2. **S2 gerilim ölçümü** — yukarıdaki dokunma emniyeti kaydı.
3. **10 kΩ pull-up** — önerilir, tıkayıcı değil (§B1).
4. **Köprü teli saklandı mı** — geri dönüş yolu; teyit bekleniyor.
5. **Hafta sonu ısınma** — `17:00 → 25` yalnız hafta içi.
6. **Sabah kuralı yok** — gece 23:00 → 20 var, sabah yükselten kural yok.
7. `events` üreticisiz · manuel kip yeniden başlatmada kayboluyor.

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
