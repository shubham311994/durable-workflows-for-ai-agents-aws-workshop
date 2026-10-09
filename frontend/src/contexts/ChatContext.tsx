import { createContext, useContext, useState, useCallback, ReactNode } from 'react';
import { useAuth } from './AuthContext';
import 'amazon-connect-chatjs';

export interface ChatMessage {
  id: string;
  content: string;
  participantRole: 'CUSTOMER' | 'SYSTEM' | 'AGENT' | 'BOT';
  displayName: string;
  timestamp: Date;
  contentType: string;
}

type ChatStatus = 'disconnected' | 'connecting' | 'connected' | 'ended' | 'error';

interface ChatContextType {
  status: ChatStatus;
  messages: ChatMessage[];
  startChat: () => Promise<void>;
  sendMessage: (text: string) => Promise<void>;
  endChat: () => Promise<void>;
  error: string | null;
}

const ChatContext = createContext<ChatContextType | undefined>(undefined);

const AWS_REGION = process.env.REACT_APP_AWS_REGION || 'us-east-1';

export const ChatProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [session, setSession] = useState<any>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [status, setStatus] = useState<ChatStatus>('disconnected');
  const [error, setError] = useState<string | null>(null);
  const { user } = useAuth();

  const startChat = useCallback(async () => {
    if (!user?.token) {
      setError('Not authenticated');
      return;
    }

    setStatus('connecting');
    setError(null);
    setMessages([]);

    try {
      // Step 1: Call backend to initiate chat (StartChatContact) via nginx proxy
      const response = await fetch('/api/chat/start', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          displayName: user.email || user.username || 'Customer',
          attributes: { source: 'sca-web-crm' },
        }),
      });

      if (!response.ok) {
        throw new Error(`Failed to start chat: ${response.statusText}`);
      }

      const { contactId, participantId, participantToken } = await response.json();

      // Step 2: Configure ChatJS global settings
      const connect = (window as any).connect;
      connect.ChatSession.setGlobalConfig({
        loggerConfig: {
          level: connect.ChatSession.LogLevel.INFO,
        },
        region: AWS_REGION,
      });

      // Step 3: Create ChatJS session
      const chatSession = connect.ChatSession.create({
        chatDetails: { contactId, participantId, participantToken },
        type: 'CUSTOMER',
        options: { region: AWS_REGION },
      });

      // Step 4: Set up event handlers
      chatSession.onMessage((event: any) => {
        const data = event.data;
        if (data.Type === 'MESSAGE') {
          setMessages(prev => [...prev, {
            id: data.Id,
            content: data.Content,
            participantRole: data.ParticipantRole,
            displayName: data.DisplayName || data.ParticipantRole,
            timestamp: new Date(data.AbsoluteTime),
            contentType: data.ContentType,
          }]);
        }
      });

      chatSession.onTyping((_event: any) => {
        // Could show typing indicator — left for future enhancement
      });

      chatSession.onConnectionEstablished(() => {
        setStatus('connected');
      });

      chatSession.onEnded(() => {
        setStatus('ended');
        setSession(null);
      });

      chatSession.onConnectionLost(() => {
        setStatus('error');
        setError('Connection lost. Please try again.');
      });

      // Step 5: Connect the session (establishes WebSocket)
      await chatSession.connect();
      setSession(chatSession);

    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to start chat';
      setError(message);
      setStatus('error');
    }
  }, [user]);

  const sendMessage = useCallback(async (text: string) => {
    if (!session || !text.trim()) return;

    try {
      await session.sendMessage({
        contentType: 'text/plain',
        message: text.trim(),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to send message';
      setError(message);
    }
  }, [session]);

  const endChat = useCallback(async () => {
    if (!session) return;

    try {
      await session.disconnectParticipant();
    } catch (err) {
      // Ignore errors during disconnect
    } finally {
      setSession(null);
      setStatus('disconnected');
    }
  }, [session]);

  return (
    <ChatContext.Provider value={{ status, messages, startChat, sendMessage, endChat, error }}>
      {children}
    </ChatContext.Provider>
  );
};

export const useChat = () => {
  const context = useContext(ChatContext);
  if (context === undefined) {
    throw new Error('useChat must be used within a ChatProvider');
  }
  return context;
};
