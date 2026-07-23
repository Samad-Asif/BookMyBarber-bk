export interface VisionProvider {
    name: string;
    isConfigured(): boolean;
    generateWithVision(params: {
        prompt: string;
        images: { data: string; mimeType: string }[];
    }): Promise<string>;
}

export interface AnalysisResult {
    face_shape: string;
    hair_density: string;
    hair_texture: string;
    hair_color: string;
    suggested_haircut: string;
    styling_reason: string;
    analysis_details: string;
    generation_prompt: string;
}

export interface PhotoValidation {
    index: number;
    valid: boolean;
    reason?: string;
}

export interface ValidationResponse {
    photos: PhotoValidation[];
    all_same_person: boolean;
    all_same_person_reason?: string;
}

export interface AnalysisValidationResponse {
    valid: boolean;
    confidence: "high" | "medium" | "low";
    reason: string;
}
