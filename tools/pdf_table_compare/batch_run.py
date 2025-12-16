import argparse
import glob
import os
import sys
import time
from pathlib import Path
from typing import Iterable, List, Optional, Set, Tuple

import pandas as pd

from app import PageResult, contains_table_tag, deepseek_ocr_markdown, render_page_to_data_url

try:
    import fitz  # PyMuPDF
except Exception:  # pragma: no cover
    fitz = None

try:
    import camelot
except Exception:  # pragma: no cover
    camelot = None


def bool_to_cn(value: bool) -> str:
    return "是" if value else "否"


def iter_pdf_paths(pdf_dir: str) -> List[str]:
    return sorted(glob.glob(os.path.join(pdf_dir, "*.pdf")))


def extract_camelot_table_pages(pdf_path: str, flavor: str) -> Tuple[Set[int], Optional[str]]:
    if camelot is None:
        return set(), "camelot 未安装"

    pages: Set[int] = set()

    try:
        tables = camelot.read_pdf(pdf_path, pages="all", flavor=flavor)
    except Exception as e:  # noqa: BLE001
        return set(), f"{type(e).__name__}: {e}"

    for t in tables:
        page = getattr(t, "page", None)
        if page is None:
            try:
                page = t.parsing_report.get("page")
            except Exception:  # noqa: BLE001
                page = None
        if page is None:
            continue
        try:
            pages.add(int(page))
        except Exception:  # noqa: BLE001
            continue

    return pages, None


def to_output_row(r: PageResult) -> dict:
    return {
        "pdf名称": r.pdf_name,
        "页码": r.page_num,
        "camelot Stream识别是否有表格（是、否）": bool_to_cn(r.camelot_stream_has_table),
        "camelot Lattice识别是否有表格（是、否）": bool_to_cn(r.camelot_lattice_has_table),
        "deepseekoce识别是否有表格（是、否）": bool_to_cn(r.deepseek_has_table),
    }


def load_existing_keys(csv_path: str, required_columns: List[str]) -> Set[Tuple[str, int]]:
    if not os.path.exists(csv_path):
        return set()
    df = pd.read_csv(csv_path)
    missing = [c for c in required_columns if c not in df.columns]
    if missing:
        raise ValueError(f"无法 resume：现有 CSV 缺少列 {missing}（请删除旧文件或关闭 --resume）")
    keys: Set[Tuple[str, int]] = set()
    for _, row in df.iterrows():
        try:
            keys.add((str(row["pdf名称"]), int(row["页码"])))
        except Exception:  # noqa: BLE001
            continue
    return keys


def append_rows(csv_path: str, rows: Iterable[dict], columns: List[str]) -> None:
    df = pd.DataFrame(list(rows), columns=columns)
    if df.empty:
        return
    header = not os.path.exists(csv_path)
    df.to_csv(csv_path, mode="a", header=header, index=False, encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description="Batch compare Camelot vs DeepSeek OCR table detection.")
    parser.add_argument("--pdf-dir", default="pdf", help="包含 PDF 的目录（默认：pdf）")
    parser.add_argument(
        "--out",
        default="tools/pdf_table_compare/output/pdf_table_compare.partial.csv",
        help="输出 CSV 路径（默认写 partial，完成后会生成最终 csv）",
    )
    parser.add_argument(
        "--final-out",
        default="tools/pdf_table_compare/output/pdf_table_compare.csv",
        help="最终 CSV 路径（带 utf-8-sig，便于 Excel 打开）",
    )
    parser.add_argument("--resume", action="store_true", help="如果已存在输出 CSV，则跳过已处理页")
    parser.add_argument("--sleep", type=float, default=0.0, help="每页 OCR 之间额外等待秒数（默认 0）")
    parser.add_argument("--enable-ocr", action="store_true", help="启用 DeepSeek OCR 判断（默认关闭）")
    args = parser.parse_args()

    pdf_paths = iter_pdf_paths(args.pdf_dir)
    if not pdf_paths:
        print(f"未找到 PDF：{args.pdf_dir}", file=sys.stderr)
        return 2

    Path(os.path.dirname(args.out)).mkdir(parents=True, exist_ok=True)

    required_columns = [
        "pdf名称",
        "页码",
        "camelot Stream识别是否有表格（是、否）",
        "camelot Lattice识别是否有表格（是、否）",
        "deepseekoce识别是否有表格（是、否）",
    ]

    if not args.resume:
        if os.path.exists(args.out):
            os.remove(args.out)
        if os.path.exists(args.final_out):
            os.remove(args.final_out)

    if args.resume:
        try:
            processed = load_existing_keys(args.out, required_columns)
        except ValueError as e:
            print(str(e), file=sys.stderr)
            return 2
    else:
        processed = set()
    if args.resume and processed:
        print(f"[Resume] 已存在记录：{len(processed)} 行，将跳过已处理页")

    api_key = os.getenv("SILICONFLOW_API_KEY", "")
    if args.enable_ocr and not api_key:
        print("启用 OCR 但未设置环境变量 SILICONFLOW_API_KEY", file=sys.stderr)
        return 2
    if fitz is None:
        print("缺少依赖：pymupdf（fitz）未安装", file=sys.stderr)
        return 2

    new_rows: List[dict] = []
    new_count = 0

    for pdf_idx, pdf_path in enumerate(pdf_paths, start=1):
        pdf_name = os.path.basename(pdf_path)
        print(f"[{pdf_idx}/{len(pdf_paths)}] 处理：{pdf_name}")

        camelot_stream_pages, camelot_stream_err = extract_camelot_table_pages(pdf_path, "stream")
        camelot_lattice_pages, camelot_lattice_err = extract_camelot_table_pages(pdf_path, "lattice")
        if camelot_stream_err:
            print(f"  [Camelot Stream] 警告：{camelot_stream_err}")
        if camelot_lattice_err:
            print(f"  [Camelot Lattice] 警告：{camelot_lattice_err}")

        doc = fitz.open(pdf_path)
        total_pages = doc.page_count

        page_range = range(1, total_pages + 1)
        for page_num in page_range:
            key = (pdf_name, page_num)
            if key in processed:
                continue

            camelot_stream_has = page_num in camelot_stream_pages
            camelot_lattice_has = page_num in camelot_lattice_pages

            deepseek_has = False
            if args.enable_ocr:
                try:
                    image_data_url = render_page_to_data_url(doc, page_num, zoom=2.0)
                    ocr_text = deepseek_ocr_markdown(image_data_url, api_key)
                    deepseek_has = contains_table_tag(ocr_text)
                except Exception as e:  # noqa: BLE001
                    print(f"  [OCR] 第 {page_num} 页失败：{type(e).__name__}: {e}")
                    deepseek_has = False

                if args.sleep > 0:
                    time.sleep(args.sleep)

            r = PageResult(
                pdf_name=pdf_name,
                page_num=page_num,
                camelot_stream_has_table=camelot_stream_has,
                camelot_lattice_has_table=camelot_lattice_has,
                deepseek_has_table=deepseek_has,
            )
            new_rows.append(to_output_row(r))
            new_count += 1

            if len(new_rows) >= 50:
                append_rows(args.out, new_rows, required_columns)
                new_rows.clear()
                print(f"  已写入 {new_count} 行…")

        doc.close()

    if new_rows:
        append_rows(args.out, new_rows, required_columns)
        new_rows.clear()

    # 生成最终带 BOM 的 CSV
    df = pd.read_csv(args.out)
    missing = [c for c in required_columns if c not in df.columns]
    if missing:
        print(f"输出 CSV 缺少列：{missing}", file=sys.stderr)
        return 2
    df.to_csv(args.final_out, index=False, encoding="utf-8-sig")
    print(f"完成：{args.final_out}（共 {len(df)} 行）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
