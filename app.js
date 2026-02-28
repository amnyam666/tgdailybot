const tg = window.Telegram?.WebApp ?? null;
const telegramUser = tg?.initDataUnsafe?.user ?? null;
const userId = telegramUser?.id ? String(telegramUser.id) : "guest";
const STORAGE_KEY = `todo_tasks_${userId}`;

const ui = {
  userLabel: document.getElementById("user-label"),
  taskInput: document.getElementById("task-input"),
  addBtn: document.getElementById("add-btn"),
  clearDoneBtn: document.getElementById("clear-done-btn"),
  taskList: document.getElementById("task-list"),
  emptyState: document.getElementById("empty-state"),
  stats: document.getElementById("stats"),
  filterButtons: Array.from(document.querySelectorAll(".filter")),
};

const state = {
  tasks: [],
  filter: "all",
};

function loadTasks() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function saveTasks() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state.tasks));
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
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

function render() {
  const visibleTasks = getVisibleTasks();
  ui.taskList.innerHTML = "";

  for (const task of visibleTasks) {
    const li = document.createElement("li");
    li.className = "task-item";
    li.innerHTML = `
      <input type="checkbox" data-action="toggle" data-id="${task.id}" ${task.done ? "checked" : ""}>
      <span class="task-text ${task.done ? "done" : ""}">${escapeHtml(task.text)}</span>
      <button type="button" class="icon-btn" data-action="edit" data-id="${task.id}">Изм.</button>
      <button type="button" class="icon-btn danger" data-action="delete" data-id="${task.id}">Удалить</button>
    `;
    ui.taskList.appendChild(li);
  }

  const activeCount = state.tasks.filter((task) => !task.done).length;
  ui.stats.textContent = `${activeCount} активных из ${state.tasks.length}`;
  ui.emptyState.style.display = visibleTasks.length === 0 ? "block" : "none";
}

function addTask() {
  const text = ui.taskInput.value.trim();
  if (!text) return;

  state.tasks.unshift({
    id: crypto.randomUUID(),
    text,
    done: false,
    createdAt: Date.now(),
  });
  saveTasks();
  ui.taskInput.value = "";
  render();
}

function toggleTask(taskId, done) {
  const task = state.tasks.find((item) => item.id === taskId);
  if (!task) return;
  task.done = done;
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

  const trimmed = nextText.trim();
  if (!trimmed) return;

  task.text = trimmed.slice(0, 300);
  saveTasks();
  render();
}

function clearDone() {
  state.tasks = state.tasks.filter((task) => !task.done);
  saveTasks();
  render();
}

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

if (tg) {
  tg.ready();
  tg.expand();
}

formatUserLabel();
state.tasks = loadTasks();
render();
