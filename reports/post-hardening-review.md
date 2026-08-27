# 하드닝 이후 최종 검증 보고서 (post-hardening review)

- 대상 커밋: `66f0be3` "fix: harden mobile Drive sync" (기준: `3e4f575`, 검토 입력: `reports/final-review.md`, `reports/hardening.md`)
- 검토자 권한: 읽기 전용. 제품 코드·테스트·매니페스트 무수정. 본 문서 1개만 생성.
- 검토 일자: 2026-08-27

---

## 결론 (두괄식)

**Ship — 코드 수준 blocking 잔여 없음.** `final-review.md`의 blocking 3건(B-1/B-2/B-3)은 모두 실제 코드로 수정되었고, 각각 회귀 테스트가 하드닝 diff에 포함되어 실제로 실행·통과함을 재확인했다. non-blocking 16건 중 13건도 닫혔다. 모든 게이트(`npm run check`, `npm audit`, 패키지 내용, 모바일 로드, `git diff --check`, 시크릿 스캔)를 본 검토에서 독립 재실행했고 전부 통과했다. 하드닝 diff 자체에서 새로운 데이터 손실·보안·iOS 런타임 회귀는 발견하지 못했다.

단, "ship"의 의미는 **README의 Authorized real-device smoke checklist 실행 단계로 넘어가도 된다**는 것이다. 실기기·실계정 검증은 여전히 미수행이며(하드닝 보고서가 스스로 명시), 그 경계는 이 커밋으로 해소될 수 없는 권한 문제다.

---

## 1. 이전 blocking 3건 검증

### B-1. 대용량/resumable 업로드 — ✅ 해소 확인

- `src/drive.ts`: 5 MiB(`MULTIPART_LIMIT`) 초과 시 `uploadResumable()`로 분기. 4 MiB 청크(`RESUMABLE_CHUNK_SIZE`, 비최종 청크 256 KiB 배수 조건 충족), 세션 초기화는 신규 POST/갱신 PATCH 모두 지원, 308 응답의 `Range` 헤더로 오프셋 추적(`resumableOffset`), 무진전(`next <= offset`) 시 예외, 청크 실패 시 `Content-Range: bytes */total` 상태 조회로 재개, 복구 횟수는 `MAX_RESUMABLE_RECOVERIES = 3`으로 유한.
- **중복 생성 안전성**: resumable에서 파일은 마지막 청크 커밋 시점에만 생성된다. "커밋됐지만 응답 유실" 시 상태 조회가 200 + 완성 metadata를 돌려주는 경로가 구현되어 있고(`if (status.status !== 308) return status.json`), mock이 이 시나리오를 주입(`failResumableChunkAfterCommit`)해 **`large.bin` 중복 0건·바이트 동일성**을 검증한다(`test/drive.integration.mjs`). 세션 초기화의 `retry: "safe"`도 세션만 재발급할 뿐 파일을 만들지 않으므로 file-ID 불변식과 충돌하지 않는다.
- 갱신 경로는 `assertRevision`(사전 rev 검증) 후 기존 file ID로 PATCH — stable-ID 계약 유지. 6 MiB+ 신규/갱신 두 경로 모두 테스트로 다운로드 바이트 비교까지 수행.
- 부수 개선: `call()`에 `headers`/`acceptedStatuses` 추가, file-ID를 `encodeURIComponent`로 일관 인코딩(metadata/download/upload/move/trash — 구 N-15), `listTree`의 folderId도 `escapeQueryValue` 적용. mock이 인코딩 왕복(`id with space`)을 검증.

### B-2. 실행기 회귀 테스트 — ✅ 해소 확인

`test/executor.test.mjs`(459줄, 신규)가 **번들된 실제 `DriveMergeSyncPlugin`** 을 in-memory `MemoryVault`/`MemoryAdapter` + mock Drive 서버 위에서 구동한다. 커버리지:

1. 부분 실패(2번째 업로드 413) → journal 잔존 확인 → `preparePlan` 재계획 → 재실행 후 **양쪽 파일 각 1개(중복 없음)**, journal 소거 — `AGENTS.md`의 "partial run must be safe to repeat"를 실행으로 증명.
2. 텍스트 충돌: 마커에 양측 원문 보존 + `note (Drive conflict …)` 사본 + Drive 정본 갱신.
3. `.canvas` 충돌: 정본이 유효한 JSON으로 유지되고 로컬 입력이 유효한 형제 사본으로 보존(N-2 회귀 테스트).
4. `writeBaseCopy` rename 실패 주입 → 구 baseline 원복, `.bak`/`.tmp` 잔존물 0.
5. clean 3-way 병합이 "conflict preserved"로 집계되지 않음(N-10).
6. 자동 트리거 승인 대기 Notice 1회/fingerprint(N-4), `resetBaseline()`이 토큰은 유지하고 root/base/journal만 소거(N-3).

한계: 실행기 9개 액션 중 rename/deleteRemote 경로는 직접 시나리오가 없다(부분 실패·conflict·upload/download 중심). final-review가 요구한 최소 3종은 초과 충족이므로 blocking 아님.

### B-3. 볼트 전량 재해시 — ✅ 해소 확인

- `preparePlan()`: base의 `localHash`가 있고 `localMtime`·`localSize`가 현재 stat과 일치하면 저장된 해시 재사용 — 불변 파일은 `readBinary` 0회. 테스트가 **불변 파일 read 0회 / mtime 변경 후 read 1회**를 카운터로 검증.
- `assertLocalSnapshot()`: 기본 fence를 mtime/size 비교로 바꾸고(`verifyContent=false`), 업로드는 내용 해시를 **1회만** 계산해 planned hash와 대조 후 base에 기록 — 이전의 "업로드 1건당 최대 3회 재해시" 제거. 업로드 후 `freshStat()`(adapter.stat)으로 mtime/size를 기록하므로 다음 사이클의 해시 재사용 전제가 어긋나지 않음(다운로드·rename 경로도 동일하게 `freshStat` + 즉시 해시 기록 확인).

---

## 2. Non-blocking 처리 대조 (final-review N-1~N-16)

| ID | 판정 | 근거 |
| --- | --- | --- |
| N-1 preview 무경고 제외 | ✅ | `preparePlan`이 로컬+원격의 mandatory 제외를 distinct Set으로 집계해 경고 1줄 추가, 테스트 `2 files were omitted` 검증. `BLOCKED_SEGMENTS` 범위는 좁히지 않고 README:27에 "at any depth"로 정확히 공개 — 계약상 수용 가능한 선택 |
| N-2 `.canvas`/`.json` 구조 파괴 | ✅ | `TEXT_EXTENSIONS`를 `md`,`txt`로 축소 → 구조화 포맷은 바이너리 보존 경로. executor 테스트로 검증 |
| N-3 fail-closed 출구 없음 | ✅ | `reset-sync-baseline` 커맨드 + 확인 모달 + `resetBaseline()`. 토큰 보존 테스트 있음 |
| N-4 자동 sync 무음 정지 | ✅ | fingerprint당 Notice 1회, 실행 진입 시 리셋. 테스트 있음 |
| N-5 루프백 콜백 미테스트 | ✅ | `startLoopbackAuth`에 `httpModule` 주입. 경로(204)/정상 code(200)/state 불일치(400+reject)/완료 후 재진입(409)/서버 close까지 테스트 |
| N-6/N-15 이름 내 `/`·인코딩 | ✅ | `assertSafeRemoteName()`(`/`,`\`,제어문자,`.`,`..` 거부)을 `listTree`에서 항목별 호출 + 통합/유닛 테스트. README:29 주장이 이제 사실이 됨 |
| N-7 클립보드 실패 | ✅ | `presentConnectionCode()`: textarea 표시 먼저, clipboard는 optional·실패 무해. 테스트 있음 |
| N-8 의존성 취약점 | ✅ | esbuild `^0.28.2` 승급 포함, 본 검토 재실행 `npm audit` **0건**(전체/prod 모두) |
| N-9 삭제 게이트 비대칭 | ✅ | `deletes >= 3 \|\| (deletes >= 2 && ratio > 0.1)` + 테스트(1건 미승인/큰 볼트 3건 승인). 단수형 분기는 도달 불가하나 무해 |
| N-10 clean merge 오집계 | ✅ | `onMerge()`를 `conflicts > 0` 내부로 이동, Notice 부재 테스트 |
| N-11 `.envrc` | ✅ | `safety.ts` + 테스트 + README 문구 일치 |
| N-12 planner 로그 | ✅ | `planner: 19 tests passed` 단일 출력 확인 |
| N-13 도달 불가 분기 | ✅ | 제거됨 |
| N-14 ESLint warning 4건 | ⚠️ 잔존(의도) | 하드닝 보고서가 비마켓플레이스 범위로 남긴다고 명시. 게이트는 오류 0으로 통과 |
| N-16 API 호출 수 | ⚠️ 잔존(의도) | 정확성 우선으로 유지한다고 명시. 수용 |

## 3. 게이트 독립 재실행 결과

| 게이트 | 결과 |
| --- | --- |
| `npm run check` (typecheck→lint→unit→integration→package→mobile) | ✅ EXIT=0 |
| lint | 0 errors / 4 warnings (기존 성격) |
| unit | planner 19, merge smoke, conflict, safety(신규 이름·게이트 케이스 포함), connection(+clipboard fallback), auth(+루프백 4분기), executor 신규 suite 전부 통과 |
| mock integration | multipart/resumable(6 MiB+ 신규·갱신, commit-후-응답유실, 중복 0), file-ID 인코딩, unsafe name 거부 통과 |
| package | `dist/owen-google-drive-sync` = LICENSE, main.js, manifest.json, styles.css 정확히 4개 |
| mobile load | Node/Electron 런타임 접근 없음 |
| `npm audit` / `--omit=dev` | 0 / 0 vulnerabilities |
| `git diff --check` | 통과. working tree clean (HEAD = 66f0be3) |
| 시크릿 스캔 (`GOCSPX-`, `ya29.`, `AIza…`, `1//…`, `apps.googleusercontent.com`) | 하드닝 diff·추적 트리 모두 실유출 0건 (매치는 보고서 인용문과 `src/wizard.ts:26` 정규식 리터럴뿐) |

`reports/hardening.md`의 주장과 실측이 모두 일치했다. README 신규 주장(재사용 해시, resumable, 구조화 포맷 충돌 경로, 승인 Notice 1회, baseline reset, 실기기 체크리스트)도 코드와 대조해 정확함을 확인했다.

## 4. 하드닝 diff 자체에 대한 신규 findings — blocking 0건

### Non-blocking (실기기 스모크 전 수정 불요)

1. **[P-1, Low] resumable 복구 경로의 오프셋 후퇴 가능성.** 복구 상태 조회에서 `Range` 헤더가 없으면 `resumableOffset`이 0을 반환하고, 복구 경로에는 청크 경로와 달리 무진전 가드가 없어 오프셋이 이미 커밋된 지점보다 뒤로 갈 수 있다. 실제 Google 서버가 중복 구간 PUT을 거부하면 `MAX_RESUMABLE_RECOVERIES`(3회) 안에서 실패로 끝난다 — **유한하고, 중복 파일이나 데이터 손실은 아님**(파일은 세션 완결 시에만 생성). 실계정 스모크(체크리스트 4번)가 자연스럽게 이 경로를 커버한다.
2. **[P-2, Low] 해시 재사용의 mtime/size 전제.** 같은 mtime(ms)·같은 size로 내용만 바뀐 파일은 그 사이클에서 stale 해시가 재사용되어 업로드가 건너뛰어진다. Obsidian 내부 편집에서는 사실상 발생하지 않고, `hardening.md:56`이 전제를 명시했다. 외부 앱(iOS Files 등)이 볼트를 직접 수정하는 워크플로가 생기면 재평가할 것.
3. **[P-3, Low] resumable도 원본 전체를 메모리에 올린다.** `readBinary` 특성상 파일 1회 + 청크 4 MiB 사본. multipart의 2배 복사는 제거됐지만 수백 MB 단일 파일은 여전히 iOS 메모리 경계다. `hardening.md:55`에 이미 명시 — 실기기 스모크에서 대용량 상한을 실측할 것.
4. **[P-4, Trivial] base에만 남은 mandatory 제외 항목은 omission 경고 count에 포함되지 않는다** (로컬·원격 순회에서만 집계). 표시 수치가 약간 과소일 수 있는 표기 문제.
5. **[P-5, Trivial] `.json`/`.canvas`의 기존 base 텍스트 사본이 orphan으로 남을 수 있다.** `TEXT_EXTENSIONS` 축소로 더는 갱신·사용되지 않지만 읽는 곳도 md/txt 경로뿐이라 동작 영향 없음. 파일 삭제·rebuild 시 정리된다.
6. **[P-6, Trivial] executor 테스트에 rename/deleteRemote 직접 시나리오 부재.** final-review의 최소 요구는 초과 충족. 후속 여력이 있으면 추가 권장.

### iOS 런타임 관점

diff의 신규 코드는 표준 Web API(`ArrayBuffer.slice`, `Number.isSafeInteger`, 정규식 `\p{Cc}`)와 Obsidian `requestUrl`만 사용한다. `navigator.clipboard`는 optional-chaining으로 가드되고 실패 시 UI 표시가 유지된다. 루프백 서버는 여전히 `Platform.isDesktopApp` 뒤에 있다. `test/mobile-load.mjs` 통과로 번들에 Node/Electron 접근이 없음을 재확인했다. **신규 iOS 회귀 없음.**

## 5. 권고

**Ship.** 코드·테스트·문서 수준에서 이 커밋을 막을 사유는 없다. 다음 단계는 README의 **Authorized real-device smoke checklist**를 사용자 소유의 일회용 Drive 폴더·일회용 `owen-mobile` 볼트로 실행하는 것뿐이며, 그 과정에서 P-1(중단 후 재개)과 P-3(대용량 상한)이 자연히 실측된다. P-2는 외부 앱 편집 워크플로가 도입될 때만 재평가하면 된다.
