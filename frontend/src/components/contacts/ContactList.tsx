import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Contact } from '../../types';
import { useAuth } from '../../contexts/AuthContext';
import { useRealTime } from '../../contexts/RealTimeContext';
import './ContactList.css';

export const ContactList: React.FC = () => {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [filteredContacts, setFilteredContacts] = useState<Contact[]>([]);
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('ALL');
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nextToken, setNextToken] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);

  const { user } = useAuth();
  const { subscribeToAll, isConnected } = useRealTime();
  const navigate = useNavigate();

  useEffect(() => {
    fetchContacts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    filterContacts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contacts, searchTerm, statusFilter]);

  useEffect(() => {
    const unsubscribe = subscribeToAll((event) => {
      switch (event.eventType) {
        case 'CONTACT_CREATED':
          if (event.data.contact) {
            setContacts(prev => {
              const exists = prev.some(c => c.id === event.data.contact!.id);
              if (exists) return prev;
              return [event.data.contact!, ...prev];
            });
          }
          break;
        case 'CONTACT_UPDATED':
        case 'ANALYTICS_COMPLETED':
          if (event.data.contact) {
            setContacts(prev => prev.map(c =>
              c.id === event.contactId ? event.data.contact! : c
            ));
          } else if (event.data.analytics) {
            setContacts(prev => prev.map(c =>
              c.id === event.contactId ? { ...c, analytics: event.data.analytics } : c
            ));
          }
          break;
        case 'SUMMARY_STREAMING':
          if (event.data.summaryChunk) {
            setContacts(prev => prev.map(c => {
              if (c.id === event.contactId && c.analytics) {
                return {
                  ...c,
                  analytics: {
                    ...c.analytics,
                    summary: event.data.isComplete
                      ? event.data.summary || c.analytics.summary
                      : (c.analytics.summary || '') + event.data.summaryChunk
                  }
                };
              }
              return c;
            }));
          }
          break;
      }
    });
    return () => unsubscribe();
  }, [subscribeToAll]);

  const fetchContacts = async (loadMore: boolean = false) => {
    if (loadMore) {
      setIsLoadingMore(true);
    } else {
      setIsLoading(true);
      setContacts([]);
      setNextToken(null);
      setHasMore(true);
    }
    setError(null);

    try {
      let url = '/api/contacts?limit=50';
      if (loadMore && nextToken) {
        url += `&next_token=${encodeURIComponent(nextToken)}`;
      }

      const response = await fetch(url, {
        headers: {
          'Authorization': `Bearer ${user?.token}`,
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch contacts: ${response.statusText}`);
      }

      const data = await response.json();
      let parsedData: any;
      if (data.body && typeof data.body === 'string') {
        parsedData = JSON.parse(data.body);
      } else if (data.contacts) {
        parsedData = data;
      } else {
        throw new Error('Invalid response format: no contacts data found');
      }

      if (!parsedData || !parsedData.contacts || !Array.isArray(parsedData.contacts)) {
        throw new Error('Invalid response format: contacts is not an array');
      }

      if (loadMore) {
        setContacts(prev => [...prev, ...parsedData.contacts]);
      } else {
        setContacts(parsedData.contacts);
      }

      setNextToken(parsedData.next_token || null);
      setHasMore(!!parsedData.next_token);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load contacts');
      if (!loadMore) setContacts([]);
    } finally {
      setIsLoading(false);
      setIsLoadingMore(false);
    }
  };

  const filterContacts = () => {
    let filtered = [...contacts];
    if (searchTerm) {
      const term = searchTerm.toLowerCase();
      filtered = filtered.filter(contact =>
        contact.id.toLowerCase().includes(term) ||
        contact.analytics?.summary?.toLowerCase().includes(term) ||
        (contact.firstName && contact.firstName.toLowerCase().includes(term)) ||
        (contact.lastName && contact.lastName.toLowerCase().includes(term))
      );
    }
    if (statusFilter !== 'ALL') {
      filtered = filtered.filter(contact => contact.status === statusFilter);
    }
    filtered.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    setFilteredContacts(filtered);
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

  const statusCounts = {
    all: contacts.length,
    inProgress: contacts.filter(c => c.status === 'IN_PROGRESS').length,
    completed: contacts.filter(c => c.status === 'COMPLETED').length,
    failed: contacts.filter(c => c.status === 'FAILED').length,
  };

  if (error) {
    return (
      <div className="crm-page">
        <div className="error">
          {error}
          <button onClick={() => fetchContacts(false)} className="button" style={{ marginTop: '12px' }}>
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="crm-page">
      <div className="page-header">
        <div className="page-header-left">
          <h1 className="page-title">Contacts</h1>
          <div className={`live-badge ${isConnected ? 'connected' : 'disconnected'}`}>
            <span className="live-dot" />
            {isConnected ? 'Live' : 'Offline'}
          </div>
        </div>
        <button onClick={() => fetchContacts(false)} className="button btn-secondary">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="14" height="14">
            <polyline points="23 4 23 10 17 10" />
            <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
          </svg>
          Refresh
        </button>
      </div>

      {/* Stats cards */}
      <div className="stats-row">
        <div className="stat-card">
          <span className="stat-value">{statusCounts.all}</span>
          <span className="stat-label">Total Contacts</span>
        </div>
        <div className="stat-card stat-progress">
          <span className="stat-value">{statusCounts.inProgress}</span>
          <span className="stat-label">In Progress</span>
        </div>
        <div className="stat-card stat-completed">
          <span className="stat-value">{statusCounts.completed}</span>
          <span className="stat-label">Completed</span>
        </div>
        <div className="stat-card stat-failed">
          <span className="stat-value">{statusCounts.failed}</span>
          <span className="stat-label">Failed</span>
        </div>
      </div>

      {/* Filters */}
      <div className="table-toolbar">
        <div className="toolbar-left">
          <div className="table-search">
            <svg className="table-search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input
              type="text"
              placeholder="Search by ID or summary..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="table-search-input"
            />
          </div>
          <div className="filter-pills">
            {(['ALL', 'IN_PROGRESS', 'COMPLETED', 'FAILED'] as const).map(status => (
              <button
                key={status}
                className={`filter-pill ${statusFilter === status ? 'active' : ''}`}
                onClick={() => setStatusFilter(status)}
              >
                {status === 'ALL' ? 'All' : status === 'IN_PROGRESS' ? 'In Progress' : status.charAt(0) + status.slice(1).toLowerCase()}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Table */}
      <div className="table-container">
        <table className="crm-table">
          <thead>
            <tr>
              <th>Contact ID</th>
              <th>Caller</th>
              <th>Status</th>
              <th>Eligibility</th>
              <th>Risk</th>
              <th>Sentiment</th>
              <th>Topics</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              Array.from({ length: 4 }).map((_, i) => (
                <tr key={i} className="skeleton-row">
                  <td><div className="skel skel-text" /></td>
                  <td><div className="skel skel-text" /></td>
                  <td><div className="skel skel-badge" /></td>
                  <td><div className="skel skel-badge" /></td>
                  <td><div className="skel skel-badge" /></td>
                  <td><div className="skel skel-badge" /></td>
                  <td><div className="skel skel-text" /></td>
                  <td><div className="skel skel-text" /></td>
                </tr>
              ))
            ) : filteredContacts.length === 0 ? (
              <tr>
                <td colSpan={8} className="empty-state">
                  <div className="empty-content">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" width="40" height="40">
                      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                      <circle cx="9" cy="7" r="4" />
                      <line x1="17" y1="11" x2="23" y2="11" />
                    </svg>
                    <p>No contacts found</p>
                    {(searchTerm || statusFilter !== 'ALL') && (
                      <button className="button btn-secondary" onClick={() => { setSearchTerm(''); setStatusFilter('ALL'); }}>
                        Clear Filters
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ) : (
              filteredContacts.map(contact => (
                <tr key={contact.id} className="table-row" onClick={() => navigate(`/contacts/${contact.id}`)}>
                  <td>
                    <span className="contact-id-cell">{contact.id}</span>
                  </td>
                  <td>
                    {contact.firstName || contact.lastName
                      ? `${contact.firstName || ''} ${contact.lastName || ''}`.trim()
                      : <span className="no-data">—</span>}
                  </td>
                  <td>
                    <span className={`status-pill status-${contact.status.toLowerCase().replace('_', '-')}`}>
                      {contact.status === 'IN_PROGRESS' ? 'In Progress' : contact.status.charAt(0) + contact.status.slice(1).toLowerCase()}
                    </span>
                  </td>
                  <td>
                    {contact.eligibility ? (
                      <span className={`status-pill ${contact.eligibility.eligible ? 'status-completed' : 'status-failed'}`}>
                        {contact.eligibility.eligible ? 'Eligible' : 'Not Eligible'}
                      </span>
                    ) : (
                      <span className="no-data">—</span>
                    )}
                  </td>
                  <td>
                    {contact.fraudAssessment ? (
                      <span className={`status-pill fraud-${contact.fraudAssessment.riskLevel.toLowerCase()}`}>
                        {contact.fraudAssessment.riskLevel}
                      </span>
                    ) : (
                      <span className="no-data">—</span>
                    )}
                  </td>
                  <td>
                    {contact.analytics?.sentiment ? (
                      <span className="sentiment-pill" style={{ color: getSentimentColor(contact.analytics.sentiment.overall) }}>
                        <span className="sentiment-dot" style={{ backgroundColor: getSentimentColor(contact.analytics.sentiment.overall) }} />
                        {contact.analytics.sentiment.overall}
                      </span>
                    ) : (
                      <span className="no-data">—</span>
                    )}
                  </td>
                  <td>
                    <div className="topics-cell">
                      {contact.analytics?.topics?.slice(0, 2).map((topic, idx) => (
                        <span key={idx} className="topic-chip">{topic.name}</span>
                      ))}
                      {(contact.analytics?.topics?.length || 0) > 2 && (
                        <span className="topic-more">+{(contact.analytics?.topics?.length || 0) - 2}</span>
                      )}
                      {!contact.analytics?.topics?.length && <span className="no-data">—</span>}
                    </div>
                  </td>
                  <td className="date-cell">{formatDate(contact.createdAt)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {hasMore && !searchTerm && statusFilter === 'ALL' && !isLoading && (
        <div className="load-more-row">
          <button onClick={() => fetchContacts(true)} className="button btn-secondary" disabled={isLoadingMore}>
            {isLoadingMore ? 'Loading...' : 'Load More'}
          </button>
        </div>
      )}
    </div>
  );
};
