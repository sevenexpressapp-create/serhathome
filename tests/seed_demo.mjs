// Yerel yigina PANEL TESTI icin ornek veri basar. YALNIZ yerel Supabase'e
// yazar (127.0.0.1); bulut projelerine dokunmaz.
//   npx supabase start && npx supabase db reset && node tests/seed_demo.mjs
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

const st = JSON.parse(execFileSync("npx", ["-y", "supabase@latest", "status", "-o", "json"],
  { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
if (!st.API_URL.includes("127.0.0.1")) throw new Error("YEREL olmayan hedef — durduruldu");
const H = { apikey: st.SERVICE_ROLE_KEY, Authorization: `Bearer ${st.SERVICE_ROLE_KEY}`, "content-type": "application/json" };

async function user(email, password) {
  let u = await (await fetch(`${st.API_URL}/auth/v1/admin/users`, {
    method: "POST", headers: H, body: JSON.stringify({ email, password, email_confirm: true }),
  })).json();
  if (!u.id) {
    const l = await (await fetch(`${st.API_URL}/auth/v1/admin/users`, { headers: H })).json();
    u = l.users.find((x) => x.email === email);
  }
  return u.id;
}
const post = (t, b, merge) => fetch(`${st.API_URL}/rest/v1/${t}`, {
  method: "POST", headers: merge ? { ...H, Prefer: "resolution=merge-duplicates" } : H, body: JSON.stringify(b),
});

// 1) Verisi olan hesap
const uid = await user("panel@kombi.test", "Kombi-Panel-2026!");
const D = "kombi-salon";
await post("devices", { id: D, owner_id: uid, name: "Salon kombisi", secret_sha256: createHash("sha256").update("panel-test-sir").digest("hex") }, true);
await post("device_settings", { device_id: D, target_c: 21.5, hysteresis_c: 3.0 }, true);
// Kural DEVREDE olan bir durum: yururlukteki hedef 25 (07:00 senaryosu),
// taban 21.5. Panel "su an neden 25?" sorusunu cevaplayabilmeli (K1).
await post("device_state", {
  device_id: D, temp_c: 20.4, humidity: 54, relay_on: true, sensor_ok: true, time_valid: true,
  rules_suspended: false, target_c: 25.0, base_target_c: 21.5, rule_active: true,
  active_rule_hour: 7, active_rule_minute: 0, reason: "below_band", uptime_s: 3600,
  wifi_rssi: -58, fw_version: "kombi-fw 0.2.0-faz1", last_seen_at: new Date().toISOString(),
}, true);
await post("scenario_rules", { device_id: D, days_mask: 62, hour: 7, minute: 0, target_c: 22 });
await post("scenario_rules", { device_id: D, days_mask: 127, hour: 23, minute: 0, target_c: 18 });

// --- telemetri: URUNUN GERCEK RITMI + iki bilincli uc hal -------------------
// Eskiden tohum 5 DAKIKADA bir satir yaziyordu; kartin kurali ise "bir satir =
// bir kadans kadar yanma". Kadans artik veriden olculuyor ama tohumun uretimle
// ayni ritimde olmasi sart: panel testi kartin gercekte gorecegi seriyi
// olcmeli. Cihaz 60 sn'de bir yaziyor (device-sync TELEMETRY_MIN_GAP_MS).
//
// Iki uc hal BILEREK konuldu, ikisi de panel testinde olculuyor:
//   · 90 dakikalik KAYIT BOSLUGU (cihaz susmus) — serit bunu koprulememeli
//   · yanan bir dizinin ORTASINDA iki satirlik `temp_c = null` (DHT11'de
//     olagan) — kayit VAR, yalniz sicaklik okunamamis; yanma BOLUNMEMELI
const KADANS_MS = 60e3;
const PENCERE_DK = 24 * 60;
const BOSLUK_BAS_DK = 9 * 60;      // simdiden 9 saat once basliyor
const BOSLUK_SURE_DK = 90;
const SENSOR_BOS_DK = 3 * 60;      // simdiden 3 saat once, iki satir
const now = Date.now();
const rows = [];
let temp = 21.4, heat = true;
for (let i = PENCERE_DK; i >= 0; i--) {
  const t = now - i * KADANS_MS;
  // Histerezis: yakma 23,5 / sondurme 26,5 (hedef 25,0 · bant 3,0) yerine
  // tohumun kendi dar salinimi korunuyor; onemli olan fiziksel tutarlilik.
  if (heat) { temp += 0.03; if (temp >= 23.0) heat = false; }
  else { temp -= 0.02; if (temp <= 20.0) heat = true; }
  if (i <= BOSLUK_BAS_DK && i > BOSLUK_BAS_DK - BOSLUK_SURE_DK) continue;   // KAYIT YOK
  const sensorBos = i <= SENSOR_BOS_DK && i > SENSOR_BOS_DK - 2;
  if (sensorBos) heat = true;      // bosluk yanan bir dizinin ORTASINDA olsun
  rows.push({
    device_id: D, ts: new Date(t).toISOString(),
    temp_c: sensorBos ? null : Math.round(temp * 10) / 10,
    humidity: sensorBos ? null : 52 + (i % 7),
    relay_on: heat, target_c: 25.0,
  });
}
// Son satir YANIK olsun: `device_state.relay_on = true` ile tutarli ve kartin
// "su an X dk yaniyor" dali olculebilir kalsin.
for (let k = rows.length - 12; k < rows.length; k++) rows[k].relay_on = true;

// Tohum IDEMPOTENT: eski kosumun satirlari ustune binmesin (yerel yigin).
await fetch(`${st.API_URL}/rest/v1/telemetry?device_id=eq.${D}&ts=gte.${new Date(now - 26 * 3600e3).toISOString()}`,
  { method: "DELETE", headers: { ...H, Prefer: "return=minimal" } });
for (let i = 0; i < rows.length; i += 500) await post("telemetry", rows.slice(i, i + 500));

// 2) BOS hesap — "veri yokken uydurma deger gosterilmiyor" testi icin
const uid2 = await user("bos@kombi.test", "Kombi-Bos-2026!x");
await post("devices", { id: "kombi-bos", owner_id: uid2, name: "Yeni kombi", secret_sha256: createHash("sha256").update("bos").digest("hex") }, true);

// Panel testi bu sayilari bagimsiz dogrulama tarafi olarak kullanabilsin.
const yanan = rows.filter((r) => r.relay_on).length;
const gece = new Date(); gece.setHours(0, 0, 0, 0);
console.log(JSON.stringify({
  satir: rows.length, yanan,
  bugunYanan: rows.filter((r) => r.relay_on && Date.parse(r.ts) >= gece.getTime()).length,
  kayitBoslugu_dk: BOSLUK_SURE_DK, sensorBosSatir: rows.filter((r) => r.temp_c === null).length,
}));
console.log("tohum veri hazir: panel@kombi.test (dolu) + bos@kombi.test (bos)");
console.log("NOT: parolalar auth politikasina gore (>=12 krk + karmasiklik) guncellendi;");
console.log("     tests/panel_test.mjs ayni degerleri kullanir.");
