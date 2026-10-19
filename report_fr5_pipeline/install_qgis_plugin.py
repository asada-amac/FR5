# -*- coding: utf-8 -*-
"""
install_qgis_plugin.py
QGISの標準プラグインフォルダ (%APPDATA%\\QGIS\\QGIS3\\profiles\\default\\python\\plugins\\FR5Survey_Setup)
に FR5 現地調査報告書プラグインをインストール・更新するスクリプト
"""

import os
import shutil

SRC_DIR = os.path.dirname(os.path.abspath(__file__))
APPDATA = os.environ.get("APPDATA", os.path.expanduser("~\\AppData\\Roaming"))
PLUGIN_DEST = os.path.join(
    APPDATA, "QGIS", "QGIS3", "profiles", "default", "python", "plugins", "FR5Survey_Setup"
)

FILES_TO_COPY = [
    "__init__.py",
    "metadata.txt",
    "plugin.py",
    "step1_prepare_data.py",
    "step2_qgis_setup.py",
    "step3_generate_docx_report.py",
    "doc1_prompt.txt",
    "doc2_guideline.txt",
]


def install():
    os.makedirs(PLUGIN_DEST, exist_ok=True)
    for fname in FILES_TO_COPY:
        src = os.path.join(SRC_DIR, fname)
        dst = os.path.join(PLUGIN_DEST, fname)
        if os.path.exists(src):
            shutil.copy2(src, dst)
    print(f"QGISプラグインを {PLUGIN_DEST} にインストールしました。")


if __name__ == "__main__":
    install()
