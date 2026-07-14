import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { session } from './lib/api';
import Shell from './components/Shell';
import { LoginPage, SignupPage } from './pages/Login';
import OverviewPage from './pages/Overview';
import ActivityPage from './pages/Activity';
import WorkflowsPage from './pages/Workflows';
import WorkflowEditorPage from './pages/workflow-editor';
import StepDrawer from './pages/workflow-editor/StepDrawer';
import StepEditorPage from './pages/workflow-editor/StepEditorPage';
import MessageDetailPage from './pages/MessageDetail';
import AnalyticsPage from './pages/Analytics';
import SubscribersPage from './pages/Subscribers';
import TopicsPage, { TopicDetailPage } from './pages/Topics';
import TemplatesPage, { TemplateEditorPage } from './pages/Templates';
import IntegrationsPage from './pages/Integrations';
import ApiKeysPage from './pages/ApiKeys';
import InboxPreviewPage from './pages/InboxPreview';
import AgentsPage from './pages/Agents';
import ConnectionsPage from './pages/Connections';
import ConversationsPage, { ConversationDetailPage } from './pages/Conversations';

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
          <Route path="/workflows/new" element={<WorkflowEditorPage />}>
            <Route path="steps/:index" element={<StepDrawer />} />
            <Route path="steps/:index/editor" element={<StepEditorPage />} />
          </Route>
          <Route path="/workflows/:key" element={<WorkflowEditorPage />}>
            <Route path="steps/:index" element={<StepDrawer />} />
            <Route path="steps/:index/editor" element={<StepEditorPage />} />
          </Route>
          <Route path="/analytics" element={<AnalyticsPage />} />
          <Route path="/subscribers" element={<SubscribersPage />} />
          <Route path="/topics" element={<TopicsPage />} />
          <Route path="/topics/:key" element={<TopicDetailPage />} />
          <Route path="/templates" element={<TemplatesPage />} />
          <Route path="/templates/new" element={<TemplateEditorPage />} />
          <Route path="/templates/:key" element={<TemplateEditorPage />} />
          <Route path="/agents" element={<AgentsPage />} />
          <Route path="/connections" element={<ConnectionsPage />} />
          <Route path="/conversations" element={<ConversationsPage />} />
          <Route path="/conversations/:id" element={<ConversationDetailPage />} />
          <Route path="/integrations" element={<IntegrationsPage />} />
          <Route path="/keys" element={<ApiKeysPage />} />
          <Route path="/inbox-preview" element={<InboxPreviewPage />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
