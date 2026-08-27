# 최종 독립 검토 보고서 — 구현 후 회귀·보안·계약 대조

- 대상 커밋: `3e4f575` "feat: build private safety-first Drive sync" (직전 `2b4c27b`)
- 검토 범위: `AGENTS.md`, `PROJECT_BRIEF.md`, `reports/security-mobile-audit.md`, `reports/sync-correctness-audit.md`, 구현 diff 전체(32파일 / +2,148 −756), `src/*.ts` 9개 파일 1,954줄, `test/*` 전량, 패키징·CI·README
- 검토자 권한: 읽기 전용. 제품 코드·테스트·매니페스트 무수정. `reports/final-review.md` 1개 파일만 생성 (`AGENTS.md` Coordination 조항 준수)
- 검토 일자: 2026-08-27

---

## 결론 (두괄식)

**검토는 완료되었고, 초기 감사의 Critical 3건과 High 5건은 모두 코드 수준에서 닫혔다.** 문서화된 게이트 6종(`npm run check`)은 전부 통과한다(exit 0). 그러나 **실기기 스모크 테스트 전에 반드시 처리해야 할 blocking 3건**과 non-blocking 16건이 남아 있다.

Blocking 3건은 데이터 손실이나 보안 결함이 아니라 **"실제 볼트에서 반드시 실패하거나 사실상 사용 불가"** 유형이다.

| 구분 | 건수 | 요약 |
| --- | --- | --- |
| Blocking | 3 | 5MB 초과 파일 업로드 불가(가드 없음), 실행기 테스트 0건, 매 트리거마다 볼트 전량 재해시 |
| Non-blocking (High) | 2 | 흔한 노트 폴더명 무경고 제외, `.canvas`/`.json` 충돌 시 파일 구조 파괴 |
| Non-blocking (Medium) | 5 | fail-closed 복구 수단 부재, 자동 sync 무음 차단, 루프백 콜백 미테스트, 파일명 내 `/`, 클립보드 실패 |
| Non-blocking (Low) | 9 | 의존성 취약점(dev 전용), 삭제 게이트 비대칭, Notice 오표기 외 |

초기 감사에서 지적된 **`AGENTS.md`·`PROJECT_BRIEF` 위반 항목은 대부분 해소**되었다. 수용 기준 9개 중 7개 충족(✅), 2개 부분 충족(⚠️), **실패(❌) 0개** — 이전 감사의 ❌ 2건(첫 sync preview, resume 트리거)은 모두 닫혔다.

---

## 1. 문서화된 게이트 재실행 결과

`npm run check`를 그대로 재실행했다(`typecheck → lint → test:unit → test:integration → package → test:mobile`).

| 게이트 | 명령 | 결과 | 근거 |
| --- | --- | --- | --- |
| 타입체크 | `tsc -noEmit -skipLibCheck` | ✅ 통과 | 오류 0 |
| 린트 | `eslint src` | ✅ 통과 | `✖ 4 problems (0 errors, 4 warnings)` — 전부 obsidianmd 스타일 경고 |
| 유닛 (planner) | `node test/planner.test.mjs` | ✅ 통과 | `planner: 13 tests passed` + `planner extended: 19 total` |
| 유닛 (merge) | 인라인 smoke | ✅ 통과 | `merge: smoke passed` |
| 유닛 (conflict) | `node test/conflict.test.mjs` | ✅ 통과 | `conflict: missing baseline, true conflicts, and disjoint merge preservation passed` |
| 유닛 (safety) | `node test/safety.test.mjs` | ✅ 통과 | `safety: exclusions, approval gates, and destructive ordering passed` |
| 유닛 (connection) | `node test/connection.test.mjs` | ✅ 통과 | `connection: encrypted, expiring, refresh-only device transfer passed` |
| 유닛 (auth) | `node test/auth.test.mjs` | ✅ 통과 | `auth: cryptographic state and PKCE material passed` |
| mock 통합 | `node test/drive.integration.mjs` | ✅ 통과 | `drive integration: idempotency, retry, and file-ID assertions passed` (22개 assert) |
| 프로덕션 빌드 | `node esbuild.config.mjs production` | ✅ 통과 | `main.js` 82,539 bytes |
| 패키징 | `node scripts/package.mjs` | ✅ 통과 | `dist/owen-google-drive-sync (LICENSE, main.js, manifest.json, styles.css)` |
| 모바일 로드 | `node test/mobile-load.mjs` | ✅ 통과 | `mobile load: bundle loaded without Node or Electron runtime access` |
| **전체** | `npm run check` | **✅ EXIT=0** | |

추가로 실행한 비파괴 검증:

- **시크릿 스캔**: 추적 파일 전체 + 전체 커밋 히스토리에서 `GOCSPX-`, `ya29.`, `AIza…`, `1//…`, `*.apps.googleusercontent.com` 패턴 **0건**.
- **빌드 산출물 커밋 여부**: `git ls-files` 36개 항목에 `main.js`·`dist/`·`test/*.build.mjs` **없음** (`.gitignore:2,4-10,11`). 이전 감사 Low 지적 해소.
- **`npm audit`**: 전체 4건(moderate 1, high 3). **`npm audit --omit=dev` → 0건** (전부 devDependency transitive).
- **CSS 클래스 대조**: `src`에서 쓰는 `ogds-preview-warning`, `ogds-preview-list`, `dms-wizard-*`, `dms-ok` 모두 `styles.css`에 정의됨.
- **번들 내 Node 접근**: `main.js`의 `require(...)` 호출은 `require("obsidian")` 4건뿐. `window.require`는 `main.js:529` 1곳으로 `Platform.isDesktopApp` 가드 뒤(`auth.ts:88-92`).

---

## 2. Blocking findings

### B-1. multipart 업로드에 5MB 가드도 resumable 폴백도 없다 — 첨부파일 있는 볼트는 매번 sync 전체 실패

`drive.ts:349-414`의 `upload()`는 크기와 무관하게 항상 `uploadType=multipart`를 쓴다.

```
src/drive.ts:389  `${this.ep.upload}/files/${existingId}?uploadType=multipart&fields=id,md5Checksum`
src/drive.ts:390  `${this.ep.upload}/files?uploadType=multipart&fields=id,md5Checksum`
```

Google Drive v3에서 `uploadType=multipart`는 **5MB 이하 페이로드용**으로 문서화되어 있고, 초과 시 요청이 거부된다. 그런데 `src/` 전체에 크기 검사가 없다:

```
$ grep -rn "5 \* 1024\|5242880\|MAX_.*SIZE\|byteLength >\|size >" src/
NONE FOUND
$ grep -rn "uploadType=resumable" src/
no resumable upload
```

**실패 시나리오**: `owen-mobile` 볼트에 6MB짜리 PDF나 사진 첨부 1개가 있다. `uploadNew`가 이 파일에서 예외를 던진다 → `executeSnapshot`의 워커가 `firstFailure`를 세우고(`main.ts:498-516`) 전체 실행을 throw → `journal`이 남아 다음 sync는 승인 요구 상태로 진입 → 승인해도 같은 파일에서 같은 실패. **볼트가 영구적으로 동기화 불가 상태에 갇힌다.** 삭제 액션은 transfers 뒤에 있으므로 실행되지 않아 데이터 손실은 없지만(설계상 의도된 순서, `main.ts:518-519`), 제품이 동작하지 않는다.

또한 `upload()`는 `head + content + tail`을 담는 `Uint8Array`를 새로 할당하므로(`main.ts` 아님, `drive.ts:383-386`) 파일 크기의 **2배 메모리**를 순간 점유한다. iOS WKWebView에서 큰 첨부는 5MB 제한 이전에 메모리 압박을 일으킨다.

초기 감사 M-4가 지적한 항목이며 **미해결**이다. 최소한 (a) 5MB 초과 파일을 계획 단계에서 감지해 명시적 경고와 함께 스킵하거나, (b) resumable 업로드를 구현해야 한다.

### B-2. 실행기(`src/main.ts`, 1,208줄)에 자동화 테스트가 0건이다 — 볼트를 변경하는 코드 전부가 미검증

게이트는 통과하지만, 통과하는 테스트가 덮는 것은 **순수 모듈과 `DriveClient`뿐**이다.

| 테스트 파일 | 대상 |
| --- | --- |
| `test/planner.test.mjs` | `src/planner.ts` (순수 계획) |
| `test/conflict.test.mjs` | `src/conflict.ts` (순수 병합 래퍼) |
| `test/safety.test.mjs` | `src/safety.ts` (순수 판정) |
| `test/connection.test.mjs` | `src/connection.ts` (순수 암복호) |
| `test/auth.test.mjs` | `src/auth.ts`의 `createPkce()` 만 |
| `test/drive.integration.mjs` | `src/drive.ts` (mock 서버) |
| `test/mobile-load.mjs` | 번들 로드 가능성 |

`src/main.ts`를 대상으로 하는 테스트는 **하나도 없다**. 미검증 상태로 남은 것은 정확히 사용자의 볼트를 건드리는 로직이다:

- `execute()` (`main.ts:643-820`) — 9개 액션 종류의 실제 부작용
- `resolveConflict()` (`main.ts:824-894`) — 충돌 시 로컬 파일 덮어쓰기와 사본 생성
- `writeBaseCopy()` (`main.ts:570-600`) — temp→backup→rename 원자 쓰기와 실패 롤백 경로
- `readBaseCopy()`의 `.bak` 복구 경로 (`main.ts:549-559`)
- `rebuildBase()` (`main.ts:974-992`) — base 엔트리 정리와 기준 사본 삭제
- `journal` 기반 중단 후 재개 불변식 (`main.ts:465, 428, 445, 524`)
- `assertLocalSnapshot()` 펜스 (`main.ts:624-641`)
- 승인 게이트 자체 (`main.ts:364-370`)

`AGENTS.md` Engineering은 *"A partial run must be safe to repeat"* 를 요구한다. 코드를 읽어 추적한 결과 이 불변식은 **구조적으로는 성립한다**(중단 시 `journal`이 남아 다음 계획이 승인 필수가 되고, 계획은 항상 현재 상태에서 재구성된다). 그러나 **실행으로 증명된 바가 없다**. `PROJECT_BRIEF` 수용 기준 5의 "deterministic tested behavior"도 계획 단계에서만 증명된다.

초기 감사 M-13이 지적한 항목이며 **미해결**이다. 최소 3개 시나리오(부분 실패 후 재실행, 텍스트 충돌 양측 보존, 기준 사본 원자 쓰기 롤백)는 Obsidian `Vault`/`FileManager`/`adapter` mock 위에서 헤드리스로 검증 가능하다.

### B-3. 모든 트리거가 볼트 전체를 다시 읽고 SHA-256 해시한다 — 30초 디바운스와 결합되면 모바일에서 사실상 사용 불가

`preparePlan()`은 변경 여부와 무관하게 전 파일을 읽어 해시한다.

```
src/main.ts:396-405
    const local: Record<string, LocalEntry> = {};
    for (const file of this.app.vault.getFiles()) {
      if (this.excluded(file.path)) continue;
      const bytes = await this.app.vault.readBinary(file);   // 전량 읽기
      local[file.path] = { mtime, size, hash: await sha256Hex(bytes) };  // 전량 해시
    }
```

`base`에 이미 `localHash`·`localMtime`·`localSize`가 있는데도(`planner.ts:10-16`) mtime/size가 일치하는 파일을 건너뛰는 단축 경로가 없다.

이 함수는 다음 모든 경로에서 호출된다:

- 시작 후 3초 (`main.ts:150-154`)
- **앱이 보이게 될 때마다** (`main.ts:136-140`, `visibilitychange`)
- **모든 create/modify/delete/rename 후 30초 디바운스** (`main.ts:142-148, 182-191`)
- 수동 sync·dry run, 그리고 승인 후 재실행 시 한 번 더

즉 사용자가 노트를 편집하고 30초 멈출 때마다 볼트 전체가 디스크에서 읽히고 해시된다. 추가로 `assertLocalSnapshot()`이 업로드 액션마다 같은 파일을 **다시** 읽고 해시하며(`main.ts:636`, 업로드 1건당 최대 3회 호출: `main.ts:730, 734, 742`), `rebuildBase()`가 `listTree`를 한 번 더 돈다(`main.ts:977`).

수백 MB급 실제 볼트에서 iOS 기기의 배터리·응답성 관점으로 이는 실사용 불가 수준이다. 정확성 결함은 아니지만 **실기기 스모크 테스트가 의미 있는 결과를 내기 전에 해소되어야 한다.**

---

## 3. Non-blocking findings

### N-1 (High). 흔한 Obsidian 폴더명이 설정으로 되돌릴 수 없이, 무경고로 제외된다

`safety.ts:3-17`의 `BLOCKED_SEGMENTS`는 경로의 **모든 깊이**에서 대소문자 무시로 매칭된다(`safety.ts:30, 32`). 실측 결과:

```
EXCLUDED Archive/2024/note.md
EXCLUDED archives/note.md
EXCLUDED Build/spec.md
EXCLUDED Out/plan.md
EXCLUDED Raw/idea.md
EXCLUDED Dist/notes.md
EXCLUDED Coverage/report.md
EXCLUDED notes/Archive/a.md      <- 중첩된 깊이에서도 제외
synced   Projects/Output/x.md
```

`Archive/`는 Obsidian 볼트에서 매우 흔한 노트 폴더명이다. `isMandatoryExcluded`는 **설정에서 해제 불가**(`safety.ts:27` 주석이 명시)이고, `excluded()`가 로컬 수집·원격 수집·base 필터·`rebuildBase`에 모두 적용되므로(`main.ts:333, 393, 398, 410, 979, 987`) 해당 파일들은 **preview에도 나타나지 않는다**. 사용자는 자기 노트가 동기화되지 않는다는 사실을 알 방법이 없다.

`AGENTS.md`는 "raw archives, build outputs"를 제외하라고 했고 README:26도 "archive folders"를 명시하므로 **의도 자체는 계약에 부합**한다. 문제는 (a) 매칭이 모든 깊이·대소문자 무시로 과도하게 넓고, (b) 제외 사실이 사용자에게 전혀 보고되지 않는다는 점이다. preview에 "N개 파일이 필수 제외 규칙으로 생략됨" 요약 한 줄을 추가하는 것만으로 위험이 크게 낮아진다.

### N-2 (High). `.canvas`·`.json` 충돌 시 파일 안에 충돌 마커가 삽입되어 구조가 깨진다

`main.ts:82`의 `TEXT_EXTENSIONS`에 `json`과 `canvas`가 포함되어 있고, 충돌 시 `conflict.ts:19`가 파일 본문을 통째로 감싼다:

```
src/conflict.ts:19
    content: `<<<<<<< LOCAL\n${local}\n=======\n${remote}\n>>>>>>> GOOGLE DRIVE\n`,
```

`.canvas`는 JSON이므로 결과물은 **유효하지 않은 JSON**이 되고 Obsidian Canvas가 열지 못한다. 같은 내용이 Drive에도 업로드되므로(`main.ts:865-873`) 두 기기 모두에서 깨진다.

데이터는 보존된다(양쪽 원문이 마커 안에 그대로 있고 Drive 사본도 별도 생성됨) — `AGENTS.md` Safety 위반은 아니다. 그러나 사용자가 손으로 복구해야 하는 상태가 된다. `.canvas`/`.json`은 바이너리 경로(`main.ts:883-892`, 로컬본을 형제 사본으로 남기고 원격을 채택)로 처리하는 편이 안전하다.

### N-3 (Medium). fail-closed 가드에서 빠져나올 앱 내 수단이 없다

두 개의 안전 장치가 예외를 던져 sync를 완전히 막는다:

- `safety.ts:101-105` — baseline은 있는데 원격이 비었을 때 (`"Drive folder is unexpectedly empty…"`)
- `drive.ts:268-273` — root 폴더가 휴지통에 있거나 사라졌을 때 (`"The configured Drive sync folder is missing or in Drive Trash."`)

둘 다 대량 삭제를 막는 올바른 설계다. 그러나 사용자가 **의도적으로** Drive 폴더를 비웠거나 지운 경우, 이 상태에서 벗어날 커맨드가 없다. 유일한 출구는 설정의 Disconnect인데, 이는 `DriveClient.revokeToken`으로 **공유 refresh token을 revoke**해(`main.ts:288-297`) 같은 자격증명을 쓰는 **다른 모든 기기의 연결까지 끊는다**. "baseline 초기화 후 원격을 새로 채택" 같은 별도 커맨드가 필요하다.

### N-4 (Medium). 자동 트리거가 승인 요구 상태에 걸리면 아무 신호 없이 조용히 멈춘다

```
src/main.ts:366-370
      if (dryRun || approvalChanged || (snapshot.requiresApproval && !approvedFingerprint)) {
        this.setStatus("preview required");
        if (trigger === "manual") this.showPreview(snapshot);
        return;
      }
```

`trigger === "automatic"`이면 모달도 `Notice`도 뜨지 않는다. 상태 표시줄의 `Drive: preview required` 뿐이다. iOS Obsidian에서 상태 표시줄은 눈에 잘 띄지 않는다. 승인이 필요한 상황은 드물지 않다 — N-9에서 보듯 작은 볼트에서는 **삭제 1건만으로도** 걸린다. 사용자가 며칠간 동기화가 멈춘 줄 모를 수 있다.

### N-5 (Medium). C-1(OAuth code injection) 수정의 핵심 분기가 테스트되지 않는다

`test/auth.test.mjs`는 12줄이고 `createPkce()`의 무작위성·인코딩만 확인한다. 실제 보안 수정인 `startLoopbackAuth`의 콜백 핸들러(`auth.ts:108-145`)는 커버리지 0이다:

- `url.pathname !== "/callback"` → 204 (`auth.ts:110-114`)
- `settled` 재진입 차단 → 409 (`auth.ts:115-119`)
- `returnedState === pkce.state` 불일치 시 code 거부 (`auth.ts:123, 134-135`)

코드를 읽은 한 세 분기 모두 올바르다(state는 32바이트 CSPRNG, PKCE S256 `code_challenge`가 인가 요청에 포함됨 — `auth.ts:60-66, 155-158`). 그러나 회귀 방지 장치가 없다. `createServer`를 주입 가능하게 만들면 헤드리스로 검증할 수 있다.

### N-6 (Medium). Drive 파일명에 포함된 `/`가 경로 구분자로 흡수되며, README의 관련 주장이 사실과 다르다

`listTree`는 **합쳐진 경로**를 검증하지 실제 `f.name`을 검증하지 않는다:

```
src/drive.ts:314-315
          const path = prefix ? `${prefix}/${f.name}` : f.name;
          assertSafeRemotePath(path);
```

실측:

```
ACCEPTED "a/b.md"                 <- Drive 파일명이 "a/b.md"인 경우와 구분 불가
REJECTED "evil/../x.md" :: Unsafe Drive path segment
REJECTED "/x.md"        :: Unsafe Drive path
ACCEPTED "notes/sub dir/f.md"
```

**볼트 탈출은 없다** — 선행 `/`, `\`, `..`, 빈 세그먼트, 제어문자, 1024자 초과는 모두 거부된다(`safety.ts:46-57`, `test/safety.test.mjs:28-31`로 검증됨). 실제 영향은 `a/b.md`라는 이름의 Drive 파일이 로컬에 `a/` 폴더 + `b.md`로 생성되고, 실존하는 `a/` 폴더와 충돌할 수 있다는 정도다.

다만 **README:29의 "Remote paths containing traversal, separators inside a name, … stop the run"은 사실이 아니다.** `f.name`을 개별로 검증하거나 README 문구를 수정해야 한다.

### N-7 (Medium). 클립보드 쓰기가 실패하면 내보낸 연결 코드에 접근할 방법이 사라진다

```
src/main.ts:1076-1078
            this.code = code;
            await navigator.clipboard.writeText(code);
```

`this.code`는 내부 필드일 뿐이고 textarea의 표시값은 갱신되지 않는다(`main.ts:1061-1066`의 `onChange`는 사용자 입력 방향만 처리). iOS WKWebView에서 `navigator.clipboard`가 없거나 권한 오류를 내면 `catch`가 오류 `Notice`만 띄우고 코드는 어디에도 남지 않는다. `area.setValue(code)`로 textarea에 채운 뒤 클립보드를 시도하는 순서가 안전하다.

(내보내기는 주로 데스크톱에서 일어나므로 실제 노출은 제한적이다. 참고로 클립보드에 들어간 코드는 15분 만료 이후에도 클립보드에 남으며, 이는 README:37 "never saved by the plugin UI" 주장의 범위 밖이다 — 주장 자체는 정확하다.)

### N-8 (Low). dev 전용 의존성 취약점 4건이 남아 있다

```
$ npm audit          -> 4 vulnerabilities (1 moderate, 3 high)
$ npm audit --omit=dev -> found 0 vulnerabilities
```

`brace-expansion`(high, DoS), `fast-uri`(high), `js-yaml`(high), `esbuild`(moderate, dev 서버 CORS). **런타임 번들에는 영향이 없다**(플러그인은 의존성을 번들하지 않고 `obsidian`만 external). 3건은 비파괴 `npm audit fix`로 해소되고, `esbuild`만 major 업그레이드가 필요하다. 초기 감사 M-16 미해결.

### N-9 (Low). 삭제 안전 게이트가 볼트 크기에 대해 비대칭이다

`safety.ts:109-112`의 기준은 `deletes >= 20 || deletes / max(1, baseCount) > 0.1`이다. 실측:

```
baseCount=5,    1 delete  -> requiresApproval: true  ("1 deletes exceed the automatic safety limit.")
baseCount=1000, 19 deletes -> requiresApproval: false
```

작은 볼트에서는 정상적인 삭제 1건마다 승인을 요구해 사용자를 피로하게 만들고(N-4와 결합하면 자동 sync가 계속 조용히 멈춤), 큰 볼트에서는 19개 파일이 승인 없이 양쪽에서 삭제된다. 삭제는 양쪽 다 휴지통으로 가므로(`main.ts:793`, `drive.ts:436-443`) 복구 가능하고 `AGENTS.md` 위반은 아니다. 하한(예: `deletes >= 3`)을 두는 편이 낫다. 경고 문구의 `"1 deletes"` 복수형 오류도 함께.

### N-10 (Low). 충돌 없는 자동 병합도 "conflict preserved"로 집계된다

`main.ts:874`의 `onMerge()`가 무조건 호출되므로, `result.conflicts === 0`인 깨끗한 3-way 병합도 `conflictsPreserved`를 증가시킨다(`main.ts:489`). 결과적으로 최종 `Notice`(`main.ts:527-533`)가 실제 충돌이 없었던 파일까지 "N conflict(s) preserved"로 보고한다. 표기 오류일 뿐 동작에는 영향 없다.

### N-11 (Low). `.envrc`가 제외되지 않는데 README는 `.env*`라고 적었다

`safety.ts:37`은 `name === ".env" || name.startsWith(".env.")`만 검사한다. 실측에서 `.envrc`는 `synced`로 분류된다. README:27의 "`.env*`" 표기와 불일치한다. `direnv` 사용자가 볼트에 `.envrc`를 둘 가능성은 낮지만, 문서와 구현을 일치시켜야 한다.

### N-12 (Low). planner 테스트의 통과 개수 로그가 파일 중간에서 출력된다

`test/planner.test.mjs:129`가 `planner: ${count} tests passed`를 출력하는데, 그 **뒤에** 6개 테스트(`:131-209`)가 더 정의되어 있다. 실제 출력은 두 줄이다:

```
planner: 13 tests passed
planner extended: 19 total
```

테스트 자체는 전부 실행되고 실패 시 프로세스가 죽는다(`t()`가 재throw). 다만 이전 감사가 "planner 16 tests"로 기록했기 때문에, 첫 줄만 보면 커버리지가 줄어든 것처럼 오독된다. 로그 두 줄을 파일 끝의 한 줄로 합쳐야 한다.

### N-13 (Low). 도달 불가능한 방어 분기

```
src/main.ts:457-461
    const rootId = snapshot.rootId ?? (await drive.ensureFolder(folderName));
    await drive.verifyFolder(rootId);
    if (snapshot.rootId && snapshot.rootId !== rootId) {
      throw new Error("Drive folder changed after preview. Preview again.");
    }
```

`snapshot.rootId`가 truthy면 `rootId`는 정의상 그와 같은 값이므로 조건이 참이 될 수 없다. 무해하지만 실제 방어를 하지 않는다는 오해를 준다(실질적인 방어는 그 위의 `verifyFolder`와 `preparePlan`의 fingerprint 비교가 담당한다).

### N-14 (Low). ESLint 경고 4건 잔존

에러 0건으로 게이트는 통과한다. 내역: `main.ts:311`·`wizard.ts:71`·`wizard.ts:114` sentence-case, `main.ts:1102` `getSettingDefinitions()` 미구현(Obsidian 1.13+ 설정 검색 미노출). 마켓플레이스 게시 대상이 아니므로 영향은 제한적이다.

### N-15 (Low). Drive 쿼리 이스케이프가 두 경로에서 일관되지 않는다

`findChildren`은 `escapeQueryValue`로 `name`과 `parentId`를 모두 이스케이프하지만(`drive.ts:221-223`), `listTree`는 `folderId`를 그대로 보간한다(`drive.ts:305`). `folderId`는 Drive가 돌려준 값이라 실제 주입 가능성은 없으나, 두 경로 중 하나만 방어하는 형태는 잠재적 위험이다. 유사하게 `download`(`drive.ts:340`)와 `upload`/`move`/`trash`의 URL은 `fileId`를 `encodeURIComponent` 없이 삽입하는 반면 `metadata`(`drive.ts:278`)는 인코딩한다.

### N-16 (Low). 무결성 검증 비용이 API 호출 수를 크게 늘린다

`assertRevision`이 다운로드 전후로 각각 metadata GET을 하므로(`drive.ts:339, 344`) **파일 1개 다운로드에 API 호출 3회**가 든다. `upload`의 갱신 경로도 사전 `assertRevision` 1회를 더한다(`drive.ts:369`). 여기에 sync당 `listTree` 2회(계획 1회 + `rebuildBase` 1회)가 얹힌다. 정확성 측면에서는 옳은 설계(계획 이후 원격 변경을 확실히 잡는다)지만, 모바일 네트워크 지연과 Drive 쿼터 소모가 곱셈으로 늘어난다. B-3와 함께 성능 항목으로 묶어 검토할 것.

---

## 4. 초기 감사 지적사항 처리 현황

### Critical — 3/3 해소

| ID | 지적 | 상태 | 근거 |
| --- | --- | --- | --- |
| C-1 | OAuth 루프백에 `state`/PKCE 없음 | ✅ 해소 | `auth.ts:55-67` CSPRNG 32B state + 64B verifier + S256 challenge; `auth.ts:155-158` 인가 요청에 포함; `auth.ts:110` `/callback` 경로 검사; `auth.ts:115-119` 재진입 차단; `auth.ts:123,134` state 불일치 시 code 거부; `drive.ts:95` 토큰 교환에 `code_verifier` 전달. (테스트는 N-5 참조) |
| C-2 | 원격 폴더 소실 시 볼트 전체 삭제 | ✅ 해소 | `safety.ts:101-105` baseline 존재 + 원격 0건이면 예외; `main.ts:385` 매 계획마다 `verifyFolder(rootId)`로 root 재검증; `drive.ts:268-273` 휴지통/타입 확인; `main.ts:518-519` 삭제는 전송 성공 후 마지막에 실행; `test/safety.test.mjs:35-38` 검증 |
| C-3 | 텍스트 충돌 시 원격 내용 파기 | ✅ 해소 | `conflict.ts:14` base 없으면 무조건 충돌 처리; `conflict.ts:19` 양측 원문을 마커로 보존; `main.ts:861-863` Drive 사본 별도 생성; `main.ts:842-854` 바이트 동일 시 조용히 채택; `test/conflict.test.mjs:4-15` 검증 |

### High — 5/5 해소

| ID | 지적 | 상태 | 근거 |
| --- | --- | --- | --- |
| H-1 | connection code가 평문 base64 | ✅ 해소 | `connection.ts` 전면 재작성: PBKDF2-SHA256 210,000회 + AES-256-GCM + AAD, 15분 만료, 12자 이상 패스프레이즈 강제(`connection.ts:39-41`), access token 미포함(`connection.ts:127-133`). `test/connection.test.mjs:22,30-34`가 평문 노출·오패스프레이즈·만료를 검증 |
| H-2 | 재시도가 Drive 중복 생성 | ✅ 해소 | `drive.ts:170` POST 기본 `retry: "none"`; `drive.ts:241-266` 폴더 생성 실패 후 이름으로 재조회; `drive.ts:356-368, 399-411` 파일 생성 전후 조회 + 바이트 비교, 내용 다르면 예외; `test/drive.integration.mjs:35-41, 50-56`이 "커밋됐지만 응답 유실" 시나리오에서 중복 0건을 확인 |
| H-3 | `Promise.all` 거부 후 고아 워커 | ✅ 해소 | `main.ts:496-516` 공유 큐 + `firstFailure` 플래그 + `Promise.allSettled` 로 전 워커 drain 후 throw. `TRANSFER_CONCURRENCY = 1`(`main.ts:51`)로 동시성 자체를 제거 |
| H-4 | 첫 sync가 preview 없이 실행 | ✅ 해소 | `main.ts:389-390` firstSync 판정, `safety.ts:108,116` 무조건 승인 요구, `main.ts:364-370` fingerprint 승인 없이는 실행 차단. dry run이 폴더를 만들지 않음도 `test/drive.integration.mjs:23-25`로 확인 |
| H-5 | `disconnect()`가 revoke·정리 안 함 | ✅ 해소 | `main.ts:288-314` revoke 시도 + 토큰/root/base/identity/journal/clientId/clientSecret 전부 초기화 + `clearBaselineFiles()`; revoke 실패 시 수동 안내 `Notice` |

### Medium — 주요 항목

| ID | 지적 | 상태 | 근거 |
| --- | --- | --- | --- |
| M-1 | 원격 경로 무검증 | ✅ 해소 | `safety.ts:46-57` + `drive.ts:315` 호출; 단 N-6 잔여 |
| M-2 | 401 재인증 없음, 403 무차별 재시도 | ✅ 해소 | `drive.ts:190-195` 401 1회 강제 refresh; `drive.ts:196-205` `backendError`/`rateLimitExceeded`/`userRateLimitExceeded`만 재시도. `test/drive.integration.mjs:91-97`이 영구 403 미재시도를 확인 |
| M-3 | Google 네이티브 문서 처리 | ✅ 해소 | `drive.ts:318-319` `application/vnd.google-apps.*` 스킵(shortcut 포함) |
| M-4 | multipart 5MB 한도·모바일 메모리 | ❌ **미해결** | **B-1** |
| M-5 | 액션 단위 오류 격리 없음 | ⚠️ 설계상 유지 | 여전히 첫 실패에서 전체 중단. 다만 삭제를 마지막으로 미루고(`main.ts:518-519`) journal로 재개를 안전화해 위험은 낮아짐. B-1과 결합 시 영구 실패 유발 |
| M-6 | resume/디바운스 트리거·백그라운드 고지 없음 | ✅ 해소 | `main.ts:136-140` visibilitychange, `main.ts:142-148,182-191` 30초 디바운스, README:11-12·설정 설명(`main.ts:1182`)에 백그라운드 미지원 명시 |
| M-7 | base 사본 슬러그 충돌·잔존 | ✅ 해소 | `main.ts:540-543` 경로 SHA-256 슬러그(충돌 불가), `main.ts:602-615` 삭제 시 `.bak`·잔여 tmp 포함 정리, `main.ts:986-991` `rebuildBase`가 고아 사본 제거 |
| M-8 | Drive 쿼리 이스케이프 불완전 | ⚠️ 부분 | `drive.ts:54-56, 221-223` 추가됨. `listTree`는 미적용 — N-15 |
| M-9 | 전송 무결성 검증 없음 | ✅ 해소 | `drive.ts:287-293` rev 사전/사후 검증, `drive.ts:341-343` 다운로드 크기 검증, `main.ts:624-641` 로컬 스냅샷 해시 펜스 |
| M-10 | 기본 제외 목록 비어 있음 | ✅ 해소 (과잉) | `safety.ts:3-43` 필수 제외 구현. 다만 범위가 과도 — N-1, N-11 |
| M-13 | 실행기 테스트 0건 | ❌ **미해결** | **B-2** |
| M-14 | lint 게이트 없음 | ✅ 해소 | `package.json:9,15` `check`에 포함, `.github/workflows/ci.yml:21-22`가 CI에서 실행 |
| M-15 | `deploy`가 타인 절대경로 볼트에 씀 | ✅ 해소 | `package.json`에 `deploy` 스크립트 **없음**. `package`는 `dist/`에만 씀(`scripts/package.mjs:5,8-12`) — `AGENTS.md` "Do not modify the user's Obsidian vaults" 준수 |
| M-16 | 의존성 취약점 4건 | ❌ 미해결 | N-8 (단, 런타임 영향 없음 확인) |

### Low — 주요 항목

| 지적 | 상태 |
| --- | --- |
| `listTree` 순환 가드 | ✅ `drive.ts:298, 300-302` 깊이 64 제한 + `visited` 사이클 감지 |
| 생성물 커밋 | ✅ `.gitignore:2-11`, `git ls-files`에 `main.js`·`dist/`·`*.build.mjs` 없음 |
| upstream 정체성 잔존 (id 충돌) | ✅ `manifest.json:2` `owen-google-drive-sync`, `scripts/package.mjs:15-17`이 패키징 시 강제 검증 |
| 중복 경로 처리 | ✅ `drive.ts:321-323` 중복 path 예외, `drive.ts:230-235` 중복 형제 예외 |

---

## 5. `PROJECT_BRIEF` 수용 기준 대조

| # | 기준 | 상태 | 근거 |
| --- | --- | --- | --- |
| 1 | `isDesktopOnly: false`, Node/Electron 런타임 미사용 | ✅ | `manifest.json:8`; `test/mobile-load.mjs`가 VM에서 `obsidian` 외 `require` 0건으로 로드 성공을 증명; 번들의 `window.require`는 `Platform.isDesktopApp` 가드 뒤(`auth.ts:88-92`) |
| 2 | 사용자 소유 OAuth + `drive.file`, 자격증명 미커밋·미동기화 | ✅ | `auth.ts:8` 스코프; `safety.ts:28-43` + `main.ts:333`으로 `data.json`·configDir 하드 제외; 히스토리 시크릿 스캔 0건 |
| 3 | 첫 sync는 명시적이고 preview됨 | ✅ | `main.ts:364-370, 389-390`; `safety.ts:108,116`; preview가 Drive 폴더를 만들지 않음을 `test/drive.integration.mjs:23-25`가 확인. **이전 감사 ❌ → 해소** |
| 4 | 이후 sync는 baseline 기반 변경분만 전송 | ✅ | `planner.ts:66-74` (해시 우선, mtime/size 폴백), `main.ts:391` |
| 5 | upload/download/rename/delete/divergence 결정적·테스트됨 | ⚠️ | 계획은 결정적이고 19개 테스트로 검증; Drive 측은 mock 통합으로 검증. **볼트 측 실행기는 미테스트 — B-2** |
| 6 | 업데이트에 file ID, 삭제는 Drive Trash | ✅ | `drive.ts:388-394` file ID PATCH, `drive.ts:436-443` `trashed:true`, `main.ts:793` Obsidian 휴지통; 생성 재시도 중복 방지 `test/drive.integration.mjs:50-56`; 원격 rename 식별도 checksum → file ID로 교체(`planner.ts:172-195`) |
| 7 | 시작/재개/수동 트리거, 백그라운드 보장 제외 명시 | ✅ | `main.ts:136-154, 182-191`; README:11-12; 설정 설명 `main.ts:1181-1183`. **이전 감사 ❌ → 해소** |
| 8 | 테스트에 실계정 불필요, 실계정 스모크는 전용 폴더 게이팅 | ⚠️ | 모든 테스트가 mock/로컬 전용이며 네트워크 미접촉(`test/mock-drive.mjs`) ✅. 실제 볼트에 쓰던 `deploy` 스크립트 제거 ✅. 다만 **게이팅된 스모크 절차가 스크립트나 체크리스트로 존재하지 않고** README:46,61의 산문 안내뿐 |
| 9 | `main.js` + `manifest.json` + `styles.css` 패키징 | ✅ | `scripts/package.mjs:6,14-21`이 내용물을 강제 검증(+`LICENSE`); `dist/owen-google-drive-sync/`에 4개 파일 실재 확인 |

**합계: 충족 7, 부분 충족 2, 미충족 0.**

---

## 6. README 주장 검증

| README 위치 | 주장 | 판정 |
| --- | --- | --- |
| :5 | 볼트명이 `owen-mobile`이 아니면 sync 거부 | ✅ `safety.ts:59-65`, `main.ts:382`, `test/safety.test.mjs:26-27` |
| :11 | 수동 / 시작·재개 직후 / 30초 편집 디바운스에서만 실행 | ✅ `main.ts:114-126, 136-154, 182-191` |
| :13 | 첫 sync는 항상 읽기 전용 preview, 승인 전 Drive 폴더를 만들지 않음 | ✅ `main.ts:385-386`(`findFolder`만) vs `main.ts:457`(`ensureFolder`는 실행 시점), `test/drive.integration.mjs:23-25` |
| :15 | 원격 삭제는 Drive 휴지통, 로컬 삭제는 Obsidian 휴지통 | ✅ `drive.ts:436-443`, `main.ts:793` |
| :16 | 큰 삭제 계획은 재-preview 필요, 빈 원격 + baseline은 fail closed | ✅ `safety.ts:101-112` — 단 임계값 비대칭은 N-9 |
| :17 | 텍스트는 마커+Drive 사본으로 양측 보존, 바이너리는 로컬본을 사본으로 남기고 Drive가 정본 | ✅ `main.ts:856-894`, `conflict.ts:14-22` |
| :23-27 | 필수 제외 목록 | ⚠️ 대체로 정확. `.env*` 주장은 `.envrc`를 놓침(N-11). 목록이 실제 구현보다 **좁게** 읽힘 — `Archive`/`Build`/`Out`/`Coverage` 등 일반 폴더명까지 제외된다는 사실이 드러나지 않음(N-1) |
| :29 | 원격 경로의 traversal / **이름 내 구분자** / 제어문자 / 순환 / 중복 형제가 실행을 중단시킴 | ⚠️ traversal·제어문자·순환·중복은 ✅(`safety.ts:46-57`, `drive.ts:300-302, 321-323`). **"separators inside a name"은 거짓** — N-6 |
| :37 | 코드는 15분 만료, access token 미포함, UI가 저장하지 않음 | ✅ `connection.ts:5,69,110-111`, `connection.ts:127-133`, `main.ts:1093-1097` |
| :44 | 인가 요청이 `state`와 PKCE(S256) 사용, 모바일은 루프백 서버 미기동 | ✅ `auth.ts:88-92, 155-158` |
| :57 | `check`가 6개 게이트를 돌리고 패키지는 정확히 4개 파일 | ✅ 재실행으로 확인, `scripts/package.mjs:18-21`이 강제 |
| :65 | upstream 귀속과 MIT LICENSE 보존 | ✅ `LICENSE` 추적됨, 패키지에 포함(`scripts/package.mjs:6`) |

README는 전반적으로 코드와 일치한다. 수정이 필요한 곳은 **:29의 "separators inside a name"** 한 곳과, **:23-27 제외 목록의 범위 설명**이다.

---

## 7. `AGENTS.md` 계약 대조 (요약)

| 조항 | 판정 | 근거 |
| --- | --- | --- |
| upstream 귀속·`LICENSE` 보존 | ✅ | README:65, `LICENSE` 추적·패키징 |
| foreground only, iOS 백그라운드 미주장 | ✅ | README:12, `main.ts:1181-1183` |
| pull/plan before push, preview 제공 | ✅ | `main.ts:381-447` 계획 → `main.ts:455` 실행 분리 |
| 원격 삭제 Drive Trash / 로컬 삭제 Obsidian trash | ✅ | `drive.ts:436-443`, `main.ts:793` |
| **양측 변경 내용을 조용히 덮어쓰지 않음** | ✅ | `conflict.ts:14-22` + `main.ts:861-863, 883` — C-3 해소 |
| Exclusions (auth state, workspace*, .trash, .git, raw archives, build outputs, secrets) | ✅ (과잉) | `safety.ts:3-43`. `.obsidian/workspace-mobile.json`은 `workspace.json` 규칙이 아니라 configDir 규칙으로 걸린다(실측 확인) |
| 시크릿·토큰·Drive ID 미커밋 | ✅ | 전체 히스토리 스캔 0건 |
| 런타임에 Node/Electron API 미사용 | ✅ | `test/mobile-load.mjs` |
| 실제 Drive 변경은 사용자 소유 테스트 폴더 필요, 테스트는 mock 기본 | ✅ | `test/mock-drive.mjs`, 네트워크 미접촉 |
| 계획을 결정적·독립 테스트 가능하게 유지 | ✅ | `planner.ts` 순수 함수, 19 테스트 |
| **원격 업데이트에 file ID 사용** | ✅ | `drive.ts:388-394`; 생성 재시도 중복 방지까지 검증됨 |
| last-common baseline 영속, 상태·로컬 쓰기는 원자적/복구 가능 | ⚠️ | `main.ts:570-600` temp→backup→rename + 롤백 구현 ✅. 단 `saveData`(`data.json`)의 원자성은 Obsidian 구현에 위임되며 검증 안 됨. 롤백 경로 테스트 없음 — B-2 |
| **네트워크 재시도는 유한·멱등, 부분 실행은 반복 안전** | ⚠️ | 재시도 유한·멱등 ✅(`drive.ts:167-211`, 통합 테스트). 반복 안전성은 코드상 성립하나 미검증 — B-2 |
| 필수 게이트: typecheck, lint, unit, mock integration, production build, 독립 리뷰 | ✅ | 전부 재실행 통과 + 본 문서가 독립 리뷰 |
| 리뷰 워커는 `reports/` 아래에만 쓴다 | ✅ | 본 검토는 `reports/final-review.md` 1개만 생성 |
| 개발 중 사용자 볼트 미변경 | ✅ | `deploy` 스크립트 제거, `package`는 `dist/`만 |

---

## 8. 권고 처리 순서

1. **B-1** — 5MB 초과 파일 감지 후 명시적 스킵 + preview 경고, 또는 resumable 업로드 구현. (실기기 테스트 전 필수)
2. **B-3** — `preparePlan`에서 `base`의 mtime/size가 일치하면 저장된 `localHash`를 재사용해 전량 재해시를 회피. `assertLocalSnapshot`의 중복 해시도 1회로 축소.
3. **B-2** — Obsidian `Vault`/`FileManager`/`adapter` mock 위에서 실행기 테스트 최소 3종: (a) 부분 실패 후 재실행 안전성, (b) 텍스트 충돌 양측 보존, (c) `writeBaseCopy` 롤백.
4. **N-1** — preview에 "필수 제외로 생략된 N개" 요약 추가. `BLOCKED_SEGMENTS`를 볼트 루트 한정으로 좁힐지 결정.
5. **N-2** — `.canvas`/`.json`을 바이너리 충돌 경로로 이동.
6. **N-3 / N-4** — "baseline 초기화 후 원격 재채택" 커맨드 추가, 자동 트리거가 승인 요구에 걸리면 `Notice` 1회 발행.
7. **N-6 / N-11** — `f.name` 개별 검증 추가 또는 README:29·:27 문구 수정.
8. **N-5** — `createServer` 주입으로 루프백 콜백 3분기 테스트.
9. **N-8** — `npm audit fix`(비파괴)로 3건 해소, `esbuild` major는 별도 판단.
10. **N-7, N-9, N-10, N-12~N-16** — 정리 작업.

---

## 9. 검토 방법과 한계

**수행한 것**: `git show --stat 3e4f575` 기준 전체 diff 검토, `src/*.ts` 9개 파일 전량 정독, `test/*` 전량 정독, `npm run check` 전 게이트 재실행, `npm audit` 2회(전체/prod), 추적 파일 및 전체 커밋 히스토리 시크릿 스캔, `git ls-files` 인벤토리, 빌드 산출물 내 Node 접근 grep, CSS 클래스 대조, 그리고 `safety.ts` 빌드 산출물을 직접 실행한 경계값 프로빙(제외 규칙 12케이스, 원격 경로 4케이스, 충돌 사본 명명 2케이스, 삭제 게이트 2케이스).

**하지 않은 것 / 확인 불가**:

- **실제 iOS 기기 실행 검증 없음.** `crypto.subtle`의 secure-context 가용성, `navigator.clipboard` 동작, `document.visibilityState` 전이 타이밍, Obsidian iOS의 실제 휴지통 설정 반영, `vault.adapter.rename`/`rmdir`의 iOS 파일시스템 동작은 모두 미검증이다.
- **실제 Google Drive API 미접촉.** 모든 Drive 검증은 `test/mock-drive.mjs` 기준이다. 실제 응답 형태(`md5Checksum` 부재 케이스, 쿼터 응답, `Retry-After` 헤더)와의 호환성은 확인되지 않았다. B-1의 5MB 한도는 Google Drive v3 문서상의 `uploadType=multipart` 제약에 근거한 것이며 실측이 아니다.
- **`src/merge.ts`(402줄)는 이번 커밋에서 변경되지 않았고** 여전히 smoke 테스트 1건만 존재한다. LCS 기반 3-way 병합의 정확성은 이번 검토에서 재검증하지 않았다.
- **제품 코드 무수정.** 발견 사항의 수정은 구현 담당자 몫이다.
