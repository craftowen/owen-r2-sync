# Owen R2 Sync 설정

현재 저장소는 코드와 로컬 테스트까지만 준비한다. 아래 작업은 production 배포 승인 후 진행한다.

## Cloudflare

1. `worker/wrangler.jsonc`를 ignored 파일인 `worker/wrangler.production.jsonc`로 복사한 뒤, 실제 Worker·R2 bucket 식별자는 production override에만 둔다.
2. R2 bucket은 private 상태로 유지한다.
3. Worker token은 32바이트 이상 난수로 만들고 `wrangler secret put SYNC_TOKEN`의 대화형 입력으로 저장한다.
4. Worker 디렉터리에서 `npm run check:release`를 통과시킨다.
5. Worker를 배포하고 HTTPS URL을 기록한다.

## Mac·iPhone

1. iPhone은 iCloud vault가 아니라 `나의 iPhone/Obsidian/owen-mobile`을 연다. Mac은 기존 `owen-brain` SOT를 연다.
2. 기존 설치를 제자리에서 교체하기 위해 plugin ID와 폴더는 `.obsidian/plugins/owen-google-drive-sync`를 유지한다. 표시 이름과 transport는 **Owen R2 Sync**다.
3. 설정에서 Worker URL과 `owen-mobile` vault ID를 입력한다.
4. Sync token은 SecretStorage에서 생성·선택한다. `data.json`에 직접 적지 않는다.
5. **Test R2 connection**을 실행한다.
6. **Preview what a sync would do**로 첫 계획을 확인하고 승인한다.
7. 복제 vault 실기기 검증이 끝난 뒤 실제 cutover 시점에만 기존 Google Drive bridge/launchd를 중지한다. 두 sync를 `owen-brain`에 동시에 실행하지 않는다.

## 실기기 합격 기준

- 앱 냉시작은 iCloud 다운로드를 기다리지 않고 로컬 vault를 연다.
- 정상 상태 동기화는 Worker index 요청 1회이며 per-file HEAD 요청이 없다.
- 같은 파일 세트의 첫 연결은 download가 아니라 `adopt` 계획이 된다.
- Markdown·한글 NFC 파일명·이미지·12 MiB 이상 binary가 SHA-256 동일하게 왕복한다.
- 응답 유실 재시도에서 같은 경로가 중복 생성되지 않는다.
- 양쪽 동시 수정은 두 입력을 보존한다.
- edit-vs-delete는 edit가 이기며, remote delete는 tombstone으로 남는다.
- 대량 삭제와 첫 sync는 승인 없이는 실행되지 않는다.
- iPhone에서 작성한 노트가 R2를 거쳐 Mac SOT에 동일 SHA-256으로 도착한다.
- 파일 수정·삭제 전에 이전 revision이 immutable history로 저장되고, 목록 조회와 복원이 정상 sync 요청 수를 늘리지 않는다.
- 과거 revision 복원은 현재 revision을 먼저 보존하고 새 revision으로 복원되며, stale·다른 fileId·move된 old-path 복원은 거부된다.

## 제한

- iOS background sync는 지원하지 않는다.
- 매우 큰 파일은 R2가 아니라 iPhone 메모리로 제한될 수 있다.
- Worker와 bucket은 private이지만 현재 버전은 note 본문을 client-side E2E 암호화하지 않는다.
- 기존 canonical 객체는 backfill하지 않는다. 업그레이드 후 처음 변경될 때 현재 revision부터 history에 보존된다.
- history는 기본 무기한 보존이라 R2 저장 용량과 operation 비용이 계속 증가할 수 있다.
- R2는 백업이 아니다. Git 및 별도 snapshot을 유지한다.
