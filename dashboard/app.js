// Kombi dashboard — statik sayfa, tum veri Supabase'den GIRISTEN SONRA gelir.
// Sayfanin kendisinde veri yok (plan §6). Yazma/okuma yetkisini RLS belirler.
//
// Bos durum kurali: veri yoksa UYDURMA deger gosterilmez, "henuz veri yok" yazar.

"use strict";

const CFG = window.KOMBI_CONFIG || {};
const HISTORY_HOURS = CFG.HISTORY_HOURS || 24;
const POLL_MS = (CFG.POLL_SECONDS || 15) * 1000;
const DAYS = ["Paz", "Pzt", "Sal", "Car", "Per", "Cum", "Cmt"]; // bit0 = Pazar

const $ = (id) => document.getElementById(id);
const show = (el, on) => el.classList.toggle("hidden", !on);

let sb = null;
let device = null;
let settings = null;
let pendingTarget = null;
let pollTimer = null;
// ORTA-4 — HESAPLAR ARASI SIZINTININ YARIS HALI. Oturum degisince ekran
// sifirlaniyor (D10) ama UCUSTAKI yanitlar geri donup yeni hesabin ekranina
// yaziliyordu: A cikar -> B girer -> A'nin 4 istegi doner -> A'nin sicakligi
// B'nin ekraninda. Iki onlem: (1) oturum cagi sayaci, geciken yanit atilir,
// (2) AbortController ile istekler gercekten iptal edilir.
let sessionEpoch = 0;
let inflight = null;

// --- tema (yalniz goruntu tercihi; basarisiz olursa sessizce gecilir) --------
try {
  const saved = localStorage.getItem("kombi-theme");
  if (saved) document.documentElement.dataset.theme = saved;
} catch (_) {}
$("theme-toggle").addEventListener("click", () => {
  const cur = document.documentElement.dataset.theme;
  const next = cur === "dark" ? "light" : cur === "light" ? "" : "dark";
  if (next) document.documentElement.dataset.theme = next;
  else delete document.documentElement.dataset.theme;
  try { localStorage.setItem("kombi-theme", next); } catch (_) {}
  if (device) renderChart(lastRows, settings);
});

// --- kurulum ----------------------------------------------------------------
if (!CFG.SUPABASE_URL || !CFG.SUPABASE_ANON_KEY) {
  show($("config-missing"), true);
  show($("auth-card"), false);
} else {
  sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, storageKey: "kombi-auth" },
  });
  sb.auth.getSession().then(({ data }) => onSession(data.session));
  sb.auth.onAuthStateChange((_e, session) => onSession(session));
}

function onSession(session) {
  const signedIn = Boolean(session);
  const epoch = ++sessionEpoch;           // ORTA-4: bu andan onceki yanitlar gecersiz
  if (inflight) { inflight.abort(); inflight = null; }
  show($("auth-card"), !signedIn);
  show($("app"), signedIn);
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  // HER oturum degisiminde ekrandaki durum SIFIRLANIR. Yoksa cikis/giris
  // sonrasi onceki hesabin degeri (orn. hedef sicaklik) ekranda kaliyor ve
  // verisi olmayan hesapta UYDURMA deger gibi gorunuyor — tarayici olcumunde
  // (D10) tam olarak bu yakalandi.
  resetView();
  if (signedIn) {
    loadDevice(epoch).then(() => {
      if (epoch !== sessionEpoch) return;
      refresh();
      pollTimer = setInterval(refresh, POLL_MS);
      $("poll-note").textContent = `${POLL_MS / 1000} sn'de bir yenilenir`;
    });
  }
}

$("auth-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  show($("auth-err"), false);
  const { error } = await sb.auth.signInWithPassword({
    email: $("email").value.trim(),
    password: $("password").value,
  });
  if (error) { $("auth-err").textContent = "Giris basarisiz: " + error.message; show($("auth-err"), true); }
});
$("signout").addEventListener("click", () => sb.auth.signOut());

// --- veri -------------------------------------------------------------------
async function loadDevice(epoch) {
  const { data, error } = await sb.from("devices").select("id, name").order("created_at").limit(1);
  if (epoch !== sessionEpoch) return;  // ORTA-4: oturum degisti, yaniti AT
  if (error) {
    $("device-name").textContent = "cihaz okunamadi";
    showLoadError("Cihaz listesi okunamadi: " + error.message);
    device = null;
    return;
  }
  if (!data || data.length === 0) {
    $("device-name").textContent = "kayitli cihaz yok";
    device = null;
    return;
  }
  device = data[0];
  $("device-name").textContent = device.name || device.id;
}

// Y6 — HATAYI BOS DURUMDAN AYIR. Eskiden dort sorgunun `.error` alani hic
// okunmuyordu: ag/RLS/oturum hatasi ekranda "Cihaz henuz hic baglanmadi"
// bos durumu gibi gorunuyor, kullanici yanlis teshis koyuyordu.
function showLoadError(msg) {
  const el = $("load-err");
  el.textContent = "Veri okunamadi — gosterilen bilgi guncel OLMAYABILIR. " + msg;
  show(el, true);
}

let lastRows = [];

function resetView() {
  device = null;
  settings = null;
  pendingTarget = null;
  lastRows = [];
  $("device-name").textContent = "—";
  $("target-val").textContent = "—";
  $("target-src").textContent = "—";
  show($("load-err"), false);
  for (const id of ["s-band", "s-freeze", "s-hold"]) $(id).value = "";
  $("s-manual").value = "false";
  renderState(null);
  renderRules([]);
  renderChart([], null);
  renderTable([]);
  show($("t-err"), false);
  show($("s-err"), false);
  show($("r-err"), false);
}

async function refresh() {
  if (!device) return;
  const epoch = sessionEpoch;
  const sinceIso = new Date(Date.now() - HISTORY_HOURS * 3600e3).toISOString();
  if (inflight) inflight.abort();
  const ac = new AbortController();
  inflight = ac;

  let res;
  try {
    res = await Promise.all([
      sb.from("device_state").select("*").eq("device_id", device.id).abortSignal(ac.signal).maybeSingle(),
      sb.from("device_settings").select("*").eq("device_id", device.id).abortSignal(ac.signal).maybeSingle(),
      sb.from("scenario_rules").select("*").eq("device_id", device.id).order("hour").order("minute")
        .abortSignal(ac.signal),
      sb.from("telemetry").select("ts, temp_c, humidity, relay_on")
        .eq("device_id", device.id).gte("ts", sinceIso).order("ts").abortSignal(ac.signal),
    ]);
  } catch (e) {
    // Promise.all REDDI de yakalanmali (eskiden yakalanmiyordu).
    if (epoch === sessionEpoch && e?.name !== "AbortError") showLoadError(String(e?.message || e));
    return;
  } finally {
    if (inflight === ac) inflight = null;
  }
  if (epoch !== sessionEpoch) return;  // ORTA-4: oturum degisti, yaniti AT

  const [stateRes, setRes, ruleRes, telRes] = res;
  // Y6: HER sorgunun hatasi okunur. Iptal (AbortError) hata sayilmaz.
  const errs = [
    ["anlik durum", stateRes.error], ["ayarlar", setRes.error],
    ["kurallar", ruleRes.error], ["gecmis", telRes.error],
  ].filter(([, e]) => e && e.name !== "AbortError" && e.code !== "20");
  if (errs.length) {
    showLoadError(errs.map(([ad, e]) => `${ad}: ${e.message || e.code}`).join(" · "));
  } else {
    show($("load-err"), false);
  }

  settings = setRes.error ? null : (setRes.data || null);
  if (!stateRes.error) renderState(stateRes.data || null);
  renderSettings(settings);
  if (!ruleRes.error) renderRules(ruleRes.data || []);
  if (!telRes.error) {
    lastRows = (telRes.data || []).map((r) => ({
      t: new Date(r.ts).getTime(),
      temp: r.temp_c === null ? null : Number(r.temp_c),
      hum: r.humidity === null ? null : Number(r.humidity),
      heat: Boolean(r.relay_on),
    }));
    renderChart(lastRows, settings);
    renderTable(lastRows);
  }
}

function renderState(st) {
  if (!st) {
    // BOS DURUM: uydurma deger yok.
    $("temp").textContent = "—";
    $("hum").textContent = "—";
    $("target-now").textContent = "—";
    $("target-src").textContent = "—";
    $("online").textContent = "veri yok";
    $("reason").textContent = "—";
    $("relay-text").textContent = "bilinmiyor";
    $("seen").textContent = "Cihaz henuz hic baglanmadi.";
    return;
  }
  const ageS = (Date.now() - new Date(st.last_seen_at).getTime()) / 1000;
  const online = ageS < 600;
  $("temp").textContent = st.temp_c === null ? "—" : Number(st.temp_c).toFixed(1);
  $("hum").textContent = st.humidity === null ? "—" : Number(st.humidity).toFixed(0) + " %";
  $("target-now").textContent = st.target_c === null ? "—" : Number(st.target_c).toFixed(1) + " °C";
  // K1 — "su an neden 25 °C?" Yururlukteki hedefin KAYNAGI yaziliyor: saatli
  // kural mi, elle yazilan taban mi. (Kural artik tabani ezmiyor; ikisi ayri.)
  $("target-src").textContent = targetSourceLabel(st);
  $("online").textContent = online ? "cevrimici" : "SUSTU";
  $("reason").textContent = reasonLabel(st.reason);
  const on = Boolean(st.relay_on);
  $("relay-text").textContent = on ? "Isitma acik" : "Isitma kapali";
  $("relay-pill").querySelector(".dot").style.background = on ? "var(--series-2)" : "var(--muted)";
  $("seen").textContent = "Son veri: " + fmtAge(ageS) + " once (" + new Date(st.last_seen_at).toLocaleString("tr-TR") + ")";

  const problems = [];
  if (!online) problems.push("Cihaz 10 dakikadan uzun suredir veri gondermiyor.");
  if (st.sensor_ok === false) problems.push("SENSOR ARIZASI: isi istegi kesildi.");
  if (st.temp_c !== null && Number(st.temp_c) < 6) problems.push("DONMA RISKI: oda 6 °C altinda.");
  if (st.rules_suspended) problems.push("Cihazin saati dogrulanmadi: saatli senaryolar askida, termostat son hedefle suruyor.");
  $("alerts").innerHTML = problems.map((p) => "• " + p).join("<br>");
  show($("alerts"), problems.length > 0);
}

function targetSourceLabel(st) {
  if (st.target_c === null) return "—";
  const base = st.base_target_c === null || st.base_target_c === undefined
    ? null : Number(st.base_target_c);
  if (st.rule_active) {
    const hh = String(st.active_rule_hour ?? 0).padStart(2, "0");
    const mm = String(st.active_rule_minute ?? 0).padStart(2, "0");
    return `${hh}:${mm} senaryosu` + (base === null ? "" : ` (taban ${base.toFixed(1)} °C)`);
  }
  if (st.rules_suspended) return "saat dogrulanmadi, taban hedef";
  if (st.rule_active === false && base !== null && Number(st.target_c) === base) return "elle ayarlanan hedef";
  return base === null ? "—" : `taban ${base.toFixed(1)} °C`;
}

function reasonLabel(r) {
  return ({
    boot: "aciliyor", sensor_fault: "sensor arizasi", freeze_guard: "donma korumasi",
    below_band: "hedefin altinda", above_band: "hedefin ustunde", in_band: "bant icinde",
    min_hold: "asgari bekleme",
  })[r] || (r || "—");
}

function fmtAge(s) {
  if (s < 90) return Math.round(s) + " sn";
  if (s < 5400) return Math.round(s / 60) + " dk";
  return Math.round(s / 3600) + " saat";
}

// --- hedefin alt siniri SEMA KISITINDAN turer -------------------------------
// Sema: `freeze_guard_c <= target_c - 0.5` (device_settings_freeze_below_target).
// Yani donma esigi 6,0 iken en kucuk KAYDEDILEBILIR hedef 6,5'tir; 6,0 ve alti
// 23514 ile reddedilir (yerel yiginda olculdu: 6,5 -> 204, 6,0/5,5/5,0 -> 400).
// Sayac eskiden sabit 5 °C'ye kadar iniyordu, yani veritabaninin ASLA
// kaydedemeyecegi bir hedef sunuyor ve ham Ingilizce kisit metnini ekrana
// basiyordu. "Evde yokken 5-6 °C'ye dusur" senaryosu bu yuzden tikaliydi.
const KISIT_PAYI_C = 0.5;      // sema: freeze_guard_c <= target_c - 0.5
const HEDEF_TAVAN_C = 30;      // sema: target_c <= 30
const HEDEF_SEMA_TABAN_C = 5;  // sema: target_c >= 5

const vir = (n) => Number(n).toFixed(1).replace(".", ",");   // 6 -> "6,0"

// YURURLUKTEKI (kaydedilmis) donma esigine gore alt sinir. Panelde henuz
// kaydedilmemis bir donma esigi varsa O KULLANILMAZ: sayac yine veritabaninin
// reddedecegi bir yere acilmis olurdu.
function enAzHedefC(s = settings) {
  const f = s === null || s === undefined ? NaN : Number(s.freeze_guard_c);
  if (!Number.isFinite(f)) return HEDEF_SEMA_TABAN_C;
  return Math.max(HEDEF_SEMA_TABAN_C, f + KISIT_PAYI_C);
}

// Postgres kisit hatasini (23514) kullaniciya DONUK bir cumleye cevirir. Ham
// Ingilizce govde ('new row for relation "device_settings" violates check
// constraint ...' + 'Failing row contains (...)') kullaniciya GOSTERILMEZ.
function kisitMetni(error, hangi) {
  const ham = `${error?.code ?? ""} ${error?.message ?? ""} ${error?.details ?? ""}`;
  if (/freeze_below_target/.test(ham)) {
    const f = settings === null ? NaN : Number(settings.freeze_guard_c);
    const t = settings === null ? NaN : Number(settings.target_c);
    if (hangi === "hedef") {
      return "Kaydedilemedi. Donma esigi" + (Number.isFinite(f) ? ` (${vir(f)} °C)` : "") +
        " hedefin en az 0,5 °C altinda kalmali" +
        (Number.isFinite(f) ? `, yani hedef en az ${vir(f + KISIT_PAYI_C)} °C olabilir` : "") +
        ". Daha dusuk bir hedef icin once asagidaki ayarlardan donma esigini dusurup kaydedin.";
    }
    return "Kaydedilemedi. Donma esigi, hedefin" + (Number.isFinite(t) ? ` (${vir(t)} °C)` : "") +
      " en az 0,5 °C altinda kalmali" +
      (Number.isFinite(t) ? `, yani en fazla ${vir(t - KISIT_PAYI_C)} °C girebilirsiniz` : "") + ".";
  }
  if (error?.code === "23514") {
    return "Kaydedilemedi: girilen deger izin verilen araligin disinda. Degeri kontrol edip tekrar deneyin.";
  }
  return "Kaydedilemedi: " + (error?.message ?? "bilinmeyen hata");
}

function renderSettings(s) {
  if (!s) {
    // Ayar satiri henuz yok (cihaz hic konusmadi): bos goster, tahmin uretme.
    pendingTarget = null;
    $("target-val").textContent = "—";
    return;
  }
  if (pendingTarget === null) pendingTarget = Number(s.target_c);
  // Donma esigi degisince hedefin alt siniri DA degisir: bekleyen deger
  // kaydedilemez bir yerde kalmasin.
  pendingTarget = Math.min(HEDEF_TAVAN_C, Math.max(enAzHedefC(s), pendingTarget));
  $("target-val").textContent = pendingTarget.toFixed(1);
  $("s-band").value = Number(s.hysteresis_c);
  $("s-freeze").value = Number(s.freeze_guard_c);
  $("s-hold").value = s.min_relay_hold_s;
  $("s-manual").value = String(s.manual_mode);
}

$("t-minus").addEventListener("click", () => bumpTarget(-0.5));
$("t-plus").addEventListener("click", () => bumpTarget(0.5));
function bumpTarget(d) {
  if (pendingTarget === null) return;
  const lo = enAzHedefC();
  pendingTarget = Math.min(HEDEF_TAVAN_C, Math.max(lo, Math.round((pendingTarget + d) * 2) / 2));
  $("target-val").textContent = pendingTarget.toFixed(1);
  // Alt sinira dayanildiysa yol TIKALI degil: sirasi anlatilir.
  if (d < 0 && pendingTarget <= lo && lo > HEDEF_SEMA_TABAN_C) {
    $("t-err").textContent =
      `Donma esigi ${vir(settings.freeze_guard_c)} °C oldugu icin hedef en az ${vir(lo)} °C olabilir. ` +
      "Daha dusuk bir hedef icin once asagidaki ayarlardan donma esigini dusurup kaydedin.";
    show($("t-err"), true);
  } else {
    show($("t-err"), false);
  }
}
$("t-save").addEventListener("click", async () => {
  show($("t-err"), false);
  if (pendingTarget === null || !device) {
    $("t-err").textContent = "Cihaz henuz ayar bildirmedi; hedef yazilamaz.";
    show($("t-err"), true);
    return;
  }
  const { error } = await sb.from("device_settings")
    .update({ target_c: pendingTarget, updated_at: new Date().toISOString() })
    .eq("device_id", device.id);
  if (error) { $("t-err").textContent = kisitMetni(error, "hedef"); show($("t-err"), true); return; }
  refresh();
});

$("s-save").addEventListener("click", async () => {
  show($("s-err"), false);
  const { error } = await sb.from("device_settings").update({
    hysteresis_c: Number($("s-band").value),
    freeze_guard_c: Number($("s-freeze").value),
    min_relay_hold_s: Number($("s-hold").value),
    manual_mode: $("s-manual").value === "true",
    updated_at: new Date().toISOString(),
  }).eq("device_id", device.id);
  if (error) { $("s-err").textContent = kisitMetni(error, "ayar"); show($("s-err"), true); return; }
  refresh();
});

// --- kurallar ---------------------------------------------------------------
const dayState = [false, true, true, true, true, true, false]; // varsayilan: hafta ici
DAYS.forEach((d, i) => {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = d;
  b.style.minWidth = "52px";
  const paint = () => {
    b.style.background = dayState[i] ? "var(--series-1)" : "var(--surface)";
    b.style.color = dayState[i] ? "#fff" : "var(--text)";
    b.setAttribute("aria-pressed", String(dayState[i]));
  };
  b.addEventListener("click", () => { dayState[i] = !dayState[i]; paint(); });
  paint();
  $("r-days").appendChild(b);
});

function maskLabel(mask) {
  const names = [];
  for (let i = 0; i < 7; i++) if ((mask >> i) & 1) names.push(DAYS[i]);
  if (mask === 127) return "Her gun";
  if (mask === 62) return "Hafta ici";
  if (mask === 65) return "Hafta sonu";
  return names.join(" ");
}

function renderRules(rows) {
  const tb = $("rules").querySelector("tbody");
  tb.innerHTML = "";
  show($("rules-empty"), rows.length === 0);
  show($("rules"), rows.length > 0);
  for (const r of rows) {
    const tr = document.createElement("tr");
    tr.innerHTML =
      `<td>${maskLabel(r.days_mask)}${r.enabled ? "" : " (kapali)"}</td>` +
      `<td class="num">${String(r.hour).padStart(2, "0")}:${String(r.minute).padStart(2, "0")}</td>` +
      `<td class="num">${Number(r.target_c).toFixed(1)} °C</td>`;
    const td = document.createElement("td");
    const del = document.createElement("button");
    del.className = "link";
    del.type = "button";
    del.textContent = "sil";
    del.addEventListener("click", async () => {
      await sb.from("scenario_rules").delete().eq("id", r.id);
      refresh();
    });
    td.appendChild(del);
    tr.appendChild(td);
    tb.appendChild(tr);
  }
}

$("r-add").addEventListener("click", async () => {
  show($("r-err"), false);
  let mask = 0;
  for (let i = 0; i < 7; i++) if (dayState[i]) mask |= 1 << i;
  if (mask === 0) { $("r-err").textContent = "En az bir gun secin."; show($("r-err"), true); return; }
  const { error } = await sb.from("scenario_rules").insert({
    device_id: device.id,
    days_mask: mask,
    hour: Number($("r-hour").value),
    minute: Number($("r-min").value),
    target_c: Number($("r-target").value),
  });
  if (error) {
    // Cakisan kural tetikleyicisi buradan geri doner (ayni dakika + cakisan gun).
    $("r-err").textContent = "Eklenemedi: " + error.message;
    show($("r-err"), true);
    return;
  }
  refresh();
});

// --- tablo (erisilebilirlik: grafigin metin karsiligi) ----------------------
function renderTable(rows) {
  const tb = $("data-table").querySelector("tbody");
  tb.innerHTML = "";
  for (const r of rows.slice(-60).reverse()) {
    const tr = document.createElement("tr");
    tr.innerHTML =
      `<td>${new Date(r.t).toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" })}</td>` +
      `<td class="num">${r.temp === null ? "—" : r.temp.toFixed(1)}</td>` +
      `<td class="num">${r.hum === null ? "—" : r.hum.toFixed(0) + " %"}</td>` +
      `<td>${r.heat ? "acik" : "kapali"}</td>`;
    tb.appendChild(tr);
  }
}

// --- grafik -----------------------------------------------------------------
// Tek seri (oda sicakligi) cizgi + isitma dilimlerini gosteren seritli alt bant
// + hedefin kesikli cizgisi. Tek eksen; ikinci bir y ekseni YOK.
const SVG_NS = "http://www.w3.org/2000/svg";
function el(name, attrs) {
  const n = document.createElementNS(SVG_NS, name);
  for (const k in attrs) n.setAttribute(k, attrs[k]);
  return n;
}

function renderChart(rows, s) {
  const svg = $("chart");
  svg.innerHTML = '<title id="chart-title">Oda sicakligi, son ' + HISTORY_HOURS + " saat</title>";
  const pts = rows.filter((r) => r.temp !== null);
  show($("chart-empty"), pts.length < 2);
  if (pts.length < 2) { svg.style.height = "0px"; chartCtx = null; return; }
  svg.style.height = "240px";

  const w = svg.clientWidth || 360;
  const h = 240;
  const m = { t: 12, r: 10, b: 38, l: 34 };
  const ribbonH = 10;
  const plotH = h - m.t - m.b - ribbonH - 6;
  const plotW = w - m.l - m.r;
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);

  const xs = pts.map((p) => p.t);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  const temps = pts.map((p) => p.temp);
  const target = s ? Number(s.target_c) : null;
  let lo = Math.min(...temps, target ?? Infinity) - 1;
  let hi = Math.max(...temps, target ?? -Infinity) + 1;
  if (hi - lo < 4) { const c = (hi + lo) / 2; lo = c - 2; hi = c + 2; }
  const X = (t) => m.l + ((t - x0) / Math.max(1, x1 - x0)) * plotW;
  const Y = (v) => m.t + plotH - ((v - lo) / (hi - lo)) * plotH;

  // y ekseni: 4 adim, cekingen izgara
  const steps = 4;
  for (let i = 0; i <= steps; i++) {
    const v = lo + ((hi - lo) * i) / steps;
    const y = Y(v);
    svg.appendChild(el("line", { x1: m.l, x2: m.l + plotW, y1: y, y2: y, stroke: "var(--grid)", "stroke-width": 1 }));
    const tx = el("text", { x: m.l - 6, y: y + 4, "text-anchor": "end", fill: "var(--muted)", "font-size": 11 });
    tx.textContent = v.toFixed(0);
    svg.appendChild(tx);
  }
  // x ekseni: bas/orta/son saat
  for (const t of [x0, (x0 + x1) / 2, x1]) {
    const tx = el("text", {
      x: X(t), y: h - 16,
      "text-anchor": t === x0 ? "start" : t === x1 ? "end" : "middle",
      fill: "var(--muted)", "font-size": 11,
    });
    tx.textContent = new Date(t).toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" });
    svg.appendChild(tx);
  }

  // hedef cizgisi (kesikli, cekingen) + dogrudan etiket
  if (target !== null && target >= lo && target <= hi) {
    svg.appendChild(el("line", {
      x1: m.l, x2: m.l + plotW, y1: Y(target), y2: Y(target),
      stroke: "var(--muted)", "stroke-width": 1.5, "stroke-dasharray": "5 4",
    }));
    const lbl = el("text", { x: m.l + plotW, y: Y(target) - 5, "text-anchor": "end", fill: "var(--text-2)", "font-size": 11 });
    lbl.textContent = "hedef " + target.toFixed(1) + " °C";
    svg.appendChild(lbl);
  }

  // isitma seridi: ardisik "acik" araliklari tek dikdortgen olarak ciz
  const ry = m.t + plotH + 6;
  let i = 0;
  while (i < pts.length) {
    if (!pts[i].heat) { i++; continue; }
    let j = i;
    while (j + 1 < pts.length && pts[j + 1].heat) j++;
    const xa = X(pts[i].t);
    const xb = Math.max(X(pts[j].t), xa + 2);
    svg.appendChild(el("rect", {
      x: xa, y: ry, width: xb - xa, height: ribbonH, rx: 3,
      fill: "var(--series-2)", "fill-opacity": 0.85,
    }));
    i = j + 1;
  }
  svg.appendChild(el("line", { x1: m.l, x2: m.l + plotW, y1: ry + ribbonH + 0.5, y2: ry + ribbonH + 0.5, stroke: "var(--axis)", "stroke-width": 1 }));

  // sicaklik cizgisi (ince, 2px)
  let d = "";
  pts.forEach((p, k) => { d += (k ? "L" : "M") + X(p.t).toFixed(1) + " " + Y(p.temp).toFixed(1) + " "; });
  svg.appendChild(el("path", {
    d, fill: "none", stroke: "var(--series-1)", "stroke-width": 2,
    "stroke-linejoin": "round", "stroke-linecap": "round",
  }));

  // son degeri dogrudan etiketle (her noktaya sayi YAZILMAZ)
  const last = pts[pts.length - 1];
  svg.appendChild(el("circle", { cx: X(last.t), cy: Y(last.temp), r: 4, fill: "var(--series-1)", stroke: "var(--surface)", "stroke-width": 2 }));

  // --- gezinme katmani: dikey nisan + ipucu -------------------------------
  // Y5 — DINLEYICI BIRIKMESI. Eskiden her cizimde 5 dinleyici EKLENIYOR ama
  // hic kaldirilmiyordu (`svg.innerHTML=` yalniz dugumleri siler, dinleyiciler
  // SVG elemaninin kendisindeydi). 15 sn'lik yoklamayla saatte ~1.200 dinleyici;
  // telefonda acik kalan panel saatler icinde bozuluyordu.
  // Cozum: dinleyiciler MODUL YUKLENIRKEN TEK KEZ baglanir, cizim yalniz
  // paylasilan `chartCtx`i gunceller.
  const cross = el("line", { y1: m.t, y2: m.t + plotH, stroke: "var(--axis)", "stroke-width": 1, opacity: 0 });
  svg.appendChild(cross);
  chartCtx = { svg, cross, pts, m, plotW, x0, x1, X, Y };
}

// Grafigin gezinme durumu: tek dinleyici kumesi bunu okur.
let chartCtx = null;

(function bindChartPointerOnce() {
  const svg = $("chart");
  const tip = $("tip");
  const move = (ev) => {
    const c = chartCtx;
    if (!c || !c.pts.length) return;
    const box = c.svg.getBoundingClientRect();
    const px = (ev.touches ? ev.touches[0].clientX : ev.clientX) - box.left;
    const t = c.x0 + ((px - c.m.l) / c.plotW) * (c.x1 - c.x0);
    let best = c.pts[0];
    for (const p of c.pts) if (Math.abs(p.t - t) < Math.abs(best.t - t)) best = p;
    c.cross.setAttribute("x1", c.X(best.t));
    c.cross.setAttribute("x2", c.X(best.t));
    c.cross.setAttribute("opacity", 1);
    tip.style.opacity = 1;
    tip.textContent =
      new Date(best.t).toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" }) +
      " · " + best.temp.toFixed(1) + " °C · isitma " + (best.heat ? "acik" : "kapali");
    const tw = tip.offsetWidth || 150;
    tip.style.left = Math.max(0, Math.min(box.width - tw, c.X(best.t) - tw / 2)) + "px";
    tip.style.top = Math.max(0, c.Y(best.temp) - 36) + "px";
  };
  const hide = () => {
    if (chartCtx) chartCtx.cross.setAttribute("opacity", 0);
    tip.style.opacity = 0;
  };
  svg.addEventListener("mousemove", move);
  svg.addEventListener("touchstart", move, { passive: true });
  svg.addEventListener("touchmove", move, { passive: true });
  svg.addEventListener("mouseleave", hide);
  svg.addEventListener("touchend", hide);
})();

window.addEventListener("resize", () => { if (device) renderChart(lastRows, settings); });
