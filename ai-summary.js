const GEMINI_API_KEY_STORAGE_KEY = "memo_directory_gemini_api_key";
const GEMINI_MODEL_STORAGE_KEY = "memo_directory_gemini_model";
const DEFAULT_GEMINI_MODEL = "gemini-3.5-flash";
const GEMINI_GENERATE_CONTENT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models";

export function getGeminiApiKey() {
    return localStorage.getItem(GEMINI_API_KEY_STORAGE_KEY) || "";
}

export function saveGeminiApiKey(apiKey) {
    const cleanKey = (apiKey || "").trim();

    if (cleanKey) {
        localStorage.setItem(GEMINI_API_KEY_STORAGE_KEY, cleanKey);
    }
}

export function getGeminiModel() {
    return localStorage.getItem(GEMINI_MODEL_STORAGE_KEY) || DEFAULT_GEMINI_MODEL;
}

export function saveGeminiModel(model) {
    const cleanModel = (model || "").trim();

    if (cleanModel) {
        localStorage.setItem(GEMINI_MODEL_STORAGE_KEY, cleanModel);
    }
}

export async function generateMemoSummaryWithGemini(memoInput) {
    const apiKey = getOrPromptForGeminiApiKey();
    const model = getGeminiModel();
    const parts = await buildGeminiParts(memoInput);

    const response = await fetch(
        `${GEMINI_GENERATE_CONTENT_BASE_URL}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                contents: [
                    {
                        role: "user",
                        parts
                    }
                ],
                generationConfig: {
                    temperature: 0.2,
                    maxOutputTokens: 180
                }
            })
        }
    );

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
        throw new Error(formatGeminiError(response.status, data));
    }

    const summary = extractGeminiText(data);

    if (!summary) {
        throw new Error("Gemini returned no summary text.");
    }

    return forceTwoSentenceLimit(summary);
}

function getOrPromptForGeminiApiKey() {
    let apiKey = getGeminiApiKey();

    if (!apiKey) {
        apiKey = window.prompt("Enter your Gemini API key. It will be saved only in this browser:");

        if (!apiKey || !apiKey.trim()) {
            throw new Error("Gemini API key is required.");
        }

        saveGeminiApiKey(apiKey);
    }

    return apiKey.trim();
}

async function buildGeminiParts(memoInput) {
    const {
        ref = "",
        date = "",
        topic = "",
        conditions = "",
        application = "",
        url = "",
        pdfData = ""
    } = memoInput || {};

    const prompt = [
        "You are an engineering document assistant.",
        "Generate exactly two concise sentences summarising the memo.",
        "Focus on the memo purpose, main requirement, and practical application.",
        "Do not invent facts that are not supported by the provided content.",
        "",
        `Memo Reference: ${ref}`,
        `Date: ${date}`,
        `Topic / Scope: ${topic}`,
        `Conditions: ${conditions}`,
        `Existing Description: ${application}`,
        `Document URL: ${url}`,
        "",
        "Return only the two-sentence summary."
    ].join("\n");

    const parts = [{ text: prompt }];

    if (pdfData && pdfData.startsWith("data:")) {
        const inlinePdfPart = dataUrlToGeminiInlinePart(pdfData);

        if (inlinePdfPart) {
            parts.push(inlinePdfPart);
            return parts;
        }
    }

    const fetchedContentPart = await tryFetchUrlAsGeminiPart(url);

    if (fetchedContentPart) {
        parts.push(fetchedContentPart);
    }

    return parts;
}

function dataUrlToGeminiInlinePart(dataUrl) {
    const match = dataUrl.match(/^data:([^;,]+);base64,(.+)$/);

    if (!match) return null;

    const mimeType = match[1];
    const base64Data = match[2];

    return {
        inline_data: {
            mime_type: mimeType,
            data: base64Data
        }
    };
}

async function tryFetchUrlAsGeminiPart(url) {
    const cleanUrl = (url || "").trim();

    if (!cleanUrl || /^file:/i.test(cleanUrl) || /^\\\\/.test(cleanUrl)) {
        return null;
    }

    try {
        const response = await fetch(cleanUrl, {
            cache: "no-store"
        });

        if (!response.ok) return null;

        const contentType = response.headers.get("content-type") || "";

        if (/application\/pdf/i.test(contentType) || /\.pdf($|\?)/i.test(cleanUrl)) {
            const buffer = await response.arrayBuffer();
            return {
                inline_data: {
                    mime_type: "application/pdf",
                    data: arrayBufferToBase64(buffer)
                }
            };
        }

        if (/text\/|json|xml|html/i.test(contentType)) {
            const text = await response.text();
            return {
                text: `Fetched document text:\n${htmlToReadableText(text).slice(0, 25000)}`
            };
        }

        return null;
    } catch {
        return null;
    }
}

function htmlToReadableText(text) {
    const raw = text || "";

    if (/<html|<body|<div|<p|<table/i.test(raw)) {
        const doc = new DOMParser().parseFromString(raw, "text/html");

        doc.querySelectorAll("script, style, nav, header, footer").forEach((node) => node.remove());

        return cleanText(doc.body?.textContent || raw);
    }

    return cleanText(raw);
}

function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    const chunkSize = 0x8000;
    let binary = "";

    for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }

    return btoa(binary);
}

function extractGeminiText(data) {
    return (
        data?.candidates?.[0]?.content?.parts
            ?.map((part) => part.text || "")
            .join(" ")
            .trim() || ""
    );
}

function forceTwoSentenceLimit(text) {
    const clean = cleanText(text);
    const sentences = clean.match(/[^.!?]+[.!?]+/g);

    if (!sentences || sentences.length <= 2) {
        return clean;
    }

    return sentences.slice(0, 2).join(" ").trim();
}

function formatGeminiError(status, data) {
    const message =
        data?.error?.message ||
        data?.message ||
        "Unknown Gemini API error.";

    if (status === 400) {
        return `Gemini request failed: bad request. ${message}`;
    }

    if (status === 401 || status === 403) {
        return `Gemini request failed: API key is invalid or not allowed. ${message}`;
    }

    if (status === 429) {
        return `Gemini request failed: quota or rate limit exceeded. ${message}`;
    }

    return `Gemini request failed: HTTP ${status}. ${message}`;
}

function cleanText(value) {
    return (value || "").replace(/\s+/g, " ").trim();
}
