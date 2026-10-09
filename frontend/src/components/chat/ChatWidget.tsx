import { useState, useRef, useEffect, FormEvent } from 'react';
import { useChat, ChatMessage } from '../../contexts/ChatContext';
import { useCall } from '../../contexts/CallContext';
import './ChatWidget.css';

type WidgetMode = 'chat' | 'voice';

export const ChatWidget = () => {
  const { status, messages, startChat, sendMessage, endChat, error } = useChat();
  const call = useCall();
  const [isOpen, setIsOpen] = useState(false);
  const [mode, setMode] = useState<WidgetMode>('chat');
  const [input, setInput] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!input.trim()) return;
    await sendMessage(input);
    setInput('');
  };

  const handleStartChat = async () => {
    await startChat();
  };

  const handleEndChat = async () => {
    await endChat();
  };

  const handleToggle = () => {
    setIsOpen(prev => !prev);
  };

  // Switch modes; block switching while a chat or call is active to avoid orphaning a session.
  const chatActive = status === 'connected' || status === 'connecting';
  const callActive = call.status === 'in-call' || call.status === 'connecting';

  const handleSelectMode = (next: WidgetMode) => {
    if (chatActive || callActive) return;
    setMode(next);
  };

  const renderMessage = (msg: ChatMessage) => {
    const isCustomer = msg.participantRole === 'CUSTOMER';
    const roleClass = isCustomer ? 'chat-message--customer' : 'chat-message--agent';

    return (
      <div key={msg.id} className={`chat-message ${roleClass}`}>
        <div className="chat-message__bubble">
          <span className="chat-message__sender">
            {isCustomer ? 'You' : msg.displayName}
          </span>
          <p className="chat-message__text">{msg.content}</p>
          <span className="chat-message__time">
            {msg.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </span>
        </div>
      </div>
    );
  };

  const renderChat = () => {
    switch (status) {
      case 'disconnected':
        return (
          <div className="chat-widget__start">
            <div className="chat-widget__start-icon" aria-hidden="true">💬</div>
            <h3 className="chat-widget__start-title">Start a Chat</h3>
            <p className="chat-widget__start-description">
              Chat with our AI assistant for help with health insurance enrollment.
            </p>
            <button
              className="chat-widget__start-button"
              onClick={handleStartChat}
              aria-label="Start chat"
            >
              Start Chat
            </button>
          </div>
        );

      case 'connecting':
        return (
          <div className="chat-widget__loading">
            <div className="chat-widget__spinner" aria-label="Connecting" role="status" />
            <p>Connecting to agent...</p>
          </div>
        );

      case 'connected':
      case 'ended':
        return (
          <>
            <div className="chat-widget__messages" role="log" aria-live="polite">
              {messages.length === 0 && status === 'connected' && (
                <p className="chat-widget__empty">
                  Connected! Waiting for a response...
                </p>
              )}
              {messages.map(renderMessage)}
              {status === 'ended' && (
                <div className="chat-message chat-message--system">
                  <div className="chat-message__bubble chat-message__bubble--system">
                    <p className="chat-message__text">Chat session ended.</p>
                  </div>
                </div>
              )}
              <div ref={messagesEndRef} />
            </div>
            {status === 'connected' ? (
              <form className="chat-widget__input-area" onSubmit={handleSubmit}>
                <input
                  type="text"
                  className="chat-widget__input"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  placeholder="Type a message..."
                  aria-label="Chat message input"
                  autoFocus
                />
                <button
                  type="submit"
                  className="chat-widget__send-button"
                  disabled={!input.trim()}
                  aria-label="Send message"
                >
                  Send
                </button>
              </form>
            ) : (
              <div className="chat-widget__input-area chat-widget__input-area--ended">
                <button
                  className="chat-widget__start-button"
                  onClick={handleStartChat}
                  aria-label="Start new chat"
                >
                  Start New Chat
                </button>
              </div>
            )}
          </>
        );

      case 'error':
        return (
          <div className="chat-widget__error">
            <p className="chat-widget__error-message">{error || 'An error occurred'}</p>
            <button
              className="chat-widget__start-button"
              onClick={handleStartChat}
              aria-label="Retry chat"
            >
              Retry
            </button>
          </div>
        );

      default:
        return null;
    }
  };

  const renderVoice = () => {
    switch (call.status) {
      case 'idle':
      case 'ended':
        return (
          <div className="chat-widget__start">
            <div className="chat-widget__start-icon" aria-hidden="true">📞</div>
            <h3 className="chat-widget__start-title">
              {call.status === 'ended' ? 'Call ended' : 'Talk to our AI assistant'}
            </h3>
            <p className="chat-widget__start-description">
              Start a voice call to speak with our AI assistant about health insurance enrollment.
              Your browser will ask for microphone access.
            </p>
            <button
              className="chat-widget__start-button"
              onClick={call.startCall}
              aria-label="Start voice call"
            >
              {call.status === 'ended' ? 'Call Again' : 'Start Call'}
            </button>
          </div>
        );

      case 'connecting':
        return (
          <div className="chat-widget__loading">
            <div className="chat-widget__spinner" aria-label="Connecting" role="status" />
            <p>Connecting your call...</p>
          </div>
        );

      case 'in-call':
        return (
          <div className="chat-widget__call">
            <div className="chat-widget__call-status" role="status" aria-live="polite">
              <div className="chat-widget__call-icon" aria-hidden="true">
                {call.isMuted ? '🔇' : '🎙️'}
              </div>
              <p className="chat-widget__call-label">
                In call{call.isMuted ? ' — microphone muted' : ''}
              </p>
            </div>
            <div className="chat-widget__call-controls">
              <button
                className="chat-widget__mute-button"
                onClick={call.toggleMute}
                aria-pressed={call.isMuted}
                aria-label={call.isMuted ? 'Unmute microphone' : 'Mute microphone'}
              >
                {call.isMuted ? 'Unmute' : 'Mute'}
              </button>
              <button
                className="chat-widget__endcall-button"
                onClick={call.endCall}
                aria-label="End call"
              >
                End Call
              </button>
            </div>
          </div>
        );

      case 'error':
        return (
          <div className="chat-widget__error">
            <p className="chat-widget__error-message">{call.error || 'An error occurred'}</p>
            <button
              className="chat-widget__start-button"
              onClick={call.startCall}
              aria-label="Retry call"
            >
              Retry
            </button>
          </div>
        );

      default:
        return null;
    }
  };

  return (
    <div className="chat-widget">
      {isOpen && (
        <div className="chat-widget__panel" role="dialog" aria-label="Support window">
          <div className="chat-widget__header">
            <h2 className="chat-widget__title">Support</h2>
            <div className="chat-widget__header-actions">
              {status === 'connected' && mode === 'chat' && (
                <button
                  className="chat-widget__end-button"
                  onClick={handleEndChat}
                  aria-label="End chat"
                >
                  End
                </button>
              )}
              <button
                className="chat-widget__close-button"
                onClick={handleToggle}
                aria-label="Close support panel"
              >
                ✕
              </button>
            </div>
          </div>

          {/* Chat / Voice mode toggle */}
          <div className="chat-widget__modes" role="tablist" aria-label="Support mode">
            <button
              role="tab"
              aria-selected={mode === 'chat'}
              className={`chat-widget__mode ${mode === 'chat' ? 'chat-widget__mode--active' : ''}`}
              onClick={() => handleSelectMode('chat')}
              disabled={callActive}
            >
              💬 Chat
            </button>
            <button
              role="tab"
              aria-selected={mode === 'voice'}
              className={`chat-widget__mode ${mode === 'voice' ? 'chat-widget__mode--active' : ''}`}
              onClick={() => handleSelectMode('voice')}
              disabled={chatActive}
            >
              📞 Voice
            </button>
          </div>

          <div className="chat-widget__body">
            {mode === 'chat' ? renderChat() : renderVoice()}
          </div>

          {/* Remote audio playback for the voice call (hidden element) */}
          <audio ref={call.audioRef} autoPlay />
        </div>
      )}
      <button
        className="chat-widget__fab"
        onClick={handleToggle}
        aria-label={isOpen ? 'Close support' : 'Open support'}
        aria-expanded={isOpen}
      >
        {isOpen ? '✕' : '💬'}
      </button>
    </div>
  );
};
