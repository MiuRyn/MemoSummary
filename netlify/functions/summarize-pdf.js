const { PDFDocument } = require("pdf-lib");
const pdfParse = require("pdf-parse");

async function trimPdfToFirstPages(pdfBuffer, maxPages = 2) {
    const sourcePdf = await PDFDocument.load(pdfBuffer, {
        ignoreEncryption: true
    });

    const outputPdf = await PDFDocument.create();
    const pageCount = Math.min(maxPages, sourcePdf.getPageCount());
    const pageIndexes = Array.from({ length: pageCount }, (_, index) => index);

    const copiedPages = await outputPdf.copyPages(sourcePdf, pageIndexes);

    copiedPages.forEach(page => {
        outputPdf.addPage(page);
    });

    return await outputPdf.save();
}

exports.handler = async function (event) {
    try {
        if (event.httpMethod !== "POST") {
            return json(405, { error: "Method not allowed" });
        }

        if (!process.env.GEMINI_API_KEY) {
            return json(500, { error: "GEMINI_API_KEY environment variable is missing" });
        }

        const { pdfData = "", ref = "", date = "", topic = "" } = JSON.parse(event.body || "{}");
        const parsedPdf = parseDataUrl(pdfData);

        if (!parsedPdf) {
            return json(400, { error: "Valid base64 PDF data is required" });
        }

        const byteLength = Buffer.byteLength(parsedPdf.base64Data, "base64");

        if (byteLength > 15 * 1024 * 1024) {
            return json(400, { error: "PDF exceeds 15MB limit" });
        }

        const pdfBuffer = Buffer.from(parsedPdf.base64Data, "base64");
        const trimmedPdfBytes = await trimPdfToFirstPages(pdfBuffer, 2);
        const trimmedBuffer = Buffer.from(trimmedPdfBytes);
        
        let documentText = "";
        
        try {
            const parsed = await pdfParse(trimmedBuffer);
            documentText = cleanText(parsed.text || "");
        } catch (error) {
            console.warn("PDF text extraction failed:", error.message);
        }
        
        let result;
        
        if (documentText.length > 100) {
            result = await generateGeminiSummaryAndMetadataFromText({
                documentText,
                ref,
                date,
                topic
            });
        } else {
            const trimmedBase64Data = trimmedBuffer.toString("base64");
        
            result = await generateGeminiSummaryAndMetadataFromPdf({
                mimeType: "application/pdf",
                base64Data: trimmedBase64Data,
                ref,
                date,
                topic
            });
        }
        return json(200, result);
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

//extract text first
async function generateGeminiSummaryAndMetadataFromText({ documentText, ref, date, topic }) {
    const response = await fetch(
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
${buildPrompt({ ref, date, topic })}

Document text from first 2 pages:

${documentText.slice(0, 12000)}
                                `.trim()
                            }
                        ]
                    }
                ],
                generationConfig: {
                    temperature: 0,
                    maxOutputTokens: 2000,
                    thinkingConfig: {
                        thinkingBudget: 0
                    }
                }
            })
        }
    );

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
        throw new Error(data.error?.message || "Gemini text summary failed");
    }

    const text = data.candidates?.[0]?.content?.parts
        ?.map(part => part.text || "")
        .join(" ")
        .trim();

    if (!text) {
        throw new Error("Gemini returned an empty text response");
    }

    return parseGeminiJsonResult(text);
}

//extract pdf as fall back
async function generateGeminiSummaryAndMetadataFromPdf({ mimeType, base64Data, ref, date, topic }) {
    const response = await fetch(
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
                                text: buildPrompt({ ref, date, topic })
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
                    temperature: 0,
                    maxOutputTokens: 2000,
                    thinkingConfig: {
                        thinkingBudget: 0
                    }
                }
                }
            })
        }
    );

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
        throw new Error(data.error?.message || "Gemini PDF fallback failed");
    }

    const text = data.candidates?.[0]?.content?.parts
        ?.map(part => part.text || "")
        .join(" ")
        .trim();

    if (!text) {
        throw new Error("Gemini returned an empty response");
    }

    return parseGeminiJsonResult(text);
}

function buildPrompt({ ref, date, topic }) {
    return `
Extract memo metadata from the provided content.

Existing values:
Reference: ${ref || ""}
Date: ${date || ""}
Topic: ${topic || ""}
URL: ${url || ""}

Return ONLY JSON:
{
  "ref": "",
  "date": "",
  "topic": "",
  "summary": ""
}

Rules:
- Use only provided content.
- Fill unknown fields with "".
- date must be YYYY-MM-DD.
- summary must be 3 to 5 short phrases separated by semicolons.
- include conditions if have. 
- Total output under 100 words.
- No markdown.
    `.trim();
}

function parseGeminiJsonResult(text) {
    const clean = cleanText(text)
        .replace(/^```json\s*/i, "")
        .replace(/^```\s*/i, "")
        .replace(/\s*```$/i, "");

    let parsed = null;

    try {
        parsed = JSON.parse(clean);
    } catch {
        const jsonMatch = clean.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            parsed = JSON.parse(jsonMatch[0]);
        }
    }

    if (!parsed || typeof parsed !== "object") {
        return {
            summary: cleanSummary(clean),
            ref: "",
            date: "",
            topic: "",
            metadata: {
                ref: "",
                date: "",
                topic: ""
            }
        };
    }

    const summaryObject = parsed.summary && typeof parsed.summary === "object" ? parsed.summary : null;

    const result = {
        summary: cleanSummary(summaryObject?.summary ?? summaryObject?.text ?? parsed.summary ?? ""),
        ref: cleanText(parsed.ref ?? summaryObject?.ref ?? ""),
        date: normalizeDateForInput(parsed.date ?? summaryObject?.date ?? ""),
        topic: cleanText(parsed.topic ?? summaryObject?.topic ?? "")
    };

    return {
        ...result,
        metadata: {
            ref: result.ref,
            date: result.date,
            topic: result.topic
        }
    };
}

function normalizeDateForInput(value) {
    const cleanValue = cleanText(value);

    if (!cleanValue) return "";

    const isoMatch = cleanValue.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (isoMatch) {
        return `${isoMatch[1]}-${isoMatch[2].padStart(2, "0")}-${isoMatch[3].padStart(2, "0")}`;
    }

    const slashMatch = cleanValue.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (slashMatch) {
        return `${slashMatch[3]}-${slashMatch[2].padStart(2, "0")}-${slashMatch[1].padStart(2, "0")}`;
    }

    const parsed = new Date(cleanValue);
    if (!Number.isNaN(parsed.getTime()) && /\d{4}/.test(cleanValue)) {
        return [
            parsed.getFullYear(),
            String(parsed.getMonth() + 1).padStart(2, "0"),
            String(parsed.getDate()).padStart(2, "0")
        ].join("-");
    }

    return "";
}

function cleanSummary(value) {
    const clean = cleanText(value);

    if (clean.startsWith("{") || clean.includes('"summary"')) {
        return "";
    }

    return clean
        .replace(/\n/g, " ")
        .replace(/\s*;\s*/g, "; ")
        .replace(/\.$/, "")
        .trim();
}

function cleanText(value) {
    if (value === null || value === undefined) return "";
    if (typeof value === "object") {
        if (typeof value.summary === "string") return cleanText(value.summary);
        if (typeof value.text === "string") return cleanText(value.text);
        return "";
    }

    return String(value).replace(/\s+/g, " ").trim();
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
