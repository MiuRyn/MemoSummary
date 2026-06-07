const pdfjsLib = require("pdfjs-dist/legacy/build/pdf");

export async function extractPdfTextFromFirstPages(arrayBuffer, maxPages = 2) {
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

        const { url, ref = "", date = "", topic = "" } = JSON.parse(event.body || "{}");

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

        const documentText = await extractPdfTextFromFirstPages(arrayBuffer, 2);

        let result;

        if (documentText.trim()) {
            result = await generateGeminiSummaryAndMetadata({
                documentText,
                ref,
                date,
                topic,
                url
            });
        } else {
            console.log("No text extracted. Falling back to PDF upload.");

            const base64Data = Buffer.from(arrayBuffer).toString("base64");

            result = await generateGeminiSummaryAndMetadataFromPdf({
                mimeType: contentType.includes("pdf") ? "application/pdf" : contentType,
                base64Data,
                ref,
                date,
                topic,
                url
            });
        }

        return json(200, result);
    } catch (error) {
        return json(500, {
            error: error.message || "Failed to summarize URL"
        });
    }
};

async function generateGeminiSummaryAndMetadata({ documentText, ref, date, topic, url }) {
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
${buildPrompt({ ref, date, topic, url })}

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

async function generateGeminiSummaryAndMetadataFromPdf({
    mimeType,
    base64Data,
    ref,
    date,
    topic,
    url
}) {
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
                                text: buildPrompt({ ref, date, topic, url })
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

function buildPrompt({ ref, date, topic, url }) {
    return `
Extract memo metadata and keywords from this government memo.
Only use the provided document text or PDF content.

Existing form values:
- Reference: ${ref || ""}
- Date: ${date || ""}
- Topic: ${topic || ""}
- Source URL: ${url || ""}

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

    const summaryObject = parsed.summary && typeof parsed.summary === "object"
        ? parsed.summary
        : null;

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
