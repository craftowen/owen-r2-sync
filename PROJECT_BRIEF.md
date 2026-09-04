# Personal Cloudflare R2 Sync

## Goal

Keep the iPhone Obsidian vault fully local and fast while synchronizing actual vault files through Owen's own Cloudflare Worker and R2 bucket.

## Required behavior

1. `owen-brain` remains final SOT; `owen-mobile` is a selected mobile replica. The same plugin may run in both local vaults against one R2 namespace.
2. One authenticated Worker index request replaces per-file cloud metadata calls.
3. Worker uses an R2 binding and private bucket. Devices never receive R2 credentials.
4. Worker token stays in Obsidian SecretStorage and a Worker secret.
5. Three-way SHA-256 planning, preview approval, interruption journal, and conflict preservation remain mandatory.
6. Remote deletion is a conditional tombstone PUT. Physical canonical delete is forbidden in the sync path.
7. Transfers precede deletes.
8. All non-excluded file types synchronize as bytes.
9. Large files use multipart staging and conditional commit.
10. Mobile execution is foreground/startup/resume/manual/edit-debounce only.
11. Every replaced canonical revision is archived immutably before the conditional mutation. History list/restore is explicit, bounded, file-ID based, and never part of steady-state sync.
12. Restoring a version creates a new canonical revision after archiving the current one; stale, corrupt, cross-file, or moved-old-path restores fail closed.

## Non-goals

- Multi-user collaboration or public marketplace distribution.
- Reliable iOS background execution.
- Treating R2 as the only backup.
- Production deployment or vault mutation during code-only development.
