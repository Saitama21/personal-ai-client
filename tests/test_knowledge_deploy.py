from pathlib import Path


def test_dockerfile_copies_knowledge_base():
    root = Path(__file__).resolve().parents[1]
    dockerfile = (root / "Dockerfile").read_text(encoding="utf-8")
    assert "COPY data/knowledge_base ./data/knowledge_base" in dockerfile


def test_knowledge_base_files_present():
    root = Path(__file__).resolve().parents[1]
    kb = root / "data" / "knowledge_base"
    for name in ("machine_profile.json", "documents.json", "entries.json", "g_codes.json", "m_codes.json"):
        assert (kb / name).is_file(), name
