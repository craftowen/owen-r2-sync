# Personal Google Drive Sync

## Goal

Build a private, manually installed Obsidian iOS plugin that keeps the local `owen-mobile` vault synchronized through a dedicated Google Drive folder without relying on iCloud or Obsidian Sync.

## Initial architecture

```text
iPhone local owen-mobile
  ↕ foreground Obsidian plugin
Google Drive app-owned folder
  ↕ Mac bridge (follow-up integration)
Mac owen-brain selected mirror
```

## MVP acceptance criteria

1. Mobile-compatible build with `isDesktopOnly: false` and no Node/Electron runtime dependencies.
2. User-owned OAuth setup with `drive.file`; credentials never committed or included in sync payloads.
3. First sync is explicit and previewed.
4. Later syncs transfer only changed files using a persisted last-common baseline.
5. Upload, download, rename, delete, and same-file divergence have deterministic tested behavior.
6. Drive updates use file IDs; deletes use Drive Trash.
7. App startup/resume and manual foreground sync are supported; background guarantees are explicitly excluded.
8. Tests require no real Google account. A real-account smoke test is gated behind a dedicated test folder.
9. A packaged plugin contains `main.js`, `manifest.json`, and `styles.css` for manual iOS installation.

## Non-goals for MVP

- iCloud or CloudKit support.
- App Store/native iOS background execution.
- Multi-user collaboration, shared drives, marketplace publication, or hosted credential broker.
- Syncing `owen-raw`, the full `owen-brain`, or secrets.

## Delivery phases

1. Audit upstream security, sync semantics, and mobile compatibility.
2. Define the personal contract and close unsafe gaps with tests.
3. Rebrand/package as a private plugin and implement required changes.
4. Run mock integration and regression review.
5. Configure user OAuth and perform a dedicated-folder device smoke test.
