# Project Understanding & Development Plan

## 1. Understanding the Core Problem
The user has a collection of documents (insurance policies) generated via OCR. The format is a hybrid:
- **Markdown:** Used for headers, lists, and general text paragraphs.
- **HTML:** Used specifically for complex tables (likely because the OCR tool found Markdown tables insufficient for the data structure).
- **Markers:** Special separators like `<--- Page Split --->`.

**Pain Point:** Standard Markdown viewers often escape HTML tags for security, rendering the tables as raw code. Standard HTML viewers don't render Markdown syntax (like `## Header`) correctly. The user needs a unified renderer.

## 2. Solution Architecture
We will build a React Application "DocuRender" with the following features:
- **Batch Processing:** A sidebar to manage multiple uploaded files.
- **Hybrid Rendering Engine:** A specialized viewing component that parses Markdown but allows specific HTML tags (specifically `<table>`) to pass through and be styled.
- **Split View:** A classical "Editor vs. Preview" layout to allow manual correction of OCR errors.
- **AI Integration:** Since we are parsing policy documents, we will use the **Gemini Agent** to act as a "Policy Analyst".

## 3. Development Plan

### Phase 1: The Rendering Core (The "Hybrid" Agent)
We need a library stack that handles the "Markdown + Raw HTML" requirement.
- **Library:** `react-markdown` combined with `rehype-raw`.
- **Why:** `rehype-raw` allows the parser to detect HTML nodes inside the Markdown stream and render them as actual DOM nodes instead of text.
- **Styling:** We will use Tailwind's `typography` plugin (simulated via utility classes) to ensure both the Markdown text and the HTML tables look cohesive (same fonts, border styles).

### Phase 2: State Management & Batching
- **Structure:** A central Store (Context or simple State) to hold an array of loaded files.
- **Action:** `FileReader` API to read local `.md` or `.txt` files.

### Phase 3: Gemini AI Agent (Efficiency Booster)
The user asked: *"Using what agent to improve efficiency?"*
**Answer:** We will implement a **"Document Q&A Agent"**.
- **Role:** Instead of just reading the document, the user can ask: "What is the max age for coverage?"
- **Mechanism:** We send the currently active document content as context to the Gemini 2.5 Flash model (efficient for large text contexts) and allow the user to query it. This turns a static viewer into an analytical tool.

## 4. Tech Stack
- **React 18 + TypeScript**: For robustness.
- **Tailwind CSS**: For rapid, professional styling (Insurance/FinTech aesthetic).
- **Gemini API**: For the "Policy Analyst" feature.
- **Lucide React**: For UI icons.
