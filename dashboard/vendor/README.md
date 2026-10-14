# dashboard/vendor — depoya alınan üçüncü taraf dosyalar

Panel hiçbir betiği CDN'den çekmiyor (güvenlik denetimi ORTA-1). Sebep:
SRI'siz bir CDN betiği, CDN ele geçtiğinde panelin oturum jetonunu okuyabilir;
ayrıca CSP'yi `default-src 'self'` kadar dar tutmak CDN varken mümkün değil.

| Dosya | Sürüm | Kaynak | SHA-256 |
|---|---|---|---|
| `supabase-js-2.45.4.umd.js` | `@supabase/supabase-js` 2.45.4 (UMD) | `https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.js` | `8596965fe918e656600a1b568d3a168f5c0d3d22a600886bb6f44a6555db01e7` |

**Doğrulama (14.10.2026):** aynı dosya iki bağımsız CDN'den indirildi
(jsDelivr ve unpkg) ve **iki SHA-256 özeti birebir aynı** çıktı — yani indirilen
şey npm'de yayınlanmış yapının kendisi, tek bir CDN'in verdiği bir şey değil.

Sürüm yükseltirken:

```
curl -sS -o dashboard/vendor/supabase-js-<SURUM>.umd.js \
  "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@<SURUM>/dist/umd/supabase.js"
curl -sS -o /tmp/ikinci.js \
  "https://unpkg.com/@supabase/supabase-js@<SURUM>/dist/umd/supabase.js"
shasum -a 256 dashboard/vendor/supabase-js-<SURUM>.umd.js /tmp/ikinci.js   # iki özet AYNI olmalı
```

Sonra `dashboard/index.html` içindeki `<script src="vendor/...">` satırını ve
bu tablodaki özeti güncelleyin.
