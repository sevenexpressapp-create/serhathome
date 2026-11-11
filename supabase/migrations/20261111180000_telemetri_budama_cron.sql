-- O7 — TELEMETRI BUDAMA ZAMANLAMASI (Faz 2).
-- NE YAPAR: pg_cron'u kurar ve her gun 00:17 UTC'de `public.prune_telemetry(30)`
--   cagirir; 30 gunden eski telemetri satirlarini siler. `cron.timezone` = GMT
--   (olculdu: canli ve yerel yigin, ikisi de GMT), yani ifade UTC okunur:
--   00:17 UTC = 03:17 TRT (UTC+3).
--   Fonksiyon 20261014090000_kombi_init.sql'de ZATEN tanimli ve canlida mevcut —
--   burada yeniden tanimlanmiyor, YALNIZ zamanlama kuruluyor.
--
-- ⚠️ DIZGE DEGISTI, NIYET KORUNDU (denetim ORTA-2, 11.11.2026).
--   kombi_init.sql:144-146'daki yazili oneri `'17 3 * * *'` dizgesiydi ve
--   yorumun niyeti GECE 03:17'ydi. Ama `cron.timezone` GMT oldugu icin ayni
--   dizge canlida 06:17 TRT'ye kayiyordu — yani dizgeyi aynen korumak NIYETI
--   bozuyordu. Bu gocte dizge BILEREK DEGISTIRILDI:
--       '17 3 * * *'  ->  '17 0 * * *'
--   Depodaki eski dizge icin "aynen korundu" demek yanlis olurdu; korunan sey
--   dizge degil, "gece kossun" niyeti.
--   06:17 TRT neden istenmiyordu: senaryo kurallari hedefi 02:00 ve 06:00'da
--   (yerel) degistiriyor; 06:17 tam isinma penceresinin icine dusuyordu.
--   Teknik bir cakisma yine olmazdi (budama yalniz 30 gunden ESKI satirlari
--   siler; satir kilidi yalnizca silinen eski satirlarda olusur, cihazin ayni
--   anda yazdigi INSERT bloklanmaz, `device_settings` ve roleye hic dokunmaz)
--   — ama yazili niyet "gece"ydi ve niyet geri getirildi.
--
-- NEDEN 30 GUN (denetim ORTA-5 duzeltmesi): BAGLAYICI pencere panelin
--   **30 GUNLUK SAYIM** penceresidir — 24 saatlik grafik degil. Eski gerekce
--   ("panelin okudugu 24 saatlik pencere") yanlis pencereyi gosteriyordu.
--   Panel 30 gunluk yanma/kapsam sayimlarini SUNUCUDA yapiyor:
--     · dashboard/app.js:725  — `iso30` (now - 30 gun)
--     · dashboard/app.js:753-754 — bu degerle kosan `count: exact` sayimlari
--     · dashboard/app.js:759  — "kayit ne zaman basladi" sorgusu (gte iso30)
--   24 saatlik grafik penceresi bunun ALT KUMESI.
--   ⚠️ PANELIN SAYIM PENCERESI DEGISIRSE BU GOC DE DEGISMELI. Su an iki taraf
--   tam tumleyen: silme `ts < now() - 30 gun`, panel `ts >= now() - 30 gun`;
--   aralarinda PAY (guvenlik marji) YOK. Panel 60 gune cikarsa bu gocun de
--   60'a cikmasi gerekir, yoksa ekran sessizce eksik sayar.
--   Boyut: ~1.570 satir/gun x 30 gun ≈ 47 bin satir (~8 MB) — ucretsiz
--   katmanin 500 MB diskinde rahat.
--
-- NASIL GERI ALINIR (jobname yerine jobid'e bakan guvenli bicim; is zaten
--   yoksa hicbir satir donmez ve HATA da vermez — `cron.unschedule('ad')`
--   bulamadiginda exception atar):
--     select cron.unschedule(jobid) from cron.job where jobname = 'kombi-telemetri-buda';
--   (pg_cron'u tumden kaldirmak TUM isleri siler: drop extension pg_cron;)
--
-- IDEMPOTENT — AMA KOSULLU (denetim ORTA-1): `cron.schedule` var olan kaydi
--   `(jobname, username)` CIFTINE gore tazeler. Yani bu goc **ayni ROL ile**
--   kosuldugunda (burada `postgres`; `db push` ve Supabase SQL editoru bu
--   rolle kosar) YENI kayit acmaz, var olani jobid'i degistirmeden gunceller
--   (olculdu, pg_cron 1.6.4: ucuncu cagri da jobid=1 dondu, `cron.job`'da tek
--   satir kaldi) — bu yuzden ikinci kosum guvenli ve elle degistirilmis bir
--   zamanlamayi geri alir. BASKA bir rolle kosulursa ayni jobname'den IKINCI
--   bir is olusur ve budama gunde iki kez calisir.
--
-- ⚠️ ELLE `grant` YAZMAYIN. Supabase'in `issue_pg_cron_access` olay tetigi
--   (`grant_pg_cron_access`) `create extension pg_cron` sonrasinda yetkileri
--   KENDI kuruyor: `grant usage on schema cron to postgres with grant option`,
--   `grant select on cron.job to postgres with grant option` vb. Supabase
--   belgesindeki elle `grant` adimlari KENDI BARINDIRAN kurulum icindir; bu
--   projede yazilirsa `postgres` kendi grant option'iyla kendine yeniden yetki
--   verir (`postgres=r/postgres`) ve tetigin kendi `revoke`'u BOZULUR.
--   OLCULDU 11.11.2026 (yerel yigin): elle grant'lerle gocun 2. kosumu
--   `ERROR: dependent privileges exist / Use CASCADE` ile dustu (cikis kodu 3).
--   Grant'ler cikarilinca 2. kosum temiz gecti.

-- Supabase belgesinin (docs/guides/cron/install) yazdigi sema: uzanti
-- `pg_catalog`'a kurulur, kendi `cron` semasini ayrica acar.
create extension if not exists pg_cron with schema pg_catalog;

select cron.schedule(
  'kombi-telemetri-buda',
  '17 0 * * *',
  $cmd$select public.prune_telemetry(30)$cmd$
);
