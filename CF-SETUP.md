# Cloudflare 설정 정리

## 전체 구조

| 역할 | 서비스 | 도메인 |
|------|--------|--------|
| 프론트엔드 | Cloudflare Pages | `pull.acidblob.com` |
| 백엔드 API | Cloudflare Workers | `pull-up-api.acidblob.com` |
| 데이터베이스 | Cloudflare D1 | `pullup-map-db` |
| 이미지 저장소 | Cloudflare R2 | 버킷: `pullup-map-images` |

---

## 1회성 초기 설정 순서

### Step 1. 의존성 설치

```bash
cd backend
npm install
npx wrangler login
```

---

### Step 2. D1 데이터베이스

```bash
# 데이터베이스 생성
npx wrangler d1 create pullup-map-db
```

생성 후 출력된 `database_id`를 `wrangler.toml`의 `[[d1_databases]]` 항목에 입력.

스키마 적용:

```bash
npm run db:init:remote
```

스키마 재적용이 필요할 때:

```bash
npx wrangler d1 execute pullup-map-db --remote \
  --command="DROP TABLE IF EXISTS photos; DROP TABLE IF EXISTS tokens;"
npm run db:init:remote
```

---

### Step 3. R2 버킷 생성

```bash
npm run r2:create
```

Cloudflare 대시보드 → **R2** → `pullup-map-images` 버킷 → **Settings** → **Public access** → **Allow Access** 활성화.

활성화하면 `https://pub-XXXXXXXX.r2.dev` 형태의 URL이 생성됨.  
이 URL을 `wrangler.toml`의 `R2_PUBLIC_URL`에 입력:

```toml
[vars]
R2_PUBLIC_URL = "https://pub-XXXXXXXX.r2.dev"
```

---

### Step 4. 최초 관리자 토큰 등록

토큰은 D1에 저장됩니다. 최초 관리자 토큰은 wrangler CLI로 직접 삽입합니다:

```bash
cd backend
npx wrangler d1 execute pullup-map-db --remote \
  --command="INSERT INTO tokens (id, uid, token, role, name, status) VALUES ('$(python3 -c \"import uuid; print(uuid.uuid4())\")', '$(python3 -c \"import uuid; print(uuid.uuid4())\")', '여기에-관리자토큰-32자이상', 'admin', '홍길동', 'active')"
```

이후 추가 토큰(파워유저 등)은 앱 내 **토큰 관리** 패널에서 관리자가 직접 발급합니다.

---

### Step 5. Worker 배포

```bash
cd backend
npm run deploy
```

Cloudflare 대시보드 → **Workers & Pages** → `pullup-map-api` → **Settings** → **Triggers** → Custom Domains → `pull-up-api.acidblob.com` 추가.

DNS:

| Type | Name | Target | Proxy |
|------|------|--------|-------|
| CNAME | `pull-up-api` | `pullup-map-api.workers.dev` | ON |

---

### Step 6. 프론트엔드 배포

Cloudflare 대시보드 → **Workers & Pages** → **Create** → **Pages** → **Direct Upload** → 프로젝트 이름 `pullup-map`.

```bash
cd backend
npx wrangler pages deploy ../frontend --project-name pullup-map --commit-dirty=true
```

커스텀 도메인 추가:

| Type | Name | Target | Proxy |
|------|------|--------|-------|
| CNAME | `pull` | `pullup-map.pages.dev` | ON |

---

## 이후 배포 명령어

```bash
# 백엔드
cd backend && npm run deploy

# 프론트엔드
cd backend && npx wrangler pages deploy ../frontend --project-name pullup-map --commit-dirty=true
```

---

## 로컬 개발

```bash
cd backend
npx wrangler dev   # API: http://localhost:8787
```

`frontend/index.html`을 브라우저에서 직접 열면 `localhost:8787` API를 자동으로 바라봄.

---

## 관리자 기능 사용법

1. 앱 우상단 ⚙️ 버튼 → 토큰 입력 → 저장
2. 역할이 `관리자` 또는 `파워유저`로 표시되면 인증 성공
3. 📋 버튼이 나타남 → 대기 사진 승인/거절, 전체 사진 관리, 토큰 관리 가능
4. 관리자/파워유저가 올린 사진은 승인 없이 즉시 게시됨

---

## DB 스키마

```sql
CREATE TABLE tokens (
  id         TEXT PRIMARY KEY,
  uid        TEXT NOT NULL UNIQUE,
  token      TEXT UNIQUE,          -- NULL until user activates
  role       TEXT NOT NULL CHECK(role IN ('admin', 'power')),
  name       TEXT NOT NULL DEFAULT '',
  status     TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'active')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE photos (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  uid            TEXT NOT NULL,         -- 사용자 UUID (localStorage)
  lat            REAL NOT NULL,
  lng            REAL NOT NULL,
  image_key      TEXT NOT NULL,         -- R2 오브젝트 키 (photos/uuid.jpg)
  status         TEXT NOT NULL DEFAULT 'pending',  -- pending | approved | rejected
  name           TEXT NOT NULL DEFAULT '',
  uploader_role  TEXT NOT NULL DEFAULT 'user',
  taken_at       TEXT,                  -- EXIF 촬영일 (없으면 NULL)
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  reject_reason  TEXT
);
```

---

## API 엔드포인트

| Method | Path | 설명 | 권한 |
|--------|------|------|------|
| `GET` | `/me` | 내 역할 조회 / 토큰 활성화 | 모두 |
| `POST` | `/photos` | 사진 업로드 | 모두 (일반: 하루 3개) |
| `GET` | `/photos?minLat=&maxLat=&minLng=&maxLng=` | 지도 범위 내 사진 | 모두 |
| `GET` | `/photos?includePending=1` | 대기 중 포함 | admin/power |
| `GET` | `/photos/pending` | 전체 대기 목록 | admin/power |
| `POST` | `/photos/:id/approve` | 승인 | admin/power |
| `POST` | `/photos/:id/reject` | 거절 (사유 포함) | admin/power |
| `POST` | `/photos/:id/move` | 핀 위치 수정 | admin/power |
| `DELETE` | `/photos/:id` | 삭제 (R2 포함) | 본인 or admin/power |
| `GET` | `/admin/photos` | 전체 사진 목록 (페이지네이션) | admin/power |
| `POST` | `/users/:uid/promote` | 파워유저 등업 | admin |
| `GET` | `/tokens` | 토큰 목록 | admin |
| `DELETE` | `/tokens/:id` | 토큰 삭제 | admin |
