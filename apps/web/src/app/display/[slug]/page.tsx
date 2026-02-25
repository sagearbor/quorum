interface DisplayPageProps {
  params: { slug: string };
}

export default function DisplayPage({ params }: DisplayPageProps) {
  return (
    <div className="h-screen w-screen bg-black text-white overflow-hidden flex flex-col">
      <header className="px-6 py-3 flex items-center justify-between border-b border-white/10">
        <h1 className="text-lg font-semibold tracking-wide">
          QUORUM <span className="text-white/50 font-normal">/ {params.slug}</span>
        </h1>
        <span className="text-xs text-white/40">PROJECTION MODE</span>
      </header>

      {/* Dual-panel carousel — built in Phase 2 */}
      <main className="flex-1 flex items-center justify-center">
        <div className="grid grid-cols-2 gap-6 w-full max-w-7xl px-6">
          <div className="aspect-video border border-white/10 rounded-lg flex items-center justify-center text-white/30">
            Dashboard Panel 1
          </div>
          <div className="aspect-video border border-white/10 rounded-lg flex items-center justify-center text-white/30">
            Dashboard Panel 2
          </div>
        </div>
      </main>
    </div>
  );
}
