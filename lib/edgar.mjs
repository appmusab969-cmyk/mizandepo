// SEC EDGAR erişim katmanı
// ------------------------
// Ham XBRL verisini (10-K / 10-Q beyannamelerinden) ve şirket meta verisini
// (SIC sektör kodu) çeker. Hepsi ücretsiz, anahtar gerektirmez.
//
//   - Ticker → CIK eşlemesi:  https://www.sec.gov/files/company_tickers.json
//   - Şirket meta (SIC):      https://data.sec.gov/submissions/CIK##########.json
//   - XBRL bilanço/gelir:     https://data.sec.gov/api/xbrl/companyfacts/CIK##########.json

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';

import { cachedFetch, fetchWithRetry } from './http.mjs';

const pad10 = (cik) => String(cik).replace(/\D/g, '').padStart(10, '0');

/** Tüm ticker→CIK listesini indirir (günde bir yeter → 1 gün cache). */
export async function loadTickerMap(cacheRoot) {
  const { data } = await cachedFetch(
    cacheRoot,
    'company_tickers',
    'https://www.sec.gov/files/company_tickers.json',
    { maxAgeDays: 1 },
  );
  // { "0": { cik_str, ticker, title }, ... } → Map<TICKER, {cik,title}>
  const map = new Map();
  for (const row of Object.values(data)) {
    map.set(String(row.ticker).toUpperCase(), {
      cik: pad10(row.cik_str),
      title: row.title,
    });
  }
  return map;
}

/** submissions dosyası: SIC kodu, isim, borsa, form tipi vb. (20 gün cache). */
export async function loadSubmissions(cacheRoot, cik) {
  const c = pad10(cik);
  const { data } = await cachedFetch(
    cacheRoot,
    `submissions_CIK${c}`,
    `https://data.sec.gov/submissions/CIK${c}.json`,
    { maxAgeDays: 20 },
  );
  return {
    name: data.name,
    sic: data.sic ? Number(data.sic) : null,
    sicDescription: data.sicDescription ?? '',
    exchanges: data.exchanges ?? [],
    tickers: data.tickers ?? [],
    isEtf:
      /exchange traded fund|etf/i.test(data.sicDescription ?? '') ||
      (data.formerNames ?? []).length === 0 &&
        /trust|fund|etf/i.test(data.name ?? '') &&
        (data.sic == null),
  };
}

/** companyfacts: tüm XBRL kavramları. Büyük dosya; 20 gün cache. */
export async function loadCompanyFacts(cacheRoot, cik) {
  const c = pad10(cik);
  const { data, stale } = await cachedFetch(
    cacheRoot,
    `facts_CIK${c}`,
    `https://data.sec.gov/api/xbrl/companyfacts/CIK${c}.json`,
    { maxAgeDays: 20 },
  );
  return { facts: data, stale };
}

/**
 * Bir XBRL kavramının EN GÜNCEL değerini döndürür.
 * `us-gaap` ve `dei` taksonomilerine bakar, USD ve 'shares' birimlerini kabul
 * eder. Anlık (instant) kalemler için en yeni `end`; dönemsel (duration) gelir
 * kalemleri için son 4 çeyreği toplamak isteyen çağıran `sumLastYear` kullanır.
 */
function latestFact(facts, names, { units = ['USD'] } = {}) {
  for (const taxonomy of ['us-gaap', 'dei', 'ifrs-full', 'srt']) {
    const tax = facts.facts?.[taxonomy];
    if (!tax) continue;
    for (const name of names) {
      const concept = tax[name];
      if (!concept?.units) continue;
      for (const unit of units) {
        const series = concept.units[unit];
        if (!Array.isArray(series) || series.length === 0) continue;
        // 10-K/10-Q asıllarını al, en yeni `end` (eşitlikte en yeni `filed`).
        const rows = series
          .filter((r) => r.form === '10-K' || r.form === '10-Q' || r.form === '20-F' || r.form === '40-F')
          .sort((a, b) => (a.end < b.end ? 1 : a.end > b.end ? -1 : (a.filed < b.filed ? 1 : -1)));
        if (rows[0]) return { val: Number(rows[0].val), end: rows[0].end, form: rows[0].form };
      }
    }
  }
  return null;
}

/**
 * Dönemsel (gelir/gider) bir kavram için son 12 ayı yaklaşık toplar.
 * 10-K varsa onun yıllık değerini alır; yoksa en yeni 4 çeyreği toplar.
 */
function trailingYear(facts, names) {
  for (const taxonomy of ['us-gaap', 'ifrs-full']) {
    const tax = facts.facts?.[taxonomy];
    if (!tax) continue;
    for (const name of names) {
      const series = tax[name]?.units?.USD;
      if (!Array.isArray(series) || series.length === 0) continue;

      // Süreli kalemler: start/end farkı ~90 gün (çeyrek) ya da ~365 gün (yıl).
      const withSpan = series
        .filter((r) => r.start && r.end)
        .map((r) => ({ ...r, days: (Date.parse(r.end) - Date.parse(r.start)) / 86_400_000 }))
        .sort((a, b) => (a.end < b.end ? 1 : -1));

      // Önce en yeni yıllık (10-K, ~365 gün) değeri dene.
      const annual = withSpan.find((r) => r.form === '10-K' && r.days >= 300 && r.days <= 400);
      if (annual) return { val: Number(annual.val), end: annual.end, basis: '10-K yıllık' };

      // Yoksa: en yeni çeyreği bul, geriye doğru 4 farklı çeyrek topla.
      const quarters = withSpan.filter((r) => r.days >= 80 && r.days <= 100);
      if (quarters.length >= 4) {
        const seen = new Set();
        let sum = 0;
        let n = 0;
        for (const q of quarters) {
          if (seen.has(q.end)) continue;
          seen.add(q.end);
          sum += Number(q.val);
          n++;
          if (n === 4) break;
        }
        if (n === 4) return { val: sum, end: quarters[0].end, basis: '4 çeyrek toplamı' };
      }
    }
  }
  return null;
}

/**
 * companyfacts + submissions'tan AAOIFI taraması için gereken sayıları çıkarır.
 * Eksik kalemler `null` döner; algoritma bunu "veri yetersiz → şüpheli" sayar.
 */
export function extractFinancials(facts) {
  // --- Faizli borç: uzun + kısa vadeli ---
  // Şirketler bu kalemi çok farklı etiketliyor; birden çok isim deniyoruz.
  const ltDebtNoncurrent = latestFact(facts, [
    'LongTermDebtNoncurrent',
    'LongTermDebtAndCapitalLeaseObligations',
    'LongtermDebtNoncurrent',
  ]);
  const ltDebtCurrent = latestFact(facts, [
    'LongTermDebtCurrent',
    'DebtCurrent',
    'ShortTermBorrowings',
    'LongTermDebtAndCapitalLeaseObligationsCurrent',
    'ShorttermDebtCurrent',
  ]);
  const ltDebtTotal = latestFact(facts, [
    'LongTermDebt',
    'DebtLongtermAndShorttermCombinedAmount',
    'DebtAndCapitalLeaseObligations',
    'NotesPayable',
    'LongTermNotesPayable',
    'SeniorNotes',
    'UnsecuredDebt',
    'SecuredDebt',
    'NonRecourseDebt',
  ]);
  let debt = null;
  if (ltDebtNoncurrent || ltDebtCurrent) {
    debt = (ltDebtNoncurrent?.val ?? 0) + (ltDebtCurrent?.val ?? 0);
  } else if (ltDebtTotal) {
    debt = ltDebtTotal.val;
  }

  // --- Nakit + faiz getiren menkul kıymetler ---
  const cash = latestFact(facts, [
    'CashAndCashEquivalentsAtCarryingValue',
    'CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents',
  ]);
  const stInvest = latestFact(facts, [
    'ShortTermInvestments',
    'MarketableSecuritiesCurrent',
    'AvailableForSaleSecuritiesCurrent',
  ]);
  const ltInvest = latestFact(facts, [
    'LongTermInvestments',
    'MarketableSecuritiesNoncurrent',
    'AvailableForSaleSecuritiesNoncurrent',
  ]);
  const cashAndInterestSecurities =
    cash || stInvest || ltInvest
      ? (cash?.val ?? 0) + (stInvest?.val ?? 0) + (ltInvest?.val ?? 0)
      : null;

  // --- Alacaklar ---
  const receivables = latestFact(facts, [
    'AccountsReceivableNetCurrent',
    'ReceivablesNetCurrent',
    'AccountsAndOtherReceivablesNetCurrent',
    'AccountsReceivableNet',
    'NontradeReceivablesCurrent',
  ]);

  // --- Toplam varlık ---
  const assets = latestFact(facts, ['Assets']);

  // --- Gelir (12 ay) ---
  const revenue = trailingYear(facts, [
    'RevenueFromContractWithCustomerExcludingAssessedTax',
    'Revenues',
    'RevenueFromContractWithCustomerIncludingAssessedTax',
    'SalesRevenueNet',
  ]);

  // --- Faiz geliri (12 ay) — arındırma ve %5 eşiği için ---
  const interestIncome =
    trailingYear(facts, ['InvestmentIncomeInterest', 'InterestAndDividendIncomeOperating', 'InterestIncomeOperating']) ??
    latestFact(facts, ['InvestmentIncomeInterest']);

  // --- Net kâr (12 ay) — arındırma oranı paydası ---
  const netIncome = trailingYear(facts, ['NetIncomeLoss', 'ProfitLoss']) ?? latestFact(facts, ['NetIncomeLoss']);

  // --- Hisse adedi — piyasa değeri için ---
  // Öncelik: fiili tedavüldeki adet. Yoksa ağırlıklı ortalama (seyreltilmiş)
  // adet iyi bir yaklaşımdır — piyasa değeri paydası için yeterli.
  const shares =
    latestFact(facts, ['EntityCommonStockSharesOutstanding', 'CommonStockSharesOutstanding'], {
      units: ['shares'],
    }) ??
    latestFact(
      facts,
      ['WeightedAverageNumberOfDilutedSharesOutstanding', 'WeightedAverageNumberOfSharesOutstandingBasic'],
      { units: ['shares'] },
    );

  return {
    debt,
    cashAndInterestSecurities,
    receivables: receivables?.val ?? null,
    assets: assets?.val ?? null,
    revenue: revenue?.val ?? null,
    interestIncome: interestIncome?.val ?? null,
    netIncome: netIncome?.val ?? null,
    sharesOutstanding: shares?.val ?? null,
    asOf: assets?.end ?? debt ?? null,
  };
}

/**
 * SLIM CACHE — repoya commit'lenen küçük özet.
 * ------------------------------------------
 * Ham companyfacts yanıtları ~1-4 MB; 500 şirket ~2 GB eder ve repoya sığmaz.
 * Bunun yerine sadece taramaya gereken çıkarılmış sayıları (`extractFinancials`
 * çıktısı + SIC/isim) `cache-slim/CIK##########.json` altında saklarız
 * (~0.5 KB/şirket). GitHub Actions bu klasörü commit'ler; bir sonraki hafta
 * 20 günden yeni olanlar için EDGAR'a HİÇ gidilmez.
 *
 * Büyük `cache/` klasörü sadece yerel hız içindir ve .gitignore'dadır.
 *
 * @returns {{ fin, sic, sicDescription, name, fromSlim: boolean, stale: boolean }}
 */
export async function loadFinancials(cacheRoot, slimRoot, cik, { maxAgeDays = 20 } = {}) {
  const c = String(cik).replace(/\D/g, '').padStart(10, '0');
  const slimPath = join(slimRoot, `CIK${c}.json`);

  let slim = null;
  try {
    slim = JSON.parse(await readFile(slimPath, 'utf8'));
  } catch {
    slim = null;
  }
  const ageDays = slim?.cachedAt
    ? (Date.now() - Date.parse(slim.cachedAt)) / 86_400_000
    : Infinity;
  if (slim && ageDays < maxAgeDays) {
    return {
      fin: slim.fin,
      sic: slim.sic,
      sicDescription: slim.sicDescription,
      name: slim.name,
      fromSlim: true,
      stale: false,
    };
  }

  // Slim yok / bayat → ham veriyi çek, çıkar, slim'e yaz.
  try {
    const sub = await loadSubmissions(cacheRoot, c);
    const { facts, stale } = await loadCompanyFacts(cacheRoot, c);
    const fin = extractFinancials(facts);
    const record = {
      cachedAt: new Date().toISOString(),
      sic: sub.sic,
      sicDescription: sub.sicDescription,
      name: sub.name,
      fin,
    };
    if (!stale) {
      await mkdir(dirname(slimPath), { recursive: true });
      await writeFile(slimPath, JSON.stringify(record) + '\n', 'utf8');
    }
    return { fin, sic: sub.sic, sicDescription: sub.sicDescription, name: sub.name, fromSlim: false, stale };
  } catch (err) {
    if (slim) {
      // Ağ patladı ama bayat slim var — dini ihtiyat için onu bayat işaretle.
      return {
        fin: slim.fin,
        sic: slim.sic,
        sicDescription: slim.sicDescription,
        name: slim.name,
        fromSlim: true,
        stale: true,
      };
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// SEC EDGAR — Form N-PORT ile ETF künyesi ve holdings
// ---------------------------------------------------------------------------
// ABD'de kayıtlı her fon çeyrekte bir **Form N-PORT** (NPORT-P) verir; bu
// beyanname portföydeki HER pozisyonu (isim, CUSIP, ticker, USD değeri, portföy
// yüzdesi) ve fon toplamlarını (net varlık, toplam varlık) içerir. Tamamen
// resmi, kamuya açık ve ücretsizdir — üçüncü bir finans sitesi kazınmaz.
//
//   1. Tam metin arama:  https://efts.sec.gov/LATEST/search-index?q="<seri adı>"&forms=NPORT-P
//      → en yeni beyannamenin CIK + accession numarası.
//   2. Beyanname XML'i:  https://www.sec.gov/Archives/edgar/data/<cik>/<adshNoDashes>/primary_doc.xml
//      → <genInfo> (seri adı, dönem), <fundInfo> (totAssets/netAssets),
//        <invstOrSec>* (her pozisyon).
//
// N-PORT çeyreklik olduğu için 30 gün cache yeterli. Beyanname bulunamayan
// (yeni ya da ABD dışı) fonlar için `null` döner; çağıran eski künyeyi korur.

/** XML metninden bir etiketin ilk değerini çıkarır (namespace'siz). */
function xmlTag(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
  return m ? m[1].trim() : null;
}

/** XML attribute değeri: <ticker value="MMM"/>. */
function xmlAttr(block, tag, attr) {
  const m = block.match(new RegExp(`<${tag}[^>]*\\b${attr}="([^"]*)"`, 'i'));
  return m ? m[1].trim() : null;
}

function decodeXmlEntities(s) {
  return String(s)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"');
}

/**
 * Bir fonun (ETF) en yeni NPORT-P beyannamesini bulur ve künye + en büyük ~10
 * hisse pozisyonunu çıkarır.
 *
 * @param {string} cacheRoot ham yanıt cache klasörü
 * @param {string} ticker    borsa sembolü (sadece cache anahtarı ve log için)
 * @param {string} fundName  fonun tam adı — EDGAR tam metin aramasında ve seri
 *                            adı doğrulamasında kullanılır
 * @returns {{
 *   aumUsd: number|null, netAssetsUsd: number|null, asOf: string|null,
 *   trust: string|null, totalPositions: number,
 *   topHoldings: {symbol: string, name: string, weightPct: number}[],
 *   filingUrl: string|null, source: string,
 * } | null}
 */
export async function fetchNportHoldings(cacheRoot, ticker, fundName) {
  const t = ticker.toUpperCase();
  const key = `nport_${t}`;
  const path = join(cacheRoot, `${key}.json`);
  try {
    const cached = JSON.parse(await readFile(path, 'utf8'));
    const ageDays = (Date.now() - Date.parse(cached.fetchedAt)) / 86_400_000;
    if (ageDays < 30) return cached.data;
  } catch {
    /* yok / bayat */
  }

  // 1. Tam metin arama → en yeni NPORT-P beyannamesi.
  let hit;
  try {
    const q = encodeURIComponent(`"${fundName}"`);
    const { data } = await cachedFetch(
      cacheRoot,
      `nport_search_${t}`,
      `https://efts.sec.gov/LATEST/search-index?q=${q}&forms=NPORT-P`,
      { maxAgeDays: 30 },
    );
    const hits = (data?.hits?.hits ?? [])
      .map((h) => ({
        cik: (h._source?.ciks ?? [])[0],
        adsh: h._source?.adsh,
        fileDate: h._source?.file_date,
        name: (h._source?.display_names ?? [])[0] ?? '',
      }))
      .filter((h) => h.cik && h.adsh)
      .sort((a, b) => (a.fileDate < b.fileDate ? 1 : -1));
    hit = hits[0];
  } catch {
    return null;
  }
  if (!hit) {
    console.warn(`  ${t}: NPORT-P beyannamesi bulunamadı ("${fundName}")`);
    return null;
  }

  // 2. primary_doc.xml'i çek ve ayrıştır.
  const cikNum = String(hit.cik).replace(/\D/g, '');
  const adsh = hit.adsh.replace(/-/g, '');
  const filingUrl = `https://www.sec.gov/Archives/edgar/data/${cikNum}/${adsh}/primary_doc.xml`;
  let xml;
  try {
    const { data } = await cachedFetch(cacheRoot, `nport_xml_${adsh}`, filingUrl, {
      maxAgeDays: 90,
      accept: 'application/xml',
      as: 'text',
    });
    xml = data;
  } catch {
    return null;
  }

  const genInfo = xml.match(/<genInfo>([\s\S]*?)<\/genInfo>/i)?.[1] ?? '';
  const fundInfo = xml.match(/<fundInfo>([\s\S]*?)<\/fundInfo>/i)?.[1] ?? '';

  // Doğrulama: beyannamenin serisi gerçekten bu fon mu? Tam metin araması bazen
  // bu fonu bir POZİSYON olarak içeren BAŞKA bir fonun N-PORT'unu döndürür
  // (ticker/isim çakışması). Seri adıyla istenen ad arasında kelime örtüşmesi
  // yoksa beyannameyi reddet (yanlış portföyü "helal" fona iliştirmemek için).
  const filedSeriesName = decodeXmlEntities(
    xmlTag(genInfo, 'seriesName') ?? xmlTag(genInfo, 'regName') ?? '',
  );
  const wordsOf = (s) =>
    new Set(
      String(s)
        .toLowerCase()
        .replace(/[^a-z0-9 ]/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length > 2 && !['etf', 'the', 'fund', 'ltd', 'inc'].includes(w)),
    );
  const want = wordsOf(fundName);
  const got = wordsOf(filedSeriesName);
  const common = [...want].filter((w) => got.has(w)).length;
  if (want.size >= 2 && common < 2) {
    console.warn(
      `  ${t}: NPORT-P seri adı uyuşmuyor ("${filedSeriesName}" ≠ "${fundName}") — atlandı`,
    );
    return null;
  }

  const asOf = xmlTag(genInfo, 'repPdDate');
  const trust = decodeXmlEntities(xmlTag(genInfo, 'regName') ?? '') || hit.name || null;
  const netAssets = Number(xmlTag(fundInfo, 'netAssets')) || null;
  const totAssets = Number(xmlTag(fundInfo, 'totAssets')) || null;

  // Her <invstOrSec> pozisyonu.
  const positions = [];
  const re = /<invstOrSec>([\s\S]*?)<\/invstOrSec>/gi;
  let m;
  while ((m = re.exec(xml))) {
    const b = m[1];
    const pct = Number(xmlTag(b, 'pctVal'));
    const valUSD = Number(xmlTag(b, 'valUSD'));
    const assetCat = xmlTag(b, 'assetCat'); // EC = equity common
    const name = decodeXmlEntities(xmlTag(b, 'name') ?? xmlTag(b, 'title') ?? '');
    let ticker = xmlAttr(b, 'ticker', 'value');
    if (ticker && !/^[A-Z.\-]{1,6}$/i.test(ticker.trim())) ticker = null;
    positions.push({
      name,
      symbol: ticker ? ticker.trim().toUpperCase() : null,
      weightPct: Number.isFinite(pct) ? Number(pct.toFixed(2)) : 0,
      valUSD: Number.isFinite(valUSD) ? valUSD : 0,
      isEquity: assetCat === 'EC',
    });
  }

  // En büyük ~10 hisse pozisyonu (ağırlığa göre). Hisse yoksa (tahvil/sukuk
  // fonu) en büyük 10 pozisyonu ismiyle göster.
  const equities = positions.filter((p) => p.isEquity);
  const pool = equities.length ? equities : positions;
  const topHoldings = pool
    .slice()
    .sort((a, b) => b.weightPct - a.weightPct || b.valUSD - a.valUSD)
    .slice(0, 10)
    .map((p) => ({ symbol: p.symbol ?? '', name: p.name, weightPct: p.weightPct }));

  const data = {
    aumUsd: totAssets,
    netAssetsUsd: netAssets,
    asOf,
    trust,
    totalPositions: positions.length,
    topHoldings,
    filingUrl: `https://www.sec.gov/Archives/edgar/data/${cikNum}/${adsh}/`,
    source: 'SEC EDGAR Form N-PORT',
  };

  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      JSON.stringify({ url: filingUrl, fetchedAt: new Date().toISOString(), data }, null, 0),
      'utf8',
    );
  } catch {
    /* cache yazılamadı — sorun değil */
  }
  return data;
}

/** Yahoo chart endpoint'inden son fiyat + günlük değişim (%). Anahtarsız. */
export async function fetchQuote(cacheRoot, ticker) {
  try {
    const { data } = await cachedFetch(
      cacheRoot,
      `quote_${ticker.toUpperCase()}`,
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=1d`,
      { maxAgeDays: 1 },
    );
    const meta = data?.chart?.result?.[0]?.meta;
    if (!meta) return null;
    return {
      price: Number(meta.regularMarketPrice) || 0,
      changePercent: Number(meta.regularMarketChangePercent) || 0,
    };
  } catch {
    return null;
  }
}

export { fetchWithRetry };
