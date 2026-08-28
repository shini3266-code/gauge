# TargetBoard

Bear / Base / Target 밴드 기준으로 종목을 트래킹하는 대시보드입니다.
구글 스프레드시트를 데이터 소스로 연결해서 쓸 수 있고, Vercel/Netlify 등에 바로 배포할 수 있습니다.

## 1. 구글 시트 준비

시트에 아래와 같은 헤더로 데이터를 입력합니다 (열 순서는 상관없음, 대소문자 무관):

| ticker | name | sector | price | prevClose | bear | base | target | expiration |
|---|---|---|---|---|---|---|---|---|
| AAPL | Apple Inc. | Mega Cap | 228.4 | 231.1 | 190 | 220 | 260 | 2026-12-15 |

- `ticker`, `price`, `bear`, `base`, `target` 은 필수입니다.
- `expiration` 은 `YYYY-MM-DD` 형식이어야 D-day 계산이 정확합니다.
- 한글 헤더도 지원합니다: `종목코드`, `종목명`, `섹터`, `현재가`, `전일종가`, `만기일`

## 2. 시트를 CSV로 웹에 게시

1. 구글 시트 상단 메뉴에서 **파일 → 공유 → 웹에 게시** 클릭
2. "링크" 탭에서 데이터가 있는 시트(탭)를 선택
3. 형식을 **쉼표로 구분된 값(.csv)** 으로 선택 후 **게시** 클릭
4. 발급된 URL을 복사 (예: `https://docs.google.com/spreadsheets/d/e/2PACX-xxxx/pub?gid=0&single=true&output=csv`)

> 이 방식은 시트를 "보기 전용으로 웹에 공개"하는 것과 같습니다. 민감한 데이터라면 별도 API 키 기반 연동(Google Sheets API)으로 바꾸는 걸 권장합니다 — 필요하면 말씀해 주세요.

## 3. 로컬에서 실행

```bash
npm install
cp .env.example .env
# .env 파일을 열어 VITE_SHEET_CSV_URL 에 2번에서 복사한 URL을 붙여넣기
npm run dev
```

`.env` 를 비워두면 샘플 데이터로 동작합니다.

## 4. 배포

### Vercel (추천, 무료)

```bash
npm i -g vercel
vercel
```

배포 중 환경변수를 물어보지 않으면, Vercel 대시보드 → 프로젝트 → Settings → Environment Variables 에서
`VITE_SHEET_CSV_URL` 을 추가하고 다시 배포(`vercel --prod`)하세요.

### Netlify

```bash
npm i -g netlify-cli
netlify deploy --build
```

Site settings → Environment variables 에서 동일하게 `VITE_SHEET_CSV_URL` 을 추가합니다.

### 직접 빌드해서 아무 정적 호스팅에 올리기

```bash
npm run build
```

`dist/` 폴더가 생성되며, 이 폴더를 그대로 정적 호스팅(GitHub Pages, Cloudflare Pages 등)에 올리면 됩니다.
단, 빌드 시점에 `.env` 의 `VITE_SHEET_CSV_URL` 값이 번들에 포함되므로, 빌드 전에 `.env` 를 반드시 설정하세요.

## 5. 자동 갱신

시트가 연결되어 있으면 5분마다 자동으로 새로고침합니다 (`src/App.jsx` 의 `AUTO_REFRESH_MS` 값으로 조절 가능).
우측 상단 새로고침 버튼을 눌러 수동으로도 갱신할 수 있습니다.
