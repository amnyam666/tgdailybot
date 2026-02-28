# tgdailybot мини-приложение

Telegram-бот + Telegram Mini App для задач с напоминаниями в чат бота.

## Что реализовано
- Профиль пользователя в шапке mini app.
- Приветствие по времени суток (утро/день/вечер) по выбранному часовому поясу.
- Выбор часового пояса (только РФ).
- Задачи с датой/временем напоминания.
- Настройка уведомлений: включить/выключить и "за сколько минут напоминать".
- Напоминания приходят в чат с ботом с текстом и датой задачи.

## Файлы
- `main.py` — бот + API + фоновый сервис напоминаний.
- `index.html`, `styles.css`, `app.js` — frontend mini app для GitHub Pages.

## URL mini app
Мини-приложение открывается по адресу:

`https://amnyam666.github.io/tgdailybot/`

Кнопка бота использует этот URL.

## Важно про backend
Frontend размещен на GitHub Pages (статический), а API и отправка напоминаний в чат выполняются backend-сервисом из `main.py`.

Чтобы mini app на GitHub Pages мог работать с API, backend должен быть доступен по публичному HTTPS URL.

Укажите его в переменной:

```powershell
$env:PUBLIC_API_BASE_URL="https://your-backend-domain"
```

Бот автоматически откроет mini app с параметром `?api=...`.

## Установка
```powershell
python -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r requirements.txt
```

## Настройка
1. Создайте бота через `@BotFather`.
2. Вставьте токен в `bot_token.txt`.
3. Настройте переменные:

```powershell
$env:WEB_SERVER_HOST="0.0.0.0"
$env:WEB_SERVER_PORT="8080"
$env:TODO_DB_PATH="todo.sqlite3"
$env:PUBLIC_API_BASE_URL="https://your-backend-domain"
$env:API_ALLOWED_ORIGIN="https://amnyam666.github.io"
```

Опционально:

```powershell
$env:TELEGRAM_BOT_TOKEN_FILE="bot_token.txt"
$env:INIT_DATA_MAX_AGE_SECONDS="86400"
$env:REMINDER_POLL_SECONDS="20"
```

## Запуск
```powershell
python main.py
```

После запуска:
1. Откройте чат с ботом.
2. Отправьте `/start`.
3. Нажмите `Открыть мини-приложение`.
4. Создайте задачу с напоминанием — уведомление придет в чат бота.
