# Personal AI Client PRO 2.0

Веб-клиент для анализа JPG/PNG/WEBP/PDF/SLDDRW, подготовки Stock Removal и редактирования токарного контура X/Z под SINUMERIK 828D.

## PRO-функции

- анализ изображений, PDF и SLDDRW через OpenAI Responses API;
- безопасное извлечение встроенного PNG-превью из SLDDRW;
- отображение превью SLDDRW прямо в браузере;
- AI-предложение ориентировочного контура X/Z;
- Stock Removal для токарной и фрезерной обработки;
- интерактивный редактор точек X/Z;
- отдельные цвета для прямых X, прямых Z, дуг CW/CCW и фасок;
- перетаскивание точек мышкой, привязка к шагу, масштаб колесом;
- Undo/Redo, дублирование, удаление, разворот, замыкание и смещение контура;
- визуальное наложение заготовки;
- валидация координат, дуг и выхода за пределы заготовки;
- пошаговая карта ввода в SINUMERIK 828D;
- экспорт JSON, CSV и текстовой карты SINUMERIK;
- проекты в SQLite на Railway Volume;
- локальное автосохранение и автоматическая синхронизация открытого проекта;
- история анализов;
- адаптивный интерфейс Liquid Glass.

## Railway

1. Подключите GitHub-репозиторий к Railway.
2. Подключите Volume с Mount Path:

```text
/app/data
```

3. Добавьте переменные:

```text
OPENAI_API_KEY=...
OPENAI_MODEL=gpt-5-mini
MOCK_MODE=false
MAX_FILE_MB=20
KEEP_OPENAI_FILES=false
DATA_DIR=/app/data
```

4. Railway использует включённый `Dockerfile` и переменную `${PORT:-8000}` автоматически.
5. Healthcheck:

```text
/api/health
```

## Локальный запуск

```bash
cp .env.example .env
# заполните OPENAI_API_KEY или оставьте MOCK_MODE=true
./run.sh
```

Откройте `http://localhost:8000`.

## Горячие клавиши редактора

- `Ctrl/Cmd + Z` — отмена;
- `Ctrl/Cmd + Shift + Z` — повтор;
- `Delete` — удалить текущую точку;
- `A` — добавить точку;
- `S` — сохранить проект;
- стрелки влево/вправо — предыдущий/следующий шаг.

## Проверка

```bash
PYTHONPATH=. pytest -q
node --check app/static/app.js
python -m py_compile app/main.py
```

Перед вводом контура в стойку обязательно сверяйте размеры с исходным чертежом и фактической заготовкой.
