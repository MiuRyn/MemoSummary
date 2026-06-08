
export function getStoredOpenAIApiKey() {
    return "server-side-netlify-gemini";
}

export function requestOpenAIApiKey() {
    return "server-side-netlify-gemini";
}

export async function generateTwoSentenceMemoSummary({ memoDraft } = {}) {
    const result = await generateMemoSummaryWithGemini(memoDraft || {});
    return typeof result === "string" ? result : (result.summary || "");
}

export async function generateMemoSummaryWithGemini(memoInput) {
    const {
        url = "",
        pdfData = "",
        pdfUrl = "",
        ref = "",
        date = "",
        topic = ""
    } = memoInput || {};

    // 1. Unsaved uploaded PDF from FileReader
    if (pdfData && pdfData.startsWith("data:")) {
        try {
            return await summarizeUploadedPdfWithNetlifyFunction({
                pdfData,
                ref,
                date,
                topic
            });
        } catch (error) {
            console.warn("Uploaded PDF summary failed. Trying PDF URL fallback.", error);
    
            if (pdfUrl && /^https?:\/\//i.test(pdfUrl)) {
                return await summarizeExternalUrlWithNetlifyFunction({
                    url: pdfUrl,
                    ref,
                    date,
                    topic
                });
            }
    
            throw error;
        }
    }

    // 2. Saved Firebase Storage PDF URL
    if (pdfUrl && /^https?:\/\//i.test(pdfUrl)) {
        return await summarizeExternalUrlWithNetlifyFunction({
            url: pdfUrl,
            ref,
            date,
            topic
        });
    }

    // 3. External memo URL
    if (url && /^https?:\/\//i.test(url)) {
        return await summarizeExternalUrlWithNetlifyFunction({
            url,
            ref,
            date,
            topic
        });
    }

    throw new Error("Please provide an uploaded PDF, stored PDF URL, or valid external URL.");
}

async function summarizeExternalUrlWithNetlifyFunction({ url, ref, date, topic }) {
    const response = await fetch("/.netlify/functions/summarize-url", {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            url,
            ref,
            date,
            topic
        })
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
        throw new Error(data.error || "Failed to summarize external URL");
    }

    return normalizeAiSummaryResult(data);
}

async function summarizeUploadedPdfWithNetlifyFunction({ pdfData, ref, date, topic }) {
    const response = await fetch("/.netlify/functions/summarize-pdf", {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            pdfData,
            ref,
            date,
            topic
        })
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
        throw new Error(data.error || "Failed to summarize uploaded PDF");
    }

    return normalizeAiSummaryResult(data);
}

function normalizeAiSummaryResult(data) {
    const metadata = data && typeof data.metadata === "object" && data.metadata ? data.metadata : {};
    const summarySource = data?.summary ?? metadata.summary ?? "";
    const summaryObject = summarySource && typeof summarySource === "object" ? summarySource : null;

    const result = {
        summary: cleanSummary(summaryObject?.summary ?? summaryObject?.text ?? summarySource),
        ref: cleanText(data?.ref ?? metadata.ref ?? summaryObject?.ref ?? ""),
        date: normalizeDateForInput(data?.date ?? metadata.date ?? summaryObject?.date ?? ""),
        topic: cleanText(data?.topic ?? metadata.topic ?? summaryObject?.topic ?? "")
    };

    result.toString = function () {
        return this.summary || "";
    };

    result.valueOf = function () {
        return this.summary || "";
    };

    return result;
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

    return String(value)
        .replace(/\s+/g, " ")
        .trim();
}
