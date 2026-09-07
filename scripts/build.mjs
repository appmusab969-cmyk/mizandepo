// Mizan veri üretici — SEC EDGAR + kendi AAOIFI algoritmamız
// =========================================================
// Bu script `stocks.json`'u üretir. Üçüncü bir tarama servisi KULLANMAZ:
//
//   1. Evren: S&P 500 bileşenleri (Wikipedia/datasets CSV) + Şeriat ETF beyaz
//      listesi (`etf-whitelist.json`).
//   2. Her hisse için SEC EDGAR'dan ham XBRL çekilir (companyfacts) + SIC kodu
//      (submissions). Fiyat Yahoo chart endpoint'inden (anahtarsız).
//   3. `lib/screen.mjs` içindeki AAOIFI algoritması helal / şüpheli / uygun
//      değil kararını verir ve 0-100 Mizan skoru üretir.
//   4. Her yanıt `cache/` altına yazılır (repoya commit'lenir). Tekrar
//      çalıştırınca 20 günden yeni cache varsa EDGAR'a HİÇ gidilmez → limit
//      sorunu olmaz.
//
// Çalıştırma:
//   node scripts/build.mjs                 # tam liste
//   node scripts/build.mjs AAPL MSFT       # sadece bu semboller (test)
//   LIMIT=25 node scripts/build.mjs        # ilk 25 sembol (hızlı deneme)
//
// Çıkış kodu 1 → hiçbir sembol işlenemedi; workflow commit atmaz.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { cachedFetch } from '../lib/http.mjs';
import { loadTickerMap, loadFinancials, fetchQuote, fetchNportHoldings } from '../lib/edgar.mjs';
import { businessScreen, financialRatios, screenEquity } from '../lib/screen.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const CACHE_ROOT = join(REPO_ROOT, 'cache'); // ham SEC yanıtları — .gitignore'da
const SLIM_ROOT = join(REPO_ROOT, 'cache-slim'); // çıkarılmış özet — repoya commit'lenir
const OUT_FILE = join(REPO_ROOT, 'stocks.json');
const WHITELIST_FILE = join(REPO_ROOT, 'etf-whitelist.json');

const SP500_CSV =
  'https://raw.githubusercontent.com/datasets/s-and-p-500-companies/main/data/constituents.csv';

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

/** S&P 500 CSV → [{symbol, name, sector, cik}] (7 gün cache). */
async function loadUniverse() {
  const { data: csv } = await cachedFetch(CACHE_ROOT, 'sp500_constituents', SP500_CSV, {
    maxAgeDays: 7,
    accept: 'text/csv',
    as: 'text',
  });
  const lines = csv.trim().split(/\r?\n/);
  lines.shift(); // başlık
  const rows = [];
  for (const line of lines) {
    // CSV: bazı alanlar tırnaklı ve virgül içerir.
    const cells = parseCsvLine(line);
    if (cells.length < 7) continue;
    const [symbol, name, sector, , , , cik] = cells;
    rows.push({
      symbol: symbol.trim().toUpperCase(),
      name: name.trim(),
      sector: SECTOR_TR[sector.trim()] || sector.trim() || '—',
      cik: cik ? cik.trim().padStart(10, '0') : null,
    });
  }
  return rows;
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

/** Bir hisseyi işler → stocks.json kaydı (veya hata durumunda null). */
async function processEquity(u, tickerMap, prev) {
  const old = prev.get(u.symbol) ?? {};
  let cik = u.cik;
  if (!cik || cik === '0000000000') {
    cik = tickerMap.get(u.symbol)?.cik ?? null;
  }
  if (!cik) {
    console.warn(`  ATLA ${u.symbol.padEnd(6)} — CIK bulunamadı`);
    return old.symbol ? old : null;
  }

  let sub;
  try {
    sub = await loadFinancials(CACHE_ROOT, SLIM_ROOT, cik);
  } catch (err) {
    console.warn(`  FAIL ${u.symbol.padEnd(6)} — EDGAR: ${err.message}`);
    return old.symbol ? old : null;
  }
  const fin = sub.fin;
  const factsRes = { stale: sub.stale };

  const quote = (await fetchQuote(CACHE_ROOT, u.symbol)) ?? {
    price: Number(old.price ?? 0),
    changePercent: Number(old.changePercent ?? 0),
  };

  const marketCap =
    fin.sharesOutstanding && quote.price
      ? fin.sharesOutstanding * quote.price
      : Number(old.marketCapBillions ?? 0) * 1e9 || null;

  const business = businessScreen(sub.sic, sub.sicDescription, sub.name || u.name);
  const ratios = financialRatios(fin, marketCap);

  const dataComplete =
    fin.debt != null &&
    fin.cashAndInterestSecurities != null &&
    fin.revenue != null &&
    (marketCap != null || fin.assets != null);

  const verdict = screenEquity({
    business,
    ratios,
    dataComplete,
    stale: factsRes.stale,
  });

  // Temettü verimi: XBRL'de güvenilir değil → eski değeri koru.
  const dividendYield = Number(old.dividendYield ?? 0);

  return {
    symbol: u.symbol,
    name: sub.name || u.name || u.symbol,
    sector: u.sector,
    assetType: 'Hisse',
    price: Number((quote.price || 0).toFixed(2)),
    changePercent: Number((quote.changePercent || 0).toFixed(2)),
    marketCapBillions: marketCap ? Math.round(marketCap / 1e9) : Number(old.marketCapBillions ?? 0),
    dividendYield,
    debtRatio: verdict.ratios.debtRatioPct ?? Number(old.debtRatio ?? 0),
    status: verdict.status,
    mizanScore: verdict.score,
    whyNote: verdict.whyNote,
    screening: {
      standard: 'AAOIFI',
      source: 'SEC EDGAR (companyfacts + submissions)',
      asOf: fin.asOf,
      denominator: verdict.ratios.denominatorBasis,
      ratios: verdict.ratios,
      checks: verdict.checks,
      sic: sub.sic,
      sicDescription: sub.sicDescription,
      dataComplete,
      staleSource: factsRes.stale,
    },
  };
}

/** Beyaz listedeki bir ETF → stocks.json kaydı. */
async function processEtf(symbol, meta, prev) {
  const old = prev.get(symbol) ?? {};
  const quote = (await fetchQuote(CACHE_ROOT, symbol)) ?? {
    price: Number(old.price ?? 0),
    changePercent: Number(old.changePercent ?? 0),
  };

  // Portföy + fon toplamları: SEC EDGAR Form N-PORT (resmi, çeyreklik). ABD'de
  // kayıtlı olmayan (UCITS vb.) fonlar için null döner → eski künyeyi koru.
  const nport = await fetchNportHoldings(CACHE_ROOT, symbol, meta.name);
  const prevFund = old.fund ?? {};

  // Gider oranı ve kuruluş tarihi N-PORT'ta yoktur (izahnamede); beyaz listeye
  // elle işlenir. Diğer alanlar N-PORT'tan, yoksa önceki değerden gelir.
  const fund = {
    ...(meta.expenseRatioPct != null
      ? { expenseRatioPct: meta.expenseRatioPct }
      : prevFund.expenseRatioPct != null
        ? { expenseRatioPct: prevFund.expenseRatioPct }
        : {}),
    ...(meta.inception ? { inceptionDate: meta.inception } : prevFund.inceptionDate ? { inceptionDate: prevFund.inceptionDate } : {}),
    ...(nport
      ? {
          aumUsd: nport.aumUsd,
          netAssetsUsd: nport.netAssetsUsd,
          asOf: nport.asOf,
          trust: nport.trust,
          totalPositions: nport.totalPositions,
          topHoldings: nport.topHoldings,
          filingUrl: nport.filingUrl,
          source: nport.source,
        }
      : {
          aumUsd: prevFund.aumUsd ?? null,
          asOf: prevFund.asOf ?? null,
          trust: prevFund.trust ?? null,
          totalPositions: prevFund.totalPositions ?? 0,
          topHoldings: prevFund.topHoldings ?? [],
          filingUrl: prevFund.filingUrl ?? null,
          source: prevFund.source ?? null,
        }),
  };

  const hasFund = Object.keys(fund).length > 0 &&
    (fund.topHoldings?.length || fund.aumUsd != null || fund.expenseRatioPct != null || fund.inceptionDate != null);

  return {
    symbol,
    name: meta.name,
    sector: 'Endeks',
    assetType: 'ETF',
    price: Number((quote.price || 0).toFixed(2)),
    changePercent: Number((quote.changePercent || 0).toFixed(2)),
    marketCapBillions: fund.aumUsd
      ? Number((fund.aumUsd / 1e9).toFixed(2))
      : Number(old.marketCapBillions ?? 0),
    dividendYield: Number(old.dividendYield ?? 0),
    debtRatio: 0,
    status: 'halal',
    mizanScore: meta.score ?? 85,
    whyNote: `${meta.board} tarafından Şeriat'a uygun onaylandı. Portföyün tamamı bağımsız kurul tarafından taranır.`,
    screening: {
      standard: 'Şeriat kurulu onayı (beyaz liste)',
      source: 'etf-whitelist.json',
      board: meta.board,
    },
    ...(hasFund ? { fund } : {}),
  };
}

async function readPrevious() {
  try {
    const parsed = JSON.parse(await readFile(OUT_FILE, 'utf8'));
    const list = Array.isArray(parsed) ? parsed : parsed.stocks ?? [];
    return new Map(list.map((s) => [String(s.symbol).toUpperCase(), s]));
  } catch {
    return new Map();
  }
}

async function main() {
  await mkdir(CACHE_ROOT, { recursive: true });
  await mkdir(SLIM_ROOT, { recursive: true });

  const argSymbols = process.argv.slice(2).map((s) => s.toUpperCase());
  const limit = process.env.LIMIT ? Number(process.env.LIMIT) : null;

  const [tickerMap, universeAll, whitelistRaw, prev] = await Promise.all([
    loadTickerMap(CACHE_ROOT),
    loadUniverse(),
    readFile(WHITELIST_FILE, 'utf8'),
    readPrevious(),
  ]);
  const whitelist = JSON.parse(whitelistRaw).etfs;

  let universe = universeAll;
  if (argSymbols.length) {
    universe = universeAll.filter((u) => argSymbols.includes(u.symbol));
    // CSV'de olmayan ama istenen sembolleri de dene (ticker map'ten).
    for (const s of argSymbols) {
      if (!universe.some((u) => u.symbol === s) && !whitelist[s]) {
        universe.push({ symbol: s, name: s, sector: '—', cik: tickerMap.get(s)?.cik ?? null });
      }
    }
  }
  if (limit) universe = universe.slice(0, limit);

  console.log(`${universe.length} hisse + ${Object.keys(whitelist).length} ETF taranacak.`);
  console.log('(cache/ dolu ise EDGAR isteği yapılmaz — limit güvenli.)\n');

  const out = [];
  let ok = 0;
  let failed = 0;

  for (const u of universe) {
    try {
      const rec = await processEquity(u, tickerMap, prev);
      if (rec) {
        out.push(rec);
        ok++;
        console.log(`  OK   ${u.symbol.padEnd(6)} -> ${rec.status.padEnd(8)} (skor ${rec.mizanScore})`);
      } else {
        failed++;
      }
    } catch (err) {
      failed++;
      console.warn(`  FAIL ${u.symbol.padEnd(6)} -> ${err.message}`);
      if (prev.get(u.symbol)) out.push(prev.get(u.symbol));
    }
  }

  // ETF'ler (beyaz liste) — argSymbols verildiyse yalnızca istenenler.
  const etfSymbols = argSymbols.length
    ? Object.keys(whitelist).filter((s) => argSymbols.includes(s))
    : Object.keys(whitelist);
  for (const symbol of etfSymbols) {
    try {
      out.push(await processEtf(symbol, whitelist[symbol], prev));
      ok++;
      console.log(`  OK   ${symbol.padEnd(6)} -> ETF helal (beyaz liste)`);
    } catch (err) {
      failed++;
      console.warn(`  FAIL ${symbol.padEnd(6)} -> ${err.message}`);
    }
  }

  if (ok === 0) {
    console.error('\nHiçbir sembol işlenemedi; stocks.json değiştirilmedi.');
    process.exit(1);
  }

  // Skora göre azalan; eşitlikte sembol alfabetik.
  out.sort((a, b) => b.mizanScore - a.mizanScore || a.symbol.localeCompare(b.symbol));

  const counts = {
    ok,
    failed,
    total: universe.length + etfSymbols.length,
    halal: out.filter((s) => s.status === 'halal').length,
    doubtful: out.filter((s) => s.status === 'doubtful').length,
    nonHalal: out.filter((s) => s.status === 'nonHalal').length,
  };

  const payload = {
    updatedAt: new Date().toISOString().slice(0, 10),
    source: 'SEC EDGAR (companyfacts + submissions) — Mizan kendi AAOIFI algoritması',
    standard: 'AAOIFI Şeriat Standardı No. 21 (borç/piyasa değeri < %30, faiz geliri < %5)',
    note:
      'Otomatik üretildi (scripts/build.mjs). Üçüncü bir tarama servisi kullanılmaz; ' +
      'ham SEC verisi Mizan algoritmasıyla işlenir. ETF\'ler bağımsız Şeriat kurulu ' +
      'onayına göre beyaz listeden gelir. Fiyatlar Yahoo chart endpoint\'inden, günde bir güncellenir.',
    counts,
    stocks: out,
  };

  await writeFile(OUT_FILE, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  console.log(
    `\nstocks.json yazıldı: ${ok} başarılı, ${failed} başarısız. ` +
      `${counts.halal} helal / ${counts.doubtful} şüpheli / ${counts.nonHalal} uygun değil.`,
  );
}

main().catch((err) => {
  console.error('Beklenmeyen hata:', err);
  process.exit(1);
});
