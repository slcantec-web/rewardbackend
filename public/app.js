// ============================================================
// Config (resolved by config.js, loaded before this script)
// ============================================================
const API_BASE = window.API_BASE || "";

// ============================================================
// State
// ============================================================
let products = [];
let dealers = [];
let selectedDealerId = null;
let gpsData = null;
let billFile = null;
let billBase64 = null;
const quantities = {}; // productId -> qty
const createdAtClient = new Date().toISOString();

// ============================================================
// Device blueprint capture
// ============================================================
function captureDeviceBlueprint() {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  let canvasFingerprint = "";
  try {
    ctx.textBaseline = "top";
    ctx.font = "14px Arial";
    ctx.fillText("device-check-" + Math.random(), 2, 2);
    canvasFingerprint = canvas.toDataURL().slice(-64);
  } catch (e) { /* canvas blocked — non-fatal */ }

  let webglRenderer = "";
  try {
    const gl = document.createElement("canvas").getContext("webgl");
    const dbg = gl && gl.getExtension("WEBGL_debug_renderer_info");
    webglRenderer = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : "";
  } catch (e) { /* WebGL blocked — non-fatal */ }

  return {
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    language: navigator.language,
    screen: {
      width: screen.width,
      height: screen.height,
      colorDepth: screen.colorDepth,
      pixelRatio: window.devicePixelRatio || 1,
    },
    hardwareConcurrency: navigator.hardwareConcurrency || null,
    deviceMemory: navigator.deviceMemory || null,
    webglRenderer,
    canvasFingerprint,
    connectionType: navigator.connection ? navigator.connection.effectiveType : null,
  };
}

// ============================================================
// Init
// ============================================================
async function init() {
  document.getElementById("timeStatus").textContent = new Date().toLocaleString();

  requestLocation();
  await loadProducts();
  await loadDealers("");

  document.getElementById("dealerSearch").addEventListener("input", (e) => loadDealers(e.target.value));
  document.getElementById("dealerSelect").addEventListener("change", (e) => {
    selectedDealerId = e.target.value;
    validateForm();
  });
  document.getElementById("uploadBox").addEventListener("click", () => document.getElementById("billFileInput").click());
  document.getElementById("billFileInput").addEventListener("change", handleFileSelect);
  document.getElementById("mobileInput").addEventListener("input", validateForm);
  document.getElementById("submitBtn").addEventListener("click", submitClaim);
}

function requestLocation() {
  if (!navigator.geolocation) {
    document.getElementById("gpsStatus").textContent = "Not supported on this device";
    document.getElementById("gpsStatus").className = "status-err";
    return;
  }
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      gpsData = {
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        accuracy: pos.coords.accuracy,
      };
      document.getElementById("gpsStatus").textContent = `Captured (±${Math.round(pos.coords.accuracy)}m)`;
      document.getElementById("gpsStatus").className = "status-ok";
      validateForm();
    },
    (err) => {
      document.getElementById("gpsStatus").textContent = "Permission required — please allow location";
      document.getElementById("gpsStatus").className = "status-err";
    },
    { enableHighAccuracy: true, timeout: 15000 }
  );
}

async function loadProducts() {
  const res = await fetch(`${API_BASE}/api/products`);
  const data = await res.json();
  products = data.products || [];
  renderProducts();
}

function renderProducts() {
  const list = document.getElementById("productList");
  list.innerHTML = "";
  products.forEach((p) => {
    quantities[p.id] = quantities[p.id] || 0;
    const row = document.createElement("div");
    row.className = "product-row";
    row.innerHTML = `
      <span class="product-name">${p.name}</span>
      <div class="stepper">
        <button data-action="dec" data-id="${p.id}">−</button>
        <span id="qty-${p.id}">${quantities[p.id]}</span>
        <button data-action="inc" data-id="${p.id}">+</button>
      </div>
    `;
    list.appendChild(row);
  });
  list.querySelectorAll("button").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.id;
      const delta = btn.dataset.action === "inc" ? 1 : -1;
      quantities[id] = Math.max(0, quantities[id] + delta);
      document.getElementById(`qty-${id}`).textContent = quantities[id];
      validateForm();
    });
  });
}

async function loadDealers(query) {
  const res = await fetch(`${API_BASE}/api/dealers?q=${encodeURIComponent(query)}`);
  const data = await res.json();
  dealers = data.dealers || [];
  const select = document.getElementById("dealerSelect");
  select.innerHTML = `<option value="">Select a dealer...</option>` +
    dealers.map((d) => `<option value="${d.id}">${d.name} — ${d.city || ""}</option>`).join("");
}

function handleFileSelect(e) {
  const file = e.target.files[0];
  if (!file) return;
  billFile = file;
  document.getElementById("uploadBox").classList.add("has-file");
  document.getElementById("fileNameLabel").textContent = `File: ${file.name}`;

  // Client-side compression via canvas downscale before base64 encode
  compressImage(file, 1280, 0.7).then((base64) => {
    billBase64 = base64;
    validateForm();
  });
}

function compressImage(file, maxDim, quality) {
  return new Promise((resolve) => {
    const img = new Image();
    const reader = new FileReader();
    reader.onload = (e) => (img.src = e.target.result);
    img.onload = () => {
      let { width, height } = img;
      if (width > maxDim || height > maxDim) {
        const scale = maxDim / Math.max(width, height);
        width *= scale;
        height *= scale;
      }
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      canvas.getContext("2d").drawImage(img, 0, 0, width, height);
      resolve(canvas.toDataURL("image/jpeg", quality));
    };
    reader.readAsDataURL(file);
  });
}

function validateForm() {
  const hasQty = Object.values(quantities).some((q) => q > 0);
  const hasMobile = document.getElementById("mobileInput").value.trim().length >= 9;
  const ready = !!(selectedDealerId && hasQty && billBase64 && gpsData && hasMobile);
  document.getElementById("submitBtn").disabled = !ready;
}

async function submitClaim() {
  const btn = document.getElementById("submitBtn");
  btn.disabled = true;
  btn.textContent = "Submitting…";

  const items = Object.entries(quantities)
    .filter(([, qty]) => qty > 0)
    .map(([productId, claimedQty]) => ({ productId, claimedQty }));

  const payload = {
    dealerId: selectedDealerId,
    mobileNumber: document.getElementById("mobileInput").value.trim(),
    items,
    billImageBase64: billBase64,
    gps: gpsData,
    createdAtClient,
    device: captureDeviceBlueprint(),
  };

  try {
    const res = await fetch(`${API_BASE}/api/submissions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    const banner = document.getElementById("resultBanner");
    banner.style.display = "block";
    if (res.ok && data.status !== "REJECTED") {
      banner.className = "result-banner ok";
      banner.innerHTML = `✅ Claim submitted! Your tracking ID is <b>${data.submissionId}</b>.<br>Save it to check your status.`;
    } else {
      banner.className = "result-banner err";
      banner.innerHTML = `⚠️ Claim could not be accepted (${(data.flags || []).join(", ") || "see support"}).`;
    }
    window.scrollTo({ top: 0, behavior: "smooth" });
  } catch (e) {
    alert("Network error — please try again.");
  } finally {
    btn.textContent = "Submit Claim & Get Tracking ID";
    validateForm();
  }
}

init();
