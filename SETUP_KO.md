# Owen Vault Sync — iPhone 설치 가이드

Mac·Google Cloud·Google Drive·OAuth·브리지 구성은 완료되어 있다. 사용자가 할 일은 준비된 볼트를 iPhone 로컬 저장소에 넣고 여는 것뿐이다.

## 준비된 파일

- 설치 ZIP: `/Users/owen/Documents/Obsidian-iPhone-Ready/owen-mobile-ios-ready.zip`
- SHA-256: `bf3aa462972a5af11c083af4f691429614947b23b694af1bb3ae2e7a990d7d2b`
- ZIP 내용: 활성 노트 413개, 모바일 플러그인, production OAuth 연결, Drive folder ID, 검증된 동기화 baseline

이 ZIP에는 Google refresh token이 들어 있으므로 다른 사람에게 전송하거나 메신저·공용 클라우드에 올리지 않는다. iPhone 설치 확인 후 Mac의 ZIP을 삭제한다.

## iPhone에서 할 일

1. Mac Finder에서 `owen-mobile-ios-ready.zip`을 iPhone으로 **AirDrop**한다.
2. iPhone **파일** 앱에서 ZIP을 한 번 눌러 압축을 푼다.
3. 생성된 `owen-mobile` 폴더를 길게 누르고 **이동**을 선택한다.
4. 목적지를 **나의 iPhone → Obsidian**으로 지정한다. 최종 경로는 `나의 iPhone/Obsidian/owen-mobile`이다.
5. Obsidian을 열고 볼트 전환기에서 로컬 `owen-mobile`을 연다. iCloud의 동명 볼트를 열지 않는다.
6. 설정 → Community plugins에서 **Owen Google Drive Sync**가 켜져 있는지 확인한다. 이미 활성화 목록에 들어 있다.
7. 화면 하단 상태가 `Drive: ready`인지 확인한다. 필요하면 리본의 동기화 아이콘 또는 명령 팔레트의 **Sync with Google Drive**를 한 번 실행한다.

로그인, client secret 입력, connection code, passphrase, 첫 baseline 승인은 필요 없다. 패키지 생성 시 현재 로컬 413개와 Drive 413개의 SHA-256·file ID를 대조했고 planner 결과가 0 action임을 검증했다.

## 동작 방식

- iPhone Obsidian이 열려 있을 때 startup/resume/manual 및 편집 후 30초 debounce로 Drive와 동기화한다.
- Mac은 60초마다 `Drive → Mac staging → owen-brain → Drive` 순서로 왕복한다.
- `owen-brain`이 최종 SOT이며 `owen-raw`·`.git`·`.obsidian`·`60-studio`·시크릿은 iPhone으로 가지 않는다.
- 모바일에서 삭제한 파일은 메인 볼트에서 자동 삭제되지 않고 복원된다. 삭제는 Mac의 `owen-brain`에서 한다.
- 동시 수정 시 두 버전을 보존한다.

## 완료 판정

- 로컬 볼트가 즉시 열리고 iCloud 로딩 표시가 없다.
- `Drive: ready`가 보인다.
- iPhone에서 테스트 메모를 만든 뒤 동기화하면 최대 약 1분 후 Mac `owen-brain`에 나타난다.
- Mac에서 수정한 메모는 다음 iPhone foreground/resume 동기화 후 반영된다.
