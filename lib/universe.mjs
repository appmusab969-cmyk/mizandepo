// Hisse evreni — "en popüler ~1500 ABD hissesi"
// =============================================
// Eskiden evren yalnızca S&P 500 bileşenleri CSV'siydi (~500 sembol). Artık
// hedef ~1500. Üçüncü bir veri sağlayıcı KULLANMADAN, yalnızca SEC'in kendi
// açık verisiyle bir "en büyük 1500" listesi kurarız:
//
//   1. Çekirdek liste: S&P 500 bileşenleri CSV'si (datasets/ aynası) — sektör
//      adları buradan gelir, hepsi kesin dahil.
//   2. Doldurma: SEC `company_tickers.json` (zaten indiriliyor) tüm ABD borsa
//      şirketlerini verir. Her aday için `cache-slim/` (ya da hafif bir EDGAR
//      taraması) `sharesOutstanding` + son fiyat → yaklaşık piyasa değeri.
//      Piyasa değerine göre azalan sıralayıp 1500'e tamamlarız.
//   3. Sonuç `universe-1500.json` olarak repoya commit'lenir. Sıralama pahalı
//      olduğu için 90 günde bir yenilenir; aradaki haftalar bu sabit listeyi
//      tam tarar (belirlenimci sonuç, tekrarlanabilir commit'ler).
//
// Neden piyasa değeri? "Popülerlik" için en dayanıklı, manipüle edilemez ve
// resmî kaynaktan türetilebilen ölçüt odur; işlem hacmi SEC'te yok.

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { cachedFetch } from './http.mjs';

const SP500_CSV =
  'https://raw.githubusercontent.com/datasets/s-and-p-500-companies/main/data/constituents.csv';

// Bu kadar hisse hedefliyoruz. Actions iş limiti (55 dk) ve stocks.json indirme
// boyutu (~3-4 MB) göz önünde: 1500 güvenli üst sınır. Artırmak istersen
// workflow timeout'unu ve MIN_GAP_MS'i de gözden geçir.
export const TARGET_SIZE = Number(process.env.UNIVERSE_SIZE || 1500);

// universe-1500.json bu kadar günden eskiyse yeniden sıralanır. Aradaki
// haftalarda dokunulmaz → commit gürültüsü olmaz.
const RANK_MAX_AGE_DAYS = 90;

// Sıralama sinyali: SEC XBRL "frames" API'si — TEK istekte binlerce şirketin
// aynı kavramdaki değerini döndürür. `dei/EntityPublicFloat` (halka açık
// dolaşımdaki hisselerin piyasa değeri) "popülerlik" için mükemmel bir vekil
// ve fiyat çekmeye gerek bırakmaz. Şirketler farklı mali takvimlerde beyan
// verdiği için birkaç çeyreğin birleşimini alırız (~5000+ tekil şirket).
const FLOAT_FRAMES = [
  'CY2025Q2I', 'CY2024Q2I', 'CY2023Q2I',
  'CY2025Q1I', 'CY2024Q4I', 'CY2025Q3I', 'CY2024Q3I', 'CY2024Q1I',
];

const SECTOR_TR = {
  'Information Technology': 'Teknoloji',
  'Health Care': 'Sağlık',
  Financials: 'Finans',
  'Consumer Discretionary': 'Tüketici (döngüsel)',
  'Consumer Staples': 'Tüketici (savunmacı)',
  'Communication Services': 'İletişim',
  Industrials: 'Sanayi',
  Energy: 'Enerji',
  Materials: 'Temel malzeme',
  'Real Estate': 'Gayrimenkul',
  Utilities: 'Kamu hizmetleri',
};

function trSector(raw) {
  const s = (raw || '').trim();
  return SECTOR_TR[s] || s || '—';
}

function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQ && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else inQ = !inQ;
    } else if (ch === ',' && !inQ) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

/** S&P 500 CSV → Map<SYMBOL, {symbol, name, sector, cik}>. */
async function loadSp500(cacheRoot) {
  const { data: csv } = await cachedFetch(cacheRoot, 'sp500_constituents', SP500_CSV, {
    maxAgeDays: 7,
    accept: 'text/csv',
    as: 'text',
  });
  const lines = csv.trim().split(/\r?\n/);
  lines.shift(); // başlık
  const map = new Map();
  for (const line of lines) {
    const cells = parseCsvLine(line);
    if (cells.length < 7) continue;
    const [symbol, name, sector, , , , cik] = cells;
    const sym = symbol.trim().toUpperCase();
    map.set(sym, {
      symbol: sym,
      name: name.trim(),
      sector: trSector(sector),
      cik: cik ? cik.trim().padStart(10, '0') : null,
    });
  }
  return map;
}

/** Kayıtlı evren dosyası taze mi? */
function isFresh(saved) {
  if (!saved?.rankedAt || !Array.isArray(saved.symbols)) return false;
  const ageDays = (Date.now() - Date.parse(saved.rankedAt)) / 86_400_000;
  return ageDays < RANK_MAX_AGE_DAYS && saved.symbols.length >= saved.targetSize * 0.9;
}

/**
 * Evreni döndürür: [{symbol, name, sector, cik}] — çekirdek S&P 500 + piyasa
 * değerine göre en büyükler, TARGET_SIZE'a kadar.
 *
 * `universe-1500.json` taze ise doğrudan ondan kurulur (hızlı, belirlenimci).
 * Değilse SEC ticker haritası taranıp yeniden sıralanır ve dosya güncellenir.
 *
 * @param {object} opts
 * @param {string} opts.cacheRoot   ham yanıt cache klasörü
 * @param {string} opts.slimRoot    çıkarılmış özet cache klasörü
 * @param {string} opts.repoRoot    universe-1500.json'ın yazılacağı klasör
 * @param {Map}    opts.tickerMap   loadTickerMap() çıktısı
 * @param {boolean} [opts.forceRank] taze olsa bile yeniden sırala
 */
export async function loadUniverse({ cacheRoot, slimRoot, repoRoot, tickerMap, forceRank = false }) {
  const universeFile = join(repoRoot, 'universe-1500.json');
  const sp500 = await loadSp500(cacheRoot);

  let saved = null;
  try {
    saved = JSON.parse(await readFile(universeFile, 'utf8'));
  } catch {
    saved = null;
  }

  // --- Hızlı yol: kayıtlı liste taze ---
  if (!forceRank && isFresh(saved)) {
    const rows = [];
    for (const sym of saved.symbols) {
      const core = sp500.get(sym);
      if (core) {
        rows.push(core);
        continue;
      }
      const meta = tickerMap.get(sym);
      rows.push({
        symbol: sym,
        name: meta?.title || sym,
        sector: '—', // S&P dışı: sektör CSV'de yok, EDGAR SIC'i build sırasında zaten var
        cik: meta?.cik || null,
      });
    }
    console.log(
      `Evren: universe-1500.json'dan ${rows.length} hisse (son sıralama ${saved.rankedAt.slice(0, 10)}).`,
    );
    return rows;
  }

  // --- Yavaş yol: yeniden sırala ---
  console.log(
    `Evren yeniden sıralanıyor (kayıt yok ya da ${RANK_MAX_AGE_DAYS} günden eski)...`,
  );

  // Çekirdek: tüm S&P 500 — koşulsuz dahil.
  const chosen = new Map(); // SYMBOL -> {row, float}
  for (const [sym, core] of sp500) chosen.set(sym, { row: core, float: Infinity });

  // CIK → en yüksek halka açık dolaşım değeri (birden çok çeyrekten).
  const floatByCik = new Map();
  for (const frame of FLOAT_FRAMES) {
    let data;
    try {
      const res = await cachedFetch(
        cacheRoot,
        `xbrl_float_${frame}`,
        `https://data.sec.gov/api/xbrl/frames/dei/EntityPublicFloat/USD/${frame}.json`,
        { maxAgeDays: RANK_MAX_AGE_DAYS },
      );
      data = res.data;
    } catch (err) {
      console.warn(`  frame ${frame} atlandı: ${err.message}`);
      continue;
    }
    let added = 0;
    for (const row of data.data ?? []) {
      const cik = String(row.cik).padStart(10, '0');
      const val = Number(row.val) || 0;
      if (val <= 0) continue;
      if (val > (floatByCik.get(cik) ?? 0)) {
        floatByCik.set(cik, val);
        added++;
      }
    }
    console.log(`  frame ${frame}: ${data.data?.length ?? 0} kayıt, ${added} yeni/güncel`);
  }
  console.log(`  toplam ${floatByCik.size} tekil şirketin halka açık dolaşım değeri var.`);

  // Adaylar: SEC ticker haritasındaki S&P dışı semboller. Sıradan hisse
  // biçimindeki tickerları al (nokta/tire olabilir; 5+ harfli olanlar çoğunlukla
  // tercihli hisse/varant → ele). Float değeri olanları sırala.
  const scored = [];
  const seenCik = new Set();
  for (const [sym, meta] of tickerMap) {
    if (sp500.has(sym)) continue;
    if (!/^[A-Z]{1,4}([.-][A-Z])?$/.test(sym)) continue;
    if (!meta.cik) continue;
    const cik = String(meta.cik).padStart(10, '0');
    if (seenCik.has(cik)) continue; // aynı şirketin ikinci sınıf hissesi
    const float = floatByCik.get(cik);
    if (!float) continue;
    seenCik.add(cik);
    scored.push({ symbol: sym, name: meta.title, cik, float });
  }
  console.log(`  ${scored.length} aday S&P dışı sembol float değeriyle eşleşti.`);

  scored.sort((a, b) => b.float - a.float);
  const need = Math.max(0, TARGET_SIZE - chosen.size);
  for (const s of scored.slice(0, need)) {
    chosen.set(s.symbol, {
      row: { symbol: s.symbol, name: s.name || s.symbol, sector: '—', cik: s.cik },
      float: s.float,
    });
  }

  const rows = [...chosen.values()].map((v) => v.row);
  const payload = {
    rankedAt: new Date().toISOString(),
    targetSize: TARGET_SIZE,
    method:
      'S&P 500 çekirdek + SEC company_tickers.json adaylarının SEC XBRL frames ' +
      'API\'sinden (dei/EntityPublicFloat, birkaç çeyreğin birleşimi) alınan halka ' +
      `açık dolaşım değerine göre en büyükleri. Yalnızca SEC. ${RANK_MAX_AGE_DAYS} ` +
      'günde bir yenilenir.',
    symbols: rows.map((r) => r.symbol),
  };
  await writeFile(universeFile, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  console.log(`Evren yeniden sıralandı: ${rows.length} hisse → universe-1500.json yazıldı.`);
  return rows;
}
