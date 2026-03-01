const tg = window.Telegram?.WebApp ?? null;
const initDataFromHash = new URLSearchParams(window.location.hash.slice(1)).get("tgWebAppData") || "";
const initData = tg?.initData || initDataFromHash;

function parseUserFromInitData(rawInitData) {
  if (!rawInitData) return null;
  try {
    const params = new URLSearchParams(rawInitData);
    const userRaw = params.get("user");
    if (!userRaw) return null;
    const user = JSON.parse(userRaw);
    if (!user || typeof user.id === "undefined") return null;
    return user;
  } catch {
    return null;
  }
}

const initDataUser = parseUserFromInitData(initData);
let backendProfileUser = null;

function getTelegramUser() {
  return tg?.initDataUnsafe?.user ?? initDataUser ?? backendProfileUser;
}

const startupTelegramUser = getTelegramUser();
const userId = startupTelegramUser?.id ? String(startupTelegramUser.id) : "guest";

const queryApi = new URLSearchParams(window.location.search).get("api") || "";
const defaultApi = window.location.hostname.endsWith("github.io") ? "" : window.location.origin;
const API_BASE_URL = (queryApi || defaultApi).replace(/\/+$/, "");
const BACKEND_MODE = Boolean(API_BASE_URL && initData);

const TASKS_KEY = `todo_tasks_${userId}`;
const SETTINGS_KEY = `todo_settings_${userId}`;
const MAX_TEXT_LENGTH = 300;

const RU_TIMEZONES = [
  { id: "Europe/Kaliningrad", label: "UTC+2 Калининград" },
  { id: "Europe/Moscow", label: "UTC+3 Москва" },
  { id: "Europe/Samara", label: "UTC+4 Самара" },
  { id: "Asia/Yekaterinburg", label: "UTC+5 Екатеринбург" },
  { id: "Asia/Omsk", label: "UTC+6 Омск" },
  { id: "Asia/Krasnoyarsk", label: "UTC+7 Красноярск" },
  { id: "Asia/Irkutsk", label: "UTC+8 Иркутск" },
  { id: "Asia/Yakutsk", label: "UTC+9 Якутск" },
  { id: "Asia/Vladivostok", label: "UTC+10 Владивосток" },
  { id: "Asia/Magadan", label: "UTC+11 Магадан" },
  { id: "Asia/Kamchatka", label: "UTC+12 Камчатка" },
];

const timezoneMap = new Map(RU_TIMEZONES.map((zone) => [zone.id, zone.label]));

const ui = {
  greetingText: document.getElementById("greeting-text"),
  clockTime: document.getElementById("clock-time"),
  clockDate: document.getElementById("clock-date"),
  timezoneSelect: document.getElementById("timezone-select"),
  chatNotifyEnabled: document.getElementById("chat-notify-enabled"),
  notifyBefore: document.getElementById("notify-before"),
  syncStatus: document.getElementById("sync-status"),
  taskInput: document.getElementById("task-input"),
  reminderInput: document.getElementById("reminder-input"),
  addBtn: document.getElementById("add-btn"),
  clearDoneBtn: document.getElementById("clear-done-btn"),
  taskList: document.getElementById("task-list"),
  emptyState: document.getElementById("empty-state"),
  stats: document.getElementById("stats"),
  filterButtons: Array.from(document.querySelectorAll(".filter")),
  toast: document.getElementById("toast"),
};

const state = {
  tasks: [],
  filter: "all",
  settings: {
    timezone: "Europe/Moscow",
    notifyBeforeMinutes: 0,
    chatNotificationsEnabled: true,
  },
  toastTimer: null,
};

function loadJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

function saveTasksLocal() {
  localStorage.setItem(TASKS_KEY, JSON.stringify(state.tasks));
}

function saveSettingsLocal() {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
}

function clampInt(value, min, max, fallback) {
  const num = Number.parseInt(String(value), 10);
  if (!Number.isFinite(num)) return fallback;
  if (num < min) return min;
  if (num > max) return max;
  return num;
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function showToast(text, isError = false) {
  if (!ui.toast) return;
  ui.toast.textContent = text;
  ui.toast.classList.remove("hidden");
  ui.toast.style.background = isError ? "#a91f49" : "#1f4d84";

  if (state.toastTimer) clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => {
    ui.toast.classList.add("hidden");
    state.toastTimer = null;
  }, 2600);
}

function getCurrentHour(timezone) {
  const formatted = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    hour12: false,
  }).format(new Date());
  return Number.parseInt(formatted, 10);
}

function getGreeting(timezone) {
  const hour = getCurrentHour(timezone);
  if (hour >= 17 && hour < 24) return "Добрый вечер";
  if (hour >= 0 && hour < 6) return "Доброй ночи";
  return "Добрый день";
}

function updateProfileAndGreeting() {
  const user = getTelegramUser();
  const username = String(user?.username || "").replace(/^@+/, "").trim();
  const fullName = [user?.first_name, user?.last_name].filter(Boolean).join(" ").trim();

  if (!user) {
    ui.greetingText.textContent = `${getGreeting(state.settings.timezone)}!`;
    return;
  }

  const nickname = username || fullName || user.first_name || `ID ${user.id}`;
  ui.greetingText.textContent = `${getGreeting(state.settings.timezone)}, ${nickname}!`;
}

function populateTimezones() {
  ui.timezoneSelect.innerHTML = "";
  for (const zone of RU_TIMEZONES) {
    const option = document.createElement("option");
    option.value = zone.id;
    option.textContent = zone.label;
    ui.timezoneSelect.appendChild(option);
  }
}

function setSyncStatus(text, isError = false) {
  ui.syncStatus.textContent = `Синхронизация: ${text}`;
  ui.syncStatus.style.color = isError ? "#b01d4f" : "";
}

function apiHeaders() {
  return {
    "Content-Type": "application/json",
    "X-Telegram-Init-Data": initData,
  };
}

async function apiRequest(path, options = {}) {
  if (!BACKEND_MODE) {
    throw new Error("Backend API не подключен.");
  }

  const response = await fetch(`${API_BASE_URL}${path}`, {
    method: options.method || "GET",
    headers: apiHeaders(),
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) {
    throw new Error(data.error || `HTTP ${response.status}`);
  }
  return data;
}

function getZoneParts(timestamp, timeZone) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = formatter.formatToParts(new Date(timestamp));
  const map = {};
  for (const part of parts) {
    if (part.type !== "literal") map[part.type] = part.value;
  }
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour),
    minute: Number(map.minute),
    second: Number(map.second),
  };
}

function zoneOffsetMs(timeZone, timestamp) {
  const p = getZoneParts(timestamp, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - timestamp;
}

function zonedLocalToUtcMs(datetimeValue, timeZone) {
  const [datePart, timePart] = String(datetimeValue).split("T");
  if (!datePart || !timePart) return null;

  const [year, month, day] = datePart.split("-").map((x) => Number.parseInt(x, 10));
  const [hour, minute] = timePart.split(":").map((x) => Number.parseInt(x, 10));
  if (![year, month, day, hour, minute].every(Number.isFinite)) return null;

  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  let result = utcGuess;
  for (let i = 0; i < 3; i += 1) {
    result = utcGuess - zoneOffsetMs(timeZone, result);
  }
  return result;
}

function formatReminderDate(timestamp) {
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: state.settings.timezone,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestamp));
}

function reminderMeta(task) {
  if (!task.reminderAt) return "Без напоминания";
  const when = formatReminderDate(task.reminderAt);
  const lead = state.settings.notifyBeforeMinutes;
  if (lead > 0) return `Напоминание: ${when} (за ${lead} мин)`;
  return `Напоминание: ${when}`;
}

function getVisibleTasks() {
  if (state.filter === "active") return state.tasks.filter((task) => !task.done);
  if (state.filter === "done") return state.tasks.filter((task) => task.done);
  return state.tasks;
}

function render() {
  const visibleTasks = getVisibleTasks();
  ui.taskList.innerHTML = "";

  for (const task of visibleTasks) {
    const li = document.createElement("li");
    li.className = "task-item";
    li.innerHTML = `
      <input type="checkbox" data-action="toggle" data-id="${task.id}" ${task.done ? "checked" : ""}>
      <div class="task-main">
        <div class="task-text ${task.done ? "done" : ""}">${escapeHtml(task.text)}</div>
        <div class="task-meta">${escapeHtml(reminderMeta(task))}</div>
      </div>
      <button type="button" class="icon-btn" data-action="edit" data-id="${task.id}">Изм.</button>
      <button type="button" class="icon-btn danger" data-action="delete" data-id="${task.id}">Удалить</button>
    `;
    ui.taskList.appendChild(li);
  }

  const activeCount = state.tasks.filter((task) => !task.done).length;
  ui.stats.textContent = `${activeCount} активных из ${state.tasks.length}`;
  ui.emptyState.style.display = visibleTasks.length === 0 ? "block" : "none";
}

function updateClock() {
  const now = new Date();
  ui.clockTime.textContent = new Intl.DateTimeFormat("ru-RU", {
    timeZone: state.settings.timezone,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(now);
  ui.clockDate.textContent = new Intl.DateTimeFormat("ru-RU", {
    timeZone: state.settings.timezone,
    weekday: "long",
    day: "2-digit",
    month: "long",
    year: "numeric",
  }).format(now);
  updateProfileAndGreeting();
}

function normalizeTask(raw) {
  const text = typeof raw?.text === "string" ? raw.text.trim().slice(0, MAX_TEXT_LENGTH) : "";
  if (!text) return null;

  return {
    id: String(raw.id),
    text,
    done: Boolean(raw.is_done ?? raw.done),
    reminderAt: Number.isFinite(Number(raw.reminder_at_ms ?? raw.reminderAt))
      ? Number(raw.reminder_at_ms ?? raw.reminderAt)
      : null,
  };
}

function normalizeSettings(raw) {
  return {
    timezone: timezoneMap.has(raw?.timezone) ? raw.timezone : "Europe/Moscow",
    notifyBeforeMinutes: clampInt(raw?.notify_before_minutes ?? raw?.notifyBeforeMinutes, 0, 120, 0),
    chatNotificationsEnabled: Boolean(raw?.chat_notifications_enabled ?? raw?.chatNotificationsEnabled ?? true),
  };
}

function applySettingsToUi() {
  ui.timezoneSelect.value = state.settings.timezone;
  ui.notifyBefore.value = String(state.settings.notifyBeforeMinutes);
  ui.chatNotifyEnabled.checked = state.settings.chatNotificationsEnabled;
}

function parseReminderFromInput() {
  const raw = ui.reminderInput.value.trim();
  if (!raw) return { ok: true, value: null };
  const ms = zonedLocalToUtcMs(raw, state.settings.timezone);
  if (!Number.isFinite(ms)) {
    return { ok: false, message: "Некорректная дата напоминания." };
  }
  if (ms < Date.now()) {
    return { ok: false, message: "Напоминание не может быть в прошлом." };
  }
  return { ok: true, value: ms };
}

async function loadBackendData() {
  try {
    setSyncStatus("загрузка...");
    const [profileData, settingsData, tasksData] = await Promise.all([
      apiRequest("/api/profile"),
      apiRequest("/api/settings"),
      apiRequest("/api/tasks"),
    ]);

    if (profileData.user) {
      backendProfileUser = profileData.user;
    }

    state.settings = normalizeSettings(settingsData.settings || {});
    state.tasks = Array.isArray(tasksData.tasks) ? tasksData.tasks.map(normalizeTask).filter(Boolean) : [];
    applySettingsToUi();
    render();
    updateClock();
    setSyncStatus("подключено");
  } catch (error) {
    setSyncStatus(error.message, true);
    showToast(`Ошибка синхронизации: ${error.message}`, true);
  }
}

function loadLocalData() {
  const rawSettings = loadJson(SETTINGS_KEY, state.settings);
  state.settings = normalizeSettings(rawSettings);
  const rawTasks = loadJson(TASKS_KEY, []);
  state.tasks = Array.isArray(rawTasks) ? rawTasks.map(normalizeTask).filter(Boolean) : [];

  applySettingsToUi();
  render();
  updateClock();
  setSyncStatus("автономно");
}

async function saveSettings() {
  if (BACKEND_MODE) {
    await apiRequest("/api/settings", {
      method: "PUT",
      body: {
        timezone: state.settings.timezone,
        notify_before_minutes: state.settings.notifyBeforeMinutes,
        chat_notifications_enabled: state.settings.chatNotificationsEnabled,
      },
    });
    return;
  }
  saveSettingsLocal();
}

async function addTask() {
  const text = ui.taskInput.value.trim();
  if (!text) {
    showToast("Введите текст задачи.", true);
    return;
  }

  const reminder = parseReminderFromInput();
  if (!reminder.ok) {
    showToast(reminder.message, true);
    return;
  }

  try {
    if (BACKEND_MODE) {
      await apiRequest("/api/tasks", {
        method: "POST",
        body: { text: text.slice(0, MAX_TEXT_LENGTH), reminder_at_ms: reminder.value },
      });
      await loadBackendData();
    } else {
      state.tasks.unshift({
        id: crypto.randomUUID(),
        text: text.slice(0, MAX_TEXT_LENGTH),
        done: false,
        reminderAt: reminder.value,
      });
      saveTasksLocal();
      render();
    }
    ui.taskInput.value = "";
    ui.reminderInput.value = "";
  } catch (error) {
    showToast(error.message, true);
  }
}

async function toggleTask(taskId, done) {
  try {
    if (BACKEND_MODE) {
      await apiRequest(`/api/tasks/${taskId}`, { method: "PATCH", body: { is_done: done } });
      await loadBackendData();
    } else {
      const task = state.tasks.find((item) => item.id === taskId);
      if (!task) return;
      task.done = done;
      saveTasksLocal();
      render();
    }
  } catch (error) {
    showToast(error.message, true);
  }
}

async function deleteTask(taskId) {
  try {
    if (BACKEND_MODE) {
      await apiRequest(`/api/tasks/${taskId}`, { method: "DELETE" });
      await loadBackendData();
    } else {
      state.tasks = state.tasks.filter((item) => item.id !== taskId);
      saveTasksLocal();
      render();
    }
  } catch (error) {
    showToast(error.message, true);
  }
}

function formatPromptReminder(ms) {
  if (!ms) return "";
  const p = getZoneParts(ms, state.settings.timezone);
  const y = String(p.year);
  const m = String(p.month).padStart(2, "0");
  const d = String(p.day).padStart(2, "0");
  const h = String(p.hour).padStart(2, "0");
  const min = String(p.minute).padStart(2, "0");
  return `${y}-${m}-${d} ${h}:${min}`;
}

function parsePromptReminder(text) {
  const trimmed = text.trim();
  if (!trimmed) return { ok: true, value: null };
  const normalized = trimmed.includes("T") ? trimmed : trimmed.replace(" ", "T");
  const ms = zonedLocalToUtcMs(normalized, state.settings.timezone);
  if (!Number.isFinite(ms)) return { ok: false, message: "Неверный формат даты." };
  if (ms < Date.now()) return { ok: false, message: "Напоминание не может быть в прошлом." };
  return { ok: true, value: ms };
}

async function editTask(taskId) {
  const task = state.tasks.find((item) => item.id === taskId);
  if (!task) return;

  const nextText = prompt("Изменить текст задачи:", task.text);
  if (nextText === null) return;
  const text = nextText.trim();
  if (!text) {
    showToast("Текст задачи не может быть пустым.", true);
    return;
  }

  const current = formatPromptReminder(task.reminderAt);
  const reminderRaw = prompt("Напоминание (ГГГГ-ММ-ДД ЧЧ:ММ, пусто - убрать):", current);
  if (reminderRaw === null) return;

  const parsed = parsePromptReminder(reminderRaw);
  if (!parsed.ok) {
    showToast(parsed.message, true);
    return;
  }

  try {
    if (BACKEND_MODE) {
      await apiRequest(`/api/tasks/${taskId}`, {
        method: "PATCH",
        body: { text: text.slice(0, MAX_TEXT_LENGTH), reminder_at_ms: parsed.value },
      });
      await loadBackendData();
    } else {
      task.text = text.slice(0, MAX_TEXT_LENGTH);
      task.reminderAt = parsed.value;
      saveTasksLocal();
      render();
    }
  } catch (error) {
    showToast(error.message, true);
  }
}

async function clearDone() {
  const doneTasks = state.tasks.filter((task) => task.done);
  if (doneTasks.length === 0) return;

  try {
    if (BACKEND_MODE) {
      for (const task of doneTasks) {
        await apiRequest(`/api/tasks/${task.id}`, { method: "DELETE" });
      }
      await loadBackendData();
    } else {
      state.tasks = state.tasks.filter((task) => !task.done);
      saveTasksLocal();
      render();
    }
  } catch (error) {
    showToast(error.message, true);
  }
}

function bindEvents() {
  ui.addBtn.addEventListener("click", addTask);
  ui.taskInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") addTask();
  });

  ui.clearDoneBtn.addEventListener("click", clearDone);
  for (const filterBtn of ui.filterButtons) {
    filterBtn.addEventListener("click", () => {
      state.filter = filterBtn.dataset.filter;
      for (const b of ui.filterButtons) b.classList.toggle("active", b === filterBtn);
      render();
    });
  }

  ui.taskList.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const action = target.dataset.action;
    const taskId = target.dataset.id;
    if (!action || !taskId) return;

    if (action === "delete") deleteTask(taskId);
    if (action === "edit") editTask(taskId);
  });

  ui.taskList.addEventListener("change", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) return;
    if (target.dataset.action !== "toggle" || !target.dataset.id) return;
    toggleTask(target.dataset.id, target.checked);
  });

  ui.timezoneSelect.addEventListener("change", async () => {
    const value = ui.timezoneSelect.value;
    if (!timezoneMap.has(value)) return;
    state.settings.timezone = value;
    updateClock();
    render();
    try {
      await saveSettings();
      setSyncStatus(BACKEND_MODE ? "подключено" : "автономно");
    } catch (error) {
      showToast(error.message, true);
    }
  });

  ui.notifyBefore.addEventListener("change", async () => {
    state.settings.notifyBeforeMinutes = clampInt(ui.notifyBefore.value, 0, 120, 0);
    ui.notifyBefore.value = String(state.settings.notifyBeforeMinutes);
    try {
      await saveSettings();
      setSyncStatus(BACKEND_MODE ? "подключено" : "автономно");
    } catch (error) {
      showToast(error.message, true);
    }
    render();
  });

  ui.chatNotifyEnabled.addEventListener("change", async () => {
    state.settings.chatNotificationsEnabled = ui.chatNotifyEnabled.checked;
    try {
      await saveSettings();
      if (state.settings.chatNotificationsEnabled) {
        showToast("Уведомления в чат включены.");
      } else {
        showToast("Уведомления в чат отключены.");
      }
    } catch (error) {
      showToast(error.message, true);
    }
  });
}

async function init() {
  if (tg) {
    tg.ready();
    tg.expand();
  }

  populateTimezones();

  if (BACKEND_MODE) {
    await loadBackendData();
  } else {
    loadLocalData();
    ui.chatNotifyEnabled.checked = false;
    ui.chatNotifyEnabled.disabled = true;
  }

  bindEvents();
  updateProfileAndGreeting();
  setInterval(updateClock, 1000);
}

init().catch((error) => {
  showToast(`Ошибка запуска: ${error.message}`, true);
});
