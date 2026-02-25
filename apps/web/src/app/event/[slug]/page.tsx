interface EventPageProps {
  params: { slug: string };
  searchParams: { station?: string };
}

export default function EventPage({ params, searchParams }: EventPageProps) {
  const station = searchParams.station;

  return (
    <div className="p-6">
      <header className="mb-8">
        <h1 className="text-2xl font-bold">Event: {params.slug}</h1>
        {station && (
          <p className="text-sm text-gray-500 mt-1">Station {station}</p>
        )}
      </header>

      <section>
        <h2 className="text-lg font-semibold mb-4">Active Quorums</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {/* Quorum cards will be populated from Supabase in Phase 2 */}
          <div className="border border-dashed border-gray-300 rounded-lg p-6 text-center text-gray-400">
            No active quorums yet
          </div>
        </div>
      </section>
    </div>
  );
}
