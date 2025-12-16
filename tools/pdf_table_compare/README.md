# PDF 表格判断对比小工具（独立运行）

这个小工具用于对同一份 PDF 的每一页同时做两种“是否有表格”的判断，并导出 CSV：

- Camelot：用 `camelot` 解析 PDF（有表格=是/否）
- DeepSeek-OCR：调用 `deepseek-ai/DeepSeek-OCR`，看 OCR 结果是否包含 `<table` 标签（有表格=是/否）

导出 CSV 表头固定为：

`pdf名称、页码、camelot Stream识别是否有表格（是、否）、camelot Lattice识别是否有表格（是、否）、deepseekoce识别是否有表格（是、否）`

## 环境要求

- 建议 Python：3.10–3.12（Camelot/依赖在部分环境对 3.13 可能不稳定）

### 系统依赖（Camelot）

Linux（Ubuntu/Debian）：

```bash
sudo apt install -y ghostscript python3-tk
```

macOS（可选参考）：

```bash
brew install ghostscript
```

## 安装依赖

在仓库根目录执行：

```bash
python -m venv tools/pdf_table_compare/.venv
source tools/pdf_table_compare/.venv/bin/activate
pip install -r tools/pdf_table_compare/requirements.txt
```

## 配置 DeepSeek OCR 的 API Key

推荐用环境变量（也可以在页面里直接输入）：

```bash
export SILICONFLOW_API_KEY="你的key"
```

## 运行

```bash
streamlit run tools/pdf_table_compare/app.py
```

打开浏览器页面后：

1. 上传 PDF
2. 点击“开始分析”
3. 下载导出的 CSV

## 批量跑整个 `pdf/` 目录（可选）

```bash
source tools/pdf_table_compare/.venv/bin/activate
export SILICONFLOW_API_KEY="你的key"
python tools/pdf_table_compare/batch_run.py --enable-ocr
```

## 注意

- Camelot 对“扫描版图片 PDF”的识别通常效果很弱（因为它主要解析 PDF 内的文本/结构），这是工具对比的预期现象之一。
- DeepSeek OCR 调用会按页请求，页数多时耗时明显；如遇 429 会自动重试并退避等待。
