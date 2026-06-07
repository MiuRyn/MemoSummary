exports.handler = async function () {
    try {
        const url = "https://www.cedd.gov.hk/eng/publications/technical-circulars/index.html";

        const response = await fetch(url, {
            headers: {
                "User-Agent": "Mozilla/5.0 MemoDirectoryBot/1.0"
            }
        });

        if (!response.ok) {
            return json(400, {
                error: `Failed to fetch CEDD page. HTTP ${response.status}`
            });
        }

        const html = await response.text();

        return {
            statusCode: 200,
            headers: {
                "Content-Type": "text/html; charset=utf-8",
                "Access-Control-Allow-Origin": "*"
            },
            body: html
        };
    } catch (error) {
        return json(500, {
            error: error.message || "Failed to fetch CEDD page"
        });
    }
};

function json(statusCode, body) {
    return {
        statusCode,
        headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*"
        },
        body: JSON.stringify(body)
    };
}
