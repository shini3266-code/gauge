// Vercel Serverless Function
// GET /api/quotes?tickers=AAPL,NVDA,TSLA
//
// 야후 파이낸스는 공식 공개 API가 없어서, 야후 사이트가 내부적으로 쓰는
// 비공식 chart 엔드포인트를 서버(이 함수) 쪽에서 대신 호출합니다.
// 브라우저에서 직접 호출하면 CORS에 막히기 때문에 서버리스 함수를 중간에 둡니다.
//
// 참고: 비공식 엔드포인트라 야후 쪽 변경으로 언제든 깨질 수 있습니다.
// 실패하면 프론트엔드는 구글 시트에 입력된 price/prevClose 값으로 자동 대체됩니다.

export default async function handler(req, res) {
  const { tickers } = req.query;

  if (!tickers) {
    res.status(400).json({ error: "tickers query parameter is required" });
    return;
  }

  const symbols = String(tickers)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (symbols.length === 0) {
    res.status(400).json({ error: "no valid tickers provided" });
    return;
  }

  const quotes = await Promise.all(
    symbols.map(async (symbol) => {
      try {
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
          symbol
        )}?interval=1d&range=5d`;

        const response = await fetch(url, {
          headers: {
            // 야후는 기본 fetch User-Agent가 없으면 종종 차단합니다.
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
          },
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        const data = await response.json();
        const meta = data?.chart?.result?.[0]?.meta;

        if (!meta || typeof meta.regularMarketPrice !== "number") {
          throw new Error("unexpected response shape");
        }

        return {
          symbol,
          price: meta.regularMarketPrice,
          prevClose: meta.chartPreviousClose ?? meta.previousClose ?? null,
          currency: meta.currency ?? null,
          marketTime: meta.regularMarketTime ?? null,
        };
      } catch (err) {
        return { symbol, error: err.message || "fetch failed" };
      }
    })
  );

  // 60초 정도 CDN 캐시 (야후 쪽 과호출 방지 + 응답 속도 개선)
  res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=300");
  res.status(200).json({ quotes, fetchedAt: new Date().toISOString() });
}
