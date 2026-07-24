# GAS-File-Manipulation

A workspace of **Google Apps Script** projects for manipulating Google Drive files. Each
script lives in its own subdirectory with its own clasp config and README.

## Scripts

- [`Deduplicator/`](Deduplicator/README.md) — scans a Drive folder, finds duplicates by
  **content hash** (Drive's own md5, no downloads), and trashes them. Bound to the
  **DuplicateFinder** Sheet, which also stores the scan checkpoint and results.
- [`MergeGoogleFolders/`](MergeGoogleFolders/README.md) — recursively **merges** a source
  Drive folder tree into a destination, matching by **name** (newest wins), with a safe
  dry-run mode.

Full workspace documentation lives in [`_docs/README.md`](_docs/README.md). Shared
utilities (when added) live in [`_shared/`](_shared/README.md).
