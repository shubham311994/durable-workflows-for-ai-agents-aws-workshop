import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from './contexts/AuthContext';
import { RealTimeProvider } from './contexts/RealTimeContext';
import { ChatProvider } from './contexts/ChatContext';
import { CallProvider } from './contexts/CallContext';
import { AuthGuard } from './components/auth/AuthGuard';
import { Header } from './components/common/Header';
import { Sidebar } from './components/common/Sidebar';
import { Login } from './components/auth/Login';
import { ContactList } from './components/contacts/ContactList';
import { ContactDetail } from './components/contacts/ContactDetail';
import { ChatWidget } from './components/chat/ChatWidget';
import './App.css';

const CRMLayout: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="crm-layout">
    <Sidebar />
    <div className="crm-main">
      <Header />
      <main className="crm-content">
        {children}
      </main>
    </div>
  </div>
);

const App = () => {
  return (
    <AuthProvider>
      <RealTimeProvider>
        <ChatProvider>
          <CallProvider>
            <Router>
              <div className="app">
                <Routes>
                  <Route path="/login" element={<Login />} />
                  <Route
                    path="/contacts"
                    element={
                      <AuthGuard>
                        <CRMLayout>
                          <ContactList />
                        </CRMLayout>
                        <ChatWidget />
                      </AuthGuard>
                    }
                  />
                  <Route
                    path="/contacts/:contactId"
                    element={
                      <AuthGuard>
                        <CRMLayout>
                          <ContactDetail />
                        </CRMLayout>
                        <ChatWidget />
                      </AuthGuard>
                    }
                  />
                  <Route path="/" element={<Navigate to="/contacts" replace />} />
                </Routes>
              </div>
            </Router>
          </CallProvider>
        </ChatProvider>
      </RealTimeProvider>
    </AuthProvider>
  );
};

export default App;
