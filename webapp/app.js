const tg = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;
const initData = tg ? tg.initData : "";

const ui = {
  helloText: document.getElementById("hello-text"),
  taskInput: document.getElementById("task-input"),
  addBtn: document.getElementById("add-btn"),
  refreshBtn: document.getElementById("refresh-btn"),
  tasksList: document.getElementById("tasks-list"),
  emptyState: document.getElementById("empty-state"),
  statusText: document.getElementById("status-text"),
};

if (tg) {
  tg.ready();
  tg.expand();
}

function setStatus(text, isError = false) {
  ui.statusText.textContent = text;
  ui.statusText.style.color = isError ? "#b42318" : "";
}

function setHelloText() {
  if (!tg || !tg.initDataUnsafe || !tg.initDataUnsafe.user) {
    ui.helloText.textContent = "Откройте эту страницу через кнопку мини-приложения в Telegram.";
    return;
  }

  const user = tg.initDataUnsafe.user;
  const fullName = [user.first_name, user.last_name].filter(Boolean).join(" ").trim();
  ui.helloText.textContent = fullName ? `Здравствуйте, ${fullName}` : `Здравствуйте, пользователь #${user.id}`;
}

function authHeaders() {
  return {
    "Content-Type": "application/json",
    "X-Telegram-Init-Data": initData,
  };
}

async function apiRequest(path, options = {}) {
  const response = await fetch(path, {
    method: options.method || "GET",
    headers: authHeaders(),
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) {
    const message = data.error || `Ошибка HTTP ${response.status}`;
    throw new Error(message);
  }
  return data;
}

function renderTasks(tasks) {
  ui.tasksList.innerHTML = "";
  ui.emptyState.classList.toggle("hidden", tasks.length > 0);

  for (const task of tasks) {
    const row = document.createElement("li");
    row.className = "task-row";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = task.is_done;
    checkbox.addEventListener("change", () => onToggleTask(task.id, checkbox.checked));

    const text = document.createElement("span");
    text.className = `task-text${task.is_done ? " done" : ""}`;
    text.textContent = task.text;

    const removeBtn = document.createElement("button");
    removeBtn.className = "delete-btn";
    removeBtn.type = "button";
    removeBtn.textContent = "Удалить";
    removeBtn.addEventListener("click", () => onDeleteTask(task.id));

    row.appendChild(checkbox);
    row.appendChild(text);
    row.appendChild(removeBtn);
    ui.tasksList.appendChild(row);
  }
}

async function loadTasks() {
  setStatus("Загружаем задачи...");
  try {
    const result = await apiRequest("/api/tasks");
    renderTasks(result.tasks || []);
    setStatus("Готово");
  } catch (error) {
    setStatus(error.message, true);
  }
}

async function onAddTask() {
  const text = ui.taskInput.value.trim();
  if (!text) {
    setStatus("Сначала введите текст задачи.", true);
    return;
  }

  setStatus("Добавляем задачу...");
  try {
    await apiRequest("/api/tasks", { method: "POST", body: { text } });
    ui.taskInput.value = "";
    await loadTasks();
  } catch (error) {
    setStatus(error.message, true);
  }
}

async function onToggleTask(taskId, isDone) {
  try {
    await apiRequest(`/api/tasks/${taskId}`, {
      method: "PATCH",
      body: { is_done: isDone },
    });
    await loadTasks();
  } catch (error) {
    setStatus(error.message, true);
  }
}

async function onDeleteTask(taskId) {
  try {
    await apiRequest(`/api/tasks/${taskId}`, { method: "DELETE" });
    await loadTasks();
  } catch (error) {
    setStatus(error.message, true);
  }
}

ui.addBtn.addEventListener("click", onAddTask);
ui.refreshBtn.addEventListener("click", loadTasks);
ui.taskInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    onAddTask();
  }
});

setHelloText();
loadTasks();
