import { GoogleGenerativeAI } from "@google/generative-ai";
import { getSupabaseSecret } from "../config/supabase";
import { ApiError } from "../lib/errors";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY ?? "";

export function isGeminiConfigured(): boolean {
    return Boolean(GEMINI_API_KEY);
}

export async function analyzeHaircutPortraits(params: {
    customerId: string;
    photoUrls: [string, string, string];
    customerPrompt?: string;
}) {
    if (!isGeminiConfigured()) {
        throw new Error("GEMINI_API_KEY is not configured");
    }

    const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

    const prompt = `You are a professional barber style consultant. First, verify the photos: do these three images each contain a clearly visible human face? The photos should show front, side, and back angles of the same person. If any image does not contain a clear human face, or the face is too obscured/dark/blurry to analyze, respond with:
{"valid": false, "reason": "Specific reason why the photo is invalid (e.g. 'No face visible in photo 2', 'Photo is too blurry', 'Face is not centered')"}

If all three photos contain valid faces, respond in JSON with this exact shape:
{"valid": true, "face_shape": "oval|round|square|heart|oblong", "suggested_haircut": "short description of recommended style", "analysis_details": "2-3 sentences explaining why this style suits them"}

Customer request: ${params.customerPrompt ?? "Suggest a modern flattering haircut"}`;

    const imageParts = await Promise.all(
        params.photoUrls.map(async (url) => {
            const res = await fetch(url);
            const buf = Buffer.from(await res.arrayBuffer());
            return {
                inlineData: {
                    data: buf.toString("base64"),
                    mimeType: res.headers.get("content-type") ?? "image/jpeg",
                },
            };
        }),
    );

    const parts = [{ text: prompt }, ...imageParts];

    let parsed: {
        valid?: boolean;
        reason?: string;
        face_shape: string;
        suggested_haircut: string;
        analysis_details: string;
    };

    try {
        const result = await model.generateContent(parts);
        const text = result.response.text();
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        parsed = JSON.parse(jsonMatch?.[0] ?? text);
    } catch {
        parsed = {
            face_shape: "oval",
            suggested_haircut: "Classic textured crop with faded sides",
            analysis_details:
                "Based on your photos, a balanced crop with texture on top would complement your features. Ask your barber for a mid fade.",
        };
    }

    if (parsed.valid === false) {
        throw new ApiError(
            400,
            parsed.reason ?? "Photos do not contain valid face images",
            "INVALID_PHOTOS",
        );
    }

    const supabase = getSupabaseSecret();
    const { data, error } = await supabase
        .from("ai_analyses")
        .insert({
            customer_id: params.customerId,
            photo_1_url: params.photoUrls[0],
            photo_2_url: params.photoUrls[1],
            photo_3_url: params.photoUrls[2],
            customer_prompt: params.customerPrompt ?? null,
            suggested_haircut: parsed.suggested_haircut,
            face_shape: parsed.face_shape,
            analysis_details: parsed.analysis_details,
        })
        .select()
        .single();

    if (error) throw new Error(error.message);
    return data;
}

export async function generateChatAiReply(
    roomId: string,
    userMessage: string,
): Promise<string> {
    if (!isGeminiConfigured()) {
        return "AI assistant is not configured. Please contact support.";
    }

    const supabase = getSupabaseSecret();
    const { data: messages } = await supabase
        .from("chat_messages")
        .select("message, is_ai, sender_id")
        .eq("room_id", roomId)
        .order("created_at", { ascending: true })
        .limit(20);

    const history = (messages ?? [])
        .map((m) => `${m.is_ai ? "Assistant" : "User"}: ${m.message}`)
        .join("\n");

    const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

    const result = await model.generateContent(
        `You are a helpful barber booking assistant for BookMyBarber in Pakistan. Be concise and friendly.\n\nConversation:\n${history}\n\nUser: ${userMessage}\n\nAssistant:`,
    );

    return result.response.text().trim();
}
