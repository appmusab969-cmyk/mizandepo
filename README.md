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
   stocks.json (insan-okunur) + stocks.min.json (uygulamanın indirdiği) + .gz
        │  (günde 1 kez, cihaz başına — uygulamadaki StockRepository)
        ▼
   Mizan uygulaması  ── cihazda SharedPreferences cache + gömülü asset yedeği
```

- **Üçüncü bir tarama servisi KULLANILMAZ.** Ham SEC verisi çekilip
  `scripts/build.mjs` içindeki algoritmayla helal / şüpheli / uygun değil
  kararına dönüştürülür. Önceki `halalterminal.com` bağımlılığı kaldırıldı.
- **Uygulama API'yi hiç görmez.** Sadece bu repodaki `stocks.min.json`'u okur:
  `https://raw.githubusercontent.com/appmusab969-cmyk/mizandepo/main/stocks.min.json`
  (`http` paketi otomatik gzip ister; GitHub raw CDN'i sıkıştırılmış servis
  eder → tel üstünde ~450 KB). **Ölçek:** uygulama sadece bu statik dosyayı
  cihaz başına 20 saatte bir indirir; 10.000 kullanıcı ≈ 12.000 istek/gün,
  GitHub raw CDN'i için hiçbir yük değil.

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

## Hisse evreni — "en popüler ~1500 ABD hissesi"

`lib/universe.mjs` evreni kurar ve `universe-1500.json`'da tutar:

- **Çekirdek:** S&P 500 bileşenleri CSV'si (datasets/ aynası) — sektör adları
  buradan, hepsi kesin dahil.
- **Doldurma:** SEC `company_tickers.json`'daki (zaten indiriliyor) diğer tüm
  ABD borsa şirketleri, **halka açık dolaşım değerine** göre azalan sıralanır;
  1500'e kadar en büyükleri alınır. Bu değer SEC XBRL **frames API**'sinden
  gelir (`dei/EntityPublicFloat`, birkaç çeyreğin birleşimi) — şirket başına
  ayrı istek DEĞİL, çeyrek başına **tek istek** (~8 istek, ~1 dk).
- `universe-1500.json` **90 günde bir** yenilenir; aradaki haftalar bu sabit
  listeyi tam tarar (belirlenimci, gürültüsüz commit'ler). Elle yeniden
  sıralama: `RANK=1 node scripts/build.mjs` ya da workflow'un
  `workflow_dispatch` → `rank: true` girişi.
- Neden halka açık dolaşım değeri? "Popülerlik" için resmî SEC beyannamelerinden
  türetilebilen, manipüle edilemeyen bir ölçüt; işlem hacmi SEC'te yok, piyasa
  değeri ise şirket başına ayrı istek gerektirirdi.

## ETF'ler

`etf-whitelist.json` içindeki, bağımsız **Şeriat kuruluna** sahip ve **ABD
borsalarında işlem gören / ABD aracı kurumundan alınabilen** fonlar doğrudan
**helal** başlar (13 fon: SP Funds serisi — SPUS/SPSK/SPRE/SPWO/SPTE/SPEM/SPSC,
Wahed — HLAL/UMMA, MNZL, WSHR, Azzad — ADJEX/WISEX). Listede olmayan HER ETF
**şüpheli** işaretlenir (kurul onayı bizce doğrulanamadı).

> **UCITS / Londra listeli fonlar bilerek dışarıda** (ISDW, ISUS, IGDA, HSBC
> serisi vb.) — hedef kitle ABD borsası kullanıcıları, bu fonları Robinhood /
> Schwab / Fidelity'den alamaz. Dünyadaki ~40-50 "Şeriat ETF" rakamı bunları
> içerir; ABD'de gerçekten alınabilen ~13 tanedir.

### Otomatik portföy sağlık denetimi (`lib/fund-health.mjs`)

Beyaz listedeki bir fon zamanla bozulabilir (endeks metodolojisi değişir, kurul
gözden kaçırır). Her hafta build sırasında:

- Fonun en yeni N-PORT holdings'i, o turda taranan hisselerle eşleştirilir.
- **`nonHalal` pozisyonların toplam ağırlığı** hesaplanır.
- **> %5** ise fon otomatik **`doubtful`**'a düşer (`verdict: "breach"`),
  gerekçe kullanıcıya yazılır ve `fund-health-report.json`'a kaydedilir. O zaman
  fon **elle** beyaz listeden çıkarılıp yerine başkası eklenir.
- `nonHalal` + `doubtful` toplamı > %40 → `verdict: "watch"` (kurul onayı
  geçerli ama izlemede).
- Portföyün eşleşen kısmı < %15 ise (ABD dışı / sukuk, ticker yok) denetim
  yapılamaz (`assessed: false`) → kurul onayına güvenilir.
- Bir fonun whitelist kaydında **`skipHealthCheck`** alanı varsa denetim
  tamamen atlanır (`skipped: true`) ve hüküm yalnızca kurul onayına dayanır.
  Bu, **GYO fonu** (SPRE) gibi Mizan'ın hisse taramasının sektöre özel AAOIFI
  metodolojisiyle çeliştiği belgelenmiş durumlar içindir: GYO'ların sermaye
  yapısı gereği faizli borcu yüksektir, Mizan onları `borç / piyasa değeri <
  %30` ile ölçer ve tek tek "uygun değil" gösterir; oysa S&P Şeriat kurulu
  GYO'ları farklı tabanla (borç/toplam varlık, kira geliri ağırlığı) tarar.
  `skipHealthCheck` metni bu nedeni ve kullanıcının fondaki bir GYO'ya tek tek
  bakınca farklı sonuç görebileceğini açıklar; bu metin `whyNote`'a da eklenir.

Denetim yalnızca **aşağı** çeker; kurul onayı olmayan bir fonu asla "helal"
yapmaz.

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
Script `~2.5 istek/sn` gider (`lib/http.mjs` içinde `MIN_GAP_MS=400`, ortam
değişkeniyle ayarlanabilir). İki katmanlı cache limite takılmayı önler:

| Klasör | İçerik | Boyut | Git'te? |
|---|---|---|---|
| `cache/` | Ham SEC companyfacts + submissions yanıtları | ~2 GB+ | **Hayır** (`.gitignore`) — sadece yerel hız |
| `cache-slim/` | Çıkarılmış özet: SIC + `extractFinancials()` çıktısı | ~2 MB (1500 CIK) | **Evet** — workflow commit'ler |

- **Slim cache** her CIK için ~0.5 KB tutar. 20 günden yeni bir slim kaydı
  varsa o şirket için EDGAR'a **hiç gidilmez**. GitHub Actions bu klasörü
  commit'lediği için haftalık çalışma çoğunlukla buradan okur.
- Fiyat/quote (Yahoo) cache'i 1 gün, ticker listesi 1 gün, S&P 500 bileşen
  listesi 7 gün, XBRL float frames 90 gün, N-PORT 30 gün.
- Tam çalışma (~1500 hisse + 13 ETF): slim cache boşken ~60-90 dk (ilk hafta);
  slim cache doluyken ~15-25 dk (çoğu süre Yahoo fiyat çekmede). Yeniden
  sıralama (`RANK=1`) sadece ~1 dk ekler (8 frame isteği).

## Dosyalar

| Dosya | Ne işe yarar |
|---|---|
| `stocks.json` | İnsan-okunur liste (git diff için). Elle de düzenlenebilir. |
| `stocks.min.json` / `.gz` | Uygulamanın indirdiği boşluksuz sürüm — aynı içerik. |
| `etf-whitelist.json` | ABD-listeli, Şeriat kurulu onaylı ETF/fonlar (helal kabul edilenler). |
| `universe-1500.json` | ~1500 en büyük ABD hissesinin sembol listesi (90 günde bir yenilenir). |
| `fund-health-report.json` | Haftalık ETF portföy denetimi sonucu — bozulan / izlemedeki fonlar. |
| `scripts/build.mjs` | SEC'den çekip `stocks.json` üreten ana script. |
| `lib/http.mjs` | Hız sınırlayıcı + diske dayalı cache. |
| `lib/edgar.mjs` | SEC EDGAR + Yahoo erişimi, XBRL kalemi çıkarma, slim cache. |
| `lib/screen.mjs` | AAOIFI tarama algoritması (karar + Mizan skoru). |
| `lib/universe.mjs` | ~1500'lük hisse evrenini kurar / `universe-1500.json`'dan yükler. |
| `lib/fund-health.mjs` | ETF portföyünü N-PORT holdings + hisse taramasıyla otomatik denetler. |
| `cache-slim/` | Çıkarılmış özet cache (repoya commit'lenir). |
| `.github/workflows/update.yml` | Haftalık cron + elle tetikleme (`rank` girişiyle yeniden sıralama). |

## Çalıştırma

```bash
node scripts/build.mjs                 # tam liste (~1500 hisse + ETF)
node scripts/build.mjs AAPL MSFT JPM   # sadece bu semboller (hızlı test)
LIMIT=25 node scripts/build.mjs        # evrenin ilk 25 sembolü
RANK=1 node scripts/build.mjs          # universe-1500.json'ı yeniden sırala (pahalı)
UNIVERSE_SIZE=2000 RANK=1 node scripts/build.mjs   # hedef boyutu değiştir
```

Anahtar gerektirmez. Workflow şunları commit'ler: `stocks.json stocks.min.json
stocks.min.json.gz cache-slim/ universe-1500.json fund-health-report.json`.
Uygulama en geç 20 saat içinde çeker.

Tam çalıştırmadan sonra gömülü yedeği de eşitle:
`cp stocks.json ../assets/stocks.json` (test `assets/stocks.json`'un ayrıştığını
ve SPUS içerdiğini doğrular).

## Kapsamı genişletmek

Evren boyutu `UNIVERSE_SIZE` ortam değişkeniyle ayarlanır (varsayılan 1500).
`UNIVERSE_SIZE=2000 RANK=1 node scripts/build.mjs` ile yeniden sıralanır.
Artırırken şunlara dikkat:

- `update.yml` → `timeout-minutes` yeterli mi (soğuk tarama ~sembol başına
  1.5 sn; frames sıralaması sabit ~1 dk).
- Frames API'si ~5600 şirketi kapsıyor; 2000'in üstünde bazı küçük şirketler
  float beyanı vermediği için listeye giremeyebilir.
- `stocks.json` indirme boyutu — 1500'de ~3-4 MB; mobilde 5-10 MB pratik üst
  sınır. Gerekirse `screening` alt nesnesi sadeleştirilebilir.
- `lib/http.mjs` → `MIN_GAP_MS` SEC limitinin (10/sn) altında kalmalı.
- Küçük şirketlerde XBRL çoğu zaman eksik → daha fazla "şüpheli" (dini ilke
  gereği doğru davranış).
