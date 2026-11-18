import type { Metadata } from "next";
import { MusicView } from "@/components/music/MusicView";

export const metadata: Metadata = { title: "음악 · AIWorkspace" };

export default function MusicPage() {
  return <MusicView />;
}
