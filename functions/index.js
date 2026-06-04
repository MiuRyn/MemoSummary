const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");

const GEMINI_API_KEY = defineSecret("GEMINI_API_KEY");
const GEMINI_MODEL = "gemini-2.5-flash";
const GEMINI_GENERATE_CONTENT_URL =
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

exports.extractMemoKeywordsFromUrl = onCall(
    {
        secrets: [GEMINI_API_KEY],
        timeoutSeconds: 120,
        memory: "512MiB",
        cors: true
    },
    async (request) => {
        const url = cleanText(request.data?.url || "");
        const ref = cleanText(request.data?.ref || "");
        const date = cleanText(request.data?.date || "");
        const topic = cleanText(request.data?.topic || "");
        const conditions = cleanText(request.data?.conditions || "");

        validatePublicPdfUrl(url);

        const pdfResponse = await fetch(url, {
            redirect: "follow",
            headers: {
                "User-Agent": "Mozilla/5.0 memo-directory-ai-extractor"
            }
        });

        if (!pdfResponse.ok) {
            throw new HttpsError(
                "failed-precondition",
                `Could not fetch PDF from URL. HTTP ${pdfResponse.status}`
            );
        }

        const contentType = pdfResponse.headers.get("content-type") || "";
        const contentLength = Number(pdfResponse.headers.get("content-length") || 0);

        if (contentLength && contentLength > 20 * 1024 * 1024) {
            throw new HttpsError("resource-exhausted", "PDF is larger than the 20MB limit.");
        }

        if (!/pdf/i.test(contentType) && !/\.pdf($|\?)/i.test(url)) {
            throw new HttpsError("failed-precondition", "The URL does not appear to point to a PDF file.");
        }

        const arrayBuffer = await pdfResponse.arrayBuffer();

        if (arrayBuffer.byteLength > 20 * 1024 * 1024) {
            throw new HttpsError("resource-exhausted", "PDF is larger than the 20MB limit.");
        }

        const base64Pdf = Buffer.from(arrayBuffer).toString("base64");

        const prompt = `
You are extracting concise searchable key phrases from a government technical circular.

Read the attached PDF and output ONLY the most important 2 to 4 key phrases.

Rules:
1. Do not write sentences.
2. Do not explain.
3. Separate each item with a semicolon and one space.
4. Prefer the main subject, threshold amounts, effective dates, contract types, or mandatory requirements.
5. Use exact wording from the document where possible.
6. Avoid generic phrases such as "regulatory standards", "administrative memorandum", or "compliance requirements" unless they are the specific subject of the PDF.
7. Output format example:
Artificial Intelligence (AI) Technology; $15 million; $30 million

Metadata for context only:
Memo reference: ${ref}
Memo date: ${date}
Memo topic: ${topic}
Memo conditions: ${conditions}

Output only the key phrases.
`;

        const geminiResponse = await fetch(
            `${GEMINI_GENERATE_CONTENT_URL}?key=${encodeURIComponent(GEMINI_API_KEY.value())}`,
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    contents: [
                        {
                            role: "user",
                            parts: [
                                { text: prompt },
                                {
                                    inline_data: {
                                        mime_type: "application/pdf",
                                        data: base64Pdf
                                    }
                                }
                            ]
                        }
                    ],
                    generationConfig: {
                        temperature: 0.1,
                        maxOutputTokens: 80
                    }
                })
            }
        );

        const geminiData = await geminiResponse.json().catch(() => ({}));

        if (!geminiResponse.ok) {
            throw new HttpsError(
                "internal",
                geminiData?.error?.message || `Gemini request failed with HTTP ${geminiResponse.status}.`
            );
        }

        const result = extractGeminiText(geminiData)
            .replace(/\n+/g, " ")
            .replace(/\s*;\s*/g, "; ")
            .replace(/^[\\"'`]+|[\\"'`.]+$/g, "")
            .trim();

        if (!result) {
            throw new HttpsError("internal", "Gemini returned no key phrases.");
        }

        return { result };
    }
);

function validatePublicPdfUrl(url) {
    if (!url || !/^https?:\/\//i.test(url)) {
        throw new HttpsError("invalid-argument", "A valid http/https PDF URL is required.");
    }

    let parsed;

    try {
        parsed = new URL(url);
    } catch {
        throw new HttpsError("invalid-argument", "The PDF URL is invalid.");
    }

    if (!["http:", "https:"].includes(parsed.protocol)) {
        throw new HttpsError("invalid-argument", "Only http/https URLs are supported.");
    }

    const hostname = parsed.hostname.toLowerCase();

    if (
        hostname === "localhost" ||
        hostname === "0.0.0.0" ||
        hostname === "127.0.0.1" ||
        hostname.startsWith("127.") ||
        hostname.startsWith("10.") ||
        hostname.startsWith("192.168.") ||
        /^172\.(1[6-9]|2\d|3[0-1])\./.test(hostname) ||
        hostname.endsWith(".local")
    ) {
        throw new HttpsError("invalid-argument", "Private or local network URLs are not allowed.");
    }
}

function extractGeminiText(data) {
    return (
        data?.candidates?.[0]?.content?.parts
            ?.map((part) => part.text || "")
            .join(" ")
            .trim() || ""
    );
}

function cleanText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
}
