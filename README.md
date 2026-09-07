# mizandepo — Mizan veri deposu

Mizan uygulamasının gösterdiği **ABD borsası helal hisse / fon / ETF** listesi.

## Nasıl çalışır

```
SEC EDGAR (data.sec.gov)  ── ham XBRL: borç, nakit, alacak, gelir, faiz geliri
   + SIC sektör kodu           + Yahoo chart endpoint: fiyat / değişim %
        │
        │  (haftalık, GitHub Actions — .github/workflows/update.yml)
        │  Mizan'ın KENDİ AAOIFI algoritması (lib/screen.mjs) işler
        ▼
   stocks.json   ◄── uygulamanın okuduğu tek kaynak (bu repoda)
        │  (günde 1 kez, cihaz başına — uygulamadaki StockRepository)
        ▼
   Mizan uygulaması  ── cihazda SharedPreferences cache + gömülü asset yedeği
```

- **Üçüncü bir tarama servisi KULLANILMAZ.** Ham SEC verisi çekilip
  `scripts/build.mjs` içindeki algoritmayla helal / şüpheli / uygun değil
  kararına dönüştürülür. Önceki `halalterminal.com` bağımlılığı kaldırıldı.
- **Uygulama API'yi hiç görmez.** Sadece bu repodaki `stocks.json`'u okur:
  `https://raw.githubusercontent.com/appmusab969-cmyk/mizandepo/main/stocks.json`

## Standart — AAOIFI Şeriat Standardı No. 21

Dünyada en yaygın kabul gören ölçüt (Wahed, SP Funds / S&P Dow Jones Islamic
Market, DJIM bunu kullanır).

**1) Faaliyet (sektör) taraması** — SIC koduyla. Esas faaliyeti şu alanlarda
olan şirket doğrudan **uygun değil**: faizli bankacılık / aracı kurum / faizli
finans, sigorta, alkol, domuz, kumar, tütün, yetişkin içerik, konvansiyonel
savaş sanayii. "İçecek üst kategorisi" (SIC 2080, Coca-Cola vb.) gibi belirsiz
kodlar **şüpheli** işaretlenir (kullanıcı gelir kırılımını doğrulasın).

**2) Finansal oranlar** (payda = piyasa değeri; hesaplanamıyorsa toplam varlık):

| Oran | AAOIFI eşiği |
|---|---|
| Faizli borç / payda | < %30 |
| (Nakit + faizli menkul kıymet) / payda | < %30 |
| Alacaklar / payda | < %49 |
| Helal olmayan (faiz) gelir / toplam gelir | < %5 |

**3) Karar:** Sektör uygun değil → **uygun değil**. Tüm oranlar altında + sektör
uygun → **helal**. Bir oran eşiği az aşıyor (≤ +5 puan) ya da veri eksik →
**şüpheli**. Bir oran belirgin aşıyor (ve payda = piyasa değeri) → **uygun
değil**. Payda toplam varlıksa aşan oran tek başına "uygun değil" DEDİRTMEZ,
en fazla **şüpheli**.

> **Dini uygulama ilkesi:** Emin olmadığımız hiçbir şeye "helal" demeyiz.
> Veri eksik, oran sınırda ya da kaynak bayatsa sonuç **şüpheli**dir.

## ETF'ler

`etf-whitelist.json` içindeki, bağımsız **Şeriat kuruluna** sahip ETF'ler
(SPUS, HLAL, UMMA, SPSK, SPRE, ...) doğrudan **helal**. Listede olmayan HER
ETF **şüpheli** işaretlenir (kurul onayı bizce doğrulanamadı).

Her ETF için **künye + en büyük ~10 pozisyon** çekilir:

- **Portföy, fon büyüklüğü (AUM), pozisyon sayısı ve değerleme tarihi** →
  **SEC EDGAR Form N-PORT** (`NPORT-P`). ABD'de kayıtlı her fon çeyrekte bir bu
  beyannameyi verir; her pozisyonun adı, CUSIP/ticker'ı, USD değeri ve portföy
  yüzdesi içindedir. Resmi ve ücretsiz kaynak — hiçbir finans sitesi kazınmaz.
  `lib/edgar.mjs` → `fetchNportHoldings()`: EDGAR tam metin araması ile en yeni
  `NPORT-P`'yi bulur, `primary_doc.xml`'i ayrıştırır, seri adını fon adıyla
  doğrular (ticker/isim çakışmasına karşı) ve sonucu 30 gün cache'ler.
- **Gider oranı ve kuruluş tarihi** N-PORT'ta yer almaz (izahnamede); bunlar
  `etf-whitelist.json`'da `expenseRatioPct` / `inception` alanlarına elle
  işlenir.
- **UCITS / ABD dışı kayıtlı fonlar** (ISDW, ISUS, ISDE, WSHR, ...) N-PORT
  vermez → yalnızca beyaz liste + elle künye alanlarıyla gösterilir, portföy
  listesi boş kalır.

Uygulama tarafında portföydeki bir sembol, uygulamanın kendi listesinde de
varsa dokunulabilir ve o hissenin Şeriat taramasına gider
(`lib/screens/AssetDetail.dart`).

## Limit / cache

SEC "fair access" siniri **saniyede 10 istek** + gerçek `User-Agent` zorunlu.
Script `~1 istek/sn` gider (`lib/http.mjs` içinde `MIN_GAP_MS`). İki katmanlı
cache limite takılmayı önler:

| Klasör | İçerik | Boyut | Git'te? |
|---|---|---|---|
| `cache/` | Ham SEC companyfacts + submissions yanıtları | ~2 GB | **Hayır** (`.gitignore`) — sadece yerel hız |
| `cache-slim/` | Çıkarılmış özet: SIC + `extractFinancials()` çıktısı | ~0.7 MB | **Evet** — workflow commit'ler |

- **Slim cache** her CIK için ~0.5 KB tutar. 20 günden yeni bir slim kaydı
  varsa o şirket için EDGAR'a **hiç gidilmez**. GitHub Actions bu klasörü
  commit'lediği için haftalık çalışma çoğunlukla buradan okur.
- Fiyat/quote (Yahoo) cache'i 1 gün, ticker listesi 1 gün, S&P 500 bileşen
  listesi 7 gün.
- Tam çalışma (~500 hisse + 13 ETF): slim cache boşken ~20-25 dk (ilk hafta);
  slim cache doluyken ~5-10 dk (çoğu süre Yahoo fiyat çekmede).

## Dosyalar

| Dosya | Ne işe yarar |
|---|---|
| `stocks.json` | Uygulamanın okuduğu liste. Elle de düzenlenebilir. |
| `etf-whitelist.json` | Şeriat kurulu onaylı ETF'ler (helal kabul edilenler). |
| `scripts/build.mjs` | SEC'den çekip `stocks.json` üreten ana script. |
| `lib/http.mjs` | Hız sınırlayıcı + diske dayalı cache. |
| `lib/edgar.mjs` | SEC EDGAR + Yahoo erişimi, XBRL kalemi çıkarma, slim cache. |
| `lib/screen.mjs` | AAOIFI tarama algoritması (karar + Mizan skoru). |
| `cache-slim/` | Çıkarılmış özet cache (repoya commit'lenir). |
| `.github/workflows/update.yml` | Haftalık cron + elle tetikleme. |

## Çalıştırma

```bash
node scripts/build.mjs                 # tam liste (S&P 500 + ETF)
node scripts/build.mjs AAPL MSFT JPM   # sadece bu semboller (hızlı test)
LIMIT=25 node scripts/build.mjs        # ilk 25 sembol
```

Anahtar gerektirmez. `git add stocks.json cache/ && git commit` ile
yayınlanır; uygulama en geç 20 saat içinde çeker.

## Kapsamı genişletmek

`scripts/build.mjs` içindeki `loadUniverse()` şu an S&P 500 bileşen CSV'sini
kullanır. Russell 1000'e ya da tüm EDGAR şirketlerine çıkmak için orayı
değiştir ve `update.yml` cron'unu / `timeout-minutes` değerini ayarla. Cache
sayesinde ek yük ilk çalışmada bir defalıktır.
