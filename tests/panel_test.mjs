// Dashboard'u GERCEK bir tarayicida olcer: giris, canli degerler, grafik,
// bos durum ve mobil genislik. Bagimliliksiz CDP surucusu (Node 24'un
// yerlesik WebSocket'i). Kendi profil dizini + kendi portu kullanilir ki
// baska bir ajanin tarayicisini EZMESIN.
const PORT = Number(process.env.CDP_PORT || 9444);
const BASE = process.env.PANEL_URL || "http://127.0.0.1:8788/index.html";
const EMAIL = "panel@kombi.test";
const PASSWORD = "Kombi-Panel-2026!";
const SHOT_DIR = process.env.SHOT_DIR || ".";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- YEREL YIGIN KAPISI (her seyden ONCE) -----------------------------------
// Bu takim YAZAN olcumler iceriyor: D17/D19 `device_settings`e gercekten yaziyor
// (hedef 5,5 °C / donma esigi 5,0 °C). Panelin hedefi `dashboard/config.js`den
// geliyor ve o dosya yayin aninda BULUT projesine kuruluyor — yani yanlis yone
// kosulursa Serhat Bey'in evindeki kombinin hedefi degisirdi.
// Kapi tarayici ACILMADAN once calisir: hedefi panelin kendi `config.js`inden
// okur, yerel degilse CANLIYA TEK ISTEK GITMEDEN cikar.
// (Ayni kapi: `seed_demo.mjs:9`, `rls_test.mjs`, `auth_policy_test.mjs`.)
{
  const cfgUrl = new URL("config.js", BASE).href;
  let hedef = null;
  try {
    const metin = await (await fetch(cfgUrl)).text();
    hedef = (/SUPABASE_URL:\s*["']([^"']+)["']/.exec(metin) || [])[1] || null;
  } catch (e) {
    console.error(`DUR: panelin yapilandirmasi okunamadi (${cfgUrl}): ${e.message}`);
    process.exit(2);
  }
  if (!hedef) {
    console.error(`DUR: ${cfgUrl} icinde SUPABASE_URL bulunamadi; hedefi dogrulayamadan kosmam.`);
    process.exit(2);
  }
  if (!/\/\/(127\.0\.0\.1|localhost)([:/]|$)/.test(hedef)) {
    console.error(`DUR: bu takim YAZAN olcumler iceriyor ve YALNIZ yerel yigina karsi kosar.\n` +
      `     Panelin hedefi: ${hedef}\n` +
      `     Yerel yigini baslatip paneli ona bakan bir config.js ile servis edin.`);
    process.exit(2);
  }
  console.log(`HEDEF: ${hedef} (yerel) — yazan olcumler icin kapi acik.`);
}

async function targets() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  return res.json();
}

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.waiters = new Map(); this.events = [];
    this.handlers = new Map();  // method -> fn(params)
  }
  on(method, fn) { if (fn) this.handlers.set(method, fn); else this.handlers.delete(method); }
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
      } else if (msg.method) {
        c.events.push(msg);
        const h = c.handlers.get(msg.method);
        if (h) h(msg.params);
      }
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

// Panel ondalik ayirici olarak VIRGUL kullaniyor (tr-TR); olcum sayilari
// karsilastirirken dizgeye degil SAYIYA bakar.
const say = (s) => Number(String(s).replace(",", "."));

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
// ⚠️ `Log.enable` ONCEKI kosumlarda biriken girdileri de GERI OYNATIYOR (ayni
// tarayici ornegi yeniden kullanilinca). Ilk kosumda bu yuzden D11, bir onceki
// kosumda BILEREK uretilmis 4 ag hatasini "beklenmeyen hata" sandi — yani
// olculen sey bu kosum degildi. Kayit burada sifirlanir.
await cdp.send("Log.clear");
cdp.events.length = 0;
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
    desenCalisiyor: /\\d\\d[.,]\\d\\s*°C/.test('ornek 21,6 °C metni'),
    govde: document.body.innerText.length
  })`);
  const o = JSON.parse(v);
  check("D1 girissiz ziyaretci: yalniz giris formu, HIC veri yok (desen kalibre)",
    o.desenCalisiyor && o.authGorunur && o.panelGizli && !o.sayfadaSicaklikVar, v);
  await shot("panel-1-giris");
}

// --- 2) Giris --------------------------------------------------------------
// Ikinci emniyet: sayfanin GERCEKTEN yukledigi yapilandirma yerel mi? (Ilk kapi
// `config.js`i dosya olarak okumustu; burada tarayicinin kullandigi deger
// olculuyor ve YAZAN adimlardan ONCE duruluyor.)
{
  const hedef = await cdp.eval(`window.KOMBI_CONFIG && window.KOMBI_CONFIG.SUPABASE_URL`);
  if (!/\/\/(127\.0\.0\.1|localhost)([:/]|$)/.test(String(hedef))) {
    console.error("DUR: tarayicidaki hedef yerel degil (" + hedef + "); yazan olcumler kosturulmaz.");
    process.exit(2);
  }
}
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
    o.panelGorunur && say(o.temp) === 20.4 && o.cevrim === "çevrimiçi" && o.role === "Kombi yanıyor" && o.cihaz === "Salon kombisi", v);
}

// --- 2b) K1: "SU AN NEDEN 25 °C?" panelde cevaplaniyor mu ------------------
{
  const v = await cdp.eval(`JSON.stringify({
    hedef: document.getElementById('target-now').textContent,
    kaynak: document.getElementById('target-src').textContent,
    hedefKontrol: document.getElementById('target-val').textContent
  })`);
  const o = JSON.parse(v);
  check("D12 (K1) yururlukteki hedef 25 ve KAYNAGI panelde yaziyor (07:00 senaryosu, taban 21,5)",
    o.hedef === "25,0 °C" && /07:00 senaryosu/.test(o.kaynak) && /21,5/.test(o.kaynak), v);
}

// --- 3) Grafik gercekten CIZILDI mi (sicaklik + zarf + yanma + basamakli
//        hedef + karar araligi) --------------------------------------------
// ⚠️ Secicileri `data-role`lere SIKILASTIRDIM. Eskiden "ilk <path>", "butun
// <rect>'ler" ve "kesikli cizgi sayisi TAM 1" olculuyordu. O sonuncusu
// tasarimi degil TOHUM VERISININ BIR TESADUFUNU olcuyordu: `seed_demo.mjs`
// hedefi hic degistirmiyor, o yuzden basamak sayisi 1 cikiyor. Gercek evdeki
// veride hedef gun icinde iki kez degisiyor ve ayni sayi 3 oluyordu — yani
// eski kapi, dogru calisan bir cizimi KIRMIZI yapardi. Beklenen basamak sayisi
// artik sayfadaki veriden TURETILIYOR.
{
  const v = await cdp.eval(`(() => {
    const svg = document.getElementById('chart');
    const sicaklik = svg.querySelector('path[data-role=temp]');
    const zarf = svg.querySelector('path[data-role=envelope]');
    // Hedef kac parcaya bolunmeli? Cizimden DEGIL, cizimin girdisinden hesapla.
    // ⚠️ Kural iki dalli: kayitlarin HICBIRINDE hedef yoksa (eski firmware)
    // tasarim "basamak uydurma, yururlukteki AYARI tek duzluk ciz" diyor, yani
    // beklenen 1'dir — 0 degil. Bunu yazmazsak kapi yine tohumun tesadufune
    // yaslanir (tohumda target_c dolu oldugu icin fark edilmez) ve dogru calisan
    // cizimi kirmizi yapar.
    const pts = lastRows.filter(r => r.temp !== null);
    // Dugum sayisi ARTIK veriye degil CIZIM GENISLIGINE bagli (1 px'lik
    // sutunlarda ozetleniyor): sabit ">200" dar pencerede dogru cizimi
    // kirmizi yapardi. Beklenti sayfanin kendi verisinden turetiliyor.
    const dKadans = yanmaDurumu();
    const plotWd = svg.viewBox.baseVal.width - 48, mld = 38;
    const Xd = (t) => mld + ((t - pts[0].t) / (pts[pts.length - 1].t - pts[0].t)) * plotWd;
    const kolD = new Map();
    for (const p of pts) {
      const k = Math.min(Math.round(plotWd) - 1, Math.max(0, Math.floor(Xd(p.t) - mld)));
      const c = kolD.get(k) || { t0: p.t, t1: p.t };
      c.t0 = Math.min(c.t0, p.t); c.t1 = Math.max(c.t1, p.t); kolD.set(k, c);
    }
    const kolSirali = [...kolD.keys()].sort((a, b) => a - b);
    let yolParca = kolSirali.length ? 1 : 0;
    for (let i = 1; i < kolSirali.length; i++) {
      if (kolD.get(kolSirali[i]).t0 - kolD.get(kolSirali[i - 1]).t1 > dKadans.esik) yolParca++;
    }
    const hedefi = (r) => (r.tg === null || r.tg === undefined) ? null : Number(r.tg);
    const hepsiBos = pts.every(r => hedefi(r) === null);
    let beklenenParca = 0;
    if (hepsiBos) {
      beklenenParca = (settings && settings.target_c !== null && settings.target_c !== undefined) ? 1 : 0;
    } else {
      let oncekiHedef = 'yok';
      for (const r of pts) {
        const tg = hedefi(r);
        if (tg !== oncekiHedef) { if (tg !== null) beklenenParca++; oncekiHedef = tg; }
      }
    }
    return JSON.stringify({
      yukseklik: Math.round(svg.getBoundingClientRect().height),
      genislik: Math.round(svg.getBoundingClientRect().width),
      cizgiNoktaSayisi: sicaklik ? (sicaklik.getAttribute('d').match(/L/g) || []).length : 0,
      cizgiRengi: sicaklik ? getComputedStyle(sicaklik).stroke : null,
      zarfL: zarf ? (zarf.getAttribute('d').match(/L/g) || []).length : 0,
      yanmaSeridi: svg.querySelectorAll('rect[data-role=burn]').length,
      kararAraligi: svg.querySelectorAll('rect[data-role=band]').length,
      kesikliHedef: svg.querySelectorAll('line[data-role=target][stroke-dasharray]').length,
      beklenenParca,
      beklenenDugum: kolSirali.length, beklenenYolParca: yolParca,
      bosUyariGorunur: !document.getElementById('chart-empty').classList.contains('hidden'),
      tabloSatir: document.querySelectorAll('#data-table tbody tr').length,
      tabloSutun: document.querySelectorAll('#data-table thead th').length
    });
  })()`);
  const o = JSON.parse(v);
  check("D3 grafik cizildi (sicaklik + zarf + yanma seridi + basamakli hedef + karar araligi)",
    o.cizgiNoktaSayisi === o.beklenenDugum - o.beklenenYolParca &&
    o.zarfL === 2 * o.beklenenDugum - o.beklenenYolParca &&
    o.beklenenDugum > 100 && o.yanmaSeridi >= 1 && o.kararAraligi >= 1 &&
    o.kesikliHedef >= 1 && o.kesikliHedef === o.beklenenParca &&
    !o.bosUyariGorunur && o.yukseklik > 200, v);
  check("D4 grafigin metin karsiligi (tablo) dolu ve Hedef sutunu var",
    o.tabloSatir > 0 && o.tabloSutun === 5, `satir=${o.tabloSatir} sutun=${o.tabloSutun}`);
}

// --- 3b) KART: kayit boslugu, sensor boslugu ve toplamlar -------------------
// ⚠️ Bu uc olcum kartin KENDISINI olcer. Once hicbiri yoktu: 21 kontrolun
// hicbiri `#burn-*`e dokunmuyordu, yani kart depoda OLCUSUZDU.
{
  const v = await cdp.eval(`(() => {
    const svg = document.getElementById('chart');
    const d = yanmaDurumu();
    const pts = lastRows.filter(r => r.temp !== null);
    const x0 = pts[0].t, x1 = pts[pts.length - 1].t;
    const plotW = svg.viewBox.baseVal.width - 48, ml = 38;
    const zaman = (x) => x0 + ((x - ml) / plotW) * (x1 - x0);
    const serit = [...svg.querySelectorAll('rect[data-role=burn]')].map(r => {
      const xa = Number(r.getAttribute('x')), w = Number(r.getAttribute('width'));
      return [zaman(xa), zaman(xa + w)];
    });
    // (a) Hicbir serit KAYIT BOSLUGUNU kopruleyemez.
    const deligeBinen = serit.filter(([sa, sb]) =>
      d.kayitBosluklari.some(([a, b]) => sa < b - 60000 && sb > a + 60000)).length;
    // (b) SENSOR boslugu (kayit var, sicaklik yok) bir yanmayi BOLMEMELI:
    //     hicbir serit kenari sensor boslugunun ICINDE bitmemeli/baslamamali.
    const sensorIcindeKenar = serit.filter(([sa, sb]) =>
      d.sensorBosluklari.some(([a, b]) => (sa > a && sa < b) || (sb > a && sb < b))).length;
    return JSON.stringify({
      kartDizi: d.diziler.length, grafikSerit: serit.length,
      kayitBoslugu: d.kayitBosluklari.length, sensorBoslugu: d.sensorBosluklari.length,
      kadansSn: Math.round(d.kadans / 1000),
      DELIGE_BINEN: deligeBinen, SENSOR_ICINDE_KENAR: sensorIcindeKenar,
      bosIsaretRect: svg.querySelectorAll('rect[data-role=gap]').length,
      sensorIsaretCizgi: svg.querySelectorAll('line[data-role=sensor-gap]').length
    });
  })()`);
  const o = JSON.parse(v);
  check("D21 kart ve grafik AYNI yanma dizisini kullaniyor; kayit boslugu kopru DEGIL, sensor boslugu yanmayi BOLMUYOR",
    o.kadansSn === 60 && o.kartDizi === o.grafikSerit && o.kayitBoslugu >= 1 && o.sensorBoslugu >= 1 &&
    o.DELIGE_BINEN === 0 && o.SENSOR_ICINDE_KENAR === 0 &&
    o.bosIsaretRect === o.kayitBoslugu && o.sensorIsaretCizgi === 2 * o.sensorBoslugu, v);
}

// --- 3c) KART TOPLAMLARI: sunucunun BAGIMSIZ sayimiyla birebir -------------
{
  const v = await cdp.eval(`(async () => {
    const say = async (suzgec) => {
      const r = await fetch(window.KOMBI_CONFIG.SUPABASE_URL + '/rest/v1/telemetry?select=id&' + suzgec, {
        headers: { apikey: window.KOMBI_CONFIG.SUPABASE_ANON_KEY,
                   Authorization: 'Bearer ' + JSON.parse(localStorage.getItem('kombi-auth')).access_token,
                   Prefer: 'count=exact', Range: '0-0' } });
      return Number((r.headers.get('content-range') || '0-0/0').split('/')[1]);
    };
    const gece = new Date(); gece.setHours(0, 0, 0, 0);
    const iso24 = new Date(Date.now() - 24 * 3600e3).toISOString();
    const bugunSatir = await say('device_id=eq.kombi-salon&relay_on=eq.true&ts=gte.' + gece.toISOString());
    const saat24Satir = await say('device_id=eq.kombi-salon&relay_on=eq.true&ts=gte.' + iso24);
    const kadans = yanmaDurumu().kadans;
    // ⚠️ Bu kod SABLON DIZGESI icinde yasiyor: \\d yazilmazsa kacis yutulur,
    // desen /(d+) sa/ olur ve sessizce 0 doner (ilk kosumda tam bu oldu).
    const dkCoz = (s) => { const a = /(\\d+) sa/.exec(s), b = /(\\d+) dk/.exec(s);
      // "—" SAYI DEGILDIR: 0 donseydi gece yarisina yakin pencerede
      // beklenen de 0 olur, "0 === 0" diye sahte yesil verirdi.
      if (!a && !b) return null;
      return (a ? Number(a[1]) * 60 : 0) + (b ? Number(b[1]) : 0); };
    // Alet kendi POZITIF KONTROLUNDEN gecsin (kacis yutulursa desen tutmaz).
    const cozucuCalisiyor = dkCoz("1 sa 53 dk") === 113 && dkCoz("—") === null;
    const kutu = [...document.getElementById('burn-tiles').querySelectorAll('.v')].map(v => v.textContent);
    return JSON.stringify({
      beklenenBugunDk: Math.round(bugunSatir * kadans / 60000),
      beklenen24Dk: Math.round(saat24Satir * kadans / 60000),
      cozucuCalisiyor,
      kartBugunDk: dkCoz(kutu[0]), kart24Dk: dkCoz(kutu[1]),
      kutular: kutu.join(' | '),
      // indirilen pencere kirpilmis olabilir: kart SUNUCU sayimini gostermeli
      indirilenSatir: lastRows.length, pencereYanikSatir: lastRows.filter(r => r.heat).length
    });
  })()`);
  const o = JSON.parse(v);
  check("D22 kart toplamlari sunucunun bagimsiz sayimiyla BIREBIR (indirilen pencere kirpilsa da)",
    o.cozucuCalisiyor && o.kartBugunDk === o.beklenenBugunDk && o.kart24Dk === o.beklenen24Dk &&
    o.beklenen24Dk > 0 && o.beklenenBugunDk > 0, v);
}

// --- 3d) SAYIM GELMEDEN "—" (0 degil, "veri yok" hic degil) ----------------
{
  const v = await cdp.eval(`(() => {
    const yedek = burnCounts;
    burnCounts = null; renderBurn();
    const bekleyen = {
      kutular: [...document.getElementById('burn-tiles').querySelectorAll('.v')].map(v => v.textContent).join('|'),
      bosCumle: !document.getElementById('burn-empty').classList.contains('hidden')
    };
    burnCounts = yedek; renderBurn();
    const gelince = {
      kutular: [...document.getElementById('burn-tiles').querySelectorAll('.v')].map(v => v.textContent).join('|'),
      bosCumle: !document.getElementById('burn-empty').classList.contains('hidden')
    };
    return JSON.stringify({ bekleyen, gelince });
  })()`);
  const o = JSON.parse(v);
  check("D23 sayim gelmeden kutucuklar '—' (0 YAZMIYOR, 'veri yok' DEMIYOR), gelince sayi",
    o.bekleyen.kutular === "—|—|—|—" && o.bekleyen.bosCumle === false &&
    !o.gelince.kutular.includes("—") && o.gelince.bosCumle === false, v);
}

// --- 3e) UC HAL: serinin BASINDA uzun sensor arizasi ----------------------
// Koordinatlar `temp_c` dolu satirlardan, isaretler ise TUM satirlardan
// turuyor. Serinin ucunda sensor olurse (role kaydi surerken sicaklik yok)
// isaret cizim alaninin disina dusuyordu: solda Y etiketlerinin uzerine.
// Tohumun sensor boslugu pencerenin ORTASINDA oldugu icin hicbir kapi bunu
// gormuyordu; burada bilerek uca tasiniyor.
{
  const v = await cdp.eval(`(() => {
    const yedekRows = lastRows;
    // Ilk 25 satir: kayit VAR, sicaklik YOK, role ACIK.
    lastRows = lastRows.map((r, i) => (i < 25 ? { ...r, temp: null, heat: true } : r));
    durumOnbellek = null;
    renderChart();
    const svg = document.getElementById('chart');
    const sol = 38, sag = svg.viewBox.baseVal.width - 10;
    const ucu = (el) => (el.tagName === 'rect'
      ? [Number(el.getAttribute('x')), Number(el.getAttribute('x')) + Number(el.getAttribute('width'))]
      : [Number(el.getAttribute('x1')), Number(el.getAttribute('x2'))]);
    const isaretler = [...svg.querySelectorAll(
      '[data-role=gap],[data-role=gap-edge],[data-role=sensor-gap],[data-role=burn]')].map(ucu);
    const tasan = isaretler.filter(([a, b]) => a < sol - 0.5 || b > sag + 0.5);
    const sonuc = {
      isaretSayisi: isaretler.length, TASAN: tasan.length, ornekTasan: tasan.slice(0, 3),
      alan: [sol, Math.round(sag)],
      ucSensorIsareti: svg.querySelectorAll('line[data-role=sensor-gap]').length
    };
    lastRows = yedekRows; durumOnbellek = null; renderChart();
    return JSON.stringify(sonuc);
  })()`);
  const o = JSON.parse(v);
  check("D24 serinin ucundaki sensor arizasinda isaretler cizim alanini TASMIYOR",
    o.TASAN === 0 && o.isaretSayisi > 0 && o.ucSensorIsareti >= 2, v);
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
  check("D6 panelden hedef yazildi (+1,0 °C)",
    say(after) === say(before) + 1 && !err, `once=${before} sonra=${after} hata="${err}"`);
  // Gercekten veritabaninda mi? (vekil degil hedefin kendisi)
  const st = JSON.parse(await cdp.eval(`(async () => {
    const r = await fetch(window.KOMBI_CONFIG.SUPABASE_URL + '/rest/v1/device_settings?select=target_c', {
      headers: { apikey: window.KOMBI_CONFIG.SUPABASE_ANON_KEY,
                 Authorization: 'Bearer ' + JSON.parse(localStorage.getItem('kombi-auth')).access_token }});
    return JSON.stringify(await r.json());
  })()`));
  check("D6b veritabaninda da degisti", Number(st[0]?.target_c) === say(after), JSON.stringify(st));
}

// --- 5b) SEMA KISITI: "evde yokken 5-6 °C" yolu acik mi? -------------------
// Sema kisiti: `freeze_guard_c <= target_c - 0.5`. Donma esigi 6,0 iken en
// kucuk KAYDEDILEBILIR hedef 6,5 (yerel yiginda olculdu: 6,5 -> 204,
// 6,0/5,5/5,0 -> 400 + 23514). Panel eskiden sayaci 5,0'a kadar aciyor, sonra
// ham Ingilizce kisit metnini ekrana basiyordu; yol tikaliydi.
//
// ⚠️ Bu blok BILEREK bir 400 uretiyor; D11'in beklenen hata listesinde var.
{
  const basTarget = Number(await cdp.eval(`Number(settings.target_c)`));
  const basFreeze = Number(await cdp.eval(`Number(settings.freeze_guard_c)`));

  // (a) Sayac semanin ALTINA inmiyor ve sirasi Turkce anlatiliyor.
  const a = JSON.parse(await cdp.eval(`(() => {
    for (let i = 0; i < 60; i++) document.getElementById('t-minus').click();
    return JSON.stringify({
      sayac: document.getElementById('target-val').textContent,
      taban: Number(settings.freeze_guard_c) + 0.5,
      uyariGorunur: !document.getElementById('t-err').classList.contains('hidden'),
      uyari: document.getElementById('t-err').textContent
    });
  })()`));
  check(`D17 hedef sayacinin tabani donma esiginden turuyor (${basFreeze} -> ${basFreeze + 0.5}) ve sirasi anlatiliyor`,
    say(a.sayac) === a.taban && a.taban === basFreeze + 0.5 && a.uyariGorunur &&
    /donma eşiği/i.test(a.uyari) && !/violates|constraint|new row|Failing row/i.test(a.uyari),
    JSON.stringify(a));

  // (b) REDDEDILEN YOL: gercek PATCH -> gercek 23514. Sayac artik bu degeri
  // uretemiyor; kisit yine de BILEREK ihlal ediliyor ki cevirinin KENDISI
  // olculsun (cihaz ya da baska bir oturum donma esigini degistirirse bu yol
  // hala kosar). Eksen: ham Postgres metni ekranda GORUNMEMELI.
  await cdp.eval(`(() => { pendingTarget = ${basFreeze}; document.getElementById('t-save').click(); return true; })()`);
  await sleep(2500);
  const b = JSON.parse(await cdp.eval(`JSON.stringify({
    gorunur: !document.getElementById('t-err').classList.contains('hidden'),
    metin: document.getElementById('t-err').textContent,
    dbTarget: null
  })`));
  check("D18 kisit hatasi (23514) TURKCE ve eyleme donuk; ham Postgres metni ekranda YOK",
    b.gorunur && /donma eşiği/i.test(b.metin) && /donma eşiğini düşür/i.test(b.metin) &&
    !/violates|check constraint|new row|Failing row|device_settings_/i.test(b.metin),
    JSON.stringify(b));

  // (c) BASARILI YOL: donma esigi 5,0'a cekilince hedef 5,5 GERCEKTEN kaydediliyor.
  await cdp.eval(`(() => {
    document.getElementById('s-freeze').value = '5';
    document.getElementById('s-save').click(); return true;
  })()`);
  await sleep(2500);
  await cdp.eval(`(() => {
    for (let i = 0; i < 60; i++) document.getElementById('t-minus').click();
    document.getElementById('t-save').click(); return true;
  })()`);
  await sleep(2500);
  const c = JSON.parse(await cdp.eval(`(async () => {
    const r = await fetch(window.KOMBI_CONFIG.SUPABASE_URL + '/rest/v1/device_settings?select=target_c,freeze_guard_c', {
      headers: { apikey: window.KOMBI_CONFIG.SUPABASE_ANON_KEY,
                 Authorization: 'Bearer ' + JSON.parse(localStorage.getItem('kombi-auth')).access_token }});
    const row = (await r.json())[0] || {};
    return JSON.stringify({ db: row,
      sayac: document.getElementById('target-val').textContent,
      hataGorunur: !document.getElementById('t-err').classList.contains('hidden') });
  })()`));
  check("D19 donma esigi 5,0'a cekilince hedef 5,5 VERITABANINA yaziliyor (yol tikali degil)",
    Number(c.db.target_c) === 5.5 && Number(c.db.freeze_guard_c) === 5 &&
    say(c.sayac) === 5.5 && c.hataGorunur === false, JSON.stringify(c));

  // Kalan olcumler icin baslangic durumuna DON. Sira onemli: once hedef
  // yukseltilir, sonra donma esigi — tersi ayni kisitla reddedilir.
  await cdp.eval(`(() => { pendingTarget = ${basTarget}; document.getElementById('t-save').click(); return true; })()`);
  await sleep(2000);
  await cdp.eval(`(() => { document.getElementById('s-freeze').value = '${basFreeze}';
    document.getElementById('s-save').click(); return true; })()`);
  await sleep(2000);
  const g = JSON.parse(await cdp.eval(`JSON.stringify({
    t: Number(settings.target_c), f: Number(settings.freeze_guard_c) })`));
  check("D20 olcum sonrasi baslangic durumu geri yuklendi (sonraki olcumler kirlenmedi)",
    g.t === basTarget && g.f === basFreeze, `beklenen t=${basTarget} f=${basFreeze} / ${JSON.stringify(g)}`);
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

// --- 8b) Y5: GRAFIK DINLEYICILERI BIRIKMIYOR ------------------------------
// Eksen: grafigin SVG elemanina EKLENEN dinleyici sayisi. Eskiden her cizimde
// 5 dinleyici ekleniyor, hic kaldirilmiyordu (15 sn yoklama -> saatte ~1.200).
{
  const v = await cdp.eval(`(() => {
    const svg = document.getElementById('chart');
    let eklenen = 0;
    const asil = svg.addEventListener.bind(svg);
    svg.addEventListener = (...a) => { eklenen++; return asil(...a); };
    // POZITIF KONTROL: sayacin GERCEKTEN saydigini olc (alet canli mi?).
    svg.addEventListener('mousemove', () => {});
    const sayacCalisiyor = eklenen === 1;
    eklenen = 0;
    // 10 kez yeniden ciz (panelin 2,5 dakikalik yoklamasina esdeger).
    for (let i = 0; i < 10; i++) renderChart();
    const sonuc = { sayacCalisiyor, onCizimdeEklenen: eklenen,
                    cizgiVar: !!svg.querySelector('path') };
    svg.addEventListener = asil;
    return JSON.stringify(sonuc);
  })()`);
  const o = JSON.parse(v);
  check("D13 (Y5) 10 yeniden cizimde SVG'ye 0 yeni dinleyici eklendi (sayac canli)",
    o.sayacCalisiyor === true && o.onCizimdeEklenen === 0 && o.cizgiVar, v);
}

// Buradan sonraki asamalar BILEREK ag hatasi/duraklatma uretiyor; D11 (konsol
// temizligi) bu kesme noktasindan oncesini "organik" sayar, sonrasinda ise
// yalniz ENJEKTE ettigimiz basarisizliklari mazur gorur.
const enjeksiyonBasi = cdp.events.length;

// --- 8c) Y6: VERI OKUNAMADI durumu BOS DURUMDAN ayri gosteriliyor ---------
// Eskiden dort sorgunun `.error` alani hic okunmuyordu: RLS/ag/oturum hatasi
// ekranda "Cihaz henuz hic baglanmadi" bos durumu gibi gorunuyordu.
//
// Hata GERCEK AG SEVIYESINDE uretiliyor (CDP `Fetch.failRequest`). Sayfadaki
// `window.fetch`i degistirmek ISE YARAMIYOR: supabase-js istemciyi kurarken
// `fetch` referansini bir kez yakaliyor — ilk kosumda bu yuzden "kesilen=0"
// cikti ve olcum hicbir sey olcmedi (olu alet, yakalandi).
{
  await cdp.send("Fetch.enable", {
    patterns: [{ urlPattern: "*/rest/v1/*", requestStage: "Request" }],
  });
  let kesilen = 0;
  cdp.on("Fetch.requestPaused", (p) => {
    kesilen++;
    cdp.send("Fetch.failRequest", { requestId: p.requestId, errorReason: "Failed" }).catch(() => {});
  });
  await cdp.eval(`refresh()`);
  await sleep(1500);
  cdp.on("Fetch.requestPaused", null);
  await cdp.send("Fetch.disable");

  const v = await cdp.eval(`JSON.stringify({
    hataGorunur: !document.getElementById('load-err').classList.contains('hidden'),
    hataMetni: document.getElementById('load-err').textContent.slice(0, 100),
    sicaklikKorundu: document.getElementById('temp').textContent,
    bosDurumMetniYok: !document.getElementById('seen').textContent.includes('henüz hiç bağlanmadı')
  })`);
  const o = JSON.parse(v);
  check("D14 (Y6) sorgu hatasi KULLANICIYA gosteriliyor ve bos durumla karistirilmiyor",
    kesilen > 0 && o.hataGorunur && /okunamadı/i.test(o.hataMetni) && o.bosDurumMetniYok,
    `kesilen=${kesilen} ${v}`);
}
// Hata gecince uyari KALKIYOR (yapiskan hata mesaji yok) — ayni eksen, hata yok.
{
  await cdp.eval(`refresh()`);
  await sleep(2000);
  const v = await cdp.eval(`JSON.stringify({
    hataGizli: document.getElementById('load-err').classList.contains('hidden'),
    temp: document.getElementById('temp').textContent
  })`);
  const o = JSON.parse(v);
  check("D15 (Y6) sorgu duzelince hata uyarisi kalkiyor", o.hataGizli && say(o.temp) === 20.4, v);
}

// --- 8d) ORTA-4: HESAPLAR ARASI YARIS HALI --------------------------------
// Senaryo: A'nin `device_state` istegi UCUSTA iken A cikar, B girer. A'nin
// geciken yaniti B'nin ekranina YAZILMAMALI. (D10 duzeltmesi ekrani
// sifirliyordu ama ucustaki yanitlari gecersizlestirmiyordu.)
// Istek CDP ile GERCEKTEN duraklatiliyor; oturum degistikten SONRA salinir.
{
  await cdp.send("Fetch.enable", {
    patterns: [{ urlPattern: "*/rest/v1/device_state*", requestStage: "Request" }],
  });
  const duraklayan = [];
  cdp.on("Fetch.requestPaused", (p) => duraklayan.push(p.requestId));

  cdp.eval(`refresh()`).catch(() => {});   // BEKLEMEDEN: istek ucusta kalsin
  await sleep(800);
  const duraklayanSayi = duraklayan.length;

  await cdp.eval(`(() => { document.getElementById('signout').click(); return true; })()`);
  await sleep(1500);
  await cdp.eval(`(() => {
    document.getElementById('email').value = 'bos@kombi.test';
    document.getElementById('password').value = 'Kombi-Bos-2026!x';
    document.getElementById('auth-form').requestSubmit(); return true;
  })()`);
  await sleep(4000);

  // A'nin duraklatilmis istegini SIMDI sal: cevap B'nin oturumunda doner.
  let salinan = 0, iptalEdilmis = 0;
  for (const id of duraklayan) {
    try { await cdp.send("Fetch.continueRequest", { requestId: id }); salinan++; }
    catch { iptalEdilmis++; }  // istek tarayici tarafindan IPTAL edilmis (AbortController)
  }
  await sleep(2500);
  cdp.on("Fetch.requestPaused", null);
  await cdp.send("Fetch.disable");

  const v = await cdp.eval(`JSON.stringify({
    cihaz: document.getElementById('device-name').textContent,
    temp: document.getElementById('temp').textContent,
    hedef: document.getElementById('target-now').textContent,
    kaynak: document.getElementById('target-src').textContent
  })`);
  const o = JSON.parse(v);
  check("D16 (ORTA-4) ucustaki istek oturum degisince ekrana YAZILMIYOR (A'nin 20.4'u B'de yok)",
    duraklayanSayi > 0 && o.temp === "—" && o.hedef === "—" && o.cihaz !== "Salon kombisi",
    `duraklatilan=${duraklayanSayi} salinan=${salinan} iptal_edilmis=${iptalEdilmis} ${v}`);
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
  document.getElementById('password').value = 'Kombi-Bos-2026!x';
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
    desenCalisiyor: /\\d+[.,]\\d\\s*°C/.test('ornek 21,6 °C metni'),
    panelMetni: document.getElementById('app').innerText.replace(/\\s+/g,' ').slice(0,260)
  })`);
  const o = JSON.parse(v);
  check("D10 bos durum: hicbir yerde uydurma/ornek deger YOK, aciklama var (desen kalibre)",
    o.desenCalisiyor && o.temp === "—" && o.nem === "—" && o.hedefTile === "—" && o.hedefKontrol === "—" &&
    o.grafikBosUyari && o.kuralBosUyari && o.sahteSayiVar === false, v);
  await shot("panel-3-bos-durum");
}

// --- 9) Konsol temizligi (URL'leriyle; BILEREK uretilen hatalar ayrilir) ---
{
  const raw = cdp.events
    .map((e, i) => ({ e, i }))
    .filter(({ e }) => e.method === "Log.entryAdded" || e.method === "Runtime.exceptionThrown")
    .map(({ e, i }) => e.method === "Runtime.exceptionThrown"
      ? { i, text: "EXC " + (e.params.exceptionDetails.exception?.description ?? "").slice(0, 160), url: "" }
      : { i, text: e.params.entry.text.slice(0, 160), url: e.params.entry.url ?? "" });
  for (const r of raw) console.log(`   konsol[${r.i}]:`, r.text, "<-", r.url);
  console.log(`   (enjeksiyon kesme noktasi: olay indeksi ${enjeksiyonBasi})`);
  // Beklenenler:
  //  · favicon (sunucuda yok)
  //  · D8'de BILEREK eklenen cakisan kural -> 409
  //  · D18'de BILEREK ihlal edilen hedef/donma esigi kisiti -> 400
  //  · D14/D16'da BILEREK kesilen/duraklatilan REST istekleri (enjeksiyon
  //    noktasindan SONRA ve yalniz ag hatasi olarak)
  const beklenen = (r) =>
    /favicon/i.test(r.url) ||
    (/409/.test(r.text) && /scenario_rules/.test(r.url)) ||
    (/400/.test(r.text) && /device_settings/.test(r.url)) ||
    (r.i >= enjeksiyonBasi && /ERR_FAILED|ERR_ABORTED|ERR_CONNECTION/.test(r.text) && /rest\/v1/.test(r.url));
  const errs = raw.filter((r) => !beklenen(r));
  check("D11 konsolda beklenmeyen hata yok (enjekte edilen hatalar ayri sayildi)", errs.length === 0,
    errs.map((e) => e.text + " <- " + e.url).slice(0, 3).join(" | ") ||
    `yalniz favicon + beklenen 409 + enjekte edilen ${raw.length - raw.filter((r) => r.i < enjeksiyonBasi).length} ag hatasi`);
}

const failed = results.filter((r) => !r.pass);
console.log(`\n==== ${results.length} olcum: ${results.length - failed.length} gecti, ${failed.length} kaldi ====`);
process.exit(failed.length ? 1 : 0);
