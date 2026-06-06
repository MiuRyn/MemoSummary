exports.handler = async function (event) {

    console.log("GEMINI:", !!process.env.GEMINI_API_KEY);
    if (!process.env.GEMINI_API_KEY) {
    return json(500, {
        error: "GEMINI_API_KEY environment variable is missing"
        });
    }
    
    try {
        if (event.httpMethod !== "POST") {
            return json(405, { error: "Method not allowed" });
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
// add pdf size cap
if (!pdfResponse.ok) {
    return json(400, {
        error: `Unable to fetch URL. HTTP ${pdfResponse.status}`
    });
}

const contentLength = Number(
    pdfResponse.headers.get("content-length") || 0
);

if (contentLength > 15 * 1024 * 1024) {
    return json(400, {
        error: "PDF exceeds 15MB limit"
    });
}

const contentType =
    pdfResponse.headers.get("content-type") || "application/pdf";

const arrayBuffer = await pdfResponse.arrayBuffer();

if (arrayBuffer.byteLength > 15 * 1024 * 1024) {
    return json(400, {
        error: "PDF exceeds 15MB limit"
    });
}

const base64Data = Buffer.from(arrayBuffer).toString("base64");

        const geminiResponse = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
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
Extract 3 to 5 important key phrases from the document.
Format requirements:
- Separate each phrase with a semicolon (;).
- Do not use sentences.
- Do not truncate phrases.
- If a phrase is long, keep it complete.
`.trim()
                                },
                                {
                                    inlineData: {
                                        mimeType: contentType.includes("pdf") ? "application/pdf" : contentType,
                                        data: base64Data
                                    }
                                }
                            ]
                        }
                    ]
                })
            }
        );

        const geminiData = await geminiResponse.json();

        if (!geminiResponse.ok) {
            return json(500, {
                error: geminiData.error?.message || "Gemini summary failed"
            });
        }

        const summary =
            geminiData.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";

        if (!summary) {
            return json(500, { error: "Gemini returned an empty summary" });
        }

        return json(200, { summary });
    } catch (error) {
        return json(500, {
            error: error.message || "Failed to summarize URL"
        });
    }
};

function json(statusCode, body) {
    return {
        statusCode,
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify(body)
    };
}
