# Runtime architecture

The executable runtime is Gecko. The application owns local file selection, validation, storage, input and browser integration. Gecko owns PowerPC execution, GameCube hardware, DVD commands, DSP and GX. Its wgpu backend remains the renderer.

```text
Browser launcher
  local disc and firmware selection
  local validation and storage
  Gamepad/keyboard input and local settings
       |
Gecko WebAssembly in a dedicated worker
  synchronous random-access DVD adapter
  GameCube::with_ipl_hle
  PowerPC interpreter, hardware, DSP, GX
       |
WebGPU surface and AudioWorklet output
```

This diagram is the implementation direction, not a statement that these components have all been connected. The initial Gecko browser frontend uses a DOM window and winit on the main thread; moving execution into a worker also requires adapting its host code.

## Disc access

Gecko's `image::Dvd` trait supplies a header, apploader and synchronous reads into caller-provided buffers. Its current ISO implementation owns a complete `Vec<u8>`. The browser build caps linear memory at 512 MiB, so a full retail disc cannot use that path.

A worker-local reader can satisfy the synchronous trait through bounded `Blob.slice()` reads with `FileReaderSync`, or an OPFS synchronous access handle after local import. The reader stores only metadata and bounded read/cache buffers in WASM. It must report I/O failures without silently substituting data. The existing trait has no error return, which requires an explicit failure policy when adapting it.

For first boot, direct reads from the user-selected file avoid a full-disc import delay and an unnecessary second copy. OPFS adds persistence and predictable access after import, with quota and eviction handling. A full-disc `ArrayBuffer` is unsuitable under the observed memory limit. These choices must be tested using real browser APIs and measured memory consumption.

## Runtime and firmware

`GameCube::with_ipl_hle` reuses Gecko's disc boot implementation and executes the game's apploader. It does not require a Nintendo IPL dump. Gecko currently implements DSP execution rather than a DSP HLE backend, so its IROM and coefficient ROM inputs need locally supplied firmware. Zero-filled default firmware is not a valid compatibility result.

Gecko's browser crate disables the default JIT feature. Performance work begins with its PowerPC interpreter and profiles. Static recompilation is a later execution-backend investigation sharing Gecko's hardware interfaces, with differential tests against interpretation.

## Reference source

The Melee decompilation provides symbols, types, source behavior and debugging context. It targets the GameCube ABI and hardware. A native-source port needs separate work on operating-system services, graphics, audio, memory layout and compiler semantics. Its existing `TARGET_PC` static-library experiment is useful research but does not establish a working browser port.

## Milestones and evidence

The [issue sequence](https://github.com/frankischilling/melee-web/issues) covers validation, full-disc boot, random access, apploader, title screen, audio, input, persistence, launcher, local match and profiling. Browser rendering must be observed before calling title boot complete. Physical controller input, synchronized audio, a local match and persistent saves must be observed before calling the project playable. Synthetic tests verify host behavior and regressions; they do not substitute for those compatibility checks.
