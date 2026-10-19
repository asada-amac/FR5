# -*- coding: utf-8 -*-
"""
step2_qgis_setup.py (project_FR5)
QGIS上で以下のレイヤとA4印刷レイアウトを自動構築・PNG出力するスクリプト:
1. 地理院タイル（標準地図・グレースケール）
2. 農業集落境界 (target_villages.geojson / chiba_agri.geojson) + 集落名(AGRI_N)ラベル
3. 調査巡回トラック (survey_tracks_current.geojson)
4. 現地調査地点 (survey_points_current.geojson) + 地点分類別シンボル + 地点番号ラベル
"""

import os
from qgis.core import (
    QgsProject,
    QgsRasterLayer,
    QgsVectorLayer,
    QgsCoordinateReferenceSystem,
    QgsCoordinateTransform,
    QgsSymbol,
    QgsRendererCategory,
    QgsCategorizedSymbolRenderer,
    QgsSimpleMarkerSymbolLayer,
    QgsSimpleLineSymbolLayer,
    QgsSimpleFillSymbolLayer,
    QgsPalLayerSettings,
    QgsTextFormat,
    QgsTextBufferSettings,
    QgsVectorLayerSimpleLabeling,
    QgsPrintLayout,
    QgsLayoutItemMap,
    QgsLayoutItemLabel,
    QgsLayoutItemLegend,
    QgsLayoutItemScaleBar,
    QgsLayoutPoint,
    QgsLayoutSize,
    QgsUnitTypes,
    QgsLayoutExporter,
    QgsRectangle,
    QgsLayerTreeLayer
)
from qgis.PyQt.QtGui import QColor, QFont
from qgis.PyQt.QtCore import Qt
import qgis.utils

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(BASE_DIR)
OUTPUT_DIR = os.path.join(BASE_DIR, "output")

POINTS_GEOJSON   = os.path.join(BASE_DIR, "survey_points_current.geojson")
TRACKS_GEOJSON   = os.path.join(BASE_DIR, "survey_tracks_current.geojson")
VILLAGES_GEOJSON = os.path.join(BASE_DIR, "target_villages.geojson")
CHIBA_AGRI_FULL  = os.path.join(PROJECT_ROOT, "chiba_agri.geojson")

LAYOUT_NAME = "調査結果図_全体"

# FR5の21分類に対応するシンボル・色設定 (shape, fill_hex, outline_hex, size_mm)
CATEGORY_STYLES = {
    # 捕獲わな系 (四角・三角 / 青〜紫系)
    "囲いわな":       ("square",   "#2563eb", "#1e3a8a", 4.2),
    "箱わな":         ("square",   "#3b82f6", "#1d4ed8", 4.0),
    "くくりわな":     ("triangle", "#7c3aed", "#4c1d95", 4.2),
    "小型わな":       ("triangle", "#a855f7", "#6b21a8", 3.8),
    # 防護柵系 (ダイヤ / 緑〜ティール系)
    "電気柵":         ("diamond",  "#10b981", "#065f46", 4.4),
    "ワイヤーメッシュ": ("diamond", "#14b8a6", "#115e59", 4.2),
    "金網柵":         ("diamond",  "#059669", "#064e3b", 4.2),
    "その他柵":       ("diamond",  "#84cc16", "#3f6212", 4.0),
    # 痕跡・被害・目撃系 (円 / 赤〜オレンジ〜茶系)
    "掘り起こし":     ("circle",   "#ef4444", "#7f1d1d", 3.8),
    "足跡":           ("circle",   "#f97316", "#7c2d12", 3.6),
    "獣道":           ("circle",   "#eab308", "#713f12", 3.6),
    "食痕":           ("circle",   "#dc2626", "#7f1d1d", 3.8),
    "泥こすり":       ("circle",   "#b45309", "#451a03", 3.6),
    "ヌタ場":         ("circle",   "#92400e", "#451a03", 4.0),
    "寝屋":           ("circle",   "#78350f", "#292524", 4.0),
    "爪痕":           ("circle",   "#f59e0b", "#78350f", 3.6),
    "目撃":           ("circle",   "#ec4899", "#831843", 4.0),
    "被害":           ("circle",   "#be123c", "#4c0519", 4.2),
    # 聞き取り・カメラ・その他
    "聞き取り":       ("star",     "#06b6d4", "#164e63", 4.8),
    "カメラ":         ("pentagon", "#6366f1", "#312e81", 4.2),
    "その他":         ("circle",   "#64748b", "#1e293b", 3.5),
}


def _apply_village_boundary_style(layer):
    """chiba_agri (農業集落境界) のポリゴンスタイルと AGRI_N ラベル設定"""
    symbol = QgsSymbol.defaultSymbol(layer.geometryType())
    fill_layer = QgsSimpleFillSymbolLayer()
    fill_layer.setColor(QColor(255, 255, 255, 0))  # 塗りつぶし透明
    fill_layer.setStrokeColor(QColor("#1e3a8a"))
    fill_layer.setStrokeWidth(0.55)
    fill_layer.setStrokeStyle(Qt.DashDotLine)
    symbol.changeSymbolLayer(0, fill_layer)
    layer.renderer().setSymbol(symbol)

    # 集落名 (AGRI_N) ラベル
    pal = QgsPalLayerSettings()
    pal.fieldName = "AGRI_N"
    pal.enabled = True
    try:
        pal.placement = QgsPalLayerSettings.Horizontal
    except Exception:
        pass

    tf = QgsTextFormat()
    tf.setFont(QFont("Yu Gothic UI", 10, QFont.Bold))
    tf.setSize(10)
    tf.setColor(QColor("#1e3a8a"))

    buf = QgsTextBufferSettings()
    buf.setEnabled(True)
    buf.setSize(1.2)
    buf.setColor(QColor("#ffffff"))
    tf.setBuffer(buf)

    pal.setFormat(tf)
    layer.setLabeling(QgsVectorLayerSimpleLabeling(pal))
    layer.setLabelsEnabled(True)
    layer.triggerRepaint()


def _apply_track_style(layer):
    """調査巡回トラックの赤破線スタイル"""
    symbol = QgsSymbol.defaultSymbol(layer.geometryType())
    line_layer = QgsSimpleLineSymbolLayer()
    line_layer.setColor(QColor("#dc2626"))
    line_layer.setWidth(0.85)
    line_layer.setPenStyle(Qt.DashLine)
    symbol.changeSymbolLayer(0, line_layer)
    layer.renderer().setSymbol(symbol)
    layer.triggerRepaint()


def _shape_enum(shape_name):
    mapping = {
        "square":   QgsSimpleMarkerSymbolLayer.Square,
        "triangle": QgsSimpleMarkerSymbolLayer.Triangle,
        "diamond":  QgsSimpleMarkerSymbolLayer.Diamond,
        "star":     QgsSimpleMarkerSymbolLayer.Star,
        "pentagon": QgsSimpleMarkerSymbolLayer.Pentagon,
        "circle":   QgsSimpleMarkerSymbolLayer.Circle,
    }
    return mapping.get(shape_name, QgsSimpleMarkerSymbolLayer.Circle)


def _apply_points_style(layer):
    """調査地点の地点分類別シンボルと地点番号ラベル設定"""
    # データ内に存在する分類のみ凡例に表示するようフィルタ
    present_cats = set()
    for feat in layer.getFeatures():
        val = feat["地点分類"]
        if val:
            present_cats.add(str(val))

    categories = []
    for cat_name, (shape_str, fill_hex, stroke_hex, size_mm) in CATEGORY_STYLES.items():
        if present_cats and cat_name not in present_cats:
            continue
        sym = QgsSymbol.defaultSymbol(layer.geometryType())
        marker = QgsSimpleMarkerSymbolLayer()
        marker.setShape(_shape_enum(shape_str))
        marker.setColor(QColor(fill_hex))
        marker.setStrokeColor(QColor(stroke_hex))
        marker.setStrokeWidth(0.45)
        marker.setSize(size_mm)
        sym.changeSymbolLayer(0, marker)
        categories.append(QgsRendererCategory(cat_name, sym, cat_name))

    # 未定義の分類がある場合のフォールバック
    for extra_cat in sorted(present_cats - set(CATEGORY_STYLES.keys())):
        sym = QgsSymbol.defaultSymbol(layer.geometryType())
        marker = QgsSimpleMarkerSymbolLayer()
        marker.setShape(QgsSimpleMarkerSymbolLayer.Circle)
        marker.setColor(QColor("#64748b"))
        marker.setStrokeColor(QColor("#0f172a"))
        marker.setStrokeWidth(0.45)
        marker.setSize(3.6)
        sym.changeSymbolLayer(0, marker)
        categories.append(QgsRendererCategory(extra_cat, sym, extra_cat))

    renderer = QgsCategorizedSymbolRenderer("地点分類", categories)
    layer.setRenderer(renderer)

    # 地点番号ラベル
    pal = QgsPalLayerSettings()
    pal.fieldName = "地点番号"
    pal.enabled = True
    try:
        pal.dist = 1.6
    except Exception:
        pass

    tf = QgsTextFormat()
    tf.setFont(QFont("Arial", 10, QFont.Bold))
    tf.setSize(10)
    tf.setColor(QColor("#111827"))

    buf = QgsTextBufferSettings()
    buf.setEnabled(True)
    buf.setSize(1.3)
    buf.setColor(QColor("#ffffff"))
    tf.setBuffer(buf)

    pal.setFormat(tf)
    layer.setLabeling(QgsVectorLayerSimpleLabeling(pal))
    layer.setLabelsEnabled(True)
    layer.triggerRepaint()


def _compute_combined_extent(project, layers):
    """指定レイヤ群の結合範囲 (プロジェクトCRS) を計算し、余白を持たせた矩形を返す"""
    combined = None
    dest_crs = project.crs()
    for lyr in layers:
        if not lyr or not lyr.isValid() or lyr.featureCount() == 0:
            continue
        ext = lyr.extent()
        if ext.isEmpty():
            continue
        if lyr.crs() != dest_crs:
            tr = QgsCoordinateTransform(lyr.crs(), dest_crs, project)
            ext = tr.transformBoundingBox(ext)
        if combined is None:
            combined = QgsRectangle(ext)
        else:
            combined.combineExtentWith(ext)

    if combined is None or combined.isEmpty():
        return None

    # 範囲が1点のみ等で幅0の場合は約600m四方を確保
    if combined.width() < 50 or combined.height() < 50:
        cx = combined.center().x()
        cy = combined.center().y()
        half = 400.0 if not dest_crs.isGeographic() else 0.004
        combined = QgsRectangle(cx - half, cy - half, cx + half, cy + half)
    else:
        combined.scale(1.28)
    return combined


def _create_or_update_print_layout(project, pts_layer, trk_layer, vil_layer, map_extent):
    """A4縦の印刷レイアウト「調査結果図_全体」を自動生成"""
    manager = project.layoutManager()
    existing = manager.layoutByName(LAYOUT_NAME)
    if existing:
        manager.removeLayout(existing)

    layout = QgsPrintLayout(project)
    layout.initializeDefaults()
    layout.setName(LAYOUT_NAME)

    # A4 縦 (210mm x 297mm)
    pc = layout.pageCollection()
    page = pc.page(0)
    page.setPageSize("A4", QgsLayoutItemPage.Portrait if hasattr(page, "Portrait") else 0)

    # 1. タイトルラベル
    title_item = QgsLayoutItemLabel(layout)
    title_item.setText("現地調査結果図")
    title_tf = QgsTextFormat()
    title_tf.setFont(QFont("MS Mincho", 15, QFont.Bold))
    title_tf.setSize(15)
    title_item.setTextFormat(title_tf)
    title_item.setHAlign(Qt.AlignHCenter)
    title_item.setVAlign(Qt.AlignVCenter)
    title_item.attemptMove(QgsLayoutPoint(10, 6, QgsUnitTypes.LayoutMillimeters))
    title_item.attemptResize(QgsLayoutSize(190, 10, QgsUnitTypes.LayoutMillimeters))
    layout.addLayoutItem(title_item)

    # 2. 地図フレーム (190mm x 268mm)
    map_item = QgsLayoutItemMap(layout)
    map_item.attemptMove(QgsLayoutPoint(10, 18, QgsUnitTypes.LayoutMillimeters))
    map_item.attemptResize(QgsLayoutSize(190, 268, QgsUnitTypes.LayoutMillimeters))
    map_item.setFrameEnabled(True)

    if map_extent:
        # 地図フレームの縦横比 (190:268) に合わせてExtentを調整
        target_ratio = 190.0 / 268.0
        ext_w = map_extent.width()
        ext_h = map_extent.height()
        cx = map_extent.center().x()
        cy = map_extent.center().y()
        if ext_w / ext_h > target_ratio:
            new_w = ext_w
            new_h = ext_w / target_ratio
        else:
            new_h = ext_h
            new_w = ext_h * target_ratio
        adj_ext = QgsRectangle(cx - new_w / 2, cy - new_h / 2, cx + new_w / 2, cy + new_h / 2)
        map_item.setExtent(adj_ext)

    layout.addLayoutItem(map_item)

    # 3. 凡例 (右下または左上)
    legend = QgsLayoutItemLegend(layout)
    legend.setTitle("凡例")
    legend.setLinkedMap(map_item)
    legend.setAutoUpdateModel(False)
    root = legend.model().rootGroup()
    for child in list(root.children()):
        if isinstance(child, QgsLayerTreeLayer):
            if child.layer() not in (pts_layer, trk_layer, vil_layer):
                root.removeChildNode(child)
    legend.setBackgroundEnabled(True)
    legend.setBackgroundColor(QColor(255, 255, 255, 230))
    legend.setFrameEnabled(True)
    legend.attemptMove(QgsLayoutPoint(14, 22, QgsUnitTypes.LayoutMillimeters))
    layout.addLayoutItem(legend)

    # 4. 縮尺バー (左下)
    scalebar = QgsLayoutItemScaleBar(layout)
    scalebar.setStyle("Single Box")
    scalebar.setLinkedMap(map_item)
    scalebar.applyDefaultSize()
    scalebar.setBackgroundEnabled(True)
    scalebar.setBackgroundColor(QColor(255, 255, 255, 210))
    scalebar.attemptMove(QgsLayoutPoint(14, 270, QgsUnitTypes.LayoutMillimeters))
    layout.addLayoutItem(scalebar)

    manager.addLayout(layout)
    return layout


def setup_survey_map(open_designer=True):
    """QGISプロジェクトに標準地図・集落境界・トラック・調査地点を読み込み、印刷レイアウトを生成"""
    project = QgsProject.instance()
    project.setCrs(QgsCoordinateReferenceSystem("EPSG:3857"))

    # 既存の同名管理レイヤをクリア
    managed_names = {"地理院タイル（標準地図）", "農業集落境界 (chiba_agri)", "調査巡回トラック", "現地調査地点"}
    for lyr_id, lyr in list(project.mapLayers().items()):
        if lyr.name() in managed_names:
            project.removeMapLayer(lyr_id)

    # 1. 国土地理院 標準地図 (グレースケール)
    gsi_uri = "type=xyz&url=https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png&zmax=18&zmin=2"
    gsi_layer = QgsRasterLayer(gsi_uri, "地理院タイル（標準地図）", "wms")
    if gsi_layer.isValid():
        if gsi_layer.hueSaturationFilter():
            gsi_layer.hueSaturationFilter().setSaturation(-80)
        if gsi_layer.brightnessFilter():
            gsi_layer.brightnessFilter().setContrast(10)
            gsi_layer.brightnessFilter().setBrightness(10)
        project.addMapLayer(gsi_layer)

    # 2. 農業集落境界 (target_villages.geojson 優先、なければ chiba_agri.geojson)
    vil_path = VILLAGES_GEOJSON if os.path.exists(VILLAGES_GEOJSON) else CHIBA_AGRI_FULL
    vil_layer = None
    if os.path.exists(vil_path):
        vil_layer = QgsVectorLayer(vil_path, "農業集落境界 (chiba_agri)", "ogr")
        if vil_layer.isValid():
            project.addMapLayer(vil_layer)
            _apply_village_boundary_style(vil_layer)

    # 3. 調査巡回トラック
    trk_layer = None
    if os.path.exists(TRACKS_GEOJSON):
        trk_layer = QgsVectorLayer(TRACKS_GEOJSON, "調査巡回トラック", "ogr")
        if trk_layer.isValid() and trk_layer.featureCount() > 0:
            project.addMapLayer(trk_layer)
            _apply_track_style(trk_layer)

    # 4. 現地調査地点
    pts_layer = None
    if os.path.exists(POINTS_GEOJSON):
        pts_layer = QgsVectorLayer(POINTS_GEOJSON, "現地調査地点", "ogr")
        if pts_layer.isValid():
            project.addMapLayer(pts_layer)
            _apply_points_style(pts_layer)

    # キャンバス範囲を調査地点＋トラックにズーム
    target_extent = _compute_combined_extent(project, [pts_layer, trk_layer])
    if not target_extent and vil_layer:
        target_extent = _compute_combined_extent(project, [vil_layer])

    if target_extent and qgis.utils.iface:
        canvas = qgis.utils.iface.mapCanvas()
        canvas.setExtent(target_extent)
        canvas.refresh()

    # 印刷レイアウト生成
    layout = _create_or_update_print_layout(project, pts_layer, trk_layer, vil_layer, target_extent)
    if open_designer and qgis.utils.iface and layout:
        qgis.utils.iface.openLayoutDesigner(layout)

    return layout


def export_layouts_to_png(dpi=300):
    """印刷レイアウト「調査結果図_全体」を300dpi PNGとして output/ に書き出す"""
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    project = QgsProject.instance()
    manager = project.layoutManager()
    layout = manager.layoutByName(LAYOUT_NAME)
    if not layout:
        layout = setup_survey_map(open_designer=False)

    out_png = os.path.join(OUTPUT_DIR, f"{LAYOUT_NAME}.png")
    exporter = QgsLayoutExporter(layout)
    settings = QgsLayoutExporter.ImageExportSettings()
    settings.dpi = dpi
    result = exporter.exportToImage(out_png, settings)
    if result == QgsLayoutExporter.Success:
        print(f"調査結果図PNGを出力しました: {out_png}")
        return [out_png]
    else:
        raise RuntimeError(f"PNG書き出しに失敗しました (エラーコード: {result})")
