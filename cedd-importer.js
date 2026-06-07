const CEDD_BASE_URL = "https://www.cedd.gov.hk";
const CEDD_TECHNICAL_CIRCULARS_URL =
    "https://www.cedd.gov.hk/eng/publications/technical-circulars/index.html";

export async function loadCEDDMemos(existingMemos = []) {
    const html = await fetchCEDDTechnicalCircularsHtml();
    const importedMemos = parseCEDDTechnicalCircularsHtml(html);

    return mergeCEDDMemos(importedMemos, existingMemos);
}

async function fetchCEDDTechnicalCircularsHtml() {
    const response = await fetch("/.netlify/functions/fetch-cedd", {
        cache: "no-store"
    });

    if (!response.ok) {
        throw new Error(`Failed to fetch CEDD page. HTTP ${response.status}`);
    }

    return await response.text();
}

function parseCEDDTechnicalCircularsHtml(html) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const rows = Array.from(doc.querySelectorAll("table tbody tr, table tr"));
    const memos = [];

    for (const row of rows) {
        const cells = Array.from(row.querySelectorAll("td"));
        if (cells.length < 2) continue;

        const circularNo = cleanText(cells[0].textContent);
        const link = cells[1].querySelector("a[href]");
        if (!isCEDDCircularNumber(circularNo) || !link) continue;

        const title = cleanText(
            Array.from(link.childNodes)
                .filter(node => node.nodeType === Node.TEXT_NODE)
                .map(node => node.textContent)
                .join(" ")
        ) || cleanText(link.textContent);

        const href = link.getAttribute("href") || "";
        const url = absoluteCEDDUrl(href);

        if (!title || !url || !/\.pdf($|\?)/i.test(url)) continue;

        memos.push({
            id: createStableCEDDId(circularNo, url),
            ref: `CEDD TC No. ${circularNo}`,
            date: "",
            topic: title,
            url,
            category: "Technical Specifications",
            conditions: "",
            application: "",
            pdfData: "",
            source: "CEDD Technical Circulars"
        });
    }

    return dedupeMemosByUrlRefId(memos);
}

export function mergeCEDDMemos(importedMemos, existingMemos) {
    const existingByUrl = new Map();
    const existingByRef = new Map();
    const existingByTitle = new Map();

    for (const memo of existingMemos) {
        if (getUrlMemoKey(memo)) {
            existingByUrl.set(getUrlMemoKey(memo), memo);
        }

        if (normalizeCEDDRef(memo.ref)) {
            existingByRef.set(normalizeCEDDRef(memo.ref), memo);
        }

        if (normalizeTitle(memo.topic)) {
            existingByTitle.set(normalizeTitle(memo.topic), memo);
        }
    }

    const merged = [...existingMemos];
    const changedMemos = [];

    for (const importedMemo of importedMemos) {
        const match =
            existingByUrl.get(getUrlMemoKey(importedMemo)) ||
            existingByRef.get(normalizeCEDDRef(importedMemo.ref)) ||
            existingByTitle.get(normalizeTitle(importedMemo.topic));

          if (match) {
              const index = merged.findIndex(memo => memo.id === match.id);
          
              const updatedMemo = {
                  ...match,
                  ...importedMemo,
                  id: match.id,
                  pdfData: match.pdfData || "",
                  application: match.application || importedMemo.application || "",
                  conditions: match.conditions || importedMemo.conditions || "",
                  category: match.category || importedMemo.category || "Technical Specifications"
              };
          
              if (index >= 0) {
                  merged[index] = updatedMemo;
              }
          
              changedMemos.push(updatedMemo);
          
              existingByUrl.set(
                  getUrlMemoKey(updatedMemo),
                  updatedMemo
              );
          
              existingByRef.set(
                  normalizeCEDDRef(updatedMemo.ref),
                  updatedMemo
              );
          
              existingByTitle.set(
                  normalizeTitle(updatedMemo.topic),
                  updatedMemo
              );
          
              continue;
          }

          merged.push(importedMemo);
          changedMemos.push(importedMemo);
          
          existingByUrl.set(
              getUrlMemoKey(importedMemo),
              importedMemo
          );
          
          existingByRef.set(
              normalizeCEDDRef(importedMemo.ref),
              importedMemo
          );
          
          existingByTitle.set(
              normalizeTitle(importedMemo.topic),
              importedMemo
          );
    }

    return {
        mergedMemos: dedupeMemosByUrlRefId(merged),
        changedMemos
    };
}

function normalizeCEDDRef(value) {
    return cleanText(value || "")
        .toUpperCase()
        .replace(/^CEDD\s*TC\s*NO\.?\s*/i, "")
        .replace(/^CEDD\s*TC\s*/i, "")
        .replace(/^TC\s*NO\.?\s*/i, "")
        .replace(/\s+/g, "")
        .replace(/[.]/g, "");
}

function normalizeTitle(value) {
    return cleanText(value || "")
        .toUpperCase()
        .replace(/\s+/g, " ")
        .replace(/[^\w\s/()-]/g, "")
        .trim();
}
function isCEDDCircularNumber(value) {
    return /^\d{1,2}\/\d{4}$/.test(cleanText(value));
}

function absoluteCEDDUrl(path) {
    if (!path) return "";
    return new URL(path, CEDD_BASE_URL).href;
}

function normalizeCEDDCircularDate(circularNo) {
    const match = cleanText(circularNo).match(/^(\d{1,2})\/(\d{4})$/);
    if (!match) return "";

    const month = match[1].padStart(2, "0");
    const year = match[2];

    return `${year}-${month}-01`;
}

function createStableCEDDId(circularNo, url) {
    const key = `${circularNo || ""}-${url || ""}`;

    return `cedd-${btoa(unescape(encodeURIComponent(key)))
        .replace(/[^a-zA-Z0-9]/g, "")
        .slice(0, 36)}`;
}

function getUrlMemoKey(memo) {
    return cleanText((memo && memo.url) || (memo && memo.ref) || (memo && memo.id) || "");
}

function dedupeMemosByUrlRefId(records) {
    const map = new Map();

    records.forEach((record) => {
        const key = getUrlMemoKey(record);
        if (!key) return;

        const existing = map.get(key);

        map.set(key, {
            ...(existing || {}),
            ...record,
            id: (existing && existing.id) || record.id
        });
    });

    return Array.from(map.values());
}

function cleanText(value) {
    return (value || "").replace(/\s+/g, " ").trim();
}
