# GAS-File-Manipulation

A workspace of **Google Apps Script** projects for manipulating Google Drive files. Each
script lives in its own subdirectory with its own clasp config and README.

## Scripts

- [`Deduplicator/`](Deduplicator/README.md) — scans a Drive folder, finds duplicates by
  **content hash**, and trashes them. Bound to the **DuplicateFinder** Sheet.
- [`MergeGoogleFolders/`](MergeGoogleFolders/README.md) — recursively **merges** a source
  Drive folder tree into a destination, matching by **name** (newest wins), with a safe
  dry-run mode.

Full workspace documentation lives in [`_docs/README.md`](_docs/README.md). Shared
utilities (when added) live in [`_shared/`](_shared/README.md).
