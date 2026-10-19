# -*- coding: utf-8 -*-
"""
plugin.py (FR5Survey_Setup)
QGISメニュー「FR5調査報告書」およびツールバーに5つの段階実行ボタンを追加するプラグイン本体:
  ① 最新データ同期 (スプレッドシート＆ドライブから更新)
  ② 調査結果図のセットアップ (マップ＆レイアウト生成)
  ③ 調査結果図 PNG書き出し (300dpi)
  ④ 報告書Word文書の生成 (Gemini API / AMAC標準形式)
  ⑤ 成果物フォルダを開く
"""

import os
import sys
import subprocess
import importlib
from qgis.PyQt.QtWidgets import (
    QAction,
    QLabel,
    QMessageBox,
    QProgressDialog,
    QInputDialog,
    QLineEdit,
    QApplication
)
from qgis.PyQt.QtGui import QIcon
from qgis.PyQt.QtCore import Qt


class FR5SurveyReportPlugin:
    def __init__(self, iface):
        self.iface = iface
        self.actions = []
        self.menu_name = "FR5調査 (&F)"
        self.toolbar = None

        # 実体データ・スクリプト群は project_FR5/report_fr5_pipeline を参照
        default_pipeline = r"c:\Users\asada\project_FR5\report_fr5_pipeline"
        if os.path.exists(default_pipeline):
            self.pipeline_dir = default_pipeline
        else:
            self.pipeline_dir = os.path.dirname(os.path.abspath(__file__))

    def _add_button(self, text, callback, status_tip=""):
        action = QAction(text, self.iface.mainWindow())
        if status_tip:
            action.setStatusTip(status_tip)
            action.setToolTip(status_tip)
        action.triggered.connect(callback)
        self.iface.addPluginToMenu(self.menu_name, action)
        if self.toolbar:
            self.toolbar.addAction(action)
        self.actions.append(action)
        return action

    def initGui(self):
        self.toolbar = self.iface.addToolBar("FR5調査ツールバー")
        self.toolbar.setObjectName("FR5SurveyReportToolbar")

        # ツールバー先頭に「FR5調査」の見出しラベルを配置（他プラグインと明確に識別）
        lbl_header = QLabel("【FR5調査】", self.iface.mainWindow())
        lbl_header.setStyleSheet(
            "font-weight: bold; color: #1A365D; background-color: #E2E8F0; "
            "padding: 3px 6px; border-radius: 3px; margin: 0 4px 0 2px;"
        )
        self.toolbar.addWidget(lbl_header)

        self._add_button(
            "① 最新データ同期",
            self.run_step1_sync_data,
            "スプレッドシート・Googleドライブ(写真/トラック)・chiba_agri集落境界から最新データを同期し、別添表と写真集を作成します"
        )
        self._add_button(
            "② 調査結果図セットアップ",
            self.run_step2_setup_map,
            "QGIS上に標準地図・農業集落境界・トラック・調査地点を配置し、A4印刷レイアウトを自動生成します"
        )
        self._add_button(
            "③ 調査結果図 PNG出力",
            self.run_step3_export_png,
            "印刷レイアウトを300dpiのPNG画像としてoutputフォルダへ書き出します"
        )
        self._add_button(
            "④ Gemini報告書(Word)作成",
            self.run_step4_generate_docx,
            "Googleドキュメントのプロンプト資料とGemini APIを用いてAMAC形式の現地調査報告書(.docx)を生成します"
        )
        self._add_button(
            "⑤ 成果物フォルダを開く",
            self.run_step5_open_output,
            "生成された報告書・図・別添表・写真集が保存されたoutputフォルダを開きます"
        )

    def unload(self):
        for action in self.actions:
            self.iface.removePluginMenu(self.menu_name, action)
            if self.toolbar:
                self.toolbar.removeAction(action)
        if self.toolbar:
            del self.toolbar
            self.toolbar = None
        self.actions = []

    def _ensure_sys_path(self):
        if self.pipeline_dir not in sys.path:
            sys.path.insert(0, self.pipeline_dir)

    def _create_progress(self, title, label):
        dlg = QProgressDialog(label, None, 0, 0, self.iface.mainWindow())
        dlg.setWindowTitle(title)
        dlg.setWindowModality(Qt.WindowModal)
        dlg.setCancelButton(None)
        dlg.setMinimumDuration(0)
        dlg.show()
        QApplication.processEvents()
        return dlg

    # ------------------------------------------
    # ① 最新データ同期
    # ------------------------------------------
    def run_step1_sync_data(self):
        dlg = self._create_progress(
            "① 最新データ同期",
            "スプレッドシート・Googleドライブ(写真/トラック)・集落境界データを同期中..."
        )
        try:
            self._ensure_sys_path()
            import step1_prepare_data
            importlib.reload(step1_prepare_data)
            res = step1_prepare_data.main()
            dlg.close()

            villages_str = "、".join(res.get("villages", [])) or "なし"
            QMessageBox.information(
                self.iface.mainWindow(),
                "① 最新データ同期 完了",
                f"最新データの同期が完了しました。\n\n"
                f"・調査地点数: {res.get('points_count', 0)} 件\n"
                f"・判定された農業集落: {villages_str}\n"
                f"・別添Excel表 / 写真集PDF を output フォルダに更新しました。\n\n"
                f"続いて「② 調査結果図セットアップ」ボタンを押してください。"
            )
        except Exception as e:
            dlg.close()
            QMessageBox.critical(
                self.iface.mainWindow(),
                "① 最新データ同期 エラー",
                f"データ同期中にエラーが発生しました:\n{e}"
            )

    # ------------------------------------------
    # ② 調査結果図のセットアップ
    # ------------------------------------------
    def run_step2_setup_map(self):
        dlg = self._create_progress(
            "② 調査結果図セットアップ",
            "QGISレイヤ（標準地図・chiba_agri集落境界・トラック・調査地点）と印刷レイアウトを構築中..."
        )
        try:
            self._ensure_sys_path()
            import step2_qgis_setup
            importlib.reload(step2_qgis_setup)
            step2_qgis_setup.setup_survey_map(open_designer=True)
            dlg.close()

            QMessageBox.information(
                self.iface.mainWindow(),
                "② 調査結果図セットアップ 完了",
                "QGISマップおよびA4印刷レイアウト「調査結果図_全体」を生成しました。\n\n"
                "レイアウト画面でラベル位置や表示範囲をご確認・微調整したのち、\n"
                "「③ 調査結果図 PNG出力」ボタンを押してください。"
            )
        except Exception as e:
            dlg.close()
            QMessageBox.critical(
                self.iface.mainWindow(),
                "② 調査結果図セットアップ エラー",
                f"マップセットアップ中にエラーが発生しました:\n{e}"
            )

    # ------------------------------------------
    # ③ 調査結果図 PNG書き出し
    # ------------------------------------------
    def run_step3_export_png(self):
        dlg = self._create_progress(
            "③ 調査結果図 PNG出力",
            "印刷レイアウトを 300dpi PNG 画像として書き出し中..."
        )
        try:
            self._ensure_sys_path()
            import step2_qgis_setup
            importlib.reload(step2_qgis_setup)
            files = step2_qgis_setup.export_layouts_to_png(dpi=300)
            dlg.close()

            joined = "\n".join(files)
            QMessageBox.information(
                self.iface.mainWindow(),
                "③ 調査結果図 PNG出力 完了",
                f"調査結果図のPNG出力が完了しました:\n{joined}\n\n"
                f"続いて「④ Gemini報告書(Word)作成」ボタンを押してください。"
            )
        except Exception as e:
            dlg.close()
            QMessageBox.critical(
                self.iface.mainWindow(),
                "③ 調査結果図 PNG出力 エラー",
                f"PNG書き出し中にエラーが発生しました:\n{e}"
            )

    # ------------------------------------------
    # ④ Gemini 報告書(Word)作成
    # ------------------------------------------
    def run_step4_generate_docx(self):
        self._ensure_sys_path()
        import step3_generate_docx_report
        importlib.reload(step3_generate_docx_report)

        api_key = step3_generate_docx_report.load_gemini_api_key()
        if not api_key:
            key_input, ok = QInputDialog.getText(
                self.iface.mainWindow(),
                "Gemini API キー入力 (任意)",
                "Gemini APIキーを入力してください（空欄のままOKを押すと標準テンプレートで生成します）:",
                QLineEdit.Password
            )
            if not ok:
                return
            if key_input.strip():
                api_key = key_input.strip()
                try:
                    with open(os.path.join(self.pipeline_dir, "api_key.txt"), "w", encoding="utf-8") as f:
                        f.write(api_key)
                except Exception:
                    pass

        dlg = self._create_progress(
            "④ Gemini報告書(Word)作成",
            "Googleドキュメントのプロンプト資料と現地調査データからAMAC標準報告書(.docx)を生成中..."
        )
        try:
            out_docx = step3_generate_docx_report.generate_word_report(override_api_key=api_key)
            dlg.close()

            QMessageBox.information(
                self.iface.mainWindow(),
                "④ Gemini報告書(Word)作成 完了",
                f"合同会社AMAC標準フォーマットの現地調査報告書を生成しました！\n\n"
                f"保存先:\n{out_docx}\n\n"
                f"「⑤ 成果物フォルダを開く」ボタンで確認できます。"
            )
        except Exception as e:
            dlg.close()
            QMessageBox.critical(
                self.iface.mainWindow(),
                "④ Gemini報告書(Word)作成 エラー",
                f"Word報告書の生成中にエラーが発生しました:\n{e}"
            )

    # ------------------------------------------
    # ⑤ 成果物フォルダを開く
    # ------------------------------------------
    def run_step5_open_output(self):
        out_dir = os.path.join(self.pipeline_dir, "output")
        os.makedirs(out_dir, exist_ok=True)
        if os.name == "nt":
            os.startfile(out_dir)
        else:
            subprocess.Popen(["xdg-open", out_dir])
