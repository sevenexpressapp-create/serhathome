# Faz 3 — Kombi bağlantısı: kontrol listesi

Telefondan takip etmek için yazıldı. **Sıra önemli**; bir adım kırmızıysa
sonrakine geçilmez.

> ⚠️ Demirdöküm kılavuzu (0020331204_01, §9.5) elektrik kurulumunun yetkili
> servisçe yapılmasını söylüyor. Kombi **garanti dışı** (14.10 teyidi), yani
> servis zorunluluğu yok; bu cümle planda emniyet uyarısı olarak duruyor.
> Termostat devresi **24 V DC / 1 A** — elektriksel tehlike düşük, ama klemens
> kutusunun diğer ucunda **230 V** var. Kapak açıkken kombinin fişi çekili olacak.

---

## A. Yazılım tarafı — ✅ BİTTİ (15.10.2026, 00:58)

| Ölçüm | Sonuç |
|---|---|
| Üretim yazılımı karta yüklendi (`esp32dev_prod`) | ✅ `Hash of data verified` |
| `info` satırında `SIM=0` | ✅ |
| `sim temp 35` cihazda reddediliyor | ✅ `bilinmeyen komut` |
| Aynı komut sıcaklığı değiştirmedi (22.1 → 22.1) | ✅ |
| İkilide benzetim dizgeleri yok (pozitif kontrol: dev ikilisinde **var**) | ✅ 0 / 2 |
| Kurallar NVS'ten geri geldi | ✅ `rules=2` |
| WiFi + bulut geri geldi | ✅ `wifi=192.168.1.105 cloud=ok` |
| Açılışta röle boşta | ✅ `acilis_pad=HIGH heat=0` |

Kartın USB'si eline geçen biri artık röleyi benzetim komutuyla süremez.

---

## B. Bağlantıdan önce — İKİ TIKAYICI

### B1. 🔴 Harici 10 kΩ pull-up direnci

**Bu takılmadan kombiye bağlantı YAPILMAZ.** (Kod denetimi O1 / `docs/DONANIM.md`.)

- **Nereye:** ESP32'nin **GPIO 23** bacağı ile **3V3** bacağı arasına, 10 kΩ.
- **Neden:** Karta elektrik geldiği an ile bizim kodumuzun çalışmaya başladığı
  an arasında **~200 ms**'lik bir boşluk var. O boşlukta GPIO 23'ü yukarıda
  tutan tek şey röle modülünün kendi giriş katmanı. Ölçtük, hat o pencerede
  HIGH okuyor — ama bu **dolaylı** kanıt; garanti eden bir direnç yok.
  Kombi bağlıyken o pencerede röle çekerse kombi istemsiz yanar ve bu her
  elektrik kesintisi sonrasında tekrarlanır.
- **Dürüst sınır:** Faz 1'deki `acilis_pad=HIGH` ölçümü yalnız **kodumuz
  çalıştıktan sonrasını** görür. İlk milisaniyeleri ölçen bir aletimiz yok.
  Direnci takmamızın sebebi tam olarak bu: ölçemediğimiz pencereyi
  ölçüme değil **fiziğe** bağlamak.

**Kabul ölçümü (direnç takıldıktan sonra):**
1. Kart **enerjisiz** iken multimetre direnç kademesinde GPIO 23 – 3V3 arası
   **~10 kΩ** okumalı.
2. Röle çekiliyken reset'e basıldığında seri porta yine
   `ACILIS: role pini GPIO 23, kod oncesi seviye=HIGH` satırı düşmeli.

### B2. 🟡 S2 — klemens BULUNDU, gerilim hâlâ ölçülmedi

**15.10.2026 01:40 — fotoğrafla ve Serhat Bey'in beyanıyla kapanan kısım:**

- Kombinin kontrol kutusunun kenarında **mavi, 2×2 dört vidalı** klemens var.
- **Burası termostat girişi.** Kanıt bir etiket değil, Serhat Bey'in birinci
  elden bilgisi: *"eminim, daha önce buraya bağladık."* Klemens üzerinde
  okunabilir `RT`/`24V`/`GND` yazısı **yok** — gri plastikte yalnız kabartma
  bir şema simgesi var. Yani isimleri hâlâ RF 6001 kılavuzundan varsayıyoruz;
  **hangi uçlar** olduğu artık belli, **ne taşıdıkları** değil.
- **Köprü VAR ve sebebi belli:** termostat söküldüğü için klemensin **ön
  sırasındaki** iki terminal kısa bir telle köprülenmiş. Kombi bu yüzden şu an
  sürekli ısı talebinde. Bu köprü C2'de çıkarılacak, bizim röle onun yerine
  girecek.
- **Kablolar kombinin içine gidiyor** — duvara çıkan bir termostat kablosu
  yok. Bağlantı noktası kombinin dibinde (bkz. aşağıdaki not).

**Kalan tek şey gerilim:** kombi çalışırken, köprü sökülüyken ve uçlar boşta /
birbirine değmiyorken multimetre **DC Volt** kademesinde iki ön terminal arası.
**Beklenen ~24 V DC.**

🛑 **DUR koşulu:** Beklenenden çok farklı bir değer çıkarsa — özellikle AC
kademesinde yüksek gerilim görürsen — bağlantı yapma, değeri bildir. Röle
kontağı 250 V AC'ye dayanır ama perfboard, ince montaj teli ve açıktaki kart
şebeke gerilimi için uygun değil. Plan o veriye göre düzeltilir.

### B3. 🟡 Kart nerede duracak — sensör kombinin dibinde OLAMAZ

Kablolar içeri gittiği için bağlantı noktası kombinin yanında. Ama DHT11 aynı
perfboard'un üzerinde ve **kombinin dibindeki sıcaklık odanın sıcaklığı
değildir** — kazan/dolap sıcaklığını ölçer, termostat da ona göre yanlış karar
verir.

Çözüm: röle **kuru kontak**, yani uzatılması serbest. Klemensten karta
2 damarlı kablo çekilir (kılavuz s.11 §2.5: 20 m'ye kadar **2×0,75 mm²**,
daha uzunsa 2×1 mm², beyaz), kart ve sensör odada durur.

Kartın yeri: oturma odası / salon / hol duvarı, **yerden ~1,5 m**, güneşten,
kombiden, radyatörden ve hava akımından uzak; yakınında **priz** olmalı
(ESP32 ayrı 5 V adaptörle beslenecek).

**Açık:** yer seçimi ve kablo uzunluğu Serhat Bey'den bekleniyor.

Kombi **çalışır durumdayken**, termostat uçları boşta ve birbirine değmiyorken:

1. Multimetre **DC Volt** kademesinde **RT – 24V** arasını ölç.
   - **Beklenen: ~24 V DC** (kontak açıkken).
2. Klemens bölgesinin **fotoğrafını** çek: RT ile 24V arasında **köprü teli** var mı?

🛑 **DUR koşulu:** Beklenenden çok farklı bir değer çıkarsa — özellikle AC
kademesinde yüksek gerilim görürsen — bağlantı yapma, değeri bildir. Plan o
veriye göre düzeltilir.

---

## C. Bağlantı adımları

1. **Kombinin elektriğini tamamen kes** — fiş *ve* sigorta. Ekranın söndüğünü gör.
2. **Köprüyü çıkar.** Köprü **var** (15.10 fotoğrafı, klemensin ön sırası);
   takılı kalırsa
   kombi sürekli ısı talebinde kalır ve röle hiçbir şeyi kontrol edemez.
   - Çıkan teli **bantla, etiketle, klemens kutusunun yanında sakla.**
   - Köprü yoksa kısa bir tel hazırlayıp oraya koy. **Geri dönüş yolun bu:**
     sıkıntı çıkarsa kartı çıkarıp köprüyü geri bağlarsın.
     (Yalnız evdeyken işleyen bir yol — plan §5'teki açık risk.)
3. **Röle → kombi:**
   - Rölenin **COM** ucu → kombinin **RT** klemensi
   - Rölenin **NO** ucu → kombinin **24V** klemensi
   - **NC kullanılmaz.** Kart ölürse röle bırakır ve kombi ısı talebi görmez.
4. **Kablo:** 20 m'ye kadar 2×0,75 mm², daha uzunsa 2×1 mm² (kılavuz s.11 §2.5).
5. **ESP32 beslemesi: prizden ayrı 5 V adaptör.** Kombinin 24 V'undan besleme —
   kombi kapanınca kart da ölür, kışın asıl lazım olan "oda soğuyor" verisi
   tam o anda kaybolur.
6. Bağlantıyı **fotoğrafla**, kablo uçlarını etiketle.
7. Kombinin elektriğini ver.

---

## D. Kabul ölçümleri (bağlantıdan sonra)

Bant 3,0 °C → röle **hedef − 1,5**'te çeker, **hedef + 1,5**'te bırakır.
Oda şu an ~22 °C.

| # | Yap | Beklenen |
|---|---|---|
| D1 | Panelden hedefi **26** yap | Röle çeker, kombi yanar (`heat=1 pad=LOW`) |
| D2 | Bekle | **Asgari 5 dakika** çekili kalır — bu kusur değil, kombiyi sık aç-kapadan koruyan `min_hold` |
| D3 | Panelden hedefi **18** yap | 5 dakika dolunca röle bırakır, kombi söner |
| D4 | ESP32'nin fişini çek | Röle bırakır, kombi ısı talebi görmez |
| D5 | Fişi geri tak | Açılışta röle çekmez; hedef ve kurallar NVS'ten geri gelir |

**Kabul:** D1–D5 beklendiği gibi *ve* çıkarılan köprü teli saklanmış hâlde
fotoğrafla kayıtlı.

---

## E. Bağlantıdan sonra geçerli iki şart

Kombinin **kendi** donma koruması var (kılavuz s.18 §3.3: çıkış suyu 6 °C altına
düşünce devreye girer, 15 °C'ye kadar çalışır). Kart ölse, röle bırakmış olsa
bile bu koruma çalışır — **ama iki şartla:**

1. **Evde yokken kombinin elektriği ve gazı açık kalacak.** "Giderken fişi
   çekeyim" refleksi korumayı iptal eder. Kılavuzun tarifi: konum seçim
   düğmesini `O` konumuna getir, elektrik ve gaz açık kalsın.
2. **Radyatör vanaları kapatılmayacak.** Kılavuz bunu özellikle yazıyor.

**Kapsanmayan yer (dürüst sınır):** koruma kombinin kendi çıkış suyu
sıcaklığını ölçer. Vanalar açıkken radyatör devresi büyük ölçüde kapsanır,
ama kombiye uzak ve yalıtımsız bir boru garanti değil. Bu bizim yorumumuz,
kılavuzun beyanı değil.

---

## F. Geri dönüş

| Durum | Ne yap |
|---|---|
| Sistem beklenmedik davranıyor | Kartı çıkar, saklanan **köprü telini** RT–24V arasına tak → kombi eski hâline döner |
| Geliştirme yazılımına dönmek gerekirse | `cd firmware && pio run -e esp32dev -t upload` |
| Kartın orijinal (satın alındığı) yazılımına dönmek gerekirse | `~/Desktop/Projeler/kombi-orijinal-firmware-yedek/esp32-orijinal-4MB-20261014.bin` — doğrulanmış tam yedek |
