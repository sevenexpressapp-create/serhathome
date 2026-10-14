// YUKSEK-2 olcumu: signup kapali mi, parola politikasi uyguluyor mu?
import { execFileSync } from "node:child_process";
const st = JSON.parse(execFileSync("npx", ["-y", "supabase@latest", "status", "-o", "json"],
  { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
const U = st.API_URL, ANON = st.ANON_KEY, SERVICE = st.SERVICE_ROLE_KEY;
const results = [];
const check = (n, p, d) => { results.push({n,p}); console.log(`${p?"GECTI ":"KALDI "} ${n}${d?" — "+d:""}`); };

const post = async (path, body, key = ANON, bearer = null) => {
  const r = await fetch(`${U}${path}`, { method: "POST",
    headers: { apikey: key, Authorization: `Bearer ${bearer ?? key}`, "content-type": "application/json" },
    body: JSON.stringify(body) });
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

const failed = results.filter(r => !r.p);
console.log(`\n==== ${results.length} olcum: ${results.length-failed.length} gecti, ${failed.length} kaldi ====`);
process.exit(failed.length ? 1 : 0);
