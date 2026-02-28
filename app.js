const tg = window.Telegram?.WebApp ?? null;
const telegramUser = tg?.initDataUnsafe?.user ?? null;
const userId = telegramUser?.id ? String(telegramUser.id) : "guest";

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
  userLabel: document.getElementById("user-label"),
  clockTime: document.getElementById("clock-time"),
  clockDate: document.getElementById("clock-date"),
  timezoneSelect: document.getElementById("timezone-select"),
  notificationsEnabled: document.getElementById("notifications-enabled"),
  notifyBefore: document.getElementById("notify-before"),
  requestNotifyBtn: document.getElementById("request-notify-btn"),
  notifyPermission: document.getElementById("notify-permission"),
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
    notificationsEnabled: false,
    notifyBeforeMinutes: 0,
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

function saveTasks() {
  localStorage.setItem(TASKS_KEY, JSON.stringify(state.tasks));
}

function saveSettings() {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
}

function normalizeTask(raw) {
  const text = typeof raw?.text === "string" ? raw.text.trim().slice(0, MAX_TEXT_LENGTH) : "";
  if (!text) return null;

  return {
    id: typeof raw.id === "string" && raw.id ? raw.id : crypto.randomUUID(),
    text,
    done: Boolean(raw.done),
    createdAt: Number(raw.createdAt) || Date.now(),
    reminderAt: Number.isFinite(Number(raw.reminderAt)) ? Number(raw.reminderAt) : null,
    notifiedFor: Number.isFinite(Number(raw.notifiedFor)) ? Number(raw.notifiedFor) : null,
  };
}

function loadTasks() {
  const rawTasks = loadJson(TASKS_KEY, []);
  if (!Array.isArray(rawTasks)) return [];
  return rawTasks.map(normalizeTask).filter(Boolean);
}

function loadSettings() {
  const raw = loadJson(SETTINGS_KEY, state.settings);
  const timezone = timezoneMap.has(raw?.timezone) ? raw.timezone : "Europe/Moscow";
  const notifyBeforeMinutes = clampInt(raw?.notifyBeforeMinutes, 0, 120, 0);
  return {
    timezone,
    notificationsEnabled: Boolean(raw?.notificationsEnabled),
    notifyBeforeMinutes,
  };
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

  if (state.toastTimer) {
    clearTimeout(state.toastTimer);
  }
  state.toastTimer = setTimeout(() => {
    ui.toast.classList.add("hidden");
    state.toastTimer = null;
  }, 2600);
}

function formatUserLabel() {
  if (!telegramUser) {
    ui.userLabel.textContent = "Локальный режим (без Telegram профиля)";
    return;
  }

  const fullName = [telegramUser.first_name, telegramUser.last_name].filter(Boolean).join(" ").trim();
  ui.userLabel.textContent = fullName
    ? `Пользователь: ${fullName}`
    : `Пользователь ID: ${telegramUser.id}`;
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

function updatePermissionStatus() {
  if (!("Notification" in window)) {
    ui.notifyPermission.textContent = "Статус: браузер не поддерживает уведомления";
    return;
  }

  const map = {
    granted: "разрешены",
    denied: "запрещены",
    default: "не запрошены",
  };
  ui.notifyPermission.textContent = `Статус: ${map[Notification.permission] ?? "неизвестно"}`;
}

function setupSettingsUi() {
  ui.timezoneSelect.value = state.settings.timezone;
  ui.notificationsEnabled.checked = state.settings.notificationsEnabled;
  ui.notifyBefore.value = String(state.settings.notifyBeforeMinutes);
  updatePermissionStatus();
}

function setFilter(filter) {
  state.filter = filter;
  for (const btn of ui.filterButtons) {
    btn.classList.toggle("active", btn.dataset.filter === filter);
  }
  render();
}

function getVisibleTasks() {
  if (state.filter === "active") {
    return state.tasks.filter((task) => !task.done);
  }
  if (state.filter === "done") {
    return state.tasks.filter((task) => task.done);
  }
  return state.tasks;
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
    if (part.type !== "literal") {
      map[part.type] = part.value;
    }
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

function formatForReminderPrompt(timestamp) {
  const p = getZoneParts(timestamp, state.settings.timezone);
  const y = String(p.year);
  const m = String(p.month).padStart(2, "0");
  const d = String(p.day).padStart(2, "0");
  const h = String(p.hour).padStart(2, "0");
  const min = String(p.minute).padStart(2, "0");
  return `${y}-${m}-${d} ${h}:${min}`;
}

function parseReminderPromptValue(value) {
  const trimmed = value.trim();
  if (!trimmed) return { ok: true, value: null };

  const normalized = trimmed.includes("T") ? trimmed : trimmed.replace(" ", "T");
  const timestamp = zonedLocalToUtcMs(normalized, state.settings.timezone);
  if (!Number.isFinite(timestamp)) {
    return { ok: false, message: "Неверный формат времени. Используйте ГГГГ-ММ-ДД ЧЧ:ММ." };
  }
  return { ok: true, value: timestamp };
}

function currentReminderInputToUtc() {
  const raw = ui.reminderInput.value.trim();
  if (!raw) return { ok: true, value: null };

  const timestamp = zonedLocalToUtcMs(raw, state.settings.timezone);
  if (!Number.isFinite(timestamp)) {
    return { ok: false, message: "Некорректная дата напоминания." };
  }
  return { ok: true, value: timestamp };
}

function addTask() {
  const text = ui.taskInput.value.trim();
  if (!text) {
    showToast("Введите текст задачи.", true);
    return;
  }

  const reminder = currentReminderInputToUtc();
  if (!reminder.ok) {
    showToast(reminder.message, true);
    return;
  }
  if (reminder.value && reminder.value < Date.now()) {
    showToast("Напоминание не может быть в прошлом.", true);
    return;
  }

  state.tasks.unshift({
    id: crypto.randomUUID(),
    text: text.slice(0, MAX_TEXT_LENGTH),
    done: false,
    createdAt: Date.now(),
    reminderAt: reminder.value,
    notifiedFor: null,
  });
  saveTasks();
  ui.taskInput.value = "";
  ui.reminderInput.value = "";
  render();
}

function toggleTask(taskId, done) {
  const task = state.tasks.find((item) => item.id === taskId);
  if (!task) return;

  task.done = done;
  if (done) {
    task.notifiedFor = null;
  }
  saveTasks();
  render();
}

function deleteTask(taskId) {
  state.tasks = state.tasks.filter((item) => item.id !== taskId);
  saveTasks();
  render();
}

function editTask(taskId) {
  const task = state.tasks.find((item) => item.id === taskId);
  if (!task) return;

  const nextText = prompt("Изменить текст задачи:", task.text);
  if (nextText === null) return;

  const trimmedText = nextText.trim();
  if (!trimmedText) {
    showToast("Текст задачи не может быть пустым.", true);
    return;
  }

  const zoneLabel = timezoneMap.get(state.settings.timezone) || state.settings.timezone;
  const currentReminder = task.reminderAt ? formatForReminderPrompt(task.reminderAt) : "";
  const rawReminder = prompt(
    `Напоминание (${zoneLabel}). Формат: ГГГГ-ММ-ДД ЧЧ:ММ. Пусто - убрать:`,
    currentReminder,
  );

  let nextReminder = task.reminderAt;
  if (rawReminder !== null) {
    const parsed = parseReminderPromptValue(rawReminder);
    if (!parsed.ok) {
      showToast(parsed.message, true);
      return;
    }
    if (parsed.value && parsed.value < Date.now()) {
      showToast("Напоминание не может быть в прошлом.", true);
      return;
    }
    nextReminder = parsed.value;
  }

  task.text = trimmedText.slice(0, MAX_TEXT_LENGTH);
  task.reminderAt = nextReminder;
  task.notifiedFor = null;
  saveTasks();
  render();
}

function clearDone() {
  state.tasks = state.tasks.filter((task) => !task.done);
  saveTasks();
  render();
}

function updateClock() {
  const now = new Date();
  const timeText = new Intl.DateTimeFormat("ru-RU", {
    timeZone: state.settings.timezone,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(now);
  const dateText = new Intl.DateTimeFormat("ru-RU", {
    timeZone: state.settings.timezone,
    weekday: "long",
    day: "2-digit",
    month: "long",
    year: "numeric",
  }).format(now);

  ui.clockTime.textContent = timeText;
  ui.clockDate.textContent = dateText;
}

function sendSystemNotification(title, body, tag) {
  if (!("Notification" in window)) return false;
  if (Notification.permission !== "granted") return false;

  try {
    new Notification(title, { body, tag });
    return true;
  } catch {
    return false;
  }
}

function emitReminder(task) {
  const when = formatReminderDate(task.reminderAt);
  const title = "Напоминание о задаче";
  const body = `${task.text}\n${when}`;
  const sentSystem = sendSystemNotification(title, body, `todo-reminder-${task.id}`);

  if (!sentSystem) {
    showToast(`Напоминание: ${task.text}`);
    return;
  }
  showToast(`Системное уведомление: ${task.text}`);
}

function checkReminders() {
  if (!state.settings.notificationsEnabled) return;

  const now = Date.now();
  const leadMs = state.settings.notifyBeforeMinutes * 60_000;
  let changed = false;

  for (const task of state.tasks) {
    if (task.done || !task.reminderAt) continue;

    const triggerAt = task.reminderAt - leadMs;
    if (now < triggerAt) {
      continue;
    }

    if (task.notifiedFor === triggerAt) {
      continue;
    }

    emitReminder(task);
    task.notifiedFor = triggerAt;
    changed = true;
  }

  if (changed) {
    saveTasks();
    render();
  }
}

function bindEvents() {
  ui.addBtn.addEventListener("click", addTask);
  ui.taskInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      addTask();
    }
  });

  ui.clearDoneBtn.addEventListener("click", clearDone);
  for (const filterBtn of ui.filterButtons) {
    filterBtn.addEventListener("click", () => setFilter(filterBtn.dataset.filter));
  }

  ui.taskList.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;

    const action = target.dataset.action;
    const taskId = target.dataset.id;
    if (!action || !taskId) return;

    if (action === "delete") {
      deleteTask(taskId);
    } else if (action === "edit") {
      editTask(taskId);
    }
  });

  ui.taskList.addEventListener("change", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) return;
    if (target.dataset.action !== "toggle" || !target.dataset.id) return;
    toggleTask(target.dataset.id, target.checked);
  });

  ui.timezoneSelect.addEventListener("change", () => {
    const value = ui.timezoneSelect.value;
    if (!timezoneMap.has(value)) return;
    state.settings.timezone = value;
    saveSettings();
    updateClock();
    render();
  });

  ui.notificationsEnabled.addEventListener("change", () => {
    state.settings.notificationsEnabled = ui.notificationsEnabled.checked;
    saveSettings();
    if (state.settings.notificationsEnabled && "Notification" in window && Notification.permission === "default") {
      showToast("Нажмите 'Разрешить уведомления', чтобы включить системные уведомления.");
    }
  });

  ui.notifyBefore.addEventListener("change", () => {
    state.settings.notifyBeforeMinutes = clampInt(ui.notifyBefore.value, 0, 120, 0);
    ui.notifyBefore.value = String(state.settings.notifyBeforeMinutes);
    saveSettings();
    checkReminders();
    render();
  });

  ui.requestNotifyBtn.addEventListener("click", async () => {
    if (!("Notification" in window)) {
      showToast("Браузер не поддерживает уведомления.", true);
      return;
    }

    try {
      await Notification.requestPermission();
      updatePermissionStatus();
      if (Notification.permission === "granted") {
        showToast("Уведомления разрешены.");
      } else {
        showToast("Разрешение на уведомления не выдано.", true);
      }
    } catch {
      showToast("Не удалось запросить разрешение на уведомления.", true);
    }
  });
}

function init() {
  if (tg) {
    tg.ready();
    tg.expand();
  }

  populateTimezones();
  formatUserLabel();

  state.settings = loadSettings();
  state.tasks = loadTasks();

  setupSettingsUi();
  bindEvents();
  render();
  updateClock();
  checkReminders();

  setInterval(updateClock, 1000);
  setInterval(checkReminders, 15_000);
}

init();
