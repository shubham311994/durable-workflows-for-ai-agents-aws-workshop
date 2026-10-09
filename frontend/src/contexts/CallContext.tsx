import { createContext, useContext, useState, useCallback, useRef, ReactNode } from 'react';
import {
  ConsoleLogger,
  DefaultDeviceController,
  DefaultMeetingSession,
  LogLevel,
  MeetingSessionConfiguration,
} from 'amazon-chime-sdk-js';
import { useAuth } from './AuthContext';

type CallStatus = 'idle' | 'connecting' | 'in-call' | 'ended' | 'error';

interface CallContextType {
  status: CallStatus;
  isMuted: boolean;
  error: string | null;
  startCall: () => Promise<void>;
  toggleMute: () => void;
  endCall: () => Promise<void>;
  /** Ref to attach to an <audio> element for remote audio playback. */
  audioRef: React.RefObject<HTMLAudioElement>;
}

const CallContext = createContext<CallContextType | undefined>(undefined);

export const CallProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [status, setStatus] = useState<CallStatus>('idle');
  const [isMuted, setIsMuted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { user } = useAuth();

  const meetingSessionRef = useRef<DefaultMeetingSession | null>(null);
  const audioRef = useRef<HTMLAudioElement>(null);

  const cleanup = useCallback(() => {
    const session = meetingSessionRef.current;
    if (session) {
      try {
        session.audioVideo.stop();
      } catch {
        // ignore stop errors
      }
      meetingSessionRef.current = null;
    }
  }, []);

  const startCall = useCallback(async () => {
    if (!user?.token) {
      setError('Not authenticated');
      setStatus('error');
      return;
    }

    setStatus('connecting');
    setError(null);
    setIsMuted(false);

    try {
      // Step 1: Ask backend to place the in-app voice call (StartWebRTCContact) via nginx proxy.
      const response = await fetch('/api/call/start', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          displayName: user.email || user.username || 'Customer',
          attributes: { source: 'sca-web-crm-voice' },
        }),
      });

      if (!response.ok) {
        throw new Error(`Failed to start call: ${response.statusText}`);
      }

      const { connectionData } = await response.json();
      const { Meeting, Attendee } = connectionData;

      // Step 2: Build the Chime SDK meeting session from the Connect connection data.
      const logger = new ConsoleLogger('SCAWebRTC', LogLevel.WARN);
      const deviceController = new DefaultDeviceController(logger);
      const configuration = new MeetingSessionConfiguration(Meeting, Attendee);
      const meetingSession = new DefaultMeetingSession(configuration, logger, deviceController);
      meetingSessionRef.current = meetingSession;

      const av = meetingSession.audioVideo;

      // Step 3: Select the default microphone as the audio input.
      const audioInputs = await av.listAudioInputDevices();
      if (audioInputs.length > 0) {
        await av.startAudioInput(audioInputs[0].deviceId);
      }

      // Step 4: Bind remote audio to the <audio> element so the caller hears the AI agent.
      if (audioRef.current) {
        await av.bindAudioElement(audioRef.current);
      }

      // Step 5: Observe connection lifecycle.
      av.addObserver({
        audioVideoDidStart: () => {
          setStatus('in-call');
        },
        audioVideoDidStop: (sessionStatus) => {
          // Any stop (agent hangup, network drop, or local end) lands here.
          cleanup();
          setStatus((prev) => (prev === 'error' ? 'error' : 'ended'));
          // eslint-disable-next-line no-console
          console.info('Call ended:', sessionStatus.statusCode());
        },
      });

      // Step 6: Start the session (establishes WebRTC audio to Amazon Connect).
      av.start();
    } catch (err) {
      cleanup();
      const message = err instanceof Error ? err.message : 'Failed to start call';
      setError(message);
      setStatus('error');
    }
  }, [user, cleanup]);

  const toggleMute = useCallback(() => {
    const session = meetingSessionRef.current;
    if (!session) return;

    const av = session.audioVideo;
    if (av.realtimeIsLocalAudioMuted()) {
      av.realtimeUnmuteLocalAudio();
      setIsMuted(false);
    } else {
      av.realtimeMuteLocalAudio();
      setIsMuted(true);
    }
  }, []);

  const endCall = useCallback(async () => {
    cleanup();
    setStatus('idle');
    setIsMuted(false);
  }, [cleanup]);

  return (
    <CallContext.Provider
      value={{ status, isMuted, error, startCall, toggleMute, endCall, audioRef }}
    >
      {children}
    </CallContext.Provider>
  );
};

export const useCall = () => {
  const context = useContext(CallContext);
  if (context === undefined) {
    throw new Error('useCall must be used within a CallProvider');
  }
  return context;
};
