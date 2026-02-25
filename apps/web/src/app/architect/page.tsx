export default function ArchitectPage() {
  return (
    <div className="p-6 max-w-4xl mx-auto">
      <header className="mb-8">
        <h1 className="text-2xl font-bold">Architect</h1>
        <p className="text-gray-500 mt-1">Create and manage events and quorums</p>
      </header>

      {/* Event creation form — built in Phase 2 (Stream I) */}
      <section className="mb-8">
        <h2 className="text-lg font-semibold mb-4">Create Event</h2>
        <div className="border border-dashed border-gray-300 rounded-lg p-8 text-center text-gray-400">
          Event creation form (Phase 2)
        </div>
      </section>

      {/* Existing events list */}
      <section>
        <h2 className="text-lg font-semibold mb-4">Your Events</h2>
        <div className="border border-dashed border-gray-300 rounded-lg p-8 text-center text-gray-400">
          No events yet
        </div>
      </section>
    </div>
  );
}
