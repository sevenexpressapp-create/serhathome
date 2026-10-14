// device-sync — CIHAZIN TEK KAPISI (plan §6 "Cihaz kimligi").
//
// ESP32 tablolara dogrudan erismez. Buraya POST atar; bu fonksiyon service_role
// ile calisir (RLS'i asar) ama YALNIZCA sirri dogrulanan cihazin kendi satirina
// dokunur. Boylece cihaz sirri sizsa bile saldirgan baska bir cihazin/kullanicinin
// verisine ulasamaz.
//
// Istek  : POST, basliklar `x-device-id` + `x-device-secret`, govde = durum JSON'u
// Cevap  : { settings: {...}, rules: [...], server_time: "..." }
// Hatalar: 401 (kimlik) — nedeni ASLA ayrintilandirilmaz; 400 (bicim); 405 (yontem)
//
// Yayin: `supabase functions deploy device-sync --no-verify-jwt`
//   (cihazda kullanici JWT'si yok; kimlik dogrulamasi cihaz sirriyla yapiliyor)

import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
// Ayni cihazdan gelen her istek icin telemetri satiri yazmayiz; cihaz 30 sn'de
// bir konusuyor, gecmis icin 60 sn yeterli. Kisitlama SUNUCU tarafinda ki
// cihaz yazilimi degisse de tablo sismesin.
const TELEMETRY_MIN_GAP_MS = 55_000;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Sabit sureli karsilastirma: ozetin kac karakteri tuttugu zamanlamadan sizmasin.
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function num(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "yalniz POST" }, 405);

  const deviceId = req.headers.get("x-device-id") ?? "";
  const secret = req.headers.get("x-device-secret") ?? "";
  if (!deviceId || !secret) return json({ error: "yetkisiz" }, 401);

  const db = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false },
  });

  const { data: device, error: devErr } = await db
    .from("devices")
    .select("id, secret_sha256")
    .eq("id", deviceId)
    .maybeSingle();

  // Cihaz yok ile sir yanlis AYNI cevabi verir: hangi cihaz kimliklerinin var
  // oldugu disaridan sayilamasin.
  if (devErr || !device) return json({ error: "yetkisiz" }, 401);
  if (!timingSafeEqual(await sha256Hex(secret), device.secret_sha256)) {
    return json({ error: "yetkisiz" }, 401);
  }

  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    return json({ error: "gecersiz JSON" }, 400);
  }

  // Govdedeki device_id'ye GUVENILMEZ; her zaman basliktan dogrulanan kimlik kullanilir.
  const state = {
    device_id: device.id,
    temp_c: num(body.temp_c),
    humidity: num(body.humidity),
    relay_on: Boolean(body.relay_on),
    sensor_ok: Boolean(body.sensor_ok),
    time_valid: Boolean(body.time_valid),
    rules_suspended: Boolean(body.rules_suspended),
    target_c: num(body.target_c),
    reason: typeof body.reason === "string" ? body.reason.slice(0, 32) : null,
    uptime_s: num(body.uptime_s),
    wifi_rssi: num(body.wifi_rssi),
    fw_version: typeof body.fw_version === "string" ? body.fw_version.slice(0, 48) : null,
    last_seen_at: new Date().toISOString(),
  };

  const { error: stateErr } = await db.from("device_state").upsert(state);
  if (stateErr) return json({ error: "durum yazilamadi" }, 500);

  // Telemetri: sunucu tarafli araliklama.
  const { data: lastRow } = await db
    .from("telemetry")
    .select("ts")
    .eq("device_id", device.id)
    .order("ts", { ascending: false })
    .limit(1)
    .maybeSingle();
  const lastMs = lastRow?.ts ? new Date(lastRow.ts).getTime() : 0;
  if (Date.now() - lastMs >= TELEMETRY_MIN_GAP_MS) {
    await db.from("telemetry").insert({
      device_id: device.id,
      temp_c: state.temp_c,
      humidity: state.humidity,
      relay_on: state.relay_on,
      sensor_ok: state.sensor_ok,
      target_c: state.target_c,
    });
  }

  // Cihazin bildirdigi olay (sensor arizasi, bekci sifirlamasi vb.)
  if (typeof body.event === "string" && body.event.length > 0) {
    await db.from("events").insert({
      device_id: device.id,
      kind: body.event.slice(0, 32),
      detail: typeof body.event_detail === "string" ? body.event_detail.slice(0, 200) : null,
    });
  }

  // Ayarlar yoksa varsayilan satiri olustur (ilk konusma).
  let { data: settings } = await db
    .from("device_settings")
    .select("target_c, hysteresis_c, freeze_guard_c, manual_mode, min_relay_hold_s, sensor_timeout_s")
    .eq("device_id", device.id)
    .maybeSingle();
  if (!settings) {
    await db.from("device_settings").insert({ device_id: device.id });
    const again = await db
      .from("device_settings")
      .select("target_c, hysteresis_c, freeze_guard_c, manual_mode, min_relay_hold_s, sensor_timeout_s")
      .eq("device_id", device.id)
      .maybeSingle();
    settings = again.data;
  }

  const { data: rules } = await db
    .from("scenario_rules")
    .select("enabled, days_mask, hour, minute, target_c")
    .eq("device_id", device.id)
    .eq("enabled", true)
    .order("hour", { ascending: true })
    .order("minute", { ascending: true })
    .limit(12);

  return json({
    settings: settings
      ? {
          target_c: Number(settings.target_c),
          hysteresis_c: Number(settings.hysteresis_c),
          freeze_guard_c: Number(settings.freeze_guard_c),
          manual_mode: settings.manual_mode,
          min_relay_hold_s: settings.min_relay_hold_s,
          sensor_timeout_s: settings.sensor_timeout_s,
        }
      : null,
    rules: (rules ?? []).map((r) => ({
      enabled: r.enabled,
      days_mask: r.days_mask,
      hour: r.hour,
      minute: r.minute,
      target_c: Number(r.target_c),
    })),
    server_time: new Date().toISOString(),
  });
});
