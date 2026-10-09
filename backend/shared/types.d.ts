/**
 * Core data types for the Serverless Conversational Analytics solution
 */
export interface Transcription {
    contactId: string;
    sequenceNumber: number;
    timestamp: Date;
    speaker: 'AGENT' | 'CUSTOMER';
    text: string;
    confidence: number;
    isComplete?: boolean;
    totalExpected?: number;
    metadata: {
        channel?: string;
        language?: string;
        duration?: number;
        contactStatus?: 'IN_PROGRESS' | 'COMPLETED';
    };
}
export interface ContactAnalytics {
    contactId: string;
    summary: string;
    sentiment: {
        overall: 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL' | 'MIXED';
        confidence: number;
        segments: Array<{
            text: string;
            sentiment: string;
            confidence: number;
        }>;
    };
    topics: Array<{
        name: string;
        confidence: number;
        mentions: number;
    }>;
    generatedAt: Date;
}
export interface Contact {
    id: string;
    transcriptions: Transcription[];
    analytics?: ContactAnalytics;
    status: 'IN_PROGRESS' | 'COMPLETED' | 'FAILED';
    createdAt: Date;
    updatedAt: Date;
    metadata: {
        totalDuration?: number;
        participantCount?: number;
        source?: string;
    };
}
export interface AppSyncEvent {
    eventType: 'CONTACT_UPDATED' | 'CONTACT_CREATED' | 'ANALYTICS_COMPLETED' | 'SUMMARY_STREAMING';
    contactId: string;
    timestamp: string;
    data: {
        contact?: Contact;
        analytics?: ContactAnalytics;
        summary?: string;
        summaryChunk?: string;
        isComplete?: boolean;
    };
}
export interface KinesisTranscriptionRecord {
    contactId: string;
    sequenceNumber: number;
    timestamp: string;
    speaker: 'AGENT' | 'CUSTOMER';
    text: string;
    confidence: number;
    metadata?: {
        channel?: string;
        language?: string;
        duration?: number;
        contactStatus?: 'IN_PROGRESS' | 'COMPLETED';
        isComplete?: boolean;
        totalExpected?: number;
    };
}
export interface TranscriptionDynamoDBItem {
    PK: string;
    SK: string;
    contactId: string;
    sequenceNumber: number;
    timestamp: string;
    speaker: string;
    text: string;
    confidence: number;
    isComplete?: boolean;
    totalExpected?: number;
    metadata?: Record<string, any>;
    GSI1PK?: string;
    GSI1SK?: string;
}
export interface AnalyticsDynamoDBItem {
    PK: string;
    SK: string;
    contactId: string;
    analyticsType: 'SUMMARY' | 'SENTIMENT' | 'TOPICS';
    content: string;
    confidence?: number;
    generatedAt: string;
    metadata?: Record<string, any>;
}
export interface ProcessingError {
    errorType: 'VALIDATION_ERROR' | 'PROCESSING_ERROR' | 'STORAGE_ERROR' | 'AI_SERVICE_ERROR';
    message: string;
    context: Record<string, any>;
    timestamp: Date;
    retryable: boolean;
}
export interface DeadLetterQueueMessage {
    originalMessage: any;
    error: ProcessingError;
    attemptCount: number;
    firstAttempt: Date;
    lastAttempt: Date;
}
