import { useState } from "react";

interface NewEnvDialogProps {
  onClose: () => void;
  onCreate: (repoUrl: string, backend: "cf" | "local", authMode: "auto" | "subscription" | "api") => Promise<void>;
}

export default function NewEnvDialog({ onClose, onCreate }: NewEnvDialogProps) {
  const [repoUrl, setRepoUrl] = useState("");
  const [backend, setBackend] = useState<"cf" | "local">("cf");
  const [authMode, setAuthMode] = useState<"auto" | "subscription" | "api">("auto");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const url = repoUrl.trim();
    if (!url) return;

    setLoading(true);
    setError(null);
    try {
      await onCreate(url, backend, authMode);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-md mx-4">
        <div className="px-5 py-4 border-b border-[#d0d7de]">
          <h3 className="text-sm font-semibold text-[#24292f]">New Environment</h3>
        </div>
        <form onSubmit={handleSubmit} className="px-5 py-4">
          <label className="block text-xs font-medium text-[#57606a] mb-1.5">
            Repository URL
          </label>
          <input
            type="text"
            value={repoUrl}
            onChange={(e) => setRepoUrl(e.target.value)}
            placeholder="https://github.com/you/repo"
            autoFocus
            disabled={loading}
            className="w-full bg-white border border-[#d0d7de] rounded px-3 py-2 text-sm text-[#24292f] placeholder:text-[#6e7781] disabled:opacity-50 focus:outline-none focus:border-[#0969da] focus:ring-1 focus:ring-[#0969da]/30"
          />
          <label className="block text-xs font-medium text-[#57606a] mt-3 mb-1.5">
            Runner Backend
          </label>
          <select
            value={backend}
            onChange={(e) => setBackend(e.target.value as "cf" | "local")}
            disabled={loading}
            className="w-full bg-white border border-[#d0d7de] rounded px-3 py-2 text-sm text-[#24292f] disabled:opacity-50 focus:outline-none focus:border-[#0969da] focus:ring-1 focus:ring-[#0969da]/30"
          >
            <option value="cf">Cloudflare Containers</option>
            <option value="local">Local Runner</option>
          </select>
          <label className="block text-xs font-medium text-[#57606a] mt-3 mb-1.5">
            Claude Auth
          </label>
          <select
            value={authMode}
            onChange={(e) => setAuthMode(e.target.value as "auto" | "subscription" | "api")}
            disabled={loading}
            className="w-full bg-white border border-[#d0d7de] rounded px-3 py-2 text-sm text-[#24292f] disabled:opacity-50 focus:outline-none focus:border-[#0969da] focus:ring-1 focus:ring-[#0969da]/30"
          >
            <option value="auto">Auto (prefer subscription, fallback to API key)</option>
            <option value="subscription">Subscription only</option>
            <option value="api">Anthropic API key only</option>
          </select>
          <p className="mt-1 text-[11px] text-[#6e7781]">
            <code>auto</code> keeps the API key as backup but warns if the subscription token is not used.
          </p>
          {error && (
            <p className="mt-2 text-xs text-red-600">{error}</p>
          )}
          <div className="flex justify-end gap-2 mt-4">
            <button
              type="button"
              onClick={onClose}
              disabled={loading}
              className="text-xs px-3 py-1.5 rounded border border-[#d0d7de] bg-white hover:bg-[#f6f8fa] text-[#57606a] transition-colors disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading || !repoUrl.trim()}
              className="text-xs px-3 py-1.5 rounded bg-[#0969da] hover:bg-[#0a5bc4] text-white font-medium transition-colors disabled:opacity-40"
            >
              {loading ? "Creating..." : "Create"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
