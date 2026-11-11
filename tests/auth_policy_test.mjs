// YUKSEK-2 olcumu: signup kapali mi, parola politikasi uyguluyor mu?
// + 11.11.2026 KRITIK-1: panel kullanicisinin (`authenticated`) cagirmamasi
//   gereken SILME fonksiyonunu gercekten cagiramadigi (S6/S7, dosya sonunda).
//
// Calistirma:
//   node tests/auth_policy_test.mjs                       # YEREL yigin (54321)
//   SUPABASE_URL=https://<REF>.supabase.co ANON_KEY=<anon> SERVICE_KEY=<service> \
//     node tests/auth_policy_test.mjs                     # BULUT projesi
//
// ⚠️ SAHTE YESIL TUZAGI (denetim 2. tur): bu dosya eskiden `process.env`i HIC
// okumuyordu. docs/SUPABASE-KURULUM.md §7.5'teki bulut komutu kopyalanip
// kosuldugunda bile hedef `supabase status`tan geliyor, yani YEREL yigin
// olculuyor ve "5/5 gecti" basiliyordu — bulut projesinde kayit acik, parola 6
// karakter olabilirken. Ortam degiskenleri artik hedefi EZIYOR (kardes testlerle
// ayni kalip: rls_test / device_sync_test / sync_test) ve olcumun hangi hedefe
// bagli oldugu ilk satirda BASILIYOR. Hedefe ulasilamazsa olcum sessizce yerele
// DONMEZ, kirmiziya duser.
import { execFileSync } from "node:child_process";

function localStatus() {
  const out = execFileSync("npx", ["-y", "supabase@latest", "status", "-o", "json"], {
    encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
  });
  return JSON.parse(out);
}
const st = process.env.SUPABASE_URL ? null : localStatus();
const U = process.env.SUPABASE_URL ?? st.API_URL;
const ANON = process.env.ANON_KEY ?? st.ANON_KEY;
const SERVICE = process.env.SERVICE_KEY ?? st.SERVICE_ROLE_KEY;
if (!U || !ANON || !SERVICE) {
  console.error("DUR: SUPABASE_URL verildiyse ANON_KEY ve SERVICE_KEY de gerekli " +
    "(eksik anahtarla kosmak 'olcum' degildir).");
  process.exit(2);
}
const yerel = /\/\/(127\.0\.0\.1|localhost)([:/]|$)/.test(U);
console.log(`HEDEF: ${U} (${yerel ? "yerel" : "bulut"})` +
  (process.env.SUPABASE_URL ? " — ortam degiskeninden" : " — ortam degiskeni yok, `supabase status`tan"));

const results = [];
const check = (n, p, d) => { results.push({n,p}); console.log(`${p?"GECTI ":"KALDI "} ${n}${d?" — "+d:""}`); };

const post = async (path, body, key = ANON, bearer = null) => {
  let r;
  try {
    r = await fetch(`${U}${path}`, { method: "POST",
      headers: { apikey: key, Authorization: `Bearer ${bearer ?? key}`, "content-type": "application/json" },
      body: JSON.stringify(body) });
  } catch (e) {
    // Hedefe ULASILAMADI. Yerele geri donmek YOK: "durum=0" her olcumu dusurur.
    return { status: 0, data: `AG HATASI (${U}): ${e?.cause?.code ?? e?.message ?? String(e)}` };
  }
  let d = null; const t = await r.text(); if (t) { try { d = JSON.parse(t); } catch { d = t; } }
  return { status: r.status, data: d };
};

const stamp = Date.now();
// 1) YABANCI KENDINE HESAP ACAMAZ
const su = await post("/auth/v1/signup", { email: `yabanci+${stamp}@kombi.test`, password: "Guclu-Parola-2026!" });
check("S1 anon signup KAPALI", su.status >= 400 && /signup|disabled|not allowed/i.test(JSON.stringify(su.data)),
  `durum=${su.status} govde=${JSON.stringify(su.data).slice(0,120)}`);

// 2) POZITIF KONTROL (ayni eksen): yonetici (service_role) hala kullanici ekleyebiliyor
const ok = await post("/auth/v1/admin/users",
  { email: `sahip+${stamp}@kombi.test`, password: "Guclu-Parola-2026!", email_confirm: true }, SERVICE);
check("S2 POZITIF KONTROL: yonetici kullanici EKLEYEBILIYOR (yani S1 'auth tamamen bozuk' degil)",
  ok.status === 200 && Boolean(ok.data?.id), `durum=${ok.status}`);

// 3) PAROLA POLITIKASI: kisa parola reddedilir
const short = await post("/auth/v1/admin/users",
  { email: `kisa+${stamp}@kombi.test`, password: "Abc12345!", email_confirm: true }, SERVICE);
check("S3 9 karakterlik parola REDDEDILIYOR (asgari 12)", short.status >= 400,
  `durum=${short.status} ${JSON.stringify(short.data).slice(0,100)}`);

// 4) PAROLA KARMASIKLIGI: uzun ama sembolsuz/tek tip parola reddedilir
const simple = await post("/auth/v1/admin/users",
  { email: `basit+${stamp}@kombi.test`, password: "abcdefghijklmnop", email_confirm: true }, SERVICE);
check("S4 karmasiklik kurali uyguluyor (yalniz kucuk harf reddedildi)", simple.status >= 400,
  `durum=${simple.status} ${JSON.stringify(simple.data).slice(0,100)}`);

// 5) Girilebiliyor mu (S2'nin kullanicisi)
const login = await post("/auth/v1/token?grant_type=password",
  { email: `sahip+${stamp}@kombi.test`, password: "Guclu-Parola-2026!" });
check("S5 gecerli kullanici GIRIS YAPABILIYOR (politika mesru kullaniciyi kilitlemedi)",
  login.status === 200 && Boolean(login.data?.access_token), `durum=${login.status}`);

// --- 6) FONKSIYON YETKISI: panel kullanicisi budama fonksiyonunu CAGIRAMAZ ---
// KRITIK-1 (denetim 11.11.2026). `kombi_init.sql:165` yalniz PUBLIC sozde-rolunu
// aliyordu; Supabase'in varsayilan yetkileri ACL'e ADLANDIRILMIS bir
// `authenticated=X/postgres` girdisi yaziyor ve `revoke ... from public` ona
// dokunmuyor. Olculdu (canli + yerel): proacl =
// {postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}.
// Duzeltme gocu: supabase/migrations/20261111211500_prune_telemetry_yetki_duzeltme.sql
//
// ⚠️ BU OLCUM NEDEN VERI SILMEZ (tasarim karari — PENCEREYI KUCULTMEYIN):
// olculen sey "cagri REDDEDILIYOR mu". Olcum KIRMIZIYA duserse cagri GECMIS
// olur, yani fonksiyon gercekten kosar. O yuzden tutma penceresi 36500 GUN
// (100 yil): `ts < now() - 36500 gun` hicbir satiri tutmaz, en kotu halde 0
// satir silinir. `p_keep_days: 1` gibi bir deger yazmak, gerilemeyi OLCEN
// sinavin kendisini veri yok ediciye cevirirdi.
//
// ⚠️ YEREL-YIGIN KAPISI BILEREK EKLENMEDI: bu dosya (kardeslerinin aksine)
// BULUTA karsi kosmak icin tasarlandi — ortam degiskenleri hedefi eziyor
// (satir 8-15'teki sahte-yesil dersi) ve docs/SUPABASE-KURULUM.md:132 ile :222
// bulut kosumunu ACIKCA tarif ediyor. Ustelik S6'nin olctugu ACIK YETKI canli
// projede duruyor; yerele kilitlemek, olculmesi gereken yeri olcumsuz
// birakirdi. Guvenlik, hedefi kisitlamakla degil CAGRIYI ZARARSIZ KILMAKLA
// saglaniyor (asagidaki KEEP_DAYS kapisi).
const KEEP_DAYS = 36500;
if (!Number.isInteger(KEEP_DAYS) || KEEP_DAYS < 3650) {
  console.error("DUR: S6/S7 yalniz ZARARSIZ bir tutma penceresiyle kosar (>= 3650 gun). " +
    `KEEP_DAYS=${KEEP_DAYS} ile bu sinav veri silen bir arac olur.`);
  process.exit(2);
}

const rpc = async (bearer, key = ANON) => {
  let r;
  try {
    r = await fetch(`${U}/rest/v1/rpc/prune_telemetry`, { method: "POST",
      headers: { apikey: key, Authorization: `Bearer ${bearer}`, "content-type": "application/json" },
      body: JSON.stringify({ p_keep_days: KEEP_DAYS }) });
  } catch (e) {
    return { status: 0, data: `AG HATASI (${U}): ${e?.cause?.code ?? e?.message ?? String(e)}` };
  }
  let d = null; const t = await r.text(); if (t) { try { d = JSON.parse(t); } catch { d = t; } }
  return { status: r.status, data: d };
};

const jeton = login.data?.access_token ?? null;
if (!jeton) {
  // Atlamak YOK: olculemeyen sey "gecti" sayilmaz.
  check("S6 panel kullanicisi (authenticated) prune_telemetry'yi CAGIRAMAZ", false,
    "S5 giris yapamadi, oturum jetonu yok — yetki OLCULEMEDI (atlanmadi, KALDI sayildi)");
} else {
  const pr = await rpc(jeton);
  // OLCUT: PostgreSQL hata kodu 42501 (insufficient_privilege) — satir sayisi
  // DEGIL. Fonksiyon silinmis olsa PostgREST PGRST202 dondururdu ve bu olcum
  // yine KALIRDI (sahte yesil kapisi).
  const kod = pr.data?.code ?? null;
  check("S6 panel kullanicisi (authenticated) prune_telemetry'yi CAGIRAMAZ",
    pr.status >= 400 && kod === "42501",
    `durum=${pr.status} kod=${kod ?? "-"} ` + (pr.status === 200
      ? `⚠️ CAGRI GECTI — YETKI ACIK. Donen silinen satir sayisi=${JSON.stringify(pr.data)} ` +
        `(100 yillik pencere sayesinde 0; veri kaybi YOK ama kapi acik)`
      : JSON.stringify(pr.data).slice(0, 150)));
}

// --- 7) POZITIF KONTROL (ayni eksen): service_role HALA cagirabiliyor --------
// S6'nin "fonksiyon yok / RPC yolu bozuk" yuzunden yesil gorunmesini engeller.
// Ayni zararsiz 100 yillik pencere: beklenen donus 0 silinen satir.
const pk = await rpc(SERVICE, SERVICE);
check("S7 POZITIF KONTROL: service_role prune_telemetry'yi CAGIRABILIYOR (yani S6 'fonksiyon yok' demiyor)",
  pk.status === 200 && Number(pk.data) === 0,
  `durum=${pk.status} silinen=${JSON.stringify(pk.data)} (100 yillik pencere: 0 beklenir)`);

const failed = results.filter(r => !r.p);
console.log(`\n==== ${results.length} olcum: ${results.length-failed.length} gecti, ${failed.length} kaldi ====`);
process.exit(failed.length ? 1 : 0);
