export function cleanText(value) {
    return (value || "").replace(/\s+/g, " ").trim();
}

export function formatMemoDate(dateValue) {
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

export function showToast(message, type = "success") {
    const toast = document.getElementById("toast");
    const toastMessage = document.getElementById("toastMessage");
    const toastIcon = document.getElementById("toastIcon");

    if (!toast || !toastMessage || !toastIcon) {
        console[type === "success" ? "log" : "warn"](message);
        return;
    }

    toastMessage.textContent = message;
    toastIcon.innerHTML = type === "success"
        ? '<i class="fa-solid fa-circle-check text-emerald-400"></i>'
        : '<i class="fa-solid fa-circle-exclamation text-amber-400"></i>';

    toast.classList.remove("translate-y-20", "opacity-0");
    setTimeout(() => toast.classList.add("translate-y-20", "opacity-0"), 3000);
}
