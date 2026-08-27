# 보안 · iOS 호환성 감사 보고서

- 대상: `obsidian-gdrive-personal-sync` (upstream `google-drive-merge-sync` v0.4.1, commit `2b4c27b`)
- 기준 문서: `AGENTS.md`, `PROJECT_BRIEF.md`
- 유형: **읽기 전용 감사**. 제품 코드·테스트·매니페스트 미수정. 실제 Google 계정 접촉 없음.
- 실행한 검증: `npm ci`, `npm run build`(tsc + esbuild), `npm test`(planner 16 + merge smoke + mock Drive 통합 12 assertions), `npx eslint src`, `npm audit`, git 히스토리 시크릿 스캔 — 전부 통과/무유출.

---

## 요약 (두괄식)

**현재 상태로 실기기에 붙이면 안 된다.** 빌드·테스트·lint는 전부 녹색이고 `drive.file` 스코프 자체는 올바르게 좁게 잡혀 있으나, **OAuth 루프백 플로우에 `state`·PKCE가 없고**, **원격 폴더가 사라지면 로컬 볼트 전체가 휴지통으로 들어가는 경로가 열려 있으며**, **텍스트 충돌 시 원격 내용이 아무 사본 없이 파기**된다. 이 세 가지는 `AGENTS.md`의 "Safety" 조항과 정면으로 충돌한다.

부차적으로 upstream의 공개 배포 정체성(플러그인 id, 후원 링크, 타인의 로컬 경로가 박힌 `deploy` 스크립트)이 그대로 남아 있어, 개인 포크 요건과 "사용자 볼트를 건드리지 않는다" 규칙을 위반할 소지가 있다.

| 심각도 | 건수 | 대표 항목 |
|---|---|---|
| Critical | 3 | OAuth code injection, 볼트 전체 로컬 삭제, 충돌 시 원격 내용 파기 |
| High | 5 | connection code 평문 자격증명, 재시도 시 Drive 중복 생성, 고아 워커 경합, 강제 preview 부재, disconnect 미정리 |
| Medium | 16 | 원격 유래 경로 무검증, 401/403 처리, 5MB 업로드 한도, resume 트리거 부재, 오류 격리 부재 외 |
| Low | 9 | listTree 순환 가드, 생성물 커밋, upstream 정체성 잔존 외 |

---

## Critical

### C-1. OAuth 루프백에 `state` 파라미터와 PKCE가 없다 — authorization code injection

- 근거: `src/auth.ts:105-116` (인가 URL 구성), `src/auth.ts:85-103` (루프백 핸들러), `src/drive.ts:54-89` (code 교환)
- 인가 요청 파라미터는 `client_id`, `redirect_uri`, `response_type`, `scope`, `access_type`, `prompt` 뿐이다. `state`도 `code_challenge`도 없다.
- 루프백 서버는 **경로·Origin·Referer를 일절 검사하지 않고**, `?code=` 쿼리를 실은 첫 요청을 그대로 성공으로 처리한다(`auth.ts:86-99`).
- 실패 시나리오: 사용자가 "Sign in with Google"을 누른 5분 창 동안, 브라우저에 열려 있는 임의의 악성 페이지(또는 같은 머신의 임의 프로세스)가 `http://127.0.0.1:<port>/?code=<공격자_code>`로 요청을 보내면 브라우저는 응답을 못 읽어도 **요청은 도달**한다. 포트는 랜덤이지만 범위가 좁아 스캔으로 탐색 가능하다. 플러그인은 공격자의 code를 교환해 **공격자 Google 계정의 refresh token**을 저장하고, 이후 모든 sync가 공격자 Drive로 볼트를 업로드한다.
- PKCE 부재는 별개 문제다. Google은 installed app에 대해 PKCE를 권고하며, PKCE가 없으면 루프백에서 가로챈 code를 client secret 보유자 누구나 상환할 수 있다. 그 client secret은 `data.json`과 connection code 안에 평문으로 존재한다(H-1 참조).
- 권고:
  1. 암호학적 난수 `state`를 생성해 인가 URL에 싣고, 루프백 핸들러에서 **정확히 일치할 때만** code를 수락. 불일치는 즉시 reject.
  2. `code_verifier`/`code_challenge`(S256) 추가, 토큰 교환에 `code_verifier` 동봉.
  3. 루프백 핸들러에서 경로를 고정(`/callback`)하고 그 외 경로는 204로 무시 — 브라우저 프리페치가 정상 로그인을 죽이는 문제(L-4)도 같이 해결된다.

### C-2. 원격 폴더가 사라지면 로컬 볼트 전체가 휴지통으로 들어간다 — 대량 삭제 가드 없음

- 근거: `src/planner.ts:75-85`(`l && !r` + `!localChanged` → `deleteLocal`), `src/main.ts:296-299`(`rootFolderId`가 있으면 폴더 존재 재확인 없음), `src/main.ts:527-533`(`deleteLocal` 실행)
- `rootFolderId`는 `data.json`에 영속된다. 그 폴더가 Drive에서 휴지통으로 이동되거나(하위 항목까지 trashed 처리됨) 접근 불가가 되면 `listTree`는 **빈 맵**을 반환한다.
- 그 순간 base에는 전체 파일 목록이 남아 있고 로컬 파일은 수정되지 않았으므로, 모든 경로가 `deleteLocal`로 계획된다. 실행되면 `fileManager.trashFile`로 **볼트 전체가 삭제**된다.
- 같은 함정의 두 번째 경로: `disconnect()`는 `base`를 비우지 않는다(H-5). 끊었다가 새 폴더로 다시 연결하면 remote는 비어 있고 base는 옛 목록이 남아 동일한 대량 `deleteLocal`이 발생한다.
- 되돌릴 수는 있으나(Obsidian 휴지통), iOS에서 수천 파일 휴지통 복구는 실질적 데이터 손실이다.
- 권고:
  1. 계획 실행 전 **삭제 비율 가드**: `deleteLocal` + `deleteRemote` 합계가 전체 대비 임계(예: 10% 또는 절대 20건)를 넘으면 자동 실행을 중단하고 명시적 확인을 요구.
  2. sync 시작 시 `rootFolderId`의 존재·`trashed=false`를 GET으로 확인하고, 실패하면 계획 자체를 중단.
  3. remote 목록이 비어 있는데 base가 비어 있지 않은 상태는 **무조건 비정상**으로 간주하고 중단.
  4. `disconnect()`에서 `base`와 base 사본 디렉터리를 함께 정리.

### C-3. 텍스트 충돌 시 원격 내용이 사본 없이 파기된다 — `AGENTS.md` Safety 조항 위반

- 근거: `src/merge.ts:379-395`(`composeSegments`의 기본 선택), `src/merge.ts:399-402`(`merge3`), `src/main.ts:584-596`(자동 병합·업로드)
- `merge3`는 `composeSegments(segments)`를 choices 없이 호출한다. `conflict:true` 세그먼트의 기본값은 `!seg.conflict` → **`mine`(로컬)** 이고, 원격 텍스트는 결과물에서 **완전히 제거**된다. 그 결과가 곧바로 원격에 업로드되므로(`main.ts:588-589` → `finishConflict`) 양쪽 모두에서 원격 버전이 사라진다. 사용자에게는 Notice 한 줄만 뜬다.
- `AGENTS.md`: "divergent edits are preserved. Never silently overwrite both-changed content." — 직접 위반이다. 바이너리 충돌은 conflict copy를 만드는데(`main.ts:610-616`) 텍스트는 만들지 않는 비대칭도 부자연스럽다.
- 증폭 요인: base 사본이 없으면 `readBaseCopy`가 `null` → `?? ""`로 **빈 base**를 쓴다(`main.ts:586`). 빈 base에서는 양쪽 전체가 서로 겹치는 삽입으로 취급되어 충돌 판정이 나고, 로컬이 통째로 이기고 원격이 통째로 버려진다. base 사본은 플러그인 폴더에만 있고 sync 대상이 아니므로 **connection code로 새로 붙인 iPhone의 첫 충돌에서 정확히 이 상황**이 된다.
- 권고:
  1. `conflict:true` 세그먼트가 하나라도 있으면 원격 버전을 `<name> (conflict <ts>).md`로 로컬에 저장한 뒤 병합본을 쓴다(바이너리 경로와 동일한 안전망).
  2. 또는 `<<<<<<< local` / `>>>>>>> drive` 마커를 남겨 사용자가 판정하게 한다.
  3. base 사본이 없는 경로는 자동 병합 대상에서 제외하고 사용자 확인으로 승격.

---

## High

### H-1. Connection code는 장기 자격증명 묶음의 평문 base64다

- 근거: `src/main.ts:175-186`(`exportConnectionCode`), `src/main.ts:188-210`(`importConnectionCode`), `src/main.ts:762-771`(클립보드 복사)
- 코드에는 `clientId`, **`clientSecret`**, `accessToken`, **`refreshToken`**, `rootFolderId`가 들어간다. base64는 인코딩이지 암호화가 아니다.
- 이 문자열은 `navigator.clipboard.writeText`로 시스템 클립보드에 올라간 뒤, 실사용에서는 메모·메신저·AirDrop 등 **암호화되지 않은 채널**로 iPhone에 옮겨진다. macOS↔iOS 유니버설 클립보드는 iCloud를 경유하는데, 이 프로젝트가 애초에 회피하려던 경로다.
- 만료 시각도, 무결성 검증도, 1회용 제한도 없다. 유출되면 취소 전까지 영구히 볼트 전체 읽기·쓰기 권한이다.
- import 쪽도 위험하다. `payload.tokens?.refreshToken`의 truthy 여부만 보고(`main.ts:196`) **확인 프롬프트 없이** 기존 자격증명과 `rootFolderId`를 덮어쓴다. 악의적 코드를 붙여넣게 만들면 sync 대상이 공격자 Drive 폴더로 바뀌고 볼트가 그쪽으로 업로드된다.
- 권고: WebCrypto(PBKDF2 + AES-GCM)로 사용자 지정 패스프레이즈 암호화, 발급 시각·만료(예: 10분) 포함, import 시 대상 폴더명과 계정을 보여주는 확인 단계 추가, 클립보드 대신 화면 표시(QR/수기 입력) 옵션 제공, 사용 후 클립보드 비우기.

### H-2. 재시도가 Drive에 중복 파일·폴더를 만든다 — `AGENTS.md` Engineering 조항 위반

- 근거: `src/drive.ts:117-146`(`call`의 무차별 재시도), `src/drive.ts:203-233`(`existingId` 없으면 POST 생성), `src/drive.ts:156-165`(`ensureFolder`의 POST)
- `AGENTS.md`: "Use file IDs for remote updates so Google Drive cannot create duplicate same-name siblings during retries." — 이 불변식은 **update 경로에만** 성립한다.
- `call()`은 메서드를 구분하지 않고 네트워크 예외·5xx·429·403에 대해 최대 4회 재시도한다. Drive가 create를 커밋한 뒤 응답이 유실되면 재시도가 **동일 이름의 두 번째 파일**을 만든다. Drive는 같은 부모 아래 동명 형제를 허용한다.
- `ensureFolder`도 같은 문제다. 중복 폴더가 생기면 `listTree`가 두 하위 트리를 같은 경로 접두사로 평탄화해 계획 자체가 오염된다.
- 권고: POST(create)는 재시도 전에 `name + parent`로 재조회해 커밋 여부를 확인한 뒤에만 재시도하거나, 재시도 대상에서 제외하고 상위에서 조회 후 결정하도록 분리.

### H-3. `Promise.all` 거부 후 남은 워커가 고아로 계속 실행된다

- 근거: `src/main.ts:360-372`(워커 풀), `src/main.ts:385-390`(catch), `src/main.ts:391-393`(`finally`에서 `syncing=false`)
- 워커 하나가 throw하면 `Promise.all`이 즉시 거부되지만 나머지 최대 3개 워커는 **취소되지 않고 계속** 큐를 소진한다. 그동안 상위에서는 catch가 실행되고 `finally`가 `this.syncing=false`로 락을 푼다.
- 결과: 사용자가 곧바로 다시 sync를 누르면 **두 개의 sync가 동시에** `this.base`를 변형하고 Drive에 쓴다. `base`는 단순 객체이고 어떤 잠금도 없다.
- 또한 고아 워커의 작업 결과는 `rebuildBase`·`persist`가 이미 건너뛰어진 뒤이므로 어디에도 기록되지 않는다.
- 권고: `AbortController` 또는 공유 `cancelled` 플래그로 워커 루프를 중단시키고, `Promise.allSettled`로 전원 종료를 기다린 뒤에만 `syncing`을 해제.

### H-4. 첫 sync가 preview 없이 즉시 실행된다 — `PROJECT_BRIEF` 수용 기준 3 미충족

- 근거: `src/main.ts:277-296`(`syncNow`가 곧바로 실행), `src/main.ts:322-336`(dry run은 별도 커맨드 인자), `src/main.ts:89-101`(리본·커맨드 모두 `syncNow()` 직결)
- "First sync is explicit and previewed"가 요구사항인데, preview는 사용자가 따로 실행해야 하는 **선택적** 커맨드다. 강제 게이트가 없다.
- 최악 시나리오는 이 프로젝트의 표준 워크플로우와 정확히 겹친다. connection code로 붙인 iPhone은 base가 비어 있고 볼트에는 이미 파일이 있다. `planner.ts:60-64`의 `l && r && !b` 규칙으로 **모든 동명 파일이 conflict**가 되고, 바이트가 다르면 C-3 경로를 타서 데스크톱 버전이 원격에서 파괴된다.
- dry run 출력 자체도 승인 UI로 부적합하다. Notice에 최대 30줄만 잘라 보여준다(`main.ts:322-334`).
- 권고: `base`가 비어 있거나 connection code import 직후의 첫 sync는 **무조건** 계획 모달을 띄우고 명시적 승인 후에만 실행. 계획 표시는 Notice가 아니라 스크롤 가능한 Modal로.

### H-5. `disconnect()`가 토큰을 revoke하지 않고 secret·base도 남긴다

- 근거: `src/main.ts:246-251`
- `tokens=null`, `rootFolderId=null`만 하고 `persist()`한다. `settings.clientSecret`은 `data.json`에 그대로 남고, refresh token은 로컬에서만 버려질 뿐 **Google 측에서 취소되지 않는다**. 이미 유출된 connection code는 계속 유효하다.
- `base`도 남아 C-2의 대량 삭제 경로를 연다. 플러그인 폴더의 base 사본(노트 전문)도 남는다.
- 권고: `https://oauth2.googleapis.com/revoke`로 refresh token 폐기, `clientSecret`·`base`·base 사본 디렉터리 삭제, 사용자에게 "Google 계정 권한 페이지에서도 해제" 안내.

---

## Medium

### M-1. 원격에서 유래한 경로를 전혀 검증하지 않는다

- 근거: `src/drive.ts:182-188`(Drive `name`을 그대로 이어붙여 path 생성), `src/main.ts:505-516`(그 path로 `createBinary`/`modifyBinary`), `src/main.ts:461-464`(`ensureLocalFolders`)
- Drive의 파일 이름은 임의 문자열이며 `/`와 `..`를 포함할 수 있다. `listTree`가 만든 경로는 아무 정규화·검증 없이 로컬 쓰기 경로가 된다. `normalizePath`는 구분자·유니코드 정규화와 슬래시 트리밍을 하지만 `..` 세그먼트를 해소하지 않는다.
- 실제 볼트 이탈 여부는 Obsidian 내부 가드에 달려 있어 이 감사에서 실행 확인은 못 했다(문서화되지 않은 동작). 그러나 **플러그인 쪽 방어가 0**이라는 사실 자체가 문제다. 최소한 이름에 `/`가 섞이면 경로 모델이 깨져 폴더/파일이 충돌한다.
- 권고: `listTree`에서 이름에 `/`, `\`, `..`, 제어문자, 선행 `.`이 있으면 건너뛰고 경고. 최종 경로가 루트 하위인지 문자열 수준에서 검증.

### M-2. 401 재인증 경로가 없고 403은 무차별 재시도한다

- 근거: `src/drive.ts:91-113`(만료 판단이 로컬 시계 `Date.now()`에만 의존), `src/drive.ts:136-141`
- 401은 재시도 목록에 없어 즉시 throw된다. 그런데 토큰 갱신 트리거는 로컬 시계뿐이라, 기기 시계가 앞서 있거나 refresh token이 취소되면 사용자는 원인 불명의 `Drive returned 401`만 본다. 재연결 유도도 없다.
- 반대로 403은 무조건 4회 재시도한다. Drive의 403은 `userRateLimitExceeded` 같은 일시적 사유와 `insufficientFilePermissions`·`storageQuotaExceeded` 같은 영구 사유를 함께 쓴다. 후자에서 약 7.5초를 낭비하고 진짜 원인을 가린다.
- `token()`은 `throw:false` 없이 호출되므로 `invalid_grant`가 `Request failed, status 400`으로 뭉개진다(`drive.ts:99-104`).
- 권고: 401 수신 시 강제 갱신 후 1회 재시도, 그래도 실패하면 "재연결 필요" 상태로 전환. 403은 응답 본문의 `reason`을 파싱해 rate limit 계열만 재시도. 토큰 갱신 실패 메시지를 별도로 해석.

### M-3. Google 네이티브 문서·바로가기를 일반 파일로 취급한다

- 근거: `src/drive.ts:182-188`(폴더가 아니면 전부 파일로 수집), `src/main.ts:307-315`(`md5Checksum` 없으면 `modifiedTime`을 rev로)
- 동기화 폴더 안에서 사용자가 Google Docs/Sheets를 만들면 `application/vnd.google-apps.document`가 목록에 잡힌다. 이런 항목은 `md5Checksum`이 없고 `alt=media` 다운로드가 불가(export 필요)라 `download()`가 실패하고 **sync 전체가 중단**된다(M-5). `modifiedTime`을 rev로 쓰므로 매 sync마다 변경으로 오인되기도 한다.
- 권고: `application/vnd.google-apps.` 접두 mime(폴더 제외)과 shortcut은 목록에서 제외하고 1회 알림.

### M-4. multipart 업로드 한도와 모바일 메모리

- 근거: `src/drive.ts:203-233`(항상 `uploadType=multipart`), `src/main.ts:36`(`TRANSFER_CONCURRENCY = 4`)
- Drive의 `uploadType=multipart`는 소용량 전용이며(대용량은 resumable 필요) 큰 첨부는 실패한다.
- 메모리도 문제다. `readBinary`로 전체를 읽고, multipart 본문용으로 다시 같은 크기의 `Uint8Array`를 만든다(`drive.ts:219-222`). 즉 파일당 최소 2배 버퍼가 동시에 4개까지 살아 있다. iOS WebView 메모리 한도에서 대용량 첨부 다수는 위험하다.
- 권고: 임계(예: 4MB) 초과 파일은 resumable 업로드로 분기하거나 명시적으로 건너뛰고 보고. 모바일에서는 동시성을 2로 낮추고 파일 크기 상한을 설정으로 노출.

### M-5. 액션 단위 오류 격리가 없다 — 파일 하나가 전체 sync를 중단시킨다

- 근거: `src/main.ts:356-372`(`execute` 호출에 개별 try/catch 없음), `src/main.ts:374-376`(`rebuildBase`/`persist`가 예외 시 건너뛰어짐)
- 어떤 파일 하나에서 예외가 나면 전체 sync가 catch로 빠지고, 그때까지 성공한 작업의 base 갱신이 **영속되지 않는다**(`persist()`가 실행되지 않음). "A partial run must be safe to repeat"라는 규칙은 형식적으로만 만족된다 — 반복은 안전하지만 매번 처음부터 다시 한다.
- 권고: 액션마다 try/catch로 감싸 실패 목록을 모으고 나머지는 계속 진행. 종료 시 실패 요약을 보고. base는 주기적 체크포인트 또는 `finally`에서 영속.

### M-6. resume·디바운스 편집 트리거가 없고 백그라운드 불가 고지도 없다

- 근거: `src/main.ts:108-117`(등록된 이벤트는 `layout-change`, `active-leaf-change`, `onLayoutReady`뿐), `src/main.ts:147-156`(`window.setInterval`), `src/main.ts:795-813`(설정 UI 문구)
- `AGENTS.md`는 "Sync on explicit command, app startup/resume, and debounced edits while Obsidian is active"를 요구한다. 현재 구현에는 **resume 리스너도 `vault.on("modify")` 디바운스도 없다**. 3가지 트리거 중 1개만 있다.
- iOS에서 앱이 백그라운드로 가면 WebView가 정지해 `setInterval`이 발화하지 않고, 복귀 시 밀린 실행에 대한 보정도 없다. 그런데 "Sync interval (minutes)" 슬라이더(최대 120분)와 설명 문구는 주기 동기화가 신뢰 가능한 것처럼 읽힌다. `PROJECT_BRIEF` 수용 기준 7의 "background guarantees are explicitly excluded"가 UI에 반영돼 있지 않다.
- 권고: `visibilitychange`/Obsidian resume 시점 sync 추가, `vault.on("modify")` 디바운스(예: 30초) 추가, 설정 설명에 "iOS에서는 앱이 활성일 때만 동작하며 백그라운드 동기화는 지원하지 않음"을 명시.

### M-7. base 사본의 슬러그 충돌과 삭제 후 잔존

- 근거: `src/main.ts:395-399`(`baseSlug`: `/`와 `\`를 `__`로 치환), `src/main.ts:418-424`(쓰기), `src/main.ts:527-540`(삭제 시 base 엔트리만 제거)
- `a/b.md`와 `a__b.md`가 **같은 슬러그**로 매핑된다. 병합 base가 서로 오염되어 잘못된 자동 병합을 낳는다.
- 길이 제한도 없다. 깊은 경로는 슬러그가 iOS 파일명 한도(255바이트)를 넘겨 쓰기가 실패하고, M-5에 의해 sync 전체가 중단된다.
- 삭제 시 base 사본 파일은 지워지지 않는다. **삭제한 노트의 본문 전문이 `.obsidian/plugins/<id>/base/`에 평문으로 무기한 남는다.** 개인 볼트 기준 실질적인 데이터 잔류 문제다.
- 권고: 슬러그를 경로의 해시(SHA-256 hex)로 대체. `deleteLocal`/`deleteRemote`/rename 시 사본을 정리. 주기적 고아 사본 GC.

### M-8. `ensureFolder`의 Drive 쿼리 이스케이프가 불완전하다

- 근거: `src/drive.ts:150-152`
- `name.replace(/'/g, "\\'")`는 작은따옴표만 처리하고 **백슬래시를 처리하지 않는다**. 이름이 `foo\`이면 결과 쿼리는 `name = 'foo\'`가 되어 닫는 따옴표가 이스케이프되고, 쿼리 문법 오류 또는 조건 주입이 된다. `driveFolderName`은 사용자 입력이고, 기본값은 `app.vault.getName()`이다.
- 권고: 백슬래시를 먼저 이스케이프한 뒤 작은따옴표를 처리(`replace(/\\/g,"\\\\").replace(/'/g,"\\'")`).

### M-9. 전송 무결성 검증이 없다

- 근거: `src/drive.ts:197-200`(다운로드 후 검증 없음), `src/main.ts:503-516`(그대로 로컬에 기록)
- Drive는 `md5Checksum`과 `size`를 제공하는데 다운로드 바이트와 대조하지 않는다. 잘린 응답이 그대로 로컬 노트를 덮어쓴다. 업로드도 반환된 `md5Checksum`을 저장만 하고 로컬 내용과 비교하지 않는다.
- 권고: 최소한 `size` 일치를 검사하고 불일치 시 해당 액션을 실패 처리. 가능하면 SHA 기반 자체 체크섬을 base에 병기.

### M-10. 기본 제외 목록이 비어 있다 — `AGENTS.md` Exclusions 미구현

- 근거: `src/main.ts:25-32`(`excludedFolders: []`), `src/main.ts:257-264`(`excluded()`는 폴더 접두사 매칭만)
- 요구된 제외 대상(인증 상태, `.obsidian/workspace*`, `.trash`, `.git`, raw 아카이브, 빌드 산출물, 시크릿 파일) 중 **기본으로 막히는 것이 하나도 없다**. `.obsidian` 등 dot 디렉터리는 `vault.getFiles()`가 색인하지 않아 결과적으로 업로드되지 않을 뿐이며, 이는 문서화되지 않은 Obsidian 내부 동작에 의존하는 **우연한 안전**이다.
- `excluded()`는 폴더 접두사만 표현할 수 있어 `.env`, `*.key` 같은 파일 패턴을 막을 수 없다.
- 권고: 하드코딩 deny-list(`.obsidian`, `.trash`, `.git`, `node_modules`, `data.json`)를 코드로 강제하고, glob 패턴 제외를 지원. 계획 단계에서 deny-list 위반 경로가 있으면 assert 실패시켜 회귀를 잡는다.

### M-11. 병합 엔진의 메모리 상한이 모바일 기준으로 과하다

- 근거: `src/merge.ts:111`(`LCS_GUARD = 9_000_000`), `src/merge.ts:41-42`(`Uint32Array((n+1)*width)`)
- 상한에서 DP 테이블 하나가 약 36MB다. 라인 단위 패스와 문자 단위 패스(`charMerge3`)가 각각 이 상한을 쓰며, 충돌 파일마다 반복된다. iOS WebView에서 OOM 위험이 실재한다.
- 권고: `Platform.isMobile`일 때 상한을 1/4 이하로 낮추고, 초과 시 자동 병합 대신 conflict copy 경로로 폴백.

### M-12. `serial` 계산이 O(n²)다

- 근거: `src/main.ts:338-342` — `actions.filter(a => !transfers.includes(a))`
- 액션 1만 건이면 약 1억 회 비교다. 대형 볼트 첫 sync를 폰에서 돌리면 UI가 멈춘다.
- 권고: `transfers`를 `Set`으로 만들고 `has`로 판정.

### M-13. 실행기(`main.ts`)에 테스트가 0건이다

- 근거: `test/` 전체 — `planner.test.mjs`(순수 계획), `drive.integration.mjs`(DriveClient), merge smoke 1건.
- 계획은 검증되지만 **계획을 실제 행동으로 옮기는 코드**(충돌 해소, base 사본, 경로 처리, 대량 삭제, 재시도 상호작용)는 한 줄도 테스트되지 않는다. `PROJECT_BRIEF` 수용 기준 5("deterministic tested behavior")가 절반만 충족된다.
- 권고: Obsidian Vault/adapter를 모킹해 `execute`/`resolveConflict`/`rebuildBase`를 mock Drive와 함께 돌리는 통합 테스트 추가. 특히 C-2·C-3 시나리오를 회귀 테스트로 고정.

### M-14. lint 게이트가 없다

- 근거: `package.json:6-11`(스크립트에 `lint` 없음), `.github/workflows/ci.yml:19-25`(build와 test만 실행)
- `AGENTS.md`는 "Required gates: typecheck, lint, unit tests, mock integration tests, production build, and an independent review"를 요구한다. eslint와 `eslint-plugin-obsidianmd`가 devDependency로 설치돼 있는데 **호출하는 곳이 없다**.
- 참고로 지금 수동 실행하면 통과한다: `npx eslint src` → 0 errors, 2 warnings(`main.ts:699` 선언형 설정 API 미채택, `wizard.ts:71` 문장형 대소문자).
- 권고: `"lint": "eslint src"` 스크립트 추가, CI에 단계 추가.

### M-15. `npm run deploy`가 타인의 절대 경로로 실제 볼트에 쓴다

- 근거: `package.json:10`
- `cp main.js manifest.json styles.css "/Users/simonaaimar/Desktop/Obsidian/vaults/AI SKILL/.obsidian/plugins/google-drive-merge-sync/"` — upstream 작성자의 macOS 사용자명과 볼트 경로가 그대로 남아 있다.
- 이 저장소에서는 경로가 없어 실패하지만, 스크립트의 의도 자체가 **실제 Obsidian 볼트를 수정**하는 것이고 이는 `AGENTS.md`의 "Do not modify the user's Obsidian vaults from this repository during development"와 충돌한다. 제3자의 로컬 디렉터리 구조도 불필요하게 노출한다.
- 권고: 개인 포크에서 해당 스크립트 삭제. 배포가 필요하면 환경변수로 대상 경로를 받고, 미설정 시 실패하도록 한다.

### M-16. 의존성 취약점 4건 (전부 transitive)

- 근거: `npm audit` 결과 — `brace-expansion`(high, DoS), `fast-uri`(high, host confusion), `js-yaml`(high, quadratic CPU), `esbuild`(moderate, dev server 요청 허용).
- 전부 빌드/린트 툴체인 경유이며 런타임 번들에 포함되지 않는다. 사용자 위험은 낮고 CI/개발 머신 위험이다.
- 권고: `npm audit fix` 적용 후 빌드·테스트 재확인. Dependabot 활성화.

---

## Low

- **L-1. `listTree`에 순환·깊이·크기 가드가 없다** (`src/drive.ts:171-193`). Drive의 다중 부모/shortcut 구성에서 재귀가 무한 루프에 빠질 수 있다. 방문한 folderId 집합과 최대 깊이를 두라.
- **L-2. `driveFolderName` 변경이 무시된다** (`src/main.ts:296-300`). `rootFolderId`가 이미 있으면 이름 설정을 다시 읽지 않는다. 설정을 바꿔도 아무 일이 없어 혼란스럽다. 변경 시 재해석 여부를 물어라.
- **L-3. `importConnectionCode`의 타입 검증이 부족하다** (`src/main.ts:190-203`). `clientId`/`clientSecret`가 `undefined`여도 그대로 대입된다. 스키마 검증을 추가하라.
- **L-4. 루프백 서버가 모든 경로를 소비한다** (`src/auth.ts:85-103`). 브라우저 프리페치나 다른 탭의 요청이 먼저 도달하면 `code` 없음으로 판정되어 정상 로그인이 실패한다. C-1의 경로 고정으로 함께 해결된다.
- **L-5. dry run 출력이 Notice에 30줄로 잘린다** (`src/main.ts:322-334`). 승인 UI로 부적합. Modal로 교체하라.
- **L-6. 자동 sync 중복 시 사용자에게 Notice가 뜬다** (`src/main.ts:278-281`). 인터벌 발화에서는 조용히 건너뛰어야 한다.
- **L-7. 생성물이 커밋돼 있다.** `test/drive.build.mjs`가 추적 중인데 `.gitignore`에는 `planner.build.mjs`/`merge.build.mjs`만 있다(중복 항목도 있음). `npm test`를 돌릴 때마다 diff가 더러워진다.
- **L-8. upstream 배포 정체성이 그대로다.** `manifest.json`의 `id`/`name`/`author`/`fundingUrl`, `README.md`의 후원 버튼·다운로드 배지·타인 이메일, `.github/workflows/release.yml`의 공개 릴리스 자동화가 개인 포크에 그대로 남아 있다. 특히 플러그인 `id`가 upstream과 동일해 같은 볼트에 upstream 사본이 있으면 **디렉터리가 충돌**한다. LICENSE와 저작자 표기는 `AGENTS.md` 지시대로 유지하되, `id`/`name`/`fundingUrl`/후원 문구는 개인 포크용으로 바꿔야 한다.
- **L-9. `rebuildBase`가 제외 목록을 적용하지 않는다** (`src/main.ts:466-479`). 제외 설정을 나중에 바꾸면 base에 유령 엔트리가 남는다.

---

## `PROJECT_BRIEF` 수용 기준 대조

| # | 기준 | 상태 | 근거 |
|---|---|---|---|
| 1 | `isDesktopOnly: false`, 런타임 Node/Electron 미사용 | ✅ | `manifest.json:12`; `auth.ts:37-41`의 `window.require`는 `Platform.isDesktopApp` 가드 뒤(`auth.ts:67-71`), esbuild가 builtin 외부화 |
| 2 | 사용자 소유 OAuth + `drive.file`, 자격증명 미커밋·미동기화 | ⚠️ | 스코프는 정확(`auth.ts:8`), 히스토리 시크릿 유출 없음. 다만 미동기화는 dot 디렉터리 미색인이라는 우연에 의존(M-10), connection code로 평문 유출 위험(H-1) |
| 3 | 첫 sync는 명시적이고 preview됨 | ❌ | preview가 선택적 별도 커맨드(H-4) |
| 4 | 이후 sync는 baseline 기반 변경분만 전송 | ✅ | `planner.ts:40-104`, base 영속 `main.ts:163-172` |
| 5 | upload/download/rename/delete/divergence 결정적·테스트됨 | ⚠️ | 계획은 16 테스트 통과, 실행기는 테스트 0(M-13). divergence 동작은 계약 위반(C-3) |
| 6 | 업데이트에 file ID, 삭제는 Trash | ⚠️ | update·delete는 충족(`drive.ts:224-231`, `249-255`). create 재시도가 중복 생성(H-2) |
| 7 | 시작/재개/수동 트리거, 백그라운드 보장 제외 명시 | ❌ | 시작·수동만 존재, resume·디바운스 없음. 백그라운드 미지원 고지도 없음(M-6) |
| 8 | 테스트에 실계정 불필요, 실계정 스모크는 전용 폴더로 게이팅 | ⚠️ | mock 기반 테스트는 충족. 게이팅된 실계정 스모크는 미존재이며, 대신 실제 볼트에 쓰는 `deploy` 스크립트가 있다(M-15) |
| 9 | `main.js` + `manifest.json` + `styles.css` 패키징 | ✅ | `release.yml:26-42`, 프로덕션 빌드 성공 확인 |

---

## 권고 처리 순서

1. **C-1** OAuth `state` + PKCE — 계정 탈취를 막는다. 실기기 연결 전 필수.
2. **C-2** 대량 삭제 가드 + 루트 폴더 생존 확인 — 볼트 전체 손실을 막는다.
3. **C-3** 텍스트 충돌 conflict copy — 원격 내용 파기를 막는다.
4. **H-4** 첫 sync 강제 preview — 위 두 개의 안전망 역할도 겸한다.
5. **H-1** connection code 암호화·만료·import 확인.
6. **H-2 / H-3 / H-5** 재시도 멱등성, 워커 취소, disconnect 정리.
7. **M-1 / M-5 / M-2** 경로 검증, 액션 단위 오류 격리, 401·403 처리.
8. **M-13 / M-14** 실행기 통합 테스트와 lint 게이트를 추가해 위 수정들을 회귀로 고정.
9. **M-15 / L-8** upstream 배포 정체성과 `deploy` 스크립트 정리.
10. 나머지 Medium/Low.

---

## 감사 방법 및 한계

- 정적 리뷰: `src/*.ts` 전량(2,612줄 중 소스 1,954줄), `test/*` 전량, `manifest.json`, `package.json`, `tsconfig.json`, `esbuild.config.mjs`, `eslint.config.mjs`, `.github/workflows/*`, `README.md`.
- 동적 검증(비파괴): `npm ci` → `npm run build` → `npm test` → `npx eslint src` → `npm audit`. 전부 로컬 mock 서버 대상이며 Google API에는 단 한 번도 접속하지 않았다.
- 시크릿 스캔: 작업 트리와 전체 커밋 21개에 대해 `GOCSPX-`, `ya29.`, `AIza…`, `*.apps.googleusercontent.com` 패턴 검색 → **유출 없음**. `src/wizard.ts:26`과 `test/mock-drive.mjs:45`의 매치는 각각 정규식 리터럴과 mock 상수다.
- 미검증 항목: Obsidian 모바일 실기기 동작, `normalizePath`의 `..` 처리에 대한 Obsidian 내부 가드(M-1), Drive API의 실제 응답 형태(모두 mock 기준). 실기기 스모크는 별도 게이팅된 작업으로 수행해야 한다.
