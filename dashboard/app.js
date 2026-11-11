// Kombi dashboard — statik sayfa, tum veri Supabase'den GIRISTEN SONRA gelir.
// Sayfanin kendisinde veri yok (plan §6). Yazma/okuma yetkisini RLS belirler.
//
// Bos durum kurali: veri yoksa UYDURMA deger gosterilmez, "henuz veri yok" yazar.

"use strict";

const CFG = window.KOMBI_CONFIG || {};
const HISTORY_HOURS = CFG.HISTORY_HOURS || 24;
const POLL_MS = (CFG.POLL_SECONDS || 15) * 1000;
const DAYS = ["Paz", "Pzt", "Sal", "Çar", "Per", "Cum", "Cmt"]; // bit0 = Pazar

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
  if (device) renderChart();
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
    loadDevice(epoch).catch(() => {}).then(() => {
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
  if (error) { $("auth-err").textContent = "Giriş başarısız: " + error.message; show($("auth-err"), true); }
});
$("signout").addEventListener("click", () => sb.auth.signOut());

// --- veri -------------------------------------------------------------------
async function loadDevice(epoch) {
  let data, error;
  try {
    ({ data, error } = await sb.from("devices").select("id, name").order("created_at").limit(1));
  } catch (e) {
    error = { message: String(e?.message || e) };   // ag hatasi da EKRANA yazilir
  }
  if (epoch !== sessionEpoch) return;  // ORTA-4: oturum degisti, yaniti AT
  if (error) {
    $("device-name").textContent = "cihaz okunamadı";
    showLoadError("Cihaz listesi okunamadı: " + error.message);
    device = null;
    return;
  }
  if (!data || data.length === 0) {
    $("device-name").textContent = "kayıtlı cihaz yok";
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
  el.textContent = "Veri okunamadı — gösterilen bilgi güncel OLMAYABİLİR. " + msg;
  show(el, true);
}

let lastRows = [];
let lastState = null;
// "Bos" bir CEVAPTIR, varsayilan degil: telemetri bir kez okunana kadar
// "henuz veri yok" DENMEZ (hem grafik hem kart bu bayragi okur).
let telemetriOkundu = false;

// Yanma karti: sunucuda sayilan degerler ayri bir tazelik saatiyle yurur.
// Sekil: { geceMs, kadans, bugun, saat24, gun7, gun30, kapsam7, kapsam30,
//          enEski, kapsamUyari, eskiSonYanma }  (sayilar SATIR adedidir)
let burnCounts = null;
let burnCountsAt = 0;      // son BASARILI/BASARISIZ sayim ani
let burnCountsBusy = false;
let burnHataSayisi = 0;    // artan geri cekilme icin
let burnAc = null;
let burnErr = null;

function resetView() {
  device = null;
  settings = null;
  pendingTarget = null;
  lastRows = [];
  lastState = null;
  telemetriOkundu = false;
  // Yanma sayimlari da hesaba BAGLIDIR: oturum degisince atilir, yoksa onceki
  // hesabin toplami yeni hesabin ekraninda kalir (ORTA-4 ile ayni eksen).
  if (burnAc) { burnAc.abort(); burnAc = null; }
  burnCounts = null;
  burnCountsAt = 0;
  burnCountsBusy = false;   // ucustaki istek iptal edildi; kilit de ACILMALI
  burnHataSayisi = 0;
  burnErr = null;
  durumOnbellek = null;
  $("device-name").textContent = "—";
  $("target-val").textContent = "—";
  $("target-src").textContent = "—";
  show($("load-err"), false);
  for (const id of ["s-band", "s-freeze", "s-hold"]) $(id).value = "";
  $("s-manual").value = "false";
  renderState(null);
  renderRules([]);
  renderChart();
  renderTable([]);
  renderBurn();
  show($("t-err"), false);
  show($("s-err"), false);
  show($("r-err"), false);
}

async function refresh() {
  const epoch = sessionEpoch;
  // Cihaz listesi ilk denemede okunamadiysa panel sonsuza kadar BOS
  // yoklamasin: her yoklamada bir kez daha dener, yani sayfa yenilenmeden
  // kendini toparlar. (Eskiden `loadDevice` hatasi `device`i kalici null
  // birakiyor, `refresh` ilk satirda donuyordu.)
  if (!device) {
    await loadDevice(epoch);
    if (epoch !== sessionEpoch || !device) return;
  }
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
      // `target_c` DE cekilir: hedef gun icinde degisiyor (saatli senaryolar) ve
      // her telemetri satiri o anin hedefini zaten tasiyor. Basamakli hedef
      // cizgisi bu sutundan turer; `device_settings`teki tek deger pencerenin
      // tamamini anlatmiyor. Ek sorgu degil, ayni sorguya bir sutun.
      //
      // SIRALAMA EN YENIDEN GERIYE (sonra JS'te cevriliyor). Sunucunun satir
      // tavani var (yerel yiginda `config.toml` -> `max_rows = 1000`; bulut
      // projelerinde de varsayilan 1.000) ve 60 sn'de bir yazan cihaz 24 saatte
      // 1.439 satir uretiyor. Eskiden artan siralamayla EN ESKI 1.000 satir
      // geliyordu: grafigin sag ucu saatler once bitiyor, "su an yaniyor"
      // suresi olmayan bir ani anlatiyordu. Artik tavan isirirsa kaybedilen
      // kisim GECMISIN ESKISI olur, simdiki an degil.
      // 11.11.2026: canli projenin tavani 2.000'e cikarildi (Serhat Bey, Supabase
      // panelinden; ayar veritabaninda durmadigi icin KODDAN OLCULEMEZ). Azalan
      // siralama yine de KALIYOR: tavan projeye gore degisiyor, kadans
      // degisebiliyor ve yanlis uc kaybetmek sessiz bir hata olurdu.
      sb.from("telemetry").select("ts, temp_c, humidity, relay_on, target_c")
        .eq("device_id", device.id).gte("ts", sinceIso)
        .order("ts", { ascending: false }).abortSignal(ac.signal),
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
    // Bu etiketler KULLANICIYA gorunur: hata metninin icine giriyorlar.
    ["anlık durum", stateRes.error], ["ayarlar", setRes.error],
    ["kurallar", ruleRes.error], ["geçmiş", telRes.error],
  ].filter(([, e]) => e && e.name !== "AbortError" && e.code !== "20");
  if (errs.length) {
    showLoadError(errs.map(([ad, e]) => `${ad}: ${e.message || e.code}`).join(" · "));
  } else {
    show($("load-err"), false);
  }

  settings = setRes.error ? null : (setRes.data || null);
  if (!stateRes.error) {
    lastState = stateRes.data || null;
    renderState(lastState);
  }
  renderSettings(settings);
  if (!ruleRes.error) renderRules(ruleRes.data || []);
  if (!telRes.error) {
    // Sorgu azalan geldi; cizim ve hesaplar ARTAN sira bekliyor.
    lastRows = (telRes.data || []).map((r) => ({
      t: new Date(r.ts).getTime(),
      temp: r.temp_c === null ? null : Number(r.temp_c),
      hum: r.humidity === null ? null : Number(r.humidity),
      heat: Boolean(r.relay_on),
      tg: r.target_c === null || r.target_c === undefined ? null : Number(r.target_c),
    })).reverse();
    telemetriOkundu = true;
    renderChart();
    renderTable(lastRows);
  }
  // Yanma karti: canli sure + bugun + 24 saat ZATEN elde olan 24 saatlik
  // pencereden hesaplanir (0 ek istek). 7/30 gunluk sayimlar sunucuda
  // sayilir ve 15 sn'lik yoklamaya BAGLANMAZ (en cok 5 dakikada bir).
  // Beklenmeden calisir; reddini YUTMAYIZ ama konsola da dusurmeyiz: kart
  // zaten "okunamadi" satirini gosteriyor.
  yanmaSayimlariniTazele(epoch).catch(() => {});
  renderBurn();
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
    $("seen").textContent = "Cihaz henüz hiç bağlanmadı.";
    return;
  }
  const ageS = (Date.now() - new Date(st.last_seen_at).getTime()) / 1000;
  const online = ageS < 600;
  // ONDALIK AYIRICI: panelin tamami virgul. Grafik/tablo virgul, durum karti
  // nokta kullaniyordu; ayni ekranda "21.6" ile "21,6" yan yana duruyordu.
  $("temp").textContent = st.temp_c === null ? "—" : vir(st.temp_c);
  $("hum").textContent = st.humidity === null ? "—" : "%" + Number(st.humidity).toFixed(0);
  $("target-now").textContent = st.target_c === null ? "—" : vir(st.target_c) + " °C";
  // K1 — "su an neden 25 °C?" Yururlukteki hedefin KAYNAGI yaziliyor: saatli
  // kural mi, elle yazilan taban mi. (Kural artik tabani ezmiyor; ikisi ayri.)
  $("target-src").textContent = targetSourceLabel(st);
  $("online").textContent = online ? "çevrimiçi" : "SUSTU";
  $("reason").textContent = reasonLabel(st.reason);
  const on = Boolean(st.relay_on);
  $("relay-text").textContent = on ? "Kombi yanıyor" : "Kombi kapalı";
  $("relay-pill").querySelector(".dot").style.background = on ? "var(--series-2)" : "var(--muted)";
  $("seen").textContent = "Son veri: " + fmtAge(ageS) + " önce (" + new Date(st.last_seen_at).toLocaleString("tr-TR") + ")";

  const problems = [];
  if (!online) problems.push("Cihaz 10 dakikadan uzun süredir veri göndermiyor.");
  if (st.sensor_ok === false) problems.push("SENSÖR ARIZASI: ısı isteği kesildi.");
  if (st.temp_c !== null && Number(st.temp_c) < 6) problems.push("DONMA RİSKİ: oda 6 °C altında.");
  if (st.rules_suspended) problems.push("Cihazın saati doğrulanmadı: saatli senaryolar askıda, termostat son hedefle sürüyor.");
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
    return `${hh}:${mm} senaryosu` + (base === null ? "" : ` (taban ${vir(base)} °C)`);
  }
  if (st.rules_suspended) return "saat doğrulanmadı, taban hedef";
  if (st.rule_active === false && base !== null && Number(st.target_c) === base) return "elle ayarlanan hedef";
  return base === null ? "—" : `taban ${vir(base)} °C`;
}

function reasonLabel(r) {
  return ({
    boot: "açılıyor", sensor_fault: "sensör arızası", freeze_guard: "donma koruması",
    below_band: "hedefin altında", above_band: "hedefin üstünde", in_band: "bant içinde",
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
const hhmm = (t) => new Date(t).toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" });
const gunKisa = (t) => new Date(t).toLocaleDateString("tr-TR", { day: "numeric", month: "short" });

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
      return "Kaydedilemedi. Donma eşiği" + (Number.isFinite(f) ? ` (${vir(f)} °C)` : "") +
        " hedefin en az 0,5 °C altında kalmalı" +
        (Number.isFinite(f) ? `, yani hedef en az ${vir(f + KISIT_PAYI_C)} °C olabilir` : "") +
        ". Daha düşük bir hedef için önce aşağıdaki ayarlardan donma eşiğini düşürüp kaydedin.";
    }
    return "Kaydedilemedi. Donma eşiği, hedefin" + (Number.isFinite(t) ? ` (${vir(t)} °C)` : "") +
      " en az 0,5 °C altında kalmalı" +
      (Number.isFinite(t) ? `, yani en fazla ${vir(t - KISIT_PAYI_C)} °C girebilirsiniz` : "") + ".";
  }
  if (error?.code === "23514") {
    return "Kaydedilemedi: girilen değer izin verilen aralığın dışında. Değeri kontrol edip tekrar deneyin.";
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
  $("target-val").textContent = vir(pendingTarget);
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
  $("target-val").textContent = vir(pendingTarget);
  // Alt sinira dayanildiysa yol TIKALI degil: sirasi anlatilir.
  if (d < 0 && pendingTarget <= lo && lo > HEDEF_SEMA_TABAN_C) {
    $("t-err").textContent =
      `Donma eşiği ${vir(settings.freeze_guard_c)} °C olduğu için hedef en az ${vir(lo)} °C olabilir. ` +
      "Daha düşük bir hedef için önce aşağıdaki ayarlardan donma eşiğini düşürüp kaydedin.";
    show($("t-err"), true);
  } else {
    show($("t-err"), false);
  }
}
$("t-save").addEventListener("click", async () => {
  show($("t-err"), false);
  if (pendingTarget === null || !device) {
    $("t-err").textContent = "Cihaz henüz ayar bildirmedi; hedef yazılamaz.";
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
  // Cihaz okunamadiysa `device.id` yakalanmayan bir TypeError uretiyor ve
  // kullaniciya HICBIR SEY yazilmiyordu (hedef butonu dogru davraniyordu).
  if (!device) {
    $("s-err").textContent = "Cihaz okunamadı; ayarlar yazılamaz. Sayfayı yenileyip tekrar deneyin.";
    show($("s-err"), true);
    return;
  }
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
  if (mask === 127) return "Her gün";
  if (mask === 62) return "Hafta içi";
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
      `<td>${maskLabel(r.days_mask)}${r.enabled ? "" : " (kapalı)"}</td>` +
      `<td class="num">${String(r.hour).padStart(2, "0")}:${String(r.minute).padStart(2, "0")}</td>` +
      `<td class="num">${vir(r.target_c)} °C</td>`;
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
  if (mask === 0) { $("r-err").textContent = "En az bir gün seçin."; show($("r-err"), true); return; }
  if (!device) {
    $("r-err").textContent = "Cihaz okunamadı; kural eklenemez. Sayfayı yenileyip tekrar deneyin.";
    show($("r-err"), true);
    return;
  }
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
    // Grafikte yeni bir seri (hedef) varsa metin karsiliginda da olmali.
    tr.innerHTML =
      `<td>${hhmm(r.t)}</td>` +
      `<td class="num">${r.temp === null ? "—" : vir(r.temp)}</td>` +
      `<td class="num">${r.tg === null || r.tg === undefined ? "—" : vir(r.tg)}</td>` +
      `<td class="num">${r.hum === null ? "—" : "%" + r.hum.toFixed(0)}</td>` +
      `<td>${r.heat ? "yandı" : "—"}</td>`;
    tb.appendChild(tr);
  }
}

// --- "Kombi ne kadar yandi" karti -------------------------------------------
// Yanma suresi = `relay_on = true` olan telemetri SATIR SAYISI x 1 dakika.
// Dayanak: telemetri 60 sn'lik duzgun bir seri (24 saatte 1.439 nokta, en buyuk
// bosluk 71 sn, bos satir yok). Hata yanma basina ±1 dk ve bu, kartin alt
// satirinda kullaniciya YAZIYOR. `relay_on` bos olan satir (sensor arizasi)
// sayilmaz: `eq("relay_on", true)` null'i zaten disarida birakir.
//
// Istek yuku: canli sure + bugun + 24 saat, ZATEN cekilen 24 saatlik pencereden
// hesaplanir (0 ek istek). 7/30 gun, kapsam ve eski "son yanma" sunucuda
// sayilir (`count: exact`, `head: true` — satir tasinmaz) ve 15 sn'lik
// yoklamaya BAGLANMAZ: acilista bir kez, sonra en cok 5 dakikada bir.
const DK_MS = 60e3;
// TELEMETRI KADANSI — kartin butun sayilari bunun uzerine kurulu ("bir satir
// = bir kadans kadar yanma"). Kaynak TEK YERDE degil, uc yerde belirleniyor:
//   · supabase/functions/device-sync/index.ts  -> TELEMETRY_MIN_GAP_MS (55 sn)
//   · firmware/src/cloud.h                     -> kSyncPeriodMs (30 sn)
//   · sunucunun kendi gecikmesi
// Panel bunlari okuyamaz; bu yuzden kadans ONCE VERIDEN OLCULUR (ardisik
// farklarin medyani), olculemezse asagidaki taban kullanilir. Uc kaynaktan biri
// degisirse olculen medyan da degisir, yani sayilar sessizce kaymaz.
const TELEMETRI_KADANS_TABANI_MS = 60e3;   // device-sync 55 sn'lik tavani uygular
const BOSLUK_CARPANI = 2;                  // kadansin iki kati asilirsa KAYIT YOK
const SAYIM_TAZELEME_MS = 5 * 60e3;
// Hata yolunda artan geri cekilme: kalici hatada 30 sn'de bir 8 sorgu atmak
// butcenin 10 kati olurdu.
const SAYIM_GERI_CEKILME_MS = [30e3, 60e3, 5 * 60e3];
const SAYIM_ZAMAN_ASIMI_MS = 20e3;         // takilan istek sayimlari KILITLEMESIN
const KAPSAM_ESIGI = 0.95;

// --- kayit boslugu: tek kural, iki tuketici (kart + grafik) -----------------
// Esik SABIT DEGIL, serinin kendi ritminden turer: cihaz 60 sn'de bir yazarsa
// 2 dakika, 5 dakikada bir yazarsa 10 dakika. Sabit 2 dakika yazsaydik seyrek
// yazan bir seride her ornek "bosluk" sayilir, grafikteki cizgi parca parca
// dagilirdi.
function medyanAralik(seri) {
  if (!seri || seri.length < 3) return null;
  const f = [];
  for (let i = 1; i < seri.length; i++) { const d = seri[i].t - seri[i - 1].t; if (d > 0) f.push(d); }
  if (!f.length) return null;
  f.sort((a, b) => a - b);
  return f[Math.floor(f.length / 2)];
}
function kadansMs(seri) {
  const m = medyanAralik(seri);
  return m === null || m <= 0 ? TELEMETRI_KADANS_TABANI_MS : m;
}

// Ardisik "role acik" dizileri. KAYIT BOSLUGU diziyi BOLER. Grafik seridi
// eskiden bu kurali kullanmiyordu: 3 saatlik bir kayit deliginin iki yanindaki
// 20+20 dakikalik iki yanma tek blok olarak ciziliyor, kart dogru olarak
// "40 dk" derken grafik 219 dakikalik bir yanma UYDURUYORDU.
//
// ⚠️ Dizilerin kaynagi TEK seridir: `lastRows`in TAMAMI. Grafik kendi suzulmus
// serisinden (yalniz `temp_c` dolu satirlar) hesaplamiyordu ve sensorun iki
// okumayi kacirdigi yerde tek yanmayi IKI parcaya boluyordu — kayit vardi,
// yalniz sicaklik okunamamisti. Role durumu o satirlarda da BILINIYOR.
function yanmaDizileri(seri, esik) {
  const d = [];
  for (let i = 0; i < seri.length;) {
    if (!seri[i].heat) { i++; continue; }
    let j = i;
    while (j + 1 < seri.length && seri[j + 1].heat && seri[j + 1].t - seri[j].t <= esik) j++;
    // SURE OLCUSU TEK: satir sayisi. Zaman farki ile satir sayisi ayri iki
    // olcu olunca ayni yanma suren halde 20, bitince 19 dakika gorunuyordu
    // (kutucuklar sunucunun SATIR sayimindan geliyor).
    d.push({ baslangic: seri[i].t, bitis: seri[j].t, satir: j - i + 1 });
    i = j + 1;
  }
  return d;
}

// Kayit bosluklari (cihaz SUSMUS: hic satir yok) ile sensor bosluklari
// (satir VAR, `temp_c` bos) AYRI olgulardir; ikisi ayni griyle anlatilmaz.
function kayitBosluklari(seri, esik) {
  const b = [];
  for (let i = 1; i < seri.length; i++) {
    if (seri[i].t - seri[i - 1].t > esik) b.push([seri[i - 1].t, seri[i].t]);
  }
  return b;
}
function sensorBosluklari(seri) {
  const b = [];
  for (let i = 0; i < seri.length;) {
    if (seri[i].temp !== null) { i++; continue; }
    let j = i;
    while (j + 1 < seri.length && seri[j + 1].temp === null) j++;
    // Kenarlari komsu OLCULEN satirlara uzat ki isaret cizginin koptugu yeri
    // tam kapsasin.
    b.push([i > 0 ? seri[i - 1].t : seri[i].t, j + 1 < seri.length ? seri[j + 1].t : seri[j].t]);
    i = j + 1;
  }
  return b;
}

// Kartin ve grafigin TEK dogruluk kaynagi. Ayni yoklamada birden cok kez
// cagriliyor (kart + cizim + sayim karari); sonuc onbellege alinir.
let durumOnbellek = null;
function yanmaDurumu() {
  const now = Date.now();
  if (durumOnbellek && durumOnbellek.rows === lastRows &&
      durumOnbellek.state === lastState && now - durumOnbellek.durum.now < 10e3) {
    return durumOnbellek.durum;
  }
  const rows = lastRows;
  const gece = new Date();
  gece.setHours(0, 0, 0, 0);
  const kadans = kadansMs(rows);
  const esik = BOSLUK_CARPANI * kadans;
  const yasS = lastState && lastState.last_seen_at
    ? (now - new Date(lastState.last_seen_at).getTime()) / 1000 : null;
  const cevrimici = yasS !== null && yasS < 600;
  const diziler = yanmaDizileri(rows, esik);
  const sonSatir = rows.length ? rows[rows.length - 1] : null;
  const sonDizi = diziler.length ? diziler[diziler.length - 1] : null;
  const suAnYaniyor = cevrimici && Boolean(lastState && lastState.relay_on);
  const acikYanmaSuruyor = Boolean(suAnYaniyor && sonSatir && sonSatir.heat &&
    sonDizi && sonDizi.bitis === sonSatir.t);
  const durum = {
    now, kadans, esik, diziler, sonSatir, sonDizi, cevrimici, suAnYaniyor, acikYanmaSuruyor,
    geceMs: gece.getTime(),
    kayitBosluklari: kayitBosluklari(rows, esik),
    sensorBosluklari: sensorBosluklari(rows),
    durumBilinmiyor: lastState === null,
    sustuDk: yasS !== null && !cevrimici ? Math.round(yasS / 60) : null,
    // Tamamlanmis (suren olmayan) yanma sayisi: 0 ise "son yanma" icin
    // kayitlarin geri kalanina bakmak GEREKIR.
    tamamlanmisYanma: diziler.length - (acikYanmaSuruyor ? 1 : 0),
    canliSatir: acikYanmaSuruyor ? sonDizi.satir : 0,
    // Satirlar EN YENIDEN geriye cekildigi icin "en son satir bugunse bugunun
    // kaydi vardir" guvenli bir cikarim: sunucu tavani eski ucu kirpar, yeniyi degil.
    bugunKaydiVar: Boolean(sonSatir && sonSatir.t >= gece.getTime()),
    pencereKaydiVar: sonSatir !== null,
  };
  durumOnbellek = { rows: lastRows, state: lastState, durum };
  return durum;
}

// Satir sayisi -> dakika. Kadans olculen degerdir (bkz. TELEMETRI_KADANS_*).
const satirDakika = (satir, kadans) => (satir === null || satir === undefined
  ? null : Math.round((satir * kadans) / DK_MS));

// "0 dk" gecerli bir cevaptir; "—" yalniz BILINMIYOR demektir.
function sureMetni(dk) {
  if (dk === null || dk === undefined || !Number.isFinite(Number(dk))) return "—";
  const d = Math.max(0, Math.round(Number(dk)));
  if (d < 60) return d + " dk";
  const sa = Math.floor(d / 60), kalan = d % 60;
  return kalan === 0 ? sa + " sa" : sa + " sa " + kalan + " dk";
}
// Cihazin sustugu sure saatte DURMAZ: "Son 72 sa veri gelmedi" yerine gun.
function yasMetni(dk) {
  if (dk === null || dk === undefined || !Number.isFinite(Number(dk))) return "—";
  const d = Math.max(0, Math.round(Number(dk)));
  if (d < 1440) return sureMetni(d);
  const gun = Math.floor(d / 1440), saat = Math.round((d % 1440) / 60);
  return saat === 0 ? gun + " gün" : gun + " gün " + saat + " sa";
}

// Cihaz cevrimdisiyken yazilmayan dakikalar toplami EKSIK gosterir; sessiz
// yanlisin panzehiri bu cumle.
function kapsamCumlesi(gun, eksikDk) {
  const d = Math.max(1, Math.round(eksikDk));
  const miktar = d >= 60 ? Math.round(d / 60) + " saati" : d + " dakikası";
  return "Son " + gun + " günün " + miktar + " kayıtsız; " + gun + " günlük toplam eksik olabilir.";
}

async function yanmaSayimlariniTazele(epoch) {
  if (!sb || !device || burnCountsBusy) return;
  const gece = new Date();
  gece.setHours(0, 0, 0, 0);
  // GECE YARISI gecildiyse sayim BAYATTIR: "Bugun" penceresi degisti.
  // 23:58'de alinan sayim 5 dakika daha gecerli sayilsaydi kart 00:00-00:03
  // arasi dunun toplamini "Bugun" diye yazardi.
  const bayat = burnCounts === null || burnCounts.geceMs !== gece.getTime();
  if (!bayat && Date.now() - burnCountsAt < SAYIM_TAZELEME_MS) return;
  // "Son yanma" icin eski kayda bakmak, pencerede TAMAMLANMIS yanma yoksa
  // gerekir. Eskiden kosul "hic yanik satir yok" idi: SUREN yanma da yanik
  // satir uretiyor, o yuzden su an yanarken kart "son yanma" satirini sessizce
  // bos birakiyordu (istek hic gitmiyordu).
  const durum = yanmaDurumu();
  const eskiSonYanmaGerek = durum.tamamlanmisYanma === 0;
  // SUREN yanma, kendi "son yanma"si olamaz: sorgu su anki yanmanin
  // BASLANGICINDAN once kalan en yeni yanik satiri arar.
  const sonYanmaUstSinir = durum.acikYanmaSuruyor
    ? new Date(durum.sonDizi.baslangic).toISOString() : null;
  burnCountsBusy = true;
  const now = Date.now();
  const iso7 = new Date(now - 7 * 864e5).toISOString();
  const iso30 = new Date(now - 30 * 864e5).toISOString();
  const iso24 = new Date(now - HISTORY_HOURS * 3600e3).toISOString();
  const geceIso = gece.toISOString();
  const ac = new AbortController();
  burnAc = ac;
  // Takilan istek sayimlari KILITLEMESIN: `burnCountsBusy` yalniz `finally`de
  // dusuyordu, yani yanit hic donmezse kart bir daha hic tazelenmezdi.
  const zamanAsimi = setTimeout(() => ac.abort(), SAYIM_ZAMAN_ASIMI_MS);
  const say = (since, yalnizYanan) => {
    let q = sb.from("telemetry").select("*", { count: "exact", head: true })
      .eq("device_id", device.id).gte("ts", since);
    if (yalnizYanan) q = q.eq("relay_on", true);
    return q.abortSignal(ac.signal);
  };
  const okunamadi = () => {
    burnErr = "Yanma süresi okunamadı — gösterilen bilgi güncel OLMAYABİLİR.";
    burnCounts = null;      // eski sayimlar hatanin yaninda GUNCELMIS gibi durmasin
    // ARTAN geri cekilme: 30 sn -> 1 dk -> 5 dk. Sabit 30 saniye, sunucu
    // kalici hata verirken dakikada 16 sorgu demekti.
    const bekleme = SAYIM_GERI_CEKILME_MS[Math.min(burnHataSayisi, SAYIM_GERI_CEKILME_MS.length - 1)];
    burnHataSayisi++;
    burnCountsAt = Date.now() - SAYIM_TAZELEME_MS + bekleme;
    renderBurn();
  };

  let res;
  try {
    res = await Promise.all([
      say(iso7, true), say(iso30, true),          // yanma
      say(iso7, false), say(iso30, false),        // kapsam (toplam satir)
      // Bugun ve 24 saat de SUNUCUDA sayilir. Indirilen pencereden
      // hesaplasaydik, sunucunun satir tavani (yerelde 1.000) pencereyi
      // kirptigi anda toplamlar sessizce eksik cikardi.
      say(geceIso, true), say(iso24, true),
      sb.from("telemetry").select("ts").eq("device_id", device.id).gte("ts", iso30)
        .order("ts").limit(1).abortSignal(ac.signal),   // kaydin basladigi an
      eskiSonYanmaGerek
        ? (() => {
            let q = sb.from("telemetry").select("ts").eq("device_id", device.id).eq("relay_on", true);
            if (sonYanmaUstSinir !== null) q = q.lt("ts", sonYanmaUstSinir);
            return q.order("ts", { ascending: false }).limit(1).abortSignal(ac.signal);
          })()
        : Promise.resolve({ data: [], error: null }),
    ]);
  } catch (e) {
    if (epoch === sessionEpoch && e?.name !== "AbortError") okunamadi();
    return;
  } finally {
    clearTimeout(zamanAsimi);
    burnCountsBusy = false;
    if (burnAc === ac) burnAc = null;
  }
  if (epoch !== sessionEpoch) return;   // ORTA-4: oturum degisti, yaniti AT

  const hatali = res.find((r) => r.error && r.error.name !== "AbortError" && r.error.code !== "20");
  if (hatali) { okunamadi(); return; }

  const [y7, y30, k7, k30, yBugun, y24, eski, sonY] = res;
  const enEski = eski.data && eski.data.length ? new Date(eski.data[0].ts).getTime() : null;
  // Beklenen satir sayisi, kaydin GERCEKTEN geriye gittigi sure kadardir.
  // Sabit 30 gun alsaydik 12 gundur calisan bir cihazda kart her acilista
  // "18 gun kayitsiz" diye yanlis alarm verirdi. Bolen de sabit degil, OLCULEN
  // kadans: 5 dakikada bir yazan bir seride 1 dakikalik beklenti, kapsami
  // yuzde yirmi gosterip sahte alarm uretirdi.
  const kadans = durum.kadans;
  const bekle = (gun) => {
    const pencereBas = now - gun * 864e5;
    const bas = enEski === null ? pencereBas : Math.max(pencereBas, enEski);
    return Math.max(1, Math.round((now - bas) / kadans));
  };
  const b7 = bekle(7), b30 = bekle(30);
  let uyari = null;
  if (k30.count !== null && k30.count > 0 && k30.count < KAPSAM_ESIGI * b30) {
    uyari = kapsamCumlesi(30, satirDakika(b30 - k30.count, kadans));
  } else if (k7.count !== null && k7.count > 0 && k7.count < KAPSAM_ESIGI * b7) {
    uyari = kapsamCumlesi(7, satirDakika(b7 - k7.count, kadans));
  }

  burnErr = null;
  burnHataSayisi = 0;
  burnCounts = {
    geceMs: gece.getTime(), kadans,
    bugun: yBugun.count, saat24: y24.count,
    gun7: y7.count, gun30: y30.count, kapsam7: k7.count, kapsam30: k30.count,
    enEski, kapsamUyari: uyari,
    // undefined = sorulmadi (pencerede zaten yanma var), null = kayitlarda hic yanma yok
    eskiSonYanma: eskiSonYanmaGerek
      ? (sonY.data && sonY.data.length ? new Date(sonY.data[0].ts).getTime() : null)
      : undefined,
  };
  burnCountsAt = Date.now();
  renderBurn();
}

function renderBurn() {
  const dur = yanmaDurumu();
  const now = dur.now;
  const sustuDk = dur.sustuDk;
  const kadans = burnCounts ? burnCounts.kadans : dur.kadans;

  // Toplamlar SUNUCUDAN gelir (tavan pencereyi kirpsa bile dogru kalsinlar) ve
  // SATIR adedidir; dakikaya olculen kadansla cevrilir.
  // Sayim daha gelmediyse dogru cevap 0 degil "—"dir; o pencerede hic kayit
  // yoksa da "—"dir (olculmemis bir seye 0 demek uydurmaktir).
  // GECE YARISI gecilmisse "Bugun" sayimi DUNE aittir: yine "—".
  const bugunSayimiGecerli = burnCounts !== null && burnCounts.geceMs === dur.geceMs;
  const bugun = !bugunSayimiGecerli || !dur.bugunKaydiVar
    ? null : satirDakika(burnCounts.bugun, kadans);
  const saat24 = burnCounts === null || !dur.pencereKaydiVar
    ? null : satirDakika(burnCounts.saat24, kadans);

  let sonYanma;                                   // undefined = henuz bilinmiyor
  const sy = dur.diziler.length - (dur.acikYanmaSuruyor ? 2 : 1);
  if (sy >= 0) sonYanma = dur.diziler[sy];
  else if (burnCounts && burnCounts.eskiSonYanma !== undefined) {
    sonYanma = burnCounts.eskiSonYanma === null ? null : { bitis: burnCounts.eskiSonYanma };
  }

  // "Hic veri yok" BILINEN bir sonuctur, varsayilan degil: telemetri okunmus
  // olmali VE 30 gunluk sayim gercekten 0 donmus olmali. Eskiden sayim daha
  // gelmeden de bu dala duluyordu, yani 30 gunluk kaydi olan cihazda bile
  // panel her acilista "henuz veri yok" diyordu.
  const veriYok = telemetriOkundu && !dur.pencereKaydiVar &&
    burnCounts !== null && burnCounts.kapsam30 === 0;
  show($("burn-body"), !veriYok);
  show($("burn-empty"), veriYok && !burnErr);
  show($("burn-err"), Boolean(burnErr));
  if (burnErr) $("burn-err").textContent = burnErr;
  if (veriYok) return;

  $("burn-dot").style.background = dur.suAnYaniyor ? "var(--series-2)" : "var(--muted)";
  $("burn-pill-text").textContent = dur.durumBilinmiyor
    ? "Kombi durumu bilinmiyor"
    : sustuDk !== null
      ? "Cihaz veri göndermiyor"
      : dur.suAnYaniyor ? "Kombi şu an yanıyor" : "Kombi şu an kapalı";

  const pre = $("burn-pre"), num = $("burn-num"), tail = $("burn-tail");
  num.classList.remove("unknown");
  if (sustuDk !== null) {
    // Cihaz sustuysa BUYUK sayi yok: bilinmeyen bir seyi 28 px'te vurgulamanin
    // anlami yok, cumleye iner.
    pre.textContent = "";
    num.textContent = "";
    tail.textContent = "Son " + yasMetni(sustuDk) + " veri gelmedi; kombi yanıyor mu bilinmiyor.";
  } else if (dur.suAnYaniyor) {
    pre.textContent = "";
    num.textContent = sureMetni(satirDakika(dur.canliSatir, dur.kadans));
    tail.textContent = "boyunca yanıyor";
  } else {
    pre.textContent = "Bugün";
    num.textContent = sureMetni(bugun);
    if (bugun === null) num.classList.add("unknown");
    tail.textContent = "yandı";
  }

  const gunOnEk = (t) => (new Date(t).toDateString() === new Date(now).toDateString()
    ? "bugün " : gunKisa(t) + " ");
  $("burn-sub").textContent =
    (sustuDk !== null ? "Toplamlar son gelen veriye kadar. " : "") +
    (sonYanma === undefined ? ""
      : sonYanma === null ? "Kayıtlarda (30 gün) hiç yanma yok."
        : sonYanma.baslangic
          // Aralik, son ornegin KAPSADIGI kadansin sonunda biter; yoksa
          // "05:11–06:00 · 50 dk" gibi kendi icinde celisen bir satir cikar.
          ? "Son yanma " + gunOnEk(sonYanma.bitis) + hhmm(sonYanma.baslangic) + "–" +
            hhmm(sonYanma.bitis + dur.kadans) + " · " +
            sureMetni(satirDakika(sonYanma.satir, dur.kadans))
          // 24 saatten eski yanmanin SURESI uydurulmaz: yalniz zamani yazilir.
          : "Son yanma " + gunOnEk(sonYanma.bitis) + hhmm(sonYanma.bitis) + " dolayında");

  const kutular = [
    ["Bugün", bugun], [HISTORY_HOURS + " saat", saat24],
    ["7 gün", burnCounts ? satirDakika(burnCounts.gun7, kadans) : null],
    ["30 gün", burnCounts ? satirDakika(burnCounts.gun30, kadans) : null],
  ];
  const kutu = $("burn-tiles");
  kutu.innerHTML = "";
  for (const [ad, deger] of kutular) {
    const kutucuk = document.createElement("div");
    kutucuk.className = "tile";
    const k = document.createElement("div");
    k.className = "k";
    k.textContent = ad;
    const v = document.createElement("div");
    v.className = deger === null ? "v unknown" : "v";
    v.textContent = sureMetni(deger);
    kutucuk.appendChild(k);
    kutucuk.appendChild(v);
    kutu.appendChild(kutucuk);
  }

  $("burn-note").textContent =
    (burnCounts && burnCounts.kapsamUyari ? burnCounts.kapsamUyari + " " : "") +
    "Süreler dakikaya yuvarlanır; her yanma için 1 dakikaya kadar sapabilir. " +
    // Budama isi (pg_cron): goc 11.11.2026'da YAZILDI
    // (supabase/migrations/20261111180000_telemetri_budama_cron.sql) ama
    // CANLIYA HENUZ UYGULANMADI (Serhat Bey onayinda). Yani "30 gun tutulur"
    // hala verilemeyecek bir soz. Asagidaki cumle BILEREK yalniz ekranin kendi
    // kapsamini anlatiyor; budama canliya girse bile bu metin dogru kalir
    // (silme `ts < now()-30g`, ekran `ts >= now()-30g` — tam tumleyen).
    // ⚠️ Ekran metnini degistirmeyin; degisen sey yalniz bu yorumun durumu.
    "30 günden eskisi bu ekranda gösterilmiyor.";
}

// --- grafik -----------------------------------------------------------------
// Oda sicakligi (1 CSS px'lik sutunlarda ortalama cizgi + en dusuk/en yuksek
// zarfi), kombinin yandigi araliklar, BASAMAKLI hedef ve her basamagin karar
// araligi. Tek eksen; ikinci bir y ekseni YOK.
const SVG_NS = "http://www.w3.org/2000/svg";
function el(name, attrs) {
  const n = document.createElementNS(SVG_NS, name);
  for (const k in attrs) n.setAttribute(k, attrs[k]);
  return n;
}

// Y alani 0,5'e DISA yuvarlanir ve yururlukteki yakma/sondurme esiklerini
// ICERMEK ZORUNDADIR: yoksa "hedef 22, oda 21,5, kombi neden yanmiyor?"
// sorusunun cevabi ekranin disinda kalir. Eskiden alan `min-1 .. max+1` idi ve
// etiket ONDALIKSIZ basiliyordu: izgara 19,7/20,7/21,7'de dururken ekranda
// 20/21/22 yaziyordu — etiket cizgiden 0,3 °C kayikti. (Eski cagrinin adini
// buraya birebir yazmiyorum: kabul olcumu dosyada o dizgeyi ariyor, yorumdaki
// metin kendi olcumunu kirletirdi.)
function yAlan(temps, esikLo, esikHi) {
  let lo = Math.min(...temps, esikLo);
  let hi = Math.max(...temps, esikHi);
  lo = Math.floor((lo - 0.3) * 2) / 2;
  hi = Math.ceil((hi + 0.3) * 2) / 2;
  // Duz bir gun gurultuyu dag gibi gostermesin.
  if (hi - lo < 2) { const c = (hi + lo) / 2; lo = Math.floor((c - 1) * 2) / 2; hi = Math.ceil((c + 1) * 2) / 2; }
  return [lo, hi];
}
// Etiketler arasi >= 40 px birakan en kucuk adim.
function yAdim(lo, hi, plotH) {
  for (const a of [0.5, 1, 2]) if (plotH / ((hi - lo) / a) >= 40) return a;
  return 2;
}
// Etiketler arasi >= 45 px birakan en kucuk YUVARLAK saat adimi ("02:00"
// 11 px'te 31 px genis, +14 px nefes).
function xAdimSaat(plotW, saat) {
  for (const a of [1, 2, 3, 4, 6, 12]) if ((plotW / saat) * a >= 45) return a;
  return 12;
}

// YUKSEK-1 kaliti: imza `renderChart(rows, s)` idi; sicaklik yolu PARAMETREDEN,
// serit/bosluk ise global `lastRows`tan besleniyordu. Dort cagrinin dordu de
// ayni diziyi geciriyordu ama farkli bir dizi geciren ILK cagri resmi yine
// ikiye bolerdi. Kaynak artik tek: globaller.
function renderChart() {
  const svg = $("chart");
  const rows = lastRows, s = settings;
  const pts = rows.filter((r) => r.temp !== null);
  // Baslik CIZILEN araligi anlatir. Sunucunun satir tavani pencereyi kirparsa
  // (60 sn'lik seride 24 saat 1.439 satir, tavan 1.000) grafik 24 saatin
  // tamamini gostermez; "son 24 saat" demek o durumda yanlis bir iddia olur.
  const kapsananSaat = pts.length >= 2 ? (pts[pts.length - 1].t - pts[0].t) / 3600e3 : 0;
  const aralikMetni = pts.length < 2 || kapsananSaat >= HISTORY_HOURS * 0.95
    ? "son " + HISTORY_HOURS + " saat"
    : hhmm(pts[0].t) + " – " + hhmm(pts[pts.length - 1].t) + " arası";
  svg.innerHTML = '<title id="chart-title">Oda sıcaklığı, hedef ve kombinin karar aralığı — ' +
    aralikMetni + "</title>";
  // "Henuz kayitli veri yok" bir CEVAPTIR: telemetri okunmadan once yazilmaz
  // (yoksa 30 gunluk kaydi olan cihazda bile panel her acilista bunu gosterir).
  show($("chart-empty"), telemetriOkundu && pts.length < 2);
  show($("chart-legend"), pts.length >= 2);
  show($("explain"), pts.length >= 2);
  if (pts.length < 2) {
    // Veri yokken gostergede SAYI kalmaz: "Hedef 22,0 °C" yazili bir gosterge,
    // olculmemis bir degeri olculmus gibi gosterirdi.
    $("lg-target").textContent = "Hedef";
    $("lg-band").textContent = "Karar aralığı";
    $("explain").textContent = "";
    svg.style.height = "0px";
    chartCtx = null;
    return;
  }
  svg.style.height = "240px";
  // Yanma dizileri, kayit bosluklari ve kadans KARTLA AYNI kaynaktan gelir
  // (`yanmaDurumu()` -> `lastRows`in tamami). Grafik kendi suzulmus serisinden
  // yeniden hesaplamaz; iki kopya sessizce ayrisiyordu.
  const durum = yanmaDurumu();

  const w = svg.clientWidth || 360;
  const h = 240;
  // l: 34 -> 38 ("20,0" tek ondalikla sigsin), b: 38 -> 42 (gece yarisi
  // tikinin altindaki gun etiketi icin ikinci satir).
  const m = { t: 12, r: 10, b: 42, l: 38 };
  const ribbonH = 10, gap = 6;
  const plotH = h - m.t - m.b - ribbonH - gap;   // 170
  const plotW = w - m.l - m.r;
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);

  const x0 = pts[0].t, x1 = pts[pts.length - 1].t;
  const yariBant = s !== null && s !== undefined && Number.isFinite(Number(s.hysteresis_c))
    ? Number(s.hysteresis_c) / 2 : null;
  const ayarHedef = s !== null && s !== undefined && Number.isFinite(Number(s.target_c))
    ? Number(s.target_c) : null;
  // Yururlukteki hedef = son telemetri satirinin tasidigi hedef; yoksa ayar.
  const sonHedef = pts[pts.length - 1].tg ?? ayarHedef;
  const esikVar = sonHedef !== null && sonHedef !== undefined && yariBant !== null;
  const [lo, hi] = yAlan(
    pts.map((p) => p.temp),
    esikVar ? sonHedef - yariBant : Infinity,
    esikVar ? sonHedef + yariBant : -Infinity,
  );
  const X = (t) => m.l + ((t - x0) / Math.max(1, x1 - x0)) * plotW;
  // Dizi/bosluk TUM satirlardan, koordinat ise `pts`ten turuyor: serinin
  // ucunda bir sensor arizasi varsa isaret cizim alanindan TASAR (solda Y
  // etiketlerinin, sagda kenarin uzerine). Alan disi her sey kirpilir.
  const Xk = (t) => Math.min(m.l + plotW, Math.max(m.l, X(t)));
  const Y = (v) => m.t + plotH - ((v - lo) / (hi - lo)) * plotH;
  const kirp = (y) => Math.min(m.t + plotH, Math.max(m.t, y));

  // 1) yatay izgara + Y etiketleri (tek ondalik + virgul, CIZGIYLE AYNI deger)
  const ya = yAdim(lo, hi, plotH);
  for (let v = Math.ceil(lo / ya) * ya; v <= hi + 1e-9; v += ya) {
    svg.appendChild(el("line", { x1: m.l, x2: m.l + plotW, y1: Y(v), y2: Y(v), stroke: "var(--grid)", "stroke-width": 1 }));
    const tx = el("text", { x: m.l - 6, y: Y(v) + 4, "text-anchor": "end", fill: "var(--text-2)", "font-size": 11 });
    tx.textContent = vir(v);
    svg.appendChild(tx);
  }

  // 2) dikey izgara + X etiketleri: YUVARLAK saat (pencere kaydikca 02:37 gibi
  //    degerler cikmasin, iki grafik birbiriyle karsilastirilabilsin)
  const saat = Math.max(1 / 60, (x1 - x0) / 3600e3);
  const xs = xAdimSaat(plotW, saat);
  const ilk = new Date(x0);
  ilk.setMinutes(0, 0, 0);
  while (ilk.getHours() % xs !== 0) ilk.setHours(ilk.getHours() + 1);
  for (let t = ilk.getTime(); t <= x1; t += xs * 3600e3) {
    if (t < x0) continue;
    const x = X(t);
    svg.appendChild(el("line", { x1: x, x2: x, y1: m.t, y2: m.t + plotH, stroke: "var(--grid)", "stroke-width": 1 }));
    if (x - m.l < 14 || m.l + plotW - x < 14) continue;   // kenara tasacak etiket YAZILMAZ
    const tx = el("text", { x, y: h - 20, "text-anchor": "middle", fill: "var(--text-2)", "font-size": 11, "data-role": "xlabel" });
    tx.textContent = hhmm(t);
    svg.appendChild(tx);
    // 24 saatlik pencere iki gunu kapsiyor: "00:00" tek basina hangi gun
    // oldugunu soylemiyor.
    if (new Date(t).getHours() === 0) {
      const g = el("text", { x, y: h - 7, "text-anchor": "middle", fill: "var(--muted)", "font-size": 10 });
      g.textContent = gunKisa(t);
      svg.appendChild(g);
    }
  }

  // 3) hedefin BASAMAKLARI + her basamagin karar araligi (yakma/sondurme)
  let seg = [];
  for (const p of pts) {
    const tg = p.tg === null || p.tg === undefined ? null : Number(p.tg);
    const son = seg[seg.length - 1];
    if (!son || son.tg !== tg) seg.push({ tg, t0: p.t, t1: p.t });
    else son.t1 = p.t;
  }
  // Kayitlarda hedef HIC yoksa (eski firmware) basamak UYDURULMAZ: yururlukteki
  // ayarin hedefi tek duzluk cizilir ve gostergede "(su anki ayar)" yazar.
  const hedefTahmini = seg.every((g) => g.tg === null);
  if (hedefTahmini) seg = ayarHedef === null ? [] : [{ tg: ayarHedef, t0: x0, t1: x1 }];
  if (yariBant !== null) {
    for (const g of seg) {
      if (g.tg === null) continue;
      const yUst = kirp(Y(g.tg + yariBant)), yAlt = kirp(Y(g.tg - yariBant));
      const xa = X(g.t0), xb = X(g.t1);
      svg.appendChild(el("rect", {
        x: xa, y: yUst, width: Math.max(1, xb - xa), height: Math.max(0, yAlt - yUst),
        fill: "var(--muted)", "fill-opacity": 0.11, "data-role": "band",
      }));
      // Kenarlar olmadan serit "gri bir alan", kenarlarla "esik" okunuyor.
      for (const [v, y] of [[g.tg - yariBant, yAlt], [g.tg + yariBant, yUst]]) {
        if (v < lo || v > hi) continue;
        svg.appendChild(el("line", {
          x1: xa, x2: xb, y1: y, y2: y, stroke: "var(--muted)",
          "stroke-width": 1, opacity: 0.4, "data-role": "band-edge",
        }));
      }
    }
  }
  for (let k = 0; k < seg.length; k++) {
    const g = seg[k];
    if (g.tg === null) continue;                        // hedef bilinmiyorsa BOSLUK birakilir
    svg.appendChild(el("line", {                        // yatay basamak: KESIKLI
      x1: X(g.t0), x2: X(g.t1), y1: Y(g.tg), y2: Y(g.tg),
      stroke: "var(--muted)", "stroke-width": 1.5, "stroke-dasharray": "5 4", "data-role": "target",
    }));
    const sonraki = seg[k + 1];
    if (sonraki && sonraki.tg !== null) svg.appendChild(el("line", {   // dikey baglanti: DUZ
      x1: X(sonraki.t0), x2: X(sonraki.t0), y1: Y(g.tg), y2: Y(sonraki.tg),
      stroke: "var(--muted)", "stroke-width": 1, opacity: 0.55, "data-role": "target-step",
    }));
  }

  // 3b) IKI AYRI OLGU, IKI AYRI ISARET:
  //   · KAYIT YOK  — cihaz susmus, hicbir sey olculmemis: dolgu + DUZ kenar.
  //   · SICAKLIK OKUNAMADI — kayit VAR (role durumu biliniyor), yalniz sensor
  //     okumamis: dolgu YOK, KESIKLI kenar. Bant ve hedef gorunur kalir,
  //     cunku onlar o dakikalarda da biliniyordu.
  // Ikisini ayni griyle anlatmak "olculmedi" ile "sicaklik olculemedi"yi
  // karistirirdi; kayit boslugu dolgusu bant/hedef katmanini da ORTER.
  const bosEsik = durum.esik;
  for (const [ba, bb] of durum.kayitBosluklari) {
    const xa = Xk(ba), xb = Xk(bb);
    svg.appendChild(el("rect", {
      x: xa, y: m.t, width: Math.max(1, xb - xa), height: plotH,
      fill: "var(--grid)", "fill-opacity": 0.55, "data-role": "gap",
    }));
    for (const x of [xa, xb]) {
      svg.appendChild(el("line", {
        x1: x, x2: x, y1: m.t, y2: m.t + plotH,
        stroke: "var(--axis)", "stroke-width": 1, "data-role": "gap-edge",
      }));
    }
  }
  for (const [ba, bb] of durum.sensorBosluklari) {
    const xa = Xk(ba), xb = Xk(bb);
    for (const x of [xa, xb]) {
      svg.appendChild(el("line", {
        x1: x, x2: x, y1: m.t, y2: m.t + plotH, stroke: "var(--axis)",
        "stroke-width": 1, "stroke-dasharray": "3 3", "data-role": "sensor-gap",
      }));
    }
  }

  // 4) kombinin yandigi araliklar (alttaki serit). Diziler KARTLA AYNI
  // DIZIDEN gelir (`lastRows`in tamami): eskiden grafik kendi suzulmus
  // serisinden hesapliyordu ve sensorun iki okumayi kacirdigi yerde tek
  // yanmayi ikiye boluyordu; daha oncesinde de zaman farkina hic bakmiyor,
  // 3 saatlik kayit deliginde 219 dakikalik yanma uyduruyordu.
  const ry = m.t + plotH + gap;
  for (const dizi of durum.diziler) {
    const xa = Xk(dizi.baslangic);
    const xb = Math.min(m.l + plotW, Math.max(Xk(dizi.bitis), xa + 2));
    const w = xb - xa;
    svg.appendChild(el("rect", {
      // rx genisligin yarisini GECMEZ: kisa yanmalarda 3 px yuvarlatma
      // 5 px'lik dikdortgeni noktaya ceviriyordu.
      x: xa, y: ry, width: w, height: ribbonH, rx: Math.min(3, w / 2),
      fill: "var(--series-2)", "fill-opacity": 0.9, "data-role": "burn",
    }));
  }
  svg.appendChild(el("line", { x1: m.l, x2: m.l + plotW, y1: ry + ribbonH + 0.5, y2: ry + ribbonH + 0.5, stroke: "var(--axis)", "stroke-width": 1 }));

  // 5) sicaklik: 1 CSS px'lik sutunlarda OZETLE — ortalama cizgi + en dusuk/en
  //    yuksek zarfi. Seyreltme (her N'inci noktayi al) SECILMEDI: sensor
  //    0,1 °C adimli ve uc sicramalar tek noktada oluyor; seyreltme pencereyi
  //    actiginiz dakikadaki dibi ya da tepeyi sessizce silerdi. Sutun ozeti
  //    hicbir okumayi atmaz: zarf, o sutunda gorulen en dusuk ve en yuksek
  //    degeri kapsar.
  const kol = new Array(Math.max(1, Math.round(plotW)));
  for (const p of pts) {
    const k = Math.min(kol.length - 1, Math.max(0, Math.floor(X(p.t) - m.l)));
    const c = kol[k] || (kol[k] = { n: 0, s: 0, mn: Infinity, mx: -Infinity, x: m.l + k + 0.5, t0: p.t, t1: p.t });
    c.n++; c.s += p.temp; c.mn = Math.min(c.mn, p.temp); c.mx = Math.max(c.mx, p.temp);
    c.t0 = Math.min(c.t0, p.t); c.t1 = Math.max(c.t1, p.t);
  }
  const dolu = kol.filter(Boolean);
  // Kayit boslugunda YOL KIRILIR. Eskiden iki dolu sutun duz bir capraz
  // cizgiyle birlestiriliyordu: cihazin sustugu uc saatte OLCULMEMIS bir
  // isinma cizilmis oluyordu.
  const parcalar = [];
  let parca = [];
  for (let k = 0; k < dolu.length; k++) {
    if (k > 0 && dolu[k].t0 - dolu[k - 1].t1 > bosEsik) { parcalar.push(parca); parca = []; }
    parca.push(dolu[k]);
  }
  if (parca.length) parcalar.push(parca);

  let zarfD = "", cizgiD = "";
  for (const par of parcalar) {
    par.forEach((c, k) => { zarfD += (k ? "L" : "M") + c.x.toFixed(1) + " " + Y(c.mx).toFixed(1) + " "; });
    for (let k = par.length - 1; k >= 0; k--) zarfD += "L" + par[k].x.toFixed(1) + " " + Y(par[k].mn).toFixed(1) + " ";
    zarfD += "Z ";
    par.forEach((c, k) => { cizgiD += (k ? "L" : "M") + c.x.toFixed(1) + " " + Y(c.s / c.n).toFixed(1) + " "; });
  }
  svg.appendChild(el("path", {
    d: zarfD, fill: "var(--series-1)", "fill-opacity": 0.22, stroke: "none", "data-role": "envelope",
  }));
  svg.appendChild(el("path", {
    d: cizgiD, fill: "none", stroke: "var(--series-1)", "stroke-width": 2,
    "stroke-linejoin": "round", "stroke-linecap": "round", "data-role": "temp",
  }));

  // 6) son degeri dogrudan etiketle (her noktaya sayi YAZILMAZ)
  const last = pts[pts.length - 1];
  svg.appendChild(el("circle", { cx: X(last.t), cy: Y(last.temp), r: 4, fill: "var(--series-1)", stroke: "var(--surface)", "stroke-width": 2 }));

  // 7) sayilar grafigin ICINE degil gostergeye ve bir cumleye yazilir
  const hedefParca = seg.filter((g) => g.tg !== null).length;
  let aciklama = "";
  if (sonHedef === null || sonHedef === undefined) {
    $("lg-target").textContent = "Hedef";
    $("lg-band").textContent = "Karar aralığı";
  } else {
    $("lg-target").textContent = "Hedef " + vir(sonHedef) + " °C" + (hedefTahmini ? " (şu anki ayar)" : "");
    if (esikVar) {
      const yak = vir(sonHedef - yariBant), sondur = vir(sonHedef + yariBant);
      $("lg-band").textContent = "Karar aralığı " + yak + "–" + sondur + " °C";
      aciklama =
        "Oda " + yak + " °C'ye düşünce kombi yanar, " + sondur + " °C'ye çıkınca söner; " +
        "arada kalınca son durumunu korur." +
        (hedefParca > 1 ? " Hedef gün içinde değişince bu aralık da kayar." : "");
    } else {
      $("lg-band").textContent = "Karar aralığı";
    }
  }
  // Gostergenin iki kalemi YALNIZ karsiligi cizildiyse gorunur.
  show($("lg-gap"), durum.kayitBosluklari.length > 0);
  show($("lg-sensor"), durum.sensorBosluklari.length > 0);
  // Pencere KIRPILDIYSA bunu gorunur kanalda soyle: `<title>` yalniz ekran
  // okuyucuya ve fare ipucuna dusuyor, panel ise cogunlukla telefondan
  // aciliyor. Tek gorunur iz x ekseninin gec baslamasiydi ve nedeni hicbir
  // yerde yazmiyordu — kullanici "cihazim ancak o saatten beri kayit tutuyor"
  // diye yanlis cikarim yapardi.
  const kirpik = kapsananSaat < HISTORY_HOURS * 0.95;
  $("explain").textContent =
    // Ek cikarmadan yazildi: "11:07'dan" / "11:07'den" ayrimi saatin
    // OKUNUSUNA bagli, dogru eki uretmek icin kural yazmaya degmez.
    (kirpik ? "Grafik " + hhmm(pts[0].t) + " sonrasını gösteriyor; daha eskisi " +
      "kayıtlarda var ama bu ekrana sığmadı. " : "") + aciklama;

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
      hhmm(best.t) + " · " + vir(best.temp) + " °C" +
      (best.tg === null || best.tg === undefined ? "" : " · hedef " + vir(best.tg)) +
      " · " + (best.heat ? "kombi yandı" : "kombi yanmadı");
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

// O7 — mobilde adres cubugu kipirdadikca her olayda tum grafik yeniden
// ciziliyordu; kare basina tek cizim yeter.
let cizimBekleyen = null;
window.addEventListener("resize", () => {
  if (!device || cizimBekleyen !== null) return;
  cizimBekleyen = requestAnimationFrame(() => {
    cizimBekleyen = null;
    renderChart();
  });
});
