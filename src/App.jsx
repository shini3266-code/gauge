import React, { useEffect, useMemo, useState, useCallback } from "react";
import Papa from "papaparse";
import { RefreshCw, TrendingUp, TrendingDown, ArrowDownCircle, CircleDot, ArrowUpCircle, Flag, AlertTriangle } from "lucide-react";

// ---------------------------------------------------------------------------
// Google Sheet 연동 설정
// ---------------------------------------------------------------------------
// 1) 구글 시트를 열고 파일 > 공유 > 웹에 게시(Publish to web) 를 선택합니다.
// 2) "링크" 탭에서 연동할 시트를 고르고, 형식을 CSV로 선택한 뒤 게시합니다.
// 3) 발급된 URL을 아래 .env 파일의 VITE_SHEET_CSV_URL 에 넣거나,
//    HARDCODED_SHEET_CSV_URL 상수에 직접 붙여넣으세요 (Vercel 환경변수 UI가
//    말썽이면 이 방법이 제일 확실합니다. 어차피 "웹에 게시"한 공개 링크라
//    번들에 그대로 들어가도 문제없습니다).
//
// 시트의 첫 번째 행(헤더)에는 아래 컬럼명 중 하나를 사용하면 됩니다 (대소문자 무관):
//   ticker, name, sector, bear, base, target, expiration
//   (price/prevClose는 이제 필수 아님 — 야후 파이낸스에서 자동으로 가져옵니다.
//    야후 조회가 실패할 때만 시트 값이 있으면 fallback으로 사용됩니다.)
//   (한글 헤더도 지원: 종목코드, 종목명, 섹터, 만기일)
const HARDCODED_SHEET_CSV_URL = "https://docs.google.com/spreadsheets/d/e/2PACX-1vQlUzBC5duSaGr7nI63OpO_Eo9OOM47iozDijimc124jayJHkAtyiOwqlSmYiw-QTh05ZkqOlZM1n-b/pub?gid=1451151836&single=true&output=csv"; // 필요하면 여기에 CSV 링크를 직접 붙여넣으세요 (한 줄로!)
const SHEET_CSV_URL = (import.meta.env.VITE_SHEET_CSV_URL || HARDCODED_SHEET_CSV_URL || "").trim();
const AUTO_REFRESH_MS = 5 * 60 * 1000; // 5분마다 자동 갱신 (시트 + 시세 둘 다)

// ---------------------------------------------------------------------------
// 샘플 데이터 - 구글 시트가 설정되지 않았거나 불러오기에 실패했을 때 fallback 으로 사용
// ---------------------------------------------------------------------------
const SAMPLE = [
  { ticker: "AAPL", name: "Apple Inc.", sector: "Mega Cap", price: 228.4, prevClose: 231.1, bear: 190, base: 220, target: 260, expiration: "2026-12-15" },
  { ticker: "NVDA", name: "NVIDIA Corp.", sector: "Semis", price: 118.2, prevClose: 116.9, bear: 95, base: 110, target: 150, expiration: "2026-09-30" },
  { ticker: "TSLA", name: "Tesla Inc.", sector: "Auto", price: 402.5, prevClose: 388.0, bear: 180, base: 260, target: 320, expiration: "2026-09-05" },
];

// ---------------------------------------------------------------------------
// 구글 시트 CSV 파싱
// ---------------------------------------------------------------------------
const HEADER_ALIASES = {
  ticker: ["ticker", "symbol", "종목코드", "티커"],
  name: ["name", "종목명", "이름"],
  sector: ["sector", "섹터", "분류"],
  price: ["price", "현재가", "가격"],
  prevClose: ["prevclose", "prev_close", "previousclose", "전일종가"],
  bear: ["bear"],
  base: ["base"],
  target: ["target"],
  expiration: ["expiration", "expiry", "만기일", "만료일"],
};

function normalizeHeader(h) {
  return String(h || "").trim().toLowerCase().replace(/[\s_]/g, "");
}

function buildHeaderMap(fields) {
  const map = {};
  fields.forEach((field) => {
    const normalized = normalizeHeader(field);
    for (const [key, aliases] of Object.entries(HEADER_ALIASES)) {
      if (aliases.some((a) => normalizeHeader(a) === normalized)) {
        map[key] = field;
      }
    }
  });
  return map;
}

function toNumber(value, fallback = 0) {
  if (value === undefined || value === null || value === "") return fallback;
  const n = parseFloat(String(value).replace(/[,$]/g, ""));
  return Number.isFinite(n) ? n : fallback;
}

function rowToItem(row, headerMap) {
  const ticker = row[headerMap.ticker];
  if (!ticker || !String(ticker).trim()) return null;

  return {
    ticker: String(ticker).trim().toUpperCase(),
    name: headerMap.name ? String(row[headerMap.name] || "").trim() : "",
    sector: headerMap.sector ? String(row[headerMap.sector] || "").trim() : "",
    price: toNumber(row[headerMap.price]),
    prevClose: toNumber(row[headerMap.prevClose], toNumber(row[headerMap.price])),
    bear: toNumber(row[headerMap.bear]),
    base: toNumber(row[headerMap.base]),
    target: toNumber(row[headerMap.target]),
    expiration: headerMap.expiration ? String(row[headerMap.expiration] || "").trim() : "",
  };
}

async function fetchSheetData(url) {
  const bustCache = url.includes("?") ? `${url}&_=${Date.now()}` : `${url}?_=${Date.now()}`;
  const res = await fetch(bustCache);
  if (!res.ok) throw new Error(`시트를 불러오지 못했습니다 (HTTP ${res.status})`);
  const csvText = await res.text();

  const parsed = Papa.parse(csvText, { header: true, skipEmptyLines: true });
  if (parsed.errors && parsed.errors.length > 0) {
    console.warn("CSV parse warnings:", parsed.errors);
  }

  const headerMap = buildHeaderMap(parsed.meta.fields || []);
  if (!headerMap.ticker || !headerMap.bear || !headerMap.base || !headerMap.target) {
    throw new Error("시트 헤더를 인식하지 못했습니다. ticker/bear/base/target 컬럼을 확인하세요.");
  }

  const items = parsed.data.map((row) => rowToItem(row, headerMap)).filter(Boolean);
  if (items.length === 0) throw new Error("시트에서 유효한 데이터를 찾지 못했습니다.");
  return items;
}

// ---------------------------------------------------------------------------
// 야후 파이낸스 실시간 시세 (Vercel 서버리스 함수 /api/quotes 경유)
// ---------------------------------------------------------------------------
async function fetchLiveQuotes(tickers) {
  if (!tickers || tickers.length === 0) return {};
  const url = `/api/quotes?tickers=${encodeURIComponent(tickers.join(","))}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`시세 조회 실패 (HTTP ${res.status})`);
  const data = await res.json();

  const map = {};
  (data.quotes || []).forEach((q) => {
    if (!q.error && typeof q.price === "number") {
      map[q.symbol] = { price: q.price, prevClose: q.prevClose ?? q.price };
    }
  });
  return map;
}

// ---------------------------------------------------------------------------
// 상태 판정 로직
// ---------------------------------------------------------------------------
function classify(price, bear, base, target) {
  if (price < bear) return "DOWN";
  if (price <= base) return "IN";
  if (price <= target) return "UP";
  return "HIT";
}

function bandScore(price, bear, base, target) {
  if (price >= base) {
    return (price - base) / (target - base || 1);
  }
  return (price - base) / (base - bear || 1);
}

function formatExpiration(expiration) {
  const target = new Date(expiration + "T00:00:00");
  if (Number.isNaN(target.getTime())) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const diffDays = Math.round((target - today) / 86400000);
  const dateLabel = `${target.getFullYear()}.${target.getMonth() + 1}.${target.getDate()}`;

  let dLabel;
  let tone; // "normal" | "warning" | "expired"
  if (diffDays > 7) {
    dLabel = `D-${diffDays}`;
    tone = "normal";
  } else if (diffDays > 0) {
    dLabel = `D-${diffDays}`;
    tone = "warning";
  } else if (diffDays === 0) {
    dLabel = "D-DAY";
    tone = "warning";
  } else {
    dLabel = `EXPIRED (D+${Math.abs(diffDays)})`;
    tone = "expired";
  }

  return { text: `until ${dateLabel} ${dLabel}`, tone };
}

const EXPIRATION_TONE_COLOR = {
  normal: "#6B7686",
  warning: "#E8D1A9",
  expired: "#EDB4B7",
};

const STATUS_STYLE = {
  DOWN: { color: "#EDB4B7", bg: "rgba(240,97,107,0.12)", label: "DOWN", Icon: ArrowDownCircle },
  IN: { color: "#ACBEE6", bg: "rgba(127,168,255,0.12)", label: "IN", Icon: CircleDot },
  UP: { color: "#E8D1A9", bg: "rgba(242,176,74,0.12)", label: "UP", Icon: ArrowUpCircle },
  HIT: { color: "#8FC9AD", bg: "rgba(79,216,151,0.12)", label: "HIT", Icon: Flag },
};

function gaugeRange(bear, base, target) {
  const span = target - bear;
  const pad = span * 0.15;
  return { min: bear - pad, max: target + pad };
}

function pct(value, min, max) {
  return Math.min(100, Math.max(0, ((value - min) / (max - min)) * 100));
}

// ---------------------------------------------------------------------------
// 상단 요약 카드
// ---------------------------------------------------------------------------
function SummaryHeader({ items }) {
  const counts = useMemo(() => {
    const c = { DOWN: 0, IN: 0, UP: 0, HIT: 0 };
    items.forEach((it) => (c[classify(it.price, it.bear, it.base, it.target)] += 1));
    return c;
  }, [items]);

  return (
    <div style={{ marginBottom: 18 }}>
      <div
        style={{
          background: "#10151D",
          border: "1px solid rgba(255,255,255,0.06)",
          borderRadius: 16,
          padding: "15px 20px",
          marginBottom: 10,
        }}
      >
        <div style={{ fontSize: 12, color: "#6B7686", letterSpacing: 1, fontWeight: 600 }}>TRACKED UNIVERSE</div>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginTop: 8 }}>
          <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 30, fontWeight: 700, color: "#E8ECF1" }}>
            {items.length}
          </span>
          <span style={{ fontSize: 14, color: "#8A93A3" }}>Stocks</span>
        </div>
        <div style={{ fontSize: 12, color: "#6B7686", marginTop: 2 }}>Consensus 시트 기준 모니터링 종목</div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        {Object.entries(counts).map(([key, count]) => {
          const style = STATUS_STYLE[key];
          const Icon = style.Icon;
          return (
            <div
              key={key}
              style={{
                background: "#10151D",
                border: "1px solid rgba(255,255,255,0.06)",
                borderRadius: 16,
                padding: "14px 18px",
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontSize: 11, color: "#6B7686", letterSpacing: 1, fontWeight: 600 }}>{key}</span>
                <div
                  style={{
                    width: 26,
                    height: 26,
                    borderRadius: "50%",
                    background: style.bg,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <Icon size={14} color={style.color} />
                </div>
              </div>
              <div
                style={{
                  fontFamily: "'JetBrains Mono', monospace",
                  fontSize: 22,
                  fontWeight: 700,
                  color: "#E8ECF1",
                  marginTop: 6,
                }}
              >
                {count}
              </div>
              <div style={{ fontSize: 11, color: "#6B7686", marginTop: 2 }}>Stocks</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 분포 차트
// ---------------------------------------------------------------------------
function DistributionChart({ items }) {
  const BIN_COUNT = 17;
  const MIN_SCORE = -2;
  const MAX_SCORE = 2;
  const binWidth = (MAX_SCORE - MIN_SCORE) / BIN_COUNT;

  const bins = useMemo(() => {
    const arr = Array.from({ length: BIN_COUNT }, () => []);
    items.forEach((it) => {
      const raw = bandScore(it.price, it.bear, it.base, it.target);
      const clamped = Math.max(MIN_SCORE, Math.min(MAX_SCORE - 0.001, raw));
      const idx = Math.floor((clamped - MIN_SCORE) / binWidth);
      arr[idx].push({ ...it, status: classify(it.price, it.bear, it.base, it.target) });
    });
    return arr;
  }, [items]);

  return (
    <div
      style={{
        background: "#10151D",
        border: "1px solid rgba(255,255,255,0.06)",
        borderRadius: 16,
        padding: "20px 20px 16px",
        marginBottom: 18,
      }}
    >
      <div style={{ fontSize: 17, fontWeight: 700, color: "#E8ECF1" }}>Distribution across the band</div>
      <div style={{ fontSize: 13, color: "#8A93A3", marginTop: 6, lineHeight: 1.5 }}>
        각 종목을 자신의 BEAR–BASE–TARGET 밴드 안에서의 상대 위치로 배치했습니다.
      </div>

      <div style={{ display: "flex", gap: 14, marginTop: 14, flexWrap: "wrap" }}>
        {Object.entries(STATUS_STYLE).map(([key, s]) => (
          <div key={key} style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ width: 8, height: 8, borderRadius: "50%", background: s.color, display: "inline-block" }} />
            <span style={{ fontSize: 12, color: "#8A93A3" }}>{key}</span>
          </div>
        ))}
      </div>

      <div style={{ display: "flex", alignItems: "flex-end", gap: 3, height: 200, marginTop: 22 }}>
        {bins.map((bin, i) => (
          <div key={i} style={{ flex: 1, display: "flex", flexDirection: "column-reverse", alignItems: "center", gap: 3 }}>
            {bin.map((it, j) => (
              <div
                key={j}
                title={it.ticker}
                style={{
                  width: 9,
                  height: 9,
                  borderRadius: "50%",
                  background: STATUS_STYLE[it.status].color,
                  opacity: 0.9,
                  flexShrink: 0,
                }}
              />
            ))}
          </div>
        ))}
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 10, fontSize: 10, color: "#6B7686", fontFamily: "'JetBrains Mono', monospace" }}>
        <span>-2.0</span>
        <span>-1.0</span>
        <span>BASE</span>
        <span>+1.0</span>
        <span>+2.0</span>
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 2, fontSize: 9, color: "#4A5261" }}>
        <span>BEAR 아래</span>
        <span></span>
        <span></span>
        <span></span>
        <span>TARGET 위</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 개별 게이지 카드
// ---------------------------------------------------------------------------
function GaugeBar({ price, bear, base, target }) {
  const { min, max } = gaugeRange(bear, base, target);
  const bearPct = pct(bear, min, max);
  const basePct = pct(base, min, max);
  const targetPct = pct(target, min, max);
  const markerPct = pct(price, min, max);
  const status = classify(price, bear, base, target);
  const markerColor = STATUS_STYLE[status].color;

  return (
    <div style={{ marginTop: 14 }}>
      <div
        style={{
          position: "relative",
          height: 8,
          borderRadius: 999,
          background: `linear-gradient(
            to right,
            #EDB4B7 0%,
            #EDB4B7 ${bearPct}%,
            #ACBEE6 ${bearPct}%,
            #ACBEE6 ${basePct}%,
            #E8D1A9 ${basePct}%,
            #E8D1A9 ${targetPct}%,
            #8FC9AD ${targetPct}%,
            #8FC9AD 100%
          )`,
          opacity: 0.9,
        }}
      >
        <div
          style={{
            position: "absolute",
            left: `calc(${markerPct}% - 7px)`,
            top: -4,
            width: 16,
            height: 16,
            borderRadius: "50%",
            background: "#0A0E14",
            border: `3px solid ${markerColor}`,
            boxShadow: `0 0 10px ${markerColor}88`,
          }}
        />
      </div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          marginTop: 8,
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: 11,
          color: "#6B7686",
          letterSpacing: 0.2,
        }}
      >
        <span>BEAR ${bear.toLocaleString()}</span>
        <span>BASE ${base.toLocaleString()}</span>
        <span>TGT ${target.toLocaleString()}</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 종목 카드 - 티커 아래에 만기 정보, 섹터/풀네임은 표시하지 않음
// ---------------------------------------------------------------------------
function Card({ item }) {
  const status = classify(item.price, item.bear, item.base, item.target);
  const style = STATUS_STYLE[status];
  const change = ((item.price - item.prevClose) / item.prevClose) * 100;
  const isUp = change >= 0;
  const exp = item.expiration ? formatExpiration(item.expiration) : null;

  return (
    <div
      style={{
        background: "#10151D",
        border: "1px solid rgba(255,255,255,0.06)",
        borderRadius: 16,
        padding: "15px 20px",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <span style={{ fontFamily: "'JetBrains Mono', monospace", fontWeight: 700, fontSize: 17, color: "#E8ECF1" }}>
            {item.ticker}
          </span>
          {exp && (
            <div
              style={{
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: 11,
                color: EXPIRATION_TONE_COLOR[exp.tone],
                marginTop: 5,
              }}
            >
              {exp.text}
            </div>
          )}
        </div>
        <div
          style={{
            background: style.bg,
            color: style.color,
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 11,
            fontWeight: 700,
            padding: "5px 10px",
            borderRadius: 999,
            letterSpacing: 0.5,
          }}
        >
          {style.label}
        </div>
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginTop: 14 }}>
        <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 20, fontWeight: 700, color: "#E8ECF1" }}>
          ${item.price.toLocaleString(undefined, { minimumFractionDigits: 2 })}
        </span>
        <span
          style={{
            display: "flex",
            alignItems: "center",
            gap: 4,
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 13,
            fontWeight: 600,
            color: isUp ? "#8FC9AD" : "#EDB4B7",
          }}
        >
          {isUp ? <TrendingUp size={14} /> : <TrendingDown size={14} />}
          {isUp ? "+" : ""}
          {change.toFixed(2)}%
        </span>
      </div>

      <GaugeBar price={item.price} bear={item.bear} base={item.base} target={item.target} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// 메인 대시보드
// ---------------------------------------------------------------------------
export default function Dashboard() {
  const [baseItems, setBaseItems] = useState(SAMPLE); // 시트(또는 샘플)에서 온 bear/base/target/expiration
  const [quoteMap, setQuoteMap] = useState({}); // ticker -> { price, prevClose } from Yahoo Finance
  const [spinning, setSpinning] = useState(false);
  const [sheetError, setSheetError] = useState(null);
  const [quoteError, setQuoteError] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);

  const loadData = useCallback(async () => {
    setSpinning(true);
    setSheetError(null);
    setQuoteError(null);

    let currentItems = baseItems;

    if (SHEET_CSV_URL) {
      try {
        currentItems = await fetchSheetData(SHEET_CSV_URL);
        setBaseItems(currentItems);
      } catch (e) {
        setSheetError(e.message || "시트를 불러오지 못했습니다.");
        // 시트 실패 시 이전에 갖고 있던 items 그대로 사용
      }
    }

    try {
      const tickers = currentItems.map((it) => it.ticker);
      const quotes = await fetchLiveQuotes(tickers);
      if (Object.keys(quotes).length === 0) {
        throw new Error("야후 파이낸스에서 시세를 받지 못했습니다.");
      }
      setQuoteMap(quotes);
    } catch (e) {
      setQuoteError(e.message || "실시간 시세를 불러오지 못했습니다.");
    }

    setLastUpdated(new Date());
    setTimeout(() => setSpinning(false), 600);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    loadData();
    const interval = setInterval(loadData, AUTO_REFRESH_MS);
    return () => clearInterval(interval);
  }, [loadData]);

  // 시트(bear/base/target 등)와 야후 실시간 시세(price/prevClose)를 합침.
  // 야후 조회가 실패한 종목은 시트에 값이 있으면 그걸로, 없으면 0으로 fallback.
  // 시트(bear/base/target 등)와 야후 실시간 시세(price/prevClose)를 합침.
  // 야후 조회가 실패한 종목은 시트에 값이 있으면 그걸로, 없으면 0으로 fallback.
  const items = useMemo(
    () =>
      baseItems
        .map((it) => {
          const live = quoteMap[it.ticker];
          return {
            ...it,
            price: live?.price ?? it.price ?? 0,
            prevClose: live?.prevClose ?? it.prevClose ?? it.price ?? 0,
          };
        })
        .sort((a, b) => {
          const da = a.expiration ? new Date(a.expiration).getTime() : Infinity;
          const db = b.expiration ? new Date(b.expiration).getTime() : Infinity;
          return da - db;
        }),
    [baseItems, quoteMap]
  );

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "#0A0E14",
        fontFamily: "Inter, system-ui, sans-serif",
        padding: "20px 16px 60px",
      }}
    >
      <div style={{ maxWidth: 480, margin: "0 auto" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div
              style={{
                width: 34,
                height: 34,
                borderRadius: 9,
                background: "#ACBEE6",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontWeight: 800,
                color: "#0A0E14",
              }}
            >
              T
            </div>
            <span style={{ color: "#E8ECF1", fontWeight: 600, fontSize: 10, letterSpacing: 0.3 }}>
              TARGETBOARD
            </span>
          </div>
          <button
            onClick={loadData}
            style={{
              width: 34,
              height: 34,
              borderRadius: "50%",
              border: "1px solid rgba(255,255,255,0.1)",
              background: "transparent",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: "pointer",
            }}
          >
            <RefreshCw
              size={16}
              color="#8A93A3"
              style={{ transition: "transform 0.6s", transform: spinning ? "rotate(360deg)" : "none" }}
            />
          </button>
        </div>

        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
          <span style={{ fontSize: 11, color: "#6B7686", fontFamily: "'JetBrains Mono', monospace" }}>
            {lastUpdated
              ? `Synced ${lastUpdated.toLocaleTimeString()}`
              : "Syncing..."}
            {!SHEET_CSV_URL && " · sample bands"}
          </span>
        </div>

        {(sheetError || quoteError) && (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 6,
              background: "rgba(240,97,107,0.1)",
              border: "1px solid rgba(240,97,107,0.3)",
              color: "#EDB4B7",
              borderRadius: 12,
              padding: "12px 14px",
              fontSize: 12,
              marginBottom: 16,
            }}
          >
            {sheetError && (
              <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
                <AlertTriangle size={14} style={{ marginTop: 1, flexShrink: 0 }} />
                <span>시트: {sheetError}</span>
              </div>
            )}
            {quoteError && (
              <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
                <AlertTriangle size={14} style={{ marginTop: 1, flexShrink: 0 }} />
                <span>시세: {quoteError} (시트/샘플 값으로 표시 중)</span>
              </div>
            )}
          </div>
        )}

        <SummaryHeader items={items} />
        <DistributionChart items={items} />

        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {items.map((item) => (
            <Card key={item.ticker} item={item} />
          ))}
        </div>
      </div>
    </div>
  );
}
