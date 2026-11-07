import { c as Physics } from "./chunk-ZFRU76SJ.js";
import { U as BufferGeometry, ha as LineBasicMaterial, ia as ThreeLine, db as WebGLRenderer } from "./chunk-7BFMNA5N.js";

const lobbyRoutes = new Set(["private-menu", "private-lobby", "private-create", "private-join"]);
const gameRoutes = new Set(["training-hud", "match-hud"]);
const ballActions = new Map([["Digit1", "takePossession"], ["Digit2", "startDribble"], ["Digit3", "passBall"], ["Digit4", "launchBall"]]);
const rewindHistories = new WeakMap();
const ballMotion = new WeakMap();
const curveballModes = new Set(["curveball", "curveball-extreme"]);
const curveballStorageKey = "turball.curveball-mode.v1";
const rewindSampleTicks = 4;
const rewindTargetTicks = 240;
const rewindMaxBytes = 64 * 1024 * 1024;
let activePhysics = null;
let activeOfflinePhysics = null;
let trajectoryEnabled = false;
let trajectory;
let arcPoints = [];
let landingRing = [];

const route = () => window.pilotState?.route || document.body.dataset.screen || "";
const isTextTarget = target => target?.closest?.("input,textarea,select,[contenteditable=true],[role=textbox]");

function computeByteDiff(previous, current) {
  if (previous.length !== current.length) return null;
  const ranges = [];
  let start = -1;
  let lastChanged = -1;
  for (let index = 0; index < current.length; index += 1) {
    if (previous[index] !== current[index]) {
      if (start < 0) start = index;
      lastChanged = index;
    } else if (start >= 0 && index - lastChanged > 8) {
      ranges.push({ start, bytes: current.slice(start, lastChanged + 1) });
      start = -1;
    }
  }
  if (start >= 0) ranges.push({ start, bytes: current.slice(start, lastChanged + 1) });
  return ranges;
}

function applyByteDiff(heap, ranges) {
  for (const range of ranges) heap.set(range.bytes, range.start);
}

function createFrame(checkpoint, tick, heap) {
  return { version: checkpoint.version, wasmId: checkpoint.wasmId, carProfiles: checkpoint.carProfiles, tick, heap };
}

function promoteRewindBase(history) {
  const previous = history.frames.shift();
  const next = history.frames[0];
  const deltaSize = next.changes.reduce((size, range) => size + range.bytes.length + 8, 0);
  const heap = previous.heap.slice();
  applyByteDiff(heap, next.changes);
  delete next.changes;
  next.heap = heap;
  history.bytes -= deltaSize;
}

function captureRewindFrame(physics, ticks) {
  let history = rewindHistories.get(physics);
  if (history && history.handle !== physics.handle) history = null;
  if (!history) {
    const checkpoint = physics.captureCheckpoint();
    history = {
      handle: physics.handle,
      tick: 0,
      lastCaptureTick: 0,
      bytes: checkpoint.heap.length * 3,
      scratch: checkpoint,
      latestHeap: checkpoint.heap.slice(),
      frames: [createFrame(checkpoint, 0, checkpoint.heap.slice())],
    };
    rewindHistories.set(physics, history);
  }
  history.tick += ticks;
  if (history.tick - history.lastCaptureTick < rewindSampleTicks) return;
  history.lastCaptureTick = history.tick;
  const checkpoint = physics.captureCheckpoint(history.scratch);
  const changes = computeByteDiff(history.latestHeap, checkpoint.heap);
  if (!changes) return rewindHistories.delete(physics);
  history.frames.push({ ...createFrame(checkpoint, history.tick), changes });
  history.bytes += changes.reduce((size, range) => size + range.bytes.length + 8, 0);
  history.latestHeap.set(checkpoint.heap);
  while (history.frames.length > 1 && history.frames[1].tick <= history.tick - rewindTargetTicks) promoteRewindBase(history);
  while (history.bytes > rewindMaxBytes && history.frames.length > 1) promoteRewindBase(history);
  if (history.bytes > rewindMaxBytes) {
    history.frames = [createFrame(checkpoint, history.tick, checkpoint.heap.slice())];
    history.bytes = checkpoint.heap.length * 3;
  }
}

function statusMessage(message) {
  let output = document.querySelector("[data-game-status]");
  if (!output) {
    output = document.createElement("output");
    output.dataset.gameStatus = "";
    output.setAttribute("role", "status");
    Object.assign(output.style, { position: "fixed", left: "50%", bottom: "88px", transform: "translateX(-50%)", zIndex: "1200", padding: "8px 12px", border: "1px solid #6e9a43", borderRadius: "5px", background: "#091c27e8", color: "#f2f7e7", font: "700 12px/1.3 system-ui,sans-serif", pointerEvents: "none" });
    document.body.append(output);
  }
  output.textContent = message;
  output.hidden = false;
  clearTimeout(output.hideTimer);
  output.hideTimer = setTimeout(() => { output.hidden = true; }, 1800);
}

function rewindTwoSeconds() {
  const physics = activeOfflinePhysics;
  const history = physics && rewindHistories.get(physics);
  if (!history) return statusMessage("Rewind needs two seconds of offline play first");
  const targetTick = history.tick - rewindTargetTicks;
  if (targetTick < 0 || history.frames[0].tick > targetTick) return statusMessage("Rewind needs two seconds of offline play first");
  let targetIndex = 0;
  for (let index = 1; index < history.frames.length; index += 1) {
    if (history.frames[index].tick > targetTick) break;
    targetIndex = index;
  }
  const target = history.frames[targetIndex];
  const heap = history.frames[0].heap.slice();
  for (let index = 1; index <= targetIndex; index += 1) applyByteDiff(heap, history.frames[index].changes);
  try {
    physics.restoreCheckpoint({ version: target.version, wasmId: target.wasmId, carProfiles: target.carProfiles, heap });
    const checkpoint = physics.captureCheckpoint();
    history.frames.splice(targetIndex + 1);
    history.tick = target.tick;
    history.lastCaptureTick = target.tick;
    history.scratch = checkpoint;
    history.latestHeap = checkpoint.heap.slice();
    history.bytes = checkpoint.heap.length * 3 + history.frames.slice(1).reduce((total, frame) => total + frame.changes.reduce((size, range) => size + range.bytes.length + 8, 0), 0);
    statusMessage("Rewound 2 seconds");
  } catch (error) {
    rewindHistories.delete(physics);
    statusMessage("Could not restore this moment");
    console.warn("Training rewind failed", error);
  }
}

function makeTrajectoryUI() {
  try { trajectoryEnabled = localStorage.getItem("turball.ball-trajectory.v1") === "true"; } catch {}
  const button = document.createElement("button");
  button.type = "button";
  button.className = "ball-trajectory-toggle";
  button.textContent = `BALL ARC ${trajectoryEnabled ? "ON" : "OFF"}`;
  button.setAttribute("aria-pressed", String(trajectoryEnabled));
  const panel = document.createElement("section");
  panel.className = "ball-trajectory-panel";
  panel.hidden = !trajectoryEnabled;
  panel.innerHTML = '<header><strong>BALL ARC</strong><span data-trajectory-landing>WAITING FOR BALL</span></header><small>Live path to landing</small>';
  const style = document.createElement("style");
  style.textContent = `
    .ball-trajectory-toggle{position:fixed;top:16px;right:16px;z-index:1100;padding:8px 10px;border:1px solid #6c8c9a;border-radius:5px;background:#0b2531e8;color:#edf6f5;font:800 10px/1 system-ui,sans-serif;cursor:pointer}
    .ball-trajectory-toggle[hidden],.ball-trajectory-panel[hidden]{display:none}.ball-trajectory-toggle[aria-pressed=true]{border-color:#d6ec70;color:#e5f58a}
    .ball-trajectory-panel{position:fixed;top:54px;right:16px;z-index:1099;width:min(260px,calc(100vw - 32px));padding:8px;border:1px solid #3d6471;border-radius:6px;background:#071b29e8;color:#edf6f5;pointer-events:none}
    .ball-trajectory-panel header{display:flex;justify-content:space-between;align-items:center;margin:0 2px 4px;font:800 9px/1.2 system-ui,sans-serif}.ball-trajectory-panel header span{color:#d6ec70}
    .ball-trajectory-panel small{display:block;margin:4px 2px 2px;color:#b9c9cc;font:11px/1.3 system-ui,sans-serif}
    @media(max-width:600px){.ball-trajectory-toggle{top:12px;right:10px}.ball-trajectory-panel{top:48px;right:10px}}
  `;
  document.head.append(style);
  document.body.append(button, panel);
  button.addEventListener("click", () => {
    trajectoryEnabled = !trajectoryEnabled;
    button.textContent = `BALL ARC ${trajectoryEnabled ? "ON" : "OFF"}`;
    button.setAttribute("aria-pressed", String(trajectoryEnabled));
    panel.hidden = !trajectoryEnabled;
    try { localStorage.setItem("turball.ball-trajectory.v1", String(trajectoryEnabled)); } catch {}
    updateThreeArc();
  });
  return { button, panel, landing: panel.querySelector("[data-trajectory-landing]") };
}

function updateTrajectory(physics, ticks) {
  const inGame = gameRoutes.has(route());
  trajectory.button.hidden = !inGame;
  trajectory.panel.hidden = !inGame || !trajectoryEnabled;
  if (!inGame || !trajectoryEnabled) return;
  const ball = physics.ball;
  const previous = ballMotion.get(physics);
  const elapsed = Math.max(1, ticks) / 120;
  const measuredGravity = previous ? (ball.velocity[2] - previous.velocityZ) / elapsed : -650;
  const gravity = Number.isFinite(measuredGravity) && measuredGravity < -30 && measuredGravity > -6000
    ? previous ? previous.gravity * 0.75 + measuredGravity * 0.25 : measuredGravity
    : previous?.gravity ?? -650;
  ballMotion.set(physics, { velocityZ: ball.velocity[2], gravity });
  const radius = Math.max(1, physics.ballRadius || 90);
  const height = Math.max(0, ball.position[2] - radius);
  const root = Math.sqrt(Math.max(0, ball.velocity[2] ** 2 - 2 * gravity * height));
  const times = [(-ball.velocity[2] + root) / gravity, (-ball.velocity[2] - root) / gravity].filter(time => time > 0);
  const flightTime = Math.max(0.12, Math.min(3.2, times.length ? Math.min(...times) : 3.2));
  arcPoints = Array.from({ length: 33 }, (_, index) => {
    const time = flightTime * index / 32;
    return [ball.position[0] + ball.velocity[0] * time, ball.position[1] + ball.velocity[1] * time, Math.max(radius, ball.position[2] + ball.velocity[2] * time + gravity * time * time / 2)];
  });
  const end = arcPoints.at(-1);
  const ringRadius = Math.max(0.35, radius * 0.025);
  landingRing = Array.from({ length: 33 }, (_, index) => {
    const angle = index / 32 * Math.PI * 2;
    return [end[0] + Math.cos(angle) * ringRadius, end[1] + Math.sin(angle) * ringRadius, end[2] + 0.04];
  });
  trajectory.landing.textContent = `LANDING · ${flightTime.toFixed(1)}S`;
  updateThreeArc();
}

function selectedCurveballMode() {
  const playlist = window.turball?.snapshot?.config?.playlist;
  if (curveballModes.has(playlist)) return playlist;
  try {
    const stored = sessionStorage.getItem(curveballStorageKey);
    return curveballModes.has(stored) ? stored : null;
  } catch {
    return null;
  }
}

function applyCurveball(physics, ticks) {
  const mode = selectedCurveballMode();
  if (!mode) return;
  const ball = physics.ball;
  if (ball.position[2] <= physics.ballRadius + 60) return;
  for (let index = 0; index < physics.carProfiles.length; index += 1) {
    if (physics.ballContact(index)) return;
  }
  const [vx, vy, vz] = ball.velocity;
  const [wx, wy, wz] = ball.angularVelocity;
  const speed = Math.hypot(vx, vy, vz);
  const spin = Math.hypot(wx, wy, wz);
  if (speed < 100) return;
  const extreme = mode === "curveball-extreme";
  const baselineTurnRate = extreme ? 0.04 : 0.012;
  const spinTurnRate = extreme ? 0.18 : 0.055;
  const spinFactor = Math.min(1, spin / 8);
  const cross = [wy * vz - wz * vy, wz * vx - wx * vz, wx * vy - wy * vx];
  const crossLength = Math.hypot(...cross);
  const horizontalSpeed = Math.hypot(vx, vy);
  const sideSign = Math.sign(ball.position[0] + ball.position[1]) || 1;
  const timeStep = Math.max(1, ticks) / 120;
  let acceleration = [0, 0, 0];
  if (horizontalSpeed > 1) {
    acceleration[0] -= vy / horizontalSpeed * horizontalSpeed * baselineTurnRate * sideSign;
    acceleration[1] += vx / horizontalSpeed * horizontalSpeed * baselineTurnRate * sideSign;
  }
  if (crossLength > 1e-4 && spinFactor > 0 && spin > 1e-4) {
    const magnusAcceleration = spinTurnRate * spinFactor * crossLength / spin;
    acceleration = acceleration.map((value, axis) => value + cross[axis] / crossLength * magnusAcceleration);
  }
  physics.setBall({
    velocity: [vx + acceleration[0] * timeStep, vy + acceleration[1] * timeStep, vz + acceleration[2] * timeStep],
  }, false);
  physics.publish();
}

function setCurveballMode(mode) {
  try {
    if (curveballModes.has(mode)) sessionStorage.setItem(curveballStorageKey, mode);
    else sessionStorage.removeItem(curveballStorageKey);
  } catch {}
}

function addCurveballCards() {
  if (route() !== "extra-modes") return;
  const grid = document.querySelector("#screen .mode-grid");
  if (!grid || grid.querySelector("[data-curveball-mode]")) return;
  const template = grid.querySelector(".mode-tile:not([disabled])");
  if (!template) return;
  for (const [mode, title, description] of [
    ["curveball", "CURVEBALL", "Airborne shots bend hard through the arena."],
    ["curveball-extreme", "CURVEBALL EXTREME", "Airborne shots take a much sharper curve."],
  ]) {
    const card = template.cloneNode(true);
    card.removeAttribute("data-offline-playlist");
    card.dataset.curveballMode = mode;
    card.setAttribute("aria-label", `Play ${title.toLowerCase()} against bots`);
    card.querySelector(".mode-top span").textContent = "2v2";
    card.querySelector(".mode-bottom strong").textContent = title;
    card.querySelector(".mode-bottom small").textContent = description;
    grid.append(card);
  }
}

function updateThreeArc() {
  if (!trajectory?.line || !trajectoryEnabled || !trajectory.scene || arcPoints.length < 2) {
    if (trajectory?.line) trajectory.line.visible = false;
    if (trajectory?.landingLine) trajectory.landingLine.visible = false;
    return;
  }
  const Vector3 = trajectory.camera.position.constructor;
  trajectory.geometry.setFromPoints(arcPoints.map(point => new Vector3(point[0], point[2], point[1])));
  trajectory.geometry.computeBoundingSphere();
  trajectory.landingGeometry.setFromPoints(landingRing.map(point => new Vector3(point[0], point[2], point[1])));
  trajectory.landingGeometry.computeBoundingSphere();
  trajectory.line.visible = true;
  trajectory.landingLine.visible = true;
}

function detachTrajectory() {
  trajectory.line?.parent?.remove(trajectory.line);
  trajectory.landingLine?.parent?.remove(trajectory.landingLine);
  trajectory.scene = null;
  trajectory.camera = null;
}

function attachTrajectory(scene, camera) {
  if (trajectory.scene && trajectory.scene !== scene) detachTrajectory();
  trajectory.scene = scene;
  trajectory.camera = camera;
  if (!trajectory.line) {
    trajectory.geometry = new BufferGeometry();
    trajectory.material = new LineBasicMaterial({ color: 0xf3f6e8, linewidth: 2, transparent: true, opacity: 0.96, depthTest: true, depthWrite: false });
    trajectory.line = new ThreeLine(trajectory.geometry, trajectory.material);
    trajectory.line.name = "turball-live-ball-arc";
    trajectory.line.frustumCulled = false;
    trajectory.landingGeometry = new BufferGeometry();
    trajectory.landingMaterial = new LineBasicMaterial({ color: 0xff9a62, linewidth: 2, depthTest: true, depthWrite: false });
    trajectory.landingLine = new ThreeLine(trajectory.landingGeometry, trajectory.landingMaterial);
    trajectory.landingLine.name = "turball-live-ball-landing";
    trajectory.landingLine.frustumCulled = false;
  }
  if (trajectory.line.parent !== scene) scene.add(trajectory.line);
  if (trajectory.landingLine.parent !== scene) scene.add(trajectory.landingLine);
  updateThreeArc();
}

trajectory = makeTrajectoryUI();
const originalStep = Physics.prototype.step;
Physics.prototype.step = function (ticks) {
  const result = originalStep.call(this, ticks);
  activePhysics = gameRoutes.has(route()) ? this : null;
  if (!activePhysics || !Number.isInteger(ticks) || ticks <= 0) {
    rewindHistories.delete(this);
    if (activeOfflinePhysics === this) activeOfflinePhysics = null;
    return result;
  }
  updateTrajectory(this, ticks);
  if (window.turball?.snapshot?.config?.network === true) {
    activeOfflinePhysics = null;
    rewindHistories.delete(this);
  } else {
    activeOfflinePhysics = this;
    applyCurveball(this, ticks);
    captureRewindFrame(this, ticks);
  }
  return result;
};

const originalRender = WebGLRenderer.prototype.render;
WebGLRenderer.prototype.render = function (scene, camera) {
  if (gameRoutes.has(route()) && scene?.isScene && camera?.isPerspectiveCamera) attachTrajectory(scene, camera);
  else if (trajectory.scene && scene === trajectory.scene) detachTrajectory();
  return originalRender.call(this, scene, camera);
};

window.turballExperience = {
  controlBall(code) {
    const action = ballActions.get(code);
    const snapshot = window.turball?.snapshot;
    if (!action || !activePhysics) return false;
    const index = snapshot?.localPlayerIndex ?? snapshot?.roster?.find(player => player.local)?.index ?? 0;
    const changed = activePhysics.controlBall(index, action);
    if (changed) activePhysics.publish();
    return changed;
  },
};

window.addEventListener("keydown", event => {
  if (event.code !== "KeyR" || event.repeat || isTextTarget(event.target) || !gameRoutes.has(route())) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  if (window.turball?.snapshot?.config?.network === true) return statusMessage("Rewind is unavailable in online matches");
  rewindTwoSeconds();
}, true);

const chat = createChatPanel();
window.addEventListener("click", event => {
  const customMode = event.target.closest?.("[data-curveball-mode]");
  if (customMode) {
    setCurveballMode(customMode.dataset.curveballMode);
    customMode.dataset.offlinePlaylist = "doubles";
    return;
  }
  if (event.target.closest?.("[data-offline-playlist], [data-route='casual'], [data-route='competitive'], [data-game-action='start-private']")) setCurveballMode("");
}, true);
const appScreen = document.querySelector("#screen");
if (appScreen) new MutationObserver(addCurveballCards).observe(appScreen, { childList: true, subtree: true });
addCurveballCards();
window.addEventListener("keydown", event => {
  if (event.repeat || isTextTarget(event.target) || (!gameRoutes.has(route()) && !lobbyRoutes.has(route()))) return;
  if (event.code === "KeyY") {
    event.preventDefault();
    event.stopImmediatePropagation();
    chat.openText();
  } else if (event.code === "KeyT") {
    event.preventDefault();
    event.stopImmediatePropagation();
    chat.toggleQuick();
  }
}, true);

function createChatPanel() {
  const panel = document.createElement("section");
  panel.className = "local-lobby-chat";
  panel.hidden = true;
  panel.setAttribute("aria-label", "Game chat");
  panel.innerHTML = `
    <header><strong>GAME CHAT</strong><span data-chat-status>Connecting…</span></header>
    <div class="local-lobby-chat__messages" aria-live="polite"></div>
    <nav class="local-lobby-chat__quick" hidden>
      <button type="button" data-lobby-quick="Nice shot!">Nice shot!</button>
      <button type="button" data-lobby-quick="Great pass!">Great pass!</button>
      <button type="button" data-lobby-quick="Ready when you are.">Ready when you are.</button>
      <button type="button" data-lobby-quick="Good game!">Good game!</button>
    </nav>
    <form><input maxlength="180" autocomplete="off" aria-label="Chat message" placeholder="Type a message"><button type="submit" aria-label="Send message">SEND</button></form>
  `;
  const style = document.createElement("style");
  style.textContent = `
    .local-lobby-chat{position:fixed;right:20px;bottom:72px;z-index:1000;width:min(360px,calc(100vw - 32px));padding:12px;border:1px solid #477184;border-radius:8px;background:#071b29ed;color:#f1f7fa;box-shadow:0 12px 38px #0008;font:13px/1.4 system-ui,sans-serif}
    .local-lobby-chat[hidden]{display:none}.local-lobby-chat header{display:flex;justify-content:space-between;gap:12px;align-items:center;margin-bottom:8px}.local-lobby-chat header strong{font-size:11px;letter-spacing:.08em}.local-lobby-chat header span{color:#9fc4d2;font-size:11px}
    .local-lobby-chat__messages{height:180px;overflow:auto;display:flex;flex-direction:column;gap:5px;padding:4px 0}.local-lobby-chat__messages p{margin:0;overflow-wrap:anywhere}.local-lobby-chat__messages b{color:#d8ec73;margin-right:6px}
    .local-lobby-chat form{display:flex;gap:6px}.local-lobby-chat input{flex:1;min-width:0;padding:9px;border:1px solid #355a6d;border-radius:5px;background:#06131d;color:inherit}.local-lobby-chat button{padding:7px 10px;border:0;border-radius:5px;background:#d8ec73;color:#15251d;font-weight:800;cursor:pointer}
    .local-lobby-chat__quick{display:grid;grid-template-columns:1fr 1fr;gap:5px;padding-bottom:8px}.local-lobby-chat__quick[hidden]{display:none}.local-lobby-chat__quick button{background:#183747;color:#e8f4f8;border:1px solid #355a6d}
    @media(max-width:600px){.local-lobby-chat{right:12px;bottom:64px}}
  `;
  document.head.append(style);
  document.body.append(panel);
  const messages = panel.querySelector(".local-lobby-chat__messages");
  const status = panel.querySelector("[data-chat-status]");
  const input = panel.querySelector("input");
  const quickMenu = panel.querySelector(".local-lobby-chat__quick");
  let socket = null;
  let connectedRoom = "";
  let textOpen = false;

  function roomName() {
    const params = new URLSearchParams(location.search);
    const party = params.get("party") || params.get("room") || window.pilotState?.inviteParams?.party || window.turballPortal?.state?.inviteParams?.party;
    if (party) return `party:${party}`;
    if (!gameRoutes.has(route())) return "";
    const snapshot = window.turball?.snapshot;
    const roster = (snapshot?.roster || []).map(player => `${player.team}:${player.name}`).sort().join("|");
    return `match:${snapshot?.config?.roomId || snapshot?.roomId || snapshot?.config?.queue || "game"}:${snapshot?.config?.playlist || "mode"}:${snapshot?.arena || "arena"}:${roster}`;
  }

  function addMessage(sender, text) {
    const row = document.createElement("p");
    const label = document.createElement("b");
    label.textContent = `${String(sender || "Driver").slice(0, 24)}:`;
    row.append(label, document.createTextNode(String(text || "").slice(0, 180)));
    messages.append(row);
    while (messages.childElementCount > 40) messages.firstElementChild.remove();
    messages.scrollTop = messages.scrollHeight;
  }

  function connect() {
    const room = roomName().slice(0, 128);
    if (!room) {
      status.textContent = "Join a party to chat";
      return;
    }
    if (room === connectedRoom) return;
    connectedRoom = room;
    socket?.close();
    socket = new WebSocket(`${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}`);
    status.textContent = "Connecting…";
    socket.addEventListener("open", () => {
      let playerId = crypto.randomUUID();
      try {
        playerId = localStorage.getItem("turball.lobby-chat-id") || playerId;
        localStorage.setItem("turball.lobby-chat-id", playerId);
      } catch {}
      let name = "Driver";
      try { name = window.turballLocalProgress?.getName?.() || "Driver"; } catch {}
      socket.send(JSON.stringify({ type: "join-room", room, playerId, name, team: "blue" }));
    });
    socket.addEventListener("message", event => {
      let payload;
      try { payload = JSON.parse(event.data); } catch { return; }
      if (payload.type === "chat") addMessage(payload.name, payload.message);
      if (payload.type === "room-joined") status.textContent = `CONNECTED · ${payload.room}`;
    });
    socket.addEventListener("close", () => { status.textContent = "Disconnected"; });
    socket.addEventListener("error", () => { status.textContent = "Chat unavailable"; });
  }

  function send(text) {
    const message = String(text || "").trim().replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 180);
    if (message && socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "chat", message }));
  }

  function sync() {
    const active = lobbyRoutes.has(route()) || gameRoutes.has(route());
    const nextHidden = !active || (!textOpen && quickMenu.hidden);
    if (panel.hidden !== nextHidden) panel.hidden = nextHidden;
    if (active) connect();
    else {
      textOpen = false;
      quickMenu.hidden = true;
    }
  }

  panel.querySelector("form").addEventListener("submit", event => {
    event.preventDefault();
    send(input.value);
    input.value = "";
    input.focus();
  });
  panel.querySelectorAll("[data-lobby-quick]").forEach(button => button.addEventListener("click", () => {
    send(button.dataset.lobbyQuick);
    quickMenu.hidden = true;
    textOpen = false;
    sync();
  }));
  panel.addEventListener("keydown", event => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    quickMenu.hidden = true;
    textOpen = false;
    input.blur();
    sync();
  });
  const screen = document.querySelector("#screen");
  if (screen) new MutationObserver(sync).observe(screen, { childList: true, subtree: true });
  return {
    openText() { textOpen = true; quickMenu.hidden = true; sync(); input.focus(); },
    toggleQuick() { textOpen = false; quickMenu.hidden = !quickMenu.hidden; sync(); if (!quickMenu.hidden) quickMenu.querySelector("button")?.focus(); },
  };
}