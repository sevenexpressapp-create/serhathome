# TASARIM — Sıcaklık grafiği + "Kombi ne kadar yandı" kartı

Tarih: 10.11.2026 · Hazırlayan: tasarımcı · Uygulayacak: developer
Yüzey: `dashboard/index.html` + `dashboard/app.js` (tek sayfa panel, çoğunlukla telefondan açılıyor)

Bu belge **spec**'tir: her madde için karar, gerekçe ve ölçü verir. Kodu developer kurar;
buradaki JS parçaları yalnız mockup'ta ölçülmüş davranışın tarifidir, kopyalanacak kaynak değil.

---

## 0. Kapsam

**İçinde:** (1) var olan sıcaklık grafiğinin beş ölçülmüş kusurunun düzeltilmesi,
(2) kombinin yanma süresini gösteren YENİ kart.

**Kapsam dışı — tasarıma alan da AÇILMADI:** gaz tüketimi, ₺ tahmini, maliyet, verim.
Serhat Bey 09.11 akşamı "tüketimi boşver" dedi; kartta ne alan, ne yer tutucu, ne de
"ileride eklenir" notu var. Yeni kütüphane / font / CDN yok (CSP `script-src 'self'`).
Yeni renk uydurulmadı: tüm çizim var olan `--series-1 / --series-2 / --muted / --grid /
--axis / --text-2 / --surface` değişkenleriyle yapılıyor. Veritabanı değişikliği yok.

### Ölçümün dayanağı
Canlı ölçüm (Supabase, 10.11.2026, Patron'un brief'i): 24 saatte 1.439 nokta, tam 60 sn
aralık, boşluk yok; 20,7–22,7 °C; sensör 0,1 °C adımlı, ardışık fark ort. 0,008 / p99 0,1 /
maks 0,2; hedef gün içinde 02:00→22,0 ve 06:00→21,0 olarak değişiyor; ayar hedef 22,0,
salınım bandı 2,0 (yakma 21,0 / söndürme 23,0); yanma 24 günde 1 sa 51 dk, 4 günde.

Mockup verisi bu istatistiklere göre üretildi ve üretim **ölçülerek** doğrulandı:
1.439 nokta / 60 sn, 20,7–22,7 °C, ort. fark 0,0088, p99 0,1, maks 0,2, 24 saatte 85 dk yanma.
Fiziksel tutarlılık da sağlandı: her yanma, çizilen bandın ALT kenarına değdiği dakikada
başlıyor; ilki hedef 06:00'da düşünce (üst kenar 23,0 → 22,0) sönüyor.

---

## 1. İŞ 1 — Grafik

Şu anki çizim: `dashboard/app.js:455-570`, tek seri + ısıtma şeridi + tek düz kesikli hedef.

### 1.1 Y ekseni: etiket çizgiyle aynı değeri göstermeli

**Bulgu (ölçülü).** `app.js:484-485` alanı `min-1 .. max+1` kuruyor, `app.js:491` dört eşit
adıma bölüyor, `app.js:497` etiketi `toFixed(0)` ile basıyor. Canlı veriyle ızgara
19,7 / 20,7 / 21,7 / 22,7 / 23,7'de duruyor ama ekranda 20 / 21 / 22 / 23 / 24 yazıyor:
**etiket çizgiden 0,3 °C kayık.** Panelin tamamı 0,1 °C'lik farkları konuşurken eksen yalan
söylüyor.

**Karar.**
1. Alanın alt/üst sınırı **0,5 °C'ye dışa yuvarlanır**: `lo = aşağı0,5(min − 0,3)`,
   `hi = yukarı0,5(maks + 0,3)`.
2. Alan **yürürlükteki hedefin yakma ve söndürme eşiklerini içermek ZORUNDA** (yoksa
   "neden yanmıyor" sorusunun cevabı ekranın dışında kalır). Geçmişteki farklı hedeflerin
   bandı alanı genişletmez; o bantlar çizim alanına **kırpılır**.
3. Alan 2,0 °C'den dar olamaz (düz bir gün gürültüyü dağ gibi göstermesin).
4. Izgara adımı {0,5 · 1,0 · 2,0} içinden, **etiketler arası ≥ 40 px** kalan en küçüğü.
5. Etiket **tek ondalık ve virgüllü**: `20,0` — panelin geri kalanıyla (`vir()` yardımcısı,
   `app.js:264`) aynı biçim.
6. Donma eşiği (6,0 °C) eksene DAHİL EDİLMEZ; çizilmez de — alanı 15 °C açar.

**Ölçü (mockup, canlı şekilli veri):** alan `[20,0 – 23,5]`, adım 1,0 → etiketler
`20,0 / 21,0 / 22,0 / 23,0`, aralık 49,7 px. `20,0` etiketi 11 px'te 23 px geniş →
sol kenar boşluğu **34 px'ten 38 px'e** çıkar (etiket + 6 px boşluk + 4 px pay).
Seed verisiyle (hedef 25,0, bant 3,0) aynı kural alanı `[19,0 – 27,0]`, adımı 2,0 yapıyor —
kural geniş alanda da bozulmuyor.

### 1.2 Yoğunluk: 1 piksele 4–6 nokta düşüyor

**Bulgu.** Çizim alanı 390 px'lik telefonda 246–278 px; 1.439 nokta → **piksel başına
3,7 (500 px) ila 5,9 (360 px) nokta.** Hepsi `L` komutu olarak basılıyor; sonuç testere dişi
ve gereksiz büyük bir `path`.

**Karar: 1 CSS piksellik sütunlarda özetle — ortalama çizgi + en düşük/en yüksek zarfı.**
Seyreltme (her N'inci noktayı al) **seçilmedi**: sensör 0,1 °C adımlı ve ölçülen uç
sıçramalar (maks 0,2) tek noktada oluyor; seyreltme pencereyi açtığınız dakikadaki dip veya
tepeyi sessizce siler — yani veriyi yalan söyler. Sütun özeti hiçbir okumayı atmaz:
zarf, o sütunda sensörün gördüğü en düşük ve en yüksek değeri kapsar.

**Ölçü.** Sütun genişliği 1 px seçildi (2 px, zarf-çizgi ilişkisini bozmadan yarı yarıya
ucuzlatırdı ama `panel_test.mjs` D3'ün `>200 L` eşiğinin altına düşme riski doğuyor —
bkz. §5). Zarf kalınlığı: 49,7 px/°C ölçeğinde sütun içi aralık ortalama 0,021 °C (≈1 px),
p95 0,10 °C (**4,9 px**), maks 0,2 °C (9,8 px). Yani zarf normalde çizginin etrafında ince
bir hâle; sensör zıpladığında görünür kalınlaşıyor. Dolgu `--series-1`, `fill-opacity 0.22`;
ortalama çizgi `--series-1`, 2 px (bugünküyle aynı).

### 1.3 X ekseni: yuvarlak saat ızgarası

**Bulgu.** `app.js:501` yalnız **üç** etiket basıyor (baş / orta / son) ve bunlar yuvarlak
saat değil — pencere kaydıkça `02:37` gibi değerler çıkıyor; iki grafik birbiriyle
karşılaştırılamıyor.

**Karar.** Etiketler **yuvarlak saatlere** oturur. Adım {1 · 2 · 3 · 4 · 6 · 12} saat
içinden, etiketler arası **≥ 45 px** kalan en küçüğü (ölçü: `02:00` 11 px'te 31 px geniş,
+14 px nefes). Her etiketin üstüne `--grid` rengiyle 1 px dikey ızgara çizilir. Kenara
10 px'ten yakın etiket **yazılmaz** (ızgara çizgisi kalır). **Gece yarısı tikinin** altına
10 px `--muted` ile gün yazılır (`10 Kas`) — 24 saatlik pencere iki günü kapsıyor,
"00:00" tek başına hangi gün olduğunu söylemiyor.

**Ölçü.** 360 px telefon → 6 saat adım, 4 etiket · 500 px → 3 saat, 7 etiket ·
masaüstü (720 kapaklı) → 2 saat, 12 etiket. Üçünde de yatay kaydırma yok (ölçüldü).

### 1.4 Hedef: tek düz çizgi değil, BASAMAKLI

**Bulgu.** `app.js:505` hedefi `device_settings.target_c`'den alıp tüm pencereye tek düz
kesikli çizgi olarak basıyor. Oysa hedef gün içinde değişiyor (02:00→22, 06:00→21) ve
telemetri satırlarının her biri o anın hedefini `target_c` olarak **zaten taşıyor**
(şema: `supabase/migrations/20261014090000_kombi_init.sql:135`).

**Kusurun ikinci yarısı — veri yolu:** `app.js:153` telemetriden yalnız
`ts, temp_c, humidity, relay_on` seçiyor; **`target_c` hiç çekilmiyor.** Basamaklı hedef
için önce bu alanın seçime eklenmesi gerekiyor (ek sorgu değil, aynı sorguya bir sütun).

**Karar.** Satırlar `target_c` değerine göre ardışık **parçalara** ayrılır. Her parça için:
yatay **kesikli** çizgi (`--muted`, 1,5 px, `5 4`), parçalar arasında **düz** (kesiksiz)
dikey bağlantı (`--muted`, 1 px, opaklık 0,55). Dikey bağlantının kesiksiz olması
bilinçli — `panel_test.mjs` D3 kesikli çizgileri sayıyor (§5).
`target_c` boş gelen aralıkta hedef çizilmez (**uydurulmaz**); satırların TAMAMI boşsa
(eski kayıt) yürürlükteki ayarın hedefi tek düzlük olarak çizilir ve göstergede
"Hedef 22,0 °C **(şu anki ayar)**" yazar. Hâl 7 mockup'ta çizili.

### 1.5 Karar aralığı (salınım bandı) görünür olmalı

**Bulgu.** Panelde hiçbir yerde yakma/söndürme eşiği görünmüyor. Kullanıcı "hedef 22,
oda 21,5, kombi neden yanmıyor?" sorusunu soruyor ve cevabı yalnız "İleri ayarlar"daki
`Salınım bandı 2,0` sayısından türetebiliyor.

> Not — brief'teki örneği düzeltiyorum: bant 2,0 iken **20,9'da kombi YANAR**
> (firmware `kombi_core.cpp:398-405`: `on_at = hedef − bant/2`, `off_at = hedef + bant/2`,
> karşılaştırma `<=` / `>=`). Hedef 22,0 iken yanmama aralığı **21,1 – 22,9**'dur.
> Tasarım bu aralığı gösteriyor; metin de bu sayılarla konuşuyor.

**Karar.** Her hedef parçası için `on_at`–`off_at` arasına soluk şerit:
`--muted`, `fill-opacity 0.11`, üst ve alt kenarında 1 px `--muted` %40 opak çizgi
(kenarlar olmadan şerit "gri bir alan", kenarlarla "eşik" okunuyor). Şerit hedefle birlikte
**basamaklanır**; çizim alanının dışına taşan kısmı kırpılır. Şerit ızgaranın üstüne,
sıcaklık çizgisinin altına çizilir.

Sayılar grafiğin İÇİNE etiket olarak yazılmaz (telefonda üç sağ-kenar etiketi çakışıyor);
göstergeye ve bir cümleye taşınır:

- Gösterge: `Oda sıcaklığı` · `Kombi yandı` · `Hedef 22,0 °C` · `Karar aralığı 21,0–23,0 °C`
- Altındaki cümle (12 px, `--text-2`):
  **"Oda 21,0 °C'ye düşünce kombi yanar, 23,0 °C'ye çıkınca söner; arada kalınca son
  durumunu korur. Hedef gün içinde değişince bu aralık da kayar."**
  (İkinci cümle yalnız pencerede birden çok hedef varsa görünür.)

Bu cümle histerezisin **kilitlemeli** davranışını da anlatıyor: aralıkta karar
değişmiyor, kombi önceki hâlini sürdürüyor. Asgari bekleme (`min_relay_hold_s`) şeridi
birkaç dakika geciktirebilir; bu, cümlede "tam olarak o saniyede" iddiası kurulmadığı için
yanlış beklenti yaratmıyor.

### 1.6 Değişen küçük işler

- **İpucu (tooltip):** hedefi de söyler → `02:17 · 21,0 °C · hedef 22,0 · kombi yandı`.
- **Tablo** (grafiğin metin karşılığı, `app.js:441`): **Hedef** sütunu eklenir — grafikte
  yeni bir seri varsa metin karşılığında da olmalı. Isıtma hücresi `açık/kapalı` yerine
  `yandı / —`, kartla aynı dili konuşur.
- **SVG `<title>`:** "Oda sıcaklığı, hedef ve kombinin karar aralığı — son 24 saat".
- Grafik yüksekliği **240 px'te kalır** (D3 `> 200` ölçüyor); çizim alanı 170 px,
  şerit 10 px, aradaki boşluk 6 px, alt kenar boşluğu 42 px (iki satırlık gün etiketi için
  38'den çıktı).

---

## 2. İŞ 2 — "Kombi ne kadar yandı" kartı

### 2.1 Yeri ve yapısı

Panelde **"Anlık durum" kartının hemen ALTINA**, "Hedef sıcaklık" kartının üstüne girer.
Gerekçe: ilk satırı canlı bir durum cevabı ("şu an yanıyor mu, ne kadardır?"); telefonda
paneli açan kişi bunu kaydırmadan görmeli. Grafik kartı yerinde kalır. "Anlık durum"daki
`Isıtma açık` rozeti **değişmez** (iki yerde aynı bilgiyi iki ayrı mantıkla hesaplamayız;
kart rozeti tekrar etmez, süreyi ekler).

```
┌ Kombi ne kadar yandı ─────────────────────────┐
│ ● Kombi şu an yanıyor            13 px pill   │
│ 36 dk boyunca yanıyor            28/15 px     │
│ Son yanma 9 Kas 05:11–06:00 · 49 dk   13 px   │
│ ─────────────  ─────────────                  │
│ Bugün          24 saat            12/17 px    │
│ 36 dk          1 sa 25 dk                     │
│ ─────────────  ─────────────                  │
│ 7 gün          30 gün                         │
│ 1 sa 25 dk     1 sa 51 dk                     │
│ Süreler dakikaya yuvarlanır; …     12 px      │
└───────────────────────────────────────────────┘
```

Ölçüler (hepsi var olan token/sınıflarla):
- Kart: `.card` (16 px iç boşluk, 12 px köşe, 1 px `--border`) — diğer kartlarla aynı.
- Başlık: `h2` 14 px/600 `--text-2` (değişmiyor).
- Rozet: `.pill` + `.dot`; nokta rengi yanıyorsa `--series-2`, kapalıysa `--muted`.
- Büyük sayı: **28 px / 600 / `tabular-nums`**, ≤420 px'te 26 px. Ön ek ("Bugün") ve
  kuyruk ("boyunca yanıyor" / "yandı") 15 px `--text-2`. Boş ön ek/sayı `display:none`
  (yoksa 8 px'lik hayalet girinti kalıyor — mockup'ta görüldü, düzeltildi).
- Alt satır: 13 px `--text-2`.
- Kutucuklar: `.tile` (üstten 1 px `--grid` çizgi), başlık 12 px `--muted`, değer
  17 px/600 **`tabular-nums`**. Izgara: **telefonda 2 sütun, ≥ 560 px'te 4 sütun.**
  Var olan `.tiles` (auto-fit minmax 130 px) KULLANILMAZ: 500 px'te 3+1 kırılıyor ve
  kart bozuk görünüyor (mockup'ta ölçüldü).
- Not: 12 px `--muted`, kartın en altında.
- **Kart hiç etkileşim içermiyor** → yeni dokunma hedefi, odak halkası sorunu yok.
  `aria-live` KOYULMAZ: değer 15 sn'de bir yenileniyor, ekran okuyucuya sürekli
  "36 dk, 37 dk" okutmanın bedeli faydasından büyük.

### 2.2 Dil (panelde yazan her şey kullanıcıya yazılır)

| Durum | Metin |
|---|---|
| Yanıyor | `● Kombi şu an yanıyor` · **36 dk** `boyunca yanıyor` |
| Kapalı | `● Kombi şu an kapalı` · `Bugün` **0 dk** `yandı` |
| Cihaz sustu | `● Cihaz veri göndermiyor` · `Son 23 dk veri gelmedi; kombi yanıyor mu bilinmiyor.` (büyük sayı YOK) |
| Son yanma (24 saat içinde) | `Son yanma bugün 05:11–06:00 · 49 dk` |
| Son yanma (daha eski) | `Son yanma 2 Kas 02:53 dolayında` — süre **uydurulmaz** (§2.3) |
| Hiç yanma yok | `Kayıtlarda (30 gün) hiç yanma yok.` |
| Hassasiyet | `Süreler dakikaya yuvarlanır; her yanma için 1 dakikaya kadar sapabilir. Kayıtlar 30 gün tutulur.` |

"örnekleme 60 sn", "histerezis", "telemetri", "head count" gibi hiçbir sözcük ekrana
yazılmaz. 30 günlük sınır bir denetim notu değil, gerçek bir kullanıcı bilgisi:
`prune_telemetry` 30 günden eskisini siliyor
(`supabase/migrations/20261014090000_kombi_init.sql:147-159`), yani "30 gün" penceresi
aynı zamanda **kaydın tamamı**.

### 2.3 Veri yolu — ucuz ve dürüst

Yanma süresi = `relay_on = true` olan telemetri **satır sayısı** × 1 dakika (aralık tam
60 sn ölçüldü). `relay_on` boş olan satır (sensör arızası) sayılmaz — `eq("relay_on", true)`
`null`'ı zaten dışarıda bırakır.

| Değer | Kaynak | Maliyet |
|---|---|---|
| Şu an kaç dakikadır yanıyor | `lastRows` (24 saatlik pencere zaten çekiliyor) | **0 ek istek** |
| Bugün (yerel gece yarısından beri) | `lastRows` — 24 saatlik pencere bugünü her zaman kapsar | **0 ek istek** |
| 24 saat | `lastRows` | **0 ek istek** |
| 7 gün / 30 gün yanma | `select('*', { count: 'exact', head: true })` + `eq(relay_on,true)` + `gte(ts,…)` | 2 istek |
| 7 gün / 30 gün **kapsam** (toplam satır) | aynı sorgu, `relay_on` süzgeci olmadan | 2 istek |
| Son yanma (24 saatten eski) | `select('ts')… eq(relay_on,true).order(ts desc).limit(1)` | 1 istek (1 satır) |

Toplam **5 küçük istek**, ve bunlar **15 sn'lik yoklamaya BAĞLANMAZ**: açılışta bir kez,
sonra en çok 5 dakikada bir tazelenir. (Yoklamaya bağlansaydı dakikada 20 istek olurdu;
7/30 günlük toplam o hızda değişmiyor.) Canlı süre ve bugün/24 saat her yoklamada
`lastRows`'tan yeniden hesaplanır, ek maliyet yok.

**Kapsam kontrolü (sessiz yanlışın panzehiri).** Cihaz çevrimdışıyken yazılmayan dakikalar
toplamı **eksik** gösterir. Pencerenin gerçek satır sayısı beklenenin %95'inin altındaysa
kartta bir cümle belirir: *"Son 30 günün 4 saati kayıtsız; 30 günlük toplam eksik olabilir."*
Ölçülen normal çalışmada kapsam 1.439/1.440 = %99,9 → cümle görünmez.

**Canlı süre nasıl bulunur:** `lastRows`'un sonundan geriye doğru `relay_on` true olduğu
sürece yürünür; iki satır arası 2 dakikadan uzunsa yürüyüş durur (kayıt boşluğu, yanma
devamı sayılmaz). `device_state.last_seen_at` 10 dakikadan eskiyse "yanıyor" **iddia
edilmez** — "cihaz sustu" hâline düşülür (panelde zaten `online` ölçütü var,
`app.js:207`).

### 2.4 "0 dk" ve "veri yok" — aynı şey DEĞİL

Bu kartın en kritik kuralı:

- **0 dk = ölçüm.** Tam güçte `--text` ile yazılır, soluklaştırılmaz, tire yapılmaz.
  "Bugün 0 dk yandı" bir arızanın değil, ılık bir günün cümlesidir. (Ölçülen gerçek:
  02–08.11 arası yedi gün boyunca 0.)
- **— = bilinmiyor.** `--muted` renginde tire; yalnız veri okunamadığında veya kapsam
  bilinmediğinde çıkar.
- **Hiç veri yok** (cihaz hiç bağlanmadı): kart **tek cümleye iner**, kutucuklar gizlenir —
  "0 dk" yazmak yalan olurdu: *"Kombinin yanma süresi için henüz veri yok. Cihaz
  bağlandığında burada birikir."*
- **Okunamadı** (ağ/RLS hatası): `--critical` ile ayrı satır — *"Yanma süresi okunamadı —
  gösterilen bilgi güncel OLMAYABİLİR."* Boş durumla karıştırılmaz (panelin Y6 dersi).

Yedi hâlin hepsi `docs/mockup/mockup-haller-500.png`'de çizili.

---

## 3. Duyarlı davranış (ölçüldü)

| Genişlik | SVG | Çizim alanı | X adımı | Etiket | Kutucuk | Gösterge |
|---|---|---|---|---|---|---|
| 360 px | 294 px | 246 × 170 | 6 saat | 4 | 2 sütun | 2 satır |
| 500 px | 434 px | 386 × 170 | 3 saat | 7 | 2 sütun | 2 satır |
| 768 / 1440 px | 654 px (`wrap` 720'de kapanıyor) | 606 × 170 | 2 saat | 12 | 4 sütun | 1 satır |

1440'ta 768'den farklı bir şey olmuyor: panel bilinçli olarak tek sütun ve 720 px'te
kapalı. Üç genişlikte de yatay kaydırma yok (ölçüldü). Y ekseni alanı ve adımı üç
genişlikte de aynı (yükseklik sabit 240 px).

---

## 4. Erişilebilirlik ve kontrast — bir BULGU var

Ölçüm (WCAG 2.1 kontrast oranı, `--surface` üzerinde):

| Renk | Light | Dark | Kullanım | Sonuç |
|---|---|---|---|---|
| `--text-2` #52514e / #c3c2b7 | **7,73:1** | **9,72:1** | eksen etiketleri, açıklama | AA ✓ |
| `--muted` #898781 | **3,50:1** | 4,85:1 | 11–13 px metin (eksen, `.note`, `.tile .k`, `label`) | **light AA KALDI** (4,5 gerek) |
| `--series-1` #2a78d6 / #3987e5 | 4,30:1 | 4,79:1 | sıcaklık çizgisi | grafik objesi için 3:1 ✓ |
| `--series-2` #eb6834 / #d95926 | 3,12:1 | 4,48:1 | yanma şeridi | grafik objesi için 3:1 ✓ |
| `--muted` %11 şerit | 1,13:1 | 1,16:1 | karar aralığı dolgusu | bilinçli: anlam **metinde** de var |

**Bulgu:** `--muted` light modda 3,50:1 — eksen etiketlerinin bugünkü rengi bu ve
**AA'yı geçmiyor.** Bu, benim dokunduğum yüzeyin dışına da taşıyor (`.note`, `.tile .k`,
`label`, `.empty` hepsi `--muted`).

**Kararım, iki parçalı:**
1. **Bu spec'in kapsamında zorunlu:** grafiğin eksen etiketleri ve açıklama metni
   `--muted` yerine **`--text-2`** kullanır (7,73:1 / 9,72:1). Mockup böyle çizildi.
2. **Önerim (Patron/Serhat Bey kararı):** light modda `--muted` token'ı
   **#898781 → #726f6a** olsun (4,87:1 `--surface`, 4,75:1 `--plane`). Tek satırlık
   token değişikliği panelin TÜM küçük gri metnini AA'ya taşır; karanlık mod değişmez
   (zaten 4,85:1). Bedeli: tüm ikincil metin bir tık koyulaşır — panelin genel tonunu
   etkiler, o yüzden kararı bana bırakmıyorum. Mockup bu değerle çizildi; nasıl
   göründüğü ekran görüntülerinde.

Diğerleri: `<title>` güncellendi; grafiğin metin karşılığı olan tablo yeni seriyi
(hedef) de içeriyor; karttaki hiçbir öğe etkileşimli değil; odak halkası ve 44 px hedef
boyutu bu iki iş kapsamında yeni bir yüzey açmıyor.

> Kapsam dışı ama not düşüyorum: `index.html`'de hiçbir yerde `:focus-visible` kuralı yok;
> odak görünürlüğü tamamen tarayıcı varsayılanına bırakılmış. Bu ayrı bir iştir, bu
> spec'e dahil DEĞİL.

---

## 5. `tests/panel_test.mjs` üzerindeki etki — ölçüldü

D3 testi (satır 160-180) dört şey ölçüyor: ilk `<path>`'teki `L` sayısı > 200,
`rect` sayısı ≥ 2, `line[stroke-dasharray]` sayısı **tam 1**, boş uyarı görünmüyor,
yükseklik > 200.

**Ölçüm — yeni çizim, `tests/seed_demo.mjs` verisiyle** (289 nokta / 5 dk, `target_c`
sabit 25,0):

| Ölçüt | Değer | D3 |
|---|---|---|
| ilk `<path>` `L` sayısı | 551 (zarf) | ✓ > 200 |
| `path[data-role=temp]` `L` | 275 | — |
| `rect` sayısı | 5 (3 şerit + 2 yanma) | ✓ ≥ 2 |
| `line[stroke-dasharray]` | **1** | ✓ = 1 |
| boş uyarı | gizli | ✓ |
| yükseklik | 240 | ✓ > 200 |

> Ne ölçüldü, ne ölçülmedi: `tests/panel_test.mjs` **koşturulmadı** (yerel Supabase yığını
> gerekiyor). Ölçülen şey, `seed_demo.mjs`'in satır satır aynısıyla üretilen veriyle yeni
> çizimin D3'ün **dört seçicisine** verdiği değerler. Takdir developer'ın: uygulamadan
> sonra testi gerçekten koşsun.

**Yani 21 test, dosyaya dokunulmadan geçmeli.** Ama bunu "yeşil" diye bırakmıyorum:
D3'ün `=== 1` koşulu seed verisinde hedefin HİÇ değişmemesi sayesinde tutuyor. Canlı
şekilli veriyle aynı sayı **3** (üç hedef parçası) — yani test artık tasarımı değil,
seed verisinin bir tesadüfünü ölçüyor.

**Developer'dan istediğim (aynı commit'te):** D3'ün seçicileri yeni çizimi ölçecek şekilde
sıkılaştırılsın; öğelere zaten `data-role` verdim:
`path[data-role=temp]` (L > 200), `rect[data-role=burn]` (≥ 1),
`line[data-role=target][stroke-dasharray]` (≥ 1 ve hedef parça sayısı kadar),
`rect[data-role=band]` (≥ 1). Sütun genişliği 1 px'ten büyütülürse `L > 200` eşiği
360 px'lik telefonda düşer (246 sütun) — bu yüzden sütun 1 px.

---

## 6. Mockup dosyaları

Hepsi `docs/mockup/` altında; **yayına gitmez**, `dashboard/` dışında durur. Satır içi
`<script>` yok — panelin CSP'si (`script-src 'self'`) ile aynı kurala uyacak şekilde
yazıldı, yani tasarımın uygulanabilir olduğu gösterilmiş oluyor.

| Dosya | Ne |
|---|---|
| `/Users/serhatpolat/Desktop/Projeler/kombi-kontrol/docs/mockup/mockup.html` | Grafik + kart, normal hâl |
| `/Users/serhatpolat/Desktop/Projeler/kombi-kontrol/docs/mockup/haller.html` | Kartın 6 hâli + grafiğin 2 hâli |
| `/Users/serhatpolat/Desktop/Projeler/kombi-kontrol/docs/mockup/mockup.js` | Çizim (ölçülerin kaynağı) |
| `/Users/serhatpolat/Desktop/Projeler/kombi-kontrol/docs/mockup/haller.js` | Hâllerin verisi |
| `/Users/serhatpolat/Desktop/Projeler/kombi-kontrol/docs/mockup/ortak.css` | Panelin stil kopyası + önerilen 2 değişiklik |
| `/Users/serhatpolat/Desktop/Projeler/kombi-kontrol/docs/mockup/veri.js` | **Sentetik** veri (canlı istatistiklere göre üretildi) |
| `/Users/serhatpolat/Desktop/Projeler/kombi-kontrol/docs/mockup/mockup-telefon-500.png` | 500 px (başsız Chrome'un telefon tabanı) |
| `/Users/serhatpolat/Desktop/Projeler/kombi-kontrol/docs/mockup/mockup-telefon-360.png` | 360 px — en dar hâl |
| `/Users/serhatpolat/Desktop/Projeler/kombi-kontrol/docs/mockup/mockup-telefon-500-karanlik.png` | 500 px, karanlık mod |
| `/Users/serhatpolat/Desktop/Projeler/kombi-kontrol/docs/mockup/mockup-masaustu-1000.png` | 1000 px pencere (içerik 720'de kapanıyor) |
| `/Users/serhatpolat/Desktop/Projeler/kombi-kontrol/docs/mockup/mockup-haller-500.png` | 8 hâl, tek tahta |

Tarayıcı başsız koşturuldu (kendi portu + kendi geçici profili), görünür pencere
açılmadı, konsol temiz.

---

## 7. Kabul kriterleri (developer bitirince bunlar ölçülecek)

**Grafik**
1. Y ekseninde yazan her sayı, çizgisinin **tam** değeri; biçim tek ondalık + virgül
   (`20,0`). `toFixed(0)` kalmadı (`grep -n "toFixed(0)" dashboard/app.js` grafik
   bölümünde hiçbir şey dönmüyor).
2. Y alanı 0,5'in katlarında başlayıp bitiyor ve **yürürlükteki hedefin yakma/söndürme
   eşiklerinin ikisini de içeriyor**.
3. Sıcaklık yolunda düğüm sayısı ≈ çizim alanı genişliği (piksel başına 1); 1.439 ham
   nokta doğrudan basılmıyor.
4. Zarf (en düşük/en yüksek) çiziliyor ve hiçbir okuma dışarıda kalmıyor: bir sütunun
   zarfı o sütundaki en küçük ve en büyük okumayı kapsıyor.
5. X etiketleri yuvarlak saat; 360 px'te en az 4, masaüstünde en az 10 etiket var ve
   hiçbiri çizim alanının dışına taşmıyor. Gece yarısı tikinin altında gün yazıyor.
6. `app.js` telemetri sorgusu `target_c` alanını da çekiyor (`app.js:153`).
7. Hedef çizgisi, verideki her `target_c` değişiminde basamaklanıyor; `target_c` boş olan
   aralıkta çizilmiyor; hepsi boşsa göstergede "(şu anki ayar)" yazıyor.
8. Karar aralığı şeridi hedefle birlikte basamaklanıyor; gösterge ve açıklama cümlesi
   yürürlükteki yakma/söndürme sayılarını gösteriyor.
9. İpucunda hedef de var; tablo "Hedef" sütunu içeriyor.
10. Çizimde ham `#hex` YOK; yalnız `var(--…)`. Ölçüm: `grep -nE "#[0-9a-fA-F]{3,6}" dashboard/app.js`
    bugün **tek** satır dönüyor (`app.js:375`, gün düğmesindeki `#fff`); grafik ve kart
    bu sayıyı ARTIRMAMALI.

**Kart**
11. Kart "Anlık durum"un hemen altında; yanarken canlı süre, kapalıyken bugünün toplamı
    ve son yanma görünüyor.
12. Dört kutucuk: Bugün / 24 saat / 7 gün / 30 gün. Telefonda 2×2, ≥ 560 px'te 4 sütun;
    hiçbir genişlikte 3+1 kırılması yok.
13. **0 dk** tam güçte metinle yazılıyor (soluk değil, tire değil). Veri yokken kutucuklar
    gizli ve tek cümle var. Okuma hatası ayrı ve `--critical`.
14. Cihaz 10 dakikadır susuyorsa kart "yanıyor" demiyor.
15. 7/30 günlük sayımlar 15 sn'lik yoklamaya bağlanmamış; ağ panelinde her yoklamada
    yalnız var olan 4 istek görünüyor, sayımlar en çok 5 dakikada bir.
16. Kartta gaz / tüketim / ₺ ile ilgili **hiçbir** alan, etiket veya yer tutucu yok
    (`grep -niE "gaz|tüketim|m³|₺|TL|maliyet" dashboard/` boş döner).

**Genel**
17. `node tests/panel_test.mjs` 21/21 geçiyor; D3'ün seçicileri `data-role`'lere
    sıkılaştırılmış (§5) ve değişiklik commit mesajında yazılı.
18. 360 / 500 / 1000 px'te yatay kaydırma yok; konsolda yeni hata/uyarı yok.
19. Aydınlık ve karanlık modun ikisinde de ekran görüntüsü alınmış ve **bakılmış**
    (oran geçmesi yetmez).

---

## 8. Karar bekleyen tek kalem

`--muted` token'ının light modda #898781 → **#726f6a** yapılması (§4). Bu panelin tüm
küçük gri metnini AA'ya taşır ama genel tonu bir tık koyultur. **Önerim: yapılsın.**
Yapılmazsa grafiğin kendisi yine AA'da kalır (eksen `--text-2`'ye taşındı), ama
`.note` / `.tile .k` / `label` 3,50:1'de kalmaya devam eder — yeni kartın kutucuk
başlıkları ve not satırı da dahil.
