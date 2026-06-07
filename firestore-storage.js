import {
    collection,
    getDocs,
    setDoc,
    deleteDoc,
    doc
} from "https://www.gstatic.com/firebasejs/12.14.0/firebase-firestore.js";

import { cleanText } from "./utils.js";

const URL_MEMO_CHUNK_COLLECTION = "appData";
const URL_MEMO_CHUNK_PREFIX = "memoChunk_";
const URL_MEMO_CHUNK_SIZE = 100;

export function getUrlMemoKey(memo) {
    return cleanText((memo && memo.url) || (memo && memo.ref) || (memo && memo.id) || "");
}

export function dedupeMemosByUrlRefId(records) {
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

export async function loadUrlMemoChunks(db) {
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

export async function overwriteUrlMemoChunks(db, urlMemos) {
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

export async function upsertUrlMemoToChunks(db, memo) {
    const urlMemos = await loadUrlMemoChunks(db);
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

    await overwriteUrlMemoChunks(db, urlMemos);
}

export async function removeUrlMemoFromChunks(db, memo) {
    const key = getUrlMemoKey(memo);
    const urlMemos = await loadUrlMemoChunks(db);

    await overwriteUrlMemoChunks(
        db,
        urlMemos.filter(item => getUrlMemoKey(item) !== key)
    );
}

export async function saveMemoRecord(db, data) {
    if (cleanText(data.url || "")) {
        await upsertUrlMemoToChunks(db, data);

        try {
            await deleteDoc(doc(db, "memos", data.id));
        } catch {
            // It may not exist as an individual document.
        }

        return;
    }

    await setDoc(doc(db, "memos", data.id), data);
}

export async function deleteMemoRecord(db, memo) {
    if (memo && cleanText(memo.url || "")) {
        await removeUrlMemoFromChunks(db, memo);

        try {
            await deleteDoc(doc(db, "memos", memo.id));
        } catch {
            // It may not exist as an individual document.
        }

        return;
    }

    await deleteDoc(doc(db, "memos", memo.id));
}

export async function cleanupIndividualUrlDocuments(db, urlMemos) {
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

export async function loadMemos() {
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
