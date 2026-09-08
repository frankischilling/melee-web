import { inspectLocalDisc } from "./disc.mjs";
import { keyboardPad, standardPad } from "./controls.mjs";

const byId = (id) => document.getElementById(id);
const status = byId("status");
const keys = new Set();
let selected;
let generation = 0;
let worker;
let launching = false;
let paused = false;
let inputFrame;

function stop(
  message = "Runtime stopped. Select Launch to start a new session.",
) {
  worker?.terminate();
  worker = undefined;
  launching = false;
  cancelAnimationFrame(inputFrame);
  keys.clear();
  paused = false;
  byId("launch").disabled = !selected;
  byId("stop").disabled = byId("pause").disabled = true;
  byId("pause").textContent = "Pause";
  byId("disc").disabled = false;
  status.textContent = message;
}

byId("disc").addEventListener("change", async (event) => {
  const current = ++generation;
  selected = undefined;
  byId("launch").disabled = true;
  const file = event.target.files[0];
  if (!file) return;
  status.textContent =
    "Checking disc structure and the Melee executable locally…";
  try {
    const report = await inspectLocalDisc(file);
    if (current !== generation) return;
    if (!report.dol.matchesExpected)
      throw new Error(
        `Executable mismatch: ${report.dol.sha1}. Select a supported Melee 1.02 image.`,
      );
    selected = file;
    byId("launch").disabled = false;
    status.textContent = `Validated GALE01 revision 2. ${report.fst.files} files; executable SHA-1 matches. Disc assets have not been authenticated.`;
  } catch (error) {
    if (current === generation) status.textContent = error.message;
  }
});

async function firmware(id, size) {
  const file = byId(id).files[0];
  if (!file || file.size !== size)
    throw new Error(
      `Select a locally supplied ${size}-byte ${id === "irom" ? "DSP ROM" : "coefficient ROM"}.`,
    );
  return new Uint8Array(await file.arrayBuffer());
}

function sendInput() {
  if (!worker) return;
  const connected = navigator.getGamepads?.() ?? [];
  const pads = Array.from({ length: 4 }, (_, port) =>
    standardPad(connected[port]),
  );
  const keyboard = keyboardPad(keys);
  pads[0][0] |= keyboard[0];
  for (const axis of [1, 2, 3, 4])
    if (keyboard[axis] !== 128) pads[0][axis] = keyboard[axis];
  pads[0][5] = Math.max(pads[0][5], keyboard[5]);
  pads[0][6] = Math.max(pads[0][6], keyboard[6]);
  pads[0][7] = true;
  worker.postMessage({
    type: "input",
    pads,
    sampledAt: performance.timeOrigin + performance.now(),
  });
  inputFrame = requestAnimationFrame(sendInput);
}

byId("launcher").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!selected || worker || launching) return;
  const disc = selected;
  launching = true;
  byId("launch").disabled = true;
  byId("disc").disabled = true;
  try {
    if (!navigator.gpu)
      throw new Error(
        "WebGPU is unavailable. Use a supported desktop browser with hardware acceleration.",
      );
    const diagnostic = byId("diagnostic").checked;
    const irom = diagnostic ? undefined : await firmware("irom", 8192);
    const coef = diagnostic ? undefined : await firmware("coef", 4096);
    const canvas = document.createElement("canvas");
    canvas.width = 640;
    canvas.height = 480;
    canvas.tabIndex = 0;
    canvas.setAttribute("aria-label", "GameCube video output");
    byId("screen").replaceChildren(canvas);
    const offscreen = canvas.transferControlToOffscreen();
    worker = new Worker("./worker.mjs", { type: "module" });
    const session = worker;
    paused = document.hidden;
    byId("pause").textContent = paused ? "Resume" : "Pause";
    worker.onmessage = ({ data }) => {
      if (worker !== session) return;
      if (data.type === "error") stop(`Runtime error: ${data.message}`);
      if (data.type === "ready") {
        status.textContent = data.diagnostic
          ? "Diagnostic execution started. It will stop when DSP firmware is required."
          : "Gecko execution started. Audio output and save persistence are not connected.";
        byId("pause").disabled = false;
        if (document.hidden) {
          paused = true;
          worker.postMessage({ type: "pause", paused: true });
          byId("pause").textContent = "Resume";
        } else {
          canvas.focus();
        }
        sendInput();
      }
      if (data.type === "state")
        byId("metrics").textContent =
          `PC 0x${data.pc.toString(16).padStart(8, "0")}  LR 0x${data.lr.toString(16).padStart(8, "0")}\nCPU steps ${data.cpuSteps.toLocaleString()}  VI boundaries ${data.frames.toLocaleString()}\nLatest input dispatch delay ${data.inputDelayMs.toFixed(1)} ms (not end-to-end latency)`;
    };
    worker.onerror = (event) => {
      event.preventDefault();
      if (worker !== session) return;
      stop(`Worker failed: ${event.message}`);
    };
    worker.postMessage(
      {
        type: "start",
        file: disc,
        canvas: offscreen,
        irom,
        coef,
        paused,
      },
      [offscreen],
    );
    byId("stop").disabled = false;
    byId("disc").disabled = true;
    status.textContent = "Initializing the local disc, Gecko and WebGPU…";
  } catch (error) {
    stop(error.message);
  }
});

byId("stop").addEventListener("click", () => stop());
byId("pause").addEventListener("click", () => {
  paused = !paused;
  worker?.postMessage({ type: "pause", paused });
  byId("pause").textContent = paused ? "Resume" : "Pause";
});
window.addEventListener("keydown", (event) => {
  if (!worker || event.target.tagName !== "CANVAS") return;
  event.preventDefault();
  keys.add(event.code);
});
window.addEventListener("keyup", (event) => keys.delete(event.code));
window.addEventListener("blur", () => keys.clear());
document.addEventListener("visibilitychange", () => {
  if (document.hidden && worker) {
    keys.clear();
    paused = true;
    worker.postMessage({ type: "pause", paused: true });
    byId("pause").textContent = "Resume";
  }
});
