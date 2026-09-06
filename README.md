# mizandepo — Mizan veri deposu

Mizan uygulamasının gösterdiği **ABD borsası helal hisse / fon / ETF** listesi.

## Nasıl çalışır

```
halalterminal.com API
        │  (ayda 1 kez, GitHub Actions — .github/workflows/update.yml)
        ▼
   stocks.json   ◄── tek gerçek kaynak (bu repoda)
        │  (günde 1 kez, cihaz başına — uygulamadaki StockRepository)
        ▼
   Mizan uygulaması  ── cihazda SharedPreferences cache + gömülü asset yedeği
```

- **Uygulama API'yi hiç görmez.** Sadece bu repodaki `stocks.json`'u okur:
  `https://raw.githubusercontent.com/appmusab969-cmyk/mizandepo/main/stocks.json`
- **API limiti:** halalterminal free planı ayda ~50 istek / ~500 token verir.
  `symbols.txt` ~45 sembol içerdiğinden workflow **ayda bir** çalışır. Planı
  yükseltirsen `update.yml` içindeki cron'u haftalığa çevir (`0 6 * * 1`).

## Dosyalar

| Dosya | Ne işe yarar |
|---|---|
| `stocks.json` | Uygulamanın okuduğu liste. Elle de düzenlenebilir. |
| `symbols.txt` | Taranacak semboller (satır başına bir tane, `#` yorum). |
| `scripts/fetch.mjs` | API'den çekip `stocks.json` üreten Node script'i. |
| `.github/workflows/update.yml` | Aylık cron + elle tetikleme. |

## Kurulum (bir kez)

1. Bu klasörün içeriğini `appmusab969-cmyk/mizandepo` reposuna yükle (`main`).
2. Repo → **Settings → Secrets and variables → Actions → New repository secret**
   - Ad: `HALALTERMINAL_API_KEY`
   - Değer: halalterminal API anahtarın
3. **Actions** sekmesi → "stocks.json guncelle" → **Run workflow** ile ilk
   çekimi elle başlat (ya da ay başı cron'u bekle).

## Elle güncelleme

`stocks.json`'u düzenle, `main`'e commit'le. Kullanıcılar bir sonraki günlük
yenilemede (veya uygulamada aşağı çekince) alır.

## Şema

Kök: `{ "updatedAt": "...", "stocks": [ ... ] }`. Her kayıt:

| Alan | Tip | Kaynak | Not |
|---|---|---|---|
| `symbol` | string | symbols.txt | Zorunlu |
| `name` | string | API | |
| `sector` | string | API (TR'ye çevrilir) | ETF'lerde "Endeks" |
| `assetType` | string | API (`asset_type`) | `Hisse` / `ETF` |
| `price` | number | **elle / eski değer** | API vermiyor; `0` = veri yok → uygulama `—` gösterir |
| `changePercent` | number | **elle / eski değer** | aynı |
| `marketCapBillions` | number | API (`market_cap` / 1e9) | |
| `dividendYield` | number | API (`dividend_yield`, zaten %) | |
| `debtRatio` | number | API (`debt_to_market_cap_ratio` × 100) | AAOIFI eşiği ~%33 |
| `status` | string | API | `halal` / `doubtful` / `nonHalal` — **tanınmayan değer asla helal sayılmaz** |
| `mizanScore` | integer | script (oranlardan türetilir) | 0–100 |
| `whyNote` | string | API (`business_screen_reason` / scholar) | |

Hisseler `/api/screen/{symbol}`, ETF'ler ayrıca `/api/etf/{symbol}/screening`
(scholar onayı / holdings ağırlığı) ile değerlendirilir. Tek sembol hatası o
sembolü atlar; hiç sembol çekilemezse script çıkış kodu 1 verir ve workflow
`stocks.json`'a dokunmaz.
