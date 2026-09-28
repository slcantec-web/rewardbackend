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
/** null = not checked yet; true = name+bank required; false = already on file */
let profileRequired = null;
let mobileCheckTimer = null;
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
  // Stable per-browser id — primary key for "same phone, different mobile" blocking.
  // Persist in localStorage + sessionStorage + cookie so clearing one store is not enough.
  const KEY = "cantec_device_id";
  const COOKIE = "cantec_device_id";

  function readCookie(name) {
    try {
      const m = document.cookie.match(new RegExp("(?:^|; )" + name.replace(/[$()*+.?[\\\]^{|}]/g, "\\$&") + "=([^;]*)"));
      return m ? decodeURIComponent(m[1]) : null;
    } catch (e) { return null; }
  }
  function writeCookie(name, value) {
    try {
      // 400 days — long-lived device binding
      document.cookie = name + "=" + encodeURIComponent(value) + "; path=/; max-age=34560000; SameSite=Lax";
    } catch (e) { /* ignore */ }
  }

  let id = null;
  try { id = localStorage.getItem(KEY); } catch (e) { /* private mode */ }
  if (!id) {
    try { id = sessionStorage.getItem(KEY); } catch (e) { /* ignore */ }
  }
  if (!id) id = readCookie(COOKIE);
  if (!id) {
    try { id = window.__cantecDeviceId || null; } catch (e) { /* ignore */ }
  }
  if (!id) {
    id = (crypto.randomUUID && crypto.randomUUID()) ||
      ("id-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 12));
  }
  try { localStorage.setItem(KEY, id); } catch (e) { /* ignore */ }
  try { sessionStorage.setItem(KEY, id); } catch (e) { /* ignore */ }
  writeCookie(COOKIE, id);
  try { window.__cantecDeviceId = id; } catch (e) { /* ignore */ }
  return id;
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

  // Create / restore device installId as early as possible (same-phone multi-mobile block).
  getOrCreateInstallId();

  // Always wire UI (search + products). Desktop only blocks *submission*, not browsing.
  const onDesktop = blockIfDesktop();

  setupDealerAutocomplete();
  document.getElementById("uploadBox")?.addEventListener("click", () => document.getElementById("billFileInput").click());
  document.getElementById("billFileInput")?.addEventListener("change", handleFileSelect);
  document.getElementById("mobileInput")?.addEventListener("input", () => {
    scheduleMobileCheck();
    validateForm();
  });
  document.getElementById("mobileInput")?.addEventListener("blur", checkMobileProfile);
  ["customerNameInput", "bankAccountName", "bankAccountNumber", "bankNameInput", "bankBranchInput"].forEach((id) => {
    document.getElementById(id)?.addEventListener("input", () => {
      // Keep account holder in sync with full name when empty
      if (id === "customerNameInput") {
        const n = document.getElementById("customerNameInput");
        const a = document.getElementById("bankAccountName");
        if (n && a && (!a.dataset.touched || a.value === "")) a.value = n.value;
      }
      if (id === "bankAccountName") {
        const a = document.getElementById("bankAccountName");
        if (a) a.dataset.touched = "1";
      }
      validateForm();
    });
  });
  document.getElementById("submitBtn")?.addEventListener("click", submitClaim);

  try {
    await loadProducts();
  } catch (e) {
    const list = document.getElementById("productList");
    if (list) list.innerHTML = `<div style="color:#b91c1c;font-size:0.88rem;padding:8px 0;">Could not load products. Check connection and try again.</div>`;
  }

  // Store counter QR / admin deep-link: ?dealer=<dealerId>
  try {
    const params = new URLSearchParams(window.location.search || "");
    const dealerId = (params.get("dealer") || "").trim();
    if (dealerId) {
      await preselectDealerFromUrl(dealerId);
    }
  } catch (e) {
    console.warn("dealer preselect failed", e);
  }

  if (!onDesktop) {
    requestLocation();
  }
}

async function preselectDealerFromUrl(dealerId) {
  try {
    const res = await fetch(`${API_BASE}/api/dealers?id=${encodeURIComponent(dealerId)}`);
    if (!res.ok) return;
    const data = await res.json();
    const list = data.dealers || [];
    if (!list.length) return;
    dealers = list;
    selectDealerById(list[0].id);
  } catch (e) {
    console.warn("preselectDealerFromUrl", e);
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

  try {
    const cached = sessionStorage.getItem("cantec_products_v1");
    if (cached) {
      const parsed = JSON.parse(cached);
      if (parsed && Array.isArray(parsed.products) && parsed.ts && Date.now() - parsed.ts < 5 * 60 * 1000) {
        products = parsed.products;
        if (!products.length) {
          if (list) list.innerHTML = `<div style="color:var(--muted);font-size:0.85rem;">No products configured yet.</div>`;
          return;
        }
        renderProducts();
        fetch(`${API_BASE}/api/products`)
          .then((r) => (r.ok ? r.json() : null))
          .then((data) => {
            if (!data) return;
            products = data.products || [];
            try {
              sessionStorage.setItem("cantec_products_v1", JSON.stringify({ ts: Date.now(), products }));
            } catch (_) {}
            renderProducts();
          })
          .catch(() => {});
        return;
      }
    }
  } catch (_) {}

  const res = await fetch(`${API_BASE}/api/products`);
  if (!res.ok) throw new Error("products " + res.status);
  const data = await res.json();
  products = data.products || [];
  try {
    sessionStorage.setItem("cantec_products_v1", JSON.stringify({ ts: Date.now(), products }));
  } catch (_) {}
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
  billBase64 = null;
  document.getElementById("uploadBox").classList.add("has-file");
  const label = document.getElementById("fileNameLabel");
  if (label) label.textContent = "Compressing photo…";
  validateForm();

  // Smaller payload = faster mobile upload (max edge 960px, quality ~0.62)
  compressImage(file, 960, 0.62)
    .then((base64) => {
      billBase64 = base64;
      const kb = Math.round((base64.length * 0.75) / 1024);
      if (label) label.textContent = "Ready: " + file.name + " (~" + kb + " KB)";
      validateForm();
    })
    .catch(() => {
      if (label) label.textContent = "Could not read image — try another photo";
      billBase64 = null;
      validateForm();
    });
}

function compressImage(file, maxDim, quality) {
  return new Promise((resolve, reject) => {
    const finish = (bitmap, w, h) => {
      let width = w;
      let height = h;
      if (width > maxDim || height > maxDim) {
        const scale = maxDim / Math.max(width, height);
        width = Math.round(width * scale);
        height = Math.round(height * scale);
      }
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) return reject(new Error("canvas"));
      ctx.drawImage(bitmap, 0, 0, width, height);
      if (bitmap.close) {
        try { bitmap.close(); } catch (_) {}
      }
      resolve(canvas.toDataURL("image/jpeg", quality));
    };

    if (typeof createImageBitmap === "function") {
      createImageBitmap(file)
        .then((bmp) => finish(bmp, bmp.width, bmp.height))
        .catch(() => {
          const img = new Image();
          const reader = new FileReader();
          reader.onerror = () => reject(new Error("read"));
          reader.onload = (e) => {
            img.onload = () => finish(img, img.width, img.height);
            img.onerror = () => reject(new Error("img"));
            img.src = e.target.result;
          };
          reader.readAsDataURL(file);
        });
      return;
    }

    const img = new Image();
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("read"));
    reader.onload = (e) => {
      img.onload = () => finish(img, img.width, img.height);
      img.onerror = () => reject(new Error("img"));
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
}

function normalizeMobileClient(raw) {
  let mobileRaw = String(raw || "").trim().replace(/[^\d+]/g, "");
  if (mobileRaw.startsWith("+")) mobileRaw = mobileRaw.slice(1);
  if (mobileRaw.startsWith("94") && mobileRaw.length >= 11) mobileRaw = "0" + mobileRaw.slice(2);
  if (/^7\d{8}$/.test(mobileRaw)) mobileRaw = "0" + mobileRaw;
  return mobileRaw.replace(/\D/g, "");
}

function setProfileVisibility(show, opts) {
  opts = opts || {};
  const wrap = document.getElementById("customerProfileWrap");
  const hint = document.getElementById("mobileHint");
  if (!wrap) return;
  if (show) {
    wrap.style.display = "block";
    profileRequired = true;
    if (hint) {
      hint.style.display = "block";
      hint.style.color = "var(--muted)";
      const missing = [];
      if (!opts.hasName) missing.push("name");
      if (!opts.hasBank) missing.push("bank details");
      hint.textContent = missing.length
        ? "Please enter your " + missing.join(" & ") + " below (once only for this mobile)."
        : "Please complete your payout profile below (once only).";
    }
  } else {
    wrap.style.display = "none";
    profileRequired = false;
    ["customerNameInput", "bankAccountName", "bankAccountNumber", "bankNameInput", "bankBranchInput"].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.value = "";
    });
    if (hint) {
      hint.style.display = "block";
      hint.style.color = "var(--primary, #0f766e)";
      const bits = [];
      if (opts.knownName) bits.push(opts.knownName);
      if (opts.hasBank) bits.push("bank on file");
      hint.textContent = bits.length
        ? `Welcome back${opts.knownName ? ", " + opts.knownName : ""}. Profile on file — you can submit claims only.`
        : "This mobile is already registered — profile not required again.";
    }
  }
  validateForm();
}

async function checkMobileProfile() {
  const input = document.getElementById("mobileInput");
  const mobile = normalizeMobileClient(input?.value || "");
  const wrap = document.getElementById("customerProfileWrap");
  const hint = document.getElementById("mobileHint");
  if (mobile.length < 9) {
    profileRequired = null;
    if (wrap) wrap.style.display = "none";
    if (hint) hint.style.display = "none";
    validateForm();
    return;
  }
  try {
    const res = await fetch(`${API_BASE}/api/public/mobile-check?mobile=${encodeURIComponent(mobile)}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setProfileVisibility(true, { hasName: false, hasBank: false });
      return;
    }
    const need = data.needProfile === true || !data.hasName || !data.hasBank;
    if (need) {
      setProfileVisibility(true, { hasName: !!data.hasName, hasBank: !!data.hasBank });
      // Prefill name if we have it but bank missing
      if (data.hasName && data.name) {
        const n = document.getElementById("customerNameInput");
        const a = document.getElementById("bankAccountName");
        if (n && !n.value) n.value = data.name;
        if (a && !a.value) a.value = data.name;
      }
    } else {
      setProfileVisibility(false, { knownName: data.name || null, hasBank: true });
    }
  } catch {
    setProfileVisibility(true, { hasName: false, hasBank: false });
  }
}

function scheduleMobileCheck() {
  clearTimeout(mobileCheckTimer);
  mobileCheckTimer = setTimeout(checkMobileProfile, 350);
}

function validateForm() {
  if (!isMobileDevice()) {
    document.getElementById("submitBtn").disabled = true;
    return;
  }
  const hasQty = Object.values(quantities).some((q) => q > 0);
  const mobile = normalizeMobileClient(document.getElementById("mobileInput")?.value || "");
  const hasMobile = mobile.length >= 9;
  let profileOk = true;
  if (profileRequired === true) {
    const nameVal = (document.getElementById("customerNameInput")?.value || "").trim();
    const accName = (document.getElementById("bankAccountName")?.value || "").trim() || nameVal;
    const accNum = (document.getElementById("bankAccountNumber")?.value || "").trim().replace(/\s+/g, "");
    const bankName = (document.getElementById("bankNameInput")?.value || "").trim();
    profileOk = nameVal.length >= 2 && accName.length >= 2 && accNum.length >= 5 && bankName.length >= 2;
  }
  const hasGps = !!(gpsData && gpsData.lat != null && gpsData.lng != null);
  const ready = !!(selectedDealerId && hasQty && billBase64 && hasGps && hasMobile && profileOk);
  document.getElementById("submitBtn").disabled = !ready;
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

  const btn = document.getElementById("submitBtn");
  btn.disabled = true;
  btn.textContent = "Uploading bill…";

  const items = Object.entries(quantities)
    .filter(([, qty]) => qty > 0)
    .map(([productId, claimedQty]) => ({ productId, claimedQty }));

  // Normalize mobile client-side (server also normalizes) so +94 / spacing cannot bypass device binding
  const mobileRaw = normalizeMobileClient(document.getElementById("mobileInput").value);
  const customerName = (document.getElementById("customerNameInput")?.value || "").trim();
  const accountName = (document.getElementById("bankAccountName")?.value || "").trim() || customerName;
  const accountNumber = (document.getElementById("bankAccountNumber")?.value || "").trim().replace(/\s+/g, "");
  const bankName = (document.getElementById("bankNameInput")?.value || "").trim();
  const branchName = (document.getElementById("bankBranchInput")?.value || "").trim();

  if (profileRequired === true) {
    if (customerName.length < 2 || accountName.length < 2 || accountNumber.length < 5 || bankName.length < 2) {
      const banner = document.getElementById("resultBanner");
      if (banner) {
        banner.style.display = "block";
        banner.className = "result-banner err";
        banner.textContent = "Please complete your name and bank details (required the first time for this mobile).";
      }
      btn.disabled = false;
      btn.textContent = "Submit Claim & Get Tracking ID";
      return;
    }
  }

  const payload = {
    dealerId: selectedDealerId,
    mobileNumber: mobileRaw,
    items,
    billImageBase64: billBase64,
    gps: gpsData,
    createdAtClient,
    device: captureDeviceBlueprint(), // always includes installId
  };
  if (profileRequired === true) {
    payload.customerName = customerName;
    payload.bankDetails = {
      accountName,
      accountNumber,
      bankName,
      branchName: branchName || undefined,
    };
  }

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
        (data.hasBank || data.profileSaved
          ? `Your payout profile is saved for this mobile. Later claims only need the bill — no bank form again.<br>`
          : ``) +
        `To check status & wallet: <a href="track.html" style="color:inherit;font-weight:700;text-decoration:underline;">Track claims & wallet</a> ` +
        `with this mobile + tracking ID.`;
    } else {
      banner.className = "result-banner err";
      if (data.code === "DEVICE_MULTI_MOBILE" || (data.flags || []).includes("FLAG_DEVICE_MULTI_MOBILE")) {
        banner.innerHTML =
          `⚠️ <b>This phone is already linked to another contact number.</b><br>` +
          `You cannot submit claims for a different number from the same device.<br>` +
          `Use the original mobile number for this phone, or contact CanTec support if you need help.`;
      } else if (data.code === "CUSTOMER_NAME_REQUIRED" || data.code === "BANK_DETAILS_REQUIRED") {
        setProfileVisibility(true, { hasName: data.code !== "CUSTOMER_NAME_REQUIRED", hasBank: data.code !== "BANK_DETAILS_REQUIRED" });
        banner.innerHTML = `⚠️ Please complete your name and bank details — required the first time for this mobile.`;
      } else if (data.code === "BANK_ACCOUNT_COLLISION") {
        banner.innerHTML = `⚠️ This bank account is already linked to another mobile number. Use a different account.`;
      } else {
        const msg = data.error || (data.flags || []).join(", ") || "see support";
        banner.innerHTML = `⚠️ Claim could not be accepted (${msg}).`;
      }
    }
    window.scrollTo({ top: 0, behavior: "smooth" });
  } catch (e) {
    const banner = document.getElementById("resultBanner");
    if (banner) {
      banner.className = "result-banner err";
      banner.style.display = "block";
      banner.textContent = "Network error — please try again.";
    }
  } finally {
    btn.textContent = "Submit Claim & Get Tracking ID";
    validateForm();
  }
}

init();
