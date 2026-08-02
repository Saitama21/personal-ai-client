# Personal AI Client PRO v3.0.1 — Local Fallback Audit

Контрольный чертёж: Палец, AISI 304, Ø16×31, Ø10×12, M8×15, AF13×4, фаска 0.5×45°.

Проверено:
- /api/analyze распознаёт M8×1.25, Ø10×12, AF13 и цепочку 15+12+4=31;
- /api/stock-removal строит точки X/Z Ø16 Z0, Ø16 Z-4, Ø10 Z-4, Ø10 Z-16, Ø8 Z-16, Ø8 Z-31;
- /api/contour-ai возвращает hybrid и secondary_features AF13;
- старый демонстрационный контур Ø140/Ø130 отсутствует;
- 49 pytest-тестов пройдено.
