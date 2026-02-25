interface QuorumPageProps {
  params: { slug: string; id: string };
}

export default function QuorumPage({ params }: QuorumPageProps) {
  return (
    <div className="p-6">
      <header className="mb-6">
        <p className="text-sm text-gray-500">
          Event: {params.slug}
        </p>
        <h1 className="text-2xl font-bold">Quorum {params.id}</h1>
      </header>

      {/* Role pills — populated from API in Phase 2 */}
      <section className="mb-6">
        <h2 className="text-lg font-semibold mb-3">Roles</h2>
        <div className="flex flex-wrap gap-2">
          <div className="border border-dashed border-gray-300 rounded-full px-4 py-2 text-gray-400 text-sm">
            No roles defined
          </div>
        </div>
      </section>

      {/* Contribution form — built in Phase 2 (Stream F) */}
      <section>
        <h2 className="text-lg font-semibold mb-3">Contribute</h2>
        <div className="border border-dashed border-gray-300 rounded-lg p-8 text-center text-gray-400">
          Select a role to contribute
        </div>
      </section>
    </div>
  );
}
