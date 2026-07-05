import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { session } from './lib/api';
import Shell from './components/Shell';
import { LoginPage, SignupPage } from './pages/Login';
import OverviewPage from './pages/Overview';
import ActivityPage from './pages/Activity';
import WorkflowsPage from './pages/Workflows';
import WorkflowEditorPage from './pages/WorkflowEditor';
import MessageDetailPage from './pages/MessageDetail';
import AnalyticsPage from './pages/Analytics';
import SubscribersPage from './pages/Subscribers';
import IntegrationsPage from './pages/Integrations';
import ApiKeysPage from './pages/ApiKeys';

function RequireAuth({ children }: { children: React.ReactElement }) {
  return session.authed ? children : <Navigate to="/login" replace />;
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/signup" element={<SignupPage />} />
        <Route
          element={
            <RequireAuth>
              <Shell />
            </RequireAuth>
          }
        >
          <Route path="/" element={<OverviewPage />} />
          <Route path="/activity" element={<ActivityPage />} />
          <Route path="/activity/:transactionId" element={<MessageDetailPage />} />
          <Route path="/workflows" element={<WorkflowsPage />} />
          <Route path="/workflows/new" element={<WorkflowEditorPage />} />
          <Route path="/workflows/:key" element={<WorkflowEditorPage />} />
          <Route path="/analytics" element={<AnalyticsPage />} />
          <Route path="/subscribers" element={<SubscribersPage />} />
          <Route path="/integrations" element={<IntegrationsPage />} />
          <Route path="/keys" element={<ApiKeysPage />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
