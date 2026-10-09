import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Contact } from '../../types';
import { useAuth } from '../../contexts/AuthContext';
import { useRealTime } from '../../contexts/RealTimeContext';
import './ContactDetail.css';

type Tab = 'overview' | 'transcriptions';

export const ContactDetail: React.FC = () => {
  const { contactId } = useParams<{ contactId: string }>();
  const [contact, setContact] = useState<Contact | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<Tab>('overview');
  const [isSubmittingReview, setIsSubmittingReview] = useState(false);

  const { user } = useAuth();
  const { subscribe, isConnected } = useRealTime();
  const navigate = useNavigate();

  useEffect(() => {
    if (contactId) fetchContactDetail(contactId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contactId]);

  useEffect(() => {
    if (!contactId) return;
    const unsubscribe = subscribe(contactId, (event) => {
      switch (event.eventType) {
        case 'CONTACT_UPDATED':
        case 'ANALYTICS_COMPLETED':
          if (event.data.contact) setContact(event.data.contact);
          else if (event.data.analytics) setContact(prev => prev ? { ...prev, analytics: event.data.analytics } : null);
          break;
        case 'SUMMARY_STREAMING':
          if (event.data.summaryChunk) {
            setContact(prev => {
              if (prev?.analytics) {
                return {
                  ...prev,
                  analytics: {
                    ...prev.analytics,
                    summary: event.data.isComplete
                      ? event.data.summary || prev.analytics.summary
                      : (prev.analytics.summary || '') + event.data.summaryChunk
                  }
                };
              }
              return prev;
            });
          }
          break;
      }
    });
    return () => unsubscribe();
  }, [contactId, subscribe]);

  const fetchContactDetail = async (id: string) => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/contacts/${id}`, {
        headers: {
          'Authorization': `Bearer ${user?.token}`,
          'Content-Type': 'application/json',
        },
      });
      if (!response.ok) throw new Error(`Failed to fetch contact: ${response.statusText}`);
      const data = await response.json();
      let parsedData;
      if (data.body && typeof data.body === 'string') parsedData = JSON.parse(data.body);
      else if (data.contact) parsedData = data;
      else throw new Error('Invalid response format');
      if (!parsedData.contact) throw new Error('Contact data missing');
      setContact(parsedData.contact);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load contact details');
      setContact(null);
    } finally {
      setIsLoading(false);
    }
  };

  const handleReviewDecision = async (decision: 'APPROVED' | 'DENIED') => {
    if (!contact?.callbackId) return;
    setIsSubmittingReview(true);
    try {
      const response = await fetch(`/api/contacts/${contactId}/review`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${user?.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          decision,
          callbackId: contact.callbackId,
          reason: '',
        }),
      });
      if (!response.ok) throw new Error('Failed to submit review');
      if (contactId) fetchContactDetail(contactId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to submit review');
    } finally {
      setIsSubmittingReview(false);
    }
  };

  const formatDate = (dateString: string) => {
    const d = new Date(dateString.endsWith('Z') ? dateString : dateString + 'Z');
    return isNaN(d.getTime()) ? 'N/A' : d.toLocaleString();
  };

  const getSentimentColor = (sentiment?: string) => {
    switch (sentiment) {
      case 'POSITIVE': return '#16a34a';
      case 'NEGATIVE': return '#dc2626';
      case 'NEUTRAL': return '#6b7280';
      case 'MIXED': return '#d97706';
      default: return '#6b7280';
    }
  };

  const getSentimentForTranscription = (transcription: any) => {
    if (!contact?.analytics?.sentiment?.segments || !contact?.transcriptions) return null;
    const sorted = [...contact.transcriptions]
      .filter(t => t.text && t.timestamp && !isNaN(new Date(t.timestamp).getTime()) && t.confidence !== 0)
      .sort((a, b) => (a.sequenceNumber || 0) - (b.sequenceNumber || 0));
    const lineNumber = sorted.findIndex(t =>
      t.sequenceNumber === transcription.sequenceNumber &&
      t.timestamp === transcription.timestamp &&
      t.text === transcription.text
    ) + 1;
    if (lineNumber === 0) return null;
    return contact.analytics.sentiment.segments.find(s => s.lineNumber === lineNumber) || null;
  };

  if (isLoading) {
    return <div className="crm-page"><div className="loading">Loading contact details...</div></div>;
  }

  if (error || !contact) {
    return (
      <div className="crm-page">
        <div className="error">
          {error || 'Contact not found'}
          <button onClick={() => navigate('/contacts')} className="button" style={{ marginTop: '12px' }}>Back to Contacts</button>
        </div>
      </div>
    );
  }

  const validTranscriptions = (contact.transcriptions || [])
    .filter(t => t.text && t.timestamp && !isNaN(new Date(t.timestamp).getTime()) && t.confidence !== 0)
    .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

  return (
    <div className="crm-page">
      {/* Breadcrumb + actions */}
      <div className="detail-topbar">
        <div className="breadcrumb">
          <button onClick={() => navigate('/contacts')} className="breadcrumb-link">Contacts</button>
          <span className="breadcrumb-sep">/</span>
          <span className="breadcrumb-current">{contact.id}</span>
        </div>
        <div className="topbar-actions">
          <div className={`live-badge ${isConnected ? 'connected' : 'disconnected'}`}>
            <span className="live-dot" />
            {isConnected ? 'Live' : 'Offline'}
          </div>
        </div>
      </div>

      {/* Contact header card */}
      <div className="record-header">
        <div className="record-header-left">
          <h1 className="record-title">{contact.id}</h1>
          <span className={`status-pill status-${contact.status.toLowerCase().replace('_', '-')}`}>
            {contact.status === 'IN_PROGRESS' ? 'In Progress' : contact.status.charAt(0) + contact.status.slice(1).toLowerCase()}
          </span>
        </div>
        <div className="record-meta-row">
          {(contact.firstName || contact.lastName) && (
            <div className="record-meta-item">
              <span className="meta-label">Caller</span>
              <span className="meta-value">{`${contact.firstName || ''} ${contact.lastName || ''}`.trim()}</span>
            </div>
          )}
          {contact.phoneNumber && (
            <div className="record-meta-item">
              <span className="meta-label">Phone</span>
              <span className="meta-value">{contact.phoneNumber}</span>
            </div>
          )}
          {contact.state && (
            <div className="record-meta-item">
              <span className="meta-label">State</span>
              <span className="meta-value">{contact.state}</span>
            </div>
          )}
          <div className="record-meta-item">
            <span className="meta-label">Created</span>
            <span className="meta-value">{formatDate(contact.createdAt)}</span>
          </div>
          <div className="record-meta-item">
            <span className="meta-label">Updated</span>
            <span className="meta-value">{formatDate(contact.updatedAt)}</span>
          </div>
          {contact.metadata.totalDuration != null && (
            <div className="record-meta-item">
              <span className="meta-label">Duration</span>
              <span className="meta-value">{contact.metadata.totalDuration}s</span>
            </div>
          )}
          {contact.metadata.participantCount != null && (
            <div className="record-meta-item">
              <span className="meta-label">Participants</span>
              <span className="meta-value">{contact.metadata.participantCount}</span>
            </div>
          )}
          <div className="record-meta-item">
            <span className="meta-label">Transcriptions</span>
            <span className="meta-value">{validTranscriptions.length}</span>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="detail-tabs">
        <button className={`tab-btn ${activeTab === 'overview' ? 'active' : ''}`} onClick={() => setActiveTab('overview')}>
          Overview
        </button>
        <button className={`tab-btn ${activeTab === 'transcriptions' ? 'active' : ''}`} onClick={() => setActiveTab('transcriptions')}>
          Transcriptions ({validTranscriptions.length})
        </button>
      </div>

      {/* Tab content */}
      {activeTab === 'overview' && (
        <div className="detail-grid">
          {/* Supervisor Review Panel */}
          {contact.reviewStatus === 'PENDING_REVIEW' && (
            <div className="detail-card detail-card-full review-panel">
              <h3 className="card-title">⚠️ Supervisor Review Required</h3>
              <p className="review-description">
                This contact was flagged as <strong>HIGH</strong> risk by the fraud assessment.
                Please review the eligibility and fraud details below, then approve or deny this application.
              </p>
              <div className="review-actions">
                <button
                  className="btn-approve"
                  onClick={() => handleReviewDecision('APPROVED')}
                  disabled={isSubmittingReview}
                >
                  ✓ Approve
                </button>
                <button
                  className="btn-deny"
                  onClick={() => handleReviewDecision('DENIED')}
                  disabled={isSubmittingReview}
                >
                  ✗ Deny
                </button>
              </div>
            </div>
          )}

          {/* Review Decision (for already-reviewed contacts) */}
          {contact.reviewStatus && contact.reviewStatus !== 'PENDING_REVIEW' && contact.reviewStatus !== 'AUTO_APPROVED' && (
            <div className="detail-card detail-card-full">
              <h3 className="card-title">Review Decision</h3>
              <span className={`status-pill review-${contact.reviewStatus.toLowerCase()}`}>
                {contact.reviewStatus}
              </span>
            </div>
          )}

          {/* Summary */}
          {contact.analytics?.summary && (
            <div className="detail-card detail-card-full">
              <h3 className="card-title">Summary</h3>
              <p className="summary-text">{contact.analytics.summary}</p>
            </div>
          )}

          {/* Eligibility */}
          {contact.eligibility && (
            <div className="detail-card">
              <h3 className="card-title">Eligibility</h3>
              <div className="eligibility-status">
                <span className={`status-pill ${contact.eligibility.eligible ? 'status-completed' : 'status-failed'}`}>
                  {contact.eligibility.eligible ? 'Eligible' : 'Not Eligible'}
                </span>
              </div>
              <p className="eligibility-reason">{contact.eligibility.reason}</p>
              {contact.eligibility.plans.length > 0 && (
                <div className="eligibility-plans">
                  <span className="plans-label">Available Plans</span>
                  <div className="topics-cell">
                    {contact.eligibility.plans.map((plan, idx) => (
                      <span key={idx} className="topic-chip">{plan}</span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Address Verification */}
          {contact.addressVerification && (
            <div className="detail-card">
              <h3 className="card-title">Address Verification</h3>
              <div className="fraud-header">
                <span className={`status-pill ${contact.addressVerification.stateMatch ? 'status-completed' : 'status-failed'}`}>
                  {contact.addressVerification.stateMatch ? 'State Match' : 'State Mismatch'}
                </span>
                {contact.addressVerification.confidence > 0 && (
                  <span className="fraud-score">Confidence: {(contact.addressVerification.confidence * 100).toFixed(0)}%</span>
                )}
              </div>
              <p className="eligibility-reason">{contact.addressVerification.reason}</p>
              {contact.addressVerification.geocodedState && (
                <div className="meta-row">
                  <span className="meta-label">Geocoded State</span>
                  <span className="meta-value">{contact.addressVerification.geocodedState}</span>
                </div>
              )}
              {contact.addressVerification.formattedAddress && (
                <div className="meta-row">
                  <span className="meta-label">Formatted Address</span>
                  <span className="meta-value">{contact.addressVerification.formattedAddress}</span>
                </div>
              )}
            </div>
          )}

          {/* Fraud Assessment */}
          {contact.fraudAssessment && (
            <div className="detail-card">
              <h3 className="card-title">Fraud Assessment</h3>
              <div className="fraud-header">
                <span className={`status-pill fraud-${contact.fraudAssessment.riskLevel.toLowerCase()}`}>
                  {contact.fraudAssessment.riskLevel} Risk
                </span>
                <span className="fraud-score">Score: {(contact.fraudAssessment.riskScore * 100).toFixed(0)}%</span>
              </div>
              <p className="fraud-summary">{contact.fraudAssessment.summary}</p>
              {contact.fraudAssessment.flags.length > 0 && (
                <div className="fraud-flags">
                  {contact.fraudAssessment.flags.map((flag, idx) => (
                    <div key={idx} className="fraud-flag">⚠ {flag}</div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Sentiment */}
          {contact.analytics?.sentiment && (
            <div className="detail-card">
              <h3 className="card-title">Sentiment</h3>
              <div className="sentiment-display">
                <span className="sentiment-big" style={{ color: getSentimentColor(contact.analytics.sentiment.overall) }}>
                  {contact.analytics.sentiment.overall}
                </span>
                <span className="sentiment-conf">
                  {(contact.analytics.sentiment.confidence * 100).toFixed(1)}% confidence
                </span>
              </div>
              {contact.analytics.sentiment.segments.length > 0 && (
                <div className="segment-list">
                  {contact.analytics.sentiment.segments.map((seg, idx) => (
                    <div key={idx} className="segment-row">
                      <span className="segment-sentiment" style={{ color: getSentimentColor(seg.sentiment) }}>
                        {seg.sentiment}
                      </span>
                      {seg.text && <span className="segment-text">{seg.text}</span>}
                      <span className="segment-conf">{(seg.confidence * 100).toFixed(0)}%</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Topics */}
          {contact.analytics?.topics && contact.analytics.topics.length > 0 && (
            <div className="detail-card">
              <h3 className="card-title">Topics</h3>
              <div className="topics-list">
                {contact.analytics.topics.map((topic, idx) => (
                  <div key={idx} className="topic-row">
                    <span className="topic-name">{topic.name}</span>
                    <div className="topic-bar-wrap">
                      <div className="topic-bar" style={{ width: `${topic.confidence * 100}%` }} />
                    </div>
                    <span className="topic-mentions">{topic.mentions} mentions</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {activeTab === 'transcriptions' && (
        <div className="transcript-panel">
          {validTranscriptions.map((t, idx) => {
            const sentiment = getSentimentForTranscription(t);
            return (
              <div key={idx} className={`transcript-msg transcript-${(t.speaker || 'unknown').toLowerCase()}`}>
                <div className="msg-header">
                  <span className={`msg-speaker speaker-${(t.speaker || 'unknown').toLowerCase()}`}>
                    {t.speaker || 'Unknown'}
                  </span>
                  <span className="msg-time">{formatDate(t.timestamp)}</span>
                  {sentiment && (
                    <span className="msg-sentiment" style={{ color: getSentimentColor(sentiment.sentiment) }}>
                      {sentiment.sentiment}
                    </span>
                  )}
                </div>
                <p className="msg-text">{t.text}</p>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
