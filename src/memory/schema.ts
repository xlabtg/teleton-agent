import type Database from "better-sqlite3";
import { JOURNAL_SCHEMA } from "../utils/module-db.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("Memory");

function compareSemver(a: string, b: string): number {
  const parseVersion = (v: string) => {
    const parts = v.split("-")[0].split(".").map(Number);
    return {
      major: parts[0] || 0,
      minor: parts[1] || 0,
      patch: parts[2] || 0,
    };
  };

  const va = parseVersion(a);
  const vb = parseVersion(b);

  if (va.major !== vb.major) return va.major < vb.major ? -1 : 1;
  if (va.minor !== vb.minor) return va.minor < vb.minor ? -1 : 1;
  if (va.patch !== vb.patch) return va.patch < vb.patch ? -1 : 1;
  return 0;
}

function versionLessThan(a: string, b: string): boolean {
  return compareSemver(a, b) < 0;
}

export function ensureSchema(db: Database.Database): void {
  db.exec(`
    -- ============================================
    -- METADATA
    -- ============================================
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    -- ============================================
    -- AGENT REGISTRY
    -- ============================================
    CREATE TABLE IF NOT EXISTS agent_registry (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      config TEXT NOT NULL DEFAULT '{}',
      soul_template TEXT NOT NULL DEFAULT '',
      tools TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'stopped',
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE INDEX IF NOT EXISTS idx_agent_registry_type ON agent_registry(type);
    CREATE INDEX IF NOT EXISTS idx_agent_registry_status ON agent_registry(status);
    CREATE INDEX IF NOT EXISTS idx_agent_registry_updated ON agent_registry(updated_at DESC);

    -- ============================================
    -- UNIFIED INTEGRATIONS
    -- ============================================
    CREATE TABLE IF NOT EXISTS integrations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('api', 'webhook', 'oauth', 'mcp')),
      provider TEXT NOT NULL DEFAULT 'custom-http',
      config TEXT NOT NULL DEFAULT '{}',
      auth TEXT NOT NULL DEFAULT '{"type":"none"}',
      auth_id TEXT,
      status TEXT NOT NULL DEFAULT 'unconfigured'
        CHECK(status IN ('unknown', 'healthy', 'degraded', 'unhealthy', 'unconfigured')),
      health_check_url TEXT,
      last_health_at INTEGER,
      last_health_message TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE INDEX IF NOT EXISTS idx_integrations_type ON integrations(type);
    CREATE INDEX IF NOT EXISTS idx_integrations_provider ON integrations(provider);
    CREATE INDEX IF NOT EXISTS idx_integrations_status ON integrations(status);
    CREATE INDEX IF NOT EXISTS idx_integrations_updated ON integrations(updated_at DESC);

    CREATE TABLE IF NOT EXISTS integration_credentials (
      id TEXT PRIMARY KEY,
      integration_id TEXT NOT NULL,
      auth_type TEXT NOT NULL
        CHECK(auth_type IN ('none', 'api_key', 'oauth2', 'jwt', 'basic', 'custom_header')),
      credentials_encrypted TEXT NOT NULL,
      expires_at INTEGER,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
      FOREIGN KEY (integration_id) REFERENCES integrations(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_integration_credentials_integration
      ON integration_credentials(integration_id);
    CREATE INDEX IF NOT EXISTS idx_integration_credentials_expires
      ON integration_credentials(expires_at) WHERE expires_at IS NOT NULL;

    CREATE TABLE IF NOT EXISTS integration_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      integration_id TEXT NOT NULL,
      action TEXT NOT NULL,
      success INTEGER NOT NULL CHECK(success IN (0, 1)),
      latency_ms INTEGER,
      error TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      FOREIGN KEY (integration_id) REFERENCES integrations(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_integration_usage_integration
      ON integration_usage(integration_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_integration_usage_action
      ON integration_usage(action);

    -- ============================================
    -- AGENT MEMORY (Knowledge Base)
    -- ============================================

    -- Knowledge chunks from MEMORY.md, memory/*.md, learned facts
    CREATE TABLE IF NOT EXISTS knowledge (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL CHECK(source IN ('memory', 'session', 'learned')),
      path TEXT,
      text TEXT NOT NULL,
      embedding TEXT,
      start_line INTEGER,
      end_line INTEGER,
      hash TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE INDEX IF NOT EXISTS idx_knowledge_source ON knowledge(source);
    CREATE INDEX IF NOT EXISTS idx_knowledge_hash ON knowledge(hash);
    CREATE INDEX IF NOT EXISTS idx_knowledge_updated ON knowledge(updated_at DESC);

    -- Importance scores for active knowledge memories.
    CREATE TABLE IF NOT EXISTS memory_scores (
      memory_id TEXT PRIMARY KEY,
      score REAL NOT NULL DEFAULT 0 CHECK(score >= 0 AND score <= 1),
      recency REAL NOT NULL DEFAULT 0 CHECK(recency >= 0 AND recency <= 1),
      frequency REAL NOT NULL DEFAULT 0 CHECK(frequency >= 0 AND frequency <= 1),
      impact REAL NOT NULL DEFAULT 0 CHECK(impact >= 0 AND impact <= 1),
      explicit REAL NOT NULL DEFAULT 0 CHECK(explicit >= 0 AND explicit <= 1),
      centrality REAL NOT NULL DEFAULT 0 CHECK(centrality >= 0 AND centrality <= 1),
      access_count INTEGER NOT NULL DEFAULT 0,
      impact_count INTEGER NOT NULL DEFAULT 0,
      pinned INTEGER NOT NULL DEFAULT 0 CHECK(pinned IN (0, 1)),
      last_accessed_at INTEGER,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
      FOREIGN KEY (memory_id) REFERENCES knowledge(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_memory_scores_score ON memory_scores(score DESC);
    CREATE INDEX IF NOT EXISTS idx_memory_scores_updated ON memory_scores(updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_memory_scores_pinned ON memory_scores(pinned) WHERE pinned = 1;

    -- Temporal metadata overlay for time-aware context retrieval and pattern analysis.
    CREATE TABLE IF NOT EXISTS temporal_metadata (
      id TEXT PRIMARY KEY,
      entity_type TEXT NOT NULL CHECK(entity_type IN ('knowledge', 'message', 'session', 'task', 'behavior', 'request', 'tool')),
      entity_id TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      timezone TEXT NOT NULL DEFAULT 'UTC',
      day_of_week INTEGER NOT NULL CHECK(day_of_week >= 0 AND day_of_week <= 6),
      hour_of_day INTEGER NOT NULL CHECK(hour_of_day >= 0 AND hour_of_day <= 23),
      time_of_day TEXT NOT NULL CHECK(time_of_day IN ('morning', 'afternoon', 'evening', 'night')),
      relative_period TEXT NOT NULL CHECK(relative_period IN ('weekday', 'weekend')),
      session_phase TEXT NOT NULL DEFAULT 'unknown'
        CHECK(session_phase IN ('beginning', 'middle', 'end', 'unknown')),
      metadata TEXT NOT NULL DEFAULT '{}',
      updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
      UNIQUE(entity_type, entity_id)
    );

    CREATE INDEX IF NOT EXISTS idx_temporal_metadata_entity
      ON temporal_metadata(entity_type, entity_id);
    CREATE INDEX IF NOT EXISTS idx_temporal_metadata_time
      ON temporal_metadata(timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_temporal_metadata_day_hour
      ON temporal_metadata(day_of_week, hour_of_day);
    CREATE INDEX IF NOT EXISTS idx_temporal_metadata_markers
      ON temporal_metadata(time_of_day, relative_period);

    CREATE TABLE IF NOT EXISTS time_patterns (
      id TEXT PRIMARY KEY,
      pattern_type TEXT NOT NULL CHECK(pattern_type IN ('daily', 'weekly', 'recurring', 'seasonal', 'custom')),
      description TEXT NOT NULL,
      schedule_cron TEXT,
      confidence REAL NOT NULL DEFAULT 0 CHECK(confidence >= 0 AND confidence <= 1),
      frequency INTEGER NOT NULL DEFAULT 1,
      last_seen INTEGER NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
      enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
      metadata TEXT NOT NULL DEFAULT '{}'
    );

    CREATE INDEX IF NOT EXISTS idx_time_patterns_type
      ON time_patterns(pattern_type, confidence DESC, frequency DESC);
    CREATE INDEX IF NOT EXISTS idx_time_patterns_last_seen
      ON time_patterns(last_seen DESC);
    CREATE INDEX IF NOT EXISTS idx_time_patterns_enabled
      ON time_patterns(enabled, confidence DESC) WHERE enabled = 1;

    -- Archived knowledge rows retained after cleanup removes them from active search.
    CREATE TABLE IF NOT EXISTS memory_archive (
      archive_id INTEGER PRIMARY KEY AUTOINCREMENT,
      memory_id TEXT NOT NULL,
      source TEXT NOT NULL,
      path TEXT,
      text TEXT NOT NULL,
      embedding TEXT,
      start_line INTEGER,
      end_line INTEGER,
      hash TEXT NOT NULL,
      original_created_at INTEGER NOT NULL,
      original_updated_at INTEGER NOT NULL,
      score REAL NOT NULL DEFAULT 0,
      score_breakdown TEXT NOT NULL DEFAULT '{}',
      archived_at INTEGER NOT NULL DEFAULT (unixepoch()),
      delete_after INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_memory_archive_memory_id ON memory_archive(memory_id);
    CREATE INDEX IF NOT EXISTS idx_memory_archive_delete_after ON memory_archive(delete_after);

    CREATE TABLE IF NOT EXISTS pending_remote_vector_deletions (
      memory_id TEXT NOT NULL,
      namespace TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
      last_error TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
      PRIMARY KEY (memory_id, namespace)
    );

    CREATE INDEX IF NOT EXISTS idx_pending_remote_vector_deletions_namespace_updated
      ON pending_remote_vector_deletions(namespace, updated_at);

    CREATE TABLE IF NOT EXISTS memory_cleanup_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mode TEXT NOT NULL CHECK(mode IN ('dry_run', 'archive', 'prune_archive')),
      candidates INTEGER NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0,
      deleted INTEGER NOT NULL DEFAULT 0,
      protected INTEGER NOT NULL DEFAULT 0,
      reason TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE INDEX IF NOT EXISTS idx_memory_cleanup_history_created ON memory_cleanup_history(created_at DESC);

    -- Full-text search for knowledge
    CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(
      text,
      id UNINDEXED,
      path UNINDEXED,
      source UNINDEXED,
      content='knowledge',
      content_rowid='rowid'
    );

    -- FTS triggers
    CREATE TRIGGER IF NOT EXISTS knowledge_fts_insert AFTER INSERT ON knowledge BEGIN
      INSERT INTO knowledge_fts(rowid, text, id, path, source)
      VALUES (new.rowid, new.text, new.id, new.path, new.source);
    END;

    CREATE TRIGGER IF NOT EXISTS knowledge_fts_delete AFTER DELETE ON knowledge BEGIN
      INSERT INTO knowledge_fts(knowledge_fts, rowid, text, id, path, source)
      VALUES ('delete', old.rowid, old.text, old.id, old.path, old.source);
    END;

    CREATE TRIGGER IF NOT EXISTS knowledge_fts_update AFTER UPDATE ON knowledge BEGIN
      INSERT INTO knowledge_fts(knowledge_fts, rowid, text, id, path, source)
      VALUES ('delete', old.rowid, old.text, old.id, old.path, old.source);
      INSERT INTO knowledge_fts(rowid, text, id, path, source)
      VALUES (new.rowid, new.text, new.id, new.path, new.source);
    END;

    -- Sessions/Conversations
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,               -- session_id (UUID)
      chat_id TEXT UNIQUE NOT NULL,      -- telegram:chat_id
      started_at INTEGER NOT NULL,       -- createdAt (Unix timestamp ms)
      updated_at INTEGER NOT NULL,       -- updatedAt (Unix timestamp ms)
      ended_at INTEGER,                  -- Optional end time
      summary TEXT,                      -- Session summary
      message_count INTEGER DEFAULT 0,   -- Number of messages
      tokens_used INTEGER DEFAULT 0,     -- Deprecated (use context_tokens)
      last_message_id INTEGER,           -- Last Telegram message ID
      last_channel TEXT,                 -- Last channel (telegram/discord/etc)
      last_to TEXT,                      -- Last recipient
      context_tokens INTEGER,            -- Current context size
      model TEXT,                        -- Model used (claude-opus-4-5-20251101)
      provider TEXT,                     -- Provider (anthropic)
      last_reset_date TEXT,              -- YYYY-MM-DD of last daily reset
      input_tokens INTEGER DEFAULT 0,    -- Accumulated input tokens
      output_tokens INTEGER DEFAULT 0    -- Accumulated output tokens
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_chat ON sessions(chat_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions(started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at DESC);

    -- Correction loop logs
    CREATE TABLE IF NOT EXISTS correction_logs (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      task_id TEXT,
      chat_id TEXT NOT NULL,
      iteration INTEGER NOT NULL,
      original_output TEXT NOT NULL,
      evaluation TEXT NOT NULL,
      reflection TEXT,
      corrected_output TEXT,
      score REAL NOT NULL CHECK(score >= 0 AND score <= 1),
      corrected_score REAL CHECK(corrected_score IS NULL OR (corrected_score >= 0 AND corrected_score <= 1)),
      score_delta REAL NOT NULL DEFAULT 0,
      threshold REAL NOT NULL DEFAULT 0.7,
      escalated INTEGER NOT NULL DEFAULT 0 CHECK(escalated IN (0, 1)),
      tool_recovery TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE INDEX IF NOT EXISTS idx_correction_logs_session ON correction_logs(session_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_correction_logs_task ON correction_logs(task_id, created_at DESC) WHERE task_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_correction_logs_created ON correction_logs(created_at DESC);

    -- Tasks
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      description TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'in_progress', 'done', 'failed', 'cancelled')),
      priority INTEGER DEFAULT 0,
      created_by TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      started_at INTEGER,
      completed_at INTEGER,
      result TEXT,
      error TEXT,
      scheduled_for INTEGER,
      payload TEXT,
      reason TEXT,
      scheduled_message_id INTEGER,
      recurrence_interval INTEGER,
      recurrence_until INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_tasks_priority ON tasks(priority DESC, created_at ASC);
    CREATE INDEX IF NOT EXISTS idx_tasks_scheduled ON tasks(scheduled_for) WHERE scheduled_for IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_tasks_created_by ON tasks(created_by) WHERE created_by IS NOT NULL;

    -- Task Dependencies (for chained tasks)
    CREATE TABLE IF NOT EXISTS task_dependencies (
      task_id TEXT NOT NULL,
      depends_on_task_id TEXT NOT NULL,
      PRIMARY KEY (task_id, depends_on_task_id),
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
      FOREIGN KEY (depends_on_task_id) REFERENCES tasks(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_task_deps_task ON task_dependencies(task_id);
    CREATE INDEX IF NOT EXISTS idx_task_deps_parent ON task_dependencies(depends_on_task_id);

    -- Task Delegation
    CREATE TABLE IF NOT EXISTS task_subtasks (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      parent_id TEXT,
      description TEXT NOT NULL,
      required_skills TEXT NOT NULL DEFAULT '[]',
      required_tools TEXT NOT NULL DEFAULT '[]',
      agent_id TEXT,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending', 'delegated', 'in_progress', 'done', 'failed', 'cancelled')),
      result TEXT,
      error TEXT,
      depth INTEGER NOT NULL DEFAULT 1 CHECK(depth >= 1 AND depth <= 3),
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
      started_at INTEGER,
      completed_at INTEGER,
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
      FOREIGN KEY (parent_id) REFERENCES task_subtasks(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_task_subtasks_task ON task_subtasks(task_id, depth, created_at);
    CREATE INDEX IF NOT EXISTS idx_task_subtasks_parent ON task_subtasks(parent_id) WHERE parent_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_task_subtasks_agent ON task_subtasks(agent_id) WHERE agent_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_task_subtasks_status ON task_subtasks(status);

    CREATE TABLE IF NOT EXISTS task_subtask_dependencies (
      subtask_id TEXT NOT NULL,
      depends_on_subtask_id TEXT NOT NULL,
      PRIMARY KEY (subtask_id, depends_on_subtask_id),
      FOREIGN KEY (subtask_id) REFERENCES task_subtasks(id) ON DELETE CASCADE,
      FOREIGN KEY (depends_on_subtask_id) REFERENCES task_subtasks(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_subtask_deps_subtask ON task_subtask_dependencies(subtask_id);
    CREATE INDEX IF NOT EXISTS idx_subtask_deps_parent ON task_subtask_dependencies(depends_on_subtask_id);

    -- Agent Network Protocol
    CREATE TABLE IF NOT EXISTS network_agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      capabilities TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'offline'
        CHECK(status IN ('available', 'busy', 'offline', 'degraded')),
      load REAL NOT NULL DEFAULT 0 CHECK(load >= 0 AND load <= 1),
      public_key TEXT,
      trust_level TEXT NOT NULL DEFAULT 'untrusted'
        CHECK(trust_level IN ('trusted', 'verified', 'untrusted')),
      blocked INTEGER NOT NULL DEFAULT 0 CHECK(blocked IN (0, 1)),
      latency_ms INTEGER,
      error_rate REAL NOT NULL DEFAULT 0 CHECK(error_rate >= 0 AND error_rate <= 1),
      metadata TEXT NOT NULL DEFAULT '{}',
      last_seen_at INTEGER NOT NULL DEFAULT (unixepoch()),
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE INDEX IF NOT EXISTS idx_network_agents_status ON network_agents(status);
    CREATE INDEX IF NOT EXISTS idx_network_agents_trust ON network_agents(trust_level, blocked);
    CREATE INDEX IF NOT EXISTS idx_network_agents_seen ON network_agents(last_seen_at DESC);

    CREATE TABLE IF NOT EXISTS network_messages (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL
        CHECK(type IN ('task_request', 'task_response', 'capability_query', 'heartbeat', 'negotiation')),
      from_agent_id TEXT NOT NULL,
      to_agent_id TEXT NOT NULL,
      correlation_id TEXT NOT NULL,
      replay_key TEXT,
      payload TEXT NOT NULL DEFAULT '{}',
      signature TEXT,
      timestamp TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued'
        CHECK(status IN ('queued', 'sent', 'received', 'failed')),
      error TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      sent_at INTEGER,
      received_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_network_messages_from ON network_messages(from_agent_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_network_messages_to ON network_messages(to_agent_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_network_messages_correlation ON network_messages(correlation_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_network_messages_replay_key
      ON network_messages(replay_key) WHERE replay_key IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_network_messages_status ON network_messages(status, created_at DESC);

    -- ============================================
    -- PIPELINE EXECUTION
    -- ============================================

    CREATE TABLE IF NOT EXISTS pipelines (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      steps TEXT NOT NULL DEFAULT '[]',
      enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
      error_strategy TEXT NOT NULL DEFAULT 'fail_fast'
        CHECK(error_strategy IN ('fail_fast', 'continue', 'retry')),
      max_retries INTEGER NOT NULL DEFAULT 0 CHECK(max_retries >= 0),
      timeout_seconds INTEGER,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE INDEX IF NOT EXISTS idx_pipelines_enabled ON pipelines(enabled);
    CREATE INDEX IF NOT EXISTS idx_pipelines_created ON pipelines(created_at DESC);

    CREATE TABLE IF NOT EXISTS pipeline_runs (
      id TEXT PRIMARY KEY,
      pipeline_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending', 'running', 'completed', 'failed', 'cancelled')),
      error_strategy TEXT NOT NULL DEFAULT 'fail_fast'
        CHECK(error_strategy IN ('fail_fast', 'continue', 'retry')),
      input_context TEXT NOT NULL DEFAULT '{}',
      context TEXT NOT NULL DEFAULT '{}',
      error TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      started_at INTEGER,
      completed_at INTEGER,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
      FOREIGN KEY (pipeline_id) REFERENCES pipelines(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_pipeline_runs_pipeline ON pipeline_runs(pipeline_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_pipeline_runs_status ON pipeline_runs(status);

    CREATE TABLE IF NOT EXISTS pipeline_run_steps (
      run_id TEXT NOT NULL,
      pipeline_id TEXT NOT NULL,
      step_id TEXT NOT NULL,
      agent TEXT NOT NULL,
      action TEXT NOT NULL,
      output_name TEXT NOT NULL,
      depends_on TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending', 'running', 'completed', 'failed', 'skipped', 'cancelled')),
      input_context TEXT,
      output_value TEXT,
      error TEXT,
      attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
      started_at INTEGER,
      completed_at INTEGER,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
      PRIMARY KEY (run_id, step_id),
      FOREIGN KEY (run_id) REFERENCES pipeline_runs(id) ON DELETE CASCADE,
      FOREIGN KEY (pipeline_id) REFERENCES pipelines(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_pipeline_run_steps_run ON pipeline_run_steps(run_id, status);
    CREATE INDEX IF NOT EXISTS idx_pipeline_run_steps_pipeline ON pipeline_run_steps(pipeline_id);

    -- ============================================
    -- DYNAMIC DASHBOARDS
    -- ============================================

    CREATE TABLE IF NOT EXISTS widget_definitions (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL CHECK(category IN ('metrics', 'status', 'content', 'action', 'custom')),
      data_source TEXT NOT NULL DEFAULT '{"type":"static"}',
      renderer TEXT NOT NULL CHECK(renderer IN ('chart', 'table', 'text', 'markdown', 'custom', 'kpi', 'list')),
      default_size TEXT NOT NULL DEFAULT '{"w":6,"h":4}',
      config_schema TEXT NOT NULL DEFAULT '{}',
      built_in INTEGER NOT NULL DEFAULT 0 CHECK(built_in IN (0, 1)),
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE INDEX IF NOT EXISTS idx_widget_definitions_category ON widget_definitions(category);
    CREATE INDEX IF NOT EXISTS idx_widget_definitions_renderer ON widget_definitions(renderer);

    CREATE TABLE IF NOT EXISTS dashboards (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      widgets TEXT NOT NULL DEFAULT '[]',
      layout TEXT NOT NULL DEFAULT '{}',
      is_default INTEGER NOT NULL DEFAULT 0 CHECK(is_default IN (0, 1)),
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE INDEX IF NOT EXISTS idx_dashboards_default ON dashboards(is_default) WHERE is_default = 1;
    CREATE INDEX IF NOT EXISTS idx_dashboards_created ON dashboards(created_at DESC);

    -- ============================================
    -- ASSOCIATIVE MEMORY GRAPH
    -- ============================================

    CREATE TABLE IF NOT EXISTS graph_nodes (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL CHECK(type IN ('conversation', 'task', 'tool', 'topic', 'entity', 'outcome')),
      label TEXT NOT NULL,
      normalized_label TEXT NOT NULL,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
      UNIQUE(type, normalized_label)
    );

    CREATE INDEX IF NOT EXISTS idx_graph_nodes_type ON graph_nodes(type);
    CREATE INDEX IF NOT EXISTS idx_graph_nodes_updated ON graph_nodes(updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_graph_nodes_label ON graph_nodes(label);

    CREATE TABLE IF NOT EXISTS graph_edges (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL,
      target_id TEXT NOT NULL,
      relation TEXT NOT NULL,
      weight REAL NOT NULL DEFAULT 1.0,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      FOREIGN KEY (source_id) REFERENCES graph_nodes(id) ON DELETE CASCADE,
      FOREIGN KEY (target_id) REFERENCES graph_nodes(id) ON DELETE CASCADE,
      UNIQUE(source_id, target_id, relation)
    );

    CREATE INDEX IF NOT EXISTS idx_graph_edges_source ON graph_edges(source_id);
    CREATE INDEX IF NOT EXISTS idx_graph_edges_target ON graph_edges(target_id);
    CREATE INDEX IF NOT EXISTS idx_graph_edges_relation ON graph_edges(relation);

    -- ============================================
    -- TELEGRAM FEED
    -- ============================================

    -- Chats (groups, channels, DMs)
    CREATE TABLE IF NOT EXISTS tg_chats (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL CHECK(type IN ('dm', 'group', 'channel')),
      title TEXT,
      username TEXT,
      member_count INTEGER,
      is_monitored INTEGER DEFAULT 1,
      is_archived INTEGER DEFAULT 0,
      last_message_id TEXT,
      last_message_at INTEGER,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE INDEX IF NOT EXISTS idx_tg_chats_type ON tg_chats(type);
    CREATE INDEX IF NOT EXISTS idx_tg_chats_monitored ON tg_chats(is_monitored, last_message_at DESC);
    CREATE INDEX IF NOT EXISTS idx_tg_chats_username ON tg_chats(username) WHERE username IS NOT NULL;

    -- Users
    CREATE TABLE IF NOT EXISTS tg_users (
      id TEXT PRIMARY KEY,
      username TEXT,
      first_name TEXT,
      last_name TEXT,
      is_bot INTEGER DEFAULT 0,
      is_admin INTEGER DEFAULT 0,
      is_allowed INTEGER DEFAULT 0,
      first_seen_at INTEGER NOT NULL DEFAULT (unixepoch()),
      last_seen_at INTEGER NOT NULL DEFAULT (unixepoch()),
      message_count INTEGER DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_tg_users_username ON tg_users(username) WHERE username IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_tg_users_admin ON tg_users(is_admin) WHERE is_admin = 1;
    CREATE INDEX IF NOT EXISTS idx_tg_users_last_seen ON tg_users(last_seen_at DESC);

    -- Messages
    CREATE TABLE IF NOT EXISTS tg_messages (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL,
      sender_id TEXT,
      text TEXT,
      embedding TEXT,
      reply_to_id TEXT,
      forward_from_id TEXT,
      is_from_agent INTEGER DEFAULT 0,
      is_edited INTEGER DEFAULT 0,
      has_media INTEGER DEFAULT 0,
      media_type TEXT,
      timestamp INTEGER NOT NULL,
      indexed_at INTEGER NOT NULL DEFAULT (unixepoch()),
      FOREIGN KEY (chat_id) REFERENCES tg_chats(id) ON DELETE CASCADE,
      FOREIGN KEY (sender_id) REFERENCES tg_users(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_tg_messages_chat ON tg_messages(chat_id, timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_tg_messages_sender ON tg_messages(sender_id, timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_tg_messages_timestamp ON tg_messages(timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_tg_messages_reply ON tg_messages(reply_to_id) WHERE reply_to_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_tg_messages_from_agent ON tg_messages(is_from_agent, timestamp DESC) WHERE is_from_agent = 1;

    -- Full-text search for messages
    CREATE VIRTUAL TABLE IF NOT EXISTS tg_messages_fts USING fts5(
      text,
      id UNINDEXED,
      chat_id UNINDEXED,
      sender_id UNINDEXED,
      timestamp UNINDEXED,
      content='tg_messages',
      content_rowid='rowid'
    );

    -- FTS triggers for messages
    CREATE TRIGGER IF NOT EXISTS tg_messages_fts_insert AFTER INSERT ON tg_messages BEGIN
      INSERT INTO tg_messages_fts(rowid, text, id, chat_id, sender_id, timestamp)
      VALUES (new.rowid, new.text, new.id, new.chat_id, new.sender_id, new.timestamp);
    END;

    CREATE TRIGGER IF NOT EXISTS tg_messages_fts_delete AFTER DELETE ON tg_messages BEGIN
      INSERT INTO tg_messages_fts(tg_messages_fts, rowid, text, id, chat_id, sender_id, timestamp)
      VALUES ('delete', old.rowid, old.text, old.id, old.chat_id, old.sender_id, old.timestamp);
    END;

    CREATE TRIGGER IF NOT EXISTS tg_messages_fts_update AFTER UPDATE ON tg_messages BEGIN
      INSERT INTO tg_messages_fts(tg_messages_fts, rowid, text, id, chat_id, sender_id, timestamp)
      VALUES ('delete', old.rowid, old.text, old.id, old.chat_id, old.sender_id, old.timestamp);
      INSERT INTO tg_messages_fts(rowid, text, id, chat_id, sender_id, timestamp)
      VALUES (new.rowid, new.text, new.id, new.chat_id, new.sender_id, new.timestamp);
    END;

    -- ============================================
    -- EMBEDDING CACHE
    -- ============================================

    CREATE TABLE IF NOT EXISTS embedding_cache (
      hash TEXT NOT NULL,
      model TEXT NOT NULL,
      provider TEXT NOT NULL,
      embedding BLOB NOT NULL,
      dims INTEGER NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      accessed_at INTEGER NOT NULL DEFAULT (unixepoch()),
      PRIMARY KEY (hash, model, provider)
    );

    CREATE INDEX IF NOT EXISTS idx_embedding_cache_accessed ON embedding_cache(accessed_at);

    -- =====================================================
    -- EXEC AUDIT (Command Execution History)
    -- =====================================================

    CREATE TABLE IF NOT EXISTS exec_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER NOT NULL DEFAULT (unixepoch()),
      user_id INTEGER NOT NULL,
      username TEXT,
      tool TEXT NOT NULL,
      command TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running'
        CHECK(status IN ('running', 'success', 'failed', 'timeout', 'killed')),
      exit_code INTEGER,
      signal TEXT,
      duration_ms INTEGER,
      stdout TEXT,
      stderr TEXT,
      truncated INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_exec_audit_timestamp ON exec_audit(timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_exec_audit_user ON exec_audit(user_id);

    -- =====================================================
    -- PLUGIN CONFIG (Plugin Priority Order)
    -- =====================================================

    CREATE TABLE IF NOT EXISTS plugin_config (
      plugin_name TEXT PRIMARY KEY,
      priority INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- =====================================================
    -- USER HOOK CONFIG (Keyword Blocklist + Context Triggers)
    -- =====================================================

    CREATE TABLE IF NOT EXISTS user_hook_config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- =====================================================
    -- TOOL USAGE (Per-tool execution statistics)
    -- =====================================================

    CREATE TABLE IF NOT EXISTS tool_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tool_name TEXT NOT NULL,
      success INTEGER NOT NULL DEFAULT 1 CHECK(success IN (0, 1)),
      duration_ms INTEGER,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE INDEX IF NOT EXISTS idx_tool_usage_tool ON tool_usage(tool_name);
    CREATE INDEX IF NOT EXISTS idx_tool_usage_created ON tool_usage(created_at DESC);

    -- =====================================================
    -- ANALYTICS: Request Metrics (per-request detail)
    -- =====================================================

    CREATE TABLE IF NOT EXISTS request_metrics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tool_name TEXT,
      tokens_used INTEGER DEFAULT 0,
      duration_ms INTEGER,
      success INTEGER NOT NULL DEFAULT 1 CHECK(success IN (0, 1)),
      error_message TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE INDEX IF NOT EXISTS idx_request_metrics_created ON request_metrics(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_request_metrics_tool ON request_metrics(tool_name) WHERE tool_name IS NOT NULL;

    -- =====================================================
    -- AUDIT TRAIL (Tamper-evident agent and API events)
    -- =====================================================

    CREATE TABLE IF NOT EXISTS audit_events (
      id TEXT PRIMARY KEY,
      sequence INTEGER NOT NULL UNIQUE,
      event_type TEXT NOT NULL,
      actor TEXT NOT NULL DEFAULT 'system',
      session_id TEXT,
      payload TEXT NOT NULL DEFAULT '{}',
      parent_event_id TEXT,
      previous_checksum TEXT,
      checksum TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      FOREIGN KEY (parent_event_id) REFERENCES audit_events(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_audit_events_created ON audit_events(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_events_type ON audit_events(event_type, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_events_session ON audit_events(session_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_events_actor ON audit_events(actor, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_events_parent ON audit_events(parent_event_id);
    CREATE INDEX IF NOT EXISTS idx_audit_events_sequence ON audit_events(sequence);

    -- =====================================================
    -- ANALYTICS: Cost Records (daily aggregation)
    -- =====================================================

    CREATE TABLE IF NOT EXISTS cost_records (
      date TEXT PRIMARY KEY,       -- YYYY-MM-DD
      tokens_input INTEGER DEFAULT 0,
      tokens_output INTEGER DEFAULT 0,
      cost_usd REAL DEFAULT 0,
      request_count INTEGER DEFAULT 0
    );

    -- =====================================================
    -- ANALYTICS: Budget Config
    -- =====================================================

    CREATE TABLE IF NOT EXISTS budget_config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    -- =====================================================
    -- AUTONOMOUS TASK ENGINE (ATE)
    -- =====================================================

    CREATE TABLE IF NOT EXISTS autonomous_tasks (
      id TEXT PRIMARY KEY,
      goal TEXT NOT NULL,
      success_criteria TEXT NOT NULL DEFAULT '[]',
      failure_conditions TEXT NOT NULL DEFAULT '[]',
      constraints TEXT NOT NULL DEFAULT '{}',
      strategy TEXT NOT NULL DEFAULT 'balanced'
        CHECK(strategy IN ('conservative', 'balanced', 'aggressive')),
      retry_policy TEXT NOT NULL DEFAULT '{}',
      context TEXT NOT NULL DEFAULT '{}',
      priority TEXT NOT NULL DEFAULT 'medium'
        CHECK(priority IN ('low', 'medium', 'high', 'critical')),
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending', 'queued', 'running', 'paused', 'completed', 'failed', 'cancelled')),
      current_step INTEGER NOT NULL DEFAULT 0,
      last_checkpoint_id TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER,
      started_at INTEGER,
      completed_at INTEGER,
      paused_at INTEGER,
      result TEXT,
      error TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_auto_tasks_status ON autonomous_tasks(status);
    CREATE INDEX IF NOT EXISTS idx_auto_tasks_priority ON autonomous_tasks(priority, created_at ASC);
    CREATE INDEX IF NOT EXISTS idx_auto_tasks_created ON autonomous_tasks(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_auto_tasks_paused_at ON autonomous_tasks(paused_at) WHERE paused_at IS NOT NULL;

    CREATE TABLE IF NOT EXISTS task_checkpoints (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      step INTEGER NOT NULL,
      state TEXT NOT NULL DEFAULT '{}',
      tool_calls TEXT NOT NULL DEFAULT '[]',
      next_action_hint TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      FOREIGN KEY (task_id) REFERENCES autonomous_tasks(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_checkpoints_task ON task_checkpoints(task_id, step DESC);

    CREATE TABLE IF NOT EXISTS execution_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      step INTEGER NOT NULL,
      event_type TEXT NOT NULL
        CHECK(event_type IN ('plan', 'tool_call', 'tool_result', 'reflect', 'checkpoint', 'escalate', 'error', 'info')),
      message TEXT NOT NULL,
      data TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      FOREIGN KEY (task_id) REFERENCES autonomous_tasks(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_exec_logs_task ON execution_logs(task_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_exec_logs_type ON execution_logs(event_type);

    -- Policy engine runtime state, keyed by task. Persists rate-limit
    -- timestamps, loop-detection recent actions, and uncertainty counter so
    -- that pause/resume cannot bypass policy windows (issue #256).
    CREATE TABLE IF NOT EXISTS policy_state (
      task_id TEXT PRIMARY KEY,
      state TEXT NOT NULL DEFAULT '{}',
      updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
      FOREIGN KEY (task_id) REFERENCES autonomous_tasks(id) ON DELETE CASCADE
    );

    -- Settled TON spend shared by all autonomous tasks. The UTC date is part
    -- of the key so a new day starts with an empty budget without a reset job.
    CREATE TABLE IF NOT EXISTS autonomous_daily_ton_spend (
      wallet_key TEXT NOT NULL,
      utc_date TEXT NOT NULL,
      amount REAL NOT NULL DEFAULT 0 CHECK(amount >= 0),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
      PRIMARY KEY (wallet_key, utc_date)
    );

    -- =====================================================
    -- JOURNAL (Trading & Business Operations)
    -- =====================================================
    ${JOURNAL_SCHEMA}
  `);
}

export function ensureVectorTables(db: Database.Database, dimensions: number): boolean {
  const existingDims = db
    .prepare(
      `
    SELECT sql FROM sqlite_master
    WHERE type='table' AND name='knowledge_vec'
  `
    )
    .get() as { sql?: string } | undefined;

  let dimensionsChanged = false;
  if (existingDims?.sql && !existingDims.sql.includes(`[${dimensions}]`)) {
    db.exec(`DROP TABLE IF EXISTS knowledge_vec`);
    db.exec(`DROP TABLE IF EXISTS tg_messages_vec`);
    dimensionsChanged = true;
  }

  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_vec USING vec0(
      id TEXT PRIMARY KEY,
      embedding FLOAT[${dimensions}] distance_metric=cosine
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS tg_messages_vec USING vec0(
      id TEXT PRIMARY KEY,
      embedding FLOAT[${dimensions}] distance_metric=cosine
    );
  `);

  return dimensionsChanged;
}

export function getSchemaVersion(db: Database.Database): string | null {
  const row = db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function setSchemaVersion(db: Database.Database, version: string): void {
  db.prepare(
    `
    INSERT INTO meta (key, value, updated_at)
    VALUES ('schema_version', ?, unixepoch())
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `
  ).run(version);
}

function getPragmaFlag(db: Database.Database, name: string): boolean {
  return Number(db.pragma(name, { simple: true })) === 1;
}

function setPragmaFlag(db: Database.Database, name: string, enabled: boolean): void {
  db.pragma(`${name} = ${enabled ? "ON" : "OFF"}`);
}

function withAutonomousTaskTableRebuildPragmas<T>(db: Database.Database, fn: () => T): T {
  const foreignKeysEnabled = getPragmaFlag(db, "foreign_keys");
  const legacyAlterTableEnabled = getPragmaFlag(db, "legacy_alter_table");

  setPragmaFlag(db, "foreign_keys", false);
  setPragmaFlag(db, "legacy_alter_table", true);
  try {
    return fn();
  } finally {
    setPragmaFlag(db, "legacy_alter_table", legacyAlterTableEnabled);
    setPragmaFlag(db, "foreign_keys", foreignKeysEnabled);
  }
}

function runMigrationTransaction(db: Database.Database, fn: () => void): void {
  db.exec("BEGIN");
  try {
    fn();
    db.exec("COMMIT");
  } catch (error) {
    if (db.inTransaction) {
      db.exec("ROLLBACK");
    }
    throw error;
  }
}

function tableExists(db: Database.Database, tableName: string): boolean {
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(tableName);
  return Boolean(row);
}

function tableHasForeignKeyTarget(
  db: Database.Database,
  tableName: string,
  targetTableName: string
): boolean {
  if (!tableExists(db, tableName)) {
    return false;
  }

  const foreignKeys = db.prepare(`PRAGMA foreign_key_list(${tableName})`).all() as Array<{
    table: string;
  }>;
  return foreignKeys.some((foreignKey) => foreignKey.table === targetTableName);
}

interface AutonomousTaskChildTable {
  name: string;
  tempName: string;
  columns: string;
  createTempSql: string;
  createIndexesSql: string;
}

const AUTONOMOUS_TASK_CHILD_TABLES: AutonomousTaskChildTable[] = [
  {
    name: "task_checkpoints",
    tempName: "task_checkpoints_fk_repair",
    columns: "id, task_id, step, state, tool_calls, next_action_hint, created_at",
    createTempSql: `
      CREATE TABLE task_checkpoints_fk_repair (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        step INTEGER NOT NULL,
        state TEXT NOT NULL DEFAULT '{}',
        tool_calls TEXT NOT NULL DEFAULT '[]',
        next_action_hint TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        FOREIGN KEY (task_id) REFERENCES autonomous_tasks(id) ON DELETE CASCADE
      );
    `,
    createIndexesSql: `
      CREATE INDEX IF NOT EXISTS idx_checkpoints_task ON task_checkpoints(task_id, step DESC);
    `,
  },
  {
    name: "execution_logs",
    tempName: "execution_logs_fk_repair",
    columns: "id, task_id, step, event_type, message, data, created_at",
    createTempSql: `
      CREATE TABLE execution_logs_fk_repair (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        step INTEGER NOT NULL,
        event_type TEXT NOT NULL
          CHECK(event_type IN ('plan', 'tool_call', 'tool_result', 'reflect', 'checkpoint', 'escalate', 'error', 'info')),
        message TEXT NOT NULL,
        data TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        FOREIGN KEY (task_id) REFERENCES autonomous_tasks(id) ON DELETE CASCADE
      );
    `,
    createIndexesSql: `
      CREATE INDEX IF NOT EXISTS idx_exec_logs_task ON execution_logs(task_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_exec_logs_type ON execution_logs(event_type);
    `,
  },
  {
    name: "policy_state",
    tempName: "policy_state_fk_repair",
    columns: "task_id, state, updated_at",
    createTempSql: `
      CREATE TABLE policy_state_fk_repair (
        task_id TEXT PRIMARY KEY,
        state TEXT NOT NULL DEFAULT '{}',
        updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
        FOREIGN KEY (task_id) REFERENCES autonomous_tasks(id) ON DELETE CASCADE
      );
    `,
    createIndexesSql: "",
  },
];

function repairAutonomousTaskChildForeignKeys(db: Database.Database): number {
  const tablesToRepair = AUTONOMOUS_TASK_CHILD_TABLES.filter((table) =>
    tableHasForeignKeyTarget(db, table.name, "autonomous_tasks_old")
  );
  if (tablesToRepair.length === 0) {
    return 0;
  }

  withAutonomousTaskTableRebuildPragmas(db, () => {
    runMigrationTransaction(db, () => {
      for (const table of tablesToRepair) {
        db.exec(`
          DROP TABLE IF EXISTS ${table.tempName};
          ${table.createTempSql}
          INSERT INTO ${table.tempName} (${table.columns})
          SELECT ${table.columns} FROM ${table.name};
          DROP TABLE ${table.name};
          ALTER TABLE ${table.tempName} RENAME TO ${table.name};
          ${table.createIndexesSql}
        `);
      }
    });
  });

  return tablesToRepair.length;
}

export const CURRENT_SCHEMA_VERSION = "1.42.0";

export function runMigrations(db: Database.Database): void {
  const currentVersion = getSchemaVersion(db);
  if (!currentVersion || versionLessThan(currentVersion, "1.1.0")) {
    log.info("Running migration: Adding scheduled task columns...");

    try {
      const tableExists = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='tasks'")
        .get();

      if (!tableExists) {
        log.info("Tasks table doesn't exist yet, skipping column migration");
        setSchemaVersion(db, CURRENT_SCHEMA_VERSION);
        return;
      }

      const tableInfo = db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
      const existingColumns = tableInfo.map((col) => col.name);
      if (!existingColumns.includes("scheduled_for")) {
        db.exec(`ALTER TABLE tasks ADD COLUMN scheduled_for INTEGER`);
      }
      if (!existingColumns.includes("payload")) {
        db.exec(`ALTER TABLE tasks ADD COLUMN payload TEXT`);
      }
      if (!existingColumns.includes("reason")) {
        db.exec(`ALTER TABLE tasks ADD COLUMN reason TEXT`);
      }
      if (!existingColumns.includes("scheduled_message_id")) {
        db.exec(`ALTER TABLE tasks ADD COLUMN scheduled_message_id INTEGER`);
      }

      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_tasks_scheduled ON tasks(scheduled_for) WHERE scheduled_for IS NOT NULL`
      );

      db.exec(`
        CREATE TABLE IF NOT EXISTS task_dependencies (
          task_id TEXT NOT NULL,
          depends_on_task_id TEXT NOT NULL,
          PRIMARY KEY (task_id, depends_on_task_id),
          FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
          FOREIGN KEY (depends_on_task_id) REFERENCES tasks(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_task_deps_task ON task_dependencies(task_id);
        CREATE INDEX IF NOT EXISTS idx_task_deps_parent ON task_dependencies(depends_on_task_id);
      `);

      log.info("Migration 1.1.0 complete: Scheduled tasks support added");
    } catch (error) {
      log.error({ err: error }, "Migration 1.1.0 failed");
      throw error;
    }
  }
  if (!currentVersion || versionLessThan(currentVersion, "1.2.0")) {
    try {
      log.info("Running migration 1.2.0: Extend sessions table for SQLite backend");

      // Add missing columns to sessions table
      const addColumnIfNotExists = (table: string, column: string, type: string) => {
        try {
          db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
        } catch (e: unknown) {
          if (!(e instanceof Error) || !e.message.includes("duplicate column name")) {
            throw e;
          }
        }
      };

      addColumnIfNotExists(
        "sessions",
        "updated_at",
        "INTEGER NOT NULL DEFAULT (unixepoch() * 1000)"
      );
      addColumnIfNotExists("sessions", "last_message_id", "INTEGER");
      addColumnIfNotExists("sessions", "last_channel", "TEXT");
      addColumnIfNotExists("sessions", "last_to", "TEXT");
      addColumnIfNotExists("sessions", "context_tokens", "INTEGER");
      addColumnIfNotExists("sessions", "model", "TEXT");
      addColumnIfNotExists("sessions", "provider", "TEXT");
      addColumnIfNotExists("sessions", "last_reset_date", "TEXT");

      const sessions = db.prepare("SELECT started_at FROM sessions LIMIT 1").all() as Array<{
        started_at: number;
      }>;
      if (sessions.length > 0 && sessions[0].started_at < 1000000000000) {
        db.exec(
          "UPDATE sessions SET started_at = started_at * 1000 WHERE started_at < 1000000000000"
        );
      }

      db.exec("CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at DESC)");

      log.info("Migration 1.2.0 complete: Sessions table extended");
    } catch (error) {
      log.error({ err: error }, "Migration 1.2.0 failed");
      throw error;
    }
  }
  if (!currentVersion || versionLessThan(currentVersion, "1.9.0")) {
    log.info("Running migration 1.9.0: Upgrade embedding_cache to BLOB storage");
    try {
      db.exec(`DROP TABLE IF EXISTS embedding_cache`);
      db.exec(`
        CREATE TABLE IF NOT EXISTS embedding_cache (
          hash TEXT NOT NULL,
          model TEXT NOT NULL,
          provider TEXT NOT NULL,
          embedding BLOB NOT NULL,
          dims INTEGER NOT NULL,
          created_at INTEGER NOT NULL DEFAULT (unixepoch()),
          accessed_at INTEGER NOT NULL DEFAULT (unixepoch()),
          PRIMARY KEY (hash, model, provider)
        );
        CREATE INDEX IF NOT EXISTS idx_embedding_cache_accessed ON embedding_cache(accessed_at);
      `);
      log.info("Migration 1.9.0 complete: embedding_cache upgraded to BLOB storage");
    } catch (error) {
      log.error({ err: error }, "Migration 1.9.0 failed");
      throw error;
    }
  }

  if (!currentVersion || versionLessThan(currentVersion, "1.10.0")) {
    log.info("Running migration 1.10.0: Add tool_config table for runtime tool management");
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS tool_config (
          tool_name TEXT PRIMARY KEY,
          enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
          scope TEXT CHECK(scope IN ('always', 'dm-only', 'group-only', 'admin-only')),
          updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
          updated_by INTEGER
        );
      `);
      log.info("Migration 1.10.0 complete: tool_config table created");
    } catch (error) {
      log.error({ err: error }, "Migration 1.10.0 failed");
      throw error;
    }
  }

  if (!currentVersion || versionLessThan(currentVersion, "1.10.1")) {
    log.info("Running migration 1.10.1: Fix tool_config scope CHECK constraint (add admin-only)");
    try {
      db.transaction(() => {
        db.exec(`
          CREATE TABLE IF NOT EXISTS tool_config_new (
            tool_name TEXT PRIMARY KEY,
            enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
            scope TEXT CHECK(scope IN ('always', 'dm-only', 'group-only', 'admin-only')),
            updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
            updated_by INTEGER
          );
          INSERT OR IGNORE INTO tool_config_new SELECT * FROM tool_config;
          DROP TABLE tool_config;
          ALTER TABLE tool_config_new RENAME TO tool_config;
        `);
      })();
      log.info("Migration 1.10.1 complete: tool_config CHECK constraint updated");
    } catch (error) {
      log.error({ err: error }, "Migration 1.10.1 failed");
      throw error;
    }
  }

  if (!currentVersion || versionLessThan(currentVersion, "1.11.0")) {
    log.info("Running migration 1.11.0: Add tool_index tables for Tool RAG");
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS tool_index (
          name TEXT PRIMARY KEY,
          description TEXT NOT NULL,
          search_text TEXT NOT NULL,
          updated_at INTEGER NOT NULL DEFAULT (unixepoch())
        );

        CREATE VIRTUAL TABLE IF NOT EXISTS tool_index_fts USING fts5(
          search_text,
          name UNINDEXED,
          content='tool_index',
          content_rowid='rowid'
        );

        CREATE TRIGGER IF NOT EXISTS tool_index_fts_insert AFTER INSERT ON tool_index BEGIN
          INSERT INTO tool_index_fts(rowid, search_text, name)
          VALUES (new.rowid, new.search_text, new.name);
        END;

        CREATE TRIGGER IF NOT EXISTS tool_index_fts_delete AFTER DELETE ON tool_index BEGIN
          INSERT INTO tool_index_fts(tool_index_fts, rowid, search_text, name)
          VALUES ('delete', old.rowid, old.search_text, old.name);
        END;

        CREATE TRIGGER IF NOT EXISTS tool_index_fts_update AFTER UPDATE ON tool_index BEGIN
          INSERT INTO tool_index_fts(tool_index_fts, rowid, search_text, name)
          VALUES ('delete', old.rowid, old.search_text, old.name);
          INSERT INTO tool_index_fts(rowid, search_text, name)
          VALUES (new.rowid, new.search_text, new.name);
        END;
      `);
      log.info("Migration 1.11.0 complete: tool_index tables created");
    } catch (error) {
      log.error({ err: error }, "Migration 1.11.0 failed");
      throw error;
    }
  }

  if (!currentVersion || versionLessThan(currentVersion, "1.12.0")) {
    log.info("Running migration 1.12.0: Add exec_audit table");
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS exec_audit (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          timestamp INTEGER NOT NULL DEFAULT (unixepoch()),
          user_id INTEGER NOT NULL,
          username TEXT,
          tool TEXT NOT NULL,
          command TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          exit_code INTEGER,
          signal TEXT,
          duration_ms INTEGER,
          stdout TEXT,
          stderr TEXT,
          truncated INTEGER NOT NULL DEFAULT 0
        );

        CREATE INDEX IF NOT EXISTS idx_exec_audit_timestamp ON exec_audit(timestamp DESC);
        CREATE INDEX IF NOT EXISTS idx_exec_audit_user ON exec_audit(user_id);
      `);
      log.info("Migration 1.12.0 complete: exec_audit table created");
    } catch (error) {
      log.error({ err: error }, "Migration 1.12.0 failed");
      throw error;
    }
  }

  if (!currentVersion || versionLessThan(currentVersion, "1.13.0")) {
    log.info("Running migration 1.13.0: Add token usage columns to sessions");
    try {
      const addColumnIfNotExists = (table: string, column: string, type: string) => {
        try {
          db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
        } catch (e: unknown) {
          if (!(e instanceof Error) || !e.message.includes("duplicate column name")) {
            throw e;
          }
        }
      };

      addColumnIfNotExists("sessions", "input_tokens", "INTEGER DEFAULT 0");
      addColumnIfNotExists("sessions", "output_tokens", "INTEGER DEFAULT 0");

      log.info("Migration 1.13.0 complete: Token usage columns added to sessions");
    } catch (error) {
      log.error({ err: error }, "Migration 1.13.0 failed");
      throw error;
    }
  }

  if (!currentVersion || versionLessThan(currentVersion, "1.14.0")) {
    log.info("Running migration 1.14.0: Add plugin_config table for plugin priority");
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS plugin_config (
          plugin_name TEXT PRIMARY KEY,
          priority INTEGER NOT NULL DEFAULT 0,
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);
      log.info("Migration 1.14.0 complete: plugin_config table created");
    } catch (error) {
      log.error({ err: error }, "Migration 1.14.0 failed");
      throw error;
    }
  }

  if (!currentVersion || versionLessThan(currentVersion, "1.15.0")) {
    log.info("Running migration 1.15.0: Add user_hook_config table");
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS user_hook_config (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);
      log.info("Migration 1.15.0 complete: user_hook_config table created");
    } catch (error) {
      log.error({ err: error }, "Migration 1.15.0 failed");
      throw error;
    }
  }

  if (!currentVersion || versionLessThan(currentVersion, "1.16.0")) {
    log.info("Running migration 1.16.0: Add tool_usage table for per-tool execution statistics");
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS tool_usage (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          tool_name TEXT NOT NULL,
          success INTEGER NOT NULL DEFAULT 1 CHECK(success IN (0, 1)),
          duration_ms INTEGER,
          created_at INTEGER NOT NULL DEFAULT (unixepoch())
        );

        CREATE INDEX IF NOT EXISTS idx_tool_usage_tool ON tool_usage(tool_name);
        CREATE INDEX IF NOT EXISTS idx_tool_usage_created ON tool_usage(created_at DESC);
      `);
      log.info("Migration 1.16.0 complete: tool_usage table created");
    } catch (error) {
      log.error({ err: error }, "Migration 1.16.0 failed");
      throw error;
    }
  }

  if (!currentVersion || versionLessThan(currentVersion, "1.17.0")) {
    log.info(
      "Running migration 1.17.0: Add analytics tables (request_metrics, cost_records, budget_config)"
    );
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS request_metrics (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          tool_name TEXT,
          tokens_used INTEGER DEFAULT 0,
          duration_ms INTEGER,
          success INTEGER NOT NULL DEFAULT 1 CHECK(success IN (0, 1)),
          error_message TEXT,
          created_at INTEGER NOT NULL DEFAULT (unixepoch())
        );

        CREATE INDEX IF NOT EXISTS idx_request_metrics_created ON request_metrics(created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_request_metrics_tool ON request_metrics(tool_name) WHERE tool_name IS NOT NULL;

        CREATE TABLE IF NOT EXISTS cost_records (
          date TEXT PRIMARY KEY,
          tokens_input INTEGER DEFAULT 0,
          tokens_output INTEGER DEFAULT 0,
          cost_usd REAL DEFAULT 0,
          request_count INTEGER DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS budget_config (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at INTEGER NOT NULL DEFAULT (unixepoch())
        );
      `);
      log.info("Migration 1.17.0 complete: analytics tables created");
    } catch (error) {
      log.error({ err: error }, "Migration 1.17.0 failed");
      throw error;
    }
  }

  if (!currentVersion || versionLessThan(currentVersion, "1.18.0")) {
    log.info("Running migration 1.18.0: Add workflows table for workflow automation");
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS workflows (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          description TEXT,
          enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
          config TEXT NOT NULL DEFAULT '{}',
          created_at INTEGER NOT NULL DEFAULT (unixepoch()),
          updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
          last_run_at INTEGER,
          run_count INTEGER NOT NULL DEFAULT 0,
          last_error TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_workflows_enabled ON workflows(enabled);
        CREATE INDEX IF NOT EXISTS idx_workflows_created ON workflows(created_at DESC);
      `);
      log.info("Migration 1.18.0 complete: workflows table created");
    } catch (error) {
      log.error({ err: error }, "Migration 1.18.0 failed");
      throw error;
    }
  }

  if (!currentVersion || versionLessThan(currentVersion, "1.19.0")) {
    log.info("Running migration 1.19.0: Add recurrence columns to tasks table");
    try {
      const addColumnIfNotExists = (table: string, column: string, type: string) => {
        try {
          db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
        } catch (e: unknown) {
          if (!(e instanceof Error) || !e.message.includes("duplicate column name")) {
            throw e;
          }
        }
      };

      addColumnIfNotExists("tasks", "recurrence_interval", "INTEGER");
      addColumnIfNotExists("tasks", "recurrence_until", "INTEGER");

      log.info("Migration 1.19.0 complete: recurrence columns added to tasks table");
    } catch (error) {
      log.error({ err: error }, "Migration 1.19.0 failed");
      throw error;
    }
  }

  if (!currentVersion || versionLessThan(currentVersion, "1.20.0")) {
    log.info("Running migration 1.20.0: Add Autonomous Task Engine tables");
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS autonomous_tasks (
          id TEXT PRIMARY KEY,
          goal TEXT NOT NULL,
          success_criteria TEXT NOT NULL DEFAULT '[]',
          failure_conditions TEXT NOT NULL DEFAULT '[]',
          constraints TEXT NOT NULL DEFAULT '{}',
          strategy TEXT NOT NULL DEFAULT 'balanced'
            CHECK(strategy IN ('conservative', 'balanced', 'aggressive')),
          retry_policy TEXT NOT NULL DEFAULT '{}',
          context TEXT NOT NULL DEFAULT '{}',
          priority TEXT NOT NULL DEFAULT 'medium'
            CHECK(priority IN ('low', 'medium', 'high', 'critical')),
          status TEXT NOT NULL DEFAULT 'pending'
            CHECK(status IN ('pending', 'queued', 'running', 'paused', 'completed', 'failed', 'cancelled')),
          current_step INTEGER NOT NULL DEFAULT 0,
          last_checkpoint_id TEXT,
          created_at INTEGER NOT NULL DEFAULT (unixepoch()),
          updated_at INTEGER,
          started_at INTEGER,
          completed_at INTEGER,
          result TEXT,
          error TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_auto_tasks_status ON autonomous_tasks(status);
        CREATE INDEX IF NOT EXISTS idx_auto_tasks_priority ON autonomous_tasks(priority, created_at ASC);
        CREATE INDEX IF NOT EXISTS idx_auto_tasks_created ON autonomous_tasks(created_at DESC);

        CREATE TABLE IF NOT EXISTS task_checkpoints (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL,
          step INTEGER NOT NULL,
          state TEXT NOT NULL DEFAULT '{}',
          tool_calls TEXT NOT NULL DEFAULT '[]',
          next_action_hint TEXT,
          created_at INTEGER NOT NULL DEFAULT (unixepoch()),
          FOREIGN KEY (task_id) REFERENCES autonomous_tasks(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_checkpoints_task ON task_checkpoints(task_id, step DESC);

        CREATE TABLE IF NOT EXISTS execution_logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          task_id TEXT NOT NULL,
          step INTEGER NOT NULL,
          event_type TEXT NOT NULL
            CHECK(event_type IN ('plan', 'tool_call', 'tool_result', 'reflect', 'checkpoint', 'escalate', 'error', 'info')),
          message TEXT NOT NULL,
          data TEXT,
          created_at INTEGER NOT NULL DEFAULT (unixepoch()),
          FOREIGN KEY (task_id) REFERENCES autonomous_tasks(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_exec_logs_task ON execution_logs(task_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_exec_logs_type ON execution_logs(event_type);
      `);
      log.info("Migration 1.20.0 complete: Autonomous Task Engine tables created");
    } catch (error) {
      log.error({ err: error }, "Migration 1.20.0 failed");
      throw error;
    }
  }

  if (!currentVersion || versionLessThan(currentVersion, "1.21.0")) {
    log.info("Running migration 1.21.0: Add associative memory graph tables");
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS graph_nodes (
          id TEXT PRIMARY KEY,
          type TEXT NOT NULL CHECK(type IN ('conversation', 'task', 'tool', 'topic', 'entity', 'outcome')),
          label TEXT NOT NULL,
          normalized_label TEXT NOT NULL,
          metadata TEXT NOT NULL DEFAULT '{}',
          created_at INTEGER NOT NULL DEFAULT (unixepoch()),
          updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
          UNIQUE(type, normalized_label)
        );

        CREATE INDEX IF NOT EXISTS idx_graph_nodes_type ON graph_nodes(type);
        CREATE INDEX IF NOT EXISTS idx_graph_nodes_updated ON graph_nodes(updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_graph_nodes_label ON graph_nodes(label);

        CREATE TABLE IF NOT EXISTS graph_edges (
          id TEXT PRIMARY KEY,
          source_id TEXT NOT NULL,
          target_id TEXT NOT NULL,
          relation TEXT NOT NULL,
          weight REAL NOT NULL DEFAULT 1.0,
          created_at INTEGER NOT NULL DEFAULT (unixepoch()),
          FOREIGN KEY (source_id) REFERENCES graph_nodes(id) ON DELETE CASCADE,
          FOREIGN KEY (target_id) REFERENCES graph_nodes(id) ON DELETE CASCADE,
          UNIQUE(source_id, target_id, relation)
        );

        CREATE INDEX IF NOT EXISTS idx_graph_edges_source ON graph_edges(source_id);
        CREATE INDEX IF NOT EXISTS idx_graph_edges_target ON graph_edges(target_id);
        CREATE INDEX IF NOT EXISTS idx_graph_edges_relation ON graph_edges(relation);
      `);
      log.info("Migration 1.21.0 complete: memory graph tables created");
    } catch (error) {
      log.error({ err: error }, "Migration 1.21.0 failed");
      throw error;
    }
  }

  if (!currentVersion || versionLessThan(currentVersion, "1.22.0")) {
    log.info("Running migration 1.22.0: Add memory prioritization tables");
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS memory_scores (
          memory_id TEXT PRIMARY KEY,
          score REAL NOT NULL DEFAULT 0 CHECK(score >= 0 AND score <= 1),
          recency REAL NOT NULL DEFAULT 0 CHECK(recency >= 0 AND recency <= 1),
          frequency REAL NOT NULL DEFAULT 0 CHECK(frequency >= 0 AND frequency <= 1),
          impact REAL NOT NULL DEFAULT 0 CHECK(impact >= 0 AND impact <= 1),
          explicit REAL NOT NULL DEFAULT 0 CHECK(explicit >= 0 AND explicit <= 1),
          centrality REAL NOT NULL DEFAULT 0 CHECK(centrality >= 0 AND centrality <= 1),
          access_count INTEGER NOT NULL DEFAULT 0,
          impact_count INTEGER NOT NULL DEFAULT 0,
          pinned INTEGER NOT NULL DEFAULT 0 CHECK(pinned IN (0, 1)),
          last_accessed_at INTEGER,
          updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
          FOREIGN KEY (memory_id) REFERENCES knowledge(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_memory_scores_score ON memory_scores(score DESC);
        CREATE INDEX IF NOT EXISTS idx_memory_scores_updated ON memory_scores(updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_memory_scores_pinned ON memory_scores(pinned) WHERE pinned = 1;

        CREATE TABLE IF NOT EXISTS memory_archive (
          archive_id INTEGER PRIMARY KEY AUTOINCREMENT,
          memory_id TEXT NOT NULL,
          source TEXT NOT NULL,
          path TEXT,
          text TEXT NOT NULL,
          embedding TEXT,
          start_line INTEGER,
          end_line INTEGER,
          hash TEXT NOT NULL,
          original_created_at INTEGER NOT NULL,
          original_updated_at INTEGER NOT NULL,
          score REAL NOT NULL DEFAULT 0,
          score_breakdown TEXT NOT NULL DEFAULT '{}',
          archived_at INTEGER NOT NULL DEFAULT (unixepoch()),
          delete_after INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_memory_archive_memory_id ON memory_archive(memory_id);
        CREATE INDEX IF NOT EXISTS idx_memory_archive_delete_after ON memory_archive(delete_after);

        CREATE TABLE IF NOT EXISTS memory_cleanup_history (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          mode TEXT NOT NULL CHECK(mode IN ('dry_run', 'archive', 'prune_archive')),
          candidates INTEGER NOT NULL DEFAULT 0,
          archived INTEGER NOT NULL DEFAULT 0,
          deleted INTEGER NOT NULL DEFAULT 0,
          protected INTEGER NOT NULL DEFAULT 0,
          reason TEXT,
          created_at INTEGER NOT NULL DEFAULT (unixepoch())
        );

        CREATE INDEX IF NOT EXISTS idx_memory_cleanup_history_created ON memory_cleanup_history(created_at DESC);
      `);
      log.info("Migration 1.22.0 complete: memory prioritization tables created");
    } catch (error) {
      log.error({ err: error }, "Migration 1.22.0 failed");
      throw error;
    }
  }

  if (!currentVersion || versionLessThan(currentVersion, "1.23.0")) {
    log.info("Running migration 1.23.0: Add policy_state table for policy engine persistence");
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS policy_state (
          task_id TEXT PRIMARY KEY,
          state TEXT NOT NULL DEFAULT '{}',
          updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
          FOREIGN KEY (task_id) REFERENCES autonomous_tasks(id) ON DELETE CASCADE
        );
      `);
      log.info("Migration 1.23.0 complete: policy_state table created");
    } catch (error) {
      log.error({ err: error }, "Migration 1.23.0 failed");
      throw error;
    }
  }

  if (!currentVersion || versionLessThan(currentVersion, "1.24.0")) {
    log.info("Running migration 1.24.0: Add 'queued' status to autonomous_tasks");
    try {
      // When ensureSchema() has already created the latest-schema table in the
      // same session, the CHECK constraint already permits 'queued' and we
      // would otherwise INSERT SELECT * across tables whose column counts no
      // longer match (e.g. paused_at added in 1.25.0). Skip the rebuild in
      // that case — the table already matches the post-1.24.0 shape.
      const statusSupportsQueued = (() => {
        const row = db
          .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='autonomous_tasks'`)
          .get() as { sql?: string } | undefined;
        return Boolean(row?.sql && /'queued'/.test(row.sql));
      })();

      if (!statusSupportsQueued) {
        // SQLite does not support ALTER COLUMN CHECK constraints, so we use
        // the recommended rename-create-copy-drop approach inside a
        // transaction. List columns explicitly so the copy is robust to
        // extra columns added by other migrations running in the same pass.
        withAutonomousTaskTableRebuildPragmas(db, () => {
          runMigrationTransaction(db, () => {
            db.exec(`
              ALTER TABLE autonomous_tasks RENAME TO autonomous_tasks_old;
              CREATE TABLE autonomous_tasks (
                id TEXT PRIMARY KEY,
                goal TEXT NOT NULL,
                success_criteria TEXT NOT NULL DEFAULT '[]',
                failure_conditions TEXT NOT NULL DEFAULT '[]',
                constraints TEXT NOT NULL DEFAULT '{}',
                strategy TEXT NOT NULL DEFAULT 'balanced'
                  CHECK(strategy IN ('conservative', 'balanced', 'aggressive')),
                retry_policy TEXT NOT NULL DEFAULT '{}',
                context TEXT NOT NULL DEFAULT '{}',
                priority TEXT NOT NULL DEFAULT 'medium'
                  CHECK(priority IN ('low', 'medium', 'high', 'critical')),
                status TEXT NOT NULL DEFAULT 'pending'
                  CHECK(status IN ('pending', 'queued', 'running', 'paused', 'completed', 'failed', 'cancelled')),
                current_step INTEGER NOT NULL DEFAULT 0,
                last_checkpoint_id TEXT,
                created_at INTEGER NOT NULL DEFAULT (unixepoch()),
                updated_at INTEGER,
                started_at INTEGER,
                completed_at INTEGER,
                result TEXT,
                error TEXT
              );
              INSERT INTO autonomous_tasks (
                id, goal, success_criteria, failure_conditions, constraints,
                strategy, retry_policy, context, priority, status, current_step,
                last_checkpoint_id, created_at, updated_at, started_at,
                completed_at, result, error
              )
              SELECT
                id, goal, success_criteria, failure_conditions, constraints,
                strategy, retry_policy, context, priority, status, current_step,
                last_checkpoint_id, created_at, updated_at, started_at,
                completed_at, result, error
              FROM autonomous_tasks_old;
              DROP TABLE autonomous_tasks_old;
            `);
          });
        });
        log.info("Migration 1.24.0 complete: 'queued' status added to autonomous_tasks");
      } else {
        log.info("Migration 1.24.0 skipped: autonomous_tasks already supports 'queued' status");
      }
    } catch (error) {
      log.error({ err: error }, "Migration 1.24.0 failed");
      throw error;
    }
  }

  if (!currentVersion || versionLessThan(currentVersion, "1.25.0")) {
    log.info("Running migration 1.25.0: Add paused_at column to autonomous_tasks (AUDIT-M5)");
    try {
      const columns = db.prepare(`PRAGMA table_info(autonomous_tasks)`).all() as Array<{
        name: string;
      }>;
      if (!columns.some((col) => col.name === "paused_at")) {
        db.exec(`ALTER TABLE autonomous_tasks ADD COLUMN paused_at INTEGER`);
      }
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_auto_tasks_paused_at ON autonomous_tasks(paused_at) WHERE paused_at IS NOT NULL`
      );
      log.info("Migration 1.25.0 complete: paused_at column added");
    } catch (error) {
      log.error({ err: error }, "Migration 1.25.0 failed");
      throw error;
    }
  }

  if (!currentVersion || versionLessThan(currentVersion, "1.26.0")) {
    log.info("Running migration 1.26.0: Add last_fired_bucket to workflows (AUDIT-M7)");
    try {
      const tableExists = db
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='workflows'`)
        .get();
      if (tableExists) {
        const columns = db.prepare(`PRAGMA table_info(workflows)`).all() as Array<{ name: string }>;
        if (!columns.some((col) => col.name === "last_fired_bucket")) {
          db.exec(`ALTER TABLE workflows ADD COLUMN last_fired_bucket INTEGER`);
        }
      }
      log.info("Migration 1.26.0 complete: last_fired_bucket column added");
    } catch (error) {
      log.error({ err: error }, "Migration 1.26.0 failed");
      throw error;
    }
  }

  if (!currentVersion || versionLessThan(currentVersion, "1.27.0")) {
    log.info("Running migration 1.27.0: Add agent_registry table");
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS agent_registry (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          type TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          config TEXT NOT NULL DEFAULT '{}',
          soul_template TEXT NOT NULL DEFAULT '',
          tools TEXT NOT NULL DEFAULT '[]',
          status TEXT NOT NULL DEFAULT 'stopped',
          created_at INTEGER NOT NULL DEFAULT (unixepoch()),
          updated_at INTEGER NOT NULL DEFAULT (unixepoch())
        );

        CREATE INDEX IF NOT EXISTS idx_agent_registry_type ON agent_registry(type);
        CREATE INDEX IF NOT EXISTS idx_agent_registry_status ON agent_registry(status);
        CREATE INDEX IF NOT EXISTS idx_agent_registry_updated ON agent_registry(updated_at DESC);
      `);
      log.info("Migration 1.27.0 complete: agent_registry table created");
    } catch (error) {
      log.error({ err: error }, "Migration 1.27.0 failed");
      throw error;
    }
  }

  if (!currentVersion || versionLessThan(currentVersion, "1.28.0")) {
    log.info("Running migration 1.28.0: Add task delegation tables");
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS task_subtasks (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL,
          parent_id TEXT,
          description TEXT NOT NULL,
          required_skills TEXT NOT NULL DEFAULT '[]',
          required_tools TEXT NOT NULL DEFAULT '[]',
          agent_id TEXT,
          status TEXT NOT NULL DEFAULT 'pending'
            CHECK(status IN ('pending', 'delegated', 'in_progress', 'done', 'failed', 'cancelled')),
          result TEXT,
          error TEXT,
          depth INTEGER NOT NULL DEFAULT 1 CHECK(depth >= 1 AND depth <= 3),
          created_at INTEGER NOT NULL DEFAULT (unixepoch()),
          updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
          started_at INTEGER,
          completed_at INTEGER,
          FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
          FOREIGN KEY (parent_id) REFERENCES task_subtasks(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_task_subtasks_task ON task_subtasks(task_id, depth, created_at);
        CREATE INDEX IF NOT EXISTS idx_task_subtasks_parent ON task_subtasks(parent_id) WHERE parent_id IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_task_subtasks_agent ON task_subtasks(agent_id) WHERE agent_id IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_task_subtasks_status ON task_subtasks(status);

        CREATE TABLE IF NOT EXISTS task_subtask_dependencies (
          subtask_id TEXT NOT NULL,
          depends_on_subtask_id TEXT NOT NULL,
          PRIMARY KEY (subtask_id, depends_on_subtask_id),
          FOREIGN KEY (subtask_id) REFERENCES task_subtasks(id) ON DELETE CASCADE,
          FOREIGN KEY (depends_on_subtask_id) REFERENCES task_subtasks(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_subtask_deps_subtask ON task_subtask_dependencies(subtask_id);
        CREATE INDEX IF NOT EXISTS idx_subtask_deps_parent ON task_subtask_dependencies(depends_on_subtask_id);
      `);
      log.info("Migration 1.28.0 complete: task delegation tables created");
    } catch (error) {
      log.error({ err: error }, "Migration 1.28.0 failed");
      throw error;
    }
  }

  if (!currentVersion || versionLessThan(currentVersion, "1.29.0")) {
    log.info("Running migration 1.29.0: Add pipeline execution tables");
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS pipelines (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          description TEXT,
          steps TEXT NOT NULL DEFAULT '[]',
          enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
          error_strategy TEXT NOT NULL DEFAULT 'fail_fast'
            CHECK(error_strategy IN ('fail_fast', 'continue', 'retry')),
          max_retries INTEGER NOT NULL DEFAULT 0 CHECK(max_retries >= 0),
          timeout_seconds INTEGER,
          created_at INTEGER NOT NULL DEFAULT (unixepoch()),
          updated_at INTEGER NOT NULL DEFAULT (unixepoch())
        );

        CREATE INDEX IF NOT EXISTS idx_pipelines_enabled ON pipelines(enabled);
        CREATE INDEX IF NOT EXISTS idx_pipelines_created ON pipelines(created_at DESC);

        CREATE TABLE IF NOT EXISTS pipeline_runs (
          id TEXT PRIMARY KEY,
          pipeline_id TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending'
            CHECK(status IN ('pending', 'running', 'completed', 'failed', 'cancelled')),
          error_strategy TEXT NOT NULL DEFAULT 'fail_fast'
            CHECK(error_strategy IN ('fail_fast', 'continue', 'retry')),
          input_context TEXT NOT NULL DEFAULT '{}',
          context TEXT NOT NULL DEFAULT '{}',
          error TEXT,
          created_at INTEGER NOT NULL DEFAULT (unixepoch()),
          started_at INTEGER,
          completed_at INTEGER,
          updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
          FOREIGN KEY (pipeline_id) REFERENCES pipelines(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_pipeline_runs_pipeline ON pipeline_runs(pipeline_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_pipeline_runs_status ON pipeline_runs(status);

        CREATE TABLE IF NOT EXISTS pipeline_run_steps (
          run_id TEXT NOT NULL,
          pipeline_id TEXT NOT NULL,
          step_id TEXT NOT NULL,
          agent TEXT NOT NULL,
          action TEXT NOT NULL,
          output_name TEXT NOT NULL,
          depends_on TEXT NOT NULL DEFAULT '[]',
          status TEXT NOT NULL DEFAULT 'pending'
            CHECK(status IN ('pending', 'running', 'completed', 'failed', 'skipped', 'cancelled')),
          input_context TEXT,
          output_value TEXT,
          error TEXT,
          attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
          started_at INTEGER,
          completed_at INTEGER,
          updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
          PRIMARY KEY (run_id, step_id),
          FOREIGN KEY (run_id) REFERENCES pipeline_runs(id) ON DELETE CASCADE,
          FOREIGN KEY (pipeline_id) REFERENCES pipelines(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_pipeline_run_steps_run ON pipeline_run_steps(run_id, status);
        CREATE INDEX IF NOT EXISTS idx_pipeline_run_steps_pipeline ON pipeline_run_steps(pipeline_id);
      `);
      log.info("Migration 1.29.0 complete: pipeline execution tables created");
    } catch (error) {
      log.error({ err: error }, "Migration 1.29.0 failed");
      throw error;
    }
  }

  if (!currentVersion || versionLessThan(currentVersion, "1.30.0")) {
    log.info("Running migration 1.30.0: Add correction_logs table");
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS correction_logs (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          task_id TEXT,
          chat_id TEXT NOT NULL,
          iteration INTEGER NOT NULL,
          original_output TEXT NOT NULL,
          evaluation TEXT NOT NULL,
          reflection TEXT,
          corrected_output TEXT,
          score REAL NOT NULL CHECK(score >= 0 AND score <= 1),
          corrected_score REAL CHECK(corrected_score IS NULL OR (corrected_score >= 0 AND corrected_score <= 1)),
          score_delta REAL NOT NULL DEFAULT 0,
          threshold REAL NOT NULL DEFAULT 0.7,
          escalated INTEGER NOT NULL DEFAULT 0 CHECK(escalated IN (0, 1)),
          tool_recovery TEXT NOT NULL DEFAULT '[]',
          created_at INTEGER NOT NULL DEFAULT (unixepoch())
        );

        CREATE INDEX IF NOT EXISTS idx_correction_logs_session ON correction_logs(session_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_correction_logs_task ON correction_logs(task_id, created_at DESC) WHERE task_id IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_correction_logs_created ON correction_logs(created_at DESC);
      `);
      log.info("Migration 1.30.0 complete: correction_logs table created");
    } catch (error) {
      log.error({ err: error }, "Migration 1.30.0 failed");
      throw error;
    }
  }

  if (!currentVersion || versionLessThan(currentVersion, "1.31.0")) {
    log.info("Running migration 1.31.0: Add temporal context tables");
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS temporal_metadata (
          id TEXT PRIMARY KEY,
          entity_type TEXT NOT NULL CHECK(entity_type IN ('knowledge', 'message', 'session', 'task', 'behavior', 'request', 'tool')),
          entity_id TEXT NOT NULL,
          timestamp INTEGER NOT NULL,
          timezone TEXT NOT NULL DEFAULT 'UTC',
          day_of_week INTEGER NOT NULL CHECK(day_of_week >= 0 AND day_of_week <= 6),
          hour_of_day INTEGER NOT NULL CHECK(hour_of_day >= 0 AND hour_of_day <= 23),
          time_of_day TEXT NOT NULL CHECK(time_of_day IN ('morning', 'afternoon', 'evening', 'night')),
          relative_period TEXT NOT NULL CHECK(relative_period IN ('weekday', 'weekend')),
          session_phase TEXT NOT NULL DEFAULT 'unknown'
            CHECK(session_phase IN ('beginning', 'middle', 'end', 'unknown')),
          metadata TEXT NOT NULL DEFAULT '{}',
          updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
          UNIQUE(entity_type, entity_id)
        );

        CREATE INDEX IF NOT EXISTS idx_temporal_metadata_entity
          ON temporal_metadata(entity_type, entity_id);
        CREATE INDEX IF NOT EXISTS idx_temporal_metadata_time
          ON temporal_metadata(timestamp DESC);
        CREATE INDEX IF NOT EXISTS idx_temporal_metadata_day_hour
          ON temporal_metadata(day_of_week, hour_of_day);
        CREATE INDEX IF NOT EXISTS idx_temporal_metadata_markers
          ON temporal_metadata(time_of_day, relative_period);

        CREATE TABLE IF NOT EXISTS time_patterns (
          id TEXT PRIMARY KEY,
          pattern_type TEXT NOT NULL CHECK(pattern_type IN ('daily', 'weekly', 'recurring', 'seasonal', 'custom')),
          description TEXT NOT NULL,
          schedule_cron TEXT,
          confidence REAL NOT NULL DEFAULT 0 CHECK(confidence >= 0 AND confidence <= 1),
          frequency INTEGER NOT NULL DEFAULT 1,
          last_seen INTEGER NOT NULL,
          created_at INTEGER NOT NULL DEFAULT (unixepoch()),
          updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
          enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
          metadata TEXT NOT NULL DEFAULT '{}'
        );

        CREATE INDEX IF NOT EXISTS idx_time_patterns_type
          ON time_patterns(pattern_type, confidence DESC, frequency DESC);
        CREATE INDEX IF NOT EXISTS idx_time_patterns_last_seen
          ON time_patterns(last_seen DESC);
        CREATE INDEX IF NOT EXISTS idx_time_patterns_enabled
          ON time_patterns(enabled, confidence DESC) WHERE enabled = 1;
      `);
      log.info("Migration 1.31.0 complete: temporal context tables created");
    } catch (error) {
      log.error({ err: error }, "Migration 1.31.0 failed");
      throw error;
    }
  }

  if (!currentVersion || versionLessThan(currentVersion, "1.32.0")) {
    log.info("Running migration 1.32.0: Add unified integration registry tables");
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS integrations (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          type TEXT NOT NULL CHECK(type IN ('api', 'webhook', 'oauth', 'mcp')),
          provider TEXT NOT NULL DEFAULT 'custom-http',
          config TEXT NOT NULL DEFAULT '{}',
          auth TEXT NOT NULL DEFAULT '{"type":"none"}',
          auth_id TEXT,
          status TEXT NOT NULL DEFAULT 'unconfigured'
            CHECK(status IN ('unknown', 'healthy', 'degraded', 'unhealthy', 'unconfigured')),
          health_check_url TEXT,
          last_health_at INTEGER,
          last_health_message TEXT,
          created_at INTEGER NOT NULL DEFAULT (unixepoch()),
          updated_at INTEGER NOT NULL DEFAULT (unixepoch())
        );

        CREATE INDEX IF NOT EXISTS idx_integrations_type ON integrations(type);
        CREATE INDEX IF NOT EXISTS idx_integrations_provider ON integrations(provider);
        CREATE INDEX IF NOT EXISTS idx_integrations_status ON integrations(status);
        CREATE INDEX IF NOT EXISTS idx_integrations_updated ON integrations(updated_at DESC);

        CREATE TABLE IF NOT EXISTS integration_credentials (
          id TEXT PRIMARY KEY,
          integration_id TEXT NOT NULL,
          auth_type TEXT NOT NULL
            CHECK(auth_type IN ('none', 'api_key', 'oauth2', 'jwt', 'basic', 'custom_header')),
          credentials_encrypted TEXT NOT NULL,
          expires_at INTEGER,
          created_at INTEGER NOT NULL DEFAULT (unixepoch()),
          updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
          FOREIGN KEY (integration_id) REFERENCES integrations(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_integration_credentials_integration
          ON integration_credentials(integration_id);
        CREATE INDEX IF NOT EXISTS idx_integration_credentials_expires
          ON integration_credentials(expires_at) WHERE expires_at IS NOT NULL;

        CREATE TABLE IF NOT EXISTS integration_usage (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          integration_id TEXT NOT NULL,
          action TEXT NOT NULL,
          success INTEGER NOT NULL CHECK(success IN (0, 1)),
          latency_ms INTEGER,
          error TEXT,
          created_at INTEGER NOT NULL DEFAULT (unixepoch()),
          FOREIGN KEY (integration_id) REFERENCES integrations(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_integration_usage_integration
          ON integration_usage(integration_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_integration_usage_action
          ON integration_usage(action);
      `);
      log.info("Migration 1.32.0 complete: integration tables created");
    } catch (error) {
      log.error({ err: error }, "Migration 1.32.0 failed");
      throw error;
    }
  }

  if (!currentVersion || versionLessThan(currentVersion, "1.33.0")) {
    log.info("Running migration 1.33.0: Add tamper-evident audit_events table");
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS audit_events (
          id TEXT PRIMARY KEY,
          sequence INTEGER NOT NULL UNIQUE,
          event_type TEXT NOT NULL,
          actor TEXT NOT NULL DEFAULT 'system',
          session_id TEXT,
          payload TEXT NOT NULL DEFAULT '{}',
          parent_event_id TEXT,
          previous_checksum TEXT,
          checksum TEXT NOT NULL,
          created_at INTEGER NOT NULL DEFAULT (unixepoch()),
          FOREIGN KEY (parent_event_id) REFERENCES audit_events(id) ON DELETE SET NULL
        );

        CREATE INDEX IF NOT EXISTS idx_audit_events_created ON audit_events(created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_audit_events_type ON audit_events(event_type, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_audit_events_session ON audit_events(session_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_audit_events_actor ON audit_events(actor, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_audit_events_parent ON audit_events(parent_event_id);
        CREATE INDEX IF NOT EXISTS idx_audit_events_sequence ON audit_events(sequence);
      `);
      log.info("Migration 1.33.0 complete: audit_events table created");
    } catch (error) {
      log.error({ err: error }, "Migration 1.33.0 failed");
      throw error;
    }
  }

  if (!currentVersion || versionLessThan(currentVersion, "1.34.0")) {
    log.info("Running migration 1.34.0: Add dynamic dashboard tables");
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS widget_definitions (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          category TEXT NOT NULL CHECK(category IN ('metrics', 'status', 'content', 'action', 'custom')),
          data_source TEXT NOT NULL DEFAULT '{"type":"static"}',
          renderer TEXT NOT NULL CHECK(renderer IN ('chart', 'table', 'text', 'markdown', 'custom', 'kpi', 'list')),
          default_size TEXT NOT NULL DEFAULT '{"w":6,"h":4}',
          config_schema TEXT NOT NULL DEFAULT '{}',
          built_in INTEGER NOT NULL DEFAULT 0 CHECK(built_in IN (0, 1)),
          created_at INTEGER NOT NULL DEFAULT (unixepoch()),
          updated_at INTEGER NOT NULL DEFAULT (unixepoch())
        );

        CREATE INDEX IF NOT EXISTS idx_widget_definitions_category ON widget_definitions(category);
        CREATE INDEX IF NOT EXISTS idx_widget_definitions_renderer ON widget_definitions(renderer);

        CREATE TABLE IF NOT EXISTS dashboards (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          description TEXT,
          widgets TEXT NOT NULL DEFAULT '[]',
          layout TEXT NOT NULL DEFAULT '{}',
          is_default INTEGER NOT NULL DEFAULT 0 CHECK(is_default IN (0, 1)),
          created_at INTEGER NOT NULL DEFAULT (unixepoch()),
          updated_at INTEGER NOT NULL DEFAULT (unixepoch())
        );

        CREATE INDEX IF NOT EXISTS idx_dashboards_default ON dashboards(is_default) WHERE is_default = 1;
        CREATE INDEX IF NOT EXISTS idx_dashboards_created ON dashboards(created_at DESC);
      `);
      log.info("Migration 1.34.0 complete: dynamic dashboard tables created");
    } catch (error) {
      log.error({ err: error }, "Migration 1.34.0 failed");
      throw error;
    }
  }

  if (!currentVersion || versionLessThan(currentVersion, "1.35.0")) {
    log.info("Running migration 1.35.0: Add agent network protocol tables");
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS network_agents (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          endpoint TEXT NOT NULL,
          capabilities TEXT NOT NULL DEFAULT '[]',
          status TEXT NOT NULL DEFAULT 'offline'
            CHECK(status IN ('available', 'busy', 'offline', 'degraded')),
          load REAL NOT NULL DEFAULT 0 CHECK(load >= 0 AND load <= 1),
          public_key TEXT,
          trust_level TEXT NOT NULL DEFAULT 'untrusted'
            CHECK(trust_level IN ('trusted', 'verified', 'untrusted')),
          blocked INTEGER NOT NULL DEFAULT 0 CHECK(blocked IN (0, 1)),
          latency_ms INTEGER,
          error_rate REAL NOT NULL DEFAULT 0 CHECK(error_rate >= 0 AND error_rate <= 1),
          metadata TEXT NOT NULL DEFAULT '{}',
          last_seen_at INTEGER NOT NULL DEFAULT (unixepoch()),
          created_at INTEGER NOT NULL DEFAULT (unixepoch()),
          updated_at INTEGER NOT NULL DEFAULT (unixepoch())
        );

        CREATE INDEX IF NOT EXISTS idx_network_agents_status ON network_agents(status);
        CREATE INDEX IF NOT EXISTS idx_network_agents_trust ON network_agents(trust_level, blocked);
        CREATE INDEX IF NOT EXISTS idx_network_agents_seen ON network_agents(last_seen_at DESC);

        CREATE TABLE IF NOT EXISTS network_messages (
          id TEXT PRIMARY KEY,
          type TEXT NOT NULL
            CHECK(type IN ('task_request', 'task_response', 'capability_query', 'heartbeat', 'negotiation')),
          from_agent_id TEXT NOT NULL,
          to_agent_id TEXT NOT NULL,
          correlation_id TEXT NOT NULL,
          replay_key TEXT,
          payload TEXT NOT NULL DEFAULT '{}',
          signature TEXT,
          timestamp TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'queued'
            CHECK(status IN ('queued', 'sent', 'received', 'failed')),
          error TEXT,
          created_at INTEGER NOT NULL DEFAULT (unixepoch()),
          sent_at INTEGER,
          received_at INTEGER
        );

        CREATE INDEX IF NOT EXISTS idx_network_messages_from ON network_messages(from_agent_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_network_messages_to ON network_messages(to_agent_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_network_messages_correlation ON network_messages(correlation_id);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_network_messages_replay_key
          ON network_messages(replay_key) WHERE replay_key IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_network_messages_status ON network_messages(status, created_at DESC);
      `);
      log.info("Migration 1.35.0 complete: agent network tables created");
    } catch (error) {
      log.error({ err: error }, "Migration 1.35.0 failed");
      throw error;
    }
  }

  if (!currentVersion || versionLessThan(currentVersion, "1.36.0")) {
    log.info("Running migration 1.36.0: Add agent network replay protection");
    try {
      const columns = db.prepare("PRAGMA table_info(network_messages)").all() as Array<{
        name: string;
      }>;
      if (!columns.some((column) => column.name === "replay_key")) {
        db.exec(`ALTER TABLE network_messages ADD COLUMN replay_key TEXT;`);
      }
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_network_messages_replay_key
          ON network_messages(replay_key) WHERE replay_key IS NOT NULL;
      `);
      log.info("Migration 1.36.0 complete: agent network replay protection added");
    } catch (error) {
      log.error({ err: error }, "Migration 1.36.0 failed");
      throw error;
    }
  }

  if (!currentVersion || versionLessThan(currentVersion, "1.37.0")) {
    log.info("Running migration 1.37.0: Repair autonomous task child foreign keys");
    try {
      const repairedTables = repairAutonomousTaskChildForeignKeys(db);
      log.info(
        `Migration 1.37.0 complete: repaired ${repairedTables} autonomous task child table foreign keys`
      );
    } catch (error) {
      log.error({ err: error }, "Migration 1.37.0 failed");
      throw error;
    }
  }

  if (!currentVersion || versionLessThan(currentVersion, "1.38.0")) {
    log.info("Running migration 1.38.0: Add pending remote vector deletion queue");
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS pending_remote_vector_deletions (
          memory_id TEXT NOT NULL,
          namespace TEXT NOT NULL,
          attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
          last_error TEXT,
          created_at INTEGER NOT NULL DEFAULT (unixepoch()),
          updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
          PRIMARY KEY (memory_id, namespace)
        );

        CREATE INDEX IF NOT EXISTS idx_pending_remote_vector_deletions_namespace_updated
          ON pending_remote_vector_deletions(namespace, updated_at);
      `);
      log.info("Migration 1.38.0 complete: pending remote vector deletion queue created");
    } catch (error) {
      log.error({ err: error }, "Migration 1.38.0 failed");
      throw error;
    }
  }

  if (!currentVersion || versionLessThan(currentVersion, "1.39.0")) {
    // Restores the tool_config schema the fork-sync (PRs #625/#630) dropped: the
    // runtime (tool-config.ts / ToolRegistry) reads and writes a `scope_level`
    // column and stores levelToScope() values ('open', 'allowlist', 'disabled')
    // that the original narrow `scope` CHECK never allowed. Without this the
    // agent crashes on startup with "no such column: scope_level" (issue #631).
    log.info(
      "Running migration 1.39.0: Add tool_config.scope_level and widen scope CHECK constraint"
    );
    try {
      const toolConfigExists = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='tool_config'")
        .get();

      if (toolConfigExists) {
        const columns = db.prepare(`PRAGMA table_info(tool_config)`).all() as Array<{
          name: string;
        }>;
        const hasScopeLevel = columns.some((col) => col.name === "scope_level");
        // Preserve an already-present scope_level (DBs created by the original
        // upstream code) so we never clobber explicit access levels; otherwise
        // derive it from the legacy enabled/scope columns.
        const scopeLevelExpr = hasScopeLevel
          ? "scope_level"
          : `CASE
               WHEN enabled = 0 THEN 'off'
               WHEN scope = 'admin-only' THEN 'admin'
               WHEN scope = 'allowlist' THEN 'allowlist'
               WHEN scope = 'disabled' THEN 'off'
               ELSE 'all'
             END`;

        // SQLite cannot ALTER a CHECK constraint in place, so rebuild the table.
        db.transaction(() => {
          db.exec(`
            CREATE TABLE tool_config_new (
              tool_name TEXT PRIMARY KEY,
              enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
              scope TEXT CHECK(scope IN ('always', 'open', 'dm-only', 'group-only', 'admin-only', 'allowlist', 'disabled')),
              scope_level TEXT NOT NULL DEFAULT 'all' CHECK(scope_level IN ('all', 'allowlist', 'admin', 'off')),
              updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
              updated_by INTEGER
            );
          `);
          db.exec(`
            INSERT INTO tool_config_new (tool_name, enabled, scope, scope_level, updated_at, updated_by)
            SELECT tool_name, enabled, scope, ${scopeLevelExpr}, updated_at, updated_by
            FROM tool_config;
          `);
          db.exec(`DROP TABLE tool_config;`);
          db.exec(`ALTER TABLE tool_config_new RENAME TO tool_config;`);
        })();
      } else {
        // Defensive: tool_config should already exist from migration 1.10.0, but
        // create it with the full schema if a database somehow lacks it.
        db.exec(`
          CREATE TABLE IF NOT EXISTS tool_config (
            tool_name TEXT PRIMARY KEY,
            enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
            scope TEXT CHECK(scope IN ('always', 'open', 'dm-only', 'group-only', 'admin-only', 'allowlist', 'disabled')),
            scope_level TEXT NOT NULL DEFAULT 'all' CHECK(scope_level IN ('all', 'allowlist', 'admin', 'off')),
            updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
            updated_by INTEGER
          );
        `);
      }
      log.info(
        "Migration 1.39.0 complete: tool_config.scope_level restored and scope CHECK widened"
      );
    } catch (error) {
      log.error({ err: error }, "Migration 1.39.0 failed");
      throw error;
    }
  }

  if (!currentVersion || versionLessThan(currentVersion, "1.40.0")) {
    log.info("Running migration 1.40.0: Repair and rebuild tg_messages_fts");
    try {
      if (tableExists(db, "tg_messages") && tableExists(db, "tg_messages_fts")) {
        db.exec(`
          DROP TRIGGER IF EXISTS tg_messages_fts_insert;
          DROP TRIGGER IF EXISTS tg_messages_fts_delete;
          DROP TRIGGER IF EXISTS tg_messages_fts_update;

          CREATE TRIGGER tg_messages_fts_insert AFTER INSERT ON tg_messages BEGIN
            INSERT INTO tg_messages_fts(rowid, text, id, chat_id, sender_id, timestamp)
            VALUES (new.rowid, new.text, new.id, new.chat_id, new.sender_id, new.timestamp);
          END;

          CREATE TRIGGER tg_messages_fts_delete AFTER DELETE ON tg_messages BEGIN
            INSERT INTO tg_messages_fts(tg_messages_fts, rowid, text, id, chat_id, sender_id, timestamp)
            VALUES ('delete', old.rowid, old.text, old.id, old.chat_id, old.sender_id, old.timestamp);
          END;

          CREATE TRIGGER tg_messages_fts_update AFTER UPDATE ON tg_messages BEGIN
            INSERT INTO tg_messages_fts(tg_messages_fts, rowid, text, id, chat_id, sender_id, timestamp)
            VALUES ('delete', old.rowid, old.text, old.id, old.chat_id, old.sender_id, old.timestamp);
            INSERT INTO tg_messages_fts(rowid, text, id, chat_id, sender_id, timestamp)
            VALUES (new.rowid, new.text, new.id, new.chat_id, new.sender_id, new.timestamp);
          END;
        `);
        db.prepare(`INSERT INTO tg_messages_fts(tg_messages_fts) VALUES ('rebuild')`).run();
      }
      log.info("Migration 1.40.0 complete: tg_messages_fts triggers repaired and index rebuilt");
    } catch (error) {
      log.error({ err: error }, "Migration 1.40.0 failed");
      throw error;
    }
  }

  if (!currentVersion || versionLessThan(currentVersion, "1.41.0")) {
    log.info("Running migration 1.41.0: Repair and rebuild external-content FTS indexes");
    try {
      if (tableExists(db, "knowledge") && tableExists(db, "knowledge_fts")) {
        db.exec(`
          DROP TRIGGER IF EXISTS knowledge_fts_insert;
          DROP TRIGGER IF EXISTS knowledge_fts_delete;
          DROP TRIGGER IF EXISTS knowledge_fts_update;

          CREATE TRIGGER knowledge_fts_insert AFTER INSERT ON knowledge BEGIN
            INSERT INTO knowledge_fts(rowid, text, id, path, source)
            VALUES (new.rowid, new.text, new.id, new.path, new.source);
          END;

          CREATE TRIGGER knowledge_fts_delete AFTER DELETE ON knowledge BEGIN
            INSERT INTO knowledge_fts(knowledge_fts, rowid, text, id, path, source)
            VALUES ('delete', old.rowid, old.text, old.id, old.path, old.source);
          END;

          CREATE TRIGGER knowledge_fts_update AFTER UPDATE ON knowledge BEGIN
            INSERT INTO knowledge_fts(knowledge_fts, rowid, text, id, path, source)
            VALUES ('delete', old.rowid, old.text, old.id, old.path, old.source);
            INSERT INTO knowledge_fts(rowid, text, id, path, source)
            VALUES (new.rowid, new.text, new.id, new.path, new.source);
          END;
        `);
        db.prepare(`INSERT INTO knowledge_fts(knowledge_fts) VALUES ('rebuild')`).run();
      }

      if (tableExists(db, "tool_index") && tableExists(db, "tool_index_fts")) {
        db.exec(`
          DROP TRIGGER IF EXISTS tool_index_fts_insert;
          DROP TRIGGER IF EXISTS tool_index_fts_delete;
          DROP TRIGGER IF EXISTS tool_index_fts_update;

          CREATE TRIGGER tool_index_fts_insert AFTER INSERT ON tool_index BEGIN
            INSERT INTO tool_index_fts(rowid, search_text, name)
            VALUES (new.rowid, new.search_text, new.name);
          END;

          CREATE TRIGGER tool_index_fts_delete AFTER DELETE ON tool_index BEGIN
            INSERT INTO tool_index_fts(tool_index_fts, rowid, search_text, name)
            VALUES ('delete', old.rowid, old.search_text, old.name);
          END;

          CREATE TRIGGER tool_index_fts_update AFTER UPDATE ON tool_index BEGIN
            INSERT INTO tool_index_fts(tool_index_fts, rowid, search_text, name)
            VALUES ('delete', old.rowid, old.search_text, old.name);
            INSERT INTO tool_index_fts(rowid, search_text, name)
            VALUES (new.rowid, new.search_text, new.name);
          END;
        `);
        db.prepare(`INSERT INTO tool_index_fts(tool_index_fts) VALUES ('rebuild')`).run();
      }
      log.info("Migration 1.41.0 complete: External-content FTS indexes repaired and rebuilt");
    } catch (error) {
      log.error({ err: error }, "Migration 1.41.0 failed");
      throw error;
    }
  }

  if (!currentVersion || versionLessThan(currentVersion, "1.42.0")) {
    log.info("Running migration 1.42.0: Add autonomous daily TON spend tracking");
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS autonomous_daily_ton_spend (
          wallet_key TEXT NOT NULL,
          utc_date TEXT NOT NULL,
          amount REAL NOT NULL DEFAULT 0 CHECK(amount >= 0),
          updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
          PRIMARY KEY (wallet_key, utc_date)
        );
      `);
      log.info("Migration 1.42.0 complete: autonomous daily TON spend tracking created");
    } catch (error) {
      log.error({ err: error }, "Migration 1.42.0 failed");
      throw error;
    }
  }

  setSchemaVersion(db, CURRENT_SCHEMA_VERSION);
}
