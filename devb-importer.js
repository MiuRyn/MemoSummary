import { cleanText } from "./utils.js";

const DEVB_BASE_URL = "https://www.devb.gov.hk";
const DEVB_DATA_JS_URL = "https://www.devb.gov.hk/filemanager/technicalcirculars/list_technicalcirculars_53.js";
const DEVB_DATA_PROXY_URL = `https://api.allorigins.win/raw?url=${encodeURIComponent(DEVB_DATA_JS_URL)}`;

function absoluteDEVBUrl(path) {
    if (!path) return "";
    return new URL(path, DEVB_BASE_URL).href;
}

function createStableDEVBId(circularNumber, url) {
    const key = `${circularNumber || ""}-${url || ""}`;
    return `devb-${btoa(unescape(encodeURIComponent(key))).replace(/[^a-zA-Z0-9]/g, "").slice(0, 36)}`;
}

function normalizeDEVBDate(issueDate) {
    const raw = cleanText(issueDate || "");
    const match = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);

    if (!match) return raw;

    const day = match[1].padStart(2, "0");
    const month = match[2].padStart(2, "0");
    const year = match[3];

    return `${year}-${month}-${day}`;
}

export function isImportableDEVBRecord(item) {
    return Boolean(
        item &&
        typeof item === "object" &&
        !Array.isArray(item) &&
        cleanText(item.CircularNumber || "") &&
        cleanText(item.Title || "") &&
        Array.isArray(item.Files) &&
        item.Files.some(filePath => cleanText(filePath || ""))
    );
}

export function normalizeDEVBItem(item) {
    const pdfPath = Array.isArray(item.Files) && item.Files.length > 0 ? item.Files[0] : "";
    const circularNumber = cleanText(item.CircularNumber || "");
    const title = cleanText(item.Title || "");
    const issueDate = cleanText(item.IssueDate || "");
    const url = absoluteDEVBUrl(pdfPath);

    return {
        id: createStableDEVBId(circularNumber, url),
        ref: circularNumber ? `TC(W) No. ${circularNumber}` : "",
        date: normalizeDEVBDate(issueDate),
        topic: title,
        url,
        category: "Technical Specifications",
        conditions: "",
        application: "",
        pdfData: "",
        source: "DEVB Works Technical Circulars"
    };
}

function isCircularRecord(value) {
    return isImportableDEVBRecord(value);
}


function getCircularRecordKey(item) {
    const circularNumber = cleanText(item && item.CircularNumber || "");
    const title = cleanText(item && item.Title || "");
    const files = Array.isArray(item && item.Files)
        ? item.Files.map(filePath => cleanText(filePath || "")).join("|")
        : "";
    return `${circularNumber}::${title}::${files}`;
}

function collectCircularRecords(value, output = [], visited = new Set(), depth = 0) {
    if (!value || depth > 8) return output;

    const valueType = typeof value;
    if (valueType !== "object" && valueType !== "function") return output;
    if (visited.has(value)) return output;
    visited.add(value);

    if (isCircularRecord(value)) {
        output.push(value);
        return output;
    }

    if (Array.isArray(value)) {
        for (const entry of value) {
            collectCircularRecords(entry, output, visited, depth + 1);
        }

        return output;
    }

    for (const key of Object.keys(value)) {
        try {
            collectCircularRecords(value[key], output, visited, depth + 1);
        } catch {
            continue;
        }
    }

    return output;
}

function dedupeCircularRecords(records) {
    const seen = new Set();
    const unique = [];

    for (const record of records) {
        const key = getCircularRecordKey(record);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        unique.push(record);
    }

    return unique;
}

async function loadDEVBItemsViaScriptTag() {
    const beforeKeys = new Set(Object.keys(window));

    await new Promise((resolve, reject) => {
        const existingScript = document.querySelector('script[data-devb-importer="true"]');
        if (existingScript) existingScript.remove();

        const script = document.createElement("script");
        script.src = `${DEVB_DATA_JS_URL}?cacheBust=${Date.now()}`;
        script.async = true;
        script.dataset.devbImporter = "true";
        script.onload = resolve;
        script.onerror = () => reject(new Error("Could not load DEVB data script tag."));
        document.head.appendChild(script);
    });

    const allRecords = [];
    const candidateKeys = Object.keys(window).filter(key => !beforeKeys.has(key));

    for (const key of candidateKeys) {
        try {
            collectCircularRecords(window[key], allRecords);
        } catch {
            continue;
        }
    }

    for (const key of Object.keys(window)) {
        if (!/circular|technical|tcw|list|data/i.test(key)) continue;

        try {
            collectCircularRecords(window[key], allRecords);
        } catch {
            continue;
        }
    }

    const uniqueRecords = dedupeCircularRecords(allRecords);

    if (!uniqueRecords.length) {
        throw new Error("DEVB script loaded, but no CircularNumber records were exposed on window.");
    }

    console.info(`DEVB script import found ${uniqueRecords.length} circular records.`);
    return uniqueRecords;
}

async function fetchDEVBDataJsText() {
    const urls = [DEVB_DATA_JS_URL, DEVB_DATA_PROXY_URL];
    let lastError = null;

    for (const url of urls) {
        try {
            const response = await fetch(url, { cache: "no-store" });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const text = await response.text();
            if (text && text.includes("CircularNumber")) return text;
        } catch (error) {
            lastError = error;
        }
    }

    throw lastError || new Error("Unable to fetch DEVB circular data.");
}

function findMatchingSquareBracket(text, openIndex) {
    let depth = 0;
    let inString = false;
    let stringQuote = "";
    let escaped = false;

    for (let i = openIndex; i < text.length; i++) {
        const ch = text[i];

        if (inString) {
            if (escaped) {
                escaped = false;
            } else if (ch === "\\") {
                escaped = true;
            } else if (ch === stringQuote) {
                inString = false;
                stringQuote = "";
            }

            continue;
        }

        if (ch === '"' || ch === "'") {
            inString = true;
            stringQuote = ch;
            continue;
        }

        if (ch === "[") depth++;
        if (ch === "]") depth--;

        if (depth === 0) return i;
    }

    return -1;
}

function parseDEVBDataJsText(jsText) {
    if (!jsText.includes("CircularNumber")) {
        throw new Error("The DEVB JS file was fetched, but no CircularNumber records were found.");
    }

    const assignmentMatches = Array.from(jsText.matchAll(/(?:var|let|const)?\s*([A-Za-z_$][\w$]*)\s*=\s*\[/g));
    const allRecords = [];

    for (const match of assignmentMatches) {
        const firstBracket = jsText.indexOf("[", match.index);
        const lastBracket = findMatchingSquareBracket(jsText, firstBracket);

        if (firstBracket === -1 || lastBracket === -1 || lastBracket <= firstBracket) continue;

        const arrayText = jsText.slice(firstBracket, lastBracket + 1);

        try {
            const parsed = JSON.parse(arrayText);
            collectCircularRecords(parsed, allRecords);
        } catch {
            try {
                const parsed = Function(`"use strict"; return (${arrayText});`)();
                collectCircularRecords(parsed, allRecords);
            } catch {
                continue;
            }
        }
    }

    if (!allRecords.length) {
        const circularRegex = /\{[\s\S]*?"CircularNumber"\s*:\s*"[\s\S]*?\}/g;
        const objectMatches = jsText.match(circularRegex) || [];

        for (const objectText of objectMatches) {
            try {
                const parsed = JSON.parse(objectText);
                if (isImportableDEVBRecord(parsed)) allRecords.push(parsed);
            } catch {
                try {
                    const parsed = Function(`"use strict"; return (${objectText});`)();
                    if (isImportableDEVBRecord(parsed)) allRecords.push(parsed);
                } catch {
                    continue;
                }
            }
        }
    }

    const uniqueRecords = dedupeCircularRecords(allRecords);

    if (!uniqueRecords.length) {
        throw new Error("Could not parse any circular records from list_technicalcirculars_53.js.");
    }

    console.info(`DEVB fetch fallback parsed ${uniqueRecords.length} circular records.`);
    return uniqueRecords;
}

export async function loadDEVBItems() {
    try {
        return await loadDEVBItemsViaScriptTag();
    } catch (scriptError) {
        console.warn("DEVB script-tag import failed. Trying fetch fallback.", scriptError);
        const jsText = await fetchDEVBDataJsText();
        return parseDEVBDataJsText(jsText);
    }
}

export function normalizeMemoRefForDuplicateCheck(value) {
            return cleanText(value || "")
                .toUpperCase()
                .replace(/^TC\s*\(?W\)?\s*NO\.?\s*/i, "")
                .replace(/^TCW\s*NO\.?\s*/i, "")
                .replace(/\s+/g, "")
                .replace(/[.]/g, "");
        }

export function normalizeMemoDateForDuplicateCheck(value) {
            const raw = cleanText(value || "");

            if (!raw) return "";

            const isoMatch = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
            if (isoMatch) {
                return `${isoMatch[1]}-${isoMatch[2].padStart(2, "0")}-${isoMatch[3].padStart(2, "0")}`;
            }

            const slashMatch = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
            if (slashMatch) {
                const day = slashMatch[1].padStart(2, "0");
                const month = slashMatch[2].padStart(2, "0");
                const year = slashMatch[3];

                return `${year}-${month}-${day}`;
            }

            const parsed = new Date(raw);
            if (!Number.isNaN(parsed.getTime())) {
                const year = parsed.getFullYear();
                const month = String(parsed.getMonth() + 1).padStart(2, "0");
                const day = String(parsed.getDate()).padStart(2, "0");

                return `${year}-${month}-${day}`;
            }

            return raw.toUpperCase();
        }

export function getMemoRefDateDuplicateKey(memo) {
        const normalizedRef = normalizeMemoRefForDuplicateCheck(memo && memo.ref);
        const normalizedDate = normalizeMemoDateForDuplicateCheck(memo && memo.date);

        if (!normalizedRef || !normalizedDate) return "";

        return `${normalizedRef}::${normalizedDate}`;
}

