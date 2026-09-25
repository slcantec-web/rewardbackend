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
// Mobile-only gate — block desktop / PC submissions
// ============================================================
function isMobileDevice() {
  const ua = navigator.userAgent || "";
  const mobileUa = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobile|mobile/i.test(ua);
  const touch = (navigator.maxTouchPoints || 0) > 0;
  const coarse = window.matchMedia && window.matchMedia("(pointer: coarse)").matches;
  // Prefer real phones/tablets; reject obvious desktop UA even with touch screens
  const desktopUa = /Windows NT|Macintosh|Linux x86_64|CrOS/i.test(ua) && !/Android|Mobile|iPhone|iPad/i.test(ua);
  if (desktopUa) return false;
  return mobileUa || (touch && coarse);
}

function blockIfDesktop() {
  if (isMobileDevice()) return false;
  const banner = document.getElementById("resultBanner");
  if (banner) {
    banner.style.display = "block";
    banner.className = "result-banner err";
    banner.innerHTML =
      "⚠️ Claims must be submitted from a <b>mobile phone</b> at the dealer location.<br>" +
      "Desktop / PC browsers are blocked for fraud prevention. Please open this page on your phone.";
  }
  const btn = document.getElementById("submitBtn");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Mobile device required";
  }
  const gps = document.getElementById("gpsStatus");
  if (gps) {
    gps.textContent = "Blocked — use a mobile phone";
    gps.className = "status-err";
  }
  return true;
}

// ============================================================
// Device blueprint capture
// ============================================================
function getOrCreateInstallId() {
  // Stable per-browser id — survives page reloads; cleared only if user wipes site data.
  const KEY = "cantec_device_id";
  try {
    let id = localStorage.getItem(KEY);
    if (!id) {
      id = (crypto.randomUUID && crypto.randomUUID()) ||
        ("id-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10));
      localStorage.setItem(KEY, id);
    }
    return id;
  } catch (e) {
    return null;
  }
}

function captureDeviceBlueprint() {
  // Canvas text must be CONSTANT — Math.random() made fingerprints change every load (unusable).
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  let canvasFingerprint = "";
  try {
    canvas.width = 240;
    canvas.height = 40;
    ctx.textBaseline = "top";
    ctx.font = "14px Arial";
    ctx.fillStyle = "#0f766e";
    ctx.fillRect(0, 0, 240, 40);
    ctx.fillStyle = "#ffffff";
    ctx.fillText("CanTec-device-fp-v1", 4, 12);
    canvasFingerprint = canvas.toDataURL().slice(-96);
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
    maxTouchPoints: navigator.maxTouchPoints || 0,
    isMobile: isMobileDevice(),
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
    installId: getOrCreateInstallId(),
  };
}

// ============================================================
// Init
// ============================================================
async function init() {
  document.getElementById("timeStatus").textContent = new Date().toLocaleString();

  // Always wire UI (search + products). Desktop only blocks *submission*, not browsing.
  const onDesktop = blockIfDesktop();

  setupDealerAutocomplete();
  document.getElementById("uploadBox")?.addEventListener("click", () => document.getElementById("billFileInput").click());
  document.getElementById("billFileInput")?.addEventListener("change", handleFileSelect);
  document.getElementById("mobileInput")?.addEventListener("input", validateForm);
  document.getElementById("submitBtn")?.addEventListener("click", submitClaim);

  try {
    await loadProducts();
  } catch (e) {
    const list = document.getElementById("productList");
    if (list) list.innerHTML = `<div style="color:#b91c1c;font-size:0.88rem;padding:8px 0;">Could not load products. Check connection and try again.</div>`;
  }

  if (!onDesktop) {
    requestLocation();
  }
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
  const list = document.getElementById("productList");
  if (list) list.innerHTML = `<div style="color:var(--muted);font-size:0.85rem;">Loading products…</div>`;
  const res = await fetch(`${API_BASE}/api/products`);
  if (!res.ok) throw new Error("products " + res.status);
  const data = await res.json();
  products = data.products || [];
  if (!products.length) {
    if (list) list.innerHTML = `<div style="color:var(--muted);font-size:0.85rem;">No products configured yet.</div>`;
    return;
  }
  renderProducts();
}

function renderProducts() {
  const list = document.getElementById("productList");
  if (!list) return;
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

let dealerSearchTimer = null;
let dealerHighlight = -1;

function setupDealerAutocomplete() {
  const input = document.getElementById("dealerSearch");
  const box = document.getElementById("dealerSuggestions");
  const clearBtn = document.getElementById("dealerClearBtn");
  if (!input || !box) return;

  input.addEventListener("input", () => {
    const q = input.value.trim();
    dealerHighlight = -1;
    if (selectedDealerId) {
      selectedDealerId = null;
      document.getElementById("dealerSelected")?.classList.remove("visible");
      validateForm();
    }
    clearTimeout(dealerSearchTimer);
    box.innerHTML = `<div class="dealer-sug-empty">Searching…</div>`;
    box.classList.add("open");
    // Empty query → show a starter list; otherwise filter by name/code/city/address
    dealerSearchTimer = setTimeout(() => searchDealers(q), 200);
  });

  input.addEventListener("focus", () => {
    const q = input.value.trim();
    if (!selectedDealerId) {
      box.innerHTML = `<div class="dealer-sug-empty">Searching…</div>`;
      box.classList.add("open");
      searchDealers(q);
    }
  });

  input.addEventListener("keydown", (e) => {
    const items = box.querySelectorAll(".dealer-sug-item");
    if (!items.length || !box.classList.contains("open")) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      dealerHighlight = Math.min(items.length - 1, dealerHighlight + 1);
      items.forEach((el, i) => el.classList.toggle("active", i === dealerHighlight));
      items[dealerHighlight]?.scrollIntoView({ block: "nearest" });
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      dealerHighlight = Math.max(0, dealerHighlight - 1);
      items.forEach((el, i) => el.classList.toggle("active", i === dealerHighlight));
      items[dealerHighlight]?.scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (dealerHighlight >= 0 && items[dealerHighlight]) items[dealerHighlight].click();
    } else if (e.key === "Escape") {
      box.classList.remove("open");
    }
  });

  document.addEventListener("click", (e) => {
    if (!e.target.closest(".dealer-search-wrap")) box.classList.remove("open");
  });

  clearBtn?.addEventListener("click", () => {
    selectedDealerId = null;
    input.value = "";
    input.focus();
    document.getElementById("dealerSelected")?.classList.remove("visible");
    box.classList.remove("open");
    box.innerHTML = "";
    validateForm();
  });
}

async function searchDealers(query) {
  const box = document.getElementById("dealerSuggestions");
  if (!box) return;
  try {
    const res = await fetch(`${API_BASE}/api/dealers?q=${encodeURIComponent(query)}`);
    const data = await res.json();
    dealers = data.dealers || [];
    if (!dealers.length) {
      box.innerHTML = `<div class="dealer-sug-empty">No stores found for “${escapeHtml(query)}”</div>`;
      box.classList.add("open");
      return;
    }
    box.innerHTML = dealers.map((d, i) => {
      const meta = [d.customer_code ? `Code: ${d.customer_code}` : null, d.city || d.address || null]
        .filter(Boolean).join(" · ");
      return `<div class="dealer-sug-item" role="option" data-idx="${i}" data-id="${escapeHtml(d.id)}">
        <div class="dealer-sug-name">${escapeHtml(d.name || "")}</div>
        ${meta ? `<div class="dealer-sug-meta">${escapeHtml(meta)}</div>` : ""}
      </div>`;
    }).join("");
    box.classList.add("open");
    box.querySelectorAll(".dealer-sug-item").forEach((el) => {
      el.addEventListener("click", () => selectDealerById(el.dataset.id));
    });
  } catch (err) {
    box.innerHTML = `<div class="dealer-sug-empty">Search failed — check connection</div>`;
    box.classList.add("open");
  }
}

function selectDealerById(id) {
  const d = dealers.find((x) => x.id === id);
  if (!d) return;
  selectedDealerId = d.id;
  const input = document.getElementById("dealerSearch");
  const box = document.getElementById("dealerSuggestions");
  const sel = document.getElementById("dealerSelected");
  const nameEl = document.getElementById("dealerSelectedName");
  if (input) input.value = d.name + (d.customer_code ? ` (${d.customer_code})` : "");
  if (box) { box.classList.remove("open"); box.innerHTML = ""; }
  if (nameEl) {
    const bits = [d.name];
    if (d.customer_code) bits.push(d.customer_code);
    if (d.city) bits.push(d.city);
    nameEl.textContent = bits.join(" · ");
  }
  sel?.classList.add("visible");
  validateForm();
}

function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function loadDealers(query) {
  // kept for compatibility — routes to autocomplete search
  return searchDealers(query || "");
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


// ============================================================
// Mobile number rules: exactly 10 digits; max 3 claims / day (server-enforced)
// ============================================================
function digitsOnly(value) {
  return String(value || "").replace(/\D/g, "");
}

/** Normalize to 10-digit local mobile. Accepts 07XXXXXXXX or 947XXXXXXXX. */
function normalizeMobile(value) {
  let d = digitsOnly(value);
  if (d.startsWith("94") && d.length >= 11) d = d.slice(2);
  if (d.startsWith("0") && d.length === 10) return d;
  if (d.length === 9 && !d.startsWith("0")) return "0" + d; // 771234567 → 0771234567
  return d;
}

function isValidMobile10(value) {
  const n = normalizeMobile(value);
  return /^0\d{9}$/.test(n) && n.length === 10;
}

function updateMobileHint() {
  const el = document.getElementById("mobileHint");
  const raw = document.getElementById("mobileInput")?.value || "";
  if (!el) return;
  if (!raw.trim()) {
    el.style.display = "none";
    el.textContent = "";
    return;
  }
  const n = normalizeMobile(raw);
  if (isValidMobile10(raw)) {
    el.style.display = "block";
    el.style.color = "var(--ok, #16a34a)";
    el.textContent = "✓ Valid 10-digit number (" + n + ")";
  } else {
    el.style.display = "block";
    el.style.color = "var(--danger, #dc2626)";
    el.textContent = "Mobile number must be exactly 10 digits (e.g. 0771234567). Currently: " + (n.length || 0) + " digit(s).";
  }
}

function validateForm() {
  if (!isMobileDevice()) {
    document.getElementById("submitBtn").disabled = true;
    return;
  }
  const hasQty = Object.values(quantities).some((q) => q > 0);
  const hasMobile = isValidMobile10(document.getElementById("mobileInput").value);
  const hasGps = !!(gpsData && gpsData.lat != null && gpsData.lng != null);
  const ready = !!(selectedDealerId && hasQty && billBase64 && hasGps && hasMobile);
  document.getElementById("submitBtn").disabled = !ready;
  updateMobileHint();
}

async function submitClaim() {
  if (!isMobileDevice()) {
    blockIfDesktop();
    return;
  }
  if (!gpsData || gpsData.lat == null || gpsData.lng == null) {
    const banner = document.getElementById("resultBanner");
    banner.style.display = "block";
    banner.className = "result-banner err";
    banner.innerHTML = "⚠️ Location access is required. Allow GPS permission and try again.";
    return;
  }

  const rawMobile = document.getElementById("mobileInput").value.trim();
  if (!isValidMobile10(rawMobile)) {
    const banner = document.getElementById("resultBanner");
    banner.style.display = "block";
    banner.className = "result-banner err";
    banner.innerHTML = "⚠️ Mobile number must be <b>exactly 10 digits</b> (e.g. 0771234567). Please correct it and try again.";
    updateMobileHint();
    window.scrollTo({ top: 0, behavior: "smooth" });
    return;
  }
  const mobileNumber = normalizeMobile(rawMobile);

  const btn = document.getElementById("submitBtn");
  btn.disabled = true;
  btn.textContent = "Submitting…";

  const items = Object.entries(quantities)
    .filter(([, qty]) => qty > 0)
    .map(([productId, claimedQty]) => ({ productId, claimedQty }));

  const payload = {
    dealerId: selectedDealerId,
    mobileNumber,
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
      const sid = data.submissionId || "";
      banner.innerHTML =
        `✅ Claim submitted! Your tracking ID is <b>${sid}</b>.<br>` +
        `Next: open <a href="track.html" style="color:inherit;font-weight:700;text-decoration:underline;">Track your claim</a> ` +
        `with this mobile + tracking ID and <b>add your bank account</b> (one mobile = one bank account, required for payout).`;
    } else {
      banner.className = "result-banner err";
      if (data.code === "DEVICE_MULTI_MOBILE" || (data.flags || []).includes("FLAG_DEVICE_MULTI_MOBILE")) {
        banner.innerHTML =
          `⚠️ <b>This phone is already linked to another contact number.</b><br>` +
          `You cannot submit claims for a different number from the same device.<br>` +
          `Use the original mobile number for this phone, or contact CanTec support if you need help.`;
      } else if (data.code === "INVALID_MOBILE" || (data.flags || []).includes("INVALID_MOBILE")) {
        banner.innerHTML =
          `⚠️ <b>Invalid mobile number.</b><br>` +
          `Contact number must be exactly <b>10 digits</b> (e.g. 0771234567).`;
      } else if (data.code === "DAILY_LIMIT" || (data.flags || []).includes("DAILY_LIMIT")) {
        banner.innerHTML =
          `⚠️ <b>Daily limit reached.</b><br>` +
          `This contact number can submit a maximum of <b>3 claims per day</b>. Please try again tomorrow.`;
      } else {
        const msg = data.error || (data.flags || []).join(", ") || "see support";
        banner.innerHTML = `⚠️ Claim could not be accepted (${msg}).`;
      }
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
