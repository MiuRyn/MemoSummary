const pdfjsLib = require("pdfjs-dist/legacy/build/pdf");

async function extractPdfTextFromFirstPages(arrayBuffer, maxPages = 2) {
    const loadingTask = pdfjsLib.getDocument({
        data: new Uint8Array(arrayBuffer),
        disableWorker: true
    });

    const pdf = await loadingTask.promise;
    const pagesToRead = Math.min(maxPages, pdf.numPages);
    const pageTexts = [];

    for (let pageNum = 1; pageNum <= pagesToRead; pageNum += 1) {
        const page = await pdf.getPage(pageNum);
        const textContent = await page.getTextContent();

        const text = textContent.items
            .map(item => item.str || "")
            .join(" ")
            .replace(/\s+/g, " ")
            .trim();

        if (text) {
            pageTexts.push(text);
        }
    }

    return pageTexts.join("\n\n").trim();
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
        const documentText = await extractPdfTextFromFirstPages(pdfBuffer.buffer.slice(
            pdfBuffer.byteOffset,
            pdfBuffer.byteOffset + pdfBuffer.byteLength
        ), 2);

        let result;

        if (documentText.trim()) {
            result = await generateGeminiSummaryAndMetadataFromText({
                documentText,
                ref,
                date,
                topic
            });
        } else {
            console.log("No text extracted. Falling back to uploaded PDF.");

            result = await generateGeminiSummaryAndMetadataFromPdf({
                mimeType: parsedPdf.mimeType,
                base64Data: parsedPdf.base64Data,
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

${documentText}
                                `.trim()
                            }
                        ]
                    }
                ],
                generationConfig: {
                    temperature: 0.1,
                    maxOutputTokens: 1400
                }
            })
        }
    );

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
        throw new Error(data.error?.message || "Gemini summary failed");
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
                    temperature: 0.1,
                    maxOutputTokens: 1400
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
Extract memo metadata and keywords from this government memo.
Only use the provided document text or PDF content.

Existing form values:
- Reference: ${ref || ""}
- Date: ${date || ""}
- Topic: ${topic || ""}

Return ONLY valid JSON in this exact shape:
{
  "summary": "",
  "ref": "",
  "date": "",
  "topic": ""
}

Rules:
- summary = 3 to 5 important key phrases separated by semicolons (;).
- ref = official memo, circular, technical circular, or reference number.
- date = exact issue date in YYYY-MM-DD format.
- topic = official memo title or subject.
- If a field is not found, return an empty string for that field.
- Do not invent missing values.
- Do not add markdown, comments, code fences, headings, or extra text.
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
    return cleanText(value)
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
