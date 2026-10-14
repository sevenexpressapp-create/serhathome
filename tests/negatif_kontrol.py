#!/usr/bin/env python3
"""Negatif kontrol / mutasyon kosumu — "aletin olu olmadiginin" kaniti.

Her duzeltme icin karar cekirdegine KASITLI bir hata geri konur ve ilgili
olcumun KIRMIZIYA dondugu gosterilir. Mutasyon kirmizi yapmiyorsa o olcum
hicbir sey kanitlamiyor demektir (olu alet sinifi).

Iki kol var:
  1. `pio test -e native` — 21 birim olcumu. Mutasyon DEPODAKI dosyaya
     uygulanir, kosum biter, dosya `git checkout` ile GERI ALINIR ve temiz
     oldugu ayrica dogrulanir.
  2. `tests/sync_test.mjs` — gercek HTTP + gercek Edge Function. Burada depo
     dosyasina DOKUNULMAZ: cekirdek gecici bir dizine kopyalanir, orada
     bozulur, ayri bir `core_cli` derlenir ve test o ikiliyle kosar.
     (Yerel yigin + `functions serve` acik olmali.)

Geri alma GIT'E GUVENMEZ: dosyanin baytlari kosum basinda bellege alinir ve
sonunda aynen geri yazilir, SHA-256 ile dogrulanir. (git checkout kullanmak,
commit'lenmemis calismayi silme riski tasir.)

Calistirma:
    python3 tests/negatif_kontrol.py            # her iki kol
    python3 tests/negatif_kontrol.py --native   # yalniz birim olcumleri
"""
import hashlib
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
CORE_DIR = ROOT / "firmware/lib/kombi_core"
CPP = CORE_DIR / "kombi_core.cpp"
HDR = CORE_DIR / "kombi_core.h"
CLI = ROOT / "firmware/tools/core_cli/main.cpp"

# (ad, hangi dosya, ara, yerine koy, hangi bulgu)
MUTANTS = [
    (
        "M1 K1: kural TABAN hedefi yeniden ezsin",
        CPP,
        "      effective_target_c_ = rules_.rules[idx].target_c;",
        "      effective_target_c_ = rules_.rules[idx].target_c;\n"
        "      settings_.target_c = effective_target_c_;  // MUTASYON (eski hata)",
        "K1",
    ),
    (
        "M2 K2: kenar tetikleme geri gelsin (yalniz tam dakikada)",
        CPP,
        "      if (back == 0 && rm > now_min) continue;  // bugun henuz gelmedi",
        "      if (rm != now_min) continue;  // MUTASYON (eski kenar tetikleme)",
        "K2",
    ),
    (
        "M3 Y1: kural karsilastirmasi tum diziyi okusun (memcmp)",
        CPP,
        "  for (uint8_t i = 0; i < a.count; i++) {\n"
        "    const Rule& x = a.rules[i];",
        "  if (memcmp(a.rules, b.rules, sizeof(a.rules)) != 0) return false;  // MUTASYON\n"
        "  for (uint8_t i = 0; i < a.count; i++) {\n"
        "    const Rule& x = a.rules[i];",
        "Y1",
    ),
    (
        "M4 Y2: donma mandalinin payi yine KONFOR BANDINDAN gelsin",
        CPP,
        "             last_temp_c_ >= settings_.freeze_guard_c + FREEZE_RELEASE_MARGIN_C) {",
        "             last_temp_c_ >= settings_.freeze_guard_c + settings_.hysteresis_c) {  // MUTASYON",
        "Y2",
    ),
    (
        "M5 Y3: emniyet sonrasi toparlanma yine beklemeye takilsin",
        CPP,
        "  if (want != heat_ && has_switched_ && !safety_recovery_ &&",
        "  if (want != heat_ && has_switched_ &&  // MUTASYON (emniyet donusu bekletiliyor)",
        "Y3",
    ),
    (
        "M6 YUKSEK-3: sensor zaman asimi tabani yine 10 sn olsun",
        CPP,
        "  s.sensor_timeout_s = clampu16(s.sensor_timeout_s, 60, 3600, changed);",
        "  s.sensor_timeout_s = clampu16(s.sensor_timeout_s, 10, 3600, changed);  // MUTASYON",
        "YUKSEK-3",
    ),
    (
        "M7 Y2(b): donma esigi hedefin ustune cikabilsin",
        CPP,
        "  if (s.freeze_guard_c > freeze_max) { s.freeze_guard_c = freeze_max; changed = true; }",
        "  (void)freeze_max;  // MUTASYON (kisit kaldirildi)",
        "Y2b",
    ),
    (
        "M8 O3: bant alt siniri sensorden turemesin (0.5)",
        HDR,
        "static const float MIN_BAND_C = 2.0f * SENSOR_RESOLUTION_C;     // = 2.0",
        "static const float MIN_BAND_C = 0.5f;  // MUTASYON",
        "O3",
    ),
]

# Gercek HTTP kolunda kosulacak mutasyonlar.
#
# M3 (Y1) BILEREK YOK: bu kusur sinifi "ilklendirilmemis yigin baytlari"ndan
# dogar. Olcum aletinin (core_cli) ve cihazin `nr{}` degiskeni artik
# sifirlanmis; ayrica `rules` global oldugu icin bos yuvalari da sifir.
# Yani HTTP kolunda mutant ile orijinal AYNI sonucu verir ve "yesil kaldi"
# yanilticidir. Bu sinifi ayirt eden alet birim olcumudur
# (test_bos_kural_yuvalari_nvs_yazdirmaz: cop baytli RuleSet) ve M3 orada
# KIRMIZI yapiyor. Olculdu 14.10.2026 — olu alet olarak yakalandi.
HTTP_MUTANTS = {"M1", "M2"}


def digest(path: pathlib.Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def apply_mutation(path: pathlib.Path, find: str, repl: str) -> None:
    text = path.read_text(encoding="utf-8")
    if text.count(find) < 1:
        raise SystemExit(f"MUTASYON KURULAMADI (desen yok): {path.name}\n{find[:80]}")
    path.write_text(text.replace(find, repl, 1), encoding="utf-8")


def run(cmd, cwd=None):
    return subprocess.run(cmd, cwd=cwd or ROOT, capture_output=True, text=True)


def main() -> int:
    only_native = "--native" in sys.argv
    # Dosyalarin ORIJINAL hali bellege alinir; her mutasyondan sonra aynen geri
    # yazilir ve SHA-256 ile dogrulanir.
    original = {p: (p.read_bytes(), digest(p)) for p in (CPP, HDR)}

    # Taban olcum: mutasyonsuz hal YESIL olmali, yoksa kirmizilar mutasyondan gelmez.
    base = run(["pio", "test", "-e", "native"], cwd=ROOT / "firmware")
    if base.returncode != 0:
        print("DUR: mutasyonsuz birim olcumleri KIRMIZI. Once onu duzeltin.")
        print(base.stdout[-2000:])
        return 2
    print("TABAN: mutasyonsuz `pio test -e native` YESIL\n")

    rows = []
    for name, path, find, repl, finding in MUTANTS:
        raw, want = original[path]
        apply_mutation(path, find, repl)
        # Mutasyonun GERCEKTEN uygulandigini olc (sessiz basarisizlik sinifi:
        # desen tutmazsa mutant ikizi orijinalle ayni olur ve "yesil kaldi" yaniltir).
        changed = digest(path) != want
        if not changed:
            path.write_bytes(raw)
            rows.append((name, finding, "MUTASYON DOSYAYI DEGISTIRMEDI", False))
            continue
        res = run(["pio", "test", "-e", "native"], cwd=ROOT / "firmware")
        failed_names = [
            ln.split(":")[-1].split("[")[0].strip()
            for ln in res.stdout.splitlines()
            if "[FAILED]" in ln
        ]
        path.write_bytes(raw)
        assert digest(path) == want, f"{path} geri alinamadi!"
        red = res.returncode != 0
        rows.append((name, finding, ("KIRMIZI: " + ", ".join(failed_names[:3])) if red
                     else "YESIL KALDI (olu alet!)", red))
        print(f"{'KIRMIZI ' if red else 'SORUN   '} {name} -> {rows[-1][2]}")

    # --- 2. kol: gercek HTTP ---
    http_rows = []
    if not only_native and os.environ.get("CORE_CLI"):
        for name, path, find, repl, finding in MUTANTS:
            tag = name.split()[0]
            if tag not in HTTP_MUTANTS:
                continue
            with tempfile.TemporaryDirectory(prefix="kombi-mutant-") as td:
                tdp = pathlib.Path(td)
                shutil.copy(CPP, tdp / "kombi_core.cpp")
                shutil.copy(HDR, tdp / "kombi_core.h")
                target = tdp / path.name
                apply_mutation(target, find, repl)
                binpath = tdp / "core_cli"
                comp = run(["c++", "-std=gnu++17", "-O1", "-I", str(tdp),
                            str(tdp / "kombi_core.cpp"), str(CLI), "-o", str(binpath)])
                if comp.returncode != 0:
                    http_rows.append((name, "DERLENEMEDI", False))
                    print(comp.stderr[-800:])
                    continue
                env = dict(os.environ, CORE_CLI=str(binpath))
                res = subprocess.run(["node", "tests/sync_test.mjs"], cwd=ROOT, env=env,
                                     capture_output=True, text=True)
                red = res.returncode != 0
                kaldi = [ln for ln in res.stdout.splitlines() if ln.startswith("KALDI")]
                http_rows.append((name, ("KIRMIZI: " + (kaldi[0][:90] if kaldi else "")) if red
                                  else "YESIL KALDI (olu alet!)", red))
                print(f"{'KIRMIZI ' if red else 'SORUN   '} [HTTP] {name} -> {http_rows[-1][1]}")
    elif not only_native:
        print("\n(HTTP kolu atlandi: CORE_CLI ortam degiskeni yok)")

    print("\n==== OZET ====")
    for name, finding, detail, red in rows:
        print(f"{'OK  ' if red else 'HATA'} {finding:9s} {name}")
    for name, detail, red in http_rows:
        print(f"{'OK  ' if red else 'HATA'} HTTP      {name}")
    bad = [r for r in rows if not r[3]] + [r for r in http_rows if not r[2]]
    print(f"\n{len(rows) + len(http_rows)} mutasyon, {len(bad)} tanesi KIRMIZI YAPMADI")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
