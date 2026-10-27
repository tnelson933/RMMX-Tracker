// RM Connect settings window script. Kept in a file so the page CSP can
// forbid inline scripts.
const $ = (id) => document.getElementById(id);
const api = window.connector;
let currentStatus = null;

// ── View state ──────────────────────────────────────────────────────────────
// Tracks which panel is active so periodic status pushes don't clobber the
// setup card while the user is mid-configuration.
// 'login' | 'setup' | 'status'
let view = 'login';

function showView(v) {
  view = v;
  $("loginCard").classList.toggle("hidden", v !== 'login');
  $("setupCard").classList.toggle("hidden", v !== 'setup');
  $("statusCard").classList.toggle("hidden", v !== 'status');
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function fmtAgo(iso) {
  if (!iso) return "";
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 5) return "just now";
  if (s < 60) return s + "s ago";
  return Math.round(s / 60) + "m ago";
}

// ── Status rendering ────────────────────────────────────────────────────────
 // Keep an explicitly opened setup panel open while live status updates
 // arrive. Otherwise a configured reader would immediately switch back to
 // the status panel while the user is editing device settings.

function renderStatus(st) {
  currentStatus = st;
  $("btnLogout").classList.toggle("hidden", !st.email);

   if (st.configured && view !== 'setup') {
    showView('status');
  } else if (!st.email) {
    showView('login');
  }
  // else: signed in but not configured — leave view as-is

  if (view !== 'status') return;

  $("dotCloud").className = "dot " + (st.cloud.connected ? "on" : "off");
  $("txtCloud").textContent = "Cloud: " + (st.cloud.connected ? "connected" : (st.cloud.error || "disconnected"));
  $("dotDevice").className = "dot " + (st.device.connected ? "on" : "off");
  const hwName = st.hardware === "impinj" ? "Impinj R700"
    : st.hardware === "zebra" ? "Zebra reader"
    : st.hardware === "generic" ? "LLRP reader"
    : "F2000 active timing";
  const deviceDetail = st.device.detail ? " — " + st.device.detail : "";
  let stateLabel = {
    connecting: "connecting", reconnecting: "reconnecting" + (st.reconnect.secondsUntilAttempt !== null ? " (retry in " + st.reconnect.secondsUntilAttempt + "s)" : ""),
    connected_idle: "connected, idle", testing: "testing", race_active: "race active", error: "needs attention", disconnected: "disconnected"
  }[st.state] || "disconnected";
  if ((st.state === "testing" || st.state === "race_active") && st.hardware === "active_transponder" && !st.device.ready) stateLabel += " — device pending";
  $("txtDevice").textContent = hwName + ": " + stateLabel + deviceDetail;
  if (st.activeMoto) {
    $("dotMoto").className = "dot on";
    $("txtMoto").textContent = "Racing — " + st.activeMoto.name;
  } else if (st.testMode || st.testProgress === "confirmed" || st.testProgress === "unresolved") {
    $("dotMoto").className = "dot on";
    $("txtMoto").textContent = "Test — " + (st.testMessage || "waiting for a real tag read");
  } else {
    $("dotMoto").className = "dot";
    $("txtMoto").textContent = "Idle — waiting for a moto to start";
  }
  $("txtReads").textContent = st.device.readCount
    ? st.device.readCount + " reads · last " + fmtAgo(st.device.lastReadAt)
    : "No reads yet";
  $("chkTest").checked = st.testMode;
  $("activeTimingChecklist").classList.toggle("hidden", st.hardware !== "active_transponder");
   $("btnActiveTimingSettings").classList.add("hidden");
   $("activeTimingManagedNotice").classList.toggle("hidden", st.hardware !== "active_transponder");
  if (st.hardware === "active_transponder") {
    // Device-reported values (machine ID, loop states) are untrusted: build the
    // label with DOM nodes and textContent, never innerHTML.
    const setCheck = (id, ready, label, detail) => {
      const el = $(id); el.classList.toggle("ready", !!ready);
      const bold = document.createElement("b");
      bold.textContent = label;
      el.querySelector("span:last-child").replaceChildren(bold, document.createTextNode(" — " + detail));
    };
    setCheck("checkTransport", st.device.connected, "Network transport", (st.device.connected ? "connected" : "check IP, same network, and TCP 55555"));
    setCheck("checkMachine", st.device.transportReady && st.device.heartbeatFresh, "Machine & heartbeat", (st.device.machineId ? st.device.machineId + (st.device.heartbeatFresh ? " reporting" : " heartbeat is stale") : "waiting for F2000 identification"));
    setCheck("checkLoops", st.device.ready, "Finish-gate loops 1 / 2", (st.device.loop1State || "pending") + " / " + (st.device.loop2State || "pending") + (st.device.ready ? " (same finish gate)" : " (not ready yet)"));
    setCheck("checkCloud", st.cloud.connected, "Cloud registration", (st.cloud.connected ? "connected" : "cloud disconnected; verify internet and reader registration"));
  }
  $("errStatus").textContent = st.device.diagnosis || "";

}

// ── Status-view reader picker ────────────────────────────────────────────────

let statusReadersCache = [];

function populateStatusReaders(readers, currentId) {
  statusReadersCache = readers || [];
  const sel = $("selReaderStatus");
  sel.innerHTML = "";
  if (!statusReadersCache.length) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "No readers found — create one in the web app";
    sel.appendChild(opt);
  } else {
    for (const r of statusReadersCache) {
      const opt = document.createElement("option");
      opt.value = r.id;
      opt.textContent = r.name + " (" + r.type + ")";
      if (currentId && r.id === currentId) opt.selected = true;
      sel.appendChild(opt);
    }
  }
}

async function openReaderPicker() {
  $("errSwitch").textContent = "";
  $("readerPickerWrap").classList.remove("hidden");
  // Load fresh reader list from cloud
  const s = await api.getSettings();
  const res = await api.listReaders();
  if (res.ok) populateStatusReaders(res.readers || [], s.readerId);
  else $("errSwitch").textContent = res.error || "Could not load readers";
}

function closeReaderPicker() {
  $("readerPickerWrap").classList.add("hidden");
  $("errSwitch").textContent = "";
}

$("btnChangeReader").addEventListener("click", openReaderPicker);
$("btnCancelSwitch").addEventListener("click", closeReaderPicker);

$("btnSwitchReader").addEventListener("click", async () => {
  $("errSwitch").textContent = "";
  const readerId = parseInt($("selReaderStatus").value, 10);
  if (!readerId) { $("errSwitch").textContent = "Select a reader first"; return; }
  $("btnSwitchReader").disabled = true;
  $("btnSwitchReader").textContent = "Switching…";
  const s = await api.getSettings();
  const selectedReader = statusReadersCache.find((r) => r.id === readerId);
  const res = await api.connect({
    readerId,
    hardware: s.hardware,
    hardwareAddress: selectedReader?.hardwareAddress || s.hardwareAddress,
  });
  $("btnSwitchReader").disabled = false;
  $("btnSwitchReader").textContent = "Switch";
  if (!res.ok) { $("errSwitch").textContent = res.error; return; }
  $("errStatus").textContent = "";
  closeReaderPicker();
  refresh();
});

// ── Reader list ─────────────────────────────────────────────────────────────

let readersCache = [];

function populateReaders(readers, selectedId) {
  readersCache = readers || [];
  const sel = $("selReader");
  sel.innerHTML = "";
  for (const r of readersCache) {
    const opt = document.createElement("option");
    opt.value = r.id;
    opt.textContent = r.name + " (" + r.type + ")";
    if (selectedId && r.id === selectedId) opt.selected = true;
    sel.appendChild(opt);
  }
  if (!readersCache.length) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "No readers yet — create one on Reader Setup in the web app";
    sel.appendChild(opt);
  }
  autofillFromReader();
}

function autofillFromReader() {
  const reader = readersCache.find((r) => String(r.id) === $("selReader").value);
  if (!reader) return;
  if (reader.type === "active_transponder") {
    $("selHardware").value = "active_transponder";
    $("selHardware").dispatchEvent(new Event("change"));
  }
  if (reader.hardwareAddress) {
    $("inAddress").value = reader.hardwareAddress;
  }
}

$("selReader").addEventListener("change", autofillFromReader);

$("selHardware").addEventListener("change", () => {
  const hw = $("selHardware").value;
  if (hw === "impinj") {
    $("lblAddress").textContent = "Last 6 of reader MAC address";
    $("inAddress").placeholder = "e.g. 16-25-B2";
    $("hintAddress").textContent = "Printed on the reader label — we connect via impinj-XX-XX-XX.local";
  } else if (hw === "zebra" || hw === "generic") {
    $("lblAddress").textContent = "Reader IP address or hostname";
    $("inAddress").placeholder = "e.g. 192.168.1.50";
    $("hintAddress").textContent = "Find it in your router's device list — the reader must have LLRP enabled";
  } else {
    $("lblAddress").textContent = "F2000 IP address (or IP:port)";
    $("inAddress").placeholder = "e.g. 192.168.1.50 or 192.168.1.50:55555";
    $("hintAddress").textContent = "Enter the F2000 network address. TCP port 55555 is used by default; enter IP:port only if your device uses a different port.";
  }
  const isActiveTiming = hw === "active_transponder";
  $("setupTitle").textContent = isActiveTiming ? "Guided F2000 active timing connection" : "RFID hardware setup";
  $("activeTimingSetupGuide").classList.toggle("hidden", !isActiveTiming);
  $("activeTimingControls").classList.add("hidden");
});

function activeTimingInput(syncClock) {
  return {
    channel: parseInt($("selActiveTimingChannel").value, 10),
    power: parseInt($("inActiveTimingPower").value, 10),
    loop1Enabled: $("chkLoop1").checked,
    loop2Enabled: $("chkLoop2").checked,
    syncClock: !!syncClock,
  };
}

async function applyActiveTiming(syncClock) {
  $("errActiveTiming").textContent = "";
  const res = await api.configureHardware(activeTimingInput(syncClock));
  if (!res.ok) $("errActiveTiming").textContent = res.error || "Unable to apply active timing settings";
  else refresh();
}
$("btnApplyActiveTiming").addEventListener("click", () => applyActiveTiming(false));
$("btnSyncClock").addEventListener("click", () => applyActiveTiming(true));

// ── Button handlers ─────────────────────────────────────────────────────────

$("btnLogin").addEventListener("click", async () => {
  $("errLogin").textContent = "";
  $("btnLogin").disabled = true;
  const res = await api.login({
    cloudUrl: $("inCloudUrl").value,
    email: $("inEmail").value,
    password: $("inPassword").value,
  });
  $("btnLogin").disabled = false;
  if (!res.ok) { $("errLogin").textContent = res.error; return; }
  showView('setup');
  $("btnLogout").classList.remove("hidden");
  populateReaders(res.readers || []);
});

$("btnConnect").addEventListener("click", async () => {
  $("errSetup").textContent = "";
  const readerId = parseInt($("selReader").value, 10);
  if (!readerId) { $("errSetup").textContent = "Select or create a reader first"; return; }
  if (!$("inAddress").value.trim()) { $("errSetup").textContent = "Enter the hardware address"; return; }
  $("btnConnect").disabled = true;
  $("btnConnect").textContent = "Connecting…";
  const res = await api.connect({
    readerId,
    hardware: $("selHardware").value,
    hardwareAddress: $("inAddress").value,
  });
  $("btnConnect").disabled = false;
  $("btnConnect").textContent = "Save & Connect";
  if (!res.ok) { $("errSetup").textContent = res.error; return; }
  showView('status');
  refresh();
});

$("btnDisconnect").addEventListener("click", async () => {
  await api.disconnect();
  const s = await api.getSettings();
  const res = await api.listReaders();
  if (res.ok) populateReaders(res.readers || [], s.readerId);
  if (s.hardware) $("selHardware").value = s.hardware;
  if (s.hardwareAddress) $("inAddress").value = s.hardwareAddress;
   $("selActiveTimingChannel").value = String(s.activeTimingChannel ?? 0);
   $("inActiveTimingPower").value = String(s.activeTimingPower ?? 100);
   $("chkLoop1").checked = s.activeTimingLoop1Enabled !== false;
   $("chkLoop2").checked = s.activeTimingLoop2Enabled !== false;
  $("selHardware").dispatchEvent(new Event("change"));
  showView('setup');
});

$("btnActiveTimingSettings").addEventListener("click", async () => {
  const s = await api.getSettings();
  const res = await api.listReaders();
  if (res.ok) populateReaders(res.readers || [], s.readerId);
  if (s.hardware) $("selHardware").value = s.hardware;
  if (s.hardwareAddress) $("inAddress").value = s.hardwareAddress;
  $("selActiveTimingChannel").value = String(s.activeTimingChannel ?? 0);
  $("inActiveTimingPower").value = String(s.activeTimingPower ?? 100);
  $("chkLoop1").checked = s.activeTimingLoop1Enabled !== false;
  $("chkLoop2").checked = s.activeTimingLoop2Enabled !== false;
  $("selHardware").dispatchEvent(new Event("change"));
  showView("setup");
});

$("btnReconnect").addEventListener("click", async () => {
  $("errStatus").textContent = "";
  const s = await api.getSettings();
  const res = await api.connect({
    readerId: s.readerId,
    hardware: s.hardware,
    hardwareAddress: s.hardwareAddress,
  });
  if (!res.ok) {
    $("errStatus").textContent = res.error;
    if (res.error && res.error.toLowerCase().includes("no longer exists")) {
      openReaderPicker();
    }
  }
});

$("chkTest").addEventListener("change", async () => {
  const res = await api.toggleTest($("chkTest").checked);
  if (!res.ok) { $("errStatus").textContent = res.error; $("chkTest").checked = false; }
});

$("btnLogout").addEventListener("click", async () => {
  if (!confirm("Sign out and clear all saved settings?")) return;
  await api.logout();
  location.reload();
});

// ── Init ────────────────────────────────────────────────────────────────────

async function refresh() {
  const st = await api.getStatus();
  renderStatus(st);
}

async function init() {
  const s = await api.getSettings();
  if (s.cloudUrl) $("inCloudUrl").value = s.cloudUrl;
  if (s.email) $("inEmail").value = s.email;
  await refresh();
  // Signed in but not fully configured → go straight to setup
  if (!currentStatus?.configured && s.email && s.cloudUrl) {
    const res = await api.listReaders();
    if (res.ok) {
      showView('setup');
      populateReaders(res.readers || [], s.readerId);
      if (s.hardware) $("selHardware").value = s.hardware;
      if (s.hardwareAddress) $("inAddress").value = s.hardwareAddress;
       $("selActiveTimingChannel").value = String(s.activeTimingChannel ?? 0);
       $("inActiveTimingPower").value = String(s.activeTimingPower ?? 100);
       $("chkLoop1").checked = s.activeTimingLoop1Enabled !== false;
       $("chkLoop2").checked = s.activeTimingLoop2Enabled !== false;
      $("selHardware").dispatchEvent(new Event("change"));
    }
  }
  api.onStatus(renderStatus);
}
init();
