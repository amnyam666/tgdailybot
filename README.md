# tgdailybot мини-приложение

Telegram-бот и Telegram Mini App для управления задачами с хранением в SQLite.

## Что есть в проекте
- бот (`main.py`) с командами `/start`, `/app`, `/help`
- фронтенд мини-приложения (`webapp/`), который открывается кнопкой в Telegram
- REST API (`/api/*`) для добавления, чтения, изменения и удаления задач
- проверка подписи Telegram `initData` на backend
- база данных SQLite (`todo.sqlite3`)
- статическая версия для GitHub Pages в корне: `index.html`, `styles.css`, `app.js`

## GitHub Pages
1. Откройте `Settings -> Pages`.
2. В `Build and deployment` выберите `Deploy from a branch`.
3. В качестве source выберите вашу ветку и папку `/ (root)`.
4. После публикации откройте URL вида `https://<username>.github.io/<repo>/`.

## Требования
- Python 3.11+ (проверено на 3.14)
- публичный HTTPS URL для мини-приложения (требование Telegram)

## Установка
```powershell
python -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r requirements.txt
```

## Настройка токена
1. Создайте бота через `@BotFather`.
2. Вставьте токен в `bot_token.txt` вместо строки-шаблона.

## Переменные окружения
```powershell
$env:WEB_SERVER_HOST="127.0.0.1"
$env:WEB_SERVER_PORT="8080"
$env:TODO_DB_PATH="todo.sqlite3"
```

Опционально:
```powershell
$env:TELEGRAM_BOT_TOKEN_FILE="bot_token.txt"
$env:INIT_DATA_MAX_AGE_SECONDS="86400"
```

## Запуск
```powershell
python main.py
```

После запуска:
1. Откройте чат с ботом.
2. Отправьте `/start`.
3. Нажмите кнопку `Открыть мини-приложение`.

## Важно
- По умолчанию мини-приложение открывается по адресу `https://amnyam666.github.io/tgdailybot/`.
- Для этого бота URL мини-приложения зафиксирован в коде и не зависит от переменных окружения.
- `bot_token.txt`, `.venv` и локальная БД исключены из git.
