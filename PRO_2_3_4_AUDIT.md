# PRO 2.3.4 Draft Reset + Glass Brand — audit

## Исправлено

- локальный draft восстанавливает инженерные данные, но не показывает старое имя файла без реального `File`;
- явное открытие проекта или загрузка из истории сохраняет справочное имя исходного файла;
- «Очистить файл» удаляет `state.file`, `state.restoredFileName`, preview и немедленно перезаписывает draft;
- логотип ROZFOOD и подпись создателя переведены в отдельные Liquid Glass-компоненты.

## Проверка

- Backend: 26/26 passed
- Python syntax: OK
- JavaScript syntax: OK
- HTML ID: 251
- JS → HTML: 223/223
- Missing IDs: 0
- API version: 2.3.4-pro
