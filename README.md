# GAS-File-Manipulation

Workspace holding several **Google Apps Script** projects for manipulating Google Drive
files. Each script lives in its own subdirectory with its own clasp config and README —
run `clasp pull` / `clasp push` from **inside** the relevant subdirectory.

## Scripts

| Subdirectory | What it does | Details |
|--------------|--------------|---------|
| [`Deduplicator/`](Deduplicator/README.md) | Recursively scans a Drive folder, finds duplicate files by **content hash**, and moves duplicates to Trash. Bound to the **DuplicateFinder** Sheet. | [README](Deduplicator/README.md) |
| [`MergeGoogleFolders/`](MergeGoogleFolders/README.md) | Recursively **merges** a source Drive folder tree into a destination, matching by **name** (newest wins). Has a safe dry-run mode. | [README](MergeGoogleFolders/README.md) |

## Notes

- Each subdirectory has its own `.clasp.json` (its own `scriptId`) and `.claspignore`.
  clasp commands must be run from within that subdirectory.
- clasp is authenticated globally via `~/.clasprc.json` (git-ignored — never commit it;
  it holds OAuth tokens).
- See each subproject's README for setup, usage, and the container Sheet requirements.
