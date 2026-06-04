export function cleanLinkText(value) {
    return (value || "").replace(/\s+/g, " ").trim();
}

export function isLocalFileLink(value) {
    const raw = cleanLinkText(value);
    return raw.startsWith("\\\\") || /^file:/i.test(raw);
}

export function localFileLinkToCopyPath(value) {
    const raw = cleanLinkText(value);

    if (raw.startsWith("\\\\")) {
        return raw;
    }

    if (/^file:\/\//i.test(raw)) {
        try {
            const url = new URL(raw);
            const decodedPath = decodeURIComponent(url.pathname || "");

            if (url.hostname) {
                return `\\\\${url.hostname}${decodedPath.replace(/\//g, "\\")}`;
            }

            return decodedPath
                .replace(/^\/([A-Za-z]:)/, "$1")
                .replace(/\//g, "\\");
        } catch {
            return raw
                .replace(/^file:\/+/i, "")
                .replace(/\//g, "\\");
        }
    }

    return raw;
}

export async function copyTextToClipboard(text) {
    if (!text) return false;

    if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
    }

    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.left = "-9999px";
    textarea.style.top = "-9999px";

    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();

    try {
        const copied = document.execCommand("copy");
        document.body.removeChild(textarea);
        return copied;
    } catch {
        document.body.removeChild(textarea);
        return false;
    }
}
