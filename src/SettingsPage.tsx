import { useState } from "react";
import { useToast } from "./Toast";
import type { SetupStatus } from "./api";
import { submitSetup } from "./api";

const HUB_URL = window.location.origin;

interface SecretField {
  key: string;
  label: string;
  description: string;
  group: "required" | "optional" | "advanced";
}

const FIELDS: SecretField[] = [
  {
    key: "ANTHROPIC_API_KEY",
    label: "Anthropic API Key",
    description: "Required. Get one at console.anthropic.com",
    group: "required",
  },
  {
    key: "CLAUDE_CODE_OAUTH_TOKEN",
    label: "Claude Code OAuth Token",
    description: "Alternative to API key for Claude subscription users",
    group: "optional",
  },
  {
    key: "GITHUB_TOKEN",
    label: "GitHub Token",
    description: "Personal access token for private repository access",
    group: "optional",
  },
  {
    key: "CF_ACCESS_AUD",
    label: "CF Access Audience",
    description: "Cloudflare Access audience tag for JWT validation",
    group: "optional",
  },
  {
    key: "CF_ACCESS_CLIENT_ID",
    label: "CF Access Client ID",
    description: "Service token client ID for machine-to-machine auth",
    group: "optional",
  },
  {
    key: "CF_ACCESS_CLIENT_SECRET",
    label: "CF Access Client Secret",
    description: "Service token secret paired with Client ID",
    group: "optional",
  },
  {
    key: "HUB_PUBLIC_URL",
    label: "Hub Public URL",
    description: "Public URL of this deployment (auto-detected if not set)",
    group: "advanced",
  },
  {
    key: "LOCAL_RUNNER_URL",
    label: "Local Runner URL",
    description: "Base URL for local Docker runner backend",
    group: "advanced",
  },
  {
    key: "LOCAL_RUNNER_TOKEN",
    label: "Local Runner Token",
    description: "Bearer token for local runner authentication",
    group: "advanced",
  },
  {
    key: "RESEARCH_RELAY_URL",
    label: "Research Relay URL",
    description: "URL for Codex relay gateway",
    group: "advanced",
  },
  {
    key: "RESEARCH_RELAY_TOKEN",
    label: "Research Relay Token",
    description: "Bearer token for research relay",
    group: "advanced",
  },
];

const GROUP_LABELS: Record<string, string> = {
  required: "Required",
  optional: "Optional",
  advanced: "Advanced",
};

interface SettingsPageProps {
  status: SetupStatus;
  firstRun?: boolean;
  onDone: () => void;
}

export default function SettingsPage({ status, firstRun, onDone }: SettingsPageProps) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [visible, setVisible] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({
    required: true,
    optional: firstRun ? false : true,
    advanced: false,
  });
  const addToast = useToast();

  const hasChanges = Object.values(values).some((v) => v.length > 0);

  const handleSave = async () => {
    const secrets: Record<string, string> = {};
    for (const [k, v] of Object.entries(values)) {
      if (v.length > 0) secrets[k] = v;
    }
    if (Object.keys(secrets).length === 0) return;

    setSaving(true);
    setError(null);
    try {
      await submitSetup(HUB_URL, secrets);
      addToast({
        title: "Settings saved",
        variant: "success",
        duration: 3000,
      });
      setValues({});
      setSaving(false);
      if (firstRun) {
        // Reload to initialize the dashboard
        window.location.reload();
      }
    } catch (err) {
      setError((err as Error).message);
      setSaving(false);
    }
  };

  const toggleGroup = (group: string) => {
    setExpandedGroups((prev) => ({ ...prev, [group]: !prev[group] }));
  };

  const groups = ["required", "optional", "advanced"];

  return (
    <div className="flex-1 flex flex-col overflow-y-auto bg-white">
      <div className="max-w-2xl w-full mx-auto px-6 py-8">
        {firstRun && (
          <div className="mb-6 rounded-lg border border-[#0969da]/30 bg-[#ddf4ff] px-4 py-3">
            <p className="text-sm font-medium text-[#24292f]">Welcome to Tiller</p>
            <p className="text-xs text-[#57606a] mt-0.5">
              Configure your Anthropic API key to get started. You can update these settings at any time.
            </p>
          </div>
        )}

        <h2 className="text-base font-semibold text-[#24292f] mb-1">Settings</h2>
        <p className="text-xs text-[#57606a] mb-6">
          Manage secrets for this Tiller deployment.
        </p>

        {groups.map((group) => {
          const fields = FIELDS.filter((f) => f.group === group);
          const expanded = expandedGroups[group];
          return (
            <div key={group} className="mb-4">
              <button
                type="button"
                onClick={() => toggleGroup(group)}
                className="flex items-center gap-1.5 text-xs font-semibold text-[#57606a] uppercase tracking-wider mb-2 hover:text-[#24292f] transition-colors"
              >
                <span className="text-[10px]">{expanded ? "\u25BC" : "\u25B6"}</span>
                {GROUP_LABELS[group]}
              </button>
              {expanded && (
                <div className="space-y-3 ml-3">
                  {fields.map((field) => {
                    const keyStatus = status.keys[field.key];
                    const isConfigured = keyStatus === "configured";
                    const showValue = visible[field.key];
                    return (
                      <div key={field.key}>
                        <div className="flex items-center gap-2 mb-1">
                          <label className="text-xs font-medium text-[#24292f]">
                            {field.label}
                          </label>
                          <span
                            className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${
                              isConfigured
                                ? "bg-[#dafbe1] text-[#1a7f37]"
                                : "bg-[#eff1f3] text-[#57606a]"
                            }`}
                          >
                            {isConfigured ? "configured" : "not set"}
                          </span>
                        </div>
                        <p className="text-[11px] text-[#6e7781] mb-1">{field.description}</p>
                        <div className="flex gap-1.5">
                          <input
                            type={showValue ? "text" : "password"}
                            value={values[field.key] ?? ""}
                            onChange={(e) =>
                              setValues((prev) => ({ ...prev, [field.key]: e.target.value }))
                            }
                            placeholder={isConfigured ? "\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022 (enter new value to replace)" : ""}
                            disabled={saving}
                            className="flex-1 bg-white border border-[#d0d7de] rounded px-2.5 py-1.5 text-xs text-[#24292f] placeholder:text-[#6e7781] disabled:opacity-50 focus:outline-none focus:border-[#0969da] focus:ring-1 focus:ring-[#0969da]/30 font-mono"
                          />
                          <button
                            type="button"
                            onClick={() => setVisible((prev) => ({ ...prev, [field.key]: !prev[field.key] }))}
                            className="text-[10px] px-2 py-1.5 rounded border border-[#d0d7de] bg-white hover:bg-[#f6f8fa] text-[#57606a] transition-colors"
                          >
                            {showValue ? "hide" : "show"}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}

        {error && <p className="mt-2 text-xs text-red-600">{error}</p>}

        <div className="flex items-center gap-3 mt-6 pt-4 border-t border-[#d0d7de]">
          <button
            type="button"
            onClick={handleSave}
            disabled={saving || !hasChanges}
            className="text-xs px-4 py-2 rounded bg-[#0969da] hover:bg-[#0a5bc4] text-white font-medium transition-colors disabled:opacity-40"
          >
            {saving ? "Saving..." : "Save"}
          </button>
          {!firstRun && (
            <button
              type="button"
              onClick={onDone}
              disabled={saving}
              className="text-xs px-3 py-2 rounded border border-[#d0d7de] bg-white hover:bg-[#f6f8fa] text-[#57606a] transition-colors disabled:opacity-50"
            >
              Back
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
