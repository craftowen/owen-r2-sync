# Owen Google Drive Sync

Private Obsidian plugin for the `owen-mobile` vault stored under **On My iPhone**. It mirrors selected vault files through one Google Drive folder using the user's own OAuth client and the narrow `drive.file` scope.

The plugin refuses to sync when the active vault name is not exactly `owen-mobile`.

`owen-brain` remains the source of truth. Google Drive is a transport broker for the mobile mirror, not a backup or an independent knowledge source.

## Runtime contract

- Sync runs only while Obsidian is open and visible: manually, shortly after startup/resume, or after a 30-second edit debounce.
- iOS background execution is not available or promised.
- The first sync is always a read-only preview. The plugin does not create a Drive folder or change either side until **Approve and sync** is pressed.
- Later syncs use a persisted three-way baseline and stable Drive file IDs.
- Remote deletes use Drive Trash. Local deletes use Obsidian's configured trash.
- Large delete plans require another preview. An unexpectedly empty remote folder with an existing baseline fails closed.
- When both sides changed, text keeps both versions with conflict markers and a Drive conflict copy; binary content keeps the local version as a conflict copy while Drive remains canonical.

## Mandatory exclusions

The following never enter a preview, upload, download, baseline, rename, or delete payload:

- `.obsidian`, including plugin `data.json`, OAuth state, workspaces, and baseline copies
- `.trash`, `.git`, `node_modules`
- `raw`, `owen-raw`, archive folders and archive files
- build/output/coverage folders
- `.env*`, credential/client-secret files, private keys, certificates, and connection-code files

Additional folders can be excluded in the plugin settings. Remote paths containing traversal, separators inside a name, control characters, cycles, or duplicate same-name siblings stop the run.

## Install on iOS

1. Run `npm ci && npm run package` on a development machine.
2. Copy the contents of `dist/owen-google-drive-sync/` to `On My iPhone/Obsidian/owen-mobile/.obsidian/plugins/owen-google-drive-sync/`.
3. Enable **Owen Google Drive Sync** in Obsidian Community plugins.
4. Connect on desktop with a user-owned Google Cloud OAuth Desktop client, or transfer an existing connection with the encrypted device-transfer dialog.
5. Use a separate 12+ character transfer passphrase on both devices. The encrypted code expires after 15 minutes, contains no access token, and is never saved by the plugin UI.
6. Run **Preview what a sync would do**, inspect every action, then approve.

Do not place real client secrets, refresh/access tokens, connection codes, Drive IDs, or vault content in this repository. OAuth material is stored only in Obsidian's local plugin data and is hard-excluded from sync.

## Google OAuth setup

The desktop setup wizard links to Google Cloud Console. Create a Desktop OAuth client, enable Drive API, add the account as a test user when applicable, then connect. The authorization request uses `state` and PKCE (`S256`); tokens are exchanged locally. Mobile never starts the desktop loopback server.

The `drive.file` scope lets the app work with files it created or the user explicitly opened with it; this plugin targets one dedicated folder. A real-account smoke test must use an explicit user-owned test folder and is not part of automated tests.

## Development and verification

All automated tests are mock/local only and never contact Google:

```bash
npm ci
npm run check
```

`check` runs typecheck, ESLint, unit tests, mock Drive integration tests, a production build, and package-content validation. The package contains exactly `main.js`, `manifest.json`, `styles.css`, and `LICENSE`.

## Known boundary

This repository does not implement the Mac `owen-brain` bridge yet. Device installation, Obsidian iOS resume behavior, the real trash preference, and real Google OAuth/Drive response compatibility require a separately authorized dedicated-folder smoke test.

## Upstream and license

This private fork is based on **Google Drive Merge Sync** by kebl3541. Upstream attribution and the MIT [`LICENSE`](LICENSE) are preserved. The private plugin identity, packaging, and safety policy are Owen-specific; it is not intended for Obsidian Marketplace publication.
