// `device-sync` Edge Function'in CIHAZ KAPISI oldugunu olcer.
//
// Calistirma (yerel):
//   npx supabase start && npx supabase db reset
//   npx supabase functions serve --no-verify-jwt     (ayri terminalde)
//   node tests/device_sync_test.mjs
//
// Olculen iddialar:
//   1. Dogru sir -> 200 + ayarlar/kurallar (POZITIF KONTROL: kapi aciliyor)
//   2. Yanlis sir / sirsiz / bilinmeyen cihaz -> 401 (ve nedenleri AYIRT EDILEMEZ)
//   3. Cihaz yalniz KENDI satirina yazar: govdeye baska bir device_id konsa bile
//      islem basliktan dogrulanan kimlige uygulanir
//   4. Telemetri sunucu tarafinda araliklanir (ard arda iki cagri = tek satir)
//   5. POST disi yontem -> 405

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

function localStatus() {
  const out = execFileSync("npx", ["-y", "supabase@latest", "status", "-o", "json"], {
    encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
  });
  return JSON.parse(out);
}
const s = process.env.SUPABASE_URL ? null : localStatus();
const URL_ = process.env.SUPABASE_URL ?? s.API_URL;
const SERVICE = process.env.SERVICE_KEY ?? s.SERVICE_ROLE_KEY;
const FN = `${URL_}/functions/v1/device-sync`;

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "GECTI " : "KALDI "} ${name}${detail ? " — " + detail : ""}`);
};

async function rest(path, { method = "GET", body, prefer } = {}) {
  const headers = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, "content-type": "application/json" };
  if (prefer) headers.Prefer = prefer;
  const res = await fetch(`${URL_}/rest/v1/${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch { data = text; } }
  return { status: res.status, data };
}

async function adminUser(email) {
  const res = await fetch(`${URL_}/auth/v1/admin/users`, {
    method: "POST",
    headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, "content-type": "application/json" },
    body: JSON.stringify({ email, password: "Kombi-Test-" + Date.now(), email_confirm: true }),
  });
  return (await res.json()).id;
}

const sha = (x) => createHash("sha256").update(x).digest("hex");
const stamp = Date.now();
const D1 = "kombi-fn-1-" + stamp;
const D2 = "kombi-fn-2-" + stamp;
const SECRET1 = "s1-" + "f".repeat(40);
const SECRET2 = "s2-" + "e".repeat(40);

const uid = await adminUser(`fn+${stamp}@kombi.test`);
await rest("devices", { method: "POST", body: { id: D1, owner_id: uid, secret_sha256: sha(SECRET1) } });
await rest("devices", { method: "POST", body: { id: D2, owner_id: uid, secret_sha256: sha(SECRET2) } });
await rest("device_settings", { method: "POST", body: { device_id: D1, target_c: 22.5, hysteresis_c: 2.5 } });
await rest("scenario_rules", { method: "POST", body: { device_id: D1, days_mask: 127, hour: 17, minute: 0, target_c: 25 } });

const report = {
  temp_c: 20.4, humidity: 48, relay_on: true, sensor_ok: true, time_valid: false,
  rules_suspended: true, target_c: 22.5, reason: "below_band", uptime_s: 42,
  wifi_rssi: -61, fw_version: "kombi-fw 0.1.0-faz1",
};

async function callFn(headers, body = report, method = "POST") {
  const res = await fetch(FN, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: method === "POST" ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch { data = text; } }
  return { status: res.status, data };
}

// 1) POZITIF KONTROL — dogru sirla kapi aciliyor
{
  const r = await callFn({ "x-device-id": D1, "x-device-secret": SECRET1 });
  const ok = r.status === 200 && Number(r.data?.settings?.target_c) === 22.5 &&
    r.data?.rules?.length === 1 && r.data.rules[0].hour === 17;
  check("F1 dogru sir -> 200 + ayar/kural iniyor", ok,
    `durum=${r.status} hedef=${r.data?.settings?.target_c} kural=${r.data?.rules?.length}`);
}
{
  const r = await rest(`device_state?device_id=eq.${D1}&select=temp_c,relay_on,reason,fw_version,last_seen_at`);
  const row = r.data?.[0];
  check("F2 durum satiri yazildi", Number(row?.temp_c) === 20.4 && row?.relay_on === true && row?.reason === "below_band",
    `veri=${JSON.stringify(row)}`);
}

// 2) Kimlik hatalari — hepsi AYNI cevabi vermeli (cihaz kimligi sayilamasin)
const unauthorized = [];
for (const [name, headers] of [
  ["yanlis sir", { "x-device-id": D1, "x-device-secret": "yanlis-sir" }],
  ["baska cihazin sirri", { "x-device-id": D1, "x-device-secret": SECRET2 }],
  ["sirsiz", { "x-device-id": D1 }],
  ["bilinmeyen cihaz", { "x-device-id": "olmayan-cihaz", "x-device-secret": SECRET1 }],
  ["basliksiz", {}],
]) {
  const r = await callFn(headers);
  unauthorized.push(JSON.stringify(r.data));
  check(`F3 ${name} -> 401`, r.status === 401, `durum=${r.status} govde=${JSON.stringify(r.data)}`);
}
check("F4 tum 401 cevaplari AYNI (hangi cihazin var oldugu sizmiyor)",
  new Set(unauthorized).size === 1, `farkli cevap sayisi=${new Set(unauthorized).size}`);

// 3) Cihaz baska cihazin satirina yazamaz
{
  await callFn({ "x-device-id": D1, "x-device-secret": SECRET1 }, { ...report, device_id: D2, temp_c: 1.0 });
  const r2 = await rest(`device_state?device_id=eq.${D2}&select=device_id`);
  const r1 = await rest(`device_state?device_id=eq.${D1}&select=temp_c`);
  check("F5 govdedeki yabanci device_id YOK SAYILIYOR (2. cihaz satiri olusmadi)",
    (r2.data?.length ?? 0) === 0 && Number(r1.data?.[0]?.temp_c) === 1.0,
    `d2_satir=${r2.data?.length} d1_temp=${r1.data?.[0]?.temp_c}`);
}

// 4) Telemetri araliklama
{
  const before = await rest(`telemetry?device_id=eq.${D1}&select=id`);
  await callFn({ "x-device-id": D1, "x-device-secret": SECRET1 });
  await callFn({ "x-device-id": D1, "x-device-secret": SECRET1 });
  const after = await rest(`telemetry?device_id=eq.${D1}&select=id`);
  check("F6 ard arda cagrilar telemetriyi sismiyor (sunucu araliklamasi)",
    after.data?.length === before.data?.length,
    `once=${before.data?.length} sonra=${after.data?.length}`);
}

// 5) Yontem
{
  const r = await callFn({ "x-device-id": D1, "x-device-secret": SECRET1 }, null, "GET");
  check("F7 GET -> 405", r.status === 405, `durum=${r.status}`);
}

// 6) Ayarlar satiri olmayan cihaz: fonksiyon varsayilani olusturuyor
{
  const r = await callFn({ "x-device-id": D2, "x-device-secret": SECRET2 });
  check("F8 ayarsiz cihaza varsayilan ayar uretiliyor",
    r.status === 200 && Number(r.data?.settings?.target_c) === 21,
    `durum=${r.status} hedef=${r.data?.settings?.target_c}`);
}

await rest(`devices?id=in.(${D1},${D2})`, { method: "DELETE" });

const failed = results.filter((r) => !r.pass);
console.log(`\n==== ${results.length} olcum: ${results.length - failed.length} gecti, ${failed.length} kaldi ====`);
if (failed.length) process.exit(1);
