// Mizan veri üretici — SEC EDGAR + kendi AAOIFI algoritmamız
// =========================================================
// Bu script `stocks.json` (+ `stocks.min.json` / `.gz`) üretir. Üçüncü bir
// tarama servisi KULLANMAZ:
//
//   1. Evren: ~1500 en büyük ABD hissesi (lib/universe.mjs — S&P 500 çekirdek +
//      SEC company_tickers piyasa değeri sıralaması) + ABD-listeli Şeriat ETF
//      beyaz listesi (`etf-whitelist.json`).
//   2. Her hisse için SEC EDGAR'dan ham XBRL çekilir (companyfacts) + SIC kodu
//      (submissions). Fiyat Yahoo chart endpoint'inden (anahtarsız).
//   3. `lib/screen.mjs` içindeki AAOIFI algoritması helal / şüpheli / uygun
//      değil kararını verir ve 0-100 Mizan skoru üretir.
//   4. Her ETF, kurul onayına ek olarak `lib/fund-health.mjs` ile otomatik
//      portföy denetiminden geçer (N-PORT holdings vs. hisse taraması).
//   5. Her yanıt `cache/` altına yazılır. 20 günden yeni cache varsa EDGAR'a
//      HİÇ gidilmez → limit sorunu olmaz.
//
// Çalıştırma:
//   node scripts/build.mjs                 # tam liste (~1500 hisse + ETF)
//   node scripts/build.mjs AAPL MSFT       # sadece bu semboller (test)
//   LIMIT=25 node scripts/build.mjs        # evrenin ilk 25 sembolü
//   RANK=1 node scripts/build.mjs          # universe-1500.json'ı yeniden sırala
//
// Çıkış kodu 1 → hiçbir sembol işlenemedi; workflow commit atmaz.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { gzipSync } from 'node:zlib';

import { loadTickerMap, loadFinancials, fetchQuote, fetchNportHoldings } from '../lib/edgar.mjs';
import { businessScreen, financialRatios, screenEquity } from '../lib/screen.mjs';
import { loadUniverse } from '../lib/universe.mjs';
import { assessFundHoldings } from '../lib/fund-health.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const CACHE_ROOT = join(REPO_ROOT, 'cache'); // ham SEC yanıtları — .gitignore'da
const SLIM_ROOT = join(REPO_ROOT, 'cache-slim'); // çıkarılmış özet — repoya commit'lenir
const OUT_FILE = join(REPO_ROOT, 'stocks.json'); // insan-okunur (git diff)
const MIN_FILE = join(REPO_ROOT, 'stocks.min.json'); // uygulamanın indirdiği
const GZ_FILE = join(REPO_ROOT, 'stocks.min.json.gz'); // önceden sıkıştırılmış
const WHITELIST_FILE = join(REPO_ROOT, 'etf-whitelist.json');
const HEALTH_FILE = join(REPO_ROOT, 'fund-health-report.json');

// Evren (~1500 hisse) `lib/universe.mjs` tarafından kurulur ve
// `universe-1500.json`'da tutulur; sektör Türkçeleştirme ve CSV ayrıştırma da
// oraya taşındı.

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

/** Beyaz listedeki bir ETF → stocks.json kaydı.
 *  @param {Map<string, object>} stockBySymbol  bu turda taranan hisseler —
 *    otomatik portföy sağlık denetimi için (lib/fund-health.mjs). */
async function processEtf(symbol, meta, prev, stockBySymbol) {
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

  // --- Otomatik portföy sağlık denetimi ---
  // Kurul onayı fonu 'helal' yapar; bu denetim yalnızca AŞAĞI çekebilir.
  // Bazı fonlar (ör. GYO fonları) muaftır: sektöre özel AAOIFI eşikleri Mizan
  // hisse taramasından farklı olduğu için denetim yanlış pozitif üretir.
  const health = meta.skipHealthCheck
    ? { assessed: false, matchedWeightPct: 0, nonHalalWeightPct: 0, doubtfulWeightPct: 0, offenders: [], verdict: 'clean', note: null, skipped: true }
    : assessFundHoldings(fund.topHoldings ?? [], stockBySymbol);

  let status = 'halal';
  let whyNote = `${meta.board} tarafından Şeriat'a uygun onaylandı. Portföyün tamamı bağımsız kurul tarafından taranır.`;
  let mizanScore = meta.score ?? 85;

  if (health.skipped) {
    // Muaf fon: kurul onayına dayanır, otomatik portföy denetimi uygulanmaz.
    whyNote += ` Bu fon için Mizan'ın otomatik portföy denetimi uygulanmaz: ${meta.skipHealthCheck}`;
  } else if (health.verdict === 'breach') {
    status = 'doubtful';
    mizanScore = Math.min(mizanScore, 55);
    whyNote =
      `${meta.board} onaylı; ancak ${health.note} ` +
      `(değerleme: ${fund.asOf ?? 'bilinmiyor'}).`;
  } else if (health.verdict === 'watch' && health.note) {
    whyNote += ` İzleme notu: ${health.note}`;
  } else if (health.assessed) {
    whyNote +=
      ` Mizan portföy denetimi (${fund.asOf ?? 'son N-PORT'}): eşleşen ` +
      `pozisyonların %${health.nonHalalWeightPct}'i "uygun değil" — %5 eşiğinin altında.`;
  }

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
    status,
    mizanScore,
    whyNote,
    screening: {
      standard: 'Şeriat kurulu onayı (beyaz liste) + Mizan portföy sağlık denetimi',
      source: 'etf-whitelist.json + SEC Form N-PORT',
      board: meta.board,
      health: {
        assessed: health.assessed,
        matchedWeightPct: health.matchedWeightPct,
        nonHalalWeightPct: health.nonHalalWeightPct,
        doubtfulWeightPct: health.doubtfulWeightPct,
        verdict: health.verdict,
        offenders: health.offenders.slice(0, 8),
        ...(health.skipped ? { skipped: true, skipReason: meta.skipHealthCheck } : {}),
      },
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

  const [tickerMap, whitelistRaw, prev] = await Promise.all([
    loadTickerMap(CACHE_ROOT),
    readFile(WHITELIST_FILE, 'utf8'),
    readPrevious(),
  ]);
  const whitelist = JSON.parse(whitelistRaw).etfs;

  // Evren (~1500): universe-1500.json taze ise ondan; değilse SEC ticker
  // haritası piyasa değerine göre yeniden sıralanır (RANK=1 ile zorlanabilir).
  const universeAll = await loadUniverse({
    cacheRoot: CACHE_ROOT,
    slimRoot: SLIM_ROOT,
    repoRoot: REPO_ROOT,
    tickerMap,
    forceRank: process.env.RANK === '1',
  });

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

  // Taranan hisseleri sembolle indeksle — fon portföy sağlık denetimi için.
  const stockBySymbol = new Map(out.map((s) => [String(s.symbol).toUpperCase(), s]));

  // ETF'ler (beyaz liste) — argSymbols verildiyse yalnızca istenenler.
  const etfSymbols = argSymbols.length
    ? Object.keys(whitelist).filter((s) => argSymbols.includes(s))
    : Object.keys(whitelist);
  const healthReport = [];
  for (const symbol of etfSymbols) {
    try {
      const rec = await processEtf(symbol, whitelist[symbol], prev, stockBySymbol);
      out.push(rec);
      ok++;
      const h = rec.screening?.health;
      const tag =
        rec.status === 'doubtful'
          ? `ŞÜPHELİ — portföy denetimi (%${h?.nonHalalWeightPct} uygun değil)`
          : h?.skipped
            ? 'helal (denetim muaf — sektöre özel eşik)'
            : h?.assessed
              ? `helal (denetim OK, %${h.nonHalalWeightPct} uygun değil / %${h.matchedWeightPct} eşleşti)`
              : 'helal (portföy denetlenemedi — ABD dışı/sukuk)';
      console.log(`  OK   ${symbol.padEnd(6)} -> ETF ${tag}`);
      if (h && !h.skipped && (h.verdict !== 'clean' || !h.assessed)) {
        healthReport.push({
          symbol,
          name: whitelist[symbol].name,
          status: rec.status,
          verdict: h.verdict,
          assessed: h.assessed,
          nonHalalWeightPct: h.nonHalalWeightPct,
          doubtfulWeightPct: h.doubtfulWeightPct,
          matchedWeightPct: h.matchedWeightPct,
          offenders: h.offenders,
          asOf: rec.fund?.asOf ?? null,
        });
      }
    } catch (err) {
      failed++;
      console.warn(`  FAIL ${symbol.padEnd(6)} -> ${err.message}`);
    }
  }

  // Fon sağlık raporu: hangi fon neden izlemede/bozuk — her hafta buradan
  // bakılıp bozulan fon elle beyaz listeden çıkarılır, yerine yenisi eklenir.
  await writeFile(
    HEALTH_FILE,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        note:
          'Otomatik ETF portföy sağlık denetimi (lib/fund-health.mjs). "breach" = ' +
          'fon otomatik ŞÜPHELİ\'ye düştü, beyaz listeden çıkarılıp yerine başka fon ' +
          'eklenmeli. "watch" = kurul onayı geçerli ama izlemede. "assessed:false" = ' +
          'portföy ABD dışı/sukuk olduğu için denetlenemedi (kurul onayına güvenilir).',
        limits: { nonHalalWeightLimitPct: 5.0, unverifiedWeightLimitPct: 40.0 },
        funds: healthReport,
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );

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
      'ham SEC verisi Mizan algoritmasıyla işlenir. Evren ~1500 en büyük ABD hissesi ' +
      '(S&P 500 çekirdek + SEC company_tickers piyasa değeri sıralaması, universe-1500.json). ' +
      'ETF\'ler bağımsız Şeriat kurulu onaylı beyaz listeden gelir ve her hafta N-PORT ' +
      'portföy sağlık denetiminden geçer (fund-health-report.json). Fiyatlar Yahoo chart ' +
      'endpoint\'inden, günde bir güncellenir.',
    counts,
    stocks: out,
  };

  // İnsan-okunur sürüm (git diff'i anlamlı kalsın diye 2 boşluk girintili).
  const pretty = JSON.stringify(payload, null, 2) + '\n';
  await writeFile(OUT_FILE, pretty, 'utf8');

  // Uygulamanın indirdiği sürüm: boşluksuz (minify). ~1500 kayıtta pretty ~3 MB,
  // minify ~2.2 MB. GitHub raw'ın kendi gzip'i bunu tel üstünde ~450 KB'ye
  // indirir; ayrıca .gz'yi de yazıyoruz ki isteyen doğrudan çekebilsin.
  const minified = JSON.stringify(payload);
  await writeFile(MIN_FILE, minified, 'utf8');
  const gz = gzipSync(Buffer.from(minified, 'utf8'), { level: 9 });
  await writeFile(GZ_FILE, gz);

  const kb = (n) => (n / 1024).toFixed(0);
  console.log(
    `\nstocks.json yazıldı: ${ok} başarılı, ${failed} başarısız. ` +
      `${counts.halal} helal / ${counts.doubtful} şüpheli / ${counts.nonHalal} uygun değil.`,
  );
  console.log(
    `  boyut: pretty ${kb(Buffer.byteLength(pretty))} KB · ` +
      `min ${kb(Buffer.byteLength(minified))} KB · gz ${kb(gz.length)} KB`,
  );
}

main().catch((err) => {
  console.error('Beklenmeyen hata:', err);
  process.exit(1);
});
