import base64
import os
import re
import tempfile
import time
from dataclasses import dataclass
from typing import Iterable, List, Optional, Set, Tuple

import pandas as pd
import requests
import streamlit as st

try:
    import fitz  # PyMuPDF
except Exception:  # pragma: no cover
    fitz = None

try:
    import camelot
except Exception:  # pragma: no cover
    camelot = None


BASE_URL = "https://api.siliconflow.cn/v1"
DEEPSEEK_OCR_MODEL = "deepseek-ai/DeepSeek-OCR"
DEFAULT_OCR_PROMPT = "<image>\n<|grounding|>Convert the document to markdown."


@dataclass(frozen=True)
class PageResult:
    pdf_name: str
    page_num: int
    camelot_stream_has_table: bool
    camelot_lattice_has_table: bool
    deepseek_has_table: bool


def parse_pages(pages_text: str, total_pages: int) -> List[int]:
    text = (pages_text or "").strip().lower()
    if not text or text == "all":
        return list(range(1, total_pages + 1))

    text = text.replace(" ", "")
    pages: List[int] = []

    if re.fullmatch(r"\d+-\d+", text):
        start_s, end_s = text.split("-", 1)
        start, end = int(start_s), int(end_s)
        if start < 1 or end < 1 or start > total_pages or end > total_pages:
            raise ValueError("页码范围超出 PDF 总页数")
        if start > end:
            start, end = end, start
        return list(range(start, end + 1))

    if re.fullmatch(r"\d+(,\d+)*", text):
        for part in text.split(","):
            page = int(part)
            if page < 1 or page > total_pages:
                raise ValueError("页码超出 PDF 总页数")
            pages.append(page)
        unique_pages = sorted(set(pages))
        return unique_pages

    raise ValueError('页码格式不正确：支持 "all"、"1-3"、"1,3,5"')


def strip_markdown_fences(text: str) -> str:
    if not text:
        return ""
    cleaned = text.strip()
    cleaned = re.sub(r"^```markdown\s*", "", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"^```\s*", "", cleaned)
    cleaned = re.sub(r"\s*```$", "", cleaned)
    return cleaned.strip()


def contains_table_tag(text: str) -> bool:
    return "<table" in (text or "").lower()


def render_page_to_data_url(doc: "fitz.Document", page_num: int, zoom: float = 2.0) -> str:
    if fitz is None:
        raise RuntimeError("缺少依赖：pymupdf（fitz）未安装")
    page = doc.load_page(page_num - 1)
    matrix = fitz.Matrix(zoom, zoom)
    pix = page.get_pixmap(matrix=matrix, alpha=False)
    png_bytes = pix.tobytes("png")
    encoded = base64.b64encode(png_bytes).decode("ascii")
    return f"data:image/png;base64,{encoded}"


def deepseek_ocr_markdown(
    image_data_url: str,
    api_key: str,
    prompt: str = DEFAULT_OCR_PROMPT,
    retries: int = 5,
    timeout_s: int = 120,
) -> str:
    last_error: Optional[Exception] = None
    for attempt in range(1, retries + 1):
        try:
            resp = requests.post(
                f"{BASE_URL}/chat/completions",
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json",
                },
                json={
                    "model": DEEPSEEK_OCR_MODEL,
                    "messages": [
                        {
                            "role": "user",
                            "content": [
                                {"type": "image_url", "image_url": {"url": image_data_url}},
                                {"type": "text", "text": prompt},
                            ],
                        }
                    ],
                    "stream": False,
                    "temperature": 0.0,
                    "max_tokens": 4096,
                },
                timeout=timeout_s,
            )

            if not resp.ok:
                if resp.status_code == 401:
                    raise RuntimeError("API Key 无效（401）")
                if resp.status_code == 429:
                    raise RuntimeError("触发限流（429）")
                try:
                    detail = resp.json()
                except Exception:
                    detail = {"error": {"message": resp.text}}
                raise RuntimeError(detail.get("error", {}).get("message") or f"API 错误：{resp.status_code}")

            data = resp.json()
            content = data.get("choices", [{}])[0].get("message", {}).get("content", "") or ""
            return strip_markdown_fences(content)

        except Exception as e:  # noqa: BLE001
            last_error = e
            is_rate_limit = "429" in str(e)
            if attempt < retries:
                wait_s = (5 * attempt) if is_rate_limit else (1 * (2 ** (attempt - 1)))
                time.sleep(wait_s)
                continue
            raise

    raise last_error or RuntimeError("DeepSeek OCR 失败（未知错误）")


def pages_to_camelot_spec(pages: List[int], total_pages: int) -> str:
    if pages == list(range(1, total_pages + 1)):
        return "all"
    if pages and pages == list(range(pages[0], pages[-1] + 1)):
        return f"{pages[0]}-{pages[-1]}"
    return ",".join(str(p) for p in pages)


def camelot_table_pages(pdf_path: str, pages_spec: str, flavor: str) -> Tuple[Set[int], Optional[str]]:
    if camelot is None:
        return set(), "缺少依赖：camelot 未安装"

    try:
        tables = camelot.read_pdf(pdf_path, pages=pages_spec, flavor=flavor)
    except Exception as e:  # noqa: BLE001
        return set(), f"{type(e).__name__}: {e}"

    pages: Set[int] = set()
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


def bool_to_cn(value: bool) -> str:
    return "是" if value else "否"


def build_results_df(results: Iterable[PageResult]) -> pd.DataFrame:
    return pd.DataFrame(
        [
            {
                "pdf名称": r.pdf_name,
                "页码": r.page_num,
                "camelot Stream识别是否有表格（是、否）": bool_to_cn(r.camelot_stream_has_table),
                "camelot Lattice识别是否有表格（是、否）": bool_to_cn(r.camelot_lattice_has_table),
                "deepseekoce识别是否有表格（是、否）": bool_to_cn(r.deepseek_has_table),
            }
            for r in results
        ]
    )


def main() -> None:
    st.set_page_config(page_title="PDF 表格判断对比工具", layout="centered")
    st.title("PDF 表格判断对比工具")

    with st.expander("说明（点开查看）", expanded=False):
        st.markdown(
            "- Camelot：直接解析 PDF 判断是否有表格\n"
            "- DeepSeek-OCR：对每页做 OCR，判断结果里是否包含 `<table` 标签\n"
            "- 输出 CSV：`pdf名称、页码、camelot Stream识别是否有表格（是、否）、camelot Lattice识别是否有表格（是、否）、deepseekoce识别是否有表格（是、否）`"
        )

    uploaded = st.file_uploader("上传 PDF", type=["pdf"])
    pages_text = st.text_input('页码范围（可选）', value="all", help='支持 "all"、"1-3"、"1,3,5"')

    st.subheader("DeepSeek OCR")
    env_key = os.getenv("SILICONFLOW_API_KEY", "")
    api_key = st.text_input("SILICONFLOW_API_KEY（可留空使用环境变量）", value=env_key, type="password")
    enable_ocr = st.checkbox("启用 DeepSeek OCR 判断", value=True)

    if st.button("开始分析", type="primary", disabled=(uploaded is None)):
        if uploaded is None:
            st.warning("请先上传 PDF")
            return

        if enable_ocr and not api_key:
            st.error("已启用 DeepSeek OCR，但未提供 `SILICONFLOW_API_KEY`（环境变量或输入框）")
            return

        if fitz is None:
            st.error("缺少依赖：pymupdf（fitz）未安装，无法渲染 PDF 页面截图")
            return

        with tempfile.NamedTemporaryFile(delete=False, suffix=".pdf") as tmp:
            tmp.write(uploaded.getvalue())
            pdf_path = tmp.name

        pdf_name = uploaded.name
        doc = fitz.open(pdf_path)
        total_pages = doc.page_count

        try:
            pages = parse_pages(pages_text, total_pages)
        except ValueError as e:
            doc.close()
            st.error(str(e))
            return

        st.info(f"PDF：{pdf_name}（共 {total_pages} 页），本次分析页码：{pages[0]}..{pages[-1]}（{len(pages)} 页）")

        pages_spec = pages_to_camelot_spec(pages, total_pages)
        with st.spinner("Camelot 分析中（Stream/Lattice）…"):
            stream_pages, stream_err = camelot_table_pages(pdf_path, pages_spec, "stream")
            lattice_pages, lattice_err = camelot_table_pages(pdf_path, pages_spec, "lattice")
        if stream_err:
            st.caption(f"[Camelot Stream] 异常：{stream_err}")
        if lattice_err:
            st.caption(f"[Camelot Lattice] 异常：{lattice_err}")

        progress = st.progress(0, text="准备开始…")
        results: List[PageResult] = []

        for idx, page_num in enumerate(pages, start=1):
            progress.progress((idx - 1) / max(1, len(pages)), text=f"处理中：第 {page_num} 页")

            camelot_stream_ok = page_num in stream_pages
            camelot_lattice_ok = page_num in lattice_pages

            deepseek_ok = False
            if enable_ocr:
                try:
                    data_url = render_page_to_data_url(doc, page_num, zoom=2.0)
                    ocr_text = deepseek_ocr_markdown(data_url, api_key)
                    deepseek_ok = contains_table_tag(ocr_text)
                except Exception as e:  # noqa: BLE001
                    st.caption(f"[DeepSeek OCR] 第 {page_num} 页异常：{type(e).__name__}: {e}")
                    deepseek_ok = False

            results.append(
                PageResult(
                    pdf_name=pdf_name,
                    page_num=page_num,
                    camelot_stream_has_table=camelot_stream_ok,
                    camelot_lattice_has_table=camelot_lattice_ok,
                    deepseek_has_table=deepseek_ok,
                )
            )

        progress.progress(1.0, text="完成")
        doc.close()

        df = build_results_df(results)
        st.dataframe(df, use_container_width=True)

        csv_bytes = df.to_csv(index=False, encoding="utf-8-sig").encode("utf-8-sig")
        st.download_button(
            "下载 CSV",
            data=csv_bytes,
            file_name=f"{os.path.splitext(pdf_name)[0]}_table_compare.csv",
            mime="text/csv",
        )


if __name__ == "__main__":
    main()
