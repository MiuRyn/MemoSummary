exports.handler = async function (event) {
    try {
        if (event.httpMethod !== "POST") {
            return json(405, { error: "Method not allowed" });
        }

        if (!process.env.GEMINI_API_KEY) {
            return json(500, { error: "GEMINI_API_KEY environment variable is missing" });
        }

        const { pdfData = "", ref = "", topic = "" } = JSON.parse(event.body || "{}");

        const parsedPdf = parseDataUrl(pdfData);

        if (!parsedPdf) {
            return json(400, { error: "Valid base64 PDF data is required" });
        }

        const byteLength = Buffer.byteLength(parsedPdf.base64Data, "base64");

        if (byteLength > 15 * 1024 * 1024) {
            return json(400, { error: "PDF exceeds 15MB limit" });
        }

        const summary = await generateGeminiSummary({
            mimeType: parsedPdf.mimeType,
            base64Data: parsedPdf.base64Data,
            ref,
            topic
        });

        return json(200, { summary });
    } catch (error) {
        return json(500, {
            error: error.message || "Failed to summarize uploaded PDF"
        });
    }
};

function parseDataUrl(dataUrl) {
    const match = String(dataUrl || "").match(/^data:([^;,]+);base64,(.+)$/);

    if (!match) return null;

    return {
        mimeType: match[1] || "application/pdf",
        base64Data: match[2] || ""
    };
}

async function generateGeminiSummary({ mimeType, base64Data, ref, topic }) {
    const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                contents: [
                    {
                        parts: [
                            {
                                text: `
Extract 3 to 5 important key phrases from this government memo.

Reference: ${ref}
Topic: ${topic}

Format requirements:
- Separate each phrase with a semicolon (;).
- Do not use sentences.
- Do not truncate phrases.
- If a phrase is long, keep it complete.
                                `.trim()
                            },
                            {
                                inlineData: {
                                    mimeType,
                                    data: base64Data
                                }
                            }
                        ]
                    }
                ],
                generationConfig: {
                    temperature: 0.1,
                    maxOutputTokens: 1000
                }
            })
        }
    );

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
        throw new Error(data.error?.message || "Gemini summary failed");
    }

    const summary = data.candidates?.[0]?.content?.parts?.map(part => part.text || "").join(" ").trim();

    if (!summary) {
        throw new Error("Gemini returned an empty summary");
    }

    return cleanText(summary).replace(/\n/g, " ").replace(/\s*;\s*/g, "; ").replace(/\.$/, "");
}

function cleanText(value) {
    return (value || "").replace(/\s+/g, " ").trim();
}

function json(statusCode, body) {
    return {
        statusCode,
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify(body)
    };
}
