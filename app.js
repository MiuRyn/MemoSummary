				
        import { initializeApp } from "https://www.gstatic.com/firebasejs/12.14.0/firebase-app.js";
        import { getFirestore, collection, getDocs, setDoc, deleteDoc, doc } from "https://www.gstatic.com/firebasejs/12.14.0/firebase-firestore.js";
        import { isLocalFileLink, localFileLinkToCopyPath, copyTextToClipboard } from "./local-file-links.js";
        import { generateMemoSummaryWithGemini } from "./ai-summary.js";
        import { loadCEDDMemos } from "./cedd-importer.js";

        const firebaseConfig = {
            apiKey: "AIzaSyCtQbVm91_lsmzz2XcX60bhUCYH0CjRb_E",
            authDomain: "memosummary.firebaseapp.com",
            projectId: "memosummary",
            storageBucket: "memosummary.firebasestorage.app",
            messagingSenderId: "368924924231",
            appId: "1:368924924231:web:db54991db4a9d6afe5d462",
            measurementId: "G-798K8NH74R"
        };

        const app = initializeApp(firebaseConfig);
        const db = getFirestore(app);

        let memos = [];
        const defaultCats = ["Insurance / PII", "Conditions of Contract", "Technical Specifications", "Procurement Guidelines"];
        let categories = JSON.parse(localStorage.getItem('tender_categories')) || defaultCats;
        let memoToDeleteId = null;

        const URL_MEMO_CHUNK_COLLECTION = "appData";
        const URL_MEMO_CHUNK_PREFIX = "memoChunk_";
        const URL_MEMO_CHUNK_SIZE = 100;

        // Pagination state
        window.currentPage = 1;
        const itemsPerPage = 20;
        let totalPages = 1;
        let dateSortDirection = "desc";

        const memoTableBody = document.getElementById('memoTableBody');
        const memoCount = document.getElementById('memoCount');
        const searchInput = document.getElementById('searchInput');
        const condSearchInput = document.getElementById('condSearchInput');
        const dateSearchInput = document.getElementById('dateSearchInput');
        const categoryFilter = document.getElementById('categoryFilter');
        const memoModal = document.getElementById('memoModal');
        const catModal = document.getElementById('catModal');
        const catList = document.getElementById('catList');
        const memoCategorySelect = document.getElementById('memoCategory');
        const importInput = document.getElementById('importInput');
        const memoPdfInput = document.getElementById('memoPdfInput');
        const memoPdfData = document.getElementById('memoPdfData');
        const pdfUploadStatus = document.getElementById('pdfUploadStatus');
        const saveSpinner = document.getElementById('saveSpinner');
        const saveFormBtn = document.getElementById('saveFormBtn');
        const generateSummaryBtn = document.getElementById('generateSummaryBtn');
        const dateSortBtn = document.getElementById('dateSortBtn');
        const dateSortIcon = document.getElementById('dateSortIcon');

        function showToast(message, type = "success") {
            const toast = document.getElementById('toast');
            document.getElementById('toastMessage').textContent = message;
            document.getElementById('toastIcon').innerHTML = type === "success" ? '<i class="fa-solid fa-circle-check text-emerald-400"></i>' : '<i class="fa-solid fa-circle-exclamation text-amber-400"></i>';
            toast.classList.remove('translate-y-20', 'opacity-0');
            setTimeout(() => toast.classList.add('translate-y-20', 'opacity-0'), 3000);
        }

        function cleanText(value) {
            return (value || '').replace(/\s+/g, ' ').trim();
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

        async function loadUrlMemoChunks() {
            const querySnapshot = await getDocs(collection(db, URL_MEMO_CHUNK_COLLECTION));
            const chunkDocs = [];

            querySnapshot.forEach((snapshot) => {
                if (!snapshot.id.startsWith(URL_MEMO_CHUNK_PREFIX)) return;
                const data = snapshot.data();
                if (!Array.isArray(data.memos)) return;

                chunkDocs.push({
                    id: snapshot.id,
                    memos: data.memos
                });
            });

            chunkDocs.sort((a, b) => a.id.localeCompare(b.id));

            return dedupeMemosByUrlRefId(
                chunkDocs.flatMap(chunk => chunk.memos)
            );
        }

        async function overwriteUrlMemoChunks(urlMemos) {
            const cleanUrlMemos = dedupeMemosByUrlRefId(
                urlMemos
                    .filter(memo => memo && cleanText(memo.url || ""))
                    .map(memo => ({
                        ...memo,
                        pdfData: memo.pdfData || ""
                    }))
            ).sort((a, b) => cleanText(a.ref || "").localeCompare(cleanText(b.ref || "")));

            const existingSnapshot = await getDocs(collection(db, URL_MEMO_CHUNK_COLLECTION));
            const deletes = [];

            existingSnapshot.forEach((snapshot) => {
                if (snapshot.id.startsWith(URL_MEMO_CHUNK_PREFIX)) {
                    deletes.push(deleteDoc(doc(db, URL_MEMO_CHUNK_COLLECTION, snapshot.id)));
                }
            });

            await Promise.all(deletes);

            const writes = [];
            for (let i = 0; i < cleanUrlMemos.length; i += URL_MEMO_CHUNK_SIZE) {
                const chunkNumber = String(Math.floor(i / URL_MEMO_CHUNK_SIZE) + 1).padStart(3, "0");
                const chunk = cleanUrlMemos.slice(i, i + URL_MEMO_CHUNK_SIZE);

                writes.push(setDoc(doc(db, URL_MEMO_CHUNK_COLLECTION, `${URL_MEMO_CHUNK_PREFIX}${chunkNumber}`), {
                    updatedAt: new Date().toISOString(),
                    count: chunk.length,
                    memos: chunk
                }));
            }

            await Promise.all(writes);
        }

        async function upsertUrlMemoToChunks(memo) {
            const urlMemos = await loadUrlMemoChunks();
            const key = getUrlMemoKey(memo);
            const existingIndex = urlMemos.findIndex(item => getUrlMemoKey(item) === key);

            if (existingIndex >= 0) {
                urlMemos[existingIndex] = {
                    ...urlMemos[existingIndex],
                    ...memo,
                    id: urlMemos[existingIndex].id || memo.id
                };
            } else {
                urlMemos.push(memo);
            }

            await overwriteUrlMemoChunks(urlMemos);
        }

        async function removeUrlMemoFromChunks(memo) {
            const key = getUrlMemoKey(memo);
            const urlMemos = await loadUrlMemoChunks();
            await overwriteUrlMemoChunks(urlMemos.filter(item => getUrlMemoKey(item) !== key));
        }

        async function saveMemoRecord(data) {
            if (cleanText(data.url || "")) {
                await upsertUrlMemoToChunks(data);

                try {
                    await deleteDoc(doc(db, "memos", data.id));
                } catch {
                    // It may not exist as an individual document.
                }

                return;
            }

            await setDoc(doc(db, "memos", data.id), data);
        }

        async function deleteMemoRecord(memo) {
            if (memo && cleanText(memo.url || "")) {
                await removeUrlMemoFromChunks(memo);

                try {
                    await deleteDoc(doc(db, "memos", memo.id));
                } catch {
                    // It may not exist as an individual document.
                }

                return;
            }

            await deleteDoc(doc(db, "memos", memo.id));
        }

        async function cleanupIndividualUrlDocuments(urlMemos) {
            const keys = new Set(urlMemos.map(getUrlMemoKey).filter(Boolean));
            const querySnapshot = await getDocs(collection(db, "memos"));
            const deletes = [];

            querySnapshot.forEach((snapshot) => {
                const data = snapshot.data();
                const key = getUrlMemoKey(data);

                if (key && keys.has(key)) {
                    deletes.push(deleteDoc(doc(db, "memos", snapshot.id)));
                }
            });

            await Promise.all(deletes);
            return deletes.length;
        }

        async function loadMemos() {
            try {
                const [urlMemos, querySnapshot] = await Promise.all([
                    loadUrlMemoChunks(),
                    getDocs(collection(db, "memos"))
                ]);

                const individualMemos = [];

                querySnapshot.forEach((snapshot) => {
                    const data = snapshot.data();

                    if (!cleanText(data.url || "")) {
                        individualMemos.push(data);
                    }
                });

                memos = dedupeMemosByUrlRefId([...urlMemos, ...individualMemos]);
                renderTable();
            } catch (error) {
                console.error(error);
                showToast("Failed to load data from database", "error");
            }
        }

        function formatMemoDate(dateValue) {
            if (!dateValue) return "";
            const raw = cleanText(dateValue);
            const parsed = new Date(`${raw}T00:00:00`);
            if (Number.isNaN(parsed.getTime())) return raw;
            return parsed.toLocaleDateString(undefined, {
                year: "numeric",
                month: "short",
                day: "numeric"
            });
        }
        window.copyMemoLocalPath = async (id) => {
            const memo = memos.find(item => item.id === id);
            if (!memo || !memo.url) {
                showToast("No local file path found", "error");
                return;
            }

            const pathToCopy = localFileLinkToCopyPath(memo.url);

            try {
                const copied = await copyTextToClipboard(pathToCopy);
                if (copied) {
                    showToast("Local file path copied. Paste it into Chrome address bar or File Explorer.");
                } else {
                    showToast("Copy failed. Please copy the path manually.", "error");
                    window.prompt("Copy this local file path:", pathToCopy);
                }
            } catch {
                showToast("Copy failed. Please copy the path manually.", "error");
                window.prompt("Copy this local file path:", pathToCopy);
            }
        };

        function renderMemoLinkAction(memo) {
            if (!memo || !memo.url) return "";

            if (isLocalFileLink(memo.url)) {
                return `<button onclick="copyMemoLocalPath('${memo.id}')" class="p-1.5 text-slate-400 hover:text-emerald-600 transition" title="Copy Local File Path"><i class="fa-solid fa-copy"></i></button>`;
            }

            return `<a href="${memo.url}" target="_blank" rel="noopener noreferrer" class="p-1.5 text-slate-400 hover:text-indigo-600 transition" title="Open Link"><i class="fa-solid fa-arrow-up-right-from-square"></i></a>`;
        }

        function updateDateSortIcon() {
            if (!dateSortIcon) return;

            if (dateSortDirection === "asc") {
                dateSortIcon.className = "fa-solid fa-arrow-up text-xs";
            } else if (dateSortDirection === "desc") {
                dateSortIcon.className = "fa-solid fa-arrow-down text-xs";
            } else {
                dateSortIcon.className = "fa-solid fa-sort text-xs";
            }
        }
        
        function renderTable() {
            const term = searchInput.value.toLowerCase();
            const dateTerm = dateSearchInput.value.toLowerCase();
            const condTerm = condSearchInput.value.toLowerCase();
            const cat = categoryFilter.value;
            
        let filtered = memos.filter(m =>
                (
                    (m.ref && m.ref.toLowerCase().includes(term)) ||
                    (m.topic && m.topic.toLowerCase().includes(term)) ||
                    (m.application && m.application.toLowerCase().includes(term))
                ) &&
                (m.date || '').toLowerCase().includes(dateTerm) &&
                (m.conditions || '').toLowerCase().includes(condTerm) &&
                (cat === 'all' || m.category === cat)
      );
        if (dateSortDirection) {
            filtered.sort((a, b) => {
                const dateA = a.date ? new Date(a.date).getTime() : 0;
                const dateB = b.date ? new Date(b.date).getTime() : 0;

                return dateSortDirection === "asc"
                    ? dateA - dateB
                    : dateB - dateA;
            });
        }

            
            
            const totalItems = filtered.length;
            totalPages = Math.ceil(totalItems / itemsPerPage) || 1;
            
            if (window.currentPage > totalPages) window.currentPage = totalPages;
            if (window.currentPage < 1) window.currentPage = 1;

            const startIndex = (window.currentPage - 1) * itemsPerPage;
            const endIndex = Math.min(startIndex + itemsPerPage, totalItems);
            
            const paginatedMemos = filtered.slice(startIndex, endIndex);

            memoCount.textContent = totalItems;
            document.getElementById('totalFilteredItems').textContent = totalItems;
            document.getElementById('pageStartItem').textContent = totalItems === 0 ? 0 : startIndex + 1;
            document.getElementById('pageEndItem').textContent = endIndex;

            memoTableBody.innerHTML = paginatedMemos.map(m => `
                <tr class="hover:bg-slate-50 transition border-b border-slate-100">
                    <td class="py-3 px-4 font-semibold">${m.ref || ''}</td>
                    <td class="py-3 px-4 text-xs text-slate-500 whitespace-nowrap">${formatMemoDate(m.date)}</td>
                    <td class="py-3 px-4">${m.topic || ''}</td>
                    <td class="py-3 px-4"><span class="px-2 py-0.5 bg-slate-100 rounded text-[10px] text-slate-600 font-medium">${m.conditions || 'N/A'}</span></td>
                    <td class="py-3 px-4 text-xs text-slate-500 leading-relaxed">${m.application || ''}</td>
                    <td class="py-3 px-4"><span class="px-2 py-0.5 rounded text-xs border bg-white border-slate-200 text-slate-700">${m.category || ''}</span></td>
                    <td class="py-3 px-4 text-right whitespace-nowrap">
                        <div class="flex justify-end gap-1">
                            ${renderMemoLinkAction(m)}
                            ${m.pdfData ? `<button onclick="openPdf('${m.id}')" class="p-1.5 text-slate-400 hover:text-rose-600 transition" title="Open PDF"><i class="fa-solid fa-file-pdf"></i></button>` : ''}
                            <button onclick="editMemo('${m.id}')" class="p-1.5 text-slate-400 hover:text-blue-600 transition"><i class="fa-solid fa-pen"></i></button>
                            <button onclick="deleteMemo('${m.id}')" class="p-1.5 text-slate-400 hover:text-red-600 transition"><i class="fa-solid fa-trash"></i></button>
                        </div>
                    </td>
                </tr>
            `).join('');

            renderPaginationControls();
        }

        function renderPaginationControls() {
            const container = document.getElementById('paginationControls');
            let html = '';

            html += `<button onclick="window.changePage(${window.currentPage - 1})" class="relative inline-flex items-center rounded-l-md px-2 py-2 text-slate-400 ring-1 ring-inset ring-slate-300 hover:bg-slate-50 focus:z-20 focus:outline-offset-0 disabled:opacity-50" ${window.currentPage === 1 ? 'disabled' : ''}>
                        <span class="sr-only">Previous</span><i class="fa-solid fa-chevron-left h-4 w-4"></i>
                     </button>`;

            for(let i = 1; i <= totalPages; i++) {
                if(i === 1 || i === totalPages || (i >= window.currentPage - 1 && i <= window.currentPage + 1)) {
                    const isCurrent = i === window.currentPage;
                    const activeClass = isCurrent ? 'z-10 bg-blue-600 text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600' : 'text-slate-900 ring-1 ring-inset ring-slate-300 hover:bg-slate-50 focus:z-20 focus:outline-offset-0';
                    html += `<button onclick="window.changePage(${i})" class="relative inline-flex items-center px-4 py-2 text-sm font-semibold ${activeClass}">${i}</button>`;
                } else if (i === window.currentPage - 2 || i === window.currentPage + 2) {
                    html += `<span class="relative inline-flex items-center px-4 py-2 text-sm font-semibold text-slate-700 ring-1 ring-inset ring-slate-300 focus:outline-offset-0">...</span>`;
                }
            }

            html += `<button onclick="window.changePage(${window.currentPage + 1})" class="relative inline-flex items-center rounded-r-md px-2 py-2 text-slate-400 ring-1 ring-inset ring-slate-300 hover:bg-slate-50 focus:z-20 focus:outline-offset-0 disabled:opacity-50" ${window.currentPage === totalPages ? 'disabled' : ''}>
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
            const m = memos.find(x => x.id === id);
            if (!m || !m.pdfData) return;

            const win = window.open('', '_blank');
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
    <iframe src="${m.pdfData}" allowfullscreen></iframe>
</body>
</html>`);
            win.document.close();
        };

        async function generateMemoDescriptionFromGemini() {
            if (!generateSummaryBtn) return;

            const originalHtml = generateSummaryBtn.innerHTML;
            const memoRefInput = document.getElementById('memoRef');
            const memoDateInput = document.getElementById('memoDate');
            const memoTopicInput = document.getElementById('memoTopic');
            const memoApplicationInput = document.getElementById('memoApplication');
//add guard to prevent overload of ai
            if (
                cleanText(memoRefInput.value) &&
                cleanText(memoDateInput.value) &&
                cleanText(memoTopicInput.value) &&
                cleanText(memoApplicationInput.value)
            ) {
                showToast(
                    "Record already contains metadata and description.",
                    "info"
                );
                return;
            }
///end of guard            
            try {
                generateSummaryBtn.disabled = true;
                generateSummaryBtn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i><span>Generating</span>';

                const aiResult = await generateMemoSummaryWithGemini({
                    ref: memoRefInput.value,
                    date: memoDateInput.value,
                    topic: memoTopicInput.value,
                    url: document.getElementById('memoLink').value,
                    category: document.getElementById('memoCategory').value,
                    conditions: document.getElementById('memoConditions').value,
                    application: memoApplicationInput.value,
                    pdfData: memoPdfData.value
                });

                const summaryText = typeof aiResult === "string" ? aiResult : (aiResult.summary || "");

                if (summaryText) {
                    memoApplicationInput.value = summaryText;
                }

                let filledFields = 0;

                if (typeof aiResult === "object" && aiResult) {
                    if (!cleanText(memoRefInput.value) && cleanText(aiResult.ref || "")) {
                        memoRefInput.value = aiResult.ref;
                        filledFields++;
                    }

                    if (!cleanText(memoDateInput.value) && cleanText(aiResult.date || "")) {
                        memoDateInput.value = aiResult.date;
                        filledFields++;
                    }

                    if (!cleanText(memoTopicInput.value) && cleanText(aiResult.topic || "")) {
                        memoTopicInput.value = aiResult.topic;
                        filledFields++;
                    }
                }

                showToast(
                    filledFields
                        ? `Gemini summary generated and ${filledFields} blank field(s) filled`
                        : "Gemini summary generated"
                );
            } catch (error) {
                console.error(error);
                showToast(error.message || "Failed to generate Gemini summary", "error");
            } finally {
                generateSummaryBtn.disabled = false;
                generateSummaryBtn.innerHTML = originalHtml;
            }
        }

        function renderCategoryTools() {
            const filterVal = categoryFilter.value;
            categoryFilter.innerHTML = '<option value="all">All Categories</option>' + 
                categories.map(c => `<option value="${c}">${c}</option>`).join('');
            categoryFilter.value = categories.includes(filterVal) ? filterVal : 'all';

            memoCategorySelect.innerHTML = categories.map(c => `<option value="${c}">${c}</option>`).join('');

            catList.innerHTML = categories.map((c, i) => `
                <div class="flex items-center justify-between p-2 bg-slate-50 rounded-lg border border-slate-100">
                    <span class="text-sm font-medium">${c}</span>
                    <div class="flex gap-1">
                        <button onclick="renameCategory(${i})" class="text-slate-400 hover:text-blue-600 p-1"><i class="fa-solid fa-pen text-xs"></i></button>
                        <button onclick="removeCategory(${i})" class="text-slate-400 hover:text-red-600 p-1"><i class="fa-solid fa-trash text-xs"></i></button>
                    </div>
                </div>
            `).join('');
        }

        const addCatButton = document.getElementById('addCatBtn');
        if (addCatButton) addCatButton.onclick = () => {
            const val = document.getElementById('newCatInput').value.trim();
            if (val && !categories.includes(val)) {
                categories.push(val);
                document.getElementById('newCatInput').value = '';
                saveCats();
                renderCategoryTools();
                showToast("Category added");
            }
        };

        window.removeCategory = (i) => {
            const cat = categories[i];
            memos.forEach(async m => { 
                if(m.category === cat) {
                    m.category = categories[0] === cat ? categories[1] || 'General' : categories[0];
                    await setDoc(doc(db, "memos", m.id), m);
                }
            });
            categories.splice(i, 1);
            saveCats();
            renderCategoryTools();
            renderTable();
        };

        window.renameCategory = (i) => {
            const oldVal = categories[i];
            const newVal = prompt("Enter new name for category:", oldVal);
            if (newVal && newVal.trim() !== "" && !categories.includes(newVal.trim())) {
                memos.forEach(async m => { 
                    if(m.category === oldVal) {
                        m.category = newVal.trim();
                        await setDoc(doc(db, "memos", m.id), m);
                    }
                });
                categories[i] = newVal.trim();
                saveCats();
                renderCategoryTools();
                renderTable();
            }
        };

        const saveCats = () => localStorage.setItem('tender_categories', JSON.stringify(categories));

        const addMemoButton = document.getElementById('addMemoBtn');
        if (addMemoButton) addMemoButton.onclick = () => {
            memoModal.classList.remove('hidden');
            document.getElementById('modalTitle').textContent = "New Memo Entry";
            document.getElementById('memoForm').reset();
            document.getElementById('memoId').value = "";
            memoPdfData.value = "";
            pdfUploadStatus.textContent = "";
            setTimeout(() => memoModal.querySelector('div').classList.remove('translate-x-full'), 10);
        };

        const closeM = () => {
            memoModal.querySelector('div').classList.add('translate-x-full');
            setTimeout(() => memoModal.classList.add('hidden'), 300);
        };

        const closeModalButton = document.getElementById('closeModalBtn');
        if (closeModalButton) closeModalButton.onclick = closeM;
        const cancelFormButton = document.getElementById('cancelFormBtn');
        if (cancelFormButton) cancelFormButton.onclick = closeM;

        saveFormBtn.onclick = async () => {
            const id = document.getElementById('memoId').value;
            const data = {
                id: id || Date.now().toString(),
                ref: document.getElementById('memoRef').value,
                date: document.getElementById('memoDate').value,
                topic: document.getElementById('memoTopic').value,
                url: document.getElementById('memoLink').value,
                category: document.getElementById('memoCategory').value,
                conditions: document.getElementById('memoConditions').value,
                application: document.getElementById('memoApplication').value,
                pdfData: memoPdfData.value
            };

            if (!data.ref || !data.topic) {
                return showToast("Ref and Topic are required", "error");
            }
            if (data.pdfData && data.pdfData.length > 900000) {
                return showToast("PDF string is too large for database limits.", "error");
            }

            saveFormBtn.disabled = true;
            saveSpinner.classList.remove('hidden');

            try {
                const previousMemo = memos.find(m => m.id === data.id);
                if (previousMemo && cleanText(previousMemo.url || "") && !cleanText(data.url || "")) {
                    await removeUrlMemoFromChunks(previousMemo);
                }

                await saveMemoRecord(data);
                const idx = memos.findIndex(m => m.id === data.id);
                if (idx > -1) {
                    memos[idx] = data;
                } else {
                    memos.push(data);
                }
                renderTable();
                closeM();
                showToast("Saved successfully");
            } catch (error) {
                showToast("Error saving to database", "error");
            } finally {
                saveFormBtn.disabled = false;
                saveSpinner.classList.add('hidden');
            }
        };

        window.editMemo = (id) => {
            const m = memos.find(x => x.id === id);
            document.getElementById('memoId').value = m.id;
            document.getElementById('memoRef').value = m.ref;
            document.getElementById('memoDate').value = m.date || '';
            document.getElementById('memoTopic').value = m.topic;
            document.getElementById('memoLink').value = m.url || '';
            document.getElementById('memoCategory').value = m.category;
            document.getElementById('memoConditions').value = m.conditions || '';
            document.getElementById('memoApplication').value = m.application || '';
            memoPdfData.value = m.pdfData || '';
            pdfUploadStatus.textContent = m.pdfData ? 'Existing PDF loaded.' : '';
            memoModal.classList.remove('hidden');
            document.getElementById('modalTitle').textContent = "Edit Memo Entry";
            setTimeout(() => memoModal.querySelector('div').classList.remove('translate-x-full'), 10);
        };

        window.deleteMemo = (id) => {
            memoToDeleteId = id;
            document.getElementById('deleteConfirmModal').classList.remove('hidden');
        };

        document.getElementById('confirmDeleteBtn').onclick = async () => {
            try {
                const memoToDelete = memos.find(m => m.id === memoToDeleteId);
                if (!memoToDelete) throw new Error("Memo was not found.");
                await deleteMemoRecord(memoToDelete);
                memos = memos.filter(m => m.id !== memoToDeleteId);
                // Adjust pagination if deleting the last item on the current page
                const totalFiltered = memos.filter(m => 
                    ((m.ref && m.ref.toLowerCase().includes(searchInput.value.toLowerCase())) || 
                     (m.date && m.date.toLowerCase().includes(searchInput.value.toLowerCase())) ||
                     (m.topic && m.topic.toLowerCase().includes(searchInput.value.toLowerCase())) || 
                     (m.application && m.application.toLowerCase().includes(searchInput.value.toLowerCase()))) && 
                    ((m.conditions || '').toLowerCase().includes(condSearchInput.value.toLowerCase())) &&
                    (categoryFilter.value === 'all' || m.category === categoryFilter.value)
                ).length;
                const updatedTotalPages = Math.ceil(totalFiltered / itemsPerPage) || 1;
                if (window.currentPage > updatedTotalPages) {
                    window.currentPage = updatedTotalPages;
                }
                renderTable();
                document.getElementById('deleteConfirmModal').classList.add('hidden');
                showToast("Entry deleted", "success");
            } catch (error) {
                showToast("Error deleting from database", "error");
            }
        };

        document.getElementById('cancelDeleteBtn').onclick = () => document.getElementById('deleteConfirmModal').classList.add('hidden');

        const manageCatsButton = document.getElementById('manageCatsBtn');
        if (manageCatsButton) manageCatsButton.onclick = () => catModal.classList.remove('hidden');
        const closeCatModalButton = document.getElementById('closeCatModalBtn');
        if (closeCatModalButton) closeCatModalButton.onclick = () => catModal.classList.add('hidden');


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

        function isImportableDEVBRecord(item) {
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

        function normalizeDEVBItem(item) {
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
            const files = Array.isArray(item && item.Files) ? item.Files.map(filePath => cleanText(filePath || "")).join("|") : "";
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
                const existingScript = document.querySelector(`script[data-devb-importer="true"]`);
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

        async function loadDEVBItems() {
            try {
                return await loadDEVBItemsViaScriptTag();
            } catch (scriptError) {
                console.warn("DEVB script-tag import failed. Trying fetch fallback.", scriptError);
                const jsText = await fetchDEVBDataJsText();
                return parseDEVBDataJsText(jsText);
            }
        }
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

                let importedMemos = circularRecords
                    .map(normalizeDEVBItem)
                    .filter(item => item.ref && item.topic && item.url);

                if (!importedMemos.length) {
                    console.warn("No importable DEVB records found. First raw item sample:", rawItems[0]);
                    throw new Error(`No valid DEVB circulars parsed. Found ${rawItems.length} raw items. Check Console for first sample.`);
                }

                const existingKeys = new Set(memos.map(getUrlMemoKey).filter(Boolean));
                const newCount = importedMemos.filter(memo => !existingKeys.has(getUrlMemoKey(memo))).length;
                const updatedCount = importedMemos.length - newCount;

                const incomingRefDateKeys = new Set();
                const newImportedMemos = [];
								const existingRefDateKeys = new Set(
								  memos
								    .map(getMemoRefDateDuplicateKey)
								    .filter(Boolean)
								);
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
                const mergedUrlMemos = dedupeMemosByUrlRefId([...existingUrlMemos, ...importedMemos]);

                await overwriteUrlMemoChunks(mergedUrlMemos);
                const cleanedCount = await cleanupIndividualUrlDocuments(importedMemos);

                await loadMemos();
                showToast(`DEVB import complete: ${newCount} new, ${updatedCount} updated, ${cleanedCount} old individual docs removed`);
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

        const importDevbButton = document.getElementById("importDevbBtn");
        if (importDevbButton) importDevbButton.onclick = importDEVBMemos;

        const exportButton = document.getElementById('exportBtn');
        if (exportButton) {
            exportButton.onclick = () => {
                const blob = new Blob([JSON.stringify(memos, null, 2)], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = 'tender_memos.json';
                a.click();
            };
        }

        const importButton = document.getElementById('importBtn');
        if (importButton && importInput) {
            importButton.onclick = () => importInput.click();
            importInput.onchange = async (e) => {
            const file = e.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = async (event) => {
                try {
                    const imported = JSON.parse(event.target.result);
                    if (Array.isArray(imported)) {
                        for (const m of imported) {
                            if (!m.id) m.id = Date.now().toString() + Math.random().toString().substring(2, 6);
                            await setDoc(doc(db, "memos", m.id), m);
                        }
                        await loadMemos();
                        showToast("Imported to database");
                    }
                } catch (err) {
                    showToast("Failed to import file", "error");
                }
            };
            reader.readAsText(file);
            };
        }

        const handleFilterChange = () => {
            window.currentPage = 1;
            renderTable();
        };

        searchInput.oninput = handleFilterChange;
        dateSearchInput.oninput = handleFilterChange;
        condSearchInput.oninput = handleFilterChange;
        categoryFilter.onchange = handleFilterChange;

        memoPdfInput.onchange = (e) => {
            const file = e.target.files[0];
            if (!file) {
                memoPdfData.value = '';
                pdfUploadStatus.textContent = '';
                return;
            }
            if (file.size > 700 * 1024) {
                showToast("File too large. Limit is 700KB.", "error");
                memoPdfInput.value = '';
                return;
            }
            const reader = new FileReader();
            reader.onload = (event) => {
                memoPdfData.value = event.target.result;
                pdfUploadStatus.textContent = `Loaded: ${file.name} (${Math.round(file.size/1024)}KB)`;
            };
            reader.readAsDataURL(file);
        };
        if (dateSortBtn) {
            dateSortBtn.onclick = () => {
                if (dateSortDirection === null) {
                    dateSortDirection = "desc";
                } else if (dateSortDirection === "desc") {
                    dateSortDirection = "asc";
                } else {
                    dateSortDirection = null;
                }

                updateDateSortIcon();
                window.currentPage = 1;
                renderTable();
            };
        }
        if (generateSummaryBtn) {
            generateSummaryBtn.onclick = generateMemoDescriptionFromGemini;
        }

        renderCategoryTools();
        loadMemos();
