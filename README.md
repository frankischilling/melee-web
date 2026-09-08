# Melee Web

Melee Web is a browser runtime project for a locally owned NTSC-U Super Smash Bros. Melee 1.02 disc. Gecko supplies the GameCube runtime and WebGPU renderer. The Melee decompilation supplies symbols and behavior references.

The project is under development. Browser boot, audio, and playable performance have not yet been verified. No game or console firmware is included.

## Repositories

- [Application and integration](https://github.com/frankischilling/melee-web)
- [Gecko runtime fork](https://github.com/frankischilling/gecko), tracking [ioncodes/gecko](https://github.com/ioncodes/gecko)
- [Melee research fork](https://github.com/frankischilling/melee), tracking [doldecomp/melee](https://github.com/doldecomp/melee)

The name `melee-web` describes the integration directly and keeps runtime changes separate from the decompilation.

Project code is available under [GPL-3.0](LICENSE). The Melee source and upstream dependencies have their own licensing terms; this repository grants no rights to game data or firmware.

## Local development

Use Python 3.11 or newer for repository tools. Runtime build requirements are recorded with the upstream audit.

```sh
python -m unittest discover -s tests -v
python -m compileall -q tools tests
python tools/publication.py --staged
```

Put user-owned discs in `.private/discs/`, firmware in `.private/system/`, extraction in `.private/extracted/`, and runtime output in `.private/runtime/`. All of `.private/` is ignored. Do not serve the repository root with a static web server; serve the application build directory only.

Read [the private-data policy](docs/private-data.md) before working with a disc or runtime capture. Current work is tracked through [issues](https://github.com/frankischilling/melee-web/issues).
