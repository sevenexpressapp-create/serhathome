#!/usr/bin/env bash
# Netlify yayin hazirligi. Depoda OLMAYAN iki seyi yayin aninda uretir:
#
#   1. dashboard/config.js   — panelin Supabase adresi + anon anahtari.
#      Depoya girmez (.gitignore). Netlify ortam degiskenlerinden uretilir.
#
#   2. dashboard/_headers    — CSP'deki `*.supabase.co` jokeri GERCEK proje
#      adresine daraltilir. Joker, panelin yanlislikla baska bir Supabase
#      projesine veri gondermesini engellemez. Ayrica proje ref'i boylece
#      herkese acik depoda DURMAZ, yalniz yayinlanan ciktida olur.
#
# Eksik degiskenle yayina devam ETMEZ: calismayan ya da gevsek CSP'li bir panel
# yayinlamaktansa derlemeyi dusurmek dogrudur.

set -euo pipefail

: "${SUPABASE_URL:?DUR: SUPABASE_URL tanimli degil. Netlify > Site settings >
Environment variables altina https://<proje-ref>.supabase.co olarak ekleyin.}"
: "${SUPABASE_ANON_KEY:?DUR: SUPABASE_ANON_KEY tanimli degil. Netlify ortam
degiskenlerine 'anon public' anahtari ekleyin. service_role anahtari ASLA.}"

KOK="$(cd "$(dirname "$0")/.." && pwd)"
PANEL="$KOK/dashboard"

# --- Sagduyu kontrolleri ----------------------------------------------------
case "$SUPABASE_URL" in
  https://*.supabase.co) ;;
  *) echo "DUR: SUPABASE_URL 'https://<ref>.supabase.co' bicimine uymuyor." >&2
     exit 1 ;;
esac

# service_role anahtari tarayiciya GITMEZ. JWT govdesini cozup rolu okuyoruz;
# ad/uzunluk tahminine guvenmek yerine anahtarin KENDI beyanini olcuyoruz.
ROL="$(printf '%s' "$SUPABASE_ANON_KEY" | cut -d. -f2 \
       | tr '_-' '/+' | awk '{while(length($0)%4)$0=$0"="; print}' \
       | base64 -d 2>/dev/null | tr ',' '\n' | grep -o '"role":"[a-z_]*"' || true)"
case "$ROL" in
  *service_role*)
    echo "DUR: SUPABASE_ANON_KEY icine service_role anahtari konmus." >&2
    echo "     Bu anahtar tarayiciya gider ve RLS'i tamamen bypass eder." >&2
    exit 1 ;;
esac

ORIGIN="${SUPABASE_URL#https://}"

# --- 1. config.js -----------------------------------------------------------
cat > "$PANEL/config.js" <<EOF
// OTOMATIK URETILDI — netlify-build.sh, yayin aninda. Elle duzenlemeyin.
// Buradaki anahtar "anon/publishable"; gizli degildir, veriyi RLS korur.
window.KOMBI_CONFIG = {
  SUPABASE_URL: "${SUPABASE_URL}",
  SUPABASE_ANON_KEY: "${SUPABASE_ANON_KEY}",
  HISTORY_HOURS: 24,
  POLL_SECONDS: 15,
};
EOF

# --- 2. _headers: CSP jokerini daralt ---------------------------------------
sed -i.yedek \
  -e "s|https://\*\.supabase\.co|https://${ORIGIN}|g" \
  -e "s|wss://\*\.supabase\.co|wss://${ORIGIN}|g" \
  "$PANEL/_headers"
rm -f "$PANEL/_headers.yedek"

# --- 3. Uretilen ciktiyi OLC (yazdim demek, oldu demek degil) ---------------
hata=0

grep -q "${SUPABASE_URL}" "$PANEL/config.js" \
  || { echo "OLCUM: config.js icinde SUPABASE_URL yok"; hata=1; }
grep -q "SUPABASE_ANON_KEY: \"ey" "$PANEL/config.js" \
  || { echo "OLCUM: config.js icinde anon anahtar yok"; hata=1; }

# Asil kapi: connect-src'de joker KALMAMALI.
# DIKKAT: dosyanin TAMAMINDA aramak YANLIS. _headers'in yorum blogu jokeri
# aciklama amaciyla metin olarak tasiyordu ve kapi hep kirmizi kaliyordu
# (15.10.2026 kum havuzu olcumu). Yalniz yururlukteki CSP satirina bakilir.
if grep '^[[:space:]]*Content-Security-Policy:' "$PANEL/_headers" \
   | grep -q '\*\.supabase\.co'; then
  echo "OLCUM: CSP satirinda hala joker var"; hata=1
fi
# POZITIF KONTROL (ayni eksen): daraltilmis adres gercekten YAZILMIS olmali.
# Yoksa yukaridaki 'joker yok' sonucu, sed'in satiri tamamen silmesinden de
# gelebilirdi — yani sahte yesil.
grep -q "connect-src 'self' https://${ORIGIN} wss://${ORIGIN}" "$PANEL/_headers" \
  || { echo "OLCUM: _headers icinde daraltilmis connect-src bulunamadi"; hata=1; }

if [ "$hata" -ne 0 ]; then
  echo "DUR: yayin ciktisi dogrulanamadi, derleme dusuruldu." >&2
  exit 1
fi

echo "Yayin hazir."
echo "  config.js uretildi  -> ${SUPABASE_URL}"
echo "  CSP daraltildi      -> connect-src ... https://${ORIGIN}"
