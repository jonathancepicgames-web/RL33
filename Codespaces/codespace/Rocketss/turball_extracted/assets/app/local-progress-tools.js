const savePrefix = /^turball[.:]/i;
const excludedKey = /account|auth|token|playtime\.visitor/i;
const maxSaveBytes = 300 * 1024 * 1024;

function readRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Save data could not be read."));
  });
}

function openReplayDatabase() {
  if (!globalThis.indexedDB) throw new Error("Replay storage is unavailable in this browser.");
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("turball-replays", 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains("replays")) request.result.createObjectStore("replays", { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Replay storage could not be opened."));
  });
}

async function getSavedReplays() {
  const database = await openReplayDatabase();
  const transaction = database.transaction("replays", "readonly");
  const complete = new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error || new Error("Replay storage failed."));
    transaction.onabort = () => reject(transaction.error || new Error("Replay storage was interrupted."));
  });
  const rows = await readRequest(transaction.objectStore("replays").getAll());
  await complete;
  database.close();
  return rows;
}

async function replaceSavedReplays(rows) {
  const database = await openReplayDatabase();
  const transaction = database.transaction("replays", "readwrite");
  const complete = new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error || new Error("Replay storage failed."));
    transaction.onabort = () => reject(transaction.error || new Error("Replay import was interrupted."));
  });
  const store = transaction.objectStore("replays");
  store.clear();
  for (const row of rows) store.put(row);
  await complete;
  database.close();
}

async function blobToBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let start = 0; start < bytes.length; start += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
  }
  return btoa(binary);
}

function base64ToBlob(value, type) {
  const binary = atob(value);
  const parts = [];
  for (let start = 0; start < binary.length; start += 0x8000) {
    const chunk = binary.slice(start, start + 0x8000);
    const bytes = new Uint8Array(chunk.length);
    for (let index = 0; index < chunk.length; index += 1) bytes[index] = chunk.charCodeAt(index);
    parts.push(bytes);
  }
  return new Blob(parts, { type: String(type || "application/octet-stream").slice(0, 120) });
}

function currentStorage() {
  const storage = {};
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (key && savePrefix.test(key) && !excludedKey.test(key)) storage[key] = localStorage.getItem(key);
  }
  return storage;
}

async function exportSave() {
  const storage = currentStorage();
  if (!storage["turball.offline.v1"]) throw new Error("No local career save was found to export.");
  const rows = await getSavedReplays();
  const replays = await Promise.all(rows.map(async row => {
    const { blob, ...metadata } = row;
    if (!(blob instanceof Blob)) throw new Error("A saved replay could not be included in the backup.");
    return { ...metadata, blobBase64: await blobToBase64(blob), blobType: blob.type || "application/octet-stream" };
  }));
  const payload = { format: "turball-progress-save", version: 1, createdAt: new Date().toISOString(), storage, replays };
  const file = new Blob([JSON.stringify(payload)], { type: "application/json" });
  if (file.size > maxSaveBytes) throw new Error("Save file is larger than 300 MB.");
  const url = URL.createObjectURL(file);
  const link = document.createElement("a");
  link.href = url;
  link.download = `turball-progress-${new Date().toISOString().slice(0, 10)}.turball-save`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
  return { keys: Object.keys(storage).length, replays: replays.length };
}

async function importSave(file) {
  if (!file) throw new Error("Choose a Turball save file first.");
  if (file.size > maxSaveBytes) throw new Error("Save file is larger than 300 MB.");
  let payload;
  try { payload = JSON.parse(await file.text()); } catch { throw new Error("This file is not valid save data."); }
  if (payload?.format !== "turball-progress-save" || payload.version !== 1 || !payload.storage || typeof payload.storage !== "object" || Array.isArray(payload.storage)) {
    throw new Error("This is not a supported Turball save file.");
  }
  const rawCareer = payload.storage["turball.offline.v1"];
  if (typeof rawCareer !== "string") throw new Error("This save does not contain local career progress.");
  let career;
  try { career = JSON.parse(rawCareer); } catch { throw new Error("The save's career data is invalid."); }
  if (![1, 2].includes(career?.version)) throw new Error("The save uses an unsupported career format.");

  const incoming = Object.entries(payload.storage).filter(([key, value]) => savePrefix.test(key) && !excludedKey.test(key) && typeof value === "string");
  if (incoming.some(([key]) => key.length > 180)) throw new Error("The save contains an invalid storage key.");
  const replays = (Array.isArray(payload.replays) ? payload.replays : []).map(row => {
    if (!row || typeof row.id !== "string" || !/^[\w-]{1,100}$/.test(row.id) || typeof row.blobBase64 !== "string" || row.blobBase64.length > maxSaveBytes * 1.34) {
      throw new Error("The save contains an invalid replay entry.");
    }
    const { blobBase64, blobType, ...metadata } = row;
    return { ...metadata, blob: base64ToBlob(blobBase64, blobType) };
  });

  for (let index = localStorage.length - 1; index >= 0; index -= 1) {
    const key = localStorage.key(index);
    if (key && savePrefix.test(key) && !excludedKey.test(key)) localStorage.removeItem(key);
  }
  for (const [key, value] of incoming) localStorage.setItem(key, value);
  if (Array.isArray(payload.replays)) await replaceSavedReplays(replays);
  return { keys: incoming.length, replays: replays.length };
}

function saveLocalName(value) {
  const name = String(value || "").trim();
  if (!/^[A-Za-z0-9_]{3,24}$/.test(name)) throw new Error("Use 3–24 letters, numbers, or underscores for your name.");
  const career = JSON.parse(localStorage.getItem("turball.offline.v1") || "null");
  if (!career || ![1, 2].includes(career.version)) throw new Error("Local career data is unavailable.");
  career.name = name;
  localStorage.setItem("turball.offline.v1", JSON.stringify(career));
  return name;
}

window.turballLocalProgress = {
  getName() {
    try { return JSON.parse(localStorage.getItem("turball.offline.v1") || "null")?.name || "Driver"; } catch { return "Driver"; }
  },
  saveName: saveLocalName,
  export: exportSave,
  import: importSave,
};

const toolsStyle = document.createElement("style");
toolsStyle.textContent = `
  .local-save-tools{margin-top:20px;padding-top:16px;border-top:1px solid #355365;display:grid;gap:12px}
  .local-save-tools h2{margin:0;font-size:16px}.local-save-tools p{margin:0;color:#afc4ce;font-size:12px;line-height:1.5}
  .local-save-tools label{display:grid;gap:6px;color:#c9d9df;font-size:12px}.local-save-tools input[type=text]{min-width:0;padding:10px;border:1px solid #496879;border-radius:4px;background:#071923;color:#f4f8fa}
  .local-save-tools__actions{display:flex;flex-wrap:wrap;gap:8px}.local-save-tools__actions button,.local-save-tools__actions label{display:inline-flex;align-items:center;justify-content:center;min-height:38px;padding:0 12px;border:1px solid #56727d;border-radius:4px;background:#173846;color:#f2f7f5;font-weight:800;cursor:pointer}
  .local-save-tools__status{min-height:18px;color:#d9ec83;font-size:12px}.local-save-tools input[type=file]{display:none}
`;
document.head.append(toolsStyle);

function addProfileTools() {
  if (window.pilotState?.route !== "profile") return;
  const profile = document.querySelector("#screen .panel.compact");
  if (!profile || profile.querySelector("[data-local-save-tools]")) return;
  const tools = document.createElement("section");
  tools.className = "local-save-tools";
  tools.dataset.localSaveTools = "";
  tools.innerHTML = `
    <h2>LOCAL NAME AND SAVE</h2>
    <label>Player name<input type="text" data-local-name maxlength="24" minlength="3" autocomplete="off"></label>
    <div class="local-save-tools__actions"><button type="button" data-local-name-save>SAVE NAME</button><button type="button" data-save-export>EXPORT SAVE</button><label>IMPORT SAVE<input type="file" data-save-import accept=".turball-save,.json,application/json"></label></div>
    <p>Backup your local career, vehicles, settings, inventory, and saved replays.</p>
    <output class="local-save-tools__status" data-local-save-status role="status" aria-live="polite"></output>
  `;
  tools.querySelector("[data-local-name]").value = window.turballLocalProgress.getName();
  profile.after(tools);
}

function setToolsStatus(message) {
  const status = document.querySelector("[data-local-save-status]");
  if (status) status.textContent = message;
}

document.addEventListener("click", async event => {
  const saveNameButton = event.target.closest("[data-local-name-save]");
  if (saveNameButton) {
    try {
      const name = window.turballLocalProgress.saveName(document.querySelector("[data-local-name]")?.value);
      setToolsStatus(`Name saved as ${name}. Reloading…`);
      setTimeout(() => location.reload(), 500);
    } catch (error) {
      setToolsStatus(error.message);
    }
    return;
  }
  const exportButton = event.target.closest("[data-save-export]");
  if (!exportButton) return;
  exportButton.disabled = true;
  try {
    const result = await exportSave();
    setToolsStatus(`Exported ${result.keys} save items and ${result.replays} replays.`);
  } catch (error) {
    setToolsStatus(error.message);
  } finally {
    exportButton.disabled = false;
  }
});

document.addEventListener("change", async event => {
  const input = event.target.closest("[data-save-import]");
  if (!input || !input.files?.[0]) return;
  const file = input.files[0];
  if (!confirm("Import this save and replace local progress in this browser?")) {
    input.value = "";
    return;
  }
  input.disabled = true;
  try {
    const result = await importSave(file);
    setToolsStatus(`Imported ${result.keys} save items and ${result.replays} replays. Reloading…`);
    setTimeout(() => location.reload(), 500);
  } catch (error) {
    setToolsStatus(error.message);
  } finally {
    input.disabled = false;
    input.value = "";
  }
});

new MutationObserver(addProfileTools).observe(document.body, { childList: true, subtree: true });
addProfileTools();