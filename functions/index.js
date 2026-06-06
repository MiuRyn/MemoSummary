const { onRequest } = require("firebase-functions/v2/https");
const { GoogleGenerativeAI } = require("@google/generative-ai");

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

exports.summarizeExternalMemoUrl = onRequest(
  {
    cors: true,
    timeoutSeconds: 120,
    memory: "1GiB"
  },
  async (req, res) => {
    try {
      if (req.method !== "POST") {
        return res.status(405).json({ error: "Method not allowed" });
      }

      const { url, ref = "", topic = "" } = req.body || {};

      if (!url || !/^https?:\/\//i.test(url)) {
        return res.status(400).json({ error: "Valid http/https URL is required" });
      }

      const pdfResponse = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 MemoSummaryBot/1.0"
        }
      });

      if (!pdfResponse.ok) {
        return res.status(400).json({
          error: `Could not fetch URL. HTTP ${pdfResponse.status}`
        });
      }

      const contentType = pdfResponse.headers.get("content-type") || "";
      const arrayBuffer = await pdfResponse.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);

      if (buffer.length > 15 * 1024 * 1024) {
        return res.status(413).json({
          error: "PDF is too large. Limit is 15MB."
        });
      }

      const model = genAI.getGenerativeModel({
        model: "gemini-1.5-flash"
      });

      const result = await model.generateContent([
        {
          text: `
Summarize this government memo in 2 concise sentences.

Memo reference: ${ref}
Memo topic: ${topic}
Source URL: ${url}

Focus on:
1. What the memo/circular is about
2. Practical use or relevance for works/tender/contract administration
          `.trim()
        },
        {
          inlineData: {
            mimeType: contentType.includes("pdf") ? "application/pdf" : contentType || "application/pdf",
            data: buffer.toString("base64")
          }
        }
      ]);

      const summary = result.response.text().trim();

      return res.json({
        summary
      });
    } catch (error) {
      console.error(error);
      return res.status(500).json({
        error: error.message || "Failed to summarize external URL"
      });
    }
  }
);
