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
const uid = await user("panel@kombi.test", "Kombi-Panel-2026");
const D = "kombi-salon";
await post("devices", { id: D, owner_id: uid, name: "Salon kombisi", secret_sha256: createHash("sha256").update("panel-test-sir").digest("hex") }, true);
await post("device_settings", { device_id: D, target_c: 21.5, hysteresis_c: 3.0 }, true);
await post("device_state", {
  device_id: D, temp_c: 20.4, humidity: 54, relay_on: true, sensor_ok: true, time_valid: true,
  rules_suspended: false, target_c: 21.5, reason: "below_band", uptime_s: 3600, wifi_rssi: -58,
  fw_version: "kombi-fw 0.1.0-faz1", last_seen_at: new Date().toISOString(),
}, true);
await post("scenario_rules", { device_id: D, days_mask: 62, hour: 7, minute: 0, target_c: 22 });
await post("scenario_rules", { device_id: D, days_mask: 127, hour: 23, minute: 0, target_c: 18 });

const rows = [];
let temp = 19.5, heat = true;
const now = Date.now();
for (let i = 288; i >= 0; i--) {
  if (heat) { temp += 0.11; if (temp >= 23.0) heat = false; } else { temp -= 0.07; if (temp <= 20.0) heat = true; }
  rows.push({ device_id: D, ts: new Date(now - i * 5 * 60e3).toISOString(), temp_c: Math.round(temp * 10) / 10, humidity: 52 + (i % 7), relay_on: heat, target_c: 21.5 });
}
await post("telemetry", rows);

// 2) BOS hesap — "veri yokken uydurma deger gosterilmiyor" testi icin
const uid2 = await user("bos@kombi.test", "Kombi-Bos-2026");
await post("devices", { id: "kombi-bos", owner_id: uid2, name: "Yeni kombi", secret_sha256: createHash("sha256").update("bos").digest("hex") }, true);

console.log("tohum veri hazir: panel@kombi.test (dolu) + bos@kombi.test (bos)");
