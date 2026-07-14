import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  type PipelineData,
  type PipelineErrorStrategy,
  type PipelineRunData,
  type PipelineRunDetailData,
  type PipelineStepData,
} from "../lib/api";
import { useTranslation } from "react-i18next";
import { selectRunIdToLoad } from "../lib/pipelineRunSelection";

interface StepDraft {
  id: string;
  agent: string;
  action: string;
  output: string;
  dependsOn: string;
  errorStrategy: "" | PipelineErrorStrategy;
  retryCount: string;
  timeoutSeconds: string;
}

interface PipelineFormDraft {
  name: string;
  description: string;
  enabled: boolean;
  errorStrategy: PipelineErrorStrategy;
  maxRetries: string;
  timeoutSeconds: string;
  steps: StepDraft[];
}

const EMPTY_STEP: StepDraft = {
  id: "",
  agent: "primary",
  action: "",
  output: "",
  dependsOn: "",
  errorStrategy: "",
  retryCount: "",
  timeoutSeconds: "",
};

const DEFAULT_STEPS: StepDraft[] = [
  {
    id: "search",
    agent: "primary",
    action: "Search for {topic}",
    output: "search_results",
    dependsOn: "",
    errorStrategy: "",
    retryCount: "",
    timeoutSeconds: "",
  },
  {
    id: "summarize",
    agent: "primary",
    action: "Create summary from {search_results}",
    output: "final_report",
    dependsOn: "search",
    errorStrategy: "",
    retryCount: "",
    timeoutSeconds: "",
  },
];

function formatDate(value: number | null): string {
  if (!value) return "-";
  return new Date(value * 1000).toLocaleString();
}

function commaList(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function statusColor(status: string): string {
  if (status === "completed") return "var(--green)";
  if (status === "failed") return "var(--red)";
  if (status === "running") return "var(--accent)";
  if (status === "cancelled" || status === "skipped") return "var(--text-tertiary)";
  return "var(--text-secondary)";
}

function valuePreview(value: unknown): string {
  if (value === null || value === undefined) return "-";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function stepFromDraft(step: StepDraft): PipelineStepData {
  const retryCount = step.retryCount.trim() ? Number(step.retryCount) : undefined;
  const timeoutSeconds = step.timeoutSeconds.trim() ? Number(step.timeoutSeconds) : undefined;
  return {
    id: step.id.trim(),
    agent: step.agent.trim() || "primary",
    action: step.action.trim(),
    output: step.output.trim() || step.id.trim(),
    dependsOn: commaList(step.dependsOn),
    ...(step.errorStrategy ? { errorStrategy: step.errorStrategy } : {}),
    ...(Number.isFinite(retryCount) ? { retryCount } : {}),
    ...(Number.isFinite(timeoutSeconds) ? { timeoutSeconds } : {}),
  };
}

function draftFromPipeline(pipeline: PipelineData | null): PipelineFormDraft {
  if (!pipeline) {
    return {
      name: "",
      description: "",
      enabled: true,
      errorStrategy: "fail_fast",
      maxRetries: "0",
      timeoutSeconds: "",
      steps: DEFAULT_STEPS,
    };
  }
  return {
    name: pipeline.name,
    description: pipeline.description ?? "",
    enabled: pipeline.enabled,
    errorStrategy: pipeline.errorStrategy,
    maxRetries: String(pipeline.maxRetries),
    timeoutSeconds: pipeline.timeoutSeconds === null ? "" : String(pipeline.timeoutSeconds),
    steps: pipeline.steps.map((step) => ({
      id: step.id,
      agent: step.agent,
      action: step.action,
      output: step.output,
      dependsOn: step.dependsOn.join(", "),
      errorStrategy: step.errorStrategy ?? "",
      retryCount: step.retryCount === undefined ? "" : String(step.retryCount),
      timeoutSeconds: step.timeoutSeconds === undefined ? "" : String(step.timeoutSeconds),
    })),
  };
}

function PipelineForm({
  initial,
  saving,
  onSave,
  onCancel,
}: {
  initial: PipelineData | null;
  saving: boolean;
  onSave: (draft: PipelineFormDraft) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<PipelineFormDraft>(() => draftFromPipeline(initial));

  const updateStep = (index: number, updates: Partial<StepDraft>) => {
    setDraft((prev) => ({
      ...prev,
      steps: prev.steps.map((step, i) => (i === index ? { ...step, ...updates } : step)),
    }));
  };

  const addStep = () => {
    setDraft((prev) => ({
      ...prev,
      steps: [
        ...prev.steps,
        {
          ...EMPTY_STEP,
          id: `step${prev.steps.length + 1}`,
          output: `step${prev.steps.length + 1}_output`,
        },
      ],
    }));
  };

  const removeStep = (index: number) => {
    setDraft((prev) => ({ ...prev, steps: prev.steps.filter((_, i) => i !== index) }));
  };

  return (
    <div style={{ display: "grid", gap: "14px" }}>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
          gap: "12px",
        }}
      >
        <div className="form-group">
          <label>Name</label>
          <input
            value={draft.name}
            onChange={(e) => setDraft((prev) => ({ ...prev, name: e.target.value }))}
          />
        </div>
        <div className="form-group">
          <label>Error Strategy</label>
          <select
            value={draft.errorStrategy}
            onChange={(e) =>
              setDraft((prev) => ({
                ...prev,
                errorStrategy: e.target.value as PipelineErrorStrategy,
              }))
            }
          >
            <option value="fail_fast">fail_fast</option>
            <option value="continue">continue</option>
            <option value="retry">retry</option>
          </select>
        </div>
      </div>

      <div className="form-group">
        <label>Description</label>
        <input
          value={draft.description}
          onChange={(e) => setDraft((prev) => ({ ...prev, description: e.target.value }))}
        />
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
          gap: "12px",
        }}
      >
        <div className="form-group">
          <label>Max Retries</label>
          <input
            type="number"
            min={0}
            max={10}
            value={draft.maxRetries}
            onChange={(e) => setDraft((prev) => ({ ...prev, maxRetries: e.target.value }))}
          />
        </div>
        <div className="form-group">
          <label>Timeout Seconds</label>
          <input
            type="number"
            min={1}
            value={draft.timeoutSeconds}
            onChange={(e) => setDraft((prev) => ({ ...prev, timeoutSeconds: e.target.value }))}
          />
        </div>
        <label style={{ display: "flex", alignItems: "center", gap: "8px", paddingTop: "20px" }}>
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={(e) => setDraft((prev) => ({ ...prev, enabled: e.target.checked }))}
          />
          Enabled
        </label>
      </div>

      <div style={{ display: "grid", gap: "10px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h3 style={{ fontSize: "14px" }}>Steps</h3>
          <button className="btn-ghost btn-sm" type="button" onClick={addStep}>
            + Step
          </button>
        </div>
        <div style={{ display: "grid", gap: "10px" }}>
          {draft.steps.map((step, index) => (
            <div key={index} className="card" style={{ padding: "12px" }}>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
                  gap: "8px",
                }}
              >
                <div className="form-group">
                  <label>ID</label>
                  <input
                    value={step.id}
                    onChange={(e) => updateStep(index, { id: e.target.value })}
                  />
                </div>
                <div className="form-group">
                  <label>Agent</label>
                  <input
                    value={step.agent}
                    onChange={(e) => updateStep(index, { agent: e.target.value })}
                  />
                </div>
                <div className="form-group">
                  <label>Output</label>
                  <input
                    value={step.output}
                    onChange={(e) => updateStep(index, { output: e.target.value })}
                  />
                </div>
                <div className="form-group">
                  <label>Depends On</label>
                  <input
                    value={step.dependsOn}
                    onChange={(e) => updateStep(index, { dependsOn: e.target.value })}
                  />
                </div>
                <button
                  className="btn-ghost btn-sm"
                  type="button"
                  onClick={() => removeStep(index)}
                  style={{ alignSelf: "end", color: "var(--red)" }}
                >
                  Remove
                </button>
              </div>

              <div className="form-group" style={{ marginTop: "8px" }}>
                <label>Action</label>
                <textarea
                  value={step.action}
                  onChange={(e) => updateStep(index, { action: e.target.value })}
                  rows={3}
                  style={{ width: "100%", resize: "vertical" }}
                />
              </div>

              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
                  gap: "8px",
                }}
              >
                <div className="form-group">
                  <label>Step Strategy</label>
                  <select
                    value={step.errorStrategy}
                    onChange={(e) =>
                      updateStep(index, {
                        errorStrategy: e.target.value as "" | PipelineErrorStrategy,
                      })
                    }
                  >
                    <option value="">pipeline default</option>
                    <option value="fail_fast">fail_fast</option>
                    <option value="continue">continue</option>
                    <option value="retry">retry</option>
                  </select>
                </div>
                <div className="form-group">
                  <label>Retries</label>
                  <input
                    type="number"
                    min={0}
                    max={10}
                    value={step.retryCount}
                    onChange={(e) => updateStep(index, { retryCount: e.target.value })}
                  />
                </div>
                <div className="form-group">
                  <label>Timeout</label>
                  <input
                    type="number"
                    min={1}
                    value={step.timeoutSeconds}
                    onChange={(e) => updateStep(index, { timeoutSeconds: e.target.value })}
                  />
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px" }}>
        <button className="btn-ghost" type="button" disabled={saving} onClick={onCancel}>
          Cancel
        </button>
        <button type="button" disabled={saving} onClick={() => onSave(draft)}>
          {saving ? "Saving..." : "Save"}
        </button>
      </div>
    </div>
  );
}

function PipelineGraph({ pipeline }: { pipeline: PipelineData }) {
  return (
    <div style={{ display: "flex", gap: "10px", overflowX: "auto", paddingBottom: "4px" }}>
      {pipeline.steps.map((step, index) => (
        <div key={step.id} style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <div
            style={{
              width: 180,
              minHeight: 116,
              padding: "12px",
              borderRadius: "8px",
              border: "1px solid var(--separator)",
              background: "var(--surface)",
            }}
          >
            <div style={{ fontSize: "12px", color: "var(--text-secondary)" }}>{step.agent}</div>
            <div style={{ fontWeight: 600, margin: "4px 0" }}>{step.id}</div>
            <div
              style={{
                fontSize: "12px",
                color: "var(--text-secondary)",
                display: "-webkit-box",
                WebkitLineClamp: 2,
                WebkitBoxOrient: "vertical",
                overflow: "hidden",
              }}
            >
              {step.action}
            </div>
            <code style={{ display: "inline-block", marginTop: "8px", fontSize: "11px" }}>
              {step.output}
            </code>
            {step.dependsOn.length > 0 && (
              <div style={{ marginTop: "6px", fontSize: "11px", color: "var(--text-tertiary)" }}>
                {step.dependsOn.join(", ")}
              </div>
            )}
          </div>
          {index < pipeline.steps.length - 1 && (
            <span style={{ color: "var(--text-secondary)", fontSize: "18px" }}>→</span>
          )}
        </div>
      ))}
    </div>
  );
}

export function Pipelines() {
  const { t } = useTranslation();
  const [pipelines, setPipelines] = useState<PipelineData[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [runs, setRuns] = useState<PipelineRunData[]>([]);
  const [selectedRun, setSelectedRun] = useState<PipelineRunDetailData | null>(null);
  const [modal, setModal] = useState<"create" | PipelineData | null>(null);
  const [inputContext, setInputContext] = useState('{\n  "topic": "pipeline execution"\n}');
  const [loading, setLoading] = useState(true);
  const [runsLoading, setRunsLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selectedRunIdRef = useRef<string | null>(null);

  const selected = useMemo(
    () => pipelines.find((pipeline) => pipeline.id === selectedId) ?? pipelines[0] ?? null,
    [pipelines, selectedId]
  );

  const loadPipelines = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.pipelinesList();
      const next = res.data ?? [];
      setPipelines(next);
      setSelectedId((prev) => prev ?? next[0]?.id ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadRunDetail = useCallback(async (pipelineId: string, runId: string) => {
    try {
      const res = await api.pipelineRunDetail(pipelineId, runId);
      const detail = res.data ?? null;
      selectedRunIdRef.current = detail?.run.id ?? null;
      setSelectedRun(detail);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const loadRuns = useCallback(
    async (pipelineId: string) => {
      setRunsLoading(true);
      try {
        const res = await api.pipelineRunsList(pipelineId);
        const next = res.data ?? [];
        setRuns(next);
        const runId = selectRunIdToLoad(
          selectedRunIdRef.current,
          next.map((run) => run.id)
        );
        if (runId) {
          await loadRunDetail(pipelineId, runId);
        } else {
          selectedRunIdRef.current = null;
          setSelectedRun(null);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setRunsLoading(false);
      }
    },
    [loadRunDetail]
  );

  useEffect(() => {
    loadPipelines();
  }, [loadPipelines]);

  useEffect(() => {
    if (selected) void loadRuns(selected.id);
  }, [selected?.id, loadRuns]);

  useEffect(() => {
    if (!selected || !runs.some((run) => run.status === "pending" || run.status === "running")) {
      return;
    }
    const timer = window.setInterval(() => void loadRuns(selected.id), 2_000);
    return () => window.clearInterval(timer);
  }, [selected, runs, loadRuns]);

  const savePipeline = async (draft: PipelineFormDraft) => {
    setSaving(true);
    setError(null);
    try {
      const payload = {
        name: draft.name,
        description: draft.description || null,
        enabled: draft.enabled,
        errorStrategy: draft.errorStrategy,
        maxRetries: Number(draft.maxRetries || 0),
        timeoutSeconds: draft.timeoutSeconds.trim() ? Number(draft.timeoutSeconds) : null,
        steps: draft.steps.map(stepFromDraft),
      };
      const res =
        modal === "create"
          ? await api.pipelinesCreate(payload)
          : await api.pipelinesUpdate((modal as PipelineData).id, payload);
      const saved = res.data!;
      setPipelines((prev) =>
        modal === "create"
          ? [saved, ...prev]
          : prev.map((item) => (item.id === saved.id ? saved : item))
      );
      setSelectedId(saved.id);
      setModal(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const deletePipeline = async (pipeline: PipelineData) => {
    setError(null);
    try {
      await api.pipelinesDelete(pipeline.id);
      setPipelines((prev) => prev.filter((item) => item.id !== pipeline.id));
      setSelectedId(null);
      setRuns([]);
      setSelectedRun(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const runPipeline = async () => {
    if (!selected) return;
    setRunning(true);
    setError(null);
    try {
      const parsed = inputContext.trim()
        ? (JSON.parse(inputContext) as Record<string, unknown>)
        : {};
      const res = await api.pipelinesRun(selected.id, { inputContext: parsed });
      if (res.data) {
        setRuns((prev) => [res.data!, ...prev]);
        await loadRunDetail(selected.id, res.data.id);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  };

  const cancelRun = async (run: PipelineRunData) => {
    if (!selected) return;
    try {
      await api.pipelineRunCancel(selected.id, run.id);
      await loadRuns(selected.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div>
      <div className="header">
        <h1>{t('pages.pipelines.title')}</h1>
        <p>{t('pages.pipelines.subtitle')}</p>
      </div>

      {error && (
        <div className="alert error" style={{ marginBottom: "14px" }}>
          <span>{error}</span>
          <button className="btn-ghost btn-sm" onClick={() => setError(null)}>
            Dismiss
          </button>
        </div>
      )}

      {modal !== null && (
        <div className="modal-overlay" onClick={() => !saving && setModal(null)}>
          <div
            className="modal"
            style={{ maxWidth: "960px", width: "100%" }}
            onClick={(e) => e.stopPropagation()}
          >
            <h2 style={{ marginBottom: "16px" }}>
              {modal === "create" ? "Create Pipeline" : `Edit: ${(modal as PipelineData).name}`}
            </h2>
            <PipelineForm
              initial={modal === "create" ? null : (modal as PipelineData)}
              saving={saving}
              onSave={savePipeline}
              onCancel={() => setModal(null)}
            />
          </div>
        </div>
      )}

      <div
        className="card"
        style={{
          padding: "10px 14px",
          marginBottom: "14px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <span style={{ fontSize: "13px", color: "var(--text-secondary)" }}>
          {pipelines.length} pipeline{pipelines.length !== 1 ? "s" : ""}
          {pipelines.some((pipeline) => pipeline.enabled) && (
            <> · {pipelines.filter((pipeline) => pipeline.enabled).length} enabled</>
          )}
        </span>
        <div style={{ display: "flex", gap: "8px" }}>
          <button className="btn-ghost btn-sm" onClick={loadPipelines}>
            Refresh
          </button>
          <button onClick={() => setModal("create")}>+ New Pipeline</button>
        </div>
      </div>

      <div className="pipeline-layout">
        <div className="card" style={{ padding: 0, alignSelf: "start" }}>
          {loading ? (
            <div style={{ padding: "20px", textAlign: "center" }}>Loading...</div>
          ) : pipelines.length === 0 ? (
            <div style={{ padding: "24px", textAlign: "center" }}>
              <div style={{ color: "var(--text-secondary)", marginBottom: "12px" }}>
                No pipelines yet
              </div>
              <button onClick={() => setModal("create")}>+ Create Pipeline</button>
            </div>
          ) : (
            pipelines.map((pipeline) => (
              <button
                key={pipeline.id}
                className="btn-ghost"
                onClick={() => setSelectedId(pipeline.id)}
                style={{
                  width: "100%",
                  borderRadius: 0,
                  padding: "12px 14px",
                  display: "block",
                  textAlign: "left",
                  background: selected?.id === pipeline.id ? "var(--surface-hover)" : "transparent",
                  borderBottom: "1px solid var(--separator)",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", gap: "8px" }}>
                  <strong>{pipeline.name}</strong>
                  <span
                    style={{ color: pipeline.enabled ? "var(--green)" : "var(--text-tertiary)" }}
                  >
                    {pipeline.enabled ? "enabled" : "disabled"}
                  </span>
                </div>
                <div style={{ fontSize: "12px", color: "var(--text-secondary)" }}>
                  {pipeline.steps.length} step{pipeline.steps.length !== 1 ? "s" : ""} ·{" "}
                  {pipeline.errorStrategy}
                </div>
              </button>
            ))
          )}
        </div>

        <div style={{ display: "grid", gap: "16px", minWidth: 0 }}>
          {selected ? (
            <>
              <div className="card" style={{ padding: "16px" }}>
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    gap: "12px",
                    marginBottom: "14px",
                  }}
                >
                  <div>
                    <h2 style={{ fontSize: "20px", marginBottom: "4px" }}>{selected.name}</h2>
                    <div style={{ color: "var(--text-secondary)", fontSize: "13px" }}>
                      {selected.description || "No description"} · updated{" "}
                      {formatDate(selected.updatedAt)}
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: "8px", alignItems: "start" }}>
                    <button className="btn-ghost btn-sm" onClick={() => setModal(selected)}>
                      Edit
                    </button>
                    <button
                      className="btn-ghost btn-sm"
                      style={{ color: "var(--red)" }}
                      onClick={() => deletePipeline(selected)}
                    >
                      Delete
                    </button>
                  </div>
                </div>
                <PipelineGraph pipeline={selected} />
              </div>

              <div className="card" style={{ padding: "16px" }}>
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
                    gap: "12px",
                    alignItems: "end",
                  }}
                >
                  <div className="form-group" style={{ margin: 0 }}>
                    <label>Input Context</label>
                    <textarea
                      value={inputContext}
                      onChange={(e) => setInputContext(e.target.value)}
                      rows={4}
                      style={{ width: "100%", resize: "vertical", fontFamily: "var(--font-mono)" }}
                    />
                  </div>
                  <button disabled={running || !selected.enabled} onClick={runPipeline}>
                    {running ? "Starting..." : "Run Pipeline"}
                  </button>
                </div>
              </div>

              <div className="card" style={{ padding: 0 }}>
                <div
                  style={{
                    padding: "12px 14px",
                    borderBottom: "1px solid var(--separator)",
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                  }}
                >
                  <strong>Runs</strong>
                  <button className="btn-ghost btn-sm" onClick={() => loadRuns(selected.id)}>
                    {runsLoading ? "Refreshing..." : "Refresh"}
                  </button>
                </div>
                {runs.length === 0 ? (
                  <div style={{ padding: "24px", color: "var(--text-secondary)" }}>No runs</div>
                ) : (
                  <div className="pipeline-run-grid">
                    <div style={{ borderRight: "1px solid var(--separator)" }}>
                      {runs.map((run) => (
                        <button
                          key={run.id}
                          className="btn-ghost"
                          onClick={() => loadRunDetail(selected.id, run.id)}
                          style={{
                            width: "100%",
                            display: "block",
                            textAlign: "left",
                            padding: "10px 12px",
                            borderRadius: 0,
                            borderBottom: "1px solid var(--separator)",
                            background:
                              selectedRun?.run.id === run.id
                                ? "var(--surface-hover)"
                                : "transparent",
                          }}
                        >
                          <div style={{ color: statusColor(run.status), fontWeight: 600 }}>
                            {run.status}
                          </div>
                          <div style={{ color: "var(--text-secondary)", fontSize: "12px" }}>
                            {formatDate(run.createdAt)}
                          </div>
                        </button>
                      ))}
                    </div>

                    <div style={{ padding: "14px", minWidth: 0 }}>
                      {selectedRun ? (
                        <div style={{ display: "grid", gap: "12px" }}>
                          <div style={{ display: "flex", justifyContent: "space-between" }}>
                            <div>
                              <div
                                style={{
                                  color: statusColor(selectedRun.run.status),
                                  fontWeight: 700,
                                }}
                              >
                                {selectedRun.run.status}
                              </div>
                              <div style={{ fontSize: "12px", color: "var(--text-secondary)" }}>
                                started {formatDate(selectedRun.run.startedAt)} · completed{" "}
                                {formatDate(selectedRun.run.completedAt)}
                              </div>
                            </div>
                            {(selectedRun.run.status === "pending" ||
                              selectedRun.run.status === "running") && (
                              <button
                                className="btn-ghost btn-sm"
                                style={{ color: "var(--red)" }}
                                onClick={() => cancelRun(selectedRun.run)}
                              >
                                Cancel
                              </button>
                            )}
                          </div>

                          {selectedRun.run.error && (
                            <code style={{ color: "var(--red)", whiteSpace: "pre-wrap" }}>
                              {selectedRun.run.error}
                            </code>
                          )}

                          <div style={{ display: "grid", gap: "8px" }}>
                            {selectedRun.steps.map((step) => (
                              <div
                                key={step.stepId}
                                style={{
                                  border: "1px solid var(--separator)",
                                  borderRadius: "8px",
                                  padding: "10px",
                                }}
                              >
                                <div
                                  style={{
                                    display: "flex",
                                    justifyContent: "space-between",
                                    gap: "8px",
                                  }}
                                >
                                  <strong>{step.stepId}</strong>
                                  <span style={{ color: statusColor(step.status) }}>
                                    {step.status}
                                  </span>
                                </div>
                                <div style={{ fontSize: "12px", color: "var(--text-secondary)" }}>
                                  {step.agent} · output {step.output} · attempts {step.attempts}
                                </div>
                                {step.error ? (
                                  <code
                                    style={{
                                      display: "block",
                                      marginTop: "6px",
                                      color: "var(--red)",
                                      whiteSpace: "pre-wrap",
                                    }}
                                  >
                                    {step.error}
                                  </code>
                                ) : (
                                  <code
                                    style={{
                                      display: "block",
                                      marginTop: "6px",
                                      whiteSpace: "pre-wrap",
                                      wordBreak: "break-word",
                                    }}
                                  >
                                    {valuePreview(step.outputValue)}
                                  </code>
                                )}
                              </div>
                            ))}
                          </div>
                        </div>
                      ) : (
                        <div style={{ color: "var(--text-secondary)" }}>Select a run</div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </>
          ) : (
            <div className="card" style={{ padding: "32px", textAlign: "center" }}>
              <button onClick={() => setModal("create")}>+ Create Pipeline</button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
