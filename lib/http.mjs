// Ortak HTTP yardımcıları — SEC EDGAR "fair access" politikasına uyar.
// -------------------------------------------------------------------
// SEC, saniyede en fazla 10 istek ister ve gerçek bir User-Agent (kişi/kurum +
// iletişim) zorunlu kılar. Biz çok daha yavaş gideriz (~1 istek/sn) ve her
// yanıtı `cache/` altında saklarız; böylece tekrar tekrar çalıştırınca EDGAR'a
// neredeyse hiç gitmeyiz ve limite takılmayız.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';

/** SEC zorunlu tutuyor: gerçek iletişim bilgisi içeren User-Agent. */
export const USER_AGENT = 'Mizan Screener (musabgoka@gmail.com)';

/** İstekler arası minimum bekleme (ms). 1100ms ≈ 0.9 istek/sn — limitin çok altı. */
const MIN_GAP_MS = 1100;

let _lastRequestAt = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Küresel hız sınırlayıcı: iki ağ isteği arasında en az MIN_GAP_MS bırakır. */
async function throttle() {
  const now = Date.now();
  const wait = _lastRequestAt + MIN_GAP_MS - now;
  if (wait > 0) await sleep(wait);
  _lastRequestAt = Date.now();
}

/**
 * Bir URL'yi çeker; 429/503 alırsa artan beklemeyle 4 kez dener.
 * `accept` başlığı ve dönüş tipi ('json' | 'text') seçilebilir.
 */
export async function fetchWithRetry(url, { accept = 'application/json', as = 'json' } = {}) {
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    await throttle();
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT, Accept: accept },
      });
      if (res.status === 429 || res.status === 503) {
        const backoff = 2000 * (attempt + 1) * (attempt + 1); // 2s, 8s, 18s, 32s
        console.warn(`  ${res.status} ${url} — ${backoff}ms bekleniyor`);
        await sleep(backoff);
        lastErr = new Error(`HTTP ${res.status}`);
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      return as === 'text' ? res.text() : res.json();
    } catch (err) {
      lastErr = err;
      await sleep(1500 * (attempt + 1));
    }
  }
  throw lastErr ?? new Error(`fetch başarısız: ${url}`);
}

/**
 * Diske dayalı cache ile çeker. `cache/<key>.json` varsa ve `maxAgeDays`'ten
 * yeni ise ağ isteği YAPILMAZ. Aksi halde çeker, cache'e yazar ve döndürür.
 * Ağ hatası olursa bayat da olsa cache varsa onu döndürür (dini uygulama —
 * yanlış "helal" dememek için elimizdeki en iyi doğrulanmış veriyle çalışırız).
 *
 * @returns {{data: any, fromCache: boolean, stale: boolean}}
 */
export async function cachedFetch(cacheRoot, key, url, {
  maxAgeDays = 20,
  accept = 'application/json',
  as = 'json',
} = {}) {
  const path = join(cacheRoot, `${key}.json`);
  let cached = null;
  try {
    cached = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    cached = null;
  }

  const ageDays = cached?.fetchedAt
    ? (Date.now() - Date.parse(cached.fetchedAt)) / 86_400_000
    : Infinity;

  if (cached && ageDays < maxAgeDays) {
    return { data: cached.data, fromCache: true, stale: false };
  }

  try {
    const data = await fetchWithRetry(url, { accept, as });
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      JSON.stringify({ url, fetchedAt: new Date().toISOString(), data }, null, 0),
      'utf8',
    );
    return { data, fromCache: false, stale: false };
  } catch (err) {
    if (cached) {
      console.warn(`  ${key}: ağ hatası (${err.message}); bayat cache kullanılıyor.`);
      return { data: cached.data, fromCache: true, stale: true };
    }
    throw err;
  }
}
