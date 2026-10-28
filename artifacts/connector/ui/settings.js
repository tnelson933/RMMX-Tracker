// RM Connect window script. Kept in a file so the page CSP can forbid inline
// scripts. Device-reported values (tag IDs, machine IDs, hostnames) are
// untrusted: everything is written with textContent, never innerHTML.
const $ = (id) => document.getElementById(id);
const api = window.connector;

const MODEL = {
  impinj: "Impinj R700",
  zebra: "Zebra RFID",
  generic: "RFID reader",
  active_transponder: "RM TrackR",
};
const FOUND_HIGHLIGHT_MS = 6_000;

let status = null;
const cards = new Map(); // readerId → { el, f: fields, settingsLoaded }

function fmtAgo(iso) {
  if (!iso) return "";
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return s + "s ago";
  if (s < 3600) return Math.round(s / 60) + "m ago";
  return new Date(iso).toLocaleTimeString();
}

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else node.setAttribute(k, v);
  }
  for (const child of children) if (child) node.append(child);
  return node;
}

// ── Top-level view ──────────────────────────────────────────────────────────

function render(st) {
  status = st;
  // Asked to sign in again: show the sign-in card above the readers, which keep timing.
  $("loginCard").classList.toggle("hidden", st.signedIn && !st.signInRequired);
  $("signInReason").textContent = st.signInRequired || "";
  $("mainView").classList.toggle("hidden", !st.signedIn);
  if (!st.signedIn) return;
  $("txtAccount").textContent = "Signed in as " + st.email;
  $("identifyBanner").classList.toggle("hidden", !st.identifying);
  $("btnIdentify").classList.toggle("hidden", st.identifying || st.readers.length === 0);
  renderReaders(st.readers);
}

function renderReaders(readers) {
  const list = $("readers");
  const seen = new Set();
  for (const r of readers) {
    seen.add(r.readerId);
    let card = cards.get(r.readerId);
    if (!card) {
      card = createCard(r.readerId);
      cards.set(r.readerId, card);
    }
    list.append(card.el); // keeps order in step with the reader list
    updateCard(card, r);
  }
  for (const [id, card] of cards) {
    if (!seen.has(id)) { card.el.remove(); cards.delete(id); }
  }
  if (readers.length === 0) {
    if (!$("emptyState")) {
      list.append(el("div", { class: "card empty", id: "emptyState" },
        el("div", { text: "No readers on this laptop yet." }),
        el("div", { text: "Power on your reader, connect this laptop to the same network, then click Find readers." })));
    }
    if ($("findCard").classList.contains("hidden") && !autoFindDone) { autoFindDone = true; openFind(); }
  } else {
    $("emptyState")?.remove();
  }
}

// ── Reader cards ────────────────────────────────────────────────────────────

function createCard(readerId) {
  const el = $("tplReader").content.firstElementChild.cloneNode(true);
  const f = {};
  el.querySelectorAll("[data-f]").forEach(n => { f[n.dataset.f] = n; });
  const card = { el, f, readerId, settingsLoaded: false, renaming: false };
  el.querySelectorAll("[data-a]").forEach(btn => btn.addEventListener("click", () => onCardAction(card, btn.dataset.a, btn)));
  f.renameInput.addEventListener("keydown", e => {
    if (e.key === "Enter") onCardAction(card, "saveName");
    if (e.key === "Escape") onCardAction(card, "cancelName");
  });
  return card;
}

function statusText(r) {
  const where = r.hardwareAddress ? " at " + r.hardwareAddress : "";
  switch (r.state) {
    case "connecting": return "Connecting" + where + "…";
    case "reconnecting": return "Can't reach the reader" + where + (r.reconnectInSeconds != null ? " — retrying in " + r.reconnectInSeconds + "s" : "");
    case "race_active": return "Timing " + (r.activeMoto ? r.activeMoto.name : "a moto");
    case "testing": return "Testing";
    case "connected_idle": return (r.device.ready ? "Ready" : "Connected") + where + " — waiting for a moto to start";
    case "error": return "Needs attention";
    default: return "Not connected" + where;
  }
}

function updateCard(card, r) {
  const { f, el: root } = card;
  const ok = r.device.connected && r.cloud.connected && (r.hardware !== "active_transponder" || r.device.ready || r.state === "connected_idle");
  f.dot.className = "dot " + (ok ? "on" : r.state === "connecting" || r.state === "reconnecting" ? "wait" : r.device.connected ? "wait" : "off");
  f.name.textContent = r.readerName;
  f.model.textContent = MODEL[r.hardware] || "Reader";
  f.status.textContent = statusText(r);

  if (r.hardware === "active_transponder" && r.device.connected) {
    // The RM TrackR reports each loop as 1/0 (or a word on some firmware).
    const loop = (state) => !state ? "waiting" : /^1$|working|running|open/i.test(state) ? "running" : /^0$|stop|closed/i.test(state) ? "off" : state;
    f.checks.textContent = (r.device.machineId ? "ID " + r.device.machineId : "Waiting for the RM TrackR to identify itself")
      + " · Loop 1 " + loop(r.device.loop1State) + " · Loop 2 " + loop(r.device.loop2State);
  } else if (r.hardware !== "active_transponder" && r.device.connected && r.device.antennaIds.length) {
    f.checks.textContent = "Antennas seen: " + r.device.antennaIds.join(", ");
  } else {
    f.checks.textContent = "";
  }

  f.reads.textContent = r.device.readCount
    ? r.device.readCount + " read" + (r.device.readCount === 1 ? "" : "s") + " · last " + fmtAgo(r.device.lastReadAt)
      + (r.pendingCrossings ? " · " + r.pendingCrossings + " waiting to send" : "")
    : (r.pendingCrossings ? r.pendingCrossings + " crossings waiting to send" : "");

  // A problem the organizer can act on vs. an informational note.
  const problem = r.device.error || (!r.cloud.connected ? r.device.diagnosis : "");
  f.problem.textContent = problem || "";
  f.note.textContent = !problem && r.hardware === "active_transponder" && r.device.connected && !r.device.ready && r.device.diagnosis ? r.device.diagnosis : "";

  const found = r.identifiedAt && Date.now() - new Date(r.identifiedAt).getTime() < FOUND_HIGHLIGHT_MS;
  root.classList.toggle("found", !!found);
  f.thisOne.classList.toggle("hidden", !found);

  root.querySelector('[data-a="settings"]').classList.toggle("hidden", r.hardware !== "active_transponder");
  const testBtn = root.querySelector('[data-a="test"]');
  testBtn.classList.toggle("hidden", r.testMode);
  testBtn.disabled = !r.device.connected;
  testBtn.title = r.device.connected ? "Check that reads reach RM Roost" : "Connect the reader first";

  f.testPanel.classList.toggle("hidden", !r.testMode && r.testProgress !== "confirmed" && r.testProgress !== "unresolved");
  f.testMsg.textContent = r.testMessage || (r.hardware === "active_transponder" ? "Walk an RM TrackR Transponder over either loop." : "Hold a tag near an antenna.");
  f.testMsg.classList.toggle("ok", r.testProgress === "confirmed");
  f.readList.replaceChildren(...r.recentReads.map(read => el("div", { class: "read" },
    el("span", { class: "tag mono", text: read.tag }),
    read.antennaId != null ? el("span", { class: "meta", text: "antenna " + read.antennaId }) : null,
    read.rssi != null ? el("span", { class: "meta", text: read.rssi + " dBm" }) : null,
    el("span", { class: "meta", text: fmtAgo(read.at) }))));

  if (!card.renaming) f.renameInput.value = r.readerName;
  card.status = r;
}

async function onCardAction(card, action, btn) {
  const r = card.status;
  const { f } = card;
  f.actionErr.textContent = "";
  if (action === "rename") {
    card.renaming = true;
    f.renameRow.classList.remove("hidden");
    f.renameInput.value = r.readerName;
    f.renameInput.focus();
    f.renameInput.select();
  } else if (action === "cancelName") {
    card.renaming = false;
    f.renameRow.classList.add("hidden");
  } else if (action === "saveName") {
    const res = await api.renameReader(r.readerId, f.renameInput.value);
    if (!res.ok) { f.actionErr.textContent = res.error; return; }
    card.renaming = false;
    f.renameRow.classList.add("hidden");
  } else if (action === "test") {
    await api.testReader(r.readerId, true);
  } else if (action === "endTest") {
    await api.testReader(r.readerId, false);
    f.testPanel.classList.add("hidden");
  } else if (action === "reconnect") {
    btn.disabled = true;
    const res = await api.reconnectReader(r.readerId);
    btn.disabled = false;
    if (!res.ok) f.actionErr.textContent = res.error;
  } else if (action === "remove") {
    if (!confirm(`Remove "${r.readerName}" from this laptop?\n\nIt stays registered in RM Roost, and you can add it back with Find readers.`)) return;
    await api.removeReader(r.readerId);
  } else if (action === "settings") {
    const open = f.settingsPanel.classList.toggle("hidden") === false;
    if (open) {
      const cfg = (await api.getSettings()).readers.find(x => x.readerId === r.readerId);
      const at = cfg?.activeTiming || { channel: 0, power: 100, loop1Enabled: true, loop2Enabled: true };
      f.channel.value = at.channel; f.power.value = at.power;
      f.loop1.checked = at.loop1Enabled; f.loop2.checked = at.loop2Enabled;
    }
  } else if (action === "applySettings" || action === "syncClock") {
    f.settingsErr.textContent = "";
    const res = await api.configureReader(r.readerId, {
      channel: parseInt(f.channel.value, 10),
      power: parseInt(f.power.value, 10),
      loop1Enabled: f.loop1.checked,
      loop2Enabled: f.loop2.checked,
      syncClock: action === "syncClock",
    });
    f.settingsErr.textContent = res.ok ? "" : res.error;
  }
}

// ── Find readers ────────────────────────────────────────────────────────────

let autoFindDone = false;
let cloudReaders = [];

function openFind() {
  $("findCard").classList.remove("hidden");
  $("errFind").textContent = "";
  runScan();
}

async function loadCloudReaders() {
  const res = await api.listCloudReaders();
  cloudReaders = res.ok ? res.readers : [];
  if (!res.ok) $("errFind").textContent = res.error;
}

async function runScan() {
  $("findResults").replaceChildren();
  $("findStatus").replaceChildren(el("span", { class: "spinner" }), document.createTextNode(" Searching this laptop's network for readers…"));
  $("btnRescan").disabled = true;
  const [res] = await Promise.all([api.scanNetwork(), loadCloudReaders()]);
  $("btnRescan").disabled = false;
  if (!res.ok) {
    $("findStatus").textContent = "";
    $("errFind").textContent = res.error;
    return;
  }
  showDevices(res.devices, res.devices.length
    ? `Found ${res.devices.length} reader${res.devices.length === 1 ? "" : "s"}.`
    : "No readers found on this laptop's network.");
}

function showDevices(devices, summary) {
  $("findStatus").textContent = summary;
  $("findResults").replaceChildren(...devices.map(deviceRow));
}

function deviceRow(d) {
  const title = (MODEL[d.hardware] || "Reader") + " at " + d.address;
  const box = el("div", { class: "device" },
    el("div", { class: "device-title", text: title }),
    d.hostname && d.hostname !== d.address ? el("div", { class: "muted", text: d.hostname }) : null);

  if (d.inUseBy) {
    box.append(el("div", { class: "muted ok", text: "Already added as “" + d.inUseBy + "”." }));
    return box;
  }

  const isActive = d.hardware === "active_transponder";
  const sameType = cloudReaders.filter(r => !r.onThisLaptop && (r.type === "active_transponder") === isActive);
  const select = el("select");
  select.append(el("option", { value: "", text: "A new reader in RM Roost" }));
  for (const r of sameType) select.append(el("option", { value: String(r.id), text: "Existing: " + r.name }));
  if (d.registeredReaderId && sameType.some(r => r.id === d.registeredReaderId)) select.value = String(d.registeredReaderId);

  const name = el("input", { placeholder: isActive ? "e.g. Finish line" : "e.g. Finish line or Section 3 start", maxlength: "60" });
  const nameWrap = el("div", {}, el("label", { text: "Name it after where it sits on the course" }), name);
  const sync = () => nameWrap.classList.toggle("hidden", !!select.value);
  select.addEventListener("change", sync);
  sync();

  const err = el("div", { class: "err" });
  const add = el("button", { text: "Add reader" });
  add.addEventListener("click", async () => {
    add.disabled = true;
    add.textContent = "Adding…";
    err.textContent = "";
    const res = await api.addReader({
      address: d.address,
      hardware: d.hardware,
      readerId: select.value ? Number(select.value) : null,
      name: name.value,
    });
    add.disabled = false;
    add.textContent = "Add reader";
    if (!res.ok) { err.textContent = res.error; return; }
    box.replaceChildren(el("div", { class: "device-title", text: title }), el("div", { class: "muted ok", text: "Added. It's connecting below." }));
  });

  box.append(el("label", { text: "Add as" }), select, nameWrap, el("div", { class: "row", style: "margin-top:8px;" }, add), err);
  return box;
}

$("btnFind").addEventListener("click", openFind);
$("btnRescan").addEventListener("click", runScan);
$("btnCloseFind").addEventListener("click", () => $("findCard").classList.add("hidden"));
$("btnCheckAddress").addEventListener("click", async () => {
  const address = $("inManualAddress").value.trim();
  $("errFind").textContent = "";
  if (!address) { $("errFind").textContent = "Enter an IP address or the 6 characters from the Impinj label."; return; }
  $("btnCheckAddress").disabled = true;
  $("findStatus").replaceChildren(el("span", { class: "spinner" }), document.createTextNode(" Checking " + address + "…"));
  const [res] = await Promise.all([api.probeAddress(address), loadCloudReaders()]);
  $("btnCheckAddress").disabled = false;
  if (!res.ok) { $("findStatus").textContent = ""; $("errFind").textContent = res.error; return; }
  showDevices(res.devices, "Found a reader at " + address + ".");
});
$("inManualAddress").addEventListener("keydown", e => { if (e.key === "Enter") $("btnCheckAddress").click(); });

// ── Identify ────────────────────────────────────────────────────────────────

$("btnIdentify").addEventListener("click", () => api.setIdentifying(true));
$("btnStopIdentify").addEventListener("click", () => api.setIdentifying(false));

// ── Sign in / out ───────────────────────────────────────────────────────────

$("btnLogin").addEventListener("click", async () => {
  $("errLogin").textContent = "";
  if (!$("inEmail").value.trim() || !$("inPassword").value) {
    $("errLogin").textContent = "Enter your organizer email and password.";
    return;
  }
  $("btnLogin").disabled = true;
  $("btnLogin").textContent = "Signing in…";
  const res = await api.login({ cloudUrl: $("inCloudUrl").value, email: $("inEmail").value, password: $("inPassword").value });
  $("btnLogin").disabled = false;
  $("btnLogin").textContent = "Sign in";
  if (!res.ok) { $("errLogin").textContent = res.error; return; }
  $("inPassword").value = "";
  render(await api.getStatus());
});

for (const id of ["inCloudUrl", "inEmail", "inPassword"]) {
  $(id).addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !$("btnLogin").disabled) $("btnLogin").click();
  });
}

$("btnLogout").addEventListener("click", async () => {
  if (!confirm("Sign out? Readers on this laptop stop sending reads until you sign in and add them again.")) return;
  await api.logout();
  location.reload();
});

// ── Init ────────────────────────────────────────────────────────────────────

async function init() {
  const s = await api.getSettings();
  if (s.cloudUrl) $("inCloudUrl").value = s.cloudUrl;
  if (s.email) $("inEmail").value = s.email;
  render(await api.getStatus());
  api.onStatus(render);
}
init();
