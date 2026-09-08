// Mizan Şeriat tarama algoritması — AAOIFI standardı
// ==================================================
// Kaynak: AAOIFI Şeriat Standardı No. 21 ("Hisse Senetleri ve Tahviller
// Alım-Satımı") ve dünyada yaygın uygulaması (Wahed, SP Funds / S&P Dow Jones
// Islamic Market, DJIM). Üçüncü bir tarama servisine güvenmiyoruz; ham SEC
// EDGAR verisinden kendimiz hesaplıyoruz.
//
// DİNİ UYGULAMA İLKESİ: Emin olmadığımız hiçbir şeye "helal" demeyiz.
// Veri eksikse, oran sınırdaysa ya da kaynak bayatsa sonuç "şüpheli"dir.
//
// ── 1) Faaliyet (sektör) taraması ───────────────────────────────────────────
// Aşağıdaki alanlarda ESAS faaliyeti olan şirket doğrudan "uygun değil":
//   • Faizli bankacılık, aracı kurum, faizli finans/leasing, sigorta
//   • Alkol, domuz ürünleri, kumar/bahis, tütün
//   • Yetişkin içerik, silah (konvansiyonel savaş sanayii)
//   • Faizli gelir ağırlıklı eğlence/medya (vaka bazlı → şüpheli)
// SIC (Standard Industrial Classification) kodu ile ayıklıyoruz.
//
// ── 2) Finansal oran taraması (AAOIFI) ──────────────────────────────────────
// Payda = piyasa değeri (hisse adedi × güncel fiyat). Piyasa değeri yoksa
// toplam varlık kullanılır (S&P bazı sürümlerinde varlık; AAOIFI piyasa değeri).
//   a) Faizli borç / payda            < %30
//   b) (Nakit + faizli menkul kıymet) / payda   < %30
//   c) Alacaklar / payda              < %49   (bazı kurullar; sınırda → şüpheli)
//   d) Faizli (helal olmayan) gelir / toplam gelir   < %5
//
// ── 3) Karar ───────────────────────────────────────────────────────────────
//   • Sektör uygun DEĞİL                                   → nonHalal
//   • Tüm oranlar eşiğin altında + sektör uygun            → halal
//   • Sektör uygun ama bir oran eşiği AZ aşıyor (≤ +5 puan) → doubtful
//   • Sektör uygun ama bir oran eşiği çok aşıyor            → nonHalal
//   • Veri yetersiz / kaynak bayat                          → doubtful

// AAOIFI eşikleri (oran, payda cinsinden).
export const THRESHOLDS = {
  debt: 0.30,
  liquidity: 0.30, // nakit + faizli menkul kıymetler
  receivables: 0.49,
  impureIncome: 0.05,
  // Bir oranın "sınırda" sayıldığı tolerans (mutlak puan). Eşik + tolerans
  // arasındaki değer "şüpheli", üstü "uygun değil".
  marginPoints: 0.05,
};

/**
 * SIC kod aralıkları → yasak faaliyet. Kaynak: SEC SIC listesi.
 * Aralık [min, max] dahil.
 */
const HARAM_SIC_RANGES = [
  // Depository & non-depository credit, faizli bankacılık
  [6000, 6199, 'Faizli bankacılık / kredi kurumu'],
  // Security & commodity brokers, dealers, exchanges
  [6200, 6299, 'Menkul kıymet aracılığı / borsa'],
  // Insurance carriers & agents
  [6300, 6411, 'Sigortacılık'],
  // Investment offices (faizli fon/holding) — vaka bazlı, çoğu ETF burada değil
  [6722, 6726, 'Yatırım fonu / faizli holding'],
  // Federal & federally-sponsored credit agencies
  [6011, 6023, 'Faizli kredi ajansı'],
];

/** Tekil SIC kodları (aralık değil).
 *  DİKKAT: SIC 2080 = "İçecek" ÜST kategorisidir (alkolsüz dâhil: Coca-Cola,
 *  PepsiCo bu koddadır). Yalnızca 2082/2084/2085 kesin alkoldür. 2086 =
 *  "Alkolsüz içecek / gazoz" → uygun. Bu ayrımı yapmazsak KO/PEP yanlışlıkla
 *  "uygun değil" çıkar; S&P ve DJIM bunları uyumlu sayar. */
const HARAM_SIC_CODES = new Map([
  [2082, 'Malt içecekler (bira)'],
  [2084, 'Şarap / brendi'],
  [2085, 'Damıtılmış alkollü içki'],
  [2080, 'İçecek (üst kategori) — alkolsüz olabilir, gelir kırılımı doğrulanmalı'],
  [2100, 'Tütün ürünleri'],
  [2111, 'Sigara'],
  [2120, 'Puro'],
  [2131, 'Tütün (çiğneme / enfiye)'],
  [2140, 'Tütün yaprağı'],
  [5122, 'İlaç / alkol toptan (karma) — vaka bazlı'],
  [5182, 'İçki toptan ticareti'],
  [5813, 'İçki servisi yapan mekânlar (bar)'],
  [7993, 'Kumar makineleri / oyun salonu'],
  [7900, 'Eğlence — vaka bazlı'],
  [7011, 'Otelcilik — kumar/bar gelirine göre vaka bazlı'],
  [3480, 'Mühimmat'],
  [3482, 'Küçük çaplı mühimmat'],
  [3483, 'Mühimmat (30mm üstü)'],
  [3484, 'Hafif silah'],
  [3489, 'Savaş araç-gereçleri'],
  [3795, 'Tank ve askeri araç'],
  [2870, 'Tarım kimyasalları — vaka bazlı'],
]);

/** "Vaka bazlı" olanlar: doğrudan nonHalal değil, doubtful yapar.
 *  2080 (içecek üst kategorisi) burada: Coca-Cola gibi alkolsüz üreticiler
 *  yanlışlıkla mahkûm edilmesin, ama alkol geliri olan şirketler de sessizce
 *  geçmesin — kullanıcı gelir kırılımını doğrulasın diye "şüpheli". */
const REVIEW_SIC_CODES = new Set([2080, 5122, 7900, 7011, 2870, 2833]);

/**
 * @returns {{ status: 'ok'|'review'|'haram', reason: string|null }}
 */
/** SIC 7389 (Business Services, NEC) çok geniş bir çöp kutusu: Visa, Mastercard,
 *  FIS gibi ödeme ağları da, sıradan yazılım/hizmet şirketleri de burada. Kod
 *  bazında ayıramadığımız için isimden yakalıyoruz. Bu isimler DOĞRUDAN "haram"
 *  değil (âlimler ödeme ağları konusunda ihtilaflı) → "review" = şüpheli. */
const NAME_REVIEW_PATTERNS = [
  [/\bvisa\b/i, 'Ödeme ağı — faizli kredi ekosistemine bağlı, ihtilaflı'],
  [/master ?card/i, 'Ödeme ağı — faizli kredi ekosistemine bağlı, ihtilaflı'],
  [/american express/i, 'Kart / kredi kuruluşu — faizli gelir ağırlıklı'],
  [/\bfiserv\b|\bfis\b|global payments|\bpaypal\b|\bfleetcor\b|\bwex\b/i,
    'Ödeme işleme — faizli kredi ekosistemine bağlı, ihtilaflı'],
  [/moody'?s|s&p global|s and p global|fitch|morningstar|msci inc/i,
    'Kredi derecelendirme / tahvil endeksi geliri — faize dayalı'],
];

export function businessScreen(sic, sicDescription = '', name = '') {
  // İsim bazlı ihtilaflı liste (SIC kodu genel olsa bile).
  for (const [re, label] of NAME_REVIEW_PATTERNS) {
    if (re.test(name)) return { status: 'review', reason: `${label}.` };
  }
  if (sic == null) {
    return { status: 'review', reason: 'Sektör kodu (SIC) bulunamadı; faaliyet doğrulanamadı.' };
  }
  // Kredi raporlama / tahsilat — faizli finansa bitişik.
  if (sic === 7320 || sic === 7322) {
    return { status: 'haram', reason: `Kredi raporlama / tahsilat (SIC ${sic}) — faizli finans ekosistemi.` };
  }
  for (const [min, max, label] of HARAM_SIC_RANGES) {
    if (sic >= min && sic <= max) return { status: 'haram', reason: label };
  }
  if (HARAM_SIC_CODES.has(sic)) {
    const label = HARAM_SIC_CODES.get(sic);
    return REVIEW_SIC_CODES.has(sic)
      ? { status: 'review', reason: `${label} (SIC ${sic}) — arındırma gerekebilir.` }
      : { status: 'haram', reason: `${label} (SIC ${sic}).` };
  }
  // Açıklamada anahtar kelime taraması (SIC kodu genel olsa bile).
  const d = sicDescription.toLowerCase();
  const KW = [
    ['bank', 'Faizli bankacılık'],
    ['insurance', 'Sigortacılık'],
    ['casino', 'Kumar'],
    ['gaming', 'Kumar / bahis'],
    ['tobacco', 'Tütün'],
    ['brewer', 'Alkollü içecek'],
    ['distiller', 'Alkollü içki'],
    ['winer', 'Şarap'],
  ];
  for (const [kw, label] of KW) {
    if (d.includes(kw)) return { status: 'haram', reason: `${label} (${sicDescription}).` };
  }
  return { status: 'ok', reason: null };
}

/**
 * AAOIFI finansal oranlarını hesaplar.
 * @param fin  extractFinancials() çıktısı
 * @param marketCap  piyasa değeri (USD). 0/null ise varlık paydası kullanılır.
 */
export function financialRatios(fin, marketCap) {
  const denom =
    marketCap && marketCap > 0
      ? { value: marketCap, basis: 'piyasa değeri' }
      : fin.assets && fin.assets > 0
        ? { value: fin.assets, basis: 'toplam varlık' }
        : null;

  const ratio = (num) =>
    denom && Number.isFinite(num) ? num / denom.value : null;

  const debtRatio = ratio(fin.debt);
  const liquidityRatio = ratio(fin.cashAndInterestSecurities);
  const receivablesRatio = ratio(fin.receivables);
  const impureIncomeRatio =
    fin.revenue && fin.revenue > 0 && Number.isFinite(fin.interestIncome)
      ? Math.max(0, fin.interestIncome) / fin.revenue
      : null;

  // Arındırma oranı: helal olmayan gelir / net kâr (bilgi amaçlı gösterim).
  const purificationRate =
    fin.netIncome && fin.netIncome > 0 && Number.isFinite(fin.interestIncome)
      ? Math.max(0, fin.interestIncome) / fin.netIncome
      : null;

  // AAOIFI arındırma yöntemi — HİSSE BAŞINA helal olmayan gelir (USD/yıl).
  //   arındırılacak = (yıllık toplam faiz geliri / dolaşan hisse adedi)
  //                   × sahip olunan adet × (tutulan gün / 365)
  // Bu ana veri (tutar + adet) olmadan hesap YAPILMAZ — uygulama kullanıcıyı
  // 10-K / âlime yönlendirir (yanlış rakam vermek dini kayıp riski taşır).
  const impurePerShareUsd =
    Number.isFinite(fin.interestIncome) &&
    fin.interestIncome > 0 &&
    fin.sharesOutstanding &&
    fin.sharesOutstanding > 0
      ? fin.interestIncome / fin.sharesOutstanding
      : null;

  return {
    denominatorBasis: denom?.basis ?? null,
    debtRatio,
    liquidityRatio,
    receivablesRatio,
    impureIncomeRatio,
    purificationRate,
    impurePerShareUsd,
  };
}

/** Bir oranı eşiğe göre değerlendirir. */
function judgeRatio(value, threshold, label) {
  if (value == null) return { verdict: 'unknown', label, value: null, threshold };
  if (value < threshold) return { verdict: 'pass', label, value, threshold };
  if (value <= threshold + THRESHOLDS.marginPoints)
    return { verdict: 'margin', label, value, threshold };
  return { verdict: 'fail', label, value, threshold };
}

/**
 * Tam tarama sonucu.
 * @returns {{
 *   status: 'halal'|'doubtful'|'nonHalal',
 *   score: number,          // 0-100 Mizan skoru
 *   whyNote: string,        // kullanıcıya gösterilecek gerekçe
 *   ratios: object,         // hesaplanan oranlar (%)
 *   checks: object[],       // her oranın verdict'i
 * }}
 */
export function screenEquity({ business, ratios, dataComplete, stale }) {
  // 1) Sektör.
  if (business.status === 'haram') {
    return {
      status: 'nonHalal',
      score: 5,
      whyNote: `Faaliyet alanı uygun değil: ${business.reason}`,
      ratios: ratiosToPercent(ratios),
      checks: [{ label: 'Faaliyet alanı', verdict: 'fail', detail: business.reason }],
    };
  }

  const checks = [
    judgeRatio(ratios.debtRatio, THRESHOLDS.debt, 'Faizli borç / ' + (ratios.denominatorBasis ?? 'payda')),
    judgeRatio(ratios.liquidityRatio, THRESHOLDS.liquidity, 'Nakit + faizli menkul kıymet / ' + (ratios.denominatorBasis ?? 'payda')),
    judgeRatio(ratios.receivablesRatio, THRESHOLDS.receivables, 'Alacaklar / ' + (ratios.denominatorBasis ?? 'payda')),
    judgeRatio(ratios.impureIncomeRatio, THRESHOLDS.impureIncome, 'Helal olmayan (faiz) gelir / toplam gelir'),
  ];

  const failed = checks.filter((c) => c.verdict === 'fail');
  const margin = checks.filter((c) => c.verdict === 'margin');
  const unknown = checks.filter((c) => c.verdict === 'unknown');

  // AAOIFI oranları PİYASA DEĞERİ paydasıyla tanımlıdır. Piyasa değerini
  // bulamayıp toplam varlık paydasına düştüysek, aşan bir oran tek başına
  // "haram" hükmü VERDİRMEZ — en fazla "şüpheli" deriz (dini ihtiyat).
  const denomIsMarketCap = ratios.denominatorBasis === 'piyasa değeri';

  let status;
  let note;

  if (failed.length > 0 && denomIsMarketCap) {
    status = 'nonHalal';
    note = `Finansal oran eşiği aşıldı: ${failed
      .map((c) => `${c.label} %${(c.value * 100).toFixed(1)} (eşik %${(c.threshold * 100).toFixed(0)})`)
      .join('; ')}.`;
  } else if (failed.length > 0) {
    status = 'doubtful';
    note =
      `Bir finansal oran eşiği aşıyor (${failed
        .map((c) => `${c.label} %${(c.value * 100).toFixed(1)}`)
        .join('; ')}) ancak piyasa değeri hesaplanamadığı için oranlar TOPLAM VARLIK ` +
      'üzerinden alındı. AAOIFI piyasa değeri paydası kullanır; kesin hüküm için ' +
      'şirketin güncel piyasa değerini esas alan bir taramaya bakınız.';
  } else if (business.status === 'review') {
    status = 'doubtful';
    note = `Finansal oranlar uygun ancak faaliyet alanı incelenmeli: ${business.reason}`;
  } else if (unknown.length >= 2 || !dataComplete) {
    status = 'doubtful';
    note =
      'Bazı finansal kalemler SEC verisinde bulunamadı; ihtiyatla "şüpheli" işaretlendi. ' +
      'Kesin hüküm için şirketin son 10-K raporuna bakınız.';
  } else if (margin.length > 0) {
    status = 'doubtful';
    note = `Faaliyet alanı uygun; ancak bir oran sınırda: ${margin
      .map((c) => `${c.label} %${(c.value * 100).toFixed(1)} (eşik %${(c.threshold * 100).toFixed(0)})`)
      .join('; ')}. Arındırma gerekebilir.`;
  } else {
    status = 'halal';
    note =
      'Faaliyet alanı uygun; faizli borç, likidite ve faiz geliri oranlarının hepsi AAOIFI eşiklerinin altında.';
    if (ratios.purificationRate != null && ratios.purificationRate > 0) {
      note += ` Tahmini arındırma: temettünün ~%${(ratios.purificationRate * 100).toFixed(1)}'i.`;
    }
  }

  if (stale && status === 'halal') {
    status = 'doubtful';
    note =
      'SEC verisi güncellenemedi (ağ/limit); son doğrulanmış veriye göre oranlar uygundu ' +
      'ancak güncel beyanname doğrulanana kadar ihtiyatla "şüpheli".';
  }

  return {
    status,
    score: mizanScore(status, ratios, business),
    whyNote: note,
    ratios: ratiosToPercent(ratios),
    checks: checks.map((c) => ({
      label: c.label,
      verdict: c.verdict,
      value: c.value == null ? null : Number((c.value * 100).toFixed(1)),
      threshold: Number((c.threshold * 100).toFixed(0)),
    })),
  };
}

function ratiosToPercent(r) {
  const p = (v) => (v == null ? null : Number((v * 100).toFixed(1)));
  return {
    denominatorBasis: r.denominatorBasis,
    debtRatioPct: p(r.debtRatio),
    liquidityRatioPct: p(r.liquidityRatio),
    receivablesRatioPct: p(r.receivablesRatio),
    impureIncomeRatioPct: p(r.impureIncomeRatio),
    purificationRatePct: p(r.purificationRate),
    // Hisse başına helal olmayan gelir (USD/yıl) — arındırma hesabının temeli.
    // Yuvarlanmaz; küçük tutarlar (ör. 0.003 $) anlamlı.
    impurePerShareUsd:
      r.impurePerShareUsd == null ? null : Number(r.impurePerShareUsd.toFixed(6)),
  };
}

/** 0-100 Mizan skoru: eşiklere ne kadar pay bıraktığına göre. */
function mizanScore(status, r, business) {
  if (status === 'nonHalal') return business.status === 'haram' ? 5 : 12;
  let score = status === 'halal' ? 80 : 50;

  const headroom = (val, thr) => (val == null ? 0 : Math.max(-1, Math.min(1, (thr - val) / thr)));
  score += 8 * headroom(r.debtRatio, THRESHOLDS.debt);
  score += 6 * headroom(r.liquidityRatio, THRESHOLDS.liquidity);
  score += 3 * headroom(r.receivablesRatio, THRESHOLDS.receivables);
  score += 5 * headroom(r.impureIncomeRatio, THRESHOLDS.impureIncome);

  if (r.purificationRate != null && r.purificationRate < 0.01) score += 3;

  return Math.max(0, Math.min(100, Math.round(score)));
}
