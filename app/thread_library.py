from __future__ import annotations

from typing import Any, Iterable


THREAD_FAMILIES: list[dict[str, str]] = [
    {"id": "metric_iso", "label": "Метрическая ISO (M)", "short": "ISO M"},
    {"id": "metric_fine", "label": "Метрическая мелкая", "short": "M fine"},
    {"id": "bspp", "label": "Трубная цилиндрическая G (BSPP)", "short": "G / BSPP"},
    {"id": "bspt", "label": "Трубная коническая R / Rc / Rp (BSPT)", "short": "R / BSPT"},
    {"id": "npt", "label": "NPT / NPTF", "short": "NPT"},
    {"id": "unified", "label": "UN / UNC / UNF / UNEF / UNS", "short": "UN"},
    {"id": "trapezoidal", "label": "Трапецеидальная Tr", "short": "Tr"},
    {"id": "buttress", "label": "Упорная S", "short": "S"},
    {"id": "round", "label": "Круглая Rd", "short": "Rd"},
    {"id": "rectangular", "label": "Прямоугольная", "short": "Sq"},
    {"id": "modular", "label": "Модульная", "short": "Module"},
    {"id": "pg", "label": "PG", "short": "PG"},
    {"id": "edison", "label": "Edison / E", "short": "E"},
    {"id": "api_special", "label": "API / специальные", "short": "API"},
]


def _as_float(value: float | int | str | None) -> float | None:
    if value is None or value == "":
        return None
    return float(value)


def _profile(
    *,
    family: str,
    designation: str,
    standard: str,
    pitch_mm: float | None = None,
    tpi: float | None = None,
    diameter_mm: float | None = None,
    angle: str = "",
    note: str = "",
    standard_profile: bool = True,
    default_tolerance_external: str = "",
    default_tolerance_internal: str = "",
    taper: str = "",
    aliases: Iterable[str] = (),
) -> dict[str, Any]:
    pitch = _as_float(pitch_mm)
    tpi_value = _as_float(tpi)
    if pitch is None and tpi_value:
        pitch = 25.4 / tpi_value
    return {
        "id": f"{family}:{designation}".lower().replace(" ", "_").replace("/", "-").replace("×", "x"),
        "family": family,
        "designation": designation,
        "standard": standard,
        "diameter_mm": _as_float(diameter_mm),
        "pitch_mm": round(pitch, 6) if pitch is not None else None,
        "tpi": tpi_value,
        "profile_angle": angle,
        "note": note,
        "standard_profile": bool(standard_profile),
        "default_tolerance_external": default_tolerance_external,
        "default_tolerance_internal": default_tolerance_internal,
        "taper": taper,
        "aliases": list(aliases),
        "sides": ["external", "internal"],
    }


def _metric_profiles(metric_catalog: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    for designation, spec in sorted(metric_catalog.items(), key=lambda item: item[1]["diameter"]):
        coarse = float(spec["coarse"])
        pitches = sorted({float(x) for x in spec.get("pitches", [coarse])})
        for pitch in pitches:
            family = "metric_iso" if pitch == coarse else "metric_fine"
            items.append(
                _profile(
                    family=family,
                    designation=f"{designation}×{pitch:g}",
                    standard="ISO 261 / ISO 262 / ISO 965",
                    diameter_mm=float(spec["diameter"]),
                    pitch_mm=pitch,
                    angle="60°",
                    note="Крупный шаг" if pitch == coarse else "Мелкий шаг",
                    default_tolerance_external="6g",
                    default_tolerance_internal="6H",
                    aliases=(designation,),
                )
            )
    return items


BSP_TPI = [
    ("1/16", 28), ("1/8", 28), ("1/4", 19), ("3/8", 19),
    ("1/2", 14), ("5/8", 14), ("3/4", 14), ("7/8", 14),
    ("1", 11), ("1 1/8", 11), ("1 1/4", 11), ("1 1/2", 11),
    ("1 3/4", 11), ("2", 11), ("2 1/4", 11), ("2 1/2", 11),
    ("2 3/4", 11), ("3", 11), ("3 1/2", 11), ("4", 11),
    ("4 1/2", 11), ("5", 11), ("5 1/2", 11), ("6", 11),
]

NPT_TPI = [
    ("1/16", 27), ("1/8", 27), ("1/4", 18), ("3/8", 18),
    ("1/2", 14), ("3/4", 14), ("1", 11.5), ("1 1/4", 11.5),
    ("1 1/2", 11.5), ("2", 11.5), ("2 1/2", 8), ("3", 8),
    ("3 1/2", 8), ("4", 8), ("5", 8), ("6", 8),
]

UNIFIED_SERIES: dict[str, list[tuple[str, float]]] = {
    "UNC": [
        ("#0", 80), ("#1", 64), ("#2", 56), ("#3", 48), ("#4", 40), ("#5", 40),
        ("#6", 32), ("#8", 32), ("#10", 24), ("#12", 24), ("1/4", 20), ("5/16", 18),
        ("3/8", 16), ("7/16", 14), ("1/2", 13), ("9/16", 12), ("5/8", 11), ("3/4", 10),
        ("7/8", 9), ("1", 8), ("1 1/8", 7), ("1 1/4", 7), ("1 3/8", 6), ("1 1/2", 6),
        ("1 3/4", 5), ("2", 4.5), ("2 1/4", 4.5), ("2 1/2", 4), ("2 3/4", 4), ("3", 4),
    ],
    "UNF": [
        ("#0", 80), ("#1", 72), ("#2", 64), ("#3", 56), ("#4", 48), ("#5", 44),
        ("#6", 40), ("#8", 36), ("#10", 32), ("#12", 28), ("1/4", 28), ("5/16", 24),
        ("3/8", 24), ("7/16", 20), ("1/2", 20), ("9/16", 18), ("5/8", 18), ("3/4", 16),
        ("7/8", 14), ("1", 12), ("1 1/8", 12), ("1 1/4", 12), ("1 3/8", 12), ("1 1/2", 12),
    ],
    "UNEF": [
        ("#12", 32), ("1/4", 32), ("5/16", 32), ("3/8", 32), ("7/16", 28), ("1/2", 28),
        ("9/16", 24), ("5/8", 24), ("11/16", 24), ("3/4", 20), ("13/16", 20), ("7/8", 20),
        ("15/16", 20), ("1", 20), ("1 1/16", 18), ("1 1/8", 18), ("1 3/16", 18), ("1 1/4", 18),
    ],
    "UNS": [
        ("1/4", 36), ("5/16", 36), ("3/8", 40), ("7/16", 36), ("1/2", 32), ("9/16", 32),
        ("5/8", 32), ("3/4", 32), ("7/8", 28), ("1", 24), ("1 1/8", 20), ("1 1/4", 20),
        ("1 1/2", 18), ("2", 16),
    ],
}


def _inch_to_mm(label: str) -> float | None:
    text = label.strip().replace("#", "")
    number_sizes = {"0": 1.524, "1": 1.854, "2": 2.184, "3": 2.515, "4": 2.845, "5": 3.175, "6": 3.505, "8": 4.166, "10": 4.826, "12": 5.486}
    if label.startswith("#"):
        return number_sizes.get(text)
    try:
        if " " in text:
            whole, frac = text.split(" ", 1)
            num, den = frac.split("/")
            return (float(whole) + float(num) / float(den)) * 25.4
        if "/" in text:
            num, den = text.split("/")
            return float(num) / float(den) * 25.4
        return float(text) * 25.4
    except (ValueError, ZeroDivisionError):
        return None


def build_thread_library(metric_catalog: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = _metric_profiles(metric_catalog)

    for size, tpi in BSP_TPI:
        diameter = _inch_to_mm(size)
        items.append(_profile(family="bspp", designation=f"G {size}", standard="ISO 228-1", diameter_mm=diameter, tpi=tpi, angle="55°", note="Цилиндрическая трубная", aliases=(f"G{size}",)))
        for prefix, note in (("R", "Наружная коническая"), ("Rc", "Внутренняя коническая"), ("Rp", "Внутренняя цилиндрическая")):
            items.append(_profile(family="bspt", designation=f"{prefix} {size}", standard="ISO 7-1", diameter_mm=diameter, tpi=tpi, angle="55°", note=note, taper="1:16", aliases=(f"{prefix}{size}",)))

    for size, tpi in NPT_TPI:
        diameter = _inch_to_mm(size)
        items.append(_profile(family="npt", designation=f"{size}-{tpi:g} NPT", standard="ASME B1.20.1", diameter_mm=diameter, tpi=tpi, angle="60°", note="Коническая трубная", taper="1:16"))
        items.append(_profile(family="npt", designation=f"{size}-{tpi:g} NPTF", standard="ASME B1.20.3", diameter_mm=diameter, tpi=tpi, angle="60°", note="Dryseal, проверять класс и сборку", taper="1:16"))

    for series, rows in UNIFIED_SERIES.items():
        for size, tpi in rows:
            items.append(_profile(family="unified", designation=f"{size}-{tpi:g} {series}", standard="ASME B1.1", diameter_mm=_inch_to_mm(size), tpi=tpi, angle="60°", note=series, default_tolerance_external="2A", default_tolerance_internal="2B"))

    trapezoidal = [
        (8, 1.5), (10, 2), (12, 3), (14, 3), (16, 4), (18, 4), (20, 4), (22, 5),
        (24, 5), (26, 5), (28, 5), (30, 6), (32, 6), (36, 6), (40, 7), (44, 7),
        (48, 8), (50, 8), (52, 8), (55, 9), (60, 9), (65, 10), (70, 10), (75, 10),
        (80, 10), (85, 12), (90, 12), (95, 12), (100, 12),
    ]
    for diameter, pitch in trapezoidal:
        items.append(_profile(family="trapezoidal", designation=f"Tr{diameter}×{pitch:g}", standard="ISO 2904", diameter_mm=diameter, pitch_mm=pitch, angle="30°", note="Однозаходная трапецеидальная"))
        if diameter >= 20:
            items.append(_profile(family="trapezoidal", designation=f"Tr{diameter}×{pitch:g}(P{pitch/2:g})", standard="ISO 2904", diameter_mm=diameter, pitch_mm=pitch/2, angle="30°", note="Шаблон многозаходной; ход и число заходов проверить", standard_profile=False))

    buttress = [(10, 2), (12, 3), (16, 4), (20, 4), (24, 5), (30, 6), (36, 6), (40, 7), (50, 8), (60, 9), (70, 10), (80, 10), (90, 12), (100, 12)]
    for diameter, pitch in buttress:
        items.append(_profile(family="buttress", designation=f"S{diameter}×{pitch:g}", standard="DIN 513", diameter_mm=diameter, pitch_mm=pitch, angle="3°/30°", note="Упорная; направление нагрузки проверить"))

    round_threads = [(8, 1.25), (10, 1.5), (12, 2), (16, 2), (20, 2.5), (24, 3), (30, 3.5), (36, 4), (40, 4), (50, 5), (60, 6), (70, 6), (80, 8), (100, 10)]
    for diameter, pitch in round_threads:
        items.append(_profile(family="round", designation=f"Rd{diameter}×{pitch:g}", standard="DIN 405", diameter_mm=diameter, pitch_mm=pitch, angle="Круглый профиль", note="Для загрязнённых и ударных соединений"))

    for diameter, pitch in [(8, 2), (10, 2), (12, 3), (16, 4), (20, 4), (24, 5), (30, 6), (40, 8), (50, 10), (60, 12), (80, 16), (100, 20)]:
        items.append(_profile(family="rectangular", designation=f"Sq{diameter}×{pitch:g}", standard="Специальный профиль", diameter_mm=diameter, pitch_mm=pitch, angle="0°", note="Прямоугольный профиль; ширину впадины задаёт конструктор", standard_profile=False))

    for module in (0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10):
        pitch = 3.141592653589793 * module
        items.append(_profile(family="modular", designation=f"m{module:g} · P{pitch:.3f}", standard="Модульный профиль", pitch_mm=pitch, angle="20°", note="Шаг P = π·m; диаметр задаётся отдельно", standard_profile=False))

    for pg, pitch, diameter in [(7, 1.27, 12.5), (9, 1.41, 15.2), (11, 1.41, 18.6), (13.5, 1.41, 20.4), (16, 1.41, 22.5), (21, 1.588, 28.3), (29, 1.588, 37.0), (36, 1.588, 47.0), (42, 1.588, 54.0), (48, 1.588, 59.3)]:
        items.append(_profile(family="pg", designation=f"PG {pg:g}", standard="DIN 40430", diameter_mm=diameter, pitch_mm=pitch, angle="80°", note="Кабельный ввод"))

    for designation, diameter, pitch in [("E5", 5, 1.0), ("E10", 10, 1.81), ("E12", 12, 2.54), ("E14", 14, 2.82), ("E17", 17, 2.82), ("E26", 26, 3.629), ("E27", 27, 3.629), ("E39", 39, 6.35), ("E40", 40, 6.35)]:
        items.append(_profile(family="edison", designation=designation, standard="IEC 60061", diameter_mm=diameter, pitch_mm=pitch, angle="Круглый профиль", note="Ламповый цоколь; контроль калибром обязателен"))

    api_templates = [
        ("API 8RD · EUE/NUE", 8, "API 5B", "Круглая нефтепромысловая, размер трубы выбрать по API 5B"),
        ("API 8RD · LTC/STC", 8, "API 5B", "Муфтовая обсадная, размер трубы выбрать по API 5B"),
        ("API BTC · 5 TPI", 5, "API 5B", "Упорная обсадная; профиль и натяг проверять по калибрам"),
        ("ACME 1/2-10", 10, "ASME B1.5", "Трапецеидальная дюймовая 29°"),
        ("ACME 3/4-6", 6, "ASME B1.5", "Трапецеидальная дюймовая 29°"),
        ("ACME 1-5", 5, "ASME B1.5", "Трапецеидальная дюймовая 29°"),
        ("Stub ACME 1-8", 8, "ASME B1.8", "Укороченный профиль ACME"),
    ]
    for designation, tpi, standard, note in api_templates:
        items.append(_profile(family="api_special", designation=designation, standard=standard, tpi=tpi, angle="29°" if "ACME" in designation else "По стандарту", note=note, standard_profile=False))

    # Stable ordering: family order first, then nominal diameter and designation.
    family_order = {item["id"]: index for index, item in enumerate(THREAD_FAMILIES)}
    items.sort(key=lambda x: (family_order.get(x["family"], 999), x["diameter_mm"] if x["diameter_mm"] is not None else 10**9, x["designation"]))
    return items
