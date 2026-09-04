# Owen R2 Sync

Private, speed-first Obsidian sync for the local iPhone vault `owen-mobile`.

```text
On My iPhone/Obsidian/owen-mobile
        ↕ Owen R2 Sync plugin
private Cloudflare Worker
        ↕ R2 binding
private R2 bucket
        ↕ Owen R2 Sync on Mac
owen-brain (final SOT)
```

The iPhone always opens local files. iCloud Drive and Google Drive File Provider are not involved in startup. On Mac, the same plugin observes AI/file-system changes in `owen-brain`; if Obsidian was closed, the next startup performs a full scan.

The manifest keeps the legacy private plugin ID `owen-google-drive-sync` so an existing iPhone installation upgrades in place. Schema migration drops the old OAuth fields, refresh token, Drive folder ID, and Drive baseline before the first R2 preview.

## What it guarantees

- One Worker index request describes the remote vault; there is no per-file remote metadata waterfall.
- Unchanged local files reuse the saved SHA-256 from their mtime/size baseline.
- A new device adopts same-path/same-hash notes without downloading them.
- Writes use R2 conditional PUT. Deletes use conditional tombstones, not unsafe `HEAD → DELETE`.
- Uploads/downloads and conflict preservation finish before delete propagation.
- Markdown/text can three-way merge. When lines truly collide, the more recently modified side becomes the canonical note and the other side is preserved as a `(R2 conflict …)` / `(Local conflict …)` sibling copy — conflict markers are never written into notes. Binary/structured formats keep the local input as a sibling copy.
- Interrupted and suspicious plans stop for a fresh preview approval.
- All non-excluded bytes are supported: Markdown, images, PDFs, Canvas, audio, video, and other attachments.
- The token is kept in Obsidian SecretStorage. R2 credentials remain inside Cloudflare.
- Before an update, move, delete, multipart commit, or restore can replace the current revision, the exact previous R2 object is archived under an immutable file-ID history key.
- Version history is queried only from explicit commands. It is excluded from the normal one-request index and has no plugin delete endpoint.
- Restoring an old or deleted version archives the current revision first, performs a conditional server-side restore, and then lets normal sync download or conflict-preserve it.

## Capacity and large files

The plugin has no total-vault quota. R2 account billing and platform limits remain real.

History retention is unlimited by default and SHA-identical current writes are still rejected or adopted by the existing sync contract. Stored history therefore grows only when a canonical revision is actually replaced; storage and operation billing still apply.

- Under 8 MiB: one conditional upload.
- 8 MiB and larger: two-way parallel 8 MiB multipart staging, followed by a conditional canonical commit.
- The plugin reads one Obsidian file into device memory before transfer because the mobile Vault API exposes `readBinary()`, not a file stream. Extremely large files can therefore be limited by iPhone memory even though R2 supports much larger objects.

## iOS lifecycle

Community plugins cannot continuously run after iOS suspends Obsidian. Sync runs:

- three seconds after startup;
- immediately on foreground resume;
- manually from the ribbon or command palette;
- 30 seconds after a visible vault edit.

## Releasing and installing updates

The plugin is distributed through GitHub Releases on the private repo `craftowen/owen-r2-sync`
and installed on every device with [BRAT](https://github.com/TfTHacker/obsidian42-brat)
(repository path `craftowen/owen-r2-sync`, per-repo token for the private repo). BRAT checks for
a newer release on startup and swaps the plugin files in place — no manual file copying.

To ship a version: bump `version` in `manifest.json` and `versions.json`, then run
`./scripts/release.sh "notes"`. It runs the unit tests, packages, tags, creates the GitHub
Release with `main.js`/`manifest.json`/`styles.css`, and refreshes the Mac plugin folder.

## Cloudflare setup

Deployment is intentionally not automatic.

1. Copy `worker/wrangler.jsonc` to the ignored `worker/wrangler.production.jsonc`, then put the private Worker and R2 bucket identifiers only in that local override. The tracked config contains placeholders for tests and dry-runs.
2. From `worker/`, authenticate Wrangler and create or select the bucket.
3. Generate a random 32-byte-or-longer token and store it interactively with `wrangler secret put SYNC_TOKEN`. Never put it in source or shell history.
4. Run `npm run check:release` in `worker/`; it covers generated types, TypeScript, Workers-runtime tests, Wrangler dry-run, and startup profiling.
5. Deploy only after explicit approval.
6. In Obsidian settings, set the Worker URL and vault ID `owen-mobile`, create/select the same token through SecretStorage, and test the connection.
7. Run the dry-run command and approve the first plan only after reviewing every action.
8. After a copied-vault test passes, stop the legacy Google Drive bridge at the cutover. Never run both sync systems against `owen-brain` at the same time.

## Verification

```bash
npm install
npm run check
npm run check:release --workspace owen-r2-sync-worker
```

`npm run check` covers plugin typecheck/lint/tests/package/mobile loading plus Worker generated types, TypeScript, and local Workers-runtime R2 tests. `check:release` additionally performs the Wrangler dry-run and startup profile required before deployment.

## Deployment boundary

Automated tests use in-memory/local R2 only. Passing gates does not prove the production Worker, production R2 bucket, iPhone foreground lifecycle, mobile network, or real vault behavior. Validate those with a disposable R2 vault namespace and a copied local vault before connecting `owen-mobile`.

Existing canonical objects are not backfilled into history. Their current bytes become the first recoverable snapshot when the first post-upgrade mutation archives them.

The Worker and bucket are private, but note contents are not client-side end-to-end encrypted in this version. Application-level R2 history protects overwritten and deleted revisions, but it is still not an independent backup; local Obsidian trash, Git, and separate snapshots remain necessary recovery layers.

## Attribution

This private fork began from **Google Drive Merge Sync** by `kebl3541`. The MIT [`LICENSE`](LICENSE) and attribution are preserved. The R2 transport, Worker, performance path, safety policy, tests, and private packaging are Owen-specific.
