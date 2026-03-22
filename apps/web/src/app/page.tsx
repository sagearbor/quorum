import Link from "next/link";

export default function Home() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center p-8">
      <h1 className="text-4xl font-bold mb-4">Quorum</h1>
      <p className="text-lg text-gray-600 mb-8 text-center max-w-md">
        Multi-agent coordination platform. Real people, configurable authority,
        live dashboards, actionable artifacts.
      </p>
      <div className="flex gap-4">
        <Link
          href="/events"
          className="rounded-lg bg-foreground text-background px-6 py-3 font-medium hover:opacity-90 transition-opacity"
        >
          Browse Events
        </Link>
        <Link
          href="/architect"
          className="rounded-lg border border-gray-300 px-6 py-3 font-medium hover:bg-gray-50 transition-colors"
        >
          Architect
        </Link>
      </div>
    </main>
  );
}
