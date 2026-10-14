# PROGRESS — Kombi uzaktan kontrol

Bu dosya projenin **süreklilik defteri**: bir sonraki iş kim tarafından yapılırsa
yapılsın bağlamı burada bulur. Yeni iş eklerken en üste yaz (tarih + değişiklik +
neden). Ayrıntılı ölçümler `docs/FAZ1-TEST-SONUCLARI.md`'de.

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
| `tests/panel_test.mjs` (gerçek CSP başlıklarıyla) | **17/17** | — |

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
