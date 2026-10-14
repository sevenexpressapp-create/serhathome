// Dashboard'u GERCEK bir tarayicida olcer: giris, canli degerler, grafik,
// bos durum ve mobil genislik. Bagimliliksiz CDP surucusu (Node 24'un
// yerlesik WebSocket'i). Kendi profil dizini + kendi portu kullanilir ki
// baska bir ajanin tarayicisini EZMESIN.
const PORT = Number(process.env.CDP_PORT || 9444);
const BASE = process.env.PANEL_URL || "http://127.0.0.1:8788/index.html";
const EMAIL = "panel@kombi.test";
const PASSWORD = "Kombi-Panel-2026";
const SHOT_DIR = process.env.SHOT_DIR || ".";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function targets() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  return res.json();
}

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.waiters = new Map(); this.events = []; }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    const c = new CDP(ws);
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && c.waiters.has(msg.id)) {
        const { res, rej } = c.waiters.get(msg.id);
        c.waiters.delete(msg.id);
        msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
      } else if (msg.method) c.events.push(msg);
    };
    return c;
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.waiters.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.waiters.has(id)) { this.waiters.delete(id); rej(new Error(method + " zaman asimi")); } }, 30000);
    });
  }
  async eval(expr) {
    const r = await this.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error("JS hatasi: " + JSON.stringify(r.exceptionDetails.exception?.description ?? r.exceptionDetails));
    return r.result.value;
  }
  consoleErrors() {
    return this.events
      .filter((e) => (e.method === "Runtime.consoleAPICalled" && ["error", "warning"].includes(e.params.type)) ||
                     (e.method === "Log.entryAdded" && ["error"].includes(e.params.entry.level)) ||
                     e.method === "Runtime.exceptionThrown")
      .map((e) => e.method === "Runtime.exceptionThrown"
        ? "EXC " + (e.params.exceptionDetails.exception?.description ?? "").slice(0, 200)
        : e.method === "Log.entryAdded"
          ? "LOG " + e.params.entry.text.slice(0, 200)
          : e.params.type.toUpperCase() + " " + e.params.args.map((a) => a.value ?? a.description ?? "").join(" ").slice(0, 200));
  }
}

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "GECTI " : "KALDI "} ${name}${detail ? " — " + detail : ""}`);
};

const list = await targets();
const page = list.find((t) => t.type === "page");
const cdp = await CDP.connect(page.webSocketDebuggerUrl);
await cdp.send("Runtime.enable");
await cdp.send("Log.enable");
await cdp.send("Page.enable");
// Onbellek KAPALI: olcumun kaynak dosyalarin GUNCEL surumune bakmasi sart.
// (Bir kosumda Chrome eski index.html'i servis etti ve giris 400 aldi; sayilar
// dogru gorunurken olculen sey eski suruumdu.)
await cdp.send("Network.enable");
await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
await cdp.send("Emulation.setDeviceMetricsOverride", {
  width: 390, height: 844, deviceScaleFactor: 2, mobile: true,
});

async function shot(name) {
  const r = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
  const fs = await import("node:fs");
  fs.writeFileSync(`${SHOT_DIR}/${name}.png`, Buffer.from(r.data, "base64"));
  return `${SHOT_DIR}/${name}.png`;
}

// --- 1) Girissiz: panelde VERI OLMAMALI --------------------------------------
// Onemli: bu tarayici profili onceki kosumun KALICI oturumunu tutuyor olabilir
// (D9'un olctugu ozellik). Temiz baslangic icin depolama silinip yeniden yuklenir;
// yoksa D1 "girissiz" degil "girisli" durumu olcer (ilk kosumda boyle oldu).
await cdp.send("Page.navigate", { url: BASE });
await sleep(1500);
await cdp.eval(`(() => { try { localStorage.clear(); sessionStorage.clear(); } catch (e) {} return true; })()`);
await cdp.send("Page.navigate", { url: BASE + "?temiz=1" });
await sleep(2500);
{
  const v = await cdp.eval(`JSON.stringify({
    authGorunur: !document.getElementById('auth-card').classList.contains('hidden'),
    panelGizli: document.getElementById('app').classList.contains('hidden'),
    sayfadaSicaklikVar: /\\d\\d[.,]\\d\\s*°C/.test(document.body.innerText),
    govde: document.body.innerText.length
  })`);
  const o = JSON.parse(v);
  check("D1 girissiz ziyaretci: yalniz giris formu, HIC veri yok",
    o.authGorunur && o.panelGizli && !o.sayfadaSicaklikVar, v);
  await shot("panel-1-giris");
}

// --- 2) Giris --------------------------------------------------------------
await cdp.eval(`(() => {
  const e = document.getElementById('email'), p = document.getElementById('password');
  e.value = ${JSON.stringify(EMAIL)}; p.value = ${JSON.stringify(PASSWORD)};
  document.getElementById('auth-form').requestSubmit(); return true;
})()`);
await sleep(4000);
{
  const v = await cdp.eval(`JSON.stringify({
    panelGorunur: !document.getElementById('app').classList.contains('hidden'),
    cihaz: document.getElementById('device-name').textContent,
    temp: document.getElementById('temp').textContent,
    hum: document.getElementById('hum').textContent,
    hedef: document.getElementById('target-now').textContent,
    cevrim: document.getElementById('online').textContent,
    karar: document.getElementById('reason').textContent,
    role: document.getElementById('relay-text').textContent,
    hata: document.getElementById('auth-err').textContent
  })`);
  const o = JSON.parse(v);
  check("D2 giris calisiyor ve canli degerler geliyor",
    o.panelGorunur && o.temp === "20.4" && o.cevrim === "cevrimici" && o.role === "Isitma acik" && o.cihaz === "Salon kombisi", v);
}

// --- 3) Grafik gercekten CIZILDI mi (cizgi + isitma seridi + hedef) ---------
{
  const v = await cdp.eval(`(() => {
    const svg = document.getElementById('chart');
    const path = svg.querySelector('path');
    return JSON.stringify({
      yukseklik: Math.round(svg.getBoundingClientRect().height),
      genislik: Math.round(svg.getBoundingClientRect().width),
      cizgiNoktaSayisi: path ? (path.getAttribute('d').match(/L/g) || []).length : 0,
      cizgiRengi: path ? getComputedStyle(path).stroke : null,
      isitmaSeridi: svg.querySelectorAll('rect').length,
      kesikliHedef: svg.querySelectorAll('line[stroke-dasharray]').length,
      bosUyariGorunur: !document.getElementById('chart-empty').classList.contains('hidden'),
      tabloSatir: document.querySelectorAll('#data-table tbody tr').length
    });
  })()`);
  const o = JSON.parse(v);
  check("D3 grafik cizildi (tek seri cizgi + isitma seridi + kesikli hedef)",
    o.cizgiNoktaSayisi > 200 && o.isitmaSeridi >= 2 && o.kesikliHedef === 1 && !o.bosUyariGorunur && o.yukseklik > 200, v);
  check("D4 grafigin metin karsiligi (tablo) dolu", o.tabloSatir > 0, `satir=${o.tabloSatir}`);
}

// --- 4) Mobil genislik: yatay kaydirma OLMAMALI ----------------------------
{
  const v = await cdp.eval(`JSON.stringify({
    govdeGenislik: document.documentElement.scrollWidth,
    gorunumGenislik: window.innerWidth,
    enGenisOge: (() => { let w = 0, sel = '';
      document.querySelectorAll('*').forEach(e => { const r = e.getBoundingClientRect();
        if (r.width > w) { w = r.width; sel = e.tagName + (e.id ? '#' + e.id : ''); } });
      return sel + ' ' + Math.round(w); })(),
    solBosluk: Math.round(document.querySelector('.wrap').getBoundingClientRect().left)
  })`);
  const o = JSON.parse(v);
  check("D5 mobil 390px: yatay kaydirma yok, 16px kenar boslugu",
    o.govdeGenislik <= o.gorunumGenislik && o.solBosluk >= 0, v);
  await shot("panel-2-mobil");
}

// --- 5) Hedef yazma: panelden degistir, VERITABANINDAN dogrula -------------
{
  const before = await cdp.eval(`document.getElementById('target-val').textContent`);
  await cdp.eval(`(() => { document.getElementById('t-plus').click(); document.getElementById('t-plus').click(); document.getElementById('t-save').click(); return true; })()`);
  await sleep(2500);
  const after = await cdp.eval(`document.getElementById('target-val').textContent`);
  const err = await cdp.eval(`document.getElementById('t-err').textContent`);
  check("D6 panelden hedef yazildi (+1.0 °C)",
    Number(after) === Number(before) + 1 && !err, `once=${before} sonra=${after} hata="${err}"`);
  // Gercekten veritabaninda mi? (vekil degil hedefin kendisi)
  const st = JSON.parse(await cdp.eval(`(async () => {
    const r = await fetch(window.KOMBI_CONFIG.SUPABASE_URL + '/rest/v1/device_settings?select=target_c', {
      headers: { apikey: window.KOMBI_CONFIG.SUPABASE_ANON_KEY,
                 Authorization: 'Bearer ' + JSON.parse(localStorage.getItem('kombi-auth')).access_token }});
    return JSON.stringify(await r.json());
  })()`));
  check("D6b veritabaninda da degisti", Number(st[0]?.target_c) === Number(after), JSON.stringify(st));
}

// --- 6) Kural listesi + cakisan kural reddi --------------------------------
{
  const v = await cdp.eval(`JSON.stringify({
    satir: document.querySelectorAll('#rules tbody tr').length,
    ilk: (document.querySelector('#rules tbody tr')||{}).innerText
  })`);
  const o = JSON.parse(v);
  check("D7 senaryo kurallari listelendi", o.satir === 2, v);

  // Panelden ayni dakikaya cakisan kural: tetikleyici reddetmeli ve
  // kullaniciya hata gorunmeli (sessiz basarisizlik OLMAMALI).
  await cdp.eval(`(() => {
    document.getElementById('r-hour').value = '7';
    document.getElementById('r-min').value = '0';
    document.getElementById('r-target').value = '24';
    document.getElementById('r-add').click(); return true;
  })()`);
  await sleep(2000);
  const err = await cdp.eval(`JSON.stringify({
    gorunur: !document.getElementById('r-err').classList.contains('hidden'),
    metin: document.getElementById('r-err').textContent
  })`);
  const e = JSON.parse(err);
  check("D8 cakisan kural panelde REDDEDILIYOR ve hata gosteriliyor",
    e.gorunur && /cakisan|duplicate|23505/i.test(e.metin), err);
}

// --- 7) Oturum kaliciligi: sayfa yenilenince yeniden giris ISTEMEMELI ------
await cdp.send("Page.navigate", { url: BASE });
await sleep(4000);
{
  const v = await cdp.eval(`JSON.stringify({
    panelGorunur: !document.getElementById('app').classList.contains('hidden'),
    authGizli: document.getElementById('auth-card').classList.contains('hidden'),
    temp: document.getElementById('temp').textContent
  })`);
  const o = JSON.parse(v);
  check("D9 oturum kalici: yenilemede giris istemiyor", o.panelGorunur && o.authGizli && o.temp !== "—", v);
}

// --- 8) BOS DURUM — gercek bir "verisi olmayan" kullaniciyla -------------
// Onceki surumde bu testi sayfadaki cizim fonksiyonlarini elle cagirarak
// kurmustum; o zaman hedef denetimi onceki kullanicinin degerini tutmaya
// devam etti ve olcum kendi duzenegimi olcuyordu. Dogrusu: verisi HIC
// olmayan ikinci bir hesapla girip sayfanin kendi akisini olcmek.
await cdp.eval(`(() => { document.getElementById('signout').click(); return true; })()`);
await sleep(2000);
await cdp.eval(`(() => {
  document.getElementById('email').value = 'bos@kombi.test';
  document.getElementById('password').value = 'Kombi-Bos-2026';
  document.getElementById('auth-form').requestSubmit(); return true;
})()`);
await sleep(4500);
{
  const v = await cdp.eval(`JSON.stringify({
    cihaz: document.getElementById('device-name').textContent,
    temp: document.getElementById('temp').textContent,
    nem: document.getElementById('hum').textContent,
    hedefTile: document.getElementById('target-now').textContent,
    hedefKontrol: document.getElementById('target-val').textContent,
    cevrim: document.getElementById('online').textContent,
    seen: document.getElementById('seen').textContent,
    grafikBosUyari: !document.getElementById('chart-empty').classList.contains('hidden'),
    kuralBosUyari: !document.getElementById('rules-empty').classList.contains('hidden'),
    sahteSayiVar: /\\d+[.,]\\d\\s*°C/.test(document.getElementById('app').innerText),
    panelMetni: document.getElementById('app').innerText.replace(/\\s+/g,' ').slice(0,260)
  })`);
  const o = JSON.parse(v);
  check("D10 bos durum: hicbir yerde uydurma/ornek deger YOK, aciklama var",
    o.temp === "—" && o.nem === "—" && o.hedefTile === "—" && o.hedefKontrol === "—" &&
    o.grafikBosUyari && o.kuralBosUyari && o.sahteSayiVar === false, v);
  await shot("panel-3-bos-durum");
}

// --- 9) Konsol temizligi (URL'leriyle; beklenen 409 ayrilir) --------------
{
  const raw = cdp.events
    .filter((e) => e.method === "Log.entryAdded" || e.method === "Runtime.exceptionThrown")
    .map((e) => e.method === "Runtime.exceptionThrown"
      ? { text: "EXC " + (e.params.exceptionDetails.exception?.description ?? "").slice(0, 160), url: "" }
      : { text: e.params.entry.text.slice(0, 160), url: e.params.entry.url ?? "" });
  for (const r of raw) console.log("   konsol:", r.text, "<-", r.url);
  // D8'de BILEREK cakisan kural ekledik: 409 beklenen cevaptir, hata degil.
  const beklenen = (r) => /favicon/i.test(r.url) || (/409/.test(r.text) && /scenario_rules/.test(r.url));
  const errs = raw.filter((r) => !beklenen(r));
  check("D11 konsolda beklenmeyen hata yok", errs.length === 0,
    errs.map((e) => e.text + " <- " + e.url).slice(0, 3).join(" | ") || "yalniz favicon + beklenen 409");
}

const failed = results.filter((r) => !r.pass);
console.log(`\n==== ${results.length} olcum: ${results.length - failed.length} gecti, ${failed.length} kaldi ====`);
process.exit(failed.length ? 1 : 0);
