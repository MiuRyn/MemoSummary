import { initializeApp } from "https://www.gstatic.com/firebasejs/12.14.0/firebase-app.js";
import {
    collection,
    getDocs,
    setDoc,
    doc
} from "https://www.gstatic.com/firebasejs/12.14.0/firebase-firestore.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/12.14.0/firebase-firestore.js";

import { firebaseConfig } from "./firebase-config.js";
import { cleanText, formatMemoDate, showToast } from "./utils.js";
import { filterMemos } from "./search.js";
import {
    loadAllMemos,
    saveMemoRecord,
    deleteMemoRecord,
    removeUrlMemoFromChunks,
    overwriteUrlMemoChunks,
    cleanupIndividualUrlDocuments,
    getUrlMemoKey,
    dedupeMemosByUrlRefId
} from "./firestore-storage.js";
import {
    loadDEVBItems,
    isImportableDEVBRecord,
    normalizeDEVBItem
} from "./devb-importer.js";

console.info("Government Memo Directory app.js loaded");

window.changePage = window.changePage || function () {
    console.warn("changePage called before app finished loading");
};

window.openPdf = window.openPdf || function () {
    console.warn("openPdf called before app finished loading");
};

window.editMemo = window.editMemo || function () {
    console.warn("editMemo called before app finished loading");
};

window.deleteMemo = window.deleteMemo || function () {
    console.warn("deleteMemo called before app finished loading");
};

window.renameCategory = window.renameCategory || function () {
    console.warn("renameCategory called before app finished loading");
};

window.removeCategory = window.removeCategory || function () {
    console.warn("removeCategory called before app finished loading");
};

function requireElement(id) {
    const element = document.getElementById(id);

    if (!element) {
        throw new Error(`Required HTML element #${id} was not found. Check that index.html matches app.js.`);
    }

    return element;
}

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

let memos = [];
const defaultCats = ["Insurance / PII", "Conditions of Contract", "Technical Specifications", "Procurement Guidelines"];
let categories = JSON.parse(localStorage.getItem("tender_categories")) || defaultCats;
let memoToDeleteId = null;

window.currentPage = 1;
const itemsPerPage = 20;
let totalPages = 1;

const memoTableBody = requireElement("memoTableBody");
const memoCount = requireElement("memoCount");
const searchInput = requireElement("searchInput");
const condSearchInput = requireElement("condSearchInput");
const dateSearchInput = requireElement("dateSearchInput");
const categoryFilter = requireElement("categoryFilter");
const memoModal = requireElement("memoModal");
const catModal = requireElement("catModal");
const catList = requireElement("catList");
const memoCategorySelect = requireElement("memoCategory");
const importInput = requireElement("importInput");
const memoPdfInput = requireElement("memoPdfInput");
const memoPdfData = requireElement("memoPdfData");
const pdfUploadStatus = requireElement("pdfUploadStatus");
const saveSpinner = requireElement("saveSpinner");
const saveFormBtn = requireElement("saveFormBtn");

async function loadMemos() {
    try {
        memos = await loadAllMemos(db);
        renderTable();
    } catch (error) {
        console.error(error);
        showToast("Failed to load data from database", "error");
    }
}

function getFilteredMemos() {
    return filterMemos(memos, {
        term: searchInput.value,
        dateTerm: dateSearchInput.value,
        condTerm: condSearchInput.value,
        category: categoryFilter.value
    });
}

function renderTable() {
    const filtered = getFilteredMemos();

    const totalItems = filtered.length;
    totalPages = Math.ceil(totalItems / itemsPerPage) || 1;

    if (window.currentPage > totalPages) window.currentPage = totalPages;
    if (window.currentPage < 1) window.currentPage = 1;

    const startIndex = (window.currentPage - 1) * itemsPerPage;
    const endIndex = Math.min(startIndex + itemsPerPage, totalItems);
    const paginatedMemos = filtered.slice(startIndex, endIndex);

    memoCount.textContent = totalItems;
    document.getElementById("totalFilteredItems").textContent = totalItems;
    document.getElementById("pageStartItem").textContent = totalItems === 0 ? 0 : startIndex + 1;
    document.getElementById("pageEndItem").textContent = endIndex;

    memoTableBody.innerHTML = paginatedMemos.map(m => `
        <tr class="hover:bg-slate-50 transition border-b border-slate-100">
            <td class="py-3 px-4 font-semibold">${m.ref || ""}</td>
            <td class="py-3 px-4 text-xs text-slate-500 whitespace-nowrap">${formatMemoDate(m.date)}</td>
            <td class="py-3 px-4">${m.topic || ""}</td>
            <td class="py-3 px-4"><span class="px-2 py-0.5 bg-slate-100 rounded text-[10px] text-slate-600 font-medium">${m.conditions || "N/A"}</span></td>
            <td class="py-3 px-4 text-xs text-slate-500 leading-relaxed">${m.application || ""}</td>
            <td class="py-3 px-4"><span class="px-2 py-0.5 rounded text-xs border bg-white border-slate-200 text-slate-700">${m.category || ""}</span></td>
            <td class="py-3 px-4 text-right whitespace-nowrap">
                <div class="flex justify-end gap-1">
                    ${m.url ? `<a href="${m.url}" target="_blank" class="p-1.5 text-slate-400 hover:text-indigo-600 transition" title="Open Link"><i class="fa-solid fa-arrow-up-right-from-square"></i></a>` : ""}
                    ${m.pdfData ? `<button onclick="openPdf('${m.id}')" class="p-1.5 text-slate-400 hover:text-rose-600 transition" title="Open PDF"><i class="fa-solid fa-file-pdf"></i></button>` : ""}
                    <button onclick="editMemo('${m.id}')" class="p-1.5 text-slate-400 hover:text-blue-600 transition"><i class="fa-solid fa-pen"></i></button>
                    <button onclick="deleteMemo('${m.id}')" class="p-1.5 text-slate-400 hover:text-red-600 transition"><i class="fa-solid fa-trash"></i></button>
                </div>
            </td>
        </tr>
    `).join("");

    renderPaginationControls();
}

function renderPaginationControls() {
    const container = document.getElementById("paginationControls");
    let html = "";

    html += `<button onclick="window.changePage(${window.currentPage - 1})" class="relative inline-flex items-center rounded-l-md px-2 py-2 text-slate-400 ring-1 ring-inset ring-slate-300 hover:bg-slate-50 focus:z-20 focus:outline-offset-0 disabled:opacity-50" ${window.currentPage === 1 ? "disabled" : ""}>
                <span class="sr-only">Previous</span><i class="fa-solid fa-chevron-left h-4 w-4"></i>
             </button>`;

    for (let i = 1; i <= totalPages; i++) {
        if (i === 1 || i === totalPages || (i >= window.currentPage - 1 && i <= window.currentPage + 1)) {
            const isCurrent = i === window.currentPage;
            const activeClass = isCurrent
                ? "z-10 bg-blue-600 text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
                : "text-slate-900 ring-1 ring-inset ring-slate-300 hover:bg-slate-50 focus:z-20 focus:outline-offset-0";

            html += `<button onclick="window.changePage(${i})" class="relative inline-flex items-center px-4 py-2 text-sm font-semibold ${activeClass}">${i}</button>`;
        } else if (i === window.currentPage - 2 || i === window.currentPage + 2) {
            html += `<span class="relative inline-flex items-center px-4 py-2 text-sm font-semibold text-slate-700 ring-1 ring-inset ring-slate-300 focus:outline-offset-0">...</span>`;
        }
    }

    html += `<button onclick="window.changePage(${window.currentPage + 1})" class="relative inline-flex items-center rounded-r-md px-2 py-2 text-slate-400 ring-1 ring-inset ring-slate-300 hover:bg-slate-50 focus:z-20 focus:outline-offset-0 disabled:opacity-50" ${window.currentPage === totalPages ? "disabled" : ""}>
                <span class="sr-only">Next</span><i class="fa-solid fa-chevron-right h-4 w-4"></i>
             </button>`;

    container.innerHTML = html;
}

window.changePage = (page) => {
    if (page >= 1 && page <= totalPages) {
        window.currentPage = page;
        renderTable();
    }
};

window.openPdf = (id) => {
    const memo = memos.find(x => x.id === id);

    if (!memo || !memo.pdfData) return;

    const win = window.open("", "_blank");

    if (!win) {
        showToast("Popup blocked. Please allow popups for this site.", "error");
        return;
    }

    win.document.open();
    win.document.write(`<!DOCTYPE html>
<html>
<head>
    <title>PDF Viewer</title>
    <style>
        html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; }
        iframe { width: 100%; height: 100%; border: none; }
    </style>
</head>
<body>
    <iframe src="${memo.pdfData}" allowfullscreen></iframe>
</body>
</html>`);
    win.document.close();
};

function renderCategoryTools() {
    const filterVal = categoryFilter.value;

    categoryFilter.innerHTML = '<option value="all">All Categories</option>' +
        categories.map(c => `<option value="${c}">${c}</option>`).join("");

    categoryFilter.value = categories.includes(filterVal) ? filterVal : "all";
    memoCategorySelect.innerHTML = categories.map(c => `<option value="${c}">${c}</option>`).join("");

    catList.innerHTML = categories.map((category, index) => `
        <div class="flex items-center justify-between p-2 bg-slate-50 rounded-lg border border-slate-100">
            <span class="text-sm font-medium">${category}</span>
            <div class="flex gap-1">
                <button onclick="renameCategory(${index})" class="text-slate-400 hover:text-blue-600 p-1"><i class="fa-solid fa-pen text-xs"></i></button>
                <button onclick="removeCategory(${index})" class="text-slate-400 hover:text-red-600 p-1"><i class="fa-solid fa-trash text-xs"></i></button>
            </div>
        </div>
    `).join("");
}

const saveCats = () => localStorage.setItem("tender_categories", JSON.stringify(categories));

async function persistAllMemosAfterCategoryChange() {
    const urlMemos = memos.filter(memo => cleanText(memo.url || ""));
    const individualMemos = memos.filter(memo => !cleanText(memo.url || ""));

    await overwriteUrlMemoChunks(db, urlMemos);

    await Promise.all(
        individualMemos.map(memo => setDoc(doc(db, "memos", memo.id), memo))
    );
}

document.getElementById("addCatBtn").onclick = () => {
    const input = document.getElementById("newCatInput");
    const value = input.value.trim();

    if (value && !categories.includes(value)) {
        categories.push(value);
        input.value = "";
        saveCats();
        renderCategoryTools();
        showToast("Category added");
    }
};

window.removeCategory = async (index) => {
    const category = categories[index];
    const replacement = categories[0] === category ? categories[1] || "General" : categories[0] || "General";

    memos.forEach((memo) => {
        if (memo.category === category) memo.category = replacement;
    });

    categories.splice(index, 1);
    saveCats();

    try {
        await persistAllMemosAfterCategoryChange();
        renderCategoryTools();
        renderTable();
        showToast("Category removed");
    } catch (error) {
        console.error(error);
        showToast("Failed to update category", "error");
    }
};

window.renameCategory = async (index) => {
    const oldValue = categories[index];
    const newValue = prompt("Enter new name for category:", oldValue);

    if (!newValue || newValue.trim() === "" || categories.includes(newValue.trim())) return;

    const cleanedNewValue = newValue.trim();

    memos.forEach((memo) => {
        if (memo.category === oldValue) memo.category = cleanedNewValue;
    });

    categories[index] = cleanedNewValue;
    saveCats();

    try {
        await persistAllMemosAfterCategoryChange();
        renderCategoryTools();
        renderTable();
        showToast("Category renamed");
    } catch (error) {
        console.error(error);
        showToast("Failed to rename category", "error");
    }
};

document.getElementById("addMemoBtn").onclick = () => {
    memoModal.classList.remove("hidden");
    document.getElementById("modalTitle").textContent = "New Memo Entry";
    document.getElementById("memoForm").reset();
    document.getElementById("memoId").value = "";
    memoPdfData.value = "";
    pdfUploadStatus.textContent = "";
    setTimeout(() => memoModal.querySelector("div").classList.remove("translate-x-full"), 10);
};

const closeM = () => {
    memoModal.querySelector("div").classList.add("translate-x-full");
    setTimeout(() => memoModal.classList.add("hidden"), 300);
};

document.getElementById("closeModalBtn").onclick = closeM;
document.getElementById("cancelFormBtn").onclick = closeM;

saveFormBtn.onclick = async () => {
    const id = document.getElementById("memoId").value;
    const data = {
        id: id || Date.now().toString(),
        ref: document.getElementById("memoRef").value,
        date: document.getElementById("memoDate").value,
        topic: document.getElementById("memoTopic").value,
        url: document.getElementById("memoLink").value,
        category: requireElement("memoCategory").value,
        conditions: document.getElementById("memoConditions").value,
        application: document.getElementById("memoApplication").value,
        pdfData: memoPdfData.value
    };

    if (!data.ref || !data.topic) {
        showToast("Ref and Topic are required", "error");
        return;
    }

    if (data.pdfData && data.pdfData.length > 900000) {
        showToast("PDF string is too large for database limits.", "error");
        return;
    }

    saveFormBtn.disabled = true;
    saveSpinner.classList.remove("hidden");

    try {
        const previousMemo = memos.find(memo => memo.id === data.id);

        if (previousMemo && cleanText(previousMemo.url || "") && !cleanText(data.url || "")) {
            await removeUrlMemoFromChunks(db, previousMemo);
        }

        await saveMemoRecord(db, data);

        const index = memos.findIndex(memo => memo.id === data.id);

        if (index > -1) {
            memos[index] = data;
        } else {
            memos.push(data);
        }

        renderTable();
        closeM();
        showToast("Saved successfully");
    } catch (error) {
        console.error(error);
        showToast("Error saving to database", "error");
    } finally {
        saveFormBtn.disabled = false;
        saveSpinner.classList.add("hidden");
    }
};

window.editMemo = (id) => {
    const memo = memos.find(x => x.id === id);

    if (!memo) {
        showToast("Memo not found", "error");
        return;
    }

    document.getElementById("memoId").value = memo.id;
    document.getElementById("memoRef").value = memo.ref;
    document.getElementById("memoDate").value = memo.date || "";
    document.getElementById("memoTopic").value = memo.topic;
    document.getElementById("memoLink").value = memo.url || "";
    requireElement("memoCategory").value = memo.category;
    document.getElementById("memoConditions").value = memo.conditions || "";
    document.getElementById("memoApplication").value = memo.application || "";
    memoPdfData.value = memo.pdfData || "";
    pdfUploadStatus.textContent = memo.pdfData ? "Existing PDF loaded." : "";

    memoModal.classList.remove("hidden");
    document.getElementById("modalTitle").textContent = "Edit Memo Entry";
    setTimeout(() => memoModal.querySelector("div").classList.remove("translate-x-full"), 10);
};

window.deleteMemo = (id) => {
    memoToDeleteId = id;
    document.getElementById("deleteConfirmModal").classList.remove("hidden");
};

document.getElementById("confirmDeleteBtn").onclick = async () => {
    try {
        const memoToDelete = memos.find(memo => memo.id === memoToDeleteId);

        if (!memoToDelete) throw new Error("Memo was not found.");

        await deleteMemoRecord(db, memoToDelete);

        memos = memos.filter(memo => memo.id !== memoToDeleteId);

        const updatedTotalPages = Math.ceil(getFilteredMemos().length / itemsPerPage) || 1;

        if (window.currentPage > updatedTotalPages) {
            window.currentPage = updatedTotalPages;
        }

        renderTable();
        document.getElementById("deleteConfirmModal").classList.add("hidden");
        showToast("Entry deleted", "success");
    } catch (error) {
        console.error(error);
        showToast("Error deleting from database", "error");
    }
};

document.getElementById("cancelDeleteBtn").onclick = () => {
    document.getElementById("deleteConfirmModal").classList.add("hidden");
};

document.getElementById("manageCatsBtn").onclick = () => catModal.classList.remove("hidden");
document.getElementById("closeCatModalBtn").onclick = () => catModal.classList.add("hidden");

function normalizeMemoRefForDuplicateCheck(value) {
    return cleanText(value || "")
        .toUpperCase()
        .replace(/^TC\s*\(?W\)?\s*NO\.?\s*/i, "")
        .replace(/^TCW\s*NO\.?\s*/i, "")
        .replace(/\s+/g, "")
        .replace(/[.]/g, "");
}

function normalizeMemoDateForDuplicateCheck(value) {
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

function getMemoRefDateDuplicateKey(memo) {
    const normalizedRef = normalizeMemoRefForDuplicateCheck(memo && memo.ref);
    const normalizedDate = normalizeMemoDateForDuplicateCheck(memo && memo.date);

    if (!normalizedRef || !normalizedDate) return "";

    return `${normalizedRef}::${normalizedDate}`;
}

async function importDEVBMemos() {
    const importDevbBtn = document.getElementById("importDevbBtn");
    const originalText = importDevbBtn ? importDevbBtn.innerHTML : "";

    try {
        if (importDevbBtn) {
            importDevbBtn.disabled = true;
            importDevbBtn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i> Importing';
        }

        showToast("Importing DEVB circulars...");

        const rawItems = await loadDEVBItems();

        if (!Array.isArray(rawItems)) {
            throw new Error("DEVB circular data was found, but it is not an array.");
        }

        const circularRecords = rawItems.filter(isImportableDEVBRecord);

        const importedMemos = circularRecords
            .map(normalizeDEVBItem)
            .filter(item => item.ref && item.topic && item.url);

        if (!importedMemos.length) {
            console.warn("No importable DEVB records found. First raw item sample:", rawItems[0]);
            throw new Error(`No valid DEVB circulars parsed. Found ${rawItems.length} raw items. Check Console for first sample.`);
        }

        const existingRefDateKeys = new Set(
            memos
                .map(getMemoRefDateDuplicateKey)
                .filter(Boolean)
        );

        const incomingRefDateKeys = new Set();
        const newImportedMemos = [];

        for (const importedMemo of importedMemos) {
            const duplicateKey = getMemoRefDateDuplicateKey(importedMemo);

            if (!duplicateKey) continue;
            if (existingRefDateKeys.has(duplicateKey)) continue;
            if (incomingRefDateKeys.has(duplicateKey)) continue;

            incomingRefDateKeys.add(duplicateKey);
            newImportedMemos.push(importedMemo);
        }

        if (!newImportedMemos.length) {
            await loadMemos();
            showToast(`DEVB import complete: 0 new, ${importedMemos.length} skipped as existing ref/date matches`);
            return;
        }

        const existingUrlMemos = memos.filter(memo => cleanText(memo.url || ""));
        const mergedUrlMemos = dedupeMemosByUrlRefId([...existingUrlMemos, ...newImportedMemos]);

        await overwriteUrlMemoChunks(db, mergedUrlMemos);
        await loadMemos();

        showToast(`DEVB import complete: ${newImportedMemos.length} new, ${importedMemos.length - newImportedMemos.length} skipped as existing ref/date matches`);
    } catch (error) {
        console.error(error);
        showToast(error.message || "Failed to import DEVB circulars", "error");
    } finally {
        if (importDevbBtn) {
            importDevbBtn.disabled = false;
            importDevbBtn.innerHTML = originalText;
        }
    }
}

document.getElementById("importDevbBtn").onclick = importDEVBMemos;

document.getElementById("exportBtn").onclick = () => {
    const blob = new Blob([JSON.stringify(memos, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");

    anchor.href = url;
    anchor.download = "tender_memos.json";
    anchor.click();

    URL.revokeObjectURL(url);
};

document.getElementById("importBtn").onclick = () => importInput.click();

importInput.onchange = async (event) => {
    const file = event.target.files[0];

    if (!file) return;

    const reader = new FileReader();

    reader.onload = async (loadEvent) => {
        try {
            const imported = JSON.parse(loadEvent.target.result);

            if (Array.isArray(imported)) {
                for (const memo of imported) {
                    if (!memo.id) {
                        memo.id = Date.now().toString() + Math.random().toString().substring(2, 6);
                    }

                    await saveMemoRecord(db, memo);
                }

                await loadMemos();
                showToast("Imported to database");
            }
        } catch (error) {
            console.error(error);
            showToast("Failed to import file", "error");
        }
    };

    reader.readAsText(file);
};

const handleFilterChange = () => {
    window.currentPage = 1;
    renderTable();
};

searchInput.oninput = handleFilterChange;
dateSearchInput.oninput = handleFilterChange;
condSearchInput.oninput = handleFilterChange;
categoryFilter.onchange = handleFilterChange;

memoPdfInput.onchange = (event) => {
    const file = event.target.files[0];

    if (!file) {
        memoPdfData.value = "";
        pdfUploadStatus.textContent = "";
        return;
    }

    if (file.size > 700 * 1024) {
        showToast("File too large. Limit is 700KB.", "error");
        memoPdfInput.value = "";
        return;
    }

    const reader = new FileReader();

    reader.onload = (loadEvent) => {
        memoPdfData.value = loadEvent.target.result;
        pdfUploadStatus.textContent = `Loaded: ${file.name} (${Math.round(file.size / 1024)}KB)`;
    };

    reader.readAsDataURL(file);
};

renderCategoryTools();
loadMemos();
