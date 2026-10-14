// PIN TESPIT ARACI (tek kullanimlik, karta gecici olarak atilir)
//
// Neden var: karttaki eski firmware'in kaynak kodu elde yok, DHT11 ve role
// hangi GPIO'ya bagli BILINMIYOR. Varsayimla ilerlemek yerine olcuyoruz.
//
// Yontem:
//  ASAMA 1 (tamamen pasif, hicbir pin CIKIS yapilmaz):
//    Her aday pin sirayla dahili pull-DOWN ve pull-UP ile okunur.
//    - Bagli olmayan pin: pulldown'da LOW, pullup'ta HIGH  -> "serbest"
//    - Disaridan yukari cekilmis pin (DHT11 veri hatti ya da role modulunun
//      giris katmani): pulldown'da da HIGH kalir -> "DISARIDAN HIGH"
//    Dahili cekme direnci ~45 kOhm; disarida 1-10 kOhm'luk bir pull-up onu
//    yener. Bu asamada role CEKILEMEZ cunku hicbir pin surulmez.
//  ASAMA 2 (yalniz asama 1'de "DISARIDAN HIGH" cikan pinlerde):
//    DHT11 protokolu denenir. Yalniz gercek sensor pini gecerli saglama
//    toplamiyla veri dondurur -> sensor pini KESIN tespit edilir.
//    Not: DHT protokolu pini kisa sure (~20 ms) LOW surer. Aday pinlerden biri
//    role ise role bir an "tik" edebilir. Faz 1'de role BOSTA (kombiye bagli
//    degil), bu yuzden zararsiz. Kombi bagliyken bu arac CALISTIRILMAZ.
//
// Eleme: asama 1'de disaridan HIGH cikan ama asama 2'de DHT vermeyen pin(ler)
// role adayidir. Tek pin kaliyorsa role pini elemeyle bulunmus olur; dogrulama
// icin modulun LED'ine bakilir (insan gozlemi).

#include <Arduino.h>
#include <DHT.h>

// Aday pinler. Dislananlar ve nedenleri:
//  GPIO 6-11  : dahili flash'a bagli, dokunulmaz
//  GPIO 34-39 : yalniz-giris (role suremez), DHT de olamaz
//  GPIO 0     : acilis strapping pini; okunur ama asla surulmez
static const int CANDIDATES[] = {0, 2, 4, 5, 12, 13, 14, 15, 16, 17, 18, 19,
                                 21, 22, 23, 25, 26, 27, 32, 33};
static const int N = sizeof(CANDIDATES) / sizeof(CANDIDATES[0]);

static bool externally_high[N];

static void phase1() {
  Serial.println(F("=== ASAMA 1: pasif pin taramasi (hicbir pin CIKIS yapilmaz) ==="));
  Serial.println(F("pin\tpulldown\tpullup\tyorum"));
  for (int i = 0; i < N; i++) {
    const int p = CANDIDATES[i];
    pinMode(p, INPUT_PULLDOWN);
    delay(20);
    const int d = digitalRead(p);
    pinMode(p, INPUT_PULLUP);
    delay(20);
    const int u = digitalRead(p);
    pinMode(p, INPUT);  // pini serbest birak
    externally_high[i] = (d == HIGH);
    Serial.printf("%d\t%s\t\t%s\t%s\n", p, d ? "HIGH" : "LOW", u ? "HIGH" : "LOW",
                  d == HIGH ? "DISARIDAN HIGH (bagli olabilir)" : "serbest");
  }
  Serial.println();
}

static void phase2() {
  Serial.println(F("=== ASAMA 2: DHT11 protokol denemesi (yalniz disaridan HIGH pinler) ==="));
  int found = -1;
  for (int i = 0; i < N; i++) {
    if (!externally_high[i]) continue;
    const int p = CANDIDATES[i];
    if (p == 0) continue;  // strapping pini surulmez
    DHT dht(p, DHT11);
    dht.begin();
    delay(1200);  // DHT11 ilk okumadan once oturma suresi ister
    float t = NAN, h = NAN;
    for (int tries = 0; tries < 4; tries++) {
      t = dht.readTemperature();
      h = dht.readHumidity();
      if (!isnan(t) && !isnan(h)) break;
      delay(2200);
    }
    if (!isnan(t) && !isnan(h)) {
      Serial.printf("pin %d -> DHT11 OKUDU: %.1f C, %.1f %%  <<< SENSOR PINI\n", p, t, h);
      found = p;
    } else {
      Serial.printf("pin %d -> DHT yok (role adayi)\n", p);
    }
  }
  Serial.println();
  Serial.printf("SONUC: DHT11 pini = %d\n", found);
  Serial.print(F("SONUC: role adaylari (disaridan HIGH, DHT degil) = "));
  for (int i = 0; i < N; i++) {
    if (externally_high[i] && CANDIDATES[i] != found && CANDIDATES[i] != 0) {
      Serial.printf("%d ", CANDIDATES[i]);
    }
  }
  Serial.println();
}

void setup() {
  Serial.begin(115200);
  delay(1500);
  Serial.println();
  Serial.println(F("### KOMBI PIN TESPIT ARACI v1 ###"));
  phase1();
  phase2();
  Serial.println(F("### BITTI — sonuclari not alip ana yazilimi flash'layin ###"));
}

void loop() { delay(10000); }
