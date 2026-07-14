import { useCallback, useEffect, useMemo, useState } from "react";
import {
  api,
  type NetworkAgentData,
  type NetworkAgentStatus,
  type NetworkLocalAgentData,
  type NetworkMessageData,
  type NetworkStatusData,
  type NetworkTrustLevel,
} from "../lib/api";
import { toast } from "../lib/toast-store";
import { useTranslation } from "react-i18next";
import { handleUiAction } from "../lib/handleUiAction";

const TRUST_LEVELS: NetworkTrustLevel[] = ["trusted", "verified", "untrusted"];
const AGENT_STATUSES: NetworkAgentStatus[] = ["available", "busy", "offline", "degraded"];

interface AgentForm {
  agentId: string;
  name: string;
  endpoint: string;
  capabilities: string;
  status: NetworkAgentStatus;
  load: string;
  trustLevel: NetworkTrustLevel;
  publicKey: string;
}

const DEFAULT_AGENT_FORM: AgentForm = {
  agentId: "",
  name: "",
  endpoint: "",
  capabilities: "",
  status: "available",
  load: "0",
  trustLevel: "untrusted",
  publicKey: "",
};

function commaList(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function formatTime(value: number | null): string {
  if (!value) return "-";
  return new Date(value * 1000).toLocaleString();
}

function statusColor(status: NetworkAgentStatus | NetworkMessageData["status"]): string {
  if (status === "available" || status === "sent" || status === "received") return "var(--green)";
  if (status === "busy" || status === "queued") return "var(--cyan)";
  if (status === "degraded") return "var(--purple)";
  if (status === "failed") return "var(--red)";
  return "var(--text-tertiary)";
}

function parsePayload(value: string): Record<string, unknown> {
  if (!value.trim()) return {};
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Payload must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function StatTile({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="card" style={{ padding: "14px", minHeight: "78px" }}>
      <div style={{ fontSize: "12px", color: "var(--text-secondary)" }}>{label}</div>
      <div style={{ marginTop: "6px", fontSize: "24px", fontWeight: 700 }}>{value}</div>
    </div>
  );
}

function LocalAgentNode({ local }: { local?: NetworkLocalAgentData }) {
  const status: NetworkAgentStatus = local?.status ?? "available";
  return (
    <div
      style={{
        border: "1px solid var(--separator)",
        borderRadius: "8px",
        padding: "10px",
        background: "var(--surface)",
        minWidth: 0,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
        <span
          style={{
            width: "9px",
            height: "9px",
            borderRadius: "50%",
            background: statusColor(status),
            flex: "0 0 auto",
          }}
        />
        <strong style={{ overflowWrap: "anywhere" }}>{local?.name ?? "Primary Agent"}</strong>
      </div>
      <div style={{ marginTop: "6px", fontSize: "12px", color: "var(--text-secondary)" }}>
        {(local?.id ?? "primary") + " / local / "}
        {local?.networkEnabled ? "network on" : "network off"}
      </div>
    </div>
  );
}

function LocalAgentCard({ local }: { local: NetworkLocalAgentData }) {
  return (
    <section className="card" style={{ padding: "16px", borderRadius: "8px" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "12px",
          flexWrap: "wrap",
        }}
      >
        <div>
          <h2 style={{ fontSize: "18px" }}>This Agent</h2>
          <p style={{ marginTop: "4px", color: "var(--text-secondary)", fontSize: "12px" }}>
            Local agent identity advertised to peers in the network.
          </p>
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "8px",
            color: "var(--text-secondary)",
            fontSize: "12px",
          }}
        >
          <span
            style={{
              width: "8px",
              height: "8px",
              borderRadius: "50%",
              background: statusColor(local.status),
            }}
          />
          {local.status} / {local.networkEnabled ? "network enabled" : "network disabled"}
        </div>
      </div>

      <div
        style={{
          marginTop: "12px",
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
          gap: "10px",
        }}
      >
        <div>
          <div style={{ fontSize: "12px", color: "var(--text-secondary)" }}>Agent ID</div>
          <div style={{ marginTop: "4px", overflowWrap: "anywhere" }}>{local.id}</div>
        </div>
        <div>
          <div style={{ fontSize: "12px", color: "var(--text-secondary)" }}>Name</div>
          <div style={{ marginTop: "4px", overflowWrap: "anywhere" }}>{local.name}</div>
        </div>
        <div>
          <div style={{ fontSize: "12px", color: "var(--text-secondary)" }}>Endpoint</div>
          <div
            style={{
              marginTop: "4px",
              overflowWrap: "anywhere",
              fontFamily: "var(--font-mono)",
              fontSize: "12px",
            }}
          >
            {local.endpoint ?? "not configured"}
          </div>
        </div>
        <div>
          <div style={{ fontSize: "12px", color: "var(--text-secondary)" }}>Discovery</div>
          <div style={{ marginTop: "4px" }}>{local.discoveryMode}</div>
        </div>
        <div>
          <div style={{ fontSize: "12px", color: "var(--text-secondary)" }}>Signing key</div>
          <div style={{ marginTop: "4px" }}>
            {local.publicKey ? "advertised" : "not configured"}
            {local.hasPrivateKey ? " / outbound signing ready" : " / outbound signing missing"}
          </div>
        </div>
      </div>

      <div style={{ marginTop: "12px" }}>
        <div style={{ fontSize: "12px", color: "var(--text-secondary)" }}>Capabilities</div>
        <div style={{ marginTop: "4px", display: "flex", flexWrap: "wrap", gap: "6px" }}>
          {local.capabilities.length === 0 && (
            <span style={{ color: "var(--text-secondary)", fontSize: "12px" }}>none</span>
          )}
          {local.capabilities.map((capability) => (
            <span
              key={capability}
              style={{
                fontSize: "11px",
                padding: "2px 6px",
                borderRadius: "4px",
                background: "var(--surface-elevated, var(--background))",
                border: "1px solid var(--separator)",
              }}
            >
              {capability}
            </span>
          ))}
        </div>
      </div>

      {!local.networkEnabled && (
        <div className="alert" style={{ marginTop: "12px" }}>
          The agent network is disabled. Set <code>network.enabled: true</code> in your config and
          configure <code>network.endpoint</code> plus signing keys before peers can reach this
          agent. See the user guide&apos;s Network section for the detailed checklist.
        </div>
      )}
    </section>
  );
}

function AgentNode({ agent }: { agent: NetworkAgentData }) {
  return (
    <div
      style={{
        border: "1px solid var(--separator)",
        borderRadius: "8px",
        padding: "10px",
        background: "var(--surface)",
        minWidth: 0,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
        <span
          style={{
            width: "9px",
            height: "9px",
            borderRadius: "50%",
            background: statusColor(agent.status),
            flex: "0 0 auto",
          }}
        />
        <strong style={{ overflowWrap: "anywhere" }}>{agent.name}</strong>
      </div>
      <div style={{ marginTop: "6px", fontSize: "12px", color: "var(--text-secondary)" }}>
        {agent.id} / {agent.trustLevel} / {formatPercent(agent.load)}
      </div>
    </div>
  );
}

export function Network() {
  const { t } = useTranslation();
  const [agents, setAgents] = useState<NetworkAgentData[]>([]);
  const [messages, setMessages] = useState<NetworkMessageData[]>([]);
  const [status, setStatus] = useState<NetworkStatusData | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [agentForm, setAgentForm] = useState<AgentForm>(DEFAULT_AGENT_FORM);
  const [selectedAgentId, setSelectedAgentId] = useState("");
  const [taskDescription, setTaskDescription] = useState("");
  const [taskCapabilities, setTaskCapabilities] = useState("");
  const [taskPayload, setTaskPayload] = useState("{}");
  const [lastError, setLastError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLastError(null);
    try {
      const [agentsRes, statusRes, messagesRes] = await Promise.all([
        api.getNetworkAgents(),
        api.getNetworkStatus(),
        api.getNetworkMessages({ limit: 50 }),
      ]);
      setAgents(agentsRes.data.agents);
      setStatus(statusRes.data);
      setMessages(messagesRes.data.messages);
      setSelectedAgentId((current) => current || agentsRes.data.agents[0]?.id || "");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setLastError(message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const capableAgents = useMemo(
    () => agents.filter((agent) => !agent.blocked && agent.trustLevel !== "untrusted"),
    [agents]
  );
  const selectableAgents = capableAgents.length > 0 ? capableAgents : agents;

  const registerAgent = async () => {
    setSaving(true);
    setLastError(null);
    try {
      await api.registerNetworkAgent({
        agentId: agentForm.agentId.trim(),
        name: agentForm.name.trim(),
        endpoint: agentForm.endpoint.trim(),
        capabilities: commaList(agentForm.capabilities),
        status: agentForm.status,
        load: Number(agentForm.load) || 0,
        trustLevel: agentForm.trustLevel,
        publicKey: agentForm.publicKey.trim() || null,
      });
      setAgentForm(DEFAULT_AGENT_FORM);
      toast.success("Network agent saved");
      await load();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setLastError(message);
      toast.error(message);
    } finally {
      setSaving(false);
    }
  };

  const updateTrust = async (agent: NetworkAgentData, trustLevel: NetworkTrustLevel) => {
    await handleUiAction(async () => {
      await api.updateNetworkAgentTrust(agent.id, { trustLevel });
      await load();
    }, setLastError);
  };

  const toggleBlocked = async (agent: NetworkAgentData) => {
    await handleUiAction(async () => {
      await api.updateNetworkAgentTrust(agent.id, { blocked: !agent.blocked });
      await load();
    }, setLastError);
  };

  const removeAgent = async (agent: NetworkAgentData) => {
    await handleUiAction(async () => {
      await api.removeNetworkAgent(agent.id);
      await load();
    }, setLastError);
  };

  const delegateTask = async () => {
    if (!selectedAgentId) return;
    setSaving(true);
    setLastError(null);
    try {
      await api.delegateNetworkTask(selectedAgentId, {
        description: taskDescription.trim(),
        requiredCapabilities: commaList(taskCapabilities),
        payload: parsePayload(taskPayload),
      });
      setTaskDescription("");
      toast.success("Task request sent");
      await load();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setLastError(message);
      toast.error(message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ display: "grid", gap: "18px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: "12px" }}>
        <div>
          <h1>{t('pages.network.title')}</h1>
          <p style={{ color: "var(--text-secondary)", marginTop: "4px" }}>
            {loading ? t('common.loading') : t('pages.network.remoteAgents', { count: agents.length })}
          </p>
        </div>
        <button className="btn-ghost" onClick={load} disabled={loading}>
          Refresh
        </button>
      </div>

      {lastError && <div className="alert error">{lastError}</div>}

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
          gap: "10px",
        }}
      >
        <StatTile label="Agents" value={status?.totalAgents ?? 1} />
        <StatTile label="Available" value={status?.availableAgents ?? 1} />
        <StatTile label="Trusted" value={status?.trustedAgents ?? 1} />
        <StatTile label="Avg Load" value={formatPercent(status?.averageLoad ?? 0)} />
        <StatTile label="Messages 1h" value={status?.messagesLastHour ?? 0} />
        <StatTile label="Errors 1h" value={status?.errorsLastHour ?? 0} />
      </div>

      {status?.localAgent && <LocalAgentCard local={status.localAgent} />}

      <section style={{ display: "grid", gap: "12px" }}>
        <h2 style={{ fontSize: "18px" }}>Topology</h2>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))",
            gap: "10px",
          }}
        >
          <LocalAgentNode local={status?.localAgent} />
          {agents.map((agent) => (
            <AgentNode key={agent.id} agent={agent} />
          ))}
        </div>
      </section>

      <div className="pipeline-layout">
        <section className="card" style={{ padding: "16px", borderRadius: "8px" }}>
          <h2 style={{ fontSize: "18px", marginBottom: "12px" }}>Register Agent</h2>
          <div style={{ display: "grid", gap: "10px" }}>
            <div className="form-group">
              <label>Agent ID</label>
              <input
                value={agentForm.agentId}
                onChange={(e) => setAgentForm((form) => ({ ...form, agentId: e.target.value }))}
              />
            </div>
            <div className="form-group">
              <label>Name</label>
              <input
                value={agentForm.name}
                onChange={(e) => setAgentForm((form) => ({ ...form, name: e.target.value }))}
              />
            </div>
            <div className="form-group">
              <label>Endpoint</label>
              <input
                value={agentForm.endpoint}
                placeholder="https://agent.example.com/api/agent-network"
                onChange={(e) => setAgentForm((form) => ({ ...form, endpoint: e.target.value }))}
              />
            </div>
            <div className="form-group">
              <label>Capabilities</label>
              <input
                value={agentForm.capabilities}
                placeholder="web-search, summarization"
                onChange={(e) =>
                  setAgentForm((form) => ({ ...form, capabilities: e.target.value }))
                }
              />
            </div>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))",
                gap: "10px",
              }}
            >
              <div className="form-group">
                <label>Status</label>
                <select
                  value={agentForm.status}
                  onChange={(e) =>
                    setAgentForm((form) => ({
                      ...form,
                      status: e.target.value as NetworkAgentStatus,
                    }))
                  }
                >
                  {AGENT_STATUSES.map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
              </div>
              <div className="form-group">
                <label>Load</label>
                <input
                  type="number"
                  min={0}
                  max={1}
                  step={0.1}
                  value={agentForm.load}
                  onChange={(e) => setAgentForm((form) => ({ ...form, load: e.target.value }))}
                />
              </div>
              <div className="form-group">
                <label>Trust</label>
                <select
                  value={agentForm.trustLevel}
                  onChange={(e) =>
                    setAgentForm((form) => ({
                      ...form,
                      trustLevel: e.target.value as NetworkTrustLevel,
                    }))
                  }
                >
                  {TRUST_LEVELS.map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="form-group">
              <label>Public Key</label>
              <textarea
                value={agentForm.publicKey}
                rows={4}
                onChange={(e) => setAgentForm((form) => ({ ...form, publicKey: e.target.value }))}
                style={{ width: "100%", minHeight: "96px", resize: "vertical" }}
              />
            </div>
            <button onClick={registerAgent} disabled={saving}>
              Save Agent
            </button>
          </div>
        </section>

        <section style={{ display: "grid", gap: "14px", minWidth: 0 }}>
          <div className="card" style={{ padding: "16px", borderRadius: "8px" }}>
            <h2 style={{ fontSize: "18px", marginBottom: "12px" }}>Task Delegation</h2>
            <div style={{ display: "grid", gap: "10px" }}>
              <div className="form-group">
                <label>Agent</label>
                <select
                  value={selectedAgentId}
                  onChange={(e) => setSelectedAgentId(e.target.value)}
                >
                  {selectableAgents.map((agent) => (
                    <option key={agent.id} value={agent.id}>
                      {agent.name} ({agent.id})
                    </option>
                  ))}
                </select>
              </div>
              <div className="form-group">
                <label>Description</label>
                <input
                  value={taskDescription}
                  onChange={(e) => setTaskDescription(e.target.value)}
                />
              </div>
              <div className="form-group">
                <label>Required Capabilities</label>
                <input
                  value={taskCapabilities}
                  placeholder="summarization"
                  onChange={(e) => setTaskCapabilities(e.target.value)}
                />
              </div>
              <div className="form-group">
                <label>Payload JSON</label>
                <textarea
                  value={taskPayload}
                  rows={5}
                  onChange={(e) => setTaskPayload(e.target.value)}
                  style={{
                    width: "100%",
                    minHeight: "130px",
                    resize: "vertical",
                    fontFamily: "var(--font-mono)",
                  }}
                />
              </div>
              <button
                onClick={delegateTask}
                disabled={saving || !selectedAgentId || !taskDescription.trim()}
              >
                Send Task
              </button>
            </div>
          </div>

          <div className="card" style={{ padding: "16px", borderRadius: "8px", minWidth: 0 }}>
            <h2 style={{ fontSize: "18px", marginBottom: "12px" }}>Remote Agents</h2>
            <div style={{ display: "grid", gap: "10px" }}>
              {agents.length === 0 && (
                <div style={{ color: "var(--text-secondary)" }}>No remote agents registered.</div>
              )}
              {agents.map((agent) => (
                <div
                  key={agent.id}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "minmax(0, 1fr) auto",
                    gap: "10px",
                    alignItems: "center",
                    padding: "10px 0",
                    borderBottom: "1px solid var(--separator)",
                  }}
                >
                  <div style={{ minWidth: 0 }}>
                    <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                      <span
                        style={{
                          width: "8px",
                          height: "8px",
                          borderRadius: "50%",
                          background: statusColor(agent.status),
                        }}
                      />
                      <strong style={{ overflowWrap: "anywhere" }}>{agent.name}</strong>
                    </div>
                    <div
                      style={{
                        marginTop: "4px",
                        color: "var(--text-secondary)",
                        fontSize: "12px",
                        overflowWrap: "anywhere",
                      }}
                    >
                      {agent.endpoint}
                    </div>
                    <div style={{ marginTop: "4px", fontSize: "12px" }}>
                      {agent.capabilities.join(", ") || "-"}
                    </div>
                  </div>
                  <div style={{ display: "grid", gap: "6px", justifyItems: "end" }}>
                    <select
                      value={agent.trustLevel}
                      onChange={(e) => void updateTrust(agent, e.target.value as NetworkTrustLevel)}
                    >
                      {TRUST_LEVELS.map((value) => (
                        <option key={value} value={value}>
                          {value}
                        </option>
                      ))}
                    </select>
                    <div style={{ display: "flex", gap: "6px" }}>
                      <button
                        className="btn-ghost btn-sm"
                        onClick={() => void toggleBlocked(agent)}
                      >
                        {agent.blocked ? "Unblock" : "Block"}
                      </button>
                      <button className="btn-ghost btn-sm" onClick={() => void removeAgent(agent)}>
                        Remove
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>
      </div>

      <section className="card" style={{ padding: "16px", borderRadius: "8px" }}>
        <h2 style={{ fontSize: "18px", marginBottom: "12px" }}>Message Log</h2>
        <div style={{ display: "grid", gap: "8px" }}>
          {messages.length === 0 && (
            <div style={{ color: "var(--text-secondary)" }}>No network messages recorded.</div>
          )}
          {messages.map((message) => (
            <div
              key={message.id}
              style={{
                display: "grid",
                gridTemplateColumns: "minmax(0, 1fr) auto",
                gap: "10px",
                padding: "10px 0",
                borderBottom: "1px solid var(--separator)",
              }}
            >
              <div style={{ minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                  <span
                    style={{
                      width: "8px",
                      height: "8px",
                      borderRadius: "50%",
                      background: statusColor(message.status),
                    }}
                  />
                  <strong>{message.type}</strong>
                  <span style={{ color: "var(--text-secondary)" }}>
                    {message.from} to {message.to}
                  </span>
                </div>
                <div
                  style={{
                    marginTop: "4px",
                    color: "var(--text-secondary)",
                    fontSize: "12px",
                    overflowWrap: "anywhere",
                  }}
                >
                  {message.correlationId}
                </div>
              </div>
              <div style={{ color: "var(--text-secondary)", fontSize: "12px", textAlign: "right" }}>
                <div>{message.status}</div>
                <div>{formatTime(message.createdAt)}</div>
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
