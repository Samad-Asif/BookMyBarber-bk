import { InferenceClient } from "@huggingface/inference";
import type { VisionProvider } from "./types";

const HF_TOKEN = process.env.HF_TOKEN ?? "";
const MODEL = "meta-llama/Llama-3.2-11B-Vision-Instruct";

export function createHuggingFaceProvider(): VisionProvider {
    let client: InferenceClient | null = null;

    function getClient(): InferenceClient {
        if (!client) client = new InferenceClient(HF_TOKEN);
        return client;
    }

    return {
        name: "huggingface",
        isConfigured: () => Boolean(HF_TOKEN),
        async generateWithVision({ prompt, images }) {
            const content: any[] = [{ type: "text", text: prompt }];
            for (const img of images) {
                content.push({
                    type: "image_url",
                    image_url: { url: `data:${img.mimeType};base64,${img.data}` },
                });
            }

            const result = await getClient().chatCompletion({
                model: `${MODEL}:fastest`,
                messages: [{ role: "user", content }],
            });

            const text = result.choices?.[0]?.message?.content;
            if (typeof text !== "string" || !text) {
                throw new Error("HuggingFace returned empty response");
            }
            return text;
        },
    };
}
