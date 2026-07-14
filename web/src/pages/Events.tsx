import { useEffect, useMemo, useState } from "react";
import {
  api,
  EventLogEntry,
  WebhookDeliveryData,
  WebhookRegistrationData,
} from "../lib/api";
import { useTranslation } from "react-i18next";
import { handleUiAction } from "../lib/handleUiAction";

function fmtTime(value: string | number | null): string {
  if (value === null) return "-";
  const date = typeof value === "number" ? new Date(value) : new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString();
}

function eventPreview(payload: Record<string, unknown>): string {
  const text = JSON.stringify(payload);
  return text.length > 140 ? `${text.slice(0, 140)}...` : text;
}

function statusColor(status: WebhookDeliveryData["status"]): string {
  if (status === "delivered") return "var(--green)";
  if (status === "failed") return "var(--red)";
  if (status === "retrying") return "var(--accent)";
  return "var(--text-secondary)";
}

export function Events() {
  const { t } = useTranslation();
  const [events, setEvents] = useState<EventLogEntry[]>([]);
  const [eventTypes, setEventTypes] = useState<string[]>([]);
  const [webhooks, setWebhooks] = useState<WebhookRegistrationData[]>([]);
  const [deliveries, setDeliveries] = useState<WebhookDeliveryData[]>([]);
  const [selectedWebhookId, setSelectedWebhookId] = useState<string>("");
  const [filterType, setFilterType] = useState("");
  const [form, setForm] = useState({
    url: "",
    events: "agent.message.received",
    secret: "",
    maxRetries: 5,
    active: true,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const selectedWebhook = useMemo(
    () => webhooks.find((webhook) => webhook.id === selectedWebhookId) ?? null,
    [selectedWebhookId, webhooks]
  );

  const loadEvents = async () => {
    const result = await api.eventsList({ type: filterType || undefined, limit: 100 });
    setEvents(result.data.events);
  };

  const loadWebhooks = async () => {
    const result = await api.webhooksList();
    setWebhooks(result.data);
    setSelectedWebhookId((current) => current || result.data[0]?.id || "");
  };

  const loadDeliveries = async (id: string) => {
    if (!id) {
      setDeliveries([]);
      return;
    }
    const result = await api.webhookDeliveries(id);
    setDeliveries(result.data);
  };

  const loadAll = async () => {
    setLoading(true);
    setError(null);
    try {
      const [types] = await Promise.all([api.eventTypes(), loadEvents(), loadWebhooks()]);
      setEventTypes(types.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadAll();
    const disconnect = api.connectEvents((event) => {
      setEvents((current) => [event, ...current].slice(0, 100));
    });
    return disconnect;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    loadDeliveries(selectedWebhookId).catch((err) =>
      setError(err instanceof Error ? err.message : String(err))
    );
  }, [selectedWebhookId]);

  const createWebhook = async () => {
    setError(null);
    try {
      const events = form.events
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
      await api.webhooksCreate({
        url: form.url.trim(),
        events,
        secret: form.secret.trim() || undefined,
        active: form.active,
        maxRetries: form.maxRetries,
      });
      setForm((current) => ({ ...current, url: "", secret: "" }));
      await loadWebhooks();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const toggleWebhook = async (webhook: WebhookRegistrationData) => {
    try {
      await api.webhooksUpdate(webhook.id, { active: !webhook.active });
      await loadWebhooks();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const deleteWebhook = async (id: string) => {
    try {
      await api.webhooksDelete(id);
      setSelectedWebhookId("");
      await loadWebhooks();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const testWebhook = async (id: string) => {
    try {
      await api.webhookTest(id);
      await loadDeliveries(id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const retryDelivery = async (delivery: WebhookDeliveryData) => {
    try {
      await api.webhookRetry(delivery.webhookId, delivery.id);
      await loadDeliveries(delivery.webhookId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const replayEvent = async (id: string) => {
    try {
      await api.eventReplay(id);
      await loadEvents();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div>
      <div className="header">
        <h1>{t('pages.events.title')}</h1>
        <p>{t('pages.events.subtitle')}</p>
      </div>

      {error && (
        <div
          className="alert error"
          style={{
            marginBottom: 14,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <span>{error}</span>
          <button className="btn-ghost btn-sm" onClick={() => setError(null)}>
            Dismiss
          </button>
        </div>
      )}

      <div className="events-layout">
        <div className="card" style={{ padding: 0, overflowX: "auto" }}>
          <div
            style={{
              display: "flex",
              gap: 8,
              padding: 14,
              borderBottom: "1px solid var(--separator)",
              alignItems: "center",
            }}
          >
            <select
              value={filterType}
              onChange={(e) => setFilterType(e.target.value)}
              style={{ minWidth: 220 }}
            >
              <option value="">All event types</option>
              {eventTypes.map((type) => (
                <option key={type} value={type}>
                  {type}
                </option>
              ))}
            </select>
            <button onClick={loadEvents}>Refresh</button>
          </div>
          {loading ? (
            <div style={{ padding: 24, color: "var(--text-secondary)" }}>Loading...</div>
          ) : events.length === 0 ? (
            <div style={{ padding: 24, color: "var(--text-secondary)" }}>No events</div>
          ) : (
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ color: "var(--text-secondary)", borderBottom: "1px solid var(--separator)" }}>
                  <th style={{ textAlign: "left", padding: "8px 12px", width: 190 }}>Time</th>
                  <th style={{ textAlign: "left", padding: "8px 12px", width: 210 }}>Type</th>
                  <th style={{ textAlign: "left", padding: "8px 12px" }}>Payload</th>
                  <th style={{ padding: "8px 12px", width: 90 }}></th>
                </tr>
              </thead>
              <tbody>
                {events.map((event) => (
                  <tr key={event.id} style={{ borderBottom: "1px solid var(--separator)" }}>
                    <td style={{ padding: "9px 12px", color: "var(--text-secondary)" }}>
                      {fmtTime(event.timestamp)}
                    </td>
                    <td style={{ padding: "9px 12px", fontFamily: "var(--font-mono)" }}>
                      {event.type}
                    </td>
                    <td
                      style={{
                        padding: "9px 12px",
                        color: "var(--text-secondary)",
                        fontFamily: "var(--font-mono)",
                        wordBreak: "break-word",
                      }}
                    >
                      {eventPreview(event.payload)}
                    </td>
                    <td style={{ padding: "9px 12px", textAlign: "right" }}>
                      <button className="btn-ghost btn-sm" onClick={() => replayEvent(event.id)}>
                        Replay
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div className="card">
            <h2 style={{ marginBottom: 14 }}>New Webhook</h2>
            <div style={{ display: "grid", gap: 10 }}>
              <label>
                URL
                <input
                  value={form.url}
                  onChange={(e) => setForm((current) => ({ ...current, url: e.target.value }))}
                  placeholder="https://hooks.example.com/teleton"
                  style={{ width: "100%", marginTop: 4 }}
                />
              </label>
              <label>
                Events
                <input
                  value={form.events}
                  onChange={(e) => setForm((current) => ({ ...current, events: e.target.value }))}
                  style={{ width: "100%", marginTop: 4 }}
                />
              </label>
              <label>
                Secret
                <input
                  type="password"
                  value={form.secret}
                  onChange={(e) => setForm((current) => ({ ...current, secret: e.target.value }))}
                  style={{ width: "100%", marginTop: 4 }}
                />
              </label>
              <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 10 }}>
                <label>
                  Retries
                  <input
                    type="number"
                    min={1}
                    max={10}
                    value={form.maxRetries}
                    onChange={(e) =>
                      setForm((current) => ({
                        ...current,
                        maxRetries: Number(e.target.value),
                      }))
                    }
                    style={{ width: "100%", marginTop: 4 }}
                  />
                </label>
                <label style={{ display: "flex", alignItems: "center", gap: 8, paddingTop: 22 }}>
                  <input
                    type="checkbox"
                    checked={form.active}
                    onChange={(e) =>
                      setForm((current) => ({ ...current, active: e.target.checked }))
                    }
                  />
                  Active
                </label>
              </div>
              <button onClick={createWebhook} disabled={!form.url.trim()}>
                Add Webhook
              </button>
            </div>
          </div>

          <div className="card" style={{ padding: 0 }}>
            <div style={{ padding: 14, borderBottom: "1px solid var(--separator)" }}>
              <h2>Webhooks</h2>
            </div>
            {webhooks.length === 0 ? (
              <div style={{ padding: 18, color: "var(--text-secondary)" }}>No webhooks</div>
            ) : (
              webhooks.map((webhook) => (
                <div
                  key={webhook.id}
                  onClick={() => setSelectedWebhookId(webhook.id)}
                  style={{
                    padding: 14,
                    borderBottom: "1px solid var(--separator)",
                    cursor: "pointer",
                    background:
                      selectedWebhookId === webhook.id ? "var(--surface-hover)" : "transparent",
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                    <strong style={{ wordBreak: "break-all" }}>{webhook.url}</strong>
                    <span style={{ color: webhook.active ? "var(--green)" : "var(--text-secondary)" }}>
                      {webhook.active ? "Active" : "Paused"}
                    </span>
                  </div>
                  <div
                    style={{
                      color: "var(--text-secondary)",
                      fontSize: 12,
                      marginTop: 6,
                      wordBreak: "break-word",
                    }}
                  >
                    {webhook.events.join(", ")}
                  </div>
                  <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                    <button className="btn-ghost btn-sm" onClick={() => toggleWebhook(webhook)}>
                      {webhook.active ? "Pause" : "Resume"}
                    </button>
                    <button className="btn-ghost btn-sm" onClick={() => testWebhook(webhook.id)}>
                      Test
                    </button>
                    <button className="btn-ghost btn-sm" onClick={() => deleteWebhook(webhook.id)}>
                      Delete
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>

          <div className="card" style={{ padding: 0 }}>
            <div style={{ padding: 14, borderBottom: "1px solid var(--separator)" }}>
              <h2>{selectedWebhook ? "Deliveries" : "Delivery History"}</h2>
            </div>
            {deliveries.length === 0 ? (
              <div style={{ padding: 18, color: "var(--text-secondary)" }}>No deliveries</div>
            ) : (
              deliveries.map((delivery) => (
                <div key={delivery.id} style={{ padding: 14, borderBottom: "1px solid var(--separator)" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                    <strong style={{ color: statusColor(delivery.status) }}>{delivery.status}</strong>
                    <span style={{ color: "var(--text-secondary)", fontSize: 12 }}>
                      {delivery.attempts} attempt{delivery.attempts === 1 ? "" : "s"}
                    </span>
                  </div>
                  <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 4 }}>
                    {delivery.eventType} · {fmtTime(delivery.createdAt)}
                  </div>
                  {delivery.error && (
                    <div style={{ color: "var(--red)", fontSize: 12, marginTop: 6 }}>
                      {delivery.error}
                    </div>
                  )}
                  {delivery.status === "failed" && (
                    <button
                      className="btn-ghost btn-sm"
                      style={{ marginTop: 10 }}
                      onClick={() => retryDelivery(delivery)}
                    >
                      Retry
                    </button>
                  )}
                </div>
              ))
            )}
          </div>

          <div className="card">
            <h2 style={{ marginBottom: 12 }}>Event Types</h2>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {eventTypes.map((type) => (
                <button
                  key={type}
                  className="btn-ghost btn-sm"
                  onClick={() => {
                    setFilterType(type);
                    void handleUiAction(async () => {
                      const result = await api.eventsList({ type, limit: 100 });
                      setEvents(result.data.events);
                    }, setError);
                  }}
                >
                  {type}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
