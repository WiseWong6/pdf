
import * as pdfjsLib from 'pdfjs-dist';
import { VERIFIER_MODEL_NAME, DEFAULT_VERIFIER_SYSTEM_PROMPT, DEFAULT_VERIFIER_USER_PROMPT } from '../constants';
import { PageData } from '../types';

// Ensure worker is configured. Using the same version as in index.html importmap
pdfjsLib.GlobalWorkerOptions.workerSrc = `https://esm.sh/pdfjs-dist@4.4.168/build/pdf.worker.min.mjs`;

const BASE_URL = 'https://api.siliconflow.cn/v1';
const MODEL_NAME = 'deepseek-ai/DeepSeek-OCR';

// Update key to force load new prompt settings
const PROMPT_STORAGE_KEY = 'VERIFIER_SYSTEM_PROMPT_LOGIC_V5';

export const checkApiKey = () => {
  return localStorage.getItem('SILICONFLOW_API_KEY');
};

export const saveApiKey = (key: string) => {
  localStorage.setItem('SILICONFLOW_API_KEY', key);
};

export const getVerifierPrompt = () => {
  return localStorage.getItem(PROMPT_STORAGE_KEY) || DEFAULT_VERIFIER_SYSTEM_PROMPT;
};

export const saveVerifierPrompt = (prompt: string) => {
  localStorage.setItem(PROMPT_STORAGE_KEY, prompt);
};


// Convert a File object (Image) to Base64
const fileToBase64 = (file: File): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = error => reject(error);
  });
};

// Render a PDF page to a Base64 image
const renderPageToImage = async (pdf: any, pageNum: number): Promise<string> => {
  const page = await pdf.getPage(pageNum);
  // OPTIMIZATION: 2.0 scale is usually sufficient for OCR and faster than 3.0
  const viewport = page.getViewport({ scale: 2.0 }); 
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  
  canvas.height = viewport.height;
  canvas.width = viewport.width;

  if (!context) throw new Error("Canvas context missing");

  await page.render({ canvasContext: context, viewport: viewport }).promise;
  
  // 0.8 quality jpeg is a good balance for OCR
  return canvas.toDataURL('image/jpeg', 0.8);
};

// --- HELPER: INPUT NOISE CLEANING ---
const cleanOcrNoise = (text: string): string => {
  if (!text) return "";
  let cleaned = text;
  
  // Remove coordinate detection tags <|det|>...<|/det|>
  cleaned = cleaned.replace(/<\|det\|>.*?<\|\/det\|>/gs, '');
  cleaned = cleaned.replace(/&lt;\|det\|&gt;.*?&lt;\|\/det\|&gt;/gs, '');
  
  // Remove quad/box tags
  cleaned = cleaned.replace(/<\|(box|quad)\|>/g, '');
  cleaned = cleaned.replace(/<\|\/(box|quad)\|>/g, '');
  
  return cleaned.trim();
};

// --- STEP 1: OCR ---
const callOcrModel = async (
  imageBase64: string, 
  apiKey: string, 
  pageLabel: string, 
  customPrompt?: string,
  retries = 5,
  signal?: AbortSignal
): Promise<string> => {
  let lastError: any;
  console.log(`[OCR] Starting Request for ${pageLabel}...`);

  // Default Official Prompt
  const defaultPrompt = '<image>\n<|grounding|>Convert the document to markdown.';
  const finalPrompt = customPrompt || defaultPrompt;

  for (let i = 0; i < retries; i++) {
    if (signal?.aborted) throw new Error("Process aborted by user");

    try {
      const response = await fetch(`${BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: MODEL_NAME,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'image_url', image_url: { url: imageBase64 } },
                { type: 'text', text: finalPrompt }
              ]
            }
          ],
          stream: false,
          temperature: 0.0, 
          max_tokens: 4096
        }),
        signal
      });

      if (!response.ok) {
        if (response.status === 401) throw new Error("Invalid API Key");
        if (response.status === 429) throw new Error(`API Error: 429 Rate Limit Exceeded`);
        const err = await response.json();
        throw new Error(err.error?.message || `API Error: ${response.status}`);
      }

      const data = await response.json();
      let content = data.choices[0]?.message?.content || '';
      content = content.replace(/^```markdown\s*/, '').replace(/^```\s*/, '').replace(/\s*```$/, '');
      
      console.log(`[OCR] Success for ${pageLabel} (Length: ${content.length})`);
      return content;

    } catch (error: any) {
      if (error.name === 'AbortError' || signal?.aborted) throw new Error("Process aborted by user");
      
      lastError = error;
      const isRateLimit = typeof error.message === 'string' && error.message.includes('429');
      
      console.warn(`[OCR] Failed ${pageLabel} (Attempt ${i + 1}/${retries}).`, error);
      
      if (i < retries - 1) {
         const waitTime = isRateLimit ? 5000 * (i + 1) : 1000 * Math.pow(2, i);
         await new Promise(resolve => setTimeout(resolve, waitTime));
      }
    }
  }
  throw lastError;
};

// --- STEP 2: LAYOUT RESTORATION (SPLIT & MERGE STRATEGY) ---
const callLayoutRestorationModel = async (
  imageBase64: string,
  rawOcrText: string,
  apiKey: string,
  signal?: AbortSignal,
  retries = 3 
): Promise<{ content: string; hasRealTable: boolean; cleaned: boolean; reasoning?: string }> => {
  
  console.log("[Restorer] Starting Table Detection & Restoration...");
  
  // 1. Split Text by Table Tags
  // Uses capture group () to include the separator (the table tag itself) in the result array
  const parts = rawOcrText.split(/(<table[^>]*>[\s\S]*?<\/table>)/i);
  
  // If no tables found, return original text immediately (preserves everything)
  if (parts.length <= 1) {
     console.log("[Restorer] Split produced 1 part (No tables detected). Skipping restoration.");
     return { content: rawOcrText, hasRealTable: false, cleaned: false, reasoning: "No tables detected in OCR." };
  }

  const systemPrompt = getVerifierPrompt();
  let fullReasoningLog = "";
  let hasAnyRealTable = false;
  let hasAnyCleaned = false;

  console.log(`[Restorer] Found ${Math.floor(parts.length / 2)} potential tables (Total parts: ${parts.length}). Processing segments...`);

  const processedParts = await Promise.all(parts.map(async (part, index) => {
    // Check if this part is a table. If not, return it AS IS (Preserve Text)
    if (!part.match(/^<table/i)) {
        return part; 
    }

    const tableIndex = Math.floor(index / 2) + 1;
    console.log(`[Restorer] Processing Table #${tableIndex} (HTML Length: ${part.length})...`);

    // It is a table. Extract it and ask AI to judge/redraw just this part.
    const tableHtml = part;
    const userPromptText = DEFAULT_VERIFIER_USER_PROMPT
      .replace('{{ocr_html}}', tableHtml)
      .replace('{{pdf_img}}', '(见附图)');

    for (let i = 0; i < retries; i++) {
        if (signal?.aborted) throw new Error("Process aborted by user");

        try {
            console.log(`[Restorer] Sending request for Table #${tableIndex} to ${VERIFIER_MODEL_NAME}...`);
            const response = await fetch(`${BASE_URL}/chat/completions`, {
                method: 'POST',
                headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                model: VERIFIER_MODEL_NAME,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { 
                      role: 'user', 
                      content: [
                        { type: 'image_url', image_url: { url: imageBase64 } },
                        { type: 'text', text: userPromptText } 
                      ]
                    }
                ],
                stream: false,
                temperature: 0.1, 
                max_tokens: 3000, 
                }),
                signal
            });

            if (!response.ok) {
                if (response.status === 429) throw new Error("429 Rate Limit");
                throw new Error(`API Error: ${response.status}`);
            }

            const data = await response.json();
            const message = data.choices[0]?.message;
            let finalContent = message?.content || '';
            
            // --- DEEP THINKING / REASONING CAPTURE ---
            // SiliconFlow/DeepSeek style: reasoning might be in `reasoning_content`
            const reasoningContent = message?.reasoning_content || ''; 
            if (reasoningContent) {
                console.log(`[Restorer] Table #${tableIndex} Reasoning Captured.`);
                fullReasoningLog += `\n[Table #${tableIndex} Thinking]:\n${reasoningContent}\n`;
            }

            // Clean Markdown wrappers
            finalContent = finalContent
                .replace(/^```(markdown|html|xml)?\s*/i, '')
                .replace(/\s*```$/i, '')
                .trim();

            console.log(`[Restorer] Table #${tableIndex} Response Length: ${finalContent.length}`);
            
            // Check results
            const outputHasHtmlTable = /<table/i.test(finalContent);
            const outputHasMarkdownTable = /\|[\s-]*:?---[\s-]*\|/.test(finalContent);
            
            if (outputHasHtmlTable || outputHasMarkdownTable) {
                hasAnyRealTable = true;
                console.log(`[Restorer] Table #${tableIndex} Decision: KEEP as Table`);
            } else {
                hasAnyCleaned = true;
                console.log(`[Restorer] Table #${tableIndex} Decision: CONVERT to Text`);
            }
            
            // Success: Return the restored segment
            return finalContent;

        } catch (error: any) {
            if (error.name === 'AbortError' || signal?.aborted) throw new Error("Process aborted by user");
            
            // Log warning
            console.warn(`[Restorer] Table #${tableIndex} failed (Attempt ${i+1}/${retries}). Error: ${error.message}`);
            
            if (i === retries - 1) {
                 console.error(`[Restorer] Table #${tableIndex} GAVE UP. Keeping original HTML.`);
                 fullReasoningLog += `[Table Segment ${tableIndex}]: Failed (${error.message})\n`;
                 return tableHtml; // FALLBACK: Return original table if AI fails
            }
            
            // Exponential backoff
            const waitTime = error.message.includes('429') ? 2000 * (i + 1) : 1000;
            await new Promise(r => setTimeout(r, waitTime));
        }
    }
    return tableHtml; // Should not reach here due to return in catch, but TS safe
  }));

  // Reassemble the document
  const finalContent = processedParts.join('');
  console.log(`[Restorer] All segments processed. Reassembled content length: ${finalContent.length}`);

  return { 
      content: finalContent, 
      hasRealTable: hasAnyRealTable, 
      cleaned: hasAnyCleaned, 
      reasoning: fullReasoningLog || "Table segments processed individually." 
  };
};


export const parsePageRange = (rangeStr: string, totalPages: number): number[] => {
  const pages = new Set<number>();
  if (!rangeStr || rangeStr === 'all') {
    for (let i = 1; i <= totalPages; i++) pages.add(i);
    return Array.from(pages).sort((a, b) => a - b);
  }

  const parts = rangeStr.split(/[,;]/);
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    
    if (trimmed.includes('-')) {
      const [start, end] = trimmed.split('-').map(Number);
      if (!isNaN(start) && !isNaN(end)) {
        for (let i = start; i <= end; i++) {
          if (i >= 1 && i <= totalPages) pages.add(i);
        }
      }
    } else {
      const page = Number(trimmed);
      if (!isNaN(page) && page >= 1 && page <= totalPages) {
        pages.add(page);
      }
    }
  }
  
  const sorted = Array.from(pages).sort((a, b) => a - b);
  return sorted.length > 0 ? sorted : Array.from({length: totalPages}, (_, i) => i + 1);
};

export const processSinglePage = async (
  file: File,
  physicalPageNum: number,
  customPrompt?: string
): Promise<string> => {
  const apiKey = checkApiKey();
  if (!apiKey) throw new Error("Missing API Key");

  let imageBase64 = "";
  if (file.type === 'application/pdf') {
    const arrayBuffer = await file.arrayBuffer();
    const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
    const pdf = await loadingTask.promise;
    imageBase64 = await renderPageToImage(pdf, physicalPageNum);
  } else {
    imageBase64 = await fileToBase64(file);
  }

  return await callOcrModel(imageBase64, apiKey, `Page ${physicalPageNum}`, customPrompt);
};

export const processDocument = async (
  file: File, 
  onProgress: (status: string) => void,
  onPageUpdate: (pageIndex: number, data: Partial<PageData>) => void,
  pagesToProcess: number[],
  signal?: AbortSignal
): Promise<string> => {
  const apiKey = checkApiKey();
  if (!apiKey) {
    throw new Error("缺少 SiliconFlow API Key，请在设置中配置。");
  }

  const fileType = file.type;
  
  try {
    if (fileType === 'application/pdf') {
      onProgress("正在加载 PDF...");
      const arrayBuffer = await file.arrayBuffer();
      const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
      const pdf = await loadingTask.promise;
      
      const restorationPromises: Promise<void>[] = [];

      // Pipeline Processing:
      // Loop 1: Render -> OCR -> Dispatch Restoration
      for (let i = 0; i < pagesToProcess.length; i++) {
        if (signal?.aborted) throw new Error("Process aborted by user");
        
        const pageNum = pagesToProcess[i];
        
        // 1. Initial State for Page
        onPageUpdate(i, { status: 'pending' });

        try {
           onProgress(`正在处理: 第 ${pageNum} 页 (OCR识别中)...`);

           // 2. Render
           const imageBase64 = await renderPageToImage(pdf, pageNum);
           if (signal?.aborted) throw new Error("Process aborted by user");

           // 3. OCR (DeepSeek)
           // We await OCR because we need the text for restoration input
           const rawContent = await callOcrModel(imageBase64, apiKey, `Page ${pageNum}`, undefined, 5, signal);
           
           // CRITICAL: Callback Immediately with RAW OCR
           onPageUpdate(i, { 
             rawOCR: rawContent, 
             restored: null, 
             status: 'ocr_success' 
           });
           
           // 4. CHECK: DOES IT CONTAIN TABLE?
           // If yes, queue restoration. If no, mark as complete immediately.
           const hasTable = /<table/i.test(rawContent);
           
           if (!hasTable) {
             console.log(`[Flow] Page ${pageNum}: No tables detected in raw OCR. Marking complete.`);
             // NO TABLE -> SKIP LLM -> MARK COMPLETE
             onPageUpdate(i, {
                status: 'complete',
                verificationResult: {
                  hasTable: false,
                  reason: "无表格 (无需重绘)",
                }
             });
           } else {
              console.log(`[Flow] Page ${pageNum}: Table tag detected. Triggering background restoration task...`);
              // HAS TABLE -> START BACKGROUND LLM TASK
              const restorationTask = (async () => {
                if (signal?.aborted) return;
                
                // Small delay to allow UI to settle or stagger requests slightly
                await new Promise(r => setTimeout(r, 200));

                onPageUpdate(i, { status: 'restoring' });
                
                try {
                    const restorationResult = await callLayoutRestorationModel(imageBase64, rawContent, apiKey, signal, 3);
                    
                    if (signal?.aborted) return;

                    onPageUpdate(i, {
                      restored: restorationResult.content,
                      status: 'complete',
                      verificationResult: {
                        hasTable: restorationResult.hasRealTable,
                        reason: restorationResult.cleaned ? "文档结构已还原" : "表格已保留",
                        modelReasoning: restorationResult.reasoning
                      }
                    });
                } catch (err: any) {
                    if (signal?.aborted) return;
                    console.error(`Restoration failed for page ${pageNum}`, err);
                    onPageUpdate(i, {
                      status: 'error',
                      errorMessage: `还原失败: ${err.message}`
                    });
                }
              })();
              restorationPromises.push(restorationTask);
           }

        } catch (pageError: any) {
           if (signal?.aborted || pageError.message === "Process aborted by user") throw new Error("Process aborted by user");
           
           console.error(`Error on page ${pageNum}:`, pageError);
           onPageUpdate(i, {
             status: 'error',
             errorMessage: pageError.message || "Unknown error"
           });
        }
      }
      
      onProgress("OCR 扫描完成，正在等待后台排版优化...");
      
      // Wait for all background restorations to complete
      await Promise.all(restorationPromises);
      
      return "DONE";

    } else if (fileType.startsWith('image/')) {
        // Image logic (Simplified for now, similar flow)
        onProgress("正在处理图片...");
        const imageBase64 = await fileToBase64(file);
        
        onPageUpdate(0, { status: 'pending' });
        
        const rawContent = await callOcrModel(imageBase64, apiKey, "Image", undefined, 5, signal);
        onPageUpdate(0, { rawOCR: rawContent, status: 'ocr_success' });

        const hasTable = /<table/i.test(rawContent);

        if (!hasTable) {
            console.log(`[Flow] Image: No tables detected. Marking complete.`);
            onPageUpdate(0, {
                status: 'complete',
                verificationResult: { hasTable: false, reason: "无表格" }
            });
            return rawContent;
        } else {
            console.log(`[Flow] Image: Table detected. Restoring...`);
            onProgress("正在智能还原版式...");
            const restorationResult = await callLayoutRestorationModel(imageBase64, rawContent, apiKey, signal);
            
            onPageUpdate(0, {
                 restored: restorationResult.content,
                 status: 'complete',
                 verificationResult: {
                   hasTable: restorationResult.hasRealTable,
                   reason: restorationResult.cleaned ? "文档结构已还原" : "表格已保留",
                   modelReasoning: restorationResult.reasoning
                 }
            });
            return restorationResult.content;
        }

    } else {
      throw new Error("不支持的文件类型。");
    }
  } catch (error: any) {
    if (error.message === "Process aborted by user") {
      throw error;
    }
    console.error("OCR Process Fatal Error:", error);
    throw new Error(error.message || "文档处理失败");
  }
};
