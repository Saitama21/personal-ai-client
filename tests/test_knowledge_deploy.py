from pathlib import Path


def test_dockerfile_bundles_immutable_resources_inside_app():
    root = Path(__file__).resolve().parents[1]
    dockerfile = (root / "Dockerfile").read_text(encoding="utf-8")
    assert "COPY app ./app" in dockerfile
    assert (root / "app" / "resources" / "knowledge_base").is_dir()
    assert (root / "app" / "resources" / "digital_twin" / "manual_index.sqlite3").is_file()


def test_knowledge_base_files_present():
    root = Path(__file__).resolve().parents[1]
    kb = root / "app" / "resources" / "knowledge_base"
    for name in ("machine_profile.json", "documents.json", "entries.json", "g_codes.json", "m_codes.json"):
        assert (kb / name).is_file(), name
