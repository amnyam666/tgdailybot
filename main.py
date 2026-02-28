import asyncio
import atexit
import hashlib
import hmac
import json
import logging
import os
import socket
import sqlite3
import time
from contextlib import closing
from pathlib import Path
from threading import Thread
from typing import TextIO
from urllib.parse import parse_qsl

from flask import Flask, jsonify, request, send_from_directory
from telegram import KeyboardButton, ReplyKeyboardMarkup, Update, WebAppInfo
from telegram.error import Conflict
from telegram.ext import Application, CommandHandler, ContextTypes

BASE_DIR = Path(__file__).resolve().parent
WEBAPP_DIR = BASE_DIR / "webapp"

DB_PATH = os.getenv("TODO_DB_PATH", str(BASE_DIR / "todo.sqlite3"))
TOKEN_FILE_PATH = os.getenv("TELEGRAM_BOT_TOKEN_FILE", str(BASE_DIR / "bot_token.txt"))
LOCK_FILE_PATH = os.getenv("APP_LOCK_FILE", str(BASE_DIR / ".bot.lock"))

WEB_APP_URL = os.getenv("WEB_APP_URL", "https://example.com")
WEB_SERVER_HOST = os.getenv("WEB_SERVER_HOST", "127.0.0.1")
WEB_SERVER_PORT = int(os.getenv("WEB_SERVER_PORT", "8080"))

MAX_TASK_LENGTH = 300
INIT_DATA_MAX_AGE_SECONDS = int(os.getenv("INIT_DATA_MAX_AGE_SECONDS", "86400"))


def acquire_single_instance_lock(lock_file_path: str) -> TextIO:
    lock_file = open(lock_file_path, "a+", encoding="utf-8")
    try:
        if os.name == "nt":
            import msvcrt

            lock_file.seek(0)
            msvcrt.locking(lock_file.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl

            fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError as exc:
        lock_file.close()
        raise RuntimeError(
            "Уже запущен другой экземпляр бота. Остановите предыдущий процесс main.py."
        ) from exc

    lock_file.seek(0)
    lock_file.truncate(0)
    lock_file.write(str(os.getpid()))
    lock_file.flush()
    return lock_file


def release_single_instance_lock(lock_file: TextIO) -> None:
    try:
        if os.name == "nt":
            import msvcrt

            lock_file.seek(0)
            msvcrt.locking(lock_file.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            import fcntl

            fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)
    except OSError:
        pass
    finally:
        lock_file.close()


def ensure_web_server_port_available(host: str, port: int) -> None:
    probe_host = "127.0.0.1" if host in {"0.0.0.0", "::"} else host
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(0.5)
        if sock.connect_ex((probe_host, port)) == 0:
            raise RuntimeError(
                f"Порт {port} на {probe_host} уже занят. "
                "Остановите старый процесс или измените WEB_SERVER_PORT."
            )


def get_connection() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    with closing(get_connection()) as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS tasks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                text TEXT NOT NULL,
                is_done INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
        conn.commit()


def list_tasks(user_id: int) -> list[dict]:
    with closing(get_connection()) as conn:
        cursor = conn.execute(
            """
            SELECT id, text, is_done, created_at
            FROM tasks
            WHERE user_id = ?
            ORDER BY is_done ASC, id ASC
            """,
            (user_id,),
        )
        rows = cursor.fetchall()
    return [
        {
            "id": int(row["id"]),
            "text": row["text"],
            "is_done": bool(row["is_done"]),
            "created_at": row["created_at"],
        }
        for row in rows
    ]


def add_task(user_id: int, text: str) -> dict:
    text = text.strip()
    if not text:
        raise ValueError("Текст задачи не может быть пустым.")
    if len(text) > MAX_TASK_LENGTH:
        raise ValueError(f"Задача слишком длинная. Максимум {MAX_TASK_LENGTH} символов.")

    with closing(get_connection()) as conn:
        cursor = conn.execute(
            "INSERT INTO tasks (user_id, text) VALUES (?, ?)",
            (user_id, text),
        )
        conn.commit()
        task_id = int(cursor.lastrowid)
    return {"id": task_id, "text": text, "is_done": False}


def update_task_status(user_id: int, task_id: int, is_done: bool) -> bool:
    with closing(get_connection()) as conn:
        cursor = conn.execute(
            "UPDATE tasks SET is_done = ? WHERE user_id = ? AND id = ?",
            (1 if is_done else 0, user_id, task_id),
        )
        conn.commit()
        return cursor.rowcount > 0


def delete_task(user_id: int, task_id: int) -> bool:
    with closing(get_connection()) as conn:
        cursor = conn.execute(
            "DELETE FROM tasks WHERE user_id = ? AND id = ?",
            (user_id, task_id),
        )
        conn.commit()
        return cursor.rowcount > 0


def load_bot_token(token_file_path: str) -> str:
    if not os.path.exists(token_file_path):
        raise RuntimeError(
            f"Файл токена не найден: {token_file_path}. "
            "Создайте файл и добавьте в него токен Telegram-бота."
        )

    with open(token_file_path, "r", encoding="utf-8") as token_file:
        token = token_file.read().strip()

    if not token or token == "PASTE_YOUR_BOT_TOKEN_HERE":
        raise RuntimeError(
            f"Токен в файле {token_file_path} не задан. "
            "Замените шаблон на реальный токен от @BotFather."
        )
    return token


def ensure_event_loop() -> None:
    try:
        asyncio.get_event_loop()
    except RuntimeError:
        asyncio.set_event_loop(asyncio.new_event_loop())


def validate_telegram_init_data(init_data: str, bot_token: str) -> dict:
    if not init_data:
        raise ValueError("Отсутствует Telegram initData.")

    parsed = dict(parse_qsl(init_data, keep_blank_values=True))
    received_hash = parsed.pop("hash", None)
    if not received_hash:
        raise ValueError("Некорректный Telegram initData: отсутствует hash.")

    data_check_string = "\n".join(f"{key}={value}" for key, value in sorted(parsed.items()))
    secret_key = hmac.new(
        key=b"WebAppData",
        msg=bot_token.encode("utf-8"),
        digestmod=hashlib.sha256,
    ).digest()
    computed_hash = hmac.new(
        key=secret_key,
        msg=data_check_string.encode("utf-8"),
        digestmod=hashlib.sha256,
    ).hexdigest()

    if not hmac.compare_digest(received_hash, computed_hash):
        raise ValueError("Некорректная подпись Telegram initData.")

    auth_date_raw = parsed.get("auth_date")
    if not auth_date_raw or not auth_date_raw.isdigit():
        raise ValueError("Некорректный Telegram initData: неверный auth_date.")
    auth_date = int(auth_date_raw)
    now = int(time.time())
    if now - auth_date > INIT_DATA_MAX_AGE_SECONDS:
        raise ValueError("Сессия Telegram истекла. Откройте мини-приложение заново.")

    user_json = parsed.get("user")
    if not user_json:
        raise ValueError("Некорректный Telegram initData: пользователь не найден.")

    user = json.loads(user_json)
    user_id = int(user["id"])
    return {"user_id": user_id, "user": user}


def create_web_server(bot_token: str) -> Flask:
    app = Flask(__name__)

    def api_error(message: str, status: int):
        return jsonify({"ok": False, "error": message}), status

    def get_authorized_user_id() -> int:
        init_data = request.headers.get("X-Telegram-Init-Data", "").strip()
        payload = validate_telegram_init_data(init_data, bot_token)
        return int(payload["user_id"])

    @app.get("/")
    def index():
        return send_from_directory(WEBAPP_DIR, "index.html")

    @app.get("/app.js")
    def app_js():
        return send_from_directory(WEBAPP_DIR, "app.js")

    @app.get("/styles.css")
    def styles_css():
        return send_from_directory(WEBAPP_DIR, "styles.css")

    @app.get("/api/health")
    def health():
        return jsonify({"ok": True})

    @app.get("/api/tasks")
    def api_list_tasks():
        try:
            user_id = get_authorized_user_id()
        except ValueError as exc:
            return api_error(str(exc), 401)
        return jsonify({"ok": True, "tasks": list_tasks(user_id)})

    @app.post("/api/tasks")
    def api_add_task():
        try:
            user_id = get_authorized_user_id()
        except ValueError as exc:
            return api_error(str(exc), 401)

        payload = request.get_json(silent=True) or {}
        text = str(payload.get("text", "")).strip()
        try:
            task = add_task(user_id, text)
        except ValueError as exc:
            return api_error(str(exc), 400)
        return jsonify({"ok": True, "task": task}), 201

    @app.patch("/api/tasks/<int:task_id>")
    def api_update_task(task_id: int):
        try:
            user_id = get_authorized_user_id()
        except ValueError as exc:
            return api_error(str(exc), 401)

        payload = request.get_json(silent=True) or {}
        is_done = payload.get("is_done")
        if not isinstance(is_done, bool):
            return api_error("Поле 'is_done' должно быть булевым значением.", 400)

        updated = update_task_status(user_id, task_id, is_done)
        if not updated:
            return api_error("Задача не найдена.", 404)
        return jsonify({"ok": True})

    @app.delete("/api/tasks/<int:task_id>")
    def api_delete_task(task_id: int):
        try:
            user_id = get_authorized_user_id()
        except ValueError as exc:
            return api_error(str(exc), 401)

        deleted = delete_task(user_id, task_id)
        if not deleted:
            return api_error("Задача не найдена.", 404)
        return jsonify({"ok": True})

    return app


def run_web_server(app: Flask) -> None:
    app.run(
        host=WEB_SERVER_HOST,
        port=WEB_SERVER_PORT,
        debug=False,
        use_reloader=False,
    )


def build_webapp_keyboard() -> ReplyKeyboardMarkup:
    button = KeyboardButton("Открыть мини-приложение", web_app=WebAppInfo(url=WEB_APP_URL))
    return ReplyKeyboardMarkup([[button]], resize_keyboard=True)


async def start_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not update.message:
        return

    await update.message.reply_text(
        "Мини-приложение задач готово.\n"
        "Нажмите кнопку ниже, чтобы открыть список задач.",
        reply_markup=build_webapp_keyboard(),
    )


async def help_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not update.message:
        return
    await update.message.reply_text(
        "Команды:\n"
        "/start - показать кнопку мини-приложения\n"
        "/app - снова показать кнопку мини-приложения\n"
        "/help - показать это сообщение"
    )


async def app_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not update.message:
        return
    await update.message.reply_text(
        "Открыть мини-приложение:",
        reply_markup=build_webapp_keyboard(),
    )


def main() -> None:
    lock_file = acquire_single_instance_lock(LOCK_FILE_PATH)
    atexit.register(release_single_instance_lock, lock_file)

    token = load_bot_token(TOKEN_FILE_PATH)

    logging.basicConfig(
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        level=logging.INFO,
    )

    init_db()
    ensure_web_server_port_available(WEB_SERVER_HOST, WEB_SERVER_PORT)

    web_server = create_web_server(token)
    web_thread = Thread(target=run_web_server, args=(web_server,), daemon=True)
    web_thread.start()
    logging.info("Веб-сервер запущен: http://%s:%s", WEB_SERVER_HOST, WEB_SERVER_PORT)

    ensure_event_loop()
    app = Application.builder().token(token).build()
    app.add_handler(CommandHandler("start", start_command))
    app.add_handler(CommandHandler("help", help_command))
    app.add_handler(CommandHandler("app", app_command))
    try:
        app.run_polling(allowed_updates=Update.ALL_TYPES)
    except Conflict as exc:
        raise RuntimeError(
            "Telegram вернул 409 Conflict: этот токен уже используется в другом процессе."
        ) from exc


if __name__ == "__main__":
    main()
