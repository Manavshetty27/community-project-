const $ = (selector) => document.querySelector(selector);
const registrationForm = $("#registration-form");
const registrationMessage = $("#registration-message");
const queueBoard = $("#queue-board");
const queueOffline = $("#queue-offline");
const staffDialog = $("#staff-dialog");
const staffLoginForm = $("#staff-login-form");
const staffDashboard = $("#staff-dashboard");
const staffLoginMessage = $("#staff-login-message");
const staffMessage = $("#staff-message");
const qrDialog = $("#qr-dialog");
const qrVideo = $("#qr-video");
const qrMessage = $("#qr-message");
let qrStream;
let qrFrame;
let qrDetector;

function openStore() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("community-care", 1);
    request.onupgradeneeded = () => {
      const store = request.result;
      store.createObjectStore("pending", { keyPath: "requestId" });
      store.createObjectStore("tickets", { keyPath: "token" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function storeAction(name, action) {
  const db = await openStore();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(name, action.mode || "readonly");
    const request = action.run(transaction.objectStore(name));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    transaction.onabort = () => reject(transaction.error || new Error("Local storage is unavailable."));
    transaction.oncomplete = () => db.close();
  });
}

function showMessage(element, message, isError = false) {
  element.textContent = message;
  element.classList.toggle("error", isError);
  element.hidden = false;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
    },
  });
  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error("The server returned an unreadable response.");
  }
  if (!response.ok) {
    const error = new Error(result.error || "The request could not be completed.");
    error.status = response.status;
    throw error;
  }
  return result;
}

function makeRequestId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2, 14)}`;
}

function stopQrScanner() {
  if (qrFrame) cancelAnimationFrame(qrFrame);
  qrFrame = undefined;
  if (qrStream) {
    qrStream.getTracks().forEach((track) => track.stop());
    qrStream = undefined;
  }
  qrVideo.srcObject = null;
  $("#qr-start").hidden = false;
  $("#qr-stop").hidden = true;
}

function chooseDepartmentFromQr(rawValue) {
  const value = rawValue.trim();
  let departmentId = "";
  const code = /^COMMUNITYCARE:([a-z]+)$/i.exec(value);
  if (code) {
    departmentId = code[1].toLowerCase();
  } else if (/^[a-z]+$/i.test(value)) {
    departmentId = value.toLowerCase();
  } else {
    try {
      const link = new URL(value);
      if (link.origin !== window.location.origin) {
        throw new Error("For your privacy, only clinic QR codes from this website are accepted.");
      }
      departmentId = link.searchParams.get("department") || "";
      if (!departmentId && link.hash.includes("?")) {
        departmentId = new URLSearchParams(link.hash.slice(link.hash.indexOf("?") + 1))
          .get("department") || "";
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("For your privacy")) throw error;
      throw new Error("That QR code isn't a recognized clinic department code.");
    }
  }
  const option = Array.from($("#department-select").options)
    .find((item) => item.value === departmentId);
  if (!option) {
    throw new Error("That QR code doesn't match a clinic department.");
  }
  $("#department-select").value = departmentId;
  stopQrScanner();
  qrDialog.close();
  const selection = $("#qr-selection");
  selection.textContent = `${option.textContent} selected. Complete the form to get your token.`;
  selection.hidden = false;
  $("#registration-form").scrollIntoView({ behavior: "smooth", block: "center" });
  $("#registration-form").elements.name.focus({ preventScroll: true });
}

async function scanQrFrame() {
  if (!qrStream || qrDialog.open !== true || !qrDetector) return;
  try {
    const codes = await qrDetector.detect(qrVideo);
    if (codes.length) {
      chooseDepartmentFromQr(codes[0].rawValue);
      return;
    }
  } catch (error) {
    showMessage(qrMessage, `Could not read the QR code: ${error.message}`, true);
  }
  if (qrStream && qrDialog.open) qrFrame = requestAnimationFrame(scanQrFrame);
}

async function startQrScanner() {
  qrMessage.hidden = true;
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    showMessage(qrMessage, "Camera scanning needs a secure HTTPS website (or localhost). You can still choose your department from the list.", true);
    return;
  }
  if (!("BarcodeDetector" in window)) {
    showMessage(qrMessage, "This browser does not support camera QR scanning. Choose your department from the list instead.", true);
    return;
  }
  try {
    const formats = typeof BarcodeDetector.getSupportedFormats === "function"
      ? await BarcodeDetector.getSupportedFormats()
      : ["qr_code"];
    if (!formats.includes("qr_code")) {
      showMessage(qrMessage, "This browser cannot read QR codes. Choose your department from the list instead.", true);
      return;
    }
    qrDetector = new BarcodeDetector({ formats: ["qr_code"] });
    qrStream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: "environment" } },
    });
    qrVideo.srcObject = qrStream;
    await qrVideo.play();
    $("#qr-start").hidden = true;
    $("#qr-stop").hidden = false;
    qrFrame = requestAnimationFrame(scanQrFrame);
  } catch (error) {
    stopQrScanner();
    showMessage(qrMessage, `Camera access wasn't available: ${error.message}. You can still choose your department from the list.`, true);
  }
}

function showTicket(container, ticket, pending = false) {
  container.replaceChildren();
  const title = document.createElement("h3");
  if (pending) {
    title.textContent = "Saved on this device — waiting to sync";
    const detail = document.createElement("p");
    detail.textContent = `${ticket.name}'s registration will be sent securely when this device is back online. Your server token will be assigned after syncing.`;
    container.append(title, detail);
    container.hidden = false;
    return;
  }
  title.textContent = `${ticket.name}, you're on the list`;
  const token = document.createElement("span");
  token.className = "ticket-number";
  token.textContent = ticket.token;
  const detail = document.createElement("p");
  const status = ticket.status === "waiting"
    ? `About ${ticket.position} ${ticket.position === 1 ? "person" : "people"} ahead of you.`
    : ticket.status === "called" ? "It's your turn — please head to the clinic." : "Your consultation is complete.";
  detail.textContent = `${ticket.department} · ${status}`;
  container.append(title, token, detail);
  container.hidden = false;
}

function saveTicket(ticket) {
  return storeAction("tickets", {
    mode: "readwrite",
    run: (store) => store.put(ticket),
  });
}

function renderQueue(items) {
  queueBoard.replaceChildren();
  for (const item of items) {
    const card = document.createElement("article");
    card.className = "queue-card";
    const heading = document.createElement("h3");
    heading.textContent = item.name;
    const stats = document.createElement("div");
    stats.className = "queue-stats";
    const waiting = document.createElement("div");
    const waitingLabel = document.createElement("span");
    waitingLabel.className = "queue-stat-label";
    waitingLabel.textContent = "Waiting";
    const waitingValue = document.createElement("span");
    waitingValue.className = "queue-stat-value";
    waitingValue.textContent = item.waiting;
    waiting.append(waitingLabel, waitingValue);
    const current = document.createElement("div");
    const currentLabel = document.createElement("span");
    currentLabel.className = "queue-stat-label";
    currentLabel.textContent = "Now serving";
    const currentValue = document.createElement("span");
    currentValue.className = "queue-stat-value queue-current";
    currentValue.textContent = item.current || "—";
    current.append(currentLabel, currentValue);
    stats.append(waiting, current);
    const updated = document.createElement("p");
    updated.className = "queue-updated";
    updated.textContent = `Next: ${item.next || "No one waiting"}`;
    card.append(heading, stats, updated);
    queueBoard.append(card);
  }
}

function formatCampDate(value) {
  const date = new Date(`${value}T00:00:00`);
  return {
    month: new Intl.DateTimeFormat(undefined, { month: "short" }).format(date),
    day: new Intl.DateTimeFormat(undefined, { day: "2-digit" }).format(date),
    full: new Intl.DateTimeFormat(undefined, { dateStyle: "long" }).format(date),
  };
}

function renderCamps(camps) {
  const container = $("#camp-list");
  container.replaceChildren();
  if (!camps.length) {
    const card = document.createElement("article");
    card.className = "camp-card";
    const icon = document.createElement("div");
    icon.className = "camp-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = "✚";
    const content = document.createElement("div");
    const heading = document.createElement("h3");
    heading.textContent = "No upcoming camps published yet";
    const detail = document.createElement("p");
    detail.textContent = "Check back here for confirmed community camp dates and locations. You can still register for a clinic visit below.";
    content.append(heading, detail);
    const link = document.createElement("a");
    link.className = "text-link";
    link.href = "#register";
    link.textContent = "Visit the clinic →";
    card.append(icon, content, link);
    container.append(card);
    return;
  }
  for (const camp of camps) {
    const card = document.createElement("article");
    card.className = "camp-card";
    const date = formatCampDate(camp.date);
    const dateBadge = document.createElement("div");
    dateBadge.className = "camp-date";
    const month = document.createElement("span");
    month.textContent = date.month;
    const day = document.createElement("b");
    day.textContent = date.day;
    dateBadge.append(month, day);
    const icon = document.createElement("div");
    icon.className = "camp-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = "✚";
    const content = document.createElement("div");
    content.className = "camp-info";
    const heading = document.createElement("h3");
    heading.textContent = camp.title;
    const detail = document.createElement("p");
    detail.textContent = `${date.full} · ${camp.location}${camp.details ? ` · ${camp.details}` : ""}`;
    content.append(heading, detail);
    const link = document.createElement("a");
    link.className = "text-link";
    link.href = "#register";
    link.textContent = "Get a token →";
    card.append(dateBadge, icon, content, link);
    container.append(card);
  }
}

async function loadCamps() {
  let camps;
  try {
    camps = await api("/api/camps");
    try {
      localStorage.setItem("community-care-camps", JSON.stringify(camps));
    } catch (error) {
      console.error("Could not save camps for offline use:", error);
    }
  } catch (error) {
    try {
      camps = JSON.parse(localStorage.getItem("community-care-camps") || "null");
    } catch (storageError) {
      console.error("Could not read saved camps:", storageError);
    }
    if (!Array.isArray(camps)) throw error;
  }
  if (!Array.isArray(camps)) throw new Error("The camp schedule is unavailable.");
  renderCamps(camps);
}

async function refreshQueue() {
  try {
    const items = await api("/api/queue");
    renderQueue(items);
    localStorage.setItem("community-care-queue", JSON.stringify(items));
    queueOffline.hidden = true;
  } catch (error) {
    let cached = null;
    try {
      cached = JSON.parse(localStorage.getItem("community-care-queue") || "null");
    } catch (storageError) {
      console.error("Could not read the saved queue.", storageError);
    }
    if (Array.isArray(cached)) {
      renderQueue(cached);
      queueOffline.hidden = false;
    } else {
      queueBoard.replaceChildren();
      const card = document.createElement("div");
      card.className = "loading-card";
      card.textContent = "Queue details will appear when a connection is available.";
      queueBoard.append(card);
      queueOffline.hidden = true;
    }
    if (!navigator.onLine) queueOffline.hidden = !Array.isArray(cached);
    if (error.status) console.error("Could not refresh the queue:", error.message);
  }
}

async function loadDepartments() {
  let departments;
  try {
    departments = await api("/api/departments");
    try {
      localStorage.setItem("community-care-departments", JSON.stringify(departments));
    } catch (error) {
      console.error("Could not save departments for offline use:", error);
    }
  } catch (error) {
    try {
      departments = JSON.parse(localStorage.getItem("community-care-departments") || "null");
    } catch (storageError) {
      console.error("Could not read saved departments:", storageError);
    }
    if (!Array.isArray(departments)) throw error;
  }
  if (!departments.length) throw new Error("No clinic departments are available.");
  for (const department of departments) {
    const patientOption = document.createElement("option");
    patientOption.value = department.id;
    patientOption.textContent = department.name;
    $("#department-select").append(patientOption);
    const staffOption = document.createElement("option");
    staffOption.value = department.id;
    staffOption.textContent = department.name;
    $("#staff-department").append(staffOption);
  }
  const departmentFromLink = new URLSearchParams(window.location.search).get("department");
  if (departmentFromLink && departments.some((department) => department.id === departmentFromLink)) {
    $("#department-select").value = departmentFromLink;
    const department = departments.find((item) => item.id === departmentFromLink);
    const selection = $("#qr-selection");
    selection.textContent = `${department.name} selected from the clinic link. Complete the form to get your token.`;
    selection.hidden = false;
  }
}

registrationForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(registrationForm);
  const payload = {
    requestId: makeRequestId(),
    name: String(form.get("name")).trim(),
    age: String(form.get("age")),
    gender: String(form.get("gender")),
    phone: String(form.get("phone")).trim(),
    village: String(form.get("village")).trim(),
    department: String(form.get("department")),
  };
  registrationMessage.hidden = true;
  const button = registrationForm.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    if (!navigator.onLine) throw new TypeError("This device is offline.");
    const ticket = await api("/api/register", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    await saveTicket({ ...ticket, phone: payload.phone });
    showTicket(registrationMessage, ticket);
    registrationForm.reset();
  } catch (error) {
    if (error instanceof TypeError || !navigator.onLine) {
      try {
        await storeAction("pending", {
          mode: "readwrite",
          run: (store) => store.put(payload),
        });
        showTicket(registrationMessage, payload, true);
        registrationForm.reset();
      } catch (storageError) {
        showMessage(registrationMessage, `Could not save your registration offline: ${storageError.message}`, true);
      }
    } else {
      showMessage(registrationMessage, error.message, true);
    }
  } finally {
    button.disabled = false;
  }
});

$("#lookup-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const token = String(form.get("token")).trim().toUpperCase();
  const phone = String(form.get("phone")).replace(/\D/g, "");
  const result = $("#ticket-result");
  result.hidden = true;
  try {
    if (!navigator.onLine) throw new TypeError("This device is offline.");
    const ticket = await api("/api/ticket", {
      method: "POST",
      body: JSON.stringify({ token, phone }),
    });
    await saveTicket({ ...ticket, phone });
    showTicket(result, ticket);
  } catch (error) {
    if (error instanceof TypeError || !navigator.onLine) {
      try {
        const cached = await storeAction("tickets", {
          run: (store) => store.get(token),
        });
        if (cached && cached.phone === phone) {
          showTicket(result, cached);
        } else {
          showMessage(result, "This token isn't saved on this device. Connect to the internet to check it.", true);
        }
      } catch (storageError) {
        showMessage(result, `Could not check the saved token: ${storageError.message}`, true);
      }
    } else {
      showMessage(result, error.message, true);
    }
  }
});

async function syncPendingRegistrations() {
  if (!navigator.onLine) return;
  let pending;
  try {
    pending = await storeAction("pending", {
      run: (store) => store.getAll(),
    });
  } catch (error) {
    console.error("Could not read offline registrations:", error);
    return;
  }
  for (const registration of pending) {
    try {
      const ticket = await api("/api/register", {
        method: "POST",
        body: JSON.stringify(registration),
      });
      await saveTicket({ ...ticket, phone: registration.phone });
      await storeAction("pending", {
        mode: "readwrite",
        run: (store) => store.delete(registration.requestId),
      });
      showTicket(registrationMessage, ticket);
      registrationMessage.scrollIntoView({ behavior: "smooth", block: "center" });
      await refreshQueue();
    } catch (error) {
      if (error instanceof TypeError || !navigator.onLine) return;
      showMessage(registrationMessage, `An offline registration could not sync: ${error.message}`, true);
      return;
    }
  }
}

function setStaffLoginMessage(message, isError = true) {
  showMessage(staffLoginMessage, message, isError);
}

async function loadStaffPatients() {
  const patients = await api("/api/admin/patients");
  const rows = $("#patient-rows");
  rows.replaceChildren();
  if (!patients.length) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 5;
    cell.textContent = "No registrations yet today.";
    row.append(cell);
    rows.append(row);
    return;
  }
  for (const patient of patients) {
    const row = document.createElement("tr");
    const identity = document.createElement("td");
    const token = document.createElement("b");
    token.textContent = patient.token;
    const name = document.createElement("small");
    name.textContent = `${patient.name}, ${patient.age}`;
    identity.append(token, name);
    const department = document.createElement("td");
    department.textContent = patient.department;
    const phone = document.createElement("td");
    phone.textContent = patient.phone;
    const statusCell = document.createElement("td");
    const status = document.createElement("span");
    status.className = `status-pill ${patient.status}`;
    status.textContent = patient.status;
    statusCell.append(status);
    const action = document.createElement("td");
    if (patient.status === "called") {
      const complete = document.createElement("button");
      complete.className = "complete-button";
      complete.type = "button";
      complete.textContent = "Complete";
      complete.addEventListener("click", async () => {
        try {
          await api("/api/admin/complete", {
            method: "POST",
            body: JSON.stringify({ id: patient.id }),
          });
          await loadStaffPatients();
          await refreshQueue();
        } catch (error) {
          showMessage(staffMessage, error.message, true);
        }
      });
      action.append(complete);
    }
    row.append(identity, department, phone, statusCell, action);
    rows.append(row);
  }
}

async function loadStaffCamps() {
  const camps = await api("/api/admin/camps");
  const rows = $("#camp-rows");
  rows.replaceChildren();
  if (!camps.length) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 4;
    cell.textContent = "No upcoming camps published.";
    row.append(cell);
    rows.append(row);
    return;
  }
  for (const camp of camps) {
    const row = document.createElement("tr");
    const title = document.createElement("td");
    title.textContent = camp.title;
    const date = document.createElement("td");
    date.textContent = formatCampDate(camp.date).full;
    const location = document.createElement("td");
    location.textContent = camp.location;
    const action = document.createElement("td");
    const remove = document.createElement("button");
    remove.className = "complete-button";
    remove.type = "button";
    remove.textContent = "Remove";
    remove.addEventListener("click", async () => {
      try {
        await api("/api/admin/camps/delete", {
          method: "POST",
          body: JSON.stringify({ id: camp.id }),
        });
        await loadStaffCamps();
        await loadCamps();
      } catch (error) {
        showMessage($("#camp-message"), error.message, true);
      }
    });
    action.append(remove);
    row.append(title, date, location, action);
    rows.append(row);
  }
}

async function showStaffDashboard() {
  staffLoginForm.hidden = true;
  staffDashboard.hidden = true;
  staffLoginMessage.hidden = true;
  try {
    await api("/api/admin/session");
    staffDashboard.hidden = false;
    await loadStaffPatients();
    await loadStaffCamps();
  } catch (error) {
    if (error.status === 401) {
      staffLoginForm.hidden = false;
      staffLoginForm.elements.password.value = "";
      return;
    }
    staffLoginForm.hidden = false;
    showMessage(staffLoginMessage, error.message, true);
  }
}

$("#camp-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const values = new FormData(form);
  const message = $("#camp-message");
  message.hidden = true;
  try {
    await api("/api/admin/camps", {
      method: "POST",
      body: JSON.stringify({
        title: String(values.get("title")).trim(),
        date: String(values.get("date")),
        location: String(values.get("location")).trim(),
        details: String(values.get("details")).trim(),
      }),
    });
    form.reset();
    showMessage(message, "Camp published on the public schedule.", false);
    await loadStaffCamps();
    await loadCamps();
  } catch (error) {
    showMessage(message, error.message, true);
  }
});

document.querySelectorAll(".staff-open").forEach((button) => {
  button.addEventListener("click", async () => {
    staffDialog.showModal();
    await showStaffDashboard();
  });
});

$("#qr-open").addEventListener("click", () => {
  qrMessage.hidden = true;
  qrDialog.showModal();
  startQrScanner();
});

$("#qr-start").addEventListener("click", startQrScanner);
$("#qr-stop").addEventListener("click", stopQrScanner);
$(".qr-close").addEventListener("click", () => qrDialog.close());
qrDialog.addEventListener("close", stopQrScanner);

$(".dialog-close").addEventListener("click", () => staffDialog.close());
staffDialog.addEventListener("click", (event) => {
  if (event.target === staffDialog) staffDialog.close();
});
staffDialog.addEventListener("close", () => {
  const wasUnlocked = !staffDashboard.hidden;
  staffDashboard.hidden = true;
  staffLoginForm.hidden = false;
  staffLoginForm.reset();
  if (wasUnlocked) {
    api("/api/admin/logout", { method: "POST", body: "{}" }).catch((error) => {
      console.error("Could not end the administrator session:", error);
    });
  }
});

staffLoginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  setStaffLoginMessage("", false);
  const password = new FormData(staffLoginForm).get("password");
  try {
    await api("/api/admin/login", {
      method: "POST",
      body: JSON.stringify({ password }),
    });
    await showStaffDashboard();
  } catch (error) {
    setStaffLoginMessage(error.message);
  }
});

$("#staff-logout").addEventListener("click", async () => {
  try {
    await api("/api/admin/logout", { method: "POST", body: "{}" });
  } catch (error) {
    showMessage(staffMessage, error.message, true);
  } finally {
    staffDashboard.hidden = true;
    staffLoginForm.hidden = false;
    staffLoginForm.reset();
  }
});

$("#call-next").addEventListener("click", async () => {
  const button = $("#call-next");
  button.disabled = true;
  try {
    const result = await api("/api/admin/call-next", {
      method: "POST",
      body: JSON.stringify({ department: $("#staff-department").value }),
    });
    const announcement = $("#staff-call-result");
    announcement.textContent = `Now calling ${result.token}.`;
    announcement.hidden = false;
    await loadStaffPatients();
    await refreshQueue();
  } catch (error) {
    showMessage(staffMessage, error.message, true);
  } finally {
    button.disabled = false;
  }
});

window.addEventListener("online", () => {
  syncPendingRegistrations();
  refreshQueue();
});

let installPrompt;
window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  installPrompt = event;
  $("#install-button").hidden = false;
});

$("#install-button").addEventListener("click", async () => {
  if (!installPrompt) return;
  installPrompt.prompt();
  await installPrompt.userChoice;
  installPrompt = null;
  $("#install-button").hidden = true;
});

window.addEventListener("load", async () => {
  const dateInput = $("#camp-form input[name=date]");
  const today = new Date();
  dateInput.min = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  try {
    await loadDepartments();
  } catch (error) {
    console.error("Could not load clinic departments:", error);
  }
  try {
    await loadCamps();
  } catch (error) {
    console.error("Could not load the camp schedule:", error);
  }
  refreshQueue();
  syncPendingRegistrations();
  window.setInterval(refreshQueue, 15_000);
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").catch((error) => {
      console.error("Offline support could not be started:", error);
    });
  }
});
