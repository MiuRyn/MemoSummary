export function filterMemos(memos, filters) {
    const term = (filters.term || "").toLowerCase();
    const dateTerm = (filters.dateTerm || "").toLowerCase();
    const condTerm = (filters.condTerm || "").toLowerCase();
    const category = filters.category || "all";

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
