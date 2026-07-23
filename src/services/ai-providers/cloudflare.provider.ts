import axios from "axios";
import type { VisionProvider } from "./types";

const CLOUDFLARE_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID ?? "";
const CLOUDFLARE_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN ?? "";
const MODEL = "@cf/meta/llama-3.2-11b-vision-instruct";

let metaLicenseAccepted = false;

export function createCloudflareProvider(): VisionProvider {
    return {
        name: "cloudflare",
        isConfigured: () => Boolean(CLOUDFLARE_ACCOUNT_ID) && Boolean(CLOUDFLARE_API_TOKEN),
        async generateWithVision({ prompt, images }) {
            const base = `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/ai/run/${MODEL}`;
            const headers = {
                Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}`,
                "Content-Type": "application/json",
            };

            if (!metaLicenseAccepted) {
                try {
                    await axios.post(base, { prompt: "agree" }, { headers, timeout: 30_000 });
                    metaLicenseAccepted = true;
                } catch {
                    metaLicenseAccepted = true;
                }
            }

            const messages: any[] = [
                { role: "system", content: "You are a helpful vision analysis assistant. Always respond with valid JSON only, no markdown." },
            ];

            const userContent: any[] = [{ type: "text", text: prompt }];
            for (const img of images) {
                userContent.push({
                    type: "image_url",
                    image_url: { url: `data:${img.mimeType};base64,${img.data}` },
                });
            }
            messages.push({ role: "user", content: userContent });

            const { data } = await axios.post(base, { messages, max_tokens: 4096, temperature: 0.3 }, { headers, timeout: 120_000 });

            const result = data?.result;
            if (typeof result?.response === "string") return result.response;
            if (typeof result === "string") return result;
            throw new Error("Cloudflare returned empty response");
        },
    };
}
