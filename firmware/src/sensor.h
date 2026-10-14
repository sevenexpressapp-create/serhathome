// sensor.h — Sicaklik sensoru SURUCU ARAYUZU.
//
// Plan §7: DHT11 kalici cozum degil, DS18B20/SHT31'e gecilecek. Bu yuzden sensor
// bir arayuzun ardinda duruyor: gecis gunu `main.cpp`'de tek satir (hangi sinifin
// ornegi olusturuluyor) degisir, termostat mantigi HIC degismez.
#pragma once

#include <Arduino.h>
#include <DHT.h>

#include "kombi_core.h"

class ISensor {
 public:
  virtual ~ISensor() {}
  virtual void begin() = 0;
  virtual const char* name() const = 0;
  // Kac milisaniyede bir okunabilir (DHT11 >= 2000 ms ister).
  virtual uint32_t minIntervalMs() const = 0;
  virtual kombi::Reading read() = 0;
};

// --- DHT11 -------------------------------------------------------------------
class Dht11Sensor : public ISensor {
 public:
  explicit Dht11Sensor(uint8_t pin) : pin_(pin), dht_(pin, DHT11) {}

  void begin() override { dht_.begin(); }
  const char* name() const override { return "DHT11"; }
  uint32_t minIntervalMs() const override { return 2000; }

  kombi::Reading read() override {
    kombi::Reading r;
    const float t = dht_.readTemperature();
    const float h = dht_.readHumidity();
    // DHT11'in gecerli araligi: 0-50 °C, 20-90 %RH. Aralik disi deger bozuk
    // kabul edilir — "saticma deger"i gecerli saymak korlemesine isitmaya yol acar.
    if (isnan(t) || isnan(h) || t < -5.0f || t > 60.0f || h < 0.0f || h > 100.0f) {
      r.valid = false;
      return r;
    }
    r.valid = true;
    r.temp_c = t;
    r.humidity = h;
    return r;
  }

 private:
  uint8_t pin_;
  DHT dht_;
};

// --- DS18B20 / SHT31 gecisi --------------------------------------------------
// Faz 4'te eklenecek sinif buraya gelir; `ISensor`u uygulamasi yeterli.
// Ornek iskelet (bilincli olarak bos birakildi, sensor elde yok):
//   class Ds18b20Sensor : public ISensor { ... };

// --- Benzetim sarmalayicisi (yalniz Faz 1 kabul testleri icin) ---------------
// Gercek sensorun uzerine biner: `forceFault` ile okuma arizasini, `forceTemp`
// ile belirli bir sicakligi taklit eder. Boylece "sensor arizasinda isitma
// kesiliyor" ve "donma korumasi tetikleniyor" iddialari, odanin sicakligini
// gercekten degistirmeye gerek kalmadan KARTIN UZERINDE olculebiliyor.
class SimWrapper : public ISensor {
 public:
  explicit SimWrapper(ISensor* inner) : inner_(inner) {}

  void begin() override { inner_->begin(); }
  const char* name() const override { return inner_->name(); }
  uint32_t minIntervalMs() const override { return inner_->minIntervalMs(); }

  kombi::Reading read() override {
    kombi::Reading real = inner_->read();
    if (fault_) {
      kombi::Reading r;  // valid=false
      return r;
    }
    if (has_temp_) {
      real.valid = true;
      real.temp_c = temp_;
      if (isnan(real.humidity)) real.humidity = 0.0f;
    }
    return real;
  }

  void setFault(bool on) { fault_ = on; }
  void setTemp(float t) { temp_ = t; has_temp_ = true; }
  void clearTemp() { has_temp_ = false; }
  bool active() const { return fault_ || has_temp_; }
  bool faulting() const { return fault_; }
  bool tempForced() const { return has_temp_; }
  float forcedTemp() const { return temp_; }

 private:
  ISensor* inner_;
  bool fault_ = false;
  bool has_temp_ = false;
  float temp_ = 0.0f;
};
