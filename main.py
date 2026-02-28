import asyncio
import atexit
import hashlib
import hmac
import json
import logging
import os
import socket
import sqlite3
import threading
import time
import urllib.parse
import urllib.request
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, TextIO
from urllib.parse import parse_qsl, quote
from zoneinfo import ZoneInfo

from flask import Flask, jsonify, request
from telegram import KeyboardButton, ReplyKeyboardMarkup, Update, WebAppInfo
from telegram.error import Conflict
from telegram.ext import Application, CommandHandler, ContextTypes

BASE_DIR = Path(__file__).resolve().parent

TOKEN_FILE_PATH = os.getenv("TELEGRAM_BOT_TOKEN_FILE", str(BASE_DIR / "bot_token.txt"))
LOCK_FILE_PATH = os.getenv("APP_LOCK_FILE", str(BASE_DIR / ".bot.lock"))
DB_PATH = os.getenv("TODO_DB_PATH", str(BASE_DIR / "todo.sqlite3"))

WEB_SERVER_HOST = os.getenv("WEB_SERVER_HOST", "0.0.0.0")
WEB_SERVER_PORT = int(os.getenv("WEB_SERVER_PORT", "8080"))
PUBLIC_API_BASE_URL = os.getenv("PUBLIC_API_BASE_URL", "")
API_ALLOWED_ORIGIN = os.getenv("API_ALLOWED_ORIGIN", "https://amnyam666.github.io")

MINI_APP_URL = "https://amnyam666.github.io/tgdailybot/"
INIT_DATA_MAX_AGE_SECONDS = int(os.getenv("INIT_DATA_MAX_AGE_SECONDS", "86400"))
MAX_TASK_LENGTH = 300
REMINDER_POLL_SECONDS = int(os.getenv("REMINDER_POLL_SECONDS", "20"))

DEFAULT_TIMEZONE = "Europe/Moscow"
RU_TIMEZONES = {
    "Europe/Kaliningrad",
    "Europe/Moscow",
    "Europe/Samara",
    "Asia/Yekaterinburg",
    "Asia/Omsk",
    "Asia/Krasnoyarsk",
    "Asia/Irkutsk",
    "Asia/Yakutsk",
    "Asia/Vladivostok",
    "Asia/Magadan",
    "Asia/Kamchatka",
}

reminder_stop_event = threading.Event()


def ensure_event_loop() -> None:
    try:
        asyncio.get_event_loop()
    except RuntimeError:
        asyncio.set_event_loop(asyncio.new_event_loop())


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


def get_connection() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def ensure_column(conn: sqlite3.Connection, table_name: str, column_name: str, definition: str) -> None:
    columns = conn.execute(f"PRAGMA table_info({table_name})").fetchall()
    exists = any(row["name"] == column_name for row in columns)
    if not exists:
        conn.execute(f"ALTER TABLE {table_name} ADD COLUMN {column_name} {definition}")


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
        ensure_column(conn, "tasks", "reminder_at_ms", "INTEGER")
        ensure_column(conn, "tasks", "notified_at_ms", "INTEGER")

        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS user_settings (
                user_id INTEGER PRIMARY KEY,
                timezone TEXT NOT NULL DEFAULT 'Europe/Moscow',
                notify_before_minutes INTEGER NOT NULL DEFAULT 0,
                chat_notifications_enabled INTEGER NOT NULL DEFAULT 1
            )
            """
        )
        conn.commit()


def validate_timezone(value: str) -> str:
    return value if value in RU_TIMEZONES else DEFAULT_TIMEZONE


def normalize_text(value: Any) -> str:
    text = str(value or "").strip()
    if not text:
        raise ValueError("Текст задачи не может быть пустым.")
    if len(text) > MAX_TASK_LENGTH:
        raise ValueError(f"Задача слишком длинная. Максимум {MAX_TASK_LENGTH} символов.")
    return text


def normalize_reminder(value: Any) -> int | None:
    if value is None or value == "":
        return None
    reminder = int(value)
    if reminder <= 0:
        raise ValueError("Некорректная дата напоминания.")
    return reminder


def get_or_create_settings(user_id: int) -> dict[str, Any]:
    with closing(get_connection()) as conn:
        row = conn.execute("SELECT * FROM user_settings WHERE user_id = ?", (user_id,)).fetchone()
        if row is None:
            conn.execute(
                """
                INSERT INTO user_settings (user_id, timezone, notify_before_minutes, chat_notifications_enabled)
                VALUES (?, ?, 0, 1)
                """,
                (user_id, DEFAULT_TIMEZONE),
            )
            conn.commit()
            row = conn.execute("SELECT * FROM user_settings WHERE user_id = ?", (user_id,)).fetchone()

    return {
        "timezone": validate_timezone(row["timezone"]),
        "notify_before_minutes": int(row["notify_before_minutes"]),
        "chat_notifications_enabled": bool(row["chat_notifications_enabled"]),
    }


def update_settings(
    user_id: int,
    timezone_value: str,
    notify_before_minutes: int,
    chat_notifications_enabled: bool,
) -> dict[str, Any]:
    timezone_value = validate_timezone(timezone_value)
    notify_before_minutes = max(0, min(120, int(notify_before_minutes)))
    enabled_int = 1 if chat_notifications_enabled else 0

    with closing(get_connection()) as conn:
        conn.execute(
            """
            INSERT INTO user_settings (user_id, timezone, notify_before_minutes, chat_notifications_enabled)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(user_id) DO UPDATE SET
                timezone = excluded.timezone,
                notify_before_minutes = excluded.notify_before_minutes,
                chat_notifications_enabled = excluded.chat_notifications_enabled
            """,
            (user_id, timezone_value, notify_before_minutes, enabled_int),
        )
        conn.commit()
    return get_or_create_settings(user_id)


def list_tasks(user_id: int) -> list[dict[str, Any]]:
    with closing(get_connection()) as conn:
        rows = conn.execute(
            """
            SELECT id, text, is_done, reminder_at_ms, created_at
            FROM tasks
            WHERE user_id = ?
            ORDER BY is_done ASC, COALESCE(reminder_at_ms, 32503680000000) ASC, id ASC
            """,
            (user_id,),
        ).fetchall()

    return [
        {
            "id": int(row["id"]),
            "text": row["text"],
            "is_done": bool(row["is_done"]),
            "reminder_at_ms": int(row["reminder_at_ms"]) if row["reminder_at_ms"] is not None else None,
            "created_at": row["created_at"],
        }
        for row in rows
    ]


def add_task(user_id: int, text_value: Any, reminder_value: Any) -> dict[str, Any]:
    get_or_create_settings(user_id)
    text = normalize_text(text_value)
    reminder_at_ms = normalize_reminder(reminder_value)

    with closing(get_connection()) as conn:
        cursor = conn.execute(
            """
            INSERT INTO tasks (user_id, text, is_done, reminder_at_ms, notified_at_ms)
            VALUES (?, ?, 0, ?, NULL)
            """,
            (user_id, text, reminder_at_ms),
        )
        conn.commit()
        task_id = int(cursor.lastrowid)

    return {
        "id": task_id,
        "text": text,
        "is_done": False,
        "reminder_at_ms": reminder_at_ms,
    }


def update_task(user_id: int, task_id: int, payload: dict[str, Any]) -> bool:
    updates: list[str] = []
    params: list[Any] = []

    if "text" in payload:
        updates.append("text = ?")
        params.append(normalize_text(payload["text"]))

    if "is_done" in payload:
        updates.append("is_done = ?")
        params.append(1 if bool(payload["is_done"]) else 0)

    if "reminder_at_ms" in payload:
        reminder_at_ms = normalize_reminder(payload["reminder_at_ms"])
        updates.append("reminder_at_ms = ?")
        params.append(reminder_at_ms)
        updates.append("notified_at_ms = NULL")

    if not updates:
        return False

    params.extend([user_id, task_id])
    query = f"UPDATE tasks SET {', '.join(updates)} WHERE user_id = ? AND id = ?"

    with closing(get_connection()) as conn:
        cursor = conn.execute(query, params)
        conn.commit()
        return cursor.rowcount > 0


def delete_task(user_id: int, task_id: int) -> bool:
    with closing(get_connection()) as conn:
        cursor = conn.execute("DELETE FROM tasks WHERE user_id = ? AND id = ?", (user_id, task_id))
        conn.commit()
        return cursor.rowcount > 0


def validate_telegram_init_data(init_data: str, bot_token: str) -> dict[str, Any]:
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
    if int(time.time()) - auth_date > INIT_DATA_MAX_AGE_SECONDS:
        raise ValueError("Сессия Telegram истекла. Откройте мини-приложение заново.")

    user_json = parsed.get("user")
    if not user_json:
        raise ValueError("Некорректный Telegram initData: пользователь не найден.")

    user = json.loads(user_json)
    return {"user_id": int(user["id"]), "user": user}


def format_datetime_for_timezone(timestamp_ms: int, timezone_name: str) -> str:
    zone_name = validate_timezone(timezone_name)
    dt = datetime.fromtimestamp(timestamp_ms / 1000, tz=timezone.utc).astimezone(ZoneInfo(zone_name))
    return dt.strftime("%d.%m.%Y %H:%M")


def send_telegram_message(token: str, chat_id: int, text: str) -> bool:
    url = f"https://api.telegram.org/bot{token}/sendMessage"
    payload = urllib.parse.urlencode({"chat_id": str(chat_id), "text": text}).encode("utf-8")
    req = urllib.request.Request(url, data=payload, method="POST")

    try:
        with urllib.request.urlopen(req, timeout=15) as response:
            body = response.read().decode("utf-8")
            data = json.loads(body)
            return bool(data.get("ok"))
    except Exception as exc:  # noqa: BLE001
        logging.error("Ошибка отправки Telegram-сообщения user_id=%s: %s", chat_id, exc)
        return False


def find_due_reminders(now_ms: int) -> list[sqlite3.Row]:
    with closing(get_connection()) as conn:
        rows = conn.execute(
            """
            SELECT
                t.id,
                t.user_id,
                t.text,
                t.reminder_at_ms,
                s.timezone,
                s.notify_before_minutes
            FROM tasks t
            JOIN user_settings s ON s.user_id = t.user_id
            WHERE t.is_done = 0
              AND t.reminder_at_ms IS NOT NULL
              AND t.notified_at_ms IS NULL
              AND s.chat_notifications_enabled = 1
              AND (t.reminder_at_ms - (s.notify_before_minutes * 60000)) <= ?
            ORDER BY t.reminder_at_ms ASC
            LIMIT 200
            """,
            (now_ms,),
        ).fetchall()
    return rows


def mark_task_notified(task_id: int, notified_at_ms: int) -> None:
    with closing(get_connection()) as conn:
        conn.execute("UPDATE tasks SET notified_at_ms = ? WHERE id = ?", (notified_at_ms, task_id))
        conn.commit()


def reminder_worker(token: str) -> None:
    while not reminder_stop_event.is_set():
        now_ms = int(time.time() * 1000)
        rows = find_due_reminders(now_ms)

        for row in rows:
            reminder_at_ms = int(row["reminder_at_ms"])
            timezone_name = validate_timezone(row["timezone"])
            date_text = format_datetime_for_timezone(reminder_at_ms, timezone_name)
            message = (
                "Напоминание о задаче\n\n"
                f"Задача: {row['text']}\n"
                f"Дата: {date_text} ({timezone_name})"
            )

            sent = send_telegram_message(token, int(row["user_id"]), message)
            if sent:
                mark_task_notified(int(row["id"]), now_ms)

        reminder_stop_event.wait(max(5, REMINDER_POLL_SECONDS))


def create_web_server(token: str) -> Flask:
    app = Flask(__name__)

    def api_error(message: str, status: int):
        return jsonify({"ok": False, "error": message}), status

    def resolve_origin_header() -> str:
        if API_ALLOWED_ORIGIN == "*":
            return "*"
        req_origin = request.headers.get("Origin", "")
        if req_origin == API_ALLOWED_ORIGIN:
            return req_origin
        return API_ALLOWED_ORIGIN

    @app.after_request
    def add_cors_headers(response):
        response.headers["Access-Control-Allow-Origin"] = resolve_origin_header()
        response.headers["Access-Control-Allow-Headers"] = "Content-Type, X-Telegram-Init-Data"
        response.headers["Access-Control-Allow-Methods"] = "GET, POST, PUT, PATCH, DELETE, OPTIONS"
        return response

    @app.route("/api/<path:path>", methods=["OPTIONS"])
    def api_options(path: str):  # noqa: ARG001
        return ("", 204)

    def get_auth_payload() -> dict[str, Any]:
        init_data = request.headers.get("X-Telegram-Init-Data", "").strip()
        return validate_telegram_init_data(init_data, token)

    @app.get("/api/health")
    def api_health():
        return jsonify({"ok": True})

    @app.get("/api/profile")
    def api_profile():
        try:
            payload = get_auth_payload()
        except ValueError as exc:
            return api_error(str(exc), 401)
        return jsonify({"ok": True, "user": payload["user"]})

    @app.get("/api/settings")
    def api_get_settings():
        try:
            payload = get_auth_payload()
        except ValueError as exc:
            return api_error(str(exc), 401)
        settings = get_or_create_settings(int(payload["user_id"]))
        return jsonify({"ok": True, "settings": settings})

    @app.put("/api/settings")
    def api_put_settings():
        try:
            payload = get_auth_payload()
        except ValueError as exc:
            return api_error(str(exc), 401)

        body = request.get_json(silent=True) or {}
        timezone_value = validate_timezone(str(body.get("timezone", DEFAULT_TIMEZONE)))
        notify_before_minutes = clamp_int(body.get("notify_before_minutes"), 0, 120, 0)
        chat_notifications_enabled = bool(body.get("chat_notifications_enabled", True))

        settings = update_settings(
            int(payload["user_id"]),
            timezone_value,
            notify_before_minutes,
            chat_notifications_enabled,
        )
        return jsonify({"ok": True, "settings": settings})

    @app.get("/api/tasks")
    def api_get_tasks():
        try:
            payload = get_auth_payload()
        except ValueError as exc:
            return api_error(str(exc), 401)
        tasks = list_tasks(int(payload["user_id"]))
        return jsonify({"ok": True, "tasks": tasks})

    @app.post("/api/tasks")
    def api_post_tasks():
        try:
            payload = get_auth_payload()
        except ValueError as exc:
            return api_error(str(exc), 401)

        body = request.get_json(silent=True) or {}
        try:
            task = add_task(
                int(payload["user_id"]),
                body.get("text", ""),
                body.get("reminder_at_ms"),
            )
        except ValueError as exc:
            return api_error(str(exc), 400)
        return jsonify({"ok": True, "task": task}), 201

    @app.patch("/api/tasks/<int:task_id>")
    def api_patch_task(task_id: int):
        try:
            payload = get_auth_payload()
        except ValueError as exc:
            return api_error(str(exc), 401)

        body = request.get_json(silent=True) or {}
        try:
            updated = update_task(int(payload["user_id"]), task_id, body)
        except ValueError as exc:
            return api_error(str(exc), 400)

        if not updated:
            return api_error("Задача не найдена или данные не изменены.", 404)
        return jsonify({"ok": True})

    @app.delete("/api/tasks/<int:task_id>")
    def api_delete_task(task_id: int):
        try:
            payload = get_auth_payload()
        except ValueError as exc:
            return api_error(str(exc), 401)

        deleted = delete_task(int(payload["user_id"]), task_id)
        if not deleted:
            return api_error("Задача не найдена.", 404)
        return jsonify({"ok": True})

    return app


def clamp_int(value: Any, minimum: int, maximum: int, fallback: int) -> int:
    try:
        number = int(value)
    except (TypeError, ValueError):
        return fallback
    return max(minimum, min(maximum, number))


def run_web_server(app: Flask) -> None:
    app.run(host=WEB_SERVER_HOST, port=WEB_SERVER_PORT, debug=False, use_reloader=False)


def build_mini_app_url() -> str:
    base = MINI_APP_URL
    api_url = PUBLIC_API_BASE_URL.strip()
    if not api_url:
        return base
    sep = "&" if "?" in base else "?"
    return f"{base}{sep}api={quote(api_url, safe='')}"


def build_webapp_keyboard() -> ReplyKeyboardMarkup:
    button = KeyboardButton("Открыть мини-приложение", web_app=WebAppInfo(url=build_mini_app_url()))
    return ReplyKeyboardMarkup([[button]], resize_keyboard=True)


async def start_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:  # noqa: ARG001
    if not update.message:
        return
    await update.message.reply_text(
        "Откройте мини-приложение кнопкой ниже.",
        reply_markup=build_webapp_keyboard(),
    )


async def app_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:  # noqa: ARG001
    if not update.message:
        return
    await update.message.reply_text("Открыть мини-приложение:", reply_markup=build_webapp_keyboard())


async def help_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:  # noqa: ARG001
    if not update.message:
        return
    await update.message.reply_text(
        "Команды:\n"
        "/start - показать кнопку мини-приложения\n"
        "/app - открыть кнопку мини-приложения\n"
        "/help - показать это сообщение"
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
    web_thread = threading.Thread(target=run_web_server, args=(web_server,), daemon=True)
    web_thread.start()
    logging.info("API запущен: http://%s:%s", WEB_SERVER_HOST, WEB_SERVER_PORT)

    reminder_thread = threading.Thread(target=reminder_worker, args=(token,), daemon=True)
    reminder_thread.start()
    logging.info("Сервис напоминаний запущен")

    ensure_event_loop()
    app = Application.builder().token(token).build()
    app.add_handler(CommandHandler("start", start_command))
    app.add_handler(CommandHandler("app", app_command))
    app.add_handler(CommandHandler("help", help_command))

    try:
        app.run_polling(allowed_updates=Update.ALL_TYPES)
    except Conflict as exc:
        raise RuntimeError(
            "Telegram вернул 409 Conflict: этот токен уже используется в другом процессе."
        ) from exc
    finally:
        reminder_stop_event.set()


if __name__ == "__main__":
    main()
