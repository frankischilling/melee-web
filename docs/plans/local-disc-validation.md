# Local disc validation implementation plan

> **For agentic workers:** Use the executing-plans skill to implement this plan task by task. The parent task already authorizes inline execution in this isolated worktree.

**Goal:** Validate a local GALE01 revision 2 disc and optionally extract its main executable into ignored private storage.

**Architecture:** A Python standard library command reads bounded regions of the disc. It checks the disc header, DOL section layout, and FST tree before hashing the exact DOL span. Extraction separately checks the destination and uses exclusive creation.

**Tech stack:** Python 3.11+, argparse, hashlib, pathlib, struct, subprocess, unittest.

**Spec:** Parent task for issue #2: local GameCube/Melee disc validation, with synthetic tests and no published disc content.

## Constraints

- Never upload input or generated game data.
- Validation is read-only by default. Real extracted data stays under an ignored `.private` directory.
- Require GALE01, revision 2, disc number 0 and GameCube header magic.
- Check DOL section bounds and overlaps; check FST entries, directory parents, names and file extents.
- Hash only the DOL header and sections through the greatest section end. Report hash scope explicitly.
- Expected DOL SHA-1 is `08e0bf20134dfcb260699671004527b2d6bb1a45`.
- Synthetic tests contain no game bytes. No commits or pushes in this implementation task.

## Task 1: Bounded structural validation

Files: `tools/disc.py`, `tests/test_disc.py`.

Interface: `validate_disc(path, full_sha256=False)` returns a JSON-compatible dictionary. Malformed structures raise `DiscError`. A structurally valid but changed DOL returns a false hash-match field.

- [x] Build a small synthetic GALE01 image with one text section and a nested FST. Test valid metadata and exact DOL hashing.
- [x] Run `python -m unittest discover -s tests -v` and observe the missing validator failure.
- [x] Implement bounded reads, big-endian field decoding, header checks, DOL extents and FST validation.
- [x] Cover malformed magic/identity/revision/disc number, truncated regions, overlapping or out-of-range DOL sections, bad FST root/count/type/tree/name/file extents.
- [x] Run the tests and confirm green.

## Task 2: Private extraction and CLI

Files: `tools/disc.py`, `tests/test_disc.py`, `docs/local-disc.md`.

Interface: `extract_dol(path, output, private_root)` requires a matching DOL and creates only a new file below a resolved, Git-ignored `.private` directory. CLI: `python tools/disc.py IMAGE [--sha256] [--json] [--extract-dol OUTPUT --private-root ABSOLUTE_PATH]`.

- [x] Write tests for an ignored private destination, public destination rejection, overwrite rejection, symlink/junction alias rejection, and mismatching hash rejection.
- [x] Observe failures before implementing extraction.
- [x] Implement destination traversal checks, `git check-ignore`, exclusive creation and streaming copy. Implement concise JSON or text reports and nonzero failure status.
- [x] Run synthetic tests and read-only validation against the user's local image. Record only metadata and hashes.
- [x] Document commands, output scope, extraction constraints and verification evidence. Report files ready for parent review without committing.
