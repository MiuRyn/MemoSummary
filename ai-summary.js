
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
        ref = "",
        date = "",
        topic = ""
    } = memoInput || {};

    if (pdfData && pdfData.startsWith("data:")) {
        return await summarizeUploadedPdfWithNetlifyFunction({
            pdfData,
            ref,
            date,
            topic
        });
    }

    if (url && /^https?:\/\//i.test(url)) {
        return await summarizeExternalUrlWithNetlifyFunction({
            url,
            ref,
            date,
            topic
        });
    }

    throw new Error("Please provide an uploaded PDF or a valid external URL.");
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

    return {
        summary: cleanSummary(data?.summary || metadata.summary || ""),
        ref: cleanText(data?.ref || metadata.ref || ""),
        date: normalizeDateForInput(data?.date || metadata.date || ""),
        topic: cleanText(data?.topic || metadata.topic || "")
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
    return (value || "")
        .replace(/\s+/g, " ")
        .trim();
}
