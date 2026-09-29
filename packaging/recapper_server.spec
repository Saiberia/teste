# -*- mode: python ; coding: utf-8 -*-
# PyInstaller spec for the Recapper backend sidecar (one-folder build).
#
#   python packaging/build_server.py          (recommended wrapper)
#   python -m PyInstaller --noconfirm --distpath dist --workpath build/pyinstaller packaging/recapper_server.spec
#
# Output: dist/recapper-server/recapper-server[.exe] + _internal/
# The desktop app ships this folder as <resources>/backend (electron-builder extraResources).
import importlib.util
import sys
from pathlib import Path

from PyInstaller.utils.hooks import collect_all, collect_data_files, collect_submodules, copy_metadata

ROOT = Path(SPECPATH).resolve().parent  # noqa: F821  (SPECPATH is injected by PyInstaller)
STATIC = ROOT / "recapper" / "web" / "static"


def have(module: str) -> bool:
    try:
        return importlib.util.find_spec(module) is not None
    except (ImportError, ValueError):
        return False


datas = [(str(STATIC), "recapper/web/static")]
binaries = []
hiddenimports = [
    "recapper.__main__",
    *collect_submodules("recapper", filter=lambda name: not name.startswith("recapper.bot")),
    # uvicorn picks its loop/protocol implementations by string at runtime
    *collect_submodules("uvicorn"),
    "multipart",
    "python_multipart",
]

# python-docx ships .docx templates as package data
if have("docx"):
    datas += collect_data_files("docx")

# Optional local speech recognition. collect_all pulls native libraries
# (ctranslate2, onnxruntime), data files (Silero VAD model in faster_whisper/assets,
# tokenizers) and hidden imports so ASR works inside the packaged app.
ASR_PACKAGES = ["faster_whisper", "ctranslate2", "tokenizers", "onnxruntime", "av", "huggingface_hub"]
bundled_asr = []
for pkg in ASR_PACKAGES:
    if have(pkg):
        d, b, h = collect_all(pkg)
        datas += d
        binaries += b
        hiddenimports += h
        bundled_asr.append(pkg)
if not have("faster_whisper"):
    print("WARNING: faster-whisper is not installed; the build will have no local ASR "
          "(pip install -e .[asr]).", file=sys.stderr)
print(f"recapper-server: bundling ASR packages: {bundled_asr or 'none'}", file=sys.stderr)

# Packages that read their own version via importlib.metadata at runtime.
for dist in ["anthropic", "fastapi", "starlette", "uvicorn", "pydantic", "pydantic_core", "httpx",
             "python-multipart", "python-docx", "faster-whisper", "ctranslate2", "tokenizers",
             "onnxruntime", "huggingface_hub", "tqdm", "numpy", "av"]:
    try:
        datas += copy_metadata(dist)
    except Exception:  # not installed
        pass

excludes = [
    "tkinter", "_tkinter", "matplotlib", "IPython", "jupyter", "notebook", "pytest", "PyQt5", "PyQt6",
    "PySide2", "PySide6", "torch", "tensorflow", "telegram", "recapper.bot", "PIL",
]

a = Analysis(  # noqa: F821
    [str(ROOT / "packaging" / "recapper_server_entry.py")],
    pathex=[str(ROOT)],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=excludes,
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)  # noqa: F821

exe = EXE(  # noqa: F821
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="recapper-server",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,  # UPX breaks native ASR libraries and trips antivirus heuristics
    # Console binary: stdout carries the RECAPPER_READY line. Electron starts it
    # with windowsHide, so no console window appears on Windows.
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,  # native arch of the build machine (arm64 / x86_64)
    codesign_identity=None,  # electron-builder signs the whole app bundle
    entitlements_file=None,
)

coll = COLLECT(  # noqa: F821
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name="recapper-server",
)
