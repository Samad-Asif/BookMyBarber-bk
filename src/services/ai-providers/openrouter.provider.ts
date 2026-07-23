import axios from "axios";
import type { VisionProvider } from "./types";

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY ?? "";
const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const MODEL = "qwen/qwen-2-vl-72b-instruct:fastest";

export function createOpenRouterProvider(): VisionProvider {
    return {
        name: "openrouter",
        isConfigured: () => Boolean(OPENROUTER_API_KEY),
        async generateWithVision({ prompt, images }) {
            const content: any[] = [{ type: "text", text: prompt }];
            for (const img of images) {
                content.push({
                    type: "image_url",
                    image_url: { url: `data:${img.mimeType};base64,${img.data}` },
                });
            }

            const { data } = await axios.post(
                `${OPENROUTER_BASE_URL}/chat/completions`,
                {
                    model: MODEL,
                    messages: [{ role: "user", content }],
                    max_tokens: 4096,
                },
                {
                    headers: {
                        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
                        "Content-Type": "application/json",
                    },
                    timeout: 60_000,
                },
            );

            const text = data?.choices?.[0]?.message?.content;
            if (!text) throw new Error("OpenRouter returned empty response");
            return text;
        },
    };
}
