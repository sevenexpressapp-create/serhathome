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
  const r = await rest(`device_settings?device_id=eq.${DEVICE_ID}`, {
    token: tokB, method: "PATCH", body: { target_c: 30 }, prefer: "return=representation",
  });
  const blocked = r.status >= 400 || (Array.isArray(r.data) && r.data.length === 0);
  check("N4 yabanci hedefi DEGISTIREMIYOR", blocked, `durum=${r.status} veri=${JSON.stringify(r.data)}`);
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
//    RLS'i kapatip ayni yetkisiz sorguyu tekrar kosuyoruz. Satir GELMELI;
//    gelmezse "0 satir" sonucumuz RLS'ten degil baska bir seyden geliyordu.
// =========================================================================
let leaked = -1;
try {
  sql("alter table public.devices disable row level security;");
  const r = await rest(`devices?select=id`, { token: tokB });
  leaked = Array.isArray(r.data) ? r.data.length : -1;
  check("M1 MUTASYON: RLS kapatilinca yabanci cihazi GORUYOR (alet canli)", leaked === 1,
    `satir=${leaked} (RLS kapaliyken)`);

  // Bonus: ikinci bagimsiz kapi — anon'un yetkisi geri alindigi icin RLS
  // kapaliyken DE anon okuyamiyor.
  const ra = await rest(`devices?select=id`);
  check("M2 RLS kapaliyken bile anon okuyamiyor (yetki geri alinmis = 2. kapi)",
    ra.status >= 400, `durum=${ra.status} kod=${ra.data?.code ?? "-"}`);
} finally {
  sql("alter table public.devices enable row level security;");
}
{
  const r = await rest(`devices?select=id`, { token: tokB });
  check("M3 RLS geri acildi, yabanci yine GOREMIYOR", r.data?.length === 0, `satir=${r.data?.length}`);
}

// --- temizlik ---
await rest(`devices?id=eq.${DEVICE_ID}`, { token: SERVICE, method: "DELETE" });

const failed = results.filter((r) => !r.pass);
console.log(`\n==== ${results.length} olcum: ${results.length - failed.length} gecti, ${failed.length} kaldi ====`);
if (failed.length) {
  for (const f of failed) console.log(`  KALDI: ${f.name} — ${f.detail}`);
  process.exit(1);
}
