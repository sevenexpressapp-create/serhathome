// K1 + K2 + Y1 + Y7'nin UCU UCA olcumu: GERCEK karar cekirdegi + GERCEK HTTP +
// GERCEK Edge Function + GERCEK Postgres. "wifi=down" ile olculemeyen sey tam
// olarak buydu: kural motoru ile bulut yolunun AYNI ANDA kosmasi.
//
// Nasil kuruldu:
//   · Karar mantigi `firmware/tools/core_cli` ile surulur — bu alet cihazdaki
//     kodun KENDISINI (lib/kombi_core, `applyCloudState` dahil) kullanir.
//   · Bulut yolu gercek `device-sync` fonksiyonuna POST atilarak kosturulur.
//   · Cihazin gonderdigi govde `firmware/src/cloud.h` ile ayni alanlardir.
//
// Calistirma:
//   npx supabase start && npx supabase db reset
//   npx supabase functions serve --no-verify-jwt       (ayri terminalde)
//   c++ -std=gnu++17 -O1 -I firmware/lib/kombi_core \
//       firmware/lib/kombi_core/kombi_core.cpp firmware/tools/core_cli/main.cpp -o /tmp/core_cli
//   CORE_CLI=/tmp/core_cli node tests/sync_test.mjs
//
// NEGATIF KONTROL: `tests/negatif_kontrol.sh` ayni testi, cekirdegi kasitli
// bozulmus bir kopyayla kosar; test KIRMIZIYA donmek zorundadir.

import { execFileSync, spawn } from "node:child_process";
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
const CORE_CLI = process.env.CORE_CLI;
if (!CORE_CLI) {
  console.error("CORE_CLI ortam degiskeni gerekli (core_cli ikilisinin yolu).");
  process.exit(2);
}

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "GECTI " : "KALDI "} ${name}${detail ? " — " + detail : ""}`);
};

// --- core_cli surucusu -------------------------------------------------------
class Core {
  constructor() {
    this.p = spawn(CORE_CLI, { stdio: ["pipe", "pipe", "inherit"] });
    this.buf = "";
    this.queue = [];
    this.p.stdout.on("data", (d) => {
      this.buf += d.toString();
      let i;
      while ((i = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, i);
        this.buf = this.buf.slice(i + 1);
        const w = this.queue.shift();
        if (w) w(line);
      }
    });
  }
  cmd(text) {
    return new Promise((res) => {
      this.queue.push(res);
      this.p.stdin.write(text + "\n");
    });
  }
  async state(line) {
    const out = line ?? (await this.cmd("state"));
    const o = {};
    for (const part of out.split(/\s+/)) {
      const [k, v] = part.split("=");
      if (v === undefined) continue;
      o[k] = /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v;
    }
    return o;
  }
  close() { this.p.stdin.write("quit\n"); }
}

// --- REST yardimcilari (service_role; cihazin Edge Function'i da boyle yazar) --
async function rest(path, { method = "GET", body, prefer } = {}) {
  const headers = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, "content-type": "application/json" };
  if (prefer) headers.Prefer = prefer;
  const res = await fetch(`${URL_}/rest/v1/${path}`, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch { data = text; } }
  return { status: res.status, data };
}

const sha = (x) => createHash("sha256").update(x).digest("hex");
const stamp = Date.now();
const DEV = "kombi-sync-" + stamp;
const SECRET = "sync-" + "a".repeat(40);

async function adminUser(email) {
  const res = await fetch(`${URL_}/auth/v1/admin/users`, {
    method: "POST",
    headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, "content-type": "application/json" },
    body: JSON.stringify({ email, password: "Kombi-Sync-2026!x", email_confirm: true }),
  });
  return (await res.json()).id;
}

// Cihazin bir senkron turu: core_cli'den durumu al -> govdeyi KUR -> POST ->
// donen ayar/kurali core_cli'ye uygula. (cloud.h ile ayni alanlar.)
async function syncRound(core, st) {
  const body = {
    device_id: DEV,
    temp_c: st.has ? 20.0 : null,
    humidity: st.has ? 48 : null,
    relay_on: st.heat === 1,
    sensor_ok: st.fault === 0,
    time_valid: true,
    rules_suspended: st.susp === 1,
    target_c: st.eff,
    base_target_c: st.base,
    rule_active: st.rule === 1,
    active_rule_hour: st.rule === 1 ? st.rh : null,
    active_rule_minute: st.rule === 1 ? st.rm : null,
    reason: st.reason,
    uptime_s: 120,
    wifi_rssi: -58,
    fw_version: "kombi-fw 0.2.0-faz1",
  };
  const res = await fetch(FN, {
    method: "POST",
    headers: { "content-type": "application/json", "x-device-id": DEV, "x-device-secret": SECRET },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (res.status !== 200) throw new Error("device-sync " + res.status + " " + JSON.stringify(data));
  const g = data.settings;
  const parts = [
    "cloud", g ? 1 : 0, g?.target_c ?? 21, g?.hysteresis_c ?? 3, g?.freeze_guard_c ?? 6,
    g?.manual_mode ? 1 : 0, g?.min_relay_hold_s ?? 300, g?.sensor_timeout_s ?? 120,
    data.rules.length,
  ];
  for (const r of data.rules) parts.push(r.days_mask, r.hour, r.minute, r.target_c);
  const line = await core.cmd(parts.join(" "));
  const applied = {};
  for (const p of line.split(/\s+/)) {
    const [k, v] = p.split("=");
    if (v !== undefined) applied[k] = Number(v);
  }
  return { cloud: data, applied };
}

// ===========================================================================
const uid = await adminUser(`sync+${stamp}@kombi.test`);
await rest("devices", { method: "POST", body: { id: DEV, owner_id: uid, secret_sha256: sha(SECRET) } });
await rest("device_settings", { method: "POST", body: { device_id: DEV, target_c: 21.0 } });
await rest("scenario_rules", {
  method: "POST", body: { device_id: DEV, days_mask: 127, hour: 17, minute: 0, target_c: 25 },
});

const core = new Core();
await core.cmd("boot 21 3 6 0 300 120");
await core.cmd("rule 127 17 0 25");
await core.cmd("rules-apply");

// --- C1: kural yururluge giriyor (17:05, saat GECERLI) ----------------------
let st = await core.state(await core.cmd("tick 1000 20.0 1 3 17 5"));
check("C1 kural yururlukte: yururlukteki hedef 25, taban 21",
  st.eff === 25 && st.base === 21 && st.rule === 1,
  `eff=${st.eff} base=${st.base} rule=${st.rule}`);

// --- C2 (K1): BULUT BAGLIYKEN 6 tur — hedef geri ALINMIYOR ------------------
// Eski kodda 2. turda `cur.target_c(25) != ns.target_c(21)` -> setSettings(21)
// ve hedef ~5 sn icinde 21'e donuyordu.
let persistTotal = 0;
let minEff = 99;
for (let i = 0; i < 6; i++) {
  const r = await syncRound(core, st);
  persistTotal += r.applied.persist;
  st = await core.state(await core.cmd(`tick ${31000 + i * 30000} 20.0 1 3 17 ${10 + i * 5}`));
  minEff = Math.min(minEff, st.eff);
}
check("C2 (K1) bulut bagliyken 6 senkron turu: yururlukteki hedef 25 KALDI",
  minEff === 25 && st.eff === 25 && st.base === 21 && st.rule === 1,
  `son eff=${st.eff} en kucuk eff=${minEff} base=${st.base}`);
check("C3 (Y1) ayni veri gelen 6 turda NVS yazmasi istenmedi",
  persistTotal === 0 && st.nvs === 0, `persist toplami=${persistTotal} nvs=${st.nvs}`);

// --- C4: bulutta YAZILI olan taban hedef degismedi (kural tabani ezmiyor) ---
{
  const r = await rest(`device_settings?device_id=eq.${DEV}&select=target_c`);
  check("C4 (K1) bulut TABAN hedefi hala 21 (cihaz kural hedefini tabana yazmadi)",
    Number(r.data?.[0]?.target_c) === 21, `target_c=${r.data?.[0]?.target_c}`);
}

// --- C5: panel "su an neden 25?" sorusunu cevaplayabiliyor ------------------
{
  const r = await rest(`device_state?device_id=eq.${DEV}&select=target_c,base_target_c,rule_active,active_rule_hour,active_rule_minute,reason`);
  const row = r.data?.[0];
  check("C5 (K1) device_state: yururlukteki 25 + taban 21 + rule_active + 17:00",
    Number(row?.target_c) === 25 && Number(row?.base_target_c) === 21 && row?.rule_active === true &&
    row?.active_rule_hour === 17 && row?.active_rule_minute === 0, JSON.stringify(row));
}

// --- C6: PANELDEN hedef degisikligi CALISIYOR (kural penceresi icinde bile) -
// K1 duzeltmesi "kural hep kazanir" demek olmamali; kullanici 17:30'da
// panelden 23 yazarsa cihaz onu uygulamali.
{
  await rest(`device_settings?device_id=eq.${DEV}`, { method: "PATCH", body: { target_c: 23.0 } });
  const r = await syncRound(core, st);
  st = await core.state(await core.cmd("tick 400000 20.0 1 3 17 45"));
  check("C6 panelden yazilan hedef kural penceresinde de UYGULANIYOR",
    r.applied.persist === 1 && st.eff === 23 && st.base === 23 && st.ovr === 1,
    `persist=${r.applied.persist} eff=${st.eff} base=${st.base} ovr=${st.ovr}`);
}
// ...ve bir SONRAKI kural tetiklenince kural yeniden devralir.
{
  await rest("scenario_rules", {
    method: "POST", body: { device_id: DEV, days_mask: 127, hour: 23, minute: 0, target_c: 18 },
  });
  const r = await syncRound(core, st);
  st = await core.state(await core.cmd("tick 430000 20.0 1 3 23 1"));
  check("C7 sonraki kural (23:00 -> 18) elle hedefi DEVRALIYOR",
    st.eff === 18 && st.rule === 1 && st.ovr === 0 && st.base === 23,
    `eff=${st.eff} rule=${st.rule} ovr=${st.ovr} base=${st.base} (kural indi=${r.cloud.rules.length})`);
}

// --- C8 (K2): ELEKTRIK KESINTISI — 16:00 kesinti, 18:05 acilis -------------
// Cihaz sifirdan aciliyor (NVS'ten taban 23), bulut bagli. 17:00 kurali
// uygulanmali ve bulut turu onu geri almamali.
{
  await core.cmd("boot 23 3 6 0 300 120");          // acilis: NVS'ten taban hedef
  st = await core.state(await core.cmd("tick 1000 18.0 1 3 18 5"));
  const before = { eff: st.eff, rule: st.rule, rh: st.rh };
  const r = await syncRound(core, st);
  st = await core.state(await core.cmd("tick 31000 18.0 1 3 18 6"));
  check("C8 (K2) 16:00 kesinti -> 18:05 acilis: kacirilan 17:00 kurali YURURLUKTE (bulut turundan sonra da)",
    before.eff === 25 && before.rule === 1 && before.rh === 17 && st.eff === 25 && st.rule === 1,
    `acilis eff=${before.eff} rh=${before.rh}, bulut turu sonrasi eff=${st.eff} persist=${r.applied.persist}`);
}

// --- C9 (Y7): GECERLI OKUMA YOKKEN temp NULL gider -------------------------
{
  await core.cmd("boot 21 3 6 0 300 120");
  st = await core.state(await core.cmd("tick 1000 nan 1 3 12 0"));  // hic okuma yok
  const r = await syncRound(core, st);
  const row = (await rest(`device_state?device_id=eq.${DEV}&select=temp_c,humidity,sensor_ok`)).data?.[0];
  const health = (await rest(`device_health?device_id=eq.${DEV}&select=freeze_risk,temp_c`)).data?.[0];
  check("C9 (Y7) okuma yokken temp_c NULL (uydurma 0.0 yok) ve DONMA RISKI yanlis calismiyor",
    row?.temp_c === null && row?.humidity === null && health?.freeze_risk === false,
    `temp_c=${row?.temp_c} humidity=${row?.humidity} freeze_risk=${health?.freeze_risk} (bulut cevabi=${r.cloud.settings ? "ok" : "yok"})`);
}
// POZITIF KONTROL (ayni eksen): gercekten 3 °C ise donma riski GORULUYOR.
{
  st = await core.state(await core.cmd("tick 3000 3.0 1 3 12 1"));
  const body = {
    device_id: DEV, temp_c: 3.0, humidity: 40, relay_on: true, sensor_ok: true, time_valid: true,
    rules_suspended: false, target_c: st.eff, base_target_c: st.base, rule_active: st.rule === 1,
    active_rule_hour: null, active_rule_minute: null, reason: st.reason, uptime_s: 1, wifi_rssi: -50,
    fw_version: "kombi-fw 0.2.0-faz1",
  };
  await fetch(FN, {
    method: "POST",
    headers: { "content-type": "application/json", "x-device-id": DEV, "x-device-secret": SECRET },
    body: JSON.stringify(body),
  });
  const health = (await rest(`device_health?device_id=eq.${DEV}&select=freeze_risk,temp_c`)).data?.[0];
  check("C10 POZITIF KONTROL: gercek 3 °C -> freeze_risk TRUE (yani C9'daki false olu alet degil)",
    health?.freeze_risk === true && Number(health?.temp_c) === 3,
    `temp_c=${health?.temp_c} freeze_risk=${health?.freeze_risk}`);
}

core.close();
await rest(`devices?id=eq.${DEV}`, { method: "DELETE" });

const failed = results.filter((r) => !r.pass);
console.log(`\n==== ${results.length} olcum: ${results.length - failed.length} gecti, ${failed.length} kaldi ====`);
if (failed.length) {
  for (const f of failed) console.log(`  KALDI: ${f.name} — ${f.detail}`);
  process.exit(1);
}
