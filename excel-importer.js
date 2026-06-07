import { showToast, cleanText, formatMemoDate } from "./utils.js";
import { dedupeMemosByUrlRefId } from "./firestore-storage.js";

function getExcelCellString(value) {
            if (value === null || value === undefined) return "";
            if (value instanceof Date && !Number.isNaN(value.getTime())) {
                const year = value.getFullYear();
                const month = String(value.getMonth() + 1).padStart(2, "0");
                const day = String(value.getDate()).padStart(2, "0");
                return `${year}-${month}-${day}`;
            }
            return cleanText(String(value));
  }

        function normalizeExcelHeader(value) {
            return getExcelCellString(value)
                .toLowerCase()
                .replace(/[^a-z0-9]/g, "");
        }

        function findExcelColumnIndex(headers, aliases) {
            const normalizedAliases = aliases.map(normalizeExcelHeader);
            return headers.findIndex(header => normalizedAliases.includes(normalizeExcelHeader(header)));
        }

        function excelSerialDateToISODate(serial) {
            const serialNumber = Number(serial);

            if (!Number.isFinite(serialNumber) || serialNumber <= 0) return "";

            const utcDays = Math.floor(serialNumber - 25569);
            const utcValue = utcDays * 86400;
            const date = new Date(utcValue * 1000);

            if (Number.isNaN(date.getTime())) return "";

            const year = date.getUTCFullYear();
            const month = String(date.getUTCMonth() + 1).padStart(2, "0");
            const day = String(date.getUTCDate()).padStart(2, "0");

            return `${year}-${month}-${day}`;
        }

        function normalizeExcelMemoDate(value) {
            if (value === null || value === undefined || value === "") return "";

            if (value instanceof Date && !Number.isNaN(value.getTime())) {
                const year = value.getFullYear();
                const month = String(value.getMonth() + 1).padStart(2, "0");
                const day = String(value.getDate()).padStart(2, "0");
                return `${year}-${month}-${day}`;
            }

            if (typeof value === "number") {
                return excelSerialDateToISODate(value);
            }

            const raw = cleanText(String(value));
            if (!raw) return "";

            if (/^\d+(\.\d+)?$/.test(raw)) {
                const serialDate = excelSerialDateToISODate(raw);
                if (serialDate) return serialDate;
            }

            const isoMatch = raw.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
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
            if (!Number.isNaN(parsed.getTime()) && /\d{4}/.test(raw)) {
                const year = parsed.getFullYear();
                const month = String(parsed.getMonth() + 1).padStart(2, "0");
                const day = String(parsed.getDate()).padStart(2, "0");
                return `${year}-${month}-${day}`;
            }

            return raw;
        }

        function createStableExcelMemoId(ref, topic, date, url) {
            const key = `${ref || ""}|${topic || ""}|${date || ""}|${url || ""}`;
            return `excel-${btoa(unescape(encodeURIComponent(key))).replace(/[^a-zA-Z0-9]/g, "").slice(0, 40) || Date.now()}`;
        }

        function parseExcelMemoWorksheet(workbook) {
            const firstSheetName = workbook.SheetNames[0];

            if (!firstSheetName) {
                throw new Error("The Excel file does not contain any worksheets.");
            }

            const worksheet = workbook.Sheets[firstSheetName];
            const rows = XLSX.utils.sheet_to_json(worksheet, {
                header: 1,
                defval: "",
                raw: true,
                blankrows: false
            });

            if (!rows.length) {
                throw new Error("The first worksheet is empty.");
            }

            const headerRowIndex = rows.findIndex(row => {
                const normalized = row.map(normalizeExcelHeader);
                return normalized.includes("title") && normalized.includes("url");
            });

            if (headerRowIndex === -1) {
                throw new Error("Could not find the Excel header row. Expected columns: Ref, Title, Date, Url.");
            }

            const headers = rows[headerRowIndex];
            const refIndex = findExcelColumnIndex(headers, ["Ref", "Reference", "Memo Ref", "Circular No"]);
            const titleIndex = findExcelColumnIndex(headers, ["Title", "Topic", "Memo Title", "Subject"]);
            const dateIndex = findExcelColumnIndex(headers, ["Date", "Issue Date", "Memo Date"]);
            const urlIndex = findExcelColumnIndex(headers, ["Url", "URL", "Link", "File", "Path"]);

            if (titleIndex === -1 || urlIndex === -1) {
                throw new Error("The Excel file must include at least Title and Url columns.");
            }

            const importedMemos = [];

            for (let rowIndex = headerRowIndex + 1; rowIndex < rows.length; rowIndex++) {
                const row = rows[rowIndex] || [];
                const ref = refIndex >= 0 ? getExcelCellString(row[refIndex]) : "";
                const topic = getExcelCellString(row[titleIndex]);
                const date = dateIndex >= 0 ? normalizeExcelMemoDate(row[dateIndex]) : "";
                const url = getExcelCellString(row[urlIndex]);

                if (!ref && !topic && !date && !url) continue;
                if (!topic || !url) continue;

                importedMemos.push({
                    id: createStableExcelMemoId(ref, topic, date, url),
                    ref,
                    date,
                    topic,
                    url,
                    category: categories.includes("Technical Specifications") ? "Technical Specifications" : (categories[0] || "General"),
                    conditions: "",
                    application: "",
                    pdfData: "",
                    source: "Excel Import"
                });
            }

            return dedupeMemosByUrlRefId(importedMemos);
        }


export async function parseExcelMemoFile(file) {
            if (!window.XLSX) {
                throw new Error("Excel parser failed to load. Check your internet connection and refresh the admin page.");
            }

            const buffer = await file.arrayBuffer();
            const workbook = XLSX.read(buffer, {
                type: "array",
                cellDates: true
            });

            return parseExcelMemoWorksheet(workbook);
        }
