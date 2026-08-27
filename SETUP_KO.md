# Owen Google Drive Sync 실사용 설정 가이드

이 가이드는 개인 Google 계정과 일회용 테스트 폴더로 첫 실기기 smoke를 수행하기 위한 절차다. client secret·refresh token·connection code·전송 passphrase는 채팅이나 Git에 남기지 않는다.

## 준비된 로컬 자산

- 플러그인 ZIP: `/Users/owen/wProject/obsidian-gdrive-personal-sync/dist/owen-google-drive-sync-1.0.0.zip`
- Mac smoke 볼트: `/Users/owen/Documents/obsidian-sync-smoke/owen-mobile`
- iPhone bootstrap ZIP: `/Users/owen/Documents/obsidian-sync-smoke/owen-mobile-bootstrap.zip`
- bootstrap SHA-256: `ee28e669dded75aaab628c13ebaad6e1327453ab05714c3f12266ab843865dce`

smoke 볼트에는 합성 Markdown 3개와 6MiB zero fixture만 있으며 개인 노트는 없다.

## 1. Google Cloud 프로젝트

1. `https://console.cloud.google.com/`에 로그인한다.
2. 상단 프로젝트 선택기 → **새 프로젝트**.
3. 프로젝트 이름: `owen-obsidian-sync`.
4. 생성된 프로젝트를 선택한다.
5. API 및 서비스 → 라이브러리 → **Google Drive API** → 사용.

## 2. Google Auth Platform

1. Google Auth Platform → 시작하기.
2. 앱 이름: `Owen Google Drive Sync`.
3. 사용자 지원 이메일·개발자 연락처에는 본인 계정을 선택한다.
4. Audience는 **External**로 두고 본인 계정만 테스트 사용자로 추가한다.
5. Data Access에서 앱이 런타임에 요청하는 `drive.file` 외 광범위 Drive scope를 추가하지 않는다.
6. Clients → **Create client** → Application type **Desktop app**.
7. 이름: `Owen Obsidian Sync Desktop`.

client ID와 client secret은 이 채팅이나 저장소에 붙여넣지 않는다. JSON 다운로드도 피하고 Mac smoke 볼트의 플러그인 설정 화면에 직접 한 번 입력한다.

## 3. Mac smoke 연결

1. Obsidian에서 `/Users/owen/Documents/obsidian-sync-smoke/owen-mobile`을 별도 볼트로 연다.
2. Community plugins에서 **Owen Google Drive Sync**를 활성화한다.
3. 플러그인 설정의 Drive folder name을 `owen-mobile-smoke-20260828`로 지정한다.
4. setup wizard에 client ID·client secret을 직접 입력한다.
5. Connect를 눌러 Google 로그인·동의를 완료한다. 요청 scope가 `drive.file`인지 확인한다.
6. **Preview what a sync would do**를 실행한다.
7. 첫 preview가 합성 fixture만 다루고 `.obsidian`을 제외하는지 확인한 뒤 승인한다.

## 4. Mac smoke 판정

- Markdown 3개와 `README.md`, 6MiB fixture가 전송된다.
- Drive에 같은 이름의 sibling이 중복 생성되지 않는다.
- rename은 같은 Drive file ID를 유지한다.
- 양쪽에서 다르게 수정한 `conflict.md`는 두 입력이 모두 보존된다.
- 삭제는 Drive Trash·Obsidian trash로 간다.
- 대용량 업로드 중단 후 재시도해도 중복 파일이 생기지 않는다.
- remote folder를 비우면 자동 삭제하지 않고 fail-closed 된다.

## 5. iPhone 로컬 볼트

1. `owen-mobile-bootstrap.zip`을 AirDrop 또는 Files로 iPhone에 옮긴다.
2. 압축을 풀고 `owen-mobile` 폴더를 **나의 iPhone → Obsidian** 아래로 이동한다.
3. Obsidian 볼트 전환기에서 로컬 `owen-mobile`을 연다. iCloud 위치의 동명 볼트와 혼동하지 않는다.
4. Community plugins에서 플러그인을 활성화한다.
5. Mac 플러그인 설정에서 **Encrypted device transfer**를 연다.
6. 12자 이상의 별도 passphrase를 정하고, 15분 만료 connection code를 iPhone에 직접 전달한다. passphrase와 code는 채팅에 남기지 않는다.
7. iPhone에서 먼저 preview를 확인한 뒤 승인한다.

## 6. smoke 종료

1. 결과와 file ID·중복·trash 여부를 기록한다.
2. Google Drive의 `owen-mobile-smoke-20260828` 폴더를 휴지통으로 보낸다.
3. Google 계정의 서드파티 접근 권한에서 테스트 OAuth grant를 revoke한다.
4. smoke가 성공하면 OAuth 앱을 Production으로 전환해 테스트 모드 refresh token 만료 제약을 피한다.
5. 실제 `owen-mobile` 전환 전 Mac bridge를 구현·검증한다.

## 브라우저 자동화 재개

Codex가 Google Cloud Console을 대신 탐색하려면 앱의 **Settings → Computer use**에서 브라우저 확장을 연결하고, 연결된 브라우저에서 Google Cloud Console에 로그인한 뒤 다시 요청한다. 비밀번호·2FA·client secret은 사용자가 직접 다룬다.
