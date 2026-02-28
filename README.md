# tgdailybot mini app

Telegram bot + Telegram Mini App for managing To-Do tasks with SQLite.

## What is in the project
- Telegram bot (`main.py`) with commands `/start`, `/app`, `/help`
- Mini app frontend (`webapp/`) opened from Telegram keyboard button
- REST API (`/api/*`) for task CRUD
- Telegram `initData` signature validation on backend
- SQLite storage (`todo.sqlite3`)

## Requirements
- Python 3.11+ (tested on 3.14)
- Public HTTPS URL for mini app (Telegram requirement)

## Install
```powershell
python -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r requirements.txt
```

## Configure token
1. Create bot in `@BotFather`.
2. Put token to `bot_token.txt` (replace placeholder line).

## Configure environment
```powershell
$env:WEB_APP_URL="https://YOUR_PUBLIC_DOMAIN"
$env:WEB_SERVER_HOST="127.0.0.1"
$env:WEB_SERVER_PORT="8080"
$env:TODO_DB_PATH="todo.sqlite3"
```

Optional:
```powershell
$env:TELEGRAM_BOT_TOKEN_FILE="bot_token.txt"
$env:INIT_DATA_MAX_AGE_SECONDS="86400"
```

## Run
```powershell
python main.py
```

After start:
1. Open chat with your bot.
2. Send `/start`.
3. Press `Open To-Do Mini App` button.

## Notes
- `WEB_APP_URL` must be HTTPS and publicly reachable by Telegram clients.
- For local development, use tunnel tools (for example, `ngrok` or `cloudflared`) and set tunnel HTTPS URL to `WEB_APP_URL`.
- `bot_token.txt`, `.venv`, and local DB are ignored by git.
