exports.handler = async function (event) {
    try {
        if (event.httpMethod !== "POST") {
            return json(405, { error: "Method not allowed" });
        }

        if (!process.env.GEMINI_API_KEY) {
            return json(500, { error: "GEMINI_API_KEY environment variable is missing" });
        }

        const { url, ref = "", topic = "" } = JSON.parse(event.body || "{}");

        if (!url || !/^https?:\/\//i.test(url)) {
            return json(400, { error: "Valid URL is required" });
        }

        const pdfResponse = await fetch(url, {
            headers: {
                "User-Agent": "Mozilla/5.0 MemoSummaryBot/1.0"
            }
        });

        if (!pdfResponse.ok) {
            return json(400, { error: `Unable to fetch URL. HTTP ${pdfResponse.status}` });
        }

        const contentLength = Number(pdfResponse.headers.get("content-length") || 0);

        if (contentLength && contentLength > 15 * 1024 * 1024) {
            return json(400, { error: "PDF exceeds 15MB limit" });
        }

        const contentType = pdfResponse.headers.get("content-type") || "application/pdf";
        const arrayBuffer = await pdfResponse.arrayBuffer();

        if (arrayBuffer.byteLength > 15 * 1024 * 1024) {
            return json(400, { error: "PDF exceeds 15MB limit" });
        }

        const base64Data = Buffer.from(arrayBuffer).toString("base64");

        const summary = await generateGeminiSummary({
            mimeType: contentType.includes("pdf") ? "application/pdf" : contentType,
            base64Data,
            ref,
            topic,
            url
        });

        return json(200, { summary });
    } catch (error) {
        return json(500, {
            error: error.message || "Failed to summarize URL"
        });
    }
};

async function generateGeminiSummary({ mimeType, base64Data, ref, topic, url }) {
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
Source URL: ${url}

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
