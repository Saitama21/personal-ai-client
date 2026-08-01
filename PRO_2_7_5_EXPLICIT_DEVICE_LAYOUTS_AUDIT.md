# Personal AI Client PRO v2.7.5 — Explicit Device Layouts

- iPad определяется по `iPad` user-agent или `MacIntel + maxTouchPoints > 1`, а не по одной ширине viewport.
- Добавлены независимые режимы `phone`, `tablet`, `desktop` на `<html>` и `<body>`.
- Планшетный интерфейс принудительно активируется на iPad Pro 10.5 независимо от масштаба Safari, панели вкладок и ориентации.
- CSS-порог планшета расширен до 1400 px, но применяется только при классе `tablet-edition`.
- Устранены конфликты мобильных и desktop-стилей с Tablet UI.
- Добавлена поддержка планшетного portrait-layout; в landscape остаются мастер этапов, инспектор и нижняя панель.
- Cache-busting: `2.7.5-explicit-device-layouts`.
