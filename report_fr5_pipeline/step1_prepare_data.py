# -*- coding: utf-8 -*-
"""
step1_prepare_data.py (project_FR5)
1. スプレッドシート (1kSUf7P5D97oQ4JOhAHTyCPAsDE3gcKLRfnKfxsho8OI / GID:1613389351) から現地調査結果CSVを取得
2. chiba_agri.geojson (千葉県農業集落境界) と空間結合し、各地点の「集落名 (AGRI_N)」を自動判定
   および調査範囲周辺の集落境界ポリゴン (target_villages.geojson) を抽出
3. Googleドライブの写真フォルダ (1vuPqSRlshqLwVQqhoTVT44jm6DA0TvrJ) と
   トラックフォルダ (1H-3icPudMe_X_yFo8FuccXsjzcXjch6R) からデータを同期
4. QGIS描画用 GeoJSON (survey_points_current.geojson, survey_tracks_current.geojson) を出力
5. 報告書添付用の Excel一覧表 (output/別添表_現地調査結果一覧.xlsx) と 写真集PDF (output/別添_現地調査写真集.pdf) を生成
"""

import os
import re
import csv
import io
import json
import urllib.request
import urllib.parse
from datetime import datetime

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(BASE_DIR)
OUTPUT_DIR = os.path.join(BASE_DIR, "output")
PHOTOS_DIR = os.path.join(BASE_DIR, "photos")
TRACKS_DIR = os.path.join(BASE_DIR, "tracks")
CHIBA_AGRI_PATH = os.path.join(PROJECT_ROOT, "chiba_agri.geojson")

# Google Drive / Spreadsheet / GAS 定数
PARENT_FOLDER_ID = "17hKxRiGZIzaOgmOYybt5xJxuHJVYY3H_"
SPREADSHEET_ID   = "1kSUf7P5D97oQ4JOhAHTyCPAsDE3gcKLRfnKfxsho8OI"
SURVEY_GID       = "1613389351"
PHOTO_FOLDER_ID  = "1vuPqSRlshqLwVQqhoTVT44jm6DA0TvrJ"
TRACK_FOLDER_ID  = "1H-3icPudMe_X_yFo8FuccXsjzcXjch6R"
BACKUP_FOLDER_ID = "1I1bn_UtMfHlUkMIqdXaR98MnWuupTWzv"

GAS_URL = "https://script.google.com/macros/s/AKfycbx2f3c13xT7x1v2L0K_T8xX1g4Q2E5F8hJ9kL0M1N2P3Q4R5S6T/exec"


def _load_gas_url_from_config():
    """FR5Android/config.js または app.js から最新の GAS_URL を読み取る"""
    config_path = os.path.join(PROJECT_ROOT, "FR5Android", "config.js")
    if os.path.exists(config_path):
        try:
            with open(config_path, "r", encoding="utf-8") as f:
                text = f.read()
            m = re.search(r'GAS_URL\s*=\s*["\'](https://script\.google\.com/[^"\']+)["\']', text)
            if m:
                return m.group(1)
        except Exception:
            pass
    return GAS_URL


# ==========================================
# 純Pythonによる高速 Point-in-Polygon (chiba_agri.geojson 用)
# ==========================================
def _point_in_ring(lon, lat, ring):
    inside = False
    n = len(ring)
    if n < 3:
        return False
    p1x, p1y = ring[0][0], ring[0][1]
    for i in range(1, n + 1):
        p2x, p2y = ring[i % n][0], ring[i % n][1]
        if lat > min(p1y, p2y):
            if lat <= max(p1y, p2y):
                if lon <= max(p1x, p2x):
                    if p1y != p2y:
                        xinters = (lat - p1y) * (p2x - p1x) / (p2y - p1y) + p1x
                    if p1x == p2x or lon <= xinters:
                        inside = not inside
        p1x, p1y = p2x, p2y
    return inside


def _point_in_polygon_coords(lon, lat, poly_coords):
    if not poly_coords:
        return False
    if not _point_in_ring(lon, lat, poly_coords[0]):
        return False
    for hole in poly_coords[1:]:
        if _point_in_ring(lon, lat, hole):
            return False
    return True


def _compute_geom_bbox(geom):
    gtype = geom.get("type", "")
    coords = geom.get("coordinates", [])
    lons, lats = [], []
    if gtype == "Polygon":
        for ring in coords:
            for pt in ring:
                lons.append(pt[0])
                lats.append(pt[1])
    elif gtype == "MultiPolygon":
        for poly in coords:
            for ring in poly:
                for pt in ring:
                    lons.append(pt[0])
                    lats.append(pt[1])
    if not lons:
        return (0, 0, 0, 0)
    return (min(lons), min(lats), max(lons), max(lats))


def load_chiba_agri_index():
    """chiba_agri.geojson を読み込み、バウンディングボックス付きインデックスを返す"""
    if not os.path.exists(CHIBA_AGRI_PATH):
        print(f"警告: {CHIBA_AGRI_PATH} が見つかりません。")
        return []
    try:
        with open(CHIBA_AGRI_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
        indexed = []
        for feat in data.get("features", []):
            geom = feat.get("geometry") or {}
            bbox = _compute_geom_bbox(geom)
            name = (feat.get("properties") or {}).get("AGRI_N", "")
            indexed.append({
                "bbox": bbox,
                "name": str(name).strip(),
                "feature": feat
            })
        return indexed
    except Exception as e:
        print(f"chiba_agri.geojson 読み込みエラー: {e}")
        return []


def find_village_name(lon, lat, agri_index):
    """緯度経度から農業集落名 (AGRI_N) を判定"""
    for item in agri_index:
        minx, miny, maxx, maxy = item["bbox"]
        if lon < minx or lon > maxx or lat < miny or lat > maxy:
            continue
        geom = item["feature"].get("geometry") or {}
        gtype = geom.get("type", "")
        coords = geom.get("coordinates", [])
        if gtype == "Polygon":
            if _point_in_polygon_coords(lon, lat, coords):
                return item["name"]
        elif gtype == "MultiPolygon":
            for poly in coords:
                if _point_in_polygon_coords(lon, lat, poly):
                    return item["name"]
    return "対象地区外"


def save_target_villages_geojson(points_lonlat, tracks_lonlat, agri_index):
    """調査地点・トラック周辺の集落境界ポリゴンを抽出し target_villages.geojson に保存"""
    # トラック点数が非常に多い場合は間引いて近傍判定を高速化
    sampled_tracks = tracks_lonlat[::max(1, len(tracks_lonlat) // 200)] if tracks_lonlat else []
    target_coords = list(points_lonlat) + sampled_tracks

    out_path = os.path.join(BASE_DIR, "target_villages.geojson")
    if not target_coords or not agri_index:
        with open(out_path, "w", encoding="utf-8") as f:
            json.dump({"type": "FeatureCollection", "features": []}, f, ensure_ascii=False)
        return out_path

    # 調査地点（優先）またはトラックの周囲 約1.5km (0.015度) 以内に重なる集落ポリゴンのみを抽出
    base_coords = list(points_lonlat) if points_lonlat else sampled_tracks
    margin = 0.015

    selected_features = []
    for item in agri_index:
        minx, miny, maxx, maxy = item["bbox"]
        for (lon, lat) in base_coords:
            if (maxx >= lon - margin and minx <= lon + margin and
                maxy >= lat - margin and miny <= lat + margin):
                selected_features.append(item["feature"])
                break

    with open(out_path, "w", encoding="utf-8") as f:
        json.dump({
            "type": "FeatureCollection",
            "name": "target_villages",
            "features": selected_features
        }, f, ensure_ascii=False, indent=2)
    print(f"周辺集落ポリゴン {len(selected_features)} 件を {out_path} に抽出しました。")
    return out_path


# ==========================================
# Google Drive ファイルダウンロード補助
# ==========================================
def extract_drive_file_id(url_or_text):
    if not url_or_text:
        return None
    m = re.search(r'/d/([a-zA-Z0-9_-]{15,})', str(url_or_text))
    if m:
        return m.group(1)
    m2 = re.search(r'[?&]id=([a-zA-Z0-9_-]{15,})', str(url_or_text))
    if m2:
        return m2.group(1)
    return None


def download_drive_file(file_id, dest_path):
    if not file_id:
        return False
    if os.path.exists(dest_path) and os.path.getsize(dest_path) > 100:
        return True
    url = f"https://drive.google.com/uc?export=download&id={file_id}"
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=20) as resp:
            data = resp.read()
            if data and len(data) > 100 and not data[:20].startswith(b"<!DOCTYPE html"):
                with open(dest_path, "wb") as out:
                    out.write(data)
                return True
    except Exception as e:
        print(f"Driveファイル取得スキップ ({file_id}): {e}")
    return False


def fetch_gas_resource(action):
    gas_url = _load_gas_url_from_config()
    if not gas_url or "YOUR_GAS" in gas_url:
        return None
    sep = "&" if "?" in gas_url else "?"
    url = f"{gas_url}{sep}action={action}"
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=20) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
            data = json.loads(raw)
            if data.get("status") == "success":
                return data
    except Exception as e:
        print(f"GAS ({action}) 取得情報: {e}")
    return None


def scrape_public_drive_folder_files(folder_id):
    """公開共有されているGoogleドライブフォルダからファイル名とIDの対応表を抽出"""
    file_map = {}
    # 1. embeddedfolderview による軽量リスト解析
    embed_url = f"https://drive.google.com/embeddedfolderview?id={folder_id}#list"
    try:
        req = urllib.request.Request(embed_url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=20) as resp:
            html = resp.read().decode("utf-8", errors="ignore")
        for m in re.finditer(r'id="entry-([a-zA-Z0-9_-]{15,})".*?class="flip-entry-title">([^<]+)</div>', html, re.S):
            fid, fname = m.group(1).strip(), m.group(2).strip()
            file_map[fname] = fid
    except Exception as e:
        print(f"embeddedfolderview 解析スキップ ({folder_id}): {e}")

    if file_map:
        return file_map

    # 2. フォールバック: 通常フォルダページの解析
    url = f"https://drive.google.com/drive/folders/{folder_id}"
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=20) as resp:
            html = resp.read().decode("utf-8", errors="ignore")
        for m in re.finditer(r'\["([a-zA-Z0-9_-]{25,45})",\["[^"]+"\],"([^"]+\.(?:jpg|jpeg|png|geojson|json|zip))"', html, re.IGNORECASE):
            fid, fname = m.group(1), m.group(2)
            file_map[fname] = fid
    except Exception as e:
        print(f"公開フォルダ一覧の直接解析スキップ ({folder_id}): {e}")
    return file_map


# ==========================================
# スプレッドシート同期 & GeoJSON / Excel / PDF 作成
# ==========================================
def fetch_survey_rows_from_sheet():
    csv_url = f"https://docs.google.com/spreadsheets/d/{SPREADSHEET_ID}/export?format=csv&gid={SURVEY_GID}"
    local_csv_path = os.path.join(BASE_DIR, "raw_survey_sheet.csv")
    try:
        print(f"スプレッドシートから最新CSVを取得中... ({SPREADSHEET_ID})")
        req = urllib.request.Request(csv_url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=20) as resp:
            content = resp.read().decode("utf-8-sig")
        with open(local_csv_path, "w", encoding="utf-8-sig") as f:
            f.write(content)
    except Exception as e:
        print(f"スプレッドシート通信エラー（ローカルキャッシュを使用します）: {e}")
        if os.path.exists(local_csv_path):
            with open(local_csv_path, "r", encoding="utf-8-sig") as f:
                content = f.read()
        else:
            return []

    reader = csv.DictReader(io.StringIO(content))
    rows = []
    for r in reader:
        if not any(r.values()):
            continue
        rows.append(r)
    return rows


def sync_tracks():
    """トラックデータを取得し survey_tracks_current.geojson に統合"""
    os.makedirs(TRACKS_DIR, exist_ok=True)

    # 1. GASの ?action=tracks エンドポイントから取得を試みる
    gas_tracks = fetch_gas_resource("tracks")
    if gas_tracks and isinstance(gas_tracks.get("tracks"), list):
        for t in gas_tracks["tracks"]:
            name = t.get("name") or f"track_{t.get('id', 'unknown')}.geojson"
            gjson = t.get("geojson")
            if gjson:
                dest = os.path.join(TRACKS_DIR, name)
                with open(dest, "w", encoding="utf-8") as f:
                    json.dump(gjson, f, ensure_ascii=False, indent=2)

    # 2. 公開トラックフォルダ (1H-3icPudMe_X_yFo8FuccXsjzcXjch6R) からの直接取得も試行
    folder_files = scrape_public_drive_folder_files(TRACK_FOLDER_ID)
    for fname, fid in folder_files.items():
        if fname.lower().endswith((".geojson", ".json")):
            dest = os.path.join(TRACKS_DIR, fname)
            download_drive_file(fid, dest)

    # 3. tracks/ 内の全 GeoJSON を統合
    features = []
    tracks_lonlat = []
    if os.path.exists(TRACKS_DIR):
        for fname in sorted(os.listdir(TRACKS_DIR)):
            if not fname.lower().endswith((".geojson", ".json")):
                continue
            fpath = os.path.join(TRACKS_DIR, fname)
            try:
                with open(fpath, "r", encoding="utf-8") as f:
                    data = json.load(f)
                feats = data.get("features", []) if data.get("type") == "FeatureCollection" else [data]
                for feat in feats:
                    geom = feat.get("geometry") or {}
                    coords = geom.get("coordinates", [])
                    gtype = geom.get("type", "")
                    if gtype == "LineString" and len(coords) >= 2:
                        props = feat.get("properties") or {}
                        props["source_file"] = fname
                        feat["properties"] = props
                        features.append(feat)
                        for pt in coords:
                            tracks_lonlat.append((pt[0], pt[1]))
            except Exception as e:
                print(f"トラック読込スキップ ({fname}): {e}")

    out_tracks = os.path.join(BASE_DIR, "survey_tracks_current.geojson")
    with open(out_tracks, "w", encoding="utf-8") as f:
        json.dump({
            "type": "FeatureCollection",
            "name": "survey_tracks_current",
            "features": features
        }, f, ensure_ascii=False, indent=2)
    print(f"トラックデータ {len(features)} 本を {out_tracks} に出力しました。")
    return features, tracks_lonlat


def generate_excel_table(records, out_xlsx_path):
    """別添表（Excel）の出力（openpyxlが無い場合はCSV出力も併用）"""
    os.makedirs(os.path.dirname(out_xlsx_path), exist_ok=True)
    csv_fallback = os.path.splitext(out_xlsx_path)[0] + ".csv"
    headers = ["地点番号", "調査日", "調査時間", "調査者", "集落名", "地点分類", "種名", "情報詳細", "聞き取り対象", "写真有無", "緯度", "経度"]

    with open(csv_fallback, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.writer(f)
        w.writerow(headers)
        for r in records:
            w.writerow([
                r["point_no"], r["date"], r["time"], r["username"],
                r["village"], r["category"], r["species"], r["detail"],
                r["interview"], "あり" if r.get("local_photo") or r.get("photo_raw") else "なし",
                r["lat"], r["lng"]
            ])

    try:
        import openpyxl
        from openpyxl.styles import Font, PatternFill, Alignment, Border, Side

        wb = openpyxl.Workbook()
        ws = wb.active
        ws.title = "現地調査結果一覧"

        ws.append(headers)
        header_fill = PatternFill(start_color="1E40AF", end_color="1E40AF", fill_type="solid")
        header_font = Font(name="游ゴシック", size=10, bold=True, color="FFFFFF")
        body_font = Font(name="游ゴシック", size=10)
        thin_border = Border(
            left=Side(style="thin", color="CBD5E1"),
            right=Side(style="thin", color="CBD5E1"),
            top=Side(style="thin", color="CBD5E1"),
            bottom=Side(style="thin", color="CBD5E1")
        )

        for col_idx in range(1, len(headers) + 1):
            cell = ws.cell(row=1, column=col_idx)
            cell.fill = header_fill
            cell.font = header_font
            cell.alignment = Alignment(horizontal="center", vertical="center")

        for row_idx, r in enumerate(records, start=2):
            row_vals = [
                r["point_no"], r["date"], r["time"], r["username"],
                r["village"], r["category"], r["species"], r["detail"],
                r["interview"], "あり" if r.get("local_photo") or r.get("photo_raw") else "なし",
                r["lat"], r["lng"]
            ]
            ws.append(row_vals)
            for col_idx in range(1, len(headers) + 1):
                c = ws.cell(row=row_idx, column=col_idx)
                c.font = body_font
                c.border = thin_border
                if col_idx in (1, 2, 3, 5, 6, 7, 10):
                    c.alignment = Alignment(horizontal="center", vertical="center")
                else:
                    c.alignment = Alignment(horizontal="left", vertical="center", wrap_text=True)

        col_widths = [10, 13, 11, 14, 15, 15, 13, 38, 15, 10, 13, 13]
        for idx, width in enumerate(col_widths, start=1):
            col_letter = openpyxl.utils.get_column_letter(idx)
            ws.column_dimensions[col_letter].width = width

        wb.save(out_xlsx_path)
        print(f"別添Excel表を生成しました: {out_xlsx_path}")
    except ImportError:
        print(f"openpyxl が未導入のため CSV 版を出力しました: {csv_fallback}")


def generate_photo_pdf(records, out_pdf_path):
    """現地調査写真集（PDF）を生成"""
    os.makedirs(os.path.dirname(out_pdf_path), exist_ok=True)
    photo_records = [r for r in records if r.get("local_photo") and os.path.exists(r["local_photo"])]
    if not photo_records:
        print("ローカルにダウンロード済みの写真ファイルが無いため、写真集PDF生成はスキップしました。")
        return

    try:
        from reportlab.lib.pagesizes import A4
        from reportlab.pdfgen import canvas
        from reportlab.pdfbase import pdfmetrics
        from reportlab.pdfbase.ttfonts import TTFont
        from reportlab.lib.utils import ImageReader

        font_name = "Helvetica"
        for fp in [r"C:\Windows\Fonts\msmincho.ttc", r"C:\Windows\Fonts\msgothic.ttc", r"C:\Windows\Fonts\meiryo.ttc"]:
            if os.path.exists(fp):
                try:
                    pdfmetrics.registerFont(TTFont("JPFont", fp, subfontIndex=0))
                    font_name = "JPFont"
                    break
                except Exception:
                    pass

        c = canvas.Canvas(out_pdf_path, pagesize=A4)
        w, h = A4

        for idx, r in enumerate(photo_records):
            slot = idx % 2
            if slot == 0:
                if idx > 0:
                    c.showPage()
                c.setFont(font_name, 14)
                c.drawCentredString(w / 2, h - 35, "現地調査 写真帳")

            top_y = (h - 65) if slot == 0 else (h / 2 - 20)
            box_h = 330
            c.rect(40, top_y - box_h, w - 80, box_h)

            # キャプション
            c.setFont(font_name, 10)
            cap1 = f"【地点番号 {r['point_no']}】 地区: {r['village']} / 分類: {r['category']} / 獣種: {r['species']} ({r['date']})"
            cap2 = f"詳細: {r['detail'] or '特になし'} (調査員: {r['username']})"
            c.drawString(50, top_y - 20, cap1)
            c.drawString(50, top_y - 36, cap2[:55])

            # 画像描画
            try:
                img = ImageReader(r["local_photo"])
                iw, ih = img.getSize()
                max_w, max_h = w - 110, box_h - 55
                scale = min(max_w / float(iw), max_h / float(ih))
                dw, dh = iw * scale, ih * scale
                dx = 40 + (w - 80 - dw) / 2
                dy = (top_y - box_h) + (box_h - 45 - dh) / 2
                c.drawImage(img, dx, dy, width=dw, height=dh, preserveAspectRatio=True)
            except Exception as img_err:
                c.drawString(60, top_y - 100, f"画像読込エラー: {img_err}")

        c.save()
        print(f"現地調査写真集PDFを生成しました: {out_pdf_path}")
    except ImportError:
        print("reportlab が未導入のため写真集PDF生成をスキップしました。")


def main():
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    os.makedirs(PHOTOS_DIR, exist_ok=True)
    os.makedirs(TRACKS_DIR, exist_ok=True)

    agri_index = load_chiba_agri_index()
    raw_rows = fetch_survey_rows_from_sheet()

    # 写真解決用マップ（GASまた公開フォルダ一覧）
    photo_name_to_id = scrape_public_drive_folder_files(PHOTO_FOLDER_ID)
    gas_photos = fetch_gas_resource("photos")
    if gas_photos and isinstance(gas_photos.get("photos"), list):
        for p in gas_photos["photos"]:
            if p.get("name") and p.get("id"):
                photo_name_to_id[p["name"]] = p["id"]

    seen_ids = set()
    records = []
    points_lonlat = []

    for row in raw_rows:
        rec_id = str(row.get("ID") or "").strip()
        lat_str = str(row.get("緯度") or "").strip()
        lng_str = str(row.get("経度") or "").strip()
        if not lat_str or not lng_str:
            continue
        try:
            lat = float(lat_str)
            lng = float(lng_str)
        except ValueError:
            continue

        # 重複IDの排除（スプレッドシート上で下にある最新行またはユニークIDを保持）
        dedup_key = rec_id if rec_id else f"{lat:.6f}_{lng:.6f}_{row.get('調査時間','')}"
        if dedup_key in seen_ids:
            continue
        seen_ids.add(dedup_key)

        # 集落名: スプレッドシートに「集落名」列があれば優先、なければ chiba_agri.geojson から空間判定
        manual_village = str(row.get("集落名") or row.get("地区名") or "").strip()
        village = manual_village if manual_village else find_village_name(lng, lat, agri_index)

        # 地点番号: スプレッドシートに「地点番号」列があれば優先、なければ連番
        manual_pt_no = str(row.get("地点番号") or "").strip()
        point_no = int(manual_pt_no) if manual_pt_no.isdigit() else (len(records) + 1)

        photo_raw = str(row.get("写真") or "").strip()
        file_id = extract_drive_file_id(photo_raw)
        if not file_id and photo_raw in photo_name_to_id:
            file_id = photo_name_to_id[photo_raw]

        local_photo = ""
        if file_id:
            dest_photo = os.path.join(PHOTOS_DIR, f"point_{point_no:03d}_{file_id[:8]}.jpg")
            if download_drive_file(file_id, dest_photo):
                local_photo = dest_photo

        record = {
            "id": rec_id or f"pt_{point_no}",
            "point_no": point_no,
            "username": str(row.get("調査者") or "").strip(),
            "date": str(row.get("調査日") or "").strip(),
            "time": str(row.get("調査時間") or "").strip(),
            "village": village,
            "category": str(row.get("地点分類") or "その他").strip(),
            "species": str(row.get("種名") or "不明").strip(),
            "detail": str(row.get("情報詳細") or "").strip(),
            "interview": str(row.get("聞き取り対象") or "").strip(),
            "photo_raw": photo_raw,
            "local_photo": local_photo,
            "lat": lat,
            "lng": lng
        }
        records.append(record)
        points_lonlat.append((lng, lat))

    # GeoJSON (survey_points_current.geojson) 作成
    point_features = []
    for r in records:
        point_features.append({
            "type": "Feature",
            "geometry": {
                "type": "Point",
                "coordinates": [r["lng"], r["lat"]]
            },
            "properties": {
                "id": r["id"],
                "point_no": r["point_no"],
                "地点番号": r["point_no"],
                "調査者": r["username"],
                "調査日": r["date"],
                "調査時間": r["time"],
                "集落名": r["village"],
                "地点分類": r["category"],
                "種名": r["species"],
                "情報詳細": r["detail"],
                "聞き取り対象": r["interview"],
                "写真": r["photo_raw"],
                "local_photo": r["local_photo"]
            }
        })

    points_geojson_path = os.path.join(BASE_DIR, "survey_points_current.geojson")
    with open(points_geojson_path, "w", encoding="utf-8") as f:
        json.dump({
            "type": "FeatureCollection",
            "name": "survey_points_current",
            "features": point_features
        }, f, ensure_ascii=False, indent=2)
    print(f"調査地点データ {len(point_features)} 件を {points_geojson_path} に出力しました。")

    # トラック同期
    _, tracks_lonlat = sync_tracks()

    # 周辺集落境界ポリゴン (target_villages.geojson) の抽出
    save_target_villages_geojson(points_lonlat, tracks_lonlat, agri_index)

    # 別添Excel表 & 写真集PDF 生成
    generate_excel_table(records, os.path.join(OUTPUT_DIR, "別添表_現地調査結果一覧.xlsx"))
    generate_photo_pdf(records, os.path.join(OUTPUT_DIR, "別添_現地調査写真集.pdf"))

    return {
        "points_count": len(point_features),
        "villages": sorted(list({r["village"] for r in records if r["village"]}))
    }


if __name__ == "__main__":
    main()
