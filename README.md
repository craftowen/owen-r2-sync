# Owen Google Drive Sync

Private Obsidian plugin for the `owen-mobile` vault stored under **On My iPhone**. It mirrors selected vault files through one Google Drive folder using the user's own OAuth client and the narrow `drive.file` scope.

The plugin refuses to sync when the active vault name is not exactly `owen-mobile`.

`owen-brain` remains the source of truth. Google Drive is a transport broker for the mobile mirror, not a backup or an independent knowledge source.

## Runtime contract

- Sync runs only while Obsidian is open and visible: manually, shortly after startup/resume, or after a 30-second edit debounce.
- iOS background execution is not available or promised.
- A fresh unconfigured install always starts with a read-only preview. Owen's generated iPhone package is an exception only because it embeds a hash-verified baseline that was independently checked against the live Drive folder before packaging.
- Later syncs use a persisted three-way baseline and stable Drive file IDs. Files whose mtime and size still match the baseline reuse the persisted content hash instead of rereading the whole vault.
- Files larger than 5 MiB use 4 MiB resumable chunks with bounded status recovery; smaller files use multipart upload.
- Remote deletes use Drive Trash. Local deletes use Obsidian's configured trash.
- Large delete plans require another preview. An unexpectedly empty remote folder with an existing baseline fails closed.
- When both sides changed, Markdown/plain text keeps both versions with conflict markers and a Drive conflict copy. Structured formats such as JSON and Canvas, plus binary content, keep the local version as a valid sibling conflict copy while Drive remains canonical.
- If an automatic trigger needs approval, Obsidian shows one notice for that unchanged plan and waits for the preview command.

## Mandatory exclusions

The following never enter a preview, upload, download, baseline, rename, or delete payload:

- `.obsidian`, including plugin `data.json`, OAuth state, workspaces, and baseline copies
- the Mac bridge access marker `RCLONE_TEST`
- `.trash`, `.git`, `node_modules`
- `raw`, `owen-raw`, archive folders and archive files
- build/output/coverage folders (these reserved folder names are excluded at any depth)
- `.env`, `.env.*`, `.envrc`, credential/client-secret files, private keys, certificates, and connection-code files

Additional folders can be excluded in the plugin settings. The preview reports how many distinct files mandatory rules omitted. Remote paths containing traversal, separators inside a name, control characters, cycles, or duplicate same-name siblings stop the run.

## Install on iOS

1. AirDrop `/Users/owen/Documents/Obsidian-iPhone-Ready/owen-mobile-ios-ready.zip` to the iPhone.
2. In Files, extract it and move the resulting `owen-mobile` folder to **On My iPhone → Obsidian**.
3. Open that local `owen-mobile` vault in Obsidian. The plugin, production OAuth connection, folder ID, and verified baseline are already present.
4. Confirm the status bar says `Drive: ready`; use **Sync with Google Drive** once if the automatic startup sync has not completed yet.

The ready ZIP contains a Google refresh token and must not be shared. Remove it from transfer locations after the iPhone installation is confirmed.

If Drive's folder was intentionally replaced or emptied and the fail-closed guard stops sync, run **Reset sync baseline for recovery**. This keeps the OAuth connection, forgets only the folder/baseline identity, and forces another read-only first-sync preview.

Do not place real client secrets, refresh/access tokens, connection codes, Drive IDs, or vault content in this repository. OAuth material is stored only in Obsidian's local plugin data and is hard-excluded from sync.

## Google OAuth setup

한국어 실사용 절차는 [`SETUP_KO.md`](SETUP_KO.md)를 따른다.

The desktop setup wizard links to Google Cloud Console. Create a Desktop OAuth client, enable Drive API, add the account as a test user when applicable, then connect. The authorization request uses `state` and PKCE (`S256`); tokens are exchanged locally. Mobile never starts the desktop loopback server.

The `drive.file` scope lets the app work with files it created or the user explicitly opened with it; this plugin targets one dedicated folder. A real-account smoke test must use an explicit user-owned test folder and is not part of automated tests.

The OAuth app is in Production with only `drive.file`. Public app information and the privacy policy are hosted at <https://vault-sync.aasoft.link/> and <https://vault-sync.aasoft.link/privacy/>.

## Development and verification

All automated tests are mock/local only and never contact Google:

```bash
npm ci
npm run check
```

`check` runs typecheck, ESLint, planner/conflict/security/executor unit tests, mock Drive integration tests (including resumable upload recovery), a production build, mobile bundle loading, and package-content validation. The package contains exactly `main.js`, `manifest.json`, `styles.css`, and `LICENSE`.

### Real-account verification completed on Mac

The user-owned disposable Drive folders verified:

1. Real OAuth authorization with the production client and exact `drive.file` consent text.
2. Five-file synthetic upload including a 6 MiB fixture, zero hash differences, stable Drive file ID across rename/update, and Drive Trash behavior.
3. Mac bridge bidirectional propagation, mobile-delete restoration, and isolated both-changed conflict preservation.
4. Production `owen-mobile` contains 414 bridge-visible files (413 vault files plus `RCLONE_TEST`) with zero differences; the prepared iPhone baseline produces zero planner actions.

## Known boundary

The Mac `owen-brain ↔ staging ↔ Google Drive` bridge is installed under `/Users/owen/Scripts/owen-brain` and runs every 60 seconds through `com.owen.brain.mobile-sync`. Actual Obsidian iOS loading, foreground/resume timing, iOS local trash behavior, and the final on-device sync remain the only unverified boundary.

## Upstream and license

This private fork is based on **Google Drive Merge Sync** by kebl3541. Upstream attribution and the MIT [`LICENSE`](LICENSE) are preserved. The private plugin identity, packaging, and safety policy are Owen-specific; it is not intended for Obsidian Marketplace publication.
