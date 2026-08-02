# Railway

Переменные:

```text
MOCK_MODE=false
OPENAI_MODE=live
OPENAI_API_KEY=sk-proj-...
KEEP_OPENAI_FILES=false
MAX_FILE_MB=20
DATA_DIR=/data
APP_VERSION=4.2.1-single-source-dimensions
```

После deploy проверьте `/api/health`. PDF формируется сервером через ReportLab и скачивается из этапа «Экспорт».
