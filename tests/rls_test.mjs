// RLS kapisinin GERCEKTEN engelledigini olcer. Yazmakla kalmayip sinar.
//
// Calistirma (YEREL yigina karsi — Serhat Bey'in bulut projelerine DOKUNMAZ):
//   cd kombi-kontrol && npx supabase start && npx supabase db reset
//   node tests/rls_test.mjs
// Yerel anahtarlar `supabase status` ciktisindan otomatik okunur; istenirse
// SUPABASE_URL / ANON_KEY / SERVICE_KEY / DB_URL ortam degiskenleriyle ezilir.
//
// Olcum tasarimi (hafiza dersi: "kapi zincirde degilse kapi degildir"):
//   · Her yasak iddiasinin yaninda AYNI EKSENDE pozitif kontrol var: ayni
//     sorgu, yalniz kimlik degisiyor ve SAHIBI veriyi goruyor. Yani "0 satir"
//     sonucu, sorgunun hic calismamasindan gelmiyor.
//   · Sonda MUTASYON var: RLS kapatiliyor ve ayni yetkisiz sorgu TEKRAR
//     kosuluyor. Satir gelmezse testin aleti olu demektir -> test KIRMIZI olur.
//
// ⚠️ MUTASYON ADIMI VARSAYILAN OLARAK KAPALI (guvenlik denetimi ORTA-5).
// `KOMBI_MUTATE=1` verilmeden kosulmaz. Sebep: adim `alter table ... disable
// row level security` calistiriyor; `finally` geri aciyor ama kosum SIGKILL
// alirsa ya da makine coker ise tablo RLS'SIZ KALIR. Bu yuzden:
//   · yerelde:  KOMBI_MUTATE=1 node tests/rls_test.mjs   (aleti dogrulamak icin)
//   · BULUTTA:  bayrak VERILMEZ. Canli projede RLS'i kapatan bir adim kosmaz.

import { execFileSync } from "node:child_process";

function localStatus() {
  const out = execFileSync("npx", ["-y", "supabase@latest", "status", "-o", "json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return JSON.parse(out);
}

let URL_, ANON, SERVICE, DB_URL;
if (process.env.SUPABASE_URL) {
  URL_ = process.env.SUPABASE_URL;
  ANON = process.env.ANON_KEY;
  SERVICE = process.env.SERVICE_KEY;
  DB_URL = process.env.DB_URL;
} else {
  const s = localStatus();
  URL_ = s.API_URL;
  ANON = s.ANON_KEY;
  SERVICE = s.SERVICE_ROLE_KEY;
  DB_URL = s.DB_URL;
}

const DEVICE_ID = "kombi-test-rls";
const results = [];

function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? "GECTI " : "KALDI "} ${name}${detail ? " — " + detail : ""}`);
}

async function rest(path, { token, method = "GET", body, prefer } = {}) {
  const headers = {
    apikey: ANON,
    Authorization: `Bearer ${token ?? ANON}`,
    "content-type": "application/json",
  };
  if (prefer) headers.Prefer = prefer;
  const res = await fetch(`${URL_}/rest/v1/${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  const text = await res.text();
  if (text) {
    try { data = JSON.parse(text); } catch { data = text; }
  }
  return { status: res.status, data };
}

async function adminCreateUser(email, password) {
  const res = await fetch(`${URL_}/auth/v1/admin/users`, {
    method: "POST",
    headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, "content-type": "application/json" },
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  const j = await res.json();
  if (!j.id) throw new Error(`kullanici olusturulamadi: ${JSON.stringify(j)}`);
  return j.id;
}

async function signIn(email, password) {
  const res = await fetch(`${URL_}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: ANON, "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const j = await res.json();
  if (!j.access_token) throw new Error(`giris basarisiz: ${JSON.stringify(j)}`);
  return j.access_token;
}

function sql(statement) {
  return execFileSync("psql", [DB_URL, "-v", "ON_ERROR_STOP=1", "-c", statement], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

const stamp = Date.now();
const emailA = `sahip+${stamp}@kombi.test`;
const emailB = `yabanci+${stamp}@kombi.test`;
const PASS = "Kombi-Test-" + stamp;

console.log(`yerel API: ${URL_}`);

const uidA = await adminCreateUser(emailA, PASS);
await adminCreateUser(emailB, PASS);
const tokA = await signIn(emailA, PASS);
const tokB = await signIn(emailB, PASS);

// --- Tohum veri: service_role ile (cihazin Edge Function'i da boyle yazar) ---
await rest(`devices`, {
  token: SERVICE,
  method: "POST",
  body: {
    id: DEVICE_ID,
    owner_id: uidA,
    name: "Test kombi",
    secret_sha256: "a".repeat(64),
  },
  prefer: "resolution=merge-duplicates",
});
await rest(`device_settings`, {
  token: SERVICE, method: "POST", body: { device_id: DEVICE_ID, target_c: 21.0 },
  prefer: "resolution=merge-duplicates",
});
await rest(`device_state`, {
  token: SERVICE, method: "POST",
  body: { device_id: DEVICE_ID, temp_c: 22.5, relay_on: false, sensor_ok: true },
  prefer: "resolution=merge-duplicates",
});
await rest(`telemetry`, {
  token: SERVICE, method: "POST", body: { device_id: DEVICE_ID, temp_c: 22.5, relay_on: false },
});
await rest(`events`, {
  token: SERVICE, method: "POST", body: { device_id: DEVICE_ID, kind: "test_olay", detail: "tohum" },
});

// =========================================================================
// 1) POZITIF KONTROL — sahibi kendi verisini GORUYOR.
//    Bu gecmezse asagidaki "0 satir" sonuclari hicbir sey kanitlamaz.
// =========================================================================
{
  const r = await rest(`devices?select=id,name`, { token: tokA });
  check("P1 sahip kendi cihazini okuyor", r.status === 200 && Array.isArray(r.data) && r.data.length === 1,
    `durum=${r.status} satir=${Array.isArray(r.data) ? r.data.length : "?"}`);
}
{
  const r = await rest(`device_state?select=temp_c`, { token: tokA });
  check("P2 sahip anlik durumu okuyor", r.status === 200 && r.data?.length === 1 && Number(r.data[0].temp_c) === 22.5,
    `durum=${r.status} veri=${JSON.stringify(r.data)}`);
}
{
  const r = await rest(`device_settings?device_id=eq.${DEVICE_ID}`, {
    token: tokA, method: "PATCH", body: { target_c: 23.5 }, prefer: "return=representation",
  });
  check("P3 sahip hedef sicakligi YAZIYOR", r.status === 200 && r.data?.length === 1 && Number(r.data[0].target_c) === 23.5,
    `durum=${r.status} veri=${JSON.stringify(r.data)}`);
}
{
  const r = await rest(`device_health?select=device_id,online,freeze_risk`, { token: tokA });
  check("P4 sahip saglik goruntusunu okuyor", r.status === 200 && r.data?.length === 1,
    `durum=${r.status} satir=${r.data?.length}`);
}
// P5/P6 — OLCUM BOSLUGU KAPATILDI (denetci isaretledi): `telemetry` ve `events`
// icin SAHIP TARAFINDA pozitif kontrol yoktu. O yuzden politika bozulup
// "kimse goremez" haline gelse bile N3/N7 yesil kalirdi (olu alet sinifi).
{
  const r = await rest(`telemetry?select=temp_c&device_id=eq.${DEVICE_ID}`, { token: tokA });
  check("P5 sahip telemetriyi OKUYOR (N3'un olu alet olmadigi)",
    r.status === 200 && r.data?.length >= 1 && Number(r.data[0].temp_c) === 22.5,
    `durum=${r.status} satir=${r.data?.length} ilk=${r.data?.[0]?.temp_c}`);
}
{
  const r = await rest(`events?select=kind`, { token: tokA });
  check("P6 sahip olaylari OKUYOR (events icin sahip tarafi olcumu)",
    r.status === 200 && r.data?.length === 1 && r.data[0].kind === "test_olay",
    `durum=${r.status} satir=${r.data?.length} ilk=${r.data?.[0]?.kind}`);
}

// =========================================================================
// 2) YETKISIZ GIRISLI KULLANICI — baska birinin cihazi
// =========================================================================
{
  const r = await rest(`devices?select=id`, { token: tokB });
  check("N1 yabanci kullanici cihazi GOREMIYOR", r.status === 200 && r.data?.length === 0,
    `durum=${r.status} satir=${r.data?.length}`);
}
{
  const r = await rest(`device_state?select=temp_c`, { token: tokB });
  check("N2 yabanci anlik durumu GOREMIYOR", r.status === 200 && r.data?.length === 0,
    `durum=${r.status} satir=${r.data?.length}`);
}
{
  const r = await rest(`telemetry?select=temp_c`, { token: tokB });
  check("N3 yabanci telemetriyi GOREMIYOR", r.status === 200 && r.data?.length === 0,
    `durum=${r.status} satir=${r.data?.length}`);
}
{
  const r = await rest(`events?select=kind`, { token: tokB });
  check("N7 yabanci olaylari GOREMIYOR", r.status === 200 && r.data?.length === 0,
    `durum=${r.status} satir=${r.data?.length}`);
}
{
  // device_health icin OLUMSUZ EKSEN (denetci: "olumsuz eksen yok"). Goruntu
  // security_invoker oldugu icin cagiranin RLS'i uygulanmali.
  const r = await rest(`device_health?select=device_id`, { token: tokB });
  check("N8 yabanci saglik goruntusunde HICBIR satir gormuyor",
    r.status === 200 && r.data?.length === 0, `durum=${r.status} satir=${r.data?.length}`);
}
{
  const r = await rest(`device_settings?device_id=eq.${DEVICE_ID}`, {
    token: tokB, method: "PATCH", body: { target_c: 30 }, prefer: "return=representation",
  });
  const blocked = r.status >= 400 || (Array.isArray(r.data) && r.data.length === 0);
  check("N4 yabanci hedefi DEGISTIREMIYOR", blocked, `durum=${r.status} veri=${JSON.stringify(r.data)}`);
}
{
  // Denetcinin isaretledigi bosluk: yabanci BASKASININ device_id'siyle
  // scenario_rules'a INSERT edemiyor mu? (with check politikasi)
  const r = await rest(`scenario_rules`, {
    token: tokB, method: "POST",
    body: { device_id: DEVICE_ID, days_mask: 127, hour: 4, minute: 0, target_c: 30 },
    prefer: "return=representation",
  });
  const after = await rest(`scenario_rules?select=hour&hour=eq.4`, { token: tokA });
  check("N9 yabanci BASKASININ cihazina kural EKLEYEMIYOR",
    r.status >= 400 && (after.data?.length ?? 0) === 0,
    `durum=${r.status} kod=${r.data?.code ?? "-"} sahip_gorunum_satir=${after.data?.length}`);
}
{
  // ORTA-3: panel oturumu cihaz SIRRINI degistiremez (calinmis oturum cihazi
  // taklit edip gercek ESP32'yi kalici 401'e dusuremesin).
  const r = await rest(`devices?id=eq.${DEVICE_ID}`, {
    token: tokA, method: "PATCH", body: { secret_sha256: "c".repeat(64) },
    prefer: "return=representation",
  });
  const after = await rest(`devices?select=secret_sha256,name`, { token: tokA });
  const unchanged = after.data?.[0]?.secret_sha256 === "a".repeat(64);
  check("N10 (ORTA-3) SAHIBI bile cihaz sirrini DEGISTIREMIYOR", r.status >= 400 && unchanged,
    `durum=${r.status} kod=${r.data?.code ?? "-"} ozet_degismedi=${unchanged}`);

  // POZITIF KONTROL (ayni eksen): ADI degistirebiliyor -> N10 "panel hic
  // yazamiyor"dan degil, SUTUN BAZLI yetkiden geliyor.
  const rn = await rest(`devices?id=eq.${DEVICE_ID}`, {
    token: tokA, method: "PATCH", body: { name: "Yeni ad" }, prefer: "return=representation",
  });
  check("N10b POZITIF KONTROL: sahip cihaz ADINI degistirebiliyor",
    rn.status === 200 && rn.data?.[0]?.name === "Yeni ad", `durum=${rn.status}`);
}
{
  // Gercekten degismemis mi? Sahibinin gozuyle dogrula (vekil degil, hedefin kendisi).
  const r = await rest(`device_settings?select=target_c`, { token: tokA });
  check("N4b hedef hala 23.5 (yabancinin yazmasi gercekten islemedi)",
    Number(r.data?.[0]?.target_c) === 23.5, `target_c=${r.data?.[0]?.target_c}`);
}
{
  const r = await rest(`devices`, {
    token: tokB, method: "POST", body: { id: "korsan-cihaz", owner_id: uidA, secret_sha256: "b".repeat(64) },
    prefer: "return=representation",
  });
  check("N5 yabanci BASKASI adina cihaz kaydedemiyor", r.status >= 400,
    `durum=${r.status} kod=${r.data?.code ?? "-"}`);
}
{
  // "Yalniz cihaz yazar" iddiasi. Olculen eksen: yazma gercekten islemedi mi?
  // Hem cevap (hata ya da 0 satir) hem DEGERIN KENDISI kontrol ediliyor —
  // 200 donen bir cevap da 0 satir guncellemis olabilir (ilk olcumde oyleydi).
  const r = await rest(`device_state?device_id=eq.${DEVICE_ID}`, {
    token: tokA, method: "PATCH", body: { temp_c: 99 }, prefer: "return=representation",
  });
  const refused = r.status >= 400 || (Array.isArray(r.data) && r.data.length === 0);
  const after = await rest(`device_state?select=temp_c`, { token: tokA });
  const unchanged = Number(after.data?.[0]?.temp_c) === 22.5;
  check("N6 SAHIBI bile anlik durumu yazamiyor (yalniz cihaz yazar)", refused && unchanged,
    `durum=${r.status} kod=${r.data?.code ?? "-"} sonraki_temp=${after.data?.[0]?.temp_c}`);
}

// =========================================================================
// 3) ANONIM (girissiz) — plan §6: hicbir satir gormemeli
// =========================================================================
for (const tbl of ["devices", "device_state", "device_settings", "telemetry", "scenario_rules", "events"]) {
  const r = await rest(`${tbl}?select=*`);
  const blocked = r.status >= 400 || (Array.isArray(r.data) && r.data.length === 0);
  check(`A1 anon ${tbl} okuyamiyor`, blocked, `durum=${r.status} kod=${r.data?.code ?? "-"}`);
}
{
  const r = await rest(`device_settings?device_id=eq.${DEVICE_ID}`, {
    token: null, method: "PATCH", body: { target_c: 30 }, prefer: "return=representation",
  });
  check("A2 anon hedefi yazamiyor", r.status >= 400 || (Array.isArray(r.data) && r.data.length === 0),
    `durum=${r.status} kod=${r.data?.code ?? "-"}`);
}

// =========================================================================
// 4) Cakisan kural tetikleyicisi (plan §2)
// =========================================================================
{
  const r1 = await rest(`scenario_rules`, {
    token: tokA, method: "POST", body: { device_id: DEVICE_ID, days_mask: 62, hour: 8, minute: 0, target_c: 22 },
    prefer: "return=representation",
  });
  check("R1 sahip kural ekliyor (hafta ici 08:00)", r1.status === 201, `durum=${r1.status}`);

  const r2 = await rest(`scenario_rules`, {
    token: tokA, method: "POST", body: { device_id: DEVICE_ID, days_mask: 65, hour: 8, minute: 0, target_c: 20 },
    prefer: "return=representation",
  });
  check("R2 cakismayan ayni saat (hafta sonu 08:00) SERBEST", r2.status === 201, `durum=${r2.status}`);

  const r3 = await rest(`scenario_rules`, {
    token: tokA, method: "POST", body: { device_id: DEVICE_ID, days_mask: 2, hour: 8, minute: 0, target_c: 25 },
    prefer: "return=representation",
  });
  check("R3 CAKISAN ayni dakika (Pazartesi 08:00) REDDEDILIYOR", r3.status >= 400,
    `durum=${r3.status} mesaj=${(r3.data?.message ?? "").slice(0, 60)}`);
}

// =========================================================================
// 5) MUTASYON / POZITIF KONTROL — aletin olu olmadiginin kaniti.
//    RLS'i kapatip ayni yetkisiz sorgulari TEKRAR kosuyoruz. Satir GELMELI;
//    gelmezse "0 satir" sonucumuz RLS'ten degil baska bir seyden geliyordu.
//
//    ORTA-5: YALNIZ `KOMBI_MUTATE=1` ile. Bulut projesinde KOSULMAZ.
//    Denetcinin istedigi bosluk: mutasyon yalniz `devices`'a uygulanmisti;
//    simdi `telemetry` de kapsamda (her tablonun kendi kapisi ayri).
// =========================================================================
const MUTATE = process.env.KOMBI_MUTATE === "1";
if (!MUTATE) {
  console.log("ATLANDI M1-M4 mutasyon adimi — `KOMBI_MUTATE=1` verilmedi " +
    "(canli projede RLS kapatilmaz). Yerelde aleti dogrulamak icin bayragi verin.");
} else {
  if (!/127\.0\.0\.1|localhost/.test(URL_)) {
    console.log("DUR: mutasyon adimi YALNIZ yerel yigina karsi kosulabilir. Hedef: " + URL_);
    process.exit(2);
  }
  try {
    sql("alter table public.devices disable row level security;");
    // Sorgu BU TESTIN cihazina daraltildi: tohum veri (seed_demo) baska cihazlar
    // da ekliyor; "tam 1 satir" beklemek olcumu veritabanindaki diger satirlara
    // bagli kiliyordu (olculdu: 3 satir -> sahte kirmizi).
    const r = await rest(`devices?select=id&id=eq.${DEVICE_ID}`, { token: tokB });
    const leaked = Array.isArray(r.data) ? r.data.length : -1;
    check("M1 MUTASYON: RLS kapatilinca yabanci cihazi GORUYOR (alet canli)", leaked === 1,
      `satir=${leaked} (RLS kapaliyken, yalniz ${DEVICE_ID})`);

    // Bonus: ikinci bagimsiz kapi — anon'un yetkisi geri alindigi icin RLS
    // kapaliyken DE anon okuyamiyor.
    const ra = await rest(`devices?select=id&id=eq.${DEVICE_ID}`);
    check("M2 RLS kapaliyken bile anon okuyamiyor (yetki geri alinmis = 2. kapi)",
      ra.status >= 400, `durum=${ra.status} kod=${ra.data?.code ?? "-"}`);
  } finally {
    sql("alter table public.devices enable row level security;");
  }
  {
    const r = await rest(`devices?select=id&id=eq.${DEVICE_ID}`, { token: tokB });
    check("M3 RLS geri acildi, yabanci yine GOREMIYOR", r.data?.length === 0, `satir=${r.data?.length}`);
  }
  // MUTASYON 2 — telemetry. `telemetry`nin kapisi `devices`'tan BAGIMSIZ
  // (owns_device + geri alinmis yetki); o yuzden ayrica olculuyor.
  try {
    sql("alter table public.telemetry disable row level security;");
    sql("grant select on public.telemetry to authenticated;");
    const r = await rest(`telemetry?select=temp_c&device_id=eq.${DEVICE_ID}`, { token: tokB });
    check("M4 MUTASYON: telemetry RLS'i kapatilinca yabanci satiri GORUYOR (N3 canli)",
      (r.data?.length ?? 0) >= 1, `satir=${r.data?.length} durum=${r.status}`);
  } finally {
    sql("alter table public.telemetry enable row level security;");
    sql("revoke all on public.telemetry from authenticated; grant select on public.telemetry to authenticated;");
  }
  {
    const r = await rest(`telemetry?select=temp_c&device_id=eq.${DEVICE_ID}`, { token: tokB });
    check("M5 telemetry RLS geri acildi, yabanci yine GOREMIYOR", r.data?.length === 0,
      `satir=${r.data?.length}`);
    const own = await rest(`telemetry?select=temp_c`, { token: tokA });
    check("M6 ...ve SAHIBI hala goruyor (geri alma dogru yapildi)", (own.data?.length ?? 0) >= 1,
      `sahip_satir=${own.data?.length}`);
  }
}

// --- temizlik ---
await rest(`devices?id=eq.${DEVICE_ID}`, { token: SERVICE, method: "DELETE" });

const failed = results.filter((r) => !r.pass);
console.log(`\n==== ${results.length} olcum: ${results.length - failed.length} gecti, ${failed.length} kaldi ====`);
if (failed.length) {
  for (const f of failed) console.log(`  KALDI: ${f.name} — ${f.detail}`);
  process.exit(1);
}
