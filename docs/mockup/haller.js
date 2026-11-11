// haller.html — kartın ve grafiğin UÇ hâlleri. Her biri spec'teki bir kuralı gösterir.
"use strict";
const MM = window.__mockup;   // renderChart/renderBurn mockup.js'te global: yeniden TANIMLANMAZ
const MK = window.MOCK;
const G = (id) => document.getElementById(id);
const gunOnce = (n) => MK.now - n * 86400e3;

// 1 — kapalı, bugün hiç yanmadı; dün yanmış
MM.renderBurn(G("h1"), {
  canli: null, acik: false, sustuDk: null,
  sonYanma: { baslangic: gunOnce(1) + 4 * 3600e3 - 49 * 60e3, bitis: gunOnce(1) + 4 * 3600e3, dakika: 49 },
  toplam: { bugun: 0, saat24: 49, gun7: 85, gun30: 111 }, kapsamUyari: null, hata: null,
});

// 2 — yedi gündür hiç yanmadı (ölçülen 02–08.11 dönemi): sıfırlar BOZUK görünmemeli
MM.renderBurn(G("h2"), {
  canli: null, acik: false, sustuDk: null,
  sonYanma: { bitis: gunOnce(8) },            // 24 saatten eski: yalnız zaman, süre YOK
  toplam: { bugun: 0, saat24: 0, gun7: 0, gun30: 26 }, kapsamUyari: null, hata: null,
});

// 3 — cihaz sustu: "yanıyor" İDDİA EDİLMEZ
MM.renderBurn(G("h3"), {
  canli: null, acik: false, sustuDk: 23,
  sonYanma: { baslangic: MK.sonYanma.baslangic, bitis: MK.sonYanma.bitis, dakika: 49 },
  toplam: { bugun: 36, saat24: 85, gun7: 85, gun30: 111 }, kapsamUyari: null, hata: null,
});

// 4 — hiç veri yok: 0 dk DEĞİL, kart tek cümleye iner
MM.renderBurn(G("h4"), { canli: null, acik: false, sustuDk: null, sonYanma: null, toplam: null, kapsamUyari: null, hata: null });

// 5 — okunamadı: boş durumdan AYRI
MM.renderBurn(G("h5"), {
  canli: null, acik: false, sustuDk: null, sonYanma: null, toplam: null,
  kapsamUyari: null, hata: "Yanma süresi okunamadı — gösterilen bilgi güncel OLMAYABİLİR.",
});

// 6 — kayıt eksik: süre EKSİK olabilir, sessizce doğru gibi gösterilmez
MM.renderBurn(G("h6"), {
  canli: null, acik: false, sustuDk: null,
  sonYanma: { baslangic: gunOnce(1) + 4 * 3600e3 - 49 * 60e3, bitis: gunOnce(1) + 4 * 3600e3, dakika: 49 },
  toplam: { bugun: 0, saat24: 49, gun7: 85, gun30: null },
  kapsamUyari: "Son 30 günün 4 saati kayıtsız; 30 günlük toplam eksik olabilir.", hata: null,
});

// 7 — grafik: hedef bilinmiyor (target_c boş) -> basamak çizilmez, ayardaki hedef kullanılır
const rowsTargetsiz = MK.rows.map((r) => ({ ...r, target_c: null }));
const cizH = () => MM.renderChart(rowsTargetsiz, MK.ayar);
cizH();
window.addEventListener("resize", cizH);
