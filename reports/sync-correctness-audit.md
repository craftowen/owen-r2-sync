# 동기화 정확성 및 테스트 감사

작성일: 2026-08-27
범위: `AGENTS.md`, `PROJECT_BRIEF.md`, `src/{planner,merge,drive,main,auth,wizard}.ts`, 모든 `test/*.mjs`, `manifest.json`, `package.json`, TypeScript/ESLint/esbuild 설정

## 결론

현재 구현은 기본적인 3-way 계획, 파일 ID 기반 업데이트, 양쪽 휴지통 삭제, 제한된 Drive 재시도, 모바일용 번들 생성까지는 동작한다. 그러나 MVP 안전 계약을 충족한 상태는 아니다. 특히 아래 6개는 실제 데이터 손실·노출 또는 중복 파일로 이어질 수 있어 실사용 OAuth/기기 스모크 전에 막아야 한다.

1. **필수 제외 규칙이 없다.** `syncNow()`는 사용자가 직접 입력한 폴더만 제외한다(`src/main.ts:266-272,300-315`). 따라서 `.obsidian/plugins/<plugin-id>/data.json`의 OAuth client secret/refresh token/root ID와 `base/`의 기준 사본을 포함해 `.obsidian`, `.trash`, `.git`, archive/build/secret 경로를 코드 수준에서 차단하지 않는다. `Vault.getFiles()`가 config/hidden 경로를 노출하는지는 Obsidian 환경에 따라 별도 검증이 필요하지만, 노출되는 환경에서는 secret upload와 기준 사본 자기 재귀가 가능하고 remote에 존재하는 동일 경로는 현재 코드가 확실히 download 대상으로 본다.
2. **첫 동기화가 preview 승인으로 봉쇄되지 않는다.** 실제 sync를 바로 실행할 수 있고 startup/interval도 빈 baseline을 실행할 수 있다(`src/main.ts:112-115,144-156,279-318`). dry run조차 계획 전에 Drive root folder를 생성하고 `data.json`을 저장하므로 무효과 preview가 아니다(`src/main.ts:292-298,318-330`).
3. **연결 대상 변경 시 기존 baseline이 남는다.** `disconnect()`는 token/root ID만 지우고 `base`와 기준 사본은 남긴다(`src/main.ts:243-248`). 다른 빈 folder/account에 재연결하면 변경되지 않은 로컬 파일이 `deleteLocal`로 계획되어 trash될 수 있다. connection code import도 root ID를 교체하면서 baseline을 검증하거나 초기화하지 않는다(`src/main.ts:195-215`).
4. **새 파일/폴더 생성 재시도는 idempotent하지 않다.** 모든 403/429/5xx/transport failure를 동일 POST로 최대 4회 반복한다(`src/drive.ts:115-145`). 첫 요청의 mutation은 성공했지만 응답만 유실된 경우 `ensureFolder()`와 `uploadNew`가 같은 이름의 sibling을 중복 생성할 수 있다. `listTree()`는 같은 경로를 `Map`의 마지막 항목으로 덮어 중복을 숨긴다(`src/drive.ts:168-194`).
5. **부분 실패와 상태 저장이 원자적이지 않다.** delete/rename/conflict를 먼저 적용하고 transfer 4개를 병렬 실행한 뒤에야 remote re-list와 `saveData()`를 한다(`src/main.ts:333-376`). `Promise.all`은 첫 실패에 반환하지만 다른 worker를 취소/대기하지 않아 `syncing=false` 이후에도 mutation이 계속될 수 있다. 로컬 파일, 기준 사본, `base`, remote effect 사이 journal/commit 경계가 없고 token refresh callback은 실행 중의 부분 변경된 `base`를 비동기로 저장할 수도 있다(`src/main.ts:250-260`).
6. **both-changed의 패자를 항상 보존하지 않는다.** text true-conflict는 local 조각을 택한 결과를 같은 Drive file ID에 자동 업로드하므로 remote 충돌 조각의 독립 사본이 남지 않는다(`src/main.ts:590-603,642-666`; `src/merge.ts:375-402`). binary에서 local mtime이 더 최신이면 remote bytes를 내려받고도 그대로 덮어써 remote 패자를 보존하지 않는다(`src/main.ts:606-620`). 첫 sync의 동일 경로·상이한 text는 공통 기준을 빈 문자열로 가정해 같은 동작을 한다.

따라서 현재 상태는 **mock proof-of-concept는 통과하지만, 개인 vault를 맡길 수 있는 fail-closed sync는 아니다.**

## 계약 매트릭스

| 영역 | 상태 | 현재 동작 및 근거 | 계약과의 차이 |
|---|---|---|---|
| 첫 sync | 실패 | 빈 `base`에서 local-only는 upload, remote-only는 download, 양쪽 동일 path는 conflict로 계획한다(`planner.ts:60-96`). 동일 bytes면 채택하지만 다르면 자동 merge/upload한다(`main.ts:575-603`). | 첫 실행 전 preview/승인 gate가 없고, dry run도 root folder를 생성한다. 상이한 양쪽 파일에는 실제 common baseline이 없는데 빈 문자열을 baseline으로 사용한다. |
| pull/plan before push | 부분 충족 | local/remote를 모두 수집한 후 pure `planSync()`를 호출하고 그 뒤 effects를 실행한다(`main.ts:300-318,333-376`). | 계획 snapshot 이후 파일 변화를 fence하지 않는다. preview가 mutation-free가 아니며 first-sync 승인 상태도 없다. |
| upload new/update | 부분 충족 | update는 planner가 받은 remote `fileId`로 PATCH하고 반환 ID/rev를 base에 기록한다(`main.ts:482-503`; `drive.ts:202-233`). | create POST의 ambiguous failure 재시도가 중복을 만들 수 있다. local 변화 판정이 `mtime > baseline`뿐이라 같은/과거 mtime의 실제 변경을 놓친다(`planner.ts:57-58`). |
| download new/update | 부분 충족 | file ID로 download하고 Obsidian API로 create/modify한다(`main.ts:506-529`). | temp+atomic replace/recovery가 없고 executor 전체 테스트가 없다. download 직후 실패 시 local/base-copy/index가 서로 다른 세대가 될 수 있다. |
| local rename -> Drive | 부분 충족 | old delete + new create를 `localSize`와 exact mtime의 유일 일치로 짝지어 기존 Drive ID를 move한다(`planner.ts:133-149`; `main.ts:441-457`). | content identity가 아니어서 같은 size/mtime의 무관 파일을 false rename할 수 있다. rename+edit는 rename으로 인식하지 못한다. |
| remote rename -> local | 실패 | checksum이 같은 유일 후보를 rename으로 보고 `fileManager.renameFile`을 사용한다(`planner.ts:152-164`; `main.ts:460-479`). | 이미 양쪽에 file ID가 있는데 ID가 아니라 checksum으로 식별한다. 같은 checksum의 새 file ID를 false rename할 수 있고, 같은 file ID가 rename과 edit를 함께 하면 delete+download가 되어 링크 보존을 잃는다. |
| local delete -> Drive | 충족(기본 effect) | 기존 file ID에 `trashed:true` PATCH한다(`planner.ts:87-95`; `drive.ts:249-255`). | partial-run/journal/duplicate-ID 시나리오는 미검증이다. |
| remote delete -> local | 부분 충족 | 변경되지 않은 local은 `fileManager.trashFile`로 보낸다(`planner.ts:75-83`; `main.ts:532-537`). local edit는 새 upload가 이긴다. | 실제 Obsidian trash 정책과 permanent-delete 설정까지 강제 검증하지 않는다. 기준 사본은 삭제하지 않아 같은 path가 재등장하면 stale baseline을 읽을 수 있다. |
| 양쪽 삭제 | 부분 충족 | planner는 no-op이고 successful run의 `rebuildBase()`가 index entry를 제거한다(`planner.ts:99-101`; `main.ts:679-693`). | 기준 사본 파일은 제거하지 않는다. path 재사용 시 오래된 content가 merge baseline으로 부활한다. |
| both-changed text | 실패 | line/char 3-way merge 후 결과를 local과 동일 remote ID에 자동 반영한다. true conflict는 local 조각을 기본 선택하고 Notice만 보낸다(`merge.ts:210-332,375-402`; `main.ts:590-603`). | divergent edits의 양쪽 보존 및 사용자 승인 요구를 충족하지 않는다. 기준 사본이 없으면 `""`을 common base로 가정한다(`main.ts:593`). merge 전체 테스트는 1개 smoke뿐이다. |
| both-changed binary | 실패 | remote newer면 local conflict copy를 만든다. local mtime newer면 remote를 같은 ID로 덮어쓴다(`main.ts:606-631`). | local-newer 분기에서 remote 패자가 사라진다. 서로 다른 device clock의 mtime 비교도 안전한 인과관계가 아니다. |
| retry | 부분 충족 | transport exception, 403, 429, 5xx를 bounded exponential delay로 최대 4회 시도한다(`drive.ts:115-145`). mock은 GET의 연속 500 두 번 후 성공만 검사한다. | mutation ambiguity, 401 refresh, `Retry-After`, 영구 403, exhausted retries, response validation이 없다. create는 idempotent하지 않다. |
| partial failure / repeat safety | 실패 | action별로 effect 직후 in-memory base를 바꾸고 전체 성공 후에만 rebuild/persist한다. transfer는 4-way pool이다(`main.ts:333-376,426-558`). | durable journal, per-action commit, generation fence, cancellation/drain이 없다. 실패 반환 뒤 worker가 계속 mutation할 수 있고 재시작/재시도 invariants가 테스트되지 않았다. |
| baseline/state persistence | 실패 | `data.json`에 settings/tokens/root/base index를 함께 저장하고, text 기준 사본은 별도 파일로 직접 write한다(`main.ts:159-175,394-424`). | 원자성/복구가 없고 secret과 baseline storage에 명시적 hard exclusion이 없다. `baseSlug()`의 `/` -> `__` 변환 때문에 `a/b.md`와 `a__b.md`가 충돌한다. delete 시 기준 사본을 지우지 않는다. |
| exclusions | 실패 | 사용자가 입력한 folder prefix만 local/remote 양쪽에 적용한다(`main.ts:266-272,300-315,816-829`). | 계약상 고정 제외(`data.json`, connection material, `.obsidian/workspace*`, `.trash`, `.git`, raw archives, build output, secret files)가 구현되지 않았고 filename/glob 규칙도 없다. |
| file-ID behavior | 부분 충족 | upload update, conflict overwrite, move, trash, download는 file ID를 쓴다. `rebuildBase`도 remote path의 ID를 다시 기록한다. | create retry는 안정된 ID가 없고 duplicate path를 감지하지 않는다. remote rename 식별은 ID 대신 checksum이다. path 중복 시 `Map`이 한 ID를 임의로 숨긴다. |
| foreground lifecycle | 실패 | manual command/ribbon/header, startup delay, optional fixed interval은 있다(`main.ts:83-116,144-156`). | app resume trigger와 debounced edit trigger가 없다. first-sync gate 없이 automatic path가 실행될 수 있다. |
| OAuth/mobile runtime | 부분 충족 | `drive.file` scope를 사용하고 mobile에서는 loopback auth를 거부한 뒤 connection code를 쓰도록 한다(`auth.ts:7-8,63-71`; `main.ts:183-215`). manifest는 `isDesktopOnly:false`다. | production bundle에 desktop `window.require("http")` 경로가 남고 mobile load smoke가 없다. connection code는 client secret/refresh token/root ID의 평문 base64이며 import 시 account/root/baseline binding을 검증하지 않는다. |
| packaging/build | 부분 충족 | `npm run build`가 typecheck와 production `main.js` bundle을 만들고 `manifest.json`/`styles.css`가 존재한다. MIT `LICENSE`와 upstream attribution은 보존되어 있다. | `build`가 lint/unit/mock/package artifact 검증을 묶지 않는다. `deploy`는 unrelated 절대경로 vault로 복사하므로 이 private fork에서 실행하면 안 된다(`package.json:10`). iOS manual-install bundle/load 검증도 없다. |

## 재현으로 확인한 planner/merge 경계

생성된 test bundle을 읽기 전용 Node snippet으로 호출해 다음을 확인했다.

- baseline `localMtime=10, localSize=1`인데 현재 `mtime=10, size=99`여도 action은 `[]`이다.
- 현재 local mtime이 baseline보다 작고 size/content가 달라도 action은 `[]`이다.
- remote가 같은 file ID로 `old.md -> new.md` rename과 edit를 함께 하면 `downloadNew(new.md) + deleteLocal(old.md)`가 된다.
- remote의 새 file ID가 기존 파일과 같은 checksum이면 실제 ID가 달라도 `renameLocal`로 오인한다.
- common base가 없고 local=`local`, remote=`remote`이면 merge 결과는 local, conflict count 1이다. executor는 이 결과를 remote ID에 upload하므로 remote 원본의 독립 사본이 남지 않는다.

## 테스트 감사

### 실행 결과

| Gate | 명령 | 결과 |
|---|---|---|
| unit + mock integration | `npm test` | 성공: planner 16 tests, merge smoke 1, Drive integration 12 assertions |
| typecheck + production build | `npm run build` | 성공 |
| lint | `npx eslint src/**/*.ts` | exit 0, error 0, warning 2 (`PluginSettingTab` declarative settings, wizard sentence case) |

`npm test`는 real Google account를 사용하지 않고 local mock만 사용한다. 이는 계약에 맞다. 반면 tests가 통과했다는 사실은 `DriveClient` happy path와 planner의 일부 truth table만 증명하며, `main.ts` effect orchestration은 한 줄도 통합 검증하지 않는다.

### 현재 테스트가 실제로 덮는 것

- Planner: local/remote new, no-op, 단방향 edit, both edit conflict, 단방향 delete, edit-vs-delete, both delete, same-path birth, mixed deterministic order, 양방향 기본 rename, ambiguous local rename.
- Merge: disjoint line 변경 1개 smoke case뿐이다. `diffLines`, `charMerge3`, segment proposal/choice, true conflict, 크기 guard는 실질 미검증이다.
- Drive mock integration: expired-token refresh, folder lookup/create idempotence(정상 응답일 때), upload/list/download, ID 유지 update, nested folder, move, trash, GET에서 500 두 번 후 성공.
- Auth, wizard, exclusions, startup/resume, connection import/export binding, dry run, executor, state persistence, partial failure, packaging/iOS load는 테스트하지 않는다.

### 반드시 추가할 누락 테스트

#### P0 — real Drive/device 전에 필수

1. **고정 제외 회귀:** local과 remote 양쪽에서 `.obsidian/plugins/<id>/data.json`, plugin `base/`, `.obsidian/workspace*`, `.trash`, `.git`, archives, `main.js`/build directories, `.env`/secret patterns가 어떤 상태에서도 upload/download/delete/preview 목록에 들어가지 않는지 검증한다.
2. **first-sync state machine:** local-only, remote-only, identical same-path, different same-path를 preview -> explicit approve -> execute 단계로 검증한다. preview 전후 Drive mock request log, root folder, `data.json`, vault가 byte-for-byte 무변경이어야 한다.
3. **연결 identity 변경:** disconnect/reconnect, 다른 root ID connection code import, folder name 변경에서 old baseline으로 local delete가 절대 계획되지 않는지 검증한다. baseline은 `(account identity, root file ID, vault identity)`에 묶여야 한다.
4. **mutation ambiguity/idempotency:** folder/file create가 server에서 적용된 뒤 응답만 500/connection reset 되는 mock을 만든다. retry 후 sibling이 정확히 1개이고 stable ID가 유지되어야 한다.
5. **부분 실패 crash matrix:** 각 action 전/remote effect 후/local effect 후/base-copy 후/index persist 전/remote re-list 중 실패를 주입하고 plugin 재시작 후 재실행한다. 결과가 duplicate/overwrite 없이 수렴하고, sync가 실패 반환한 뒤 mutation count가 더 늘지 않아야 한다.
6. **conflict 보존:** text true conflict, missing/corrupt baseline, binary local-newer, binary remote-newer, conflict upload failure를 검증한다. 모든 경우 양쪽 입력을 복구 가능한 별도 artifact로 보존하고 승인 전 원본 remote를 덮어쓰지 않아야 한다.
7. **baseline storage:** `a/b.md`와 `a__b.md`, delete 후 same-path recreate, rename/delete 중 실패, 기준 사본 write failure를 검증한다. content-addressed/escaped key가 충돌하지 않고 stale copy를 사용하지 않아야 한다.

#### P1 — correctness hardening

8. Planner local change detection: equal mtime + changed size/hash, clock rollback, mtime-only touch, coarse filesystem timestamp.
9. Rename identity: same ID rename, same ID rename+edit, different ID/same checksum false positive, local same size/mtime false positive, ambiguous 양방향 rename.
10. Drive error policy: 401 refresh-once, rate-limit 403/429 + `Retry-After`, permanent 403 no pointless retry, exhausted retry, malformed JSON/body, pagination, duplicate same-name siblings.
11. File-ID invariant: every update/move/trash가 baseline ID를 사용하고 path lookup으로 target을 바꾸지 않는지 request-level assertion을 추가한다.
12. Executor concurrency: transfer 4개 중 하나 실패, 나머지 drain/cancel, 즉시 연속 sync, sync 도중 local edit/rename/delete를 검증한다.
13. Local trash API와 설정별 동작을 Obsidian-compatible shim에서 확인한다.

#### P2 — lifecycle/package

14. startup, app resume, debounced edit가 foreground에서만 schedule되고 중복 sync를 coalesce하는지 fake timer로 검증한다.
15. production `main.js`가 mobile-like 환경에서 import/load되고 desktop-only auth branch를 실행하지 않는지 smoke test한다.
16. package gate가 정확히 `main.js`, `manifest.json`, `styles.css`, `LICENSE`를 산출하고 secret/real ID/vault content/generated test file을 포함하지 않는지 검증한다.

## 권장 구현 순서

1. **즉시 data egress 차단:** mandatory exclusion matcher를 코드 상수로 만들고 local scan, remote scan, preview, base cleanup에 동일 적용한다. plugin 자신의 `data.json`/baseline directory는 최우선 hard exclusion로 두고 테스트부터 고정한다.
2. **sync identity와 baseline 저장소 재설계:** baseline을 account/root/vault identity에 bind하고 connection 대상이 달라지면 자동 실행을 막아 first-sync flow로 보낸다. path 문자열 slug 대신 충돌 없는 key/content hash를 사용하고 index + content + journal을 atomic generation 단위로 commit한다. delete 시 기준 사본도 tombstone/GC한다.
3. **first-sync preview/approval gate 구현:** preview는 root 생성조차 하지 않는 read-only plan이어야 한다. 공통 baseline 없는 same-path 상이는 merge하지 말고 양쪽 보존 + 명시적 결정으로 보낸다. startup/resume/interval은 승인된 baseline 전에는 실행하지 않는다.
4. **Drive create와 duplicate 정책을 idempotent하게 변경:** 생성 전 stable file ID를 확보하거나 ambiguous response 후 동일 parent/path를 ID/marker로 재조정하는 프로토콜을 사용한다. list 단계에서 duplicate path를 fail closed로 보고 임의 `Map` overwrite를 금지한다. remote rename은 checksum이 아니라 persisted file ID로 판정한다.
5. **effect executor를 recoverable transaction으로 변경:** action별 durable intent/result journal, generation fence, 안전한 local temp-write/rename, worker drain/cancel을 둔다. delete는 의존 upload/download 성공 전 commit하지 않고, 실패 후 동일 plan을 반복해도 결과가 하나로 수렴하도록 한다.
6. **conflict 정책을 양쪽 보존으로 교체:** text/binary 모두 loser artifact를 local/Drive 중 계약으로 정한 안전 위치에 남기고, true conflict와 missing baseline은 fail closed한다. mtime만으로 binary winner를 정하지 말고 preview/사용자 결정 또는 명시적 version metadata를 쓴다.
7. **전체 test harness와 lifecycle/package 마무리:** `main.ts`용 Obsidian vault/Drive effect mock을 만들고 위 crash matrix를 자동화한 뒤 resume/debounce foreground scheduling을 추가한다. 마지막 gate를 typecheck -> lint -> unit -> mock integration -> production build -> secret/artifact scan -> mobile load smoke 순서로 묶고, unrelated 절대경로 `deploy`는 제거/대체한다.

## 실기기 검증 경계

이번 감사에서는 real Google Drive mutation, 사용자 vault 변경, iOS 설치/foreground resume, Obsidian trash 실제 동작을 수행하지 않았다. 현재 P0 항목이 해소되기 전에는 전용 test folder라 하더라도 real account smoke를 진행하지 않는 것이 안전하다.
