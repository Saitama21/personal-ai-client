#!/bin/bash
set -e
cd "$(dirname "$0")"

if [ ! -f .env ]; then
  cp .env.example .env
fi

printf "Вставьте OPENAI_API_KEY (ввод скрыт): "
IFS= read -rs OPENAI_KEY
printf "\n"

if [ -z "$OPENAI_KEY" ]; then
  echo "Ключ не введён. .env оставлен без изменений."
  exit 1
fi

python3 - "$OPENAI_KEY" <<'PY'
from pathlib import Path
import sys

key = sys.argv[1]
path = Path('.env')
lines = path.read_text(encoding='utf-8').splitlines()
result = []
found_key = False
found_mock = False
for line in lines:
    if line.startswith('OPENAI_API_KEY='):
        result.append('OPENAI_API_KEY=' + key)
        found_key = True
    elif line.startswith('MOCK_MODE='):
        result.append('MOCK_MODE=false')
        found_mock = True
    else:
        result.append(line)
if not found_key:
    result.append('OPENAI_API_KEY=' + key)
if not found_mock:
    result.append('MOCK_MODE=false')
path.write_text('\n'.join(result) + '\n', encoding='utf-8')
PY

unset OPENAI_KEY
echo "Готово. Ключ сохранён локально в .env, тестовый режим выключен."
echo "Теперь запустите run.command"
