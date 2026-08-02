from __future__ import annotations

import io
import math
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    BaseDocTemplate,
    Flowable,
    Frame,
    KeepTogether,
    PageBreak,
    PageTemplate,
    Paragraph,
    Spacer,
    Table,
    TableStyle,
)

FONT_REGULAR = "Helvetica"
FONT_BOLD = "Helvetica-Bold"


def _register_fonts() -> None:
    global FONT_REGULAR, FONT_BOLD
    candidates = [
        (
            Path("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"),
            Path("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"),
        ),
        (
            Path("/usr/share/fonts/dejavu/DejaVuSansCondensed.ttf"),
            Path("/usr/share/fonts/dejavu/DejaVuSansCondensed-Bold.ttf"),
        ),
    ]
    for regular, bold in candidates:
        if regular.exists() and bold.exists():
            pdfmetrics.registerFont(TTFont("ROZRegular", str(regular)))
            pdfmetrics.registerFont(TTFont("ROZBold", str(bold)))
            FONT_REGULAR = "ROZRegular"
            FONT_BOLD = "ROZBold"
            return


_register_fonts()


def _safe(value: Any, fallback: str = "—") -> str:
    if value is None:
        return fallback
    text = str(value).strip()
    return text or fallback


def _fmt_number(value: Any, suffix: str = "") -> str:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return "—"
    if math.isclose(number, round(number), abs_tol=1e-9):
        text = str(int(round(number)))
    else:
        text = f"{number:.3f}".rstrip("0").rstrip(".")
    return f"{text}{suffix}"


class ContourDrawing(Flowable):
    def __init__(self, points: list[list[float]] | list[dict[str, Any]], width: float = 170 * mm, height: float = 66 * mm):
        super().__init__()
        self.points = points
        self.width = width
        self.height = height

    def wrap(self, avail_width, avail_height):
        return min(self.width, avail_width), self.height

    def draw(self):
        parsed: list[tuple[float, float]] = []
        for point in self.points:
            try:
                if isinstance(point, dict):
                    parsed.append((float(point.get("x")), float(point.get("z"))))
                else:
                    parsed.append((float(point[0]), float(point[1])))
            except (TypeError, ValueError, IndexError):
                continue
        canvas = self.canv
        w, h = self.width, self.height
        canvas.saveState()
        canvas.setFillColor(colors.HexColor("#F3F7FB"))
        canvas.roundRect(0, 0, w, h, 3 * mm, fill=1, stroke=0)
        canvas.setStrokeColor(colors.HexColor("#B8C6D5"))
        canvas.setLineWidth(0.4)
        for i in range(1, 8):
            x = w * i / 8
            canvas.line(x, 0, x, h)
        for i in range(1, 4):
            y = h * i / 4
            canvas.line(0, y, w, y)
        if len(parsed) < 2:
            canvas.setFillColor(colors.HexColor("#51606F"))
            canvas.setFont(FONT_REGULAR, 9)
            canvas.drawCentredString(w / 2, h / 2, "Контур X/Z не зафиксирован")
            canvas.restoreState()
            return
        max_x = max(abs(x) for x, _ in parsed) or 1.0
        min_z = min(z for _, z in parsed)
        max_z = max(z for _, z in parsed)
        z_span = max(max_z - min_z, 1.0)
        margin = 9 * mm
        sx = lambda z: margin + (z - min_z) / z_span * (w - 2 * margin)
        sy = lambda x: h / 2 + x / max_x * (h / 2 - margin)
        canvas.setStrokeColor(colors.HexColor("#008FC7"))
        canvas.setLineWidth(1.8)
        path = canvas.beginPath()
        path.moveTo(sx(parsed[0][1]), sy(parsed[0][0]))
        for x, z in parsed[1:]:
            path.lineTo(sx(z), sy(x))
        canvas.drawPath(path)
        mirror = canvas.beginPath()
        mirror.moveTo(sx(parsed[0][1]), h - sy(parsed[0][0]))
        for x, z in parsed[1:]:
            mirror.lineTo(sx(z), h - sy(x))
        canvas.drawPath(mirror)
        canvas.setFillColor(colors.HexColor("#6F4BD8"))
        canvas.setFont(FONT_REGULAR, 6.8)
        for idx, (x, z) in enumerate(parsed, 1):
            px, py = sx(z), sy(x)
            canvas.circle(px, py, 1.2 * mm, fill=1, stroke=0)
            canvas.setFillColor(colors.HexColor("#1F2C38"))
            canvas.drawString(px + 2 * mm, py + 1.4 * mm, f"P{idx} X{x:g} Z{z:g}")
            canvas.setFillColor(colors.HexColor("#6F4BD8"))
        canvas.restoreState()


def _styles() -> dict[str, ParagraphStyle]:
    base = getSampleStyleSheet()
    return {
        "title": ParagraphStyle(
            "title",
            parent=base["Title"],
            fontName=FONT_BOLD,
            fontSize=20,
            leading=24,
            textColor=colors.HexColor("#10283B"),
            alignment=TA_LEFT,
            spaceAfter=5 * mm,
        ),
        "subtitle": ParagraphStyle(
            "subtitle",
            parent=base["Normal"],
            fontName=FONT_REGULAR,
            fontSize=9,
            leading=13,
            textColor=colors.HexColor("#526677"),
            spaceAfter=4 * mm,
        ),
        "h1": ParagraphStyle(
            "h1",
            parent=base["Heading1"],
            fontName=FONT_BOLD,
            fontSize=13,
            leading=16,
            textColor=colors.HexColor("#063B5A"),
            spaceBefore=4 * mm,
            spaceAfter=2.5 * mm,
        ),
        "h2": ParagraphStyle(
            "h2",
            parent=base["Heading2"],
            fontName=FONT_BOLD,
            fontSize=10.5,
            leading=13,
            textColor=colors.HexColor("#14465F"),
            spaceBefore=2.5 * mm,
            spaceAfter=1.5 * mm,
        ),
        "body": ParagraphStyle(
            "body",
            parent=base["BodyText"],
            fontName=FONT_REGULAR,
            fontSize=8.7,
            leading=12,
            textColor=colors.HexColor("#263743"),
            spaceAfter=1.8 * mm,
        ),
        "small": ParagraphStyle(
            "small",
            parent=base["BodyText"],
            fontName=FONT_REGULAR,
            fontSize=7.4,
            leading=10,
            textColor=colors.HexColor("#526677"),
        ),
        "warning": ParagraphStyle(
            "warning",
            parent=base["BodyText"],
            fontName=FONT_BOLD,
            fontSize=8.2,
            leading=11,
            textColor=colors.HexColor("#7C2C1B"),
        ),
        "center": ParagraphStyle(
            "center",
            parent=base["BodyText"],
            fontName=FONT_REGULAR,
            fontSize=8,
            leading=10,
            alignment=TA_CENTER,
        ),
    }


def _p(text: Any, style: ParagraphStyle) -> Paragraph:
    escaped = _safe(text).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    return Paragraph(escaped.replace("\n", "<br/>"), style)


def _table(rows: list[list[Any]], widths: list[float] | None = None, header: bool = False) -> Table:
    styles = _styles()
    data = [[_p(cell, styles["small"]) for cell in row] for row in rows]
    table = Table(data, colWidths=widths, repeatRows=1 if header else 0, hAlign="LEFT")
    commands = [
        ("FONTNAME", (0, 0), (-1, -1), FONT_REGULAR),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("GRID", (0, 0), (-1, -1), 0.35, colors.HexColor("#C5D1DC")),
        ("BACKGROUND", (0, 0), (-1, -1), colors.white),
        ("LEFTPADDING", (0, 0), (-1, -1), 4),
        ("RIGHTPADDING", (0, 0), (-1, -1), 4),
        ("TOPPADDING", (0, 0), (-1, -1), 3),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
    ]
    if header:
        commands += [
            ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#DDEEF7")),
            ("FONTNAME", (0, 0), (-1, 0), FONT_BOLD),
            ("TEXTCOLOR", (0, 0), (-1, 0), colors.HexColor("#123D55")),
        ]
    table.setStyle(TableStyle(commands))
    return table


def _header_footer(canvas, doc):
    canvas.saveState()
    width, height = A4
    canvas.setStrokeColor(colors.HexColor("#7DCBEA"))
    canvas.setLineWidth(0.7)
    canvas.line(18 * mm, height - 14 * mm, width - 18 * mm, height - 14 * mm)
    canvas.setFont(FONT_BOLD, 7)
    canvas.setFillColor(colors.HexColor("#174964"))
    canvas.drawString(18 * mm, height - 11 * mm, "ROZFOOD CNC ASSISTANT")
    canvas.setFont(FONT_REGULAR, 7)
    canvas.setFillColor(colors.HexColor("#607587"))
    canvas.drawRightString(width - 18 * mm, height - 11 * mm, "Sinumerik 828D / ShopTurn - карта оператора")
    canvas.line(18 * mm, 13 * mm, width - 18 * mm, 13 * mm)
    canvas.drawString(18 * mm, 9 * mm, "Режимы являются стартовыми рекомендациями и требуют проверки оператором.")
    canvas.drawRightString(width - 18 * mm, 9 * mm, f"Страница {doc.page}")
    canvas.restoreState()


def build_operator_pdf(snapshot: dict[str, Any]) -> bytes:
    if not isinstance(snapshot, dict):
        raise ValueError("Snapshot проекта должен быть объектом")
    styles = _styles()
    buffer = io.BytesIO()
    doc = BaseDocTemplate(
        buffer,
        pagesize=A4,
        leftMargin=18 * mm,
        rightMargin=18 * mm,
        topMargin=20 * mm,
        bottomMargin=18 * mm,
        title=f"Карта оператора - {_safe(snapshot.get('projectName'), 'Проект')}",
        author="ROZFOOD CNC Assistant",
    )
    frame = Frame(doc.leftMargin, doc.bottomMargin, doc.width, doc.height, id="normal")
    doc.addPageTemplates(PageTemplate(id="operator", frames=[frame], onPage=_header_footer))

    fields = snapshot.get("fields") if isinstance(snapshot.get("fields"), dict) else {}
    stock = snapshot.get("stock") if isinstance(snapshot.get("stock"), dict) else {}
    geometry = snapshot.get("geometry") if isinstance(snapshot.get("geometry"), dict) else {}
    contour = snapshot.get("contour") if isinstance(snapshot.get("contour"), list) else []
    af_contour = snapshot.get("afContour") if isinstance(snapshot.get("afContour"), list) else []
    tools = snapshot.get("tools") if isinstance(snapshot.get("tools"), list) else []
    route = snapshot.get("route") if isinstance(snapshot.get("route"), list) else []
    done = snapshot.get("done") if isinstance(snapshot.get("done"), list) else []
    warnings = []
    for key in ("warnings", "assumptions"):
        values = geometry.get(key, [])
        if isinstance(values, list):
            warnings.extend(_safe(value) for value in values if _safe(value) != "—")

    generated = snapshot.get("finalizedAt") or snapshot.get("created_at") or datetime.now(timezone.utc).isoformat()
    machine = snapshot.get("machine") if isinstance(snapshot.get("machine"), dict) else {}
    machine_name = _safe(machine.get("name"), "Tengyue CK52PT-Y")
    control = _safe(machine.get("control"), "SINUMERIK 828D")

    story: list[Any] = []
    story += [
        Spacer(1, 3 * mm),
        _p("КАРТА ОПЕРАТОРА CNC", styles["title"]),
        _p("Пошаговая инструкция по переносу подтверждённых результатов проекта в SINUMERIK 828D / ShopTurn", styles["subtitle"]),
        _table(
            [
                ["Проект", _safe(snapshot.get("projectName"), "Новый проект")],
                ["Станок", machine_name],
                ["Стойка", control],
                ["Материал", _safe(fields.get("material"))],
                ["Режим", _safe(fields.get("mode"), "токарный / токарно-фрезерный")],
                ["Итог зафиксирован", _safe(generated)],
            ],
            widths=[45 * mm, 125 * mm],
        ),
        Spacer(1, 4 * mm),
        _p(
            "ВАЖНО: документ сформирован из зафиксированного результата проекта. Перед запуском программы оператор обязан проверить чертёж, зажим, вылет инструмента, коррекции, лимиты станка, материал заготовки и безопасный пробный проход.",
            styles["warning"],
        ),
        _p("1. Подготовка проекта на стойке", styles["h1"]),
        _table(
            [
                ["Шаг", "Действие на SINUMERIK 828D / ShopTurn", "Что внести / проверить"],
                ["1", "Открыть Program Manager и создать новую ShopTurn-программу", _safe(snapshot.get("projectName"), "Новый проект")],
                ["2", "Открыть заголовок программы / данные заготовки", f"Материал: {_safe(fields.get('material'))}; заготовка Ø{_fmt_number(fields.get('blankDiameter'))} × {_fmt_number(fields.get('overallLength'), ' мм')}"],
                ["3", "Выбрать рабочую систему координат", f"X0: {_safe(stock.get('x0'), 'ось детали')}; Z0: {_safe(stock.get('z0'), 'правый торец')}"],
                ["4", "Проверить припуски", f"По диаметру: {_fmt_number(stock.get('allowanceD'), ' мм')}; по длине: {_fmt_number(stock.get('allowanceL'), ' мм')}"],
                ["5", "Выполнить графическую проверку без резания", "Single Block, Dry Run, уменьшенная подача, безопасный отвод"],
            ],
            widths=[12 * mm, 75 * mm, 83 * mm],
            header=True,
        ),
        _p("2. Исходные размеры и особенности", styles["h1"]),
        _table(
            [
                ["Параметр", "Подтверждённое значение"],
                ["Общая длина", _fmt_number(fields.get("overallLength"), " мм")],
                ["Диаметр заготовки", _fmt_number(fields.get("blankDiameter"), " мм")],
                ["Резьба", _safe(fields.get("thread"))],
                ["Длина резьбы", _fmt_number(fields.get("threadLength"), " мм")],
                ["Ступень", f"Ø{_fmt_number(fields.get('stepDiameter'))}, L={_fmt_number(fields.get('stepLength'), ' мм')}"],
                ["Головка", f"Ø{_fmt_number(fields.get('headDiameter'))}, L={_fmt_number(fields.get('headLength'), ' мм')}"],
                ["AF / размер по граням", _safe(fields.get("af"))],
                ["Фаска", _safe(fields.get("chamfer"))],
                ["Допуски", _safe(fields.get("tolerances"))],
            ],
            widths=[58 * mm, 112 * mm],
            header=True,
        ),
        _p("3. Контур X/Z", styles["h1"]),
        _p("Координаты приведены в системе проекта. Для токарного программирования X обычно задаётся в диаметрах; проверьте параметризацию конкретной стойки.", styles["body"]),
        ContourDrawing(contour),
        Spacer(1, 2 * mm),
    ]
    contour_rows = [["Точка", "X", "Z"]]
    for idx, point in enumerate(contour, 1):
        if isinstance(point, dict):
            x, z = point.get("x"), point.get("z")
        elif isinstance(point, (list, tuple)) and len(point) >= 2:
            x, z = point[0], point[1]
        else:
            continue
        contour_rows.append([f"P{idx}", _fmt_number(x), _fmt_number(z)])
    if len(contour_rows) == 1:
        contour_rows.append(["—", "—", "—"])
    story.append(_table(contour_rows, widths=[30 * mm, 60 * mm, 60 * mm], header=True))

    story += [
        _p("4. AF-контур и приводной инструмент", styles["h1"]),
        _table(
            [
                ["Параметр", "Значение / действие"],
                ["Размер AF", _safe(fields.get("af"))],
                ["Геометрия AF", f"{len(af_contour)} точек" if af_contour else "Не зафиксирована"],
                ["Ось C", "Индексирование по числу граней; проверить C0 и шаг поворота"],
                ["Приводной инструмент", "Проверить направление вращения, вылет и безопасный подход"],
                ["Контроль", "AF не включать в токарный X/Z-контур; выполнить отдельной фрезерной операцией"],
            ],
            widths=[55 * mm, 115 * mm],
            header=True,
        ),
        PageBreak(),
        _p("5. Инструменты и коррекции", styles["h1"]),
    ]
    tool_rows = [["№", "T / D", "Инструмент", "Vc / S", "Подача", "ap", "Что проверить"]]
    for idx, tool in enumerate(tools, 1):
        if isinstance(tool, dict):
            t = _safe(tool.get("t") or tool.get("toolT"), str(idx))
            d = _safe(tool.get("d") or tool.get("toolD"), str(idx))
            name = _safe(tool.get("name") or tool.get("tool") or tool.get("insert"))
            speed = _safe(tool.get("speed") or tool.get("rpm") or tool.get("vc"))
            feed = _safe(tool.get("feed"))
            ap = _safe(tool.get("ap") or tool.get("depth"))
        elif isinstance(tool, (list, tuple)):
            vals = list(tool) + [""] * 7
            t, name, d, speed, feed, ap = _safe(vals[0], str(idx)), _safe(vals[1]), _safe(vals[2], str(idx)), _safe(vals[3]), _safe(vals[4]), _safe(vals[5])
        else:
            t, d, name, speed, feed, ap = str(idx), str(idx), _safe(tool), "—", "—", "—"
        tool_rows.append([str(idx), f"T{t} / D{d}", name, speed, feed, ap, "Ориентация, вылет, радиус пластины, коррекция"])
    if len(tool_rows) == 1:
        tool_rows.append(["—", "—", "Инструменты не зафиксированы", "—", "—", "—", "—"])
    story.append(_table(tool_rows, widths=[9 * mm, 20 * mm, 42 * mm, 23 * mm, 20 * mm, 17 * mm, 39 * mm], header=True))

    story += [_p("6. Последовательность ввода операций в ShopTurn", styles["h1"])]
    if route:
        for idx, operation in enumerate(route, 1):
            tool = tools[idx - 1] if idx - 1 < len(tools) else None
            if isinstance(tool, (list, tuple)):
                tool_name = _safe(tool[1] if len(tool) > 1 else None)
                speed = _safe(tool[3] if len(tool) > 3 else None)
                feed = _safe(tool[4] if len(tool) > 4 else None)
                ap = _safe(tool[5] if len(tool) > 5 else None)
            elif isinstance(tool, dict):
                tool_name = _safe(tool.get("name") or tool.get("tool") or tool.get("insert"))
                speed = _safe(tool.get("speed") or tool.get("rpm") or tool.get("vc"))
                feed = _safe(tool.get("feed"))
                ap = _safe(tool.get("ap") or tool.get("depth"))
            else:
                tool_name = speed = feed = ap = "—"
            story.append(
                KeepTogether(
                    [
                        _p(f"Операция {idx}: {_safe(operation)}", styles["h2"]),
                        _table(
                            [
                                ["Экран / цикл", "Выбрать подходящую операцию ShopTurn по названию и типу обработки"],
                                ["Инструмент", tool_name],
                                ["Режимы", f"Скорость/обороты: {speed}; подача: {feed}; ap: {ap}"],
                                ["Геометрия", "Внести значения из подтверждённого X/Z или AF-контура"],
                                ["После ввода", "Проверить графику, направление движения и безопасные отводы"],
                            ],
                            widths=[40 * mm, 130 * mm],
                        ),
                        Spacer(1, 2 * mm),
                    ]
                )
            )
    else:
        story.append(_p("Маршрут операций не зафиксирован.", styles["warning"]))

    story += [
        _p("7. Stock Removal и симуляция", styles["h1"]),
        _table(
            [
                ["Проверка", "Статус"],
                ["Заготовка покрывает готовую геометрию", "Проверить по карте съёма"],
                ["Все операции включены в маршрут", f"{len(route)} операций"],
                ["Симуляция просмотрена", "Да" if snapshot.get("simulationReviewed") else "Нет"],
                ["Зависимые этапы завершены", f"{sum(bool(x) for x in done[:9])}/9" if done else "—"],
            ],
            widths=[100 * mm, 70 * mm],
            header=True,
        ),
        _p("8. Предупреждения и допущения", styles["h1"]),
    ]
    if warnings:
        for warning in warnings:
            story.append(_p(f"• {warning}", styles["warning"]))
    else:
        story.append(_p("В структурированном результате AI нет дополнительных предупреждений. Это не отменяет контроль оператором.", styles["body"]))
    story += [
        _p("9. Финальный чек-лист перед пуском", styles["h1"]),
        _table(
            [
                ["□", "Сверить материал и фактический размер заготовки"],
                ["□", "Проверить зажим, вылет и возможность столкновения"],
                ["□", "Проверить T/D и геометрические коррекции инструментов"],
                ["□", "Проверить X0/Z0 и активную рабочую систему координат"],
                ["□", "Запустить графическую симуляцию на стойке"],
                ["□", "Выполнить Dry Run / Single Block с уменьшенной подачей"],
                ["□", "Измерить первую деталь и скорректировать режимы/размеры"],
            ],
            widths=[12 * mm, 158 * mm],
        ),
        Spacer(1, 5 * mm),
        _p("Подпись оператора: _________________________    Дата: __________________", styles["body"]),
    ]

    doc.build(story)
    return buffer.getvalue()
