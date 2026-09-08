import assert from "node:assert/strict";
import test from "node:test";
import { keyboardPad, standardPad } from "../web/controls.mjs";

test("standard mappings preserve both sticks and analog trigger pressure", () => {
  const buttons = Array.from({ length: 17 }, () => ({
    pressed: false,
    value: 0,
  }));
  buttons[0] = { pressed: true, value: 1 };
  buttons[6] = { pressed: true, value: 0.5 };
  buttons[7] = { pressed: true, value: 0.95 };
  const pad = standardPad({
    connected: true,
    mapping: "standard",
    axes: [1, -1, -1, 1],
    buttons,
  });
  assert.deepEqual(pad.slice(1, 7), [255, 255, 0, 0, 128, 242]);
  assert.equal(pad[0] & 0x100, 0x100);
  assert.equal(pad[0] & 0x40, 0);
  assert.equal(pad[0] & 0x20, 0x20);
});

test("deadzone, missing values and disconnection yield neutral input", () => {
  const pad = standardPad({
    connected: true,
    mapping: "standard",
    axes: [0.02, NaN],
    buttons: [],
  });
  assert.deepEqual(pad, [0, 128, 128, 128, 128, 0, 0, true]);
  assert.equal(standardPad(null).at(-1), false);
  assert.equal(standardPad({ connected: true, mapping: "" }).at(-1), false);
});

test("keyboard opposing directions cancel and release returns to center", () => {
  assert.equal(keyboardPad(new Set(["ArrowLeft", "ArrowRight"]))[1], 128);
  assert.equal(keyboardPad(new Set(["ArrowUp"]))[2], 255);
  assert.equal(keyboardPad(new Set())[2], 128);
  assert.equal(keyboardPad(new Set(["Enter", "KeyX"]))[0], 0x1100);
});

test("numpad directions map to the C-stick without moving the main stick", () => {
  for (const [key, expected] of [
    ["Numpad4", [0, 128]],
    ["Numpad6", [255, 128]],
    ["Numpad8", [128, 255]],
    ["Numpad2", [128, 0]],
  ]) {
    const pad = keyboardPad(new Set([key]));
    assert.deepEqual(pad.slice(3, 5), expected, key);
    assert.deepEqual(pad.slice(0, 3), [0, 128, 128]);
  }
});

test("opposing numpad directions cancel independently on each C-stick axis", () => {
  assert.deepEqual(
    keyboardPad(new Set(["Numpad4", "Numpad6", "Numpad8"])).slice(3, 5),
    [128, 255],
  );
  assert.deepEqual(
    keyboardPad(new Set(["Numpad8", "Numpad2", "Numpad4"])).slice(3, 5),
    [0, 128],
  );
});

test("releasing numpad keys restores the held direction and then neutral", () => {
  const keys = new Set(["Numpad4", "Numpad6", "Numpad8", "Numpad2"]);
  assert.deepEqual(keyboardPad(keys).slice(3, 5), [128, 128]);
  keys.delete("Numpad4");
  keys.delete("Numpad2");
  assert.deepEqual(keyboardPad(keys).slice(3, 5), [255, 255]);
  keys.delete("Numpad6");
  keys.delete("Numpad8");
  assert.deepEqual(keyboardPad(keys).slice(3, 5), [128, 128]);
});
