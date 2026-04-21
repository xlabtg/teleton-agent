import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { useEffect, useState } from "react";
import { Layout } from "./components/Layout";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { ToastContainer } from "./components/ToastContainer";
import { ConfirmDialogProvider } from "./components/ConfirmDialog";
import { CommandPalette } from "./components/CommandPalette";
import { Dashboard } from "./pages/Dashboard";
import { Tools } from "./pages/Tools";
import { Plugins } from "./pages/Plugins";
import { Soul } from "./pages/Soul";
import { Memory } from "./pages/Memory";
import { Workspace } from "./pages/Workspace";
import { Tasks } from "./pages/Tasks";
import { Workflows } from "./pages/Workflows";
import { Mcp } from "./pages/Mcp";
import { Config } from "./pages/Config";
import { Hooks } from "./pages/Hooks";
import { Sessions } from "./pages/Sessions";
import { Analytics } from "./pages/Analytics";
import { Security } from "./pages/Security";
import { SelfImprove } from "./pages/SelfImprove";
import { Autonomous } from "./pages/Autonomous";
import { Setup } from "./pages/Setup";
import { SetupLayout } from "./components/setup/SetupLayout";
import { checkAuth, login } from "./lib/api";
import { logStore } from "./lib/log-store";

function App() {
  // Setup route bypasses auth entirely
  if (window.location.pathname.startsWith("/setup")) {
    return (
      <BrowserRouter>
        <ErrorBoundary>
          <Routes>
            <Route path="/setup" element={<SetupLayout />}>
              <Route index element={<Setup />} />
            </Route>
          </Routes>
        </ErrorBoundary>
      </BrowserRouter>
    );
  }

  return <AuthenticatedApp />;
}

function AuthenticatedApp() {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [tokenInput, setTokenInput] = useState("");
  const [loginError, setLoginError] = useState("");

  useEffect(() => {
    // Check for token exchange (from setup launch flow)
    const params = new URLSearchParams(window.location.search);
    const exchangeToken = params.get("token");
    if (window.location.pathname === "/auth/exchange" && exchangeToken) {
      login(exchangeToken).then((success) => {
        if (success) {
          window.location.href = "/";
        } else {
          setLoading(false);
          setLoginError("Token exchange failed");
        }
      });
      return;
    }

    // Check if we already have a valid session cookie
    checkAuth().then((valid) => {
      setIsAuthenticated(valid);
      setLoading(false);
    });
  }, []);

  useEffect(() => {
    if (isAuthenticated) {
      logStore.connect();
    }
  }, [isAuthenticated]);

  const handleLogin = async () => {
    const token = tokenInput.trim();
    if (!token) return;

    setLoginError("");
    const success = await login(token);
    if (success) {
      setIsAuthenticated(true);
    } else {
      setLoginError("Invalid token");
    }
  };

  if (loading) {
    return (
      <div className="login-container">
        <div className="login-card">
          <p>Loading...</p>
        </div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <div className="login-container">
        <div className="login-card">
          <h1>Teleton</h1>
          <p>Enter your authentication token to access the dashboard.</p>
          <div className="form-group">
            <label>Token</label>
            <input
              type="password"
              value={tokenInput}
              onChange={(e) => setTokenInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleLogin()}
              placeholder="Paste token from config..."
              style={{ width: "100%" }}
            />
          </div>
          {loginError && (
            <div className="alert error" style={{ marginBottom: "1rem" }}>
              {loginError}
            </div>
          )}
          <button onClick={handleLogin} style={{ width: "100%" }}>
            Sign In
          </button>
        </div>
      </div>
    );
  }

  return (
    <BrowserRouter>
      <ErrorBoundary>
        <ConfirmDialogProvider>
          <Routes>
            <Route path="/" element={<Layout />}>
              <Route index element={<Dashboard />} />
              <Route path="tools" element={<Tools />} />
              <Route path="plugins" element={<Plugins />} />
              <Route path="soul" element={<Soul />} />
              <Route path="memory" element={<Memory />} />
              <Route path="workspace" element={<Workspace />} />
              <Route path="tasks" element={<Tasks />} />
              <Route path="workflows" element={<Workflows />} />
              <Route path="mcp" element={<Mcp />} />
              <Route path="config" element={<Config />} />
              <Route path="hooks" element={<Hooks />} />
              <Route path="sessions" element={<Sessions />} />
              <Route path="analytics" element={<Analytics />} />
              <Route path="security" element={<Security />} />
              <Route path="self-improve" element={<SelfImprove />} />
              <Route path="autonomous" element={<Autonomous />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Route>
          </Routes>
          <CommandPalette />
          <ToastContainer />
        </ConfirmDialogProvider>
      </ErrorBoundary>
    </BrowserRouter>
  );
}

export default App;
export { AuthenticatedApp };
