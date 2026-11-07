import { i as loadBindings, j as saveBindings } from "./chunk-THKRGFUV.js";

const bindings = loadBindings();
const keyboard = bindings.keyboard;
const changes = [
  ["boost", [{ kind: "mouse", button: 0 }, { kind: "key", code: "KeyK" }, { kind: "key", code: "Semicolon" }], [{ kind: "key", code: "ShiftLeft" }]],
  ["jump", [{ kind: "mouse", button: 2 }, { kind: "key", code: "KeyL" }, { kind: "key", code: "Quote" }], [{ kind: "key", code: "Space" }]],
  ["powerslide", [{ kind: "key", code: "ShiftLeft" }, { kind: "key", code: "ShiftRight" }], [{ kind: "key", code: "ShiftRight" }]],
  ["airRoll", [{ kind: "key", code: "ShiftLeft" }, { kind: "key", code: "ShiftRight" }], []],
  ["ballCam", [{ kind: "key", code: "Space" }], [{ kind: "mouse", button: 0 }]],
  ["skipReplay", [{ kind: "mouse", button: 2 }, { kind: "key", code: "Space" }], [{ kind: "mouse", button: 2 }]],
];
let changed = false;

for (const [action, previous, next] of changes) {
  if (JSON.stringify(keyboard[action]) !== JSON.stringify(previous)) continue;
  keyboard[action] = next;
  changed = true;
}

if (changed) saveBindings(bindings);

const actionKeys = new Map([["Digit1", "takePossession"], ["Digit2", "startDribble"], ["Digit3", "passBall"], ["Digit4", "launchBall"]]);
window.addEventListener("keydown", event => {
  if (event.repeat || !actionKeys.has(event.code) || !["training-hud", "match-hud"].includes(window.pilotState?.route)) return;
  if (!window.turballExperience?.controlBall(event.code)) return;
  event.preventDefault();
  event.stopImmediatePropagation();
}, true);