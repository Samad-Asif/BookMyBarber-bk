import axios from "axios";
import type { VisionProvider } from "./types";

const GROQ_API_KEY = process.env.GROQ_API_KEY ?? "";
const GROQ_BASE_URL = "https://api.groq.com/openai/v1";
const MODEL = "qwen/qwen3.6-27b";

export function createGroqProvider(): VisionProvider {
    return {
        name: "groq",
        isConfigured: () => Boolean(GROQ_API_KEY),
        async generateWithVision({ prompt, images }) {
            const content: any[] = [{ type: "text", text: prompt }];
            for (const img of images) {
                content.push({
                    type: "image_url",
                    image_url: { url: `data:${img.mimeType};base64,${img.data}` },
                });
            }

            const { data } = await axios.post(
                `${GROQ_BASE_URL}/chat/completions`,
                {
                    model: MODEL,
                    messages: [{ role: "user", content }],
                    temperature: 1,
                    max_completion_tokens: 4096,
                    top_p: 1,
                    stream: false,
                },
                {
                    headers: {
                        Authorization: `Bearer ${GROQ_API_KEY}`,
                        "Content-Type": "application/json",
                    },
                    timeout: 60_000,
                },
            );

            const text = data?.choices?.[0]?.message?.content;
            if (!text) throw new Error("Groq returned empty response");
            return text;
        },
    };
}
