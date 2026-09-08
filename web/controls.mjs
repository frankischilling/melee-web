const DEADZONE = 0.12;
const neutral = (connected = false) => [0, 128, 128, 128, 128, 0, 0, connected];
const pressure = (value) =>
  Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));

function axis(value) {
  const finite = Number.isFinite(value) ? value : 0;
  const magnitude = Math.abs(finite);
  if (magnitude <= DEADZONE) return 128;
  const normalized =
    Math.sign(finite) * Math.min(1, (magnitude - DEADZONE) / (1 - DEADZONE));
  return Math.round(128 + normalized * (normalized < 0 ? 128 : 127));
}

export function standardPad(gamepad) {
  if (!gamepad?.connected || gamepad.mapping !== "standard") return neutral();
  const state = neutral(true);
  const buttons = gamepad.buttons ?? [];
  for (const [index, mask] of [
    [0, 0x100],
    [2, 0x200],
    [1, 0x400],
    [3, 0x800],
    [9, 0x1000],
    [5, 0x10],
    [12, 8],
    [13, 4],
    [14, 1],
    [15, 2],
  ]) {
    if (buttons[index]?.pressed) state[0] |= mask;
  }
  const axes = gamepad.axes ?? [];
  state[1] = axis(axes[0]);
  state[2] = axis(-axes[1]);
  state[3] = axis(axes[2]);
  state[4] = axis(-axes[3]);
  state[5] = Math.round(pressure(buttons[6]?.value) * 255);
  state[6] = Math.round(pressure(buttons[7]?.value) * 255);
  if (pressure(buttons[6]?.value) >= 0.9) state[0] |= 0x40;
  if (pressure(buttons[7]?.value) >= 0.9) state[0] |= 0x20;
  return state;
}

export function keyboardPad(keys) {
  const state = neutral(true);
  const direction = (positive, negative) =>
    keys.has(positive) === keys.has(negative)
      ? 128
      : keys.has(positive)
        ? 255
        : 0;
  state[1] = direction("ArrowRight", "ArrowLeft");
  state[2] = direction("ArrowUp", "ArrowDown");
  state[3] = direction("Numpad6", "Numpad4");
  state[4] = direction("Numpad8", "Numpad2");
  for (const [key, mask] of [
    ["KeyX", 0x100],
    ["KeyZ", 0x200],
    ["KeyC", 0x400],
    ["KeyV", 0x800],
    ["Enter", 0x1000],
    ["KeyD", 0x10],
    ["KeyA", 0x40],
    ["KeyS", 0x20],
    ["KeyI", 8],
    ["KeyK", 4],
    ["KeyJ", 1],
    ["KeyL", 2],
  ]) {
    if (keys.has(key)) state[0] |= mask;
  }
  state[5] = keys.has("KeyA") ? 255 : 0;
  state[6] = keys.has("KeyS") ? 255 : 0;
  return state;
}
