# Personal Google Drive Sync — agent rules

This repository is a private personal fork of the MIT-licensed Google Drive Merge Sync plugin. Preserve upstream attribution and `LICENSE`.

## Product contract

- Target: Obsidian Mobile on iOS with a vault stored under `On My iPhone`.
- Transport: Google Drive REST API using the narrow `drive.file` scope and the user's own Google Cloud OAuth client.
- Runtime: foreground only. Sync on explicit command, app startup/resume, and debounced edits while Obsidian is active. Never claim reliable background sync on iOS.
- Scope: one account, one remote folder, one mobile vault (`owen-mobile`). No marketplace publication is required.
- Source of truth: `owen-brain` remains the knowledge SOT. Google Drive is a broker for the selected mobile mirror, not a backup or independent SOT.
- Safety: pull/plan before push, preview available, remote deletes go to Drive Trash, local deletes go to Obsidian trash, and divergent edits are preserved. Never silently overwrite both-changed content.
- Exclusions: authentication state, `.obsidian/workspace*`, `.trash`, `.git`, raw archives, build outputs, and secret files.

## Security

- Never commit client secrets, refresh tokens, access tokens, connection codes, vault contents, or real Google Drive IDs.
- Keep OAuth material in local plugin data and exclude it from synchronization. Treat `data.json` and connection codes as secrets.
- Use Web APIs and Obsidian APIs only on mobile; no Node.js or Electron APIs in runtime code.
- Real Google Drive mutation requires an explicit user-owned test folder. Automated tests use mocks by default.

## Engineering

- Keep sync planning deterministic and separately testable from effects.
- Use file IDs for remote updates so Google Drive cannot create duplicate same-name siblings during retries.
- Persist a last-common baseline for three-way decisions. Writes to state and local files must be atomic or recoverable.
- Network retries must be bounded and idempotent. A partial run must be safe to repeat.
- Required gates: typecheck, lint, unit tests, mock integration tests, production build, and an independent review.

## Coordination

- Review workers write only under `reports/` unless dispatched as the implementation owner.
- The implementation owner may edit product code, tests, manifests, and docs after audit reports are complete.
- Do not modify the user's Obsidian vaults from this repository during development.
