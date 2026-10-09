// Core data types matching backend models

export interface Transcription {
  contactId: string;
  sequenceNumber: number;
  timestamp: string;
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
      text?: string;
      lineNumber?: number;
      sentiment: string;
      confidence: number;
    }>;
  };
  topics: Array<{
    name: string;
    confidence: number;
    mentions: number;
  }>;
  generatedAt: string;
}

export interface Eligibility {
  eligible: boolean;
  plans: string[];
  reason: string;
  age: number;
}

export interface FraudAssessment {
  riskScore: number;
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'UNKNOWN';
  flags: string[];
  summary: string;
}

export interface AddressVerification {
  verified: boolean;
  geocodedState: string | null;
  stateMatch: boolean;
  confidence: number;
  formattedAddress?: string;
  reason: string;
}

export interface Contact {
  id: string;
  transcriptions: Transcription[];
  analytics?: ContactAnalytics;
  status: 'IN_PROGRESS' | 'COMPLETED' | 'FAILED';
  createdAt: string;
  updatedAt: string;
  firstName?: string;
  lastName?: string;
  phoneNumber?: string;
  state?: string;
  reason?: string;
  eligibility?: Eligibility;
  addressVerification?: AddressVerification;
  fraudAssessment?: FraudAssessment;
  // [PLACEHOLDER_LAB5_CONTACT_FIELDS] Lab 5: Add reviewStatus and callbackId fields here
  metadata: {
    totalDuration?: number;
    participantCount?: number;
    source?: string;
  };
}

// AppSync Events types
export type EventType = 
  | 'CONTACT_UPDATED' 
  | 'CONTACT_CREATED' 
  | 'ANALYTICS_COMPLETED' 
  | 'SUMMARY_STREAMING';

export interface AppSyncEvent {
  eventType: EventType;
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

// Authentication types
export interface AuthUser {
  username: string;
  email?: string;
  token: string;
  refreshToken?: string;
}

export interface AuthState {
  user: AuthUser | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  error: string | null;
}
