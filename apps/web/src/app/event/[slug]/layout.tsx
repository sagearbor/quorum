import { BottomBar } from "@/components/BottomBar";

export default function EventLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <div className="pb-14">{children}</div>
      <BottomBar />
    </>
  );
}
