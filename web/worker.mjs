import init, { WorkerRuntime } from "./runtime/gecko_web.js";
import { inspectLocalDisc, makeDiscReader } from "./disc.mjs";

let runtime;
let starting = false;
let paused = false;
let timer;
let nextFrame = 0;
let lastReport = 0;
let lastInputDelayMs = 0;

function fail(error) {
  clearTimeout(timer);
  paused = true;
  postMessage({
    type: "error",
    message: error instanceof Error ? error.message : String(error),
  });
  // A trapped WASM instance must never be resumed. The main thread terminates this worker.
  close();
}

function tick() {
  if (!runtime || paused) return;
  try {
    const completed = runtime.run_slice(16000);
    const now = performance.now();
    if (now - lastReport >= 250) {
      postMessage({
        type: "state",
        pc: runtime.pc(),
        lr: runtime.lr(),
        cpuSteps: runtime.instructions(),
        frames: runtime.frames(),
        inputDelayMs: lastInputDelayMs,
      });
      lastReport = now;
    }
    let delay = 0;
    if (completed) {
      nextFrame = Math.max(nextFrame + 1000 / 59.94, now - 1000 / 59.94);
      delay = Math.max(0, nextFrame - now);
    }
    timer = setTimeout(tick, delay);
  } catch (error) {
    fail(error);
  }
}

onmessage = async ({ data }) => {
  try {
    if (data.type === "start") {
      if (runtime || starting)
        throw new Error("This worker already owns a runtime");
      starting = true;
      paused = Boolean(data.paused);
      const report = await inspectLocalDisc(data.file);
      if (!report.dol.matchesExpected)
        throw new Error("The selected executable does not match Melee 1.02");
      globalThis.geckoReadDisc = makeDiscReader(data.file);
      await init();
      runtime = await WorkerRuntime.create(
        data.canvas,
        data.file.size,
        data.irom,
        data.coef,
      );
      postMessage({ type: "ready", diagnostic: !data.irom });
      nextFrame = performance.now();
      tick();
    } else if (data.type === "input" && runtime) {
      for (let port = 0; port < Math.min(4, data.pads.length); port++)
        runtime.set_pad(port, ...data.pads[port]);
      lastInputDelayMs = Math.max(
        0,
        performance.timeOrigin + performance.now() - data.sampledAt,
      );
    } else if (data.type === "pause") {
      clearTimeout(timer);
      paused = data.paused;
      nextFrame = performance.now();
      if (!paused && runtime) tick();
    }
  } catch (error) {
    fail(error);
  }
};
