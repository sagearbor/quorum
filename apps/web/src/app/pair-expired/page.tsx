/**
 * /pair-expired — static fallback shown when a heartbeat returns 401/404.
 *
 * No auto-retry, no re-mint.  The attendant must hand the visitor a fresh QR
 * code, which sends them back through /pair.
 */

export const dynamic = "force-static";

export default function PairExpiredPage() {
  return (
    <div
      className="min-h-screen flex items-center justify-center bg-slate-50 dark:bg-slate-900 p-6"
      data-testid="pair-expired"
    >
      <div className="max-w-screen-sm w-full bg-white dark:bg-slate-800 rounded-2xl shadow-md p-6 text-center">
        <h1 className="text-lg font-semibold text-slate-900 dark:text-white mb-2">
          This pairing link has expired
        </h1>
        <p className="text-sm text-slate-600 dark:text-slate-300">
          Please scan a fresh QR code from the station attendant.
        </p>
      </div>
    </div>
  );
}
