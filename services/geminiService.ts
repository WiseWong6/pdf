import { GoogleGenAI } from "@google/genai";

const getClient = () => {
  const apiKey = process.env.API_KEY;
  if (!apiKey) {
    throw new Error("API Key is missing.");
  }
  return new GoogleGenAI({ apiKey });
};

export const analyzeDocument = async (
  documentContent: string,
  userQuery: string,
  history: { role: 'user' | 'model'; text: string }[] = []
) => {
  try {
    const ai = getClient();
    
    // Construct the prompt context
    const context = `
      You are an expert Insurance Policy Analyst. 
      You are analyzing the following document content (which may contain Markdown and HTML tables).
      
      DOCUMENT CONTENT START:
      ${documentContent.substring(0, 30000)} 
      DOCUMENT CONTENT END.
      
      Answer the user's question based strictly on the provided document.
      If the document contains tables, pay close attention to the rows and columns to answer accurately.
      Be concise and professional.
    `;

    // We use gemini-2.5-flash for speed and large context window capability
    const modelId = "gemini-2.5-flash";
    
    const chat = ai.chats.create({
      model: modelId,
      config: {
        systemInstruction: context,
      },
      history: history.map(h => ({
        role: h.role,
        parts: [{ text: h.text }]
      }))
    });

    const response = await chat.sendMessage({ message: userQuery });
    return response.text;

  } catch (error) {
    console.error("Gemini API Error:", error);
    return "I'm sorry, I encountered an error while analyzing the document. Please ensure your API Key is valid.";
  }
};
