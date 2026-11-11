// MOCKUP — docs/TASARIM-grafik-ve-yanma-suresi.md'nin çizili hâli.
// Yayına GİTMEZ, panele kopyalanacak kod değildir: spec'teki ölçüleri
// (eksen alanı, basamaklı hedef, bant, sütun özetleme, kart halleri) gerçek
// tarayıcıda göstermek ve ölçmek için var. Veri sentetik (bkz. veri.js).
// CSP uyumu kasıtlı: satır içi <script> yok, dosya 'self'ten yükleniyor.
"use strict";

const SVG = "http://www.w3.org/2000/svg";
const el = (n, a) => { const e = document.createElementNS(SVG, n); for (const k in a) e.setAttribute(k, a[k]); return e; };
const vir = (n, d = 1) => Number(n).toFixed(d).replace(".", ",");
const hhmm = (t) => new Date(t).toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" });
const gunKisa = (t) => new Date(t).toLocaleDateString("tr-TR", { day: "numeric", month: "short" });

/* ---------- süre biçimi: 0 dk da geçerli bir ölçümdür -------------------- */
function sure(dk) {
  if (dk === null || dk === undefined || Number.isNaN(dk)) return null;   // bilinmiyor
  if (dk < 60) return dk + " dk";
  const s = Math.floor(dk / 60), k = dk % 60;
  return k === 0 ? s + " sa" : s + " sa " + k + " dk";
}

/* ---------- Y alanı: "yuvarlak" sınırlar + 0,5 ızgara ------------------- */
function yAlan(temps, bandLo, bandHi) {
  let lo = Math.min(...temps, bandLo), hi = Math.max(...temps, bandHi);
  lo = Math.floor((lo - 0.3) * 2) / 2;          // 0,5'e DIŞA yuvarla
  hi = Math.ceil((hi + 0.3) * 2) / 2;
  if (hi - lo < 2) { const c = (hi + lo) / 2; lo = Math.floor((c - 1) * 2) / 2; hi = Math.ceil((c + 1) * 2) / 2; }
  return [lo, hi];
}
function yAdim(lo, hi, plotH) {
  for (const s of [0.5, 1, 2]) if (plotH / ((hi - lo) / s) >= 40) return s;   // etiket aralığı ≥ 40 px
  return 2;
}
function xAdimSaat(plotW, saat) {
  for (const s of [1, 2, 3, 4, 6, 12]) if ((plotW / saat) * s >= 45) return s; // "02:00" ≈ 29 px + 16 px boşluk
  return 12;
}

/* ---------- grafik ------------------------------------------------------- */
function renderChart(rows, ayar) {
  const svg = document.getElementById("chart");
  svg.innerHTML = "";
  const pts = rows.filter((r) => r.temp_c !== null)
    .map((r) => ({ t: Date.parse(r.ts), v: r.temp_c, heat: r.relay_on, tg: r.target_c }));
  document.getElementById("chart-empty").classList.toggle("hidden", pts.length >= 2);
  if (pts.length < 2) { svg.style.height = "0px"; return; }
  svg.style.height = "240px";

  const w = svg.clientWidth || 360, h = 240;
  const m = { t: 12, r: 10, b: 42, l: 38 };     // l: 34 -> 38 ("20,0" tek ondalıkla sığsın)
  const ribbonH = 10, gap = 6;
  const plotH = h - m.t - m.b - ribbonH - gap;  // = 174
  const plotW = w - m.l - m.r;
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  svg.appendChild(el("title", {})).textContent =
    "Oda sıcaklığı, hedef ve kombinin karar aralığı — son 24 saat";

  const x0 = pts[0].t, x1 = pts[pts.length - 1].t;
  const band = Number(ayar.hysteresis_c) / 2;
  const tgSon = pts[pts.length - 1].tg ?? Number(ayar.target_c);
  const [lo, hi] = yAlan(pts.map((p) => p.v), tgSon - band, tgSon + band);
  const X = (t) => m.l + ((t - x0) / (x1 - x0)) * plotW;
  const Y = (v) => m.t + plotH - ((v - lo) / (hi - lo)) * plotH;
  const kirp = (v) => Math.min(m.t + plotH, Math.max(m.t, Y(v)));

  // 1) yatay ızgara + Y etiketleri (tek ondalık, çizgiyle AYNI değer)
  const ya = yAdim(lo, hi, plotH);
  for (let v = Math.ceil(lo / ya) * ya; v <= hi + 1e-9; v += ya) {
    svg.appendChild(el("line", { x1: m.l, x2: m.l + plotW, y1: Y(v), y2: Y(v), stroke: "var(--grid)", "stroke-width": 1 }));
    const tx = el("text", { x: m.l - 6, y: Y(v) + 4, "text-anchor": "end", fill: "var(--text-2)", "font-size": 11 });
    tx.textContent = vir(v);
    svg.appendChild(tx);
  }

  // 2) hedefin basamakları + karar aralığı (yakma/söndürme) şeridi
  let seg = [];
  for (const p of pts) {
    const tg = p.tg === null || p.tg === undefined ? null : Number(p.tg);
    const son = seg[seg.length - 1];
    if (!son || son.tg !== tg) seg.push({ tg, t0: p.t, t1: p.t });
    else son.t1 = p.t;
  }
  // Kayıtlarda hedef YOKSA (eski firmware): basamak UYDURULMAZ; yürürlükteki
  // ayarın hedefi tek düzlük olarak çizilir ve göstergede "şu anki ayar" denir.
  const hedefTahmini = seg.every((s) => s.tg === null);
  if (hedefTahmini) seg = [{ tg: Number(ayar.target_c), t0: x0, t1: x1 }];
  for (const s of seg) {
    if (s.tg === null) continue;                       // hedef bilinmiyorsa BOŞLUK bırak
    const yTop = kirp(s.tg + band), yBot = kirp(s.tg - band);
    const xa = X(s.t0), xb = X(s.t1);
    svg.appendChild(el("rect", {
      x: xa, y: yTop, width: Math.max(1, xb - xa), height: Math.max(0, yBot - yTop),
      fill: "var(--muted)", "fill-opacity": 0.11, "data-role": "band",
    }));
    for (const [v, y] of [[s.tg - band, yBot], [s.tg + band, yTop]]) {   // yakma / söndürme eşiği
      if (v < lo || v > hi) continue;
      svg.appendChild(el("line", { x1: xa, x2: xb, y1: y, y2: y, stroke: "var(--muted)", "stroke-width": 1, opacity: 0.4, "data-role": "band-edge" }));
    }
  }
  for (let i = 0; i < seg.length; i++) {
    const s = seg[i];
    if (s.tg === null) continue;
    svg.appendChild(el("line", {                       // yatay basamak: KESİKLİ
      x1: X(s.t0), x2: X(s.t1), y1: Y(s.tg), y2: Y(s.tg),
      stroke: "var(--muted)", "stroke-width": 1.5, "stroke-dasharray": "5 4", "data-role": "target",
    }));
    const on = seg[i + 1];
    if (on && on.tg !== null) svg.appendChild(el("line", {   // dikey bağlantı: DÜZ (kesikli değil)
      x1: X(on.t0), x2: X(on.t0), y1: Y(s.tg), y2: Y(on.tg),
      stroke: "var(--muted)", "stroke-width": 1, opacity: 0.55, "data-role": "target-step",
    }));
  }

  // 3) dikey ızgara + X etiketleri: YUVARLAK saat
  const saat = (x1 - x0) / 3600e3;
  const xs = xAdimSaat(plotW, saat);
  const ilk = new Date(x0); ilk.setMinutes(0, 0, 0);
  while (ilk.getHours() % xs !== 0) ilk.setHours(ilk.getHours() + 1);
  for (let t = ilk.getTime(); t <= x1; t += xs * 3600e3) {
    if (t < x0) continue;
    const x = X(t), geceYarisi = new Date(t).getHours() === 0;
    svg.appendChild(el("line", { x1: x, x2: x, y1: m.t, y2: m.t + plotH, stroke: "var(--grid)", "stroke-width": 1 }));
    if (x - m.l < 14 || m.l + plotW - x < 14) continue;      // kenara taşacak etiket YAZILMAZ
    const tx = el("text", { x, y: h - 20, "text-anchor": "middle", fill: "var(--text-2)", "font-size": 11, "data-role": "xlabel" });
    tx.textContent = hhmm(t);
    svg.appendChild(tx);
    if (geceYarisi) {                                        // gün sınırı: hangi gün?
      const d = el("text", { x, y: h - 7, "text-anchor": "middle", fill: "var(--muted)", "font-size": 10 });
      d.textContent = gunKisa(t);
      svg.appendChild(d);
    }
  }

  // 4) kombinin yanık olduğu aralıklar (şerit)
  const ry = m.t + plotH + gap;
  for (let i = 0; i < pts.length; ) {
    if (!pts[i].heat) { i++; continue; }
    let j = i; while (j + 1 < pts.length && pts[j + 1].heat) j++;
    const xa = X(pts[i].t), xb = Math.max(X(pts[j].t), xa + 2);
    svg.appendChild(el("rect", { x: xa, y: ry, width: xb - xa, height: ribbonH, rx: 3, fill: "var(--series-2)", "fill-opacity": 0.9, "data-role": "burn" }));
    i = j + 1;
  }
  svg.appendChild(el("line", { x1: m.l, x2: m.l + plotW, y1: ry + ribbonH + 0.5, y2: ry + ribbonH + 0.5, stroke: "var(--axis)", "stroke-width": 1 }));

  // 5) sıcaklık: 1 CSS px'lik sütunlarda özetle (en düşük–en yüksek zarf + ortalama)
  const kol = new Array(Math.max(1, Math.round(plotW)));
  for (const p of pts) {
    const k = Math.min(kol.length - 1, Math.max(0, Math.floor(X(p.t) - m.l)));
    const c = kol[k] || (kol[k] = { n: 0, s: 0, mn: Infinity, mx: -Infinity, x: m.l + k + 0.5 });
    c.n++; c.s += p.v; c.mn = Math.min(c.mn, p.v); c.mx = Math.max(c.mx, p.v);
  }
  const dolu = kol.filter(Boolean);
  let up = "", dn = "";
  dolu.forEach((c, i) => { up += (i ? "L" : "M") + c.x.toFixed(1) + " " + Y(c.mx).toFixed(1) + " "; });
  for (let i = dolu.length - 1; i >= 0; i--) dn += "L" + dolu[i].x.toFixed(1) + " " + Y(dolu[i].mn).toFixed(1) + " ";
  svg.appendChild(el("path", { d: up + dn + "Z", fill: "var(--series-1)", "fill-opacity": 0.22, stroke: "none", "data-role": "envelope" }));
  let d = "";
  dolu.forEach((c, i) => { d += (i ? "L" : "M") + c.x.toFixed(1) + " " + Y(c.s / c.n).toFixed(1) + " "; });
  svg.appendChild(el("path", { d, fill: "none", stroke: "var(--series-1)", "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round", "data-role": "temp" }));

  // 6) son değer
  const son = pts[pts.length - 1];
  svg.appendChild(el("circle", { cx: X(son.t), cy: Y(son.v), r: 4, fill: "var(--series-1)", stroke: "var(--surface)", "stroke-width": 2 }));

  // 7) açıklayıcı metin + gösterge (sayılar İÇİNDE: grafikte etiket kalabalığı yok)
  const yak = vir(tgSon - band), sondur = vir(tgSon + band);
  document.getElementById("lg-target").textContent = "Hedef " + vir(tgSon) + " °C" + (hedefTahmini ? " (şu anki ayar)" : "");
  document.getElementById("lg-band").textContent = "Karar aralığı " + yak + "–" + sondur + " °C";
  document.getElementById("explain").textContent =
    "Oda " + yak + " °C'ye düşünce kombi yanar, " + sondur + " °C'ye çıkınca söner; arada kalınca son durumunu korur." +
    (seg.filter((s) => s.tg !== null).length > 1 ? " Hedef gün içinde değişince bu aralık da kayar." : "");
  return { plotW, plotH, lo, hi, ya, xs, sutun: dolu.length, zarf: dolu.map((c) => c.mx - c.mn) };
}

/* ---------- tablo: grafiğin metin karşılığı (Hedef sütunu YENİ) ---------- */
function renderTable(rows) {
  const tb = document.querySelector("#data-table tbody");
  tb.innerHTML = "";
  for (const r of rows.slice(-60).reverse()) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${hhmm(Date.parse(r.ts))}</td><td class="num">${vir(r.temp_c)}</td>` +
      `<td class="num">${r.target_c === null ? "—" : vir(r.target_c)}</td>` +
      `<td class="num">${r.humidity} %</td><td>${r.relay_on ? "yandı" : "—"}</td>`;
    tb.appendChild(tr);
  }
}

/* ---------- yanma süresi kartı ------------------------------------------ */
// hal: { canli: dk|null, acik: bool, sonYanma: {baslangic,bitis,dakika}|null,
//        toplam: {bugun,saat24,gun7,gun30}|null, kapsamUyari: string|null,
//        hata: string|null, sustuDk: number|null }
function renderBurn(root, hal) {
  const q = (s) => root.querySelector(s);
  const veriYok = hal.toplam === null && !hal.hata;
  q(".burn-body").classList.toggle("hidden", veriYok || !!hal.hata);
  q(".burn-empty").classList.toggle("hidden", !veriYok);
  q(".burn-err").classList.toggle("hidden", !hal.hata);
  if (hal.hata) { q(".burn-err").textContent = hal.hata; return; }
  if (veriYok) return;

  const dot = q(".burn-dot"), pill = q(".burn-pill-text");
  dot.style.background = hal.acik ? "var(--series-2)" : "var(--muted)";
  pill.textContent = hal.sustuDk !== null ? "Cihaz veri göndermiyor" : hal.acik ? "Kombi şu an yanıyor" : "Kombi şu an kapalı";

  const pre = q(".burn-pre"), num = q(".burn-num"), tail = q(".burn-tail");
  if (hal.sustuDk !== null) {
    // Cihaz sustuysa BÜYÜK sayı yok: "—" 28 px'te çubuk gibi görünüyor ve
    // bilinmeyen bir şeyi vurgulamanın anlamı yok. Cümleye iner.
    pre.textContent = ""; num.textContent = ""; num.classList.add("unknown");
    tail.textContent = "Son " + sure(hal.sustuDk) + " veri gelmedi; kombi yanıyor mu bilinmiyor.";
  } else if (hal.acik) {
    num.classList.remove("unknown");
    pre.textContent = ""; num.textContent = sure(hal.canli); tail.textContent = "boyunca yanıyor";
  } else {
    num.classList.remove("unknown");
    pre.textContent = "Bugün"; num.textContent = sure(hal.toplam.bugun); tail.textContent = "yandı";
  }

  // Son yanma: 24 saatlik pencere ZATEN elde (ek sorgu yok) -> başlangıç+bitiş+süre.
  // Daha eskisi için yalnız TEK satırlık ucuz sorgu var: sadece zaman yazılır,
  // süre UYDURULMAZ.
  const sy = hal.sonYanma;
  const gun = (t) => (new Date(t).toDateString() === new Date(M.now).toDateString() ? "bugün " : gunKisa(t) + " ");
  q(".burn-sub").textContent =
    (hal.sustuDk !== null ? "Toplamlar son gelen veriye kadar. " : "") +
    (!sy ? "Kayıtlarda (30 gün) hiç yanma yok."
      : sy.baslangic
        ? "Son yanma " + gun(sy.bitis) + hhmm(sy.baslangic) + "–" + hhmm(sy.bitis) + " · " + sure(sy.dakika)
        : "Son yanma " + gun(sy.bitis) + hhmm(sy.bitis) + " dolayında");

  const t = hal.toplam;
  const tiles = [["Bugün", t.bugun], ["24 saat", t.saat24], ["7 gün", t.gun7], ["30 gün", t.gun30]];
  const box = q(".burn-tiles");
  box.innerHTML = "";
  for (const [k, v] of tiles) {
    const d = document.createElement("div");
    d.className = "tile";
    d.innerHTML = `<div class="k">${k}</div><div class="v${v === null ? " unknown" : ""}">${v === null ? "—" : sure(v)}</div>`;
    box.appendChild(d);
  }
  q(".burn-note").textContent =
    (hal.kapsamUyari ? hal.kapsamUyari + " " : "") +
    "Süreler dakikaya yuvarlanır; her yanma için 1 dakikaya kadar sapabilir. Kayıtlar 30 gün tutulur.";
}

/* ---------- kur ---------------------------------------------------------- */
window.__mockup = { renderChart, renderTable, renderBurn, sure };
const M = window.MOCK;
let olcum = null;
if (document.getElementById("chart") && document.getElementById("data-table")) {
  const ciz = () => { olcum = renderChart(M.rows, M.ayar); renderTable(M.rows); };
  ciz();
  window.addEventListener("resize", ciz);
  window.__olcum = () => olcum;
}
if (document.getElementById("burn-card")) {
  renderBurn(document.getElementById("burn-card"), {
    canli: 36, acik: true, sustuDk: null,
    sonYanma: M.sonYanma, toplam: M.toplam, kapsamUyari: null, hata: null,
  });
}
