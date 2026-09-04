# Personal Cloudflare R2 Sync — agent rules

This repository is Owen's private Obsidian sync system. It began as an MIT-licensed Google Drive Merge Sync fork; preserve upstream attribution and `LICENSE` even though the transport is now Owen's Worker and Cloudflare R2.

## Product contract

- Target: Obsidian Mobile on iOS with a vault stored under `On My iPhone`.
- Transport: the plugin calls a private Cloudflare Worker; the Worker accesses R2 through an in-process binding. Never mount iCloud/Google Drive as the active iPhone vault.
- Runtime: foreground only. Sync on explicit command, app startup/resume, and debounced edits while Obsidian is active. Never claim reliable background sync on iOS.
- Scope: one owner, one Worker, one R2 bucket namespace, Mac `owen-brain`, and iPhone `owen-mobile`. No marketplace publication is required.
- Source of truth: `owen-brain` remains the knowledge SOT. R2 is a remote transport replica, not an independent knowledge source or the only backup.
- Capacity: do not impose a total-vault quota. Small files use conditional single PUT; files at least 8 MiB use multipart staging. Real R2, Worker, device-memory, billing, and platform limits still apply.
- File types: synchronize every non-excluded Obsidian file as bytes, including Markdown, images, PDFs, Canvas, audio, and video.
- Version history: before any update, tombstone, multipart commit, move, or restore can replace a canonical revision, the exact previous R2 object must be archived under an immutable file-ID history key. History is unlimited by default, excluded from the normal index, and has no plugin delete endpoint.

## Performance contract

- One client HTTP request must return the whole remote index for a normal vault. The Worker may paginate R2 internally and must include custom metadata in the list operation.
- A steady-state sync must not issue per-file HEAD calls or a second remote list.
- Reuse the persisted local SHA-256 when mtime and size match.
- First connection adopts same-path/same-hash files without downloading them.
- Transfers use adaptive bounded concurrency: six for small files, two for medium files, and one for files at least 8 MiB.
- Large uploads use 8 MiB parts, at most two part requests concurrently, then conditionally commit the completed staging object.

## Safety

- Pull/index and deterministically plan before effects. First sync, interrupted runs, conflicts, and suspicious deletes require an explicit preview approval fingerprint.
- R2 has conditional PUT but no safe conditional DELETE contract. Represent remote deletion as a conditional tombstone PUT to the same key. Never physically delete a live canonical object in the sync path.
- Execute preservation, rename, upload, and download effects before deletes.
- Local deletes go to Obsidian trash. Divergent edits preserve both inputs. Never silently overwrite both-changed content.
- Persist a last-common baseline and execution journal. Writes to state and local files must be atomic or recoverable.
- Network retries must be bounded and idempotent. Reconcile a committed-but-response-lost write by checking file ID and SHA-256.
- History restore is explicit and foreground-only. It must use current-revision CAS plus separate operation/restore IDs, reject moved old-path tombstones when another live path has the same file ID, archive the current revision first, and let normal sync download or conflict-preserve the restored revision.

## Exclusions

Authentication state, `.obsidian`, `.trash`, `.git`, raw/archive directories, build outputs, connection codes, root secrets, key material, and archive files are mandatory exclusions. User exclusions can only add to this list.

## Security

- Never commit Worker tokens, Cloudflare API tokens, R2 credentials, connection codes, vault contents, real Worker URLs tied to secrets, or production bucket identifiers that reveal private infrastructure.
- Store the device sync token in Obsidian `SecretStorage`, not plugin `data.json`.
- Store the Worker-side token only through `wrangler secret put SYNC_TOKEN`; `.dev.vars` is local-only and ignored.
- Keep the R2 bucket private. The plugin never receives R2 credentials.
- Use Web APIs and Obsidian APIs only in mobile runtime code; no Node.js/Electron APIs.
- Real R2 mutation or Worker deployment requires explicit user authorization and a dedicated test namespace before touching production vault data.

## Worker engineering

- `worker/wrangler.jsonc` is the binding source of truth. Regenerate `worker-configuration.d.ts` after config changes.
- Use the R2 binding, not Cloudflare REST from inside the Worker.
- Stream file bodies. Buffer only bounded JSON.
- Await every promise; do not keep request state in module globals.
- Use structured logs without note paths or content.
- Required Worker gates: generated-type check, TypeScript, Workers-runtime Vitest with local R2, Wrangler dry-run, and startup profile.

## Plugin engineering

- Keep planning deterministic and separately testable from effects.
- Stable file IDs live in R2 custom metadata and survive moves.
- Package exactly `main.js`, `manifest.json`, `styles.css`, and `LICENSE`.
- Required plugin gates: typecheck, lint, unit tests, mock Worker integration, execution tests, production build, package validation, mobile-load test, and secret scan.

## Coordination

- Do not modify the user's Obsidian vaults from this repository during development.
- Do not deploy the Worker, create/delete buckets, set secrets, install the plugin on a device, commit, or push unless the user explicitly authorizes that action.
