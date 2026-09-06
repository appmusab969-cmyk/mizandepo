// Mizan veri yenileyici
// ----------------------
// halalterminal.com API'sinden `symbols.txt` içindeki her sembol için Şeriat
// tarama sonucunu çeker ve `stocks.json`'u üretir. Uygulama bu dosyayı doğrudan
// okur; API'yi hiç görmez.
//
// Çalıştırma:
//   HALALTERMINAL_API_KEY=... node scripts/fetch.mjs
//
// Politika (free plan, ~50 istek/ay):
//   - Sadece `symbols.txt` listesindeki semboller sorgulanır.
//   - Her sembol için TEK istek: GET /api/screen/{symbol}  (~3-5 token).
//   - `price` / `changePercent` / `assetType` API'den gelmez; mevcut
//     stocks.json'daki değer korunur (ilk kez ekleniyorsa 0 / "Hisse").
//   - Bir sembol başarısız olursa o sembol atlanır, script çökmez.
//   - Hiç sembol çekilemezse çıkış kodu 1 → workflow commit atmaz.

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const SYMBOLS_FILE = join(REPO_ROOT, 'symbols.txt');
const OUT_FILE = join(REPO_ROOT, 'stocks.json');

const API_BASE = 'https://api.halalterminal.com';
const API_KEY = process.env.HALALTERMINAL_API_KEY;

if (!API_KEY) {
  console.error('HATA: HALALTERMINAL_API_KEY ortam degiskeni tanimli degil.');
  process.exit(2);
}

/** symbols.txt -> ['AAPL', 'MSFT', ...] */
async function readSymbols() {
  const raw = await readFile(SYMBOLS_FILE, 'utf8');
  return raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => l.toUpperCase());
}

/** Varsa eski stocks.json -> Map<symbol, kayit> (fiyat vb. korumak icin). */
async function readPrevious() {
  try {
    const raw = await readFile(OUT_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed) ? parsed : parsed.stocks ?? [];
    return new Map(list.map((s) => [String(s.symbol).toUpperCase(), s]));
  } catch {
    return new Map();
  }
}

const SECTOR_TR = {
  Technology: 'Teknoloji',
  'Consumer Cyclical': 'Tuketici (dongusel)',
  'Consumer Defensive': 'Tuketici (savunmaci)',
  'Communication Services': 'Iletisim',
  Healthcare: 'Saglik',
  'Financial Services': 'Finans',
  Industrials: 'Sanayi',
  Energy: 'Enerji',
  'Basic Materials': 'Temel malzeme',
  'Real Estate': 'Gayrimenkul',
  Utilities: 'Kamu hizmetleri',
};

/** halalterminal compliance -> uygulamanin bekledigi status anahtari. */
function toStatus(screen) {
  // Once acik "compliant/non_compliant" alanlarina bak.
  const s = (
    screen.compliance_status ??
    screen.shariah_compliance_status ??
    ''
  )
    .toString()
    .toLowerCase();
  if (s.includes('non') || s === 'haram' || s === 'non_compliant') {
    return 'nonHalal';
  }
  if (s === 'compliant' || s === 'halal') return 'halal';

  // Sonra is_compliant bayragi + ekran gecisleri.
  if (screen.is_compliant === true) return 'halal';
  if (screen.is_compliant === false) return 'nonHalal';
  if (screen.business_screen_pass === false) return 'nonHalal';
  if (
    screen.business_screen_pass === true &&
    screen.financial_screen_pass === true
  ) {
    return 'halal';
  }
  // Emin degiliz -> asla "helal" deme.
  return 'doubtful';
}

/** ETF: /api/etf/{symbol}/screening cevabindan status anahtari. */
function toEtfStatus(etf) {
  const s = (etf.compliance_status ?? '').toString().toLowerCase();
  if (s === 'compliant') return 'halal';
  if (s.includes('non')) return 'nonHalal';
  // Scholar-certified ise (S&P/Wahed Seriat kurulu) helal say.
  if (etf.disposition === 'scholar_certified' && Array.isArray(etf.scholar_attestations)) {
    const ok = etf.scholar_attestations.some(
      (a) => (a.position ?? '').toLowerCase() === 'compliant' && a.stale !== true,
    );
    if (ok) return 'halal';
  }
  // Holdings agirligina bak: uyumlu agirlik yuksek, uyumsuz dusukse helal.
  const w = etf.summary ?? {};
  if (Number(w.non_compliant_weight) <= 5 && Number(w.compliant_weight) >= 80) {
    return 'halal';
  }
  return 'doubtful';
}

function etfScore(status, etf) {
  if (status === 'nonHalal') return 15;
  let score = status === 'halal' ? 88 : 60;
  const pr = Number(etf?.purification_rate);
  if (Number.isFinite(pr)) {
    if (pr > 0.98) score += 6;
    else if (pr < 0.9) score -= 8;
  }
  if (etf?.disposition === 'scholar_certified') score += 4;
  return Math.max(0, Math.min(100, Math.round(score)));
}

function etfWhyNote(status, etf) {
  if (!etf) return null;
  const auth = etf.scholar_attestations?.[0]?.authority;
  if (status === 'halal' && auth) {
    return `${auth} tarafindan Seriat'a uygun onaylandi (AAOIFI metodolojisi).`;
  }
  const w = etf.summary ?? {};
  if (Number.isFinite(Number(w.non_compliant_weight))) {
    return `Portfoyun %${Number(w.compliant_weight).toFixed(0)} uyumlu, ` +
      `%${Number(w.non_compliant_weight).toFixed(1)} uyumsuz agirlikta; ` +
      `arindirma orani ~%${((1 - Number(etf.purification_rate)) * 100 || 0).toFixed(1)}.`;
  }
  return null;
}

/** 0-100 arasi kaba bir Mizan skoru (API vermiyor, oranlardan turetiyoruz). */
function mizanScore(status, screen) {
  if (status === 'nonHalal') return 10;
  let score = status === 'halal' ? 82 : 55;
  const debt = Number(screen.debt_to_market_cap_ratio ?? screen.debt_to_assets_ratio);
  if (Number.isFinite(debt)) {
    if (debt < 0.1) score += 8;
    else if (debt < 0.2) score += 4;
    else if (debt > 0.3) score -= 6;
  }
  const pr = Number(screen.purification_rate);
  if (Number.isFinite(pr) && pr > 0.98) score += 4;
  return Math.max(0, Math.min(100, Math.round(score)));
}

function whyNote(status, screen) {
  if (screen.business_screen_reason) {
    const r = screen.business_screen_reason.trim();
    if (r && r !== 'Business activity is compliant.') return r;
  }
  if (status === 'nonHalal') {
    return 'Faaliyet alani ya da finansal oranlari AAOIFI kapsaminda uygun degil.';
  }
  if (status === 'doubtful') {
    return 'Faaliyet alani uygun gorunuyor ancak en az bir finansal oran sinirda; arindirma gerekebilir.';
  }
  return null;
}

async function apiGet(path) {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { 'X-API-Key': API_KEY, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  return res.json();
}

const screenSymbol = (symbol) =>
  apiGet(`/api/screen/${encodeURIComponent(symbol)}`);

/**
 * ETF uyum durumu ayri bir endpoint'te. `/api/screen` ETF'ler icin
 * compliance_status'u bos birakiyor; burasi scholar_certified / holdings
 * analizini veriyor. Cagri bulunamazsa null doner (o zaman equity ekranina
 * guveniriz).
 */
async function etfScreening(symbol) {
  try {
    return await apiGet(`/api/etf/${encodeURIComponent(symbol)}/screening`);
  } catch {
    return null;
  }
}

async function main() {
  const symbols = await readSymbols();
  const prev = await readPrevious();
  console.log(`${symbols.length} sembol taranacak.`);

  const out = [];
  let ok = 0;
  let failed = 0;

  for (const symbol of symbols) {
    const old = prev.get(symbol) ?? {};
    try {
      const screen = await screenSymbol(symbol);
      const isEtf = (screen.asset_type ?? '').toLowerCase() === 'etf';

      // ETF'ler icin uyum durumu ayri endpoint'ten; hisseler icin screen yeter.
      let status;
      let etf = null;
      if (isEtf) {
        etf = await etfScreening(symbol);
        status = etf ? toEtfStatus(etf) : toStatus(screen);
      } else {
        status = toStatus(screen);
      }

      const assetType = isEtf ? 'ETF' : (old.assetType ?? 'Hisse');
      const sectorEn = screen.sector ?? '';
      out.push({
        symbol,
        name: screen.name ?? old.name ?? symbol,
        sector: isEtf
          ? (old.sector && old.sector !== '' ? old.sector : 'Endeks')
          : (SECTOR_TR[sectorEn] || sectorEn || old.sector || '—'),
        assetType,
        // Fiyat verisi API'den cekilmiyor; eski deger korunur.
        price: Number(old.price ?? 0),
        changePercent: Number(old.changePercent ?? 0),
        marketCapBillions: Number.isFinite(Number(screen.market_cap))
          ? Math.round(Number(screen.market_cap) / 1e9)
          : Number(old.marketCapBillions ?? 0),
        // dividend_yield API'de zaten YUZDE olarak geliyor (0.33 = %0.33).
        dividendYield: Number.isFinite(Number(screen.dividend_yield))
          ? Number(Number(screen.dividend_yield).toFixed(2))
          : Number(old.dividendYield ?? 0),
        // debt_to_market_cap_ratio bir ORAN (0.0183); yuzdeye cevir.
        debtRatio: Number.isFinite(Number(screen.debt_to_market_cap_ratio))
          ? Number((Number(screen.debt_to_market_cap_ratio) * 100).toFixed(1))
          : Number(old.debtRatio ?? 0),
        status,
        mizanScore: isEtf
          ? etfScore(status, etf)
          : mizanScore(status, screen),
        ...(() => {
          const note = isEtf
            ? etfWhyNote(status, etf)
            : whyNote(status, screen);
          return note ? { whyNote: note } : old.whyNote ? { whyNote: old.whyNote } : {};
        })(),
      });
      ok++;
      console.log(`  OK   ${symbol.padEnd(6)} -> ${status}`);
    } catch (err) {
      failed++;
      console.warn(`  FAIL ${symbol.padEnd(6)} -> ${err.message}`);
      // Eski kaydi varsa koru ki liste kismen bozulmasin.
      if (old.symbol) out.push(old);
    }
    // Nazik ol: istekler arasi kisa bekleme.
    await new Promise((r) => setTimeout(r, 400));
  }

  if (ok === 0) {
    console.error('Hicbir sembol cekilemedi; stocks.json degistirilmedi.');
    process.exit(1);
  }

  out.sort((a, b) => b.mizanScore - a.mizanScore);
  const payload = {
    updatedAt: new Date().toISOString().slice(0, 10),
    source: 'halalterminal.com /api/screen',
    note:
      'Otomatik uretildi (scripts/fetch.mjs). Uygulama bu dosyayi gunde bir ' +
      'kez ceker; fiyatlar manuel/yaklasiktir.',
    counts: { ok, failed, total: symbols.length },
    stocks: out,
  };
  await writeFile(OUT_FILE, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  console.log(`\nstocks.json yazildi: ${ok} basarili, ${failed} basarisiz.`);
}

main().catch((err) => {
  console.error('Beklenmeyen hata:', err);
  process.exit(1);
});
