# 주간 업무 일지 데스크톱 편집기

inpleROUTINE(`routine.insilicogen.com`)의 **주간 업무 일지 > 금주에 진행할 업무**를
웹페이지에 들어가지 않고 데스크톱에서 바로 편집·저장하는 Electron 앱.

## 실행

```
npm install
npm start
```

첫 실행 시 로그인 창이 뜬다. 로그인하면 쿠키가 `persist:routine` 세션 파티션에
디스크로 저장되어 **재부팅 후에도 로그인이 유지**된다. 이후로는 로그인 창이 뜨지 않는다.

## 배포용 실행 파일

### Windows

```
npm run dist        # dist\routine-weekly-setup-1.2.0.exe (설치본)
                    # dist\routine-weekly-portable-1.2.0.exe (무설치 단일 exe)
npm run dist:dir    # dist\win-unpacked\RoutineWeekly.exe (설치 없이 폴더로만)
```

코드 서명은 하지 않으므로 처음 실행할 때 SmartScreen 경고가 뜬다.
**추가 정보 > 실행**으로 넘기면 된다.

설치본과 무설치본 모두 설정·로그인 쿠키를 `%APPDATA%\routine-weekly` 에
두므로 개발 중 `npm start` 로 띄운 것과 로그인 상태를 공유한다.

### macOS

**Mac 빌드는 Mac 에서만 만들 수 있다** (electron-builder 는 Windows 에서 `.app`/`.dmg` 를 못 만든다).
Mac 에서 저장소를 받아 아래를 실행한다.

```
npm install
npm run dist:mac      # dist/routine-weekly-1.1.0-mac-arm64.dmg  (Apple Silicon)
                      # dist/routine-weekly-1.1.0-mac-x64.dmg    (Intel)
                      # 같은 이름의 .zip 도 함께 생성
npm run dist:mac:dir  # dist/mac-arm64/RoutineWeekly.app (패키징 없이 .app 만)
```

서명·공증을 하지 않으므로(`identity: null`) 처음 열 때 Gatekeeper 가
"확인되지 않은 개발자" 또는 "손상되었음" 으로 막는다. 둘 중 하나로 넘긴다.

- Finder 에서 앱을 **우클릭 > 열기** 후 대화상자에서 **열기**
- 또는 터미널에서 `xattr -cr /Applications/RoutineWeekly.app`

설정·로그인 쿠키는 `~/Library/Application Support/routine-weekly` 에 저장된다.

macOS 에서 달라지는 점:

- 트레이 아이콘은 메뉴바에 템플릿 이미지(`src/renderer/trayTemplate.png`)로 뜬다
- 단축키는 `Ctrl` 대신 `⌘` (화면 표기도 자동으로 바뀐다)
- 창을 닫아도(⌘W) 메뉴바에 남고, Dock 아이콘 클릭이나 메뉴바 클릭으로 다시 연다. ⌘Q 는 종료
- "로그인 시 자동 실행" 은 macOS 로그인 항목에 등록되며, 자동 실행으로 뜬 경우 창을 숨긴 채 시작한다

### 릴리스 자동 빌드 (GitHub Actions)

Mac 빌드 머신이 없어도 된다. `.github/workflows/release.yml` 이 태그를 push 하면
macOS(arm64, x64)와 Windows 를 각각 GitHub 러너에서 빌드해 **Releases** 페이지에 첨부한다.

```
# 1) 버전 올리기 (package.json 의 version 과 태그가 같아야 한다. 다르면 워크플로가 실패한다)
npm version 1.2.0 --no-git-tag-version
git add -A && git commit -m "v1.2.0"

# 2) 태그 push -> 약 10분 뒤 Releases 에 dmg / zip / exe 가 올라온다
git tag v1.2.0
git push origin main --tags
```

- Mac 사용자에게는 Releases 페이지 링크를 주면 된다. Apple Silicon 은 `-mac-arm64.dmg`, Intel 은 `-mac-x64.dmg`
- 릴리스 본문에 Gatekeeper 우회 방법(우클릭 > 열기 / `xattr -cr`)이 자동으로 적힌다
- Actions 탭에서 **Run workflow** 로 수동 실행하면 릴리스 없이 빌드만 하고 아티팩트(14일 보관)로 남긴다.
  아티팩트는 GitHub 로그인이 필요하므로 배포용으로는 태그 릴리스를 쓴다
- 저장소가 private 이면 Releases 도 저장소 권한이 있는 사람만 받을 수 있다.
  **자동 업데이트도 마찬가지로 막힌다** (앱이 토큰 없이 latest.yml 을 못 받는다). 자동 업데이트를 쓰려면 저장소를 public 으로 두거나,
  private 을 유지해야 하면 별도의 public 릴리스 저장소나 사내 정적 서버(`provider: generic`)로 publish 설정을 바꿔야 한다

### 자동 업데이트 (electron-updater)

설치된 앱은 시작 15초 뒤와 이후 4시간마다 Releases 의 `latest.yml`(Windows) / `latest-mac.yml`(Mac) 을 읽어
새 버전이 있는지 본다. 판정은 **태그 버전 > 실행 중인 버전** 이므로 릴리스마다 `package.json` 버전을 꼭 올려야 한다.

| 환경 | 동작 |
| --- | --- |
| Windows 설치본 (`-setup.exe`) | 백그라운드 다운로드 → 앱 안 우측 하단 토스트 + 트레이 메뉴 (운영체제 알림은 쓰지 않음). "지금 재시작" 또는 다음 종료 때 조용히 설치 후 재실행 |
| Windows 무설치 (`-portable.exe`) | 실행 중인 exe 를 스스로 못 바꾸므로 토스트 안내 + Releases 페이지 열기만 |
| Mac (dmg/zip) | 코드 서명이 없어 Squirrel.Mac 이 설치를 거부하므로 토스트 안내 + Releases 페이지 열기만. Apple Developer 서명·공증을 붙이면 `src/updater.js` 의 `canInstall` 조건만 풀어 자동 설치로 바꿀 수 있다 |
| `npm start` (개발 실행) | 검사하지 않음 |

- 트레이 메뉴 **업데이트 확인…** 으로 바로 확인할 수 있고, 결과는 대화상자로 보여준다
- 검사 실패(오프라인 등)는 사용자에게 알리지 않고 `%APPDATA%\routine-weekly\update.log` (Mac: `~/Library/Application Support/routine-weekly/update.log`) 에만 남긴다
- 관련 파일: `src/updater.js` (검사/다운로드/상태), `src/main.js` (트레이 메뉴·대화상자·IPC), `src/renderer/renderer.js` 의 `renderUpdate` (우측 하단 토스트)
- 빌드 설정: `package.json` 의 `build.publish` (GitHub provider). 이 설정이 있어야 electron-builder 가 `latest*.yml` 과 앱 안의 `app-update.yml` 을 만든다.
  업로드는 워크플로의 release 잡이 하므로 빌드 자체는 `--publish never` 로 돈다
- 릴리스는 **draft 나 pre-release 가 아니어야** 앱이 인식한다 (워크플로가 만드는 릴리스는 기본이 정식 릴리스)

## 사용법

- 월~금 5칸에 그 날 진행할 업무를 줄 단위로 입력
- **들여쓰기 2칸 또는 Tab** = 하위 항목 (서버의 `children` 중첩에 대응)
- 각 칸 **오른쪽의 좁은 칸이 진행 상태**(`task_status`)다. 왼쪽 업무 줄과
  **같은 순서로 한 줄에 하나씩** 적는다. 비워 둘 줄은 그냥 빈 줄로 둔다
  (서버에는 `&nbsp;` 로 저장된다). `Ctrl+1` 진행중 · `Ctrl+2` 진행대기 ·
  `Ctrl+3` 완료 · `Ctrl+4` 작업대기 로 커서가 있는 줄을 덮어쓴다
- 좌우 칸은 줄바꿈 없이(`white-space: pre`) 그려지고 세로 스크롤이 같이 움직여서
  n번째 업무와 n번째 상태가 항상 같은 높이에 온다
- 출장·휴가는 결재에서 자동으로 들어오는 값이라 카드 위쪽에 칩으로 표시만 한다
- 다른 칸으로 포커스를 옮기거나 입력이 멎으면 **자동 저장**
- `Ctrl+S` = 변경된 요일 모두 저장
- 창을 다시 활성화하면 자동으로 다시 조회한다. 웹에서 값이 바뀌었는데
  로컬에 저장 안 된 수정본이 있으면 해당 칸이 **"웹에서 변경됨"** 으로 표시된다
- 창을 닫으면 트레이로 내려간다. 트레이 메뉴에서 항상 위 표시 / 시작 시 자동 실행 / 테마 / 종료
- **`Ctrl+Alt+R`** (Mac: `⌘+Alt+R`) 은 어느 프로그램에서든 앱을 앞으로 띄우고 **오늘 칸에 커서**를 둔다.
  이미 앞에 떠 있으면 트레이로 숨긴다. 다른 프로그램이 같은 조합을 쓰고 있으면 등록되지 않고 콘솔에만 남는다
- 서버가 내려주는 **이번 주 공지**(`notice.current_week_notice`)가 있으면 헤더 아래 한 줄로 보인다

### 연락처 QR (팀 보기)

팀 보기의 **연락처 QR** 버튼은 조직 현황(`/company/organstatus` 가 쓰는 `GET /api/organization`)의
구성원 이름·휴대전화·이메일·내선을 vCard(.vcf) 로 묶어 휴대폰 전화번호부에 한 번에 넣는 QR 을 띄운다.

- QR 한 장에 여러 명의 vCard 를 직접 담을 수는 없다 (용량 한계, 카메라 앱은 첫 사람만 읽음).
  그래서 앱이 이 PC 의 LAN 주소에 작은 HTTP 서버를 잠깐 열고 그 주소만 QR 에 담는다. **휴대폰이 같은 Wi-Fi 에 있어야 한다**
- 찍으면 안내 페이지가 열리고 **전체 연락처 저장** 버튼이 `contacts.vcf` 를 내려준다.
  iPhone 은 Safari 가 바로 "연락처 N개 모두 추가" 를 보여주고, Android 는 내려받은 파일을 열어 연락처 앱으로 가져온다
- 범위는 **내 부서**(응답 `organization_list[].department` 가 헤더의 부서 코드와 같은 사람, 대소문자 무시) 또는 **전 직원**.
  **본인은 항상 빠진다** (프로필 `username` 또는 주간 일지 `user_data.pk` 로 판별)
- 폰에 저장되는 이름은 `[인실리코젠] 부서 성명 직책님` (예: `[인실리코젠] BS 홍길동 주임님`, 직책이 없으면 `홍길동님`). 직책은 `sub_text`("직급 / 직무 / 부서") 의 첫 칸.
  슬래시는 음성 비서가 그대로 읽고 통화 화면 폭을 차지해서 넣지 않는다.
  그 외 회사 전화·이메일·회사(부서)·직함(직급 / 직무)·내선(메모) 이 함께 들어간다
- 주소에는 무작위 토큰이 붙고, **10분이 지나거나 창을 닫으면 서버가 바로 내려간다**. 개인 휴대전화가 LAN 에 노출되는 기능이므로 필요할 때만 열어 둔다
- 조직 현황 응답 모양은 `%APPDATA%\routine-weekly\last-archive-organization.json` 에 남는다. 구성원을 못 찾으면 이 파일을 본다
- 관련 파일: `src/contacts.js` (vCard·서버·QR), `src/api.js` 의 `getOrganization`, `src/renderer/renderer.js` 의 연락처 QR 절
- 상단 **팀** 탭은 부서 응답에 함께 오는 구성원 전체의 주간 업무를 **읽기 전용**으로 보여준다.
  왼쪽에서 사람을 고르고(파트별로 묶임), 주 이동과 부서 코드 변경은 그대로 쓸 수 있다. 마지막에 고른 사람은 기억한다
- **테마**는 트레이 메뉴에서 시스템 설정 따름 / 라이트 / 다크 중 고른다. 메인 프로세스가 `nativeTheme.themeSource` 를 바꾸면
  렌더러의 `prefers-color-scheme` 가 따라 바뀌어 CSS 토큰만 갈아끼운다 (`styles.css` 의 `@media (prefers-color-scheme: dark)`)

## 아카이브 프로젝트 로그 (archive.insilicogen.com)

상단 **로그** 탭에서 아카이브의 프로젝트 로그를 웹에 들어가지 않고 바로 등록한다.
조회/수정은 웹에서 하고, 앱은 "빠른 등록" 만 맡는다 (수정에는 편집 잠금 프로토콜이 있어 넣지 않았다).

- 처음 한 번 **아카이브 로그인** 버튼으로 로그인한다. routine 과 계정은 같지만 도메인이 달라
  쿠키가 따로 저장된다. 이후로는 다시 묻지 않는다
- **프로젝트** 칸은 즐겨찾기한 프로젝트가 목록으로 뜨고, 이름을 치면 서버에서 검색해 보탠다.
  마지막에 고른 프로젝트는 기억한다
- 일자/시간 기본값은 웹과 같다 (오늘, 현재 시각을 30분 단위로 내림 + 30분)
- 담당자는 프로젝트 기본 담당자가 선택돼 있고 바꿀 수 있다. 참여인원은 프로젝트 기본값이
  웹과 동일하게 자동으로 들어간다 (앱에서 편집하지 않음)
- 본문은 평문으로 적고 저장 시 Editor.js 블록으로 바뀐다:
  빈 줄 = 단락 구분, `- 항목` = 글머리 목록(Tab 으로 하위 단계), `1. 항목` = 번호 목록, `# 제목` = 소제목
- `Ctrl+Enter` = 로그 생성. 생성 후 본문/태그만 비워져 같은 프로젝트에 이어서 쓸 수 있다
- 트레이 메뉴 **아카이브 즐겨찾기** 에 즐겨찾기 프로젝트가 나열되고 클릭하면 브라우저로 연다.
  "새 로그 작성" 은 앱의 로그 탭을 바로 띄운다. 목록은 시작할 때와 로그 생성 후 갱신된다

### 아카이브 API

번들(`app.7c658073.js`, `2263.6abc133f.js`, `2335.5c00c3b2.js`) 분석으로 확인한 계약. 응답 형식은 routine 과 같다.
프로젝트 식별자는 pk 가 아니라 **이름 문자열**이다.

| 동작 | 요청 |
| --- | --- |
| 로그인 확인 | `GET /api/user/info` |
| 즐겨찾기 프로젝트 | `GET /api/project?is_bookmark=true&size=100&page=1` → `result.data[] { id, name, is_public, is_bookmark, manager_name }` |
| 프로젝트 검색 | `GET /api/project?search=&size=20` |
| 로그 입력 기본값 | `GET /api/project/log/input?project=<name>` → `result { managers[], groups[], manager{user}, member{group[],user[]} }` |
| 태그 검색 | `GET /api/common/tag?target=project&q=` |
| 로그 생성 | `POST /api/project/log` |

```json
{ "project": "<프로젝트 이름>", "is_presentation_mode": false,
  "started_at": "2026-09-02 14:00:00", "ended_at": "2026-09-02 14:30:00",
  "content": { "time": 0, "blocks": [ { "id": "…", "type": "paragraph", "data": { "text": "…" } } ], "version": "2.28.2" },
  "manager": { "user": 12 }, "member": [ { "group": [], "user": [3, 4] } ], "tag": ["분석"] }
```

아카이브 번들에는 토큰 갱신 호출이 없어(`/sso/login`, `/sso/logout` 만 있음) 만료되면 그냥 다시 로그인한다.

## 서버 API

번들(`app.f6976e4e.js`, `988.aedddd31.js`) 분석으로 확인한 계약.

| 동작 | 요청 |
| --- | --- |
| 조회 | `GET /api/weekly-task?start_date=&end_date=&department=` |
| 저장 | `POST /api/weekly-task` |

조회 범위는 원본 페이지와 동일하게 `(해당 주 월요일 - 7일) ~ (+6일)` 2주치다.

응답: `{ code, message, result }`

```
result.user_data.pk                          // 내 사용자 pk
result.weekly_task_logs_list[]               // 부서원별 행
  .user_pk, .name, .part, .department_identifier
  .current_week_task_log[]  { date, day, task_description, task_status,
                              task_default_business_trip, task_default_holiday }
  .previous_week_task_log[]
result.notice     { current_week_notice, current_week_start_date, ... }
result.key_event  { current_week_key_event[], previous_week_key_event[] }
```

저장 payload는 **한 요청에 한 필드**다. 원본 페이지도 좌/우 에디터가
`{ date, [_taskType]: getListStructure(html) }` 로 각각 POST 한다.

```json
{ "date": "2026-08-31", "task_description": [ { "text": "A 과제 분석" }, { "text": "B 과제", "children": [ { "text": "세부 항목" } ] } ] }
{ "date": "2026-08-31", "task_status": [ { "text": "완료" }, { "text": "&nbsp;" }, { "text": "진행중" } ] }
```

`task_description` 은 `children` 중첩 트리, `task_status` 는 **평면 목록**이다.
상태는 업무 내용을 문서 순서로 펼친 n번째 줄에 대응하고, 내용 없는 줄은 `&nbsp;`,
뒤쪽 빈 줄은 아예 보내지 않는다.

`text` 안에서 서버가 허용하는 태그는 `<a> <b> <strong> <i> <u> <br>` 뿐이며,
나머지는 원본 에디터의 `getListStructure()`가 제거한다.

## 인증

- **httpOnly 쿠키 기반 JWT**. `Authorization` 헤더를 쓰지 않는다
- CSRF: `csrftoken` 쿠키 값을 `X-CSRFToken` 헤더로 전송
- 만료(`code: 40101/40102` 또는 HTTP 401) 시 `GET /sso/token/refresh` 후 1회 재시도,
  그래도 실패하면 로그인 창을 다시 띄운다
- 아이디/비밀번호를 앱이 저장하지 않는다. 실제 로그인 페이지를 그대로 쓴다

## 파일 구성

```
src/main.js              메인 프로세스: 창/트레이/로그인 창/IPC
src/client.js            공용 HTTP 클라이언트 (쿠키/CSRF/토큰 갱신) - routine, archive 공용
src/api.js               routine 주간 업무 일지 API
src/archive.js           archive 프로젝트 로그 API (즐겨찾기/검색/입력값/생성)
src/logblocks.js         평문 -> Editor.js 블록 변환
src/tree.js              평문 <-> task_description 트리 / task_status 평면 목록 변환
src/settings.js          부서 코드/자동 실행 등 설정 저장
src/preload.js           contextBridge
src/renderer/            화면
build/icon.png           Windows 앱 아이콘 원본 (256x256)
build/icon-mac.png       macOS .icns 원본 (1024x1024)
src/renderer/icon.png    Windows 트레이 아이콘
src/renderer/trayTemplate.png, @2x   macOS 메뉴바 템플릿 아이콘 (16/32px)
```

## 문제 해결

"내 업무 행을 찾지 못했습니다"가 뜨면 부서 코드가 틀린 것이다.
헤더의 **부서** 칸을 바꿔보고, 실제 응답은 아래 파일에서 확인할 수 있다.

```
%APPDATA%\routine-weekly\last-response.json
```

## 주의

원본 웹페이지도 300ms 디바운스 자동 저장이다. 같은 요일을 웹과 앱에서
동시에 열어두고 편집하면 나중에 저장한 쪽이 덮어쓴다. 앱을 쓰는 동안에는
웹페이지를 닫아두는 편이 안전하다.
