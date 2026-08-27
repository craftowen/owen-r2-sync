# 최종 하드닝 보고서

- 기준 커밋: `3e4f575` (`feat: build private safety-first Drive sync`)
- 입력 검토: `reports/final-review.md`
- 작업 일자: 2026-08-27
- 실제 볼트/Google Drive 변경: 없음

## 결론

최종 리뷰의 blocking 3건을 모두 수정하고 각각 회귀 테스트를 추가했다. 안전하게 닫을 수 있는 non-blocking 항목도 함께 처리했으며, `npm run check`, 패키지 내용 검증, `npm audit`, `git diff --check`가 모두 exit 0이다. 실제 iOS 기기와 사용자 OAuth/Drive 전용 폴더 스모크는 권한 경계상 실행하지 않았고 README에 별도 체크리스트와 한계를 명시했다.

## Blocking 처리

| ID | 처리 | 회귀 증거 |
| --- | --- | --- |
| B-1 대용량 업로드 | 5 MiB 초과 파일은 4 MiB(256 KiB 배수) 청크의 resumable 업로드를 사용한다. 초기 세션과 청크 재시도는 유한하며, 응답 유실 시 세션 상태/`Range`를 조회해 이어서 보낸다. 작은 파일의 multipart 경로와 stable-ID update는 유지했다. | `test/drive.integration.mjs`: 6 MiB+ 신규/갱신, 중간 청크 commit 후 500 응답 유실, 중복 0건, 바이트 동일성 |
| B-2 실행기 테스트 부재 | 실제 `DriveMergeSyncPlugin` 실행기를 in-memory Obsidian Vault/adapter와 mock Drive 위에서 번들·실행하는 테스트를 추가했다. | `test/executor.test.mjs`: 부분 실패→현재 상태 재계획→재실행, 텍스트 양측 보존, Canvas 구조 보존, baseline 원자 쓰기 rollback, 승인 알림, baseline reset |
| B-3 볼트 전량 재해시 | 완료된 baseline의 `localMtime + localSize + localHash`가 일치하면 저장된 해시를 재사용한다. 업로드는 내용 해시를 한 번 계산하고 전후 disk stat fence를 검사한다. | `test/executor.test.mjs`: 불변 파일 read 0회, stat 변경 파일만 read 1회 |

대용량 정책은 Google Drive 공식 [Upload file data](https://developers.google.com/workspace/drive/api/guides/manage-uploads) 계약(5 MiB 초과 resumable 권고, 비최종 청크 256 KiB 배수, 308/Range 기반 재개)에 맞췄다.

## 함께 처리한 findings

- N-1: 강제 제외 파일의 distinct 개수를 preview 경고에 표시한다. `Archive` 등 넓은 기존 제외 범위는 계약을 임의로 좁히지 않고 README에 정확히 드러냈다.
- N-2: `.json`, `.canvas`, `.css`, `.csv`는 충돌 마커를 삽입하지 않는다. Drive 정본을 유효한 구조로 유지하고 로컬 입력을 형제 conflict copy로 보존한다.
- N-3: OAuth 연결은 유지하면서 root/baseline/journal만 지우고 다음 실행을 first-sync preview로 돌리는 확인 모달/명령을 추가했다.
- N-4: 자동 sync가 승인 대기일 때 동일 fingerprint당 Notice 1회만 보낸다.
- N-5: 루프백 서버 주입점을 추가하고 callback 경로, state 불일치, 정상 code, 완료 후 재진입 409를 테스트했다.
- N-6/N-15: Drive item 이름 자체의 `/`, `\\`, traversal/control 문자를 거부한다. folder query 값과 file-ID URL을 일관되게 escape/encode한다.
- N-7: connection code를 textarea에 먼저 표시한 뒤 clipboard를 시도한다. clipboard가 없거나 실패해도 코드는 UI에 남는다.
- N-8: 비파괴 audit fix와 esbuild 업그레이드 후 production/dev dependency 모두 `npm audit` 0건이다.
- N-9: 삭제 승인은 3건 이상 또는 2건 이상이면서 baseline의 10% 초과일 때 요구한다. 작은 볼트의 단일 삭제 무한 승인과 큰 볼트의 19건 무승인을 함께 제거했다.
- N-10: conflict 없는 clean 3-way merge를 `conflicts preserved`로 집계하지 않는다.
- N-11/N-12/N-13: `.envrc` 제외, planner 테스트 로그 단일화, 도달 불가능한 root 비교 분기를 정리했다.

## 최종 게이트

| 게이트 | 결과 |
| --- | --- |
| `npm run typecheck` | 통과, 오류 0 |
| `npm run lint` | 통과, 오류 0 / 기존 성격의 warning 4건 |
| unit tests | 통과: planner 19, merge/conflict/safety/connection/auth, 신규 executor suite |
| mock integration | 통과: multipart/resumable, commit-response loss, stable ID, filename/path safety |
| production build | 통과, `main.js` 89,604 bytes |
| package | 통과: `LICENSE`, `main.js`, `manifest.json`, `styles.css` 정확히 4개 |
| mobile load | 통과: Node/Electron runtime 접근 없음 |
| `npm audit` | 0 vulnerabilities |
| `git diff --check` | 통과 |
| 독립 검토 | `reports/final-review.md`가 기준 커밋 전체를 독립 검토했고 본 하드닝이 blocking/non-blocking findings를 대조 처리함 |

## 명시적 잔여 경계

- 실제 iPhone/iPad, Obsidian iOS resume/visibility 전이, secure-context Web Crypto, clipboard, 실제 Obsidian trash/adapter 동작은 미검증이다.
- 실제 Google OAuth와 Drive API에는 접촉하지 않았다. resumable 응답/헤더, 쿼터, `Retry-After`, 토큰 만료는 공식 계약과 mock으로만 검증했다.
- resumable은 multipart의 두 번째 전체-size 복사를 없애고 4 MiB 청크만 추가 할당하지만, Obsidian `readBinary` 특성상 원본 파일 자체는 한 번 메모리에 올린다.
- 해시 재사용은 Obsidian/파일시스템이 제공하는 mtime과 size가 실제 내용 변경을 반영한다는 전제다. stat이 바뀐 파일은 다시 SHA-256한다.
- 다운로드의 전후 revision metadata 확인과 완료 후 `listTree` 재구축은 정확성을 위해 유지했다. API 호출 수 최적화(N-16)는 하지 않았다.
- 설정 검색용 `getSettingDefinitions()`와 sentence-case lint warning은 기존 최소 Obsidian 버전/비마켓플레이스 범위를 고려해 남겼다.
- Mac `owen-brain` bridge는 여전히 별도 후속 범위다.

README의 **Authorized real-device smoke checklist**가 남은 기기/OAuth 경계를 검증하는 유일한 승인된 다음 단계다.
