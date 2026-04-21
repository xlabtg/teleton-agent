import { Link, useLocation } from "react-router-dom";
import { Shell } from "./Shell";
import { AgentControl } from "./AgentControl";
import { NotificationBell } from "./NotificationBell";
import { logout } from "../lib/api";
import { useTheme } from "../hooks/useTheme";
import { openCommandPalette } from "./CommandPalette";

function DashboardNav() {
  const location = useLocation();
  const isActive = (path: string) => location.pathname === path;
  const { theme, toggleTheme } = useTheme();

  const handleLogout = async () => {
    await logout();
    window.location.href = "/";
  };

  return (
    <>
      <nav aria-label="Main navigation">
        <button
          className="cmd-k-hint"
          onClick={openCommandPalette}
          title="Open command palette (Ctrl+K)"
          aria-label="Open command palette"
          style={{ width: "100%", marginBottom: "4px", justifyContent: "space-between" }}
        >
          <span>Search...</span>
          <span>
            <kbd>⌘</kbd>
            <kbd>K</kbd>
          </span>
        </button>
        <Link to="/" className={isActive("/") ? "active" : ""}>
          Dashboard
        </Link>
        <Link to="/tools" className={isActive("/tools") ? "active" : ""}>
          Tools
        </Link>
        <Link to="/plugins" className={isActive("/plugins") ? "active" : ""}>
          Plugins
        </Link>
        <Link to="/soul" className={isActive("/soul") ? "active" : ""}>
          Soul
        </Link>
        <Link to="/memory" className={isActive("/memory") ? "active" : ""}>
          Memory
        </Link>
        <Link to="/workspace" className={isActive("/workspace") ? "active" : ""}>
          Workspace
        </Link>
        <Link to="/tasks" className={isActive("/tasks") ? "active" : ""}>
          Tasks
        </Link>
        <Link to="/workflows" className={isActive("/workflows") ? "active" : ""}>
          Workflows
        </Link>
        <Link to="/mcp" className={isActive("/mcp") ? "active" : ""}>
          MCP
        </Link>
        <Link to="/hooks" className={isActive("/hooks") ? "active" : ""}>
          Hooks
        </Link>
        <Link to="/sessions" className={isActive("/sessions") ? "active" : ""}>
          Sessions
        </Link>
        <Link to="/analytics" className={isActive("/analytics") ? "active" : ""}>
          Analytics
        </Link>
        <Link to="/security" className={isActive("/security") ? "active" : ""}>
          Security
        </Link>
        <Link to="/self-improve" className={isActive("/self-improve") ? "active" : ""}>
          Self-Improve
        </Link>
        <Link to="/autonomous" className={isActive("/autonomous") ? "active" : ""}>
          🤖 Autonomous
        </Link>
        <Link to="/config" className={isActive("/config") ? "active" : ""}>
          Config
        </Link>
      </nav>
      <div style={{ marginTop: "auto" }}>
        <AgentControl />
        <div style={{ padding: "0 12px 14px" }}>
          <button
            onClick={toggleTheme}
            className="btn-ghost"
            title={theme === "dark" ? "Switch to Light Mode" : "Switch to Dark Mode"}
            style={{
              width: "100%",
              fontSize: "13px",
              marginBottom: "8px",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: "6px",
            }}
          >
            {theme === "dark" ? (
              <>
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <circle cx="12" cy="12" r="5" />
                  <line x1="12" y1="1" x2="12" y2="3" />
                  <line x1="12" y1="21" x2="12" y2="23" />
                  <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
                  <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
                  <line x1="1" y1="12" x2="3" y2="12" />
                  <line x1="21" y1="12" x2="23" y2="12" />
                  <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
                  <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
                </svg>
                Light Mode
              </>
            ) : (
              <>
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
                </svg>
                Dark Mode
              </>
            )}
          </button>
          <button onClick={handleLogout} style={{ width: "100%", opacity: 0.7, fontSize: "13px" }}>
            Logout
          </button>
          <div
            style={{
              marginTop: "8px",
              textAlign: "center",
              fontSize: "11px",
              opacity: 0.4,
              userSelect: "none",
            }}
          >
            v{__BUILD_VERSION__} ({__BUILD_COMMIT__})
          </div>
        </div>
      </div>
    </>
  );
}

function TopBar() {
  return (
    <div className="topbar-controls" role="toolbar" aria-label="Top bar controls">
      <NotificationBell />
    </div>
  );
}

export function Layout() {
  return <Shell sidebar={<DashboardNav />} topBar={<TopBar />} />;
}
