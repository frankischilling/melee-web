# Local disc validation

`tools/disc.py` checks a local uncompressed GameCube ISO/GCM for Melee's US revision 2 (`GALE01`, NTSC 1.02). It uses Python 3.11 or newer and the standard library. Validation does not write or upload game data.

From the repository root:

```powershell
python tools/disc.py .private/discs/melee-ntsc-1.02.iso
python tools/disc.py .private/discs/melee-ntsc-1.02.iso --json --sha256
```

The command checks GameCube header magic, game ID, revision and disc number. It checks DOL section file bounds, file and memory overlaps, entry point and BSS address overflow. It checks FST root, entry count, directory parent/end indices, filename offsets and terminators, and file bounds and overlaps with other files and system regions. Zero-length files may point to the end of the image.

Reads are bounded to 1 MiB. The FST is read entry by entry, with a 16 MiB table limit and a 4,096-byte filename scan limit. File extents are retained for overlap checks; the image is never loaded into memory as a whole. These are structural checks for this revision, not a general disc repair or authenticity tool. The apploader, file payloads, padding and unused sectors are not authenticated.

The DOL SHA-1 covers bytes from its header through the greatest `section_offset + section_size`, including gaps in that span. The expected SHA-1 is `08e0bf20134dfcb260699671004527b2d6bb1a45`. A match identifies that executable span; it does not establish full-disc authenticity. `--sha256` streams the whole image to produce a separate SHA-256 fingerprint, with no reference-image comparison.

Exit status is 0 for valid structure and a matching DOL, 1 for a mismatch or validation/extraction failure, and 2 for invalid command arguments. A structurally valid image with a changed DOL still produces metadata and its actual hash, then exits 1.

## Optional private extraction

Extraction requires Git on `PATH`, an existing absolute directory named `.private`, and a new output path below it. Both the root and output must pass local `git check-ignore` checks. The following PowerShell command resolves the repository's private root:

```powershell
$privateStorage = (Resolve-Path .private).Path
python tools/disc.py .private/discs/melee-ntsc-1.02.iso --extract-dol "$privateStorage/extracted/GALE01/main.dol" --private-root "$privateStorage"
```

For an isolated worktree, use an explicit absolute `--private-root` pointing at the main repository's ignored `.private` directory and an output below that root.

Extraction requires the expected DOL hash. It rejects public destinations, existing files, input collisions, parent traversal, ambiguous trailing dots/spaces, alternate data streams, symlinks, junctions and other reparse points in the destination path. It creates the file exclusively and verifies the copied bytes' SHA-1. An interrupted or failed copy is removed when the command can handle the error. The destination directories must remain under the user's control; path checks do not provide isolation from concurrent hostile filesystem changes or forced process termination.

The tool extracts only `main.dol`. It does not extract the FST or game assets. Keep outputs under `.private`; never use real disc content as a committed test fixture.

## Tests and local verification

```powershell
python -m unittest discover -s tests -v
```

The tests build small synthetic images. Extraction tests temporarily substitute the expected hash with the synthetic DOL's hash, exercise real filesystem and Git ignore checks, and remove their temporary files. On Windows they use a directory junction if symlink creation is unavailable. An interruption test checks that Ctrl+C removes a partially created output. No game bytes are included in the tests.

Local verification on September 7, 2026 reported:

| Field | Result |
| --- | --- |
| Game ID / revision / disc | `GALE01` / `2` / `0` |
| Image size | 1,459,978,240 bytes |
| DOL offset / exact span | 124,928 / 4,425,184 bytes |
| DOL sections | 10 |
| DOL SHA-1 | `08e0bf20134dfcb260699671004527b2d6bb1a45` |
| FST entries / files / directories | 1,212 / 1,209 / 3 |
| Full ISO SHA-256 | `0de05981a34156b9cedcef73c73d4244ac05cf6149ab3c9cfed917698819e464` |

These are metadata and local fingerprints only. The image and extracted executable remain private.
