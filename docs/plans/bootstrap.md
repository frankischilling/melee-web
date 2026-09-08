# Repository audit and private-data boundary

The approved architecture runs local Melee software through Gecko. This first change establishes a source-only repository while independent audits determine the precise boot interfaces and build requirements. It addresses issue #1.

The project is split across `frankischilling/melee-web`, `frankischilling/gecko`, and `frankischilling/melee`. Runtime work belongs in Gecko when it can serve other games. Melee-specific importing and the browser host belong here.

## Work and verification

- [x] Inspect the account, configured identity, workspace, and requested skills.
- [x] Create the project and forks, with separate branches for implementation.
- [x] Move the supplied ISO into ignored `.private/discs/` without changing its contents.
- [x] Audit upstream source and record revisions, licenses, build evidence, and gaps.
- [x] Write synthetic tests for a publication check that rejects private paths, binary content, large files, symlinks, and unreviewed formats.
- [x] Run the tests before implementing `tools/publication.py`, then run them again after implementation.
- [x] Add CI running only source checks and synthetic tests. Do not upload artifacts.
- [x] Inspect the staged diff and source-only check, commit with configured identity, push, open a PR linked to #1, and inspect CI before merging. Completed in PR #15.

The checker reads Git blobs from the index or a commit, so an unstaged replacement cannot conceal staged content. It permits reviewed text-source formats only. This supplements manual review; it cannot establish the provenance of arbitrary text.

## Next independent change

Issue #2 adds bounded local disc validation and explicit private DOL extraction. It is developed in its own worktree and uses synthetic disc structures for automated tests. Real disc bytes and local reports stay outside Git.
