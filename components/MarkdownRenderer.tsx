
import React, { useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeRaw from 'rehype-raw';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';

interface MarkdownRendererProps {
  content: string;
  highlightText?: string;
}

const MATH_SEGMENT_REGEX = /\$\$[\s\S]+?\$\$|\$[^\n$]+?\$/g;

const normalizeLatexForOcrMarkdown = (input: string): string => {
  let output = input;

  // OCR 常用的脚注上标：\(^{10}\) / \(^{9,23}\)
  output = output.replace(/\\\(\s*\^\{([^}]+)\}\s*\\\)/g, '<sup>$1</sup>');
  output = output.replace(/\\\(\s*\^\s*([0-9][0-9,]*)\s*\\\)/g, '<sup>$1</sup>');

  // OCR 常用的圈号/编号标记：\(①\)、\((3)\) —— 这类通常不是数学公式
  output = output.replace(/\\\(\s*([①-⑳])\s*\\\)/g, '$1');
  output = output.replace(/\\\(\s*\((\d+)\)\s*\\\)/g, '($1)');

  // LaTeX display math: \[...\] -> $$...$$（remark-math 更容易识别）
  output = output.replace(/\\\[((?:.|\n)*?)\\\]/g, (_, inner) => `\n\n$$${inner}$$\n\n`);

  // LaTeX inline math: \( ... \) -> $...$
  output = output.replace(/\\\(([\s\S]+?)\\\)/g, (_, inner) => `$${inner}$`);

  return output;
};

const repairLatexInsideMath = (input: string): string => {
  return input.replace(/\$\$([\s\S]+?)\$\$|\$([^\n$]+?)\$/g, (full, block, inline) => {
    const isBlock = typeof block === 'string' && block.length > 0;
    const math = (block ?? inline) as string;
    let fixed = math;

    // OCR 常见：< = / > = 这类不是合法 TeX，改为 \leq / \geq
    fixed = fixed.replace(/<\s*=/g, '\\leq ');
    fixed = fixed.replace(/>\s*=/g, '\\geq ');
    fixed = fixed.replace(/=\s*</g, '\\leq ');
    fixed = fixed.replace(/=\s*>/g, '\\geq ');

    // Unicode 符号兜底（医学文档里很常见）
    fixed = fixed.replace(/≤/g, '\\leq ');
    fixed = fixed.replace(/≥/g, '\\geq ');
    fixed = fixed.replace(/×/g, '\\times ');
    fixed = fixed.replace(/·/g, '\\cdot ');

    // 修复 “10 9” -> “10^{9}”
    fixed = fixed.replace(/10\s+([0-9])(?!\d)/g, '10^{$1}');

    // 数学环境里未转义的 % 会被当作注释
    fixed = fixed.replace(/(^|[^\\])%/g, '$1\\%');

    return isBlock ? `$$${fixed}$$` : `$${fixed}$`;
  });
};

const applyHighlightOutsideMath = (input: string, highlightText: string): string => {
  const segments: string[] = [];
  const masked = input.replace(MATH_SEGMENT_REGEX, (m) => {
    const id = segments.length;
    segments.push(m);
    return `@@__MATH_${id}__@@`;
  });

  const escapedText = highlightText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`(${escapedText})`, 'gi');
  const highlighted = masked.replace(regex, '<mark>$1</mark>');

  return highlighted.replace(/@@__MATH_(\d+)__@@/g, (_, rawId) => segments[Number(rawId)] ?? '');
};

const MarkdownRenderer: React.FC<MarkdownRendererProps> = ({ content, highlightText }) => {
  
  // Clean content and apply highlighting
  const processedContent = useMemo(() => {
    if (!content) return "";
    
    let processed = content;

    // --- PHASE 1: STRUCTURE MAPPING (OCR Specific) ---
    
    // 1. Remove Coordinate/Detection tags FIRST (they are noise)
    processed = processed.replace(/<\|det\|>.*?<\|\/det\|>/gs, '');
    processed = processed.replace(/&lt;\|det\|&gt;.*?&lt;\|\/det\|&gt;/gs, '');
    processed = processed.replace(/<\|(box|quad)\|>/g, '');
    processed = processed.replace(/<\|\/(box|quad)\|>/g, '');

    // 2. Semantic Mapping: Title -> H1
    processed = processed.replace(/<\|ref\|>title<\|\/ref\|>\s*/gi, '\n# ');
    processed = processed.replace(/&lt;\|ref\|&gt;title&lt;\|\/ref\|&gt;\s*/gi, '\n# ');

    // 3. Semantic Mapping: Subtitle -> H2
    processed = processed.replace(/<\|ref\|>subtitle<\|\/ref\|>\s*/gi, '\n## ');
    processed = processed.replace(/&lt;\|ref\|&gt;subtitle&lt;\|\/ref\|&gt;\s*/gi, '\n## ');

    // 4. Semantic Mapping: Text -> Plain (Remove tag)
    processed = processed.replace(/<\|ref\|>text<\|\/ref\|>\s*/gi, '');
    processed = processed.replace(/&lt;\|ref\|&gt;text&lt;\|\/ref\|&gt;\s*/gi, '');

    // 5. Generic Unwrap
    processed = processed.replace(/<\|ref\|>(.*?)<\|\/ref\|>/gs, ''); 
    processed = processed.replace(/&lt;\|ref\|&gt;(.*?)&lt;\|\/ref\|&gt;/gs, '');

    // --- PHASE 2: LATEX SYMBOL TO MARKDOWN CONVERSION ---
    
    // 1. Convert decorative LaTeX bullets to Markdown bullets
    const bulletPattern = /(?:\\\(|\\\[|\s|^)\\?(diamond|star|bigstar|clubsuit|spadesuit|heartsuit|diamondsuit|bullet|circ)(?:\\\)|\\\]|\s|$)/gi;
    processed = processed.replace(bulletPattern, '\n- '); 
    
    // 2. Remove hallucinated slash commands
    processed = processed.replace(/^\s*\\\s+/gm, ''); 

    // --- PHASE 3: LATEX 兼容增强（面向 OCR 输出） ---
    processed = normalizeLatexForOcrMarkdown(processed);
    processed = repairLatexInsideMath(processed);

    // --- PHASE 4: MARKDOWN NORMALIZATION ---

    // Force Headers to new lines
    processed = processed.replace(/([^\n])\s*(#{1,6}\s)/g, '$1\n\n$2');
    processed = processed.replace(/^(#{1,6})(?=[^#\s])/gm, '$1 ');

    // --- PHASE 5: HIGHLIGHTING ---
    if (highlightText && highlightText.trim().length >= 2) {
      try {
        processed = applyHighlightOutsideMath(processed, highlightText);
      } catch (e) {
        console.warn("Highlighting failed regex", e);
      }
    }

    return processed;
  }, [content, highlightText]);

  return (
    <div className="markdown-body prose prose-slate prose-sm max-w-none prose-headings:font-bold prose-h1:text-xl prose-h2:text-lg prose-p:text-slate-700 prose-a:text-accent font-sans">
      <ReactMarkdown
        rehypePlugins={[
          rehypeRaw,
          [
            rehypeKatex,
            {
              throwOnError: false,
              strict: 'ignore',
            },
          ],
        ]} 
        remarkPlugins={[remarkGfm, remarkMath]} 
        components={{
          table: ({node, ...props}) => (
            <div className="overflow-x-auto my-4">
              <table {...props} className="min-w-full border-collapse border border-slate-200" />
            </div>
          ),
          td: ({node, ...props}) => (
            <td {...props} className="border border-slate-300 px-4 py-2 text-sm text-slate-700" />
          ),
          th: ({node, ...props}) => (
             <th {...props} className="border border-slate-300 bg-slate-100 px-4 py-2 text-sm font-semibold text-slate-900 text-left" />
          ),
          sup: ({node, ...props}) => (
            <sup {...props} className="text-[10px] text-slate-500 font-medium align-super ml-0.5 select-none" />
          )
        }}
      >
        {processedContent}
      </ReactMarkdown>
    </div>
  );
};

export default MarkdownRenderer;
