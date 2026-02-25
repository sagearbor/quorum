export default function QuorumLoading() {
  return (
    <div className="p-6 animate-pulse">
      <div className="h-4 w-24 bg-gray-200 rounded mb-2" />
      <div className="h-8 w-48 bg-gray-200 rounded mb-6" />
      <div className="h-6 w-20 bg-gray-200 rounded mb-3" />
      <div className="flex gap-2 mb-6">
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-10 w-24 bg-gray-200 rounded-full" />
        ))}
      </div>
      <div className="h-6 w-28 bg-gray-200 rounded mb-3" />
      <div className="h-48 bg-gray-200 rounded-lg" />
    </div>
  );
}
