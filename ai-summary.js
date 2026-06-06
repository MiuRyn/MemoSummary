export async function generateMemoSummaryWithGemini(memoInput) {
    const {
        url = "",
        pdfData = "",
        ref = "",
        topic = ""
    } = memoInput || {};

    if (pdfData && pdfData.startsWith("data:")) {
        return await summarizeUploadedPdfWithNetlifyFunction({
            pdfData,
            ref,
            topic
        });
    }

    if (url && /^https?:\/\//i.test(url)) {
        return await summarizeExternalUrlWithNetlifyFunction({
            url,
            ref,
            topic
        });
    }

    throw new Error("Please provide an uploaded PDF or a valid external URL.");
}

async function summarizeExternalUrlWithNetlifyFunction({ url, ref, topic }) {
    const response = await fetch("/.netlify/functions/summarize-url", {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            url,
            ref,
            topic
        })
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
        throw new Error(data.error || "Failed to summarize external URL");
    }

    return cleanSummary(data.summary);
}

async function summarizeUploadedPdfWithNetlifyFunction({ pdfData, ref, topic }) {
    const response = await fetch("/.netlify/functions/summarize-pdf", {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            pdfData,
            ref,
            topic
        })
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
        throw new Error(data.error || "Failed to summarize uploaded PDF");
    }

    return cleanSummary(data.summary);
}

function cleanSummary(value) {
    return (value || "")
        .replace(/\n/g, " ")
        .replace(/\s+/g, " ")
        .replace(/\s*;\s*/g, "; ")
        .replace(/\.$/, "")
        .trim();
}
