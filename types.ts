
export type ProcessingStatus = 'idle' | 'queued' | 'processing' | 'completed' | 'error' | 'waiting_config';

export interface PageData {
  rawOCR: string; // Result from DeepSeek
  restored: string | null; // Result from Qwen (null if not yet done)
  pdfImg?: string; // Base64 DataURL screenshot for the page (used for eval export)
  status: 'pending' | 'ocr_success' | 'restoring' | 'complete' | 'error';
  verificationResult?: { 
    hasTable: boolean; 
    reason?: string;
    modelReasoning?: string; // The "Chain of Thought" from the model
  };
  errorMessage?: string;
}

export interface DocFile {
  id: string;
  name: string;
  // 'content' is now a derived view based on pagesData and viewMode. 
  // It is kept for compatibility with existing components that expect a full string.
  content: string; 
  pdfUrl?: string; 
  lastModified: number;
  originalFile?: File; 
  encoding?: 'utf-8' | 'gb18030'; 
  status: ProcessingStatus; 
  statusMessage?: string; 
  pageRange?: string; 
  pageMap?: number[]; 
  
  // New State Fields
  pagesData?: Record<number, PageData>; // Key: Logical Page Index (0-based)
  viewMode?: 'restored' | 'raw'; // Controls which version is rendered in 'content'
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'model';
  text: string;
  isThinking?: boolean;
}

export interface AppState {
  files: DocFile[];
  activeFileId: string | null;
  isSidebarOpen: boolean;
  isAiOpen: boolean;
}
