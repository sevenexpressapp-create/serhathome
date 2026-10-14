// config.example.js — SABLON. Kopyalayin:
//     cp config.example.js config.js
//
// ⚠️ `config.js` .gitignore'da. Buraya YALNIZ herkese-acik (anon/publishable)
// anahtar girer; o zaten gizli degildir, veriyi RLS korur (plan §6).
// Servis anahtari (service_role / secret) ASLA buraya yazilmaz — tarayiciya
// giden her sey okunabilir.
window.KOMBI_CONFIG = {
  // https://<proje-ref>.supabase.co
  SUPABASE_URL: "",
  // "anon public" / "publishable" anahtar
  SUPABASE_ANON_KEY: "",
  // Kac saatlik gecmis gosterilsin
  HISTORY_HOURS: 24,
  // Panel kac saniyede bir yenilesin
  POLL_SECONDS: 15,
};
