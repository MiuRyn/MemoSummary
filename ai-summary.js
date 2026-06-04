const OPENAI_API_KEY_STORAGE_KEY = "memo_ai_openai_api_key";
const DEFAULT_AI_MODEL = "gpt-4o-mini";
const MAX_SOURCE_TEXT_CHARS = 18000;

export function getStoredOpenAIApiKey() {
    return localStorage.getItem(OPENAI_API_KEY_STORAGE_KEY) || "";
}

export function setStoredOpenAIApiKey(apiKey) {
    const cleaned = (apiKey || "").trim();

    if (cleaned) {
        localStorage.setItem(OPENAI_API_KEY_STORAGE_KEY, cleaned);
    } else {
        localStorage.removeItem(OPENAI_API_KEY_STORAGE_KEY);
    }

    return cleaned;
}

export function requestOpenAIApiKey() {
    const existing = getStoredOpenAIApiKey();
    const entered = window.prompt(
        "Enter your OpenAI API key. It will be saved only in this browser's localStorage, not in Firebase.",
        existing
    );

    if (entered === null) return "";

    return setStoredOpenAIApiKey(entered);
}

function cleanText(value) {
    return (value || "").replace(/\s+/g, " ").trim();
}

function isLikelyPdfUrl(url) {
    return /\.pdf($|[?#])/i.test(url || "");
}

function isLocalOrFileUrl(url) {
    const value = cleanText(url);
    return value.startsWith("file:") || value.startsWith("\\\\");
}

function base64DataUrlToUint8Array(dataUrl) {
    const base64 = String(dataUrl).split(",")[1] || "";
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);

    for (let i = 0; i < binary.length; i += 1) {
        bytes[i] = binary.charCodeAt(i);
    }

    return bytes;
}

async function loadPdfJs() {
    if (window.pdfjsLib) return window.pdfjsLib;

    const pdfjsLib = await import("https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.min.mjs");
    pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.worker.min.mjs";

    return pdfjsLib;
}

async function extractPdfTextFromBytes(bytes) {
    const pdfjsLib = await loadPdfJs();
    const pdf = await pdfjsLib.getDocument({ data: bytes }).promise;
    const pageTexts = [];
    const pageLimit = Math.min(pdf.numPages, 20);

    for (let pageNumber = 1; pageNumber <= pageLimit; pageNumber += 1) {
        const page = await pdf.getPage(pageNumber);
        const content = await page.getTextContent();
        const pageText = content.items
            .map(item => item && item.str ? item.str : "")
            .join(" ");

        pageTexts.push(pageText);

        if (pageTexts.join(" ").length >= MAX_SOURCE_TEXT_CHARS) break;
    }

    return cleanText(pageTexts.join("\n"));
}

async function extractTextFromUrl(url) {
    if (!url) return "";

    if (isLocalOrFileUrl(url)) {
        throw new Error("Browser security blocks reading local/network file paths. Copy the file path into Chrome or upload the PDF instead.");
    }

    const response = await fetch(url, { cache: "no-store" });

    if (!response.ok) {
        throw new Error(`Could not read URL. HTTP ${response.status}`);
    }

    const contentType = response.headers.get("content-type") || "";

    if (contentType.includes("application/pdf") || isLikelyPdfUrl(url)) {
        const bytes = new Uint8Array(await response.arrayBuffer());
        return extractPdfTextFromBytes(bytes);
    }

    const text = await response.text();

    if (contentType.includes("text/html") || /<html[\s>]/i.test(text)) {
        const documentClone = new DOMParser().parseFromString(text, "text/html");
        documentClone.querySelectorAll("script, style, nav, header, footer").forEach(element => element.remove());
        return cleanText(documentClone.body ? documentClone.body.textContent : text).slice(0, MAX_SOURCE_TEXT_CHARS);
    }

    return cleanText(text).slice(0, MAX_SOURCE_TEXT_CHARS);
}

async function extractTextFromPdfData(pdfData) {
    if (!pdfData) return "";
    if (!String(pdfData).startsWith("data:application/pdf")) return "";

    const bytes = base64DataUrlToUint8Array(pdfData);
    return extractPdfTextFromBytes(bytes);
}

export async function extractMemoContentForAi(memoDraft) {
    const parts = [];

    if (memoDraft.ref) parts.push(`Memo reference: ${memoDraft.ref}`);
    if (memoDraft.date) parts.push(`Date: ${memoDraft.date}`);
    if (memoDraft.topic) parts.push(`Topic: ${memoDraft.topic}`);
    if (memoDraft.conditions) parts.push(`Conditions: ${memoDraft.conditions}`);
    if (memoDraft.application) parts.push(`Existing description: ${memoDraft.application}`);

    let documentText = "";

    if (memoDraft.pdfData) {
        documentText = await extractTextFromPdfData(memoDraft.pdfData);
    }

    if (!documentText && memoDraft.url) {
        documentText = await extractTextFromUrl(memoDraft.url);
    }

    if (documentText) {
        parts.push(`Document content: ${documentText.slice(0, MAX_SOURCE_TEXT_CHARS)}`);
    }

    const combined = cleanText(parts.join("\n\n"));

    if (!combined) {
        throw new Error("No memo content found. Add a URL, upload a PDF, or fill in memo fields first.");
    }

    return combined.slice(0, MAX_SOURCE_TEXT_CHARS);
}

function readResponsesApiText(data) {
    if (data.output_text) return cleanText(data.output_text);

    const chunks = [];

    for (const outputItem of data.output || []) {
        for (const contentItem of outputItem.content || []) {
            if (contentItem.text) chunks.push(contentItem.text);
        }
    }

    return cleanText(chunks.join(" "));
}

export async function generateTwoSentenceMemoSummary({ apiKey, memoDraft }) {
    const sourceText = await extractMemoContentForAi(memoDraft);

    const response = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${apiKey}`
        },
        body: JSON.stringify({
            model: DEFAULT_AI_MODEL,
            input: [
                {
                    role: "system",
                    content: "You are an engineering memo analyst. Write clear, factual summaries only from the provided memo content. Do not invent details."
                },
                {
                    role: "user",
                    content: `Create exactly two concise sentences summarising this memo. Sentence 1 should state the purpose/topic. Sentence 2 should state the practical application or key requirement. Avoid bullet points.\n\n${sourceText}`
                }
            ],
            temperature: 0.2,
            max_output_tokens: 180
        })
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`OpenAI request failed: HTTP ${response.status}. ${errorText.slice(0, 240)}`);
    }

    const data = await response.json();
    const summary = readResponsesApiText(data);

    if (!summary) {
        throw new Error("OpenAI returned an empty summary.");
    }

    return summary;
}
