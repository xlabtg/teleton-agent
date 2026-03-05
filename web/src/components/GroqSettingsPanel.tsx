import { useState, useEffect } from 'react';
import { api } from '../lib/api';
import { Select } from './Select';
import { InfoTip } from './InfoTip';

interface GroqSettingsPanelProps {
  getLocal: (key: string) => string;
  getServer?: (key: string) => string;
  saveConfig: (key: string, value: string) => Promise<void>;
  /** Whether the current provider is Groq */
  isGroqProvider: boolean;
}

interface ModelOption {
  value: string;
  name: string;
  description: string;
}

interface HealthCheck {
  status: 'ok' | 'warn' | 'error';
  checks: Record<string, { status: 'ok' | 'warn' | 'error'; message: string }>;
}

const DEFAULT_STT_MODELS: ModelOption[] = [
  { value: 'whisper-large-v3', name: 'Whisper Large v3', description: 'Best accuracy, multilingual' },
  { value: 'whisper-large-v3-turbo', name: 'Whisper Large v3 Turbo', description: 'Fast + accurate' },
  { value: 'distil-whisper-large-v3-en', name: 'Distil Whisper v3 (EN)', description: 'English-only, fastest' },
];

const DEFAULT_TTS_MODELS: ModelOption[] = [
  { value: 'canopylabs/orpheus-v1-english', name: 'Orpheus TTS English', description: 'English TTS, Orpheus v1' },
  { value: 'canopylabs/orpheus-arabic-saudi', name: 'Orpheus TTS Arabic (Saudi)', description: 'Arabic (Saudi) TTS, Orpheus' },
];

const DEFAULT_VOICES = [
  'tara', 'leah', 'jess', 'leo', 'dan', 'mia', 'zac', 'zoe',
  'ahmad', 'nadia',
];

export function GroqSettingsPanel({ getLocal, saveConfig, isGroqProvider }: GroqSettingsPanelProps) {
  const [sttModels, setSttModels] = useState<ModelOption[]>(DEFAULT_STT_MODELS);
  const [ttsModels, setTtsModels] = useState<ModelOption[]>(DEFAULT_TTS_MODELS);
  const [voices, setVoices] = useState<string[]>(DEFAULT_VOICES);
  const [testingKey, setTestingKey] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const [healthCheck, setHealthCheck] = useState<HealthCheck | null>(null);
  const [checkingHealth, setCheckingHealth] = useState(false);

  useEffect(() => {
    if (!isGroqProvider) return;

    api.getGroqSttModels()
      .then((res) => { if (res.data) setSttModels(res.data); })
      .catch(() => {});

    api.getGroqTtsModels()
      .then((res) => { if (res.data) setTtsModels(res.data); })
      .catch(() => {});

    api.getGroqTtsVoices()
      .then((res) => { if (res.data) setVoices(res.data); })
      .catch(() => {});
  }, [isGroqProvider]);

  const handleTestKey = async () => {
    setTestingKey(true);
    setTestResult(null);
    try {
      await api.testGroqKey();
      setTestResult({ ok: true, msg: 'API key is valid' });
    } catch (err) {
      setTestResult({ ok: false, msg: err instanceof Error ? err.message : 'Key test failed' });
    } finally {
      setTestingKey(false);
    }
  };

  const handleHealthCheck = async () => {
    setCheckingHealth(true);
    setHealthCheck(null);
    try {
      const res = await api.getGroqHealth();
      if (res.data) {
        setHealthCheck(res.data);
      }
    } catch {
      setHealthCheck({ status: 'error', checks: { network: { status: 'error', message: 'Failed to connect to server' } } });
    } finally {
      setCheckingHealth(false);
    }
  };

  if (!isGroqProvider) return null;

  const sttModel = getLocal('groq.stt_model') || 'whisper-large-v3-turbo';
  const ttsModel = getLocal('groq.tts_model') || 'canopylabs/orpheus-v1-english';
  const ttsVoice = getLocal('groq.tts_voice') || 'tara';
  const ttsFormat = getLocal('groq.tts_format') || 'mp3';
  const sttLanguage = getLocal('groq.stt_language') || '';
  const rateLimitMode = getLocal('groq.rate_limit_mode') || 'auto';

  return (
    <div className="card">
      <div className="section-title">
        Groq Multi-Modal Settings
        <InfoTip text="Configure Groq's native STT (Whisper) and TTS (Orpheus) capabilities" />
      </div>

      <div style={{ display: 'grid', gap: '16px' }}>
        {/* API Key Test */}
        <div className="form-group" style={{ marginBottom: 0 }}>
          <label>API Key Test <InfoTip text="Test connectivity to the Groq API with your current key" /></label>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
            <button
              className="btn-sm"
              onClick={handleTestKey}
              disabled={testingKey}
              style={{ flexShrink: 0 }}
            >
              {testingKey ? <><span className="spinner sm" /> Testing...</> : 'Test Key'}
            </button>
            <button
              className="btn-sm"
              onClick={handleHealthCheck}
              disabled={checkingHealth}
              style={{ flexShrink: 0 }}
            >
              {checkingHealth ? <><span className="spinner sm" /> Checking...</> : 'Health Check'}
            </button>
            {testResult && (
              <span style={{ fontSize: '13px', color: testResult.ok ? 'var(--green)' : 'var(--red)' }}>
                {testResult.ok ? '✓' : '✗'} {testResult.msg}
              </span>
            )}
          </div>
          {healthCheck && (
            <div style={{ marginTop: '8px', padding: '8px', borderRadius: '4px', background: 'var(--bg-secondary)', fontSize: '12px' }}>
              <div style={{ fontWeight: 600, marginBottom: '4px', color: healthCheck.status === 'ok' ? 'var(--green)' : healthCheck.status === 'warn' ? 'var(--yellow)' : 'var(--red)' }}>
                Status: {healthCheck.status.toUpperCase()}
              </div>
              {Object.entries(healthCheck.checks).map(([name, check]) => (
                <div key={name} style={{ marginLeft: '8px', color: check.status === 'ok' ? 'var(--green)' : check.status === 'warn' ? 'var(--yellow)' : 'var(--red)' }}>
                  {check.status === 'ok' ? '✓' : check.status === 'warn' ? '⚠' : '✗'} {name}: {check.message}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* STT Model */}
        <div className="form-group" style={{ marginBottom: 0 }}>
          <label>STT Model <InfoTip text="Whisper model for speech-to-text transcription" /></label>
          <Select
            value={sttModel}
            options={sttModels.map((m) => m.value)}
            labels={sttModels.map((m) => m.name)}
            onChange={(v) => saveConfig('groq.stt_model', v)}
          />
          {sttModels.find((m) => m.value === sttModel) && (
            <p style={{ fontSize: '12px', color: 'var(--text-secondary)', margin: '4px 0 0 0' }}>
              {sttModels.find((m) => m.value === sttModel)?.description}
            </p>
          )}
        </div>

        {/* STT Language */}
        <div className="form-group" style={{ marginBottom: 0 }}>
          <label>STT Language <InfoTip text="Language hint for speech-to-text (e.g. 'en', 'es'). Leave empty for auto-detection." /></label>
          <input
            type="text"
            value={sttLanguage}
            placeholder="Auto-detect (leave empty)"
            onChange={(e) => saveConfig('groq.stt_language', e.target.value)}
            style={{ width: '100%' }}
          />
        </div>

        {/* TTS Model */}
        <div className="form-group" style={{ marginBottom: 0 }}>
          <label>TTS Model <InfoTip text="Orpheus model for text-to-speech synthesis" /></label>
          <Select
            value={ttsModel}
            options={ttsModels.map((m) => m.value)}
            labels={ttsModels.map((m) => m.name)}
            onChange={(v) => saveConfig('groq.tts_model', v)}
          />
          {ttsModels.find((m) => m.value === ttsModel) && (
            <p style={{ fontSize: '12px', color: 'var(--text-secondary)', margin: '4px 0 0 0' }}>
              {ttsModels.find((m) => m.value === ttsModel)?.description}
            </p>
          )}
        </div>

        {/* TTS Voice */}
        <div className="form-group" style={{ marginBottom: 0 }}>
          <label>TTS Voice <InfoTip text="Voice for text-to-speech (Orpheus voices)" /></label>
          <Select
            value={ttsVoice}
            options={voices}
            onChange={(v) => saveConfig('groq.tts_voice', v)}
          />
        </div>

        {/* TTS Format */}
        <div className="form-group" style={{ marginBottom: 0 }}>
          <label>TTS Output Format <InfoTip text="Audio format for TTS output" /></label>
          <Select
            value={ttsFormat}
            options={['mp3', 'opus', 'aac', 'flac', 'wav', 'pcm']}
            labels={['MP3 (recommended)', 'Opus', 'AAC', 'FLAC', 'WAV', 'PCM (raw)']}
            onChange={(v) => saveConfig('groq.tts_format', v)}
          />
        </div>

        {/* Rate Limit Mode */}
        <div className="form-group" style={{ marginBottom: 0 }}>
          <label>Rate Limit Mode <InfoTip text="How to handle Groq's free-plan rate limits (429 errors)" /></label>
          <Select
            value={rateLimitMode}
            options={['auto', 'strict', 'off']}
            labels={['Auto (retry on 429)', 'Strict (queue to avoid 429s)', 'Off (no retry)']}
            onChange={(v) => saveConfig('groq.rate_limit_mode', v)}
          />
        </div>
      </div>
    </div>
  );
}
