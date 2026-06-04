export function filterMemos(memos, filters) {
    const term = (filters.term || "").toLowerCase();
    const dateTerm = (filters.dateTerm || "").toLowerCase();
    const condTerm = (filters.condTerm || "").toLowerCase();
    const category = filters.category || "all";
    
export function sortMemosByDate(memos, direction) {
    if (!direction) return memos;

    return [...memos].sort((a, b) => {
        const dateA = a.date ? new Date(a.date).getTime() : 0;
        const dateB = b.date ? new Date(b.date).getTime() : 0;

        return direction === "asc"
            ? dateA - dateB
            : dateB - dateA;
        });
    }
    
    return memos.filter((memo) => {
        const ref = (memo.ref || "").toLowerCase();
        const topic = (memo.topic || "").toLowerCase();
        const application = (memo.application || "").toLowerCase();
        const date = (memo.date || "").toLowerCase();
        const conditions = (memo.conditions || "").toLowerCase();

        const matchesMainSearch =
            ref.includes(term) ||
            topic.includes(term) ||
            application.includes(term);

        const matchesDate = date.includes(dateTerm);
        const matchesConditions = conditions.includes(condTerm);
        const matchesCategory = category === "all" || memo.category === category;

        return matchesMainSearch && matchesDate && matchesConditions && matchesCategory;
    });
}
