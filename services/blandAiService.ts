
import { CallLog, Voice, Agent } from "../types";
import { BEATRICE_PROMPT, AYLA_PROMPT, STEPHEN_PROMPT } from "../constants";
import { getConfig } from "./configService";

const EBURON_ERROR_MESSAGE = "The Eburon Phone API service encountered an error. Please try again.";

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const getHeaders = (withEncryptedKey = true): HeadersInit => {
    const config = getConfig();
    const headers: any = {
        'authorization': config.apiKeys.blandApiKey,
    };
    if (withEncryptedKey && config.apiKeys.blandEncryptedKey) {
        headers['encrypted_key'] = config.apiKeys.blandEncryptedKey;
    }
    return headers;
}

const API_BASE_URL = 'https://api.bland.ai'; 

const apiFetch = async (endpoint: string, options: RequestInit = {}, withEncryptedKey = true) => {
    const defaultHeaders = getHeaders(withEncryptedKey);

    if (options.body) {
        (defaultHeaders as any)['Content-Type'] = 'application/json';
    }
    
    const response = await fetch(`${API_BASE_URL}${endpoint}`, {
        ...options,
        headers: {
            ...defaultHeaders,
            ...options.headers,
        },
    });

    if (!response.ok) {
        let errorMessage = `API Error: ${response.status} ${response.statusText}`;
        let errorCode = null;
        try {
            const errorBody = await response.json();
            if (errorBody.errors && Array.isArray(errorBody.errors) && errorBody.errors.length > 0) {
                errorMessage = errorBody.errors[0].message || errorMessage;
                errorCode = errorBody.errors[0].error || null;
            } else if (errorBody.message) {
                errorMessage = errorBody.message;
            } else {
                 errorMessage = JSON.stringify(errorBody);
            }
        } catch (e) {
            // Ignore if body isn't JSON
        }
        const customError: any = new Error(errorMessage);
        customError.code = errorCode;
        throw customError;
    }
    return response;
};

export const fetchCallLogs = async (): Promise<CallLog[]> => {
    try {
        const response = await apiFetch('/v1/calls');
        const data = await response.json();
        return data.calls.map((call: any) => ({
            call_id: call.call_id,
            created_at: call.created_at,
            duration: Math.round(call.call_length * 60),
            from: call.from,
            to: call.to,
            recording_url: call.recording_url || '',
            concatenated_transcript: call.concatenated_transcript || 'Transcript not available in summary.',
            transcript: call.transcript || [],
        }));
    } catch (error) {
        console.error("Eburon Voice Service Error (fetchCallLogs):", error);
        throw new Error(EBURON_ERROR_MESSAGE);
    }
};

export const fetchCallDetails = async (callId: string): Promise<CallLog> => {
    try {
        const response = await apiFetch(`/v1/calls/${callId}`);
        const call = await response.json();
        return {
            call_id: call.call_id,
            created_at: call.created_at,
            duration: Math.round(call.call_length * 60),
            from: call.from,
            to: call.to,
            recording_url: call.recording_url || '',
            concatenated_transcript: call.concatenated_transcript || 'No transcript available.',
            transcript: call.transcript || [],
            summary: call.summary || ''
        };
    } catch (error) {
        console.error("Eburon Voice Service Error (fetchCallDetails):", error);
        throw new Error(EBURON_ERROR_MESSAGE);
    }
};

export const fetchRecording = async (callId: string): Promise<Blob> => {
    const MAX_RETRIES = 7;
    const INITIAL_DELAY_MS = 2000;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            const response = await apiFetch(`/v1/recordings/${callId}`);
            const blob = await response.blob();
            if (blob.size > 0) {
                return blob;
            }
            const emptyFileError: any = new Error('Empty recording file received.');
            emptyFileError.code = 'CALL_RECORDING_NOT_FOUND';
            throw emptyFileError;

        } catch (error: any) {
            const isNotFound = error.code === 'CALL_RECORDING_NOT_FOUND';

            if (!isNotFound || attempt === MAX_RETRIES) {
                console.error(`Final error fetching recording for call ${callId} on attempt ${attempt}:`, error);
                throw new Error(`Failed to fetch recording for call ${callId}. It may not be available yet.`);
            }

            const delay = INITIAL_DELAY_MS * Math.pow(2, attempt - 1);
            console.log(`Recording not found for call ${callId}. Retrying in ${delay}ms... (Attempt ${attempt}/${MAX_RETRIES})`);
            await sleep(delay);
        }
    }
    throw new Error(`Failed to fetch recording for call ${callId} after all retries.`);
};

export const listenToActiveCall = async (callId: string): Promise<{ success: boolean; url?: string; message?: string }> => {
    try {
        const config = getConfig();
        const wsUrl = `wss://api.bland.ai/v1/listen/${callId}?api_key=${config.apiKeys.blandApiKey}`;
        return { success: true, url: wsUrl };
    } catch (error) {
        console.error("Eburon Voice Service Error (listenToActiveCall):", error);
        return { success: false, message: EBURON_ERROR_MESSAGE };
    }
};

export const listVoices = async (): Promise<Voice[]> => {
    try {
        const response = await apiFetch('/v1/voices', {}, false);
        const data = await response.json();
        const voicesData = data.voices || [];
        return voicesData.map((v: any) => {
            let displayName = v.name || `Voice ${v.id}`;
            const apiIdentifier = v.public ? v.name : v.id;

            // Map internal Bland voice names to Eburon Branding if needed
            if (displayName === 'Brh Callcenter') {
                displayName = 'Eburon Ayla (Real Estate)';
            }
            return {
                id: apiIdentifier,
                uuid: v.id,
                name: displayName,
                provider: 'Eburon TTS',
                type: v.public ? 'Prebuilt' : 'Cloned',
                tags: v.tags || [],
            };
        });
    } catch (error) {
        console.error("Eburon Voice Service Error (listVoices):", error);
        throw new Error(EBURON_ERROR_MESSAGE);
    }
};

export const generateVoiceSample = async (voiceId: string, text: string, language: string): Promise<Blob> => {
     try {
        const payload = {
            text: text,
            language: language,
            voice_settings: {},
            model: "base",
        };
        const response = await apiFetch(`/v1/voices/${voiceId}/sample`, {
            method: 'POST',
            body: JSON.stringify(payload),
        }, false);
        
        const audioBlob = await response.blob();

        if (audioBlob.size === 0) {
             throw new Error("API returned an empty audio file. This may indicate an issue with the voice or input text.");
        }
        
        return audioBlob;
    } catch (error) {
        console.error("Eburon Voice Service Error (generateVoiceSample):", error);
        throw new Error(EBURON_ERROR_MESSAGE);
    }
};

export const placeCall = async (phoneNumber: string, agent: Agent): Promise<{ success: boolean; call_id?: string; message?: string }> => {
    try {
        let tools = [];
        if (agent.tools && agent.tools.length > 0) {
             // Dynamic import to avoid circular dependency
             const dataService = await import('./dataService');
             const allTools = await dataService.getTools();
             
             tools = agent.tools.map(toolId => {
                 const t = allTools.find(at => at.id === toolId);
                 if (!t) return null;
                 
                 return {
                     name: t.name,
                     description: t.description,
                     url: t.url,
                     method: t.method,
                     headers: t.headers ? JSON.parse(t.headers) : {},
                     body: t.body ? JSON.parse(t.body) : {},
                 };
             }).filter(Boolean);
        }

        // Ensure we use the correct prompt based on the Agent's configuration
        // If it's the default ID (now Beatrice), use the hardcoded Real Estate prompt constant to be safe,
        // otherwise use the agent's custom prompt.
        let promptToUse = agent.systemPrompt;
        if (agent.id === 'default-beatrice-agent' || agent.id === 'default-ayla-agent') promptToUse = BEATRICE_PROMPT;
        
        // Handle Voice Mapping:
        // 'Kore' is a Gemini voice. For Bland AI, we need a valid Bland voice (e.g. Maya).
        // 'Puck' maps to a male voice.
        let voiceToUse = agent.voice;
        
        if (voiceToUse === 'Kore' || agent.id === 'default-beatrice-agent' || agent.id === 'default-ayla-agent') {
            voiceToUse = 'Maya'; 
        } else if (voiceToUse === 'Puck' || agent.name.includes('Stephen')) {
            voiceToUse = 'matt'; // Example male voice
        }

        const payload: any = {
            "phone_number": phoneNumber,
            "voice": voiceToUse,
            // CRITICAL FIX: Set wait_for_greeting to true to ensure audio is connected before AI speaks.
            // This prevents "I can't hear you" issues where the AI talks over the connection process.
            "wait_for_greeting": true, 
            "record": true,
            "answered_by_enabled": true,
            "noise_cancellation": true,
            // Increased threshold slightly to prevent background noise from cutting off the AI
            "interruption_threshold": 200, 
            "block_interruptions": false,
            "max_duration": 30, // 30 mins max
            "model": "enhanced", // Force enhanced for better audio processing/latency
            "language": "eng", 
            "task": promptToUse,
            "first_sentence": agent.firstSentence,
            "tools": tools.length > 0 ? tools : undefined,
            "voicemail_action": "hangup",
        };
        
        const response = await apiFetch('/v1/calls', {
            method: 'POST',
            body: JSON.stringify(payload)
        });
        const data = await response.json();
        return { success: true, call_id: data.call_id };
    } catch (error) {
        console.error("Eburon Voice Service Error (placeCall):", error);
        return { success: false, message: EBURON_ERROR_MESSAGE };
    }
};

// --- INBOUND CALL CONFIGURATION ---

export const configureInboundCall = async (phoneNumber: string, agent: Agent): Promise<{ success: boolean; message?: string }> => {
    try {
        let tools = [];
        if (agent.tools && agent.tools.length > 0) {
             const dataService = await import('./dataService');
             const allTools = await dataService.getTools();
             
             tools = agent.tools.map(toolId => {
                 const t = allTools.find(at => at.id === toolId);
                 if (!t) return null;
                 
                 return {
                     name: t.name,
                     description: t.description,
                     url: t.url,
                     method: t.method,
                     headers: t.headers ? JSON.parse(t.headers) : {},
                     body: t.body ? JSON.parse(t.body) : {},
                 };
             }).filter(Boolean);
        }

        const promptToUse = (agent.id === 'default-beatrice-agent' || agent.id === 'default-ayla-agent') ? BEATRICE_PROMPT : agent.systemPrompt;
        
        let voiceToUse = agent.voice;
        if (voiceToUse === 'Kore' || agent.id === 'default-beatrice-agent' || agent.id === 'default-ayla-agent') {
            voiceToUse = 'Maya'; 
        } else if (voiceToUse === 'Puck') {
            voiceToUse = 'matt';
        }

        const payload = {
            "phone_number": phoneNumber, // The Twilio/Bland number to configure
            "voice": voiceToUse,
            "task": promptToUse,
            "first_sentence": agent.firstSentence,
            "record": true,
            "model": "enhanced",
            "tools": tools.length > 0 ? tools : undefined,
            "wait_for_greeting": true,
            "interruption_threshold": 200,
            "max_duration": 30
        };

        const response = await apiFetch(`/v1/inbound/${phoneNumber}`, {
            method: 'POST',
            body: JSON.stringify(payload)
        });

        const data = await response.json();
        
        if(data.status === 'success') {
             return { success: true, message: "Inbound agent deployed successfully." };
        } else {
             return { success: false, message: "Failed to update inbound settings." };
        }

    } catch (error) {
        console.error("Eburon Voice Service Error (configureInboundCall):", error);
        return { success: false, message: EBURON_ERROR_MESSAGE };
    }
};
