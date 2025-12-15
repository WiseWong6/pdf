
import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import * as pdfjsLib from 'pdfjs-dist'; 
import { 
  FileText, 
  Upload, 
  Layout, 
  Menu, 
  Trash2, 
  Maximize2,
  FileType,
  ScrollText,
  ExternalLink,
  ArrowDown,
  ArrowUp,
  Link2,
  RefreshCw,
  Settings,
  Key,
  X,
  Loader2,
  Sparkles,
  CheckCircle2,
  AlertCircle,
  Hourglass,
  Play,
  RotateCw,
  MessageSquare,
  Edit3,
  Square,
  Bot,
  Table as TableIcon,
  ToggleLeft,
  ToggleRight,
  Eye,
  BrainCircuit
} from 'lucide-react';
import MarkdownRenderer from './components/MarkdownRenderer';
import PdfViewer from './components/PdfViewer';
import { DocFile, ProcessingStatus, PageData } from './types';
import { SAMPLE_DOC_CONTENT, DEFAULT_VERIFIER_SYSTEM_PROMPT } from './constants';
import { processDocument, saveApiKey, checkApiKey, parsePageRange, processSinglePage, saveVerifierPrompt, getVerifierPrompt } from './services/ocrService';

const SPLIT_MARKER = '<--- Page Split --->';
const OVERSCROLL_THRESHOLD = 80;
const MAX_CONCURRENT_JOBS = 1; 

type EvalDatasetRow = {
  name: string;
  ocr_text: string;
  pdf_img: string;
};

const EVAL_CSV_HEADER_CN = ['名称', 'ocr结果', '图片'] as const;
const EVAL_CSV_HEADER_TYPES = ['name', 'ocr_text', 'pdf_img'] as const;

const OCR_PROMPT_PRESETS = [
  { label: '标准 Markdown (文档转MD)', value: '<image>\n<|grounding|>Convert the document to markdown.' },
  { label: '无布局流式文本 (Free OCR)', value: '<image>\nFree OCR.' },
  { label: '通用 OCR (保留坐标)', value: '<image>\n<|grounding|>OCR this image.' },
  { label: '图表深度解析 (Parse Figure)', value: '<image>\nParse the figure.' },
  { label: '图片描述 (Describe Image)', value: '<image>\nDescribe this image in detail.' },
  { label: '文本定位 (Locate)', value: '<image>\nLocate <|ref|>文本<|/ref|> in the image.' },
];

const App: React.FC = () => {
  // State
  const [files, setFiles] = useState<DocFile[]>([
    {
      id: 'sample-1',
      name: '示例保单_Sample',
      content: SAMPLE_DOC_CONTENT,
      lastModified: Date.now(),
      encoding: 'utf-8',
      status: 'completed',
      pageRange: 'all',
      pageMap: [1],
      pagesData: {
          0: { 
              rawOCR: SAMPLE_DOC_CONTENT, 
              restored: SAMPLE_DOC_CONTENT, 
              status: 'complete',
              verificationResult: { hasTable: true, reason: 'Sample' }
          }
      },
      viewMode: 'restored'
    }
  ]);
  const [activeFileId, setActiveFileId] = useState<string>('sample-1');
  const [isSidebarOpen, setSidebarOpen] = useState(true);
  const [showSettings, setShowSettings] = useState(false);
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [verifierPromptInput, setVerifierPromptInput] = useState('');

  // Eval dataset (in-memory, export as CSV)
  const [evalDatasetRows, setEvalDatasetRows] = useState<EvalDatasetRow[]>([]);
  
  // Process Control
  const abortControllerRef = useRef<AbortController | null>(null);

  // Page Selector State
  const [showPageSelector, setShowPageSelector] = useState(false);
  const [pendingFileId, setPendingFileId] = useState<string | null>(null);
  const [pageRangeInput, setPageRangeInput] = useState('all');

  // Retry Modal State
  const [showRetryModal, setShowRetryModal] = useState(false);
  const [retryPrompt, setRetryPrompt] = useState(OCR_PROMPT_PRESETS[0].value);

  // Navigation State
  const [editorPage, setEditorPage] = useState(1);
  
  // Single Page Retry State
  const [retryingPageId, setRetryingPageId] = useState<string | null>(null);
  const [retrySuccessId, setRetrySuccessId] = useState<string | null>(null);

  // Highlighting State
  const [selectedText, setSelectedText] = useState<string>('');

  // Layout Controls
  const [showPdf, setShowPdf] = useState(true);
  const [showEditor, setShowEditor] = useState(true);
  const [showPreview, setShowPreview] = useState(true);
  
  // Overscroll State
  const [overscrollDir, setOverscrollDir] = useState<'prev' | 'next' | null>(null);
  const overscrollAccumulator = useRef(0);
  const overscrollTimeout = useRef<number | null>(null);

  // Column Widths
  const [colWidths, setColWidths] = useState({ pdf: 33, editor: 33 });
  const isResizing = useRef<string | null>(null);

  // Refs
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const previewContainerRef = useRef<HTMLDivElement>(null);

  // Derived State
  const activeFile = files.find(f => f.id === activeFileId);
  
  const currentPhysicalPage = useMemo(() => {
    if (!activeFile) return 1;
    if (!activeFile.pageMap || activeFile.pageMap.length === 0) return editorPage;
    return activeFile.pageMap[editorPage - 1] || 1; 
  }, [activeFile, editorPage]);

  // Derived Page Data for Current Page
  const currentPageData = useMemo(() => {
     if (!activeFile || !activeFile.pagesData) return null;
     return activeFile.pagesData[editorPage - 1];
  }, [activeFile, editorPage]);

  const currentVerificationStatus = currentPageData?.verificationResult;

  const escapeCsvValue = (value: string) => `"${value.replace(/"/g, '""')}"`;

  const buildEvalDatasetCsv = (rows: EvalDatasetRow[]) => {
    const lines: string[] = [];
    lines.push(EVAL_CSV_HEADER_CN.map(escapeCsvValue).join(','));
    lines.push(EVAL_CSV_HEADER_TYPES.map(escapeCsvValue).join(','));
    for (const row of rows) {
      lines.push([row.name, row.ocr_text, row.pdf_img].map(escapeCsvValue).join(','));
    }
    return lines.join('\r\n');
  };

  const downloadTextFile = (filename: string, content: string, mimeType: string) => {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

  const syncCurrentPageToEvalDataset = () => {
    if (!activeFile) {
      alert("未选择文件。");
      return;
    }
    if (!currentPageData?.rawOCR) {
      alert("当前页还没有 OCR 结果。");
      return;
    }
    if (!currentPageData.pdfImg) {
      alert("当前页截图尚未生成，请稍后重试。");
      return;
    }

    const baseName = activeFile.name.replace(/\.[^.]+$/, '');
    const rowName = `${baseName}_${currentPhysicalPage}`;

    const newRow: EvalDatasetRow = { name: rowName, ocr_text: currentPageData.rawOCR, pdf_img: currentPageData.pdfImg as string };
    setEvalDatasetRows(prev => {
      const existingIndex = prev.findIndex(r => r.name === rowName);
      if (existingIndex === -1) return [...prev, newRow];
      const next = [...prev];
      next[existingIndex] = newRow;
      return next;
    });
  };

  const exportEvalDatasetCsv = () => {
    const csv = buildEvalDatasetCsv(evalDatasetRows);
    downloadTextFile('eval_dataset.csv', csv, 'text/csv;charset=utf-8');
  };

  const clearEvalDataset = () => {
    if (evalDatasetRows.length === 0) return;
    const ok = window.confirm(`确认清空已收集的 ${evalDatasetRows.length} 条评测数据吗？`);
    if (!ok) return;
    setEvalDatasetRows([]);
  };

  // Check API Key on Mount
  useEffect(() => {
    const key = checkApiKey();
    if (key) setApiKeyInput(key);
    else setShowSettings(true); 
    
    setVerifierPromptInput(getVerifierPrompt());
  }, []);

  const handleSaveSettings = () => {
    saveApiKey(apiKeyInput);
    saveVerifierPrompt(verifierPromptInput);
    setShowSettings(false);
  };

  // Reset page to 1 when active file changes
  useEffect(() => {
    setEditorPage(1);
    setSelectedText('');
    setRetrySuccessId(null);
  }, [activeFileId]);

  // --- RECONSTRUCT CONTENT WHEN VIEW MODE CHANGES ---
  // This helper reconstructs the full content string based on the pagesData and viewMode
  const reconstructContent = (file: DocFile): string => {
      if (!file.pagesData) return file.content;
      
      const mode = file.viewMode || 'restored';
      const numPages = Object.keys(file.pagesData).length;
      const chunks: string[] = [];

      for (let i = 0; i < numPages; i++) {
          const pData = file.pagesData[i];
          if (!pData) {
              chunks.push(""); 
              continue;
          }

          if (pData.status === 'error') {
              chunks.push(`> ⚠️ **Page ${i + 1} Error**: ${pData.errorMessage}`);
              continue;
          }

          // If mode is restored but we only have raw (not yet done), fallback to raw
          if (mode === 'restored') {
              chunks.push(pData.restored || pData.rawOCR || "");
          } else {
              chunks.push(pData.rawOCR || "");
          }
      }
      return chunks.join(`\n\n${SPLIT_MARKER}\n\n`);
  };

  // --- PARALLEL QUEUE PROCESSING SYSTEM ---
  useEffect(() => {
    const activeJobs = files.filter(f => f.status === 'processing').length;
    if (activeJobs >= MAX_CONCURRENT_JOBS) return;

    const nextQueuedFile = files.find(f => f.status === 'queued');
    
    if (nextQueuedFile) {
      console.log(`[Queue] Starting file: ${nextQueuedFile.name}`);
      processFile(nextQueuedFile);
    }
  }, [files]); 

  const processFile = async (file: DocFile) => {
    const controller = new AbortController();
    abortControllerRef.current = controller;

    setFiles(prev => prev.map(f => f.id === file.id ? { ...f, status: 'processing', statusMessage: '启动中...', content: '' } : f));
    
    try {
      if (!file.originalFile) throw new Error("文件源丢失");
      
      let pageMap: number[] = [];
      if (file.originalFile.type === 'application/pdf') {
         const ab = await file.originalFile.arrayBuffer();
         const doc = await pdfjsLib.getDocument(ab).promise;
         pageMap = parsePageRange(file.pageRange || 'all', doc.numPages);
      } else {
         pageMap = [1];
      }

      // Initialize pagesData
      const initialPagesData: Record<number, PageData> = {};
      pageMap.forEach((_, idx) => {
          initialPagesData[idx] = { rawOCR: '', restored: null, status: 'pending' };
      });

      setFiles(prev => prev.map(f => f.id === file.id ? { ...f, pageMap, pagesData: initialPagesData } : f));

      await processDocument(
        file.originalFile, 
        (msg) => {
          setFiles(prev => prev.map(f => f.id === file.id ? { ...f, statusMessage: msg } : f));
        },
        (pageIndex, pageUpdate) => {
          // GRANULAR UPDATE HANDLER
          setFiles(prev => {
              return prev.map(f => {
                  if (f.id !== file.id) return f;
                  
                  // Update page data
                  const newPagesData = { ...f.pagesData };
                  newPagesData[pageIndex] = {
                      ...newPagesData[pageIndex],
                      ...pageUpdate
                  };

                  // Reconstruct full content string for display
                  // Use a temporary file object to call reconstruct
                  const tempFile = { ...f, pagesData: newPagesData };
                  const newContent = reconstructContent(tempFile);

                  return {
                      ...f,
                      pagesData: newPagesData,
                      content: newContent
                  };
              });
          });
        },
        pageMap,
        controller.signal
      );

      setFiles(prev => prev.map(f => 
        f.id === file.id 
          ? { ...f, status: 'completed', statusMessage: '完成' } 
          : f
      ));
    } catch (err: any) {
      console.error(err);
      const isAbort = err.message === "Process aborted by user";
      setFiles(prev => prev.map(f => 
        f.id === file.id 
          ? { ...f, content: isAbort ? f.content : `处理文档时出错: ${err.message}`, status: 'error', statusMessage: isAbort ? '已停止' : '失败' } 
          : f
      ));
    } finally {
      abortControllerRef.current = null;
    }
  };

  const handleStopProcessing = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
  };

  const toggleViewMode = () => {
      if (!activeFile) return;
      const newMode: 'restored' | 'raw' = activeFile.viewMode === 'raw' ? 'restored' : 'raw';
      
      setFiles(prev => prev.map(f => {
          if (f.id !== activeFile.id) return f;
          const updatedFile: DocFile = { ...f, viewMode: newMode };
          updatedFile.content = reconstructContent(updatedFile);
          return updatedFile;
      }));
  };

  // --- SINGLE PAGE RETRY LOGIC (WITH PROMPT SELECTION) ---
  const openRetryModal = useCallback(() => {
    setRetryPrompt(OCR_PROMPT_PRESETS[0].value); 
    setShowRetryModal(true);
  }, []);

  const handleConfirmRetry = async () => {
    setShowRetryModal(false);
    if (!activeFile || !activeFile.originalFile) return;
    
    const physicalPage = currentPhysicalPage;
    const logicalPageIndex = editorPage - 1;
    const retryKey = `${activeFile.id}-${physicalPage}`;
    
    setRetryingPageId(retryKey);
    setRetrySuccessId(null);

    try {
      const newContent = await processSinglePage(
        activeFile.originalFile, 
        physicalPage,
        retryPrompt 
      );
      
      // Update Page Data to manual override state
      setFiles(prev => prev.map(f => {
          if (f.id !== activeFile.id) return f;
          const newPagesData = { ...f.pagesData };
          
          // When manually retrying, we essentially overwrite the 'raw' and invalidate 'restored'
          // Or treat it as the new raw, and maybe user wants to re-restore? 
          // For simplicity in retry: we just set it as raw and update content.
          newPagesData[logicalPageIndex] = {
              rawOCR: newContent,
              restored: null, // Invalidate previous restoration
              status: 'ocr_success',
              verificationResult: undefined
          };
          
          const tempFile = { ...f, pagesData: newPagesData };
          const fullContent = reconstructContent(tempFile);
          
          return { ...f, pagesData: newPagesData, content: fullContent };
      }));
      
      setRetrySuccessId(retryKey);
      setTimeout(() => setRetrySuccessId(null), 3000);

    } catch (e: any) {
      console.error(`[Retry] Failed:`, e);
      alert(`重试第 ${physicalPage} 页失败: ${e.message}`);
    } finally {
      setRetryingPageId(null);
    }
  };


  // --- Unified Selection Listener ---
  const handleSelectionChange = useCallback(() => {
    let text = '';
    const activeEl = document.activeElement;

    if (activeEl && activeEl.tagName === 'TEXTAREA') {
      const ta = activeEl as HTMLTextAreaElement;
      if (ta.selectionStart !== ta.selectionEnd) {
        text = ta.value.substring(ta.selectionStart, ta.selectionEnd);
      }
    } else {
      const selection = window.getSelection();
      if (selection && !selection.isCollapsed) {
        text = selection.toString();
      }
    }

    const trimmed = text.trim();
    if (trimmed.length > 0) {
      setSelectedText(trimmed);
    } else {
      setSelectedText('');
    }
  }, []);

  useEffect(() => {
    document.addEventListener('mouseup', handleSelectionChange);
    document.addEventListener('keyup', handleSelectionChange);
    return () => {
      document.removeEventListener('mouseup', handleSelectionChange);
      document.removeEventListener('keyup', handleSelectionChange);
    };
  }, [handleSelectionChange]);


  // --- Page Splitting Logic ---
  const pageContents = useMemo(() => {
    if (!activeFile || !activeFile.content) return [];
    return activeFile.content.split(SPLIT_MARKER);
  }, [activeFile?.content]);

  const currentTextContent = pageContents[editorPage - 1] || "";

  // Auto-scroll editor/preview
  useEffect(() => {
    if (editorRef.current) editorRef.current.scrollTop = 0;
    if (previewContainerRef.current) previewContainerRef.current.scrollTop = 0;
    setSelectedText(''); 
  }, [editorPage]);

  // --- Content Update Logic (Manual Edit) ---
  const handlePageContentChange = (newText: string) => {
    if (!activeFile) return;

    // Update the 'restored' (or raw depending on mode) in data model
    // This allows user edits to persist even if they switch views later (optional, but good UX)
    // However, switching views reconstructs content. So we need to update the source.
    
    setFiles(prev => prev.map(f => {
        if (f.id !== activeFileId) return f;
        
        const mode = f.viewMode || 'restored';
        const newPagesData = { ...f.pagesData };
        const logicalIndex = editorPage - 1;
        
        // Initialize if missing
        if (!newPagesData[logicalIndex]) {
             newPagesData[logicalIndex] = { rawOCR: '', restored: '', status: 'complete' };
        }

        if (mode === 'restored') {
            newPagesData[logicalIndex] = { ...newPagesData[logicalIndex], restored: newText };
        } else {
            newPagesData[logicalIndex] = { ...newPagesData[logicalIndex], rawOCR: newText };
        }

        const newPages = [...pageContents];
        while (newPages.length < editorPage) {
          newPages.push("");
        }
        newPages[editorPage - 1] = newText;
        const fullNewContent = newPages.join(SPLIT_MARKER);

        return { ...f, pagesData: newPagesData, content: fullNewContent };
    }));
  };

  // --- OVERSCROLL LOGIC ---
  const handleZoneWheel = useCallback((e: React.WheelEvent, target: 'editor' | 'preview') => {
    if (Math.abs(e.deltaY) < Math.abs(e.deltaX)) return;

    const el = target === 'editor' ? editorRef.current : previewContainerRef.current;
    if (!el) return;

    const { scrollTop, scrollHeight, clientHeight } = el;
    const isAtTop = scrollTop <= 0;
    const isAtBottom = Math.abs(scrollHeight - clientHeight - scrollTop) < 2;

    let triggered = false;

    if (isAtTop && e.deltaY < 0 && editorPage > 1) {
      triggered = true;
      overscrollAccumulator.current += Math.abs(e.deltaY);
      setOverscrollDir('prev');
    } else if (isAtBottom && e.deltaY > 0 && editorPage < pageContents.length) {
      triggered = true;
      overscrollAccumulator.current += Math.abs(e.deltaY);
      setOverscrollDir('next');
    } else {
      overscrollAccumulator.current = 0;
      setOverscrollDir(null);
    }

    if (triggered) {
      if (overscrollTimeout.current) clearTimeout(overscrollTimeout.current);
      overscrollTimeout.current = window.setTimeout(() => {
        setOverscrollDir(null);
        overscrollAccumulator.current = 0;
      }, 500);

      if (overscrollAccumulator.current > OVERSCROLL_THRESHOLD) {
        if (isAtTop && e.deltaY < 0) {
          setEditorPage(p => Math.max(1, p - 1));
        } else {
          setEditorPage(p => p + 1);
        }
        overscrollAccumulator.current = 0;
        setOverscrollDir(null);
      }
    }
  }, [editorPage, pageContents.length]);


  // --- Editor Scroll Sync ---
  const handleEditorScroll = () => {
    if (editorRef.current && backdropRef.current) {
      backdropRef.current.scrollTop = editorRef.current.scrollTop;
      backdropRef.current.scrollLeft = editorRef.current.scrollLeft;
    }
  };

  const escapeHtml = (unsafe: string) => {
    return unsafe
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  };

  const editorBackdropHTML = useMemo(() => {
    if (!currentTextContent) return "";
    let safeContent = escapeHtml(currentTextContent);

    if (selectedText && selectedText.length >= 1) {
      try {
        const escapedSelection = escapeHtml(selectedText);
        const escapedRegex = escapedSelection.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(`(${escapedRegex})`, 'gi');
        safeContent = safeContent.replace(regex, '<mark>$1</mark>');
      } catch (e) {
      }
    }
    return safeContent + '\n';
  }, [currentTextContent, selectedText]);


  // --- Resizing Logic ---
  const startResize = (e: React.MouseEvent, resizerId: 'pdf-editor' | 'editor-preview') => {
    e.preventDefault();
    isResizing.current = resizerId;
    document.addEventListener('mousemove', handleResizeMove);
    document.addEventListener('mouseup', stopResize);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };

  const handleResizeMove = useCallback((e: MouseEvent) => {
    if (!isResizing.current) return;
    
    const sidebarWidth = isSidebarOpen ? 256 : 0;
    const availableWidth = window.innerWidth - sidebarWidth;
    const mouseX = e.clientX - sidebarWidth;
    const percentage = (mouseX / availableWidth) * 100;

    if (isResizing.current === 'pdf-editor') {
      const newPdfWidth = Math.min(Math.max(percentage, 10), 80);
      setColWidths(prev => ({ ...prev, pdf: newPdfWidth }));
    } else if (isResizing.current === 'editor-preview') {
      const newTotal = Math.min(Math.max(percentage, colWidths.pdf + 10), 90);
      const newEditorWidth = newTotal - colWidths.pdf;
      setColWidths(prev => ({ ...prev, editor: newEditorWidth }));
    }
  }, [isSidebarOpen, colWidths.pdf]);

  const stopResize = () => {
    isResizing.current = null;
    document.removeEventListener('mousemove', handleResizeMove);
    document.removeEventListener('mouseup', stopResize);
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  };

  // --- Upload Logic ---
  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      const fileList = Array.from(e.target.files) as File[];
      const validFiles = fileList.filter(f => ['pdf', 'png', 'jpg', 'jpeg'].includes(f.name.split('.').pop()?.toLowerCase() || ''));
      
      if (validFiles.length === 0) {
         alert("没有选择有效的文件。");
         return;
      }

      if (validFiles.length === 1 && validFiles[0].type === 'application/pdf') {
         // Single PDF flow
         const file = validFiles[0];
         const fileId = Math.random().toString(36).substr(2, 9);
         const newFile: DocFile = {
            id: fileId,
            name: file.name,
            content: '',
            pdfUrl: URL.createObjectURL(file),
            lastModified: file.lastModified,
            originalFile: file,
            status: 'waiting_config', 
            statusMessage: '等待配置...',
            pageMap: [] // To be filled after config
         };
         setFiles(prev => [...prev, newFile]);
         setActiveFileId(fileId);
         
         // Trigger Modal
         setPendingFileId(fileId);
         setPageRangeInput('all');
         setShowPageSelector(true);
      } else {
         // Batch or Image flow
         const newFiles: DocFile[] = validFiles.map(file => ({
            id: Math.random().toString(36).substr(2, 9),
            name: file.name,
            content: '',
            pdfUrl: (file.type === 'application/pdf' || file.type.startsWith('image/')) ? URL.createObjectURL(file) : undefined,
            lastModified: file.lastModified,
            originalFile: file,
            status: 'queued',
            statusMessage: '等待处理...',
            pageRange: 'all',
            pageMap: [1] // Default for images
         }));
         setFiles(prev => [...prev, ...newFiles]);
         setActiveFileId(newFiles[0].id);
      }
    }
  };

  const confirmPageRange = () => {
    if (!pendingFileId) return;
    setFiles(prev => prev.map(f => f.id === pendingFileId ? { ...f, pageRange: pageRangeInput, status: 'queued' } : f));
    setShowPageSelector(false);
    setPendingFileId(null);
  };

  const deleteFile = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    const fileToDelete = files.find(f => f.id === id);
    if (fileToDelete?.pdfUrl) URL.revokeObjectURL(fileToDelete.pdfUrl);
    const newFiles = files.filter(f => f.id !== id);
    setFiles(newFiles);
    if (activeFileId === id && newFiles.length > 0) setActiveFileId(newFiles[0].id);
    else if (newFiles.length === 0) setActiveFileId('');
  };

  // Full Retry (re-process everything)
  const retryFullOcr = (fileId: string) => {
    setFiles(prev => prev.map(f => f.id === fileId ? { ...f, status: 'queued', statusMessage: '重试中...', content: '' } : f));
  };

  // Helper for Status Icons
  const getStatusIcon = (status: ProcessingStatus) => {
    switch (status) {
      case 'processing': return <Loader2 size={14} className="animate-spin text-indigo-500" />;
      case 'queued': return <Hourglass size={14} className="text-amber-500" />;
      case 'waiting_config': return <Settings size={14} className="text-slate-400" />;
      case 'completed': return <CheckCircle2 size={14} className="text-emerald-500" />;
      case 'error': return <AlertCircle size={14} className="text-red-500" />;
      default: return <FileText size={14} className="text-slate-500" />;
    }
  };

  // Compute effective view mode for current page
  const isRestoredMode = activeFile?.viewMode === 'restored' || !activeFile?.viewMode;
  // If we are in restored mode, but the page doesn't have a table (and thus no restored content specifically for it),
  // we are effectively viewing the Raw OCR, even if the file mode is 'restored'.
  // However, `reconstructContent` handles the fallback. 
  // We just want the UI label to reflect this.
  const hasTableOnCurrentPage = currentVerificationStatus?.hasTable;
  const effectiveModeLabel = (isRestoredMode && hasTableOnCurrentPage) ? '智能还原' : '原始OCR';

  return (
    <div className="flex h-screen w-full bg-slate-50 text-slate-900 font-sans overflow-hidden">
      
      {/* Sidebar - Same as before */}
      <aside 
        className={`${
          isSidebarOpen ? 'w-64 translate-x-0' : 'w-0 -translate-x-full'
        } bg-slate-900 text-slate-300 flex-shrink-0 transition-all duration-300 ease-in-out flex flex-col border-r border-slate-800 select-none`}
      >
        <div className="h-14 flex items-center px-4 border-b border-slate-800 font-bold text-white tracking-wide justify-between">
          <div className="flex items-center">
             <Layout className="mr-2 text-indigo-400" size={20} />
             DocuRender
          </div>
          <button onClick={() => setShowSettings(true)} className="text-slate-500 hover:text-white transition-colors">
            <Settings size={16} />
          </button>
        </div>

        <div className="p-4">
          <label className="flex items-center justify-center w-full px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg cursor-pointer transition-colors shadow-md group">
            <Sparkles size={16} className="mr-2 group-hover:scale-110 transition-transform" />
            <span className="text-sm font-medium">批量 OCR 上传</span>
            <input type="file" multiple accept=".pdf,.png,.jpg,.jpeg" onChange={handleFileUpload} className="hidden" />
          </label>
        </div>

        <div className="flex-1 overflow-y-auto px-2 space-y-1">
          <div className="px-2 py-1 text-xs font-semibold text-slate-500 uppercase tracking-wider flex justify-between">
             <span>文档列表</span>
             <span className="text-slate-600">{files.length} 个文件</span>
          </div>
          {files.map(file => (
            <div
              key={file.id}
              onClick={() => setActiveFileId(file.id)}
              className={`group flex items-center justify-between px-3 py-2 rounded-md cursor-pointer text-sm transition-colors ${
                activeFileId === file.id 
                  ? 'bg-slate-800 text-white shadow-sm border-l-2 border-indigo-500' 
                  : 'hover:bg-slate-800/50'
              }`}
            >
              <div className="flex items-center overflow-hidden w-full">
                <div className="mr-2 flex-shrink-0" title={file.statusMessage || file.status}>
                  {getStatusIcon(file.status)}
                </div>
                <div className="flex flex-col overflow-hidden flex-1 mr-2">
                   <span className="truncate">{file.name}</span>
                   {file.status === 'processing' && <span className="text-[10px] text-slate-400 truncate">{file.statusMessage}</span>}
                </div>
              </div>

              {/* Action Buttons in Sidebar */}
              <div className="flex items-center gap-1">
                {file.status === 'error' && (
                  <button 
                    onClick={(e) => {
                      e.stopPropagation();
                      retryFullOcr(file.id);
                    }}
                    className="p-1 text-red-400 hover:text-red-200 hover:bg-slate-700 rounded transition-colors"
                    title="重试全部"
                  >
                    <RotateCw size={12} />
                  </button>
                )}
                <button 
                  onClick={(e) => deleteFile(e, file.id)}
                  className="opacity-0 group-hover:opacity-100 p-1 hover:text-red-400 transition-opacity"
                  title="删除"
                >
                  <Trash2 size={12} />
                </button>
              </div>
            </div>
          ))}
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 flex flex-col min-w-0 bg-white relative">
        
        {/* Top Bar */}
        <header className="h-14 border-b border-slate-200 bg-white flex items-center justify-between px-4 shadow-sm z-10 flex-shrink-0 select-none">
          <div className="flex items-center min-w-0">
            <button 
              onClick={() => setSidebarOpen(!isSidebarOpen)}
              className="p-2 rounded-md hover:bg-slate-100 text-slate-600 mr-2"
            >
              <Menu size={20} />
            </button>
            <div className="flex flex-col">
              <h1 className="font-semibold text-slate-800 truncate max-w-md mr-4 leading-tight">
                {activeFile ? activeFile.name : '请选择文件'}
              </h1>
              {activeFile && (
                 <span className="text-[10px] uppercase font-bold tracking-wider" style={{
                    color: activeFile.status === 'completed' ? '#10b981' : 
                           activeFile.status === 'processing' ? '#6366f1' : 
                           activeFile.status === 'error' ? '#ef4444' : '#f59e0b'
                 }}>
                    {activeFile.status === 'completed' ? '完成' : activeFile.status === 'processing' ? '处理中' : activeFile.status === 'error' ? '错误' : activeFile.status === 'waiting_config' ? '待配置' : '排队中'} {activeFile.statusMessage ? `- ${activeFile.statusMessage}` : ''}
                 </span>
              )}
            </div>
            <div className="ml-2 flex-shrink-0">
              <div className="bg-slate-100 p-1 rounded-lg flex items-center gap-1">
                <span className="px-2 text-[10px] font-bold text-slate-500">
                  评测集 {evalDatasetRows.length}
                </span>
                <button
                  onClick={syncCurrentPageToEvalDataset}
                  disabled={!activeFile || !currentPageData?.rawOCR || !currentPageData?.pdfImg}
                  className="px-2 py-1 rounded flex items-center gap-1 text-xs font-medium bg-white border border-slate-200 text-slate-600 hover:text-indigo-600 hover:border-indigo-300 disabled:opacity-50 disabled:cursor-not-allowed"
                  title={!currentPageData?.pdfImg ? "等待当前页截图生成" : "同步当前页到评测集"}
                >
                  <ArrowUp size={14} /> 同步
                </button>
                <button
                  onClick={exportEvalDatasetCsv}
                  disabled={evalDatasetRows.length === 0}
                  className="px-2 py-1 rounded flex items-center gap-1 text-xs font-medium bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed"
                  title="导出 eval_dataset.csv（下载后覆盖 eval_data/eval_dataset.csv）"
                >
                  <ArrowDown size={14} /> 导出
                </button>
                <button
                  onClick={clearEvalDataset}
                  disabled={evalDatasetRows.length === 0}
                  className="px-2 py-1 rounded flex items-center gap-1 text-xs font-medium bg-white border border-slate-200 text-slate-600 hover:text-red-600 hover:border-red-300 disabled:opacity-50 disabled:cursor-not-allowed"
                  title="清空已收集评测数据"
                >
                  <Trash2 size={14} /> 清空
                </button>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {activeFile?.status === 'processing' && (
               <button 
                  onClick={handleStopProcessing}
                  className="mr-2 px-3 py-1.5 bg-red-50 text-red-600 hover:bg-red-100 border border-red-200 rounded text-xs font-bold flex items-center gap-1 transition-colors animate-in fade-in"
               >
                  <Square size={10} fill="currentColor" /> 停止处理
               </button>
            )}
            <div className="bg-slate-100 p-1 rounded-lg flex mr-4">
              <button onClick={() => setShowPdf(!showPdf)} className={`p-1.5 rounded flex items-center gap-1 text-xs font-medium ${showPdf ? 'bg-white shadow text-red-600' : 'text-slate-500'}`}><FileType size={16} /> PDF原文</button>
              <div className="w-px bg-slate-300 mx-1 my-1"></div>
              <button onClick={() => setShowEditor(!showEditor)} className={`p-1.5 rounded flex items-center gap-1 text-xs font-medium ${showEditor ? 'bg-white shadow text-indigo-600' : 'text-slate-500'}`}><ScrollText size={16} /> 识别结果</button>
              <button onClick={() => setShowPreview(!showPreview)} className={`p-1.5 rounded flex items-center gap-1 text-xs font-medium ${showPreview ? 'bg-white shadow text-indigo-600' : 'text-slate-500'}`}><Maximize2 size={16} /> 排版预览</button>
            </div>
          </div>
        </header>

        {/* API Key, Retry, PageRange Modals (omitted for brevity, assume same as before) */}
        {showSettings && (
          <div className="absolute inset-0 z-50 bg-slate-900/50 flex items-center justify-center backdrop-blur-sm">
            <div className="bg-white rounded-xl shadow-2xl p-6 w-[500px] border border-slate-200 animate-in fade-in zoom-in duration-200 max-h-[90vh] overflow-y-auto">
              {/* Settings Content... */}
              <div className="flex justify-between items-center mb-4">
                <h3 className="text-lg font-bold text-slate-800 flex items-center gap-2">
                  <Key size={18} className="text-indigo-600" /> 系统设置
                </h3>
                <button onClick={() => setShowSettings(false)} className="text-slate-400 hover:text-slate-600">
                  <X size={18} />
                </button>
              </div>

              <div className="space-y-6">
                <div>
                   <label className="block text-sm font-semibold text-slate-800 mb-2">
                     SiliconFlow API Key
                   </label>
                   <input
                    type="password"
                    className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-indigo-500 outline-none"
                    placeholder="sk-..."
                    value={apiKeyInput}
                    onChange={(e) => setApiKeyInput(e.target.value)}
                  />
                </div>
                <div>
                   <label className="block text-sm font-semibold text-slate-800 mb-2 flex items-center gap-2">
                     <Bot size={16} /> 表格判别器系统提示词 (Qwen VLM System Prompt)
                   </label>
                   <textarea
                    className="w-full h-40 border border-slate-300 rounded-lg px-3 py-2 text-xs font-mono focus:ring-2 focus:ring-indigo-500 outline-none resize-none bg-slate-50"
                    value={verifierPromptInput}
                    onChange={(e) => setVerifierPromptInput(e.target.value)}
                  />
                </div>
              </div>
              <div className="mt-6">
                <button 
                  onClick={handleSaveSettings}
                  className="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-medium py-2 rounded-lg transition-colors"
                >
                  保存设置
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Retry Modal */}
        {showRetryModal && (
          <div className="absolute inset-0 z-50 bg-slate-900/50 flex items-center justify-center backdrop-blur-sm">
            <div className="bg-white rounded-xl shadow-2xl p-6 w-[500px] border border-slate-200 animate-in fade-in zoom-in duration-200 flex flex-col">
              <div className="flex justify-between items-center mb-4 border-b border-slate-100 pb-2">
                <h3 className="text-lg font-bold text-slate-800 flex items-center gap-2">
                  <RotateCw size={18} className="text-indigo-600" /> 重试设置
                </h3>
                <button onClick={() => setShowRetryModal(false)} className="text-slate-400 hover:text-slate-600">
                  <X size={18} />
                </button>
              </div>
              <div className="space-y-4 mb-4">
                <div>
                   <label className="block text-sm font-medium text-slate-700 mb-1 flex items-center gap-1">
                      <MessageSquare size={14} /> 预设指令
                   </label>
                   <select 
                      className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-indigo-500 outline-none bg-slate-50"
                      onChange={(e) => setRetryPrompt(e.target.value)}
                      value={OCR_PROMPT_PRESETS.find(p => p.value === retryPrompt)?.value || ''}
                   >
                      <option value="" disabled>选择一个预设...</option>
                      {OCR_PROMPT_PRESETS.map((preset, idx) => (
                        <option key={idx} value={preset.value}>{preset.label}</option>
                      ))}
                   </select>
                </div>
                <div>
                   <label className="block text-sm font-medium text-slate-700 mb-1 flex items-center gap-1">
                      <Edit3 size={14} /> 详细指令
                   </label>
                   <textarea 
                      className="w-full h-32 border border-slate-300 rounded-lg px-3 py-2 text-sm font-mono focus:ring-2 focus:ring-indigo-500 outline-none resize-none"
                      value={retryPrompt}
                      onChange={(e) => setRetryPrompt(e.target.value)}
                   />
                </div>
              </div>
              <div className="flex gap-2 mt-2">
                 <button onClick={() => setShowRetryModal(false)} className="flex-1 bg-slate-100 hover:bg-slate-200 text-slate-700 font-medium py-2 rounded-lg">取消</button>
                <button onClick={handleConfirmRetry} className="flex-1 bg-indigo-600 hover:bg-indigo-700 text-white font-medium py-2 rounded-lg flex items-center justify-center gap-2"><Play size={16} /> 开始重试</button>
              </div>
            </div>
          </div>
        )}

        {/* Page Range Selector */}
        {showPageSelector && (
          <div className="absolute inset-0 z-50 bg-slate-900/50 flex items-center justify-center backdrop-blur-sm">
             <div className="bg-white rounded-xl shadow-2xl p-6 w-96 border border-slate-200 animate-in fade-in zoom-in duration-200">
              <div className="flex justify-between items-center mb-4">
                <h3 className="text-lg font-bold text-slate-800 flex items-center gap-2">
                  <Settings size={18} className="text-indigo-600" /> 识别设置
                </h3>
              </div>
              <div className="space-y-3 mb-6">
                <label className="flex items-center gap-3 p-3 border rounded-lg cursor-pointer hover:bg-slate-50">
                  <input type="radio" name="pageRange" checked={pageRangeInput === 'all'} onChange={() => setPageRangeInput('all')} className="text-indigo-600 focus:ring-indigo-500" />
                  <span className="text-sm font-medium">全部页面</span>
                </label>
                <label className="flex items-center gap-3 p-3 border rounded-lg cursor-pointer hover:bg-slate-50">
                   <input type="radio" name="pageRange" checked={pageRangeInput !== 'all'} onChange={() => setPageRangeInput('1')} className="text-indigo-600 focus:ring-indigo-500" />
                  <div className="flex-1">
                    <span className="text-sm font-medium block mb-1">指定页码</span>
                    <input type="text" value={pageRangeInput === 'all' ? '' : pageRangeInput} onChange={(e) => setPageRangeInput(e.target.value)} onFocus={() => { if(pageRangeInput === 'all') setPageRangeInput('') }} placeholder="例如: 1, 3-5, 8" className="w-full text-sm border-b border-slate-300 focus:border-indigo-500 outline-none py-1" />
                  </div>
                </label>
              </div>
              <div className="flex gap-2">
                 <button onClick={() => { setFiles(prev => prev.filter(f => f.id !== pendingFileId)); setShowPageSelector(false); }} className="flex-1 bg-slate-100 hover:bg-slate-200 text-slate-700 font-medium py-2 rounded-lg">取消</button>
                <button onClick={confirmPageRange} className="flex-1 bg-indigo-600 hover:bg-indigo-700 text-white font-medium py-2 rounded-lg flex items-center justify-center gap-2"><Play size={16} /> 开始识别</button>
              </div>
            </div>
          </div>
        )}

        {/* Workspace */}
        <div className="flex-1 flex overflow-hidden relative w-full h-full">
          {activeFile ? (
            activeFile.status === 'processing' && !activeFile.content && (!activeFile.pagesData || Object.keys(activeFile.pagesData).length === 0) ? (
               // PROCESSING STATE (Initial - No content yet)
               <div className="w-full h-full flex flex-col items-center justify-center bg-slate-50/50 backdrop-blur-sm z-20">
                  <div className="bg-white p-8 rounded-2xl shadow-xl flex flex-col items-center">
                    <div className="relative mb-4">
                        <div className="w-16 h-16 rounded-full border-4 border-indigo-100 border-t-indigo-600 animate-spin"></div>
                        <Sparkles className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-indigo-600" size={24} />
                    </div>
                    <h3 className="text-xl font-bold text-slate-800 mb-2">正在解析文档</h3>
                    <p className="text-slate-500 font-medium animate-pulse">{activeFile.statusMessage || "初始化中..."}</p>
                    <button onClick={handleStopProcessing} className="mt-6 px-4 py-2 bg-white border border-red-200 text-red-600 hover:bg-red-50 rounded-lg text-sm font-bold flex items-center gap-2 shadow-sm transition-all hover:shadow-md">
                       <Square size={12} fill="currentColor" /> 停止处理
                    </button>
                  </div>
               </div>
            ) : activeFile.status === 'waiting_config' ? (
               <div className="w-full h-full flex flex-col items-center justify-center bg-slate-50/50 backdrop-blur-sm z-20">
                   <div className="bg-white p-8 rounded-2xl shadow-xl flex flex-col items-center">
                      <Settings className="w-16 h-16 text-slate-400 mb-4" />
                      <h3 className="text-xl font-bold text-slate-800 mb-2">等待配置</h3>
                   </div>
               </div>
            ) : activeFile.status === 'queued' ? (
               <div className="w-full h-full flex flex-col items-center justify-center bg-slate-50/50 backdrop-blur-sm z-20">
                  <div className="bg-white p-8 rounded-2xl shadow-xl flex flex-col items-center">
                    <Hourglass className="w-16 h-16 text-amber-500 animate-pulse mb-4" />
                    <h3 className="text-xl font-bold text-slate-800 mb-2">正在排队...</h3>
                  </div>
               </div>
            ) : activeFile.status === 'error' && !activeFile.content ? (
               <div className="flex-1 flex flex-col items-center justify-center text-red-500 select-none">
                 <AlertCircle size={48} className="mb-4" />
                 <p className="text-lg font-bold">处理失败</p>
                 <button onClick={() => retryFullOcr(activeFile.id)} className="mt-6 px-4 py-2 bg-indigo-600 text-white rounded hover:bg-indigo-700 text-sm flex items-center gap-2"><RotateCw size={16} /> 点击重试</button>
               </div>
            ) : (
            <>
              {/* Column 1: PDF Viewer */}
              {showPdf && (
                <div style={{ width: showEditor || showPreview ? `${colWidths.pdf}%` : '100%' }} className="flex flex-col border-r border-slate-200 bg-slate-100 h-full relative">
                  <div className="px-4 py-2 text-xs font-bold text-slate-500 uppercase tracking-wider bg-slate-100 border-b border-slate-200 flex justify-between items-center flex-shrink-0 select-none">
                    <span>PDF 原文 (第 {currentPhysicalPage} 页)</span>
                    {activeFile.pdfUrl && <a href={activeFile.pdfUrl} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-slate-400 hover:text-indigo-600"><span className="text-[10px] font-semibold">新标签页打开</span><ExternalLink size={12} /></a>}
                  </div>
                  <div className="flex-1 relative bg-slate-200 w-full h-full overflow-hidden">
                    {activeFile.pdfUrl && activeFile.name.endsWith('.pdf') ? (
                      <PdfViewer 
                        url={activeFile.pdfUrl} 
                        physicalPage={currentPhysicalPage} 
                        pageMap={activeFile.pageMap}
                        onPageChange={(physicalPage) => {
                           if (activeFile.pageMap) {
                              const logicalIndex = activeFile.pageMap.indexOf(physicalPage);
                              if (logicalIndex !== -1) setEditorPage(logicalIndex + 1);
                           } else {
                              setEditorPage(physicalPage);
                           }
                        }}
                        onRetryPage={openRetryModal}
                        isRetrying={retryingPageId === `${activeFile.id}-${currentPhysicalPage}`}
                        highlightText={selectedText}
                      />
                    ) : activeFile.pdfUrl ? (
                        <div className="w-full h-full flex items-center justify-center overflow-auto p-4"><img src={activeFile.pdfUrl} alt="Source" className="max-w-full shadow-lg" /></div>
                    ) : (
                      <div className="flex flex-col items-center justify-center h-full text-slate-400 p-8 text-center select-none"><FileType size={48} className="mb-4 opacity-50" /><p>无源文件链接</p></div>
                    )}
                  </div>
                </div>
              )}

              {/* Resizer 1 */}
              {showPdf && (showEditor || showPreview) && (
                <div className="w-2 cursor-col-resize hover:bg-indigo-500 bg-transparent z-20 absolute h-full flex items-center justify-center group transition-colors -ml-1 select-none" style={{ left: `${colWidths.pdf}%` }} onMouseDown={(e) => startResize(e, 'pdf-editor')}>
                  <div className="w-1 h-8 bg-slate-300 rounded group-hover:bg-white"></div>
                </div>
              )}

              {/* Column 2: Editor */}
              {showEditor && (
                <div style={{ width: !showPdf && !showPreview ? '100%' : !showPdf && showPreview ? `${colWidths.editor}%` : showPdf && !showPreview ? `calc(100% - ${colWidths.pdf}%)` : `${colWidths.editor}%` }} className="flex flex-col border-r border-slate-200 bg-slate-50 h-full relative group" onWheel={(e) => handleZoneWheel(e, 'editor')}>
                   <div className="px-4 py-2 text-xs font-bold text-indigo-400 uppercase tracking-wider bg-slate-50 border-b border-slate-200 flex-shrink-0 flex justify-between items-center select-none">
                    <div className="flex items-center gap-2">
                       <span>识别结果 (第 {editorPage} 页)</span>
                       {/* LOADING / STATUS INDICATOR FOR CURRENT PAGE */}
                       {currentPageData && currentPageData.status === 'restoring' && (
                           <span className="flex items-center gap-1 text-indigo-600 bg-indigo-50 px-2 py-0.5 rounded animate-pulse">
                               <BrainCircuit size={12} className="animate-pulse" /> <span className="text-[10px] font-bold">智能还原中...</span>
                           </span>
                       )}
                       {currentPageData && currentPageData.status === 'ocr_success' && (
                           <span className="flex items-center gap-1 text-amber-600 bg-amber-50 px-2 py-0.5 rounded">
                               <span className="text-[10px] font-bold">OCR 完成，等待还原...</span>
                           </span>
                       )}
                    </div>
                  </div>
                  
                  <div className="relative flex-1 w-full h-full overflow-hidden">
                    {/* Editor logic same as before... */}
                    <div ref={backdropRef} className="absolute inset-0 p-4 w-full h-full whitespace-pre-wrap break-words overflow-auto pointer-events-none custom-scrollbar z-0" style={{ color: 'transparent', fontFamily: "'Menlo', 'Monaco', 'Courier New', monospace", fontSize: '14px', lineHeight: '1.5' }} dangerouslySetInnerHTML={{ __html: editorBackdropHTML }} />
                    <textarea ref={editorRef} onScroll={handleEditorScroll} className="absolute inset-0 p-4 w-full h-full resize-none outline-none bg-transparent text-slate-800 custom-scrollbar z-10 whitespace-pre-wrap break-words" style={{ fontFamily: "'Menlo', 'Monaco', 'Courier New', monospace", fontSize: '14px', lineHeight: '1.5' }} value={currentTextContent} onChange={(e) => handlePageContentChange(e.target.value)} spellCheck={false} placeholder={activeFile.status === 'completed' ? "本页暂无内容..." : "处理中，内容将自动出现..."} />
                  </div>
                </div>
              )}

              {/* Resizer 2 */}
              {showEditor && showPreview && (
                <div className="w-2 cursor-col-resize hover:bg-indigo-500 bg-transparent z-20 absolute h-full flex items-center justify-center group transition-colors -ml-1 select-none" style={{ left: showPdf ? `${colWidths.pdf + colWidths.editor}%` : `${colWidths.editor}%` }} onMouseDown={(e) => startResize(e, 'editor-preview')}>
                  <div className="w-1 h-8 bg-slate-300 rounded group-hover:bg-white"></div>
                </div>
              )}

              {/* Column 3: Render (Preview) */}
              {showPreview && (
                <div className="flex-1 flex flex-col bg-white h-full min-w-0" onWheel={(e) => handleZoneWheel(e, 'preview')}>
                  <div className="px-4 py-2 text-xs font-bold text-emerald-500 uppercase tracking-wider bg-white border-b border-slate-200 z-10 flex-shrink-0 flex justify-between select-none items-center">
                    <span className="flex items-center gap-2">
                        排版预览 
                        <span className="text-slate-400 font-normal normal-case ml-1">
                            ({effectiveModeLabel})
                        </span>
                    </span>
                    
                    <div className="flex items-center gap-3">
                         {/* Toggle Switch */}
                        <button 
                            onClick={toggleViewMode}
                            className={`flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold border transition-all ${
                                activeFile.viewMode === 'raw' 
                                    ? 'bg-slate-100 text-slate-500 border-slate-300 hover:bg-slate-200' 
                                    : 'bg-indigo-50 text-indigo-600 border-indigo-200 hover:bg-indigo-100'
                            }`}
                            title={activeFile.viewMode === 'raw' ? "切换到智能还原模式" : "切换到原始 OCR 模式"}
                        >
                            {activeFile.viewMode === 'raw' ? <ToggleLeft size={14} /> : <ToggleRight size={14} />}
                            {activeFile.viewMode === 'raw' ? "原始 OCR" : "智能还原"}
                        </button>

                        {/* Status Chip */}
                        {currentVerificationStatus && activeFile.viewMode !== 'raw' && (
                            <div className={`flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-semibold border ${
                                currentVerificationStatus.hasTable 
                                ? 'bg-blue-50 text-blue-600 border-blue-200'
                                : 'bg-emerald-50 text-emerald-600 border-emerald-200'
                            }`}>
                            {currentVerificationStatus.hasTable 
                                ? <><TableIcon size={10} /> 保留表格</> 
                                : <><Bot size={10} /> AI已清洗</>
                            }
                            </div>
                        )}
                    </div>
                  </div>
                  
                  <div className="flex-1 relative overflow-hidden">
                    <div ref={previewContainerRef} className="w-full h-full overflow-y-auto p-8 custom-scrollbar">
                      <div className="max-w-3xl mx-auto">
                        <MarkdownRenderer content={currentTextContent} highlightText={selectedText} />
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </>
            )
          ) : (
             <div className="flex-1 flex flex-col items-center justify-center text-slate-400 select-none">
               <Upload size={48} className="mb-4 text-slate-300" />
               <p className="text-lg">选择或上传 PDF/图片以开始 OCR 识别</p>
               <button onClick={() => setShowSettings(true)} className="mt-4 text-xs text-indigo-500 hover:underline">配置 API Key</button>
             </div>
          )}
        </div>
      </main>
    </div>
  );
};

export default App;
