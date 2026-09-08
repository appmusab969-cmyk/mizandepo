// Fon (ETF) otomatik portföy sağlık denetimi
// ==========================================
// Bir ETF'in "Şeriat'a uygun" hükmünü Mizan VERMEZ — bunu fonun bağımsız Şeriat
// kurulu verir ve biz beyaz listeye (`etf-whitelist.json`) işleriz. Ama beyaz
// listedeki bir fon zamanla bozulabilir: endeks metodolojisi değişir, kurul
// gözden kaçırır, ya da fon bir dönem uyumsuz hisse taşır.
//
// Bu modül BİR KARAR DEĞİL, BİR UYARI ÜRETİR:
//   - Fonun en yeni N-PORT holdings listesi alınır (zaten çekiliyor).
//   - Her pozisyon, bizim taradığımız hisselerle (`stocks.json`) eşleştirilir.
//   - `nonHalal` çıkan pozisyonların toplam portföy ağırlığı hesaplanır.
//   - Bu ağırlık eşiği aşarsa fon otomatik `doubtful`'a düşürülür ve gerekçe
//     kullanıcıya yazılır; ayrıca `fund-health-report.json`'a kaydedilir, böylece
//     hangi fonun neden bozulduğu her hafta görülür ve elle beyaz listeden
//     çıkarılıp yerine başkası konabilir.
//
// DİNİ İLKE: burada da "emin değilsek helal deme". Denetim yalnızca aşağı çeker,
// asla yukarı çekmez — kurul onayı olmayan bir fonu "helal" YAPMAZ.

// Portföyün en fazla bu kadarı bizim taramamızda "uygun değil" çıkabilir.
// AAOIFI'nin uygunsuz gelir toleransıyla (%5) aynı ruhta.
export const NONHALAL_WEIGHT_LIMIT = 5.0; // yüzde puan

// "Uygun değil" + "şüpheli" toplamı bu kadarı geçerse de fonu şüpheliye çekeriz
// (portföyün büyük kısmı bizce doğrulanamıyor demektir).
export const UNVERIFIED_WEIGHT_LIMIT = 40.0; // yüzde puan

/**
 * @param {object[]} topHoldings  N-PORT'tan çıkarılan pozisyonlar
 *                                 [{symbol, name, weightPct}]
 * @param {Map<string, object>} stockBySymbol  SYMBOL -> taranmış hisse kaydı
 * @returns {{
 *   assessed: boolean,
 *   matchedWeightPct: number,
 *   nonHalalWeightPct: number,
 *   doubtfulWeightPct: number,
 *   offenders: {symbol: string, name: string, weightPct: number, status: string}[],
 *   verdict: 'clean' | 'watch' | 'breach',
 *   note: string | null,
 * }}
 */
export function assessFundHoldings(topHoldings, stockBySymbol) {
  const holdings = Array.isArray(topHoldings) ? topHoldings : [];
  // Ticker'ı olan ve bizim evrende bulunan pozisyonlar.
  let matched = 0;
  let nonHalal = 0;
  let doubtful = 0;
  const offenders = [];

  for (const h of holdings) {
    const sym = String(h.symbol || '').toUpperCase();
    const w = Number(h.weightPct) || 0;
    if (!sym || w <= 0) continue;
    const stock = stockBySymbol.get(sym);
    if (!stock) continue;
    matched += w;
    if (stock.status === 'nonHalal') {
      nonHalal += w;
      offenders.push({ symbol: sym, name: stock.name || h.name || sym, weightPct: w, status: 'nonHalal' });
    } else if (stock.status === 'doubtful') {
      doubtful += w;
      offenders.push({ symbol: sym, name: stock.name || h.name || sym, weightPct: w, status: 'doubtful' });
    }
  }

  // Portföyün eşleşen kısmı çok küçükse (ör. tamamı ABD dışı / sukuk, ticker
  // yok) denetim yapamayız — sessiz kalırız, kurul onayı geçerli sayılır.
  const MIN_COVERAGE = 15.0; // en az bu kadar ağırlık eşleşmeli
  if (matched < MIN_COVERAGE) {
    return {
      assessed: false,
      matchedWeightPct: round1(matched),
      nonHalalWeightPct: round1(nonHalal),
      doubtfulWeightPct: round1(doubtful),
      offenders: [],
      verdict: 'clean',
      note: null,
    };
  }

  offenders.sort((a, b) => b.weightPct - a.weightPct);

  let verdict = 'clean';
  let note = null;
  if (nonHalal >= NONHALAL_WEIGHT_LIMIT) {
    verdict = 'breach';
    note =
      `Portföyün ~%${round1(nonHalal)}'i Mizan taramasında "uygun değil" çıktı ` +
      `(eşik %${NONHALAL_WEIGHT_LIMIT}): ` +
      offenders
        .filter((o) => o.status === 'nonHalal')
        .slice(0, 5)
        .map((o) => `${o.symbol} %${o.weightPct}`)
        .join(', ') +
      '. Şeriat kurulu onayı gözden geçirilene kadar ihtiyatla "şüpheli".';
  } else if (nonHalal + doubtful >= UNVERIFIED_WEIGHT_LIMIT) {
    verdict = 'watch';
    note =
      `Portföyün ~%${round1(nonHalal + doubtful)}'i Mizan taramasında ` +
      '"uygun değil" ya da "şüpheli"; kurul onayı geçerli ancak izlemede.';
  } else if (nonHalal > 0) {
    verdict = 'watch';
    note = null; // rapora girer, kullanıcı hükmü değişmez
  }

  return {
    assessed: true,
    matchedWeightPct: round1(matched),
    nonHalalWeightPct: round1(nonHalal),
    doubtfulWeightPct: round1(doubtful),
    offenders,
    verdict,
    note,
  };
}

function round1(n) {
  return Math.round(n * 10) / 10;
}
